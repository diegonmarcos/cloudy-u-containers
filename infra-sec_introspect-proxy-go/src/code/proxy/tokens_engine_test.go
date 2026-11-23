package proxy

// Port of infra-sec_introspect-proxy/src/test/test_tokens_engine.py (the contract of the
// Python service): revocation reaches the edge within the cache window; fail modes. Plus
// the Go-only guarantees: concurrent identical lookups share one upstream call.

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"introspect-proxy/fleetauth"
	"introspect-proxy/shadow"
)

type fakeEngine struct {
	mu     sync.Mutex
	active map[string]bool
	down   bool
	calls  atomic.Int64
	delay  time.Duration
	srv    *httptest.Server
}

func newFakeEngine(t *testing.T) *fakeEngine {
	e := &fakeEngine{active: map[string]bool{}}
	e.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.calls.Add(1)
		if e.delay > 0 {
			time.Sleep(e.delay)
		}
		var body struct{ Token, Host string }
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		e.mu.Lock()
		down, act := e.down, e.active[body.Token]
		e.mu.Unlock()
		if down {
			http.Error(w, "down", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"active": act, "id": "tk_1", "name": "ci", "scopes": []string{"a"}, "reason": "revoked"})
	}))
	t.Cleanup(e.srv.Close)
	return e
}

func (e *fakeEngine) set(tok string, on bool) { e.mu.Lock(); e.active[tok] = on; e.mu.Unlock() }
func (e *fakeEngine) clear()                  { e.mu.Lock(); e.active = map[string]bool{}; e.mu.Unlock() }
func (e *fakeEngine) setDown(d bool)          { e.mu.Lock(); e.down = d; e.mu.Unlock() }

type testKey struct {
	priv *rsa.PrivateKey
	kid  string
}

func newKey(t *testing.T, kid string) testKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return testKey{k, kid}
}

func (k testKey) jwk() map[string]any {
	return map[string]any{"kty": "RSA", "kid": k.kid, "use": "sig", "alg": "RS256",
		"n": shadow.B64(k.priv.N.Bytes()), "e": shadow.B64(big.NewInt(int64(k.priv.E)).Bytes())}
}

func (k testKey) sign(t *testing.T, header, payload string) string {
	si := shadow.B64([]byte(header)) + "." + shadow.B64([]byte(payload))
	h := sha256.Sum256([]byte(si))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k.priv, crypto.SHA256, h[:])
	if err != nil {
		t.Fatal(err)
	}
	return si + "." + shadow.B64(sig)
}

type env struct {
	cfg  *Config
	eng  *fakeEngine
	now  *float64
	key  testKey
	jwks *atomic.Int64
	h    http.Handler
}

const issuer = "https://auth.diegonmarcos.com"

func newEnv(t *testing.T, withEngine bool) *env {
	t.Helper()
	key := newKey(t, "k1")
	fetches := &atomic.Int64{}
	js := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{key.jwk()}})
	}))
	t.Cleanup(js.Close)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	lookup := map[string]string{"JWKS_URL": js.URL}
	e := &env{key: key, jwks: fetches}
	now := 1000.0
	e.now = &now
	if withEngine {
		e.eng = newFakeEngine(t)
		lookup["TOKENS_VERIFY_URL"] = e.eng.srv.URL
		lookup["TOKENS_VERIFY_SECRET"] = "s"
	}
	cfg, err := FromEnv(func(k string) (string, bool) { v, ok := lookup[k]; return v, ok }, log)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Engine != nil {
		cfg.Engine.Now = func() float64 { return *e.now }
	}
	e.cfg, e.h = cfg, Handler(cfg)
	return e
}

func (e *env) call(t *testing.T, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest("GET", "/auth", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	return w
}

func (e *env) jwt(t *testing.T) string {
	return e.key.sign(t, `{"alg":"RS256","kid":"k1","typ":"JWT"}`,
		fmt.Sprintf(`{"iss":%q,"client_id":"dagu-cc","sub":"d","exp":%d,"scp":["authelia.bearer.authz"]}`, issuer, int64(1)<<31))
}

func expect(t *testing.T, w *httptest.ResponseRecorder, code int) {
	t.Helper()
	if w.Code != code {
		t.Fatalf("status %d, want %d (body %q)", w.Code, code, w.Body.String())
	}
}

func TestFleetTokenActiveThenRevokedWithinCacheWindow(t *testing.T) {
	e := newEnv(t, true)
	e.eng.set("ft_abc", true)
	expect(t, e.call(t, "ft_abc"), 200)
	e.eng.clear()                       // owner revokes
	expect(t, e.call(t, "ft_abc"), 200) // still inside the cache window
	*e.now += e.cfg.Engine.CacheTTL + 1
	expect(t, e.call(t, "ft_abc"), 401) // rejected once the window passes
	if e.cfg.Engine.CacheTTL > 60 {
		t.Fatal("TOKENS_CACHE_TTL must be <= 60")
	}
}

func TestCacheTTLClampedTo60(t *testing.T) {
	en := fleetauth.NewEngine("http://x", "", time.Second, 600, 300)
	if en.CacheTTL != 60 {
		t.Fatalf("cache ttl %v", en.CacheTTL)
	}
}

func TestUnknownFleetTokenRejected(t *testing.T) {
	e := newEnv(t, true)
	expect(t, e.call(t, "ft_nope"), 401)
}

func TestFleetTokenFailsClosedWhenEngineDown(t *testing.T) {
	e := newEnv(t, true)
	e.eng.setDown(true)
	expect(t, e.call(t, "ft_abc"), 503)
}

func TestStaleAnswerServesBrieflyThenCloses(t *testing.T) {
	e := newEnv(t, true)
	e.eng.set("ft_abc", true)
	expect(t, e.call(t, "ft_abc"), 200)
	e.eng.setDown(true)
	*e.now += e.cfg.Engine.CacheTTL + 1
	expect(t, e.call(t, "ft_abc"), 200) // engine blip: last answer
	*e.now += e.cfg.Engine.StaleMax
	expect(t, e.call(t, "ft_abc"), 503) // too old: closed
}

func TestHeadersCarryNameAndScopes(t *testing.T) {
	e := newEnv(t, true)
	e.eng.set("ft_abc", true)
	w := e.call(t, "ft_abc")
	if w.Header().Get("X-Auth-User") != "ci" || w.Header().Get("X-Auth-Scopes") != "a" {
		t.Fatalf("headers %v", w.Header())
	}
}

func TestEngineOffKeepsOldBehaviour(t *testing.T) {
	e := newEnv(t, false)
	expect(t, e.call(t, "ft_abc"), 401)
}

func TestAutheliaJWTRevokedInEngineIsRejectedAfterWindow(t *testing.T) {
	e := newEnv(t, true)
	tok := e.jwt(t)
	e.eng.set(tok, true)
	w := e.call(t, tok)
	expect(t, w, 200)
	if w.Header().Get("X-Auth-User") != "dagu-cc" || w.Header().Get("X-Auth-Subject") != "d" || w.Header().Get("X-Auth-Email") != "dagu-cc" {
		t.Fatalf("headers %v", w.Header())
	}
	e.eng.clear() // owner revokes the adopted JWT
	*e.now += e.cfg.Engine.CacheTTL + 1
	expect(t, e.call(t, tok), 401)
}

func TestAutheliaJWTSurvivesEngineOutage(t *testing.T) {
	e := newEnv(t, true)
	e.eng.setDown(true)
	expect(t, e.call(t, e.jwt(t)), 200) // signature alone, as before the engine existed
}

func TestDeadEngineIsNotRedialledForAFewSeconds(t *testing.T) {
	e := newEnv(t, true)
	e.eng.setDown(true)
	expect(t, e.call(t, "ft_abc"), 503)
	n := e.eng.calls.Load()
	expect(t, e.call(t, "ft_other"), 503)
	if e.eng.calls.Load() != n {
		t.Fatal("breaker open: the engine was dialled again")
	}
	*e.now += e.cfg.Engine.BreakerS + 1
	e.eng.setDown(false)
	e.eng.set("ft_other", true)
	expect(t, e.call(t, "ft_other"), 200)
}

// Go-only: N concurrent requests for one token make one engine call (singleflight), where the
// single-threaded Python service queued them behind each other.
func TestConcurrentLookupsShareOneEngineCall(t *testing.T) {
	e := newEnv(t, true)
	e.eng.set("ft_burst", true)
	e.eng.delay = 300 * time.Millisecond
	var wg sync.WaitGroup
	codes := make([]int, 20)
	for i := range codes {
		wg.Add(1)
		go func(i int) { defer wg.Done(); codes[i] = e.call(t, "ft_burst").Code }(i)
	}
	wg.Wait()
	for _, c := range codes {
		if c != 200 {
			t.Fatalf("codes %v", codes)
		}
	}
	if n := e.eng.calls.Load(); n != 1 {
		t.Fatalf("engine calls %d, want 1", n)
	}
}

// Go-only: a slow engine no longer stalls unrelated requests (health stays immediate).
func TestSlowEngineDoesNotBlockHealth(t *testing.T) {
	e := newEnv(t, true)
	e.eng.delay = 2 * time.Second
	go e.call(t, "ft_slow")
	time.Sleep(50 * time.Millisecond)
	start := time.Now()
	r := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()
	e.h.ServeHTTP(w, r)
	if w.Code != 200 || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("health %d after %v", w.Code, time.Since(start))
	}
}

// Go-only: concurrent first sight of one kid fetches the JWKS once.
func TestConcurrentJWKSFetchIsCoalesced(t *testing.T) {
	e := newEnv(t, false)
	tok := e.jwt(t)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); expect(t, e.call(t, tok), 200) }()
	}
	wg.Wait()
	if n := e.jwks.Load(); n != 1 {
		t.Fatalf("jwks fetches %d, want 1", n)
	}
}

func TestEngineTimeoutIsBounded(t *testing.T) {
	e := newEnv(t, true)
	e.cfg.Engine.HTTP.Timeout = 200 * time.Millisecond
	e.eng.delay = 2 * time.Second
	start := time.Now()
	expect(t, e.call(t, "ft_slow"), 503)
	if time.Since(start) > time.Second {
		t.Fatalf("took %v", time.Since(start))
	}
}
