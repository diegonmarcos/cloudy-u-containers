//go:build parity

// Package parity runs the ORIGINAL Python service (infra-sec_cloudy-ai-tokens-api/src/code/main.py, unmodified, driven
// by ref.py) and the Go port on identical requests and requires identical answers: status, the headers that matter,
// the exact body bytes, the resulting sqlite rows, and the calls each side made to the introspection upstream.
//
// Both sides get the same clock and the same deterministic byte stream, so token ids and values are equal too.
// Synthetic keys, tokens and sqlite fixtures are generated here; nothing real is used.
//
// Run: PARITY_REQUIRE=1 go test -count=1 -tags parity -v -run TestParity ./parity/
// PARITY_MUTATE=1 skews the Go side (a different admin client id): the harness must then report differing requests.
package parity

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"tokens-api/tokensapi"
)

const (
	t0      = int64(1_800_000_000)
	vsecret = "verify-secret-synthetic"
	owner   = "owner@example.org"
)

// A synthetic fleet key made at run time; no key material is committed.
var fleetKey = func() string {
	h := sha256.Sum256([]byte("tokens-api parity synthetic fleet key"))
	return base64.RawURLEncoding.EncodeToString(h[:])
}()

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
	d, _ := filepath.Abs("../../../../infra-sec_cloudy-ai-tokens-api/src/code")
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

// mock is the introspect-proxy stand-in; it records every call.
type mock struct {
	srv *httptest.Server
	mu  sync.Mutex
	log []string
}

func newMock(t *testing.T) *mock {
	m := &mock{}
	m.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		m.mu.Lock()
		m.log = append(m.log, r.Method+" "+r.URL.Path+" "+tok)
		m.mu.Unlock()
		switch tok {
		case "jwt-admin", "jwt-204":
			w.Header().Set("X-Auth-User", "cloud-admin")
			if tok == "jwt-204" {
				w.WriteHeader(204)
			}
		case "jwt-other":
			w.Header().Set("X-Auth-User", "someone")
		case "jwt-403":
			w.WriteHeader(403)
		case "jwt-502":
			w.WriteHeader(502)
		case "jwt-503":
			w.WriteHeader(503)
		default:
			w.WriteHeader(401)
		}
	}))
	t.Cleanup(m.srv.Close)
	return m
}

type side struct {
	name, base, db, clockFile string
	mock                      *mock
	setClock                  func(int64)
	cl                        *http.Client
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

type conf struct{ proxies, owner, admins string }

func newClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{DisableKeepAlives: true}}
}

func startPy(t *testing.T, c conf, db, seed string) *side {
	bin := requirePython(t)
	dir := t.TempDir()
	clock := filepath.Join(dir, "clock")
	os.WriteFile(clock, []byte(strconv.FormatInt(t0, 10)), 0o600)
	mk := newMock(t)
	port := freePort(t)
	cmd := exec.Command(bin, "ref.py", "serve", strconv.Itoa(port), db, clock, seed)
	cmd.Env = append(os.Environ(), "PY_APP_DIR="+appDir(), "PARITY_FLEET_KEY="+fleetKey, "TOKENS_VERIFY_SECRET="+vsecret,
		"OWNER_EMAIL="+c.owner, "ADMIN_CLIENT_IDS="+c.admins, "TRUSTED_PROXIES="+c.proxies, "INTROSPECT_URL="+mk.srv.URL+"/auth", "INTROSPECT_TIMEOUT=5")
	var errb bytes.Buffer
	cmd.Stderr = &errb
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		ready <- line
	}()
	select {
	case line := <-ready:
		if !strings.HasPrefix(line, "READY") {
			t.Fatalf("python reference did not start: %q\n%s", line, errb.String())
		}
	case <-time.After(60 * time.Second):
		t.Fatalf("python reference start timeout\n%s", errb.String())
	}
	return &side{name: "python", base: "http://127.0.0.1:" + strconv.Itoa(port), db: db, clockFile: clock, mock: mk, cl: newClient(),
		setClock: func(v int64) { os.WriteFile(clock, []byte(strconv.FormatInt(v, 10)), 0o600) }}
}

func startGo(t *testing.T, c conf, db, seed string) *side {
	mk := newMock(t)
	clk := new(int64)
	atomic.StoreInt64(clk, t0)
	admins := c.admins
	if mutate() {
		admins += "-skewed"
	}
	st := &stream{seed: []byte(seed)}
	app, err := tokensapi.New(tokensapi.Config{
		DBPath: db, FleetKey: fleetKey, VerifySecret: vsecret, OwnerEmail: c.owner, AdminClientIDs: admins, TrustedProxies: c.proxies,
		IntrospectURL: mk.srv.URL + "/auth", IntrospectTimeout: 5 * time.Second,
		Clock: func() float64 { return float64(atomic.LoadInt64(clk)) }, Rand: st.Bytes,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler())
	t.Cleanup(func() { srv.Close(); app.Close() })
	return &side{name: "go", base: srv.URL, db: db, mock: mk, cl: newClient(), setClock: func(v int64) { atomic.StoreInt64(clk, v) }}
}

type step struct {
	name, method, path string
	hdr                map[string]string
	body               string
	want               int               // status the Python reference must give (guards against a vacuous corpus)
	cap                map[string]string // placeholder -> top-level JSON key of the reference answer
	advance            int64             // seconds to add to both clocks first
	pre                func(t *testing.T, py, gs *side)
}

type resp struct {
	status int
	hdr    []string
	body   string
}

var compared = []string{"Content-Type", "Cache-Control", "Allow", "Location", "Set-Cookie", "X-Auth-Request-Email"}

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
	for k, v := range st.hdr {
		req.Header[k] = []string{sub(v)}
	}
	r, err := s.cl.Do(req)
	if err != nil {
		t.Fatalf("%s %s %s: %v", s.name, st.method, st.path, err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	out := resp{status: r.StatusCode, body: string(b)}
	for _, h := range compared {
		for _, v := range r.Header.Values(h) {
			if h == "Allow" { // werkzeug builds it from a set: the order changes with PYTHONHASHSEED, the members do not
				ms := strings.Split(v, ", ")
				sort.Strings(ms)
				v = strings.Join(ms, ", ")
			}
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
	if len(s) > 400 {
		return s[:400] + "..."
	}
	return s
}

// run drives the same steps against both sides; it returns the number of differing steps.
func run(t *testing.T, py, gs *side, steps []step, vars map[string]string) int {
	t.Helper()
	diffs := 0
	for i, st := range steps {
		if st.pre != nil {
			st.pre(t, py, gs)
		}
		if st.advance != 0 {
			vars["now"] = strconv.FormatInt(atomic.AddInt64(&clockNow, st.advance), 10)
			py.setClock(clockNow)
			gs.setClock(clockNow)
		}
		a, b := py.do(t, st, vars), gs.do(t, st, vars)
		if st.want != 0 && a.status != st.want {
			t.Errorf("step %d %q: the reference answered %d, the corpus expects %d (%s)", i, st.name, a.status, st.want, clip(a.body))
		}
		if d := a.diff(b); d != "" {
			diffs++
			t.Errorf("request %d %q %s %s differs: %s", i, st.name, st.method, st.path, d)
		}
		for ph, key := range st.cap {
			var m map[string]any
			if err := json.Unmarshal([]byte(a.body), &m); err != nil || m[key] == nil {
				t.Fatalf("step %q: cannot capture %s from %s", st.name, key, clip(a.body))
			}
			vars[ph] = fmt.Sprint(m[key])
		}
	}
	return diffs
}

var clockNow = t0

func sqlDump(t *testing.T, path string) string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var sb strings.Builder
	dump := func(q string) {
		rows, err := db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		cols, _ := rows.Columns()
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			for i, v := range vals {
				fmt.Fprintf(&sb, "%s=%v|", cols[i], v)
			}
			sb.WriteString("\n")
		}
	}
	dump("SELECT id,name,kind,audience,scopes,subject,created_at,expires_at,revoked_at,last_used_at,created_by,source,hint,idx,length(nonce) AS nl,length(ct) AS cl FROM tokens ORDER BY id")
	dump("SELECT seq,ts,actor,action,token_id,token_name,detail FROM audit ORDER BY seq")
	return sb.String()
}

func jsonH() map[string]string { return map[string]string{"Content-Type": "application/json"} }
func adminH() map[string]string {
	return map[string]string{"Authorization": "Bearer jwt-admin", "Content-Type": "application/json"}
}
func verifyH() map[string]string {
	return map[string]string{"X-Verify-Secret": vsecret, "Content-Type": "application/json"}
}
func bearer(v string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + v, "Content-Type": "application/json"}
}
func session(e string) map[string]string {
	return map[string]string{"Remote-Email": e, "Content-Type": "application/json"}
}

func jwtLike(claims string) string {
	e := func(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
	return e(`{"alg":"RS256","kid":"synthetic"}`) + "." + e(claims) + "." + e("not-a-real-signature")
}

func corpus() []step {
	long := strings.Repeat("n", 81)
	importJWT := jwtLike(fmt.Sprintf(`{"sub":"imp-user","scp":["x","y"],"exp":%d,"client_id":"c"}`, t0+777777))
	scpStr := jwtLike(`{"sub":"s","scp":"a b","exp":1800500000}`)
	emptyClaims := "x.e30.y"
	hostUp := jwtLike(`{"sub":"x"}`)
	return []step{
		// routing and the Flask error pages
		{name: "health", method: "GET", path: "/health", want: 200},
		{name: "unknown path", method: "GET", path: "/nope", want: 404},
		{name: "trailing slash", method: "GET", path: "/v1/tokens/", want: 404},
		{name: "wrong method", method: "DELETE", path: "/v1/tokens", want: 405},
		{name: "options", method: "OPTIONS", path: "/v1/tokens", want: 200},
		{name: "post health", method: "POST", path: "/health", want: 405},
		{name: "get verify", method: "GET", path: "/v1/verify", want: 405},
		// who may call the owner API
		{name: "no credential", method: "GET", path: "/v1/tokens", want: 401},
		{name: "unknown ft_", method: "GET", path: "/v1/tokens", hdr: bearer("ft_unknownunknownunknown"), want: 403},
		{name: "jwt not admin", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-other"), want: 403},
		{name: "jwt 401", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-401"), want: 401},
		{name: "jwt 403", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-403"), want: 403},
		{name: "jwt 502", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-502"), want: 403},
		{name: "jwt 503", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-503"), want: 503},
		{name: "jwt 204", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-204"), want: 403},
		{name: "padded bearer", method: "GET", path: "/v1/tokens", hdr: map[string]string{"Authorization": "Bearer   jwt-admin  "}, want: 200},
		{name: "session owner", method: "GET", path: "/v1/tokens", hdr: session(owner), want: 200},
		{name: "session owner upper", method: "GET", path: "/v1/tokens", hdr: session("OWNER@Example.ORG"), want: 200},
		{name: "session stranger", method: "GET", path: "/v1/tokens", hdr: session("stranger@example.org"), want: 401},
		{name: "session non-ascii", method: "GET", path: "/v1/tokens", hdr: session("ownér@example.org"), want: 500},
		// create
		{name: "create", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, cap: map[string]string{"id1": "id", "val1": "value"},
			body: `{"name":"ci-bot","audience":"api.example.org, *.mesh.example.org","scopes":["read","tokens:admin"],"ttl_days":2}`},
		{name: "create unicode", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, cap: map[string]string{"id2": "id", "val2": "value"},
			body: `{"name":"Zo@U@00eb @U@d83d@U@de42 caf@U@00e9","scopes":"a b,c","ttl_days":"5"}`},
		{name: "ttl true", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, cap: map[string]string{"id3": "id", "val3": "value"}, body: `{"name":"x","ttl_days":true}`},
		{name: "ttl zero", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, cap: map[string]string{"id4": "id", "val4": "value"}, body: `{"name":"forever","ttl_days":0}`},
		{name: "ttl text", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","ttl_days":"abc"}`},
		{name: "ttl range", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","ttl_days":3651}`},
		{name: "ttl half", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","ttl_days":0.5}`},
		{name: "ttl list", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","ttl_days":[1]}`},
		{name: "ttl infinity", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 500, body: `{"name":"x","ttl_days":Infinity}`},
		{name: "no name", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{}`},
		{name: "long name", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"` + long + `"}`},
		{name: "bad audience", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","audience":"bad host"}`},
		{name: "audience list", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, cap: map[string]string{"id5": "id", "val5": "value"},
			body: `{"name":"x","audience":["a.example.org","b.example.org"]}`},
		{name: "bad scope", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{"name":"x","scopes":["ok","not ok"]}`},
		{name: "numeric scopes", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, body: `{"name":"x","scopes":[1,2]}`},
		{name: "null scopes", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, body: `{"name":"x","scopes":null}`},
		{name: "null audience", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, body: `{"name":"x","audience":null}`},
		{name: "not json type", method: "POST", path: "/v1/tokens", hdr: map[string]string{"Authorization": "Bearer jwt-admin", "Content-Type": "text/plain"}, want: 400, body: `{"name":"x"}`},
		{name: "plus json type", method: "POST", path: "/v1/tokens", hdr: map[string]string{"Authorization": "Bearer jwt-admin", "Content-Type": "application/vnd.api+json"}, want: 201, body: `{"name":"plusjson"}`},
		{name: "json list body", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 500, body: `[1]`},
		{name: "json empty list", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `[]`},
		{name: "broken json", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 400, body: `{`},
		{name: "padded name", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201, body: `{"name":"  padded  "}`},
		{name: "create by session", method: "POST", path: "/v1/tokens", hdr: session(owner), want: 201, cap: map[string]string{"id6": "id"}, body: `{"name":"by-session"}`},
		// an ft_ token that carries tokens:admin is itself an owner credential
		{name: "ft admin lists", method: "GET", path: "/v1/tokens", hdr: bearer("{val1}"), want: 200},
		{name: "ft without admin", method: "GET", path: "/v1/tokens", hdr: bearer("{val3}"), want: 403},
		{name: "get one", method: "GET", path: "/v1/tokens/{id1}", hdr: adminH(), want: 200},
		{name: "get missing", method: "GET", path: "/v1/tokens/tk_missing", hdr: adminH(), want: 404},
		{name: "get import", method: "GET", path: "/v1/tokens/import", hdr: adminH(), want: 404},
		// the verifier endpoint
		{name: "verify no secret", method: "POST", path: "/v1/verify", hdr: jsonH(), body: `{"token":"{val1}"}`, want: 403},
		{name: "verify wrong secret", method: "POST", path: "/v1/verify", hdr: map[string]string{"X-Verify-Secret": "nope", "Content-Type": "application/json"}, body: `{"token":"{val1}"}`, want: 403},
		{name: "verify non-ascii secret", method: "POST", path: "/v1/verify", hdr: map[string]string{"X-Verify-Secret": "sécret", "Content-Type": "application/json"}, body: `{}`, want: 500},
		{name: "verify empty", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{}`, want: 200},
		{name: "verify unknown ft", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"ft_unknownunknownunknown"}`, want: 200},
		{name: "verify ok", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}","host":"api.example.org:443"}`, want: 200},
		{name: "verify glob", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}","host":"x.mesh.example.org"}`, want: 200},
		{name: "verify wrong host", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}","host":"evil.example.com"}`, want: 200},
		{name: "verify no host", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}"}`, want: 200},
		{name: "verify host case", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}","host":"API.Example.ORG"}`, want: 200},
		{name: "verify star audience", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val2}","host":"anything.example"}`, want: 200},
		{name: "verify numeric host", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val1}","host":5}`, want: 200},
		{name: "verify null token", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":null}`, want: 200},
		{name: "verify numeric token", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":12345}`, want: 200},
		{name: "verify list body", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `[1]`, want: 500},
		{name: "adopt", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200,
			body: `{"token":"` + hostUp + `","adopt":{"client_id":"cloud-admin","sub":"user-1","scp":["authelia.bearer.authz","x"],"exp":1800003600}}`},
		{name: "adopt again", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200,
			body: `{"token":"` + hostUp + `","adopt":{"client_id":"other"}}`},
		{name: "adopt bad scope", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200, body: `{"token":"j2.b.c","adopt":{"scp":["bad scope"]}}`},
		{name: "adopt not a dict", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200, body: `{"token":"j3.b.c","adopt":"x"}`},
		{name: "adopt nan exp", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 500, body: `{"token":"j4.b.c","adopt":{"exp":NaN}}`},
		{name: "adopt true exp", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200, body: `{"token":"j5.b.c","adopt":{"exp":true,"client_id":"c"}}`},
		{name: "adopt float exp", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200, body: `{"token":"j6.b.c","adopt":{"exp":1800009999.9}}`},
		{name: "adopt huge exp", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 500, body: `{"token":"j7.b.c","adopt":{"exp":99999999999999999999}}`},
		{name: "adopt long fields", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200,
			body: `{"token":"j8.b.c","adopt":{"client_id":"` + strings.Repeat("c", 100) + `","sub":"` + strings.Repeat("s", 130) + `","scp":[1,"a"]}}`},
		{name: "adopt ft_ refused", method: "POST", path: "/v1/verify", hdr: verifyH(), want: 200, body: `{"token":"ft_notminted","adopt":{"client_id":"c"}}`},
		// revoke, expiry, reveal
		{name: "revoke", method: "POST", path: "/v1/tokens/{id3}/revoke", hdr: adminH(), want: 200},
		{name: "revoke again", method: "POST", path: "/v1/tokens/{id3}/revoke", hdr: adminH(), want: 200},
		{name: "revoke missing", method: "POST", path: "/v1/tokens/tk_missing/revoke", hdr: adminH(), want: 404},
		{name: "verify revoked", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{val3}"}`, want: 200},
		{name: "ft revoked as owner", method: "GET", path: "/v1/tokens", hdr: bearer("{val3}"), want: 403},
		{name: "reveal", method: "POST", path: "/v1/tokens/{id1}/reveal", hdr: adminH(), want: 200},
		{name: "reveal unicode name", method: "POST", path: "/v1/tokens/{id2}/reveal", hdr: adminH(), want: 200},
		{name: "reveal missing", method: "POST", path: "/v1/tokens/tk_missing/reveal", hdr: adminH(), want: 404},
		{name: "reveal without auth", method: "POST", path: "/v1/tokens/{id1}/reveal", want: 401},
		{name: "three days later", method: "POST", path: "/v1/verify", hdr: verifyH(), advance: 3 * 86400, body: `{"token":"{val1}"}`, want: 200},
		{name: "expired owner token", method: "GET", path: "/v1/tokens", hdr: bearer("{val1}"), want: 403},
		{name: "list after expiry", method: "GET", path: "/v1/tokens", hdr: adminH(), want: 200},
		// import
		{name: "import jwt", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201, cap: map[string]string{"idi": "id"},
			body: `{"name":"imported jwt","value":"` + importJWT + `"}`},
		{name: "import duplicate", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 409, body: `{"name":"again","value":"` + importJWT + `"}`},
		{name: "import opaque", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201,
			body: `{"name":"opaque","value":"  opaque-secret-value-1 ","audience":"a.example.org","scopes":"s1 s2","expires_at":null}`},
		{name: "import no value", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 400, body: `{"name":"n"}`},
		{name: "import no name", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 400, body: `{"value":"v"}`},
		{name: "import bad scope", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 400, body: `{"name":"bad","value":"v2","scopes":["bad scope"]}`},
		{name: "import bad audience", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 400, body: `{"name":"bad","value":"v3","audience":"a b"}`},
		{name: "import empty claims", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201, body: `{"name":"claimless","value":"` + emptyClaims + `"}`},
		{name: "import string scp", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201, body: `{"name":"strscp","value":"` + scpStr + `"}`},
		{name: "import float expiry", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201, body: `{"name":"fexp","value":"v4","expires_at":1800123456.7}`},
		{name: "import string expiry", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201, body: `{"name":"sexp","value":"v5","expires_at":"123"}`},
		{name: "import nan expiry", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 500, body: `{"name":"nan","value":"v6","expires_at":NaN}`},
		{name: "verify imported", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"` + importJWT + `"}`, want: 200},
		// audit
		{name: "audit", method: "GET", path: "/v1/audit", hdr: adminH(), want: 200},
		{name: "audit limit 2", method: "GET", path: "/v1/audit?limit=2", hdr: adminH(), want: 200},
		{name: "audit limit 0", method: "GET", path: "/v1/audit?limit=0", hdr: adminH(), want: 200},
		{name: "audit limit big", method: "GET", path: "/v1/audit?limit=9999", hdr: adminH(), want: 200},
		{name: "audit limit text", method: "GET", path: "/v1/audit?limit=abc", hdr: adminH(), want: 200},
		{name: "audit limit negative", method: "GET", path: "/v1/audit?limit=-5", hdr: adminH(), want: 200},
		{name: "audit limit empty", method: "GET", path: "/v1/audit?limit=", hdr: adminH(), want: 200},
		{name: "final list", method: "GET", path: "/v1/tokens", hdr: adminH(), want: 200},
		// a ciphertext that was altered on disk must not decrypt
		{name: "tamper then reveal", method: "POST", path: "/v1/tokens/{id2}/reveal", hdr: adminH(), want: 500, pre: func(t *testing.T, py, gs *side) {
			for _, s := range []*side{py, gs} {
				db, err := sql.Open("sqlite", s.db)
				if err != nil {
					t.Fatal(err)
				}
				var id string
				var ct []byte
				if err := db.QueryRow("SELECT id, ct FROM tokens WHERE name LIKE 'Zo%'").Scan(&id, &ct); err != nil {
					t.Fatal(err)
				}
				ct[0] ^= 0xff
				if _, err := db.Exec("UPDATE tokens SET ct = ? WHERE id = ?", ct, id); err != nil {
					t.Fatal(err)
				}
				db.Close()
			}
		}},
	}
}

func reset() { atomic.StoreInt64(&clockNow, t0) }

func TestParityCorpus(t *testing.T) {
	requirePython(t)
	reset()
	dir := t.TempDir()
	c := conf{proxies: "127.0.0.0/8, ::1/128", owner: owner, admins: "cloud-admin"}
	py := startPy(t, c, filepath.Join(dir, "py.sqlite3"), "corpus")
	gs := startGo(t, c, filepath.Join(dir, "go.sqlite3"), "corpus")
	vars := map[string]string{}
	n := run(t, py, gs, corpus(), vars)
	if a, b := sqlDump(t, py.db), sqlDump(t, gs.db); a != b {
		n++
		t.Errorf("sqlite rows differ:\n--- python\n%s\n--- go\n%s", a, b)
	}
	if a, b := strings.Join(py.mock.log, "\n"), strings.Join(gs.mock.log, "\n"); a != b {
		n++
		t.Errorf("introspection upstream calls differ:\n--- python\n%s\n--- go\n%s", a, b)
	}
	if n > 0 {
		t.Fatalf("%d requests differ", n)
	}
	t.Logf("%d requests identical, %d introspection calls identical", len(corpus()), len(py.mock.log))
}

// The same ciphertext format in both directions: a file the Python service wrote opens in Go and the reverse.
func TestParityCrossOpen(t *testing.T) {
	requirePython(t)
	reset()
	dir := t.TempDir()
	c := conf{proxies: "127.0.0.0/8", owner: owner, admins: "cloud-admin"}
	py := startPy(t, c, filepath.Join(dir, "py.sqlite3"), "cross")
	gs := startGo(t, c, filepath.Join(dir, "go.sqlite3"), "cross")
	var steps []step
	for i := 0; i < 6; i++ {
		steps = append(steps, step{name: "create", method: "POST", path: "/v1/tokens", hdr: adminH(), want: 201,
			body: fmt.Sprintf(`{"name":"cross %d é","audience":"a%d.example.org","scopes":["r%d"]}`, i, i, i)})
	}
	steps = append(steps, step{name: "import", method: "POST", path: "/v1/tokens/import", hdr: adminH(), want: 201,
		body: `{"name":"imp","value":"` + jwtLike(`{"sub":"u"}`) + `"}`})
	if n := run(t, py, gs, steps, map[string]string{}); n > 0 {
		t.Fatalf("%d requests differ", n)
	}
	snap := func(src *side, name string) string {
		db, err := sql.Open("sqlite", src.db)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		out := filepath.Join(dir, name)
		if _, err := db.Exec("VACUUM INTO '" + out + "'"); err != nil {
			t.Fatal(err)
		}
		return out
	}
	fromPy, fromGo := snap(py, "from-py.sqlite3"), snap(gs, "from-go.sqlite3")
	// Go serves what Python wrote; Python serves what Go wrote.
	goOverPy := startGo(t, c, fromPy, "other1")
	pyOverGo := startPy(t, c, fromGo, "other2")
	db, _ := sql.Open("sqlite", fromPy)
	rows, err := db.Query("SELECT id FROM tokens ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	rows.Close()
	db.Close()
	if len(ids) != 7 {
		t.Fatalf("expected 7 rows, got %d", len(ids))
	}
	sort.Strings(ids)
	for _, id := range ids {
		st := step{name: "reveal " + id, method: "POST", path: "/v1/tokens/" + id + "/reveal", hdr: adminH()}
		ref := py.do(t, st, nil)
		if ref.status != 200 {
			t.Fatalf("reference reveal %s: %d", id, ref.status)
		}
		for _, other := range []*side{goOverPy, pyOverGo} {
			got := other.do(t, st, nil)
			if d := ref.diff(got); d != "" {
				t.Errorf("reveal %s on %s over the other side's file: %s", id, other.name, d)
			}
		}
	}
}

// AES-256-GCM and the HMAC index against the Python implementation, with fixed nonces.
func TestParityVault(t *testing.T) {
	bin := requirePython(t)
	type vc struct {
		ID    string `json:"id"`
		Value string `json:"value"`
		Nonce string `json:"nonce"`
	}
	long := strings.Repeat("0123456789abcdef", 300)
	cases := []vc{
		{"tk_0000000000", "ft_" + strings.Repeat("A", 43), "000000000000000000000000"},
		{"tk_ffffffffff", jwtLike(`{"sub":"u"}`), "0102030405060708090a0b0c"},
		{"tk_c0ffee0123", "café 🙂 unicode value", "ffffffffffffffffffffffff"},
		{"tk_0a0b0c0d0e", long, "a1a2a3a4a5a6a7a8a9aaabac"},
		{"tk_1", "x", "00112233445566778899aabb"},
	}
	req, _ := json.Marshal(map[string]any{"key": fleetKey, "cases": cases})
	runPy := func(cmd string, in []byte) []map[string]string {
		c := exec.Command(bin, "ref.py", cmd)
		c.Env = append(os.Environ(), "PY_APP_DIR="+appDir())
		c.Stdin = bytes.NewReader(in)
		var out, eb bytes.Buffer
		c.Stdout, c.Stderr = &out, &eb
		if err := c.Run(); err != nil {
			t.Fatalf("ref.py %s: %v\n%s", cmd, err, eb.String())
		}
		var r struct{ Cases []map[string]string }
		if err := json.Unmarshal(out.Bytes(), &r); err != nil {
			t.Fatalf("ref.py %s output: %v\n%s", cmd, err, out.String())
		}
		return r.Cases
	}
	want := runPy("vault", req)
	v, err := tokensapi.NewVault(fleetKey)
	if err != nil {
		t.Fatal(err)
	}
	var openIn []map[string]string
	for i, c := range cases {
		nonce, _ := hex.DecodeString(c.Nonce)
		ct := v.SealWith(nonce, c.ID, c.Value)
		if hex.EncodeToString(ct) != want[i]["ct"] {
			t.Errorf("case %d: ciphertext differs from Python", i)
		}
		if v.Index(c.Value) != want[i]["idx"] {
			t.Errorf("case %d: index differs from Python", i)
		}
		openIn = append(openIn, map[string]string{"id": c.ID, "nonce": c.Nonce, "ct": hex.EncodeToString(ct)})
		if got, err := v.Open(c.ID, nonce, ct); err != nil || got != c.Value {
			t.Errorf("case %d: Go cannot open its own ciphertext", i)
		}
	}
	// tampered ciphertext and wrong id: both must fail on both sides
	bad := append([]byte(nil), mustHex(want[0]["ct"])...)
	bad[3] ^= 0x40
	openIn = append(openIn, map[string]string{"id": cases[0].ID, "nonce": cases[0].Nonce, "ct": hex.EncodeToString(bad)},
		map[string]string{"id": "tk_other", "nonce": cases[0].Nonce, "ct": want[0]["ct"]})
	in, _ := json.Marshal(map[string]any{"key": fleetKey, "cases": openIn})
	for i, r := range runPy("open", in) {
		if i < len(cases) {
			if r["value"] != cases[i].Value {
				t.Errorf("case %d: Python cannot open the Go ciphertext (%v)", i, r)
			}
		} else if r["error"] == "" {
			t.Errorf("tamper case %d: Python opened it", i)
		}
	}
	if _, err := v.Open("tk_0000000000", mustHex(cases[0].Nonce), bad); err == nil {
		t.Error("Go opened a tampered ciphertext")
	}
	if _, err := v.Open("tk_other", mustHex(cases[0].Nonce), mustHex(want[0]["ct"])); err == nil {
		t.Error("Go opened a ciphertext under another token id")
	}
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// Session credentials depend on trusted proxies and OWNER_EMAIL; each variant is its own pair of servers.
func TestParitySessionVariants(t *testing.T) {
	requirePython(t)
	for name, c := range map[string]conf{
		"no trusted proxy": {proxies: "", owner: owner, admins: "cloud-admin"},
		"other network":    {proxies: "10.0.0.0/8", owner: owner, admins: "cloud-admin"},
		"bare address":     {proxies: "127.0.0.1", owner: owner, admins: "cloud-admin"},
		"no owner email":   {proxies: "127.0.0.0/8", owner: "", admins: "cloud-admin"},
		"two admins":       {proxies: "127.0.0.0/8", owner: owner, admins: "cloud-admin other-client"},
	} {
		t.Run(name, func(t *testing.T) {
			reset()
			dir := t.TempDir()
			py := startPy(t, c, filepath.Join(dir, "py.sqlite3"), "var")
			gs := startGo(t, c, filepath.Join(dir, "go.sqlite3"), "var")
			steps := []step{
				{name: "session owner", method: "GET", path: "/v1/tokens", hdr: session(owner)},
				{name: "session other", method: "GET", path: "/v1/tokens", hdr: session("x@example.org")},
				{name: "jwt admin", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-admin")},
				{name: "jwt other", method: "GET", path: "/v1/tokens", hdr: bearer("jwt-other")},
				{name: "create by session", method: "POST", path: "/v1/tokens", hdr: session(owner), body: `{"name":"s"}`},
			}
			if n := run(t, py, gs, steps, map[string]string{}); n > 0 {
				t.Fatalf("%d requests differ", n)
			}
		})
	}
}

// The same sqlite file, built by the Python Store/Vault: every kind of row, read and changed by both services.
func TestParityFixture(t *testing.T) {
	bin := requirePython(t)
	reset()
	dir := t.TempDir()
	clock := filepath.Join(dir, "clock")
	os.WriteFile(clock, []byte(strconv.FormatInt(t0, 10)), 0o600)
	pyDB := filepath.Join(dir, "py.sqlite3")
	cmd := exec.Command(bin, "ref.py", "fixture", pyDB, clock, "fixture")
	cmd.Env = append(os.Environ(), "PY_APP_DIR="+appDir(), "PARITY_FLEET_KEY="+fleetKey)
	var eb bytes.Buffer
	cmd.Stderr = &eb
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("fixture: %v\n%s", err, eb.String())
	}
	var fx map[string]struct{ ID, Value string }
	if err := json.Unmarshal(out, &fx); err != nil {
		t.Fatal(err)
	}
	goDB := filepath.Join(dir, "go.sqlite3")
	for _, ext := range []string{"", "-wal", "-shm"} {
		if b, err := os.ReadFile(pyDB + ext); err == nil {
			os.WriteFile(goDB+ext, b, 0o600)
		}
	}
	c := conf{proxies: "127.0.0.0/8", owner: owner, admins: "cloud-admin"}
	py := startPy(t, c, pyDB, "serve")
	gs := startGo(t, c, goDB, "serve")
	vars := map[string]string{}
	for k, v := range fx {
		vars[k+"_id"], vars[k+"_val"] = v.ID, v.Value
	}
	steps := []step{
		{name: "list as fixture admin", method: "GET", path: "/v1/tokens", hdr: bearer("{admin_val}"), want: 200},
		{name: "list as plain", method: "GET", path: "/v1/tokens", hdr: bearer("{plain_val}"), want: 403},
		{name: "list as revoked", method: "GET", path: "/v1/tokens", hdr: bearer("{revoked_val}"), want: 403},
		{name: "list as expired", method: "GET", path: "/v1/tokens", hdr: bearer("{expired_val}"), want: 403},
	}
	for _, k := range []string{"admin", "plain", "revoked", "expired", "adopted"} {
		steps = append(steps,
			step{name: "get " + k, method: "GET", path: "/v1/tokens/{" + k + "_id}", hdr: adminH(), want: 200},
			step{name: "verify " + k, method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{` + k + `_val}","host":"svc.example.org"}`, want: 200},
			step{name: "reveal " + k, method: "POST", path: "/v1/tokens/{" + k + "_id}/reveal", hdr: adminH(), want: 200})
	}
	steps = append(steps,
		step{name: "verify plain wrong host", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{plain_val}","host":"evil.example.org"}`, want: 200},
		step{name: "verify plain mesh host", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{plain_val}","host":"a.mesh.example.org"}`, want: 200},
		step{name: "verify adopted again", method: "POST", path: "/v1/verify", hdr: verifyH(), advance: 120, body: `{"token":"{adopted_val}"}`, want: 200},
		step{name: "revoke plain", method: "POST", path: "/v1/tokens/{plain_id}/revoke", hdr: adminH(), want: 200},
		step{name: "verify plain revoked", method: "POST", path: "/v1/verify", hdr: verifyH(), body: `{"token":"{plain_val}"}`, want: 200},
		step{name: "create next to fixture", method: "POST", path: "/v1/tokens", hdr: adminH(), body: `{"name":"after fixture","scopes":["tokens:admin"]}`, want: 201, cap: map[string]string{"nid": "id", "nval": "value"}},
		step{name: "new token is admin", method: "GET", path: "/v1/tokens", hdr: bearer("{nval}"), want: 200},
		step{name: "audit", method: "GET", path: "/v1/audit", hdr: adminH(), want: 200},
		step{name: "list", method: "GET", path: "/v1/tokens", hdr: adminH(), want: 200})
	n := run(t, py, gs, steps, vars)
	if a, b := sqlDump(t, py.db), sqlDump(t, gs.db); a != b {
		n++
		t.Errorf("sqlite rows differ:\n--- python\n%s\n--- go\n%s", a, b)
	}
	if n > 0 {
		t.Fatalf("%d requests differ", n)
	}
}
