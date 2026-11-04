#!/usr/bin/env node
// rebuild-trigger 2026-08-11: the failed Aug-9 ship rsynced .docker-src-hash to
// the VM without pushing the rebuilt binaries image, so every later ship
// false-skipped the build and kept deploying the 2026-06-25 image (no
// /auth/login endpoints). This comment changes the src hash to force the build.
// claude-api-superset — front multiplexer. One process speaks three API shapes,
// all backed by the *subscription* Claude CLI (no metered key), with a Headroom
// compression hop in front of every call:
//
//   OpenAI    /v1/chat/completions   ─┐
//   Ollama    /api/chat, /api/tags    ├─→ compress(messages) ─→ claude -p
//   Anthropic /v1/messages           ─┘        (Python sidecar)
//
//   octocode (OpenAI/Ollama) and Claude Code (ANTHROPIC_BASE_URL=…) both work.
//
// Successor to kg-bridge: same no-deps design (node:http + child_process), same
// /health {calls,…} stats shape (octocode reindex.sh depends on it), same dual
// listener + named-volume OAuth login. The only new moving part is the compress
// hop, which degrades to passthrough if the sidecar is unreachable.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// isAuthRequired / AUTH_REQUIRED_SIGNATURES: the single declared list of
// dead-credential signatures. Declared next to the OAuth handshake that cures
// them (login.mjs) so the symptom and the remedy cannot drift.
import { startLogin, submitCode, loginStatus, isAuthRequired } from "./login.mjs";
// Cross-device session store — the ONE declaration of the store directory, the
// session namer and the name→session resolver (#525's resolveResumeAddress).
// This file is the SAME shared module my-ai-api ships (asserted byte-identical
// by test-my-ai-sessions-store-parity.mjs): there is exactly one derivation and
// one resolver in the fleet, and this container reuses it rather than growing a
// second copy next to a call site.
import {
  SESSIONS_DIR,
  deriveSessionName,
  resolveResumeAddress,
} from "./sessions-store.mjs";
// #548: the ONE place that answers "is the mounted task store reachable?". A
// name that resolves to a session whose ~/.claude/tasks/<id>/ is NOT reachable
// must fail with WORDS — never fall through to a `claude -p` whose TaskList
// would legitimately read zero (the exact defect #548 exists to end). The
// module is pure: it only builds the argv for a resume spawn from a RESOLVED id
// and checks the mounted task store. It does NOT resolve names — #525 owns that
// (above), and reuse, not a second resolver, is the whole point.
import {
  assertTaskStoreReachable,
  countTaskFiles,
  deriveResumeSession,
  RESUME_ERROR_WORDS,
} from "./claude-resume.mjs";

const PORT          = parseInt(process.env.BRIDGE_PORT || "3107", 10);
const BIND          = process.env.BRIDGE_BIND || "127.0.0.1";
const CLAUDE_BIN    = process.env.CLAUDE_BIN || "claude";
const MAX_CONC      = parseInt(process.env.BRIDGE_MAX_CONCURRENCY || "12", 10);
const CALL_TIMEOUT  = parseInt(process.env.BRIDGE_CALL_TIMEOUT_MS || "180000", 10);
// How many assistant turns one request may take. This was hardcoded to 1, which
// does not mean "one answer" — it means ZERO tool calls, because a tool call
// costs a turn. So the Telegram bot could say hello and nothing else: the moment
// a question needed Bash or Read, claude exited 1 with `max_turns` and the user
// got an opaque "[gateway error 502] claude -p exit 1: max_turns".
// The real ceiling on a runaway request is CALL_TIMEOUT above, which bounds wall
// clock no matter how many turns are left; this bounds the turn count so a loop
// that makes no progress still ends. Data-driven from build.json runtime.
const MAX_TURNS     = parseInt(process.env.BRIDGE_MAX_TURNS || "30", 10);
const DEFAULT_MODEL = process.env.BRIDGE_DEFAULT_MODEL || "claude-sonnet-4-6";
// Requested-id → real `claude --model` id. Data-driven (compose wires it from
// build.json runtime.model_aliases); unknown/absent ids fall back to DEFAULT_MODEL,
// so arbitrary client model strings keep working exactly as before.
const MODEL_ALIASES = JSON.parse(process.env.BRIDGE_MODEL_ALIASES || "{}");

// ── cross-device session store (per-device .jsonl blobs, WG-only) ─────────────
// SESSIONS_DIR is imported from sessions-store.mjs — the ONE declaration, the
// same module my-ai-api serves /sessions from. Devices PUT their recent Claude
// Code sessions here; any device can list/GET them to restore. Lives in the
// persistent claude_home volume. Data-driven from build.json runtime.sessions
// (dir under HOME, keep-per-device cap).
const SESSIONS_KEEP = parseInt(process.env.BRIDGE_SESSIONS_KEEP || "20", 10);
// Path components must be a single safe segment (no traversal, no separators).
const safeSeg = (s) => /^[A-Za-z0-9._-]+$/.test(s || "");

// ── #539/#545: the resume target ────────────────────────────────────────────
// :3117 must resume the saved orchestrator session instead of spawning a blank
// `claude -p` per message (the "Zero tasks" defect: a fresh session has no task
// store, so absence renders as a plausible number).
//
// #545: the target used to be DECLARED as a name in build.json — the session's
// SERVED name, as /sessions lists it. That was wrong at the root: a served name
// is derived from the newest `last-prompt` record and Claude Code writes one
// every turn, so the declared address went stale the moment Diego typed. It is
// now an OPTIONAL PIN: when it is declared AND still resolves through the #525
// resolver, it wins (set it only to something stable, e.g. a custom-title).
// Empty or stale, the target is DERIVED from the mounted task store instead —
// see deriveResumeSession in claude-resume.mjs.
const RESUME_SESSION_NAME = process.env.BRIDGE_RESUME_SESSION_NAME || "";
// #548: the project directory the resumed session belongs to. Claude keys its
// transcript store by BOTH the session uuid AND the cwd slug
// (~/.claude/projects/<cwd-slug>/<uuid>.jsonl), so `--resume <uuid>` only finds
// the session's files when the child spawn runs in the SAME cwd as the session.
// Declared in build.json runtime.resume_session.cwd alongside the name — the
// spawn below passes it as `cwd` on the child. Without it the resumed session
// resolves by uuid but reads nothing, which is the same "0 tasks" defect one
// layer up.
const RESUME_SESSION_CWD  = process.env.BRIDGE_RESUME_CWD || "";
// Resolved model ids that must NOT append into the resumed orchestrator
// session. Bulk indexing (cgc octocode asks for claude-haiku) must keep
// spawning fresh one-shot sessions; only the agent-facing default path resumes.
// Data-driven from build.json runtime.resume_session.exclude_models.
const RESUME_EXCLUDE_MODELS = new Set(JSON.parse(process.env.BRIDGE_RESUME_EXCLUDE_MODELS || "[]"));
// The mounted claude home — root of BOTH stores (transcripts under
// .claude/projects/<cwd-slug>/, task files under .claude/tasks/<uuid>/). One
// constant: the derivation and the reachability guard must read the same tree,
// or the resume would be addressed from one store and verified against another.
const CLAUDE_HOME = process.env.HOME || "/home/appuser";

const OLLAMA_PORT   = parseInt(process.env.BRIDGE_OLLAMA_PORT || "11434", 10);
const OLLAMA_BIND   = process.env.BRIDGE_OLLAMA_BIND || "127.0.0.1";
const OLLAMA_MODELS = (process.env.BRIDGE_OLLAMA_MODELS ||
  [...new Set([DEFAULT_MODEL, "claude", "claude-sonnet", ...Object.keys(MODEL_ALIASES)]
    .flatMap((n) => [n, `${n}:latest`]))].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

// ── Headroom compression hop (Python sidecar) ────────────────────────────────
const HR_ENABLED = (process.env.HEADROOM_ENABLED ?? "1") !== "0";
const HR_HOST    = process.env.HEADROOM_HOST || "127.0.0.1";
const HR_PORT    = parseInt(process.env.HEADROOM_PORT || "8787", 10);
const HR_PROFILE = process.env.HEADROOM_SAVINGS_PROFILE || "agent-90";
const HR_URL     = `http://${HR_HOST}:${HR_PORT}/compress`;

// ── concurrency semaphore ────────────────────────────────────────────────────
let active = 0;
const waiters = [];
const acquire = () =>
  active < MAX_CONC
    ? ((active++), Promise.resolve())
    : new Promise((res) => waiters.push(res)).then(() => { active++; });
const release = () => { active--; const w = waiters.shift(); if (w) w(); };

// ── cumulative accounting (cost + savings, surfaced via /health) ─────────────
const stats = {
  calls: 0, errors: 0,
  prompt_tokens: 0, completion_tokens: 0,
  tokens_before: 0, tokens_after: 0, tokens_saved: 0, compressions: 0,
  since: Math.floor(Date.now() / 1000),
};

// ── compress messages[] via the sidecar; degrade to passthrough on any failure ─
const compress = async (messages, model) => {
  if (!HR_ENABLED || !Array.isArray(messages) || messages.length === 0) return messages;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(HR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, model, savings_profile: HR_PROFILE }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) throw new Error(`compress ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j.messages)) {
      stats.compressions++;
      stats.tokens_before += j.tokens_before ?? 0;
      stats.tokens_after  += j.tokens_after ?? 0;
      stats.tokens_saved  += j.tokens_saved ?? 0;
      return j.messages;
    }
    return messages;
  } catch (e) {
    console.error(`[superset] compress passthrough (${e.message})`);
    return messages;
  }
};

// ── #539: name-served session listing ───────────────────────────────────────
// /sessions must serve the SAME rows the resolver matches against (#525: the
// resolver resolves the SERVED name). Mirrors my-ai-api's server.mjs listing,
// so the name comes from the one derivation (deriveSessionName, bounded reads)
// and every consumer (the bot, /sessions callers, resolveResumeAddress) sees
// exactly one identity per session. Unreadable rows are skipped, not fatal.
const listSessions = () => {
  const out = [];
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const device of fs.readdirSync(SESSIONS_DIR)) {
    const ddir = path.join(SESSIONS_DIR, device);
    if (!fs.statSync(ddir).isDirectory()) continue;
    for (const f of fs.readdirSync(ddir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(ddir, f);
      try {
        const st = fs.statSync(full);
        const { name, from } = deriveSessionName(full);
        out.push({ device, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size, name, name_from: from });
      } catch { /* unreadable row: skip rather than corrupt the listing */ }
    }
  }
  return out;
};

// ── messages[] → (system prompt, user prompt) for `claude -p` ─────────────────
const toPrompt = (messages = []) => {
  const sys = [], turns = [];
  for (const m of messages) {
    const content = Array.isArray(m.content)
      ? m.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
      : (m.content ?? "");
    if (m.role === "system") sys.push(content);
    else turns.push(`${(m.role || "user").toUpperCase()}: ${content}`);
  }
  return { system: sys.join("\n\n"), prompt: turns.join("\n\n") };
};

// Serve BRIDGE_DEFAULT_MODEL unless the requested id (sans :latest) is a declared
// alias in BRIDGE_MODEL_ALIASES — lets a caller pick e.g. haiku for bulk indexing
// while arbitrary/garbage client ids still land on the default.
const mapModel = (requested) =>
  MODEL_ALIASES[String(requested || "").replace(/:latest$/, "")] || DEFAULT_MODEL;

// ── #539: resume planning ────────────────────────────────────────────────────
// One envelope for every request: either the request resumes the DECLARED
// session, or it does not, or the store is unreachable and the turn must fail
// with WORDS. A count may only ever be emitted from a store that was actually
// read; a resolved-but-unreadable store must NEVER fall through to a blank
// session (that is exactly how absence rendered as "Zero"). The exclude list
// keeps bulk indexing (haiku) on fresh one-shot sessions: only the agent-facing
// default-model path appends into the saved orchestrator session.
//
// #545: the address is PIN → DERIVE → words, in that order.
//   1. PIN    — a declared name, resolved through #525's resolver. Optional, and
//              only worth declaring for something that does not drift (a
//              custom-title). A pin that matches nothing is NOT fatal: it falls
//              through, because a stale pin is exactly the failure being fixed.
//   2. DERIVE — the session under the declared project cwd holding the fullest
//              mounted task store. Nothing to go stale; self-corrects when the
//              orchestrator session rotates.
//   3. WORDS  — nothing addressable. One sentence per verdict, from the single
//              RESUME_ERROR_WORDS table, and never the word "unreachable" for
//              what was only an addressing miss.
// An AMBIGUOUS pin is the one pin failure that does NOT fall through: the user
// named several sessions, and deriving a different one instead would silently
// answer from a conversation they did not ask for.
const planResume = (model) => {
  if (!RESUME_SESSION_NAME && !RESUME_SESSION_CWD) return { mode: "none" };
  const resolved = mapModel(model);
  if (RESUME_EXCLUDE_MODELS.has(resolved)) return { mode: "none" };
  const rows = listSessions();

  if (RESUME_SESSION_NAME) {
    const verdict = resolveResumeAddress(rows, RESUME_SESSION_NAME);
    if (verdict.ok) {
      return { mode: "resume", sessionId: verdict.session.id, matchedBy: verdict.matchedBy };
    }
    if (verdict.ambiguous) {
      console.error(`[superset] resume refused: pin '${RESUME_SESSION_NAME}' is ambiguous — refusing to guess between sessions`);
      return { mode: "error", kind: "ambiguous" };
    }
    console.error(`[superset] declared pin '${RESUME_SESSION_NAME}' matched no session — deriving the target from the mounted task store instead`);
  }

  const derived = RESUME_SESSION_CWD ? deriveResumeSession(CLAUDE_HOME, RESUME_SESSION_CWD) : null;
  if (derived) return { mode: "resume", sessionId: derived.id, matchedBy: "task-store" };

  // Nothing addressable. Say WHICH store came up empty — the session listing or
  // the task store — because they fail for different reasons and send an
  // operator to different halves of the system.
  const kind = rows.length === 0 ? "session_store_void" : "unaddressed";
  console.error(`[superset] resume refused: ${kind} (pin='${RESUME_SESSION_NAME}' cwd='${RESUME_SESSION_CWD}' sessions=${rows.length}) — refusing to answer from a blank session`);
  return { mode: "error", kind };
};

// The exact words the chat sees when the TASK STORE itself could not be read —
// a genuine IO failure on a session that WAS addressed. Addressing failures get
// RESUME_ERROR_WORDS instead; conflating the two is what told Diego the store
// was unreachable in the same sentence as "no session matched that name".
// Deliberately number-free: a count may only ever be emitted by a store that
// was actually read.
const STORE_ERROR_WORDS = (reason) =>
  `[task store error] the task store is unreachable — I could not load the saved session, so no task count or status is available. reason: ${reason}`;

// When resuming, the session already holds the whole conversation — only the
// NEW user turn becomes the prompt. Sending the full history again would inject
// the conversation into itself as one giant user message.
const lastUserContent = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    return Array.isArray(m.content)
      ? m.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("")
      : (m.content ?? "");
  }
  return "";
};

// Two ways to be logged in, and the order matters.
//
// .credentials.json is the web-authenticated subscription login (the same one a
// browser /login writes) and it carries a refresh token, so the CLI renews it by
// itself and the container stays up indefinitely. oauth-token is what setup-token
// PRINTS: a static long-lived string with no refresh path, persisted by login.mjs.
//
// CLAUDE_CODE_OAUTH_TOKEN overrides the credentials file, so injecting a stale
// oauth-token silently shadows a perfectly good web login — that is exactly how
// this backend served "OAuth access token has been revoked" 502s while a valid
// credential sat in the same directory. So: credentials file wins when present,
// token file is the fallback. Both are read per spawn, so a fresh login takes
// effect without a container restart.
const CREDENTIALS_FILE = process.env.CLAUDE_CREDENTIALS_FILE || "/home/appuser/.claude/.credentials.json";
const claudeEnv = () => {
  const env = { ...process.env };
  try {
    if (fs.readFileSync(CREDENTIALS_FILE, "utf8").trim()) {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      return env;
    }
  } catch { /* no web login persisted — fall through to the static token */ }
  try {
    const token = fs.readFileSync(process.env.CLAUDE_OAUTH_TOKEN_FILE || "/home/appuser/.claude/oauth-token", "utf8").trim();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  } catch { /* no token persisted yet */ }
  return env;
};

// ── one claude -p invocation ─────────────────────────────────────────────────
const callClaude = ({ system, prompt, model, resumeId = null }) =>
  new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--max-turns", String(MAX_TURNS), "--model", mapModel(model)];
    // #539: resume the DECLARED session instead of spawning a blank one. The
    // id comes from resolveResumeAddress (name → session), never from source.
    if (resumeId) args.push("--resume", resumeId);
    if (system) args.push("--append-system-prompt", system);
    // #548: the child must run in the session's project cwd so --resume finds
    // the transcript under the matching <cwd-slug> (keyed by cwd AND uuid). A
    // resolved uuid with the wrong cwd finds nothing — same 0-tasks defect.
    const spawnOpts = { cwd: resumeId && RESUME_SESSION_CWD ? RESUME_SESSION_CWD : undefined };
    const child = spawn(CLAUDE_BIN, args, {
      env: { ...claudeEnv(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOpts,
    });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude -p timeout")); }, CALL_TIMEOUT);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // The "Not logged in · Please run /login" message is written to stdout, not
        // stderr, so fall back to the stdout tail when stderr is empty, and classify
        // the auth-required case explicitly so callers can react (e.g. auto-send a
        // login link) instead of seeing an opaque exit-code failure.
        // The reason lives in the JSON's `result` field, which on a failure sits far
        // past any tail slice — a raw 500-char prefix is all envelope and no cause,
        // which is exactly the opaque "[gateway error 502] claude -p exit 1:
        // {duration_api_ms:0,...}" the bot used to relay. Read the field.
        let reason = "";
        try {
          const j = JSON.parse(out);
          reason = [j.result, j.terminal_reason].filter(Boolean).join(" · ");
        } catch { /* not JSON (crash, truncated output) — the tail is all there is */ }
        const tail = (reason || err || out).slice(0, 500);
        // Match BOTH streams, not `err || out`: any stderr noise at all used to hide
        // the stdout message and downgrade a known auth failure to an opaque exit
        // code. A revoked token is the same class of problem as never having logged
        // in — both need a human at a browser — so they classify together.
        const both = `${err}\n${out}`;
        // Expiry belongs in here too, not just revocation: a web login whose refresh
        // token has run out fails exactly like never having logged in, and the bot
        // only offers its /login link when it recognises the failure as an auth one.
        // The signatures are declared ONCE in login.mjs — never inline here.
        if (isAuthRequired(both)) {
          return reject(new Error(`claude-cli auth required — run 'claude setup-token' and refresh the container's oauth-token: ${tail}`));
        }
        return reject(new Error(`claude -p exit ${code}: ${tail}`));
      }
      try {
        const j = JSON.parse(out);
        resolve({ text: j.result ?? "", usage: j.usage ?? {} });
      } catch (e) { reject(new Error(`bad claude json: ${e.message}: ${out.slice(0, 300)}`)); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });

const withRetry = async (fn) => { try { return await fn(); } catch { return await fn(); } };

// run the full pipeline (compress → claude) and tally cost stats
const run = async (messages, model) => {
  const plan = planResume(model);
  // #539: an unresolvable declared target must NEVER fall through to a blank
  // session — the reply is the WORDED error, never a number, never a plausible
  // guess. Logged loudly above; the 200 wraps it so the chat relays the words
  // verbatim instead of prefixing them with a numeric gateway error status.
  if (plan.mode === "error") {
    // #545: one sentence per verdict, looked up — not one sentence with the
    // verdict pasted into it. The old form said "the task store is unreachable"
    // for an addressing miss, which is a claim about IO the code never made.
    return { text: RESUME_ERROR_WORDS[plan.kind] ?? RESUME_ERROR_WORDS.unaddressed, usage: { input_tokens: 0, completion_tokens: 0 } };
  }
  // Resumed: the saved session already holds the conversation and its tools, so
  // only the NEW user turn goes in — no re-compression of history the session
  // already carries, no re-append of a system prompt it already has.
  if (plan.mode === "resume") {
    // #548: the resolved NAME is not enough — its mounted task store must be
    // readable, or a TaskList read would legitimately see nothing. Resolving a
    // name proves the session exists in the transcript store; it proves nothing
    // about the mounted task store this spawn would resume. If the task store
    // is unreachable, fail with WORDS exactly like the name-error above — never
    // spawn a claude whose answer would be a confident zero from an empty dir.
    const unreachable = assertTaskStoreReachable({ claudeHome: CLAUDE_HOME, session: plan.sessionId });
    if (unreachable) {
      return { text: STORE_ERROR_WORDS(unreachable.message), usage: { input_tokens: 0, completion_tokens: 0 } };
    }
    const prompt = lastUserContent(messages);
    const { text, usage } = await withRetry(() => callClaude({ system: "", prompt, model, resumeId: plan.sessionId }));
    stats.calls++;
    stats.prompt_tokens += usage.input_tokens ?? 0;
    stats.completion_tokens += usage.output_tokens ?? 0;
    return { text, usage };
  }
  const compressed = await compress(messages, model);
  const { system, prompt } = toPrompt(compressed);
  const { text, usage } = await withRetry(() => callClaude({ system, prompt, model }));
  stats.calls++;
  stats.prompt_tokens += usage.input_tokens ?? 0;
  stats.completion_tokens += usage.output_tokens ?? 0;
  return { text, usage };
};

// ── response envelopes ───────────────────────────────────────────────────────
const openaiEnvelope = (model, text, usage) => ({
  id: `chatcmpl-superset-${Date.now() % 1e9}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model,
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
  },
});

const anthropicEnvelope = (model, text, usage) => ({
  id: `msg_superset_${Date.now() % 1e9}`,
  type: "message",
  role: "assistant",
  model,
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: usage.output_tokens ?? 0 },
});

const readBody = (req) =>
  new Promise((res, rej) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); req.on("error", rej); });

// ── Anthropic /v1/messages (so `ANTHROPIC_BASE_URL=<superset> claude` works) ──
const handleAnthropic = async (payload, res) => {
  // system may be a string or an array of content blocks; fold into a system msg.
  const messages = [];
  if (payload.system) {
    const sysText = Array.isArray(payload.system)
      ? payload.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n\n")
      : payload.system;
    messages.push({ role: "system", content: sysText });
  }
  for (const m of payload.messages || []) messages.push(m);
  const model = payload.model || DEFAULT_MODEL;
  const { text, usage } = await run(messages, model);

  if (!payload.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(anthropicEnvelope(model, text, usage)));
  }
  // Minimal valid Anthropic SSE: full text delivered in one content_block_delta.
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = `msg_superset_${Date.now() % 1e9}`;
  ev("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input_tokens ?? 0, output_tokens: 0 } } });
  ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  ev("content_block_stop", { type: "content_block_stop", index: 0 });
  ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output_tokens ?? 0 } });
  ev("message_stop", { type: "message_stop" });
  res.end();
};

const server = http.createServer(async (req, res) => {
  const send = (code, obj, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  const isOllama = req.url.startsWith("/api/");

  // ── interactive login (see login.mjs) ─────────────────────────────────────
  // POST /auth/login/start        → { session_id, url } — child stays alive
  // POST /auth/login/code {code}  → { ok, message }
  // GET  /auth/login/status       → { pending, session_id }
  // Reachable only over the WG-only listener; the Telegram allowlist is the
  // human-facing gate (see my-ai-api's /login command).
  if (req.url.startsWith("/auth/login")) {
    try {
      if (req.method === "GET" && req.url.startsWith("/auth/login/status"))
        return send(200, loginStatus());
      if (req.method === "POST" && req.url.startsWith("/auth/login/start")) {
        const r = await startLogin({ claudeBin: CLAUDE_BIN });
        return send(r.ok ? 200 : 502, r);
      }
      if (req.method === "POST" && req.url.startsWith("/auth/login/code")) {
        let body = {};
        try { body = JSON.parse(await readBody(req)); } catch { /* fall through */ }
        if (!body.code) return send(400, { ok: false, error: "missing code" });
        const r = await submitCode(String(body.code));
        return send(r.ok ? 200 : 502, r);
      }
    } catch (e) { return send(500, { ok: false, error: String(e.message || e) }); }
    return send(404, { error: { message: "not found" } });
  }

  // ── cross-device session store ────────────────────────────────────────────
  // GET  /sessions                    → [{device,id,mtime,size,name,name_from}]
  // GET  /sessions/<device>/<id>      → raw .jsonl
  // PUT  /sessions/<device>/<id>      → store .jsonl (prunes device to KEEP)
  // The name on every row is served from the ONE derivation (deriveSessionName)
  // so the #525 resolver matches against the SAME names /resume advertises.
  if (req.url === "/sessions" || req.url.startsWith("/sessions/")) {
    const parts = req.url.split("?")[0].split("/").filter(Boolean); // ["sessions", device?, id?]
    try {
      if (req.method === "GET" && parts.length === 1) {
        return send(200, listSessions());
      }
      if (parts.length === 3) {
        const [, device, id] = parts;
        if (!safeSeg(device) || !safeSeg(id)) return send(400, { error: { message: "bad device/id" } });
        const ddir = path.join(SESSIONS_DIR, device);
        const file = path.join(ddir, `${id}.jsonl`);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) return send(404, { error: { message: "no such session" } });
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          return res.end(fs.readFileSync(file));
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          fs.mkdirSync(ddir, { recursive: true });
          fs.writeFileSync(file, body);
          // Prune this device to the newest SESSIONS_KEEP files.
          const files = fs.readdirSync(ddir).filter((f) => f.endsWith(".jsonl"))
            .map((f) => ({ f, m: fs.statSync(path.join(ddir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
          for (const { f } of files.slice(SESSIONS_KEEP)) fs.rmSync(path.join(ddir, f), { force: true });
          return send(200, { ok: true, device, id });
        }
      }
    } catch (e) { return send(500, { error: { message: String(e.message || e) } }); }
    return send(404, { error: { message: "not found" } });
  }

  // ── health + model discovery (all shapes) ─────────────────────────────────
  if (req.method === "GET" && (req.url === "/health" || req.url === "/"))
    return send(200, { status: "ok", active, max: MAX_CONC, headroom: HR_ENABLED, stats });
  if (req.method === "GET" && req.url.startsWith("/v1/models"))
    return send(200, { object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "my-ai_claude-api" }] });
  if (req.method === "GET" && req.url.startsWith("/api/version")) return send(200, { version: "0.5.7" });
  if (req.method === "GET" && req.url.startsWith("/api/tags"))
    return send(200, { models: OLLAMA_MODELS.map((n) => ({
      name: n, model: n, modified_at: new Date().toISOString(), size: 0, digest: "",
      details: { format: "gguf", family: "claude", families: ["claude"], parameter_size: "", quantization_level: "" },
    })) });

  if (req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return send(400, { error: { message: "invalid JSON body" } }); }

    await acquire();
    try {
      // Anthropic Messages API — branch first (it's also a POST with messages).
      if (req.url.startsWith("/v1/messages")) return await handleAnthropic(payload, res);

      if (!Array.isArray(payload.messages)) return send(404, { error: { message: "no messages in body" } });
      const model = payload.model || DEFAULT_MODEL;
      const { text, usage } = await run(payload.messages, model);
      const pe = usage.input_tokens ?? 0, ec = usage.output_tokens ?? 0;

      if (isOllama) {
        const now = new Date().toISOString();
        const done = { model, created_at: now, message: { role: "assistant", content: payload.stream ? "" : text }, done: true, done_reason: "stop", total_duration: 0, prompt_eval_count: pe, eval_count: ec };
        if (payload.stream) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(JSON.stringify({ model, created_at: now, message: { role: "assistant", content: text }, done: false }) + "\n");
          res.write(JSON.stringify(done) + "\n");
          res.end();
        } else { send(200, done); }
      } else if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const base = { id: `chatcmpl-superset-${Date.now() % 1e9}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        send(200, openaiEnvelope(model, text, usage));
      }
    } catch (e) {
      stats.errors++;
      // Surface the claude-cli logged-out case as 401 with a distinct error type so
      // downstream callers (e.g. the telegram bot) can detect it and auto-send the
      // OAuth login link instead of treating it as a generic upstream failure.
      const message = String(e.message || e);
      // Same ONE declared list as the spawn classifier above (login.mjs): an
      // error that reaches here un-normalized — e.g. the CLI's own "Failed to
      // authenticate: OAuth session expired and could not be refreshed" — must
      // still come out as 401 auth_required, not a generic 502 JSON blob.
      if (isAuthRequired(message)) {
        send(401, { error: { message, type: "superset_claude_auth_required" } });
      } else {
        send(502, { error: { message, type: "superset_claude_error" } });
      }
    } finally { release(); }
    return;
  }
  send(404, { error: { message: "not found" } });
});

const handler = server.listeners("request")[0];
server.listen(PORT, BIND, () =>
  console.error(`[superset] API (OpenAI /v1 + Ollama /api + Anthropic /v1/messages) on http://${BIND}:${PORT} (model=${DEFAULT_MODEL}, conc=${MAX_CONC}, headroom=${HR_ENABLED})`));

// Second listener: Ollama's default host (11434) so an `ollama:` provider reaches
// us with zero config. Same handler, all shapes.
if (OLLAMA_PORT && !(OLLAMA_BIND === BIND && OLLAMA_PORT === PORT)) {
  const ollama = http.createServer(handler);
  ollama.on("error", (e) =>
    console.error(`[superset] Ollama mimic listener on ${OLLAMA_BIND}:${OLLAMA_PORT} disabled (${e.code || e.message}); /v1 API still up`));
  ollama.listen(OLLAMA_PORT, OLLAMA_BIND, () =>
    console.error(`[superset] Ollama mimic on http://${OLLAMA_BIND}:${OLLAMA_PORT} (/api/chat, /api/tags)`));
}
