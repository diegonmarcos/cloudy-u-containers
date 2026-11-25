package mcpoauth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
)

func newApp(t *testing.T, mut func(*Config)) (*App, *int64) {
	t.Helper()
	clock := new(int64)
	atomic.StoreInt64(clock, 1_800_000_000)
	var ctr byte
	cfg := Config{
		Issuer: "https://c3-pub.example.org/mcp-oauth", AuthorizeBase: "https://c3-pvt.example.org/mcp-oauth",
		DBPath: filepath.Join(t.TempDir(), "o.sqlite3"), IntrospectSecret: "isecret", FormSecret: "form-secret-synthetic",
		AllowedUsers: []string{"owner"}, Scopes: []string{"mcp"}, AccessTTL: 3600, RefreshTTL: 86400, CodeTTL: 300, MaxClients: 3,
		AllowedRedirects: []string{"https://claude.ai/api/mcp/auth_callback"},
		Clock:            func() float64 { return float64(atomic.LoadInt64(clock)) },
		Rand: func(n int) []byte {
			b := make([]byte, n)
			for i := range b {
				ctr++
				b[i] = ctr * 11
			}
			return b
		},
	}
	if mut != nil {
		mut(&cfg)
	}
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a, clock
}

func do(a *App, method, path string, hdr map[string]string, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}

var formH = map[string]string{"Content-Type": "application/x-www-form-urlencoded"}

func jsonOf(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("not JSON (%d): %s", w.Code, w.Body.String())
	}
	return m
}

func pkce() (verifier, challenge string) {
	verifier = strings.Repeat("v", 50)
	d := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(d[:])
}

func register(t *testing.T, a *App, body string) map[string]any {
	t.Helper()
	w := do(a, "POST", "/register", map[string]string{"Content-Type": "application/json"}, body)
	if w.Code != 201 {
		t.Fatalf("register: %d %s", w.Code, w.Body.String())
	}
	return jsonOf(t, w)
}

// authorize walks GET /authorize then POST approve and returns the code from the redirect.
func authorize(t *testing.T, a *App, cid, redirect, challenge, user, decision string) (int, *url.URL) {
	t.Helper()
	q := url.Values{"client_id": {cid}, "redirect_uri": {redirect}, "response_type": {"code"}, "code_challenge": {challenge},
		"code_challenge_method": {"S256"}, "state": {"st8"}}
	w := do(a, "GET", "/authorize?"+q.Encode(), map[string]string{"Remote-User": user}, "")
	if w.Code != 200 {
		t.Fatalf("authorize page: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("consent page must forbid framing")
	}
	form := url.Values{}
	for _, m := range regexp.MustCompile(`name="([a-z_]+)" value="([^"]*)"`).FindAllStringSubmatch(w.Body.String(), -1) {
		form.Set(m[1], strings.NewReplacer("&amp;", "&", "&quot;", `"`, "&#x27;", "'", "&lt;", "<", "&gt;", ">").Replace(m[2]))
	}
	form.Set("decision", decision)
	w = do(a, "POST", "/authorize", map[string]string{"Remote-User": user, "Content-Type": "application/x-www-form-urlencoded"}, form.Encode())
	if w.Code != 302 {
		return w.Code, nil
	}
	u, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	return 302, u
}

func TestAuthorizationCodeFlowAndRefreshRotation(t *testing.T) {
	a, clock := newApp(t, nil)
	cl := register(t, a, `{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"],"client_name":"Claude"}`)
	cid := cl["client_id"].(string)
	verifier, challenge := pkce()
	code, loc := authorize(t, a, cid, "https://claude.ai/api/mcp/auth_callback", challenge, "owner", "approve")
	if code != 302 || loc.Query().Get("state") != "st8" || loc.Query().Get("iss") != "https://c3-pub.example.org/mcp-oauth" {
		t.Fatalf("approve redirect: %v", loc)
	}
	authCode := loc.Query().Get("code")
	tokenReq := func(extra url.Values) *httptest.ResponseRecorder {
		f := url.Values{"client_id": {cid}}
		for k, v := range extra {
			f[k] = v
		}
		return do(a, "POST", "/token", formH, f.Encode())
	}
	// wrong verifier burns the code; a second try with the right one fails too
	if w := tokenReq(url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "code_verifier": {strings.Repeat("x", 50)}}); w.Code != 400 || jsonOf(t, w)["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %d %s", w.Code, w.Body.String())
	}
	if w := tokenReq(url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "code_verifier": {verifier}}); w.Code != 400 {
		t.Fatalf("a code is single use even after a failed attempt: %d", w.Code)
	}
	_, loc = authorize(t, a, cid, "https://claude.ai/api/mcp/auth_callback", challenge, "owner", "approve")
	w := tokenReq(url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "code_verifier": {verifier}})
	if w.Code != 200 {
		t.Fatalf("token: %d %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("token answers must not be cached")
	}
	tk := jsonOf(t, w)
	at, rt := tk["access_token"].(string), tk["refresh_token"].(string)
	if !strings.HasPrefix(at, "mcpat_") || !strings.HasPrefix(rt, "mcprt_") || tk["expires_in"].(float64) != 3600 {
		t.Fatalf("token shape: %v", tk)
	}
	intro := func(tok string) map[string]any {
		return jsonOf(t, do(a, "POST", "/introspect", map[string]string{"Content-Type": "application/x-www-form-urlencoded", "X-Introspect-Secret": "isecret"}, url.Values{"token": {tok}}.Encode()))
	}
	if m := intro(at); m["active"] != true || m["sub"] != "owner" || m["client_id"] != cid {
		t.Fatalf("introspect: %v", m)
	}
	if do(a, "POST", "/introspect", map[string]string{"X-Introspect-Secret": "nope"}, "").Code != 401 {
		t.Fatal("introspect needs the shared secret")
	}
	// refresh rotates: the old refresh and the old access token die, the new pair works
	w = tokenReq(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rt}})
	if w.Code != 200 {
		t.Fatalf("refresh: %d %s", w.Code, w.Body.String())
	}
	tk2 := jsonOf(t, w)
	if intro(at)["active"] != false || intro(tk2["access_token"].(string))["active"] != true {
		t.Fatal("old access token must die with the refresh, the new one must work")
	}
	if w := tokenReq(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {rt}}); w.Code != 400 {
		t.Fatalf("a rotated refresh token must not work twice: %d", w.Code)
	}
	if w := tokenReq(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tk2["refresh_token"].(string)}, "scope": {"mcp admin"}}); w.Code != 400 || jsonOf(t, w)["error"] != "invalid_scope" {
		t.Fatalf("scope escalation: %d %s", w.Code, w.Body.String())
	}
	// expiry and revoke
	atomic.AddInt64(clock, 7200)
	if intro(tk2["access_token"].(string))["active"] != false {
		t.Fatal("an expired access token is inactive")
	}
}

func TestRegistrationRules(t *testing.T) {
	a, _ := newApp(t, nil)
	post := func(body string) *httptest.ResponseRecorder {
		return do(a, "POST", "/register", map[string]string{"Content-Type": "application/json"}, body)
	}
	for _, c := range []struct {
		name, body string
		want       int
	}{
		{"loopback any port", `{"redirect_uris":["http://127.0.0.1:5555/cb"]}`, 201},
		{"ipv6 loopback", `{"redirect_uris":["http://[::1]:7/cb"]}`, 201},
		{"foreign https", `{"redirect_uris":["https://evil.example.com/cb"]}`, 400},
		{"fragment", `{"redirect_uris":["https://claude.ai/api/mcp/auth_callback#x"]}`, 400},
		{"bad port", `{"redirect_uris":["http://localhost:99999/cb"]}`, 400},
		{"http non-loopback", `{"redirect_uris":["http://example.com/cb"]}`, 400},
		{"no uris", `{"redirect_uris":[]}`, 400},
		{"not an object", `[1]`, 400},
		{"bad method", `{"redirect_uris":["http://localhost/cb"],"token_endpoint_auth_method":"private_key_jwt"}`, 400},
		{"bad grant", `{"redirect_uris":["http://localhost/cb"],"grant_types":["password"]}`, 400},
		{"bad response type", `{"redirect_uris":["http://localhost/cb"],"response_types":["token"]}`, 400},
	} {
		if w := post(c.body); w.Code != c.want {
			t.Errorf("%s: %d want %d (%s)", c.name, w.Code, c.want, w.Body.String())
		}
	}
	// MAX_CLIENTS=3: the oldest client without tokens is evicted to make room; with tokens it stays
	for i := 0; i < 3; i++ {
		post(`{"redirect_uris":["http://localhost/cb"]}`)
	}
	if w := post(`{"redirect_uris":["http://localhost/cb"]}`); w.Code != 201 {
		t.Errorf("eviction: %d %s", w.Code, w.Body.String())
	}
}

func TestAuthorizeRefusals(t *testing.T) {
	a, _ := newApp(t, nil)
	cl := register(t, a, `{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}`)
	cid := cl["client_id"].(string)
	_, ch := pkce()
	base := url.Values{"client_id": {cid}, "response_type": {"code"}, "code_challenge": {ch}, "code_challenge_method": {"S256"}}
	get := func(q url.Values, user string) *httptest.ResponseRecorder {
		h := map[string]string{}
		if user != "" {
			h["Remote-User"] = user
		}
		return do(a, "GET", "/authorize?"+q.Encode(), h, "")
	}
	if w := get(base, ""); w.Code != 401 {
		t.Errorf("no session: %d", w.Code)
	}
	if w := get(base, "intruder"); w.Code != 403 {
		t.Errorf("user not allowed: %d", w.Code)
	}
	q := url.Values{}
	for k, v := range base {
		q[k] = v
	}
	q.Set("client_id", "mcpc_unknown")
	if w := get(q, "owner"); w.Code != 400 {
		t.Errorf("unknown client: %d", w.Code)
	}
	q.Set("client_id", cid)
	q.Set("redirect_uri", "https://evil.example.com/cb")
	if w := get(q, "owner"); w.Code != 400 {
		t.Errorf("unregistered redirect must never be redirected to: %d", w.Code)
	}
	q.Del("redirect_uri")
	q.Set("code_challenge_method", "plain")
	if w := get(q, "owner"); w.Code != 302 || !strings.Contains(w.Header().Get("Location"), "error=invalid_request") {
		t.Errorf("PKCE S256 is mandatory: %d %s", w.Code, w.Header().Get("Location"))
	}
	// a tampered consent form is refused
	_, loc := authorize(t, a, cid, "", ch, "owner", "deny")
	if loc.Query().Get("error") != "access_denied" {
		t.Errorf("deny: %v", loc)
	}
	form := url.Values{"client_id": {cid}, "redirect_uri": {"https://evil.example.com/cb"}, "sub": {"owner"}, "exp": {"9999999999"}, "sig": {"00"}, "decision": {"approve"}}
	if w := do(a, "POST", "/authorize", map[string]string{"Remote-User": "owner", "Content-Type": "application/x-www-form-urlencoded"}, form.Encode()); w.Code != 400 {
		t.Errorf("forged form: %d", w.Code)
	}
}

func TestDiscoveryAndRouting(t *testing.T) {
	a, _ := newApp(t, nil)
	for _, p := range []string{"/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/x/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/x"} {
		w := do(a, "GET", p, nil, "")
		m := jsonOf(t, w)
		if w.Code != 200 || m["token_endpoint"] != "https://c3-pub.example.org/mcp-oauth/token" || m["authorization_endpoint"] != "https://c3-pvt.example.org/mcp-oauth/authorize" {
			t.Errorf("%s: %d %v", p, w.Code, m)
		}
	}
	if m := jsonOf(t, do(a, "GET", "/.well-known/oauth-protected-resource/svc-a/mcp", nil, "")); m["resource"] != "https://c3-pub.example.org/mcp-oauth/svc-a/mcp" {
		t.Errorf("path-insertion resource: %v", m)
	}
	if w := do(a, "GET", "/.well-known/oauth-protected-resource/Bad_Name", nil, ""); w.Code != 404 {
		t.Errorf("bad resource path: %d", w.Code)
	}
	if w := do(a, "DELETE", "/token", nil, ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("405: %d", w.Code)
	}
	if w := do(a, "GET", "/health", nil, ""); w.Code != 200 || w.Body.String() != "OK" {
		t.Errorf("health: %d", w.Code)
	}
	if w := do(a, "POST", "/introspect", nil, ""); w.Code != 401 {
		t.Errorf("introspect without secret: %d", w.Code)
	}
	b, _ := newApp(t, func(c *Config) { c.IntrospectSecret = "" })
	if w := do(b, "POST", "/introspect", nil, ""); w.Code != 503 {
		t.Errorf("introspect disabled: %d", w.Code)
	}
}

func TestClientSecretAuthentication(t *testing.T) {
	a, _ := newApp(t, nil)
	cl := register(t, a, `{"redirect_uris":["http://localhost/cb"],"token_endpoint_auth_method":"client_secret_basic"}`)
	cid, sec := cl["client_id"].(string), cl["client_secret"].(string)
	req := func(h map[string]string, body string) int {
		return do(a, "POST", "/token", h, body).Code
	}
	basic := func(id, s string) map[string]string {
		return map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+s))}
	}
	if c := req(basic(cid, sec), "grant_type=bogus"); c != 400 {
		t.Errorf("valid secret reaches the grant check: %d", c)
	}
	if c := req(basic(cid, "wrong"), "grant_type=bogus"); c != 401 {
		t.Errorf("wrong secret: %d", c)
	}
	if c := req(map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic ***"}, ""); c != 401 {
		t.Errorf("garbage basic header: %d", c)
	}
	if c := req(formH, "client_id="+cid+"&grant_type=bogus"); c != 401 {
		t.Errorf("a confidential client needs its secret: %d", c)
	}
}
