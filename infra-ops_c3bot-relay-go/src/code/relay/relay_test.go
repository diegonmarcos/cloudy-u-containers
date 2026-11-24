package relay

// Port of test/relay.test.js (ring, ingest, dedupe, Telegram client, failover state machine), test/lease.test.js (unit
// part) and test/persist.test.js. The three hand-rolled RFC 6455 tests of relay.test.js (accept key, decoder, 16-bit
// length) have no Go counterpart because the framing is coder/websocket; the same behaviours are exercised on the wire in
// server/ws_test.go.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func num(i int) json.Number { return json.Number(fmt.Sprint(i)) }

func upd(id, from int, text string) map[string]any {
	return map[string]any{"update_id": num(id), "message": map[string]any{"message_id": num(id), "date": num(1),
		"chat": map[string]any{"id": num(7)}, "from": map[string]any{"id": num(from), "first_name": "A"}, "text": text}}
}

func seqs(evs []Event) []int64 {
	out := []int64{}
	for _, e := range evs {
		out = append(out, e.Seq())
	}
	return out
}

func TestIngestDropsSendersOutsideAllowlist(t *testing.T) {
	r := New(Options{AllowedFrom: []string{"42"}})
	dropped := r.IngestUpdate(upd(1, 99, "x"), "A")
	if dropped["type"] != "telegram.chat" { // metadata only (#1579), the text and sender never surface
		t.Fatalf("got %v", dropped["type"])
	}
	if b, _ := json.Marshal(dropped); strings.Contains(string(b), `"x"`) {
		t.Fatal("text leaked")
	}
	if ev := r.IngestUpdate(upd(2, 42, "hi"), "A"); ev["text"] != "hi" {
		t.Fatalf("got %v", ev)
	}
	if r.Cursor() != 2 {
		t.Fatalf("cursor %d", r.Cursor())
	}
}

func TestRingBufferBoundedAndSinceHonoursCursor(t *testing.T) {
	r := New(Options{BufferSize: 3})
	for i := 0; i < 5; i++ {
		r.Publish("t", map[string]any{"i": i})
	}
	if got := seqs(r.Since(0, 100)); !reflect.DeepEqual(got, []int64{3, 4, 5}) {
		t.Fatal(got)
	}
	if got := seqs(r.Since(4, 100)); !reflect.DeepEqual(got, []int64{5}) {
		t.Fatal(got)
	}
}

func TestWaitForResolvesOnPublishAndTimesOutEmpty(t *testing.T) {
	r := New(Options{})
	done := make(chan []Event)
	go func() { evs, _ := r.WaitFor(0, 2*time.Second, 100, nil); done <- evs }()
	time.Sleep(20 * time.Millisecond)
	r.Publish("t", nil)
	select {
	case evs := <-done:
		if len(evs) != 1 {
			t.Fatal(len(evs))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waiter not woken")
	}
	if evs, _ := r.WaitFor(1, 20*time.Millisecond, 100, nil); len(evs) != 0 {
		t.Fatal("expected empty")
	}
}

func TestSubscriberPanicNeverBlocksOthers(t *testing.T) {
	r := New(Options{})
	n := 0
	r.Subscribe(func(Event) { panic("boom") })
	r.Subscribe(func(Event) { n++ })
	r.Publish("t", nil)
	if n != 1 {
		t.Fatal(n)
	}
}

func TestChunkTextSplitsAtTelegramCap(t *testing.T) {
	if n := len(ChunkText(strings.Repeat("a", 9000), TelegramMax)); n != 3 {
		t.Fatal(n)
	}
	if n := len(ChunkText("ok", TelegramMax)); n != 1 {
		t.Fatal(n)
	}
	// cap is in UTF-16 units: 2049 astral runes (2 units each) need two chunks, never split inside a pair
	for _, c := range ChunkText(strings.Repeat("\U0001F600", 2049), TelegramMax) {
		if strings.ContainsRune(c, '�') {
			t.Fatal("split a surrogate pair")
		}
	}
}

func TestTelegramWithoutTokenIsUnconfigured(t *testing.T) {
	tg := NewTelegram("", "")
	if tg.State() != "unconfigured" {
		t.Fatal(tg.State())
	}
	_, err := tg.Send(context.Background(), 1, "x", nil)
	if e, ok := err.(*Error); !ok || e.Code != "unconfigured" {
		t.Fatal(err)
	}
}

func TestTelegramSendPostsSendMessageAndReturnsIDs(t *testing.T) {
	var path string
	var body map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&body)
		fmt.Fprint(w, `{"ok":true,"result":{"message_id":9}}`)
	}))
	defer ts.Close()
	tg := NewTelegram("TOK", ts.URL)
	ids, err := tg.Send(context.Background(), 5, "yo", 3)
	if err != nil || len(ids) != 1 || fmt.Sprint(ids[0]) != "9" {
		t.Fatal(ids, err)
	}
	if !strings.HasSuffix(path, "/botTOK/sendMessage") || fmt.Sprint(body["message_thread_id"]) != "3" {
		t.Fatal(path, body)
	}
}

// ---- #1579 dedupe across the webhook and getUpdates paths of the same Bot A token ----

func msg(id, date, chat int) map[string]any {
	return map[string]any{"message_id": num(id), "date": num(date), "chat": map[string]any{"id": num(chat)}, "from": map[string]any{"id": num(42)}, "text": "a"}
}

func TestDedupeIdentityIsChatMessageDate(t *testing.T) {
	r := New(Options{AllowedFrom: []string{"42"}})
	if r.IngestUpdate(map[string]any{"update_id": num(1), "message": msg(5, 9, 7)}, "A") == nil {
		t.Fatal("first")
	}
	if r.IngestUpdate(map[string]any{"update_id": num(999), "message": msg(5, 9, 7)}, "B") != nil {
		t.Fatal("duplicate surfaced")
	}
	if r.IngestUpdate(map[string]any{"update_id": num(1000), "message": msg(5, 10, 7)}, "B") == nil {
		t.Fatal("other date is another message")
	}
	if r.IngestUpdate(map[string]any{"update_id": num(1001), "message": msg(5, 9, 8)}, "B") == nil {
		t.Fatal("other chat is another message")
	}
	if r.Dupes() != 1 {
		t.Fatal(r.Dupes())
	}
}

func TestDedupeEditIsNewEventRepeatedEditIsNotSeenSetBounded(t *testing.T) {
	r := New(Options{AllowedFrom: []string{"42"}, DedupeSize: 3})
	base := msg(5, 9, 7)
	edited := func() map[string]any { m := msg(5, 9, 7); m["edit_date"] = num(20); m["text"] = "b"; return m }
	if r.IngestUpdate(map[string]any{"update_id": num(1), "message": base}, "A") == nil {
		t.Fatal("1")
	}
	if r.IngestUpdate(map[string]any{"update_id": num(2), "edited_message": edited()}, "A") == nil {
		t.Fatal("edit is new")
	}
	if r.IngestUpdate(map[string]any{"update_id": num(3), "edited_message": edited()}, "A") != nil {
		t.Fatal("repeated edit")
	}
	for i := 0; i < 5; i++ {
		r.IngestUpdate(map[string]any{"update_id": num(10 + i), "message": msg(100+i, 9, 7)}, "A")
	}
	if r.SeenLen() != 3 {
		t.Fatal(r.SeenLen())
	}
}

func TestIngestTagsSourceAndForeignChatsAnnounceOnce(t *testing.T) {
	r := New(Options{AllowedFrom: []string{"42"}})
	ev := r.IngestUpdate(map[string]any{"update_id": num(1), "message": msg(1, 1, 7)}, "B")
	if ev["source"] != "B" {
		t.Fatal(ev["source"])
	}
	m := func(id int) map[string]any {
		return map[string]any{"update_id": num(id), "message": map[string]any{"message_id": num(id), "date": num(1),
			"chat": map[string]any{"id": num(-100), "title": "grp", "type": "supergroup"}, "from": map[string]any{"id": num(9)}, "text": "foreign"}}
	}
	a := r.IngestUpdate(m(2), "A")
	if a["type"] != "telegram.chat" {
		t.Fatal(a["type"])
	}
	am := a["update"].(map[string]any)["message"].(map[string]any)
	if _, ok := am["text"]; ok {
		t.Fatal("text")
	}
	if _, ok := am["from"]; ok {
		t.Fatal("from")
	}
	if r.IngestUpdate(m(3), "A") != nil {
		t.Fatal("announced twice")
	}
}

// ---- mode-switch state machine, ONE token (injected clock) ----

type clk struct{ t int64 }

func (c *clk) now() int64 { return c.t }
func mk(c *clk, configured bool) *Failover {
	return NewFailover(600*time.Second, configured, c.now)
}

func TestModesHealthyWebhookStaysQuietChatWithPassingSelfTestIsHealthy(t *testing.T) {
	c := &clk{t: 1_000_000}
	f := mk(c, true)
	if f.Evaluate(Sig{}).State != "webhook" {
		t.Fatal()
	}
	c.t += 700000
	if !f.Evaluate(Sig{}).NeedSelfTest {
		t.Fatal("needSelfTest")
	}
	r := f.Evaluate(Sig{SelfTestOk: Bool(true)})
	if r.State != "webhook" || r.Action != "" {
		t.Fatal(r)
	}
}

func TestModesSilencePlusFailingSelfTestPollsRecoveryNeedsTwoGood(t *testing.T) {
	c := &clk{t: 1_000_000}
	f := mk(c, true)
	c.t += 700000
	r := f.Evaluate(Sig{SelfTestOk: Bool(false)})
	if r.State != "polling" || r.Action != "deleteWebhook" || !f.Polling() {
		t.Fatal(r)
	}
	if !f.Evaluate(Sig{}).NeedSelfTest {
		t.Fatal()
	}
	if f.Evaluate(Sig{SelfTestOk: Bool(false)}).Action != "" {
		t.Fatal()
	}
	if f.Evaluate(Sig{SelfTestOk: Bool(true)}).State != "polling" { // one pass is not enough (the failed one reset the count)
		t.Fatal()
	}
	r = f.Evaluate(Sig{SelfTestOk: Bool(true)})
	if r.State != "webhook" || r.Action != "setWebhook" {
		t.Fatal(r)
	}
	var to []string
	for _, x := range f.Transitions() {
		to = append(to, x.To)
	}
	if !reflect.DeepEqual(to, []string{"polling", "webhook"}) {
		t.Fatal(to)
	}
}

func TestModesInfoErrorLastErrorAndUnregistrableEachPollAtOnce(t *testing.T) {
	for _, sig := range []Sig{{InfoError: "502 Bad Gateway"}, {NotRegistered: true}, {LastErrorAt: 1_000_000 + 1, LastErrorMessage: "Wrong response: 502"}} {
		c := &clk{t: 1_000_000}
		f := mk(c, true)
		c.t++
		r := f.Evaluate(sig)
		if r.State != "polling" || r.Action != "deleteWebhook" {
			t.Fatal(sig, r)
		}
	}
}

func TestModesDeliveryErrorOlderThanLastWebhookUpdateIgnored(t *testing.T) {
	c := &clk{t: 1_000_000}
	f := mk(c, true)
	old := c.t - 1000
	c.t += 5
	f.NoteWebhookUpdate()
	if f.Evaluate(Sig{LastErrorAt: old}).State != "webhook" {
		t.Fatal()
	}
	if f.Evaluate(Sig{LastErrorAt: c.t + 1}).State != "polling" {
		t.Fatal()
	}
}

func TestModesFailedSetWebhookWhileLeavingPollingFallsBack(t *testing.T) {
	c := &clk{t: 1_000_000}
	f := mk(c, true)
	f.Evaluate(Sig{InfoError: "x"})
	f.Evaluate(Sig{SelfTestOk: Bool(true)})
	if f.Evaluate(Sig{SelfTestOk: Bool(true)}).State != "webhook" {
		t.Fatal()
	}
	f.ActionFailed("setWebhook", "boom")
	if f.State() != "polling" || !strings.Contains(f.Reason(), "setWebhook failed: boom") {
		t.Fatal(f.State(), f.Reason())
	}
}

func TestModesDegradedWithoutTokenOrSecretNeverSwitches(t *testing.T) {
	c := &clk{t: 1_000_000}
	f := mk(c, false)
	if f.State() != "degraded" || f.Evaluate(Sig{InfoError: "x"}).Action != "" {
		t.Fatal()
	}
	if fb, _ := f.Snapshot()["fallback"].(string); !strings.HasPrefix(fb, "degraded") {
		t.Fatal(fb)
	}
}

// ---- lease (unit part of lease.test.js) ----

func newLease(t *int64) *Lease {
	l := NewLease(900)
	l.Now = func() int64 { return *t }
	return l
}

func claim(t *testing.T, l *Lease, s string, ttl any) map[string]any {
	t.Helper()
	r, err := l.Claim(s, ttl)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestLeaseFirstClaimerWinsSecondRefusedUntilExpiry(t *testing.T) {
	var now int64 = 1000
	l := newLease(&now)
	a := claim(t, l, "sess-a", 60.0)
	if a["granted"] != true || a["holder"] != "sess-a" {
		t.Fatal(a)
	}
	b := claim(t, l, "sess-b", 60.0)
	if b["granted"] != false || b["holder"] != "sess-a" || b["retryInS"] != int64(60) {
		t.Fatal(b)
	}
	now += 59_999
	if claim(t, l, "sess-b", 60.0)["granted"] != false {
		t.Fatal()
	}
	now++
	b2 := claim(t, l, "sess-b", 60.0)
	if b2["granted"] != true || b2["holder"] != "sess-b" || b2["renewed"] != false {
		t.Fatal(b2)
	}
}

func TestLeaseHolderRenews(t *testing.T) {
	var now int64
	l := newLease(&now)
	claim(t, l, "a", 60.0)
	now = 50_000
	r := claim(t, l, "a", 60.0)
	if r["granted"] != true || r["renewed"] != true || r["expiresAt"] != int64(110_000) {
		t.Fatal(r)
	}
	now = 100_000
	if claim(t, l, "b", 60.0)["granted"] != false || l.Snapshot()["renewals"] != 1 {
		t.Fatal()
	}
}

func TestLeaseReleaseOnlyForHolder(t *testing.T) {
	var now int64 = 1
	l := newLease(&now)
	claim(t, l, "a", nil)
	if l.Release("b")["released"] != false || l.Snapshot()["holder"] != "a" {
		t.Fatal()
	}
	if l.Release("a")["released"] != true || l.Snapshot()["holder"] != nil || claim(t, l, "b", nil)["granted"] != true {
		t.Fatal()
	}
}

func TestLeaseTTLClampedDefaultedBadSessionsRejected(t *testing.T) {
	var now int64 = 1
	l := newLease(&now)
	if claim(t, l, "a", 1.0)["ttl"] != 30.0 || claim(t, l, "a", 99999.0)["ttl"] != 3600.0 || claim(t, l, "a", nil)["ttl"] != 900.0 {
		t.Fatal()
	}
	for _, bad := range []any{nil, "", "has space", strings.Repeat("x", 129), 7.0} {
		if _, err := l.Claim(bad, nil); err == nil || !strings.Contains(err.Error(), "session") {
			t.Fatal(bad, err)
		}
	}
}

func TestLeaseConcurrentClaimersExactlyOneWins(t *testing.T) {
	var now int64 = 1
	l := newLease(&now)
	won := 0
	for i := 0; i < 20; i++ {
		if claim(t, l, fmt.Sprintf("s%d", i), 60.0)["granted"] == true {
			won++
			if i != 0 {
				t.Fatal("not the first")
			}
		}
	}
	if won != 1 {
		t.Fatal(won)
	}
}

// ---- persist.test.js: restart safety (#1795) ----

func updP(id int, text string) map[string]any {
	return map[string]any{"update_id": num(id), "message": map[string]any{"message_id": num(id), "date": num(1),
		"chat": map[string]any{"id": num(42)}, "from": map[string]any{"id": num(42)}, "text": text}}
}

func TestPersistRestartKeepsUnreadCursorAndDedupe(t *testing.T) {
	f := filepath.Join(t.TempDir(), "state", "relay-state.json")
	a := New(Options{AllowedFrom: []string{"42"}, StatePath: f})
	a.IngestUpdate(updP(1, "hello"), "A")
	a.IngestUpdate(updP(2, "second"), "A")
	a.Flush()
	if _, err := os.Stat(f); err != nil || a.Persist().Error != nil {
		t.Fatal(err, a.Persist().Error)
	}
	b := New(Options{AllowedFrom: []string{"42"}, StatePath: f})
	if !b.Persist().Loaded || b.Cursor() != 2 {
		t.Fatal(b.Persist(), b.Cursor())
	}
	var texts []any
	for _, e := range b.Since(0, 100) {
		texts = append(texts, e["text"])
	}
	if !reflect.DeepEqual(texts, []any{"hello", "second"}) {
		t.Fatal(texts)
	}
	if b.IngestUpdate(updP(2, "second"), "A") != nil {
		t.Fatal("a redelivered update stays a duplicate")
	}
	if ev := b.IngestUpdate(updP(3, "third"), "A"); ev == nil || ev.Seq() != 3 {
		t.Fatal("seq continues, never reused")
	}
}

func TestPersistRingBoundHoldsAcrossReload(t *testing.T) {
	f := filepath.Join(t.TempDir(), "s.json")
	a := New(Options{AllowedFrom: []string{"42"}, StatePath: f, BufferSize: 3})
	for i := 1; i <= 5; i++ {
		a.IngestUpdate(updP(i, fmt.Sprintf("m%d", i)), "A")
	}
	a.Flush()
	b := New(Options{AllowedFrom: []string{"42"}, StatePath: f, BufferSize: 3})
	if got := seqs(b.Since(0, 100)); !reflect.DeepEqual(got, []int64{3, 4, 5}) || b.Cursor() != 5 {
		t.Fatal(got, b.Cursor())
	}
}

func TestPersistCorruptFileStartsEmptyAndReports(t *testing.T) {
	f := filepath.Join(t.TempDir(), "s.json")
	_ = os.WriteFile(f, []byte("{not json"), 0o644)
	r := New(Options{StatePath: f})
	if e := r.Persist().Error; r.Cursor() != 0 || e == nil || !strings.HasPrefix(*e, "load:") {
		t.Fatal(r.Cursor(), e)
	}
	m := New(Options{})
	m.Publish("x", nil)
	m.Flush()
	if m.Persist().Enabled {
		t.Fatal("memory only")
	}
}

func TestPersistUnwritableDirKeepsRunningAndReports(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores directory permissions (the Node test skips on uid 0 too)")
	}
	dir := t.TempDir()
	_ = os.Chmod(dir, 0o500)
	r := New(Options{StatePath: filepath.Join(dir, "s.json")})
	r.Publish("x", map[string]any{"a": 1})
	r.Flush()
	if e := r.Persist().Error; e == nil || !strings.HasPrefix(*e, "save:") || len(r.Since(0, 100)) != 1 {
		t.Fatal(e)
	}
}
