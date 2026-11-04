// Tester: the gateway's native agents — OpenClaw (cloud-agi-openclaw) and the
// Hermes Agent's own API (cloud-agi-hermes) — and the /health.modes list the
// Cloud Code app builds its agent picker from.
//
// Starts the REAL server.mjs as a child process on a free loopback port, with
// two fake upstreams standing in for the loopback agents (the same
// OpenAI-compatible shapes OpenClaw 2026.9.9 and Hermes Agent 0.21.5 serve:
// /health unauthenticated, /v1/chat/completions, Hermes behind Bearer
// API_SERVER_KEY). Nothing reaches the network.
//
// It must fail when:
//   * X-Agent-Mode: openclaw is not routed to the OpenClaw gateway        (N1)
//   * a native agent that is down answers anything but a 502 naming it  (N2)
//   * hermes with a key still goes to OpenRouter, or without one to the
//     Hermes API (the "Hermes" label must never hide which one answered)  (N3, N4)
//   * /health.modes stops listing an agent, or reports one available that
//     does not answer                                                    (N5)
//   * GET /agents/<agent>/<fn> proxies a path outside the allowlist, or
//     forgets the Hermes credential                                       (N6)
//   * X-Agent-Mode: openrouter lets a "claude-…" model id re-route the chat (N7)
//   * the loopback ports in server.mjs drift from the ports the two
//     services declare in their own build.json                            (N8)
//
// Usage: node test-my-ai-native-agents.mjs   (cwd = src/code; exit 0 = PASS)
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let fail = 0, pass = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

// Built at run time: a fixed literal here reads as a leaked key to the leak scan.
const KEY = ["fake", "hermes", "api", String(process.pid).padStart(12, "0")].join("-");
const seen = { openclaw: [], hermes: [] };

const fake = (name, { auth } = {}) => http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen[name].push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    const j = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/health") return j(200, { ok: true });
    if (auth && req.headers.authorization !== `Bearer ${auth}`) return j(401, { error: { message: "Invalid gateway API key" } });
    if (req.method === "POST" && req.url === "/v1/chat/completions")
      return j(200, { id: `chatcmpl-${name}`, object: "chat.completion", model: JSON.parse(body).model, choices: [{ index: 0, message: { role: "assistant", content: `${name} says pong` }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    if (req.method === "GET" && req.url === "/v1/skills") return j(200, { object: "list", data: [{ name: "github", description: "GitHub" }] });
    if (req.method === "GET" && req.url === "/v1/models") return j(200, { object: "list", data: [{ id: `${name}/default` }] });
    return j(404, { error: { message: "nope" } });
  });
});

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const freePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };

const start = async (env) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME || "/tmp",
      BRIDGE_PORT: String(port), BRIDGE_BIND: "127.0.0.1", BRIDGE_OLLAMA_PORT: "0",
      HEADROOM_ENABLED: "0", MCP_ENABLED: "0", AGENTS_PRINCIPLES_ENABLED: "0", CLOUD_PRINCIPLES_ENABLED: "0",
      BRIDGE_PROBE_TTL_MS: "0", OPENROUTER_API_KEY: "", ...env,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr.on("data", (c) => (log += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/livez`)).ok) return { base, child, log: () => log }; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error(`server.mjs did not start: ${log}`);
};

const chat = async (base, mode, model = "x/y") => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", ...(mode ? { "x-agent-mode": mode } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], reasoning: { effort: "high" }, user: "chat-1" }),
  });
  return { status: r.status, j: await r.json() };
};

const claw = fake("openclaw");
const hermes = fake("hermes", { auth: KEY });
const clawPort = await listen(claw);
const hermesPort = await listen(hermes);

// ── 1. both native agents wired and up ──────────────────────────────────────
let s = await start({ OPENCLAW_BASE_URL: `http://127.0.0.1:${clawPort}`, HERMES_API_BASE_URL: `http://127.0.0.1:${hermesPort}`, HERMES_API_KEY: KEY });
try {
  const c = await chat(s.base, "openclaw");
  const got = seen.openclaw.find((x) => x.method === "POST");
  check("N1 X-Agent-Mode: openclaw reaches the OpenClaw gateway with its agent target",
    c.status === 200 && c.j.choices?.[0]?.message?.content === "openclaw says pong" && got?.body?.model === "openclaw/default",
    JSON.stringify({ status: c.status, sent: got?.body }));
  check("N1b only messages, the target and `user` go to the agent (no gateway-only fields)",
    got && Object.keys(got.body).sort().join(",") === "messages,model,stream,user" && got.body.user === "chat-1",
    JSON.stringify(got?.body));

  const h = await chat(s.base, "hermes");
  const hs = seen.hermes.find((x) => x.method === "POST");
  check("N3 hermes with HERMES_API_KEY is the Hermes Agent API, with the Bearer key",
    h.status === 200 && h.j.choices?.[0]?.message?.content === "hermes says pong" && hs?.headers.authorization === `Bearer ${KEY}`,
    JSON.stringify({ status: h.status, j: h.j }));

  const health = await (await fetch(`${s.base}/health`)).json();
  const ids = (health.modes || []).map((m) => m.id).join(",");
  check("N5 /health.modes lists every agent the gateway serves", ids === "hermes,openclaw,deepseek,goose,claude-cli,openrouter", ids);
  const hm = health.modes.find((m) => m.id === "hermes"), om = health.modes.find((m) => m.id === "openclaw");
  check("N5b a live native agent is available and publishes its functions",
    hm.native && hm.available && hm.functions.some((f) => f.id === "skills" && f.path === "/agents/hermes/skills")
      && om.available && om.fleet === "cloud-agi-openclaw" && om.functions.some((f) => f.path === "/agents/openclaw/agents"),
    JSON.stringify(health.modes));
  check("N5c /health.agents keeps the old keys and names openclaw's target", health.agents.openclaw === "openclaw/default" && "claude_cli" in health.agents && health.agents.hermes === "hermes-agent", JSON.stringify(health.agents));
  check("N5d the health body never carries the Hermes key", !JSON.stringify(health).includes(KEY));

  const sk = await fetch(`${s.base}/agents/hermes/skills`);
  const skj = await sk.json();
  const skReq = seen.hermes.filter((x) => x.url === "/v1/skills").pop();
  check("N6 GET /agents/hermes/skills proxies Hermes' /v1/skills with its credential",
    sk.status === 200 && skj.data?.[0]?.name === "github" && skReq?.headers.authorization === `Bearer ${KEY}`, JSON.stringify(skj));
  const bad = await fetch(`${s.base}/agents/hermes/..%2Fapi%2Fjobs%2Fx%2Frun`);
  const bad2 = await fetch(`${s.base}/agents/nobody/skills`);
  check("N6b a function outside the allowlist, or an unknown agent, is a 404", bad.status === 404 && bad2.status === 404, `${bad.status} ${bad2.status}`);

  const ds = await chat(s.base, "deepseek", "anthropic/claude-x");
  check("N9 the DeepSeek harness never runs a non-DeepSeek model and reaches OpenRouter (my_ai_deepseek_error with no key)",
    ds.status === 502 && ds.j.error?.type === "my_ai_deepseek_error" && /OPENROUTER_API_KEY/.test(ds.j.error.message), JSON.stringify(ds.j));
  const dm = health.modes.find((m) => m.id === "deepseek");
  check("N9b /health.modes[deepseek] names its default model and that only DeepSeek models can be picked",
    /^deepseek\//.test(dm.model) && dm.model_choice.providers.join() === "DeepSeek", JSON.stringify(dm));
  const or = await chat(s.base, "openrouter", "claude-opus-5");
  check("N7 X-Agent-Mode: openrouter keeps a claude-… model on OpenRouter",
    or.status === 502 && or.j.error?.type === "my_ai_openrouter_error", JSON.stringify(or.j));
} finally { s.child.kill(); }

// ── 2. native agents down / not wired ───────────────────────────────────────
await new Promise((r) => claw.close(r));
s = await start({ OPENCLAW_BASE_URL: `http://127.0.0.1:${clawPort}`, HERMES_API_BASE_URL: `http://127.0.0.1:${hermesPort}` });
try {
  const before = seen.hermes.length;
  const c = await chat(s.base, "openclaw");
  check("N2 OpenClaw down is a 502 naming openclaw", c.status === 502 && c.j.error?.type === "my_ai_openclaw_error", JSON.stringify(c.j));
  const h = await chat(s.base, "hermes");
  check("N4 hermes without HERMES_API_KEY never calls the Hermes API (it is the OpenRouter forward)",
    seen.hermes.length === before && h.status === 502 && /OPENROUTER_API_KEY/.test(h.j.error?.message || ""), JSON.stringify(h.j));
  const health = await (await fetch(`${s.base}/health`)).json();
  const hm = health.modes.find((m) => m.id === "hermes"), om = health.modes.find((m) => m.id === "openclaw");
  check("N5e a down agent is listed unavailable with a reason, and publishes no function",
    om.available === false && /does not answer/.test(om.reason) && om.functions.length === 0 && health.agents.openclaw === false, JSON.stringify(om));
  check("N5f hermes without its key says so: native false, the OpenRouter model, no Hermes functions",
    hm.native === false && hm.model === health.agents.hermes && hm.functions.length === 0 && /HERMES_API_KEY/.test(hm.note || ""), JSON.stringify(hm));
  const sk = await fetch(`${s.base}/agents/hermes/skills`);
  check("N6c Hermes functions are a 503 while its key is not wired", sk.status === 503);
} finally { s.child.kill(); }
await new Promise((r) => hermes.close(r));

// ── 3. the loopback ports are the services' own declarations ───────────────
const src = readFileSync("server.mjs", "utf8");
const port = (re) => Number((re.exec(src) || [])[1]);
const declared = (dir, key) => JSON.parse(readFileSync(join("..", "..", "..", dir, "build.json"), "utf8")).ports[key];
check("N8 OPENCLAW_BASE_URL's default port is user-ai_openclaw build.json ports.app",
  port(/OPENCLAW_BASE_URL \?\? "http:\/\/127\.0\.0\.1:(\d+)"/) === declared("user-ai_openclaw", "app"));
check("N8b HERMES_API_BASE_URL's default port is user-ai_hermes-agent build.json ports.api",
  port(/HERMES_API_BASE_URL \?\? "http:\/\/127\.0\.0\.1:(\d+)"/) === declared("user-ai_hermes-agent", "api"));

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
