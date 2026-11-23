// Package shadow compares the decisions of two introspect-proxy implementations (the Python
// reference and this Go port) request by request: status, body, content type, Allow and
// every X-Auth-* header Caddy copies. It is used twice:
//
//   - the CI harness (shadow_harness_test.go) runs both implementations against fake
//     upstreams over a broad fixture set, including signed tokens;
//   - the live shadow stage (Loop) runs on gcp-proxy next to the Python container, against
//     the real Authelia JWKS and tokens-api, with fixtures built from public data only.
package shadow

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Case is one request.
type Case struct {
	Name    string
	Method  string
	Path    string
	Headers [][2]string // raw values (bytes), sent as is
}

// Result is what Caddy can observe from one answer.
type Result struct {
	Status  int
	Body    string
	CT      string
	Allow   string // normalised (sorted set): Werkzeug's order is hash-randomised
	XAuth   string // X-Auth-* name=value pairs, sorted
	ConnErr string
}

func (r Result) String() string {
	if r.ConnErr != "" {
		return "conn-error"
	}
	b := r.Body
	if len(b) > 60 {
		b = b[:60] + "..."
	}
	return fmt.Sprintf("%d %q ct=%q allow=%q %s", r.Status, b, r.CT, r.Allow, r.XAuth)
}

// AuthHeaders are the response headers that matter to the edge.
var AuthHeaders = []string{"X-Auth-User", "X-Auth-Subject", "X-Auth-Email", "X-Auth-Scopes", "X-Auth-Client"}

// Do sends c to base and records the observable answer.
func Do(ctx context.Context, cl *http.Client, base string, c Case) Result {
	req, err := http.NewRequestWithContext(ctx, c.Method, base+c.Path, nil)
	if err != nil {
		return Result{ConnErr: err.Error()}
	}
	for _, h := range c.Headers {
		req.Header.Add(h[0], h[1])
	}
	resp, err := cl.Do(req)
	if err != nil {
		return Result{ConnErr: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	var xa []string
	for _, k := range AuthHeaders {
		if vs, ok := resp.Header[k]; ok {
			xa = append(xa, k+"="+strings.Join(vs, ","))
		}
	}
	sort.Strings(xa)
	allow := ""
	if a := resp.Header.Get("Allow"); a != "" {
		parts := strings.Split(a, ",")
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}
		sort.Strings(parts)
		allow = strings.Join(parts, ", ")
	}
	return Result{Status: resp.StatusCode, Body: string(body), CT: resp.Header.Get("Content-Type"), Allow: allow, XAuth: strings.Join(xa, " ")}
}

// Same reports whether two answers are the same decision.
func Same(a, b Result) bool {
	if a.ConnErr != "" || b.ConnErr != "" {
		return a.ConnErr != "" && b.ConnErr != ""
	}
	return a.Status == b.Status && a.Body == b.Body && a.CT == b.CT && a.Allow == b.Allow && a.XAuth == b.XAuth
}

// NewClient is a plain client that never follows redirects.
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// B64 is unpadded base64url.
func B64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// RawJWT assembles a token from raw JSON header/payload text and signature bytes.
func RawJWT(header, payload string, sig []byte) string {
	return B64([]byte(header)) + "." + B64([]byte(payload)) + "." + B64(sig)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func bearer(v string) [][2]string { return [][2]string{{"Authorization", v}} }

// LiveCases is the fixture set for the live shadow stage. Nothing in it is a credential:
// the JWTs carry the live kid but a garbage signature, the ft_ tokens are random.
func LiveCases(kid, issuer string) []Case {
	exp := time.Now().Add(time.Hour).Unix()
	claims := fmt.Sprintf(`{"iss":%q,"exp":%d,"client_id":"shadow-compare","scp":["authelia.bearer.authz"]}`, issuer, exp)
	junkSig := []byte("shadow-compare-not-a-signature-" + randHex(8))
	kidHdr := func(alg string) string { return fmt.Sprintf(`{"alg":%q,"kid":%q,"typ":"JWT"}`, alg, kid) }
	cases := []Case{
		{Name: "health", Method: "GET", Path: "/health"},
		{Name: "health-head", Method: "HEAD", Path: "/health"},
		{Name: "health-post-405", Method: "POST", Path: "/health"},
		{Name: "health-options", Method: "OPTIONS", Path: "/health"},
		{Name: "unknown-path-404", Method: "GET", Path: "/nope"},
		{Name: "auth-trailing-slash-404", Method: "GET", Path: "/auth/"},
		{Name: "auth-options", Method: "OPTIONS", Path: "/auth"},
		{Name: "auth-trace-405", Method: "TRACE", Path: "/auth"},
		{Name: "no-authorization", Method: "GET", Path: "/auth"},
		{Name: "no-authorization-put", Method: "PUT", Path: "/auth"},
		{Name: "basic-scheme", Method: "GET", Path: "/auth", Headers: bearer("Basic Zm9vOmJhcg==")},
		{Name: "lowercase-bearer", Method: "GET", Path: "/auth", Headers: bearer("bearer abc")},
		{Name: "bearer-only", Method: "GET", Path: "/auth", Headers: bearer("Bearer")},
		{Name: "bearer-spaces", Method: "GET", Path: "/auth", Headers: bearer("Bearer     ")},
		{Name: "not-a-jwt", Method: "GET", Path: "/auth", Headers: bearer("Bearer abc")},
		{Name: "two-segments", Method: "GET", Path: "/auth", Headers: bearer("Bearer a.b")},
		{Name: "bad-segments", Method: "GET", Path: "/auth", Headers: bearer("Bearer a.b.c")},
		{Name: "header-not-object", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(`[1]`, claims, junkSig))},
		{Name: "payload-not-object", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(kidHdr("RS256"), `"x"`, junkSig))},
		{Name: "b64-false", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(fmt.Sprintf(`{"alg":"RS256","kid":%q,"b64":false}`, kid), claims, junkSig))},
		{Name: "live-kid-bad-signature", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(kidHdr("RS256"), claims, junkSig))},
		{Name: "live-kid-hs256", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(kidHdr("HS256"), claims, junkSig))},
		{Name: "live-kid-alg-none", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(kidHdr("none"), claims, nil))},
		{Name: "live-kid-no-alg", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(fmt.Sprintf(`{"kid":%q}`, kid), claims, junkSig))},
		{Name: "live-kid-padded-token", Method: "GET", Path: "/auth", Headers: bearer("Bearer    " + RawJWT(kidHdr("RS256"), claims, junkSig) + "   ")},
		{Name: "unknown-kid-503", Method: "GET", Path: "/auth", Headers: bearer("Bearer " + RawJWT(`{"alg":"RS256","kid":"shadow-unknown-kid"}`, claims, junkSig))},
		{Name: "fleet-token-unknown", Method: "GET", Path: "/auth", Headers: [][2]string{{"Authorization", "Bearer ft_shadow" + randHex(16)}, {"X-Forwarded-Host", "c3-pvt.diegonmarcos.com"}}},
		{Name: "fleet-token-latin1-bytes", Method: "GET", Path: "/auth", Headers: bearer("Bearer ft_shadow\xe9" + randHex(16))},
		{Name: "mcp-oauth-token", Method: "GET", Path: "/auth", Headers: bearer("Bearer mcpat_shadow" + randHex(16))},
	}
	return cases
}

// Report is the outcome of one comparison run.
type Report struct {
	Cases      int
	Mismatches []string
}

// Run sends every case to both bases (reference first) and retries a mismatch twice after
// the engine breaker window, so a single tokens-api blip on one side is not a verdict.
func Run(ctx context.Context, ref, cand string, cases []Case, retryAfter time.Duration) Report {
	cl := NewClient(15 * time.Second)
	rep := Report{Cases: len(cases)}
	for _, c := range cases {
		var a, b Result
		same := false
		for attempt := 0; attempt < 3 && !same; attempt++ {
			if attempt > 0 {
				select {
				case <-ctx.Done():
					return rep
				case <-time.After(retryAfter):
				}
			}
			a = Do(ctx, cl, ref, c)
			b = Do(ctx, cl, cand, c)
			same = Same(a, b)
		}
		if !same {
			rep.Mismatches = append(rep.Mismatches, fmt.Sprintf("%s: reference=%s candidate=%s", c.Name, a, b))
		}
	}
	return rep
}

// LiveKid reads the first signing kid from the JWKS (public data).
func LiveKid(ctx context.Context, jwksURL string) (string, error) {
	cl := NewClient(5 * time.Second)
	req, err := http.NewRequestWithContext(ctx, "GET", jwksURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := cl.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	s := string(b)
	i := strings.Index(s, `"kid"`)
	if i < 0 {
		return "", fmt.Errorf("no kid in JWKS")
	}
	rest := s[i+5:]
	q1 := strings.Index(rest, `"`)
	if q1 < 0 {
		return "", fmt.Errorf("bad JWKS")
	}
	rest = rest[q1+1:]
	q2 := strings.Index(rest, `"`)
	if q2 < 0 {
		return "", fmt.Errorf("bad JWKS")
	}
	return rest[:q2], nil
}

// Loop runs the live comparison after a short warm-up and then every interval, logging one
// verdict line per run ("shadow-compare ...") and one line per mismatch.
func Loop(ctx context.Context, log *slog.Logger, self, ref, jwksURL, issuer string, every time.Duration) {
	wait := 45 * time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		wait = every
		kid, err := LiveKid(ctx, jwksURL)
		if err != nil {
			log.Error("shadow-compare: cannot read live kid", "err", err)
			continue
		}
		rep := Run(ctx, ref, self, LiveCases(kid, issuer), 11*time.Second)
		verdict := "PASS"
		if len(rep.Mismatches) > 0 {
			verdict = "FAIL"
		}
		log.Info(fmt.Sprintf("shadow-compare %s: %d cases, %d mismatches (reference %s)", verdict, rep.Cases, len(rep.Mismatches), ref))
		for _, m := range rep.Mismatches {
			log.Warn("shadow-mismatch " + m)
		}
	}
}
