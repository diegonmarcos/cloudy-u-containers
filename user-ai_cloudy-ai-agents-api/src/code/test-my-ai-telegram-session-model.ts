// Tester: ticket #507 — claude telegram bot session persistence, /resume, and
// the no-false-model fix. Runs on every push via .github/workflows/per-service-tests.yml
// (registered in build.json tests.session-model-routing, cwd=src/code).
//
// It drives the REAL route.mjs / commands.mjs / sessions-store.mjs against a temp
// BRIDGE_SESSIONS_DIR and a fetch stub that mirrors server.mjs's /sessions endpoints,
// and asserts the three ticket guarantees. Reverting any one fix turns the matching
// check red:
//
//   1. chat history survives a "restart" (fresh module instance) — the conversation
//      continues, it does not just make a file.
//   2. the telegram store is discoverable by /sessions (device === "telegram") and its
//      NDJSON round-trips through commands.mjs /resume unchanged.
//   3. a claude-agent request with no explicit per-chat model still sends an explicit
//      CLAUDE_MODEL so server.mjs never substitutes an OpenRouter name.
//
// Usage: node test-my-ai-telegram-session-model.ts   (exit 0 = PASS, non-zero = FAIL)
import { mkdtempSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";

const TMP = mkdtempSync(join(tmpdir(), "myai-session-507-"));
process.env.BRIDGE_SESSIONS_DIR = TMP;
process.env.CLAUDE_MODEL = "claude-sonnet-4-6";

// Load the real modules AFTER the env is set, so SESSIONS_DIR / CLAUDE_MODEL are
// picked up at import time. Dynamic + cache-busted so each "restart" is a fresh
// module instance (fresh chatState).
const storeUrl = new URL("./sessions-store.mjs", import.meta.url).href;
const routeUrl = new URL("./bots/route.mjs", import.meta.url).href;
const cmdsUrl = new URL("./bots/commands.mjs", import.meta.url).href;

const store = await import(storeUrl);
const route = await import(routeUrl);
const cmds = await import(cmdsUrl);

const CHAT = "telegram-claude:99900112233";
try {
  assert.equal(store.safeSessionId(CHAT), "telegram-claude_99900112233");
} catch (e) {
  console.error("FAIL: safeSessionId maps a chatKey with ':' to a safeSeg id");
  process.exit(1);
}

// ── fetch stub ────────────────────────────────────────────────────────────────
// Mirrors the /sessions surface of server.mjs (which enumerates SESSIONS_DIR and
// serves the NDJSON files verbatim) plus the chat-completion upstream that
// routeToGoose forwards to. Records every chat-completion body so the tester can
// assert what model/messages actually went upstream.
const RESULTS: string[] = [];
const failures: string[] = [];
let completionCount = 0;
function ok(label: string) { RESULTS.push(`  OK: ${label}`); console.log(`  OK: ${label}`); }
function bad(label: string) { failures.push(label); console.log(`FAIL: ${label}`); }

(globalThis as any).fetch = async (url: unknown, init?: any) => {
  const u = String(url);
  if (u.includes("/v1/chat/completions")) {
    completionCount++;
    const body = JSON.parse(init?.body ?? "{}");
    (globalThis as any).__lastCompletionBody = body;
    const reply = `reply-${completionCount}`;
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      text: async () => "",
    };
  }
  if (u.includes("/sessions")) {
    // Mirror server.mjs /sessions GET (device listing) and /sessions/<device>/<id> GET.
    // The path match must NOT be $-anchored: server.mjs splits the query string off
    // before routing, so /sessions/<device>/<id>?tail=<bytes> is the same endpoint
    // (the #513 bound). An anchored stub modelled a server that 404s on any query
    // and made a correct caller look broken.
    const m = u.match(/\/sessions\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
    if (m) {
      const file = join(TMP, m[1], `${m[2]}.jsonl`);
      if (!existsSync(file)) return { ok: false, status: 404, text: async () => "" };
      const tail = parseInt(new URLSearchParams(m[3] ?? "").get("tail") ?? "0", 10) || 0;
      // Serve the tail through the REAL reader, so this stub cannot drift into
      // being a second implementation of the format contract.
      const raw = store.readTailBytes(file, tail < statSync(file).size ? tail : 0);
      return { ok: true, status: 200, text: async () => raw, json: async () => ({}) };
    }
    const out: any[] = [];
    if (existsSync(TMP)) {
      for (const device of readdirSync(TMP)) {
        const ddir = join(TMP, device);
        if (!statSync(ddir).isDirectory()) continue;
        for (const f of readdirSync(ddir)) {
          if (!f.endsWith(".jsonl")) continue;
          const st = statSync(join(ddir, f));
          out.push({ device, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size });
        }
      }
    }
    const list = out;
    return { ok: true, status: 200, text: async () => JSON.stringify(list), json: async () => list };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const sentId = store.safeSessionId(CHAT);
const sessPath = join(TMP, "telegram", `${sentId}.jsonl`);

// ── 1. persistence + restart survival ────────────────────────────────────────
await route.routeToGoose("first turn", CHAT, "claude");
await route.routeToGoose("second turn", CHAT, "claude");
const firstCompletion = (globalThis as any).__lastCompletionBody;

if (!existsSync(sessPath)) bad("session file written under SESSIONS_DIR/telegram/<id>.jsonl");
else ok("session file written under SESSIONS_DIR/telegram/<id>.jsonl");

// The file must hold BOTH turns (full history, not just the last slice).  If the write
// was reverted the file is absent — report as a FAIL rather than crash on read.read
let userTurns: string[] = [];
if (existsSync(sessPath)) {
  const persisted = readFileSync(sessPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  userTurns = persisted.filter((m: any) => m.role === "user").map((m: any) => m.content);
}
if (userTurns.includes("first turn") && userTurns.includes("second turn"))
  ok("persisted NDJSON keeps both turns");
else bad("persisted NDJSON keeps both turns (full history, uncapped)");

// "Restart": a FRESH module instance (fresh chatState). Its getState must reload from
// disk, and a further turn must still see the OLD first turn — the conversation continues.
const route2 = await import(`${routeUrl}?restart=${Date.now()}`);
const st2 = route2.getState(CHAT, "claude");
if (Array.isArray(st2.history) && st2.history.some((m: any) => m.role === "user" && m.content === "first turn"))
  ok("restarted chatState reloads persisted history from disk");
else bad("restarted chatState reloads persisted history from disk (restart survival)");

await route2.routeToGoose("third turn", CHAT, "claude");
const afterRestartBody = (globalThis as any).__lastCompletionBody;
const msgs = afterRestartBody?.messages ?? [];
const hasFirstAndThird = msgs.some((m: any) => m?.content === "first turn") && msgs.some((m: any) => m?.content === "third turn");
if (hasFirstAndThird) ok("conversation continues across restart (old + new turns sent upstream)");
else bad("conversation continues across restart (old + new turns sent upstream)");

// ── 2. /sessions + /resume round-trip ────────────────────────────────────────
const resumeList = await cmds.handleCommand("resume", "", CHAT, { fromId: "0", allowFrom: ["0"] }, "claude");
if (resumeList.includes(sentId) && resumeList.includes("use /resume"))
  ok("/sessions stream lists the telegram session id under device telegram");
else bad(`/sessions stream lists telegram id (got: ${JSON.stringify(resumeList)})`);

const resumed = await cmds.handleCommand("resume", sentId, CHAT, { fromId: "0", allowFrom: ["0"] }, "claude");
// Assert the STATE, not the wording of the reply: what this check is paid to
// prove is that the persisted turns are back in the chat's history. (#513 made
// the reply report what it loaded and skipped, so matching on a fixed phrase was
// testing the sentence, not the behaviour.)
const resumedHistory = route.getState(CHAT, "claude").history;
if (resumed.startsWith("▶️") && resumedHistory.some((m: any) => m.role === "user" && m.content === "first turn"))
  ok("/resume loads the persisted messages into chat state");
else bad(`/resume loads the persisted messages (got: ${JSON.stringify(resumed)}, history=${resumedHistory.length})`);

// ── 3. explicit claude model — never an OpenRouter name ─────────────────────
// Fresh chat, no per-chat model set (state.model is null). routeToGoose must send
// CLAUDE_MODEL explicitly so server.mjs never substitutes BRIDGE_DEFAULT_MODEL.
await route2.routeToGoose("fresh", "telegram-claude:55500667788", "claude");
const freshBody = (globalThis as any).__lastCompletionBody;
const sentModel = freshBody?.model;
if (sentModel === process.env.CLAUDE_MODEL)
  ok(`claude request without /model sends explicit CLAUDE_MODEL (${sentModel})`);
else bad(`claude request without /model sends explicit CLAUDE_MODEL (got ${JSON.stringify(sentModel)})`);

if (typeof sentModel === "string" && !sentModel.includes("deepseek") && !sentModel.includes("openrouter"))
  ok("claude request model is NOT an OpenRouter name");
else bad(`claude request model is NOT an OpenRouter name (got ${JSON.stringify(sentModel)})`);

// rtk/headroom/caveman shouldn't block; the reply text surfaced upstream is used.
console.log("── tester summary ──");
if (failures.length > 0) {
  console.error(`RED: ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("GREEN: all #507 session/model checks pass");
process.exit(0);