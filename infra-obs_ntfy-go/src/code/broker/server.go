package broker

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"ntfy-sidecars/pyjson"
)

// LoadState reads the state file; any error yields an empty state.
func LoadState(path string) M {
	b, err := os.ReadFile(path)
	if err != nil {
		return M{}
	}
	var s M
	if json.Unmarshal(b, &s) != nil || s == nil {
		return M{}
	}
	return s
}

// SaveState writes the state atomically (tmp + rename).
func SaveState(path string, s M) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Server is the broker HTTP surface: GET /health, GET /, POST /event, POST /ack.
type Server struct {
	Policy    *Policy
	StatePath string
	Dispatch  *Dispatcher
	Now       func() time.Time
	mu        sync.Mutex
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	body := pyjson.Dumps(v, -1)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write([]byte(body))
}

func obj(kv ...any) *pyjson.OMap {
	m := pyjson.NewOMap()
	for i := 0; i+1 < len(kv); i += 2 {
		m.Set(kv[i].(string), kv[i+1])
	}
	return m
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if r.URL.Path == "/health" || r.URL.Path == "/" {
			writeJSON(w, 200, obj("ok", true))
			return
		}
		writeJSON(w, 404, obj("error", "not found"))
	case http.MethodPost:
		if r.URL.Path != "/event" && r.URL.Path != "/ack" {
			writeJSON(w, 404, obj("error", "not found"))
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			writeJSON(w, 400, obj("error", "bad json: "+err.Error()))
			return
		}
		if len(raw) == 0 {
			raw = []byte("{}")
		}
		var event M
		if err := json.Unmarshal(raw, &event); err != nil || event == nil {
			msg := "not an object"
			if err != nil {
				msg = err.Error()
			}
			writeJSON(w, 400, obj("error", "bad json: "+msg))
			return
		}
		if r.URL.Path == "/ack" {
			event["ack"] = true
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		now := time.Now
		if s.Now != nil {
			now = s.Now
		}
		state := LoadState(s.StatePath)
		actions, newState := Decide(event, s.Policy, state, float64(now().Unix()))
		sent := 0
		for _, a := range actions {
			if s.Dispatch.Dispatch(a) {
				sent++
			}
		}
		if err := SaveState(s.StatePath, newState); err != nil && s.Dispatch.Logf != nil {
			s.Dispatch.Logf("[broker] save state: %v", err)
		}
		writeJSON(w, 200, obj("actions", int64(len(actions)), "sent", int64(sent)))
	default:
		http.Error(w, "Unsupported method", http.StatusNotImplemented)
	}
}
