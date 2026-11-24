package c3pub

import (
	"strings"
	"sync"
	"time"
)

// #1819: one SMTP delivery per message, however often the caller retries. The SMTP session runs on its own (long) socket
// timeouts and is not tied to the HTTP response. The response waits at most waitMs; if the session is still running the
// caller gets "pending" (the route answers 504). A retry with the same key joins the session in flight instead of starting
// one, and a retry after success is answered "delivered" without sending again. A failed session is forgotten.
// Key = target + Message-ID + recipient. A message without a Message-ID is never deduplicated.

type LedgerState int

const (
	Delivered LedgerState = iota
	Pending
	Failed
)

type LedgerResult struct {
	State   LedgerState
	Deduped bool
	Joined  bool
	Error   string
}

type ledgerEntry struct {
	mu    sync.Mutex
	state LedgerState // Pending until done
	err   string
	at    time.Time
	done  chan struct{}
}

type Ledger struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]*ledgerEntry
	now     func() time.Time
}

func NewLedger(ttl time.Duration) *Ledger {
	return &Ledger{ttl: ttl, entries: map[string]*ledgerEntry{}, now: time.Now}
}

// LedgerKey returns "" (never deduplicated) for a message without a stable id.
func LedgerKey(target, msgID, rcpt string) string {
	id := jsTrim(msgID)
	if id == "" || id == "?" {
		return ""
	}
	return target + "\x00" + id + "\x00" + strings.ToLower(jsTrim(rcpt))
}

func (l *Ledger) Size() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.entries) }

func (l *Ledger) prune() {
	t := l.now()
	for k, e := range l.entries {
		e.mu.Lock()
		old := e.state != Pending && t.Sub(e.at) > l.ttl
		e.mu.Unlock()
		if old {
			delete(l.entries, k)
		}
	}
}

func (l *Ledger) wait(e *ledgerEntry, waitFor time.Duration, joined bool) LedgerResult {
	timer := time.NewTimer(waitFor)
	defer timer.Stop()
	select {
	case <-e.done:
	case <-timer.C:
		return LedgerResult{State: Pending, Joined: joined}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state == Delivered {
		return LedgerResult{State: Delivered, Deduped: joined}
	}
	msg := e.err
	if msg == "" {
		msg = "delivery failed"
	}
	return LedgerResult{State: Failed, Error: msg}
}

// Deliver runs send once per key and answers within waitFor.
func (l *Ledger) Deliver(key string, send func() error, waitFor time.Duration) LedgerResult {
	l.mu.Lock()
	l.prune()
	if key != "" {
		if seen, ok := l.entries[key]; ok {
			seen.mu.Lock()
			st := seen.state
			seen.mu.Unlock()
			switch st {
			case Delivered:
				l.mu.Unlock()
				return LedgerResult{State: Delivered, Deduped: true}
			case Pending:
				l.mu.Unlock()
				return l.wait(seen, waitFor, true)
			default:
				delete(l.entries, key)
			}
		}
	}
	e := &ledgerEntry{state: Pending, at: l.now(), done: make(chan struct{})}
	if key != "" {
		l.entries[key] = e
	}
	l.mu.Unlock()
	go func() {
		err := send()
		e.mu.Lock()
		if err == nil {
			e.state = Delivered
		} else {
			e.state, e.err = Failed, err.Error()
		}
		e.at = l.now()
		failed := e.state == Failed
		e.mu.Unlock()
		if key != "" && failed {
			l.mu.Lock()
			if l.entries[key] == e {
				delete(l.entries, key)
			}
			l.mu.Unlock()
		}
		close(e.done)
	}()
	return l.wait(e, waitFor, false)
}
