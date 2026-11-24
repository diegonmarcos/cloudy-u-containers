package fleetauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
	"golang.org/x/sync/singleflight"
)

// WallClock returns the wall clock in seconds (Python time.time()).
func WallClock() float64 { return float64(time.Now().UnixNano()) / 1e9 }

func postJSONish(ctx context.Context, c *http.Client, u, ctype string, hdr map[string]string, body []byte) (Value, error) {
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return Value{}, err
	}
	req.Header.Set("Content-Type", ctype)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := c.Do(req)
	if err != nil {
		return Value{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return Value{}, fmt.Errorf("HTTPError %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return Value{}, err
	}
	return ParseJSON(b)
}

func sha(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

// ── Fleet token engine (infra-sec_cloudy-ai-tokens-api) ────────────────────

type engineEntry struct {
	freshUntil, answeredAt float64
	ans                    Value
}

// Engine asks tokens-api whether a bearer is live. Same contract as the Python service:
// a positive or negative answer is cached for CacheTTL (<= 60 s); after a failed call the
// engine is not dialled again for BreakerS; during an outage the last answer serves for up
// to StaleMax, after that ok=false (the caller decides: 503 for ft_, signature alone for a
// JWT). Concurrent asks for the same token+host share one call (singleflight); the cache is
// an expiring LRU instead of a dict that was wiped when it passed 2000 entries.
type Engine struct {
	URL, Secret        string
	CacheTTL, StaleMax float64
	BreakerS           float64
	HTTP               *http.Client
	Now                func() float64
	Log                *slog.Logger

	cache     *expirable.LRU[string, engineEntry]
	mu        sync.Mutex
	downUntil float64
	sf        singleflight.Group
}

// NewEngine builds the client. cacheTTL is clamped to 60 like TOKENS_CACHE_TTL.
func NewEngine(u, secret string, timeout time.Duration, cacheTTL, staleMax float64) *Engine {
	if cacheTTL > 60 {
		cacheTTL = 60
	}
	keep := staleMax
	if cacheTTL > keep {
		keep = cacheTTL
	}
	if keep < 1 {
		keep = 1
	}
	return &Engine{
		URL: u, Secret: secret, CacheTTL: cacheTTL, StaleMax: staleMax, BreakerS: 10,
		HTTP: NewUpstreamClient(timeout), Now: WallClock, Log: slog.Default(),
		cache: expirable.NewLRU[string, engineEntry](2000, nil, time.Duration(keep*float64(time.Second))+time.Second),
	}
}

// Reset empties the cache and closes the breaker (tests).
func (e *Engine) Reset() {
	e.cache.Purge()
	e.mu.Lock()
	e.downUntil = 0
	e.mu.Unlock()
}

// Ask is _engine_ask(token, host, adopt). ok=false means "no answer".
func (e *Engine) Ask(ctx context.Context, token, host string, adopt *Object) (Value, bool) {
	key := sha(token + "|" + host)
	now := e.Now()
	hit, has := e.cache.Get(key)
	if has && hit.freshUntil > now {
		return hit.ans, true
	}
	stale := func() (Value, bool) {
		if has && now-hit.answeredAt < e.StaleMax {
			return hit.ans, true
		}
		return Value{}, false
	}
	e.mu.Lock()
	down := e.downUntil > now
	e.mu.Unlock()
	if down {
		return stale()
	}
	type res struct {
		v   Value
		err error
	}
	r, _, _ := e.sf.Do(key, func() (any, error) {
		body := NewObject("token", S(token), "host", S(host))
		if adopt != nil && len(adopt.Keys) > 0 {
			body.set("adopt", ObjV(adopt))
		}
		v, err := postJSONish(ctx, e.HTTP, e.URL, "application/json",
			map[string]string{"X-Verify-Secret": e.Secret}, []byte(DumpJSON(ObjV(body))))
		return res{v, err}, nil
	})
	out := r.(res)
	if out.err != nil {
		e.Log.Error("token engine unreachable: " + errName(out.err))
		e.mu.Lock()
		e.downUntil = now + e.BreakerS
		e.mu.Unlock()
		return stale()
	}
	e.cache.Add(key, engineEntry{freshUntil: now + e.CacheTTL, answeredAt: now, ans: out.v})
	return out.v, true
}

func errName(err error) string {
	var ue *url.Error
	switch {
	case errors.As(err, &ue):
		if ue.Timeout() {
			return "TimeoutError"
		}
		return "URLError"
	case errors.Is(err, ErrJSON), errors.Is(err, ErrRecursion):
		return "JSONDecodeError"
	case strings.HasPrefix(err.Error(), "HTTPError"):
		return "HTTPError"
	}
	return "Error"
}

// ── MCP OAuth opaque tokens (infra-sec_mcp-oauth) ──────────────────────────

type mcpEntry struct {
	expiresAt float64
	claims    Value
}

// MCPOAuth is the RFC 7662 introspection of `mcpat_` tokens at mcp-oauth. Positive answers
// are cached for min(CacheTTL, exp-now); negative answers never are. Any failure (network,
// HTTP, JSON, a non-object answer, a non-integer exp) is an error: the caller answers 503.
type MCPOAuth struct {
	URL, Secret string
	CacheTTL    int64
	HTTP        *http.Client
	Now         func() float64

	cache *expirable.LRU[string, mcpEntry]
	sf    singleflight.Group
}

// NewMCPOAuth builds the client.
func NewMCPOAuth(u, secret string, timeout time.Duration, cacheTTL int64) *MCPOAuth {
	keep := time.Duration(cacheTTL)*time.Second + time.Second
	return &MCPOAuth{URL: u, Secret: secret, CacheTTL: cacheTTL, HTTP: NewUpstreamClient(timeout), Now: WallClock,
		cache: expirable.NewLRU[string, mcpEntry](1000, nil, keep)}
}

// Introspect is _mcp_introspect(token).
func (m *MCPOAuth) Introspect(ctx context.Context, token string) (Value, error) {
	key := sha(token)
	if hit, ok := m.cache.Get(key); ok && hit.expiresAt > m.Now() {
		return hit.claims, nil
	}
	type res struct {
		v   Value
		err error
	}
	r, _, _ := m.sf.Do(key, func() (any, error) {
		form := url.Values{"token": {token}}.Encode()
		v, err := postJSONish(ctx, m.HTTP, m.URL, "application/x-www-form-urlencoded",
			map[string]string{"X-Introspect-Secret": m.Secret}, []byte(form))
		if err != nil {
			return res{err: err}, nil
		}
		active, isDict := v.Get("active", Value{K: Null})
		if !isDict {
			return res{err: errors.New("AttributeError")}, nil
		}
		if active.Truthy() {
			expV, _ := v.Get("exp", Value{K: Int, I: big.NewInt(0)})
			exp, ie := PyInt(expV)
			if ie != IntOK {
				return res{err: errors.New("bad exp")}, nil
			}
			now := m.Now()
			left := new(big.Int).Sub(exp, big.NewInt(int64(now)))
			ttl := m.CacheTTL
			if left.Cmp(big.NewInt(ttl)) < 0 {
				ttl = left.Int64()
			}
			if ttl < 0 {
				ttl = 0
			}
			m.cache.Add(key, mcpEntry{expiresAt: m.Now() + float64(ttl), claims: v})
		}
		return res{v: v}, nil
	})
	out := r.(res)
	return out.v, out.err
}
