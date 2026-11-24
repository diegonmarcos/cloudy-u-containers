package server

// Shared fixture for the ports of test/transports.test.js and test/lease.test.js (HTTP part): a real server on a loopback
// ephemeral port and a fake Telegram API.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"c3bot-relay/relay"
)

const (
	tok       = "secret-relay-token"
	whSecret  = "wh-secret"
	whURL     = "https://edge.invalid/c3bot-webhook"
	botTok    = "FAKEA"
	baseRoute = "/c3bot-relay"
)

type call struct {
	path string
	body map[string]any
}

type fixture struct {
	t        *testing.T
	srv      *Server
	rl       *relay.Relay
	hs       *httptest.Server
	host     string
	mu       sync.Mutex
	sent     []call
	webhook  string
	failSet  bool
	infoMode string // ok | error | delivery-error
	bot      string
}

func newFixture(t *testing.T) *fixture { return newFixtureBot(t, botTok) }

func newFixtureBot(t *testing.T, bot string) *fixture {
	f := &fixture{t: t, infoMode: "ok", bot: bot}
	tg := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.sent = append(f.sent, call{r.URL.Path, body})
		w.Header().Set("content-type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/getWebhookInfo"):
			switch f.infoMode {
			case "error":
				fmt.Fprint(w, `{"ok":false,"error_code":502,"description":"Bad Gateway"}`)
			default:
				le := 0
				if f.infoMode == "delivery-error" {
					le = int(time.Now().Unix()) + 1
				}
				fmt.Fprintf(w, `{"ok":true,"result":{"url":%q,"last_error_date":%d,"last_error_message":"Wrong response from the webhook: 502"}}`, f.webhook, le)
			}
		case strings.HasSuffix(r.URL.Path, "/setWebhook"):
			if f.failSet {
				fmt.Fprint(w, `{"ok":false,"error_code":500,"description":"boom"}`)
				return
			}
			f.webhook, _ = body["url"].(string)
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case strings.HasSuffix(r.URL.Path, "/deleteWebhook"):
			f.webhook = ""
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		default:
			fmt.Fprint(w, `{"ok":true,"result":{"message_id":11}}`)
		}
	}))
	t.Cleanup(tg.Close)
	f.rl = relay.New(relay.Options{BufferSize: 500, AllowedFrom: []string{"42"}})
	botc := relay.NewTelegram(bot, tg.URL)
	fo := relay.NewFailover(600*time.Second, botc.Configured() && true, nil)
	f.srv = New(Config{Base: baseRoute, Token: tok, MaxClients: 32, PollMaxWaitS: 50, DefaultChat: "42", WebhookSecret: whSecret, WebhookURL: whURL},
		f.rl, botc, fo, relay.NewLease(900))
	f.hs = httptest.NewServer(f.srv.Handler())
	t.Cleanup(func() { f.hs.CloseClientConnections(); f.hs.Close() })
	f.host = strings.TrimPrefix(f.hs.URL, "http://")
	return f
}

func (f *fixture) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.sent {
		out = append(out, c.path[strings.LastIndex(c.path, "/")+1:])
	}
	return out
}

func (f *fixture) set(fn func()) { f.mu.Lock(); fn(); f.mu.Unlock() }

func (f *fixture) inject(id, from int, text string) relay.Event {
	return f.rl.IngestUpdate(map[string]any{"update_id": json.Number(fmt.Sprint(id)), "message": map[string]any{
		"message_id": json.Number(fmt.Sprint(id)), "date": json.Number("1"), "chat": map[string]any{"id": json.Number("42")},
		"from": map[string]any{"id": json.Number(fmt.Sprint(from))}, "text": text}}, "A")
}

// req performs an HTTP call and returns status + decoded JSON object.
func (f *fixture) req(method, path string, hdr map[string]string, body any) (int, map[string]any) {
	f.t.Helper()
	var rd io.Reader
	if s, ok := body.(string); ok {
		rd = strings.NewReader(s)
	} else if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	rq, _ := http.NewRequest(method, "http://"+f.host+path, rd)
	for k, v := range hdr {
		rq.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(rq)
	if err != nil {
		f.t.Fatal(err)
	}
	defer resp.Body.Close()
	var j map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&j)
	return resp.StatusCode, j
}

var auth = map[string]string{"Authorization": "Bearer " + tok}

func (f *fixture) postWebhook(body any, secret string, path string) int {
	h := map[string]string{"content-type": "application/json"}
	if secret != "-" {
		h["x-telegram-bot-api-secret-token"] = secret
	}
	c, _ := f.req("POST", path, h, body)
	return c
}

func tgUpd(id, mid, from int, text string, date int) map[string]any {
	return map[string]any{"update_id": id, "message": map[string]any{"message_id": mid, "date": date, "chat": map[string]any{"id": 42, "type": "private"},
		"from": map[string]any{"id": from}, "text": text}}
}

func ctxT(d time.Duration) context.Context {
	c, cancel := context.WithTimeout(context.Background(), d)
	_ = cancel
	return c
}

func eqs(t *testing.T, got, want any, what string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("%s: got %v want %v", what, got, want)
	}
}

// jsonObj round-trips v through JSON with UseNumber, as the webhook path decodes updates.
func jsonObj(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	var m map[string]any
	_ = d.Decode(&m)
	return m
}
