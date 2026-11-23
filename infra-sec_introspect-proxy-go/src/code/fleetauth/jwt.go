package fleetauth

import (
	"bytes"
	"context"

	"github.com/golang-jwt/jwt/v5"
)

// JWTErr is the outcome class of a JWT check, one per except-branch of the Python service.
type JWTErr int

const (
	JWTOK        JWTErr = iota
	JWTExpired          // ExpiredSignatureError -> 401 "Token expired"
	JWTIssuer           // InvalidIssuerError -> 401 "Invalid token issuer"
	JWTKeyServer        // PyJWKClientError -> 503 "Auth key server unavailable"
	JWTInvalid          // any other InvalidTokenError -> 401 "Invalid token"
	JWTInternal         // anything else -> 500
)

type loaded struct {
	header       Value
	payload      []byte
	signingInput []byte
	signature    []byte
}

// load is PyJWS._load; ok=false is a DecodeError.
func load(tok []byte) (loaded, JWTErr) {
	dot := bytes.LastIndexByte(tok, '.')
	if dot < 0 {
		return loaded{}, JWTInvalid
	}
	signingInput, crypto := tok[:dot], tok[dot+1:]
	hs, ps, ok := bytes.Cut(signingInput, []byte("."))
	if !ok {
		return loaded{}, JWTInvalid
	}
	hb, err := B64URLDecode(hs)
	if err != nil {
		return loaded{}, JWTInvalid
	}
	h, err := ParseJSON(hb)
	if err == ErrRecursion {
		return loaded{}, JWTInternal
	}
	if err != nil || h.K != Obj {
		return loaded{}, JWTInvalid
	}
	pb, err := B64URLDecode(ps)
	if err != nil {
		return loaded{}, JWTInvalid
	}
	sig, err := B64URLDecode(crypto)
	if err != nil {
		return loaded{}, JWTInvalid
	}
	return loaded{header: h, payload: pb, signingInput: signingInput, signature: sig}, JWTOK
}

// decodeComplete is api_jwt.decode_complete up to the payload: b64 check, then the payload
// must be a JSON object.
func decodeComplete(tok []byte) (loaded, *Object, JWTErr) {
	l, e := load(tok)
	if e != JWTOK {
		return l, nil, e
	}
	if b64, ok := l.header.O.Get("b64"); ok && b64.K == Bool && !b64.B {
		return l, nil, JWTInvalid // detached payload required
	}
	p, err := ParseJSON(l.payload)
	if err == ErrRecursion {
		return l, nil, JWTInternal
	}
	if err != nil || p.K != Obj {
		return l, nil, JWTInvalid
	}
	return l, p.O, JWTOK
}

// Verifier checks a JWT exactly as the Python service did:
//
//	signing_key = jwks.get_signing_key_from_jwt(token)
//	jwt.decode(token, signing_key.key, algorithms=["RS256"], issuer=ISSUER, options={"verify_aud": False})
type Verifier struct {
	JWKS   *JWKS
	Issuer string
}

// Verify returns the claims on success. now is the wall clock in seconds.
func (v *Verifier) Verify(ctx context.Context, token string, now float64) (*Object, JWTErr) {
	tok := []byte(token)
	l, claims, e := decodeComplete(tok) // get_signing_key_from_jwt: unverified decode first
	if e != JWTOK {
		return nil, e
	}
	kid, _ := l.header.Get("kid", Value{K: Null})
	key, ke := v.JWKS.SigningKey(ctx, kid)
	switch ke {
	case KeyClient:
		return nil, JWTKeyServer
	case KeyInternal:
		return nil, JWTInternal
	}
	// _verify_signature
	alg, has := l.header.O.Get("alg")
	if !has || !alg.Truthy() || !Equal(alg, S("RS256")) {
		return nil, JWTInvalid
	}
	switch key.ktype {
	case "RSA":
	case "RSA-unsupported":
		return nil, JWTInvalid
	default:
		return nil, JWTInternal // prepare_key / verify raise on a non-RSA-public key
	}
	// A signature must be exactly the modulus length: cryptography rejects one whose leading
	// zero byte was dropped, and so does crypto/rsa (the harness case short-signature-leading-zero).
	if jwt.SigningMethodRS256.Verify(string(l.signingInput), l.signature, key.RSA) != nil {
		return nil, JWTInvalid
	}
	// _validate_claims (leeway 0): iat, nbf, exp, then iss.
	if iat, ok := claims.Get("iat"); ok {
		n, ie := PyInt(iat)
		switch ie {
		case IntValueErr:
			return nil, JWTInvalid
		case IntOtherErr:
			return nil, JWTInternal
		}
		if IntCmpFloat(n, now) > 0 {
			return nil, JWTInvalid
		}
	}
	if nbf, ok := claims.Get("nbf"); ok {
		n, ie := PyInt(nbf)
		switch ie {
		case IntValueErr:
			return nil, JWTInvalid
		case IntOtherErr:
			return nil, JWTInternal
		}
		if IntCmpFloat(n, now) > 0 {
			return nil, JWTInvalid
		}
	}
	if exp, ok := claims.Get("exp"); ok {
		n, ie := PyInt(exp)
		switch ie {
		case IntValueErr:
			return nil, JWTInvalid
		case IntOtherErr:
			return nil, JWTInternal
		}
		if IntCmpFloat(n, now) <= 0 {
			return nil, JWTExpired
		}
	}
	iss, ok := claims.Get("iss")
	if !ok {
		return nil, JWTInvalid // MissingRequiredClaimError
	}
	if !Equal(iss, S(v.Issuer)) {
		return nil, JWTIssuer
	}
	return claims, JWTOK
}
