package relay

import (
	"fmt"
	"sync"
	"time"
)

// Failover is the health and mode-switch state machine for Bot A ingestion (port of failover.js, #1579). ONE bot token:
// the two ingestion paths are two MODES of it, never concurrent. webhook (primary), polling (webhook unhealthy:
// deleteWebhook + getUpdates), degraded (token or webhook secret missing). Pure and clock-injected: Evaluate returns the
// ACTION the caller must run ("deleteWebhook" entering polling, "setWebhook" leaving it) and reports failures back
// through ActionFailed.
type Failover struct {
	mu           sync.Mutex
	windowMs     int64
	recoverCheck int
	now          func() int64
	startedAt    int64
	lastWebhook  int64
	state        string
	reason       *string
	since        int64
	good         int
	transitions  []Transition
}

// Transition is one mode change (the last 20 are kept).
type Transition struct {
	At     int64   `json:"at"`
	From   string  `json:"from"`
	To     string  `json:"to"`
	Reason *string `json:"reason"`
}

// Sig is the evidence of one health tick.
type Sig struct {
	InfoError        string
	NotRegistered    bool
	LastErrorAt      int64 // ms, 0 = none
	LastErrorMessage string
	SelfTestOk       *bool
}

// Result of Evaluate.
type Result struct {
	State        string
	NeedSelfTest bool
	Action       string
}

func NewFailover(window time.Duration, configured bool, now func() int64) *Failover {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	f := &Failover{windowMs: window.Milliseconds(), recoverCheck: 2, now: now, state: "webhook", transitions: []Transition{}}
	f.startedAt = now()
	f.since = f.startedAt
	if !configured {
		f.state = "degraded"
		r := "bot A token or webhook secret not configured"
		f.reason = &r
	}
	return f
}

func (f *Failover) NoteWebhookUpdate() { f.mu.Lock(); f.lastWebhook = f.now(); f.mu.Unlock() }
func (f *Failover) State() string      { f.mu.Lock(); defer f.mu.Unlock(); return f.state }
func (f *Failover) Polling() bool      { return f.State() == "polling" }
func (f *Failover) Reason() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reason == nil {
		return ""
	}
	return *f.reason
}
func (f *Failover) SetReason(s string) { f.mu.Lock(); f.reason = &s; f.mu.Unlock() }
func (f *Failover) Transitions() []Transition {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Transition{}, f.transitions...)
}

func (f *Failover) silent() bool {
	m := f.lastWebhook
	if f.startedAt > m {
		m = f.startedAt
	}
	return f.now()-m > f.windowMs
}

// Bool returns a pointer for Sig.SelfTestOk.
func Bool(b bool) *bool { return &b }

func (f *Failover) Evaluate(sig Sig) Result {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state == "degraded" {
		return Result{State: f.state}
	}
	t := f.now()
	if f.state == "polling" {
		if sig.SelfTestOk == nil {
			return Result{State: f.state, NeedSelfTest: true}
		}
		if !*sig.SelfTestOk {
			f.good = 0
			return Result{State: f.state}
		}
		f.good++
		if f.good >= f.recoverCheck {
			f.to("webhook", nil)
			return Result{State: f.state, Action: "setWebhook"}
		}
		return Result{State: f.state}
	}
	bad := ""
	switch {
	case sig.InfoError != "":
		bad = "getWebhookInfo/setWebhook failed: " + sig.InfoError
	case sig.NotRegistered:
		bad = "webhook not registered at the relay url and setWebhook failed"
	case sig.LastErrorAt != 0 && t-sig.LastErrorAt <= f.windowMs && sig.LastErrorAt > f.lastWebhook:
		m := sig.LastErrorMessage
		if m == "" {
			m = "unknown"
		}
		bad = "telegram reports a delivery error: " + m
	case f.silent():
		if sig.SelfTestOk == nil {
			return Result{State: f.state, NeedSelfTest: true}
		}
		if !*sig.SelfTestOk {
			bad = fmt.Sprintf("no webhook update for %ds and the public route self-test failed", (f.windowMs+500)/1000)
		}
	}
	if bad != "" {
		f.good = 0
		f.to("polling", &bad)
		return Result{State: f.state, Action: "deleteWebhook"}
	}
	return Result{State: f.state}
}

// ActionFailed: the caller could not perform the action (a failed setWebhook while leaving polling falls back).
func (f *Failover) ActionFailed(action, why string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if action == "setWebhook" && f.state == "webhook" {
		f.good = 0
		r := "setWebhook failed: " + why
		f.to("polling", &r)
	}
}

func (f *Failover) to(next string, reason *string) {
	if next == f.state {
		f.reason = reason
		return
	}
	f.transitions = append(f.transitions, Transition{f.now(), f.state, next, reason})
	if len(f.transitions) > 20 {
		f.transitions = f.transitions[1:]
	}
	f.state, f.reason, f.since = next, reason, f.now()
}

// Snapshot is the /health "ingest" block.
func (f *Failover) Snapshot() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	fb := "standby (same Bot A token, deleteWebhook + getUpdates)"
	switch f.state {
	case "degraded":
		fb = "degraded: Bot A token or webhook secret missing"
	case "polling":
		fb = "active (Bot A getUpdates)"
	}
	var last any
	if f.lastWebhook != 0 {
		last = f.lastWebhook
	}
	return map[string]any{"mode": f.state, "state": f.state, "reason": f.reason, "since": f.since, "lastWebhookAt": last,
		"windowS": (f.windowMs + 500) / 1000, "fallback": fb, "transitions": append([]Transition{}, f.transitions...)}
}
