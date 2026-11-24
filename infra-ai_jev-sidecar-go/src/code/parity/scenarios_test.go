//go:build parity

package parity

import (
	"fmt"
	"os"
	"strings"
	"time"

	"jev-gate/pyjson"
)

func claude(ev, tool string, input any, sid string) func(d *dirs) string {
	return func(d *dirs) string {
		o := pyjson.Obj("hook_event_name", ev, "tool_name", tool, "tool_input", input, "cwd", d.project)
		if sid != "" {
			o.Set("session_id", sid)
		}
		return pyjson.DumpsDefault(o)
	}
}

func bash(cmd string) any { return pyjson.Obj("command", cmd) }

func prompt(text, sid string, cwd func(d *dirs) string) func(d *dirs) string {
	return func(d *dirs) string {
		o := pyjson.Obj("hook_event_name", "UserPromptSubmit", "prompt", text, "cwd", cwd(d))
		if sid != "" {
			o.Set("session_id", sid)
		}
		return pyjson.DumpsDefault(o)
	}
}

func inRepo(d *dirs) string  { return d.project }
func outside(d *dirs) string { return d.home }

func seed(lines ...string) func(d *dirs, m *mcp) {
	return func(d *dirs, m *mcp) { os.WriteFile(d.log, []byte(strings.Join(lines, "\n")+"\n"), 0o644) }
}

func goosePicks(n int) []string {
	var out []string
	ts := time.Now().Unix() - 100
	for i := 0; i < n; i++ {
		out = append(out, j("ts", ts, "src", "jev-gate", "use", "goose_pretool", "tool", "shell", "verdict", "allow", "call", fmt.Sprintf("c%03d", i), "picks", pyjson.Obj("safe", true)))
		out = append(out, j("ts", ts, "src", "jev-gate", "use", "goose_pretool", "verdict", "outcome", "call", fmt.Sprintf("c%03d", i), "label", true))
	}
	return out
}

func patchUse(use, key string, v any) func(cfg *pyjson.OMap, d *dirs) {
	return func(cfg *pyjson.OMap, d *dirs) { pyjson.AsMap(pyjson.AsMap(cfg.M["uses"]).M[use]).Set(key, v) }
}

func yes(b bool) *bool { return &b }

var routeReply = func(repo string) func(*pyjson.OMap) (int, string, time.Duration) {
	return func(b *pyjson.OMap) (int, string, time.Duration) {
		return 200, answersFor(b, 0.97, func(q string, crit *pyjson.OMap) (string, float64) {
			if q == "repo" {
				return repo, 0.97
			}
			return crit.Keys[0], 0.97
		}), 0
	}
}

func scenarios() []scn {
	ok := okNoul(0.97)
	var ss []scn
	add := func(s scn) { ss = append(ss, s) }

	// ---- claude: permission flow ----
	add(scn{name: "claude-no-key", mode: "claude", nokey: true, stdin: claude("PermissionRequest", "Bash", bash("ls -la"), "")})
	add(scn{name: "claude-allow-permission", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", bash("ls -la"), "")})
	add(scn{name: "claude-allow-pretool", mode: "claude", reply: ok, stdin: claude("PreToolUse", "Read", pyjson.Obj("file_path", "/tmp/notes.txt"), "")})
	add(scn{name: "claude-unsafe-defers", mode: "claude", reply: okNoul(0.03), stdin: claude("PermissionRequest", "Bash", bash("ls -la"), "")})
	add(scn{name: "claude-with-task", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", pyjson.Obj("command", "go test ./...", "description", "Run the unit tests"), "")})
	add(scn{name: "claude-mixed-scores", mode: "claude", stdin: claude("PermissionRequest", "Bash", pyjson.Obj("command", "go test", "description", "run"), ""),
		reply: func(b *pyjson.OMap) (int, string, time.Duration) {
			return 200, `{"answers":{"reversible":{"noul":0.99},"serves_task":{"noul":0.5}}}`, 0
		}})
	for i, c := range []string{"rm -rf /tmp/x", "git push origin main", "echo $(id)", "ls; sudo reboot", "cat .env", "ssh host uptime", "npm publish", "FOO=1 curl http://x", "bash -c 'x'",
		"python3 -c 'print(1)'", "rm -rf /", "docker rm x", "kill -9 1", "if true; then git reset --hard; fi", "ls | xargs rm", "/usr/bin/curl x", "echo `x`", "timeout 5 wget x",
		"ls -la", "git status", "chmod -R 777 x", "echo a && git clean -fd", "cat ~/.ssh/id_rsa", "make; make install", "terraform apply", "echo 'quoted' | wc -l", "\"ls\" -la", "cd /tmp && ls"} {
		add(scn{name: fmt.Sprintf("claude-cmd-%02d", i), mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", bash(c), "")})
	}
	add(scn{name: "claude-write-etc", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Write", pyjson.Obj("file_path", "/etc/hosts", "content", "x"), "")})
	add(scn{name: "claude-write-tmp", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Write", pyjson.Obj("file_path", "/tmp/x.txt", "content", "x"), "")})
	add(scn{name: "claude-edit-workflow", mode: "claude", reply: ok, stdin: claude("PreToolUse", "Edit", pyjson.Obj("file_path", "/w/.github/workflows/ci.yml"), "")})
	add(scn{name: "claude-grep-path-pem", mode: "claude", reply: ok, stdin: claude("PreToolUse", "Grep", pyjson.Obj("path", "/home/u/cert.pem", "pattern", "x"), "")})
	add(scn{name: "claude-command-not-string", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", pyjson.Obj("command", int64(5)), "")})

	// ---- claude: Decisions failures ----
	for name, r := range map[string]func(*pyjson.OMap) (int, string, time.Duration){
		"http500": fixed(500, "boom"), "http403": fixed(403, "{}"), "not-json": fixed(200, "<html>"), "empty-body": fixed(200, ""), "no-answers": fixed(200, `{"id":"x"}`),
		"answers-list": fixed(200, `{"answers":[1]}`), "answers-empty": fixed(200, `{"answers":{}}`), "noul-range": fixed(200, `{"answers":{"reversible":{"noul":1.5}}}`),
		"noul-string": fixed(200, `{"answers":{"reversible":{"noul":"0.9"}}}`), "noul-bool": fixed(200, `{"answers":{"reversible":{"noul":true}}}`), "json-array": fixed(200, `[1,2]`),
		"no-cost": fixed(200, `{"id":"g","answers":{"reversible":{"noul":0.97}}}`), "bad-cost": fixed(200, `{"id":"g","usage":{"cost":-1},"answers":{"reversible":{"noul":0.97}}}`),
		"slow": func(*pyjson.OMap) (int, string, time.Duration) { return 200, `{"answers":{}}`, 1500 * time.Millisecond },
	} {
		add(scn{name: "claude-reply-" + name, mode: "claude", reply: r, stdin: claude("PermissionRequest", "Bash", bash("ls -la"), "")})
	}
	add(scn{name: "claude-conn-refused", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", bash("ls"), ""),
		patch: func(cfg *pyjson.OMap, d *dirs) { cfg.Set("endpoint", "http://127.0.0.1:1/x") }})
	add(scn{name: "claude-state-too-large", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", bash("echo "+strings.Repeat("a", 300)), ""),
		patch: func(cfg *pyjson.OMap, d *dirs) { cfg.Set("max_state_chars", int64(200)) }})
	add(scn{name: "claude-redaction", mode: "claude", reply: ok, env: map[string]string{"DEPLOY_TOKEN": "zq9-very-secret-value-4455"},
		stdin: claude("PermissionRequest", "Bash", bash("echo sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 ghp_abcdefghijklmnopqrstuvwxyz password=hunter2 Authorization: Bearer abc123tokenvalue zq9-very-secret-value-4455 https://u:pw@host/x"), "")})
	add(scn{name: "claude-unicode", mode: "claude", reply: ok, stdin: claude("PermissionRequest", "Bash", pyjson.Obj("command", "echo héllo 世界 😀 \"q\" \\ \t", "description", "Say héllo é"), "")})
	add(scn{name: "claude-tool-input-list", mode: "claude", reply: ok, stdin: func(*dirs) string {
		return `{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":[1]}`
	}})
	add(scn{name: "claude-no-tool-name", mode: "claude", reply: ok, stdin: func(*dirs) string { return `{"hook_event_name":"PermissionRequest"}` }})
	add(scn{name: "claude-bad-stdin", mode: "claude", reply: ok, stdin: func(*dirs) string { return `{nope` }})
	add(scn{name: "claude-empty-stdin", mode: "claude", reply: ok, stdin: func(*dirs) string { return `` }})
	add(scn{name: "claude-stdin-array", mode: "claude", reply: ok, stdin: func(*dirs) string { return `[1]` }})
	add(scn{name: "claude-unknown-mode", mode: "bogus", reply: ok, stdin: func(*dirs) string { return `{}` }})
	add(scn{name: "claude-rate-limited", mode: "claude", reply: ok, runs: 3, stdin: claude("PermissionRequest", "Bash", bash("ls"), ""), patch: patchUse("claude_permission", "max_calls_per_hour", int64(1))})
	add(scn{name: "claude-over-budget", mode: "claude", reply: ok, runs: 3, stdin: claude("PermissionRequest", "Bash", bash("ls"), ""),
		patch: func(cfg *pyjson.OMap, d *dirs) { pyjson.AsMap(cfg.M["budget"]).Set("daily_cost_cap", 0.001) }})

	// ---- claude: impact (code-graph) ----
	impactCmd := func(d *dirs) string {
		return claude("PermissionRequest", "Bash", bash("cat "+d.repo+"/main.go"), "imp1")(d)
	}
	add(scn{name: "claude-impact", mode: "claude", reply: ok, text: "impact: 3 callers", stdin: impactCmd})
	add(scn{name: "claude-impact-json-reply", mode: "claude", reply: ok, text: "impact: 3 callers", sse: yes(false), stdin: impactCmd})
	add(scn{name: "claude-impact-cached", mode: "claude", reply: ok, text: "impact: 3 callers", runs: 2, stdin: impactCmd})
	add(scn{name: "claude-impact-no-match", mode: "claude", reply: ok, text: "No matches found", runs: 2, stdin: impactCmd})
	add(scn{name: "claude-impact-mcp-500", mode: "claude", reply: ok, status: 500, stdin: impactCmd})
	add(scn{name: "claude-impact-tool-error", mode: "claude", reply: ok, isErr: true, text: "x", stdin: impactCmd})
	add(scn{name: "claude-impact-file-tool", mode: "claude", reply: ok, text: "impact: file tool", stdin: func(d *dirs) string {
		return claude("PreToolUse", "Edit", pyjson.Obj("file_path", d.repo+"/main.go"), "imp2")(d)
	}})
	add(scn{name: "claude-impact-no-cfg", mode: "claude", reply: ok, text: "x", stdin: impactCmd, setup: func(d *dirs, m *mcp) { os.Remove(d.root + "/claude.json") }})

	// ---- claude: UserPromptSubmit route_context ----
	repos := []string{"cloud-infra", "cloud-u-containers"}
	long := "how does the router tier work in cloud-infra"
	add(scn{name: "route-injected", mode: "claude", reply: routeReply("cloud-infra"), text: "node A\nLoading 5 GraphRAG chunks\n  Deduplicated 3 items\nnode B ü", repos: repos, stdin: prompt(long, "r1", inRepo)})
	add(scn{name: "route-injected-json", mode: "claude", reply: routeReply("cloud-infra"), sse: yes(false), text: "node A", repos: repos, stdin: prompt(long, "r1", inRepo)})
	add(scn{name: "route-cached", mode: "claude", reply: routeReply("cloud-infra"), text: "node A", repos: repos, runs: 2, stdin: prompt(long, "r2", inRepo)})
	add(scn{name: "route-no-session", mode: "claude", reply: routeReply("cloud-infra"), text: "node A", repos: repos, runs: 2, stdin: prompt(long, "", inRepo)})
	add(scn{name: "route-repo-question", mode: "claude", reply: routeReply("cloud-u-containers"), text: "node Z", repos: repos, stdin: prompt(long, "r3", outside)})
	add(scn{name: "route-repo-unsure", mode: "claude", text: "node Z", repos: repos, stdin: prompt(long, "r4", outside), reply: func(b *pyjson.OMap) (int, string, time.Duration) {
		return 200, answersFor(b, 0.97, func(q string, c *pyjson.OMap) (string, float64) {
			if q == "repo" {
				return "cloud-infra", 0.4
			}
			return c.Keys[0], 0.97
		}), 0
	}})
	add(scn{name: "route-none", mode: "claude", text: "x", repos: repos, stdin: prompt("hello there", "r5", inRepo), reply: func(b *pyjson.OMap) (int, string, time.Duration) {
		return 200, answersFor(b, 0.97, func(q string, c *pyjson.OMap) (string, float64) { return "none", 0.97 }), 0
	}})
	add(scn{name: "route-low-p", mode: "claude", text: "x", repos: repos, stdin: prompt(long, "r6", inRepo), reply: func(b *pyjson.OMap) (int, string, time.Duration) {
		return 200, answersFor(b, 0.97, func(q string, c *pyjson.OMap) (string, float64) { return c.Keys[0], 0.5 }), 0
	}})
	add(scn{name: "route-no-repos-enum", mode: "claude", reply: routeReply("cloud-infra"), text: "node A", repos: nil, stdin: prompt(long, "r7", outside)})
	add(scn{name: "route-empty-prompt", mode: "claude", reply: routeReply("cloud-infra"), stdin: prompt("   ", "r8", inRepo)})
	add(scn{name: "route-prompt-not-string", mode: "claude", reply: routeReply("cloud-infra"), stdin: func(d *dirs) string {
		return j("hook_event_name", "UserPromptSubmit", "prompt", int64(5), "cwd", d.project)
	}})
	add(scn{name: "route-mcp-500", mode: "claude", reply: routeReply("cloud-infra"), status: 500, repos: repos, stdin: prompt(long, "r9", inRepo)})
	add(scn{name: "route-tool-error", mode: "claude", reply: routeReply("cloud-infra"), isErr: true, text: "x", repos: repos, stdin: prompt(long, "r10", inRepo)})
	add(scn{name: "route-no-client-config", mode: "claude", reply: routeReply("cloud-infra"), repos: repos, stdin: prompt(long, "r11", inRepo), setup: func(d *dirs, m *mcp) { os.Remove(d.root + "/claude.json") }})
	add(scn{name: "route-decisions-500", mode: "claude", reply: fixed(500, "x"), repos: repos, stdin: prompt(long, "r12", inRepo)})
	add(scn{name: "route-no-key", mode: "claude", nokey: true, repos: repos, stdin: prompt(long, "r13", inRepo)})
	add(scn{name: "route-truncate", mode: "claude", reply: routeReply("cloud-infra"), text: strings.Repeat("0123456789 ü\n", 40), repos: repos, stdin: prompt(long, "r14", inRepo),
		patch: func(cfg *pyjson.OMap, d *dirs) {
			pyjson.AsMap(pyjson.AsMap(cfg.M["code_graph"]).M["route"]).Set("max_inject_chars", int64(200))
		}})
	add(scn{name: "route-empty-result", mode: "claude", reply: routeReply("cloud-infra"), text: "Loading 5 GraphRAG chunks", repos: repos, stdin: prompt(long, "r15", inRepo)})
	add(scn{name: "route-secret-redacted", mode: "claude", reply: routeReply("cloud-infra"), text: "key sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 end", repos: repos, stdin: prompt("explain sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 in cloud-infra", "r16", inRepo)})
	add(scn{name: "route-query-truncated", mode: "claude", reply: routeReply("cloud-infra"), text: "n", repos: repos, stdin: prompt(strings.Repeat("é long ", 600), "r17", inRepo)})

	// ---- goose ----
	gooseEv := func(tool string, input any) func(d *dirs) string {
		return func(d *dirs) string {
			return j("tool_name", tool, "tool_input", input, "working_dir", d.project, "session_id", "g1")
		}
	}
	add(scn{name: "goose-allow", mode: "goose", reply: ok, stdin: gooseEv("developer__shell", bash("ls -la"))})
	add(scn{name: "goose-unsafe-gate-closed", mode: "goose", reply: okNoul(0.03), stdin: gooseEv("developer__shell", bash("ls -la"))})
	add(scn{name: "goose-unsafe-gate-open", mode: "goose", reply: okNoul(0.03), setup: seed(goosePicks(50)...), stdin: gooseEv("developer__shell", bash("ls -la"))})
	add(scn{name: "goose-unsafe-block-always", mode: "goose", reply: okNoul(0.03), patch: patchUse("goose_pretool", "on_unsafe", "block"), stdin: gooseEv("write_file", pyjson.Obj("path", "/tmp/a"))})
	add(scn{name: "goose-never-auto", mode: "goose", reply: okNoul(0.03), stdin: gooseEv("developer__shell", bash("rm -rf /"))})
	add(scn{name: "goose-no-tool-name", mode: "goose", reply: okNoul(0.03), stdin: func(d *dirs) string { return j("tool_input", bash("ls")) }})
	gp := func(d *dirs) string {
		return j("message", "how does the router tier work in cloud-infra", "working_dir", d.project, "session_id", "gp1")
	}
	add(scn{name: "goose-prompt-injected", mode: "goose-prompt", reply: routeReply("cloud-infra"), text: "node A", repos: repos, stdin: gp})
	add(scn{name: "goose-prompt-none", mode: "goose-prompt", repos: repos, stdin: gp, setup: func(d *dirs, m *mcp) { os.WriteFile(d.moim, []byte("STALE"), 0o644) },
		reply: func(b *pyjson.OMap) (int, string, time.Duration) {
			return 200, answersFor(b, 0.97, func(q string, c *pyjson.OMap) (string, float64) { return "none", 0.97 }), 0
		}})
	add(scn{name: "goose-prompt-error-empties", mode: "goose-prompt", reply: fixed(500, "x"), repos: repos, stdin: gp, setup: func(d *dirs, m *mcp) { os.WriteFile(d.moim, []byte("STALE"), 0o644) }})
	add(scn{name: "goose-prompt-no-file-env", mode: "goose-prompt", reply: routeReply("cloud-infra"), text: "node A", repos: repos, stdin: gp, env: map[string]string{"GOOSE_MOIM_MESSAGE_FILE": ""}})

	// ---- decide / outcome / precision ----
	q := func(typ, instr string) *pyjson.OMap { return pyjson.Obj("type", typ, "instructions", instr) }
	probeIn := func(state any, qs *pyjson.OMap) func(*dirs) string {
		return func(*dirs) string { return j("state", state, "questions", qs) }
	}
	noulQ := pyjson.Obj("stalled", q("noul", "Is the queue stalled?"))
	choiceQ := func(crit ...string) *pyjson.OMap {
		c := pyjson.NewMap()
		for _, k := range crit {
			c.Set(k, "option "+k)
		}
		return pyjson.Obj("pick", pyjson.Obj("type", "choice", "instructions", "Which?", "criteria", c))
	}
	st := pyjson.Obj("note", "queue stalled for 40m", "n", int64(3), "ratio", 0.5, "tags", []any{"a", "é"})
	add(scn{name: "decide-probe", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-probe-cached", mode: "decide", args: []string{"--use", "probe"}, reply: ok, runs: 3, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-probe-secret-state", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(pyjson.Obj("log", "token=abcd1234efgh sk-or-v1-abcdefghijklmnopqrstuvwxyz0123", "l", []any{"ghp_abcdefghijklmnopqrstuvwxyz"}), noulQ)})
	add(scn{name: "decide-probe-unsure", mode: "decide", args: []string{"--use", "probe"}, reply: okNoul(0.6), stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-no-key", mode: "decide", args: []string{"--use", "probe"}, nokey: true, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-http500", mode: "decide", args: []string{"--use", "probe"}, reply: fixed(500, "x"), stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-malformed", mode: "decide", args: []string{"--use", "probe"}, reply: fixed(200, `{"answers":{"stalled":{"noul":7}}}`), stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-answer-missing", mode: "decide", args: []string{"--use", "probe"}, reply: fixed(200, `{"answers":{"other":{"noul":0.9}}}`), stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-no-use-arg", mode: "decide", reply: ok, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-use-last-arg", mode: "decide", args: []string{"--use"}, reply: ok, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-bad-json", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: func(*dirs) string { return "{x" }})
	add(scn{name: "decide-no-state", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: func(*dirs) string { return j("questions", noulQ) }})
	add(scn{name: "decide-state-null", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: func(*dirs) string { return `{"state": null, "questions": {"s": {"type":"noul","instructions":"x"}}}` }})
	add(scn{name: "decide-payload-list", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: func(*dirs) string { return `[1]` }})
	add(scn{name: "decide-unknown-use", mode: "decide", args: []string{"--use", "nope"}, reply: ok, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-not-generic", mode: "decide", args: []string{"--use", "claude_permission"}, reply: ok, stdin: probeIn(st, noulQ)})
	add(scn{name: "decide-disabled", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, noulQ), patch: patchUse("probe", "enabled", false)})
	add(scn{name: "decide-misconfigured-ttl", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, noulQ), patch: patchUse("probe", "ttl_s", int64(0))})
	add(scn{name: "decide-misconfigured-threshold", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, noulQ), patch: patchUse("probe", "threshold", 1.5)})
	add(scn{name: "decide-zero-questions", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, pyjson.NewMap())})
	manyQ := pyjson.NewMap()
	for i := 0; i < 9; i++ {
		manyQ.Set(fmt.Sprintf("q%d", i), q("noul", "x"))
	}
	add(scn{name: "decide-too-many-questions", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, manyQ)})
	add(scn{name: "decide-bad-question-type", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, pyjson.Obj("a", q("text", "x")))})
	add(scn{name: "decide-question-no-instructions", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, pyjson.Obj("a", pyjson.Obj("type", "noul")))})
	add(scn{name: "decide-choice-one-criterion", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, choiceQ("only"))})
	add(scn{name: "decide-choice", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(st, choiceQ("a", "b", "c"))})
	add(scn{name: "decide-choice-bad-pick", mode: "decide", args: []string{"--use", "probe"}, stdin: probeIn(st, choiceQ("a", "b")),
		reply: fixed(200, `{"answers":{"pick":{"choice":"z","probabilities":{"a":0.5,"z":0.5}}}}`)})
	add(scn{name: "decide-score", mode: "decide", args: []string{"--use", "probe"}, stdin: probeIn(st, pyjson.Obj("sev", q("score", "How severe?"))),
		reply: fixed(200, `{"answers":{"sev":{"probabilities":{"low":0.1,"high":0.8,"mid":0.1}}}}`)})
	add(scn{name: "decide-score-tie", mode: "decide", args: []string{"--use", "probe"}, stdin: probeIn(st, pyjson.Obj("sev", q("score", "How severe?"))),
		reply: fixed(200, `{"answers":{"sev":{"probabilities":{"low":0.4,"high":0.4,"mid":0.2}}}}`)})
	add(scn{name: "decide-score-no-probs", mode: "decide", args: []string{"--use", "probe"}, stdin: probeIn(st, pyjson.Obj("sev", q("score", "How severe?"))),
		reply: fixed(200, `{"answers":{"sev":{"probabilities":{}}}}`)})
	add(scn{name: "decide-allowed-ok", mode: "decide", args: []string{"--use", "mail_fallback_folder"}, reply: ok, stdin: probeIn(st, choiceQ("finance", "work"))})
	add(scn{name: "decide-allowed-rejected", mode: "decide", args: []string{"--use", "mail_fallback_folder"}, reply: ok, stdin: probeIn(st, choiceQ("finance", "spam"))})
	add(scn{name: "decide-gate-open", mode: "decide", args: []string{"--use", "mail_fallback_folder"}, reply: ok, stdin: probeIn(st, choiceQ("finance", "work")), setup: func(d *dirs, m *mcp) {
		var lines []string
		ts := time.Now().Unix() - 50
		for i := 0; i < 30; i++ {
			lines = append(lines, j("ts", ts, "src", "jev-gate", "use", "mail_fallback_folder", "verdict", "answered", "call", fmt.Sprintf("m%02d", i), "picks", pyjson.Obj("pick", "work")))
			lines = append(lines, j("ts", ts, "src", "jev-gate", "use", "mail_fallback_folder", "verdict", "outcome", "call", fmt.Sprintf("m%02d", i), "label", "work"))
		}
		seed(lines...)(d, m)
	}})
	add(scn{name: "decide-rate-limited", mode: "decide", args: []string{"--use", "alert_priority"}, reply: ok, runs: 4, stdin: probeIn(st, choiceQ("low", "high")), patch: patchUse("alert_priority", "max_calls_per_hour", int64(2))})
	add(scn{name: "decide-over-budget", mode: "decide", args: []string{"--use", "alert_priority"}, reply: ok, runs: 2, stdin: probeIn(st, choiceQ("low", "high")),
		patch: func(cfg *pyjson.OMap, d *dirs) { pyjson.AsMap(cfg.M["budget"]).Set("daily_cost_cap", 0.0005) }})
	add(scn{name: "decide-budget-no-cost", mode: "decide", args: []string{"--use", "alert_priority"}, reply: fixed(200, `{"answers":{"pick":{"choice":"low","probabilities":{"low":0.9,"high":0.1}}}}`), runs: 2, stdin: probeIn(st, choiceQ("low", "high"))})
	add(scn{name: "decide-state-too-large", mode: "decide", args: []string{"--use", "probe"}, reply: ok, stdin: probeIn(pyjson.Obj("blob", strings.Repeat("x", 9000)), noulQ)})

	outcomeCfg := func(args ...string) scn {
		return scn{name: "outcome-" + strings.Join(args, "_"), mode: "outcome", args: args}
	}
	add(outcomeCfg("--use", "probe", "--call", "c1", "--label", "true"))
	add(outcomeCfg("--use", "probe", "--call", "c1", "--label", `{"pick":"work"}`))
	add(outcomeCfg("--use", "probe", "--call", "c1", "--label", "work"))
	add(outcomeCfg("--use", "probe", "--call", "c1"))
	add(outcomeCfg("--use", "probe"))
	add(outcomeCfg("--call", "c1"))
	add(outcomeCfg("--use", "probe", "--call", "", "--label", "1"))
	add(scn{name: "precision-empty", mode: "precision"})
	add(scn{name: "precision-seeded", mode: "precision", setup: func(d *dirs, m *mcp) {
		now := time.Now().Unix()
		lines := goosePicks(55)
		for i := 0; i < 5; i++ {
			lines = append(lines, j("ts", now-3, "src", "jev-gate", "use", "router_tier", "verdict", "answered", "call", fmt.Sprintf("rt%d", i), "picks", pyjson.Obj("tier", "fast")))
		}
		lines = append(lines, j("ts", now-20*86400, "src", "jev-gate", "use", "router_tier", "verdict", "answered", "call", "rt-old", "picks", pyjson.Obj("tier", "fast")))
		lines = append(lines, j("ts", now, "src", "jev-gate", "use", "router_tier", "verdict", "outcome", "call", "rt0", "label", pyjson.Obj("tier", "slow")))
		lines = append(lines, j("ts", now, "src", "jev-gate", "use", "router_tier", "verdict", "outcome", "call", "rt1", "label", pyjson.Obj("tier", "fast")))
		lines = append(lines, "not json at all", `[1,2]`)
		seed(lines...)(d, m)
	}})
	return ss
}
