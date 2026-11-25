// Package broker is the Go port of infra-sec_auth-broker (a stdlib http.server service): GitHub sign-in by the
// OAuth device flow, Google and GitHub by the web authorization-code flow (PKCE S256 + state), Cloudflare One /
// Cloudflare Access JWT verification, and the email one-time code. One process serves ONE provider; every
// instance validates the same signed session cookie. Same routes, same answers, same cookie bytes; see the
// Python main.py for the contract.
package broker

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"auth-broker/fleetauth"
)

const (
	// UA is the User-Agent of every call the broker makes.
	UA         = "diego-auth-broker/1"
	maxFlows   = 64
	rateN      = 10
	rateWindow = 600.0
)

// Config is what New needs besides the build.json document.
type Config struct {
	Doc      fleetauth.Value // build.json
	Provider string
	Env      func(string) string // os.environ.get(k, "")
	// Test seams.
	Now       func() float64
	Rand      func(n int) []byte
	RandBelow func(n int64) int64
	Mailer    func(to, code string) error
	HTTP      *http.Client
	Out       func(line string) // the print() lines of the Python service
}

type deviceFlow struct {
	dc        string
	exp, next float64
	iv        int64
}

type webState struct {
	verifier, bind, ru, rd string
	exp                    float64
}

type otpFlow struct {
	h, email string
	exp      float64
	n        int64
}

// Broker is one provider instance.
type Broker struct {
	ab, p, w, cf, eo cv
	enabled          bool
	prefix, flow     string
	id               string
	cookieName       string
	cookieDomain     string
	ttl              int64
	rdDomain         string
	emails           []string
	gh               []ghEntry
	secret           string
	clientID         string
	clientSecret     string
	webCID, webSec   string
	webOn            bool
	redirectURIs     []string
	cfOn, accessOn   bool
	cfKeys           map[string]cfKey
	cfKeysAt         float64
	otpLen           int64
	otpTTL           int64
	otpAttempts      int64
	otpAddrN, otpWin int64
	otpIPN           int64
	emailOn          bool
	env              func(string) string

	lock    sync.Mutex
	flows   map[string]*deviceFlow
	hits    map[string][]float64
	states  map[string]*webState
	otp     map[string]*otpFlow
	otpHits map[string][]float64

	now       func() float64
	rnd       func(int) []byte
	randBelow func(int64) int64
	mailer    func(to, code string) error
	client    *http.Client
	out       func(string)
}

type ghEntry struct {
	login string
	id    int64
	email string
}

type cfKey struct{ n, e *big.Int }

// cv reads a JSON config object with the same defaults as dict.get in the Python service.
type cv struct{ v fleetauth.Value }

func (c cv) get(k string) (fleetauth.Value, bool) {
	if c.v.K != fleetauth.Obj {
		return fleetauth.Value{}, false
	}
	return c.v.O.Get(k)
}

func (c cv) str(k, def string) string {
	if v, ok := c.get(k); ok {
		return fleetauth.PyStr(v)
	}
	return def
}

func (c cv) truthy(k string) bool {
	v, ok := c.get(k)
	return ok && v.Truthy()
}

func (c cv) integer(k string, def int64) (int64, error) {
	v, ok := c.get(k)
	if !ok {
		return def, nil
	}
	i, e := fleetauth.PyInt(v)
	if e != fleetauth.IntOK || !i.IsInt64() {
		return 0, fmt.Errorf("%s is not an integer", k)
	}
	return i.Int64(), nil
}

// obj is `x.get(k) or {}`.
func (c cv) obj(k string) cv {
	if v, ok := c.get(k); ok && v.Truthy() {
		return cv{v}
	}
	return cv{fleetauth.ObjV(&fleetauth.Object{M: map[string]fleetauth.Value{}})}
}

func (c cv) list(k string) []fleetauth.Value {
	if v, ok := c.get(k); ok && v.K == fleetauth.List {
		return v.L
	}
	return nil
}

func (c cv) strs(k string) []string {
	var out []string
	for _, v := range c.list(k) {
		out = append(out, fleetauth.PyStr(v))
	}
	return out
}

func (c cv) has(k string) bool { _, ok := c.get(k); return ok }

// abort is what a Python exception inside a request handler does to the client: no answer, connection closed.
func abort() { panic(http.ErrAbortHandler) }

// New builds one provider's broker (Broker.__init__); every SystemExit of the original is an error here.
func New(cfg Config) (*Broker, error) {
	b := &Broker{
		flows: map[string]*deviceFlow{}, hits: map[string][]float64{}, states: map[string]*webState{},
		otp: map[string]*otpFlow{}, otpHits: map[string][]float64{}, cfKeys: map[string]cfKey{},
		now: cfg.Now, rnd: cfg.Rand, randBelow: cfg.RandBelow, mailer: cfg.Mailer, client: cfg.HTTP, out: cfg.Out, env: cfg.Env,
	}
	if b.now == nil {
		b.now = func() float64 { return float64(time.Now().UnixNano()) / 1e9 }
	}
	if b.rnd == nil {
		b.rnd = func(n int) []byte {
			x := make([]byte, n)
			if _, err := rand.Read(x); err != nil {
				panic(err)
			}
			return x
		}
	}
	if b.randBelow == nil {
		b.randBelow = func(n int64) int64 {
			v, err := rand.Int(rand.Reader, big.NewInt(n))
			if err != nil {
				panic(err)
			}
			return v.Int64()
		}
	}
	if b.client == nil {
		b.client = fleetauth.NewUpstreamClient(10 * time.Second)
	}
	if b.out == nil {
		b.out = func(s string) { fmt.Fprintln(os.Stdout, s) }
	}
	if b.env == nil {
		b.env = func(string) string { return "" }
	}
	root := cv{cfg.Doc}
	if !root.has("auth_broker") {
		return nil, errors.New("KeyError: auth_broker")
	}
	b.ab = root.obj("auth_broker")
	var pv *fleetauth.Value
	for _, x := range b.ab.list("providers") {
		if c := (cv{x}); c.str("id", "") == cfg.Provider {
			x := x
			pv = &x
			break
		}
	}
	if pv == nil {
		return nil, fmt.Errorf("no provider %q in auth_broker.providers", cfg.Provider)
	}
	pid := cfg.Provider
	b.p = cv{*pv}
	b.id = pid
	b.enabled = b.p.truthy("enabled")
	b.prefix = b.p.str("prefix", "")
	b.flow = b.p.str("flow", "device")
	b.cookieName = b.ab.str("cookie_name", "")
	b.cookieDomain = b.ab.str("cookie_domain", "")
	if b.cookieName == "" && !b.ab.has("cookie_name") {
		return nil, errors.New("KeyError: cookie_name")
	}
	var err error
	if b.ttl, err = b.ab.integer("cookie_expire_seconds", 43200); err != nil {
		return nil, err
	}
	b.rdDomain = b.ab.str("rd_domain", "diegonmarcos.com")
	for _, e := range b.ab.strs("allowed_emails") {
		b.emails = append(b.emails, strings.ToLower(fleetauth.PyStrip(e)))
	}
	for _, a := range b.ab.list("allowed_github") {
		c := cv{a}
		id, err := c.integer("id", 0)
		if err != nil || !c.has("id") || !c.has("login") || !c.has("email") {
			return nil, errors.New("allowed_github entry is incomplete")
		}
		b.gh = append(b.gh, ghEntry{login: strings.ToLower(c.str("login", "")), id: id, email: c.str("email", "")})
	}
	list := len(b.emails)
	if b.p.str("provider", "") == "github" {
		list = len(b.gh)
	}
	if list == 0 {
		return nil, fmt.Errorf("allowlist for provider %s is empty: refusing to run open", pid)
	}
	b.secret = b.env("AUTH_BROKER_COOKIE_SECRET")
	if fleetauth.CPLen(b.secret) < 32 {
		return nil, errors.New("AUTH_BROKER_COOKIE_SECRET missing or shorter than 32 chars")
	}
	pre := b.p.str("secret_prefix", "")
	b.clientID = b.p.str("client_id", "")
	if !b.p.truthy("client_id") {
		b.clientID = b.env(pre + "_CLIENT_ID")
	}
	if pre != "" {
		b.clientSecret = b.env(pre + "_CLIENT_SECRET")
	}
	if b.enabled && b.clientID == "" && b.flow != "access" && b.flow != "email" {
		return nil, fmt.Errorf("provider %s is enabled but has no client id", pid)
	}
	// Web authorization-code flow: a provider with flow "web", or a device-flow provider that also declares a `web`
	// block. The web leg is live only when enabled, the provider is enabled and its client secret is present.
	if b.flow == "web" {
		b.w = b.p
	} else {
		b.w = b.p.obj("web")
	}
	wHas := b.w.v.K == fleetauth.Obj && len(b.w.v.O.Keys) > 0
	wpre := b.w.str("secret_prefix", "")
	b.webCID = b.w.str("client_id", "")
	if !b.w.truthy("client_id") {
		b.webCID = b.env(wpre + "_CLIENT_ID")
	}
	if wpre != "" {
		b.webSec = b.env(wpre + "_CLIENT_SECRET")
	}
	if b.flow == "web" {
		b.webOn = b.enabled
	} else {
		b.webOn = wHas && b.enabled && b.w.truthy("enabled") && b.webCID != "" && b.webSec != ""
	}
	b.redirectURIs = b.w.strs("redirect_uris")
	// Cloudflare Access: verify the Access JWT against the team certs.
	b.cf = b.ab.obj("cloudflare_access")
	b.cfOn = b.cf.truthy("enabled")
	if b.cfOn && !(b.cf.truthy("team_domain") && b.cf.truthy("aud") && len(b.emails) > 0) {
		return nil, errors.New("cloudflare_access is enabled without team_domain, aud and an email allowlist")
	}
	b.accessOn = b.flow == "access" && b.enabled && b.cfOn
	if b.flow == "access" && b.enabled && !(b.cfOn && b.p.truthy("login_url") && b.p.truthy("hosts")) {
		return nil, fmt.Errorf("provider %s is enabled but cloudflare_access, login_url or hosts is missing", pid)
	}
	// Email one-time code (flow "email").
	b.eo = b.ab.obj("email_otp")
	for _, f := range []struct {
		k   string
		def int64
		dst *int64
	}{{"code_length", 6, &b.otpLen}, {"ttl_seconds", 600, &b.otpTTL}, {"max_attempts", 5, &b.otpAttempts},
		{"send_per_address", 3, &b.otpAddrN}, {"send_window_seconds", 600, &b.otpWin}, {"send_per_ip", 10, &b.otpIPN}} {
		if *f.dst, err = b.eo.integer(f.k, f.def); err != nil {
			return nil, err
		}
	}
	b.emailOn = b.flow == "email" && b.enabled
	if b.emailOn && !(b.eo.v.K == fleetauth.Obj && len(b.eo.v.O.Keys) > 0) {
		return nil, fmt.Errorf("provider %s is enabled but auth_broker.email_otp is missing", pid)
	}
	if b.mailer == nil {
		b.mailer = b.deliver
	}
	return b, nil
}

// ID, Prefix, Enabled, Port expose what the entry point needs.
func (b *Broker) ID() string     { return b.id }
func (b *Broker) Prefix() string { return b.prefix }
func (b *Broker) Enabled() bool  { return b.enabled }

// Port is the configured listening port of the provider.
func (b *Broker) Port() string { return b.p.str("port", "") }

func b64e(x []byte) string { return strings.TrimRight(base64.URLEncoding.EncodeToString(x), "=") }

func b64d(s string) ([]byte, error) {
	return fleetauth.B64URLDecode([]byte(s + strings.Repeat("=", (4-fleetauth.CPLen(s)%4)%4)))
}

func (b *Broker) tokenURLSafe(n int) string { return b64e(b.rnd(n)) }

func (b *Broker) sign(body string) string {
	m := hmac.New(sha256.New, []byte(b.secret))
	m.Write([]byte(body))
	return b64e(m.Sum(nil))
}

// ---- session cookie ------------------------------------------------------------------------------------

func obj(pairs ...any) *fleetauth.Object {
	o := &fleetauth.Object{M: map[string]fleetauth.Value{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		k := pairs[i].(string)
		var v fleetauth.Value
		switch x := pairs[i+1].(type) {
		case string:
			v = fleetauth.S(x)
		case bool:
			v = fleetauth.Value{K: fleetauth.Bool, B: x}
		case int64:
			v = fleetauth.Value{K: fleetauth.Int, I: big.NewInt(x)}
		case int:
			v = fleetauth.Value{K: fleetauth.Int, I: big.NewInt(int64(x))}
		case fleetauth.Value:
			v = x
		case []string:
			l := make([]fleetauth.Value, len(x))
			for j, s := range x {
				l[j] = fleetauth.S(s)
			}
			v = fleetauth.Value{K: fleetauth.List, L: l}
		case nil:
			v = fleetauth.Value{}
		default:
			panic(fmt.Sprintf("obj: %T", x))
		}
		if _, ok := o.M[k]; !ok {
			o.Keys = append(o.Keys, k)
		}
		o.M[k] = v
	}
	return o
}

func (b *Broker) makeCookie(email, provider string) string {
	now := int64(b.now())
	body := b64e([]byte(fleetauth.DumpJSON(fleetauth.ObjV(obj("sub", email, "p", provider, "iat", now, "exp", now+b.ttl)))))
	return "v1." + body + "." + b.sign("v1."+body)
}

// checkCookie returns the cookie's sub (any JSON value, as Python does) when the signature and expiry hold.
func (b *Broker) checkCookie(value string) (fleetauth.Value, bool) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return fleetauth.Value{}, false
	}
	// hmac.compare_digest on str: non-ASCII raises TypeError, which the original's except turns into None
	for _, r := range fleetauth.CodePoints(parts[2]) {
		if r > 0x7f {
			return fleetauth.Value{}, false
		}
	}
	if !hmac.Equal([]byte(parts[2]), []byte(b.sign("v1."+parts[1]))) {
		return fleetauth.Value{}, false
	}
	raw, err := b64d(parts[1])
	if err != nil {
		return fleetauth.Value{}, false
	}
	d, err := fleetauth.ParseJSON(raw)
	if err != nil || d.K != fleetauth.Obj {
		return fleetauth.Value{}, false
	}
	ev, ok := d.O.Get("exp")
	if !ok {
		return fleetauth.Value{}, false
	}
	exp, e := fleetauth.PyInt(ev)
	if e != fleetauth.IntOK {
		return fleetauth.Value{}, false
	}
	if new(big.Float).SetInt(exp).Cmp(big.NewFloat(b.now())) <= 0 {
		return fleetauth.Value{}, false
	}
	sub, ok := d.O.Get("sub")
	return sub, ok
}

// sessionEmail is the first valid session cookie's sub, as text, when it is truthy.
func (b *Broker) sessionEmail(cookieHeader string) (string, bool) {
	for _, part := range strings.Split(cookieHeader, ";") {
		k, v, _ := strings.Cut(fleetauth.PyStrip(part), "=")
		if k == b.cookieName {
			if e, ok := b.checkCookie(v); ok && e.Truthy() {
				return fleetauth.PyStr(e), true
			}
		}
	}
	return "", false
}

func (b *Broker) setCookie(value string, maxAge int64) string {
	a := []string{b.cookieName + "=" + value, "Path=/", fmt.Sprintf("Max-Age=%d", maxAge), "Secure", "HttpOnly", "SameSite=Lax"}
	if b.cookieDomain != "" {
		a = append(a[:1], append([]string{"Domain=" + b.cookieDomain}, a[1:]...)...)
	}
	return strings.Join(a, "; ")
}

// safeRD is the redirect-target check. A value Python would raise on (not a string, a malformed URL) aborts.
func (b *Broker) safeRD(rdv fleetauth.Value) string {
	if !rdv.Truthy() {
		return "/"
	}
	if rdv.K != fleetauth.Str {
		abort()
	}
	rd := rdv.S
	if strings.HasPrefix(rd, "/") && !strings.HasPrefix(rd, "//") && !strings.Contains(rd, `\`) {
		return rd
	}
	u, err := fleetauth.PyURLSplit(rd)
	if err != nil {
		abort()
	}
	h := strings.ToLower(u.Hostname())
	if u.Scheme == "https" && (h == b.rdDomain || strings.HasSuffix(h, "."+b.rdDomain)) {
		return rd
	}
	return "/"
}

func (b *Broker) safeRDStr(rd string) string { return b.safeRD(fleetauth.S(rd)) }

func hexOf(x []byte) string { return hex.EncodeToString(x) }

func be64(n uint64) []byte {
	var c [8]byte
	binary.BigEndian.PutUint64(c[:], n)
	return c[:]
}
