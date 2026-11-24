// Package mcpoauth is the Go port of infra-sec_mcp-oauth (Flask): the MCP OAuth 2.1 authorization server
// (RFC 8414/9728 discovery, RFC 7591 registration, PKCE S256 authorization code + refresh rotation, RFC 7662
// introspection). Same routes, same answers, same sqlite file; see the Python main.py for the contract.
package mcpoauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"mcp-oauth/fleetauth"
)

const (
	accessPrefix  = "mcpat_"
	refreshPrefix = "mcprt_"
)

var (
	svcRE      = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,62}\n?$`) // Python's $ also matches before a final newline
	challengeR = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	verifierR  = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

// Config is the service configuration (the module-level constants of the Python service).
type Config struct {
	Issuer, AuthorizeBase, DBPath, IntrospectSecret, FormSecret string
	AllowedUsers, Scopes, AllowedRedirects                      []string
	AccessTTL, RefreshTTL, CodeTTL, MaxClients                  int64
	// Test seams.
	Clock func() float64
	Rand  func(n int) []byte
	Log   *slog.Logger
}

func cryptoBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// FromEnv reads the same environment variables as the Python service.
func FromEnv(get func(string) (string, bool)) (Config, error) {
	env := func(k, def string) string {
		if v, ok := get(k); ok {
			return v
		}
		return def
	}
	num := func(k, def string) (int64, error) {
		i, e := fleetauth.PyInt(fleetauth.S(env(k, def)))
		if e != fleetauth.IntOK || !i.IsInt64() {
			return 0, fmt.Errorf("%s is not an integer", k)
		}
		return i.Int64(), nil
	}
	c := Config{}
	c.Issuer = strings.TrimRight(env("ISSUER", "https://mcp.diegonmarcos.com"), "/")
	c.AuthorizeBase = strings.TrimRight(env("AUTHORIZE_BASE", c.Issuer), "/")
	c.DBPath = env("DB_PATH", "/data/mcp-oauth.sqlite3")
	c.IntrospectSecret = env("INTROSPECT_SECRET", "")
	c.FormSecret = env("FORM_SECRET", "")
	c.AllowedUsers = fleetauth.PyFields(strings.ReplaceAll(env("ALLOWED_USERS", ""), ",", " "))
	c.Scopes = fleetauth.PyFields(env("SCOPES", "mcp"))
	c.AllowedRedirects = fleetauth.PyFields(env("ALLOWED_REDIRECTS", "https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback"))
	var err error
	if c.AccessTTL, err = num("ACCESS_TTL", "3600"); err != nil {
		return c, err
	}
	if c.RefreshTTL, err = num("REFRESH_TTL", fmt.Sprint(30*86400)); err != nil {
		return c, err
	}
	if c.CodeTTL, err = num("CODE_TTL", "300"); err != nil {
		return c, err
	}
	if c.MaxClients, err = num("MAX_CLIENTS", "200"); err != nil {
		return c, err
	}
	return c, nil
}

// App is the running service.
type App struct {
	cfg   Config
	st    *store
	clock func() float64
	rnd   func(int) []byte
	log   *slog.Logger
	mux   *fleetauth.Mux
}

// New builds the service. The sqlite file is opened on first use (or by /health), like the original.
func New(cfg Config) (*App, error) {
	a := &App{cfg: cfg, st: &store{path: cfg.DBPath}, clock: cfg.Clock, rnd: cfg.Rand, log: cfg.Log}
	if a.clock == nil {
		a.clock = func() float64 { return float64(time.Now().UnixNano()) / 1e9 }
	}
	if a.rnd == nil {
		a.rnd = cryptoBytes
	}
	if a.log == nil {
		a.log = slog.Default()
	}
	if a.cfg.FormSecret == "" {
		a.cfg.FormSecret = hex.EncodeToString(a.rnd(32))
	}
	if a.cfg.Scopes == nil {
		a.cfg.Scopes = []string{}
	}
	a.routes()
	return a, nil
}

// Close releases the database.
func (a *App) Close() { a.st.close() }

// Handler is the http.Handler.
func (a *App) Handler() http.Handler { return a.mux }

func (a *App) now() int64 { return int64(a.clock()) }

func h(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func (a *App) tokenHex(n int) string { return hex.EncodeToString(a.rnd(n)) }

func (a *App) tokenURLSafe(n int) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(a.rnd(n)), "=")
}

func (a *App) gc() {
	t := a.now()
	a.st.exec("DELETE FROM codes WHERE expires < ?", t)
	a.st.exec("DELETE FROM tokens WHERE expires < ?", t)
}

func oauthError(err, desc string, status int) *fleetauth.Reply {
	return fleetauth.JSONReply(status, map[string]any{"error": err, "error_description": desc}).Add("Cache-Control", "no-store")
}

func jsonNoStore(v any, status int) *fleetauth.Reply {
	return fleetauth.JSONReply(status, v).Add("Cache-Control", "no-store")
}

func (a *App) allowed(uri string) bool {
	for _, x := range a.cfg.AllowedRedirects {
		if x == uri {
			return true
		}
	}
	return false
}

func (a *App) redirectAllowed(uri fleetauth.Value) bool {
	if uri.K != fleetauth.Str || fleetauth.CPLen(uri.S) > 512 {
		return false
	}
	u, err := pyURLSplit(uri.S)
	if err != nil || !u.portOK() {
		return false
	}
	if u.fragment != "" {
		return false
	}
	if u.scheme == "http" {
		switch u.hostname() {
		case "localhost", "127.0.0.1", "::1":
			return true
		}
	}
	return a.allowed(uri.S)
}

func (a *App) redirectAllowedStr(uri string) bool { return a.redirectAllowed(fleetauth.S(uri)) }

func (a *App) resourceFor(svc string) string {
	if svc != "" {
		return a.cfg.Issuer + "/" + svc
	}
	return a.cfg.Issuer
}

func (a *App) asMetadata() map[string]any {
	return map[string]any{
		"issuer": a.cfg.Issuer, "authorization_endpoint": a.cfg.AuthorizeBase + "/authorize",
		"token_endpoint": a.cfg.Issuer + "/token", "registration_endpoint": a.cfg.Issuer + "/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none", "client_secret_post", "client_secret_basic"},
		"scopes_supported":                      a.cfg.Scopes,
	}
}

func (a *App) routes() {
	m := &fleetauth.Mux{}
	m.OnPanic = func(e any) { a.log.Error(fmt.Sprintf("Exception on request: %v", e)) }
	as := func(*http.Request, map[string]string) *fleetauth.Reply {
		return fleetauth.JSONReply(200, a.asMetadata())
	}
	m.Handle("/.well-known/oauth-authorization-server", as, "GET")
	m.Handle("/.well-known/oauth-authorization-server/<svc>", as, "GET")
	m.Handle("/.well-known/openid-configuration", as, "GET")
	m.Handle("/<svc>/.well-known/oauth-authorization-server", as, "GET")
	m.Handle("/.well-known/oauth-protected-resource", a.protectedResource, "GET")
	m.Handle("/.well-known/oauth-protected-resource/<path:svc>", a.protectedResource, "GET")
	m.Handle("/<svc>/.well-known/oauth-protected-resource", a.protectedResource, "GET")
	m.Handle("/register", a.register, "POST")
	m.Handle("/<svc>/register", a.register, "POST")
	m.Handle("/authorize", a.authorizeGet, "GET")
	m.Handle("/<svc>/authorize", a.authorizeGet, "GET")
	m.Handle("/authorize", a.authorizePost, "POST")
	m.Handle("/<svc>/authorize", a.authorizePost, "POST")
	m.Handle("/token", a.token, "POST")
	m.Handle("/<svc>/token", a.token, "POST")
	m.Handle("/introspect", a.introspect, "POST")
	m.Handle("/revoke", a.revoke, "POST")
	m.Handle("/health", a.health, "GET")
	a.mux = m
}

func (a *App) protectedResource(_ *http.Request, args map[string]string) *fleetauth.Reply {
	svc := args["svc"]
	if svc != "" {
		for _, p := range strings.Split(svc, "/") {
			if !svcRE.MatchString(p) {
				return oauthError("invalid_request", "bad resource path", 404)
			}
		}
	}
	return fleetauth.JSONReply(200, map[string]any{
		"resource": a.resourceFor(svc), "authorization_servers": []string{a.cfg.Issuer},
		"bearer_methods_supported": []string{"header"}, "scopes_supported": a.cfg.Scopes,
	})
}

func (a *App) register(r *http.Request, _ map[string]string) *fleetauth.Reply {
	body := fleetauth.JSONValue(r)
	if body.K != fleetauth.Obj {
		return oauthError("invalid_client_metadata", "JSON body required", 400)
	}
	get := func(k string, def fleetauth.Value) fleetauth.Value {
		if v, ok := body.O.Get(k); ok {
			return v
		}
		return def
	}
	uris := get("redirect_uris", fleetauth.Value{})
	if uris.K != fleetauth.List || len(uris.L) == 0 || len(uris.L) > 10 {
		return oauthError("invalid_redirect_uri", "redirect_uris required (1..10)", 400)
	}
	for _, u := range uris.L {
		if !a.redirectAllowed(u) {
			return oauthError("invalid_redirect_uri", "redirect_uri not allowed: claude.ai/claude.com callback or localhost only", 400)
		}
	}
	mv := get("token_endpoint_auth_method", fleetauth.S("none"))
	method := ""
	if mv.K == fleetauth.Str {
		method = mv.S
	}
	if mv.K != fleetauth.Str || (method != "none" && method != "client_secret_post" && method != "client_secret_basic") {
		return oauthError("invalid_client_metadata", "unsupported token_endpoint_auth_method", 400)
	}
	gts := get("grant_types", fleetauth.Value{K: fleetauth.List, L: []fleetauth.Value{fleetauth.S("authorization_code"), fleetauth.S("refresh_token")}})
	if gts.K != fleetauth.List {
		return oauthError("invalid_client_metadata", "unsupported grant_types", 400)
	}
	for _, g := range gts.L {
		if g.K == fleetauth.List || g.K == fleetauth.Obj {
			panic("TypeError: unhashable type") // set(gts)
		}
	}
	for _, g := range gts.L {
		if g.K != fleetauth.Str || (g.S != "authorization_code" && g.S != "refresh_token") {
			return oauthError("invalid_client_metadata", "unsupported grant_types", 400)
		}
	}
	rts := get("response_types", fleetauth.Value{K: fleetauth.List, L: []fleetauth.Value{fleetauth.S("code")}})
	if !fleetauth.Equal(rts, fleetauth.Value{K: fleetauth.List, L: []fleetauth.Value{fleetauth.S("code")}}) {
		return oauthError("invalid_client_metadata", "response_types must be [code]", 400)
	}
	name := fleetauth.CPHead(fleetauth.PyStr(get("client_name", fleetauth.S(""))), 100)

	a.gc()
	count := a.clientCount()
	if count >= a.cfg.MaxClients {
		// Evict the oldest client that holds no live tokens.
		a.st.exec("DELETE FROM clients WHERE client_id IN (SELECT c.client_id FROM clients c " +
			"WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id=c.client_id) " +
			"ORDER BY c.created LIMIT 1)")
		if a.clientCount() >= a.cfg.MaxClients {
			return oauthError("temporarily_unavailable", "client registry full", 503)
		}
	}
	cid := "mcpc_" + a.tokenURLSafe(16)
	var secret any
	secretStr := ""
	if method != "none" {
		secretStr = a.tokenURLSafe(32)
		secret = h(secretStr)
	}
	t := a.now()
	a.st.exec("INSERT INTO clients VALUES (?,?,?,?,?,?)", cid, secret, fleetauth.DumpJSON(uris), name, method, t)
	out := map[string]any{
		"client_id": cid, "client_id_issued_at": t, "redirect_uris": uris, "token_endpoint_auth_method": method,
		"grant_types": gts, "response_types": []string{"code"}, "client_name": name,
	}
	if method != "none" {
		out["client_secret"] = secretStr
		out["client_secret_expires_at"] = 0
	}
	a.log.Info("registered client " + cid)
	return jsonNoStore(out, 201)
}

func (a *App) clientCount() int64 {
	var n int64
	a.st.row("SELECT COUNT(*) FROM clients", []any{&n})
	return n
}

func (a *App) scopeSubset(want, have []string) bool {
	set := map[string]bool{}
	for _, s := range have {
		set[s] = true
	}
	for _, s := range want {
		if !set[s] {
			return false
		}
	}
	return true
}

type authzFields struct {
	clientID, redirectURI, state, challenge, scope, resource, sub, clientName string
}

func (a *App) userOf(r *http.Request) string {
	return fleetauth.PyStrip(fleetauth.Hdr(r, "Remote-User"))
}

func (a *App) userAllowed(user string) bool {
	if len(a.cfg.AllowedUsers) == 0 {
		return true
	}
	for _, u := range a.cfg.AllowedUsers {
		if u == user {
			return true
		}
	}
	return false
}

func (a *App) authzCheck(r *http.Request) (*authzFields, *fleetauth.Reply) {
	params := fleetauth.QueryForm(r)
	user := a.userOf(r)
	if user == "" {
		// Caddy's Authelia forward_auth should have stopped this already.
		return nil, fleetauth.HTMLReply(401, "Authelia session required")
	}
	if !a.userAllowed(user) {
		return nil, fleetauth.HTMLReply(403, "User not allowed")
	}
	cid := params.Get("client_id", "")
	var uris string
	var cname *string
	if !a.st.row("SELECT redirect_uris, client_name FROM clients WHERE client_id=?", []any{&uris, &cname}, cid) {
		return nil, fleetauth.HTMLReply(400, "Unknown client_id")
	}
	ruri := params.Get("redirect_uri", "")
	v, err := fleetauth.ParseJSON([]byte(uris))
	if err != nil {
		panic(err)
	}
	registered := v.L
	if ruri == "" && len(registered) == 1 {
		ruri = registered[0].S
	}
	in := false
	for _, x := range registered {
		if x.K == fleetauth.Str && x.S == ruri {
			in = true
		}
	}
	if !in || !a.redirectAllowedStr(ruri) {
		// Never redirect to an unverified URI (RFC 6749 s4.1.2.1).
		return nil, fleetauth.HTMLReply(400, "redirect_uri mismatch")
	}
	back := func(e, desc string) (*authzFields, *fleetauth.Reply) {
		qs := [][2]string{{"error", e}, {"error_description", desc}}
		if s := params.Get("state", ""); s != "" {
			qs = append(qs, [2]string{"state", s})
		}
		sep := "?"
		if strings.Contains(ruri, "?") {
			sep = "&"
		}
		return nil, fleetauth.HTMLReply(302, "").Add("Location", ruri+sep+fleetauth.URLEncode(qs...))
	}
	if params.Get("response_type", "") != "code" {
		return back("unsupported_response_type", "response_type must be code")
	}
	if params.Get("code_challenge_method", "") != "S256" {
		return back("invalid_request", "PKCE S256 required")
	}
	cc := params.Get("code_challenge", "")
	if !challengeR.MatchString(cc) {
		return back("invalid_request", "bad code_challenge")
	}
	scope := params.Get("scope", "")
	if scope == "" {
		scope = strings.Join(a.cfg.Scopes, " ")
	}
	if !a.scopeSubset(fleetauth.PyFields(scope), a.cfg.Scopes) {
		return back("invalid_scope", "unsupported scope")
	}
	f := &authzFields{clientID: cid, redirectURI: ruri, state: params.Get("state", ""), challenge: cc, scope: scope,
		resource: params.Get("resource", ""), sub: user, clientName: cid}
	if cname != nil && *cname != "" {
		f.clientName = *cname
	}
	return f, nil
}

// formSig is HMAC-SHA256(FORM_SECRET, json.dumps(fields, sort_keys=True)).
func (a *App) formSig(f *authzFields, exp *big.Int) string {
	pairs := [][2]any{
		{"client_id", f.clientID}, {"client_name", f.clientName}, {"code_challenge", f.challenge}, {"exp", exp},
		{"redirect_uri", f.redirectURI}, {"resource", f.resource}, {"scope", f.scope}, {"state", f.state}, {"sub", f.sub},
	}
	o := &fleetauth.Object{M: map[string]fleetauth.Value{}}
	for _, p := range pairs {
		o.Keys = append(o.Keys, p[0].(string))
		switch x := p[1].(type) {
		case string:
			o.M[p[0].(string)] = fleetauth.S(x)
		case *big.Int:
			o.M[p[0].(string)] = fleetauth.Value{K: fleetauth.Int, I: x}
		}
	}
	m := hmac.New(sha256.New, []byte(a.cfg.FormSecret))
	m.Write([]byte(fleetauth.DumpJSON(fleetauth.ObjV(o))))
	return hex.EncodeToString(m.Sum(nil))
}

// pyEscape is html.escape(s) with quote=True.
func pyEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;").Replace(s)
}

func (a *App) authorizeGet(r *http.Request, _ map[string]string) *fleetauth.Reply {
	f, rep := a.authzCheck(r)
	if rep != nil {
		return rep
	}
	exp := big.NewInt(a.now() + a.cfg.CodeTTL)
	sig := a.formSig(f, exp)
	hidden := ""
	for _, kv := range [][2]string{{"client_id", f.clientID}, {"redirect_uri", f.redirectURI}, {"state", f.state},
		{"code_challenge", f.challenge}, {"scope", f.scope}, {"resource", f.resource}, {"sub", f.sub},
		{"client_name", f.clientName}, {"exp", exp.String()}} {
		hidden += `<input type="hidden" name="` + kv[0] + `" value="` + pyEscape(kv[1]) + `">`
	}
	res := f.resource
	if res == "" {
		res = a.cfg.Issuer
	}
	su, err := pyURLSplit(a.cfg.AuthorizeBase)
	if err != nil {
		panic(err)
	}
	page := `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP client</title>
<style>body{font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}button{padding:.6rem 1.2rem;margin-right:.5rem}</style>
</head><body><h1>Authorize MCP access</h1>
<p><b>` + pyEscape(f.clientName) + `</b> wants access to <code>` + pyEscape(res) + `</code>
as <b>` + pyEscape(f.sub) + `</b> (scope: ` + pyEscape(f.scope) + `).</p>
<p>It will be redirected to <code>` + pyEscape(f.redirectURI) + `</code>.</p>
<form method="post" action="` + pyEscape(su.path) + `/authorize">` + hidden + `<input type="hidden" name="sig" value="` + sig + `">
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>
</body></html>`
	return fleetauth.HTMLReply(200, page).
		Add("Cache-Control", "no-store").
		Add("X-Frame-Options", "DENY").
		Add("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
}

func (a *App) authorizePost(r *http.Request, _ map[string]string) *fleetauth.Reply {
	user := a.userOf(r)
	if user == "" {
		return fleetauth.HTMLReply(401, "Authelia session required")
	}
	f := fleetauth.PostForm(r)
	af := &authzFields{clientID: f.Get("client_id", ""), redirectURI: f.Get("redirect_uri", ""), state: f.Get("state", ""),
		challenge: f.Get("code_challenge", ""), scope: f.Get("scope", ""), resource: f.Get("resource", ""),
		sub: f.Get("sub", ""), clientName: f.Get("client_name", "")}
	exp, ie := fleetauth.PyInt(fleetauth.S(f.Get("exp", "0")))
	if ie != fleetauth.IntOK {
		return fleetauth.HTMLReply(400, "bad form")
	}
	if !fleetauth.CompareDigest(a.formSig(af, exp), f.Get("sig", "")) {
		return fleetauth.HTMLReply(400, "bad form signature")
	}
	if exp.Cmp(big.NewInt(a.now())) < 0 {
		return fleetauth.HTMLReply(400, "consent expired, start again")
	}
	if af.sub != user || !a.userAllowed(user) {
		return fleetauth.HTMLReply(403, "session user changed")
	}
	ruri := af.redirectURI
	sep := "?"
	if strings.Contains(ruri, "?") {
		sep = "&"
	}
	var qs [][2]string
	if af.state != "" {
		qs = append(qs, [2]string{"state", af.state})
	}
	if f.Get("decision", "") != "approve" {
		qs = append(qs, [2]string{"error", "access_denied"})
		return fleetauth.HTMLReply(302, "").Add("Location", ruri+sep+fleetauth.URLEncode(qs...))
	}
	code := a.tokenURLSafe(32)
	a.st.exec("INSERT INTO codes VALUES (?,?,?,?,?,?,?,?)", h(code), af.clientID, ruri, af.challenge, user, af.scope, af.resource, a.now()+a.cfg.CodeTTL)
	qs = append([][2]string{{"code", code}}, qs...)
	qs = append(qs, [2]string{"iss", a.cfg.Issuer})
	a.log.Info("code issued client=" + af.clientID + " sub=" + user)
	return fleetauth.HTMLReply(302, "").Add("Location", ruri+sep+fleetauth.URLEncode(qs...))
}

// clientAuth supports none / post / basic. Returns the client id or the error reply.
func (a *App) clientAuth(r *http.Request, f fleetauth.Form) (string, *fleetauth.Reply) {
	cid, csec := f.Get("client_id", ""), f.Get("client_secret", "")
	if ah := fleetauth.Hdr(r, "Authorization"); strings.HasPrefix(ah, "Basic ") {
		bad := oauthError("invalid_client", "bad basic auth", 401)
		enc := ah[6:]
		for _, c := range fleetauth.CodePoints(enc) {
			if c > 127 {
				return "", bad
			}
		}
		raw, err := fleetauth.B64StdDecode([]byte(enc))
		if err != nil || !utf8.Valid(raw) || !strings.Contains(string(raw), ":") {
			return "", bad
		}
		cid, csec, _ = strings.Cut(string(raw), ":")
	}
	if cid == "" {
		return "", oauthError("invalid_client", "client_id required", 401)
	}
	var id string
	var sh *string
	var method string
	if !a.st.row("SELECT client_id, secret_hash, auth_method FROM clients WHERE client_id=?", []any{&id, &sh, &method}, cid) {
		return "", oauthError("invalid_client", "unknown client", 401)
	}
	if method != "none" {
		want := ""
		if sh != nil {
			want = *sh
		}
		if csec == "" || !hmac.Equal([]byte(h(csec)), []byte(want)) {
			return "", oauthError("invalid_client", "bad client secret", 401)
		}
	}
	return id, nil
}

func (a *App) mintPair(clientID, sub string, scope, resource *string, family string) *fleetauth.Reply {
	if family == "" {
		family = a.tokenHex(16)
	}
	at := accessPrefix + a.tokenURLSafe(32)
	rt := refreshPrefix + a.tokenURLSafe(32)
	t := a.now()
	a.st.exec("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?)", h(at), "access", clientID, sub, scope, resource, t+a.cfg.AccessTTL, family)
	a.st.exec("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?)", h(rt), "refresh", clientID, sub, scope, resource, t+a.cfg.RefreshTTL, family)
	var sc any
	if scope != nil {
		sc = *scope
	}
	return jsonNoStore(map[string]any{"access_token": at, "token_type": "Bearer", "expires_in": a.cfg.AccessTTL,
		"refresh_token": rt, "scope": sc}, 200)
}

func pkceOK(verifier, challenge string) bool {
	if !verifierR.MatchString(verifier) {
		return false
	}
	d := sha256.Sum256([]byte(verifier))
	return hmac.Equal([]byte(strings.TrimRight(base64.URLEncoding.EncodeToString(d[:]), "=")), []byte(challenge))
}

func (a *App) token(r *http.Request, _ map[string]string) *fleetauth.Reply {
	f := fleetauth.PostForm(r)
	cid, rep := a.clientAuth(r, f)
	if rep != nil {
		return rep
	}
	switch f.Get("grant_type", "\x00") {
	case "authorization_code":
		code := f.Get("code", "")
		var cclient, ruri, challenge, sub string
		var scope, resource *string
		var expires int64
		var found bool
		a.st.locked(func(db sqlDB) { // single-use: read + delete atomically
			found = scanRow(db.QueryRow("SELECT client_id, redirect_uri, challenge, sub, scope, resource, expires FROM codes WHERE code_hash=?", h(code)),
				&cclient, &ruri, &challenge, &sub, &scope, &resource, &expires)
			if found {
				if _, err := db.Exec("DELETE FROM codes WHERE code_hash=?", h(code)); err != nil {
					panic(err)
				}
			}
		})
		if !found || expires < a.now() {
			return oauthError("invalid_grant", "unknown or expired code", 400)
		}
		if cclient != cid {
			return oauthError("invalid_grant", "code was issued to another client", 400)
		}
		if f.Get("redirect_uri", ruri) != ruri {
			return oauthError("invalid_grant", "redirect_uri mismatch", 400)
		}
		if !pkceOK(f.Get("code_verifier", ""), challenge) {
			return oauthError("invalid_grant", "PKCE verification failed", 400)
		}
		res := resource
		if v := f.Get("resource", ""); v != "" {
			res = &v
		}
		return a.mintPair(cid, sub, scope, res, "")
	case "refresh_token":
		rt := f.Get("refresh_token", "")
		var cclient, sub, family string
		var scope, resource *string
		var expires int64
		var found bool
		a.st.locked(func(db sqlDB) {
			found = scanRow(db.QueryRow("SELECT client_id, sub, scope, resource, expires, family FROM tokens WHERE token_hash=? AND kind='refresh'", h(rt)),
				&cclient, &sub, &scope, &resource, &expires, &family)
			if found { // rotation: the old refresh token dies now
				if _, err := db.Exec("DELETE FROM tokens WHERE token_hash=?", h(rt)); err != nil {
					panic(err)
				}
			}
		})
		if !found || expires < a.now() {
			return oauthError("invalid_grant", "unknown or expired refresh_token", 400)
		}
		if cclient != cid {
			return oauthError("invalid_grant", "refresh_token was issued to another client", 400)
		}
		orig := ""
		if scope != nil {
			orig = *scope
		}
		sc := f.Get("scope", "")
		if sc == "" {
			sc = orig
		}
		if !a.scopeSubset(fleetauth.PyFields(sc), fleetauth.PyFields(orig)) {
			return oauthError("invalid_scope", "scope exceeds original grant", 400)
		}
		// Old access tokens of the family are revoked along with the old refresh.
		a.st.exec("DELETE FROM tokens WHERE family=? AND kind='access'", family)
		return a.mintPair(cid, sub, &sc, resource, family)
	}
	return oauthError("unsupported_grant_type", "authorization_code or refresh_token", 400)
}

func (a *App) introspect(r *http.Request, _ map[string]string) *fleetauth.Reply {
	if a.cfg.IntrospectSecret == "" {
		return oauthError("server_error", "introspection disabled (INTROSPECT_SECRET unset)", 503)
	}
	if !fleetauth.CompareDigest(fleetauth.Hdr(r, "X-Introspect-Secret"), a.cfg.IntrospectSecret) {
		return oauthError("invalid_client", "bad introspection secret", 401)
	}
	tok := fleetauth.PostForm(r).Get("token", "")
	if v := a.lookupAccess(tok); v != nil {
		return jsonNoStore(v, 200)
	}
	return jsonNoStore(map[string]any{"active": false}, 200)
}

func (a *App) lookupAccess(tok string) map[string]any {
	if !strings.HasPrefix(tok, accessPrefix) {
		return nil
	}
	var cid, sub string
	var scope, resource *string
	var expires int64
	if !a.st.row("SELECT client_id, sub, scope, resource, expires FROM tokens WHERE token_hash=? AND kind='access'",
		[]any{&cid, &sub, &scope, &resource, &expires}, h(tok)) || expires < a.now() {
		return nil
	}
	var sc any
	if scope != nil {
		sc = *scope
	}
	aud := a.cfg.Issuer
	if resource != nil && *resource != "" {
		aud = *resource
	}
	return map[string]any{"active": true, "client_id": cid, "sub": sub, "username": sub, "scope": sc, "aud": aud,
		"exp": expires, "iss": a.cfg.Issuer, "token_type": "Bearer"}
}

func (a *App) revoke(r *http.Request, _ map[string]string) *fleetauth.Reply {
	a.st.exec("DELETE FROM tokens WHERE token_hash=?", h(fleetauth.PostForm(r).Get("token", "")))
	return fleetauth.HTMLReply(200, "")
}

func (a *App) health(*http.Request, map[string]string) *fleetauth.Reply {
	a.st.locked(func(sqlDB) {})
	return fleetauth.HTMLReply(200, "OK")
}
