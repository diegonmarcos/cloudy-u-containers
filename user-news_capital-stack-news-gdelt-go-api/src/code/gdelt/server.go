package gdelt

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Server is the HTTP face: /health, and under BasePath /articles /timeline /tone /topics. Fastify's
// response shapes are kept: JSON bodies, the 404 envelope, CORS on every response, 204 on any OPTIONS.
type Server struct {
	Store    *Store
	BasePath string
	Started  time.Time
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	body := bytes.TrimSuffix(b.Bytes(), []byte("\n"))
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(code)
	_, _ = w.Write(body)
}

func query(r *http.Request, key, def string) string {
	if vs, ok := r.URL.Query()[key]; ok && len(vs) > 0 {
		return vs[0]
	}
	return def
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		p := r.URL.Path
		switch {
		case p == "/health":
			n, total, last := s.Store.Health()
			writeJSON(w, 200, ordered{{"status", "ok"}, {"cachedTopics", n}, {"totalArticles", total}, {"lastFetch", last}, {"uptime", int(time.Since(s.Started).Seconds())}})
			return
		case strings.HasPrefix(p, s.BasePath+"/") && p != s.BasePath+"/":
			s.base(w, r, strings.TrimPrefix(p, s.BasePath))
			return
		}
	}
	writeJSON(w, 404, notFound(r))
}

type ordered []kv
type kv struct {
	k string
	v any
}

// MarshalJSON keeps the key order of the Node responses.
func (o ordered) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, e := range o {
		if i > 0 {
			b.WriteByte(',')
		}
		k, _ := json.Marshal(e.k)
		b.Write(k)
		b.WriteByte(':')
		var vb bytes.Buffer
		enc := json.NewEncoder(&vb)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(e.v); err != nil {
			return nil, err
		}
		b.Write(bytes.TrimSuffix(vb.Bytes(), []byte("\n")))
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

func (s *Server) base(w http.ResponseWriter, r *http.Request, sub string) {
	ctx := context.WithoutCancel(r.Context())
	switch sub {
	case "/articles":
		q := query(r, "q", "economy")
		limit := 50
		if n, ok := ParseIntJS(query(r, "limit", "50")); ok && n != 0 {
			limit = n
		}
		if limit < 1 {
			limit = 1
		}
		if limit > 250 {
			limit = 250
		}
		s.Store.FetchOnDemand(ctx, q)
		a := s.Store.Articles(q, limit)
		writeJSON(w, 200, ordered{{"query", q}, {"count", len(a)}, {"articles", a}})
	case "/timeline":
		q := query(r, "q", "economy")
		s.Store.FetchOnDemand(ctx, q)
		t := s.Store.Timeline(q)
		writeJSON(w, 200, ordered{{"query", q}, {"points", len(t)}, {"timeline", t}})
	case "/tone":
		q := query(r, "q", "economy")
		s.Store.FetchOnDemand(ctx, q)
		t := s.Store.Tone(q)
		writeJSON(w, 200, ordered{{"query", q}, {"count", len(t)}, {"tone", t}})
	case "/topics":
		writeJSON(w, 200, map[string]any{"topics": s.Store.Topics()})
	default:
		writeJSON(w, 404, notFound(r))
	}
}

func notFound(r *http.Request) ordered {
	return ordered{{"message", fmt.Sprintf("Route %s:%s not found", r.Method, r.URL.RequestURI())}, {"error", "Not Found"}, {"statusCode", 404}}
}
