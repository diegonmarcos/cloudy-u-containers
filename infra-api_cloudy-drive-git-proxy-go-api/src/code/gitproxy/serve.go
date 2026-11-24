package gitproxy

import (
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"gitproxy-api/internal/authz"
)

// fail maps an error that escaped a handler: a timeout is an explicit 504 (a hang is the one failure the fallback
// chain cannot fall through on); everything else is a 500 internal_error. The shadow stage's missing credential
// is a 502 upstream_error, never a hang or a 200.
func (s *Server) fail(w http.ResponseWriter, err error) {
	var ue *upstreamError
	switch {
	case isTimeout(err):
		s.sendError(w, 504, "upstream_timeout", "GitHub did not answer in time")
	case errors.As(err, &ue) && ue.status == 503 && s.cfg.GitHubToken == "":
		s.sendError(w, 502, "upstream_error", ue.msg)
	default:
		msg := err.Error()
		var ue2 *url.Error
		if errors.As(err, &ue2) {
			msg = "fetch failed"
		}
		s.sendError(w, 500, "internal_error", msg)
	}
}

var trailingSlashes = regexp.MustCompile(`(.)/+$`)

// pathname approximates WHATWG URL pathname: the raw (still percent-encoded) path with dot segments resolved.
func pathname(r *http.Request) string {
	p := r.URL.EscapedPath()
	if p == "" {
		return "/"
	}
	segs := strings.Split(p, "/")
	var out []string
	for i, sg := range segs {
		low := strings.ToLower(sg)
		last := i == len(segs)-1
		switch low {
		case ".", "%2e":
			if last {
				out = append(out, "")
			}
		case "..", ".%2e", "%2e.", "%2e%2e":
			if len(out) > 1 {
				out = out[:len(out)-1]
			}
			if last {
				out = append(out, "")
			}
		default:
			out = append(out, sg)
		}
	}
	if len(out) == 0 || out[0] != "" {
		out = append([]string{""}, out...)
	}
	return strings.Join(out, "/")
}

// ServeHTTP is the request pipeline: match, then auth, then the handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := trailingSlashes.ReplaceAllString(pathname(r), "$1")
	route, params, allowed, err := match(s.table, r.Method, path)
	if err != nil {
		s.fail(w, err)
		return
	}
	if route == nil && allowed == nil {
		// An unmatched route is a 404 with a JSON error body. Never a 200 with a banner (#568).
		s.sendError(w, 404, "no_such_route", "No route for "+r.Method+" "+path)
		return
	}
	if route == nil {
		w.Header().Set("Allow", strings.Join(allowed, ", "))
		s.sendError(w, 405, "method_not_allowed", path+" accepts "+strings.Join(allowed, ", "))
		return
	}

	// #837 auth "mesh": a direct wg0 dial needs no credential; anything relayed by the public edge is judged as an
	// `authelia` route below, so off-mesh access is exactly what it was.
	meshDirect := route.Auth == "mesh" && authz.IsDirectMesh(authz.RemoteIP(r.RemoteAddr), r.Header, s.cfg.MeshCIDRs)
	if route.Auth != "none" && !meshDirect {
		// A presented bearer is authoritative: a bad one is refused, never retried as a cookie.
		authH := strings.Join(r.Header.Values("Authorization"), ", ")
		cookie := strings.Join(r.Header.Values("Cookie"), "; ")
		var d authz.Decision
		if authH != "" || cookie == "" {
			d = authz.DecideAuth(authH, s.bearer.Verify, s.rt.Authelia.RequiredScope)
		} else {
			d = authz.DecideSession(cookie, func(c string) (string, error) {
				return s.session.Verify(c, r.Method, path)
			}, s.rt.Authelia.Session.Users)
		}
		if !d.OK {
			s.sendJSON(w, d.Status, errBody{d.Error, d.Code})
			return
		}
	}
	route.handler(w, r, &reqCtx{params: params, query: r.URL.Query()})
}
