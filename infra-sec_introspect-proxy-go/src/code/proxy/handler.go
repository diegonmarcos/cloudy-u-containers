// Package proxy is the HTTP surface of introspect-proxy: the Caddy forward_auth target for
// every Bearer request on the fleet edge.
//
// Contract (unchanged from the Python/Flask service it replaces, infra-sec_introspect-proxy):
//
//	/auth   GET POST PUT PATCH DELETE (+ HEAD, OPTIONS as Flask adds them)
//	        200 "OK" + X-Auth-User / X-Auth-Subject / X-Auth-Email (+ X-Auth-Scopes | X-Auth-Client)
//	        401 "No Bearer token" | "Invalid token" | "Token expired" | "Invalid token issuer" | "Token revoked"
//	        403 "Insufficient scope"
//	        503 "Auth key server unavailable" | "Auth server unavailable"
//	/health GET (+ HEAD, OPTIONS) 200 "OK"
//	other   404 / 405 with Werkzeug's pages
//
// Responses also reproduce what Flask and gunicorn did with odd values (a claim that is not
// a string is sent as Python's str() of it, a header value with a control character is
// gunicorn's 400 page, a non-latin-1 value its 500 page), so a decision never changes.
package proxy

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"introspect-proxy/fleetauth"
)

// Config wires the checks. MCP and Engine are nil when their URL is unset (feature off).
type Config struct {
	RequiredScope string
	Verifier      *fleetauth.Verifier
	MCP           *fleetauth.MCPOAuth
	Engine        *fleetauth.Engine
	Now           func() float64
	Log           *slog.Logger
}

const (
	ctHTML = "text/html; charset=utf-8"

	body404 = "<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n"
	body405 = "<!doctype html>\n<html lang=en>\n<title>405 Method Not Allowed</title>\n<h1>Method Not Allowed</h1>\n<p>The method is not allowed for the requested URL.</p>\n"
	body500 = "<!doctype html>\n<html lang=en>\n<title>500 Internal Server Error</title>\n<h1>Internal Server Error</h1>\n<p>The server encountered an internal error and was unable to complete your request. Either the server is overloaded or there is an error in the application.</p>\n"

	allowAuth   = "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT"
	allowHealth = "GET, HEAD, OPTIONS"

	// gunicorn 21.2 defaults
	limitFieldSize = 8190
	limitFields    = 100
)

type hdr struct{ k, v string }

// resp is a Flask response before gunicorn writes it; internal = the view raised.
type resp struct {
	status   int
	body     string
	headers  []hdr
	internal bool
}

func text(status int, body string, h ...hdr) resp {
	return resp{status: status, body: body, headers: h}
}

var errInternal = resp{internal: true}

// Handler returns the http.Handler.
func Handler(c *Config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if g, ok := gunicornRequestLimits(r); ok {
			writeGunicornError(w, g.status, g.reason, g.mesg)
			return
		}
		var out resp
		switch r.URL.Path {
		case "/auth":
			switch r.Method {
			case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodHead:
				out = c.auth(r)
			case http.MethodOptions:
				out = text(200, "", hdr{"Allow", allowAuth})
			default:
				out = text(405, body405, hdr{"Allow", allowAuth})
			}
		case "/health":
			switch r.Method {
			case http.MethodGet, http.MethodHead:
				out = text(200, "OK")
			case http.MethodOptions:
				out = text(200, "", hdr{"Allow", allowHealth})
			default:
				out = text(405, body405, hdr{"Allow", allowHealth})
			}
		default:
			out = text(404, body404)
		}
		write(w, out)
	})
}

type gerr struct {
	status       int
	reason, mesg string
}

// gunicornRequestLimits reproduces gunicorn's request header limits (field size, count).
func gunicornRequestLimits(r *http.Request) (gerr, bool) {
	n := 0
	for k, vs := range r.Header {
		for _, v := range vs {
			n++
			if len(k)+2+len(v)+2 > limitFieldSize {
				return gerr{431, "Request Header Fields Too Large", "Error parsing headers: 'limit request headers fields size'"}, true
			}
		}
	}
	if n+1 > limitFields { // + Host, which Go keeps out of r.Header
		return gerr{431, "Request Header Fields Too Large", "Error parsing headers: 'limit request headers fields'"}, true
	}
	return gerr{}, false
}

// header is Werkzeug's request.headers.get(name, ""): gunicorn decodes latin-1, strips each
// value and joins repeated headers with ",".
func header(r *http.Request, name string) string {
	vs := r.Header.Values(name)
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = fleetauth.PyStrip(fleetauth.Latin1ToStr(v))
	}
	return strings.Join(parts, ",")
}

func (c *Config) auth(r *http.Request) resp {
	authz := header(r, "Authorization")
	if !strings.HasPrefix(authz, "Bearer ") {
		return text(401, "No Bearer token")
	}
	token := fleetauth.PyStrip(authz[len("Bearer "):])
	if !isASCII(token) {
		c.Log.Warn(fmt.Sprintf("Non-ASCII chars in token (len=%d), stripping", len(fleetauth.CodePoints(token))))
		token = keepASCII(token)
	}
	ctx := r.Context()
	host := header(r, "X-Forwarded-Host")
	switch {
	case strings.HasPrefix(token, "mcpat_"):
		return c.mcpOAuth(ctx, token)
	case strings.HasPrefix(token, "ft_"):
		return c.fleetToken(ctx, token, host)
	}
	return c.jwt(ctx, token, host)
}

func (c *Config) mcpOAuth(ctx context.Context, token string) resp {
	if c.MCP == nil {
		return text(401, "Invalid token")
	}
	claims, err := c.MCP.Introspect(ctx, token)
	if err != nil {
		c.Log.Error("MCP OAuth introspection failed: " + err.Error())
		return text(503, "Auth server unavailable")
	}
	active, _ := claims.Get("active", fleetauth.Value{})
	if !active.Truthy() {
		return text(401, "Invalid token")
	}
	empty := fleetauth.S("")
	sub, _ := claims.Get("sub", empty)
	client, _ := claims.Get("client_id", empty)
	c.Log.Info(fmt.Sprintf("MCP OAuth token valid for client: %s, sub: %s", fleetauth.PyStr(client), fleetauth.PyStr(sub)))
	return okWith(
		hdr{"X-Auth-User", fleetauth.PyStr(sub)},
		hdr{"X-Auth-Subject", fleetauth.PyStr(sub)},
		hdr{"X-Auth-Email", fleetauth.PyStr(sub)},
		hdr{"X-Auth-Client", fleetauth.PyStr(client)},
	)
}

func (c *Config) fleetToken(ctx context.Context, token, host string) resp {
	if c.Engine == nil {
		return text(401, "Invalid token")
	}
	ans, ok := c.Engine.Ask(ctx, token, host, nil)
	if !ok || ans.K == fleetauth.Null {
		return text(503, "Auth server unavailable")
	}
	active, isDict := ans.Get("active", fleetauth.Value{})
	if !isDict {
		return errInternal // ans.get on a non-dict
	}
	if !active.Truthy() {
		return text(401, "Invalid token")
	}
	empty := fleetauth.S("")
	name, _ := ans.Get("name", empty)
	id, _ := ans.Get("id", empty)
	c.Log.Info("Fleet token valid: " + fleetauth.PyStr(id))
	subject, _ := ans.Get("subject", empty)
	if !subject.Truthy() {
		subject = name
	}
	scopes, _ := ans.Get("scopes", fleetauth.Value{K: fleetauth.List})
	joined, ok := pyJoin(scopes)
	if !ok {
		return errInternal
	}
	return okWith(
		hdr{"X-Auth-User", fleetauth.PyStr(name)},
		hdr{"X-Auth-Subject", fleetauth.PyStr(subject)},
		hdr{"X-Auth-Email", fleetauth.PyStr(name)},
		hdr{"X-Auth-Scopes", joined},
	)
}

func (c *Config) jwt(ctx context.Context, token, host string) resp {
	claims, e := c.Verifier.Verify(ctx, token, c.Now())
	switch e {
	case fleetauth.JWTExpired:
		return text(401, "Token expired")
	case fleetauth.JWTIssuer:
		return text(401, "Invalid token issuer")
	case fleetauth.JWTKeyServer:
		c.Log.Error("JWKS fetch failed")
		return text(503, "Auth key server unavailable")
	case fleetauth.JWTInvalid:
		return text(401, "Invalid token")
	case fleetauth.JWTInternal:
		return errInternal
	}
	cl := fleetauth.ObjV(claims)
	scopes, _ := cl.Get("scp", fleetauth.Value{K: fleetauth.List})
	if c.RequiredScope != "" {
		in, ok := pyIn(c.RequiredScope, scopes)
		if !ok {
			return errInternal
		}
		if !in {
			return text(403, "Insufficient scope")
		}
	}
	empty := fleetauth.S("")
	clientID, _ := cl.Get("client_id", empty)
	subject, _ := cl.Get("sub", empty)
	if c.Engine != nil {
		exp, _ := cl.Get("exp", fleetauth.Value{K: fleetauth.Null})
		adopt := fleetauth.NewObject("client_id", clientID, "sub", subject, "exp", exp, "scp", scopes)
		ans, ok := c.Engine.Ask(ctx, token, host, adopt)
		if ok && ans.K != fleetauth.Null {
			active, isDict := ans.Get("active", fleetauth.Value{})
			if !isDict {
				return errInternal
			}
			if !active.Truthy() {
				reason, _ := ans.Get("reason", empty)
				c.Log.Info("Token refused by the engine: " + fleetauth.PyStr(reason))
				return text(401, "Token revoked")
			}
		}
	}
	c.Log.Info(fmt.Sprintf("Token valid for client: %s, sub: %s", fleetauth.PyStr(clientID), fleetauth.PyStr(subject)))
	return okWith(
		hdr{"X-Auth-User", fleetauth.PyStr(clientID)},
		hdr{"X-Auth-Subject", fleetauth.PyStr(subject)},
		hdr{"X-Auth-Email", fleetauth.PyStr(clientID)},
	)
}

// okWith is Response("OK") plus headers; Werkzeug refuses a value with \r or \n (500).
func okWith(h ...hdr) resp {
	for _, x := range h {
		if strings.ContainsAny(x.v, "\r\n") {
			return errInternal
		}
	}
	return text(200, "OK", h...)
}

// pyIn is `needle in hay` for the scope check; ok=false is a TypeError.
func pyIn(needle string, hay fleetauth.Value) (bool, bool) {
	switch hay.K {
	case fleetauth.Str:
		return strings.Contains(hay.S, needle), true
	case fleetauth.List:
		for _, e := range hay.L {
			if fleetauth.Equal(e, fleetauth.S(needle)) {
				return true, true
			}
		}
		return false, true
	case fleetauth.Obj:
		_, has := hay.O.Get(needle)
		return has, true
	}
	return false, false
}

// pyJoin is " ".join(v); ok=false is a TypeError.
func pyJoin(v fleetauth.Value) (string, bool) {
	var parts []string
	switch v.K {
	case fleetauth.List:
		for _, e := range v.L {
			if e.K != fleetauth.Str {
				return "", false
			}
			parts = append(parts, e.S)
		}
	case fleetauth.Str:
		for _, r := range fleetauth.CodePoints(v.S) {
			parts = append(parts, string(r))
		}
	case fleetauth.Obj:
		parts = append(parts, v.O.Keys...)
	default:
		return "", false
	}
	return strings.Join(parts, " "), true
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

func keepASCII(s string) string {
	var sb strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] < 0x80 {
			sb.WriteByte(s[i])
		}
	}
	return sb.String()
}

// write emits the response the way gunicorn would have.
func write(w http.ResponseWriter, out resp) {
	if out.internal {
		out = resp{status: 500, body: body500}
	}
	all := append([]hdr{{"Content-Type", ctHTML}, {"Content-Length", strconv.Itoa(len(out.body))}}, out.headers...)
	for i, h := range all {
		if hasCtl(h.v) {
			// gunicorn process_headers: InvalidHeader -> its own 400 page
			writeGunicornError(w, 400, "Bad Request", "Invalid HTTP Header: "+pyReprStr(pyReprStr(h.v)))
			return
		}
		all[i].v = fleetauth.PyStrip(h.v)
	}
	enc := make([]hdr, len(all))
	for i, h := range all {
		b, ok := fleetauth.StrToLatin1(h.v)
		if !ok {
			writeGunicornError(w, 500, "Internal Server Error", "") // UnicodeEncodeError at send
			return
		}
		enc[i] = hdr{h.k, b}
	}
	for _, h := range enc {
		w.Header()[h.k] = []string{h.v}
	}
	w.WriteHeader(out.status)
	_, _ = w.Write([]byte(out.body))
}

func hasCtl(s string) bool {
	for _, r := range fleetauth.CodePoints(s) {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func pyReprStr(s string) string { return fleetauth.PyRepr(fleetauth.S(s)) }

func writeGunicornError(w http.ResponseWriter, status int, reason, mesg string) {
	page := "<html>\n  <head>\n    <title>" + reason + "</title>\n  </head>\n  <body>\n    <h1><p>" + reason +
		"</p></h1>\n    " + pyHTMLEscape(mesg) + "\n  </body>\n</html>\n"
	b, ok := fleetauth.StrToLatin1(page)
	if !ok {
		panic(http.ErrAbortHandler) // gunicorn fails to send the error page and drops the connection
	}
	h := w.Header()
	h["Connection"] = []string{"close"}
	h["Content-Type"] = []string{"text/html"}
	h["Content-Length"] = []string{strconv.Itoa(len(b))}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(b))
}

// pyHTMLEscape is Python's html.escape(s, quote=True).
var pyHTMLEscape = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;", "'", "&#x27;").Replace
