package broker

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"auth-broker/fleetauth"
)

const secret = "unit-cookie-secret-synthetic-0123456789"

type fixture struct {
	b     *Broker
	clock *int64
	mails []string
	srv   *httptest.Server
}

func doc(t *testing.T, mutate func(ab map[string]any)) fleetauth.Value {
	t.Helper()
	ab := map[string]any{
		"allowed_emails": []string{"owner@example.org"},
		"allowed_github": []any{map[string]any{"login": "Owner", "id": 42, "email": "owner@example.org"}},
		"cookie_name":    "_sso", "cookie_domain": ".example.org", "cookie_expire_seconds": 3600, "rd_domain": "example.org",
		"cloudflare_access": map[string]any{"enabled": false},
		"email_otp":         map[string]any{"code_length": 6, "ttl_seconds": 600, "max_attempts": 2, "send_per_address": 2, "send_per_ip": 5},
		"providers": []any{
			map[string]any{"id": "email", "enabled": true, "provider": "email", "flow": "email", "prefix": "/oauth2/email", "port": 1},
			map[string]any{"id": "gh", "enabled": true, "provider": "github", "flow": "device", "client_id": "c", "prefix": "/oauth2/gh", "port": 2, "scope": "read:user"},
		},
	}
	if mutate != nil {
		mutate(ab)
	}
	raw, _ := json.Marshal(map[string]any{"auth_broker": ab})
	v, err := fleetauth.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func newFixture(t *testing.T, prov string, mutate func(ab map[string]any)) *fixture {
	t.Helper()
	f := &fixture{clock: new(int64)}
	atomic.StoreInt64(f.clock, 1_800_000_000)
	var n byte
	b, err := New(Config{Doc: doc(t, mutate), Provider: prov, Env: func(k string) string {
		if k == "AUTH_BROKER_COOKIE_SECRET" {
			return secret
		}
		return ""
	},
		Now: func() float64 { return float64(atomic.LoadInt64(f.clock)) },
		Rand: func(k int) []byte {
			out := make([]byte, k)
			for i := range out {
				n++
				out[i] = n * 13
			}
			return out
		},
		RandBelow: func(k int64) int64 { n++; return int64(n) * 7919 % k },
		Mailer:    func(to, code string) error { f.mails = append(f.mails, to+" "+code); return nil },
		Out:       func(string) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	f.b = b
	f.srv = httptest.NewServer(b.Handler())
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) post(path, body string) (int, string, http.Header) {
	req, _ := http.NewRequest("POST", f.srv.URL+path, strings.NewReader(body))
	req.Header.Set("X-Requested-With", "sso")
	req.Header.Set("Content-Type", "application/json")
	return f.do(req)
}

func (f *fixture) get(path string, hdr map[string]string) (int, string, http.Header) {
	req, _ := http.NewRequest("GET", f.srv.URL+path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	return f.do(req)
}

func (f *fixture) do(req *http.Request) (int, string, http.Header) {
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return -1, err.Error(), nil
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), resp.Header
}

func cookieOf(h http.Header) string {
	for _, c := range h.Values("Set-Cookie") {
		if strings.HasPrefix(c, "_sso=") {
			return strings.SplitN(strings.TrimPrefix(c, "_sso="), ";", 2)[0]
		}
	}
	return ""
}

func TestEmailCodeFlow(t *testing.T) {
	f := newFixture(t, "email", nil)
	code, body, _ := f.post("/oauth2/email/request", `{"email":" Owner@Example.org "}`)
	if code != 200 || !strings.Contains(body, `"status": "sent"`) || len(f.mails) != 1 {
		t.Fatalf("request: %d %s %v", code, body, f.mails)
	}
	sid := strings.Split(strings.Split(body, `"sid": "`)[1], `"`)[0]
	mailed := strings.Fields(f.mails[0])[1]
	if _, b, _ := f.post("/oauth2/email/verify", `{"sid":"`+sid+`","code":"000000"}`); !strings.Contains(b, `"wrong"`) {
		t.Fatalf("wrong code: %s", b)
	}
	code, body, h := f.post("/oauth2/email/verify", `{"sid":"`+sid+`","code":"`+mailed+`","rd":"https://app.example.org/x"}`)
	if code != 200 || !strings.Contains(body, `"status": "ok"`) || !strings.Contains(body, `"rd": "https://app.example.org/x"`) || cookieOf(h) == "" {
		t.Fatalf("verify: %d %s", code, body)
	}
	if !strings.Contains(strings.Join(h.Values("Set-Cookie"), "|"), "Domain=.example.org; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax") {
		t.Fatalf("cookie attributes: %v", h.Values("Set-Cookie"))
	}
	if _, b, _ := f.post("/oauth2/email/verify", `{"sid":"`+sid+`","code":"`+mailed+`"}`); !strings.Contains(b, `"expired"`) {
		t.Fatalf("a code works once: %s", b)
	}
	c2, _, h2 := f.get("/oauth2/email/auth", map[string]string{"Cookie": "_sso=" + cookieOf(h)})
	if c2 != 202 || h2.Get("X-Auth-Request-Email") != "owner@example.org" {
		t.Fatalf("session: %d %v", c2, h2)
	}
	// expiry of the session
	atomic.AddInt64(f.clock, 3600)
	if c, _, _ := f.get("/oauth2/email/auth", map[string]string{"Cookie": "_sso=" + cookieOf(h)}); c != 401 {
		t.Fatalf("expired session: %d", c)
	}
}

func TestEmailAnswersDoNotLeakTheAllowlist(t *testing.T) {
	f := newFixture(t, "email", nil)
	_, a, _ := f.post("/oauth2/email/request", `{"email":"owner@example.org"}`)
	_, b, _ := f.post("/oauth2/email/request", `{"email":"stranger@example.org"}`)
	strip := func(s string) string { return s[:strings.Index(s, `"sid"`)] + s[strings.Index(s, `"status"`):] }
	if strip(a) != strip(b) {
		t.Fatalf("answers differ:\n%s\n%s", a, b)
	}
	if len(f.mails) != 1 || !strings.HasPrefix(f.mails[0], "owner@") {
		t.Fatalf("only the listed address gets a mail: %v", f.mails)
	}
	// two mails per address and window; the third request is answered the same and sends nothing
	f.post("/oauth2/email/request", `{"email":"owner@example.org"}`)
	_, c, _ := f.post("/oauth2/email/request", `{"email":"owner@example.org"}`)
	if strip(c) != strip(a) || len(f.mails) != 2 {
		t.Fatalf("throttled request: %s mails=%v", c, f.mails)
	}
	// attempts: two wrong codes lock the flow
	sid := strings.Split(strings.Split(a, `"sid": "`)[1], `"`)[0]
	f.post("/oauth2/email/verify", `{"sid":"`+sid+`","code":"111111"}`)
	if _, b, _ := f.post("/oauth2/email/verify", `{"sid":"`+sid+`","code":"222222"}`); !strings.Contains(b, `"locked"`) {
		t.Fatalf("lock: %s", b)
	}
}

func TestRedirectTargets(t *testing.T) {
	f := newFixture(t, "email", nil)
	for rd, want := range map[string]string{
		"/ok": "/ok", "//evil.example": "/", `/a\b`: "/", "https://example.org/x": "https://example.org/x", "https://a.example.org/": "https://a.example.org/",
		"https://example.org.evil.com/": "/", "http://a.example.org/": "/", "": "/", "javascript:alert(1)": "/",
	} {
		if got := f.b.safeRDStr(rd); got != want {
			t.Errorf("safeRD(%q) = %q, want %q", rd, got, want)
		}
	}
}

func TestSessionCookieRules(t *testing.T) {
	f := newFixture(t, "email", nil)
	c := f.b.makeCookie("owner@example.org", "email")
	if e, ok := f.b.sessionEmail("a=b; _sso=" + c); !ok || e != "owner@example.org" {
		t.Fatalf("valid cookie: %q %v", e, ok)
	}
	for name, cookie := range map[string]string{
		"tampered":  strings.Replace(c, "v1.", "v1.A", 1),
		"version":   strings.Replace(c, "v1.", "v2.", 1),
		"signature": c[:len(c)-2] + "xx",
		"empty":     "",
	} {
		if _, ok := f.b.sessionEmail("_sso=" + cookie); ok {
			t.Errorf("%s cookie accepted", name)
		}
	}
	other := newFixture(t, "gh", nil)
	if _, ok := other.b.sessionEmail("_sso=" + c); !ok {
		t.Error("every instance validates a session issued by any other")
	}
}

func TestRealBuildJSONLoads(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "infra-sec_auth-broker", "build.json"))
	if err != nil {
		t.Skip("python service's build.json not in this checkout")
	}
	v, err := fleetauth.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"AUTH_BROKER_COOKIE_SECRET": secret, "AUTH_BROKER_GOOGLE_CLIENT_ID": "x", "AUTH_BROKER_GOOGLE_CLIENT_SECRET": "y",
		"AUTH_BROKER_GITHUB_APP_CLIENT_SECRET": "z"}
	for _, id := range []string{"google", "github", "cloudflare", "email"} {
		b, err := New(Config{Doc: v, Provider: id, Env: func(k string) string { return env[k] }, Out: func(string) {}})
		if err != nil {
			t.Errorf("provider %s: %v", id, err)
			continue
		}
		if !strings.HasPrefix(b.Prefix(), "/oauth2/") || b.Port() == "" {
			t.Errorf("provider %s: prefix %q port %q", id, b.Prefix(), b.Port())
		}
	}
}

// ---- Cloudflare Access verification --------------------------------------------------------------------------

func cfFixture(t *testing.T) (*fixture, *rsa.PrivateKey, func(claims map[string]any, kid string) string) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	certs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e := []byte{1, 0, 1}
		fmt.Fprintf(w, `{"keys":[{"kty":"RSA","kid":"k1","n":%q,"e":%q}]}`, base64.RawURLEncoding.EncodeToString(key.N.Bytes()), base64.RawURLEncoding.EncodeToString(e))
	}))
	t.Cleanup(certs.Close)
	f := newFixture(t, "email", func(ab map[string]any) {
		ab["cloudflare_access"] = map[string]any{"enabled": true, "team_domain": "team.example", "certs_url": certs.URL, "aud": []string{"aud1"}}
	})
	mk := func(claims map[string]any, kid string) string {
		base := map[string]any{"iss": "https://team.example", "aud": []string{"aud1"}, "email": "owner@example.org", "exp": atomic.LoadInt64(f.clock) + 600}
		for k, v := range claims {
			if v == nil {
				delete(base, k)
			} else {
				base[k] = v
			}
		}
		hb, _ := json.Marshal(map[string]any{"alg": "RS256", "kid": kid})
		pb, _ := json.Marshal(base)
		h, p := base64.RawURLEncoding.EncodeToString(hb), base64.RawURLEncoding.EncodeToString(pb)
		d := sha256.Sum256([]byte(h + "." + p))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, d[:])
		return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
	}
	return f, key, mk
}

func TestCloudflareAccessJWT(t *testing.T) {
	f, _, mk := cfFixture(t)
	now := atomic.LoadInt64(f.clock)
	for name, c := range map[string]struct {
		tok  string
		want string
	}{
		"valid":          {mk(nil, "k1"), "owner@example.org"},
		"expired":        {mk(map[string]any{"exp": now - 1}, "k1"), ""},
		"wrong audience": {mk(map[string]any{"aud": []string{"other"}}, "k1"), ""},
		"wrong issuer":   {mk(map[string]any{"iss": "https://evil.example"}, "k1"), ""},
		"string aud":     {mk(map[string]any{"aud": "aud1"}, "k1"), "owner@example.org"},
		"nbf in grace":   {mk(map[string]any{"nbf": now + 30}, "k1"), "owner@example.org"},
		"nbf too far":    {mk(map[string]any{"nbf": now + 90}, "k1"), ""},
		"stranger":       {mk(map[string]any{"email": "x@example.org"}, "k1"), ""},
		"service token":  {mk(map[string]any{"email": nil}, "k1"), ""},
		"unknown kid":    {mk(nil, "nope"), ""},
		"not a jwt":      {"a.b", ""},
		"empty":          {"", ""},
	} {
		if got := f.b.cfEmail(c.tok); got != c.want {
			t.Errorf("%s: %q, want %q", name, got, c.want)
		}
	}
	parts := strings.Split(mk(nil, "k1"), ".")
	forged := parts[0] + "." + base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"https://team.example","aud":["aud1"],"email":"owner@example.org","exp":9999999999}`)) + "." + parts[2]
	if f.b.cfEmail(forged) != "" {
		t.Error("a payload swapped under a valid signature must fail")
	}
	// the gate endpoint
	if c, _, h := f.get("/oauth2/email/cf-auth", map[string]string{"Cf-Access-Jwt-Assertion": mk(nil, "k1")}); c != 202 || h.Get("X-Auth-Request-Email") != "owner@example.org" {
		t.Errorf("cf-auth: %d %v", c, h)
	}
	if c, _, _ := f.get("/oauth2/email/cf-auth", nil); c != 401 {
		t.Errorf("cf-auth without header: %d", c)
	}
}

// ---- web flow ----------------------------------------------------------------------------------------------

func TestWebFlowStateIsSingleUseAndBoundToTheBrowser(t *testing.T) {
	var exchanges int32
	prov := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			atomic.AddInt32(&exchanges, 1)
			io.WriteString(w, `{"access_token":"AT"}`)
		case "/userinfo":
			io.WriteString(w, `{"email":"owner@example.org","email_verified":true}`)
		}
	}))
	t.Cleanup(prov.Close)
	f := newFixture(t, "g", func(ab map[string]any) {
		ab["providers"] = []any{map[string]any{"id": "g", "enabled": true, "provider": "google", "flow": "web", "client_id": "cid", "secret_prefix": "G",
			"prefix": "/oauth2/g", "port": 3, "scope": "openid email", "auth_url": "https://accounts.example/auth", "token_url": prov.URL + "/token",
			"userinfo_url": prov.URL + "/userinfo", "redirect_uris": []string{"https://auth.example.org/oauth2/g/callback"}}}
	})
	f.b.webSec = "s" // the web leg needs the client secret
	req, _ := http.NewRequest("GET", f.srv.URL+"/oauth2/g/start?rd=%2Fhome", nil)
	req.Host = "auth.example.org"
	code, _, h := f.do(req)
	loc := h.Get("Location")
	if code != 302 || !strings.HasPrefix(loc, "https://accounts.example/auth?") || !strings.Contains(loc, "code_challenge_method=S256") || !strings.Contains(loc, "prompt=select_account") {
		t.Fatalf("start: %d %s", code, loc)
	}
	state := strings.Split(strings.Split(loc, "state=")[1], "&")[0]
	bind := strings.Split(strings.TrimPrefix(h.Get("Set-Cookie"), "_sso_state="), ";")[0]
	cb := func(st, bd string) (int, http.Header) {
		c, _, hh := f.get("/oauth2/g/callback?state="+st+"&code=c1", map[string]string{"Cookie": "_sso_state=" + bd})
		return c, hh
	}
	if c, _ := cb(state, "other-browser"); c != 400 {
		t.Fatalf("state bound to another browser must fail: %d", c)
	}
	if c, _ := cb(state, bind); c != 400 {
		t.Fatalf("state is single use, even after a failed attempt: %d", c)
	}
	req, _ = http.NewRequest("GET", f.srv.URL+"/oauth2/g/start?rd=%2Fhome", nil)
	req.Host = "auth.example.org"
	_, _, h = f.do(req)
	state = strings.Split(strings.Split(h.Get("Location"), "state=")[1], "&")[0]
	bind = strings.Split(strings.TrimPrefix(h.Get("Set-Cookie"), "_sso_state="), ";")[0]
	c, hh := cb(state, bind)
	if c != 302 || hh.Get("Location") != "/home" || cookieOf(hh) == "" || atomic.LoadInt32(&exchanges) != 1 {
		t.Fatalf("callback: %d %v exchanges=%d", c, hh, exchanges)
	}
	if c, _ := cb(state, bind); c != 400 {
		t.Fatalf("replay: %d", c)
	}
}

func TestStartupRefusals(t *testing.T) {
	for name, mut := range map[string]func(ab map[string]any){
		"empty allowlist": func(ab map[string]any) { ab["allowed_emails"] = []string{} },
		"cf without aud":  func(ab map[string]any) { ab["cloudflare_access"] = map[string]any{"enabled": true, "team_domain": "t"} },
		"no otp block":    func(ab map[string]any) { delete(ab, "email_otp") },
	} {
		_, err := New(Config{Doc: doc(t, mut), Provider: "email", Env: func(k string) string { return secret }})
		if err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := New(Config{Doc: doc(t, nil), Provider: "email", Env: func(string) string { return "short" }}); err == nil || !strings.Contains(err.Error(), "shorter than 32") {
		t.Errorf("short secret: %v", err)
	}
}
