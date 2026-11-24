// Package authz is the Go port of the fleet's shared authz.mjs (identical copies live in
// infra-api_cloudy-drive-git-proxy-api and infra-api_cloud-me-api) plus the JWKS RS256 bearer verifier, the
// Authelia session verifier and the mesh CIDR gate that sit next to it in their index.mjs/upstream.mjs.
//
// It is security-critical and therefore ported ONCE. The canonical copy is _shared/go/authz; every Go
// service carries a byte-identical copy in src/code/internal/authz (Go cannot import across service build
// contexts) and TestCopiesAreIdentical fails the build when one drifts. Parity with the Node reference is
// proved by parity/parity_test.go (same decision corpus through authz.mjs and this package).
//
// Standard library only.
package authz

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Scheme is the only accepted Authorization scheme (case-sensitive, like the Node original).
const Scheme = "Bearer "

// ErrJWKSUnavailable marks a failure that is OURS (the key server cannot be reached), so the caller
// answers 503 and the client retries here instead of giving up on the route.
var ErrJWKSUnavailable = errors.New("jwks unavailable")

// ErrSessionUnavailable is the same distinction for the Authelia session verifier.
var ErrSessionUnavailable = errors.New("session verifier unavailable")

// Claims are the decoded JWT claims.
type Claims map[string]any

// Decision is the result of an authorization decision. OK=false carries Status and a {error, code} body.
type Decision struct {
	OK     bool
	Claims Claims // set on a bearer accept
	User   string // set on a session accept
	Status int
	Code   string
	Error  string
}

// Body is the JSON refusal body, key order identical to the Node object literal {error, code}.
func (d Decision) Body() []byte {
	b, _ := json.Marshal(struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{d.Error, d.Code})
	return b
}

func refuse(status int, code, msg string) Decision {
	return Decision{OK: false, Status: status, Code: code, Error: msg}
}

var asciiToken = regexp.MustCompile(`^[\x21-\x7e]+$`)

// jsTrim mirrors String.prototype.trim (the JS WhiteSpace + LineTerminator set), which differs from
// strings.TrimSpace (U+FEFF is trimmed by JS; U+0085 is trimmed by Go but not by JS).
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
			return true
		}
		return r >= 0x2000 && r <= 0x200A
	})
}

// DecideAuth is authz.mjs decideAuth: the bearer path as a pure function of (header, verify, scope).
// A refusal is ALWAYS non-2xx with {error, code} (#568).
func DecideAuth(authHeader string, verify func(token string) (Claims, error), requiredScope string) Decision {
	if authHeader == "" {
		return refuse(401, "missing_authorization", "Authorization header required")
	}
	if !strings.HasPrefix(authHeader, Scheme) {
		return refuse(401, "bad_scheme", "Authorization must use the "+strings.TrimSpace(Scheme)+" scheme")
	}
	token := jsTrim(authHeader[len(Scheme):])
	if token == "" {
		return refuse(401, "empty_token", "Bearer token is empty")
	}
	// A JWT is always ASCII. Rejecting rather than stripping: a token we had to repair is a token we
	// cannot claim to have verified.
	if !asciiToken.MatchString(token) {
		return refuse(401, "malformed_token", "Bearer token is not a valid JWT")
	}
	claims, err := verify(token)
	if err != nil {
		if errors.Is(err, ErrJWKSUnavailable) {
			return refuse(503, "jwks_unavailable", "Cannot reach the auth key server")
		}
		return refuse(401, "invalid_token", "Bearer token failed verification")
	}
	if requiredScope != "" && !contains(ScopesOf(claims), requiredScope) {
		return refuse(403, "insufficient_scope", "Token lacks the "+requiredScope+" scope")
	}
	return Decision{OK: true, Claims: claims}
}

// DecideSession is authz.mjs decideSession: the cookie path for a caller holding an Authelia portal login.
// verify asks Authelia whether the cookie is a live session; the user it names must be declared.
func DecideSession(cookie string, verify func(cookie string) (string, error), users []string) Decision {
	if cookie == "" {
		return refuse(401, "missing_authorization", "Authorization header or an Authelia session required")
	}
	user, err := verify(cookie)
	if err != nil {
		if errors.Is(err, ErrSessionUnavailable) {
			return refuse(503, "session_unavailable", "Cannot reach the session verifier")
		}
		return refuse(401, "invalid_session", "The Authelia session is not valid for this route")
	}
	if !contains(users, user) {
		return refuse(403, "user_not_allowed", "This Authelia user is not declared for this service")
	}
	return Decision{OK: true, User: user}
}

// ScopesOf reads scopes the way authz.mjs does: scp array, else scp string, else scope string; never
// permissive on anything else.
func ScopesOf(claims Claims) []string {
	if claims == nil {
		return []string{}
	}
	if v, ok := claims["scp"]; ok {
		switch s := v.(type) {
		case []any:
			out := make([]string, 0, len(s))
			for _, e := range s {
				if str, ok := e.(string); ok {
					out = append(out, str)
				} else {
					out = append(out, "\x00non-string") // never equals a real scope
				}
			}
			return out
		case string:
			return strings.Split(s, " ")
		}
	}
	if s, ok := claims["scope"].(string); ok {
		return strings.Split(s, " ")
	}
	return []string{}
}

func contains(list []string, v string) bool {
	for _, e := range list {
		if e == v {
			return true
		}
	}
	return false
}
