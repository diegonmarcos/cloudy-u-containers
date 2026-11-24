package c3pub

import (
	"bytes"
	"io"
	"net/http"
	"net/url"
	"strings"

	"c3public-api/internal/ojson"
)

var hopByHop = map[string]bool{"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true, "Te": true,
	"Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Host": true, "Content-Length": true}

// analytics reverse-proxies /analytics/<slug>[...] to the declared first-party backend (public, rate limited). The
// backend URL already carries the rewrite path (matomo.php, /api/send, the OpenObserve _json ingest); the part of the
// request after the prefix is resolved against it (rewritePrefix ""), the configured Authorization header (if any)
// replaces the caller's, and the body goes through the root parsers first (JSON is re-serialised compactly, anything
// else passes as the same bytes).
func (s *Server) analytics(w http.ResponseWriter, r *http.Request, slug, rest string) {
	b := s.cfg.Backends[slug]
	pb, st, msg := s.readBody(r)
	if st != 0 {
		s.errorHandler(w, r, st, msg)
		return
	}
	// rewritePrefix "": the part of the request after the prefix is appended to the backend URL (which already carries
	// the rewrite path), not resolved against it.
	dest, err := url.Parse(b.URL + rest)
	if err != nil {
		s.errorHandler(w, r, 500, err.Error())
		return
	}
	var body io.Reader
	ctype := r.Header.Get("Content-Type")
	switch {
	case pb.present && pb.json:
		body = bytes.NewReader(ojson.Marshal(pb.val))
	case pb.present:
		body = bytes.NewReader(pb.raw)
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, dest.String(), body)
	if err != nil {
		s.errorHandler(w, r, 500, err.Error())
		return
	}
	for k, vs := range r.Header {
		if hopByHop[k] {
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if a := s.cfg.Auth[slug]; a != "" {
		req.Header.Set("Authorization", a)
	}
	res, err := s.client.Do(req)
	if err != nil {
		s.sendJSON(w, r, 503, obj("statusCode", 503, "code", "FST_REPLY_FROM_SERVICE_UNAVAILABLE", "error", "Service Unavailable", "message", "Service Unavailable"))
		return
	}
	defer res.Body.Close()
	h := w.Header()
	for k, vs := range res.Header {
		if hopByHop[k] && !(k == "Content-Length" && r.Method == http.MethodHead) {
			continue
		}
		for _, v := range vs {
			h.Add(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, res.Body)
	}
}
