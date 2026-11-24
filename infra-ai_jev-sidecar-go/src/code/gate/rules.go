package gate

import (
	"os"
	"strings"

	"jev-gate/pyjson"
)

// Redact is redact(): the configured patterns, then every environment value whose NAME looks secret.
func Redact(text string, cfg Config) string {
	r := pyjson.AsMap(cfg.M["redact"])
	for _, pv := range pyjson.AsList(r.M["patterns"]) {
		p := pyjson.AsMap(pv)
		if out, err := subRE(str(p.M["re"]), str(p.M["sub"]), text); err == nil {
			text = out
		}
	}
	secretName := str(r.M["env_name"])
	minLen := intOf(r.M["env_min_len"])
	mask := str(r.M["mask"])
	for _, kv := range os.Environ() {
		name, value, _ := strings.Cut(kv, "=")
		if ok, _ := searchRE(secretName, name); ok && runeLen(value) >= minLen && value != "" {
			text = strings.ReplaceAll(text, value, mask)
		}
	}
	return text
}

func redactObj(x any, cfg Config) any {
	switch v := x.(type) {
	case string:
		return Redact(v, cfg)
	case []any:
		out := make([]any, len(v))
		for i, e := range v {
			out[i] = redactObj(e, cfg)
		}
		return out
	case *pyjson.OMap:
		o := pyjson.NewMap()
		for _, k := range v.Keys {
			o.Set(k, redactObj(v.M[k], cfg))
		}
		return o
	}
	return x
}

func normalize(part string, patterns []any) (string, error) {
	current := part
	for {
		nxt := strings.TrimSpace(current)
		for _, p := range patterns {
			out, err := subRE(str(p), "", nxt)
			if err != nil {
				return "", err
			}
			nxt = out
		}
		if nxt == current {
			return current, nil
		}
		current = nxt
	}
}

func inList(l []any, s any) bool {
	for _, x := range l {
		if pyEq(x, s) {
			return true
		}
	}
	return false
}

// NeverAutoApprove is never_auto_approve(): true when the call must stay with the host's normal flow
// without asking Jev.
func NeverAutoApprove(tool any, toolInput *pyjson.OMap, cfg Config) (bool, error) {
	n := pyjson.AsMap(cfg.M["never_auto_approve"])
	pathsRe := "(?i)" + str(n.M["paths"])
	if inList(pyjson.AsList(cfg.M["shell_tools"]), tool) {
		cmd, ok := toolInput.M["command"].(string)
		if !ok {
			return true, nil
		}
		if hit, err := searchRE(str(n.M["opaque_shell"]), cmd); err != nil || hit {
			return err == nil, err
		}
		if hit, err := searchRE(pathsRe, cmd); err != nil || hit {
			return err == nil, err
		}
		parts, err := splitRE(str(n.M["split"]), cmd)
		if err != nil {
			return false, err
		}
		for _, raw := range parts {
			p, err := normalize(raw, pyjson.AsList(n.M["normalize"]))
			if err != nil {
				return false, err
			}
			if p == "" {
				continue
			}
			for _, rx := range pyjson.AsList(n.M["commands"]) {
				if hit, err := searchRE(str(rx), p); err != nil || hit {
					return err == nil, err
				}
			}
		}
		return false, nil
	}
	for _, f := range pyjson.AsList(cfg.M["path_fields"]) {
		if s, ok := toolInput.M[str(f)].(string); ok {
			if hit, err := searchRE(pathsRe, s); err != nil {
				return false, err
			} else if hit {
				return true, nil
			}
		}
	}
	return false, nil
}
