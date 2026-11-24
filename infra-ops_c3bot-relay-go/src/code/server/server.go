// Package server is the HTTP face of c3bot-relay (Go port of server.js): WebSocket /ws, SSE /events, long-poll /poll,
// outbound POST /send, the session lease (/claim, /release), the Telegram webhook receiver and /health. Bearer-gated
// (C3BOT_RELAY_TOKEN); /health and the webhook (own secret) are open.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"c3bot-relay/relay"
)

// Config is the environment of the service.
type Config struct {
	Base          string // BASE_PATH, stripped from the request path when present
	Token         string // C3BOT_RELAY_TOKEN
	MaxClients    int
	PollMaxWaitS  float64
	DefaultChat   string // first entry of C3BOT_ALLOWED_FROM
	WebhookSecret string
	WebhookURL    string
	WebhookClient *http.Client // selfTest transport (nil = default)
}

// Server wires the relay, the Telegram client, the failover machine and the lease to HTTP.
type Server struct {
	Cfg      Config
	Relay    *relay.Relay
	BotA     *relay.Telegram
	Failover *relay.Failover
	Lease    *relay.Lease

	clients     atomic.Int32
	pollEnabled atomic.Bool // true only after deleteWebhook succeeded; the getUpdates loop never runs beside a webhook
	stMu        sync.Mutex
	selfTests   map[string]struct{}
}

func New(cfg Config, r *relay.Relay, bot *relay.Telegram, f *relay.Failover, l *relay.Lease) *Server {
	if cfg.MaxClients == 0 {
		cfg.MaxClients = 32
	}
	if cfg.PollMaxWaitS == 0 {
		cfg.PollMaxWaitS = 50
	}
	if cfg.WebhookURL == "" {
		cfg.WebhookURL = "https://c3-pub.diegonmarcos.com/c3bot-webhook"
	}
	return &Server{Cfg: cfg, Relay: r, BotA: bot, Failover: f, Lease: l, selfTests: map[string]struct{}{}}
}

// PollEnabled gates the getUpdates loop.
func (s *Server) PollEnabled() bool { return s.pollEnabled.Load() }

// Clients is the number of open WS + SSE clients.
func (s *Server) Clients() int { return int(s.clients.Load()) }

// ---- helpers ----

type httpErr struct {
	status int
	msg    string
}

func (e *httpErr) Error() string { return e.msg }

func eq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func writeJSON(w http.ResponseWriter, code int, body any) {
	b, err := json.Marshal(body)
	if err != nil {
		code, b = 500, []byte(`{"ok":false,"error":"encode"}`)
	}
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(b)
}

func merge(base map[string]any, more map[string]any) map[string]any {
	for k, v := range more {
		base[k] = v
	}
	return base
}

func ok(more map[string]any) map[string]any { return merge(map[string]any{"ok": true}, more) }

func (s *Server) bearerOK(r *http.Request) bool {
	h := r.Header.Get("Authorization")
	var t string
	if strings.HasPrefix(h, "Bearer ") {
		t = h[7:]
	} else {
		t = r.URL.Query().Get("token")
	}
	return s.Cfg.Token != "" && t != "" && eq(t, s.Cfg.Token)
}

var errNullBody = errors.New("null body")

// readBody parses a JSON object body (empty = {}). A JSON null is returned as nil with errNullBody-free semantics left
// to the caller; non-objects behave like an object without keys (JS property reads give undefined).
func readBody(r *http.Request) (any, error) {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1e6+1))
	if err != nil || len(b) > 1e6 {
		return nil, &httpErr{500, "body too large"}
	}
	if len(bytes.TrimSpace(b)) == 0 {
		return map[string]any{}, nil
	}
	var v any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&v); err != nil || d.More() {
		return nil, &httpErr{500, "invalid JSON"}
	}
	return v, nil
}

// bodyObj reads the body as an object; JSON null throws like `null.session` does in JS.
func bodyObj(r *http.Request, prop string) (map[string]any, error) {
	v, err := readBody(r)
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, &httpErr{500, "Cannot read properties of null (reading '" + prop + "')"}
	}
	m, _ := v.(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m, nil
}

func (s *Server) route(r *http.Request) string {
	p := r.URL.Path
	if strings.HasPrefix(p, s.Cfg.Base) && s.Cfg.Base != "" {
		p = p[len(s.Cfg.Base):]
		if p == "" {
			p = "/"
		}
	}
	return p
}

// Health is the open /health document (never contains a secret or a lease holder name).
func (s *Server) Health() map[string]any {
	var tgErr any
	if e := s.BotA.LastError(); e != nil {
		tgErr = *e
	}
	var exp any
	if s.Lease.Live() != "" {
		exp = s.Lease.ExpiresAt()
	}
	ing := s.Failover.Snapshot()
	ing["webhookSecretConfigured"] = s.Cfg.WebhookSecret != ""
	ing["botA"] = s.BotA.State()
	ing["polling"] = s.PollEnabled()
	ing["dupes"] = s.Relay.Dupes()
	return map[string]any{"ok": true, "telegram": s.BotA.State(), "telegramError": tgErr, "cursor": s.Relay.Cursor(), "clients": s.Clients(),
		"transports": []string{"ws", "sse", "poll"}, "tokenConfigured": s.Cfg.Token != "", "botConfigured": s.BotA.Configured(),
		"lease": map[string]any{"held": s.Lease.Live() != "", "expiresAt": exp}, "persist": s.Relay.Persist(), "ingest": ing}
}

// DoSend relays one outbound message as Bot A and records it as a telegram.sent event.
func (s *Server) DoSend(ctx context.Context, msg map[string]any) (map[string]any, error) {
	var chat any = msg["chat_id"]
	if chat == nil && s.Cfg.DefaultChat != "" {
		chat = s.Cfg.DefaultChat
	}
	text, isStr := msg["text"].(string)
	if !isTruthy(chat) || !isStr || text == "" {
		return nil, &httpErr{400, "chat_id (or default) and text required"}
	}
	ids, err := s.BotA.Send(ctx, chat, text, msg["thread_id"])
	if err != nil {
		var te *relay.Error
		if errors.As(err, &te) && te.Code == "unconfigured" {
			return nil, &httpErr{503, err.Error()}
		}
		return nil, &httpErr{502, err.Error()}
	}
	s.Relay.Publish("telegram.sent", map[string]any{"chat_id": chat, "text": text, "message_ids": ids})
	return map[string]any{"message_ids": ids}, nil
}

func isTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case json.Number:
		f, _ := t.Float64()
		return f != 0
	}
	return true
}

func status(err error) int {
	var he *httpErr
	if errors.As(err, &he) {
		return he.status
	}
	var se *relay.StatusError
	if errors.As(err, &se) {
		return se.Status
	}
	return 500
}

// ---- handler ----

// Handler is the whole HTTP surface.
func (s *Server) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := s.serve(w, r); err != nil {
			writeJSON(w, status(err), map[string]any{"ok": false, "error": err.Error()})
		}
	})
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) error {
	path := s.route(r)
	isUpgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
	if isUpgrade && r.Method == http.MethodGet {
		if path != "/ws" { // Node destroys the socket
			if hj, ok := w.(http.Hijacker); ok {
				if c, _, err := hj.Hijack(); err == nil {
					c.Close()
				}
			}
			return nil
		}
		return s.serveWS(w, r)
	}
	switch {
	case r.Method == "GET" && path == "/health":
		writeJSON(w, 200, s.Health())
		return nil
	case r.Method == "POST" && (path == "/telegram/webhook" || path == "/webhook"):
		return s.webhook(w, r)
	}
	if !s.bearerOK(r) {
		writeJSON(w, 401, map[string]any{"ok": false, "error": "unauthorized"})
		return nil
	}
	switch {
	case r.Method == "POST" && path == "/claim":
		b, err := bodyObj(r, "session")
		if err != nil {
			return err
		}
		res, err := s.Lease.Claim(b["session"], b["ttl"])
		if err != nil {
			return err
		}
		writeJSON(w, 200, ok(res))
	case r.Method == "POST" && path == "/release":
		b, err := bodyObj(r, "session")
		if err != nil {
			return err
		}
		writeJSON(w, 200, ok(s.Lease.Release(b["session"])))
	case r.Method == "GET" && path == "/claim":
		writeJSON(w, 200, ok(s.Lease.Snapshot()))
	case r.Method == "POST" && path == "/send":
		m, err := bodyObj(r, "chat_id")
		if err != nil {
			return err
		}
		res, err := s.DoSend(r.Context(), m)
		if err != nil {
			return err
		}
		writeJSON(w, 200, ok(res))
	case r.Method == "GET" && path == "/poll":
		s.poll(w, r)
	case r.Method == "GET" && path == "/events":
		s.sse(w, r)
	default:
		writeJSON(w, 404, map[string]any{"ok": false, "error": "not found"})
	}
	return nil
}

// qnum is JS `+(value || default)`: NaN for junk.
func qnum(v string, def float64) float64 {
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

// poll is the long-poll fallback: cursor in, events + new cursor out.
func (s *Server) poll(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	after := qnum(q.Get("after"), 0)
	wait := math.Min(qnum(q.Get("wait"), 25), s.Cfg.PollMaxWaitS)
	d := time.Millisecond // NaN waits fire at once, like setTimeout(NaN)
	if !math.IsNaN(wait) {
		d = time.Duration(wait * float64(time.Second))
	}
	evs, alive := s.Relay.WaitFor(after, d, 100, r.Context().Done())
	if !alive {
		return
	}
	var cursor any
	switch {
	case len(evs) > 0:
		cursor = evs[len(evs)-1].Seq()
	case math.IsNaN(after) || math.IsInf(after, 0):
		cursor = nil // JSON.stringify(NaN|Infinity) is null
	default:
		cursor = math.Max(after, 0)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "head": s.Relay.Cursor(), "cursor": cursor, "events": evs})
}

// sse streams events, resumable with Last-Event-ID or ?after=.
func (s *Server) sse(w http.ResponseWriter, r *http.Request) {
	fl, canFlush := w.(http.Flusher)
	if int(s.clients.Load()) >= s.Cfg.MaxClients {
		writeJSON(w, 429, map[string]any{"ok": false, "error": "too many clients"})
		return
	}
	s.clients.Add(1)
	defer s.clients.Add(-1)
	h := w.Header()
	h.Set("content-type", "text/event-stream")
	h.Set("cache-control", "no-cache")
	h.Set("connection", "keep-alive")
	h.Set("x-accel-buffering", "no")
	w.WriteHeader(200)
	after := qnum(r.Header.Get("Last-Event-ID"), qnum(r.URL.Query().Get("after"), 0))
	flush := func() {
		if canFlush {
			fl.Flush()
		}
	}
	fmt.Fprint(w, ": connected\n\n")
	flush()
	out := make(chan relay.Event, s.Relay.BufferSize()*2+64)
	over := make(chan struct{})
	var once sync.Once
	unsub := s.Relay.SubscribeFrom(after, s.Relay.BufferSize(), func(e relay.Event) {
		select {
		case out <- e:
		default: // a client that cannot keep up is dropped, never blocks publish
			once.Do(func() { close(over) })
		}
	})
	defer unsub()
	ka := time.NewTicker(20 * time.Second)
	defer ka.Stop()
	for {
		select {
		case e := <-out:
			b, _ := json.Marshal(e)
			fmt.Fprintf(w, "id: %d\nevent: %v\ndata: %s\n\n", e.Seq(), e["type"], b)
			flush()
		case <-ka.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flush()
		case <-over:
			return
		case <-r.Context().Done():
			return
		}
	}
}

// webhook is the Telegram receiver. Authenticated ONLY by Telegram's secret_token header (constant-time compare); no
// secret configured means 503, never anonymous posts. A 200 is returned for parseable bodies even when the update is
// dropped, so Telegram never retry-storms.
func (s *Server) webhook(w http.ResponseWriter, r *http.Request) error {
	if s.Cfg.WebhookSecret == "" {
		writeJSON(w, 503, map[string]any{"ok": false, "error": "webhook secret not configured"})
		return nil
	}
	h := r.Header.Get("X-Telegram-Bot-Api-Secret-Token")
	if h == "" || !eq(h, s.Cfg.WebhookSecret) {
		writeJSON(w, 401, map[string]any{"ok": false, "error": "unauthorized"})
		return nil
	}
	v, err := readBody(r)
	if err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": err.Error()})
		return nil
	}
	u, _ := v.(map[string]any)
	if st, isStr := u["selftest"].(string); isStr {
		s.stMu.Lock()
		s.selfTests[st] = struct{}{}
		s.stMu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true, "selftest": true})
		return nil
	}
	s.Failover.NoteWebhookUpdate()
	if v == nil {
		return &httpErr{500, "Cannot read properties of null (reading 'message')"}
	}
	if u != nil {
		s.Relay.IngestUpdate(u, "A")
	}
	writeJSON(w, 200, map[string]any{"ok": true})
	return nil
}

// ---- failover driver ----

// SelfTest posts a probe to our own public webhook URL with the secret header and checks it arrived.
func (s *Server) SelfTest(ctx context.Context) bool {
	var nb [8]byte
	_, _ = rand.Read(nb[:])
	nonce := fmt.Sprintf("%d-%s", time.Now().UnixMilli(), hex.EncodeToString(nb[:]))
	body, _ := json.Marshal(map[string]any{"selftest": nonce})
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", s.Cfg.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return false
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-telegram-bot-api-secret-token", s.Cfg.WebhookSecret)
	cl := s.Cfg.WebhookClient
	if cl == nil {
		cl = http.DefaultClient
	}
	resp, err := cl.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	s.stMu.Lock()
	_, seen := s.selfTests[nonce]
	delete(s.selfTests, nonce)
	s.stMu.Unlock()
	return resp.StatusCode == 200 && seen
}

func (s *Server) enterPolling(ctx context.Context) {
	j, err := s.BotA.API(ctx, "deleteWebhook", map[string]any{"drop_pending_updates": false}, 15*time.Second)
	if err != nil {
		s.pollEnabled.Store(false)
		s.Failover.SetReason("deleteWebhook failed: " + s.BotA.Redact(err.Error()))
		return
	}
	good, _ := j["ok"].(bool)
	s.pollEnabled.Store(good)
	if !good {
		d := fmt.Sprint(j["description"])
		if j["description"] == nil || d == "" {
			d = "not ok"
		}
		s.Failover.SetReason("deleteWebhook failed: " + d)
	}
}

func (s *Server) leavePolling(ctx context.Context) {
	s.pollEnabled.Store(false)
	j, err := s.BotA.SetWebhook(ctx, s.Cfg.WebhookURL, s.Cfg.WebhookSecret)
	if err != nil {
		s.Failover.ActionFailed("setWebhook", s.BotA.Redact(err.Error()))
		s.enterPolling(ctx)
		return
	}
	if good, _ := j["ok"].(bool); !good {
		d := fmt.Sprint(j["description"])
		if j["description"] == nil {
			d = "not ok"
		}
		s.Failover.ActionFailed("setWebhook", d)
		s.enterPolling(ctx)
	}
}

func jstr(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case json.Number:
		return t.String()
	}
	return fmt.Sprint(v)
}

// HealthTick is one health tick. In webhook mode: idempotent setWebhook if unregistered, getWebhookInfo (error /
// last_error), self-test of the public route when the chat has been silent. In polling mode: self-test and switch back
// after recoverChecks healthy ticks. self overrides the self-test (tests). Secrets are never logged.
func (s *Server) HealthTick(ctx context.Context, self func() bool) map[string]any {
	if self == nil {
		self = func() bool { return s.SelfTest(ctx) }
	}
	f := s.Failover
	if f.State() == "degraded" {
		return f.Snapshot()
	}
	if f.Polling() {
		if !s.pollEnabled.Load() {
			s.enterPolling(ctx) // a failed deleteWebhook is retried every tick
		}
		res := f.Evaluate(relay.Sig{SelfTestOk: relay.Bool(self())})
		if res.Action == "setWebhook" {
			s.leavePolling(ctx)
		}
		return f.Snapshot()
	}
	var sig relay.Sig
	j, err := s.BotA.GetWebhookInfo(ctx)
	if err != nil {
		sig.InfoError = s.BotA.Redact(err.Error())
	} else if good, _ := j["ok"].(bool); !good {
		sig.InfoError = strings.TrimSpace(jstr(j["error_code"]) + " " + orDefault(jstr(j["description"]), "not ok"))
	} else {
		res := func() map[string]any { m, _ := j["result"].(map[string]any); return m }
		if jstr(res()["url"]) != s.Cfg.WebhookURL {
			set, err := s.BotA.SetWebhook(ctx, s.Cfg.WebhookURL, s.Cfg.WebhookSecret)
			if good, _ := set["ok"].(bool); err != nil || !good {
				sig.NotRegistered = true
			} else if j2, err := s.BotA.GetWebhookInfo(ctx); err != nil {
				sig.InfoError = s.BotA.Redact(err.Error())
			} else {
				j = j2
			}
		}
		if g, _ := j["ok"].(bool); g && sig.InfoError == "" {
			if n, isNum := res()["last_error_date"].(json.Number); isNum {
				if d, _ := n.Float64(); d != 0 {
					sig.LastErrorAt = int64(d * 1000)
					sig.LastErrorMessage = jstr(res()["last_error_message"])
				}
			}
		}
	}
	r := f.Evaluate(sig)
	if r.NeedSelfTest {
		sig.SelfTestOk = relay.Bool(self())
		r = f.Evaluate(sig)
	}
	if r.Action == "deleteWebhook" {
		s.enterPolling(ctx)
	}
	return f.Snapshot()
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// NewEphemeralSecret returns a random 64-hex secret (shadow mode: nothing outside the process can know it).
func NewEphemeralSecret() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
