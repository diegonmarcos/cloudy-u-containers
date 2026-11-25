package broker

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"fmt"
	"io"
	"math"
	"math/big"
	"net/http"
	"strconv"
	"strings"

	"auth-broker/fleetauth"
)

// ---- calls to providers ----------------------------------------------------------------------------------

// call is Broker.call: GET (data nil) or form POST, JSON back. A 4xx/5xx answer is (code, its JSON or {}); a
// transport failure or an unparsable 2xx answer is an exception in the original, so the request is aborted.
func (b *Broker) call(u string, data [][2]string, headers map[string]string) (int, fleetauth.Value) {
	var body io.Reader
	method := http.MethodGet
	if data != nil {
		method = http.MethodPost
		body = strings.NewReader(fleetauth.URLEncode(data...))
	}
	req, err := http.NewRequest(method, u, body)
	if err != nil {
		abort()
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", UA)
	if data != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := b.client.Do(req)
	if err != nil {
		abort()
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		abort()
	}
	empty := fleetauth.ObjV(&fleetauth.Object{M: map[string]fleetauth.Value{}})
	if resp.StatusCode >= 400 {
		if len(raw) == 0 {
			return resp.StatusCode, empty
		}
		v, err := fleetauth.ParseJSON(raw)
		if err != nil || v.K != fleetauth.Obj {
			return resp.StatusCode, empty
		}
		return resp.StatusCode, v
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	v, err := fleetauth.ParseJSON(raw)
	if err != nil || v.K != fleetauth.Obj { // json error, or a non-dict the callers would raise AttributeError on
		abort()
	}
	return resp.StatusCode, v
}

func get(v fleetauth.Value, k string) fleetauth.Value {
	if m, ok := v.O.Get(k); ok {
		return m
	}
	return fleetauth.Value{}
}

func getOr(v fleetauth.Value, k string, def fleetauth.Value) fleetauth.Value {
	if m, ok := v.O.Get(k); ok {
		return m
	}
	return def
}

func intOf(v fleetauth.Value) int64 {
	i, e := fleetauth.PyInt(v)
	if e != fleetauth.IntOK || !i.IsInt64() {
		abort()
	}
	return i.Int64()
}

// ---- rate limits -----------------------------------------------------------------------------------------

func (b *Broker) rateOK(ip string) bool {
	now := b.now()
	b.lock.Lock()
	defer b.lock.Unlock()
	var h []float64
	for _, t := range b.hits[ip] {
		if now-t < rateWindow {
			h = append(h, t)
		}
	}
	ok := len(h) < rateN
	if ok {
		h = append(h, now)
	}
	b.hits[ip] = h
	for k, v := range b.hits {
		if len(v) == 0 || now-v[len(v)-1] > rateWindow {
			delete(b.hits, k)
		}
	}
	return ok
}

func (b *Broker) window(table map[string][]float64, key string, limit int64, now float64) bool {
	var h []float64
	for _, t := range table[key] {
		if now-t < float64(b.otpWin) {
			h = append(h, t)
		}
	}
	ok := int64(len(h)) < limit
	if ok {
		h = append(h, now)
	}
	table[key] = h
	return ok
}

// ---- email one-time code ---------------------------------------------------------------------------------

func (b *Broker) otpHash(sid, code string) string {
	m := hmac.New(sha256.New, []byte(b.secret))
	m.Write([]byte("otp|" + sid + "|" + code))
	return hexOf(m.Sum(nil))
}

// otpRequest answers (status, body). The answer never depends on the allowlist or the per-address limit.
func (b *Broker) otpRequest(address fleetauth.Value, ip string) (int, *fleetauth.Object) {
	if !b.emailOn {
		return 404, obj("error", "disabled")
	}
	now := b.now()
	a := ""
	if address.Truthy() {
		a = fleetauth.PyStr(address)
	}
	addr := fleetauth.CPHead(strings.ToLower(fleetauth.PyStrip(a)), 254)
	sid := b.tokenURLSafe(24)
	b.lock.Lock()
	for k, f := range b.otp {
		if f.exp <= now {
			delete(b.otp, k)
		}
	}
	if !b.window(b.otpHits, "ip:"+ip, b.otpIPN, now) {
		b.lock.Unlock()
		return 429, obj("error", "rate_limited")
	}
	if len(b.otp) >= maxFlows*4 {
		b.lock.Unlock()
		return 429, obj("error", "busy")
	}
	send := false
	for _, e := range b.emails {
		if e == addr {
			send = b.window(b.otpHits, "addr:"+addr, b.otpAddrN, now)
			break
		}
	}
	// "%0*d" % (len, randbelow(10 ** len))
	limit := new(big.Int).Exp(big.NewInt(10), big.NewInt(b.otpLen), nil)
	if !limit.IsInt64() {
		b.lock.Unlock()
		abort()
	}
	code := fmt.Sprintf("%0*d", int(b.otpLen), b.randBelow(limit.Int64()))
	f := &otpFlow{exp: now + float64(b.otpTTL)}
	if send {
		f.h, f.email = b.otpHash(sid, code), addr
	} else {
		// Unlisted or throttled addresses get a live-looking sid with a hash nobody knows the code for.
		f.h = b.otpHash(sid, hexOf(b.rnd(8)))
	}
	b.otp[sid] = f
	b.lock.Unlock()
	if send {
		if err := b.mailer(addr, code); err != nil {
			b.out("otp delivery failed: " + errName(err))
		}
	}
	return 200, obj("sid", sid, "status", "sent", "expires_in", b.otpTTL)
}

func errName(err error) string {
	if e, ok := err.(interface{ PyName() string }); ok {
		return e.PyName()
	}
	return "Error"
}

// otpVerify answers (status, body, set-cookie). Single use; the flow dies after max_attempts wrong codes.
func (b *Broker) otpVerify(sidv, codev fleetauth.Value) (int, *fleetauth.Object, string) {
	if !b.emailOn {
		return 404, obj("status", "disabled"), ""
	}
	sid, code := "", ""
	if sidv.Truthy() {
		sid = fleetauth.PyStr(sidv)
	}
	if codev.Truthy() {
		code = fleetauth.PyStrip(fleetauth.PyStr(codev))
	}
	b.lock.Lock()
	f, ok := b.otp[sid]
	if !ok || f.exp <= b.now() {
		delete(b.otp, sid)
		b.lock.Unlock()
		return 200, obj("status", "expired"), ""
	}
	f.n++
	good := f.email != "" && fleetauth.IsASCIIDigits(code) && int64(fleetauth.CPLen(code)) == b.otpLen &&
		hmac.Equal([]byte(b.otpHash(sid, code)), []byte(f.h))
	if good {
		delete(b.otp, sid)
	} else if f.n >= b.otpAttempts {
		delete(b.otp, sid)
		b.lock.Unlock()
		return 200, obj("status", "locked"), ""
	}
	b.lock.Unlock()
	if !good {
		return 200, obj("status", "wrong"), ""
	}
	return 200, obj("status", "ok"), b.setCookie(b.makeCookie(f.email, b.id), b.ttl)
}

// ---- device flow -----------------------------------------------------------------------------------------

func (b *Broker) newDevice(ip string) (int, *fleetauth.Object) {
	if !b.enabled {
		return 404, obj("error", "disabled")
	}
	if !b.rateOK(ip) {
		return 429, obj("error", "rate_limited")
	}
	b.lock.Lock()
	now := b.now()
	for k, f := range b.flows {
		if f.exp <= now {
			delete(b.flows, k)
		}
	}
	if len(b.flows) >= maxFlows {
		b.lock.Unlock()
		return 429, obj("error", "busy")
	}
	b.lock.Unlock()
	st, d := b.call(b.p.str("device_url", ""), [][2]string{{"client_id", b.clientID}, {"scope", b.p.str("scope", "")}}, nil)
	if _, has := d.O.Get("device_code"); st != 200 || !has {
		b.out(fmt.Sprintf("device code request failed: status=%d error=%s", st, fleetauth.PyStr(get(d, "error"))))
		detail := getOr(d, "error", fleetauth.S(""))
		return 502, obj("error", "provider_error", "detail", detail)
	}
	sid := b.tokenURLSafe(24)
	iv := intOf(getOr(d, "interval", fleetauth.Value{K: fleetauth.Int, I: big.NewInt(5)}))
	if iv < 1 {
		iv = 1
	}
	exp := intOf(getOr(d, "expires_in", fleetauth.Value{K: fleetauth.Int, I: big.NewInt(900)}))
	now = b.now()
	b.lock.Lock()
	b.flows[sid] = &deviceFlow{dc: fleetauth.PyStr(get(d, "device_code")), exp: b.now() + float64(exp), iv: iv, next: b.now() + float64(iv)}
	b.lock.Unlock()
	uc, has := d.O.Get("user_code")
	if !has {
		abort()
	}
	vu := getOr(d, "verification_uri", fleetauth.Value{})
	if !vu.Truthy() {
		vu = get(d, "verification_url")
	}
	return 200, obj("sid", sid, "user_code", uc, "interval", iv, "expires_in", exp, "verification_uri", vu)
}

// identity returns the allowlisted email for this provider token, or "" (None).
func (b *Broker) identity(token string) string {
	auth := map[string]string{"Authorization": "Bearer " + token}
	if b.p.str("provider", "") == "github" {
		st, u := b.call(b.p.str("user_url", ""), nil, auth)
		idv, has := u.O.Get("id")
		if st != 200 || !has {
			return ""
		}
		for _, a := range b.gh {
			id, e := fleetauth.PyInt(idv)
			if e != fleetauth.IntOK {
				abort()
			}
			if id.Cmp(big.NewInt(a.id)) == 0 && strings.ToLower(fleetauth.PyStr(getOr(u, "login", fleetauth.S("")))) == a.login {
				return a.email
			}
		}
		b.out("github account not on the allowlist: " + fleetauth.PyStr(get(u, "login")))
		return ""
	}
	st, u := b.call(b.p.str("userinfo_url", ""), nil, auth)
	em := strings.ToLower(fleetauth.PyStrip(fleetauth.PyStr(getOr(u, "email", fleetauth.S("")))))
	if ev := get(u, "email_verified"); st == 200 && ev.K == fleetauth.Bool && ev.B && b.listed(em) {
		return em
	}
	b.out("google account not on the allowlist: " + em)
	return ""
}

func (b *Broker) listed(em string) bool {
	for _, e := range b.emails {
		if e == em {
			return true
		}
	}
	return false
}

func (b *Broker) poll(sid string) (int, *fleetauth.Object, string) {
	b.lock.Lock()
	f, ok := b.flows[sid]
	if !ok {
		b.lock.Unlock()
		return 404, obj("status", "unknown"), ""
	}
	now := b.now()
	if f.exp <= now {
		delete(b.flows, sid)
		b.lock.Unlock()
		return 200, obj("status", "expired"), ""
	}
	if now < f.next {
		b.lock.Unlock()
		return 200, obj("status", "pending"), ""
	}
	f.next = now + float64(f.iv)
	dc := f.dc
	b.lock.Unlock()
	data := [][2]string{{"client_id", b.clientID}, {"device_code", dc}, {"grant_type", "urn:ietf:params:oauth:grant-type:device_code"}}
	if b.clientSecret != "" {
		data = append(data, [2]string{"client_secret", b.clientSecret})
	}
	_, d := b.call(b.p.str("token_url", ""), data, nil)
	errV := get(d, "error")
	errS, errIsStr := errV.S, errV.K == fleetauth.Str
	if errIsStr && errS == "authorization_pending" {
		return 200, obj("status", "pending"), ""
	}
	if errIsStr && errS == "slow_down" {
		b.lock.Lock()
		if f, ok := b.flows[sid]; ok {
			f.iv += 5
			f.next = b.now() + float64(f.iv)
		}
		b.lock.Unlock()
		return 200, obj("status", "pending"), ""
	}
	at := get(d, "access_token")
	if errV.Truthy() || !at.Truthy() {
		b.lock.Lock()
		delete(b.flows, sid)
		b.lock.Unlock()
		if errIsStr && errS == "expired_token" {
			return 200, obj("status", "expired"), ""
		}
		return 200, obj("status", "denied"), ""
	}
	b.lock.Lock()
	delete(b.flows, sid) // one use: the device code is spent either way
	b.lock.Unlock()
	email := b.identity(fleetauth.PyStr(at))
	if email == "" {
		return 200, obj("status", "forbidden"), ""
	}
	return 200, obj("status", "ok"), b.setCookie(b.makeCookie(email, b.id), b.ttl)
}

// ---- Cloudflare Access JWT (RS256) -----------------------------------------------------------------------

var sha256DigestInfo = []byte{0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20}

func (b *Broker) cfLoadKeys(force bool) {
	now := b.now()
	if !force && len(b.cfKeys) > 0 && now-b.cfKeysAt < 3600 {
		return
	}
	if force && now-b.cfKeysAt < 60 { // an unknown kid must not make us hammer the certs URL
		return
	}
	certs := b.cf.str("certs_url", "")
	if !b.cf.truthy("certs_url") {
		certs = "https://" + b.cf.str("team_domain", "") + "/cdn-cgi/access/certs"
	}
	st, d := b.call(certs, nil, nil)
	if st != 200 {
		return
	}
	keys := map[string]cfKey{}
	kv := getOr(d, "keys", fleetauth.Value{K: fleetauth.List})
	if kv.K != fleetauth.List {
		panic("TypeError: keys is not iterable")
	}
	for _, k := range kv.L {
		if k.K != fleetauth.Obj {
			panic("AttributeError")
		}
		kid := get(k, "kid")
		if kt := get(k, "kty"); kt.K == fleetauth.Str && kt.S == "RSA" && kid.Truthy() {
			nb, err1 := b64dVal(get(k, "n"))
			eb, err2 := b64dVal(get(k, "e"))
			if err1 != nil || err2 != nil {
				panic("binascii.Error")
			}
			keys[fleetauth.PyStr(kid)] = cfKey{new(big.Int).SetBytes(nb), new(big.Int).SetBytes(eb)}
		}
	}
	if len(keys) > 0 {
		b.cfKeys, b.cfKeysAt = keys, now
	}
}

func b64dVal(v fleetauth.Value) ([]byte, error) {
	if v.K != fleetauth.Str {
		return nil, fmt.Errorf("not a string")
	}
	return b64d(v.S)
}

// pyFloat is float(v) for a JSON value.
func pyFloat(v fleetauth.Value) (float64, bool) {
	switch v.K {
	case fleetauth.Bool:
		if v.B {
			return 1, true
		}
		return 0, true
	case fleetauth.Int:
		f, _ := new(big.Float).SetInt(v.I).Float64()
		return f, !math.IsInf(f, 0)
	case fleetauth.Float:
		return v.F, true
	case fleetauth.Str:
		s := fleetauth.PyStrip(v.S)
		if strings.ContainsAny(s, "xXpP") {
			return 0, false
		}
		if strings.Contains(s, "_") {
			for i := 0; i < len(s); i++ {
				if s[i] == '_' && (i == 0 || i == len(s)-1 || s[i-1] < '0' || s[i-1] > '9' || s[i+1] < '0' || s[i+1] > '9') {
					return 0, false
				}
			}
			s = strings.ReplaceAll(s, "_", "")
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
				return f, true
			}
			return 0, false
		}
		return f, true
	}
	return 0, false
}

// cfEmail is the owner email for a valid Cloudflare Access JWT, else "". Verified: RS256 signature against the team
// certs, issuer, audience, expiry, and the email against the allowlist (service tokens carry no email).
func (b *Broker) cfEmail(tok string) (email string) {
	if !b.cfOn || tok == "" || fleetauth.CPLen(tok) > 8192 {
		return ""
	}
	defer func() {
		// the original's `except Exception: return None`: a failed certs call and any odd claim end up here
		if recover() != nil {
			email = ""
		}
	}()
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return ""
	}
	h64, p64, s64 := parts[0], parts[1], parts[2]
	hraw, err := b64d(h64)
	if err != nil {
		return ""
	}
	hdr, err := fleetauth.ParseJSON(hraw)
	if err != nil || hdr.K != fleetauth.Obj {
		return ""
	}
	if alg := get(hdr, "alg"); alg.K != fleetauth.Str || alg.S != "RS256" {
		return ""
	}
	kidV := getOr(hdr, "kid", fleetauth.S(""))
	b.cfLoadKeys(false)
	if kidV.K == fleetauth.List || kidV.K == fleetauth.Obj {
		return "" // unhashable: TypeError in `kid not in self.cf_keys`
	}
	kid := fleetauth.PyStr(kidV)
	if kidV.K != fleetauth.Str {
		kid = "\x00non-string kid " + kid // never equal to a string key
	}
	if _, ok := b.cfKeys[kid]; !ok {
		b.cfLoadKeys(true)
	}
	key, ok := b.cfKeys[kid]
	if !ok {
		return ""
	}
	k := (key.n.BitLen() + 7) / 8
	sig, err := b64d(s64)
	if err != nil {
		return ""
	}
	sn := new(big.Int).SetBytes(sig)
	if len(sig) != k || sn.Cmp(key.n) >= 0 {
		return ""
	}
	em := make([]byte, k)
	new(big.Int).Exp(sn, key.e, key.n).FillBytes(em)
	digest := sha256.Sum256([]byte(h64 + "." + p64))
	tail := append(append([]byte{0}, sha256DigestInfo...), digest[:]...)
	pad := k - len(tail) - 2
	want := append([]byte{0, 1}, bytes.Repeat([]byte{0xff}, max(pad, 0))...)
	want = append(want, tail...)
	if !hmac.Equal(em, want) {
		return ""
	}
	praw, err := b64d(p64)
	if err != nil {
		return ""
	}
	c, err := fleetauth.ParseJSON(praw)
	if err != nil || c.K != fleetauth.Obj {
		return ""
	}
	now := b.now()
	audV := get(c, "aud")
	var aud []fleetauth.Value
	switch {
	case audV.K == fleetauth.Str:
		aud = []fleetauth.Value{audV}
	case !audV.Truthy():
	case audV.K == fleetauth.List:
		aud = audV.L
	case audV.K == fleetauth.Obj:
		for _, k := range audV.O.Keys {
			aud = append(aud, fleetauth.S(k))
		}
	default:
		return "" // list(5): TypeError
	}
	for _, a := range aud {
		if a.K == fleetauth.List || a.K == fleetauth.Obj {
			return "" // unhashable in set(aud)
		}
	}
	iss := get(c, "iss")
	if iss.K != fleetauth.Str || iss.S != "https://"+b.cf.str("team_domain", "") {
		return ""
	}
	match := false
	for _, want := range b.cf.list("aud") {
		for _, a := range aud {
			if fleetauth.Equal(a, want) {
				match = true
			}
		}
	}
	if !match {
		return ""
	}
	expV, has := c.O.Get("exp")
	if !has {
		return ""
	}
	exp, ok := pyFloat(expV)
	if !ok {
		return ""
	}
	nbf, ok := pyFloat(getOr(c, "nbf", fleetauth.Value{K: fleetauth.Int, I: big.NewInt(0)}))
	if !ok {
		return ""
	}
	if exp <= now || nbf > now+60 {
		return ""
	}
	em2 := strings.ToLower(fleetauth.PyStrip(fleetauth.PyStr(getOr(c, "email", fleetauth.S("")))))
	if b.listed(em2) {
		return em2
	}
	return ""
}

// ---- Cloudflare One sign-in (flow "access") ------------------------------------------------------------

// accessStart is the Location of the Access-protected callback, with rd made absolute and validated, or "".
func (b *Broker) accessStart(host string, rd fleetauth.Value) string {
	host = strings.SplitN(strings.ToLower(host), ":", 2)[0]
	ok := false
	for _, h := range b.p.strs("hosts") {
		if h == host {
			ok = true
		}
	}
	if !b.accessOn || !ok {
		return ""
	}
	r := b.safeRD(rd)
	if strings.HasPrefix(r, "/") {
		r = "https://" + host + r
	}
	return b.p.str("login_url", "") + "?" + fleetauth.URLEncode([2]string{"rd", r})
}

// accessCallback is (location, set-cookie) for a valid owner Access JWT, else ok=false.
func (b *Broker) accessCallback(jwt string, rd fleetauth.Value) (loc, cookie string, ok bool) {
	e := ""
	if b.accessOn {
		e = b.cfEmail(jwt)
	}
	if e == "" {
		return "", "", false
	}
	r := b.safeRD(rd)
	if strings.HasPrefix(r, "/") {
		r = b.p.str("home_url", "")
	}
	return r, b.setCookie(b.makeCookie(e, b.id), b.ttl), true
}

// ---- web authorization-code flow (PKCE S256 + state) ---------------------------------------------------

const stateCookie = "_sso_state"

func (b *Broker) webRedirectURI(host string) string {
	host = strings.ToLower(host)
	for _, u := range b.redirectURIs {
		sp, err := fleetauth.PyURLSplit(u)
		if err != nil {
			abort()
		}
		if sp.Netloc == host {
			return u
		}
	}
	return ""
}

func (b *Broker) webStart(host string, rd fleetauth.Value) (int, string, string) {
	if !b.webOn {
		return 404, "", ""
	}
	ru := b.webRedirectURI(host)
	if ru == "" {
		return 400, "", ""
	}
	now := b.now()
	state, verifier, bind, code := "", "", "", 0
	func() {
		b.lock.Lock()
		defer b.lock.Unlock() // safeRD may abort the request: the lock must not stay held
		for k, v := range b.states {
			if v.exp <= now {
				delete(b.states, k)
			}
		}
		if len(b.states) >= maxFlows*4 {
			code = 429
			return
		}
		state, verifier, bind = b.tokenURLSafe(24), b.tokenURLSafe(48), b.tokenURLSafe(16)
		b.states[state] = &webState{verifier: verifier, bind: bind, ru: ru, rd: b.safeRD(rd), exp: now + 600}
	}()
	if code != 0 {
		return code, "", ""
	}
	sum := sha256.Sum256([]byte(verifier))
	scope := b.w.str("scope", b.p.str("scope", ""))
	q := fleetauth.URLEncode([2]string{"client_id", b.webCID}, [2]string{"redirect_uri", ru}, [2]string{"response_type", "code"},
		[2]string{"scope", scope}, [2]string{"state", state}, [2]string{"code_challenge", b64e(sum[:])},
		[2]string{"code_challenge_method", "S256"}, [2]string{"prompt", "select_account"})
	cookie := fmt.Sprintf("%s=%s; Path=%s; Max-Age=600; Secure; HttpOnly; SameSite=Lax", stateCookie, bind, b.prefix)
	return 302, b.w.str("auth_url", "") + "?" + q, cookie
}

// webCallback returns (status, location-or-message, set-cookies). State is single use and bound to the browser.
func (b *Broker) webCallback(query, cookieHeader string) (int, string, []string) {
	_, q := fleetauth.ParseQS(query)
	first := func(k string) string {
		if v := q[k]; len(v) > 0 {
			return v[0]
		}
		return ""
	}
	b.lock.Lock()
	st := b.states[first("state")]
	delete(b.states, first("state"))
	b.lock.Unlock()
	bind := ""
	for _, part := range strings.Split(cookieHeader, ";") {
		k, v, _ := strings.Cut(fleetauth.PyStrip(part), "=")
		if k == stateCookie {
			bind = v
		}
	}
	clear := fmt.Sprintf("%s=; Path=%s; Max-Age=0; Secure; HttpOnly; SameSite=Lax", stateCookie, b.prefix)
	if st == nil || st.exp <= b.now() || bind == "" || !fleetauth.CompareDigest(bind, st.bind) {
		return 400, "Sign-in expired or invalid. Start again.", []string{clear}
	}
	if first("error") != "" || first("code") == "" {
		return 403, "Sign-in was cancelled or denied.", []string{clear}
	}
	if !b.webOn {
		return 404, "Sign-in is not available.", []string{clear}
	}
	data := [][2]string{{"client_id", b.webCID}, {"client_secret", b.webSec}, {"code", first("code")},
		{"code_verifier", st.verifier}, {"redirect_uri", st.ru}, {"grant_type", "authorization_code"}}
	tokenURL := b.w.str("token_url", "")
	if !b.w.truthy("token_url") {
		tokenURL = b.p.str("token_url", "")
	}
	code, d := b.call(tokenURL, data, nil)
	at := get(d, "access_token")
	if code != 200 || !at.Truthy() {
		b.out(fmt.Sprintf("code exchange failed: status=%d error=%s", code, fleetauth.PyStr(get(d, "error"))))
		return 502, "Sign-in failed at the provider.", []string{clear}
	}
	email := b.identity(fleetauth.PyStr(at))
	if email == "" {
		return 403, "This account is not allowed.", []string{clear}
	}
	return 302, st.rd, []string{clear, b.setCookie(b.makeCookie(email, b.id), b.ttl)}
}
