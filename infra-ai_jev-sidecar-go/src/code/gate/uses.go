package gate

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"jev-gate/pyjson"
)

const (
	maxQuestions   = 8
	maxDecideCache = 256
)

var (
	classes       = []string{"user_facing", "background", "gating"}
	questionTypes = []string{"noul", "choice", "score"}
)

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

// GenericUse is generic_use(): the declaration of a use `decide` may serve, or the reason it may not.
func GenericUse(cfg Config, use string) (*pyjson.OMap, string) {
	u := pyjson.AsMap(get(cfg, "uses", use))
	if u == nil {
		return nil, "unknown_use"
	}
	cl, _ := u.M["class"].(string)
	if !contains(classes, cl) {
		return nil, "not_generic"
	}
	if !pyjson.Truthy(u.M["enabled"]) {
		return nil, "disabled"
	}
	ttl, ttlOK := pyjson.AsNum(u.M["ttl_s"])
	if cl == "background" && !(ttlOK && ttl > 0) {
		return nil, "misconfigured"
	}
	th, thOK := pyjson.AsNum(u.M["threshold"])
	if !thOK || !(th > 0 && th <= 1) {
		return nil, "misconfigured"
	}
	return u, ""
}

// CheckQuestions is check_questions(): "" when the caller's questions are well formed and inside `allowed`.
func CheckQuestions(questions any, u *pyjson.OMap) string {
	qs := pyjson.AsMap(questions)
	if qs == nil || !(qs.Len() > 0 && qs.Len() <= maxQuestions) {
		return "bad_questions"
	}
	allowed := pyjson.AsList(u.M["allowed"])
	for _, qid := range qs.Keys {
		q := pyjson.AsMap(qs.M[qid])
		if q == nil {
			return "bad_questions"
		}
		t, _ := q.M["type"].(string)
		if !contains(questionTypes, t) {
			return "bad_questions"
		}
		if _, ok := q.M["instructions"].(string); !ok {
			return "bad_questions"
		}
		if t == "choice" {
			crit := pyjson.AsMap(q.M["criteria"])
			if crit == nil || crit.Len() < 2 {
				return "bad_questions"
			}
			if len(allowed) > 0 {
				for _, k := range crit.Keys {
					if !inList(allowed, k) {
						return "option_not_allowed"
					}
				}
			}
		}
	}
	return ""
}

// ReadVerdicts is read_verdicts(): {question: {...}} or nil when any answer is missing/mistyped/out of range.
func ReadVerdicts(answers, questions *pyjson.OMap, u *pyjson.OMap) *pyjson.OMap {
	t := num(u.M["threshold"])
	out := pyjson.NewMap()
	for _, qid := range questions.Keys {
		q := pyjson.AsMap(questions.M[qid])
		a := pyjson.AsMap(answers.M[qid])
		if a == nil {
			return nil
		}
		typ := str(q.M["type"])
		if typ == "noul" {
			p := a.M["noul"]
			if !isProb(p) {
				return nil
			}
			pf := num(p)
			out.Set(qid, pyjson.Obj("type", "noul", "p", p, "value", pf >= 0.5, "confident", math.Max(pf, 1-pf) >= t))
			continue
		}
		probs := pyjson.AsMap(a.M["probabilities"])
		if probs == nil || probs.Len() == 0 {
			return nil
		}
		for _, k := range probs.Keys {
			if !isProb(probs.M[k]) {
				return nil
			}
		}
		if typ == "choice" {
			pk, ok := a.M["choice"].(string)
			crit := pyjson.AsMap(q.M["criteria"])
			if _, inCrit := crit.Get(pk); !ok || !inCrit {
				return nil
			}
			pv, inProbs := probs.Get(pk)
			if !inProbs {
				return nil
			}
			out.Set(qid, pyjson.Obj("type", "choice", "pick", pk, "p", pv, "confident", num(pv) >= t, "probabilities", probs))
		} else {
			level := probs.Keys[0]
			for _, k := range probs.Keys {
				if num(probs.M[k]) > num(probs.M[level]) {
					level = k
				}
			}
			out.Set(qid, pyjson.Obj("type", "score", "level", level, "p", probs.M[level], "confident", num(probs.M[level]) >= t, "probabilities", probs))
		}
	}
	return out
}

func decideCacheDir(cfg Config) string {
	d, _ := expand(str(get(cfg, "code_graph", "cache_dir")), false)
	return filepath.Join(expandUser(d), "decide")
}

func decideCacheGet(cfg Config, key string) *pyjson.OMap {
	b, err := os.ReadFile(filepath.Join(decideCacheDir(cfg), key+".json"))
	if err != nil {
		return nil
	}
	v, err := pyjson.Parse(b)
	hit := pyjson.AsMap(v)
	if err != nil || hit == nil {
		return nil
	}
	exp, ok := pyjson.AsNum(hit.M["exp"])
	res := pyjson.AsMap(hit.M["results"])
	if !ok || res == nil || !(exp > nowSec()) {
		return nil
	}
	return res
}

func decideCacheSet(cfg Config, key string, results *pyjson.OMap, ttl float64) {
	d := decideCacheDir(cfg)
	if err := os.MkdirAll(d, 0o777); err != nil {
		return
	}
	body := pyjson.DumpsDefault(pyjson.Obj("exp", nowSec()+ttl, "results", results))
	if err := os.WriteFile(filepath.Join(d, key+".json"), []byte(body), 0o666); err != nil {
		return
	}
	ents, err := os.ReadDir(d)
	if err != nil {
		return
	}
	type fm struct {
		p string
		t time.Time
	}
	var files []fm
	for _, e := range ents {
		if info, err := e.Info(); err == nil {
			files = append(files, fm{filepath.Join(d, e.Name()), info.ModTime()})
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return files[i].t.Before(files[j].t) })
	if n := len(files) - maxDecideCache; n > 0 {
		for _, f := range files[:n] {
			_ = os.Remove(f.p)
		}
	}
}

func noOpinion(cfg Config, use string, ev Event, reason string) *pyjson.OMap {
	Log(cfg, Merge(Ev("verdict", "none", "reason", reason), ev))
	return pyjson.Obj("ok", false, "use", use, "reason", reason)
}

func result(use string, u *pyjson.OMap, results *pyjson.OMap, cached bool, call string) *pyjson.OMap {
	out := pyjson.Obj("ok", true, "use", use, "class", u.M["class"], "cached", cached, "threshold", u.M["threshold"], "call", call, "results", results)
	if u.M["class"] == "gating" {
		out.Set("advice_only", true)
	}
	return out
}

func pickOf(r *pyjson.OMap) any {
	switch r.M["type"] {
	case "choice":
		return r.M["pick"]
	case "score":
		return r.M["level"]
	}
	return r.M["value"]
}

func held(cfg Config, use string, u *pyjson.OMap, ev Event, call string) *pyjson.OMap {
	if !pyjson.Truthy(u.M["gate"]) || GateStatus(cfg, use, nil).M["open"] == true {
		return nil
	}
	Log(cfg, Merge(Ev("verdict", "held", "reason", "gate_closed", "call", call), ev))
	return pyjson.Obj("ok", false, "use", use, "reason", "gate_closed", "call", call)
}

// RunUse is run_use(): one decision for a declared generic use. Always returns a dict.
func RunUse(use string, payload any, cfg Config) (out *pyjson.OMap) {
	t0 := time.Now()
	ev := Ev("use", use)
	defer func() {
		if r := recover(); r != nil {
			Log(cfg, Merge(Ev("verdict", "none", "reason", "exception:Exception", "latency_ms", int64(time.Since(t0)/time.Millisecond)), ev))
			out = pyjson.Obj("ok", false, "use", use, "reason", "exception")
		}
	}()
	u, why := GenericUse(cfg, use)
	if u == nil {
		Log(cfg, Merge(Ev("verdict", "none", "reason", why), ev))
		return pyjson.Obj("ok", false, "use", use, "reason", why)
	}
	ev.Set("class", u.M["class"])
	pm := pyjson.AsMap(payload)
	if pm == nil {
		return noOpinion(cfg, use, ev, "bad_request")
	}
	if _, ok := pm.Get("state"); !ok {
		return noOpinion(cfg, use, ev, "bad_request")
	}
	questions := pm.M["questions"]
	if why := CheckQuestions(questions, u); why != "" {
		return noOpinion(cfg, use, ev, why)
	}
	qm := pyjson.AsMap(questions)
	state := redactObj(pm.M["state"], cfg)
	if runeLen(pyjson.DumpsDefault(state)) > intOf(cfg.M["max_state_chars"]) {
		return noOpinion(cfg, use, ev, "state_too_large")
	}
	key := shaShort(pyjson.Dumps([]any{use, state, questions}, pyjson.Opts{EnsureASCII: true, SortKeys: true}))
	ttl := num(u.M["ttl_s"])
	if ttl != 0 {
		if hit := decideCacheGet(cfg, key); hit != nil {
			Log(cfg, Merge(Ev("verdict", "cached", "call", key[:12]), ev))
			if h := held(cfg, use, u, ev, key[:12]); h != nil {
				return h
			}
			return result(use, u, hit, true, key[:12])
		}
	}
	answers, meta := Decide(state, qm, cfg, 0, false, use)
	var results *pyjson.OMap
	if answers != nil && answers.Len() > 0 {
		results = ReadVerdicts(answers, qm, u)
	}
	if results == nil {
		reason := "malformed"
		if e, ok := meta.Get("error"); ok && pyjson.Truthy(e) {
			reason = str(e)
		}
		rest := pyjson.NewMap()
		for _, k := range meta.Keys {
			if k != "error" {
				rest.Set(k, meta.M[k])
			}
		}
		Log(cfg, Merge(Ev("verdict", "none", "reason", reason), ev, rest))
		return pyjson.Obj("ok", false, "use", use, "reason", reason)
	}
	if ttl != 0 {
		decideCacheSet(cfg, key, results, ttl)
	}
	scores := pyjson.NewMap()
	picks := pyjson.NewMap()
	for _, q := range results.Keys {
		r := pyjson.AsMap(results.M[q])
		scores.Set(q, r.M["p"])
		if r.M["confident"] == true {
			picks.Set(q, pickOf(r))
		}
	}
	Log(cfg, Merge(Ev("verdict", "answered", "call", key[:12], "scores", scores, "picks", picks, "threshold", u.M["threshold"]), ev, meta))
	if h := held(cfg, use, u, ev, key[:12]); h != nil {
		return h
	}
	return result(use, u, results, false, key[:12])
}

// ---- outcomes, precision and the evidence gate (#884) ----

// Journal is journal(): the decisions journal as a list of events.
func Journal(cfg Config) []*pyjson.OMap {
	path := os.Getenv("JEV_GATE_LOG")
	if path == "" {
		path = str(cfg.M["log_path"])
	}
	f, err := os.Open(expandUser(path))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []*pyjson.OMap
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<26)
	for sc.Scan() {
		if v, err := pyjson.Parse([]byte(sc.Text())); err == nil {
			if m := pyjson.AsMap(v); m != nil {
				out = append(out, m)
			}
		}
	}
	return out
}

// Outcome is outcome(): record what really happened for decision `call` of `use`.
func Outcome(cfg Config, use, call any, label any) *pyjson.OMap {
	u, uok := use.(string)
	c, cok := call.(string)
	if !(uok && cok && c != "") {
		return pyjson.Obj("ok", false, "reason", "usage: outcome --use <name> --call <id> --label <json>")
	}
	Log(cfg, Ev("use", u, "verdict", "outcome", "call", c, "label", label))
	return pyjson.Obj("ok", true, "use", u, "call", c)
}

func roundHalfEven4(x float64) float64 {
	f, _ := strconv.ParseFloat(strconv.FormatFloat(x, 'f', 4, 64), 64)
	return f
}

// Precision is precision(): of a use's CONFIDENT answers that have an outcome, how many matched it.
func Precision(cfg Config, use string, events []*pyjson.OMap, haveEvents bool, now float64) *pyjson.OMap {
	if !haveEvents {
		events = Journal(cfg)
	}
	if now == 0 {
		now = nowSec()
	}
	picks := map[string]*pyjson.OMap{}
	at := map[string]float64{}
	var pickOrder []string
	labels := map[string]any{}
	var labelOrder []string
	for _, e := range events {
		if e.M["use"] != use {
			continue
		}
		call, _ := e.M["call"].(string)
		if call == "" {
			continue
		}
		if e.M["verdict"] != "outcome" {
			if pm := pyjson.AsMap(e.M["picks"]); pm != nil && pm.Len() > 0 {
				if _, seen := picks[call]; !seen {
					pickOrder = append(pickOrder, call)
				}
				picks[call] = pm
				ts := now
				if t, ok := pyjson.AsNum(e.M["ts"]); ok {
					ts = t
				}
				at[call] = ts
			}
		} else {
			if _, seen := labels[call]; !seen {
				labelOrder = append(labelOrder, call)
			}
			labels[call] = e.M["label"]
		}
	}
	days := num(get(cfg, "uses", use, "implicit_accept_days"))
	labelled, correct := 0, 0
	for _, call := range labelOrder {
		lab := labels[call]
		mine := picks[call]
		if mine == nil {
			continue
		}
		for _, q := range mine.Keys {
			pk := mine.M[q]
			var want any
			if lm := pyjson.AsMap(lab); lm != nil {
				want = lm.M[q]
			} else if mine.Len() == 1 {
				want = lab
			}
			if want == nil {
				continue
			}
			labelled++
			if pyEq(want, pk) {
				correct++
			}
		}
	}
	if days > 0 {
		for _, call := range pickOrder {
			if _, has := labels[call]; !has && now-at[call] >= days*86400 {
				n := picks[call].Len()
				labelled += n
				correct += n
			}
		}
	}
	var prec any
	if labelled > 0 {
		prec = roundHalfEven4(float64(correct) / float64(labelled))
	}
	return pyjson.Obj("use", use, "answered", int64(len(picks)), "labelled", int64(labelled), "correct", int64(correct), "precision", prec)
}

// GateStatus is gate_status(): {open, reasons, evidence} for a gated use; ungated uses are open.
func GateStatus(cfg Config, use string, events []*pyjson.OMap) (out *pyjson.OMap) {
	g := pyjson.AsMap(get(cfg, "uses", use, "gate"))
	if g == nil || !pyjson.Truthy(g) {
		return pyjson.Obj("use", use, "open", true, "gated", false)
	}
	defer func() {
		if r := recover(); r != nil {
			out = pyjson.Obj("use", use, "gated", true, "open", false, "reasons", []any{"gate_error:TypeError"})
		}
	}()
	have := events != nil
	if !have {
		events = Journal(cfg)
	}
	ev := []any{}
	why := []any{}
	minL, minP := num(g.M["min_labelled"]), num(g.M["min_precision"])
	for _, a := range pyjson.AsList(g.M["after"]) {
		p := Precision(cfg, str(a), events, true, 0)
		ev = append(ev, p)
		lab := num(p.M["labelled"])
		if lab < minL {
			why = append(why, fmt.Sprintf("%s: %d/%d labelled", str(a), int(lab), int(minL)))
		} else if p.M["precision"] == nil {
			panic("TypeError")
		} else if num(p.M["precision"]) < minP {
			why = append(why, fmt.Sprintf("%s: precision %.2f < %.2f", str(a), num(p.M["precision"]), minP))
		}
	}
	return pyjson.Obj("use", use, "gated", true, "open", len(why) == 0, "reasons", why, "evidence", ev,
		"min_labelled", g.M["min_labelled"], "min_precision", g.M["min_precision"])
}

// PrecisionReport is precision_report(): per declared use its evidence, per gated use whether it is open.
func PrecisionReport(cfg Config) *pyjson.OMap {
	events := Journal(cfg)
	if events == nil {
		events = []*pyjson.OMap{}
	}
	uses := pyjson.AsMap(cfg.M["uses"])
	var names []string
	if uses != nil {
		for _, n := range uses.Keys {
			if um := pyjson.AsMap(uses.M[n]); um != nil && pyjson.Truthy(um.M["class"]) {
				names = append(names, n)
			}
		}
	}
	sort.Strings(names)
	prec := []any{}
	gates := []any{}
	for _, n := range names {
		prec = append(prec, Precision(cfg, n, events, true, 0))
	}
	for _, n := range names {
		if pyjson.Truthy(pyjson.AsMap(uses.M[n]).M["gate"]) {
			gates = append(gates, GateStatus(cfg, n, events))
		}
	}
	return pyjson.Obj("uses", prec, "gates", gates)
}

// DecideCLI is decide_cli(): `decide --use <name>` with stdin {state, questions}.
func DecideCLI(argv []string, stdin string, cfg Config) *pyjson.OMap {
	use := ""
	for i := 0; i+1 < len(argv); i++ {
		if argv[i] == "--use" {
			use = argv[i+1]
			break
		}
	}
	if use == "" {
		return pyjson.Obj("ok", false, "reason", "usage: jev-gate decide --use <name> < {state, questions}")
	}
	payload, err := pyjson.Parse([]byte(stdin))
	if err != nil {
		return pyjson.Obj("ok", false, "use", use, "reason", "bad_request")
	}
	return RunUse(use, payload, cfg)
}

// GenericUseNames lists the uses `decide` may serve, sorted.
func GenericUseNames(cfg Config) []any {
	uses := pyjson.AsMap(cfg.M["uses"])
	var names []string
	if uses != nil {
		for _, n := range uses.Keys {
			if u, _ := GenericUse(cfg, n); u != nil {
				names = append(names, n)
			}
		}
	}
	sort.Strings(names)
	out := []any{}
	for _, n := range names {
		out = append(out, n)
	}
	return out
}

var _ = strings.TrimSpace
