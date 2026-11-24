// Package broker is the Go port of notify-broker.py. Decide is the same pure function: no network, no clock, no disk.
// Values are plain JSON data (map[string]any, []any, string, float64, bool, nil) so the Python test corpus and the
// parity harness can feed identical documents to both implementations.
package broker

import (
	"encoding/json"
	"fmt"
	"strings"
)

// M is a JSON object.
type M = map[string]any

// SeverityOrder is the escalation ladder.
var SeverityOrder = []string{"info", "warn", "crit", "page"}

// Policy is the parsed build-notify.json. UnitOrder keeps the file order of category_by_unit, because Python's dict
// iteration order breaks ties between equally specific glob patterns.
type Policy struct {
	Raw       M
	UnitOrder []string
}

// ParsePolicy parses a policy document.
func ParsePolicy(data []byte) (*Policy, error) {
	var raw M
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("policy is not a JSON object")
	}
	return &Policy{Raw: raw, UnitOrder: unitOrder(data)}, nil
}

// unitOrder returns the key order of the top-level category_by_unit object.
func unitOrder(data []byte) []string {
	dec := json.NewDecoder(strings.NewReader(string(data)))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return nil
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil
		}
		key, _ := kt.(string)
		if key == "category_by_unit" {
			if t, err := dec.Token(); err != nil || t != json.Delim('{') {
				return nil
			}
			var keys []string
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return keys
				}
				k, _ := kt.(string)
				keys = append(keys, k)
				var skip json.RawMessage
				if err := dec.Decode(&skip); err != nil {
					return keys
				}
			}
			return keys
		}
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil
		}
	}
	return nil
}

// ---- Python-semantics helpers -------------------------------------------------------------------------------------

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case []any:
		return len(t) > 0
	case M:
		return len(t) > 0
	}
	return true
}

func num(v any, def float64) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	}
	return def
}

func pyStr(v any) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case float64:
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return fmt.Sprintf("%v", t)
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func asM(v any) M {
	if m, ok := v.(M); ok {
		return m
	}
	return M{}
}

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

func get(m M, k string, def any) any {
	if v, ok := m[k]; ok {
		return v
	}
	return def
}

func severityRank(sev any) int {
	s, ok := sev.(string)
	if !ok {
		return 0
	}
	for i, x := range SeverityOrder {
		if x == s {
			return i
		}
	}
	return 0
}

func deepCopy(v any) any {
	b, _ := json.Marshal(v)
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// ---- resolution ---------------------------------------------------------------------------------------------------

// ResolveCategory: event.category, else unit glob, else "default".
func ResolveCategory(event M, p *Policy) any {
	if truthy(event["category"]) {
		return event["category"]
	}
	if unit, ok := event["unit"].(string); ok && unit != "" {
		table := asM(p.Raw["category_by_unit"])
		if v, ok := table[unit]; ok && !strings.Contains(unit, "*") && !strings.HasPrefix(unit, "_") {
			return v
		}
		bestPat := ""
		var bestCat any
		found := false
		for _, pat := range p.UnitOrder {
			if strings.HasPrefix(pat, "_") {
				continue
			}
			if strings.Contains(pat, "*") && fnmatch(unit, pat) {
				if !found || len([]rune(pat)) > len([]rune(bestPat)) {
					bestPat, bestCat, found = pat, table[pat], true
				}
			}
		}
		if found {
			return bestCat
		}
	}
	return "default"
}

// ResolveSeverity: explicit event.severity wins, else severity_map.by_class[class], else severity_map.default.
func ResolveSeverity(event M, p *Policy) any {
	if s, ok := event["severity"].(string); ok {
		for _, x := range SeverityOrder {
			if x == s {
				return s
			}
		}
	}
	smap := asM(p.Raw["severity_map"])
	byClass := asM(smap["by_class"])
	if cls, ok := event["class"].(string); ok && cls != "" {
		if v, ok := byClass[cls]; ok {
			return v
		}
	}
	return get(smap, "default", "info")
}

// RouteChannels picks the channel list for (category, severity): category rule, else the default rule.
func RouteChannels(category, severity any, p *Policy) []any {
	rules := asList(asM(p.Raw["routing"])["rules"])
	want := "category:" + pyStr(category)
	var chosen M
	for _, r := range rules {
		rm := asM(r)
		if rm["match"] == want {
			chosen = rm
			break
		}
	}
	if chosen == nil {
		for _, r := range rules {
			rm := asM(r)
			if rm["match"] == "default" {
				chosen = rm
				break
			}
		}
	}
	if chosen == nil {
		return []any{}
	}
	sevKey, _ := severity.(string)
	if l, ok := asM(chosen["channels"])[sevKey].([]any); ok {
		return l
	}
	return []any{}
}

func flapStep(ks M, alerting bool, now float64, cfg M) (flapping, muted bool, out M) {
	if !truthy(cfg["enabled"]) {
		return false, false, ks
	}
	window := num(get(cfg, "window_secs", 900.0), 900)
	limit := num(get(cfg, "transitions", 4.0), 4)
	muteFor := num(get(cfg, "mute_after_flap_secs", 1800.0), 1800)

	cp := M{}
	for k, v := range ks {
		cp[k] = v
	}
	if now < num(get(cp, "flap_muted_until", 0.0), 0) {
		return false, true, cp
	}
	prev, hasPrev := cp["alerting"]
	trans := []any{}
	if l, ok := cp["transitions"].([]any); ok {
		trans = l
	}
	if hasPrev && prev != nil && prev != any(alerting) {
		kept := []any{}
		for _, t := range trans {
			if now-num(t, 0) < window {
				kept = append(kept, t)
			}
		}
		trans = append(kept, now)
	}
	cp["transitions"] = trans
	if float64(len(trans)) >= limit {
		cp["flap_muted_until"] = now + muteFor
		cp["transitions"] = []any{}
		return true, false, cp
	}
	return false, false, cp
}

func action(ch any, severity any, title, body any, key, note string) M {
	cm := asM(ch)
	return M{
		"kind":     cm["kind"],
		"topic":    cm["topic"],
		"severity": severity,
		"title":    title,
		"body":     body,
		"key":      key,
		"note":     note,
	}
}

// Decide is the pure routing/dedup/flap/escalation/recovery decision. It returns the actions and the new state.
func Decide(event M, p *Policy, state M, now float64) ([]M, M) {
	var ns M
	if len(state) > 0 {
		ns, _ = deepCopy(state).(M)
	}
	if ns == nil {
		ns = M{}
	}
	keys, ok := ns["keys"].(M)
	if !ok {
		keys = M{}
		ns["keys"] = keys
	}

	var key string
	if truthy(event["key"]) {
		key = pyStr(event["key"])
	} else {
		key = pyStr(get(event, "source", "?")) + ":" + pyStr(get(event, "class", "?"))
	}
	ks, ok := keys[key].(M)
	if !ok {
		ks = M{}
		keys[key] = ks
	}

	category := ResolveCategory(event, p)
	severity := ResolveSeverity(event, p)
	cls, clsIsStr := event["class"].(string)
	recovered := truthy(event["recovered"]) || (clsIsStr && cls == "recovered") || (clsIsStr && strings.HasSuffix(cls, "_ok"))
	ack := truthy(event["ack"])

	actions := []M{}

	if ack {
		ks["acked"] = true
		ks["escalation_level"] = nil
		return actions, ns
	}

	titleOr := func() any { return get(event, "title", key) }

	recCfg := asM(p.Raw["recovery"])
	flapCfg := asM(p.Raw["flap"])
	if recovered {
		_, _, ks = flapStep(ks, false, now, flapCfg)
		wasAlerting := ks["active_severity"] != nil
		if truthy(get(recCfg, "enabled", true)) && wasAlerting {
			notice := get(recCfg, "notice_severity", "info")
			active := get(ks, "active_severity", severity)
			for _, ch := range RouteChannels(category, active, p) {
				actions = append(actions, action(ch, notice, "[RESOLVED] "+pyStr(titleOr()), get(event, "body", ""), key, "recovery"))
			}
		}
		ks["active_severity"] = nil
		ks["alerting"] = false
		ks["acked"] = false
		ks["escalation_level"] = nil
		delete(ks, "first_alert_ts")
		delete(ks, "last_alert_ts")
		keys[key] = ks
		return actions, ns
	}

	esc := asM(p.Raw["escalation"])
	if truthy(esc["enabled"]) && truthy(ks["active_severity"]) && !truthy(ks["acked"]) {
		first := num(get(ks, "first_alert_ts", now), now)
		age := now - first
		eff := severity
		if ks["active_severity"] == "warn" && age >= num(get(esc, "warn_to_crit_secs", 900.0), 900) {
			eff = "crit"
		}
		if (ks["active_severity"] == "warn" || ks["active_severity"] == "crit") && age >= num(get(esc, "crit_to_page_secs", 1800.0), 1800) {
			eff = "page"
		}
		if severityRank(eff) > severityRank(severity) {
			severity = eff
		}
	}

	flapping, muted, ks2 := flapStep(ks, true, now, flapCfg)
	ks = ks2
	if muted {
		keys[key] = ks
		return actions, ns
	}
	if flapping {
		for _, ch := range RouteChannels(category, "warn", p) {
			actions = append(actions, action(ch, "warn", "[FLAPPING] "+pyStr(titleOr()), key+" flapped; further transitions muted.", key, "flap"))
		}
		ks["active_severity"] = severity
		ks["alerting"] = true
		ks["first_alert_ts"] = get(ks, "first_alert_ts", now)
		ks["last_alert_ts"] = now
		keys[key] = ks
		return actions, ns
	}

	dd := asM(p.Raw["dedup"])
	window := num(get(dd, "window_secs", 300.0), 300)
	if v, ok := asM(dd["by_key"])[key]; ok {
		window = num(v, 300)
	}
	sevKey, _ := severity.(string)
	last := num(asM(ks["last_sent"])[sevKey], 0)
	if now-last < window && ks["active_severity"] == severity {
		ks["suppressed_count"] = num(get(ks, "suppressed_count", 0.0), 0) + 1
		ks["alerting"] = true
		keys[key] = ks
		return actions, ns
	}

	for _, ch := range RouteChannels(category, severity, p) {
		actions = append(actions, action(ch, severity, titleOr(), get(event, "body", ""), key, "alert"))
	}
	ls, ok := ks["last_sent"].(M)
	if !ok {
		ls = M{}
		ks["last_sent"] = ls
	}
	ls[sevKey] = now
	ks["active_severity"] = severity
	ks["alerting"] = true
	ks["acked"] = false
	ks["first_alert_ts"] = get(ks, "first_alert_ts", now)
	ks["last_alert_ts"] = now
	ks["suppressed_count"] = 0.0
	keys[key] = ks
	return actions, ns
}
