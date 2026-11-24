package gate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"jev-gate/pyjson"
)

// JournalStdout mirrors JOURNAL_STDOUT: the sidecar also prints each journal line (never set for the CLI
// modes, whose stdout is the hook's answer).
var JournalStdout bool

var stdoutMu sync.Mutex

// Event builds a journal line's fields in call order (Python kwargs order).
type Event = *pyjson.OMap

// Ev starts an event from alternating key, value arguments.
func Ev(kv ...any) Event { return pyjson.Obj(kv...) }

// Merge appends the fields of others (**kwargs expansion).
func Merge(e Event, others ...*pyjson.OMap) Event {
	for _, o := range others {
		if o == nil {
			continue
		}
		for _, k := range o.Keys {
			e.Set(k, o.M[k])
		}
	}
	return e
}

// Log is log(): append one JSONL decision; never the state text, never fails.
func Log(cfg Config, event Event) {
	defer func() { _ = recover() }()
	line := pyjson.NewMap()
	line.Set("ts", int64(time.Now().Unix()))
	line.Set("src", "jev-gate")
	for _, k := range event.Keys {
		line.Set(k, event.M[k])
	}
	s := pyjson.DumpsDefault(line)
	if JournalStdout {
		stdoutMu.Lock()
		fmt.Fprintln(os.Stdout, s)
		stdoutMu.Unlock()
	}
	path := os.Getenv("JEV_GATE_LOG")
	if path == "" {
		path = str(cfg.M["log_path"])
	}
	path = expandUser(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o666)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(s + "\n")
}

// ---- budget ledger (#881) ----

var (
	memLedger = pyjson.Obj("day", "", "spent", 0.0, "calls", pyjson.NewMap())
	memMu     sync.Mutex
)

func ledgerPath(cfg Config) string {
	if p := os.Getenv("JEV_GATE_BUDGET"); p != "" {
		return expandUser(p)
	}
	if p := str(get(cfg, "budget", "ledger_path")); p != "" {
		return expandUser(p)
	}
	return expandUser("~/.local/state/jev-gate/budget.json")
}

// ledger runs txn under a file lock on the shared ledger and writes the state back; when the file cannot
// be used the in-process ledger still bounds this process.
func ledger(cfg Config, txn func(st *pyjson.OMap) any) any {
	res, err := fileLedger(cfg, txn)
	if err == nil {
		return res
	}
	memMu.Lock()
	defer memMu.Unlock()
	return txn(memLedger)
}

func fileLedger(cfg Config, txn func(st *pyjson.OMap) any) (any, error) {
	path := ledgerPath(cfg)
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o666)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	st := pyjson.NewMap()
	if b, err := os.ReadFile(path); err == nil {
		if v, err := pyjson.Parse(b); err == nil {
			if m := pyjson.AsMap(v); m != nil {
				st = m
			}
		}
	}
	res := txn(st)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(pyjson.DumpsDefault(st)), 0o666); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return nil, err
	}
	return res, nil
}

func today(now float64) string {
	return time.Unix(int64(now), 0).UTC().Format("2006-01-02")
}

func rollDay(st *pyjson.OMap, now float64) {
	day := today(now)
	if d, _ := st.M["day"].(string); d != day || st.M["day"] == nil {
		st.Set("day", day)
		st.Set("spent", 0.0)
	}
}

func spent(st *pyjson.OMap) float64 {
	f, _ := pyjson.AsNum(st.M["spent"])
	return f
}

// BudgetAdmit is budget_admit(): "" when one more call may be made, else "over_budget" or "rate_limited".
// An admitted call is counted against its use before it is made.
func BudgetAdmit(cfg Config, use string, now float64) string {
	capV := num(get(cfg, "budget", "daily_cost_cap"))
	perHour := 0.0
	if use != "" {
		perHour = num(get(cfg, "uses", use, "max_calls_per_hour"))
	}
	if capV == 0 && perHour == 0 {
		return ""
	}
	if now == 0 {
		now = nowSec()
	}
	res := ledger(cfg, func(st *pyjson.OMap) any {
		rollDay(st, now)
		if capV != 0 && spent(st) >= capV {
			return "over_budget"
		}
		if perHour != 0 {
			calls := pyjson.AsMap(st.M["calls"])
			if calls == nil {
				calls = pyjson.NewMap()
				st.Set("calls", calls)
			}
			recent := []any{}
			for _, t := range pyjson.AsList(calls.M[use]) {
				if f, ok := pyjson.AsNum(t); ok && f > now-3600 {
					recent = append(recent, t)
				}
			}
			if float64(len(recent)) >= perHour {
				calls.Set(use, recent)
				return "rate_limited"
			}
			calls.Set(use, append(recent, now))
		}
		return ""
	})
	s, _ := res.(string)
	return s
}

// BudgetCharge is budget_charge(): add one answered call's usage.cost (est_call_cost when none).
func BudgetCharge(cfg Config, cost any, now float64) {
	b := pyjson.AsMap(cfg.M["budget"])
	if b == nil || num(b.M["daily_cost_cap"]) == 0 {
		return
	}
	amount := num(b.M["est_call_cost"])
	if _, isBool := cost.(bool); !isBool {
		if f, ok := pyjson.AsNum(cost); ok && f >= 0 {
			amount = f
		}
	}
	if now == 0 {
		now = nowSec()
	}
	ledger(cfg, func(st *pyjson.OMap) any {
		rollDay(st, now)
		st.Set("spent", spent(st)+amount)
		return nil
	})
}

// ---- the Decisions call ----

func apiKey(cfg Config) string {
	for _, k := range pyjson.AsList(cfg.M["key_env"]) {
		if v := os.Getenv(str(k)); v != "" {
			return v
		}
	}
	return ""
}

// HasKey reports whether an API key is configured in the environment.
func HasKey(cfg Config) bool { return apiKey(cfg) != "" }

// Decide is decide(): POST one Decisions request. Returns (answers, meta); answers is nil on any
// failure. budget < 0 means "no caller deadline" (Python None). use "" = no use.
func Decide(state any, questions any, cfg Config, budget float64, hasBudget bool, use string) (*pyjson.OMap, *pyjson.OMap) {
	key := apiKey(cfg)
	if key == "" {
		return nil, pyjson.Obj("error", "no_key")
	}
	if over := BudgetAdmit(cfg, use, 0); over != "" {
		return nil, pyjson.Obj("error", over)
	}
	body := pyjson.DumpsDefault(pyjson.Obj("model", cfg.M["model"], "state", state, "questions", questions))
	t0 := time.Now()
	meta := pyjson.Obj("state_sha", sha256hex(pyjson.Dumps(state, pyjson.Opts{EnsureASCII: true, SortKeys: true}))[:12])
	answers, err := func() (*pyjson.OMap, error) {
		if hasBudget && budget <= 0 {
			return nil, perr("TimeoutError", "budget spent")
		}
		timeout := num(cfg.M["timeout_s"])
		if hasBudget && budget != 0 && budget < timeout {
			timeout = budget
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout*float64(time.Second)))
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, "POST", str(cfg.M["endpoint"]), bytes.NewReader([]byte(body)))
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, httpErr(err)
		}
		defer res.Body.Close()
		if res.StatusCode >= 400 {
			meta.Set("error", fmt.Sprintf("HTTPError:%d", res.StatusCode))
			return nil, &PyErr{"HTTPError", fmt.Sprint(res.StatusCode)}
		}
		meta.Set("status", int64(res.StatusCode))
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			return nil, httpErr(err)
		}
		v, err := pyjson.Parse(raw)
		if err != nil {
			return nil, perr("JSONDecodeError", "%v", err)
		}
		data := pyjson.AsMap(v)
		if data == nil {
			return nil, perr("AttributeError", "not a dict")
		}
		meta.Set("id", data.M["id"])
		var cost any
		if u := pyjson.AsMap(data.M["usage"]); u != nil {
			cost = u.M["cost"]
		}
		meta.Set("cost", cost)
		BudgetCharge(cfg, cost, 0)
		ans, ok := data.M["answers"]
		if !ok {
			return nil, perr("KeyError", "answers")
		}
		am := pyjson.AsMap(ans)
		if am == nil {
			return nil, perr("ValueError", "answers is not an object")
		}
		return am, nil
	}()
	if err != nil {
		if _, set := meta.Get("error"); !set {
			meta.Set("error", ErrName(err))
		}
		meta.Set("latency_ms", int64(time.Since(t0)/time.Millisecond))
		return nil, meta
	}
	meta.Set("latency_ms", int64(time.Since(t0)/time.Millisecond))
	return answers, meta
}

// httpErr maps a transport failure to the Python exception name urllib raises for it: a failed connect is
// URLError, a stall after the request went out is TimeoutError.
func httpErr(err error) error {
	var ne net.Error
	var oe *net.OpError
	if errors.As(err, &oe) && oe.Op == "dial" {
		return perr("URLError", "%v", err)
	}
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return perr("TimeoutError", "timed out")
	}
	return perr("URLError", "%v", err)
}
