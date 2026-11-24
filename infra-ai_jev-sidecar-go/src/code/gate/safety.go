package gate

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"jev-gate/pyjson"
)

// Safety is safety(): "allow" | "unsafe" | "defer" plus the scores. Never fails.
func Safety(use string, tool any, toolInput any, project any, task string, cfg Config, cli, sessionID string) (verdict string, scores *pyjson.OMap) {
	u := useCfg(cfg, use)
	ti := pyjson.AsMap(toolInput)
	if u == nil || ti == nil {
		return "defer", nil
	}
	v, sc, err := safetyInner(u, use, tool, ti, project, task, cfg, cli, sessionID)
	if err != nil {
		Log(cfg, Ev("use", use, "tool", tool, "verdict", "defer", "reason", "exception:"+ErrName(err)))
		return "defer", nil
	}
	return v, sc
}

func safetyInner(u *pyjson.OMap, use string, tool any, ti *pyjson.OMap, project any, task string, cfg Config, cli, sessionID string) (string, *pyjson.OMap, error) {
	never, err := NeverAutoApprove(tool, ti, cfg)
	if err != nil {
		return "", nil, err
	}
	if never {
		Log(cfg, Ev("use", use, "tool", tool, "verdict", "defer", "reason", "never_auto_approve"))
		return "defer", nil, nil
	}
	proj := ""
	if s, ok := project.(string); ok {
		proj = s
	}
	state := pyjson.Obj("tool", tool, "input", Redact(pyjson.Dumps(ti, pyjson.Opts{}), cfg), "project", Redact(proj, cfg))
	if task != "" {
		state.Set("task", Redact(task, cfg))
	}
	maxState := intOf(cfg.M["max_state_chars"])
	if runeLen(pyjson.DumpsDefault(state)) > maxState {
		Log(cfg, Ev("use", use, "tool", tool, "verdict", "defer", "reason", "state_too_large"))
		return "defer", nil, nil
	}
	if cli != "" {
		imp := Impact(cli, tool, ti, project, sessionID, cfg)
		if imp != "" {
			with := state.Copy()
			with.Set("impact", imp)
			if runeLen(pyjson.DumpsDefault(with)) <= maxState {
				state.Set("impact", imp)
			}
		}
	}
	asked := pyjson.NewMap()
	qs := pyjson.AsMap(cfg.M["questions"])
	for _, k := range qs.Keys {
		if strings.HasPrefix(k, "_") {
			continue
		}
		q := pyjson.AsMap(qs.M[k])
		if q == nil {
			continue
		}
		if need, has := q.M["needs"]; pyjson.Truthy(need) {
			if _, ok := state.M[pyStr(need)]; !ok {
				_ = has
				continue
			}
		}
		qq := pyjson.NewMap()
		for _, kk := range q.Keys {
			if kk != "needs" {
				qq.Set(kk, q.M[kk])
			}
		}
		asked.Set(k, qq)
	}
	answers, meta := Decide(state, asked, cfg, 0, false, use)
	var scoresM *pyjson.OMap
	if answers != nil && answers.Len() > 0 {
		scoresM = pyjson.NewMap()
		for _, k := range asked.Keys {
			var s any
			if a := pyjson.AsMap(answers.M[k]); a != nil {
				s = a.M["noul"]
			}
			scoresM.Set(k, s)
		}
	}
	ok := scoresM != nil && scoresM.Len() > 0
	if ok {
		for _, k := range scoresM.Keys {
			if !isProb(scoresM.M[k]) {
				ok = false
			}
		}
	}
	if !ok {
		Log(cfg, Merge(Ev("use", use, "tool", tool, "verdict", u.M["on_error"], "reason", "error"), meta))
		return "defer", nil, nil
	}
	t := num(u.M["threshold"])
	allGE, allLE := true, true
	for _, k := range scoresM.Keys {
		s := num(scoresM.M[k])
		if !(s >= t) {
			allGE = false
		}
		if !(s <= 1-t) {
			allLE = false
		}
	}
	verdict := "defer"
	if allGE {
		verdict = "allow"
	} else if allLE {
		verdict = "unsafe"
	}
	picks := pyjson.NewMap()
	if verdict != "defer" {
		picks.Set("safe", verdict == "allow")
	}
	var call any
	if s, ok := meta.Get("state_sha"); ok {
		call = s
	}
	Log(cfg, Merge(Ev("use", use, "tool", tool, "verdict", verdict, "scores", scoresM, "threshold", u.M["threshold"], "call", call, "picks", picks), meta))
	return verdict, scoresM, nil
}

// ClaudeHook is claude_hook(): the hook event -> the stdout JSON, or nil to leave the permission flow unchanged.
func ClaudeHook(event *pyjson.OMap, cfg Config) any {
	if event.M["hook_event_name"] == "UserPromptSubmit" {
		text := RouteContext("claude", event.M["prompt"], event.M["session_id"], event.M["cwd"], cfg)
		if text == "" {
			return nil
		}
		return pyjson.Obj("hookSpecificOutput", pyjson.Obj("hookEventName", "UserPromptSubmit", "additionalContext", text))
	}
	if event.M["tool_name"] == nil {
		return nil
	}
	var ti any = event.M["tool_input"]
	if !pyjson.Truthy(ti) {
		ti = pyjson.NewMap()
	}
	desc := ""
	if m := pyjson.AsMap(ti); m != nil {
		desc, _ = m.M["description"].(string)
	}
	sid := ""
	if event.M["session_id"] != nil {
		sid = pyStr(event.M["session_id"])
	}
	verdict, _ := Safety("claude_permission", event.M["tool_name"], ti, event.M["cwd"], desc, cfg, "claude", sid)
	if verdict != "allow" {
		return nil // 'unsafe' is never turned into a deny: the normal prompt decides
	}
	if event.M["hook_event_name"] == "PreToolUse" {
		return pyjson.Obj("hookSpecificOutput", pyjson.Obj("hookEventName", "PreToolUse", "permissionDecision", "allow", "permissionDecisionReason", "jev-gate: confident safe"))
	}
	return pyjson.Obj("hookSpecificOutput", pyjson.Obj("hookEventName", "PermissionRequest", "decision", pyjson.Obj("behavior", "allow")))
}

// GooseHook is goose_hook(): {"decision":"block",...} or nil.
func GooseHook(event *pyjson.OMap, cfg Config) any {
	var ti any = event.M["tool_input"]
	if !pyjson.Truthy(ti) {
		ti = pyjson.NewMap()
	}
	sid := ""
	if event.M["session_id"] != nil {
		sid = pyStr(event.M["session_id"])
	}
	verdict, scores := Safety("goose_pretool", event.M["tool_name"], ti, event.M["working_dir"], "", cfg, "goose", sid)
	u := useCfg(cfg, "goose_pretool")
	if verdict == "unsafe" && u != nil {
		on := u.M["on_unsafe"]
		if on == "block" || (on == "block_when_gate_open" && GateStatus(cfg, "goose_pretool", nil).M["open"] == true) {
			keys := append([]string(nil), scores.Keys...)
			sort.Strings(keys)
			parts := make([]string, 0, len(keys))
			for _, k := range keys {
				parts = append(parts, fmt.Sprintf("%s=%.2f", k, num(scores.M[k])))
			}
			return pyjson.Obj("decision", "block", "reason", "jev-gate: judged unsafe/irreversible ("+strings.Join(parts, ", ")+"); ask the operator")
		}
	}
	return nil
}

// GoosePromptHook is goose_prompt_hook(): the context goes to $GOOSE_MOIM_MESSAGE_FILE, the hook prints nothing.
func GoosePromptHook(event *pyjson.OMap, cfg Config) any {
	path := os.Getenv("GOOSE_MOIM_MESSAGE_FILE")
	if path == "" {
		return nil
	}
	path = expandUser(path)
	defer func() { _ = recover() }()
	dir := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		dir = path[:i]
	} else {
		dir = "."
	}
	if dir == "" {
		dir = "."
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil
	}
	if err := os.WriteFile(path, nil, 0o666); err != nil {
		return nil
	}
	cwd := event.M["working_dir"]
	if !pyjson.Truthy(cwd) {
		wd, _ := os.Getwd()
		cwd = wd
	}
	text := RouteContext("goose", event.M["message"], event.M["session_id"], cwd, cfg)
	if text != "" {
		if err := os.WriteFile(path+".tmp", []byte(text), 0o666); err == nil {
			_ = os.Rename(path+".tmp", path)
		}
	}
	return nil
}
