package execd

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Server is the HTTP face of the sidecar. It is meant for loopback / a unix socket; Token
// (when set) is additionally required in X-Execd-Token.
type Server struct {
	Token string
	Pool  *Pool
	Dock  *Docker
	Audit *Auditor
	Home  string
}

func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "ssh_dials": s.Pool.Dials()})
	})
	m.HandleFunc("POST /v1/exec", s.guard(s.exec))
	m.HandleFunc("POST /v1/ssh", s.guard(s.ssh))
	m.HandleFunc("POST /v1/docker", s.guard(s.docker))
	return m
}

func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token != "" && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Execd-Token")), []byte(s.Token)) != 1 {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) exec(w http.ResponseWriter, r *http.Request) {
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := CheckCommand(req.Command); err != nil {
		s.Audit.Log("exec", req.Command, "DENIED")
		writeJSON(w, 403, map[string]string{"error": err.Error()})
		return
	}
	t0 := time.Now()
	res := Run(r.Context(), req)
	s.Audit.Log("exec", fmt.Sprintf("%s argc=%d", req.Command, len(req.Args)), fmt.Sprintf("exit %d in %dms", res.ExitCode, time.Since(t0).Milliseconds()))
	writeJSON(w, 200, res)
}

func (s *Server) ssh(w http.ResponseWriter, r *http.Request) {
	var req SSHRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := CheckAlias(req.Alias); err != nil {
		s.Audit.Log("ssh", "bad-alias", "DENIED")
		writeJSON(w, 403, map[string]string{"error": err.Error()})
		return
	}
	res := s.Pool.Exec(r.Context(), req)
	cmd := req.Command
	if len(cmd) > 120 {
		cmd = cmd[:120]
	}
	// same shape as ssh.ts: alias plus the first 120 chars of the command
	s.Audit.Log("ssh", fmt.Sprintf("%s: %q", req.Alias, cmd), fmt.Sprintf("exit %d", res.ExitCode))
	writeJSON(w, 200, res)
}

func (s *Server) docker(w http.ResponseWriter, r *http.Request) {
	var req DockerRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	if err := CheckDocker(req.Method, req.Path); err != nil {
		s.Audit.Log("docker", req.Method+" "+req.Path, "DENIED")
		writeJSON(w, 403, map[string]string{"error": err.Error()})
		return
	}
	resp, err := s.Dock.Do(context.WithoutCancel(r.Context()), req)
	if err != nil {
		s.Audit.Log("docker", req.Method+" "+req.Path, "FAILED "+err.Error())
		writeJSON(w, 502, map[string]string{"error": err.Error()})
		return
	}
	s.Audit.Log("docker", req.Method+" "+req.Path, fmt.Sprintf("status %d", resp.Status))
	writeJSON(w, 200, resp)
}
