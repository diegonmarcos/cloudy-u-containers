// Package relay is the core of c3bot-relay (Go port of relay.js): an in-memory event log with a cursor, fan-out to
// subscribers, dedupe and the allowlist. Transport-agnostic: the server package maps WS, SSE and long-poll onto
// Subscribe / Since / WaitFor.
package relay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Event is one ring entry: {seq, ts, type, ...data}. Values decoded from JSON use json.Number so ids round-trip.
type Event map[string]any

// Seq returns the event sequence number.
func (e Event) Seq() int64 {
	switch v := e["seq"].(type) {
	case int64:
		return v
	case json.Number:
		n, _ := v.Int64()
		return n
	case float64:
		return int64(v)
	}
	return 0
}

// Persist is the state of the restart-safety file, shown by /health.
type Persist struct {
	Enabled    bool    `json:"enabled"`
	Loaded     bool    `json:"loaded"`
	LastSaveAt *int64  `json:"lastSaveAt"`
	Error      *string `json:"error"`
}

// Options configure a Relay. Zero values take the Node defaults.
type Options struct {
	BufferSize  int
	AllowedFrom []string
	DedupeSize  int
	StatePath   string
	SaveDelay   time.Duration
}

type sub struct {
	id int
	fn func(Event)
}

// Relay is the event log.
type Relay struct {
	mu         sync.Mutex
	bufferSize int
	dedupeSize int
	seen       map[string]struct{}
	seenOrder  []string
	chatSig    map[string]struct{}
	chatOrder  []string
	dupes      int
	allowed    []float64
	events     []Event
	seq        int64
	subs       []sub
	nextSub    int
	notify     chan struct{} // closed and replaced on every publish (long-poll wake-up)

	statePath string
	saveDelay time.Duration
	saveTimer *time.Timer
	persist   Persist
}

// New builds a Relay and loads the state file when StatePath is set.
func New(o Options) *Relay {
	r := &Relay{bufferSize: o.BufferSize, dedupeSize: o.DedupeSize, saveDelay: o.SaveDelay, statePath: o.StatePath,
		seen: map[string]struct{}{}, chatSig: map[string]struct{}{}, notify: make(chan struct{}), events: []Event{}}
	if r.bufferSize <= 0 {
		r.bufferSize = 500
	}
	if r.dedupeSize <= 0 {
		r.dedupeSize = 2000
	}
	if r.saveDelay <= 0 {
		r.saveDelay = 200 * time.Millisecond
	}
	for _, s := range o.AllowedFrom {
		r.allowed = append(r.allowed, jsNumber(s))
	}
	r.persist.Enabled = o.StatePath != ""
	if o.StatePath != "" {
		r.load()
	}
	return r
}

func jsNumber(s string) float64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	var f float64
	if _, err := fmt.Sscan(s, &f); err != nil {
		return math.NaN()
	}
	return f
}

func (r *Relay) load() {
	b, err := os.ReadFile(r.statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			e := "load: " + err.Error()
			r.persist.Error = &e
		}
		return
	}
	var j struct {
		Seq    json.Number `json:"seq"`
		Events []Event     `json:"events"`
		Seen   []string    `json:"seen"`
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if err := d.Decode(&j); err != nil {
		e := "load: " + err.Error()
		r.persist.Error = &e
		return
	}
	if j.Events != nil {
		ev := j.Events
		if len(ev) > r.bufferSize {
			ev = ev[len(ev)-r.bufferSize:]
		}
		r.events = ev
	}
	n, _ := j.Seq.Int64()
	r.seq = n
	if len(r.events) > 0 {
		if l := r.events[len(r.events)-1].Seq(); l > r.seq {
			r.seq = l
		}
	}
	if j.Seen != nil {
		s := j.Seen
		if len(s) > r.dedupeSize {
			s = s[len(s)-r.dedupeSize:]
		}
		for _, k := range s {
			if _, ok := r.seen[k]; !ok {
				r.seen[k] = struct{}{}
				r.seenOrder = append(r.seenOrder, k)
			}
		}
	}
	r.persist.Loaded = true
}

func (r *Relay) save() {
	if r.statePath == "" {
		return
	}
	fail := func(err error) { e := "save: " + err.Error(); r.persist.Error = &e }
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o755); err != nil {
		fail(err)
		return
	}
	tmp := r.statePath + ".tmp"
	b, err := json.Marshal(map[string]any{"v": 1, "seq": r.seq, "events": r.events, "seen": append([]string{}, r.seenOrder...)})
	if err == nil {
		err = os.WriteFile(tmp, b, 0o644)
	}
	if err == nil {
		err = os.Rename(tmp, r.statePath)
	}
	if err != nil {
		fail(err)
		return
	}
	now := time.Now().UnixMilli()
	r.persist.LastSaveAt = &now
	r.persist.Error = nil
}

func (r *Relay) scheduleSave() {
	if r.statePath == "" || r.saveTimer != nil {
		return
	}
	r.saveTimer = time.AfterFunc(r.saveDelay, func() {
		r.mu.Lock()
		r.saveTimer = nil
		r.save()
		r.mu.Unlock()
	})
}

// Flush writes the state file now (shutdown, tests).
func (r *Relay) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.saveTimer != nil {
		r.saveTimer.Stop()
		r.saveTimer = nil
	}
	r.save()
}

// Persist returns a copy of the persistence status.
func (r *Relay) Persist() Persist {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.persist
}

// Cursor is the sequence number of the newest event.
func (r *Relay) Cursor() int64 { r.mu.Lock(); defer r.mu.Unlock(); return r.seq }

// BufferSize is the ring capacity.
func (r *Relay) BufferSize() int { return r.bufferSize }

// Dupes counts deduped deliveries.
func (r *Relay) Dupes() int { r.mu.Lock(); defer r.mu.Unlock(); return r.dupes }

// SeenLen is the size of the dedupe set.
func (r *Relay) SeenLen() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.seen) }

// Publish appends an event and fans it out. data keys are merged after seq/ts/type.
func (r *Relay) Publish(typ string, data map[string]any) Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.publish(typ, data)
}

func (r *Relay) publish(typ string, data map[string]any) Event {
	r.seq++
	ev := Event{"seq": r.seq, "ts": time.Now().UnixMilli(), "type": typ}
	for k, v := range data {
		ev[k] = v
	}
	r.events = append(r.events, ev)
	if len(r.events) > r.bufferSize {
		r.events = r.events[len(r.events)-r.bufferSize:]
	}
	r.scheduleSave()
	for _, s := range append([]sub(nil), r.subs...) {
		call(s.fn, ev)
	}
	close(r.notify)
	r.notify = make(chan struct{})
	return ev
}

// call runs one subscriber; a panicking one never blocks the rest.
func call(fn func(Event), ev Event) {
	defer func() { _ = recover() }()
	fn(ev)
}

func (r *Relay) since(after float64, limit int) []Event {
	out := []Event{}
	for _, e := range r.events {
		if float64(e.Seq()) > after {
			out = append(out, e)
			if len(out) >= limit {
				break
			}
		}
	}
	return out
}

// Since returns events with seq > after, at most limit (NaN after matches nothing, as in JS).
func (r *Relay) Since(after float64, limit int) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.since(after, limit)
}

// Subscribe registers fn for every future event.
func (r *Relay) Subscribe(fn func(Event)) (unsub func()) {
	return r.SubscribeFrom(math.Inf(1), 0, fn)
}

// SubscribeFrom atomically replays the backlog (seq > after, at most limit) into fn and registers it, so no event is
// lost or duplicated between replay and live push. fn must not block.
func (r *Relay) SubscribeFrom(after float64, limit int, fn func(Event)) (unsub func()) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if limit > 0 {
		for _, e := range r.since(after, limit) {
			call(fn, e)
		}
	}
	r.nextSub++
	id := r.nextSub
	r.subs = append(r.subs, sub{id, fn})
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		for i, s := range r.subs {
			if s.id == id {
				r.subs = append(r.subs[:i:i], r.subs[i+1:]...)
				return
			}
		}
	}
}

// WaitFor is the long-poll primitive: events after `after`, or an empty slice when wait elapses or done closes.
func (r *Relay) WaitFor(after float64, wait time.Duration, limit int, done <-chan struct{}) ([]Event, bool) {
	r.mu.Lock()
	now := r.since(after, limit)
	ch := r.notify
	r.mu.Unlock()
	if len(now) > 0 || wait <= 0 {
		return now, true
	}
	t := time.NewTimer(wait)
	defer t.Stop()
	for {
		select {
		case <-ch:
			r.mu.Lock()
			evs := r.since(after, limit)
			ch = r.notify
			r.mu.Unlock()
			if len(evs) > 0 {
				return evs, true
			}
		case <-t.C:
			return r.Since(after, limit), true
		case <-done:
			return nil, false
		}
	}
}

// ---- update access helpers (Telegram updates are untyped JSON) ----

func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }

func has(m map[string]any, k string) bool { _, ok := m[k]; return ok }

// nn is JS `??` for a key: nil when the key is absent or null.
func nn(m map[string]any, k string) any { return m[k] }

// jsStr renders a value like a JS template literal does (absent -> "undefined").
func jsStr(m map[string]any, k string) string {
	v, ok := m[k]
	if !ok {
		return "undefined"
	}
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case json.Number:
		return t.String()
	case bool:
		return fmt.Sprint(t)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func truthy(v any) bool {
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

// message picks update.message || edited_message || channel_post.
func message(u map[string]any) map[string]any {
	for _, k := range []string{"message", "edited_message", "channel_post"} {
		if truthy(u[k]) {
			return obj(u[k])
		}
	}
	return nil
}

// DedupeKey is the identity shared by both ingestion paths: chat + message_id + date (+ edit_date for an edit).
func DedupeKey(u map[string]any) (string, bool) {
	m := message(u)
	if m == nil {
		return "", false
	}
	chat := obj(m["chat"])
	if chat == nil || chat["id"] == nil || m["message_id"] == nil {
		return "", false
	}
	k := jsStr(chat, "id") + ":" + jsStr(m, "message_id") + ":" + jsStr(m, "date")
	if truthy(u["edited_message"]) {
		k += ":e"
		if m["edit_date"] != nil {
			k += jsStr(m, "edit_date")
		}
	}
	return k, true
}

func (r *Relay) isDuplicate(key string, ok bool) bool {
	if !ok {
		return false
	}
	if _, dup := r.seen[key]; dup {
		r.dupes++
		return true
	}
	r.seen[key] = struct{}{}
	r.seenOrder = append(r.seenOrder, key)
	if len(r.seen) > r.dedupeSize {
		delete(r.seen, r.seenOrder[0])
		r.seenOrder = r.seenOrder[1:]
	}
	return false
}

func (r *Relay) isAllowed(from any) bool {
	if len(r.allowed) == 0 {
		return true
	}
	var f float64
	switch t := from.(type) {
	case json.Number:
		f, _ = t.Float64()
	case string:
		f = jsNumber(t)
	case nil:
		f = 0 // Number(undefined) is NaN, Number(null) is 0; absent ids never match below
	default:
		return false
	}
	for _, a := range r.allowed {
		if a == f {
			return true
		}
	}
	return false
}

// IngestUpdate turns an inbound Telegram update into an event. Only allowlisted senders are surfaced; for everyone else
// only chat/topic metadata (no text, no sender) is announced once per signature. source is 'A' (webhook) or 'P' (getUpdates).
// Returns nil for a dropped, duplicate or unusable update.
func (r *Relay) IngestUpdate(u map[string]any, source string) Event {
	m := message(u)
	if m == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	k, ok := DedupeKey(u)
	if r.isDuplicate(k, ok) {
		return nil
	}
	from := obj(m["from"])
	var fromID any
	if from != nil {
		fromID = from["id"]
	}
	if len(r.allowed) > 0 && (from == nil || from["id"] == nil || !r.isAllowed(fromID)) {
		return r.announceChat(u, m, source)
	}
	chat := obj(m["chat"])
	var names []string
	if from != nil {
		for _, n := range []string{"first_name", "last_name"} {
			if s, _ := from[n].(string); s != "" {
				names = append(names, s)
			}
		}
	}
	var name any
	if len(names) > 0 {
		name = strings.Join(names, " ")
	}
	var text any = ""
	if t := m["text"]; t != nil {
		text = t
	} else if c := m["caption"]; c != nil {
		text = c
	}
	f := map[string]any{"username": nil, "name": name}
	if from != nil {
		if v, ok := from["id"]; ok {
			f["id"] = v
		}
		if v := from["username"]; v != nil {
			f["username"] = v
		}
	}
	data := map[string]any{"source": source, "update": u, "from": f, "thread_id": m["message_thread_id"], "text": text}
	for dst, v := range map[string]any{"update_id": u["update_id"], "message_id": m["message_id"], "date": m["date"]} {
		if has(u, dst) || has(m, dst) {
			data[dst] = v
		}
	}
	if chat != nil && has(chat, "id") {
		data["chat_id"] = chat["id"]
	}
	return r.publish("telegram.message", data)
}

func (r *Relay) announceChat(u, m map[string]any, source string) Event {
	chat := obj(m["chat"])
	if chat == nil {
		return nil
	}
	topicName := func(m map[string]any) any {
		if m == nil {
			return nil
		}
		return m["name"]
	}
	var t any = topicName(obj(m["forum_topic_created"]))
	if t == nil {
		t = topicName(obj(m["forum_topic_edited"]))
	}
	if t == nil {
		if rt := obj(m["reply_to_message"]); rt != nil {
			t = topicName(obj(rt["forum_topic_created"]))
		}
	}
	topic := ""
	if t != nil {
		topic = fmt.Sprint(t)
	}
	str := func(m map[string]any, k string) string {
		if m[k] == nil {
			return ""
		}
		return jsStr(m, k)
	}
	sig := strings.Join([]string{jsStr(chat, "id"), str(chat, "title"), str(chat, "type"), str(m, "message_thread_id"), topic}, "|")
	if _, ok := r.chatSig[sig]; ok {
		return nil
	}
	r.chatSig[sig] = struct{}{}
	r.chatOrder = append(r.chatOrder, sig)
	if len(r.chatSig) > 500 {
		delete(r.chatSig, r.chatOrder[0])
		r.chatOrder = r.chatOrder[1:]
	}
	c := map[string]any{}
	for _, k := range []string{"id", "type", "title", "first_name", "last_name"} {
		if has(chat, k) {
			c[k] = chat[k]
		}
	}
	msg := map[string]any{"chat": c}
	for _, k := range []string{"message_id", "date", "message_thread_id", "is_topic_message"} {
		if has(m, k) {
			msg[k] = m[k]
		}
	}
	for _, k := range []string{"forum_topic_created", "forum_topic_edited"} {
		if truthy(m[k]) {
			msg[k] = m[k]
		}
	}
	if rt := obj(m["reply_to_message"]); rt != nil && truthy(rt["forum_topic_created"]) {
		msg["reply_to_message"] = map[string]any{"forum_topic_created": rt["forum_topic_created"]}
	}
	upd := map[string]any{"message": msg}
	if has(u, "update_id") {
		upd["update_id"] = u["update_id"]
	}
	return r.publish("telegram.chat", map[string]any{"source": source, "update": upd, "chat_id": chat["id"], "thread_id": m["message_thread_id"]})
}
