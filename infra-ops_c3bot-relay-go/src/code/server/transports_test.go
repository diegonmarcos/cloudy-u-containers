package server

// Port of test/transports.test.js (integration: real server, fake Telegram) and the HTTP part of test/lease.test.js.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestHealthIsOpenAndReportsTransports(t *testing.T) {
	f := newFixture(t)
	c, j := f.req("GET", baseRoute+"/health", nil, nil)
	eqs(t, c, 200, "status")
	eqs(t, j["transports"], []any{"ws", "sse", "poll"}, "transports")
	eqs(t, j["botConfigured"], true, "botConfigured")
}

func TestEveryOtherRouteNeedsTheBearer(t *testing.T) {
	f := newFixture(t)
	c, _ := f.req("GET", "/poll", nil, nil)
	eqs(t, c, 401, "no bearer")
	c, _ = f.req("GET", "/poll", map[string]string{"Authorization": "Bearer nope"}, nil)
	eqs(t, c, 401, "bad bearer")
}

func TestLongPollReturnsBufferedAndWaitsForNew(t *testing.T) {
	f := newFixture(t)
	f.inject(1, 42, "first")
	_, a := f.req("GET", "/poll?after=0&wait=1", auth, nil)
	evs := a["events"].([]any)
	eqs(t, evs[0].(map[string]any)["text"], "first", "first")
	type res struct {
		j map[string]any
	}
	ch := make(chan res)
	go func() {
		_, j := f.req("GET", fmt.Sprintf("/poll?after=%v&wait=5", a["cursor"]), auth, nil)
		ch <- res{j}
	}()
	time.Sleep(50 * time.Millisecond)
	f.inject(2, 42, "second")
	select {
	case r := <-ch:
		eqs(t, r.j["events"].([]any)[0].(map[string]any)["text"], "second", "second")
	case <-time.After(4 * time.Second):
		t.Fatal("poll did not wake")
	}
}

func TestSSEReplaysAfterLastEventIDThenStreamsLive(t *testing.T) {
	f := newFixture(t)
	f.inject(1, 42, "first")
	f.inject(2, 42, "second")
	rq, _ := http.NewRequest("GET", "http://"+f.host+"/events", nil)
	rq.Header.Set("Authorization", "Bearer "+tok)
	rq.Header.Set("Last-Event-ID", fmt.Sprint(f.rl.Cursor()-1))
	resp, err := http.DefaultClient.Do(rq)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if !strings.Contains(resp.Header.Get("content-type"), "text/event-stream") {
		t.Fatal(resp.Header)
	}
	go func() { time.Sleep(50 * time.Millisecond); f.inject(3, 42, "live") }()
	sc := bufio.NewScanner(resp.Body)
	var buf strings.Builder
	done := make(chan struct{})
	go func() {
		for sc.Scan() {
			buf.WriteString(sc.Text() + "\n")
			if strings.Contains(buf.String(), "second") && strings.Contains(buf.String(), "live") {
				break
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(4 * time.Second):
		t.Fatal("no live event: " + buf.String())
	}
	s := buf.String()
	if !strings.Contains(s, "event: telegram.message") || !strings.Contains(s, ": connected") || strings.Contains(s, "first") {
		t.Fatal(s)
	}
}

func TestSendRelaysToTelegramWithDefaultChat(t *testing.T) {
	f := newFixture(t)
	c, j := f.req("POST", "/send", auth, map[string]any{"text": "out"})
	eqs(t, c, 200, "status")
	eqs(t, j["message_ids"], []any{11.0}, "ids")
	f.mu.Lock()
	defer f.mu.Unlock()
	last := f.sent[len(f.sent)-1]
	if !strings.HasPrefix(last.path, "/botFAKEA/") || last.body["chat_id"] != "42" {
		t.Fatal(last)
	}
}

func TestSendValidationAndErrorMapping(t *testing.T) {
	f := newFixture(t)
	c, j := f.req("POST", "/send", auth, map[string]any{"chat_id": 1})
	eqs(t, c, 400, "no text")
	eqs(t, j["error"], "chat_id (or default) and text required", "msg")
	g := newFixtureBot(t, "")
	c, _ = g.req("POST", "/send", auth, map[string]any{"text": "x"})
	eqs(t, c, 503, "unconfigured")
	c, j = f.req("POST", "/send", auth, "{bad")
	eqs(t, c, 500, "invalid JSON")
	eqs(t, j["error"], "invalid JSON", "msg")
}

func TestNonAllowlistedSendersNeverReachAnyTransport(t *testing.T) {
	// #1579: a foreign sender yields at most ONE telegram.chat metadata event per chat signature, never a telegram.message,
	// never its text and never its sender.
	f := newFixture(t)
	before := float64(f.rl.Cursor())
	f.inject(5, 999, "spam")
	evs := f.rl.Since(before, 100)
	if len(evs) > 1 {
		t.Fatal(len(evs))
	}
	for _, e := range evs {
		b, _ := json.Marshal(e)
		if e["type"] != "telegram.chat" || e["text"] != nil || e["from"] != nil || strings.Contains(string(b), "spam") || strings.Contains(string(b), "999") {
			t.Fatal(string(b))
		}
	}
	after := f.rl.Cursor()
	f.inject(6, 999, "spam again")
	if f.rl.Cursor() != after {
		t.Fatal("the same chat is announced once")
	}
}

func TestBotAStateExposed(t *testing.T) {
	f := newFixture(t)
	switch f.srv.BotA.State() {
	case "idle", "polling", "error", "standby":
	default:
		t.Fatal(f.srv.BotA.State())
	}
}

// ---- #1579 webhook ingestion, mode switching and dedupe ----

const wh = baseRoute + "/telegram/webhook"

func TestWebhookWrongOrMissingSecretIs401AndIngestsNothing(t *testing.T) {
	f := newFixture(t)
	before := f.rl.Cursor()
	eqs(t, f.postWebhook(tgUpd(900, 900, 42, "x", 100), "nope", wh), 401, "wrong")
	eqs(t, f.postWebhook(tgUpd(900, 900, 42, "x", 100), "-", wh), 401, "missing")
	c, _ := f.req("POST", wh, auth, "{}") // the relay bearer does not substitute
	eqs(t, c, 401, "bearer")
	eqs(t, f.rl.Cursor(), before, "cursor")
}

func TestWebhookValidPostIngestedReachesPollCarriesSourceA(t *testing.T) {
	f := newFixture(t)
	after := f.rl.Cursor()
	eqs(t, f.postWebhook(tgUpd(901, 901, 42, "reply via webhook", 100), whSecret, wh), 200, "post")
	_, j := f.req("GET", fmt.Sprintf("/c3bot-relay/poll?after=%d&wait=1", after), auth, nil)
	ev := j["events"].([]any)[0].(map[string]any)
	eqs(t, ev["source"], "A", "source")
	eqs(t, ev["update"].(map[string]any)["message"].(map[string]any)["text"], "reply via webhook", "raw update")
}

func TestWebhookForeignSendersAnnounceChatMetadataOnly(t *testing.T) {
	f := newFixture(t)
	after := f.rl.Cursor()
	eqs(t, f.postWebhook(tgUpd(902, 902, 99, "secret stranger text", 100), whSecret, wh), 200, "post")
	_, j := f.req("GET", fmt.Sprintf("/poll?after=%d&wait=1", after), auth, nil)
	evs := j["events"].([]any)
	if len(evs) != 1 || evs[0].(map[string]any)["type"] != "telegram.chat" {
		t.Fatal(evs)
	}
	if b, _ := json.Marshal(evs[0]); strings.Contains(string(b), "stranger") {
		t.Fatal("leak")
	}
}

func TestDedupeAcrossAAndBSurfacedOnce(t *testing.T) {
	f := newFixture(t)
	after := f.rl.Cursor()
	f.postWebhook(tgUpd(910, 55, 42, "same message", 777), whSecret, wh)       // Bot A webhook
	f.rl.IngestUpdate(jsonObj(tgUpd(31337, 55, 42, "same message", 777)), "P") // getUpdates copy, different update_id
	_, j := f.req("GET", fmt.Sprintf("/poll?after=%d&wait=1", after), auth, nil)
	n := 0
	for _, e := range j["events"].([]any) {
		if e.(map[string]any)["text"] == "same message" {
			n++
			eqs(t, e.(map[string]any)["source"], "A", "source")
		}
	}
	eqs(t, n, 1, "surfaced")
	f.rl.IngestUpdate(jsonObj(tgUpd(31338, 56, 42, "other message", 777)), "B") // new message_id is not a duplicate
	m := 0
	for _, e := range f.rl.Since(float64(after), 100) {
		if e["text"] == "other message" {
			m++
		}
	}
	eqs(t, m, 1, "other")
}

func TestWebhookSelfTestProbeIsAnsweredNotIngested(t *testing.T) {
	f := newFixture(t)
	before := f.rl.Cursor()
	c, j := f.req("POST", wh, map[string]string{"x-telegram-bot-api-secret-token": whSecret}, map[string]any{"selftest": "n1"})
	eqs(t, c, 200, "status")
	eqs(t, j["selftest"], true, "selftest")
	eqs(t, f.rl.Cursor(), before, "cursor")
}

func TestHealthWebhookHealthyPollingOffSecretsFree(t *testing.T) {
	f := newFixture(t)
	snap := f.srv.HealthTick(ctxT(5*time.Second), func() bool { return true })
	eqs(t, snap["state"], "webhook", "state")
	eqs(t, f.webhook, whURL, "registered declaratively with setWebhook")
	ok := false
	f.mu.Lock()
	for _, c := range f.sent {
		if strings.HasSuffix(c.path, "/setWebhook") && c.body["secret_token"] == whSecret {
			ok = true
		}
	}
	f.mu.Unlock()
	if !ok {
		t.Fatal("setWebhook with secret_token not seen")
	}
	_, h := f.req("GET", baseRoute+"/health", nil, nil)
	eqs(t, h["ingest"].(map[string]any)["state"], "webhook", "ingest.state")
	if b, _ := json.Marshal(h); strings.Contains(string(b), whSecret) || strings.Contains(string(b), "FAKE") {
		t.Fatal("secret in /health")
	}
}

func has(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func TestModeSwitchInfoErrorPollsThenRecovers(t *testing.T) {
	f := newFixture(t)
	yes, no := func() bool { return true }, func() bool { return false }
	f.set(func() { f.infoMode = "error" })
	n0 := len(f.calls())
	eqs(t, f.srv.HealthTick(ctxT(5*time.Second), yes)["state"], "polling", "state")
	if !has(f.calls()[n0:], "deleteWebhook") {
		t.Fatal("deleteWebhook not called")
	}
	eqs(t, f.webhook, "", "deleteWebhook cleared the registration")
	eqs(t, f.srv.Failover.Polling(), true, "polling")
	_, h := f.req("GET", baseRoute+"/health", nil, nil)
	eqs(t, h["ingest"].(map[string]any)["polling"], true, "health polling")
	f.set(func() { f.infoMode = "ok" })
	f.srv.HealthTick(ctxT(5*time.Second), no) // route still down: stay in polling
	eqs(t, f.srv.Failover.State(), "polling", "still polling")
	f.srv.HealthTick(ctxT(5*time.Second), yes) // 1 good
	eqs(t, f.srv.Failover.State(), "polling", "1 good")
	n1 := len(f.calls())
	eqs(t, f.srv.HealthTick(ctxT(5*time.Second), yes)["state"], "webhook", "2 good")
	if !has(f.calls()[n1:], "setWebhook") {
		t.Fatal("setWebhook not called")
	}
	eqs(t, f.webhook, whURL, "re-registered")
	_, h = f.req("GET", baseRoute+"/health", nil, nil)
	eqs(t, h["ingest"].(map[string]any)["polling"], false, "polling off")
}

func TestModeSwitchDeliveryErrorPollsAndPolledUpdateDeduped(t *testing.T) {
	f := newFixture(t)
	yes := func() bool { return true }
	f.set(func() { f.infoMode = "delivery-error" })
	eqs(t, f.srv.HealthTick(ctxT(5*time.Second), yes)["state"], "polling", "state")
	f.set(func() { f.infoMode = "ok" })
	after := float64(f.rl.Cursor())
	f.postWebhook(tgUpd(920, 77, 42, "dup across modes", 555), whSecret, wh)      // arrived by webhook just before the outage
	f.rl.IngestUpdate(jsonObj(tgUpd(4001, 77, 42, "dup across modes", 555)), "P") // re-delivered by getUpdates after deleteWebhook
	n := 0
	for _, e := range f.rl.Since(after, 100) {
		if e["text"] == "dup across modes" {
			n++
		}
	}
	eqs(t, n, 1, "once")
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	eqs(t, f.srv.Failover.State(), "webhook", "recovered")
}

func TestModeSwitchFailingSetWebhookOnTheWayBackKeepsPolling(t *testing.T) {
	f := newFixture(t)
	yes := func() bool { return true }
	f.set(func() { f.infoMode = "error" })
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	eqs(t, f.srv.Failover.State(), "polling", "polling")
	f.set(func() { f.infoMode = "ok"; f.failSet = true })
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	eqs(t, f.srv.Failover.State(), "polling", "still polling")
	eqs(t, f.srv.Failover.Polling(), true, "polling()")
	f.set(func() { f.failSet = false })
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	f.srv.HealthTick(ctxT(5*time.Second), yes)
	eqs(t, f.srv.Failover.State(), "webhook", "back")
}

func TestWebhookOtherPostPathsFallThroughToBearerGate(t *testing.T) {
	f := newFixture(t)
	eqs(t, f.postWebhook(map[string]any{}, whSecret, baseRoute+"/other"), 401, "exact route")
}

func TestWebhookWithoutSecretConfiguredIs503AndBadBodyIs400(t *testing.T) {
	f := newFixture(t)
	eqs(t, f.postWebhook("{bad", whSecret, wh), 400, "bad body")
	f.srv.Cfg.WebhookSecret = ""
	eqs(t, f.postWebhook(map[string]any{}, whSecret, wh), 503, "no secret configured")
}

// ---- lease.test.js: HTTP ----

func TestLeaseHTTPBearerGatedHealthHidesHolder(t *testing.T) {
	f := newFixture(t)
	post := func(p string, b any, h map[string]string) (int, map[string]any) {
		return f.req("POST", baseRoute+p, h, b)
	}
	c, _ := post("/claim", map[string]any{"session": "x"}, nil)
	eqs(t, c, 401, "no bearer")
	_, a := post("/claim", map[string]any{"session": "sess-a", "ttl": 60}, auth)
	eqs(t, a["granted"], true, "a")
	_, b := post("/claim", map[string]any{"session": "sess-b", "ttl": 60}, auth)
	eqs(t, b["granted"], false, "b")
	eqs(t, b["holder"], "sess-a", "holder")
	c, _ = post("/claim", map[string]any{"session": "bad name"}, auth)
	eqs(t, c, 400, "bad name")
	_, g := f.req("GET", baseRoute+"/claim", auth, nil)
	eqs(t, g["holder"], "sess-a", "GET /claim")
	_, h := f.req("GET", baseRoute+"/health", nil, nil)
	eqs(t, h["lease"].(map[string]any)["held"], true, "held")
	if bb, _ := json.Marshal(h); strings.Contains(string(bb), "sess-a") {
		t.Fatal("holder leaked in /health")
	}
	_, r := post("/release", map[string]any{"session": "sess-a"}, auth)
	eqs(t, r["released"], true, "released")
	_, n := post("/claim", map[string]any{"session": "sess-b"}, auth)
	eqs(t, n["granted"], true, "b now")
}
