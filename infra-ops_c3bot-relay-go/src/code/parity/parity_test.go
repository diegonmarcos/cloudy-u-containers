//go:build parity

// Package parity runs the SAME request sequences against the Node relay (infra-ops_c3bot-relay, the reference) and this Go
// port, each with its own fake Telegram API and its own state, and requires identical transcripts: status, content type,
// normalised JSON body, SSE frames, WebSocket frames and the calls each relay made to Telegram. Needs `node` on PATH
// (CI: build.json tests.parity-compare; `go test -tags parity -run TestParity ./parity/`). The reference is started with
// its own throwaway token and fake Telegram only; nothing here touches the live relay.
package parity

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"c3bot-relay/relay"
	"c3bot-relay/server"
)

const (
	token  = "parity-relay-token"
	secret = "parity-wh-secret"
	botTok = "PARITYBOT"
	prefix = "/c3bot-relay"
)

// fakeTG is a recording Telegram Bot API; tick state is driven by the scenario.
type fakeTG struct {
	srv     *httptest.Server
	mu      sync.Mutex
	calls   []string
	webhook string
	info    string // ok | error
}

func newFakeTG() *fakeTG {
	f := &fakeTG{info: "ok"}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(b, &body)
		f.mu.Lock()
		defer f.mu.Unlock()
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		w.Header().Set("content-type", "application/json")
		switch method {
		case "getWebhookInfo":
			f.calls = append(f.calls, method)
			if f.info == "error" {
				fmt.Fprint(w, `{"ok":false,"error_code":502,"description":"Bad Gateway"}`)
				return
			}
			fmt.Fprintf(w, `{"ok":true,"result":{"url":%q}}`, f.webhook)
		case "setWebhook":
			f.webhook, _ = body["url"].(string)
			f.calls = append(f.calls, fmt.Sprintf("setWebhook secret=%v allowed=%v", body["secret_token"] == secret, body["allowed_updates"]))
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case "deleteWebhook":
			f.webhook = ""
			f.calls = append(f.calls, fmt.Sprintf("deleteWebhook drop=%v", body["drop_pending_updates"]))
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case "getUpdates":
			time.Sleep(300 * time.Millisecond)
			fmt.Fprint(w, `{"ok":true,"result":[]}`)
		default:
			f.calls = append(f.calls, fmt.Sprintf("%s %s", r.URL.Path[:strings.Index(r.URL.Path[1:], "/")+1], canon(body)))
			fmt.Fprint(w, `{"ok":true,"result":{"message_id":11}}`)
		}
	}))
	return f
}

func (f *fakeTG) setInfo(s string) { f.mu.Lock(); f.info = s; f.mu.Unlock() }

// distinct lists the sorted unique non-poll calls (tick counts differ by a timing hair, kinds must not).
func (f *fakeTG) distinct() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	m := map[string]bool{}
	for _, c := range f.calls {
		m[c] = true
	}
	var out []string
	for c := range m {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

func canon(v any) string { b, _ := json.Marshal(v); return string(b) }

type impl struct {
	name string
	base string // host:port
	tg   *fakeTG
	out  []string
}

func freePort(t *testing.T) int {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitUp(t *testing.T, base string) {
	for i := 0; i < 100; i++ {
		if r, err := http.Get("http://" + base + "/health"); err == nil {
			r.Body.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("server did not come up: " + base)
}

func envFor(port int, tg *fakeTG) []string {
	return append(os.Environ(), "PORT="+fmt.Sprint(port), "HTTP_HOST=127.0.0.1", "BASE_PATH="+prefix, "C3BOT_RELAY_TOKEN="+token,
		"C3BOT_WEBHOOK_SECRET="+secret, "C3BOT_A_BOT_TOKEN="+botTok, "C3BOT_ALLOWED_FROM=42", "TELEGRAM_API_BASE="+tg.srv.URL,
		"C3BOT_WEBHOOK_URL=http://127.0.0.1:"+fmt.Sprint(port)+prefix+"/telegram/webhook", "CHECK_INTERVAL_S=1", "HEALTH_WINDOW_S=600",
		"BUFFER_SIZE=500", "MAX_CLIENTS=32", "POLL_MAX_WAIT_S=50", "RELAY_STATE_FILE=", "NODE_ENV=")
}

func startNode(t *testing.T) *impl {
	node, err := exec.LookPath("node")
	if err != nil {
		if os.Getenv("PARITY_REQUIRE") == "1" {
			t.Fatal("node not on PATH")
		}
		t.Skip("node not on PATH; the parity harness runs in CI")
	}
	dir, _ := filepath.Abs("../../../../infra-ops_c3bot-relay/src/code")
	tg, port := newFakeTG(), freePort(t)
	cmd := exec.Command(node, "server.js")
	cmd.Dir, cmd.Env = dir, envFor(port, tg)
	var logb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &logb, &logb
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait(); tg.srv.Close() })
	im := &impl{name: "node", base: fmt.Sprintf("127.0.0.1:%d", port), tg: tg}
	waitUp(t, im.base)
	return im
}

func startGo(t *testing.T) *impl {
	tg, port := newFakeTG(), freePort(t)
	bot := relay.NewTelegram(botTok, tg.srv.URL)
	rl := relay.New(relay.Options{BufferSize: 500, AllowedFrom: []string{"42"}})
	fo := relay.NewFailover(600*time.Second, true, nil)
	srv := server.New(server.Config{Base: prefix, Token: token, MaxClients: 32, PollMaxWaitS: 50, DefaultChat: "42", WebhookSecret: secret,
		WebhookURL: fmt.Sprintf("http://127.0.0.1:%d%s/telegram/webhook", port, prefix)}, rl, bot, fo, relay.NewLease(900))
	hs := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", port), Handler: srv.Handler()}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = hs.ListenAndServe() }()
	go bot.Loop(ctx, func(u map[string]any) { rl.IngestUpdate(u, "P") }, 50, 5*time.Second, 2*time.Second, func() bool { return srv.PollEnabled() && fo.Polling() })
	go func() {
		srv.HealthTick(ctx, nil)
		for tk := time.NewTicker(time.Second); ; {
			select {
			case <-tk.C:
				srv.HealthTick(ctx, nil)
			case <-ctx.Done():
				return
			}
		}
	}()
	t.Cleanup(func() { cancel(); _ = hs.Close(); tg.srv.Close() })
	im := &impl{name: "go", base: fmt.Sprintf("127.0.0.1:%d", port), tg: tg}
	waitUp(t, im.base)
	return im
}

// ---- normalisation ----

var volatile = map[string]bool{"ts": true, "lastSaveAt": true, "since": true, "lastWebhookAt": true, "at": true, "expiresAt": true, "retryInS": true}

func norm(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			if volatile[k] {
				if x != nil {
					t[k] = "<volatile>"
				}
				continue
			}
			t[k] = norm(x)
		}
	case []any:
		for i := range t {
			t[i] = norm(t[i])
		}
	}
	return v
}

func normJSON(b []byte) string {
	var v any
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		return "<non-json: " + strings.TrimSpace(string(b)) + ">"
	}
	return canon(norm(v))
}

// http runs one request and appends "label: status ctype body" to the transcript.
func (im *impl) http(label, method, path string, hdr map[string]string, body string) {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	rq, _ := http.NewRequest(method, "http://"+im.base+path, rd)
	for k, v := range hdr {
		rq.Header.Set(k, v)
	}
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(rq)
	if err != nil {
		im.out = append(im.out, label+": ERR "+err.Error())
		return
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	im.out = append(im.out, fmt.Sprintf("%s: %d %s %s", label, resp.StatusCode, resp.Header.Get("content-type"), normJSON(b)))
}

// fire posts a webhook update without logging it (it races the stream being recorded).
func (im *impl) fire(body string) {
	rq, _ := http.NewRequest("POST", "http://"+im.base+prefix+"/webhook", strings.NewReader(body))
	for k, v := range whHdr {
		rq.Header.Set(k, v)
	}
	if r, err := http.DefaultClient.Do(rq); err == nil {
		r.Body.Close()
	}
}

func (im *impl) logf(f string, a ...any) { im.out = append(im.out, fmt.Sprintf(f, a...)) }

var bearer = map[string]string{"Authorization": "Bearer " + token}
var whHdr = map[string]string{"x-telegram-bot-api-secret-token": secret, "content-type": "application/json"}

func upd(id, mid, from int, date int, extra map[string]any) string {
	m := map[string]any{"message_id": mid, "date": date, "chat": map[string]any{"id": 42, "type": "private"}}
	if from != 0 {
		m["from"] = map[string]any{"id": from, "first_name": "Ann", "last_name": "Lee", "username": "ann"}
	}
	for k, v := range extra {
		m[k] = v
	}
	return canon(map[string]any{"update_id": id, "message": m})
}

func (im *impl) scenario(t *testing.T) {
	// 1. open and gated routes
	im.http("health", "GET", prefix+"/health", nil, "")
	im.http("health-noprefix", "GET", "/health", nil, "")
	im.http("poll-nobearer", "GET", "/poll", nil, "")
	im.http("poll-badbearer", "GET", "/poll", map[string]string{"Authorization": "Bearer nope"}, "")
	im.http("poll-empty-bearer", "GET", "/poll?wait=0&token="+token, map[string]string{"Authorization": "Bearer x"}, "")
	im.http("poll-query-token", "GET", "/poll?wait=0&token="+token, nil, "")
	im.http("notfound", "GET", prefix+"/nope", bearer, "")
	im.http("method", "DELETE", prefix+"/poll", bearer, "")
	// 2. webhook auth
	im.http("wh-nosecret", "POST", prefix+"/telegram/webhook", map[string]string{}, `{}`)
	im.http("wh-wrongsecret", "POST", prefix+"/webhook", map[string]string{"x-telegram-bot-api-secret-token": "no"}, `{}`)
	im.http("wh-bearer-not-enough", "POST", prefix+"/telegram/webhook", bearer, `{}`)
	im.http("wh-badjson", "POST", prefix+"/telegram/webhook", whHdr, `{bad`)
	im.http("wh-selftest", "POST", prefix+"/telegram/webhook", whHdr, `{"selftest":"abc"}`)
	im.http("wh-other-path", "POST", prefix+"/other", whHdr, `{}`)
	// 3. ingestion: allowed, caption, no sender, foreign (announce once), duplicate, edit, repeated edit, other chat
	im.http("wh-allowed", "POST", prefix+"/telegram/webhook", whHdr, upd(1, 1, 42, 100, map[string]any{"text": "hello", "message_thread_id": 7}))
	im.http("wh-caption", "POST", prefix+"/webhook", whHdr, upd(2, 2, 42, 100, map[string]any{"caption": "pic"}))
	im.http("wh-nosender", "POST", prefix+"/webhook", whHdr, upd(3, 3, 0, 100, map[string]any{"text": "anon"}))
	im.http("wh-foreign", "POST", prefix+"/webhook", whHdr, upd(4, 4, 99, 100, map[string]any{"text": "secret stranger"}))
	im.http("wh-foreign-again", "POST", prefix+"/webhook", whHdr, upd(5, 5, 99, 101, map[string]any{"text": "again"}))
	im.http("wh-dup", "POST", prefix+"/webhook", whHdr, upd(900, 1, 42, 100, map[string]any{"text": "hello"}))
	im.http("wh-edit", "POST", prefix+"/webhook", whHdr, canon(map[string]any{"update_id": 6, "edited_message": map[string]any{"message_id": 1, "date": 100, "edit_date": 200, "chat": map[string]any{"id": 42}, "from": map[string]any{"id": 42}, "text": "hello!"}}))
	im.http("wh-edit-again", "POST", prefix+"/webhook", whHdr, canon(map[string]any{"update_id": 7, "edited_message": map[string]any{"message_id": 1, "date": 100, "edit_date": 200, "chat": map[string]any{"id": 42}, "from": map[string]any{"id": 42}, "text": "hello!"}}))
	im.http("wh-topic", "POST", prefix+"/webhook", whHdr, canon(map[string]any{"update_id": 8, "message": map[string]any{"message_id": 9, "date": 5, "chat": map[string]any{"id": -100, "title": "grp", "type": "supergroup"}, "from": map[string]any{"id": 7}, "message_thread_id": 3, "is_topic_message": true, "forum_topic_created": map[string]any{"name": "ops"}}}))
	im.http("wh-nomessage", "POST", prefix+"/webhook", whHdr, `{"update_id":10,"callback_query":{}}`)
	// 4. poll variants
	im.http("poll-all", "GET", prefix+"/poll?after=0&wait=0", bearer, "")
	im.http("poll-after", "GET", prefix+"/poll?after=3&wait=0", bearer, "")
	im.http("poll-past", "GET", prefix+"/poll?after=999&wait=0", bearer, "")
	im.http("poll-nan", "GET", prefix+"/poll?after=abc&wait=0", bearer, "")
	im.http("poll-negwait", "GET", prefix+"/poll?after=999&wait=-5", bearer, "")
	im.http("poll-timeout", "GET", prefix+"/poll?after=999&wait=0.3", bearer, "")
	// 5. send
	im.http("send-default", "POST", prefix+"/send", bearer, `{"text":"out"}`)
	im.http("send-explicit", "POST", prefix+"/send", bearer, `{"chat_id":-100,"thread_id":3,"text":"topic"}`)
	im.http("send-long", "POST", prefix+"/send", bearer, canon(map[string]any{"text": strings.Repeat("a", 9000)}))
	im.http("send-notext", "POST", prefix+"/send", bearer, `{"chat_id":1}`)
	im.http("send-badtext", "POST", prefix+"/send", bearer, `{"text":5}`)
	im.http("send-badjson", "POST", prefix+"/send", bearer, `{bad`)
	im.http("send-nobearer", "POST", prefix+"/send", nil, `{"text":"x"}`)
	// 6. lease
	im.http("claim-nobearer", "POST", prefix+"/claim", nil, `{"session":"a"}`)
	im.http("claim-a", "POST", prefix+"/claim", bearer, `{"session":"sess-a","ttl":60}`)
	im.http("claim-a-renew", "POST", prefix+"/claim", bearer, `{"session":"sess-a","ttl":"90"}`)
	im.http("claim-b", "POST", prefix+"/claim", bearer, `{"session":"sess-b"}`)
	im.http("claim-bad", "POST", prefix+"/claim", bearer, `{"session":"bad name"}`)
	im.http("claim-nosession", "POST", prefix+"/claim", bearer, `{}`)
	im.http("claim-ttl-low", "POST", prefix+"/claim", bearer, `{"session":"sess-a","ttl":1}`)
	im.http("claim-ttl-high", "POST", prefix+"/claim", bearer, `{"session":"sess-a","ttl":99999}`)
	im.http("claim-badjson", "POST", prefix+"/claim", bearer, `{bad`)
	im.http("claim-get", "GET", prefix+"/claim", bearer, "")
	im.http("release-other", "POST", prefix+"/release", bearer, `{"session":"sess-b"}`)
	im.http("release-a", "POST", prefix+"/release", bearer, `{"session":"sess-a"}`)
	im.http("claim-get-free", "GET", prefix+"/claim", bearer, "")
	im.http("health-lease", "GET", prefix+"/health", nil, "")
	// 7. SSE replay + live, then WebSocket hello/replay/send/since/errors
	im.sse(t)
	im.ws(t)
	// 8. Telegram calls made so far (sendMessage payloads), in order
	im.tg.mu.Lock()
	for _, c := range im.tg.calls {
		if strings.Contains(c, "sendMessage") {
			im.logf("tg: %s", c)
		}
	}
	im.tg.mu.Unlock()
	im.modes(t)
}

func (im *impl) sse(t *testing.T) {
	rq, _ := http.NewRequest("GET", "http://"+im.base+"/events", nil)
	rq.Header.Set("Authorization", "Bearer "+token)
	rq.Header.Set("Last-Event-ID", "2")
	resp, err := http.DefaultClient.Do(rq)
	if err != nil {
		im.logf("sse: ERR %v", err)
		return
	}
	defer resp.Body.Close()
	im.logf("sse: %d %s cache=%s", resp.StatusCode, resp.Header.Get("content-type"), resp.Header.Get("cache-control"))
	go func() {
		time.Sleep(300 * time.Millisecond)
		im.fire(upd(50, 50, 42, 300, map[string]any{"text": "live"}))
	}()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	done := make(chan struct{})
	var lines []string
	go func() {
		defer close(done)
		for sc.Scan() {
			l := sc.Text()
			if strings.HasPrefix(l, "data: ") {
				l = "data: " + normJSON([]byte(l[6:]))
			}
			lines = append(lines, l)
			if strings.Contains(l, `"text":"live"`) {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		lines = append(lines, "TIMEOUT")
	}
	for _, l := range lines {
		im.logf("sse| %s", l)
	}
}

func (im *impl) ws(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, resp, err := websocket.Dial(ctx, "ws://"+im.base+"/ws?token=wrong", nil); err == nil {
		im.logf("ws-bad: accepted")
	} else if resp != nil {
		im.logf("ws-bad: %d", resp.StatusCode)
	} else {
		im.logf("ws-bad: ERR")
	}
	c, _, err := websocket.Dial(ctx, "ws://"+im.base+prefix+"/ws?token="+token+"&after=8", nil)
	if err != nil {
		im.logf("ws: ERR %v", err)
		return
	}
	defer c.CloseNow()
	read := func() (map[string]any, bool) {
		rctx, rc := context.WithTimeout(ctx, 4*time.Second)
		defer rc()
		_, b, err := c.Read(rctx)
		if err != nil {
			im.logf("ws-recv: ERR")
			return nil, false
		}
		im.logf("ws-recv| %s", normJSON(b))
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		return m, true
	}
	recv := func(n int) {
		for i := 0; i < n; i++ {
			if _, ok := read(); !ok {
				return
			}
		}
	}
	// recvUntil reads frames in arrival order up to and including the first of the given types.
	recvUntil := func(types ...string) {
		for {
			m, ok := read()
			if !ok {
				return
			}
			for _, ty := range types {
				if m["type"] == ty {
					return
				}
			}
		}
	}
	send := func(s string) { _ = c.Write(ctx, websocket.MessageText, []byte(s)) }
	recv(1) // hello
	im.fire(upd(60, 60, 42, 301, map[string]any{"text": "wslive"}))
	recv(1)
	send(`{"type":"send","id":"a1","text":"via ws"}`)
	recvUntil("send.ok", "error")
	send(`{"type":"send","id":"a2"}`)
	recvUntil("send.ok", "error")
	send(`nope`)
	recvUntil("error")
	send(`{"type":"zzz"}`)
	recvUntil("error")
	n := len(im.sinceCount(14))
	send(`{"type":"since","after":14}`)
	recv(n)
	_ = c.Close(websocket.StatusNormalClosure, "")
}

// sinceCount asks the relay (poll) how many events a since(14) replay returns, so both sides read the same number.
func (im *impl) sinceCount(after int) []any {
	resp, err := http.DefaultClient.Do(func() *http.Request {
		rq, _ := http.NewRequest("GET", fmt.Sprintf("http://%s/poll?after=%d&wait=0", im.base, after), nil)
		rq.Header.Set("Authorization", "Bearer "+token)
		return rq
	}())
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var j map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&j)
	evs, _ := j["events"].([]any)
	return evs
}

// modes drives the failover through the real tick (CHECK_INTERVAL_S=1) against the fake Telegram.
func (im *impl) modes(t *testing.T) {
	state := func() string {
		resp, err := http.Get("http://" + im.base + "/health")
		if err != nil {
			return "ERR"
		}
		defer resp.Body.Close()
		var j map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&j)
		in, _ := j["ingest"].(map[string]any)
		return fmt.Sprintf("state=%v polling=%v webhookSecretConfigured=%v", in["state"], in["polling"], in["webhookSecretConfigured"])
	}
	until := func(want string) {
		for i := 0; i < 60; i++ {
			if strings.HasPrefix(state(), want) {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	until("state=webhook")
	im.logf("mode: %s", state())
	im.logf("tg-distinct: %v", im.tg.distinct())
	im.tg.setInfo("error")
	until("state=polling polling=true")
	im.logf("mode: %s", state())
	im.tg.setInfo("ok")
	until("state=webhook polling=false")
	im.logf("mode: %s", state())
	im.logf("tg-distinct: %v", im.tg.distinct())
}

func TestParity(t *testing.T) {
	n := startNode(t)
	g := startGo(t)
	var wg sync.WaitGroup
	for _, im := range []*impl{n, g} {
		wg.Add(1)
		go func() { defer wg.Done(); im.scenario(t) }()
	}
	wg.Wait()
	cases := 0
	var bad []string
	for i := 0; i < len(n.out) || i < len(g.out); i++ {
		var a, b string
		if i < len(n.out) {
			a = n.out[i]
		}
		if i < len(g.out) {
			b = g.out[i]
		}
		cases++
		if a != b {
			bad = append(bad, fmt.Sprintf("line %d\n  node: %s\n  go:   %s", i, a, b))
		}
	}
	if len(bad) > 0 {
		t.Fatalf("parity FAIL: %d lines, %d mismatches\n%s", cases, len(bad), strings.Join(bad, "\n"))
	}
	t.Logf("parity PASS: %d transcript lines, 0 mismatches", cases)
}
