package relay

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// Lease is the session lease (#1795): exactly one Claude session answers an owner message that is not a reply. The first
// claimer holds it, the holder renews it with the same call, another session is refused until it expires or is released.
// In-memory by design: a restart frees the lease.
type Lease struct {
	mu                         sync.Mutex
	Now                        func() int64
	MinTTL, MaxTTL, DefaultTTL float64
	holder                     string
	expiresAt, since           int64
	renewals                   int
}

// StatusError is an error carrying an HTTP status.
type StatusError struct {
	Status int
	Msg    string
}

func (e *StatusError) Error() string { return e.Msg }

var sessionRE = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

func NewLease(defaultTTL float64) *Lease {
	if defaultTTL <= 0 {
		defaultTTL = 900
	}
	return &Lease{Now: func() int64 { return time.Now().UnixMilli() }, MinTTL: 30, MaxTTL: 3600, DefaultTTL: defaultTTL}
}

func (l *Lease) live() string {
	if l.holder != "" && l.Now() >= l.expiresAt {
		l.holder, l.expiresAt, l.since, l.renewals = "", 0, 0, 0
	}
	return l.holder
}

// Live returns the current holder ("" when free).
func (l *Lease) Live() string { l.mu.Lock(); defer l.mu.Unlock(); return l.live() }

// ExpiresAt of the live lease (0 when free).
func (l *Lease) ExpiresAt() int64 { l.mu.Lock(); defer l.mu.Unlock(); l.live(); return l.expiresAt }

// jsNum is JS unary plus on a JSON value.
func jsNum(v any) float64 {
	switch t := v.(type) {
	case nil:
		return 0
	case bool:
		if t {
			return 1
		}
		return 0
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	case string:
		f, err := strconv.ParseFloat(t, 64)
		if err != nil {
			if t == "" {
				return 0
			}
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func (l *Lease) ttl(v any) float64 {
	t := jsNum(v)
	if math.IsNaN(t) || math.IsInf(t, 0) || t <= 0 {
		t = l.DefaultTTL
	}
	return math.Min(math.Max(t, l.MinTTL), l.MaxTTL)
}

// Claim grants or renews the lease for session, or refuses it while another session holds it.
func (l *Lease) Claim(session any, ttlS any) (map[string]any, error) {
	s, ok := session.(string)
	if !ok || !sessionRE.MatchString(s) {
		return nil, &StatusError{400, "session (1-128 of [A-Za-z0-9_.:-]) required"}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	cur, t, now := l.live(), l.ttl(ttlS), l.Now()
	if cur != "" && cur != s {
		return map[string]any{"granted": false, "holder": cur, "expiresAt": l.expiresAt, "retryInS": int64(math.Ceil(float64(l.expiresAt-now) / 1000))}, nil
	}
	if cur == s {
		l.renewals++
	} else {
		l.holder, l.since, l.renewals = s, now, 0
	}
	l.expiresAt = now + int64(t*1000)
	return map[string]any{"granted": true, "holder": s, "renewed": cur == s, "expiresAt": l.expiresAt, "ttl": t}, nil
}

// Release frees the lease only for the holder.
func (l *Lease) Release(session any) map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	cur := l.live()
	if s, _ := session.(string); cur != "" && cur == s {
		l.holder, l.expiresAt, l.since, l.renewals = "", 0, 0, 0
		return map[string]any{"released": true}
	}
	var h any
	if cur != "" {
		h = cur
	}
	return map[string]any{"released": false, "holder": h}
}

// Snapshot is GET /claim.
func (l *Lease) Snapshot() map[string]any {
	l.mu.Lock()
	defer l.mu.Unlock()
	h := l.live()
	if h == "" {
		return map[string]any{"holder": nil, "expiresAt": nil, "since": nil, "renewals": 0}
	}
	return map[string]any{"holder": h, "expiresAt": l.expiresAt, "since": l.since, "renewals": l.renewals}
}
