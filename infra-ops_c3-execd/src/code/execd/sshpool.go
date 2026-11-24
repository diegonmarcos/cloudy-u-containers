package execd

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// Pool keeps one authenticated ssh connection per alias and opens a session per command,
// replacing a fork of the ssh binary (plus a TCP+auth handshake) for every call. Host keys
// are not checked: ssh-argv.ts runs with UserKnownHostsFile=/dev/null, and fleet ssh is
// mesh-only through the aliases in ssh_config.
type Pool struct {
	Cfg       *SSHConfig
	Home      string
	Dial      func(ctx context.Context, network, addr string) (net.Conn, error) // test seam
	IdleTTL   time.Duration
	KeepAlive time.Duration

	mu      sync.Mutex
	entries map[string]*poolEntry
	signers map[string][]ssh.Signer
	dials   int
}

type poolEntry struct {
	mu      sync.Mutex // serialises (re)dial for one alias
	client  *ssh.Client
	last    time.Time
	closeCh chan struct{}
}

func NewPool(cfg *SSHConfig, home string) *Pool {
	return &Pool{Cfg: cfg, Home: home, IdleTTL: 5 * time.Minute, KeepAlive: 30 * time.Second,
		entries: map[string]*poolEntry{}, signers: map[string][]ssh.Signer{}}
}

// Dials is the number of fresh ssh handshakes performed (pool effectiveness, and a test hook).
func (p *Pool) Dials() int { p.mu.Lock(); defer p.mu.Unlock(); return p.dials }

func (p *Pool) loadSigners(files []string) ([]ssh.Signer, error) {
	var out []ssh.Signer
	for _, f := range files {
		p.mu.Lock()
		cached, ok := p.signers[f]
		p.mu.Unlock()
		if !ok {
			b, err := os.ReadFile(f)
			if err != nil {
				continue // like ssh: a missing IdentityFile is skipped
			}
			s, err := ssh.ParsePrivateKey(b)
			if err != nil {
				continue
			}
			cached = []ssh.Signer{s}
			p.mu.Lock()
			p.signers[f] = cached
			p.mu.Unlock()
		}
		out = append(out, cached...)
	}
	if len(out) == 0 {
		return nil, errors.New("no usable IdentityFile")
	}
	return out, nil
}

func (p *Pool) dialConn(ctx context.Context, addr string, ct time.Duration) (net.Conn, error) {
	dctx, cancel := context.WithTimeout(ctx, ct)
	defer cancel()
	if p.Dial != nil {
		return p.Dial(dctx, "tcp", addr)
	}
	var d net.Dialer
	return d.DialContext(dctx, "tcp", addr)
}

// connect builds a client for alias, through ProxyJump hops when configured.
func (p *Pool) connect(ctx context.Context, alias string, ct time.Duration, depth int) (*ssh.Client, error) {
	if depth > 4 {
		return nil, errors.New("ProxyJump chain too deep")
	}
	hc := p.Cfg.Resolve(alias, p.Home)
	signers, err := p.loadSigners(hc.IdentityFiles)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", alias, err)
	}
	user := hc.User
	if user == "" {
		user = "root"
	}
	cc := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signers...)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // see Pool doc
		Timeout:         ct,
	}
	addr := net.JoinHostPort(hc.HostName, strconv.Itoa(hc.Port))
	var conn net.Conn
	if hc.ProxyJump != "" && !strings.EqualFold(hc.ProxyJump, "none") {
		jump := strings.Split(hc.ProxyJump, ",")[0]
		jc, err := p.client(ctx, jump, ct, depth+1)
		if err != nil {
			return nil, fmt.Errorf("proxyjump %s: %w", jump, err)
		}
		conn, err = jc.Dial("tcp", addr)
		if err != nil {
			return nil, err
		}
	} else if conn, err = p.dialConn(ctx, addr, ct); err != nil {
		return nil, err
	}
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr, cc)
	if err != nil {
		conn.Close()
		return nil, err
	}
	p.mu.Lock()
	p.dials++
	p.mu.Unlock()
	return ssh.NewClient(sc, chans, reqs), nil
}

func (p *Pool) entry(alias string) *poolEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	e := p.entries[alias]
	if e == nil {
		e = &poolEntry{}
		p.entries[alias] = e
	}
	return e
}

func (p *Pool) client(ctx context.Context, alias string, ct time.Duration, depth int) (*ssh.Client, error) {
	e := p.entry(alias)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.client != nil {
		e.last = time.Now()
		return e.client, nil
	}
	c, err := p.connect(ctx, alias, ct, depth)
	if err != nil {
		return nil, err
	}
	e.client, e.last = c, time.Now()
	e.closeCh = make(chan struct{})
	go p.watch(alias, e, c, e.closeCh)
	return c, nil
}

// watch keepalives one connection and evicts it when idle or dead.
func (p *Pool) watch(alias string, e *poolEntry, c *ssh.Client, done chan struct{}) {
	t := time.NewTicker(p.KeepAlive)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			e.mu.Lock()
			idle := time.Since(e.last) > p.IdleTTL
			e.mu.Unlock()
			if idle {
				p.drop(alias, c)
				return
			}
			if _, _, err := c.SendRequest("keepalive@openssh.com", true, nil); err != nil {
				p.drop(alias, c)
				return
			}
		}
	}
}

func (p *Pool) drop(alias string, c *ssh.Client) {
	e := p.entry(alias)
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.client == c {
		e.client = nil
		if e.closeCh != nil {
			close(e.closeCh)
			e.closeCh = nil
		}
	}
	c.Close()
}

// Close drops every pooled connection.
func (p *Pool) Close() {
	p.mu.Lock()
	var all []string
	for a := range p.entries {
		all = append(all, a)
	}
	p.mu.Unlock()
	for _, a := range all {
		e := p.entry(a)
		e.mu.Lock()
		c := e.client
		e.mu.Unlock()
		if c != nil {
			p.drop(a, c)
		}
	}
}

// SSHRequest is one remote command, as sshExec(vm, command, timeout, _, connectTimeout).
type SSHRequest struct {
	Alias          string `json:"alias"`
	Command        string `json:"command"`
	TimeoutMS      int    `json:"timeout_ms"`
	ConnectTimeout int    `json:"connect_timeout"` // seconds, default 10
}

// Exec runs the command under `bash -c` (RemoteShellWrap) on the alias, retrying once on a
// fresh connection when the pooled one turned out dead (the stale-mux case ssh.ts avoids by
// having no mux at all).
func (p *Pool) Exec(ctx context.Context, r SSHRequest) Result {
	timeout := DefaultTimeout
	if r.TimeoutMS > 0 {
		timeout = time.Duration(r.TimeoutMS) * time.Millisecond
	}
	ct := 10 * time.Second
	if r.ConnectTimeout > 0 {
		ct = time.Duration(r.ConnectTimeout) * time.Second
	}
	res, retry := p.once(ctx, r.Alias, RemoteShellWrap(r.Command), timeout, ct)
	if retry {
		res, _ = p.once(ctx, r.Alias, RemoteShellWrap(r.Command), timeout, ct)
	}
	return res
}

// once reports retry=true only when the session could not be opened (nothing ran).
func (p *Pool) once(ctx context.Context, alias, wrapped string, timeout, ct time.Duration) (Result, bool) {
	c, err := p.client(ctx, alias, ct, 0)
	if err != nil {
		return Result{ExitCode: 255, Stderr: err.Error()}, false
	}
	s, err := c.NewSession()
	if err != nil {
		p.drop(alias, c)
		return Result{ExitCode: 255, Stderr: err.Error()}, true
	}
	defer s.Close()
	var overflowed bool
	out := &capBuffer{max: MaxBuffer, overflow: func() { overflowed = true; s.Close() }}
	errb := &capBuffer{max: MaxBuffer, overflow: func() { overflowed = true; s.Close() }}
	s.Stdout, s.Stderr = out, errb
	if err := s.Start(wrapped); err != nil {
		p.drop(alias, c)
		return Result{ExitCode: 255, Stderr: err.Error()}, true
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	res := Result{ExitCode: 1}
	select {
	case err = <-done:
	case <-timer.C:
		_ = s.Signal(ssh.SIGTERM)
		s.Close()
		<-done
		res.Stdout, res.Stderr, res.TimedOut = out.buf.String(), errb.buf.String(), true
		return res, false
	case <-ctx.Done():
		s.Close()
		<-done
		res.Stdout, res.Stderr = out.buf.String(), errb.buf.String()
		return res, false
	}
	res.Stdout, res.Stderr = out.buf.String(), errb.buf.String()
	var ee *ssh.ExitError
	switch {
	case err == nil:
		res.ExitCode, res.OK = 0, true
	case errors.As(err, &ee):
		res.ExitCode = ee.ExitStatus()
	case overflowed:
	default:
		// connection died mid-command: report like ssh does (255), drop the client
		res.ExitCode = 255
		res.Stderr += err.Error()
		p.drop(alias, c)
	}
	return res, false
}
