//go:build parity

// Package parity runs the ORIGINAL Python service (infra-sec_mcp-oauth/src/code/main.py, unmodified, driven by ref.py)
// and the Go port on identical requests and requires identical answers: status, the headers that matter, the exact
// body bytes (consent pages, signatures, tokens), and the resulting sqlite rows. Both sides get the same clock and the
// same deterministic byte stream, so client ids, codes and tokens are equal too. Synthetic secrets only.
//
// Run: PARITY_REQUIRE=1 go test -count=1 -tags parity -v -run TestParity ./parity/
// PARITY_MUTATE=1 skews the Go side (another consent form secret): the harness must then report differing requests.
package parity

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"mcp-oauth/mcpoauth"
)

const t0 = int64(1_800_000_000)

var baseEnv = map[string]string{
	"ISSUER": "https://c3-pub.example.org/mcp-oauth/", "AUTHORIZE_BASE": "https://c3-pvt.example.org/mcp-oauth",
	"INTROSPECT_SECRET": "introspect-secret-synthetic", "FORM_SECRET": "form-secret-synthetic",
	"ALLOWED_USERS": "owner, other", "SCOPES": "mcp read", "MAX_CLIENTS": "4",
	"ACCESS_TTL": "3600", "REFRESH_TTL": "86400", "CODE_TTL": "300",
}

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
	d, _ := filepath.Abs("../../../../infra-sec_mcp-oauth/src/code")
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

type side struct {
	name, base, db string
	setClock       func(int64)
	cl             *http.Client
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

func envWith(over map[string]string) map[string]string {
	m := map[string]string{}
	for k, v := range baseEnv {
		m[k] = v
	}
	for k, v := range over {
		if v == "-" {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	return m
}

func startPy(t *testing.T, env map[string]string, db, seed string) *side {
	bin := requirePython(t)
	dir := t.TempDir()
	clock := filepath.Join(dir, "clock")
	os.WriteFile(clock, []byte(strconv.FormatInt(atomic.LoadInt64(&clockNow), 10)), 0o600)
	port := freePort(t)
	cmd := exec.Command(bin, "ref.py", "serve", strconv.Itoa(port), clock, seed)
	cmd.Env = append(os.Environ(), "PY_APP_DIR="+appDir(), "DB_PATH="+db)
	for k, v := range env {
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
	return &side{name: "python", base: "http://127.0.0.1:" + strconv.Itoa(port), db: db, cl: newClient(),
		setClock: func(v int64) { os.WriteFile(clock, []byte(strconv.FormatInt(v, 10)), 0o600) }}
}

func startGo(t *testing.T, env map[string]string, db, seed string) *side {
	clk := new(int64)
	atomic.StoreInt64(clk, atomic.LoadInt64(&clockNow))
	genv := map[string]string{}
	for k, v := range env {
		genv[k] = v
	}
	genv["DB_PATH"] = db
	if mutate() {
		genv["FORM_SECRET"] = "skewed-" + genv["FORM_SECRET"]
	}
	cfg, err := mcpoauth.FromEnv(func(k string) (string, bool) { v, ok := genv[k]; return v, ok })
	if err != nil {
		t.Fatal(err)
	}
	st := &stream{seed: []byte(seed)}
	cfg.Clock = func() float64 { return float64(atomic.LoadInt64(clk)) }
	cfg.Rand = st.Bytes
	app, err := mcpoauth.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(app.Handler())
	t.Cleanup(func() { srv.Close(); app.Close() })
	return &side{name: "go", base: srv.URL, db: db, cl: newClient(), setClock: func(v int64) { atomic.StoreInt64(clk, v) }}
}

type step struct {
	name, method, path string
	hdr                map[string]string
	body               string
	want               int // status the Python reference must give (guards against a vacuous corpus)
	cap                func(resp) map[string]string
	advance            int64
}

type resp struct {
	status int
	hdr    []string
	loc    string
	body   string
}

var compared = []string{"Content-Type", "Cache-Control", "Allow", "Location", "X-Frame-Options", "Content-Security-Policy", "Set-Cookie"}

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
		v = sub(v)
		if rest, ok := strings.CutPrefix(v, "BASIC:"); ok {
			v = "Basic " + base64.StdEncoding.EncodeToString([]byte(rest))
		}
		req.Header[k] = []string{v}
	}
	r, err := s.cl.Do(req)
	if err != nil {
		t.Fatalf("%s %s %s: %v", s.name, st.method, st.path, err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	out := resp{status: r.StatusCode, body: string(b), loc: r.Header.Get("Location")}
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
	if len(s) > 600 {
		return s[:600] + "..."
	}
	return s
}

var clockNow = t0

func reset() { atomic.StoreInt64(&clockNow, t0) }

// run drives the same steps against both sides; it returns the number of differing steps.
func run(t *testing.T, py, gs *side, steps []step, vars map[string]string) int {
	t.Helper()
	diffs := 0
	for i, st := range steps {
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
	}
	return diffs
}

func sqlDump(t *testing.T, path string) string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var sb strings.Builder
	for _, q := range []string{
		"SELECT * FROM clients ORDER BY client_id",
		"SELECT * FROM codes ORDER BY code_hash",
		"SELECT * FROM tokens ORDER BY token_hash",
	} {
		rows, err := db.Query(q)
		if err != nil {
			t.Fatal(err)
		}
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
		rows.Close()
	}
	return sb.String()
}

// ---- the corpus ---------------------------------------------------------------------------------------

func pkce(seed string) (verifier, challenge string) {
	sum := sha256.Sum256([]byte(seed))
	verifier = base64.RawURLEncoding.EncodeToString(sum[:]) // 43 characters
	d := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(d[:])
}

func hdr(kv ...string) map[string]string {
	m := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

var (
	formCT = "application/x-www-form-urlencoded"
	jsonCT = "application/json"
)

func g(name, path string, want int) step {
	return step{name: name, method: "GET", path: path, want: want}
}
func gu(name, path, user string, want int) step {
	return step{name: name, method: "GET", path: path, hdr: hdr("Remote-User", user), want: want}
}

func capJSON(m map[string]string) func(resp) map[string]string {
	return func(r resp) map[string]string {
		out := map[string]string{}
		for ph, key := range m {
			rx := regexp.MustCompile(`"` + key + `":"([^"]*)"`)
			if mm := rx.FindStringSubmatch(r.body); mm != nil {
				out[ph] = mm[1]
			}
		}
		return out
	}
}

var inputRE = regexp.MustCompile(`<input type="hidden" name="([a-z_]+)" value="([^"]*)">`)

// capForm turns a consent page into ready-to-post forms: the genuine one and three damaged variants.
func capForm(tag string) func(resp) map[string]string {
	return func(r resp) map[string]string {
		v := url.Values{}
		for _, m := range inputRE.FindAllStringSubmatch(r.body, -1) {
			v.Set(m[1], html.UnescapeString(m[2]))
		}
		out := map[string]string{"FORM_" + tag: v.Encode()}
		for name, mut := range map[string]func(url.Values){
			"tamper":   func(x url.Values) { x.Set("scope", x.Get("scope")+" read") },
			"badexp":   func(x url.Values) { x.Set("exp", "abc") },
			"nonascii": func(x url.Values) { x.Set("sig", "sé") },
			"redirect": func(x url.Values) { x.Set("redirect_uri", "https://evil.example.com/cb") },
		} {
			c := url.Values{}
			for k, vv := range v {
				c[k] = append([]string(nil), vv...)
			}
			mut(c)
			out["FORM_"+tag+"_"+name] = c.Encode()
		}
		return out
	}
}

func capLocation(name string) func(resp) map[string]string {
	return func(r resp) map[string]string {
		u, err := url.Parse(r.loc)
		if err != nil {
			return nil
		}
		return map[string]string{name: u.Query().Get("code")}
	}
}

func capTokens(tag string) func(resp) map[string]string {
	return capJSON(map[string]string{"at_" + tag: "access_token", "rt_" + tag: "refresh_token"})
}

func pageQuery(cid, redirect, challenge, extra string) string {
	q := "/authorize?client_id=" + cid + "&response_type=code&code_challenge=" + challenge + "&code_challenge_method=S256"
	if redirect != "" {
		q += "&redirect_uri=" + url.QueryEscape(redirect)
	}
	return q + extra
}

// consent shows the page and approves it; the code lands in {code_<tag>}.
func consent(tag, cid, redirect, challenge, extra string) []step {
	return []step{
		{name: "page " + tag, method: "GET", path: pageQuery(cid, redirect, challenge, extra), hdr: hdr("Remote-User", "owner"), want: 200, cap: capForm(tag)},
		{name: "approve " + tag, method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_" + tag + "}&decision=approve", want: 302, cap: capLocation("code_" + tag)},
	}
}

func tokenBody(cid, tag, redirect, verifier, extra string) string {
	b := "client_id=" + cid + "&grant_type=authorization_code&code={code_" + tag + "}&code_verifier=" + verifier
	if redirect != "" {
		b += "&redirect_uri=" + url.QueryEscape(redirect)
	}
	return b + extra
}

func postForm(name, path, body string, want int) step {
	return step{name: name, method: "POST", path: path, hdr: hdr("Content-Type", formCT), body: body, want: want}
}

// basic is a Basic Authorization header whose id and secret may hold placeholders: it is encoded after substitution.
func basic(id, secret string) string { return "BASIC:" + id + ":" + secret }

func corpus() []step {
	const claudeCB = "https://claude.ai/api/mcp/auth_callback"
	v1, c1 := pkce("v1")
	v2, c2 := pkce("v2")
	v3, c3 := pkce("v3")
	v4, c4 := pkce("v4")
	_, cBad := pkce("bad")
	var s []step
	add := func(x ...step) { s = append(s, x...) }

	// discovery and routing
	add(g("as metadata", "/.well-known/oauth-authorization-server", 200),
		g("as metadata svc", "/.well-known/oauth-authorization-server/x", 200),
		g("openid configuration", "/.well-known/openid-configuration", 200),
		g("as metadata prefixed", "/svc/.well-known/oauth-authorization-server", 200),
		g("as metadata too deep", "/.well-known/oauth-authorization-server/x/y", 404),
		g("pr metadata", "/.well-known/oauth-protected-resource", 200),
		g("pr metadata path", "/.well-known/oauth-protected-resource/svc-a/mcp", 200),
		g("pr metadata prefixed", "/svc-a/.well-known/oauth-protected-resource", 200),
		g("pr bad name", "/.well-known/oauth-protected-resource/Bad_Name", 404),
		g("pr bad second part", "/.well-known/oauth-protected-resource/svc-a/Bad", 404),
		g("pr trailing newline is not a path-converter character", "/.well-known/oauth-protected-resource/svc%0A", 404),
		g("pr prefixed newline", "/svc%0A/.well-known/oauth-protected-resource", 200),
		g("pr empty", "/.well-known/oauth-protected-resource/", 404),
		g("unknown", "/nope", 404),
		g("register trailing slash", "/register/", 404),
		step{name: "delete token", method: "DELETE", path: "/token", want: 405},
		step{name: "options token", method: "OPTIONS", path: "/token", want: 200},
		g("get register", "/register", 405),
		step{name: "post health", method: "POST", path: "/health", want: 405},
		g("get introspect", "/introspect", 405),
		step{name: "prefixed introspect", method: "POST", path: "/svc/introspect", want: 404},
		g("health", "/health", 200))

	// registration
	js := hdr("Content-Type", jsonCT)
	reg := func(name, body string, want int, cap func(resp) map[string]string) step {
		return step{name: name, method: "POST", path: "/register", hdr: js, body: body, want: want, cap: cap}
	}
	add(reg("register claude", `{"redirect_uris":["`+claudeCB+`"],"client_name":"Claude"}`, 201, capJSON(map[string]string{"cid1": "client_id"})),
		reg("register confidential post", `{"redirect_uris":["http://localhost:3000/cb"],"token_endpoint_auth_method":"client_secret_post","client_name":"conf post"}`, 201,
			capJSON(map[string]string{"cid2": "client_id", "sec2": "client_secret"})),
		step{name: "register prefixed basic", method: "POST", path: "/svc/register", hdr: js, want: 201, cap: capJSON(map[string]string{"cid3": "client_id", "sec3": "client_secret"}),
			body: `{"redirect_uris":["http://127.0.0.1:1/cb"],"token_endpoint_auth_method":"client_secret_basic","grant_types":["authorization_code"]}`},
		reg("register multi uri unicode", `{"redirect_uris":["http://localhost:8080/cb","http://127.0.0.1:9/x?y=1","http://[::1]:7/p"],"client_name":"Zo@U@00eb @U@d83d@U@de42 caf@U@00e9"}`, 201,
			capJSON(map[string]string{"cid4": "client_id"})),
		step{name: "register text body", method: "POST", path: "/register", hdr: hdr("Content-Type", "text/plain"), body: `{"redirect_uris":["` + claudeCB + `"]}`, want: 400},
		reg("register list body", `[1]`, 400, nil),
		reg("register broken json", `{`, 400, nil),
		reg("register empty", `{}`, 400, nil),
		reg("register no uris", `{"redirect_uris":[]}`, 400, nil),
		reg("register string uri", `{"redirect_uris":"`+claudeCB+`"}`, 400, nil),
		reg("register eleven uris", `{"redirect_uris":[`+strings.TrimSuffix(strings.Repeat(`"http://localhost/a",`, 11), ",")+`]}`, 400, nil),
		reg("register ftp", `{"redirect_uris":["ftp://localhost/cb"]}`, 400, nil),
		reg("register http foreign", `{"redirect_uris":["http://example.com/cb"]}`, 400, nil),
		reg("register fragment", `{"redirect_uris":["`+claudeCB+`#x"]}`, 400, nil),
		reg("register bad port", `{"redirect_uris":["http://localhost:99999/cb"]}`, 400, nil),
		reg("register letter port", `{"redirect_uris":["http://localhost:ab/cb"]}`, 400, nil),
		reg("register open bracket", `{"redirect_uris":["http://[::1/cb"]}`, 400, nil),
		reg("register ipv4 in brackets", `{"redirect_uris":["http://[127.0.0.1]/cb"]}`, 400, nil),
		reg("register long uri", `{"redirect_uris":["http://localhost/`+strings.Repeat("a", 520)+`"]}`, 400, nil),
		reg("register number uri", `{"redirect_uris":[5]}`, 400, nil),
		reg("register callback with query", `{"redirect_uris":["`+claudeCB+`?x=1"]}`, 400, nil),
		reg("register bad method", `{"redirect_uris":["http://localhost/cb"],"token_endpoint_auth_method":"private_key_jwt"}`, 400, nil),
		reg("register list method", `{"redirect_uris":["http://localhost/cb"],"token_endpoint_auth_method":["none"]}`, 400, nil),
		reg("register bad grant", `{"redirect_uris":["http://localhost/cb"],"grant_types":["password"]}`, 400, nil),
		reg("register grant not list", `{"redirect_uris":["http://localhost/cb"],"grant_types":"authorization_code"}`, 400, nil),
		reg("register grant unhashable", `{"redirect_uris":["http://localhost/cb"],"grant_types":[["x"]]}`, 500, nil),
		reg("register bad response types", `{"redirect_uris":["http://localhost/cb"],"response_types":["token"]}`, 400, nil))
	// distinct creation times: the eviction order never depends on how sqlite breaks ties
	for i := range s {
		switch s[i].name {
		case "register confidential post", "register prefixed basic", "register multi uri unicode":
			s[i].advance = 1
		}
	}

	// the authorization request
	add(g("authorize no session", pageQuery("{cid1}", "", c1, ""), 401),
		gu("authorize stranger", pageQuery("{cid1}", "", c1, ""), "stranger", 403),
		gu("authorize unknown client", pageQuery("mcpc_unknown", "", c1, ""), "owner", 400),
		gu("authorize foreign redirect", pageQuery("{cid1}", "https://evil.example.com/cb", c1, ""), "owner", 400),
		gu("authorize multi uri needs one", pageQuery("{cid4}", "", c4, ""), "owner", 400),
		gu("authorize response type", "/authorize?client_id={cid1}&response_type=token&code_challenge="+c1+"&code_challenge_method=S256", "owner", 302),
		gu("authorize plain pkce", "/authorize?client_id={cid1}&response_type=code&code_challenge="+c1+"&code_challenge_method=plain&state=s%26t", "owner", 302),
		gu("authorize short challenge", "/authorize?client_id={cid1}&response_type=code&code_challenge=abc&code_challenge_method=S256", "owner", 302),
		gu("authorize bad scope", pageQuery("{cid1}", "", c1, "&scope=mcp+admin&state=abc"), "owner", 302),
		gu("authorize page defaults", pageQuery("{cid1}", "", c1, ""), "owner", 200),
		gu("authorize page escaping", pageQuery("{cid1}", claudeCB, c1, "&scope=read&state="+url.QueryEscape(`<s "t" & 'u'>`)+"&resource="+url.QueryEscape("https://r.example/<x>")), "owner", 200),
		gu("authorize prefixed", "/svc"+pageQuery("{cid1}", "", c1, ""), "other", 200),
		step{name: "authorize page head", method: "HEAD", path: pageQuery("{cid1}", "", c1, ""), hdr: hdr("Remote-User", "owner"), want: 200},
		gu("authorize padded user", pageQuery("{cid1}", "", c1, ""), "  owner  ", 200))

	// the consent form
	add(step{name: "page for form tests", method: "GET", path: pageQuery("{cid1}", "", c1, ""), hdr: hdr("Remote-User", "owner"), want: 200, cap: capForm("f")},
		step{name: "post no session", method: "POST", path: "/authorize", hdr: hdr("Content-Type", formCT), body: "{FORM_f}&decision=approve", want: 401},
		step{name: "post bad exp", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f_badexp}&decision=approve", want: 400},
		step{name: "post tampered scope", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f_tamper}&decision=approve", want: 400},
		step{name: "post tampered redirect", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f_redirect}&decision=approve", want: 400},
		step{name: "post non-ascii signature", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f_nonascii}&decision=approve", want: 500},
		step{name: "post other user", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "other", "Content-Type", formCT), body: "{FORM_f}&decision=approve", want: 403},
		step{name: "post json body", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", jsonCT), body: `{"decision":"approve"}`, want: 400},
		step{name: "deny", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f}&decision=deny", want: 302},
		step{name: "no decision", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f}", want: 302},
		step{name: "prefixed approve", method: "POST", path: "/svc/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_f}&decision=approve", want: 302, cap: capLocation("code_unused")},
		step{name: "page for expiry", method: "GET", path: pageQuery("{cid1}", "", c1, ""), hdr: hdr("Remote-User", "owner"), want: 200, cap: capForm("old")})

	// authorization codes into tokens
	add(consent("a", "{cid1}", "", c1, "&state=xy")...)
	add(consent("b", "{cid1}", "", c1, "")...)
	add(consent("c", "{cid1}", "", c1, "")...)
	add(consent("d", "{cid1}", "", c1, "")...)
	add(consent("e", "{cid1}", claudeCB, c1, "&resource="+url.QueryEscape("https://r.example/mcp"))...)
	add(consent("g", "{cid1}", "", c1, "")...)
	add(consent("h", "{cid1}", "", c1, "&scope=read")...)
	add(consent("old", "{cid1}", "", c1, "")...)
	add(postForm("token wrong redirect", "/token", tokenBody("{cid1}", "a", "https://claude.com/api/mcp/auth_callback", v1, ""), 400),
		postForm("token consumed code", "/token", tokenBody("{cid1}", "a", "", v1, ""), 400),
		postForm("token no verifier", "/token", "client_id={cid1}&grant_type=authorization_code&code={code_b}", 400),
		postForm("token short verifier", "/token", tokenBody("{cid1}", "c", "", "short", ""), 400),
		postForm("token wrong verifier", "/token", tokenBody("{cid1}", "d", "", v2, ""), 400),
		postForm("token other client", "/token", "client_id={cid2}&client_secret={sec2}&grant_type=authorization_code&code={code_g}&code_verifier="+v1, 400))
	add(consent("i", "{cid1}", "", c1, "")...)
	add(step{name: "token ok", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT), body: tokenBody("{cid1}", "i", claudeCB, v1, ""), want: 200, cap: capTokens("1")},
		postForm("token resource override", "/token", tokenBody("{cid1}", "e", "", v1, "&resource="+url.QueryEscape("https://r.example/other")), 200),
		postForm("token resource from authorize", "/token", tokenBody("{cid1}", "h", "", v1, ""), 200),
		postForm("token again", "/token", tokenBody("{cid1}", "i", "", v1, ""), 400),
		step{name: "token json body", method: "POST", path: "/token", hdr: hdr("Content-Type", jsonCT), body: `{"client_id":"{cid1}"}`, want: 401},
		postForm("token no client", "/token", "grant_type=authorization_code", 401),
		postForm("token unknown client", "/token", "client_id=mcpc_unknown&grant_type=authorization_code", 401),
		postForm("token no grant", "/token", "client_id={cid1}", 400),
		postForm("token bad grant", "/token", "client_id={cid1}&grant_type=password", 400),
		step{name: "token prefixed", method: "POST", path: "/svc/token", hdr: hdr("Content-Type", formCT), body: "client_id={cid1}&grant_type=password", want: 400})

	// confidential clients
	add(consent("j", "{cid2}", "http://localhost:3000/cb", c2, "")...)
	add(consent("k", "{cid3}", "", c3, "")...)
	add(consent("l", "{cid1}", "", c1, "")...)
	add(postForm("secret missing", "/token", "client_id={cid2}&grant_type=authorization_code&code={code_j}&code_verifier="+v2, 401),
		postForm("secret wrong", "/token", "client_id={cid2}&client_secret=nope&grant_type=authorization_code&code={code_j}&code_verifier="+v2, 401),
		postForm("secret ok", "/token", "client_id={cid2}&client_secret={sec2}&grant_type=authorization_code&code={code_j}&code_verifier="+v2, 200),
		step{name: "basic wrong", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT, "Authorization", basic("{cid3}", "nope")), body: "grant_type=authorization_code&code={code_k}&code_verifier=" + v3, want: 401},
		step{name: "basic garbage", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT, "Authorization", "Basic ***"), body: "grant_type=authorization_code", want: 401},
		step{name: "basic not base64", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT, "Authorization", "Basic abc"), body: "grant_type=authorization_code", want: 401},
		step{name: "basic ok", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT, "Authorization", basic("{cid3}", "{sec3}")), body: "grant_type=authorization_code&code={code_k}&code_verifier=" + v3, want: 200, cap: capTokens("3")},
		step{name: "multipart token", method: "POST", path: "/token", hdr: hdr("Content-Type", "multipart/form-data; boundary=XB"), want: 200, cap: capTokens("4"),
			body: "--XB\r\nContent-Disposition: form-data; name=\"client_id\"\r\n\r\n{cid1}\r\n--XB\r\nContent-Disposition: form-data; name=\"grant_type\"\r\n\r\nauthorization_code\r\n--XB\r\nContent-Disposition: form-data; name=\"code\"\r\n\r\n{code_l}\r\n--XB\r\nContent-Disposition: form-data; name=\"code_verifier\"\r\n\r\n" + v1 + "\r\n--XB--\r\n"})
	add(consent("m", "{cid4}", "http://localhost:8080/cb", c4, "")...)
	add(postForm("fourth client", "/token", tokenBody("{cid4}", "m", "http://localhost:8080/cb", v4, ""), 200))
	// capture the fourth client's pair too
	s[len(s)-1].cap = capTokens("c4")

	// refresh
	add(consent("n", "{cid1}", "", c1, "")...)
	add(postForm("pair for refresh", "/token", tokenBody("{cid1}", "n", "", v1, ""), 200))
	s[len(s)-1].cap = capTokens("r")
	add(postForm("refresh narrower", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_r}&scope=mcp", 200))
	s[len(s)-1].cap = capTokens("r2")
	add(postForm("refresh old token dead", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_r}", 400),
		postForm("refresh wider scope", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_r2}&scope=mcp+read", 400),
		postForm("refresh gone after refusal", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_r2}", 400),
		postForm("refresh unknown token", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_1}x", 400),
		postForm("refresh with access token", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={at_1}", 400),
		postForm("refresh missing", "/token", "client_id={cid1}&grant_type=refresh_token", 400),
		postForm("refresh by another client", "/token", "client_id={cid2}&client_secret={sec2}&grant_type=refresh_token&refresh_token={rt_3}", 400))
	add(consent("o", "{cid1}", "", c1, "")...)
	add(postForm("pair for rotation", "/token", tokenBody("{cid1}", "o", "", v1, ""), 200))
	s[len(s)-1].cap = capTokens("o")
	add(postForm("refresh rotation", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_o}", 200))
	s[len(s)-1].cap = capTokens("o2")

	// introspection and revocation
	is := hdr("X-Introspect-Secret", "introspect-secret-synthetic", "Content-Type", formCT)
	intro := func(name, tok string, want int) step {
		return step{name: name, method: "POST", path: "/introspect", hdr: is, body: "token=" + tok, want: want}
	}
	add(step{name: "introspect no secret", method: "POST", path: "/introspect", hdr: hdr("Content-Type", formCT), body: "token={at_o2}", want: 401},
		step{name: "introspect wrong secret", method: "POST", path: "/introspect", hdr: hdr("X-Introspect-Secret", "nope", "Content-Type", formCT), body: "token={at_o2}", want: 401},
		step{name: "introspect non-ascii secret", method: "POST", path: "/introspect", hdr: hdr("X-Introspect-Secret", "sé", "Content-Type", formCT), body: "token={at_o2}", want: 500},
		intro("introspect live", "{at_o2}", 200),
		intro("introspect rotated access", "{at_o}", 200),
		intro("introspect first access", "{at_1}", 200),
		intro("introspect refresh token", "{rt_o2}", 200),
		intro("introspect unknown", "mcpat_unknown", 200),
		intro("introspect wrong prefix", "abc", 200),
		intro("introspect empty", "", 200),
		step{name: "introspect no body", method: "POST", path: "/introspect", hdr: is, want: 200},
		step{name: "introspect multipart", method: "POST", path: "/introspect", hdr: hdr("X-Introspect-Secret", "introspect-secret-synthetic", "Content-Type", "multipart/form-data; boundary=B"),
			body: "--B\r\nContent-Disposition: form-data; name=\"token\"\r\n\r\n{at_o2}\r\n--B--\r\n", want: 200},
		step{name: "revoke access", method: "POST", path: "/revoke", hdr: hdr("Content-Type", formCT), body: "token={at_o2}", want: 200},
		intro("introspect revoked", "{at_o2}", 200),
		step{name: "revoke unknown", method: "POST", path: "/revoke", hdr: hdr("Content-Type", formCT), body: "token=nothing", want: 200},
		step{name: "revoke no body", method: "POST", path: "/revoke", want: 200},
		step{name: "refresh survives access revoke", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT), body: "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_o2}", want: 200, cap: capTokens("o3")})

	// the registry: every client holds tokens, so nobody can be evicted
	add(reg("registry full", `{"redirect_uris":["http://localhost/new"]}`, 503, nil),
		step{name: "revoke fourth access", method: "POST", path: "/revoke", hdr: hdr("Content-Type", formCT), body: "token={at_c4}", want: 200},
		step{name: "revoke fourth refresh", method: "POST", path: "/revoke", hdr: hdr("Content-Type", formCT), body: "token={rt_c4}", want: 200},
		reg("registry evicts the idle client", `{"redirect_uris":["http://localhost/new"],"client_name":"`+strings.Repeat("n", 150)+`"}`, 201, capJSON(map[string]string{"cid5": "client_id"})),
		gu("evicted client is gone", pageQuery("{cid4}", "http://localhost:8080/cb", c4, ""), "owner", 400),
		reg("null client name", `{"redirect_uris":["http://localhost/new2"],"client_name":null,"token_endpoint_auth_method":"client_secret_post"}`, 201, nil),
		reg("empty fragment is no fragment", `{"redirect_uris":["http://localhost/frag#"]}`, 201, nil))

	// time: consent expiry, token expiry to the second, refresh expiry, garbage collection
	add(step{name: "consent expired", method: "POST", path: "/authorize", hdr: hdr("Remote-User", "owner", "Content-Type", formCT), body: "{FORM_old}&decision=approve", want: 400, advance: 301},
		postForm("code expired", "/token", tokenBody("{cid1}", "old", "", v1, ""), 400),
		intro("introspect at the boundary", "{at_1}", 200))
	s[len(s)-1].advance = 3299 // tokens were minted at T and live 3600 s: at T+3600, expires == now is still active
	add(intro("introspect one second later", "{at_1}", 200))
	s[len(s)-1].advance = 1
	add(postForm("refresh before expiry", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_1}", 200))
	s[len(s)-1].cap = capTokens("t")
	add(postForm("refresh expired", "/token", "client_id={cid1}&grant_type=refresh_token&refresh_token={rt_t}", 400))
	s[len(s)-1].advance = 86401
	add(reg("register collects garbage", `{"redirect_uris":["http://localhost/after"]}`, 201, capJSON(map[string]string{"cid7": "client_id"})),
		gu("the oldest idle client was evicted", pageQuery("{cid1}", claudeCB, c1, ""), "owner", 400))
	add(consent("z", "{cid7}", "", c1, "")...)
	add(postForm("final pair", "/token", tokenBody("{cid7}", "z", "", v1, ""), 200))
	s[len(s)-1].cap = capTokens("live")
	add(postForm("unknown code", "/token", "client_id={cid7}&grant_type=authorization_code&code="+cBad, 400))
	return s
}

func TestParityCorpus(t *testing.T) {
	requirePython(t)
	reset()
	dir := t.TempDir()
	env := envWith(nil)
	py := startPy(t, env, filepath.Join(dir, "py.sqlite3"), "corpus")
	gs := startGo(t, env, filepath.Join(dir, "go.sqlite3"), "corpus")
	vars := map[string]string{}
	steps := corpus()
	n := run(t, py, gs, steps, vars)
	if a, b := sqlDump(t, py.db), sqlDump(t, gs.db); a != b {
		n++
		t.Errorf("sqlite rows differ:\n--- python\n%s\n--- go\n%s", a, b)
	}
	if n > 0 {
		t.Fatalf("%d requests differ", n)
	}
	t.Logf("%d requests identical", len(steps))

	// The same sqlite file, written by Python, served by both: a fresh Go and a fresh Python process read it.
	snap := filepath.Join(dir, "snap.sqlite3")
	db, err := sql.Open("sqlite", py.db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("VACUUM INTO '" + snap + "'"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	copyDB := func(name string) string {
		b, _ := os.ReadFile(snap)
		p := filepath.Join(dir, name)
		os.WriteFile(p, b, 0o600)
		return p
	}
	py2 := startPy(t, env, copyDB("py2.sqlite3"), "after")
	gs2 := startGo(t, env, copyDB("go2.sqlite3"), "after")
	is := hdr("X-Introspect-Secret", "introspect-secret-synthetic", "Content-Type", formCT)
	after := []step{
		{name: "introspect live token from the file", method: "POST", path: "/introspect", hdr: is, body: "token={at_live}", want: 200},
		{name: "refresh live token from the file", method: "POST", path: "/token", hdr: hdr("Content-Type", formCT), body: "client_id={cid7}&grant_type=refresh_token&refresh_token={rt_live}", want: 200, cap: capTokens("live2")},
		{name: "old access token died with the refresh", method: "POST", path: "/introspect", hdr: is, body: "token={at_live}", want: 200},
		{name: "new access token", method: "POST", path: "/introspect", hdr: is, body: "token={at_live2}", want: 200},
		{name: "register into the file", method: "POST", path: "/register", hdr: hdr("Content-Type", jsonCT), body: `{"redirect_uris":["http://localhost/z"]}`, want: 201},
	}
	n = run(t, py2, gs2, after, vars)
	if a, b := sqlDump(t, py2.db), sqlDump(t, gs2.db); a != b {
		n++
		t.Errorf("sqlite rows differ after serving the shared file:\n--- python\n%s\n--- go\n%s", a, b)
	}
	if n > 0 {
		t.Fatalf("%d requests differ", n)
	}
}

// Configuration variants: who may approve, whether introspection is on, scopes, TTLs.
func TestParityVariants(t *testing.T) {
	requirePython(t)
	_, c1 := pkce("var")
	for name, over := range map[string]map[string]string{
		"everyone may approve":  {"ALLOWED_USERS": "-"},
		"introspection off":     {"INTROSPECT_SECRET": "-"},
		"single scope":          {"SCOPES": "-"},
		"short ttls":            {"ACCESS_TTL": "10", "REFRESH_TTL": "20", "CODE_TTL": "5", "MAX_CLIENTS": "1"},
		"custom redirects":      {"ALLOWED_REDIRECTS": "https://app.example.org/cb https://other.example.org/cb"},
		"authorize base = self": {"AUTHORIZE_BASE": "-"},
	} {
		t.Run(name, func(t *testing.T) {
			reset()
			dir := t.TempDir()
			env := envWith(over)
			py := startPy(t, env, filepath.Join(dir, "py.sqlite3"), "var")
			gs := startGo(t, env, filepath.Join(dir, "go.sqlite3"), "var")
			js := hdr("Content-Type", jsonCT)
			steps := []step{
				{name: "register custom", method: "POST", path: "/register", hdr: js, body: `{"redirect_uris":["https://app.example.org/cb"]}`},
				{name: "register claude", method: "POST", path: "/register", hdr: js, body: `{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}`, cap: capJSON(map[string]string{"cid": "client_id"})},
				{name: "metadata", method: "GET", path: "/.well-known/oauth-authorization-server"},
				{name: "resource metadata", method: "GET", path: "/.well-known/oauth-protected-resource/a"},
				{name: "page as anyone", method: "GET", path: pageQuery("{cid}", "", c1, ""), hdr: hdr("Remote-User", "somebody")},
				{name: "page with scope", method: "GET", path: pageQuery("{cid}", "", c1, "&scope=read"), hdr: hdr("Remote-User", "owner")},
				{name: "introspect", method: "POST", path: "/introspect", hdr: hdr("X-Introspect-Secret", "introspect-secret-synthetic", "Content-Type", formCT), body: "token=mcpat_x"},
				{name: "introspect no secret", method: "POST", path: "/introspect", hdr: hdr("Content-Type", formCT), body: "token=mcpat_x"},
				{name: "second register", method: "POST", path: "/register", hdr: js, body: `{"redirect_uris":["http://localhost/b"]}`},
			}
			if n := run(t, py, gs, steps, map[string]string{}); n > 0 {
				t.Fatalf("%d requests differ", n)
			}
			if a, b := sqlDump(t, py.db), sqlDump(t, gs.db); a != b {
				t.Fatalf("1 requests differ: sqlite rows differ:\n--- python\n%s\n--- go\n%s", a, b)
			}
		})
	}
}
