package gate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"jev-gate/pyjson"
)

// sessionCache is the per-session cache file: its path ("" without a session) and parsed content.
func sessionCache(cfg Config, sessionID string) (string, *pyjson.OMap) {
	if sessionID == "" {
		return "", pyjson.NewMap()
	}
	dir, _ := expand(str(get(cfg, "code_graph", "cache_dir")), false)
	path := filepath.Join(dir, shaShort(sessionID)+".json")
	b, err := os.ReadFile(path)
	if err != nil {
		return path, pyjson.NewMap()
	}
	v, err := pyjson.Parse(b)
	if m := pyjson.AsMap(v); err == nil && m != nil {
		return path, m
	}
	return path, pyjson.NewMap()
}

func cachePut(cfg Config, path string, cache *pyjson.OMap, key string, value any) {
	cache.Set(key, value)
	if path == "" {
		return
	}
	// for k in list(cache)[:-max]: del cache[k]
	max := intOf(get(cfg, "code_graph", "cache_max_entries"))
	n := len(cache.Keys)
	cut := n - max
	if max == 0 {
		cut = 0
	}
	if cut > 0 {
		for _, k := range append([]string(nil), cache.Keys[:cut]...) {
			cache.Delete(k)
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return
	}
	if err := os.WriteFile(path+".tmp", []byte(pyjson.DumpsDefault(cache)), 0o666); err != nil {
		return
	}
	_ = os.Rename(path+".tmp", path)
}

func pick(answers *pyjson.OMap, q string) (choice string, choiceOK bool, p any) {
	a := pyjson.AsMap(pyjson.Path(answers, q))
	if a == nil {
		return "", false, nil
	}
	c, ok := a.M["choice"].(string)
	if !ok {
		return "", false, nil
	}
	if probs := pyjson.AsMap(a.M["probabilities"]); probs != nil {
		p = probs.M[c]
	}
	return c, true, p
}

// RouteContext is route_context(): code-graph context for one user prompt as capped text, or "".
func RouteContext(cli string, promptV any, sessionV any, cwdV any, cfg Config) (out string) {
	u := useCfg(cfg, "code_context")
	prompt, ok := promptV.(string)
	if u == nil || !ok || strings.TrimFunc(prompt, isPySpace) == "" {
		return ""
	}
	t0 := time.Now()
	ev := func() Event { return Ev("use", "code_context", "cli", cli) }
	evFields := ev()
	defer func() {
		if r := recover(); r != nil {
			Log(cfg, Merge(Ev("verdict", "none", "reason", "exception:Exception", "latency_ms", int64(time.Since(t0)/time.Millisecond)), evFields))
			out = ""
		}
	}()
	text, err := routeInner(cli, prompt, sessionV, cwdV, cfg, u, t0, evFields)
	if err != nil {
		Log(cfg, Merge(Ev("verdict", "none", "reason", "exception:"+ErrName(err), "latency_ms", int64(time.Since(t0)/time.Millisecond)), evFields))
		return ""
	}
	return text
}

func routeInner(cli, prompt string, sessionV, cwdV any, cfg Config, u *pyjson.OMap, t0 time.Time, ev Event) (string, error) {
	g := pyjson.AsMap(cfg.M["code_graph"])
	r := pyjson.AsMap(g.M["route"])
	deadline := t0.Add(time.Duration(num(r.M["budget_s"]) * float64(time.Second)))
	query := runeSlice(Redact(prompt, cfg), intOf(r.M["query_chars"]))
	root := ""
	if cwd, ok := cwdV.(string); ok && cwd != "" {
		root = RepoOf(cwd)
	}
	sid := ""
	if pyjson.Truthy(sessionV) {
		sid = pyStr(sessionV)
	}
	cpath, cache := sessionCache(cfg, sid)
	key := "route:" + shaShort(query+"\x00"+root)
	if cv, hit := cache.Get(key); hit {
		cs, _ := cv.(string)
		Log(cfg, Merge(Ev("verdict", "cached", "bytes", int64(runeLen(cs))), ev))
		return cs, nil
	}
	criteria := pyjson.NewMap()
	opts := pyjson.AsMap(r.M["options"])
	for _, k := range opts.Keys {
		criteria.Set(k, pyjson.AsMap(opts.M[k]).M["criterion"])
	}
	criteria.Set("none", r.M["none_criterion"])
	answers, meta := Decide(pyjson.Obj("request", query),
		pyjson.Obj("route", pyjson.Obj("type", "choice", "instructions", r.M["instructions"], "criteria", criteria)),
		cfg, time.Until(deadline).Seconds(), true, "code_context")
	choice, choiceOK, p := pick(answers, "route")
	_, inCriteria := criteria.Get(choice)
	if !isProb(p) || !choiceOK || !inCriteria {
		Log(cfg, Merge(Ev("verdict", "none", "reason", "error"), meta, ev))
		return "", nil
	}
	pf := num(p)
	thr := num(u.M["threshold"])
	ev.Set("choice", choice)
	ev.Set("p", p)
	ev.Set("threshold", u.M["threshold"])
	if choice == "none" || pf < thr {
		Log(cfg, Merge(Ev("verdict", "none"), meta, ev))
		cachePut(cfg, cpath, cache, key, "")
		return "", nil
	}
	opt := pyjson.AsMap(opts.M[choice])
	ep, err := CgcEndpoint(cli, cfg)
	if err != nil {
		return "", err
	}
	if ep == nil {
		Log(cfg, Merge(Ev("verdict", "none", "reason", "no_endpoint"), ev))
		return "", nil
	}
	ev.Set("server", ep.Server)
	rpc, err := McpSession(ep, deadline, cfg)
	if err != nil {
		return "", err
	}
	ekey := fmt.Sprintf("enum:%s:%s", ep.Server, str(opt.M["tool"]))
	if _, ok := cache.Get(ekey); !ok {
		lr, err := rpc("tools/list", pyjson.NewMap(), false)
		if err != nil {
			return "", err
		}
		var tool *pyjson.OMap
		lm := pyjson.AsMap(lr)
		if lm == nil {
			return "", perr("AttributeError", "result")
		}
		for _, t := range pyjson.AsList(lm.M["tools"]) {
			if tm := pyjson.AsMap(t); tm != nil && tm.M["name"] == opt.M["tool"] {
				tool = tm
				break
			}
		}
		if tool == nil {
			return "", perr("StopIteration", "")
		}
		prop := pyjson.AsMap(pyjson.Path(tool.M["inputSchema"], "properties", str(r.M["repo_arg"])))
		var enum any = []any{}
		if prop != nil && pyjson.Truthy(prop.M["enum"]) {
			enum = prop.M["enum"]
		}
		cachePut(cfg, cpath, cache, ekey, enum)
	}
	repos := pyjson.AsList(cache.M[ekey])
	repo := ""
	if root != "" {
		repo = filepath.Base(root)
	}
	if len(repos) > 0 && !inList(repos, repo) && !(repo == "" && false) {
		crit := pyjson.NewMap()
		for _, x := range repos {
			crit.Set(pyStr(x), x)
		}
		ans2, _ := Decide(pyjson.Obj("request", query),
			pyjson.Obj("repo", pyjson.Obj("type", "choice", "instructions", r.M["repo_instructions"], "criteria", crit)),
			cfg, time.Until(deadline).Seconds(), true, "code_context")
		rc, rcOK, rp := pick(ans2, "repo")
		repo = rc
		if !isProb(rp) || num(rp) < thr || !rcOK || !inList(repos, repo) {
			Log(cfg, Merge(Ev("verdict", "none", "reason", "repo_unsure"), ev))
			cachePut(cfg, cpath, cache, key, "")
			return "", nil
		}
	}
	if repo == "" {
		Log(cfg, Merge(Ev("verdict", "none", "reason", "no_repo"), ev))
		return "", nil
	}
	args := pyjson.AsMap(opt.M["args"]).Copy()
	args.Set(str(r.M["query_arg"]), query)
	args.Set(str(r.M["repo_arg"]), repo)
	text, err := toolText(rpc, str(opt.M["tool"]), args)
	if err != nil {
		return "", err
	}
	var drops []string
	for _, d := range pyjson.AsList(r.M["drop_lines"]) {
		drops = append(drops, str(d))
	}
	var kept []string
	for _, l := range splitLines(text) {
		drop := false
		for _, d := range drops {
			if hit, err := searchRE(d, l); err != nil {
				return "", err
			} else if hit {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, l)
		}
	}
	text = strings.TrimFunc(strings.Join(kept, "\n"), isPySpace)
	text = Redact(text, cfg)
	head := fmt.Sprintf("<code-graph-context source=\"%s %s\" repo=\"%s\" route=\"%s\" p=\"%.2f\">\n", ep.Server, str(opt.M["tool"]), repo, choice, pf)
	tail := "\n</code-graph-context>"
	room := intOf(r.M["max_inject_chars"]) - runeLen(head) - runeLen(tail)
	if runeLen(text) > room {
		keep := room - 14
		if keep < 0 {
			keep = 0
		}
		text = runeSlice(text, keep) + "\n[truncated]"
	}
	out := ""
	if text != "" {
		out = head + text + tail
	}
	cachePut(cfg, cpath, cache, key, out)
	verdict := "empty"
	if out != "" {
		verdict = "injected"
	}
	Log(cfg, Merge(Ev("verdict", verdict, "repo", repo, "bytes", int64(runeLen(out)), "latency_ms", int64(time.Since(t0)/time.Millisecond)), ev))
	return out, nil
}

// splitLines is str.splitlines() for the separators that occur in tool output.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\v", "\n", "\f", "\n", "\x1c", "\n", "\x1d", "\n", "\x1e", "\n", "\x85", "\n", " ", "\n", " ", "\n").Replace(s)
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}
