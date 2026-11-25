//go:build parity

// Package parity runs the ORIGINAL Python service (infra-sec_auth-broker/src/code/main.py, unmodified, driven by ref.py)
// and the Go port on identical requests and requires identical answers: status, the headers that matter, the exact
// body bytes (sign-in pages, JSON, cookies), the connection being dropped where Python raises, and the calls each
// side made to the providers, the Cloudflare certs endpoint and the mail API. Both sides get the same clock and the
// same deterministic byte stream, so sids, states, verifiers and one-time codes are equal too.
// Synthetic secrets, keys and tokens only.
//
// Run: PARITY_REQUIRE=1 go test -count=1 -tags parity -v -run TestParity ./parity/
// PARITY_MUTATE=1 skews the Go side (another cookie secret): the harness must then report differing requests.
package parity

import (
	"bufio"
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"auth-broker/broker"
	"auth-broker/fleetauth"
)

const (
	t0           = int64(1_800_000_000)
	cookieSecret = "cookie-secret-synthetic-0123456789abcdef"
	cookieName   = "_sso_test"
	chooserHost  = "auth.example.org"
)

func mutate() bool { return os.Getenv("PARITY_MUTATE") == "1" }

func requirePython(t *testing.T) string {
	t.Helper()
	bin := os.Getenv("PY_BIN")
	if bin == "" {
		bin = "python3"
	}
	if _, err := exec.LookPath(bin); err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatalf("%s is required for the parity harness", bin)
		}
		t.Skip("python not available")
	}
	return bin
}

func appDir() string {
	if d := os.Getenv("PY_APP_DIR"); d != "" {
		return d
	}
	d, _ := filepath.Abs("../../../../infra-sec_auth-broker/src/code")
	return d
}

// stream mirrors ref.py Stream: sha256(seed || be64(counter)) blocks.
type stream struct {
	mu   sync.Mutex
	seed []byte
	ctr  uint64
	buf  []byte
}

func (s *stream) Bytes(n int) []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.buf) < n {
		var c [8]byte
		binary.BigEndian.PutUint64(c[:], s.ctr)
		h := sha256.Sum256(append(append([]byte(nil), s.seed...), c[:]...))
		s.buf = append(s.buf, h[:]...)
		s.ctr++
	}
	out := append([]byte(nil), s.buf[:n]...)
	s.buf = s.buf[n:]
	return out
}

// randBelow mirrors ref.py: int.from_bytes(8 bytes, "big") % n.
func (s *stream) randBelow(n int64) int64 {
	return int64(binary.BigEndian.Uint64(s.Bytes(8)) % uint64(n))
}

type side struct {
	name, base string
	mock       *mock
	setClock   func(int64)
	cl         *http.Client
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func newClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{DisableKeepAlives: true}}
}

var clockNow = t0

func reset() { atomic.StoreInt64(&clockNow, t0) }

func baseEnv() map[string]string {
	return map[string]string{
		"AUTH_BROKER_COOKIE_SECRET": cookieSecret,
		"AB_GOOGLE_CLIENT_ID":       "google-client-id", "AB_GOOGLE_CLIENT_SECRET": "google-client-secret",
		"AB_GHAPP_CLIENT_SECRET": "ghapp-client-secret",
		"AB_GHDEV_CLIENT_SECRET": "ghdev-client-secret",
		"AB_RESEND_KEY":          "resend-key-synthetic",
	}
}

type world struct {
	doc  func(mockURL string) string
	env  map[string]string
	prov string
	seed string
	mock func(t *testing.T) *mock
}

func startPy(t *testing.T, w world) *side {
	bin := requirePython(t)
	dir := t.TempDir()
	clock := filepath.Join(dir, "clock")
	os.WriteFile(clock, []byte(strconv.FormatInt(atomic.LoadInt64(&clockNow), 10)), 0o600)
	mk := w.mock(t)
	conf := filepath.Join(dir, "build.json")
	os.WriteFile(conf, []byte(w.doc(mk.srv.URL)), 0o600)
	port := freePort(t)
	cmd := exec.Command(bin, "ref.py", "serve", strconv.Itoa(port), clock, w.seed)
	cmd.Env = append(os.Environ(), "PY_APP_DIR="+appDir(), "BROKER_CONFIG="+conf, "BROKER_PROVIDER="+w.prov)
	for k, v := range w.env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var errb bytes.Buffer
	cmd.Stderr = &errb
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		rd := bufio.NewReader(stdout)
		line, _ := rd.ReadString('\n')
		ready <- line
		io.Copy(io.Discard, rd)
	}()
	select {
	case line := <-ready:
		if !strings.HasPrefix(line, "READY") {
			t.Fatalf("python reference did not start: %q\n%s", line, errb.String())
		}
	case <-time.After(60 * time.Second):
		t.Fatalf("python reference start timeout\n%s", errb.String())
	}
	return &side{name: "python", base: "http://127.0.0.1:" + strconv.Itoa(port), mock: mk, cl: newClient(),
		setClock: func(v int64) { os.WriteFile(clock, []byte(strconv.FormatInt(v, 10)), 0o600) }}
}

func goBroker(t *testing.T, w world, mk *mock, clk *int64, st *stream) *broker.Broker {
	doc, err := fleetauth.ParseJSON([]byte(w.doc(mk.srv.URL)))
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{}
	for k, v := range w.env {
		env[k] = v
	}
	if mutate() {
		env["AUTH_BROKER_COOKIE_SECRET"] += "-skewed"
	}
	b, err := broker.New(broker.Config{Doc: doc, Provider: w.prov, Env: func(k string) string { return env[k] },
		Now: func() float64 { return float64(atomic.LoadInt64(clk)) }, Rand: st.Bytes, RandBelow: st.randBelow, Out: func(string) {}})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func startGo(t *testing.T, w world) *side {
	clk := new(int64)
	atomic.StoreInt64(clk, atomic.LoadInt64(&clockNow))
	mk := w.mock(t)
	b := goBroker(t, w, mk, clk, &stream{seed: []byte(w.seed)})
	srv := httptest.NewServer(b.Handler())
	t.Cleanup(srv.Close)
	return &side{name: "go", base: srv.URL, mock: mk, cl: newClient(), setClock: func(v int64) { atomic.StoreInt64(clk, v) }}
}

type step struct {
	name, method, path string
	host               string // Host header; default chooserHost
	hdr                map[string]string
	body               string
	want               int // status the Python reference must give (guards against a vacuous corpus); -1 = connection dropped
	cap                func(resp) map[string]string
	advance            int64
	hook               func(s *side) // runs on both sides before the request (mock behaviour switches)
	after              func(py *side, vars map[string]string)
}

type resp struct {
	status int
	hdr    []string
	loc    string
	body   string
}

var compared = []string{"Content-Type", "Content-Length", "Cache-Control", "X-Content-Type-Options", "Location", "Set-Cookie",
	"X-Auth-Request-Email", "Content-Security-Policy", "Connection"}

func (s *side) do(t *testing.T, st step, vars map[string]string) resp {
	sub := func(x string) string {
		x = strings.ReplaceAll(x, "@U@", "\x5cu")
		for k, v := range vars {
			x = strings.ReplaceAll(x, "{"+k+"}", v)
		}
		return x
	}
	var rd io.Reader
	if st.body != "" {
		rd = strings.NewReader(sub(st.body))
	}
	req, err := http.NewRequest(st.method, s.base+sub(st.path), rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = chooserHost
	if st.host != "" {
		req.Host = st.host
	}
	for k, v := range st.hdr {
		req.Header[k] = []string{sub(v)}
	}
	r, err := s.cl.Do(req)
	if err != nil {
		return resp{status: -1, body: "connection dropped"}
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	out := resp{status: r.StatusCode, body: string(b), loc: r.Header.Get("Location")}
	for _, h := range compared {
		for _, v := range r.Header.Values(h) {
			out.hdr = append(out.hdr, h+": "+v)
		}
	}
	return out
}

func (a resp) diff(b resp) string {
	var d []string
	if a.status != b.status {
		d = append(d, fmt.Sprintf("status %d != %d", a.status, b.status))
	}
	if strings.Join(a.hdr, "\n") != strings.Join(b.hdr, "\n") {
		d = append(d, fmt.Sprintf("headers %q != %q", a.hdr, b.hdr))
	}
	if a.body != b.body {
		d = append(d, fmt.Sprintf("body %q != %q", clip(a.body), clip(b.body)))
	}
	return strings.Join(d, "; ")
}

func clip(s string) string {
	if len(s) > 500 {
		return s[:500] + "..."
	}
	return s
}

// run drives the same steps against both sides; it returns the number of differing steps.
func run(t *testing.T, py, gs *side, steps []step, vars map[string]string) int {
	t.Helper()
	diffs := 0
	for i, st := range steps {
		if st.hook != nil {
			st.hook(py)
			st.hook(gs)
		}
		if st.advance != 0 {
			now := atomic.AddInt64(&clockNow, st.advance)
			py.setClock(now)
			gs.setClock(now)
		}
		a, b := py.do(t, st, vars), gs.do(t, st, vars)
		if st.want != 0 && a.status != st.want {
			t.Errorf("step %d %q: the reference answered %d, the corpus expects %d (%s)", i, st.name, a.status, st.want, clip(a.body))
		}
		if d := a.diff(b); d != "" {
			diffs++
			t.Errorf("request %d %q %s %s differs: %s", i, st.name, st.method, st.path, d)
		}
		if st.cap != nil {
			for k, v := range st.cap(a) {
				vars[k] = v
			}
		}
		if st.after != nil {
			st.after(py, vars)
		}
	}
	return diffs
}

// compareMocks requires that both sides asked the upstreams the same things in the same order.
func compareMocks(t *testing.T, py, gs *side) int {
	t.Helper()
	if a, b := py.mock.logText(), gs.mock.logText(); a != b {
		t.Errorf("upstream calls differ:\n--- python\n%s\n--- go\n%s", a, b)
		return 1
	}
	return 0
}

// ---- captures and cookies ------------------------------------------------------------------------------------

func capJSON(ph, key string) func(resp) map[string]string {
	rx := regexp.MustCompile(`"` + key + `": "([^"]*)"`)
	return func(r resp) map[string]string {
		if m := rx.FindStringSubmatch(r.body); m != nil {
			return map[string]string{ph: m[1]}
		}
		return nil
	}
}

func capLoc(ph, key string) func(resp) map[string]string {
	return func(r resp) map[string]string {
		rx := regexp.MustCompile(`[?&]` + key + `=([^&]*)`)
		if m := rx.FindStringSubmatch(r.loc); m != nil {
			return map[string]string{ph: m[1]}
		}
		return nil
	}
}

func capCookie(ph, name string) func(resp) map[string]string {
	rx := regexp.MustCompile(`^Set-Cookie: ` + regexp.QuoteMeta(name) + `=([^;]*);`)
	return func(r resp) map[string]string {
		for _, h := range r.hdr {
			if m := rx.FindStringSubmatch(h); m != nil && m[1] != "" {
				return map[string]string{ph: m[1]}
			}
		}
		return nil
	}
}

func both(fs ...func(resp) map[string]string) func(resp) map[string]string {
	return func(r resp) map[string]string {
		out := map[string]string{}
		for _, f := range fs {
			for k, v := range f(r) {
				out[k] = v
			}
		}
		return out
	}
}

func mint(secret, body string) string {
	b := b64u([]byte(body))
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("v1." + b))
	return "v1." + b + "." + b64u(m.Sum(nil))
}

func goodCookie() string {
	return mint(cookieSecret, fmt.Sprintf(`{"sub": "owner@example.org", "p": "x", "iat": %d, "exp": %d}`, t0, t0+3600))
}

func ck(v string) map[string]string { return map[string]string{"Cookie": cookieName + "=" + v} }

func jsonPost(extra ...string) map[string]string {
	h := map[string]string{"Content-Type": "application/json", "X-Requested-With": "sso", "Origin": "https://" + chooserHost}
	for i := 0; i+1 < len(extra); i += 2 {
		h[extra[i]] = extra[i+1]
	}
	return h
}

func get(name, path string, want int) step {
	return step{name: name, method: "GET", path: path, want: want}
}

func post(name, path, body string, want int, extra ...string) step {
	return step{name: name, method: "POST", path: path, hdr: jsonPost(extra...), body: body, want: want}
}

// sessionSteps check /auth with a set of hand-made cookies against the session rules.
func sessionSteps(prefix string) []step {
	s := []step{
		get("auth without cookie", prefix+"/auth", 401),
		{name: "auth good cookie", method: "GET", path: prefix + "/auth", hdr: ck(goodCookie()), want: 202},
		{name: "auth padded cookie header", method: "GET", path: prefix + "/auth", hdr: map[string]string{"Cookie": "a=b;  " + cookieName + "=" + goodCookie() + " ; c=d"}, want: 202},
		{name: "auth bad then good", method: "GET", path: prefix + "/auth", hdr: map[string]string{"Cookie": cookieName + "=bad; " + cookieName + "=" + goodCookie()}, want: 202},
		{name: "auth other cookie name", method: "GET", path: prefix + "/auth", hdr: map[string]string{"Cookie": cookieName + "x=" + goodCookie()}, want: 401},
	}
	for _, c := range []struct {
		name, body string
		want       int
	}{
		{"expired", fmt.Sprintf(`{"sub": "o@example.org", "exp": %d}`, t0-1), 401},
		{"exactly now", fmt.Sprintf(`{"sub": "o@example.org", "exp": %d}`, t0), 401},
		{"string exp", `{"sub": "o@example.org", "exp": "9999999999"}`, 202},
		{"float exp", `{"sub": "o@example.org", "exp": 9999999999.5}`, 202},
		{"bool exp", `{"sub": "o@example.org", "exp": true}`, 401},
		{"no exp", `{"sub": "o@example.org"}`, 401},
		{"no sub", `{"exp": 9999999999}`, 401},
		{"numeric sub", `{"sub": 5, "exp": 9999999999}`, 202},
		{"zero sub", `{"sub": 0, "exp": 9999999999}`, 401},
		{"empty sub", `{"sub": "", "exp": 9999999999}`, 401},
		{"null sub", `{"sub": null, "exp": 9999999999}`, 401},
		{"list sub", `{"sub": ["a"], "exp": 9999999999}`, 202},
		{"true sub", `{"sub": true, "exp": 9999999999}`, 202},
		{"list body", `[1]`, 401},
		{"not json", `nope`, 401},
		{"bad exp text", `{"sub": "o", "exp": "soon"}`, 401},
	} {
		s = append(s, step{name: "auth cookie " + c.name, method: "GET", path: prefix + "/auth", hdr: ck(mint(cookieSecret, c.body)), want: c.want})
	}
	good := goodCookie()
	s = append(s,
		step{name: "auth foreign secret", method: "GET", path: prefix + "/auth", hdr: ck(mint("another-secret-0123456789abcdef0123456", `{"sub": "o", "exp": 9999999999}`)), want: 401},
		step{name: "auth tampered body", method: "GET", path: prefix + "/auth", hdr: ck(strings.Replace(good, "v1.", "v1.x", 1)), want: 401},
		step{name: "auth wrong version", method: "GET", path: prefix + "/auth", hdr: ck(strings.Replace(good, "v1.", "v2.", 1)), want: 401},
		step{name: "auth four parts", method: "GET", path: prefix + "/auth", hdr: ck(good + ".x"), want: 401},
		step{name: "auth two parts", method: "GET", path: prefix + "/auth", hdr: ck("v1.abc"), want: 401},
		step{name: "auth non-ascii signature", method: "GET", path: prefix + "/auth", hdr: ck(strings.Join(strings.Split(good, ".")[:2], ".") + ".sé"), want: 401},
		step{name: "auth empty value", method: "GET", path: prefix + "/auth", hdr: ck(""), want: 401})
	return s
}

// commonSteps are the requests every provider answers the same way.
func commonSteps(prefix string, enabled bool) []step {
	s := []step{
		get("health", prefix+"/health", 200),
		get("outside the prefix", "/nope", 404),
		get("prefix without slash", prefix, 404),
		get("longer prefix", prefix+"x/health", 404),
		get("unknown op", prefix+"/nothing", 404),
		get("host-looking target", "//evil.example"+prefix+"/health", 200),
		get("query on health", prefix+"/health?x=1&y=%00", 200),
		{name: "head", method: "HEAD", path: prefix + "/health", want: 501},
		{name: "put", method: "PUT", path: prefix + "/health", want: 501},
		{name: "delete", method: "DELETE", path: prefix + "/health", want: 501},
		{name: "options", method: "OPTIONS", path: prefix + "/health", want: 501},
		{name: "patch odd name", method: "PATCH", path: prefix + "/health", want: 501},
		{name: "post outside", method: "POST", path: "/nope", hdr: jsonPost(), body: `{}`, want: 403},
		post("post unknown op", prefix+"/nothing", `{}`, 404),
		{name: "post no requested-with", method: "POST", path: prefix + "/nothing", hdr: map[string]string{"Content-Type": "application/json"}, body: `{}`, want: 403},
		{name: "post foreign origin", method: "POST", path: prefix + "/nothing", hdr: jsonPost("Origin", "https://evil.example"), body: `{}`, want: 403},
		{name: "post origin with port", method: "POST", path: prefix + "/nothing", hdr: jsonPost("Origin", "https://"+chooserHost+":8443"), body: `{}`, want: 403},
		{name: "post broken origin", method: "POST", path: prefix + "/nothing", hdr: jsonPost("Origin", "http://[::1"), body: `{}`, want: -1},
		{name: "post requested-with wrong", method: "POST", path: prefix + "/nothing", hdr: jsonPost("X-Requested-With", "xhr"), body: `{}`, want: 403},
		post("post broken json", prefix+"/nothing", `{`, 400),
		post("post json too long", prefix+"/nothing", `{"x":"`+strings.Repeat("a", 5000)+`"}`, 400),
		post("post empty body", prefix+"/nothing", ``, 404),
		get("cf-auth without header", prefix+"/cf-auth", 401),
	}
	return append(s, sessionSteps(prefix)...)
}
