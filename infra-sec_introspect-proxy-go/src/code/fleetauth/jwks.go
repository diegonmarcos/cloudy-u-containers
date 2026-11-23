package fleetauth

import (
	"context"
	"crypto/rsa"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"sync"
	"time"

	lru "github.com/hashicorp/golang-lru/v2"
	"golang.org/x/sync/singleflight"
)

// KeyErr classifies a JWKS failure the way the Python service's handlers see it.
type KeyErr int

const (
	KeyOK       KeyErr = iota
	KeyClient          // PyJWKClientError: the edge answers 503 "Auth key server unavailable"
	KeyInternal        // any other exception: Flask answers 500
)

// SigningKey is a usable key from the JWKS. Only an RSA public key can verify RS256; any
// other key type (EC, OKP, oct, an RSA private JWK) is kept so that a matching kid fails
// the way PyJWT fails on it (prepare_key/verify raise, not a clean signature mismatch).
type SigningKey struct {
	RSA   *rsa.PublicKey
	kid   Value
	use   Value
	ktype string
}

type parsedSet struct {
	keys []*SigningKey
	err  KeyErr
}

// JWKS reproduces PyJWT 2.9's PyJWKClient(cache_keys=True, cache_jwk_set=True, lifespan=L):
//   - the raw JWK Set document is cached for L seconds; a failed fetch clears it;
//   - a kid resolved once is kept in a 16-entry LRU that never expires, so a known key keeps
//     working while the JWKS URL is unreachable;
//   - an unknown kid forces one refetch before it is refused.
//
// Concurrent lookups of the same kid and concurrent fetches are coalesced with singleflight
// (the Python service ran single-threaded, so this only removes duplicate dials).
type JWKS struct {
	URL      string
	Lifespan time.Duration
	HTTP     *http.Client
	Now      func() time.Time // monotonic clock; time.Now by default

	mu      sync.Mutex
	set     *Value // cached document, nil when empty
	setAt   time.Time
	parsed  *parsedSet // parse of set (memoised: parsing is deterministic)
	keys    *lru.Cache[string, *SigningKey]
	sfKid   singleflight.Group
	sfFetch singleflight.Group
}

// NewJWKS builds a client; timeout bounds one fetch.
func NewJWKS(url string, lifespan, timeout time.Duration) *JWKS {
	c, _ := lru.New[string, *SigningKey](16)
	return &JWKS{URL: url, Lifespan: lifespan, HTTP: NewUpstreamClient(timeout), keys: c, Now: time.Now}
}

// NewUpstreamClient is the HTTP client used for every upstream: a total deadline per call,
// proxies from the environment (as urllib), and redirects followed only where urllib would
// follow them for the method (301/302/303; a 307/308 is an error).
func NewUpstreamClient(timeout time.Duration) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = 8
	tr.IdleConnTimeout = 30 * time.Second
	return &http.Client{
		Timeout:   timeout,
		Transport: tr,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			if c := req.Response.StatusCode; c == 307 || c == 308 {
				if req.Method != http.MethodGet && req.Method != http.MethodHead {
					return fmt.Errorf("redirect %d for %s", c, req.Method)
				}
			}
			return nil
		},
	}
}

// kidCacheKey is functools.lru_cache's key for the kid argument: equal-and-hashable values
// share an entry (1, 1.0 and True are one key); a list or dict is unhashable (TypeError).
func kidCacheKey(kid Value) (string, bool) {
	switch kid.K {
	case Null:
		return "none", true
	case Str:
		return "s:" + kid.S, true
	case Bool, Int, Float:
		return "n:" + numBig(kid).Text('g', -1), true
	}
	return "", false
}

// SigningKey is PyJWKClient.get_signing_key(kid).
func (j *JWKS) SigningKey(ctx context.Context, kid Value) (*SigningKey, KeyErr) {
	ck, ok := kidCacheKey(kid)
	if !ok {
		return nil, KeyInternal
	}
	if k, ok := j.keys.Get(ck); ok {
		return k, KeyOK
	}
	type res struct {
		k *SigningKey
		e KeyErr
	}
	v, _, _ := j.sfKid.Do(ck, func() (any, error) {
		if k, ok := j.keys.Get(ck); ok {
			return res{k, KeyOK}, nil
		}
		keys, e := j.signingKeys(ctx, false)
		if e != KeyOK {
			return res{nil, e}, nil
		}
		k := matchKid(keys, kid)
		if k == nil {
			keys, e = j.signingKeys(ctx, true)
			if e != KeyOK {
				return res{nil, e}, nil
			}
			if k = matchKid(keys, kid); k == nil {
				return res{nil, KeyClient}, nil
			}
		}
		j.keys.Add(ck, k)
		return res{k, KeyOK}, nil
	})
	r := v.(res)
	return r.k, r.e
}

func matchKid(keys []*SigningKey, kid Value) *SigningKey {
	for _, k := range keys {
		if Equal(k.kid, kid) {
			return k
		}
	}
	return nil
}

// signingKeys is get_signing_keys(refresh): the set's keys with use "sig"/absent and a kid.
func (j *JWKS) signingKeys(ctx context.Context, refresh bool) ([]*SigningKey, KeyErr) {
	var doc *Value
	var ps *parsedSet
	if !refresh {
		doc, ps = j.cached()
	}
	if doc == nil {
		var e KeyErr
		doc, ps, e = j.fetch(ctx)
		if e != KeyOK {
			return nil, e
		}
	}
	if doc == nil || doc.K != Obj {
		return nil, KeyClient // "The JWKS endpoint did not return a JSON object"
	}
	if ps == nil {
		ps = parseSet(*doc)
	}
	if ps.err != KeyOK {
		return nil, ps.err
	}
	var out []*SigningKey
	for _, k := range ps.keys {
		useOK := k.use.K == Null || Equal(k.use, S("sig"))
		if useOK && k.kid.Truthy() {
			out = append(out, k)
		}
	}
	if len(out) == 0 {
		return nil, KeyClient // "The JWKS endpoint did not contain any signing keys"
	}
	return out, KeyOK
}

func (j *JWKS) cached() (*Value, *parsedSet) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.set == nil || j.Now().Sub(j.setAt) > j.Lifespan {
		return nil, nil
	}
	if j.parsed == nil && j.set.K == Obj {
		j.parsed = parseSet(*j.set)
	}
	return j.set, j.parsed
}

func (j *JWKS) put(v *Value) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if v == nil || v.K == Null {
		j.set, j.parsed = nil, nil
		return
	}
	j.set, j.setAt, j.parsed = v, j.Now(), nil
	if v.K == Obj {
		j.parsed = parseSet(*v)
	}
}

// fetch is PyJWKClient.fetch_data: a network or HTTP failure is a PyJWKClientConnectionError
// (503); an unparsable body is a JSONDecodeError (500). Either way the cache is cleared.
func (j *JWKS) fetch(ctx context.Context) (*Value, *parsedSet, KeyErr) {
	type res struct {
		v *Value
		e KeyErr
	}
	r, _, _ := j.sfFetch.Do("jwks", func() (any, error) {
		v, e := j.fetchOnce(ctx)
		if e != KeyOK {
			j.put(nil)
			return res{nil, e}, nil
		}
		j.put(v)
		return res{v, KeyOK}, nil
	})
	out := r.(res)
	if out.e != KeyOK {
		return nil, nil, out.e
	}
	if out.v.K == Null {
		return out.v, nil, KeyOK
	}
	j.mu.Lock()
	ps := j.parsed
	if j.set != out.v || ps == nil {
		ps = nil
	}
	j.mu.Unlock()
	return out.v, ps, KeyOK
}

func (j *JWKS) fetchOnce(ctx context.Context) (*Value, KeyErr) {
	req, err := http.NewRequestWithContext(context.WithoutCancel(ctx), http.MethodGet, j.URL, nil)
	if err != nil {
		return nil, KeyClient
	}
	resp, err := j.HTTP.Do(req)
	if err != nil {
		return nil, KeyClient
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, KeyClient // urllib raises HTTPError (a URLError) for any non-2xx
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			return nil, KeyClient // TimeoutError is caught by fetch_data
		}
		return nil, KeyInternal // a reset mid-body is an OSError fetch_data does not catch
	}
	v, err := ParseJSON(body)
	if err != nil {
		return nil, KeyInternal
	}
	return &v, KeyOK
}

// parseSet is PyJWKSet.from_dict(doc): fatal problems are PyJWKSetError/TypeError etc. (500),
// unusable keys are skipped.
func parseSet(doc Value) *parsedSet {
	keys, _ := doc.Get("keys", Value{K: List, L: []Value{}})
	if !keys.Truthy() {
		return &parsedSet{err: KeyInternal} // "The JWK Set did not contain any keys"
	}
	if keys.K != List {
		return &parsedSet{err: KeyInternal} // "Invalid JWK Set value"
	}
	ps := &parsedSet{}
	for _, kv := range keys.L {
		k, skip, e := parseJWK(kv)
		if e != KeyOK {
			return &parsedSet{err: e}
		}
		if !skip {
			ps.keys = append(ps.keys, k)
		}
	}
	if len(ps.keys) == 0 {
		return &parsedSet{err: KeyInternal} // "did not contain any usable keys"
	}
	return ps
}

var pyAlgorithms = map[string]string{
	"none": "none", "HS256": "oct", "HS384": "oct", "HS512": "oct",
	"RS256": "RSA", "RS384": "RSA", "RS512": "RSA", "PS256": "RSA", "PS384": "RSA", "PS512": "RSA",
	"ES256": "EC", "ES256K": "EC", "ES384": "EC", "ES521": "EC", "ES512": "EC", "EdDSA": "OKP",
}

// parseJWK is PyJWK(jwk): (key, skip, err). skip = a PyJWTError PyJWKSet ignores.
func parseJWK(kv Value) (*SigningKey, bool, KeyErr) {
	if kv.K != Obj {
		return nil, false, KeyInternal // jwk_data.get on a non-dict: AttributeError
	}
	none := Value{K: Null}
	kty, _ := kv.Get("kty", none)
	if !kty.Truthy() {
		return nil, true, KeyOK
	}
	alg, _ := kv.Get("alg", none)
	if !alg.Truthy() {
		crv, _ := kv.Get("crv", none)
		switch {
		case Equal(kty, S("EC")):
			switch {
			case Equal(crv, S("P-256")) || !crv.Truthy():
				alg = S("ES256")
			case Equal(crv, S("P-384")):
				alg = S("ES384")
			case Equal(crv, S("P-521")):
				alg = S("ES512")
			case Equal(crv, S("secp256k1")):
				alg = S("ES256K")
			default:
				return nil, true, KeyOK
			}
		case Equal(kty, S("RSA")):
			alg = S("RS256")
		case Equal(kty, S("oct")):
			alg = S("HS256")
		case Equal(kty, S("OKP")):
			if !crv.Truthy() || !Equal(crv, S("Ed25519")) {
				return nil, true, KeyOK
			}
			alg = S("EdDSA")
		default:
			return nil, true, KeyOK
		}
	}
	if alg.K == List || alg.K == Obj {
		return nil, false, KeyInternal // unhashable in `algorithm in self._algorithms`
	}
	if alg.K != Str {
		return nil, true, KeyOK
	}
	family, ok := pyAlgorithms[alg.S]
	if !ok {
		return nil, true, KeyOK // PyJWKError: no algorithm for key
	}
	kid, _ := kv.Get("kid", none)
	use, _ := kv.Get("use", none)
	key := &SigningKey{kid: kid, use: use, ktype: family}
	switch family {
	case "none":
		return nil, false, KeyInternal // NoneAlgorithm.from_jwk: NotImplementedError
	case "oct":
		if !Equal(mustGet(kv, "kty"), S("oct")) {
			return nil, true, KeyOK
		}
		k, has := kv.O.Get("k")
		if !has {
			return nil, false, KeyInternal // KeyError
		}
		if _, e := b64Field(k); e != KeyOK {
			return nil, false, e
		}
		return key, false, KeyOK
	case "RSA":
		if !Equal(mustGet(kv, "kty"), S("RSA")) {
			return nil, true, KeyOK
		}
		_, hasD := kv.O.Get("d")
		ev, hasE := kv.O.Get("e")
		nv, hasN := kv.O.Get("n")
		if hasD && hasE && hasN {
			key.ktype = "RSA-private" // a private JWK cannot verify in PyJWT either (500 at use)
			return key, false, KeyOK
		}
		if !(hasN && hasE) {
			return nil, true, KeyOK // "Not a public or private key"
		}
		eb, e := b64Field(ev)
		if e != KeyOK {
			return nil, false, e
		}
		nb, e := b64Field(nv)
		if e != KeyOK {
			return nil, false, e
		}
		eI, nI := new(big.Int).SetBytes(eb), new(big.Int).SetBytes(nb)
		// cryptography's RSAPublicNumbers.public_key(): e >= 3, e < n, e odd (ValueError).
		if eI.Cmp(big.NewInt(3)) < 0 || eI.Cmp(nI) >= 0 || eI.Bit(0) == 0 {
			return nil, false, KeyInternal
		}
		if !eI.IsInt64() || eI.Int64() > 1<<31-1 {
			key.ktype = "RSA-unsupported" // Go's rsa.PublicKey holds an int exponent
			return key, false, KeyOK
		}
		key.RSA = &rsa.PublicKey{N: nI, E: int(eI.Int64())}
		return key, false, KeyOK
	case "EC":
		if !Equal(mustGet(kv, "kty"), S("EC")) {
			return nil, true, KeyOK
		}
		return key, false, KeyOK
	default: // OKP
		if !Equal(mustGet(kv, "kty"), S("OKP")) {
			return nil, true, KeyOK
		}
		return key, false, KeyOK
	}
}

func mustGet(o Value, k string) Value {
	v, _ := o.Get(k, Value{K: Null})
	return v
}

// b64Field is from_base64url_uint's decode step on a JWK member: str only (ASCII), lenient
// base64; anything else raises a non-PyJWT exception (500).
func b64Field(v Value) ([]byte, KeyErr) {
	if v.K != Str {
		return nil, KeyInternal
	}
	for i := 0; i < len(v.S); i++ {
		if v.S[i] >= 0x80 {
			return nil, KeyInternal
		}
	}
	b, err := B64URLDecode([]byte(v.S))
	if err != nil {
		return nil, KeyInternal
	}
	return b, KeyOK
}
