package gate

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"jev-gate/pyjson"
)

// shlexSplit is shlex.split(s) (POSIX mode, no comments): quotes, backslash escapes, whitespace splitting.
func shlexSplit(s string) ([]string, error) {
	var out []string
	var cur strings.Builder
	has := false
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			if has {
				out = append(out, cur.String())
				cur.Reset()
				has = false
			}
		case c == '\\':
			if i+1 >= len(rs) {
				return nil, perr("ValueError", "No escaped character")
			}
			i++
			cur.WriteRune(rs[i])
			has = true
		case c == '\'':
			j := i + 1
			for j < len(rs) && rs[j] != '\'' {
				j++
			}
			if j >= len(rs) {
				return nil, perr("ValueError", "No closing quotation")
			}
			cur.WriteString(string(rs[i+1 : j]))
			i = j
			has = true
		case c == '"':
			j := i + 1
			closed := false
			for j < len(rs) {
				if rs[j] == '\\' && j+1 < len(rs) && (rs[j+1] == '"' || rs[j+1] == '\\') {
					cur.WriteRune(rs[j+1])
					j += 2
					continue
				}
				if rs[j] == '"' {
					closed = true
					break
				}
				cur.WriteRune(rs[j])
				j++
			}
			if !closed {
				return nil, perr("ValueError", "No closing quotation")
			}
			i = j
			has = true
		default:
			cur.WriteRune(c)
			has = true
		}
	}
	if has {
		out = append(out, cur.String())
	}
	return out, nil
}

type touched struct{ root, path string }

// touchedPaths is touched_paths(): (repo_root, abs_path) of files the call touches, capped at impact.max_paths.
func touchedPaths(tool any, ti *pyjson.OMap, cwd string, cfg Config) ([]touched, error) {
	shell := inList(pyjson.AsList(cfg.M["shell_tools"]), tool)
	var cands []string
	if shell {
		cmd, _ := ti.M["command"].(string)
		words, err := shlexSplit(cmd)
		if err != nil {
			return nil, nil // except ValueError: return []
		}
		for _, w := range words {
			if !strings.HasPrefix(w, "-") && (strings.Contains(w, "/") || strings.Contains(w, ".")) {
				cands = append(cands, w)
			}
		}
	} else {
		for _, f := range pyjson.AsList(cfg.M["path_fields"]) {
			if s, ok := ti.M[str(f)].(string); ok {
				cands = append(cands, s)
			}
		}
	}
	base := cwd
	if base == "" {
		base, _ = os.Getwd()
	}
	var out []touched
	for _, c := range cands {
		c = expandUser(c)
		p := c
		if !filepath.IsAbs(c) {
			p = filepath.Join(base, c)
		}
		p = filepath.Clean(p)
		if shell {
			if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() {
				continue
			}
		}
		root := RepoOf(filepath.Dir(p))
		if root == "" {
			continue
		}
		dup := false
		for _, t := range out {
			if t.root == root && t.path == p {
				dup = true
			}
		}
		if !dup {
			out = append(out, touched{root, p})
		}
	}
	maxP := intOf(get(cfg, "code_graph", "impact", "max_paths"))
	if len(out) > maxP {
		out = out[:maxP]
	}
	return out, nil
}

// Impact is impact(): capped code-graph impact text for the files a tool call touches, or "".
func Impact(cli string, tool any, ti *pyjson.OMap, project any, sessionID string, cfg Config) (out string) {
	i := pyjson.AsMap(get(cfg, "code_graph", "impact"))
	if i == nil || !pyjson.Truthy(i.M["enabled"]) {
		return ""
	}
	fail := func(err error) string {
		Log(cfg, Ev("use", "impact", "cli", cli, "tool", tool, "reason", "exception:"+ErrName(err)))
		return ""
	}
	defer func() {
		if r := recover(); r != nil {
			out = fail(perr("Exception", "panic"))
		}
	}()
	cwd, _ := project.(string)
	tps, err := touchedPaths(tool, ti, cwd, cfg)
	if err != nil {
		return fail(err)
	}
	var nodes []string
	nk := str(i.M["node_key"])
	for _, t := range tps {
		rel, err := filepath.Rel(t.root, t.path)
		if err != nil {
			return fail(perr("ValueError", "%v", err))
		}
		n := strings.NewReplacer("{{", "{", "}}", "}", "{repo}", filepath.Base(t.root), "{path}", rel).Replace(nk)
		nodes = append(nodes, n)
	}
	if len(nodes) == 0 {
		return ""
	}
	cpath, cache := sessionCache(cfg, sessionID)
	var rpc mcpRPC
	noMatch := str(i.M["no_match"])
	var parts []string
	for _, n := range nodes {
		key := "impact:" + n
		if _, ok := cache.Get(key); !ok {
			if rpc == nil {
				ep, err := CgcEndpoint(cli, cfg)
				if err != nil {
					return fail(err)
				}
				if ep == nil {
					return ""
				}
				rpc, err = McpSession(ep, time.Now().Add(time.Duration(num(i.M["budget_s"])*float64(time.Second))), cfg)
				if err != nil {
					return fail(err)
				}
			}
			args := pyjson.AsMap(i.M["args"]).Copy()
			args.Set(str(i.M["target_arg"]), n)
			t, err := toolText(rpc, str(i.M["tool"]), args)
			if err != nil {
				return fail(err)
			}
			t = strings.TrimFunc(t, isPySpace)
			hit, err := searchRE(noMatch, t)
			if err != nil {
				return fail(err)
			}
			if hit {
				cachePut(cfg, cpath, cache, key, "")
			} else {
				cachePut(cfg, cpath, cache, key, t)
			}
		}
		if v, _ := cache.M[key].(string); v != "" {
			parts = append(parts, v)
		}
	}
	text := runeSlice(Redact(strings.Join(parts, "\n"), cfg), intOf(i.M["max_chars"]))
	return text
}
