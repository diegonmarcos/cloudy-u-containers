package fleetauth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Ticket #1872: a kid that is not in a JWKS that was fetched fine is an invalid token (401),
// not an outage (503); a real fetch failure stays 503; and a kid miss may force a JWKS
// refetch at most once per RefetchEvery, so random-kid tokens cannot amplify into fetches.
// The Python live gate (infra-sec_introspect-proxy/src/test/test_jwks_unknown_kid.py) pins
// the same three cases; keep the two in step.

func jwksFixture(t *testing.T) (key *rsa.PrivateKey, doc string) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	b := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	return k, fmt.Sprintf(`{"keys":[{"kty":"RSA","kid":"k1","use":"sig","alg":"RS256","n":%q,"e":"AQAB"}]}`, b(k.N.Bytes()))
}

func tokenWithKid(t *testing.T, k *rsa.PrivateKey, kid string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"iss": "iss", "exp": time.Now().Add(time.Hour).Unix()})
	if kid != "" {
		tok.Header["kid"] = kid
	}
	s, err := tok.SignedString(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestUnknownKidIs401NotFetchFailure(t *testing.T) {
	key, okDoc := jwksFixture(t)
	cases := []struct {
		name   string
		status int
		body   string
		kid    string
		want   JWTErr
	}{
		{"unknown kid, JWKS fetched fine", 200, okDoc, "nope", JWTInvalid},
		{"no kid, JWKS fetched fine", 200, okDoc, "", JWTInvalid},
		{"fetch failure: non-2xx", 500, `{}`, "nope", JWTKeyServer},
		{"fetch failure: bad JSON", 200, `{"keys":`, "nope", JWTKeyServer}, // KeyInternal is 500 in both; see below
		{"fetch failure: no signing keys", 200, strings.Replace(okDoc, `"use":"sig"`, `"use":"enc"`, 1), "nope", JWTKeyServer},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			}))
			defer srv.Close()
			v := &Verifier{JWKS: NewJWKS(srv.URL, time.Minute, 2*time.Second), Issuer: "iss"}
			_, got := v.Verify(context.Background(), tokenWithKid(t, key, c.kid), float64(time.Now().Unix()))
			want := c.want
			if c.name == "fetch failure: bad JSON" {
				want = JWTInternal // unparsable body is a JSONDecodeError in PyJWT: 500, unchanged
			}
			if got != want {
				t.Fatalf("got %v, want %v", got, want)
			}
		})
	}
}

func TestKidMissRefetchIsRateLimited(t *testing.T) {
	key, doc := jwksFixture(t)
	var fetches atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		_, _ = w.Write([]byte(doc))
	}))
	defer srv.Close()
	now := time.Now()
	j := NewJWKS(srv.URL, time.Hour, 2*time.Second)
	j.Now = func() time.Time { return now }
	v := &Verifier{JWKS: j, Issuer: "iss"}
	verify := func(kid string) JWTErr {
		_, e := v.Verify(context.Background(), tokenWithKid(t, key, kid), float64(time.Now().Unix()))
		return e
	}

	if e := verify("k1"); e != JWTOK {
		t.Fatalf("known kid: %v", e)
	}
	base := fetches.Load() // the initial fill
	for i := 0; i < 20; i++ {
		if e := verify(fmt.Sprintf("rand-%d", i)); e != JWTInvalid {
			t.Fatalf("unknown kid %d: %v", i, e)
		}
	}
	if got := fetches.Load() - base; got != 1 {
		t.Fatalf("20 unknown kids in the window caused %d extra fetches, want exactly 1", got)
	}
	// The window reopens after RefetchEvery.
	now = now.Add(61 * time.Second)
	if e := verify("rand-late"); e != JWTInvalid {
		t.Fatalf("late unknown kid: %v", e)
	}
	if got := fetches.Load() - base; got != 2 {
		t.Fatalf("after the window: %d extra fetches, want 2", got)
	}
	// Last-known-good: the cached kid still verifies with no fetch.
	before := fetches.Load()
	if e := verify("k1"); e != JWTOK || fetches.Load() != before {
		t.Fatalf("known kid after misses: %v, fetches %d->%d", e, before, fetches.Load())
	}
}
