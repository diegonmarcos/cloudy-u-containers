package authz

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const scope = "cloud-drive"

func okClaims() Claims {
	return Claims{"iss": "https://auth.diegonmarcos.com", "scp": []any{scope}, "sub": "diego"}
}

// A. refusal as a pure decision: STATUS and BODY, never a 2xx (#568).
func TestRefusal(t *testing.T) {
	accept := func(string) (Claims, error) { return okClaims(), nil }
	reject := func(string) (Claims, error) { return nil, errors.New("bad signature") }
	down := func(string) (Claims, error) { return nil, ErrJWKSUnavailable }
	other := func(string) (Claims, error) { c := okClaims(); c["scp"] = []any{"some.other.scope"}; return c, nil }
	cases := []struct {
		h      string
		v      func(string) (Claims, error)
		status int
		code   string
	}{
		{"", accept, 401, "missing_authorization"},
		{"token abc", accept, 401, "bad_scheme"},
		{"bearer abc", accept, 401, "bad_scheme"},
		{"Basic abc", accept, 401, "bad_scheme"},
		{"Bearer ", accept, 401, "empty_token"},
		{"Bearer aa bb", accept, 401, "malformed_token"},
		{"Bearer abc", reject, 401, "invalid_token"},
		{"Bearer abc", down, 503, "jwks_unavailable"},
		{"Bearer abc", other, 403, "insufficient_scope"},
	}
	for _, c := range cases {
		d := DecideAuth(c.h, c.v, scope)
		if d.OK || d.Status != c.status || d.Code != c.code {
			t.Errorf("%q: got ok=%v %d %s, want %d %s", c.h, d.OK, d.Status, d.Code, c.status, c.code)
		}
		if d.Status < 400 || d.Error == "" {
			t.Errorf("%q: refusal must be non-2xx with an error text", c.h)
		}
		var body map[string]string
		if err := json.Unmarshal(d.Body(), &body); err != nil || body["code"] != c.code || body["error"] == "" {
			t.Errorf("%q: body %s", c.h, d.Body())
		}
	}
	if d := DecideAuth("Bearer abc", accept, scope); !d.OK {
		t.Error("a valid token with the required scope must be accepted")
	}
	if string(DecideAuth("", accept, scope).Body()) != `{"error":"Authorization header required","code":"missing_authorization"}` {
		t.Error("body key order/shape must match the Node refusal literal")
	}
}

func TestScopesOf(t *testing.T) {
	eq := func(c Claims, want []string) {
		t.Helper()
		if got := ScopesOf(c); !reflect.DeepEqual(got, want) {
			t.Errorf("ScopesOf(%v) = %v, want %v", c, got, want)
		}
	}
	eq(Claims{"scp": []any{"a", "b"}}, []string{"a", "b"})
	eq(Claims{"scp": "a b"}, []string{"a", "b"})
	eq(Claims{"scope": "a b"}, []string{"a", "b"})
	eq(nil, []string{})
	eq(Claims{}, []string{})
	eq(Claims{"scp": []any{}, "scope": "x"}, []string{})
	if contains(ScopesOf(Claims{"scp": []any{1.0, 2.0}}), "1") {
		t.Error("a non-string scope must never equal a real scope")
	}
}

func TestSession(t *testing.T) {
	users := []string{"diego"}
	owner := func(string) (string, error) { return "diego", nil }
	stranger := func(string) (string, error) { return "guest@example.invalid", nil }
	dead := func(string) (string, error) { return "", errors.New("401") }
	down := func(string) (string, error) { return "", ErrSessionUnavailable }
	for _, c := range []struct {
		cookie string
		v      func(string) (string, error)
		status int
		code   string
	}{
		{"", owner, 401, "missing_authorization"},
		{"authelia_session=x", dead, 401, "invalid_session"},
		{"authelia_session=x", down, 503, "session_unavailable"},
		{"authelia_session=x", stranger, 403, "user_not_allowed"},
	} {
		d := DecideSession(c.cookie, c.v, users)
		if d.OK || d.Status != c.status || d.Code != c.code {
			t.Errorf("session %q: got %v %d %s, want %d %s", c.cookie, d.OK, d.Status, d.Code, c.status, c.code)
		}
	}
	if d := DecideSession("authelia_session=x", owner, users); !d.OK || d.User != "diego" {
		t.Error("a live session of a declared user must be accepted")
	}
	if DecideSession("authelia_session=x", owner, nil).OK {
		t.Error("an empty user list admits NOBODY")
	}
}

func TestMesh(t *testing.T) {
	C := []string{"10.0.0.0/24", "fd0c:1d00::/64"}
	h := http.Header{}
	yes := func(a string) {
		t.Helper()
		if !IsDirectMesh(a, h, C) {
			t.Errorf("%s must be the mesh", a)
		}
	}
	no := func(a string) {
		t.Helper()
		if IsDirectMesh(a, h, C) {
			t.Errorf("%s must NOT be the mesh", a)
		}
	}
	yes("10.0.0.7")
	yes("::ffff:10.0.0.7")
	yes("fd0c:1d00::5")
	no("10.0.1.7")
	no("fd0c:1d01::5")
	no("203.0.113.9")
	no("garbage")
	for _, hd := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Real-Ip", "Forwarded", "Via"} {
		hh := http.Header{}
		hh.Set(hd, "1.2.3.4")
		if IsDirectMesh("10.0.0.1", hh, C) {
			t.Errorf("a request relayed by a proxy (%s) is never the mesh", hd)
		}
	}
	if IsDirectMesh("10.0.0.7", h, nil) {
		t.Error("no declared cidrs means nothing is the mesh")
	}
	if InCIDR("garbage", "10.0.0.0/24") || InCIDR("10.0.0.1", "nonsense") {
		t.Error("malformed addresses never match")
	}
	if RemoteIP("10.0.0.7:5555") != "10.0.0.7" || RemoteIP("[fd0c:1d00::5]:80") != "fd0c:1d00::5" {
		t.Error("RemoteIP must strip the port")
	}
}

// ---- the verifier, against a throwaway keypair and a JWKS served locally ----

type fixture struct {
	key      *rsa.PrivateKey
	impostor *rsa.PrivateKey
	srv      *httptest.Server
	hits     atomic.Int32
	down     atomic.Bool
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func jwkOf(k *rsa.PublicKey, kid string) map[string]string {
	e := []byte{byte(k.E >> 16), byte(k.E >> 8), byte(k.E)}
	for len(e) > 1 && e[0] == 0 {
		e = e[1:]
	}
	return map[string]string{"kty": "RSA", "kid": kid, "n": b64(k.N.Bytes()), "e": b64(e), "alg": "RS256", "use": "sig"}
}

func newFixture(t *testing.T, impostorFirst bool) *fixture {
	t.Helper()
	f := &fixture{}
	var err error
	if f.key, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		t.Fatal(err)
	}
	if f.impostor, err = rsa.GenerateKey(rand.Reader, 2048); err != nil {
		t.Fatal(err)
	}
	real := jwkOf(&f.key.PublicKey, "k1")
	fake := jwkOf(&f.impostor.PublicKey, "k0")
	keys := []map[string]string{real}
	if impostorFirst {
		// The impostor's key comes FIRST, so a verifier that grabbed keys[0] instead of matching kid fails.
		keys = []map[string]string{fake, real}
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if f.down.Load() {
			http.Error(w, "down", 500)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": keys})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fixture) verifier() *BearerVerifier {
	return &BearerVerifier{JWKSURL: f.srv.URL, Issuer: "https://auth.diegonmarcos.com", CacheTTL: time.Hour, FetchTimeout: 2 * time.Second}
}

func mint(t *testing.T, key *rsa.PrivateKey, alg string, claims map[string]any) string {
	t.Helper()
	hb, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT", "kid": "k1"})
	pb, _ := json.Marshal(claims)
	h, p := b64(hb), b64(pb)
	if alg == "none" || key == nil {
		return h + "." + p + "."
	}
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return h + "." + p + "." + b64(sig)
}

func TestBearerVerifier(t *testing.T) {
	f := newFixture(t, true)
	v := f.verifier()
	now := time.Now().Unix()
	valid := map[string]any{"iss": "https://auth.diegonmarcos.com", "sub": "diego", "scp": []string{scope}, "iat": now, "exp": now + 300}
	with := func(k string, val any) map[string]any {
		m := map[string]any{}
		for a, b := range valid {
			m[a] = b
		}
		m[k] = val
		return m
	}
	good := mint(t, f.key, "RS256", valid)

	type tc struct {
		label  string
		tok    string
		status int
		code   string
	}
	// Tampered: genuine signature, payload swapped for an escalated scope.
	parts := strings.Split(good, ".")
	esc, _ := json.Marshal(with("scp", []string{scope, "admin"}))
	tampered := parts[0] + "." + b64(esc) + "." + parts[2]
	for _, c := range []tc{
		{"garbage token", "not-a-jwt", 401, "invalid_token"},
		{"expired", mint(t, f.key, "RS256", with("exp", now-10)), 401, "invalid_token"},
		{"wrong issuer", mint(t, f.key, "RS256", with("iss", "https://evil.example.com")), 401, "invalid_token"},
		{"impostor key", mint(t, f.impostor, "RS256", valid), 401, "invalid_token"},
		{"alg none", mint(t, nil, "none", valid), 401, "invalid_token"},
		{"tampered payload", tampered, 401, "invalid_token"},
		{"not yet valid", mint(t, f.key, "RS256", with("nbf", now+3600)), 401, "invalid_token"},
		{"missing scope", mint(t, f.key, "RS256", with("scp", []string{"nope"})), 403, "insufficient_scope"},
	} {
		d := DecideAuth("Bearer "+c.tok, v.Verify, scope)
		if d.OK || d.Status != c.status || d.Code != c.code {
			t.Errorf("%s: got ok=%v %d %s, want %d %s", c.label, d.OK, d.Status, d.Code, c.status, c.code)
		}
	}
	if d := DecideAuth("Bearer "+good, v.Verify, scope); !d.OK || d.Claims["sub"] != "diego" {
		t.Fatalf("a genuine token must be accepted (key selected by kid among two): %+v", d)
	}
	// nbf within the 60 s skew is accepted, like the Node verifier.
	if d := DecideAuth("Bearer "+mint(t, f.key, "RS256", with("nbf", now+30)), v.Verify, scope); !d.OK {
		t.Errorf("nbf inside the 60 s skew must be accepted: %+v", d)
	}
}

func TestSingleKeyFallbackAndOutage(t *testing.T) {
	f := newFixture(t, false)
	now := time.Now().Unix()
	valid := map[string]any{"iss": "https://auth.diegonmarcos.com", "scp": []string{scope}, "exp": now + 300}
	// A token whose kid is unknown still verifies against a ONE-key set (Node parity).
	hb, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "rotated"})
	pb, _ := json.Marshal(valid)
	h, p := b64(hb), b64(pb)
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	v := f.verifier()
	if _, err := v.Verify(h + "." + p + "." + b64(sig)); err != nil {
		t.Fatalf("single-key set fallback: %v", err)
	}
	// Cached: a second verify does not refetch.
	before := f.hits.Load()
	if _, err := v.Verify(h + "." + p + "." + b64(sig)); err != nil || f.hits.Load() != before {
		t.Fatalf("expected a cache hit, hits %d -> %d err=%v", before, f.hits.Load(), err)
	}
	// Outage with a cold cache: 503 jwks_unavailable (OURS, distinguishable).
	g := newFixture(t, false)
	g.down.Store(true)
	tok := mint(t, g.key, "RS256", valid)
	d := DecideAuth("Bearer "+tok, g.verifier().Verify, scope)
	if d.OK || d.Status != 503 || d.Code != "jwks_unavailable" {
		t.Fatalf("cold outage: %+v", d)
	}
	// Outage after a good fetch: the last-known-good keys keep serving (2026-08-22 failure mode).
	g.down.Store(false)
	w := g.verifier()
	w.CacheTTL = time.Nanosecond
	if d := DecideAuth("Bearer "+tok, w.Verify, scope); !d.OK {
		t.Fatalf("warm fetch: %+v", d)
	}
	g.down.Store(true)
	time.Sleep(2 * time.Millisecond)
	if d := DecideAuth("Bearer "+tok, w.Verify, scope); !d.OK {
		t.Fatalf("stale keys must keep serving during an outage: %+v", d)
	}
}

func TestSessionVerifier(t *testing.T) {
	var seen http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Clone()
		switch r.Header.Get("Cookie") {
		case "authelia_session=owner":
			w.Header().Set("Remote-User", "diego")
			w.WriteHeader(200)
		case "authelia_session=nouser":
			w.WriteHeader(200)
		case "authelia_session=redirect":
			http.Redirect(w, r, "https://auth/login", 302)
		case "authelia_session=boom":
			w.WriteHeader(502)
		default:
			w.WriteHeader(401)
		}
	}))
	defer srv.Close()
	v := &SessionVerifier{VerifyURL: srv.URL, PublicURL: "https://api.diegonmarcos.com", BasePath: "/git", Timeout: time.Second}
	users := []string{"diego"}
	d := DecideSession("authelia_session=owner", func(c string) (string, error) { return v.Verify(c, "GET", "/repos") }, users)
	if !d.OK || d.User != "diego" {
		t.Fatalf("owner: %+v", d)
	}
	if seen.Get("X-Original-Url") != "https://api.diegonmarcos.com/git/repos" || seen.Get("X-Original-Method") != "GET" {
		t.Errorf("Authelia must be asked about THIS route, got %q %q", seen.Get("X-Original-Url"), seen.Get("X-Original-Method"))
	}
	for cookie, want := range map[string]string{
		"authelia_session=dead": "invalid_session", "authelia_session=nouser": "invalid_session",
		"authelia_session=redirect": "invalid_session", "authelia_session=boom": "session_unavailable",
	} {
		d := DecideSession(cookie, func(c string) (string, error) { return v.Verify(c, "GET", "/repos") }, users)
		if d.OK || d.Code != want {
			t.Errorf("%s: got %+v want %s", cookie, d, want)
		}
	}
	srv.Close()
	d = DecideSession("authelia_session=owner", func(c string) (string, error) { return v.Verify(c, "GET", "/repos") }, users)
	if d.OK || d.Code != "session_unavailable" || d.Status != 503 {
		t.Errorf("unreachable verifier must be 503: %+v", d)
	}
}

// Every service carries a byte-identical copy of this package in src/code/internal/authz; a drifted copy of a
// security-critical package fails the build.
func TestCopiesAreIdentical(t *testing.T) {
	root, _ := filepath.Abs("../../..")
	copies, _ := filepath.Glob(filepath.Join(root, "*", "src", "code", "internal", "authz"))
	files := []string{"authz.go", "bearer.go", "session.go", "mesh.go"}
	for _, dir := range copies {
		for _, f := range files {
			want, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(filepath.Join(dir, f))
			if err != nil {
				t.Errorf("%s: %v", dir, err)
				continue
			}
			if string(got) != string(want) {
				t.Errorf("%s/%s differs from _shared/go/authz/%s — copy it, never edit the copy", dir, f, f)
			}
		}
	}
	t.Log(fmt.Sprintf("%d copies checked", len(copies)))
}
