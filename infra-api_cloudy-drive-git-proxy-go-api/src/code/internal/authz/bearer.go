package authz

import (
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"
)

// BearerVerifier checks an Authelia access token: RS256 over Authelia's JWKS. Same checks as the Node
// verifyAutheliaBearer (which mirrors infra-sec_introspect-proxy): alg RS256 only, key by kid (or the
// single key of a one-key set), signature, issuer, exp, nbf with 60 s of skew. The last-known-good key set
// is served while Authelia is unreachable (the 2026-08-22 introspect-proxy outage mode).
type BearerVerifier struct {
	JWKSURL      string
	Issuer       string
	CacheTTL     time.Duration // jwks_cache_ttl_s
	FetchTimeout time.Duration // jwks_fetch_timeout_ms
	Client       *http.Client  // optional

	mu     sync.Mutex
	keys   []jwk
	at     time.Time
	loaded bool
	now    func() time.Time // test hook
}

type jwk struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	N   string `json:"n"`
	E   string `json:"e"`
}

func (v *BearerVerifier) clock() time.Time {
	if v.now != nil {
		return v.now()
	}
	return time.Now()
}

func (v *BearerVerifier) fetchJWKS() ([]jwk, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.loaded && v.clock().Sub(v.at) < v.CacheTTL {
		return v.keys, nil
	}
	keys, err := v.fetchLocked()
	if err != nil {
		// Serve the last-known-good key set rather than refetch-fail on every request.
		if v.loaded {
			return v.keys, nil
		}
		return nil, ErrJWKSUnavailable
	}
	v.keys, v.at, v.loaded = keys, v.clock(), true
	return keys, nil
}

func (v *BearerVerifier) fetchLocked() ([]jwk, error) {
	c := v.Client
	if c == nil {
		c = &http.Client{}
	}
	cc := *c
	if v.FetchTimeout > 0 {
		cc.Timeout = v.FetchTimeout
	}
	res, err := cc.Get(v.JWKSURL)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("jwks http %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var doc struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, err
	}
	if doc.Keys == nil {
		doc.Keys = []jwk{}
	}
	return doc.Keys, nil
}

func b64u(s string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
}

// Verify is the func DecideAuth takes. Any failure except ErrJWKSUnavailable is a plain "invalid".
func (v *BearerVerifier) Verify(token string) (Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("not a compact JWS")
	}
	h, p, s := parts[0], parts[1], parts[2]

	hb, err := b64u(h)
	if err != nil {
		return nil, err
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(hb, &header); err != nil {
		return nil, err
	}
	if header.Alg != "RS256" {
		return nil, fmt.Errorf("unsupported alg %s", header.Alg)
	}

	keys, err := v.fetchJWKS()
	if err != nil {
		return nil, err
	}
	var key *jwk
	for i := range keys {
		if keys[i].Kid == header.Kid {
			key = &keys[i]
			break
		}
	}
	if key == nil && len(keys) == 1 {
		key = &keys[0]
	}
	if key == nil {
		return nil, fmt.Errorf("no JWKS key for kid %s", header.Kid)
	}
	pub, err := key.rsaKey()
	if err != nil {
		return nil, err
	}
	sig, err := b64u(s)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(h + "." + p))
	if err := rsa.VerifyPKCS1v15(pub, crypto.SHA256, sum[:], sig); err != nil {
		return nil, errors.New("signature does not verify")
	}

	pb, err := b64u(p)
	if err != nil {
		return nil, err
	}
	var claims Claims
	if err := json.Unmarshal(pb, &claims); err != nil || claims == nil {
		return nil, errors.New("claims are not an object")
	}
	if iss, _ := claims["iss"].(string); iss != v.Issuer {
		return nil, fmt.Errorf("bad issuer %v", claims["iss"])
	}
	now := v.clock().Unix()
	if exp, ok := claims["exp"].(float64); ok && exp <= float64(now) {
		return nil, errors.New("expired")
	}
	if nbf, ok := claims["nbf"].(float64); ok && nbf > float64(now+60) {
		return nil, errors.New("not yet valid")
	}
	return claims, nil
}

func (k *jwk) rsaKey() (*rsa.PublicKey, error) {
	if k.Kty != "RSA" {
		return nil, errors.New("not an RSA key")
	}
	nb, err := b64u(k.N)
	if err != nil {
		return nil, err
	}
	eb, err := b64u(k.E)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(nb)
	e := new(big.Int).SetBytes(eb)
	if n.Sign() == 0 || !e.IsInt64() || e.Int64() < 3 || e.Int64() > 1<<31-1 {
		return nil, errors.New("bad RSA key")
	}
	return &rsa.PublicKey{N: n, E: int(e.Int64())}, nil
}
