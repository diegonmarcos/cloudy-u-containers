package c3pub

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"c3public-api/internal/ojson"
)

// Server is the HTTP handler: one pipeline in the order Fastify runs it (onRequest hooks: CORS, rate limit, the /mail auth
// scope; then body parsing; then the handler), with Fastify's own 404 and error envelopes.
type Server struct {
	cfg     *Config
	mu      sync.Mutex
	rl      map[string]*window
	codes   *CodeStore
	ledger  *Ledger
	client  *http.Client
	slugs   []string
	started time.Time
}

type window struct {
	count int
	reset time.Time
}

func New(cfg *Config) *Server {
	s := &Server{cfg: cfg, rl: map[string]*window{}, codes: NewCodeStore(cfg.Profile), started: time.Now()}
	ttl := 1800000.0
	if cfg.Limits.DedupeTTLMS != nil {
		ttl = *cfg.Limits.DedupeTTLMS
	}
	s.ledger = NewLedger(time.Duration(ttl) * time.Millisecond)
	s.client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for slug := range cfg.Backends {
		s.slugs = append(s.slugs, slug)
	}
	sort.Strings(s.slugs)
	return s
}

// ---- responses ----

func (s *Server) send(w http.ResponseWriter, r *http.Request, status int, ctype string, body []byte) {
	h := w.Header()
	if ctype != "" {
		h.Set("Content-Type", ctype)
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(body)
	}
}

func (s *Server) sendJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	s.send(w, r, status, "application/json; charset=utf-8", ojson.Marshal(v))
}

func obj(kv ...any) *ojson.Obj {
	o := ojson.NewObj()
	for i := 0; i+1 < len(kv); i += 2 {
		o.Set(kv[i].(string), kv[i+1])
	}
	return o
}

// errorHandler is plugins/error-handler.ts: {error: message, statusCode}.
func (s *Server) errorHandler(w http.ResponseWriter, r *http.Request, status int, msg string) {
	s.sendJSON(w, r, status, obj("error", msg, "statusCode", status))
}

// notFound is Fastify's default 404 body.
func (s *Server) notFound(w http.ResponseWriter, r *http.Request) {
	s.sendJSON(w, r, 404, obj("message", fmt.Sprintf("Route %s:%s not found", r.Method, r.URL.RequestURI()), "error", "Not Found", "statusCode", 404))
}

// ---- client address (trustProxy: true) ----

// clientIP is req.ip under trustProxy: true: every hop is trusted, so the leftmost X-Forwarded-For entry is the client.
func clientIP(r *http.Request) string {
	if xff := strings.Join(r.Header.Values("X-Forwarded-For"), ", "); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if ip := jsTrim(first); ip != "" {
			return ip
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func isMeshIP(ip string) bool {
	return strings.HasPrefix(ip, "10.0.0.") || strings.HasPrefix(ip, "10.1.0.") || strings.HasPrefix(ip, "172.") || ip == "127.0.0.1" || ip == "::1"
}

// ---- CORS (@fastify/cors, origin: true, credentials: true) ----

// cors sets the response headers; it reports whether the request was a preflight that is now fully answered.
func (s *Server) cors(w http.ResponseWriter, r *http.Request) bool {
	h := w.Header()
	if origin := r.Header.Get("Origin"); origin != "" {
		h.Set("Access-Control-Allow-Origin", origin)
	}
	h.Add("Vary", "Origin")
	h.Set("Access-Control-Allow-Credentials", "true")
	if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, PATCH, POST, DELETE")
		if reqH := r.Header.Get("Access-Control-Request-Headers"); reqH != "" {
			h.Set("Access-Control-Allow-Headers", reqH)
			h.Add("Vary", "Access-Control-Request-Headers")
		}
		h.Set("Content-Length", "0")
		w.WriteHeader(204)
		return true
	}
	return false
}

// ---- rate limit (@fastify/rate-limit): fixed window per client address ----

func (s *Server) allowListed(path string) bool {
	return path == "/health" || path == "/ready" || strings.HasSuffix(path, "/mail/http-to-smtp")
}

// rateLimit returns false when the request was refused (429 already written).
func (s *Server) rateLimit(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.RequestURI()
	path, _, _ = strings.Cut(path, "?")
	if s.allowListed(path) {
		return true
	}
	max := int(s.cfg.Limits.RatePerIPPerMin)
	now := time.Now()
	ip := clientIP(r)
	s.mu.Lock()
	win := s.rl[ip]
	if win == nil || !now.Before(win.reset) {
		win = &window{reset: now.Add(time.Minute)}
		s.rl[ip] = win
	}
	win.count++
	count, reset := win.count, win.reset
	s.mu.Unlock()
	secs := int((reset.Sub(now) + time.Second - 1) / time.Second)
	h := w.Header()
	h.Set("X-RateLimit-Limit", strconv.Itoa(max))
	rem := max - count
	if rem < 0 {
		rem = 0
	}
	h.Set("X-RateLimit-Remaining", strconv.Itoa(rem))
	h.Set("X-RateLimit-Reset", strconv.Itoa(secs))
	if count > max {
		h.Set("Retry-After", strconv.Itoa(secs))
		s.sendJSON(w, r, 429, obj("statusCode", 429, "error", "Too Many Requests", "message", "Rate limit exceeded, retry in 1 minute"))
		return false
	}
	return true
}

// ---- body parsing (root content-type parsers: application/json -> parsed value, anything else -> Buffer) ----

type parsedBody struct {
	present bool
	json    bool
	val     any    // JSON value (ojson tree) when json
	raw     []byte // Buffer otherwise
}

func isJSONType(ct string) bool {
	ct = strings.ToLower(jsTrim(strings.SplitN(ct, ";", 2)[0]))
	return ct == "application/json"
}

// readBody applies bodyLimit and the two parsers; a non-nil error carries the status and message the error handler reports.
func (s *Server) readBody(r *http.Request) (parsedBody, int, string) {
	var pb parsedBody
	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		return pb, 0, ""
	}
	limit := int64(s.cfg.Limits.MaxBodyBytes)
	if cl := r.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil && n > limit {
			return pb, 413, "Request body is too large"
		}
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		return pb, 400, "Request body could not be read"
	}
	if int64(len(data)) > limit {
		return pb, 413, "Request body is too large"
	}
	ct := r.Header.Get("Content-Type")
	if ct == "" && len(data) == 0 {
		return pb, 0, ""
	}
	pb.present = true
	if isJSONType(ct) {
		pb.json = true
		if len(data) == 0 {
			pb.val = ojson.NewObj()
			return pb, 0, ""
		}
		v, perr := ojson.Parse(data)
		if perr != nil {
			return pb, 400, perr.Error()
		}
		pb.val = v
		return pb, 0, ""
	}
	pb.raw = data
	return pb, 0, ""
}

// ---- pipeline ----

var analyticsPath = regexp.MustCompile(`^/analytics/([^/]+)(/.*)?$`)

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.EscapedPath()
	// onRequest hooks, in registration order: CORS, then rate limit (both also run for the 404 handler).
	if s.cors(w, r) {
		return
	}
	if !s.rateLimit(w, r) {
		return
	}
	method := r.Method
	get := method == http.MethodGet || method == http.MethodHead
	switch {
	case path == "/health" && get:
		s.sendJSON(w, r, 200, obj("status", "ok"))
	case path == "/ready" && get:
		s.sendJSON(w, r, 200, obj("status", "ready"))
	case strings.HasPrefix(path, "/superapp/config/") && get && !strings.Contains(path[len("/superapp/config/"):], "/"):
		s.superapp(w, r, path[len("/superapp/config/"):])
	case path == "/profile/connect/start" && method == http.MethodPost:
		s.profileStart(w, r)
	case path == "/profile/connect/fetch" && method == http.MethodPost:
		s.profileFetch(w, r)
	case path == "/mail/http-to-smtp" && method == http.MethodPost:
		// Bearer gate scoped to /mail/* only.
		ip := clientIP(r)
		if !isMeshIP(ip) && r.Header.Get("X-Auth-User") == "" && r.Header.Get("Remote-User") == "" {
			s.sendJSON(w, r, 401, obj("error", "Unauthorized — Bearer token required (verified by Caddy/introspect-proxy)"))
			return
		}
		s.mail(w, r)
	default:
		if m := analyticsPath.FindStringSubmatch(path); m != nil {
			if _, ok := s.cfg.Backends[m[1]]; ok {
				s.analytics(w, r, m[1], strings.TrimPrefix(r.URL.RequestURI(), "/analytics/"+m[1]))
				return
			}
		}
		s.notFound(w, r)
	}
}

// ---- superapp ----

var slugRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

func (s *Server) superapp(w http.ResponseWriter, r *http.Request, user string) {
	if dec, err := url.PathUnescape(user); err == nil {
		user = dec
	}
	if !slugRe.MatchString(user) {
		s.sendJSON(w, r, 400, obj("error", "Invalid user slug"))
		return
	}
	file := "build-cloud-superapp-" + user + ".json"
	for _, d := range s.cfg.SuperappDirs {
		p := filepath.Join(d, file)
		if b, err := os.ReadFile(p); err == nil {
			s.send(w, r, 200, "application/json", []byte(ojson.ReplaceInvalidUTF8(b)))
			return
		}
	}
	s.sendJSON(w, r, 404, obj("error", "No SuperApp config for user: "+user))
}

// ---- profile connect ----

// gate returns the identity, or "" with the refusal already written.
func (s *Server) gate(w http.ResponseWriter, r *http.Request) string {
	user := Identity(r.Header)
	if user == "" {
		s.sendJSON(w, r, 401, obj("error", "unauthorized", "detail", "no bearer identity (X-Auth-User) — call through api.diegonmarcos.com/pub with an Authelia bearer"))
		return ""
	}
	if miss := MissingParts(s.cfg.Profile); len(miss) > 0 {
		arr := make([]any, len(miss))
		for i, m := range miss {
			arr[i] = m
		}
		fmt.Fprintf(os.Stderr, "profile_connect.not_configured %v\n", miss)
		s.sendJSON(w, r, 503, obj("error", "not_configured", "missing", arr))
		return ""
	}
	w.Header().Set("Cache-Control", "no-store")
	return user
}

func (s *Server) profileStart(w http.ResponseWriter, r *http.Request) {
	if _, st, msg := s.readBody(r); st != 0 {
		s.errorHandler(w, r, st, msg)
		return
	}
	user := s.gate(w, r)
	if user == "" {
		return
	}
	pc := s.cfg.Profile
	issued := s.codes.Issue(user, time.Now())
	if !issued.OK {
		w.Header().Set("Retry-After", strconv.Itoa(issued.RetryAfter))
		s.sendJSON(w, r, 429, obj("error", "cooldown", "retry_after", issued.RetryAfter))
		return
	}
	timeout := time.Duration(s.cfg.Limits.RequestTimeoutMS) * time.Millisecond
	err := SendRaw(s.cfg.Primary.Host, int(s.cfg.Primary.Port), s.cfg.Helo, pc.MailFrom, []string{pc.MailTo}, []byte(CodeMail(pc, issued.Code, user, time.Now())), timeout)
	if err != nil {
		// A code nobody received must not stay live and block a retry behind the cooldown.
		s.codes.Revoke(user)
		fmt.Fprintf(os.Stderr, "profile_connect.mail_failed %v\n", err)
		s.sendJSON(w, r, 502, obj("error", "mail_failed"))
		return
	}
	s.sendJSON(w, r, 202, obj("sent_to", MaskAddress(pc.MailTo), "expires_in", issued.ExpiresIn))
}

func (s *Server) profileFetch(w http.ResponseWriter, r *http.Request) {
	pb, st, msg := s.readBody(r)
	if st != 0 {
		s.errorHandler(w, r, st, msg)
		return
	}
	user := s.gate(w, r)
	if user == "" {
		return
	}
	code := ""
	if pb.json {
		if o, ok := pb.val.(*ojson.Obj); ok {
			if c, ok := o.Vals["code"].(string); ok {
				code = c
			}
		}
	}
	v := s.codes.Verify(user, code, time.Now())
	if !v.OK {
		if v.Err == "too_many_attempts" {
			s.sendJSON(w, r, 429, obj("error", v.Err))
			return
		}
		if v.Err == "bad_code" {
			s.sendJSON(w, r, 403, obj("error", v.Err, "attempts_left", v.AttemptsLeft))
			return
		}
		s.sendJSON(w, r, 403, obj("error", v.Err))
		return
	}
	schema, bundle, err := LoadBundle(s.cfg.Profile)
	if err != nil {
		if be, ok := err.(*BundleError); ok {
			fmt.Fprintf(os.Stderr, "profile_connect.bundle_unreadable %s\n", be.Msg)
			s.sendJSON(w, r, 502, obj("error", "bundle_unreadable", "detail", be.Msg))
			return
		}
		s.errorHandler(w, r, 500, err.Error())
		return
	}
	s.sendJSON(w, r, 200, obj("schema", schema, "bundle", bundle))
}
