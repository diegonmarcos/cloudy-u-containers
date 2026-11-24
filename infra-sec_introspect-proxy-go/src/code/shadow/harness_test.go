//go:build shadow

package shadow

// Shadow-compare harness (ticket #1872): the Python reference (infra-sec_introspect-proxy,
// run under gunicorn exactly as deployed) and this Go port are started side by side against
// the same fake upstreams (JWKS, tokens-api, mcp-oauth), every fixture is sent to both, and
// the run fails on any difference in status, body, content type, Allow or X-Auth-* headers.
// A mutation section proves the comparison is not vacuous.
//
//	PY_BIN=python3 (with flask, PyJWT[crypto], gunicorn) PY_APP_DIR=<reference src/code> go test -tags shadow ./shadow/

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"introspect-proxy/proxy"
)

const iss = "https://auth.diegonmarcos.com"

type behaviour struct {
	status int
	body   string
	delay  time.Duration
}

type upstreams struct {
	mu       sync.Mutex
	jwks     behaviour
	engine   map[string]behaviour
	mcp      map[string]behaviour
	srv      *httptest.Server
	engineIn []string
}

func (u *upstreams) setJWKS(b behaviour) { u.mu.Lock(); u.jwks = b; u.mu.Unlock() }

func (u *upstreams) serve(w http.ResponseWriter, r *http.Request) {
	reply := func(b behaviour) {
		if b.delay > 0 {
			time.Sleep(b.delay)
		}
		st := b.status
		if st == 0 {
			st = 200
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(st)
		_, _ = io.WriteString(w, b.body)
	}
	raw, _ := io.ReadAll(r.Body)
	switch r.URL.Path {
	case "/jwks":
		u.mu.Lock()
		b := u.jwks
		u.mu.Unlock()
		reply(b)
	case "/engine":
		if r.Header.Get("X-Verify-Secret") != "engine-secret" {
			reply(behaviour{status: 403, body: `{"error":"secret"}`})
			return
		}
		var in struct{ Token string }
		_ = json.Unmarshal(raw, &in)
		u.mu.Lock()
		u.engineIn = append(u.engineIn, string(raw))
		b, ok := u.engine[in.Token]
		u.mu.Unlock()
		if !ok {
			if strings.HasPrefix(in.Token, "ft_") {
				b = behaviour{body: `{"active": false, "reason": "unknown"}`}
			} else {
				b = behaviour{body: `{"active": true, "id": "tk_jwt"}`}
			}
		}
		reply(b)
	case "/mcp":
		if r.Header.Get("X-Introspect-Secret") != "mcp-secret" {
			reply(behaviour{status: 403, body: `{}`})
			return
		}
		_ = r.ParseForm()
		tok := ""
		if v, err := urlValues(string(raw)); err == nil {
			tok = v
		}
		u.mu.Lock()
		b, ok := u.mcp[tok]
		u.mu.Unlock()
		if !ok {
			b = behaviour{body: `{"active": false}`}
		}
		reply(b)
	default:
		http.NotFound(w, r)
	}
}

func urlValues(form string) (string, error) {
	req, _ := http.NewRequest("POST", "http://x/", strings.NewReader(form))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if err := req.ParseForm(); err != nil {
		return "", err
	}
	return req.PostForm.Get("token"), nil
}

type rsaKey struct {
	k   *rsa.PrivateKey
	kid string
}

func (k rsaKey) jwk(extra string) string {
	n := B64(k.k.N.Bytes())
	e := B64(big.NewInt(int64(k.k.E)).Bytes())
	return fmt.Sprintf(`{"kty":"RSA","kid":%q,"use":"sig","alg":"RS256","n":%q,"e":%q%s}`, k.kid, n, e, extra)
}

func (k rsaKey) sign(header, payload string) string {
	si := B64([]byte(header)) + "." + B64([]byte(payload))
	h := sha256.Sum256([]byte(si))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, k.k, crypto.SHA256, h[:])
	return si + "." + B64(sig)
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitUp(t *testing.T, base string) {
	cl := NewClient(time.Second)
	for i := 0; i < 100; i++ {
		if r, err := cl.Get(base + "/health"); err == nil {
			r.Body.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("%s never came up", base)
}

type step struct {
	name  string
	setup func()
	cases []Case
}

func auth(v string, extra ...[2]string) [][2]string {
	return append([][2]string{{"Authorization", v}}, extra...)
}

func get(name string, h [][2]string) Case {
	return Case{Name: name, Method: "GET", Path: "/auth", Headers: h}
}

func TestShadowCompare(t *testing.T) {
	py := os.Getenv("PY_BIN")
	app := os.Getenv("PY_APP_DIR")
	if py == "" || app == "" {
		t.Fatal("PY_BIN and PY_APP_DIR are required: the harness never skips (a skipped comparison is not a pass)")
	}
	app, _ = filepath.Abs(app)
	if _, err := os.Stat(filepath.Join(app, "main.py")); err != nil {
		t.Fatalf("reference main.py not found in %s", app)
	}

	k1 := rsaKey{mustRSA(t, 2048), "k1"}
	k2 := rsaKey{mustRSA(t, 2048), "k2"}
	ec, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	ecJWK := fmt.Sprintf(`{"kty":"EC","crv":"P-256","kid":"kec","use":"sig","x":%q,"y":%q}`, B64(ec.X.FillBytes(make([]byte, 32))), B64(ec.Y.FillBytes(make([]byte, 32))))
	okSet := fmt.Sprintf(`{"keys":[%s,%s,%s,{"kty":"RSA","kid":"kenc","use":"enc","n":%q,"e":"AQAB"},{"kty":"oct","kid":"koct","k":"c2VjcmV0"},{"kid":"nokty"},{"kty":"RSA","kid":"kalg","alg":"ES256","n":"x","e":"y"}]}`,
		k1.jwk(""), k2.jwk(""), ecJWK, B64(k1.k.N.Bytes()))

	up := &upstreams{engine: map[string]behaviour{}, mcp: map[string]behaviour{}, jwks: behaviour{body: okSet}}
	up.srv = httptest.NewServer(http.HandlerFunc(up.serve))
	defer up.srv.Close()

	envm := map[string]string{
		"JWKS_URL":                    up.srv.URL + "/jwks",
		"ISSUER":                      iss,
		"REQUIRED_SCOPE":              "authelia.bearer.authz",
		"JWKS_CACHE_TTL":              "2",
		"TOKENS_VERIFY_URL":           up.srv.URL + "/engine",
		"TOKENS_VERIFY_SECRET":        "engine-secret",
		"TOKENS_CACHE_TTL":            "30",
		"MCP_OAUTH_INTROSPECT_URL":    up.srv.URL + "/mcp",
		"MCP_OAUTH_INTROSPECT_SECRET": "mcp-secret",
	}

	// Python reference, as deployed: gunicorn, 1 worker, 4 threads.
	pport := freePort(t)
	cmd := exec.Command(py, "-m", "gunicorn", "--bind", fmt.Sprintf("127.0.0.1:%d", pport), "--workers", "1", "--threads", "4", "--timeout", "120", "main:app")
	cmd.Dir = app
	cmd.Env = append(os.Environ(), "PYTHONDONTWRITEBYTECODE=1")
	for k, v := range envm {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var pylog strings.Builder
	cmd.Stdout, cmd.Stderr = &pylog, &pylog
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	pyBase := fmt.Sprintf("http://127.0.0.1:%d", pport)

	// Go candidate, same environment.
	cfg, err := proxy.FromEnv(func(k string) (string, bool) { v, ok := envm[k]; return v, ok }, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	goSrv := httptest.NewServer(proxy.Handler(cfg))
	defer goSrv.Close()

	waitUp(t, pyBase)
	waitUp(t, goSrv.URL)

	// Production runs python:3.11-slim. A 2000-deep JSON document is a RecursionError (500)
	// on CPython 3.11 and parses on 3.12+ (C recursion limit), so that one case is only
	// compared against a 3.11 reference; the port follows 3.11.
	verOut, _ := exec.Command(py, "-c", "import sys; print('%d.%d' % sys.version_info[:2])").Output()
	pyVer := strings.TrimSpace(string(verOut))
	versionBound := map[string]bool{"payload-deep": pyVer != "3.11"}
	if versionBound["payload-deep"] {
		t.Logf("reference is CPython %s, not the deployed 3.11: payload-deep not compared", pyVer)
	}

	exp := time.Now().Add(time.Hour).Unix()
	past := time.Now().Add(-time.Hour).Unix()
	fut := time.Now().Add(time.Hour).Unix()
	h1 := `{"alg":"RS256","kid":"k1","typ":"JWT"}`
	claims := func(extra string) string {
		return fmt.Sprintf(`{"iss":%q,"exp":%d,"sub":"owner","client_id":"cli","scp":["authelia.bearer.authz"]%s}`, iss, exp, extra)
	}
	raw := func(payload string) string { return k1.sign(h1, payload) }
	pl := func(body string) string { return fmt.Sprintf(`{"iss":%q,"exp":%d,%s}`, iss, exp, body) }
	scp := `"scp":["authelia.bearer.authz"]`

	tamper := raw(claims(""))
	tamper = tamper[:len(tamper)-6] + "AAAAAA"
	shortSig := leadingZeroSig(k1, h1, claims(""))

	big8190 := "Bearer ft_" + strings.Repeat("a", 8190-len("Authorization")-4-len("Bearer ft_"))
	big8191 := big8190 + "a"

	mcp := func(tok string, b behaviour) string { up.mcp[tok] = b; return "Bearer " + tok }
	eng := func(tok string, b behaviour) string { up.engine[tok] = b; return "Bearer " + tok }
	engJWT := func(payload string, b behaviour) string {
		tok := raw(payload)
		up.engine[tok] = b
		return "Bearer " + tok
	}

	steps := []step{
		{name: "routes", cases: []Case{
			{Name: "health", Method: "GET", Path: "/health"},
			{Name: "health-head", Method: "HEAD", Path: "/health"},
			{Name: "health-post", Method: "POST", Path: "/health"},
			{Name: "health-delete", Method: "DELETE", Path: "/health"},
			{Name: "health-options", Method: "OPTIONS", Path: "/health"},
			{Name: "health-slash", Method: "GET", Path: "/health/"},
			{Name: "root", Method: "GET", Path: "/"},
			{Name: "nope-post", Method: "POST", Path: "/nope"},
			{Name: "auth-slash", Method: "GET", Path: "/auth/"},
			{Name: "auth-encoded", Method: "GET", Path: "/au%74h"},
			{Name: "auth-query", Method: "GET", Path: "/auth?x=1"},
			{Name: "auth-options", Method: "OPTIONS", Path: "/auth"},
			{Name: "auth-trace", Method: "TRACE", Path: "/auth"},
			{Name: "auth-head-no-bearer", Method: "HEAD", Path: "/auth"},
			{Name: "auth-post", Method: "POST", Path: "/auth"},
			{Name: "auth-put", Method: "PUT", Path: "/auth"},
			{Name: "auth-patch", Method: "PATCH", Path: "/auth"},
			{Name: "auth-delete", Method: "DELETE", Path: "/auth"},
		}},
		{name: "authorization header", cases: []Case{
			get("none", nil),
			get("empty", auth("")),
			get("basic", auth("Basic Zm9vOmJhcg==")),
			get("lowercase", auth("bearer x")),
			get("BEARER", auth("BEARER x")),
			get("bearer-only", auth("Bearer")),
			get("bearer-space", auth("Bearer ")),
			get("bearer-tab", auth("Bearer\tx")),
			get("nbsp-prefix-token", auth("Bearer \xa0ft_nbsp")),
			get("trailing-nel", auth("Bearer ft_nel\x85")),
			get("latin1-in-token", auth("Bearer ft_l\xe9tin")),
			get("latin1-then-space", auth("Bearer ft_x \xff")),
			get("two-headers", auth("Bearer a.b.c", [2]string{"Authorization", "Bearer ft_two"})),
			get("field-8190", auth(big8190)),
			get("field-8191", auth(big8191)),
			get("x-forwarded-host", auth("Bearer ft_host", [2]string{"X-Forwarded-Host", "c3-pvt.diegonmarcos.com"})),
		}},
		{name: "malformed jwt", cases: []Case{
			get("one-segment", auth("Bearer abc")),
			get("two-segments", auth("Bearer a.b")),
			get("dots", auth("Bearer ..")),
			get("bad-b64-header", auth("Bearer a.b.c")),
			get("header-one-extra-char", auth("Bearer "+B64([]byte(h1))+"x."+B64([]byte(claims("")))+".sig")),
			get("garbage-chars-skipped", auth("Bearer "+B64([]byte(h1))+"!!!."+B64([]byte(claims("")))+".c2ln")),
			get("four-segments", auth("Bearer "+raw(claims(""))+".extra")),
			get("header-list", auth("Bearer "+RawJWT(`[1]`, claims(""), []byte("s")))),
			get("header-string", auth("Bearer "+RawJWT(`"x"`, claims(""), []byte("s")))),
			get("header-nan", auth("Bearer "+RawJWT(`{"alg":"RS256","kid":"k1","x":NaN}`, claims(""), []byte("s")))),
			get("header-trailing", auth("Bearer "+RawJWT(h1+"x", claims(""), []byte("s")))),
			get("header-ctl-in-string", auth("Bearer "+RawJWT("{\"alg\":\"RS256\",\"kid\":\"k\x01\"}", claims(""), []byte("s")))),
			get("header-bad-utf8", auth("Bearer "+RawJWT("{\"alg\":\"RS256\",\"kid\":\"\xff\"}", claims(""), []byte("s")))),
			get("payload-list", auth("Bearer "+RawJWT(h1, `[]`, []byte("s")))),
			get("payload-bad-json", auth("Bearer "+RawJWT(h1, `{"a":`, []byte("s")))),
			get("payload-deep", auth("Bearer "+RawJWT(h1, strings.Repeat("[", 2000)+strings.Repeat("]", 2000), []byte("s")))),
			get("b64-false", auth("Bearer "+RawJWT(`{"alg":"RS256","kid":"k1","b64":false}`, claims(""), []byte("s")))),
			get("b64-zero", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"k1","b64":0}`, claims("")))),
			get("kid-list", auth("Bearer "+RawJWT(`{"alg":"RS256","kid":["k1"]}`, claims(""), []byte("s")))),
			get("kid-dict", auth("Bearer "+RawJWT(`{"alg":"RS256","kid":{}}`, claims(""), []byte("s")))),
		}},
		{name: "jwt signature and keys", cases: []Case{
			get("valid", auth("Bearer "+raw(claims("")))),
			get("valid-again-cached", auth("Bearer "+raw(claims(`,"n":1`)))),
			{Name: "valid-head", Method: "HEAD", Path: "/auth", Headers: auth("Bearer " + raw(claims(`,"n":2`)))},
			get("valid-k2", auth("Bearer "+k2.sign(`{"alg":"RS256","kid":"k2"}`, claims("")))),
			get("k1-key-k2-kid", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"k2"}`, claims(`,"n":3`)))),
			get("tampered-signature", auth("Bearer "+tamper)),
			get("short-signature-leading-zero", auth("Bearer "+shortSig)),
			get("empty-signature", auth("Bearer "+strings.TrimSuffix(raw(claims("")), raw(claims(""))[strings.LastIndex(raw(claims("")), ".")+1:]))),
			get("alg-missing", auth("Bearer "+k1.sign(`{"kid":"k1"}`, claims("")))),
			get("alg-empty", auth("Bearer "+k1.sign(`{"alg":"","kid":"k1"}`, claims("")))),
			get("alg-hs256", auth("Bearer "+k1.sign(`{"alg":"HS256","kid":"k1"}`, claims("")))),
			get("alg-none", auth("Bearer "+RawJWT(`{"alg":"none","kid":"k1"}`, claims(""), nil))),
			get("alg-rs512", auth("Bearer "+k1.sign(`{"alg":"RS512","kid":"k1"}`, claims("")))),
			get("alg-list", auth("Bearer "+k1.sign(`{"alg":["RS256"],"kid":"k1"}`, claims("")))),
			get("unknown-kid", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"nope"}`, claims("")))),
			get("no-kid", auth("Bearer "+k1.sign(`{"alg":"RS256"}`, claims("")))),
			get("kid-null", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":null}`, claims("")))),
			get("kid-int", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":5}`, claims("")))),
			get("kid-enc-key", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"kenc"}`, claims("")))),
			get("kid-ec-key", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"kec"}`, claims("")))),
			get("kid-ec-key-es256", auth("Bearer "+k1.sign(`{"alg":"ES256","kid":"kec"}`, claims("")))),
			get("kid-oct-key", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"koct"}`, claims("")))),
			get("kid-skipped-key", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"kalg"}`, claims("")))),
		}},
		{name: "claims", cases: []Case{
			get("expired", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,"exp":%d,%s}`, iss, past, scp)))),
			get("exp-float", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,"exp":%d.75,%s}`, iss, exp, scp)))),
			get("exp-float-past", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,"exp":%d.5,%s}`, iss, past, scp)))),
			get("exp-string-int", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,"exp":" %d ",%s}`, iss, exp, scp)))),
			get("exp-string-underscore", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,"exp":"9_999_999_999",%s}`, iss, scp)))),
			get("exp-string-bad", auth("Bearer "+raw(pl(`"exp2":1,"exp":"soon",`+scp)))),
			get("exp-string-float", auth("Bearer "+raw(pl(`"exp2":1,"exp":"1.5",`+scp)))),
			get("exp-null", auth("Bearer "+raw(pl(`"exp2":1,"exp":null,`+scp)))),
			get("exp-list", auth("Bearer "+raw(pl(`"exp2":1,"exp":[1],`+scp)))),
			get("exp-true", auth("Bearer "+raw(pl(`"exp2":1,"exp":true,`+scp)))),
			get("exp-nan", auth("Bearer "+raw(pl(`"exp2":1,"exp":NaN,`+scp)))),
			get("exp-infinity", auth("Bearer "+raw(pl(`"exp2":1,"exp":Infinity,`+scp)))),
			get("exp-huge", auth("Bearer "+raw(pl(`"exp2":1,"exp":1`+strings.Repeat("0", 60)+`,`+scp)))),
			get("exp-too-many-digits", auth("Bearer "+raw(pl(`"exp2":1,"exp":1`+strings.Repeat("0", 4400)+`,`+scp)))),
			get("no-exp", auth("Bearer "+raw(fmt.Sprintf(`{"iss":%q,%s}`, iss, scp)))),
			get("nbf-future", auth("Bearer "+raw(pl(fmt.Sprintf(`"nbf":%d,%s`, fut, scp))))),
			get("nbf-past", auth("Bearer "+raw(pl(fmt.Sprintf(`"nbf":%d,%s`, past, scp))))),
			get("nbf-bad", auth("Bearer "+raw(pl(`"nbf":"x",`+scp)))),
			get("iat-future", auth("Bearer "+raw(pl(fmt.Sprintf(`"iat":%d,%s`, fut, scp))))),
			get("iat-bad", auth("Bearer "+raw(pl(`"iat":"x",`+scp)))),
			get("iat-null", auth("Bearer "+raw(pl(`"iat":null,`+scp)))),
			get("iss-missing", auth("Bearer "+raw(fmt.Sprintf(`{"exp":%d,%s}`, exp, scp)))),
			get("iss-wrong", auth("Bearer "+raw(fmt.Sprintf(`{"iss":"https://evil","exp":%d,%s}`, exp, scp)))),
			get("iss-int", auth("Bearer "+raw(fmt.Sprintf(`{"iss":5,"exp":%d,%s}`, exp, scp)))),
			get("iss-expired-both", auth("Bearer "+raw(fmt.Sprintf(`{"iss":"x","exp":%d,%s}`, past, scp)))),
			get("dup-key-last-wins", auth("Bearer "+raw(fmt.Sprintf(`{"iss":"x","iss":%q,"exp":%d,%s}`, iss, exp, scp)))),
		}},
		{name: "scope and identity headers", cases: []Case{
			get("scp-missing", auth("Bearer "+raw(pl(`"client_id":"c"`)))),
			get("scp-other", auth("Bearer "+raw(pl(`"scp":["openid"]`)))),
			get("scp-string-substring", auth("Bearer "+raw(pl(`"scp":"xx authelia.bearer.authz yy"`)))),
			get("scp-dict", auth("Bearer "+raw(pl(`"scp":{"authelia.bearer.authz":1}`)))),
			get("scp-int", auth("Bearer "+raw(pl(`"scp":5`)))),
			get("scp-null", auth("Bearer "+raw(pl(`"scp":null`)))),
			get("client-int", auth("Bearer "+raw(pl(`"client_id":5,`+scp)))),
			get("client-float", auth("Bearer "+raw(pl(`"client_id":1.5,`+scp)))),
			get("client-float-big", auth("Bearer "+raw(pl(`"client_id":1e16,"sub":0.0001,`+scp)))),
			get("client-float-small", auth("Bearer "+raw(pl(`"client_id":1e-5,"sub":123456789012345678.0,`+scp)))),
			get("client-bool-null", auth("Bearer "+raw(pl(`"client_id":true,"sub":null,`+scp)))),
			get("client-list", auth("Bearer "+raw(pl(`"client_id":["a",1,null,"it's"],`+scp)))),
			get("client-dict", auth("Bearer "+raw(pl(`"client_id":{"k":"v","d":[1.0,false]},`+scp)))),
			get("client-padded", auth("Bearer "+raw(pl(`"client_id":"  cli  ","sub":" s ",`+scp)))),
			get("client-latin1", auth("Bearer "+raw(pl(`"client_id":"café",`+scp)))),
			get("client-non-latin1", auth("Bearer "+raw(pl(`"client_id":"€",`+scp)))),
			get("client-newline", auth("Bearer "+raw(pl(`"client_id":"a\nb",`+scp)))),
			get("client-tab", auth("Bearer "+raw(pl(`"client_id":"a\tb",`+scp)))),
			get("client-del", auth("Bearer "+raw(pl(`"client_id":"a\u007fb","sub":"<x&'\"",`+scp)))),
			get("client-surrogate", auth("Bearer "+raw(pl(`"client_id":"\ud800",`+scp)))),
			get("client-emoji", auth("Bearer "+raw(pl(`"client_id":["😀","\u0085"],`+scp)))),
		}},
		{name: "engine answers (no failures)", cases: []Case{
			get("ft-active", auth(eng("ft_active", behaviour{body: `{"active":true,"id":"tk_9","name":"ci","subject":"owner","scopes":["a","b"]}`}))),
			get("ft-active-no-subject", auth(eng("ft_nosub", behaviour{body: `{"active":true,"name":"ci","subject":""}`}))),
			get("ft-active-scopes-string", auth(eng("ft_sstr", behaviour{body: `{"active":true,"name":"ci","scopes":"abc"}`}))),
			get("ft-active-scopes-dict", auth(eng("ft_sdict", behaviour{body: `{"active":true,"name":"ci","scopes":{"x":1,"y":2}}`}))),
			get("ft-active-scopes-int-item", auth(eng("ft_sint", behaviour{body: `{"active":true,"name":"ci","scopes":["a",1]}`}))),
			get("ft-active-scopes-null", auth(eng("ft_snull", behaviour{body: `{"active":true,"name":"ci","scopes":null}`}))),
			get("ft-active-name-int", auth(eng("ft_nint", behaviour{body: `{"active":true,"name":7}`}))),
			get("ft-active-name-newline", auth(eng("ft_nnl", behaviour{body: `{"active":true,"name":"a\nb"}`}))),
			get("ft-active-name-tab", auth(eng("ft_ntab", behaviour{body: `{"active":true,"name":"a\tb"}`}))),
			get("ft-active-1", auth(eng("ft_one", behaviour{body: `{"active":1,"name":"ci"}`}))),
			get("ft-active-string", auth(eng("ft_str", behaviour{body: `{"active":"no","name":"ci"}`}))),
			get("ft-active-empty-list", auth(eng("ft_el", behaviour{body: `{"active":[],"name":"ci"}`}))),
			get("ft-inactive", auth(eng("ft_inactive", behaviour{body: `{"active":false}`}))),
			get("ft-answer-null", auth(eng("ft_null", behaviour{body: `null`}))),
			get("ft-answer-list", auth(eng("ft_list", behaviour{body: `[1]`}))),
			get("ft-answer-string", auth(eng("ft_strans", behaviour{body: `"yes"`}))),
			get("ft-answer-empty-object", auth(eng("ft_empty", behaviour{body: `{}`}))),
			get("jwt-engine-revoked", auth(engJWT(claims(`,"e":1`), behaviour{body: `{"active":false,"reason":"revoked"}`}))),
			get("jwt-engine-null", auth(engJWT(claims(`,"e":2`), behaviour{body: `null`}))),
			get("jwt-engine-list", auth(engJWT(claims(`,"e":3`), behaviour{body: `[true]`}))),
			get("jwt-engine-active-0", auth(engJWT(claims(`,"e":4`), behaviour{body: `{"active":0}`}))),
		}},
		{name: "mcp-oauth", cases: []Case{
			get("mcp-unknown", auth("Bearer mcpat_unknown")),
			get("mcp-active", auth(mcp("mcpat_ok", behaviour{body: fmt.Sprintf(`{"active":true,"sub":"owner","client_id":"claude","exp":%d}`, exp)}))),
			get("mcp-active-again", auth("Bearer mcpat_ok")),
			get("mcp-active-no-exp", auth(mcp("mcpat_noexp", behaviour{body: `{"active":true,"sub":"o"}`}))),
			get("mcp-active-exp-bad", auth(mcp("mcpat_badexp", behaviour{body: `{"active":true,"sub":"o","exp":"x"}`}))),
			get("mcp-active-exp-null", auth(mcp("mcpat_nullexp", behaviour{body: `{"active":true,"sub":"o","exp":null}`}))),
			get("mcp-active-sub-int", auth(mcp("mcpat_subint", behaviour{body: `{"active":true,"sub":9,"client_id":null}`}))),
			get("mcp-inactive", auth(mcp("mcpat_no", behaviour{body: `{"active":false,"sub":"o"}`}))),
			get("mcp-list", auth(mcp("mcpat_list", behaviour{body: `[]`}))),
			get("mcp-500", auth(mcp("mcpat_500", behaviour{status: 500, body: `{}`}))),
			get("mcp-badjson", auth(mcp("mcpat_bad", behaviour{body: `{`}))),
			get("mcp-slow", auth(mcp("mcpat_slow", behaviour{body: `{"active":true}`, delay: 3500 * time.Millisecond}))),
			get("mcp-plus-chars", auth(mcp("mcpat_a+b/c=d e", behaviour{body: `{"active":true,"sub":"plus"}`}))),
		}},
		{name: "jwks failure modes", setup: func() { time.Sleep(2300 * time.Millisecond); up.setJWKS(behaviour{status: 500, body: `{}`}) }, cases: []Case{
			get("jwks-500-cached-kid-still-works", auth("Bearer "+raw(claims(`,"p":1`)))),
			get("jwks-500-new-kid", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks invalid json", setup: func() { up.setJWKS(behaviour{body: `{"keys":`}) }, cases: []Case{
			get("jwks-badjson", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks 404", setup: func() { up.setJWKS(behaviour{status: 404, body: `nf`}) }, cases: []Case{
			get("jwks-404", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks list (sticky)", setup: func() { up.setJWKS(behaviour{body: `[1]`}) }, cases: []Case{
			get("jwks-list", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
			get("jwks-list-cached", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew2"}`, claims("")))),
		}},
		{name: "jwks null", setup: func() { time.Sleep(2300 * time.Millisecond); up.setJWKS(behaviour{body: `null`}) }, cases: []Case{
			get("jwks-null", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks empty keys (sticky)", setup: func() { up.setJWKS(behaviour{body: `{"keys":[]}`}) }, cases: []Case{
			get("jwks-empty", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks keys not a list", setup: func() { time.Sleep(2300 * time.Millisecond); up.setJWKS(behaviour{body: `{"keys":{"a":1}}`}) }, cases: []Case{
			get("jwks-keys-dict", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks no signing keys", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: `{"keys":[{"kty":"RSA","kid":"x","use":"enc","n":"` + B64(k1.k.N.Bytes()) + `","e":"AQAB"},{"kty":"RSA","n":"` + B64(k1.k.N.Bytes()) + `","e":"AQAB"}]}`})
		}, cases: []Case{
			get("jwks-no-sig", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks unusable keys", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: `{"keys":[{"kid":"a"},{"kty":"XX","kid":"b"},{"kty":"OKP","kid":"c","crv":"X448"}]}`})
		}, cases: []Case{
			get("jwks-unusable", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks non-object key", setup: func() { time.Sleep(2300 * time.Millisecond); up.setJWKS(behaviour{body: `{"keys":["x"]}`}) }, cases: []Case{
			get("jwks-key-string", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks rsa key with even e", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: `{"keys":[{"kty":"RSA","kid":"knew","n":"` + B64(k1.k.N.Bytes()) + `","e":"AAQ"}]}`})
		}, cases: []Case{
			get("jwks-even-e", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks rsa key with numeric n", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: `{"keys":[{"kty":"RSA","kid":"knew","n":5,"e":"AQAB"}]}`})
		}, cases: []Case{
			get("jwks-numeric-n", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks slow", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: okSet, delay: 3500 * time.Millisecond})
		}, cases: []Case{
			get("jwks-timeout", auth("Bearer "+k1.sign(`{"alg":"RS256","kid":"knew"}`, claims("")))),
		}},
		{name: "jwks recovered: new key", setup: func() {
			time.Sleep(2300 * time.Millisecond)
			up.setJWKS(behaviour{body: `{"keys":[` + rsaKey{k2.k, "knew"}.jwk("") + `]}`})
		}, cases: []Case{
			get("jwks-recovered", auth("Bearer "+k2.sign(`{"alg":"RS256","kid":"knew"}`, claims(`,"r":1`)))),
		}},
		// Engine failures last: each trips the 10 s breaker in both implementations.
		{name: "engine 500", setup: func() {}, cases: []Case{
			get("engine-500", auth(eng("ft_e500", behaviour{status: 500, body: `{}`}))),
			get("engine-breaker-open", auth(eng("ft_after", behaviour{body: `{"active":true,"name":"x"}`}))),
			get("engine-breaker-open-jwt", auth("Bearer "+raw(claims(`,"b":1`)))),
		}},
		{name: "engine bad json", setup: func() { time.Sleep(10500 * time.Millisecond) }, cases: []Case{
			get("engine-badjson", auth(eng("ft_ebad", behaviour{body: `{"active":`}))),
		}},
		{name: "engine slow", setup: func() { time.Sleep(10500 * time.Millisecond) }, cases: []Case{
			get("engine-timeout", auth(eng("ft_eslow", behaviour{body: `{"active":true}`, delay: 3500 * time.Millisecond}))),
		}},
		{name: "engine slow for a jwt", setup: func() { time.Sleep(10500 * time.Millisecond) }, cases: []Case{
			get("engine-timeout-jwt", auth(engJWT(claims(`,"slow":1`), behaviour{body: `{"active":false}`, delay: 3500 * time.Millisecond}))),
		}},
	}

	cl := NewClient(20 * time.Second)
	ctx := context.Background()
	total, failed := 0, 0
	var allCases []Case
	for _, s := range steps {
		if s.setup != nil {
			s.setup()
		}
		for _, c := range s.cases {
			if versionBound[c.Name] {
				continue
			}
			total++
			allCases = append(allCases, c)
			a := Do(ctx, cl, pyBase, c)
			b := Do(ctx, cl, goSrv.URL, c)
			if os.Getenv("SHADOW_VERBOSE") != "" {
				t.Logf("%-34s %s", c.Name, a)
			}
			if !Same(a, b) {
				failed++
				t.Errorf("[%s] %s\n  python: %s\n  go:     %s", s.name, c.Name, a, b)
			}
		}
	}
	t.Logf("shadow-compare: %d cases, %d mismatches", total, failed)
	if failed > 0 {
		t.Logf("python log tail:\n%s", tail(pylog.String(), 4000))
	}

	// Mutation proof: a candidate that changes one decision, one header or one body must be
	// caught by the same comparison.
	mutants := map[string]func(http.Handler) http.Handler{
		"status 401 -> 403": func(h http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, r)
				copyResp(w, rec, func(c int) int {
					if c == 401 {
						return 403
					}
					return c
				}, "", "")
			})
		},
		"drop X-Auth-User": func(h http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, r)
				rec.Header().Del("X-Auth-User")
				copyResp(w, rec, nil, "", "")
			})
		},
		"body changed": func(h http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, r)
				copyResp(w, rec, nil, "Invalid token", "Invalid  token")
			})
		},
		"allow everything": func(h http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				_, _ = io.WriteString(w, "OK")
			})
		},
	}
	probe := []Case{
		get("probe-invalid", auth("Bearer abc")),
		get("probe-valid", auth("Bearer "+raw(claims(`,"m":1`)))),
	}
	for name, mut := range mutants {
		m := httptest.NewServer(mut(proxy.Handler(cfg)))
		caught := false
		for _, c := range probe {
			pa, pm := Do(ctx, cl, pyBase, c), Do(ctx, cl, m.URL, c)
			if os.Getenv("SHADOW_VERBOSE") != "" {
				t.Logf("mutant %s %s: python=%s mutant=%s", name, c.Name, pa, pm)
			}
			if !Same(pa, pm) {
				caught = true
			}
		}
		m.Close()
		if !caught {
			t.Errorf("mutation not caught: %s", name)
		} else {
			t.Logf("ok: mutation caught: %s", name)
		}
	}
	_ = allCases
}

func copyResp(w http.ResponseWriter, rec *httptest.ResponseRecorder, status func(int) int, from, to string) {
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	body := rec.Body.String()
	if from != "" {
		body = strings.Replace(body, from, to, 1)
	}
	w.Header().Del("Content-Length")
	c := rec.Code
	if status != nil {
		c = status(c)
	}
	w.WriteHeader(c)
	_, _ = io.WriteString(w, body)
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

func mustRSA(t *testing.T, bits int) *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// leadingZeroSig finds a payload whose RS256 signature starts with a zero byte and returns the
// token with that byte dropped. The reference refuses it (cryptography wants the full modulus
// length); a port that left-pads would accept it, which this case caught once.
func leadingZeroSig(k rsaKey, header, payload string) string {
	for i := 0; i < 5000; i++ {
		p := strings.TrimSuffix(payload, "}") + fmt.Sprintf(`,"z":%d}`, i)
		si := B64([]byte(header)) + "." + B64([]byte(p))
		h := sha256.Sum256([]byte(si))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, k.k, crypto.SHA256, h[:])
		if sig[0] == 0 {
			return si + "." + B64(sig[1:])
		}
	}
	return "unreachable"
}
