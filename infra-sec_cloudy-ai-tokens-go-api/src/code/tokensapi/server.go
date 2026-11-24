// Package tokensapi is the Go port of infra-sec_cloudy-ai-tokens-api (Flask): the fleet token engine. Same
// routes, same answers, same sqlite file and ciphertext format; see the Python main.py for the contract.
package tokensapi

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/big"
	"net/http"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
	"time"

	"tokens-api/fleetauth"
)

const (
	prefix     = "ft_"
	adminScope = "tokens:admin"
)

var (
	scopeRE = regexp.MustCompile(`^[A-Za-z0-9:._*/-]{1,64}$`)
	audRE   = regexp.MustCompile(`^[A-Za-z0-9.*_-]{1,128}$`)
)

// Introspect asks the fleet's introspect-proxy whether a bearer JWT is valid: (status, client_id).
type Introspect func(token string) (int, string)

// Config is the service configuration (the Python cfg dict).
type Config struct {
	DBPath, FleetKey, VerifySecret, OwnerEmail string
	AdminClientIDs, TrustedProxies             string
	IntrospectURL                              string
	IntrospectTimeout                          time.Duration
	// Test seams: a clock, a byte source for ids and values, an introspection function.
	Clock      func() float64
	Rand       func(n int) []byte
	Introspect Introspect
	Log        *slog.Logger
}

// FromEnv reads the same environment variables as the Python service.
func FromEnv(get func(string) (string, bool)) (Config, error) {
	env := func(k, def string) string {
		if v, ok := get(k); ok {
			return v
		}
		return def
	}
	t, err := strconv.ParseFloat(strings.TrimSpace(env("INTROSPECT_TIMEOUT", "3")), 64)
	if err != nil {
		return Config{}, fmt.Errorf("INTROSPECT_TIMEOUT: %w", err)
	}
	return Config{
		DBPath: env("DB_PATH", "/data/tokens.sqlite3"), FleetKey: env("TOKENS_FLEET_KEY", ""),
		VerifySecret: env("TOKENS_VERIFY_SECRET", ""), OwnerEmail: env("OWNER_EMAIL", ""),
		AdminClientIDs: env("ADMIN_CLIENT_IDS", "cloud-admin"), TrustedProxies: env("TRUSTED_PROXIES", ""),
		IntrospectURL: env("INTROSPECT_URL", "http://10.0.0.1:4182/auth"), IntrospectTimeout: time.Duration(t * float64(time.Second)),
	}, nil
}

// App is the running service.
type App struct {
	cfg        Config
	vault      *Vault
	store      *Store
	admins     map[string]bool
	proxies    []netip.Prefix
	introspect Introspect
	clock      func() float64
	rnd        func(int) []byte
	log        *slog.Logger
	mux        *fleetauth.Mux
}

func cryptoBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

// New builds the service (create_app).
func New(cfg Config) (*App, error) {
	if cfg.VerifySecret == "" {
		return nil, errors.New("TOKENS_VERIFY_SECRET is required")
	}
	a := &App{cfg: cfg, admins: map[string]bool{}, log: cfg.Log}
	if a.log == nil {
		a.log = slog.Default()
	}
	var err error
	if a.vault, err = NewVault(cfg.FleetKey); err != nil {
		return nil, err
	}
	a.clock = cfg.Clock
	if a.clock == nil {
		a.clock = func() float64 { return float64(time.Now().UnixNano()) / 1e9 }
	}
	a.rnd = cfg.Rand
	if a.rnd == nil {
		a.rnd = cryptoBytes
	}
	if a.store, err = OpenStore(cfg.DBPath, a.vault, a.rnd, func() int64 { return int64(a.clock()) }); err != nil {
		return nil, err
	}
	for _, c := range strings.Split(strings.ReplaceAll(cfg.AdminClientIDs, " ", ","), ",") {
		if c = fleetauth.PyStrip(c); c != "" {
			a.admins[c] = true
		}
	}
	for _, p := range strings.Split(cfg.TrustedProxies, ",") {
		if p = fleetauth.PyStrip(p); p == "" {
			continue
		}
		pf, err := netip.ParsePrefix(p)
		if err != nil {
			ad, err2 := netip.ParseAddr(p)
			if err2 != nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q does not appear to be an IPv4 or IPv6 network", p)
			}
			pf = netip.PrefixFrom(ad, ad.BitLen())
		}
		a.proxies = append(a.proxies, pf.Masked())
	}
	a.introspect = cfg.Introspect
	if a.introspect == nil {
		a.introspect = a.defaultIntrospect(cfg.IntrospectURL, cfg.IntrospectTimeout)
	}
	a.routes()
	return a, nil
}

// Close releases the database.
func (a *App) Close() error { return a.store.Close() }

// Handler is the http.Handler.
func (a *App) Handler() http.Handler { return a.mux }

func (a *App) defaultIntrospect(url string, timeout time.Duration) Introspect {
	cl := &http.Client{Timeout: timeout}
	return func(token string) (int, string) {
		lat, ok := fleetauth.StrToLatin1(token)
		if !ok {
			a.log.Error("introspect unreachable: UnicodeEncodeError")
			return 503, ""
		}
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			a.log.Error("introspect unreachable: ValueError")
			return 503, ""
		}
		req.Header.Set("Authorization", "Bearer "+lat)
		resp, err := cl.Do(req)
		if err != nil {
			a.log.Error("introspect unreachable: URLError")
			return 503, ""
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			return resp.StatusCode, ""
		}
		return resp.StatusCode, fleetauth.Latin1ToStr(resp.Header.Get("X-Auth-User"))
	}
}

func deny(code int, msg string) *fleetauth.Reply {
	return fleetauth.JSONReply(code, map[string]any{"error": msg})
}

func (a *App) now() int64 { return int64(a.clock()) }

func statusOf(r *Row, now int64) string {
	if r.RevokedAt.Valid {
		return "revoked"
	}
	if r.ExpiresAt.Valid && r.ExpiresAt.Int64 <= now {
		return "expired"
	}
	return "active"
}

func ni(v int64, ok bool) any {
	if !ok {
		return nil
	}
	return v
}

func scopesValue(s string) fleetauth.Value {
	v, err := fleetauth.ParseJSON([]byte(s))
	if err != nil {
		panic(err)
	}
	return v
}

// public is metadata only: the value and its ciphertext never leave through here.
func public(r *Row, now int64) map[string]any {
	return map[string]any{
		"id": r.ID, "name": r.Name, "kind": r.Kind, "audience": r.Audience, "scopes": scopesValue(r.Scopes),
		"subject": r.Subject, "status": statusOf(r, now), "created_at": r.CreatedAt,
		"expires_at": ni(r.ExpiresAt.Int64, r.ExpiresAt.Valid), "revoked_at": ni(r.RevokedAt.Int64, r.RevokedAt.Valid),
		"last_used_at": ni(r.LastUsedAt.Int64, r.LastUsedAt.Valid), "created_by": r.CreatedBy, "source": r.Source,
		"hint": r.Hint,
	}
}

func audienceOK(audience, host string) bool {
	if host == "" || fleetauth.PyStrip(audience) == "" || fleetauth.PyStrip(audience) == "*" {
		return true
	}
	host = strings.ToLower(strings.SplitN(host, ":", 2)[0])
	for _, g := range strings.Split(audience, ",") {
		g = fleetauth.PyStrip(g)
		if g != "" && fnmatchCase(host, strings.ToLower(g)) {
			return true
		}
	}
	return false
}

// fnmatchCase is fnmatch.fnmatchcase: * ? [seq] [!seq].
func fnmatchCase(name, pat string) bool {
	n, p := fleetauth.CodePoints(name), fleetauth.CodePoints(pat)
	re := strings.Builder{}
	re.WriteString("(?s)^")
	for i := 0; i < len(p); {
		c := p[i]
		i++
		switch c {
		case '*':
			re.WriteString(".*")
		case '?':
			re.WriteString(".")
		case '[':
			j := i
			if j < len(p) && p[j] == '!' {
				j++
			}
			if j < len(p) && p[j] == ']' {
				j++
			}
			for j < len(p) && p[j] != ']' {
				j++
			}
			if j >= len(p) {
				re.WriteString(`\[`)
			} else {
				set := string(p[i:j])
				i = j + 1
				set = strings.ReplaceAll(set, `\`, `\\`)
				if strings.HasPrefix(set, "!") {
					set = "^" + set[1:]
				} else if strings.HasPrefix(set, "^") {
					set = `\` + set
				}
				re.WriteString("[" + set + "]")
			}
		default:
			re.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	re.WriteString("$")
	rx, err := regexp.Compile(re.String())
	if err != nil {
		return false
	}
	return rx.MatchString(string(n))
}

type valueErr string

func (e valueErr) Error() string { return string(e) }

func normAudience(v fleetauth.Value, present bool) (string, error) {
	var items []string
	if present && v.K == fleetauth.List {
		for _, x := range v.L {
			items = append(items, fleetauth.PyStrip(fleetauth.PyStr(x)))
		}
	} else {
		s := "*"
		if present && v.K != fleetauth.Null {
			s = fleetauth.PyStr(v)
		}
		for _, x := range strings.Split(s, ",") {
			items = append(items, fleetauth.PyStrip(x))
		}
	}
	var kept []string
	for _, x := range items {
		if x != "" {
			kept = append(kept, x)
		}
	}
	if len(kept) == 0 {
		kept = []string{"*"}
	}
	ok := len(kept) <= 20
	for _, x := range kept {
		ok = ok && audRE.MatchString(x)
	}
	if !ok {
		return "", valueErr("audience must be host globs (letters, digits, . * _ -)")
	}
	return strings.Join(kept, ","), nil
}

func normScopes(v fleetauth.Value) ([]string, error) {
	var items []string
	if v.K == fleetauth.List {
		for _, x := range v.L {
			items = append(items, fleetauth.PyStrip(fleetauth.PyStr(x)))
		}
	} else {
		s := ""
		if v.Truthy() {
			s = fleetauth.PyStr(v)
		}
		items = fleetauth.PyFields(strings.ReplaceAll(s, ",", " "))
	}
	kept := []string{}
	for _, x := range items {
		if x != "" {
			kept = append(kept, x)
		}
	}
	ok := len(kept) <= 30
	for _, x := range kept {
		ok = ok && scopeRE.MatchString(x)
	}
	if !ok {
		return nil, valueErr("invalid scope")
	}
	return kept, nil
}

func scopesJSON(s []string) string {
	l := make([]fleetauth.Value, len(s))
	for i, x := range s {
		l[i] = fleetauth.S(x)
	}
	return fleetauth.DumpJSON(fleetauth.Value{K: fleetauth.List, L: l})
}

func getOr(o *fleetauth.Object, k string, def fleetauth.Value) fleetauth.Value {
	if v, ok := o.Get(k); ok {
		return v
	}
	return def
}

// intOfNumber is `int(exp) if isinstance(exp, (int, float)) else None` (bool counts as int; NaN and inf raise).
func intOfNumber(v fleetauth.Value) *big.Int {
	switch v.K {
	case fleetauth.Int, fleetauth.Bool, fleetauth.Float:
		i, e := fleetauth.PyInt(v)
		if e != fleetauth.IntOK {
			panic("int(): " + fleetauth.PyRepr(v))
		}
		return i
	}
	return nil
}

func (a *App) routes() {
	m := &fleetauth.Mux{After: func(r *fleetauth.Reply) { r.Add("Cache-Control", "no-store") }}
	m.OnPanic = func(e any) { a.log.Error(fmt.Sprintf("Exception on request: %v", e)) }
	m.Handle("/v1/verify", a.verify, "POST")
	m.Handle("/v1/tokens", a.listTokens, "GET")
	m.Handle("/v1/tokens", a.create, "POST")
	m.Handle("/v1/tokens/<token_id>", a.oneToken, "GET")
	m.Handle("/v1/tokens/import", a.importToken, "POST")
	m.Handle("/v1/tokens/<token_id>/reveal", a.reveal, "POST")
	m.Handle("/v1/tokens/<token_id>/revoke", a.revoke, "POST")
	m.Handle("/v1/audit", a.auditLog, "GET")
	m.Handle("/health", func(*http.Request, map[string]string) *fleetauth.Reply { return fleetauth.HTMLReply(200, "OK") }, "GET")
	a.mux = m
}

// ownerActor is (actor, nil) for the owner, ("", reply) otherwise. Fail closed.
func (a *App) ownerActor(r *http.Request) (string, *fleetauth.Reply) {
	now := a.now()
	h := fleetauth.Hdr(r, "Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		t := fleetauth.PyStrip(h[7:])
		if strings.HasPrefix(t, prefix) {
			row := a.store.ByIndex(t)
			if row != nil && statusOf(row, now) == "active" && scopeIn(row.Scopes, adminScope) {
				a.store.Touch(row.ID, now)
				return "token:" + row.ID, nil
			}
			return "", deny(403, "owner only")
		}
		status, client := a.introspect(t)
		if status == 200 && a.admins[client] {
			return "client:" + client, nil
		}
		if status == 503 {
			return "", deny(503, "auth unavailable")
		}
		if status == 401 || status == 0 {
			return "", deny(401, "owner only")
		}
		return "", deny(403, "owner only")
	}
	email := fleetauth.Hdr(r, "Remote-Email")
	if email != "" && a.cfg.OwnerEmail != "" && fleetauth.CompareDigest(strings.ToLower(email), strings.ToLower(a.cfg.OwnerEmail)) {
		if src, err := netip.ParseAddr(fleetauth.RemoteIP(r)); err == nil {
			for _, n := range a.proxies {
				if n.Contains(src) {
					return "session:" + strings.ToLower(email), nil
				}
			}
		}
	}
	return "", deny(401, "authentication required")
}

func scopeIn(scopesJSON, want string) bool {
	v := scopesValue(scopesJSON)
	for _, x := range v.L {
		if x.K == fleetauth.Str && x.S == want {
			return true
		}
	}
	return false
}

func (a *App) bodyOrPanic(r *http.Request) *fleetauth.Object {
	o, ok := fleetauth.JSONBody(r)
	if !ok {
		panic("AttributeError: object has no attribute 'get'")
	}
	return o
}

func str(o *fleetauth.Object, k string, def string) string {
	if v, ok := o.Get(k); ok {
		return fleetauth.PyStr(v)
	}
	return def
}

func (a *App) verify(r *http.Request, _ map[string]string) *fleetauth.Reply {
	if !fleetauth.CompareDigest(fleetauth.Hdr(r, "X-Verify-Secret"), a.cfg.VerifySecret) {
		return deny(403, "forbidden")
	}
	body := a.bodyOrPanic(r)
	token := str(body, "token", "")
	host := str(body, "host", "")
	if token == "" {
		return fleetauth.JSONReply(200, map[string]any{"active": false, "reason": "no token"})
	}
	now := a.now()
	row := a.store.ByIndex(token)
	if row == nil {
		adopt, _ := body.Get("adopt")
		if strings.HasPrefix(token, prefix) || adopt.K != fleetauth.Obj {
			return fleetauth.JSONReply(200, map[string]any{"active": false, "reason": "unknown"})
		}
		// A JWT the verifier already checked (signature, issuer, scope): register it so the owner sees it.
		exp := intOfNumber(getOr(adopt.O, "exp", fleetauth.Value{}))
		client := fleetauth.CPHead(str(adopt.O, "client_id", ""), 80)
		scp := getOr(adopt.O, "scp", fleetauth.Value{})
		var scpList []fleetauth.Value
		if scp.K == fleetauth.List {
			scpList = scp.L
		}
		sub := fleetauth.CPHead(str(adopt.O, "sub", ""), 120)
		func() {
			strs := make([]fleetauth.Value, len(scpList))
			for i, s := range scpList {
				strs[i] = fleetauth.S(fleetauth.PyStr(s))
			}
			scopes, err := normScopes(fleetauth.Value{K: fleetauth.List, L: strs})
			if err != nil {
				return
			}
			nm := client
			if nm == "" {
				nm = "authelia"
			}
			tid, err := a.store.Insert(nm+" (adopted)", "authelia", "*", scopesJSON(scopes), sub, exp, "verifier", "adopted", token)
			if err != nil {
				return
			}
			a.store.Audit("verifier", "adopt", tid, client, "")
		}()
		row = a.store.ByIndex(token)
		if row == nil {
			return fleetauth.JSONReply(200, map[string]any{"active": true, "known": false})
		}
	}
	if st := statusOf(row, now); st != "active" {
		return fleetauth.JSONReply(200, map[string]any{"active": false, "reason": st, "id": row.ID})
	}
	if !audienceOK(row.Audience, host) {
		return fleetauth.JSONReply(200, map[string]any{"active": false, "reason": "audience", "id": row.ID})
	}
	a.store.Touch(row.ID, now)
	return fleetauth.JSONReply(200, map[string]any{"active": true, "known": true, "id": row.ID, "name": row.Name, "kind": row.Kind,
		"subject": row.Subject, "scopes": scopesValue(row.Scopes), "audience": row.Audience, "exp": ni(row.ExpiresAt.Int64, row.ExpiresAt.Valid)})
}

func (a *App) listTokens(r *http.Request, _ map[string]string) *fleetauth.Reply {
	if _, err := a.ownerActor(r); err != nil {
		return err
	}
	now := a.now()
	out := []any{}
	for _, row := range a.store.All() {
		out = append(out, public(row, now))
	}
	return fleetauth.JSONReply(200, map[string]any{"tokens": out})
}

func (a *App) oneToken(r *http.Request, args map[string]string) *fleetauth.Reply {
	if _, err := a.ownerActor(r); err != nil {
		return err
	}
	row := a.store.Get(args["token_id"])
	if row == nil {
		return deny(404, "not found")
	}
	return fleetauth.JSONReply(200, public(row, a.now()))
}

func (a *App) create(r *http.Request, _ map[string]string) *fleetauth.Reply {
	actor, err := a.ownerActor(r)
	if err != nil {
		return err
	}
	b := a.bodyOrPanic(r)
	name := fleetauth.PyStrip(str(b, "name", ""))
	if n := fleetauth.CPLen(name); n < 1 || n > 80 {
		return deny(400, "name required (1-80 chars)")
	}
	av, aok := b.Get("audience")
	aud, e := normAudience(av, aok)
	if e != nil {
		return deny(400, e.Error())
	}
	scopes, e := normScopes(getOr(b, "scopes", fleetauth.Value{K: fleetauth.List}))
	if e != nil {
		return deny(400, e.Error())
	}
	now := a.now()
	var exp *big.Int
	if ttl := getOr(b, "ttl_days", fleetauth.Value{}); !(ttl.K == fleetauth.Null || fleetauth.Equal(ttl, fleetauth.S("")) || fleetauth.Equal(ttl, fleetauth.Value{K: fleetauth.Int, I: big.NewInt(0)})) {
		if ttl.K == fleetauth.Float && math.IsInf(ttl.F, 0) {
			panic("OverflowError: cannot convert float infinity to integer")
		}
		days, ie := fleetauth.PyInt(ttl)
		if ie != fleetauth.IntOK {
			return deny(400, "ttl_days must be a number")
		}
		if days.Cmp(big.NewInt(1)) < 0 || days.Cmp(big.NewInt(3650)) > 0 {
			return deny(400, "ttl_days must be 1-3650")
		}
		exp = big.NewInt(now + days.Int64()*86400)
	}
	value := prefix + strings.TrimRight(base64.URLEncoding.EncodeToString(a.rnd(32)), "=")
	tid, ierr := a.store.Insert(name, "fleet", aud, scopesJSON(scopes), "", exp, actor, "generated", value)
	if ierr != nil {
		panic(ierr)
	}
	a.store.Audit(actor, "generate", tid, name, "audience="+aud+" scopes="+strings.Join(scopes, ","))
	out := public(a.store.Get(tid), now)
	out["value"] = value // shown once here; retrievable later through /reveal (audited)
	return fleetauth.JSONReply(201, out)
}

// jwtClaims is the unverified claims of a JWT (display only: the signature is the verifier's job).
func jwtClaims(value string) *fleetauth.Object {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return nil
	}
	body := parts[1] + strings.Repeat("=", (4-fleetauth.CPLen(parts[1])%4)%4)
	raw, err := fleetauth.B64URLDecode([]byte(body))
	if err != nil {
		return nil
	}
	v, err := fleetauth.ParseJSON(raw)
	if err != nil || v.K != fleetauth.Obj {
		return nil
	}
	return v.O
}

func (a *App) importToken(r *http.Request, _ map[string]string) *fleetauth.Reply {
	actor, err := a.ownerActor(r)
	if err != nil {
		return err
	}
	b := a.bodyOrPanic(r)
	value := fleetauth.PyStrip(str(b, "value", ""))
	name := fleetauth.PyStrip(str(b, "name", ""))
	if n := fleetauth.CPLen(name); value == "" || n < 1 || n > 80 {
		return deny(400, "name and value required")
	}
	claims := jwtClaims(value)
	if claims == nil {
		claims = &fleetauth.Object{M: map[string]fleetauth.Value{}}
	}
	av, aok := b.Get("audience")
	aud, e := normAudience(av, aok)
	if e != nil {
		return deny(400, e.Error())
	}
	scp, has := b.Get("scopes")
	if !has || scp.K == fleetauth.Null {
		scp = getOr(claims, "scp", fleetauth.Value{K: fleetauth.List})
	}
	var scopes []string
	if scp.K == fleetauth.List {
		strs := make([]fleetauth.Value, len(scp.L))
		for i, s := range scp.L {
			strs[i] = fleetauth.S(fleetauth.PyStr(s))
		}
		scopes, e = normScopes(fleetauth.Value{K: fleetauth.List, L: strs})
	} else {
		scopes, e = normScopes(scp)
	}
	if e != nil {
		return deny(400, e.Error())
	}
	expV, okExp := b.Get("expires_at")
	if !okExp {
		expV = getOr(claims, "exp", fleetauth.Value{})
	}
	exp := intOfNumber(expV)
	if a.store.ByIndex(value) != nil {
		return deny(409, "already known")
	}
	kind := "imported"
	if len(claims.Keys) > 0 {
		kind = "authelia"
	}
	tid, ierr := a.store.Insert(name, kind, aud, scopesJSON(scopes), fleetauth.CPHead(str(claims, "sub", ""), 120), exp, actor, "imported", value)
	if ierr != nil {
		panic(ierr)
	}
	a.store.Audit(actor, "import", tid, name, "")
	return fleetauth.JSONReply(201, public(a.store.Get(tid), a.now()))
}

func (a *App) reveal(r *http.Request, args map[string]string) *fleetauth.Reply {
	actor, err := a.ownerActor(r)
	if err != nil {
		return err
	}
	row := a.store.Get(args["token_id"])
	if row == nil {
		return deny(404, "not found")
	}
	value, oerr := a.vault.Open(row.ID, row.Nonce, row.Ct)
	if oerr != nil {
		return deny(500, "cannot decrypt")
	}
	a.store.Audit(actor, "reveal", row.ID, row.Name, "")
	return fleetauth.JSONReply(200, map[string]any{"id": row.ID, "name": row.Name, "value": value})
}

func (a *App) revoke(r *http.Request, args map[string]string) *fleetauth.Reply {
	actor, err := a.ownerActor(r)
	if err != nil {
		return err
	}
	id := args["token_id"]
	row := a.store.Get(id)
	if row == nil {
		return deny(404, "not found")
	}
	if a.store.Revoke(id, a.now()) != 0 {
		a.store.Audit(actor, "revoke", row.ID, row.Name, "")
	}
	return fleetauth.JSONReply(200, public(a.store.Get(id), a.now()))
}

func (a *App) auditLog(r *http.Request, _ map[string]string) *fleetauth.Reply {
	if _, err := a.ownerActor(r); err != nil {
		return err
	}
	limit := int64(100)
	if i, e := fleetauth.PyInt(fleetauth.S(fleetauth.QueryForm(r).Get("limit", "100"))); e == fleetauth.IntOK {
		switch {
		case i.Cmp(big.NewInt(1)) < 0:
			limit = 1
		case i.Cmp(big.NewInt(500)) > 0:
			limit = 500
		default:
			limit = i.Int64()
		}
	}
	return fleetauth.JSONReply(200, map[string]any{"audit": a.store.AuditRows(limit)})
}
