package tokensapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"tokens-api/fleetauth"
)

const testKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8" // 32 bytes, urlsafe, unpadded

func newApp(t *testing.T, mut func(*Config)) (*App, *int64, string) {
	t.Helper()
	clock := new(int64)
	atomic.StoreInt64(clock, 1_800_000_000)
	var ctr byte
	dir := t.TempDir()
	cfg := Config{
		DBPath: filepath.Join(dir, "t.sqlite3"), FleetKey: testKey, VerifySecret: "vsecret", OwnerEmail: "Owner@Example.org",
		AdminClientIDs: "cloud-admin", TrustedProxies: "127.0.0.0/8",
		Clock: func() float64 { return float64(atomic.LoadInt64(clock)) },
		Rand: func(n int) []byte {
			b := make([]byte, n)
			for i := range b {
				ctr++
				b[i] = ctr * 7
			}
			return b
		},
		Introspect: func(tok string) (int, string) {
			switch tok {
			case "jwt-admin":
				return 200, "cloud-admin"
			case "jwt-other":
				return 200, "someone"
			case "jwt-down":
				return 503, ""
			}
			return 401, ""
		},
	}
	if mut != nil {
		mut(&cfg)
	}
	a, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	return a, clock, cfg.DBPath
}

func call(a *App, method, path string, hdr map[string]string, body string) (int, map[string]any, string) {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:5555"
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	if got := w.Header().Get("Cache-Control"); got != "no-store" {
		panic("Cache-Control: " + got)
	}
	return w.Code, m, w.Body.String()
}

var adminHdr = map[string]string{"Authorization": "Bearer jwt-admin", "Content-Type": "application/json"}

func TestVaultSealOpenTamper(t *testing.T) {
	v, err := NewVault(testKey)
	if err != nil {
		t.Fatal(err)
	}
	nonce, ct := v.Seal("tk_0123456789", "ft_secret-value")
	if got, err := v.Open("tk_0123456789", nonce, ct); err != nil || got != "ft_secret-value" {
		t.Fatalf("round trip: %q %v", got, err)
	}
	if _, err := v.Open("tk_other", nonce, ct); err == nil {
		t.Error("a ciphertext must be bound to its token id")
	}
	bad := append([]byte(nil), ct...)
	bad[0] ^= 1
	if _, err := v.Open("tk_0123456789", nonce, bad); err == nil {
		t.Error("tampered ciphertext must not open")
	}
	other, _ := NewVault("Z" + testKey[1:])
	if _, err := other.Open("tk_0123456789", nonce, ct); err == nil {
		t.Error("another fleet key must not open it")
	}
	if v.Index("a") == v.Index("b") || v.Index("a") != v.Index("a") || other.Index("a") == v.Index("a") {
		t.Error("index must be a keyed, deterministic function of the value")
	}
	if !bytes.Equal(v.SealWith(nonce, "tk_0123456789", "ft_secret-value"), ct) {
		t.Error("fixed nonce must give the same ciphertext")
	}
}

func TestVaultKeyValidation(t *testing.T) {
	for _, k := range []string{"", "short", "%%%%"} {
		if _, err := NewVault(k); err == nil {
			t.Errorf("key %q must be refused", k)
		}
	}
	if _, err := NewVault("  " + testKey + "\n"); err != nil {
		t.Errorf("surrounding whitespace is stripped: %v", err)
	}
}

func TestFleetTokenLifecycle(t *testing.T) {
	a, clock, dbPath := newApp(t, nil)
	if c, _, _ := call(a, "GET", "/v1/tokens", nil, ""); c != 401 {
		t.Fatalf("no credential: %d", c)
	}
	for _, h := range []string{"Bearer jwt-other", "Bearer ft_nope"} {
		if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Authorization": h}, ""); c != 403 {
			t.Fatalf("%s: %d", h, c)
		}
	}
	if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Authorization": "Bearer jwt-down"}, ""); c != 503 {
		t.Fatalf("introspect down must be 503: %d", c)
	}
	c, out, _ := call(a, "POST", "/v1/tokens", adminHdr, `{"name":"bot","audience":"api.example.org, *.mesh.example.org","scopes":["read"],"ttl_days":1}`)
	if c != 201 {
		t.Fatalf("create: %d %v", c, out)
	}
	id, val := out["id"].(string), out["value"].(string)
	if !strings.HasPrefix(val, "ft_") || !strings.HasPrefix(id, "tk_") || out["status"] != "active" {
		t.Fatalf("created: %v", out)
	}
	raw, _ := os.ReadFile(dbPath)
	if wal, err := os.ReadFile(dbPath + "-wal"); err == nil {
		raw = append(raw, wal...)
	}
	if bytes.Contains(raw, []byte(val)) {
		t.Fatal("the token value must never be on disk in plaintext")
	}
	vh := map[string]string{"X-Verify-Secret": "vsecret", "Content-Type": "application/json"}
	verify := func(host string) map[string]any {
		_, m, _ := call(a, "POST", "/v1/verify", vh, `{"token":"`+val+`","host":"`+host+`"}`)
		return m
	}
	if m := verify("api.example.org:443"); m["active"] != true || m["known"] != true {
		t.Fatalf("verify: %v", m)
	}
	if m := verify("x.mesh.example.org"); m["active"] != true {
		t.Fatalf("glob audience: %v", m)
	}
	if m := verify("evil.example.com"); m["active"] != false || m["reason"] != "audience" {
		t.Fatalf("wrong audience: %v", m)
	}
	if c, _, _ := call(a, "POST", "/v1/verify", map[string]string{"X-Verify-Secret": "wrong"}, `{}`); c != 403 {
		t.Fatalf("wrong verify secret: %d", c)
	}
	// reveal returns the value; an audit row never carries it
	if c, m, _ := call(a, "POST", "/v1/tokens/"+id+"/reveal", adminHdr, ""); c != 200 || m["value"] != val {
		t.Fatalf("reveal: %d %v", c, m)
	}
	if _, _, body := call(a, "GET", "/v1/audit", adminHdr, ""); strings.Contains(body, val) {
		t.Fatal("audit leaked a token value")
	}
	// expiry
	atomic.AddInt64(clock, 2*86400)
	if m := verify("api.example.org"); m["active"] != false || m["reason"] != "expired" {
		t.Fatalf("expired: %v", m)
	}
	// revoke
	_, out2, _ := call(a, "POST", "/v1/tokens", adminHdr, `{"name":"two"}`)
	val2, id2 := out2["value"].(string), out2["id"].(string)
	call(a, "POST", "/v1/tokens/"+id2+"/revoke", adminHdr, "")
	_, m, _ := call(a, "POST", "/v1/verify", vh, `{"token":"`+val2+`"}`)
	if m["active"] != false || m["reason"] != "revoked" {
		t.Fatalf("revoked: %v", m)
	}
}

func TestAdminScopedFleetTokenAndSession(t *testing.T) {
	a, _, _ := newApp(t, nil)
	_, out, _ := call(a, "POST", "/v1/tokens", adminHdr, `{"name":"admin","scopes":["tokens:admin"]}`)
	_, plain, _ := call(a, "POST", "/v1/tokens", adminHdr, `{"name":"plain","scopes":["read"]}`)
	if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Authorization": "Bearer " + out["value"].(string)}, ""); c != 200 {
		t.Fatalf("admin-scoped ft_ token: %d", c)
	}
	if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Authorization": "Bearer " + plain["value"].(string)}, ""); c != 403 {
		t.Fatalf("ft_ token without the admin scope: %d", c)
	}
	if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Remote-Email": "owner@example.ORG"}, ""); c != 200 {
		t.Fatalf("owner session through a trusted proxy: %d", c)
	}
	if c, _, _ := call(a, "GET", "/v1/tokens", map[string]string{"Remote-Email": "intruder@example.org"}, ""); c != 401 {
		t.Fatalf("other session: %d", c)
	}
	a2, _, _ := newApp(t, func(c *Config) { c.TrustedProxies = "10.0.0.0/8" })
	if c, _, _ := call(a2, "GET", "/v1/tokens", map[string]string{"Remote-Email": "owner@example.org"}, ""); c != 401 {
		t.Fatalf("session from an untrusted peer must be refused: %d", c)
	}
}

func TestFlaskLikeRouting(t *testing.T) {
	a, _, _ := newApp(t, nil)
	r := httptest.NewRequest("GET", "/nope", nil)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != 404 || !strings.Contains(w.Body.String(), "<h1>Not Found</h1>") {
		t.Fatalf("404 page: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("DELETE", "/v1/tokens", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD, OPTIONS, POST" {
		t.Fatalf("405: %d %q", w.Code, w.Header().Get("Allow"))
	}
	w = httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != 200 || w.Body.String() != "OK" {
		t.Fatalf("health: %d %q", w.Code, w.Body.String())
	}
}

func TestNormalisers(t *testing.T) {
	if _, err := normAudience(mustJSON(`"a b"`), true); err == nil {
		t.Error("a space is not a host glob")
	}
	if got, _ := normAudience(mustJSON(`""`), true); got != "*" {
		t.Errorf("empty audience is *: %q", got)
	}
	if got, _ := normScopes(mustJSON(`"a, b  c"`)); strings.Join(got, "|") != "a|b|c" {
		t.Errorf("scope string split: %v", got)
	}
	if _, err := normScopes(mustJSON(`["ok","not ok"]`)); err == nil {
		t.Error("a scope with a space is invalid")
	}
	for _, c := range []struct {
		host, pat string
		want      bool
	}{{"a.example.org", "*.example.org", true}, {"example.org", "*.example.org", false}, {"ab", "a?", true}, {"ab", "[a-c]b", true}, {"db", "[!a-c]b", true}} {
		if fnmatchCase(c.host, c.pat) != c.want {
			t.Errorf("fnmatch(%q,%q) != %v", c.host, c.pat, c.want)
		}
	}
}

func TestStatusAndHints(t *testing.T) {
	a, _, _ := newApp(t, nil)
	_, out, _ := call(a, "POST", "/v1/tokens", adminHdr, `{"name":"n"}`)
	val := out["value"].(string)
	if out["hint"] != val[len(val)-4:] || out["kind"] != "fleet" || out["source"] != "generated" {
		t.Fatalf("metadata: %v", out)
	}
	if c, _, _ := call(a, "GET", "/v1/tokens/tk_missing", adminHdr, ""); c != http.StatusNotFound {
		t.Fatalf("unknown id: %d", c)
	}
}

func mustJSON(s string) fleetauth.Value {
	v, err := fleetauth.ParseJSON([]byte(s))
	if err != nil {
		panic(err)
	}
	return v
}
