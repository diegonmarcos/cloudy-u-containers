#!/usr/bin/env python3
"""#764/#765 tester for _shared/jev-gate: behaviour against a mock Decisions server and a mock
cloud-cgc MCP server, mutation tests that prove each guard is load-bearing, and the wiring into the
claude, goose and hermes containers.

Run from anywhere: python3 _shared/test-jev-gate.py   (stdlib only, no network, no key)
"""
import copy
import http.server
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE_DIR = os.path.join(ROOT, "_shared", "jev-gate")
FAKE_KEY = "sk-or-v1-" + "f" * 64


# ── mock Decisions server ────────────────────────────────────────────────────

class Mock:
    reply = None     # dict answers | callable(body)->answers
    status = 200
    raw = None       # bytes body override
    delay = 0.0
    bodies = []


class McpMock:
    """Scripted streamable-HTTP MCP server (the cloud-cgc shape: SSE replies, Mcp-Session-Id)."""
    text = "result"   # str | callable(name, args) -> str
    status = 200
    delay = 0.0
    is_error = False
    sse = True
    calls = []        # {"method", "params", "auth", "sid"}
    TOOLS = [{"name": n, "inputSchema": {"type": "object", "properties": {
        "query": {"type": "string"}, "repo": {"type": "string", "enum": ["cloud-u-containers", "cloud-infra"]}}}}
        for n in ["cgc.octocode.graphrag", "cgc.octocode.search"]] + [
        {"name": "cgc.codegraph.impact_analysis", "inputSchema": {"type": "object", "properties": {
            "target": {"type": "string"}, "depth": {"type": "number"}}}}]


def mcp_reset(text="result", status=200, delay=0.0, is_error=False, sse=True):
    McpMock.text, McpMock.status, McpMock.delay, McpMock.is_error, McpMock.sse = text, status, delay, is_error, sse
    McpMock.calls = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_mcp(self, body):
        McpMock.calls.append({"method": body.get("method"), "params": body.get("params"),
                              "auth": self.headers.get("Authorization"), "sid": self.headers.get("Mcp-Session-Id")})
        text, status, is_error, sse = McpMock.text, McpMock.status, McpMock.is_error, McpMock.sse
        if body.get("method") == "tools/call":
            time.sleep(McpMock.delay)
        if "id" not in body:
            self.send_response(202)
            self.end_headers()
            return
        m = body["method"]
        if m == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": {"name": "mock"}}
        elif m == "tools/list":
            result = {"tools": McpMock.TOOLS}
        else:
            p = body["params"]
            t = text(p["name"], p["arguments"]) if callable(text) else text
            result = {"content": [{"type": "text", "text": t}], "isError": is_error}
        msg = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result})
        out = ("event: message\ndata: %s\n\n" % msg if sse else msg).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream" if sse else "application/json")
            self.send_header("Mcp-Session-Id", "mock-session")
            self.end_headers()
            self.wfile.write(out)
        except OSError:
            pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path.startswith("/mcp"):
            return self.do_mcp(body)
        Mock.bodies.append({"body": body, "auth": self.headers.get("Authorization")})
        # Snapshot the scripted reply on ARRIVAL: the timeout case sleeps past the
        # client's deadline, and by the time it wakes a later case has re-scripted Mock.
        reply, raw = Mock.reply, Mock.raw
        time.sleep(Mock.delay)
        if raw is not None:
            out = raw
        else:
            answers = reply(body) if callable(reply) else reply
            out = json.dumps({"id": "gen-dec-test", "model": "typesafe/jev-1.13-test", "answers": answers,
                              "usage": {"input_tokens": 1, "output_tokens": 1, "cost": 0.0000001}}).encode()
        try:
            self.send_response(Mock.status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(out)
        except OSError:
            pass  # client gave up (timeout case)


SERVER = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=SERVER.serve_forever, daemon=True).start()
TMP = tempfile.mkdtemp(prefix="jev-gate-test-")


def reset(reply=None, status=200, raw=None, delay=0.0):
    Mock.reply, Mock.status, Mock.raw, Mock.delay, Mock.bodies = reply, status, raw, delay, []


def nouls(**scores):
    return lambda body: {k: {"type": "noul", "noul": scores.get(k, scores.get("all"))} for k in body["questions"]}


def choice(name, p, others=None):
    def f(body):
        crit = body["questions"]["tool"]["criteria"]
        probs = {k: 0.0 for k in crit}
        probs.update(others or {})
        probs[name] = p
        return {"tool": {"type": "choice", "choice": name, "confidence": p, "probabilities": probs}}
    return f


MCP_URL = "http://127.0.0.1:%d/mcp" % SERVER.server_address[1]
REPO = os.path.join(TMP, "repos", "cloud-u-containers")   # a git repo by .git, like a slot worktree
PLAIN = os.path.join(TMP, "plain")                       # not inside any repo
for d in [os.path.join(REPO, ".git"), os.path.join(REPO, "src"), PLAIN]:
    os.makedirs(d, exist_ok=True)
open(os.path.join(REPO, "src", "a.py"), "w").write("x = 1\n")
CLIENT_CFG = {
    "claude": os.path.join(TMP, "claude.json"),
    "goose": os.path.join(TMP, "goose.yaml"),
    "hermes": os.path.join(TMP, "hermes.yaml"),
}
json.dump({"mcpServers": {"cloud-infra-mcp": {"type": "http", "url": "http://127.0.0.1:1/x"},
                          "cloud-cgc-pvt-mcp": {"type": "http", "url": MCP_URL}}}, open(CLIENT_CFG["claude"], "w"))
# goose: pvt disabled, pub behind a bearer named by env var (the bearer-gate case)
open(CLIENT_CFG["goose"], "w").write("""GOOSE_PROVIDER: openai
extensions:
  # generated block
  cloud-cgc-pvt-mcp:
    name: cloud-cgc-pvt-mcp
    type: streamable_http
    uri: http://127.0.0.1:1/mcp
    enabled: false
  cloud-cgc-pub-mcp:
    name: cloud-cgc-pub-mcp
    type: streamable_http
    uri: %s
    enabled: true
    headers:
      Authorization: "Bearer ${JEV_TEST_CGC_TOKEN}"
  developer:
    enabled: true
""" % MCP_URL)
open(CLIENT_CFG["hermes"], "w").write("""plugins:
  enabled: [jev-gate]
mcp_servers:
  cloud-cgc-pvt-mcp:
    type: http
    url: %s
""" % MCP_URL)


def test_config(mod):
    cfg = mod.load_config(os.path.join(GATE_DIR, "jev-gate.json"))
    cfg = copy.deepcopy(cfg)
    cfg["endpoint"] = "http://127.0.0.1:%d/api/alpha/decisions" % SERVER.server_address[1]
    cfg["timeout_s"] = 0.5
    g = cfg["code_graph"]
    for cli, path in CLIENT_CFG.items():
        g["client_configs"][cli]["path"] = path
    g["cache_dir"] = os.path.join(TMP, "cache-%d" % time.monotonic_ns())
    cfg["budget"]["ledger_path"] = os.path.join(TMP, "budget-%d.json" % time.monotonic_ns())
    g["route"]["budget_s"] = 1.5
    g["impact"]["budget_s"] = 0.6
    return cfg


def route(name, p, repo=None, rp=0.9, safe=None):
    """Decisions reply for whichever of route / repo / safety questions were asked."""
    def f(body):
        q, out = body["questions"], {}
        for qn, pick, pp in [("route", name, p), ("repo", repo, rp)]:
            if qn in q:
                probs = {k: 0.0 for k in q[qn]["criteria"]}
                probs[pick] = pp
                out[qn] = {"type": "choice", "choice": pick, "probabilities": probs}
        for k in q:
            if q[k].get("type") == "noul":
                out[k] = {"type": "noul", "noul": safe}
        return out
    return f


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the behaviour suite (run against the real module AND every mutant) ─────────

def suite(mod):
    """Returns a list of failure strings. Empty = every behaviour holds."""
    fails = []
    cfg = test_config(mod)
    os.environ["OPENROUTER_API_KEY"] = FAKE_KEY
    os.environ["JEV_GATE_LOG"] = log_path = os.path.join(TMP, "decisions-%d.jsonl" % time.monotonic_ns())

    def check(cond, msg):
        if not cond:
            fails.append(msg)

    def claude(cmd=None, event="PermissionRequest", tool="Bash", ti=None, **kw):
        ev = {"hook_event_name": event, "tool_name": tool, "cwd": "/home/appuser/git/proj",
              "tool_input": ti if ti is not None else {"command": cmd}}
        ev.update(kw)
        return mod.claude_hook(ev, cfg)

    allow_pr = {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}

    # confident safe -> allow (both Claude events), request shape per the Decisions API
    reset(nouls(all=0.95))
    check(claude("ls src") == allow_pr, "safe Bash on PermissionRequest must allow")
    b = Mock.bodies[0]["body"] if Mock.bodies else {}
    check(b.get("model") == "typesafe/jev-1.13", "model must be typesafe/jev-1.13")
    check(isinstance(b.get("questions"), dict) and set(b["questions"]) == {"reversible"},
          "questions must be a MAP; no task -> only reversible is asked")
    check(all(q.get("type") == "noul" and "needs" not in q for q in b.get("questions", {}).values()),
          "questions are typed noul and carry no gate-internal keys")
    check(set(b.get("state", {})) == {"tool", "input", "project"}, "state must be minimal: tool/input/project")
    check(Mock.bodies and Mock.bodies[0]["auth"] == "Bearer " + FAKE_KEY, "bearer key from OPENROUTER_API_KEY")
    reset(nouls(all=0.95))
    out = claude("ls src", event="PreToolUse")
    check(out and out["hookSpecificOutput"].get("permissionDecision") == "allow", "PreToolUse shape must allow")
    reset(nouls(all=0.95))
    claude(ti={"command": "pytest -q", "description": "run the tests"})
    check(Mock.bodies and set(Mock.bodies[0]["body"]["questions"]) == {"reversible", "serves_task"}
          and Mock.bodies[0]["body"]["state"].get("task") == "run the tests", "a description is asked as the task")

    # threshold boundary (0.85 inclusive) and below
    reset(nouls(all=0.85))
    check(claude("ls") == allow_pr, "score == threshold must allow")
    reset(nouls(all=0.849))
    check(claude("ls") is None, "score just below threshold must defer")
    reset(lambda body: {"reversible": {"noul": 0.99}, "serves_task": {"noul": 0.40}})
    check(claude(ti={"command": "make", "description": "x"}) is None, "every asked question must clear")

    # never deny: confidently unsafe -> no output for claude
    reset(nouls(all=0.01))
    check(claude("ls") is None, "claude must never be told deny (unsafe -> defer)")

    # static never-auto-approve list: no Decisions call at all
    for cmd in ["git push origin main", "cd x && git push", "FOO=1 git push", "rm -rf build", "sudo ls",
                "echo $(cat x)", "bash -c 'ls'", "cat .env", "curl https://x", "python3 -c 'print(1)'",
                "/usr/bin/git reset --hard", "ls; sops -d secrets.yaml", "env rm -rf /"]:
        reset(nouls(all=0.99))
        check(claude(cmd) is None and not Mock.bodies, "risky command reached Jev or was allowed: " + cmd)
    for path in ["/p/.github/workflows/ci.yml", "/home/appuser/git/cloud-vault/A/x.md", "/p/src/secrets.yaml"]:
        reset(nouls(all=0.99))
        check(claude(tool="Write", ti={"file_path": path, "content": "x"}) is None and not Mock.bodies,
              "risky path reached Jev: " + path)
    reset(nouls(all=0.99))
    check(claude(tool="Edit", ti={"file_path": "/p/src/a.py", "old_string": "a", "new_string": "b"}) == allow_pr,
          "a plain in-project Edit is asked and allowed")

    # failure modes: all of them behave as if the gate did not exist
    for label, kw in [("http 500", dict(status=500, reply=nouls(all=0.99))),
                      ("malformed body", dict(raw=b"not json")),
                      ("prob out of range", dict(reply=nouls(all=1.5))),
                      ("prob is bool", dict(reply=nouls(all=True))),
                      ("missing answer", dict(reply={})),
                      ("answers not object", dict(raw=b'{"answers": [1]}')),
                      ("timeout", dict(reply=nouls(all=0.99), delay=1.2))]:
        reset(**kw)
        check(claude("ls") is None, "failure mode must defer: " + label)
    del os.environ["OPENROUTER_API_KEY"]
    reset(nouls(all=0.99))
    check(claude("ls") is None and not Mock.bodies, "no key -> no call, defer")
    os.environ["OPENROUTER_API_KEY"] = FAKE_KEY

    # oversized state is never sent truncated
    reset(nouls(all=0.99))
    check(claude(tool="Write", ti={"file_path": "/p/a.txt", "content": "x" * 20000}) is None and not Mock.bodies,
          "oversized state must defer without a call")

    # redaction: patterns + exact values of secret-named env vars
    os.environ["SOME_SERVICE_TOKEN"] = live = "liveValue-1234567890"
    reset(nouls(all=0.95))
    claude("echo ghp_" + "a" * 36 + " sk-or-v1-" + "b" * 40 + " API_KEY=hunter2hunter2 " + live)
    sent = json.dumps(Mock.bodies[0]["body"]) if Mock.bodies else ""
    for s in ["ghp_" + "a" * 36, "b" * 40, "hunter2hunter2", live, FAKE_KEY]:
        check(sent and s not in sent, "secret reached Jev state: " + s[:12])
    del os.environ["SOME_SERVICE_TOKEN"]

    # log: probabilities yes, state text never
    with open(log_path) as f:
        lines = [json.loads(l) for l in f]
    check(any(l.get("scores") and l.get("verdict") == "allow" for l in lines), "decisions logged with scores")
    logged = json.dumps(lines)
    check("hunter2" not in logged and "ls src" not in logged and FAKE_KEY not in logged, "log must not carry state")

    # goose: log mode passes everything; block mode blocks only confident-unsafe
    def goose(cmd, mode):
        cfg["uses"]["goose_pretool"]["on_unsafe"] = mode
        return mod.goose_hook({"event": "PreToolUse", "tool_name": "shell", "tool_input": {"command": cmd},
                               "working_dir": "/p"}, cfg)
    reset(nouls(all=0.02))
    check(goose("make deploy-ish", "log") is None, "goose on_unsafe=log must pass")
    reset(nouls(all=0.02))
    out = goose("make deploy-ish", "block")
    check(out and out.get("decision") == "block" and "reversible=0.02" in out.get("reason", ""),
          "goose on_unsafe=block must block confident-unsafe with a reason")
    reset(nouls(all=0.5))
    check(goose("make", "block") is None, "goose must pass when Jev is unsure")
    reset(nouls(all=0.99))
    check(goose("make", "block") is None, "goose must pass safe calls")
    reset(status=500)
    check(goose("make", "block") is None, "goose must pass on error")
    cfg["uses"]["goose_pretool"]["on_unsafe"] = "log"

    # hermes tool selection
    tools = [{"type": "function", "function": {"name": n, "description": "does " + n, "parameters": {}}}
             for n in ["terminal", "read_file", "web_search"]]
    req = {"model": "m", "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "read README"}],
           "tools": tools}
    reset(choice("read_file", 0.9))
    out = mod.select_tools(req, cfg, api_call_count=1)
    check(out and [t["function"]["name"] for t in out["tools"]] == ["read_file"], "confident pick -> that tool only")
    crit = Mock.bodies[0]["body"]["questions"]["tool"] if Mock.bodies else {}
    check(crit.get("type") == "choice" and set(crit.get("criteria", {})) == {"terminal", "read_file", "web_search", "none"},
          "choice over the tool names + none")
    check(Mock.bodies and Mock.bodies[0]["body"]["state"] == {"request": "read README"}, "hermes state = last user msg only")
    reset(choice("read_file", 0.6))
    check(mod.select_tools(req, cfg, api_call_count=1) is None, "low confidence -> all tools")
    reset(choice("read_file", 0.9))
    check(mod.select_tools(req, cfg, api_call_count=2) is None and not Mock.bodies, "only the first call of a turn")
    reset(choice("read_file", 0.9))
    check(mod.select_tools(req, cfg, api_call_count=1, api_mode="anthropic_messages") is None and not Mock.bodies,
          "unlisted api_mode untouched")
    reset(choice("none", 0.9))
    out = mod.select_tools(req, cfg, api_call_count=1)
    check(out is not None and "tools" not in out, "confident none -> no tools")
    traffic = dict(req, messages=req["messages"][:1] + [{"role": "assistant", "tool_calls": [{"id": "1"}]},
                                                       {"role": "tool", "content": "x"}] + req["messages"][1:])
    reset(choice("none", 0.9))
    check(mod.select_tools(traffic, cfg, api_call_count=1) is None, "none with tool history -> keep tools")
    reset(choice("bogus_tool", 0.99))
    check(mod.select_tools(req, cfg, api_call_count=1) is None, "a choice outside the offered set is an error")
    reset(status=500)
    check(mod.select_tools(req, cfg, api_call_count=1) is None, "error -> all tools (on_error=all_tools)")
    cfg["uses"]["hermes_tool_select"]["on_error"] = "no_tools"
    reset(status=500)
    out = mod.select_tools(req, cfg, api_call_count=1)
    check(out is not None and "tools" not in out, "on_error=no_tools is the fail-closed option")
    reset(choice("bogus_tool", 0.99))
    out = mod.select_tools(req, cfg, api_call_count=1)
    check(out is not None and "tools" not in out, "an out-of-set choice is an error under no_tools too")
    cfg["uses"]["hermes_tool_select"]["on_error"] = "all_tools"
    big = dict(req, tools=tools * 200)
    reset(choice("read_file", 0.9))
    check(mod.select_tools(big, cfg, api_call_count=1) is None and not Mock.bodies, "over max_options untouched")
    cfg["uses"]["hermes_tool_select"]["enabled"] = False
    reset(choice("read_file", 0.9))
    check(mod.select_tools(req, cfg, api_call_count=1) is None and not Mock.bodies, "disabled use makes no call")
    code_graph_suite(mod, check)
    decide_suite(mod, check)
    return fails


def code_graph_suite(mod, check):
    """#765: Jev-routed code-graph context and impact-aware safety, against the mock MCP server."""
    cfg = test_config(mod)
    os.environ.pop("JEV_TEST_CGC_TOKEN", None)
    ctx = lambda prompt, cli="claude", sid="s1", cwd=REPO: mod.route_context(cli, prompt, sid, cwd, cfg)
    tools_called = lambda: [c["params"] for c in McpMock.calls if c["method"] == "tools/call"]
    grag = "Loading 1384 GraphRAG nodes from database...\nSearching for: q\nFILE: src/a.py\n  wires the gate"

    # confident graphrag from inside a repo: the repo is the cwd's, no repo question, tool + args right
    reset(route("graphrag", 0.9))
    mcp_reset(text=grag)
    out = ctx("how is the jev gate wired into goose?")
    check(out and "FILE: src/a.py" in out and out.startswith("<code-graph-context"), "graphrag pick injects the result")
    check(out and "Loading 1384" not in out and "Searching for:" not in out, "octocode progress lines dropped")
    tc = tools_called()
    check(tc == [{"name": "cgc.octocode.graphrag", "arguments": {"operation": "search", "format": "text",
                  "query": "how is the jev gate wired into goose?", "repo": "cloud-u-containers"}}],
          "graphrag runs cgc.octocode.graphrag on the cwd's repo with the prompt: %r" % tc)
    check([c["method"] for c in McpMock.calls][:2] == ["initialize", "notifications/initialized"]
          and McpMock.calls[-1]["sid"] == "mock-session", "MCP handshake first, then the session id is carried")
    b = Mock.bodies[0]["body"] if Mock.bodies else {}
    check(len(Mock.bodies) == 1 and set(b.get("questions", {})) == {"route"}
          and set(b["questions"]["route"]["criteria"]) == {"graphrag", "semantic_search", "none"}
          and b.get("state") == {"request": "how is the jev gate wired into goose?"},
          "one Jev choice over graphrag/semantic_search/none with the prompt as state")

    # session cache: the same prompt in the same session asks nobody; another session asks again
    reset(route("graphrag", 0.9))
    mcp_reset(text=grag)
    check(ctx("how is the jev gate wired into goose?") == out and not Mock.bodies and not McpMock.calls,
          "same prompt + session is served from the cache")
    reset(route("graphrag", 0.9))
    ctx("how is the jev gate wired into goose?", sid="s2")
    check(len(Mock.bodies) == 1, "a different session is not served another session's cache")

    # semantic_search uses its own tool
    reset(route("semantic_search", 0.8))
    mcp_reset(text="1. src/a.py | x = 1")
    out = ctx("where is the jev threshold declared?")
    check(out and [t["name"] for t in tools_called()] == ["cgc.octocode.search"], "semantic_search -> octocode search")

    # none / low confidence / error: nothing fetched at all
    for label, reply in [("none", route("none", 0.99)), ("low confidence", route("graphrag", 0.6)),
                         ("out-of-set", route("bogus", 0.99)), ("prob out of range", route("graphrag", 1.7))]:
        reset(reply)
        mcp_reset()
        check(ctx("q " + label) is None and not McpMock.calls, label + " -> no MCP traffic, nothing injected")
    reset(route("graphrag", 0.99))
    check(ctx("q none") is None and not Mock.bodies, "a decided none is cached: the same prompt asks Jev once")
    reset(status=500)
    mcp_reset()
    check(ctx("q 500") is None and not McpMock.calls, "Jev error -> nothing fetched")
    reset(route("graphrag", 0.9))
    check(ctx("q 500") is not None, "a failure is never cached")

    # cwd outside any repo: Jev picks the repo from the server's own enum
    reset(route("graphrag", 0.9, repo="cloud-infra", rp=0.9))
    mcp_reset(text="x")
    out = ctx("how does the ship pipeline deploy?", cwd=PLAIN)
    rq = [m["body"]["questions"].get("repo") for m in Mock.bodies if "repo" in m["body"]["questions"]]
    check(rq and set(rq[0]["criteria"]) == {"cloud-u-containers", "cloud-infra"}, "repo question offers the tool's enum")
    check(out and tools_called() and tools_called()[0]["arguments"]["repo"] == "cloud-infra", "Jev's repo is queried")
    reset(route("graphrag", 0.9, repo="cloud-infra", rp=0.4))
    mcp_reset(text="x")
    check(ctx("unsure repo", cwd=PLAIN) is None and not tools_called(), "unsure repo -> nothing fetched")

    # MCP failures: HTTP error, tool error, slow server past the budget, plain-JSON transport still works
    for label, kw in [("http 500", dict(status=500)), ("tool isError", dict(is_error=True)),
                      ("over budget", dict(delay=2.5))]:
        reset(route("graphrag", 0.9))
        mcp_reset(**kw)
        t0 = time.monotonic()
        check(ctx("q mcp " + label) is None, "MCP %s -> nothing injected" % label)
        check(time.monotonic() - t0 < 2.4, "MCP %s must not outlive the budget" % label)
    reset(route("graphrag", 0.9))
    mcp_reset(text="json transport", sse=False)
    check("json transport" in (ctx("q json") or ""), "application/json MCP replies are accepted too")

    # size cap and redaction of what is injected and of what is sent
    reset(route("graphrag", 0.9))
    mcp_reset(text="y" * 50000)
    out = ctx("q big")
    check(out and len(out) <= cfg["code_graph"]["route"]["max_inject_chars"], "injected context is capped")
    os.environ["SOME_SERVICE_TOKEN"] = live = "liveValue-1234567890"
    reset(route("graphrag", 0.9))
    mcp_reset(text="token ghp_" + "c" * 36 + " and " + live)
    out = ctx("q secrets " + live + " sk-or-v1-" + "d" * 40) or ""
    sent = json.dumps([m["body"] for m in Mock.bodies]) + json.dumps(McpMock.calls)
    check(out and "c" * 36 not in out and live not in out, "injected context is redacted")
    check(live not in sent and "d" * 40 not in sent, "the prompt is redacted before Jev and the MCP query")
    del os.environ["SOME_SERVICE_TOKEN"]

    # the CLI's own MCP config decides the server: goose's pvt is disabled and pub needs a bearer
    reset(route("graphrag", 0.9))
    mcp_reset(text="via goose")
    check(ctx("q goose bearer", cli="goose") is None and not McpMock.calls,
          "a header naming an unset ${VAR} skips the server (no literal placeholder sent)")
    os.environ["JEV_TEST_CGC_TOKEN"] = tok = "cgc-bearer-" + "e" * 20
    reset(route("graphrag", 0.9))
    out = ctx("q goose bearer 2", cli="goose")
    check(out and McpMock.calls and all(c["auth"] == "Bearer " + tok for c in McpMock.calls),
          "the configured bearer header is sent on every MCP request")
    os.environ.pop("JEV_TEST_CGC_TOKEN")
    reset(route("graphrag", 0.9))
    mcp_reset(text="via hermes")
    check("via hermes" in (ctx("q hermes", cli="hermes") or ""), "hermes config.yaml mcp_servers resolves")
    reset(route("graphrag", 0.9))
    check(ctx("q nocli", cli="unknown") is None, "a CLI without a client config fetches nothing")
    cfg["uses"]["code_context"]["enabled"] = False
    reset(route("graphrag", 0.9))
    check(ctx("q disabled") is None and not Mock.bodies, "disabled code_context makes no call")
    cfg["uses"]["code_context"]["enabled"] = True

    # claude UserPromptSubmit shape; goose writes (and clears) its tom file
    reset(route("graphrag", 0.9))
    mcp_reset(text="for claude")
    out = mod.claude_hook({"hook_event_name": "UserPromptSubmit", "prompt": "q claude", "session_id": "c1",
                           "cwd": REPO}, cfg)
    check(out and out["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
          and "for claude" in out["hookSpecificOutput"]["additionalContext"], "claude gets additionalContext")
    reset(route("none", 0.99))
    check(mod.claude_hook({"hook_event_name": "UserPromptSubmit", "prompt": "hi", "session_id": "c1", "cwd": REPO},
                          cfg) is None, "claude none -> no output")
    moim = os.path.join(TMP, "moim-%d" % time.monotonic_ns(), "ctx.md")
    os.environ["GOOSE_MOIM_MESSAGE_FILE"] = moim
    os.environ["JEV_TEST_CGC_TOKEN"] = tok
    reset(route("graphrag", 0.9))
    mcp_reset(text="for goose")
    mod.goose_prompt_hook({"event": "UserPromptSubmit", "session_id": "g1", "message": "q goose file",
                           "working_dir": REPO}, cfg)
    check(os.path.exists(moim) and "for goose" in open(moim).read(), "goose context lands in the tom file")
    reset(route("none", 0.99))
    mod.goose_prompt_hook({"event": "UserPromptSubmit", "session_id": "g1", "message": "thanks"}, cfg)
    check(os.path.exists(moim) and open(moim).read() == "", "a later none clears the previous context")
    reset(status=500)
    open(moim, "w").write("stale")
    mod.goose_prompt_hook({"event": "UserPromptSubmit", "session_id": "g1", "message": "q err"}, cfg)
    check(open(moim).read() == "", "a failure clears the previous context too")
    del os.environ["GOOSE_MOIM_MESSAGE_FILE"], os.environ["JEV_TEST_CGC_TOKEN"]

    # impact-aware safety: the touched file's dependents become state.impact
    target = os.path.join(REPO, "src", "a.py")
    edit = {"file_path": target, "old_string": "1", "new_string": "2"}
    perm = lambda ti, tool="Edit", sid="i1": mod.claude_hook({"hook_event_name": "PermissionRequest", "tool_name": tool,
                                                              "tool_input": ti, "cwd": REPO, "session_id": sid}, cfg)
    reset(route(None, 0, safe=0.95))
    mcp_reset(text="Impact of changing file:cloud-u-containers/src/a.py: 1 dependents\n  server.mjs")
    out = perm(edit)
    st = Mock.bodies[0]["body"]["state"] if Mock.bodies else {}
    check(out and "server.mjs" in st.get("impact", ""), "Edit: impact snippet is in the safety state")
    check(tools_called() == [{"name": "cgc.codegraph.impact_analysis",
                              "arguments": {"depth": 2, "target": "file:cloud-u-containers/src/a.py"}}],
          "impact queried by the file's node key: %r" % tools_called())
    reset(route(None, 0, safe=0.95))
    mcp_reset(text="never used")
    perm(edit)
    check(not McpMock.calls and "server.mjs" in Mock.bodies[0]["body"]["state"].get("impact", ""),
          "impact is cached per session")
    reset(route(None, 0, safe=0.95))
    mcp_reset(text="Impact of changing src/a.py: 3 dependents")
    perm({"command": "sed -i s/1/2/ src/a.py"}, tool="Bash", sid="i2")
    check(Mock.bodies and "3 dependents" in Mock.bodies[0]["body"]["state"].get("impact", ""),
          "a shell command naming an existing repo file gets impact")
    reset(route(None, 0, safe=0.95))
    mcp_reset(text='No node matches "x".')
    perm(edit, sid="i3")
    check(Mock.bodies and "impact" not in Mock.bodies[0]["body"]["state"], "no node match -> no impact key")
    reset(route(None, 0, safe=0.95))
    mcp_reset()
    perm({"command": "ls -la"}, tool="Bash", sid="i4")
    check(not McpMock.calls, "a command touching no repo file makes no MCP call")
    for label, kw in [("http 500", dict(status=500)), ("over budget", dict(delay=1.0)), ("tool error", dict(is_error=True))]:
        reset(route(None, 0, safe=0.95))
        mcp_reset(**kw)
        out = perm(edit, sid="f-" + label)
        check(out and out["hookSpecificOutput"]["decision"] == {"behavior": "allow"}
              and "impact" not in Mock.bodies[0]["body"]["state"],
              "impact %s -> verdict exactly as without it" % label)
    reset(route(None, 0, safe=0.95))
    mcp_reset(text="z" * 9000)
    perm(edit, sid="i5")
    imp = Mock.bodies[0]["body"]["state"].get("impact", "") if Mock.bodies else ""
    check(0 < len(imp) <= cfg["code_graph"]["impact"]["max_chars"], "impact snippet is capped")
    cfg["code_graph"]["impact"]["enabled"] = False
    reset(route(None, 0, safe=0.95))
    mcp_reset(text="x")
    perm(edit, sid="i6")
    check(not McpMock.calls, "impact disabled -> no MCP call")


# ── #881: the generic `decide` entry, the budget and the sidecar ──────────────

def generic_config(mod):
    """test_config plus four declared generic uses (one per class, one rate-limited)."""
    cfg = test_config(mod)
    cfg["uses"].update({
        "t_ui": {"enabled": True, "class": "user_facing", "threshold": 0.8, "allowed": ["a", "b"]},
        "t_bg": {"enabled": True, "class": "background", "threshold": 0.8, "ttl_s": 60},
        "t_gate": {"enabled": True, "class": "gating", "threshold": 0.8},
        "t_rate": {"enabled": True, "class": "user_facing", "threshold": 0.8, "max_calls_per_hour": 2},
        "t_off": {"enabled": False, "class": "user_facing", "threshold": 0.8},
        "t_nottl": {"enabled": True, "class": "background", "threshold": 0.8},
    })
    return cfg


def noul_q(**kw):
    return {"ok": dict({"type": "noul", "instructions": "The statement is true."}, **kw)}


def choice_q(*options):
    return {"pick": {"type": "choice", "instructions": "Which one?", "criteria": {o: o + " option" for o in options}}}


def choice_reply(pick, p, extra=None):
    def f(body):
        out = {}
        for qid, q in body["questions"].items():
            probs = {k: round((1 - p) / max(len(q["criteria"]) - 1, 1), 4) for k in q["criteria"]}
            probs[pick] = p
            probs.update(extra or {})
            out[qid] = {"type": "choice", "choice": pick, "probabilities": probs}
        return out
    return f


def decide_suite(mod, check):
    cfg = generic_config(mod)
    os.environ["OPENROUTER_API_KEY"] = FAKE_KEY
    mod._MEM_LEDGER.update(day="", spent=0.0, calls={})
    run = lambda use, state, questions: mod.run_use(use, {"state": state, "questions": questions}, cfg)

    # a noul answered: ok, typed, thresholded; the state the API sees is redacted, never the caller's raw text
    reset(nouls(ok=0.95))
    r = run("t_ui", {"note": "key " + FAKE_KEY, "n": 3}, noul_q())
    check(r.get("ok") and r["class"] == "user_facing" and r["results"]["ok"]["p"] == 0.95
          and r["results"]["ok"]["confident"] and r["results"]["ok"]["value"] and not r["cached"], "a noul is answered")
    sent = Mock.bodies[0]["body"] if Mock.bodies else {}
    check(Mock.bodies and FAKE_KEY not in json.dumps(sent) and "[REDACTED]" in json.dumps(sent["state"])
          and sent["state"]["n"] == 3 and sent["model"] == "typesafe/jev-1.13", "decide redacts every string of the state")
    reset(nouls(ok=0.5))
    r = run("t_ui", {"a": 1}, noul_q())
    check(r["ok"] and not r["results"]["ok"]["confident"], "P near 0.5 is not confident")
    reset(nouls(ok=0.1))
    r = run("t_ui", {"a": 2}, noul_q())
    check(r["ok"] and r["results"]["ok"]["confident"] and not r["results"]["ok"]["value"], "a confident NO is confident")

    # choices: pick must be one of the caller's options; `allowed` bounds the options a use may offer
    reset(choice_reply("a", 0.9))
    r = run("t_ui", {"q": 1}, choice_q("a", "b"))
    check(r["ok"] and r["results"]["pick"]["pick"] == "a" and r["results"]["pick"]["confident"], "a choice is answered")
    reset(choice_reply("c", 0.9))
    r = run("t_ui", {"q": 2}, choice_q("a", "c"))
    check(not r["ok"] and r["reason"] == "option_not_allowed" and not Mock.bodies, "an option outside `allowed` is refused before any call")
    reset(choice_reply("zzz", 0.9, {"zzz": 0.9}))
    r = run("t_ui", {"q": 3}, choice_q("a", "b"))
    check(not r["ok"] and r["reason"] == "malformed", "a pick outside the caller's options is malformed")
    reset(choice_reply("a", 0.9))
    r = run("t_ui", {"q": 4}, choice_q("a"))
    check(not r["ok"] and r["reason"] == "bad_questions", "a one-option choice is not a question")
    reset(choice_reply("a", 0.5))
    r = run("t_ui", {"q": 6}, choice_q("a", "b"))
    check(r["ok"] and not r["results"]["pick"]["confident"], "a choice below the threshold is not confident")
    reset(lambda body: {"pick": {"type": "choice", "choice": "a", "probabilities": {"a": 1.4, "b": 0.0}}})
    check(run("t_ui", {"q": 7}, choice_q("a", "b"))["reason"] == "malformed", "a choice probability above 1 is malformed")
    # scores read the best level
    reset(lambda body: {"s": {"type": "score", "probabilities": {"low": 0.1, "high": 0.85}, "legend": {"low": "l", "high": "h"}}})
    r = run("t_ui", {"q": 5}, {"s": {"type": "score", "instructions": "How urgent?", "criteria": {"low": "l", "high": "h"}}})
    check(r["ok"] and r["results"]["s"]["level"] == "high" and r["results"]["s"]["confident"], "a score reads its best level")

    # what is never served
    for use, why in [("nope", "unknown_use"), ("claude_permission", "not_generic"), ("t_off", "disabled"), ("t_nottl", "misconfigured")]:
        reset(nouls(ok=0.95))
        r = run(use, {"x": 1}, noul_q())
        check(not r["ok"] and r["reason"] == why and not Mock.bodies, "%s is answered %s without a call" % (use, why))
    reset(nouls(ok=0.95))
    big = run("t_ui", {"blob": "x" * (cfg["max_state_chars"] + 1)}, noul_q())
    check(not big["ok"] and big["reason"] == "state_too_large" and not Mock.bodies, "an oversized state is not sent, not truncated")
    for bad in ({}, {"state": 1}, {"state": 1, "questions": {}}, {"state": 1, "questions": {"q": {"type": "nope", "instructions": "i"}}}):
        r = mod.run_use("t_ui", bad, cfg)
        check(not r["ok"] and r["reason"] in ("bad_request", "bad_questions") and not Mock.bodies, "malformed request %r" % (bad,))

    # failures are "no opinion" with the reason
    reset(nouls(ok=1.5))
    r = run("t_ui", {"m": 1}, noul_q())
    check(not r["ok"] and r["reason"] == "malformed", "a probability above 1 is malformed")
    reset(lambda body: {"ok": {"type": "noul", "noul": True}})
    check(run("t_ui", {"m": 2}, noul_q())["reason"] == "malformed", "a boolean is not a probability")
    reset(status=500, raw=b"{}")
    check(not run("t_ui", {"m": 3}, noul_q())["ok"], "an HTTP error is no opinion")
    os.environ.pop("OPENROUTER_API_KEY")
    reset(nouls(ok=0.95))
    r = run("t_ui", {"m": 4}, noul_q())
    check(not r["ok"] and r["reason"] == "no_key" and not Mock.bodies, "no key is no opinion, no call")
    os.environ["OPENROUTER_API_KEY"] = FAKE_KEY

    # class semantics: background caches and never re-asks; gating is advice only
    reset(nouls(ok=0.95))
    first = run("t_bg", {"k": "v"}, noul_q())
    second = run("t_bg", {"k": "v"}, noul_q())
    check(first["ok"] and not first["cached"] and second["ok"] and second["cached"] and len(Mock.bodies) == 1,
          "a background use asks once and serves the answer from its cache")
    run("t_bg", {"k": "other"}, noul_q())
    check(len(Mock.bodies) == 2, "the cache key is the state: another state asks again")
    reset(nouls(ok=0.95))
    g = run("t_gate", {"k": "v"}, noul_q())
    check(g["ok"] and g["advice_only"] is True and "advice_only" not in run("t_ui", {"k": "w"}, noul_q()), "only a gating use answers advice_only")

    # budget: per-use hourly limit, host daily cap, day roll-over, an unusable ledger
    reset(nouls(ok=0.95))
    outs = [run("t_rate", {"i": i}, noul_q()) for i in range(3)]
    check([o["ok"] for o in outs] == [True, True, False] and outs[2]["reason"] == "rate_limited" and len(Mock.bodies) == 2,
          "max_calls_per_hour stops the third call of an hour")
    check(mod.budget_admit(cfg, "t_rate", now=time.time() + 3700) is None, "the hour window slides")
    cfg["budget"]["daily_cost_cap"] = 1e-7
    cfg["budget"]["ledger_path"] = os.path.join(TMP, "cap-%d.json" % time.monotonic_ns())
    reset(nouls(ok=0.95))
    a, b = run("t_ui", {"c": 1}, noul_q()), run("t_ui", {"c": 2}, noul_q())
    check(a["ok"] and not b["ok"] and b["reason"] == "over_budget" and len(Mock.bodies) == 1,
          "a spent daily_cost_cap stops the next call like no_key")
    check(mod.budget_admit(cfg, None, now=time.time() + 90000) is None, "the cap resets with the UTC day")
    mod._MEM_LEDGER.update(day="", spent=0.0, calls={})
    cfg["budget"]["ledger_path"] = os.path.join(TMP, "a-file-not-a-dir", "x", "budget.json")
    open(os.path.join(TMP, "a-file-not-a-dir"), "w").write("x")
    reset(nouls(ok=0.95))
    a, b = run("t_ui", {"c": 3}, noul_q()), run("t_ui", {"c": 4}, noul_q())
    check(a["ok"] and not b["ok"] and b["reason"] == "over_budget", "an unusable ledger file still enforces the cap in memory")
    cfg["budget"]["daily_cost_cap"] = 0
    cfg["budget"]["ledger_path"] = os.path.join(TMP, "none-%d.json" % time.monotonic_ns())
    reset(nouls(ok=0.95))
    check(all(run("t_ui", {"c": 10 + i}, noul_q())["ok"] for i in range(4)), "no cap and no hourly limit: never refused")
    # the existing hook uses are charged to the same ledger
    cfg["budget"]["daily_cost_cap"] = 1e-7
    reset(nouls(all=0.95))
    cfg["uses"]["claude_permission"]["max_calls_per_hour"] = 600
    first = mod.claude_hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/p"}, cfg)
    second = mod.claude_hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls -a"}, "cwd": "/p"}, cfg)
    check(first is not None and second is None, "the permission hook shares the daily cap and defers once it is spent")
    cfg["budget"]["daily_cost_cap"] = 0
    cfg["budget"]["ledger_path"] = os.path.join(TMP, "hook-%d.json" % time.monotonic_ns())
    cfg["uses"]["claude_permission"]["max_calls_per_hour"] = 1
    reset(nouls(all=0.95))
    first = mod.claude_hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls"}, "cwd": "/p"}, cfg)
    second = mod.claude_hook({"hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "ls -a"}, "cwd": "/p"}, cfg)
    check(first is not None and second is None and len(Mock.bodies) == 1, "a hook use's max_calls_per_hour defers the call past it")

    # decide_cli: the shell contract
    cli = lambda argv, stdin: mod.decide_cli(argv, stdin, cfg)
    reset(nouls(ok=0.95))
    check(cli(["--use", "t_ui"], json.dumps({"state": {"z": 1}, "questions": noul_q()}))["ok"], "decide --use answers a stdin request")
    check(cli([], "{}")["reason"].startswith("usage"), "decide without --use explains its usage")
    check(cli(["--use", "t_ui"], "not json")["reason"] == "bad_request", "decide on bad JSON is no opinion")

    # #884 evidence gate: a gated use is observe-only until the journal shows precision, then opens by itself
    jl = os.path.join(TMP, "gate-%d.jsonl" % time.monotonic_ns())
    os.environ["JEV_GATE_LOG"] = jl
    try:
        cfg["uses"]["t_src"] = {"enabled": True, "class": "user_facing", "threshold": 0.8, "allowed": ["a", "b"]}
        cfg["uses"]["t_hard"] = {"enabled": True, "class": "gating", "threshold": 0.8,
                                 "gate": {"after": ["t_src"], "min_labelled": 4, "min_precision": 0.75}}
        reset(nouls(ok=0.95))
        held = run("t_hard", {"n": 0}, noul_q())
        check(not held["ok"] and held["reason"] == "gate_closed", "a gated use with no evidence answers no opinion")
        check(any(e.get("verdict") == "held" for e in mod.journal(cfg)), "a held answer is still journaled")
        check(not mod.gate_status(cfg, "t_hard")["open"] and mod.gate_status(cfg, "t_src")["open"], "gate_status: gated closed, ungated open")
        calls = []
        reset(choice_reply("a", 0.9))
        for i in range(4):
            r = run("t_src", {"i": i}, choice_q("a", "b"))
            calls.append(r["call"])
        check(all(calls) and len(set(calls)) == 4, "every answer carries a distinct call id")
        for c in calls[:3]:
            mod.outcome(cfg, "t_src", c, "a")
        check(mod.precision(cfg, "t_src")["labelled"] == 3 and not mod.gate_status(cfg, "t_hard")["open"], "too few labelled outcomes keep the gate closed")
        mod.outcome(cfg, "t_src", calls[3], "b")
        p = mod.precision(cfg, "t_src")
        check(p["labelled"] == 4 and p["correct"] == 3 and p["precision"] == 0.75 and mod.gate_status(cfg, "t_hard")["open"],
              "enough labelled outcomes at the precision opens the gate by itself")
        reset(nouls(ok=0.95))
        check(run("t_hard", {"n": 1}, noul_q())["ok"], "an open gate serves the gated use")
        mod.outcome(cfg, "t_src", calls[2], "b")
        check(not mod.gate_status(cfg, "t_hard")["open"] and run("t_hard", {"n": 2}, noul_q()).get("reason") == "gate_closed",
              "a later outcome that drops precision closes it again")
        cfg["uses"]["t_hard"]["gate"]["after"] = ["t_missing"]
        check(not mod.gate_status(cfg, "t_hard")["open"], "evidence of a use that never answered is no evidence")
        rep = mod.precision_report(cfg)
        check("t_hard" in [g["use"] for g in rep["gates"]] and any(u["use"] == "t_src" for u in rep["uses"]), "the report lists uses and gates")
        check(mod.outcome(cfg, "t_src", "", "a")["ok"] is False, "outcome needs a call id")
        # implicit accept: an answer nobody corrected within the declared days counts as accepted; an explicit outcome wins
        cfg["uses"]["t_imp"] = {"enabled": True, "class": "user_facing", "threshold": 0.8, "implicit_accept_days": 7}
        cfg["uses"]["t_noimp"] = {"enabled": True, "class": "user_facing", "threshold": 0.8}
        day = 86400
        ev = []
        for use in ("t_imp", "t_noimp"):
            ev += [{"ts": 1000, "use": use, "verdict": "answered", "call": "o1", "picks": {"q": "a"}},
                   {"ts": 1000, "use": use, "verdict": "answered", "call": "o2", "picks": {"q": "a"}},
                   {"ts": 1000 + 6 * day, "use": use, "verdict": "answered", "call": "n1", "picks": {"q": "a"}}]
        ev.append({"ts": 2000, "use": "t_imp", "verdict": "outcome", "call": "o2", "label": {"q": "b"}})
        p1 = mod.precision(cfg, "t_imp", ev, now=1000 + 8 * day)
        check(p1["labelled"] == 2 and p1["correct"] == 1, "implicit: old unlabelled counts accepted, explicit wrong stays wrong, a young one waits")
        check(mod.precision(cfg, "t_imp", ev, now=1000 + 6 * day)["labelled"] == 1, "implicit: before the days pass only the explicit label counts")
        check(mod.precision(cfg, "t_noimp", ev, now=1000 + 99 * day)["labelled"] == 0, "no implicit_accept_days = no implicit accept")
        # the goose flip follows its own gate
        cfg["uses"]["goose_pretool"]["on_unsafe"] = "block_when_gate_open"
        cfg["uses"]["goose_pretool"]["gate"] = {"after": ["goose_pretool"], "min_labelled": 1, "min_precision": 0.9}
        reset(nouls(all=0.02))
        ev = {"tool_name": "Bash", "tool_input": {"command": "ls"}, "working_dir": "/p"}
        check(mod.goose_hook(ev, cfg) is None, "goose logs instead of blocking while its gate is closed")
        last = [e for e in mod.journal(cfg) if e.get("use") == "goose_pretool" and e.get("call")][-1]
        mod.outcome(cfg, "goose_pretool", last["call"], False)
        reset(nouls(all=0.02))
        ev["tool_input"] = {"command": "ls -a"}
        check((mod.goose_hook(ev, cfg) or {}).get("decision") == "block", "goose blocks once its journal shows precision")
    finally:
        os.environ.pop("JEV_GATE_LOG", None)


def sidecar_suite(mod):
    """`serve`: POST /decide/<use> over a real socket, health by names, the body cap, the stdout journal."""
    import contextlib
    import io
    import urllib.error
    import urllib.request
    fails = []
    cfg = generic_config(mod)
    os.environ["OPENROUTER_API_KEY"] = FAKE_KEY
    mod._MEM_LEDGER.update(day="", spent=0.0, calls={})
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        srv = mod.serve(cfg, bind="127.0.0.1", port=0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % srv.server_address[1]

        def call(path, body=None, raw=None):
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            try:
                with urllib.request.urlopen(urllib.request.Request(base + path, data=data), timeout=10) as res:
                    return res.status, json.loads(res.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")

        reset(nouls(ok=0.95))
        code, out = call("/decide/t_ui", {"state": {"secret": FAKE_KEY, "n": 7}, "questions": noul_q()})
        if not (code == 200 and out.get("ok") and out["results"]["ok"]["p"] == 0.95):
            fails.append("sidecar did not answer a decision: %s %r" % (code, out))
        code, out = call("/decide/nope", {"state": 1, "questions": noul_q()})
        if not (code == 200 and out == {"ok": False, "use": "nope", "reason": "unknown_use"}):
            fails.append("sidecar: an unknown use must be 200 {ok:false}: %s %r" % (code, out))
        code, out = call("/health")
        if not (code == 200 and out["ok"] and "t_ui" in out["uses"] and "claude_permission" not in out["uses"] and out["key"] is True
                and FAKE_KEY not in json.dumps(out)):
            fails.append("sidecar /health must list served use names and the key's presence only: %r" % (out,))
        if call("/decide/")[0] != 404 or call("/other")[0] != 404:
            fails.append("sidecar: other paths are 404")
        if call("/decide/t_ui", raw=b"{not json")[0] != 400:
            fails.append("sidecar: a body that is not JSON is 400")
        if call("/decide/t_ui", raw=b"x" * (mod.MAX_BODY + 1))[0] != 413:
            fails.append("sidecar: a body over MAX_BODY is 413")
        srv.shutdown()
    mod.JOURNAL_STDOUT = False
    lines = [json.loads(l) for l in buf.getvalue().splitlines() if l.startswith("{")]
    if not any(l.get("use") == "t_ui" and l.get("verdict") == "answered" for l in lines):
        fails.append("sidecar journal must go to stdout for the log-shipper: %r" % buf.getvalue()[:300])
    if FAKE_KEY in buf.getvalue() or '"n": 7' in buf.getvalue():
        fails.append("sidecar journal must never carry the state")
    return fails


# mutants of the #881 code: each must make decide_suite fail
MUTANTS_DECIDE = [
    ("allowed ignored", 'if allowed and not set(crit) <= set(allowed):', "if False:"),
    ("daily cap ignored", 'if cap and st.get("spent", 0.0) >= cap:', "if False:"),
    ("hourly limit ignored", "if len(recent) >= per_hour:", "if False:"),
    ("spend never charged", 'budget_charge(cfg, meta["cost"])', "pass"),
    ("background not cached", "hit = _cache_get(cfg, key)", "hit = None"),
    ("gating not advice-only", 'if u["class"] == "gating":', "if False:"),
    ("generic state unredacted", 'state = _redact_obj(payload["state"], cfg)', 'state = payload["state"]'),
    ("generic oversize sent", "if _too_big(state, cfg):", "if False:"),
    ("out-of-set pick accepted", 'if not isinstance(pick, str) or pick not in q["criteria"] or pick not in probs:', "if not isinstance(pick, str):"),
    ("noul confidence ignored", '"confident": max(p, 1 - p) >= t}', '"confident": True}'),
    ("choice confidence ignored", '"confident": probs[pick] >= t,', '"confident": True,'),
    ("disabled use served", 'if not u.get("enabled"):\n        return None, "disabled"', "if False:\n        return None, 'disabled'"),
    ("hook use served by decide", 'if u.get("class") not in CLASSES:', "if False:"),
    ("probabilities unchecked", "if not isinstance(probs, dict) or not probs or not all(_prob(v) for v in probs.values()):", "if not isinstance(probs, dict):"),
    ("background without ttl served", 'if u["class"] == "background" and not (isinstance(ttl, (int, float)) and ttl > 0):', "if False:"),
    ("memory ledger fallback dropped", "        with _MEM_LOCK:\n            return txn(_MEM_LEDGER)", "        return None"),
    ("cache key ignores state", 'key = _sha(json.dumps([use, state, questions], sort_keys=True))', 'key = _sha(json.dumps([use, questions], sort_keys=True))'),
    ("body cap dropped", "if not 0 < n <= MAX_BODY:", "if False:"),
    ("gate never closes", 'if not u.get("gate") or gate_status(cfg, use)["open"]:', "if True:"),
    ("gate ignores precision", "elif p[\"precision\"] < g[\"min_precision\"]:", "elif False:"),
    ("gate ignores sample size", 'if p["labelled"] < g["min_labelled"]:', "if False:"),
    ("implicit accept ignores the age", 'if call not in labels and now - at[call] >= days * 86400:', "if call not in labels:"),
    ("implicit accept overrides a label", 'if call not in labels and now - at[call] >= days * 86400:', "if now - at[call] >= days * 86400:"),
    ("outcome never matched", "correct += 1 if want == pk else 0", "correct += 1"),
    ("goose flip ignores gate", 'u.get("on_unsafe") == "block_when_gate_open" and gate_status(cfg, "goose_pretool")["open"]', 'u.get("on_unsafe") == "block_when_gate_open"'),
    ("hook call not budgeted", "answers, meta = decide(state, asked, cfg, use=use)", "answers, meta = decide(state, asked, cfg)"),
]


def decide_mutation_tests():
    src = open(os.path.join(GATE_DIR, "jev_gate.py")).read()
    survived = []
    for label, old, new in MUTANTS_DECIDE:
        if src.count(old) != 1:
            survived.append("%s: mutation site not found exactly once (tester out of date)" % label)
            continue
        d = tempfile.mkdtemp(prefix="jev-mutant-", dir=TMP)
        shutil.copy(os.path.join(GATE_DIR, "jev-gate.json"), d)
        with open(os.path.join(d, "jev_gate.py"), "w") as f:
            f.write(src.replace(old, new))
        mutant = load(os.path.join(d, "jev_gate.py"), "jev_gate_mutant_d")
        fails = []
        check = lambda cond, msg: None if cond else fails.append(msg)
        try:
            decide_suite(mutant, check)
            if not fails and label in ("body cap dropped",):
                fails += sidecar_suite(mutant)
        except Exception:  # noqa: BLE001 — a mutant that crashes the suite is caught too
            fails.append("crashed")
        if not fails:
            survived.append(label)
    return survived


def package_and_parity():
    """The nix package, the sidecar service and the src/dist parity of every committed copy of the gate."""
    fails = []
    read = lambda p: open(os.path.join(ROOT, p)).read()
    pkg = read("_shared/jev-gate.nix")
    for needle in ['writers.writePython3Bin "jev-gate"', "JEV_GATE_CONFIG", "share/jev-gate", 'mainProgram = "jev-gate"', "./jev-gate"]:
        if needle not in pkg:
            fails.append("_shared/jev-gate.nix lacks %r" % needle)
    nix_parse = shutil.which("nix-instantiate")
    if nix_parse:
        r = subprocess.run([nix_parse, "--parse", os.path.join(ROOT, "_shared/jev-gate.nix")], capture_output=True, text=True)
        if r.returncode:
            fails.append("_shared/jev-gate.nix does not parse: %s" % r.stderr[:200])
    sidecar = "infra-ai_jev-sidecar"
    if "../../_shared/jev-gate" not in read(sidecar + "/src/flake.nix"):
        fails.append(sidecar + ": flake extraFiles must carry ../../_shared/jev-gate")
    if not re.search(r"^COPY jev-gate/ /app/jev-gate/$", read(sidecar + "/src/code/Dockerfile"), re.M) \
            or '"serve"' not in read(sidecar + "/src/code/Dockerfile"):
        fails.append(sidecar + ": Dockerfile must COPY jev-gate/ and run `jev_gate.py serve`")
    comp = read(sidecar + "/src/compose.nix")
    if "10.0.0.6" not in comp or "JEV_GATE_BIND" not in comp or re.search(r"^\s*ports\s*=", comp, re.M):
        fails.append(sidecar + ": compose must bind the mesh address (JEV_GATE_BIND) and publish no port")
    if json.load(open(os.path.join(ROOT, sidecar, "build.json")))["containers"]["app"].get("public"):
        fails.append(sidecar + ": the sidecar must not be public")
    # every committed copy of the gate is byte-identical to _shared/jev-gate (dist is generated; a stale
    # copy would ship an old gate with a new declaration)
    for rel in ["user-ai_cloudy-ai-agents-api/dist/code/arm64/jev-gate", "user-ai_cloudy-ai-agents-api/dist/code/amd64/jev-gate"]:
        d = os.path.join(ROOT, rel)
        if not os.path.isdir(d):
            continue
        for name in sorted(os.listdir(GATE_DIR)):
            src = os.path.join(GATE_DIR, name)
            if name == "__pycache__":
                continue
            if os.path.isdir(src):
                continue
            if not os.path.exists(os.path.join(d, name)) or open(src, "rb").read() != open(os.path.join(d, name), "rb").read():
                fails.append("src/dist parity: %s/%s differs from _shared/jev-gate/%s" % (rel, name, name))
        for name in sorted(os.listdir(os.path.join(GATE_DIR, "hooks"))):
            if open(os.path.join(GATE_DIR, "hooks", name), "rb").read() != open(os.path.join(d, "hooks", name), "rb").read():
                fails.append("src/dist parity: %s/hooks/%s differs" % (rel, name))
        extra = set(os.listdir(d)) - set(os.listdir(GATE_DIR))
        if extra:
            fails.append("src/dist parity: %s holds files _shared/jev-gate does not: %s" % (rel, sorted(extra)))
    # the declaration: every generic use declares what the engine on Android declares
    cfg = json.load(open(os.path.join(GATE_DIR, "jev-gate.json")))
    if not cfg.get("budget", {}).get("daily_cost_cap"):
        fails.append("jev-gate.json must declare budget.daily_cost_cap")
    for name, u in cfg["uses"].items():
        if "class" in u and (u["class"] not in ("user_facing", "background", "gating")
                             or (u["class"] == "background" and not u.get("ttl_s"))
                             or not u.get("max_calls_per_hour")):
            fails.append("use %s: a generic use declares a valid class, ttl_s for background and max_calls_per_hour" % name)
        if "class" not in u and not u.get("max_calls_per_hour"):
            fails.append("use %s: every use declares max_calls_per_hour" % name)
    return fails


# ── mutation tests: each guard must be load-bearing ──────────────────────────

MUTANTS = [
    ("threshold inclusive", "all(s >= t for s", "all(s > t for s"),
    ("redaction skipped", '"input": redact(json.dumps(tool_input, ensure_ascii=False), cfg)',
     '"input": json.dumps(tool_input, ensure_ascii=False)'),
    ("env-value redaction skipped", 'text = text.replace(value, r["mask"])', "pass"),
    ("static list skipped", "if never_auto_approve(tool, tool_input, cfg):", "if False:"),
    ("unsafe becomes allow", 'if verdict != "allow":', 'if verdict == "defer":'),
    ("probability range unchecked", "if not scores or not all(_prob(s) for s in scores.values()):", "if not scores:"),
    ("timeout dropped", 'urllib.request.urlopen(req, timeout=min(cfg["timeout_s"], budget or cfg["timeout_s"]))',
     "urllib.request.urlopen(req)"),
    ("oversize sent", 'if len(json.dumps(state)) > cfg["max_state_chars"]:', "if False:"),
    ("goose ignores on_unsafe", 'u.get("on_unsafe") == "block"', "True"),
    ("every call gated", '(u.get("first_call_only") and api_call_count != 1)', "(False)"),
    ("hermes ignores confidence", 'if p < u["threshold"]:', "if p < 0:"),
    ("none ignores tool history",
     'out = None if _has_tool_traffic(request.get("messages")) else _without_tools(request)',
     "out = _without_tools(request)"),
    # #765
    ("route ignores none", 'if choice == "none" or p < u["threshold"]:', 'if p < u["threshold"]:'),
    ("route ignores confidence", 'if choice == "none" or p < u["threshold"]:', 'if choice == "none":'),
    ("route cache ignored", "        if key in cache:\n", "        if False:\n"),
    ("inject cap dropped", "        if len(text) > room:\n", "        if False:\n"),
    ("injected text unredacted", "        text = redact(text, cfg)\n", ""),
    ("MCP budget ignored", "with urllib.request.urlopen(req, timeout=left) as res:",
     "with urllib.request.urlopen(req, timeout=60) as res:"),
    ("bearer header dropped", '"Accept": "application/json, text/event-stream", **ep["headers"]}',
     '"Accept": "application/json, text/event-stream"}'),
    ("unset header var sent", "return None if strict and missing else out", "return out"),
    ("repo enum not consulted", "if repos and repo not in repos:", "if False:"),
    ("goose file not cleared first", '        open(path, "w").close()\n', ""),
    ("impact not in state", '            state["impact"] = imp', "            pass"),
    ("impact failure defers", 'log(cfg, use="impact", cli=cli, tool=tool, reason="exception:" + type(e).__name__)\n        return None',
     "raise"),
]


def mutation_tests():
    src = open(os.path.join(GATE_DIR, "jev_gate.py")).read()
    survived = []
    for label, old, new in MUTANTS:
        if src.count(old) != 1:
            survived.append("%s: mutation site not found exactly once (tester out of date)" % label)
            continue
        d = tempfile.mkdtemp(prefix="jev-mutant-", dir=TMP)
        shutil.copy(os.path.join(GATE_DIR, "jev-gate.json"), d)
        with open(os.path.join(d, "jev_gate.py"), "w") as f:
            f.write(src.replace(old, new))
        mutant = load(os.path.join(d, "jev_gate.py"), "jev_gate_mutant")
        if not suite(mutant):
            survived.append(label)
    return survived


# ── CLI entrypoint and host wiring ───────────────────────────────────────────

def cli_and_wiring():
    fails = []
    env = dict(os.environ, OPENROUTER_API_KEY=FAKE_KEY, JEV_GATE_LOG=os.path.join(TMP, "cli.jsonl"))
    cfgfile = os.path.join(TMP, "cli-config.json")
    mod = load(os.path.join(GATE_DIR, "jev_gate.py"), "jev_gate_cli")
    json.dump(test_config(mod), open(cfgfile, "w"))
    env["JEV_GATE_CONFIG"] = cfgfile
    run = lambda mode, stdin: subprocess.run([sys.executable, os.path.join(GATE_DIR, "jev_gate.py"), mode],
                                             input=stdin, capture_output=True, text=True, env=env, timeout=30)
    reset(nouls(all=0.95))
    r = run("claude", json.dumps({"hook_event_name": "PermissionRequest", "tool_name": "Bash",
                                  "tool_input": {"command": "ls"}, "cwd": "/p"}))
    if r.returncode or json.loads(r.stdout or "{}").get("hookSpecificOutput", {}).get("decision") != {"behavior": "allow"}:
        fails.append("CLI claude path did not allow a safe call: rc=%s out=%r" % (r.returncode, r.stdout))
    for mode, stdin in [("claude", "not json"), ("goose", ""), ("goose-prompt", "[]"), ("bogus", "{}")]:
        r = run(mode, stdin)
        if r.returncode or r.stdout.strip():
            fails.append("CLI %s with bad input must exit 0 silently (rc=%s out=%r)" % (mode, r.returncode, r.stdout))

    # hermes adapter registers llm_request middleware and tolerates an older hermes
    plugin = load(os.path.join(GATE_DIR, "__init__.py"), "jev_gate_plugin")
    seen = {}

    class Ctx:
        def register_middleware(self, kind, cb):
            seen[kind] = cb

        def register_hook(self, name, cb):
            seen[name] = cb
    os.environ["JEV_GATE_CONFIG"] = cfgfile
    plugin.register(Ctx())
    plugin.register(object())  # no register_middleware: must not raise
    del os.environ["JEV_GATE_CONFIG"]
    if "llm_request" not in seen:
        fails.append("hermes plugin did not register llm_request middleware")
    else:
        reset(choice("b", 0.9))
        req = {"messages": [{"role": "user", "content": "q"}],
               "tools": [{"type": "function", "function": {"name": n}} for n in "ab"]}
        res = seen["llm_request"](request=req, api_call_count=1, api_mode="chat_completions", turn_id="t")
        if not res or [t["function"]["name"] for t in res["request"]["tools"]] != ["b"]:
            fails.append("hermes middleware did not return the narrowed request")

    # hermes pre_llm_call returns {"context": ...} (hermes appends it to the user message)
    if "pre_llm_call" not in seen:
        fails.append("hermes plugin did not register the pre_llm_call code-context hook")
    else:
        hcfg = mod.load_config(cfgfile)
        reset(route("graphrag", 0.9, repo="cloud-infra"))
        mcp_reset(text="hermes ctx")
        os.environ["JEV_GATE_CONFIG"] = cfgfile
        res = load(os.path.join(GATE_DIR, "__init__.py"), "jev_gate_plugin2")
        seen2 = {}

        class Ctx2(Ctx):
            def register_hook(self, name, cb):
                seen2[name] = cb
        res.register(Ctx2())
        del os.environ["JEV_GATE_CONFIG"]
        out = seen2["pre_llm_call"](session_id="h1", user_message="how is X wired?", is_first_turn=True,
                                    conversation_history=[], model="m", platform="cli")
        if not (isinstance(out, dict) and "hermes ctx" in out.get("context", "")):
            fails.append("hermes pre_llm_call did not return the routed context: %r" % (out,))
        reset(route("none", 0.99))
        if seen2["pre_llm_call"](session_id="h1", user_message="thanks!") is not None:
            fails.append("hermes pre_llm_call must return None on none")

    # the real CLI configs resolve to a cloud-cgc server the gate can call
    os.environ["XDG_CONFIG_HOME"] = xdg = os.path.join(TMP, "xdg")
    os.makedirs(os.path.join(xdg, "goose"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "user-ai_cloudy-ai-agents-api/src/code/configs/goose-config.yaml"),
                os.path.join(xdg, "goose", "config.yaml"))
    os.environ["HERMES_HOME"] = os.path.join(ROOT, "user-ai_hermes-agent/src/configs")
    real_cfg = mod.load_config(os.path.join(GATE_DIR, "jev-gate.json"))
    real_cfg["code_graph"]["client_configs"]["claude"]["path"] = os.path.join(
        ROOT, "user-ai_cloudy-ai-claude-api/src/code/claude-config/mcp.tpl.json")
    for cli in ["claude", "goose", "hermes"]:
        try:
            ep = mod.cgc_endpoint(cli, real_cfg)
        except Exception as e:  # noqa: BLE001
            ep = None
            fails.append("%s: reading its MCP config raised %s" % (cli, type(e).__name__))
        if not ep or ep["server"] not in real_cfg["code_graph"]["servers"]:
            fails.append("%s: its own MCP config declares no usable cloud-cgc server" % cli)
    del os.environ["XDG_CONFIG_HOME"], os.environ["HERMES_HOME"]

    # goose hooks.json: real goose 1.44 developer tool names, unanchored-regex safe
    hooks = json.load(open(os.path.join(GATE_DIR, "hooks", "hooks.json")))["hooks"]["PreToolUse"][0]
    rx = re.compile(hooks["matcher"])
    if not all(rx.search(n) for n in ["shell", "write", "edit"]) or any(rx.search(n) for n in ["tree", "cloud-infra-mcp__shell_x"]):
        fails.append("goose matcher must cover shell/write/edit only")
    if "$PLUGIN_ROOT/jev_gate.py\" goose" not in hooks["hooks"][0]["command"]:
        fails.append("goose hook must run the shared jev_gate.py from its plugin root")
    ups = json.load(open(os.path.join(GATE_DIR, "hooks", "hooks.json")))["hooks"].get("UserPromptSubmit") or []
    if not any(h["command"].endswith("jev_gate.py\" goose-prompt") and h.get("timeout", 30) > real_cfg["code_graph"]["route"]["budget_s"]
               for e in ups for h in e.get("hooks", [])):
        fails.append("goose UserPromptSubmit must run goose-prompt with a timeout above the route budget")

    # each container actually ships and registers the gate
    def read(p):
        return open(os.path.join(ROOT, p)).read()
    s = json.load(open(os.path.join(ROOT, "user-ai_cloudy-ai-claude-api/src/code/claude-config/settings.json")))
    pr = s.get("hooks", {}).get("PermissionRequest") or []
    if not any("jev_gate.py claude" in h.get("command", "") and re.fullmatch(e.get("matcher", ""), "Bash")
               for e in pr for h in e.get("hooks", [])):
        fails.append("claude settings.json lacks the PermissionRequest jev-gate hook")
    ups = s.get("hooks", {}).get("UserPromptSubmit") or []
    if not any("jev_gate.py claude" in h.get("command", "") and h.get("timeout", 60) > real_cfg["code_graph"]["route"]["budget_s"]
               for e in ups for h in e.get("hooks", [])):
        fails.append("claude settings.json lacks the UserPromptSubmit jev-gate hook (timeout above the route budget)")
    if not all(h.get("timeout", 60) > real_cfg["timeout_s"] + real_cfg["code_graph"]["impact"]["budget_s"]
               for e in pr for h in e.get("hooks", []) if "jev_gate.py" in h.get("command", "")):
        fails.append("claude PermissionRequest timeout must exceed Jev timeout + impact budget")
    if "jev-gate" in s.get("permissions", {}).get("deny", []):
        fails.append("unexpected deny rule")
    for svc in ["user-ai_cloudy-ai-claude-api", "user-ai_cloudy-ai-agents-api"]:
        if "../../_shared/jev-gate" not in read(svc + "/src/flake.nix"):
            fails.append(svc + ": flake extraFiles must carry ../../_shared/jev-gate")
        if not re.search(r"^COPY jev-gate/ /app/jev-gate/$", read(svc + "/src/code/Dockerfile"), re.M):
            fails.append(svc + ": Dockerfile must COPY jev-gate/ /app/jev-gate/")
    if "/app/jev-gate" not in read("user-ai_cloudy-ai-agents-api/src/code/start.sh") or ".agents/plugins" not in read("user-ai_cloudy-ai-agents-api/src/code/start.sh"):
        fails.append("goose start.sh must install /app/jev-gate as a ~/.agents/plugins plugin")
    if not re.search(r'^export GOOSE_MOIM_MESSAGE_FILE="\$\{HOME\}/', read("user-ai_cloudy-ai-agents-api/src/code/start.sh"), re.M):
        fails.append("goose start.sh must export GOOSE_MOIM_MESSAGE_FILE for goosed and its hooks")
    tom = mod.mini_yaml(read("user-ai_cloudy-ai-agents-api/src/code/configs/goose-config.yaml"))["extensions"].get("tom") or {}
    if tom.get("enabled") != "true" or tom.get("type") != "platform":
        fails.append("goose-config.yaml must enable the tom platform extension (it injects the context file)")
    if not re.search(r"^\s*enabled:\s*\[[^\]]*jev-gate", read("user-ai_hermes-agent/src/configs/config.yaml"), re.M):
        fails.append("hermes config.yaml must enable the jev-gate plugin")
    if "/opt/data/plugins/jev-gate" not in read("user-ai_hermes-agent/src/compose.nix"):
        fails.append("hermes compose must mount the plugin at /opt/data/plugins/jev-gate")
    if "_shared/jev-gate" not in read("user-ai_hermes-agent/src/flake.nix"):
        fails.append("hermes flake must emit the shared jev-gate files")
    for svc in ["user-ai_cloudy-ai-claude-api", "user-ai_cloudy-ai-agents-api", "user-ai_hermes-agent"]:
        if not os.path.exists(os.path.join(ROOT, svc, "src", "secrets.yaml")):
            continue  # #1064: the sops file lives only in the private vault; the check runs where it is overlaid
        if not re.search(r"^OPENROUTER_API_KEY: ENC\[AES256_GCM", read(svc + "/src/secrets.yaml"), re.M):
            fails.append(svc + ": OPENROUTER_API_KEY must be a sops-encrypted key in src/secrets.yaml")
    return fails


def main():
    os.environ.pop("JEV_GATE_CONFIG", None)
    real = load(os.path.join(GATE_DIR, "jev_gate.py"), "jev_gate_real")
    fails = ["behaviour: " + f for f in suite(real)]
    survived = mutation_tests()
    fails += ["mutant SURVIVED (a guard is not tested): " + m for m in survived]
    fails += ["wiring: " + f for f in cli_and_wiring()]
    survived_881 = decide_mutation_tests()
    fails += ["mutant SURVIVED (a #881 guard is not tested): " + m for m in survived_881]
    survived = survived + survived_881
    fails += ["sidecar: " + f for f in sidecar_suite(real)]
    fails += ["package: " + f for f in package_and_parity()]
    SERVER.shutdown()
    shutil.rmtree(TMP, ignore_errors=True)
    for f in fails:
        print("FAIL", f)
    print("jev-gate: %d/%d mutants killed, %d failures" % (len(MUTANTS) + len(MUTANTS_DECIDE) - len(survived), len(MUTANTS) + len(MUTANTS_DECIDE), len(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
