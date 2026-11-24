package execd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// testServer is an in-process sshd: public-key auth for one client key, `exec` requests run
// through a real `sh -c <raw>` (so the bash -c wrapper and its quoting execute for real),
// and direct-tcpip forwarding so ProxyJump can be exercised.
type testServer struct {
	ln       net.Listener
	cfg      *ssh.ServerConfig
	mu       sync.Mutex
	conns    []net.Conn
	execs    []string
	forwards []string
	resolve  map[string]string // host:port -> real listener address, for direct-tcpip
}

func newKeyFile(t *testing.T, dir, name string) (ssh.Signer, string) {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	_ = pub
	blk, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	f := filepath.Join(dir, name)
	if err := os.WriteFile(f, pem.EncodeToMemory(blk), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := ssh.NewSignerFromKey(priv)
	return s, f
}

func startServer(t *testing.T, clientKey ssh.Signer) *testServer {
	t.Helper()
	_, hostPriv, _ := ed25519.GenerateKey(rand.Reader)
	hostSigner, _ := ssh.NewSignerFromKey(hostPriv)
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if string(k.Marshal()) == string(clientKey.PublicKey().Marshal()) {
			return nil, nil
		}
		return nil, io.ErrUnexpectedEOF
	}}
	cfg.AddHostKey(hostSigner)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &testServer{ln: ln, cfg: cfg, resolve: map[string]string{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns = append(s.conns, c)
			s.mu.Unlock()
			go s.serve(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return s
}

func (s *testServer) killConns() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, c := range s.conns {
		c.Close()
	}
	s.conns = nil
}

func (s *testServer) execLog() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.execs...)
}

func (s *testServer) serve(c net.Conn) {
	sc, chans, reqs, err := ssh.NewServerConn(c, s.cfg)
	if err != nil {
		c.Close()
		return
	}
	defer sc.Close()
	go func() {
		for r := range reqs {
			r.Reply(r.Type == "keepalive@openssh.com", nil)
		}
	}()
	for nc := range chans {
		switch nc.ChannelType() {
		case "session":
			ch, creqs, _ := nc.Accept()
			go s.session(ch, creqs)
		case "direct-tcpip":
			var p struct {
				Host  string
				Port  uint32
				OHost string
				OPort uint32
			}
			ssh.Unmarshal(nc.ExtraData(), &p)
			key := net.JoinHostPort(p.Host, itoa(p.Port))
			s.mu.Lock()
			s.forwards = append(s.forwards, key)
			target := s.resolve[key]
			s.mu.Unlock()
			up, err := net.Dial("tcp", target)
			if err != nil {
				nc.Reject(ssh.ConnectionFailed, err.Error())
				continue
			}
			ch, _, _ := nc.Accept()
			go func() { io.Copy(ch, up); ch.Close() }()
			go func() { io.Copy(up, ch); up.Close() }()
		default:
			nc.Reject(ssh.UnknownChannelType, "no")
		}
	}
}

func itoa(n uint32) string { return strconv.FormatUint(uint64(n), 10) }

func (s *testServer) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for r := range reqs {
		if r.Type != "exec" {
			r.Reply(false, nil)
			continue
		}
		var p struct{ Cmd string }
		ssh.Unmarshal(r.Payload, &p)
		r.Reply(true, nil)
		s.mu.Lock()
		s.execs = append(s.execs, p.Cmd)
		s.mu.Unlock()
		cmd := exec.Command("sh", "-c", p.Cmd)
		cmd.Stdout, cmd.Stderr = ch, ch.Stderr()
		code := 0
		if err := cmd.Run(); err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = 127
			}
		}
		st := make([]byte, 4)
		binary.BigEndian.PutUint32(st, uint32(code))
		ch.SendRequest("exit-status", false, st)
		return
	}
}

func poolFor(t *testing.T, cfgText, home string, addrs map[string]string) *Pool {
	t.Helper()
	p := NewPool(ParseSSHConfig(cfgText), home)
	p.KeepAlive = 100 * time.Millisecond
	p.Dial = func(ctx context.Context, n, addr string) (net.Conn, error) {
		if real, ok := addrs[addr]; ok {
			addr = real
		}
		var d net.Dialer
		return d.DialContext(ctx, n, addr)
	}
	t.Cleanup(p.Close)
	return p
}

func TestPoolReusesOneConnection(t *testing.T) {
	dir := t.TempDir()
	signer, keyFile := newKeyFile(t, dir, "k")
	srv := startServer(t, signer)
	p := poolFor(t, "Host vm1\n HostName vm1.test\n User u\n Port 22\n IdentityFile "+keyFile+"\n", dir,
		map[string]string{"vm1.test:22": srv.ln.Addr().String()})
	for i := 0; i < 5; i++ {
		r := p.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "echo ok-" + string(rune('0'+i))})
		if !r.OK || r.Stdout != "ok-"+string(rune('0'+i))+"\n" {
			t.Fatalf("call %d: %+v", i, r)
		}
	}
	if d := p.Dials(); d != 1 {
		t.Fatalf("5 commands must share one handshake, got %d dials", d)
	}
	// 20 concurrent sessions over the same connection
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r := p.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "echo c"}); !r.OK {
				t.Errorf("%+v", r)
			}
		}()
	}
	wg.Wait()
	if d := p.Dials(); d != 1 {
		t.Fatalf("concurrency opened extra connections: %d", d)
	}
}

func TestPoolSemantics(t *testing.T) {
	dir := t.TempDir()
	signer, keyFile := newKeyFile(t, dir, "k")
	srv := startServer(t, signer)
	p := poolFor(t, "Host vm1\n HostName vm1.test\n IdentityFile "+keyFile+"\n", dir, map[string]string{"vm1.test:22": srv.ln.Addr().String()})
	ctx := context.Background()

	// the wrapper is exactly ssh.ts's: bash -c <any-shell-quoted body>, and quoting works end to end
	body := `echo "it's $((1+2))"; echo e >&2; exit 7`
	r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: body})
	if r.Stdout != "it's 3\n" || r.Stderr != "e\n" || r.ExitCode != 7 || r.OK {
		t.Fatalf("%+v", r)
	}
	if log := srv.execLog(); len(log) != 1 || log[0] != RemoteShellWrap(body) {
		t.Fatalf("remote saw %q, want %q", log, RemoteShellWrap(body))
	}

	// our timeout vs a child that exits 124
	if r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: "exit 124"}); r.TimedOut || r.ExitCode != 124 {
		t.Fatalf("%+v", r)
	}
	t0 := time.Now()
	if r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: "sleep 5", TimeoutMS: 300}); !r.TimedOut || r.OK || time.Since(t0) > 3*time.Second {
		t.Fatalf("%+v after %v", r, time.Since(t0))
	}
	// the connection survives a per-command timeout
	if r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: "echo still"}); !r.OK || p.Dials() != 1 {
		t.Fatalf("%+v dials=%d", r, p.Dials())
	}
}

func TestPoolReconnectsAfterServerDropsConnection(t *testing.T) {
	dir := t.TempDir()
	signer, keyFile := newKeyFile(t, dir, "k")
	srv := startServer(t, signer)
	p := poolFor(t, "Host vm1\n HostName vm1.test\n IdentityFile "+keyFile+"\n", dir, map[string]string{"vm1.test:22": srv.ln.Addr().String()})
	ctx := context.Background()
	if r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: "echo a"}); !r.OK {
		t.Fatal(r)
	}
	srv.killConns()
	time.Sleep(50 * time.Millisecond)
	r := p.Exec(ctx, SSHRequest{Alias: "vm1", Command: "echo b"})
	if !r.OK || r.Stdout != "b\n" {
		t.Fatalf("pool must recover from a dead connection: %+v", r)
	}
	if p.Dials() != 2 {
		t.Fatalf("dials=%d", p.Dials())
	}
}

func TestPoolAuthFailureAndUnknownKey(t *testing.T) {
	dir := t.TempDir()
	signer, _ := newKeyFile(t, dir, "good")
	_, badFile := newKeyFile(t, dir, "bad")
	srv := startServer(t, signer)
	p := poolFor(t, "Host vm1\n HostName vm1.test\n IdentityFile "+badFile+"\n", dir, map[string]string{"vm1.test:22": srv.ln.Addr().String()})
	r := p.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "echo x"})
	if r.OK || r.ExitCode != 255 || r.Stderr == "" {
		t.Fatalf("%+v", r)
	}
	p2 := poolFor(t, "Host vm1\n HostName vm1.test\n IdentityFile /nonexistent\n", dir, nil)
	if r := p2.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "echo x"}); r.OK || r.ExitCode != 255 {
		t.Fatalf("%+v", r)
	}
}

func TestPoolProxyJump(t *testing.T) {
	dir := t.TempDir()
	signer, keyFile := newKeyFile(t, dir, "k")
	jump := startServer(t, signer)
	target := startServer(t, signer)
	jump.resolve["target.test:22"] = target.ln.Addr().String()
	cfg := "Host jump\n HostName jump.test\n IdentityFile " + keyFile + "\nHost tgt\n HostName target.test\n ProxyJump jump\n IdentityFile " + keyFile + "\n"
	p := poolFor(t, cfg, dir, map[string]string{"jump.test:22": jump.ln.Addr().String()})
	r := p.Exec(context.Background(), SSHRequest{Alias: "tgt", Command: "echo via-jump"})
	if !r.OK || r.Stdout != "via-jump\n" {
		t.Fatalf("%+v", r)
	}
	if len(target.execLog()) != 1 || len(jump.execLog()) != 0 {
		t.Fatalf("command must run on the target only: jump=%v target=%v", jump.execLog(), target.execLog())
	}
	if p.Dials() != 2 {
		t.Fatalf("one handshake per hop, got %d", p.Dials())
	}
}

func TestPoolIdleEviction(t *testing.T) {
	dir := t.TempDir()
	signer, keyFile := newKeyFile(t, dir, "k")
	srv := startServer(t, signer)
	p := poolFor(t, "Host vm1\n HostName vm1.test\n IdentityFile "+keyFile+"\n", dir, map[string]string{"vm1.test:22": srv.ln.Addr().String()})
	p.IdleTTL = 150 * time.Millisecond
	p.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "true"})
	time.Sleep(700 * time.Millisecond) // keepalive tick 100 ms evicts after the TTL
	p.Exec(context.Background(), SSHRequest{Alias: "vm1", Command: "true"})
	if p.Dials() != 2 {
		t.Fatalf("idle connection should have been evicted: dials=%d", p.Dials())
	}
}
