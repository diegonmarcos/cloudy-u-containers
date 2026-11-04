#!/usr/bin/env node
// my-ai-api — front multiplexer. One process speaks three API shapes, all
// routed through one of three agent backends, with a plugin pipeline in front:
//
//   OpenAI    /v1/chat/completions   ─┐
//   Ollama    /api/chat, /api/tags    ├─→ RTK → Caveman → Headroom → agent backend
//   Anthropic /v1/messages           ─┘
//
// Plugins (all degrade to passthrough on error):
//   RTK       — strips ANSI + truncates noisy tool-result blobs before compression
//   Caveman   — filler-phrase stripping in the Python sidecar (CAVEMAN_ENABLED)
//   Ponytail  — per-request compression aggressiveness (X-Ponytail-Mode: off|lite|full|ultra)
//   Headroom  — token compression via Python sidecar (always on by default)
//
// Agent modes (X-Agent-Mode header, or model-name prefix):
//   claude-cli — forward to claude-superset-api (CLAUDE_CLI_BASE_URL, WG-only)
//   goose      — OpenRouter with GOOSE_MODEL (forwarded like hermes, no local binary)
//   hermes     — the Hermes Agent's own API (HERMES_API_KEY set), else OpenRouter with HERMES_MODEL
//   openclaw   — the OpenClaw gateway's own API (cloud-agi-openclaw, loopback)
//   deepseek   — the DeepSeek harness: a DeepSeek model (request's deepseek/… or DEEPSEEK_MODEL) + the MCP tool loop
//   openrouter / (default) — OpenRouter with the requested model
// GET /health lists them all under `modes` (see modes() below).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { runAgenticLoop, mcpEnabled, metaTools, MCP_ENABLED, searchTools, getServerCounts } from "./mcp.mjs";
import { SESSIONS_DIR, readTailBytes, deriveSessionName } from "./sessions-store.mjs";
import { postJson } from "./http-post.mjs";

const PORT          = parseInt(process.env.BRIDGE_PORT || "3217", 10);
const BIND          = process.env.BRIDGE_BIND || "127.0.0.1";
const MAX_CONC      = parseInt(process.env.BRIDGE_MAX_CONCURRENCY || "12", 10);
const CALL_TIMEOUT  = parseInt(process.env.BRIDGE_CALL_TIMEOUT_MS || "180000", 10);
const DEFAULT_MODEL = process.env.BRIDGE_DEFAULT_MODEL || "z-ai/glm-5";
const MODEL_ALIASES = JSON.parse(process.env.BRIDGE_MODEL_ALIASES || "{}");

// ── OpenRouter upstream ───────────────────────────────────────────────────────
const UP_BASE  = process.env.UPSTREAM_BASE_URL || "https://openrouter.ai/api/v1";
const UP_CHAT  = process.env.UPSTREAM_CHAT_PATH || "/chat/completions";
const UP_MODELS= process.env.UPSTREAM_MODELS_PATH || "/models";
const UP_KEY   = process.env.OPENROUTER_API_KEY || process.env.UPSTREAM_API_KEY || "";
const UP_PASSTHROUGH_AUTH = (process.env.UPSTREAM_PASSTHROUGH_AUTH ?? "0") === "1";
const UP_REFERER = process.env.UPSTREAM_HTTP_REFERER || "https://my-ai-api.mesh.diegonmarcos.com";
const UP_TITLE   = process.env.UPSTREAM_HTTP_TITLE   || "my-ai-api";
if (!UP_KEY) console.error("[my-ai-api] WARNING: OPENROUTER_API_KEY unset — chat requests will 502 until the secret is wired (src/secrets.yaml)");

// ── Agent mode backends ───────────────────────────────────────────────────────
// claude-cli: route to claude-superset-api (speaks OpenAI shape, WG-only)
const CLAUDE_CLI_BASE = process.env.CLAUDE_CLI_BASE_URL || "";
const CLAUDE_CLI_CHAT = process.env.CLAUDE_CLI_CHAT_PATH || "/v1/chat/completions";
// goose: OpenRouter model slug (forwarded like hermes, no local binary)
const GOOSE_MODEL = process.env.GOOSE_MODEL || DEFAULT_MODEL;
// hermes: OpenRouter model slug for Nous Hermes
const HERMES_MODEL = process.env.HERMES_MODEL || "nousresearch/hermes-3-llama-3.1-405b:free";

// deepseek: the DeepSeek harness — DeepSeek's own models on OpenRouter driven
// through this gateway's MCP tool loop (the same tools goose and hermes get).
// The request may pick any DeepSeek model (deepseek/…, e.g. v4-pro or r1);
// anything else falls back to DEEPSEEK_MODEL, so the mode never runs a
// non-DeepSeek model under the DeepSeek name.
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek/deepseek-v4-pro-0813";
const deepseekModel = (requested) => (/^deepseek\//.test(String(requested || "")) ? String(requested) : DEEPSEEK_MODEL);

// ── Native agent APIs on this host's loopback ────────────────────────────────
// Both run with network_mode host on oci-apps and listen on 127.0.0.1 only, so
// this gateway (also host network) is the one way the mesh reaches them. The
// defaults are the ports their own build.json files declare
// (user-ai_openclaw ports.app, user-ai_hermes-agent ports.api);
// test-my-ai-native-agents.mjs fails if either drifts from its declaration.
//
// openclaw — the OpenClaw gateway (cloud-agi-openclaw). Its OpenAI-compatible
//   /v1/chat/completions runs a real OpenClaw agent turn; the `model` field
//   names the agent target, not a provider model (OpenClaw's own config picks
//   that). Loopback with gateway.auth.mode "none", so no credential exists to
//   hold here.
// hermes (native) — the Hermes Agent API server (cloud-agi-hermes): the real
//   agent with its skills, memory, sessions and toolsets, where the plain
//   `hermes` mode below is only the Hermes model behind this gateway's MCP
//   loop. It takes Bearer API_SERVER_KEY, delivered here as HERMES_API_KEY by
//   the .secrets env_file (src/secrets.yaml). Without it the hermes mode stays
//   the OpenRouter forward and /health says native:false — never a guess.
const OPENCLAW_BASE   = process.env.OPENCLAW_BASE_URL ?? "http://127.0.0.1:18789";
const OPENCLAW_AGENT  = process.env.OPENCLAW_AGENT || "openclaw/default";
const HERMES_API_BASE = process.env.HERMES_API_BASE_URL ?? "http://127.0.0.1:8642";
const HERMES_API_KEY  = process.env.HERMES_API_KEY || "";
const HERMES_API_MODEL = process.env.HERMES_API_MODEL || "hermes-agent";
const PROBE_TTL_MS    = parseInt(process.env.BRIDGE_PROBE_TTL_MS || "30000", 10);
const PROBE_TIMEOUT_MS = parseInt(process.env.BRIDGE_PROBE_TIMEOUT_MS || "1500", 10);

// Read-only functions each native agent publishes to the app's More sheet,
// served at GET /agents/<agent>/<fn>. An allowlist: nothing that writes, and no
// path the caller chooses.
const NATIVE = {
  hermes: {
    base: HERMES_API_BASE,
    enabled: () => !!HERMES_API_KEY,
    auth: () => ({ authorization: `Bearer ${HERMES_API_KEY}` }),
    functions: {
      skills:   { label: "Skills",          path: "/v1/skills" },
      toolsets: { label: "Toolsets",        path: "/v1/toolsets" },
      sessions: { label: "Hermes sessions", path: "/api/sessions" },
      jobs:     { label: "Scheduled jobs",  path: "/api/jobs" },
      models:   { label: "Models",          path: "/v1/models" },
    },
  },
  openclaw: {
    base: OPENCLAW_BASE,
    enabled: () => !!OPENCLAW_BASE,
    auth: () => ({}),
    functions: {
      agents: { label: "Agent targets", path: "/v1/models" },
    },
  },
};

// Liveness of each native agent, probed on its unauthenticated /health and
// cached so the docker healthcheck and the app's polling never pile up probes.
const probes = {};
const probeNative = async (name) => {
  const n = NATIVE[name];
  if (!n.enabled()) return false;
  const hit = probes[name];
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.up;
  let up = false;
  try {
    const r = await fetch(`${n.base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    up = r.ok;
  } catch { up = false; }
  probes[name] = { at: Date.now(), up };
  return up;
};

// ── cross-device session store ─────────────────────────────────────────────
// SESSIONS_DIR is declared ONCE in sessions-store.mjs and shared — this server
// serves it, route.mjs persists the telegram bots' chat history into it. The
// SESSIONS_KEEP prune below applies to PUT writes through this endpoint.
const SESSIONS_KEEP = parseInt(process.env.BRIDGE_SESSIONS_KEEP || "20", 10);
const safeSeg = (s) => /^[A-Za-z0-9._-]+$/.test(s || "");

const OLLAMA_PORT   = parseInt(process.env.BRIDGE_OLLAMA_PORT || "12436", 10);
const OLLAMA_BIND   = process.env.BRIDGE_OLLAMA_BIND || "127.0.0.1";
const OLLAMA_MODELS = (process.env.BRIDGE_OLLAMA_MODELS ||
  [...new Set([DEFAULT_MODEL, ...Object.keys(MODEL_ALIASES)]
    .flatMap((n) => [n, `${n}:latest`]))].join(","))
  .split(",").map((s) => s.trim()).filter(Boolean);

// ── Plugin: Headroom compression sidecar ────────────────────────────────────
const HR_ENABLED = (process.env.HEADROOM_ENABLED ?? "1") !== "0";
const HR_HOST    = process.env.HEADROOM_HOST || "127.0.0.1";
const HR_PORT    = parseInt(process.env.HEADROOM_PORT || "8890", 10);
const HR_PROFILE = process.env.HEADROOM_SAVINGS_PROFILE || "agent-90";
const HR_URL     = `http://${HR_HOST}:${HR_PORT}/compress`;

// ── Plugin: RTK — tool-result noise stripping ────────────────────────────────
const RTK_ENABLED   = (process.env.RTK_ENABLED ?? "1") !== "0";
const RTK_MAX_CHARS = parseInt(process.env.RTK_MAX_TOOL_CHARS || "8000", 10);

// ── Plugin: Caveman — linguistic filler stripping (lives in the Python sidecar)
const CAVEMAN_ENABLED = (process.env.CAVEMAN_ENABLED ?? "1") !== "0";

// ── Plugin: Ponytail — per-request compression aggressiveness ────────────────
// off→no compression, lite→agent-50, full→agent-90 (default), ultra→agent-95
// Override per-request via X-Ponytail-Mode header.
const PONYTAIL_PROFILES = { off: null, lite: "agent-50", full: "agent-90", ultra: "agent-95" };
const PONYTAIL_DEFAULT  = process.env.PONYTAIL_DEFAULT_MODE || "full";

// ── Plugin: Principles — system-prompt injection ──────────────────────────────
// Agents-principles: agent role definitions; Cloud-principles: infra rules.
// Baked into the image at /app/principles/; loaded once at startup.
const AGENTS_PRINCIPLES_ENABLED = (process.env.AGENTS_PRINCIPLES_ENABLED ?? "1") !== "0";
const CLOUD_PRINCIPLES_ENABLED  = (process.env.CLOUD_PRINCIPLES_ENABLED  ?? "1") !== "0";
const PRINCIPLES_DIR = process.env.PRINCIPLES_DIR || "/app/principles";
const _loadPrinciple = (name) => { try { return fs.readFileSync(path.join(PRINCIPLES_DIR, name), "utf8").trim(); } catch { return ""; } };
const AGENTS_PRINCIPLES = AGENTS_PRINCIPLES_ENABLED ? _loadPrinciple("agents.md") : "";
const CLOUD_PRINCIPLES  = CLOUD_PRINCIPLES_ENABLED  ? _loadPrinciple("cloud.md")  : "";

// ── #556: the agentic memory system ──────────────────────────────────────────
// The goose and hermes modes here are OpenRouter forwards, so this system
// message is the ONLY context surface they have — there is no session hook and
// no CLAUDE.md on this path. The briefing is NOT written here: it comes from
// AGENT_MEMORY_BRIEFING, declared once in _shared/engine.nix and published to
// every container with agent.git_tree. Retyping the store's path into this file
// would recreate the defect the ticket is about (measured 2026-09-24: claude had
// AGENT_MEMORY_DIR, goose and hermes had nothing).
//
// The POINTER, never the index. The index is ~170 pointer lines and is read on
// demand with the tools the agentic path has; pasting it into every chat request
// is the same bulk-load that took a session preload from 4.5k to 87k tokens.
const AGENT_MEMORY_BRIEFING = (process.env.AGENT_MEMORY_BRIEFING || "").trim();
if (!AGENT_MEMORY_BRIEFING) {
  console.warn("[my-ai] WARNING: AGENT_MEMORY_BRIEFING unset — goose/hermes modes answer WITHOUT recall of previous sessions");
}

// ── concurrency semaphore ────────────────────────────────────────────────────
let active = 0;
const waiters = [];
const acquire = () =>
  active < MAX_CONC
    ? ((active++), Promise.resolve())
    : new Promise((res) => waiters.push(res)).then(() => { active++; });
const release = () => { active--; const w = waiters.shift(); if (w) w(); };

// ── cumulative accounting ────────────────────────────────────────────────────
const stats = {
  calls: 0, errors: 0,
  prompt_tokens: 0, completion_tokens: 0,
  tokens_before: 0, tokens_after: 0, tokens_saved: 0, compressions: 0,
  upstream: "openrouter", model: DEFAULT_MODEL,
  since: Math.floor(Date.now() / 1000),
};

// ── per-request plugin toggle overrides ──────────────────────────────────────
// Request headers x-rtk / x-headroom / x-caveman / x-principles override the
// corresponding env default when present (on/off/1/0/true/false, case-insensitive).
// Header absent ⇒ use the existing env default unchanged.
const TRUE_VALS  = new Set(["on", "1", "true"]);
const FALSE_VALS = new Set(["off", "0", "false"]);
const headerBool = (headers, name, envDefault) => {
  const v = (headers?.[name] || "").toLowerCase().trim();
  if (TRUE_VALS.has(v)) return true;
  if (FALSE_VALS.has(v)) return false;
  return envDefault;
};

// ── Plugin: Principles — prepend system context ───────────────────────────────
const injectPrinciples = (messages, headers) => {
  const principlesOn = headerBool(headers, "x-principles", AGENTS_PRINCIPLES_ENABLED || CLOUD_PRINCIPLES_ENABLED);
  if (!principlesOn) return messages;
  const parts = [];
  if (CLOUD_PRINCIPLES)  parts.push(CLOUD_PRINCIPLES);
  if (AGENTS_PRINCIPLES) parts.push(AGENTS_PRINCIPLES);
  // #556 — travels with the principles: the same x-principles toggle, because a
  // request that opts out of injected context should not silently keep one half.
  if (AGENT_MEMORY_BRIEFING) parts.push(AGENT_MEMORY_BRIEFING);
  if (parts.length === 0) return messages;
  const principles = parts.join("\n\n---\n\n");
  const sys = messages.find((m) => m.role === "system");
  if (sys) {
    return messages.map((m) =>
      m.role === "system" ? { ...m, content: `${principles}\n\n---\n\n${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}` } : m
    );
  }
  return [{ role: "system", content: principles }, ...messages];
};

// ── Plugin: RTK implementation ───────────────────────────────────────────────
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const applyRTK = (messages, headers) => {
  if (!headerBool(headers, "x-rtk", RTK_ENABLED) || !Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg) return msg;
    const isToolMsg = msg.role === "tool" ||
      (Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool_result"));
    if (!isToolMsg) return msg;
    const clean = (text) => {
      if (typeof text !== "string") return text;
      let t = text.replace(ANSI_RE, "");
      t = t.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
      if (t.length > RTK_MAX_CHARS) {
        const head = Math.floor(RTK_MAX_CHARS * 0.7);
        const tail = RTK_MAX_CHARS - head;
        t = `${t.slice(0, head)}\n…[RTK: ${text.length - RTK_MAX_CHARS} chars trimmed]…\n${t.slice(-tail)}`;
      }
      return t;
    };
    if (typeof msg.content === "string") return { ...msg, content: clean(msg.content) };
    if (Array.isArray(msg.content)) {
      return {
        ...msg,
        content: msg.content.map((b) => {
          if (!b) return b;
          if (b.type === "tool_result") {
            if (typeof b.content === "string") return { ...b, content: clean(b.content) };
            if (Array.isArray(b.content))
              return { ...b, content: b.content.map((i) => i?.type === "text" ? { ...i, text: clean(i.text) } : i) };
          }
          if (b.type === "text") return { ...b, text: clean(b.text) };
          return b;
        }),
      };
    }
    return msg;
  });
};

// jev:begin  #882 S9 — Jev may pick a model TIER when the request names no model. Advisory: explicit `model` and
// the x-jev header win, and ANY doubt (no BRIDGE_TIER_MODELS, no sidecar/key, timeout, gate closed, not
// confident, unmapped tier) returns null so the caller keeps DEFAULT_MODEL exactly as before.
// BRIDGE_TIER_MODELS = {"fast":"<model>","strong":"<model>"} declares the tiers (unset = Jev never asked).
const jevTier = async (messages, headers, env = process.env, fetchImpl = globalThis.fetch) => {
  try {
    if ((headers?.["x-jev"] || "").toLowerCase() === "off" || env.JEV_ROUTER === "0") return null;
    const tiers = JSON.parse(env.BRIDGE_TIER_MODELS || "null");
    if (!tiers || typeof tiers !== "object" || Object.keys(tiers).length < 2) return null;
    const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m?.role === "user");
    const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(env.JEV_TIMEOUT_MS || 2500));
    try {
      const res = await fetchImpl(`${env.JEV_SIDECAR_URL || "http://10.0.0.6:3110"}/decide/router_tier`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({
          state: { last_message: text.slice(0, 1500), history_length: Array.isArray(messages) ? messages.length : 0 },
          questions: { tier: { type: "choice",
            instructions: "Which model tier is enough to answer `last_message` well, given `history_length` earlier messages?",
            criteria: Object.fromEntries(Object.keys(tiers).map((k) => [k, `The ${k} tier is the right size for this request.`])) } },
        }),
      });
      if (!res.ok) return null;
      const ans = await res.json();
      const r = ans?.ok === true ? ans.results?.tier : null;
      return r && r.confident === true && typeof tiers[r.pick] === "string" ? tiers[r.pick] : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
};
// #882 S9 Ponytail: the compression profile when the request names none (no x-ponytail-mode header; bots send it
// only when a chat pinned one). Options are lite|full|ultra - NEVER "off": Jev may tune compression, not remove it.
// Same doubt rule as jevTier: any failure/doubt returns null and getPonytailProfile keeps PONYTAIL_DEFAULT.
const jevPonytail = async (messages, headers, env = process.env, fetchImpl = globalThis.fetch) => {
  try {
    if (headers?.["x-ponytail-mode"] || (headers?.["x-jev"] || "").toLowerCase() === "off" || env.JEV_ROUTER === "0") return null;
    const arr = Array.isArray(messages) ? messages : [];
    const chars = arr.reduce((n, m) => n + (typeof m?.content === "string" ? m.content.length : JSON.stringify(m?.content ?? "").length), 0);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(env.JEV_TIMEOUT_MS || 2500));
    try {
      const res = await fetchImpl(`${env.JEV_SIDECAR_URL || "http://10.0.0.6:3110"}/decide/router_ponytail`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({
          state: { history_length: arr.length, total_chars: chars },
          questions: { profile: { type: "choice",
            instructions: "How aggressively can this conversation's context be compressed (`history_length` messages, `total_chars` characters) without losing what the next answer needs?",
            criteria: { lite: "Little compression: short or precise context where every word matters.",
                        full: "The usual compression.",
                        ultra: "Heavy compression: long, repetitive context." } } },
        }),
      });
      if (!res.ok) return null;
      const ans = await res.json();
      const r = ans?.ok === true ? ans.results?.profile : null;
      return r && r.confident === true && ["lite", "full", "ultra"].includes(r.pick) ? r.pick : null;
    } finally { clearTimeout(timer); }
  } catch { return null; }
};
// jev:end

// ── Plugin: Ponytail profile resolver ────────────────────────────────────────
const getPonytailProfile = (headers, advised = null) => {
  const mode = ((headers?.["x-ponytail-mode"] || "") || advised || PONYTAIL_DEFAULT).toLowerCase().trim();
  return (mode in PONYTAIL_PROFILES) ? PONYTAIL_PROFILES[mode] : HR_PROFILE;
};

// ── Plugin: Headroom compress (calls Python sidecar) ─────────────────────────
const compress = async (messages, model, savingsProfile, headers) => {
  const profile = savingsProfile !== undefined ? savingsProfile : HR_PROFILE;
  if (profile === null) return messages; // Ponytail "off"
  if (!headerBool(headers, "x-headroom", HR_ENABLED) || !Array.isArray(messages) || messages.length === 0) return messages;
  const cavemanEnabled = headerBool(headers, "x-caveman", CAVEMAN_ENABLED);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const r = await fetch(HR_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, model, savings_profile: profile, caveman_enabled: cavemanEnabled }),
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
    console.error(`[my-ai-api] compress passthrough (${e.message})`);
    return messages;
  }
};

// ── full plugin pipeline: Principles → RTK → Headroom (Caveman in sidecar) ───
const pipeline = async (messages, model, headers) => {
  const withPrinciples = injectPrinciples(messages, headers);
  const rtkd = applyRTK(withPrinciples, headers);
  return compress(rtkd, model, getPonytailProfile(headers, await jevPonytail(rtkd, headers)), headers);
};

// ── Agent mode detection ──────────────────────────────────────────────────────
// Priority: X-Agent-Mode header > model prefix > DEFAULT_MODEL mapping
const getAgentMode = (headers, model) => {
  const hdr = (headers?.["x-agent-mode"] || "").toLowerCase().trim();
  if (hdr === "claude-cli" || hdr === "claude") return "claude-cli";
  if (hdr === "goose") return "goose";
  if (hdr === "hermes") return "hermes";
  if (hdr === "openclaw") return "openclaw";
  if (hdr === "deepseek") return "deepseek";
  // Explicit, so a catalogue id such as "claude-…" cannot re-route a plain
  // OpenRouter chat to the claude CLI through the model-prefix rules below.
  if (hdr === "openrouter") return "openrouter";
  const m = String(model || "").toLowerCase();
  if (m === "goose" || m.startsWith("goose/") || m.startsWith("goose:")) return "goose";
  if (m === "hermes" || m.startsWith("hermes/") || m.startsWith("nous/")) return "hermes";
  if (m === "claude" || m.startsWith("claude/") || m.startsWith("claude-")) {
    if (CLAUDE_CLI_BASE) return "claude-cli";
  }
  return "openrouter";
};

const mapModel = (requested) =>
  MODEL_ALIASES[String(requested || "").replace(/:latest$/, "")] || requested || DEFAULT_MODEL;

// ── Backend: OpenRouter ───────────────────────────────────────────────────────
const forward = async ({ messages, model, stream, extra }) => {
  if (!UP_KEY) throw new Error("OPENROUTER_API_KEY unset on the container — wire src/secrets.yaml and re-ship");
  const body = { ...extra, model: mapModel(model), messages, stream: !!stream };
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${UP_KEY}`,
    "http-referer": UP_REFERER,
    "x-title": UP_TITLE,
  };
  if (UP_PASSTHROUGH_AUTH && extra?._clientAuth) headers["authorization"] = extra._clientAuth;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  try {
    const r = await fetch(`${UP_BASE}${UP_CHAT}`, {
      method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`openrouter ${r.status}: ${txt.slice(0, 500)}`);
    }
    return r;
  } catch (e) {
    if (e.name === "AbortError") throw new Error("openrouter timeout");
    throw e;
  }
};

const callOpenRouter = async ({ messages, model, extra }) => {
  const r = await forward({ messages, model, stream: false, extra });
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  const usage = { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 };
  stats.calls++;
  stats.prompt_tokens += usage.input_tokens;
  stats.completion_tokens += usage.output_tokens;
  return { text, usage, raw: j };
};

// ── Backend: claude-cli (forward to claude-superset-api) ─────────────────────
const callClaudeCLI = async ({ messages, model, extra }) => {
  if (!CLAUDE_CLI_BASE) throw new Error("CLAUDE_CLI_BASE_URL unset — set it to your claude-superset-api WG endpoint");
  const body = { ...extra, model, messages, stream: false };
  // Every ship recreates the claude bridge (compose down/up + 40s health start
  // period). A connection-level "fetch failed" in that window is a deploy in
  // progress, not an outage — retry within the window instead of failing the
  // turn with an instant 502 (the telegram bot surfaced exactly that all night
  // on 2026-09-19). Only connection failures retry; HTTP errors and timeouts
  // still fail loud. The window is measured from the FIRST failure, not the
  // request start: a turn that had already run 77s when the bridge went down
  // exhausted a request-anchored budget 5s before the bridge came back
  // (measured 21:42:47Z). ponytail: fixed 150s/5s window, env-driven if a
  // deploy ever legitimately exceeds it.
  const RETRY_WINDOW_MS = 150_000, RETRY_DELAY_MS = 5_000;
  let firstFail = 0;
  for (;;) {
    try {
      // node:http, not fetch — undici caps waiting for headers at ~300s and
      // long claude turns run past that (see http-post.mjs).
      const r = await postJson(`${CLAUDE_CLI_BASE}${CLAUDE_CLI_CHAT}`, { "content-type": "application/json" }, body, CALL_TIMEOUT);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`claude-cli ${r.status}: ${txt.slice(0, 500)}`);
      }
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content ?? "";
      const usage = { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 };
      stats.calls++;
      stats.prompt_tokens += usage.input_tokens;
      stats.completion_tokens += usage.output_tokens;
      return { text, usage, raw: j };
    } catch (e) {
      if (e.code === "ETIMEDOUT") throw new Error("claude-cli timeout");
      // Connection-level failure = bridge down (deploying). node:http surfaces
      // these as ECONNREFUSED/ECONNRESET/EPIPE, not fetch's "fetch failed".
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH"].includes(e.code) || e.message === "fetch failed") {
        if (!firstFail) firstFail = Date.now();
        if (Date.now() - firstFail < RETRY_WINDOW_MS) {
          console.error(`[my-ai-api] claude-cli unreachable (bridge deploying?) — retry in ${RETRY_DELAY_MS / 1000}s`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
      }
      throw e;
    }
  }
};

// ── MCP-agentic variant of callOpenRouter: runs the tool_search/tool_call loop ──
const callOpenRouterAgentic = async ({ messages, model, extra }) => {
  let lastRaw = null;
  const callModel = async (msgs, tools) => {
    const r = await forward({ messages: msgs, model, stream: false, extra: { ...extra, tools } });
    lastRaw = await r.json();
    return lastRaw.choices?.[0]?.message ?? { role: "assistant", content: "" };
  };
  const msgs = [...messages];
  const text = await runAgenticLoop({ callModel, messages: msgs });
  const usage = { input_tokens: lastRaw?.usage?.prompt_tokens ?? 0, output_tokens: lastRaw?.usage?.completion_tokens ?? 0 };
  stats.calls++;
  stats.prompt_tokens += usage.input_tokens;
  stats.completion_tokens += usage.output_tokens;
  return { text, usage, raw: lastRaw };
};

// ── Backend: a native agent's own OpenAI-compatible API (loopback) ───────────
// Only messages, the agent target and the OpenAI `user` (OpenClaw derives a
// stable session from it) are sent: every other field is this gateway's own
// (reasoning, tools, compression headers) and means nothing to the agent,
// which runs its configured model with its own tools. Fails loud: a native
// agent that is down is a 502 naming it, never a silent fall back to a model
// that merely shares its name.
const callNative = async (name, { messages, model, extra }) => {
  const n = NATIVE[name];
  const body = { model, messages, stream: false };
  if (typeof extra?.user === "string") body.user = extra.user;
  const r = await postJson(`${n.base}/v1/chat/completions`, { "content-type": "application/json", ...n.auth() }, body, CALL_TIMEOUT);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${name} ${r.status}: ${txt.slice(0, 500)}`);
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? "";
  const usage = { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 };
  stats.calls++;
  stats.prompt_tokens += usage.input_tokens;
  stats.completion_tokens += usage.output_tokens;
  return { text, usage, raw: j };
};

// ── Dispatch to the right backend ─────────────────────────────────────────────
const dispatch = async ({ messages, model, extra, agentMode }) => {
  if (agentMode === "claude-cli") return callClaudeCLI({ messages, model, extra });
  if (agentMode === "goose")      return mcpEnabled() ? callOpenRouterAgentic({ messages, model: GOOSE_MODEL, extra }) : callOpenRouter({ messages, model: GOOSE_MODEL, extra });
  if (agentMode === "deepseek")   { const m = deepseekModel(model); return mcpEnabled() ? callOpenRouterAgentic({ messages, model: m, extra }) : callOpenRouter({ messages, model: m, extra }); }
  if (agentMode === "openclaw")   return callNative("openclaw", { messages, model: OPENCLAW_AGENT, extra });
  if (agentMode === "hermes" && NATIVE.hermes.enabled()) return callNative("hermes", { messages, model: HERMES_API_MODEL, extra });
  if (agentMode === "hermes")     return mcpEnabled() ? callOpenRouterAgentic({ messages, model: HERMES_MODEL, extra }) : callOpenRouter({ messages, model: HERMES_MODEL, extra });
  return callOpenRouter({ messages, model, extra });
};

// ── The agents this gateway serves, for /health.modes ────────────────────────
// ONE list a client can build its agent picker from without knowing any of
// them in advance: id is the X-Agent-Mode value, fleet the service in the C3
// catalogue it runs as, backend what actually answers, model what that backend
// runs (null = the request's model), available whether a request would reach
// it now, functions the read-only GET /agents/<id>/<fn> routes it publishes.
const modes = async () => {
  const [clawUp, hermesUp] = await Promise.all([probeNative("openclaw"), probeNative("hermes")]);
  const fns = (name, up) => (up ? Object.entries(NATIVE[name].functions).map(([id, f]) => ({ id, label: f.label, path: `/agents/${name}/${id}` })) : []);
  const hermesNative = NATIVE.hermes.enabled();
  return [
    { id: "hermes", label: "Hermes", fleet: "cloud-agi-hermes",
      backend: hermesNative ? "hermes-agent-api" : (mcpEnabled() ? "openrouter+mcp" : "openrouter"),
      native: hermesNative, model: hermesNative ? HERMES_API_MODEL : HERMES_MODEL,
      available: hermesNative ? hermesUp : !!UP_KEY,
      ...(hermesNative && !hermesUp ? { reason: "the Hermes API server does not answer" } : {}),
      ...(!hermesNative ? { note: "HERMES_API_KEY unset: the Hermes model behind this gateway's MCP loop, not the Hermes Agent" } : {}),
      functions: fns("hermes", hermesNative && hermesUp) },
    { id: "openclaw", label: "OpenClaw", fleet: "cloud-agi-openclaw", backend: "openclaw-gateway", native: true,
      model: OPENCLAW_AGENT, available: clawUp,
      ...(clawUp ? {} : { reason: "the OpenClaw gateway does not answer" }),
      functions: fns("openclaw", clawUp) },
    { id: "deepseek", label: "DeepSeek", fleet: null, backend: mcpEnabled() ? "openrouter+mcp" : "openrouter",
      native: false, model: DEEPSEEK_MODEL, model_choice: { providers: ["DeepSeek"], prefix: "deepseek/" },
      available: !!UP_KEY, functions: [] },
    { id: "goose", label: "Goose", fleet: "cloud-agi-goose", backend: mcpEnabled() ? "openrouter+mcp" : "openrouter",
      native: false, model: GOOSE_MODEL, available: !!UP_KEY, functions: [] },
    { id: "claude-cli", label: "Claude", fleet: "cloud-agi-claude", backend: "claude-superset-api", native: true,
      model: null, available: !!CLAUDE_CLI_BASE, functions: [] },
    { id: "openrouter", label: "OpenRouter (fleet key)", fleet: null, backend: "openrouter", native: false,
      model: null, available: !!UP_KEY, streams: true, functions: [] },
  ];
};

// ── Full pipeline + dispatch ──────────────────────────────────────────────────
const run = async (messages, model, extra = {}, headers = {}) => {
  const agentMode = getAgentMode(headers, model);
  const compressed = await pipeline(messages, model, headers);
  return { ...(await dispatch({ messages: compressed, model, extra, agentMode })), agentMode };
};

// ── Response envelopes ────────────────────────────────────────────────────────
const openaiEnvelope = (model, text, usage, raw) => {
  if (raw && raw.choices && raw.id) return raw;
  return {
    id: `chatcmpl-myai-${Date.now() % 1e9}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
};

const anthropicEnvelope = (model, text, usage) => ({
  id: `msg_myai_${Date.now() % 1e9}`,
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

// ── Anthropic /v1/messages ────────────────────────────────────────────────────
const handleAnthropic = async (payload, res, reqHeaders) => {
  const messages = [];
  if (payload.system) {
    const sysText = Array.isArray(payload.system)
      ? payload.system.map((b) => (typeof b === "string" ? b : b.text || "")).join("\n\n")
      : payload.system;
    messages.push({ role: "system", content: sysText });
  }
  for (const m of payload.messages || []) messages.push(m);
  const model = payload.model || (await jevTier(messages, reqHeaders)) || DEFAULT_MODEL;
  const extra = {
    max_tokens: payload.max_tokens,
    temperature: payload.temperature,
    top_p: payload.top_p,
    stop: payload.stop_sequences,
  };
  const wantStream = !!payload.stream;

  if (!wantStream) {
    const { text, usage } = await run(messages, model, extra, reqHeaders);
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(anthropicEnvelope(model, text, usage)));
  }
  const { text, usage } = await run(messages, model, extra, reqHeaders);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = `msg_myai_${Date.now() % 1e9}`;
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

  // ── session store ──────────────────────────────────────────────────────────
  if (req.url === "/sessions" || req.url.startsWith("/sessions/")) {
    const parts = req.url.split("?")[0].split("/").filter(Boolean);
    try {
      if (req.method === "GET" && parts.length === 1) {
        const out = [];
        for (const device of fs.existsSync(SESSIONS_DIR) ? fs.readdirSync(SESSIONS_DIR) : []) {
          const ddir = path.join(SESSIONS_DIR, device);
          if (!fs.statSync(ddir).isDirectory()) continue;
          for (const f of fs.readdirSync(ddir)) {
            if (!f.endsWith(".jsonl")) continue;
            const full = path.join(ddir, f);
            const st = fs.statSync(full);
            // `name` is served HERE (#516) so every consumer gets it from one
            // declaration: both Telegram bots share bots/commands.mjs, and
            // anything else on this endpoint is named for free. The bot stays a
            // formatter and never opens a session file itself — a second reader
            // next to a call site is the #513 defect. deriveSessionName reads
            // two BOUNDED windows (never the whole file): the store holds a
            // 127 MB session, and naming-by-reading would make this listing an
            // OOM on exactly the sessions worth resuming.
            const { name, from } = deriveSessionName(full);
            out.push({ device, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size, name, name_from: from });
          }
        }
        return send(200, out);
      }
      if (parts.length === 3) {
        const [, device, id] = parts;
        if (!safeSeg(device) || !safeSeg(id)) return send(400, { error: { message: "bad device/id" } });
        const ddir = path.join(SESSIONS_DIR, device);
        const file = path.join(ddir, `${id}.jsonl`);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) return send(404, { error: { message: "no such session" } });
          // ?tail=<bytes> serves only the END of the file (#513). The store holds
          // a 127 MB session; readFileSync on it is an OOM, so a client that
          // cannot use the whole thing must be able to ask for a bound. The
          // x-session-bytes-* headers let the caller report what it skipped
          // instead of truncating silently. No tail param = whole file, exactly
          // as before — this is an extension, not a behaviour change.
          const st = fs.statSync(file);
          const tail = parseInt(new URLSearchParams(req.url.split("?")[1] || "").get("tail") || "0", 10) || 0;
          const body = tail > 0 && tail < st.size ? readTailBytes(file, tail) : fs.readFileSync(file);
          res.writeHead(200, {
            "content-type": "application/x-ndjson",
            "x-session-bytes-total": String(st.size),
            "x-session-bytes-sent": String(Buffer.byteLength(body)),
          });
          return res.end(body);
        }
        if (req.method === "PUT") {
          const body = await readBody(req);
          fs.mkdirSync(ddir, { recursive: true });
          fs.writeFileSync(file, body);
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

  // ── health + model discovery ───────────────────────────────────────────────
  if (req.method === "GET" && (req.url === "/health" || req.url === "/readyz" || req.url === "/livez" || req.url === "/")) {
    // /readyz and /livez stay probe-free; /health (the docker healthcheck and
    // the app) carries the agent list, whose probes are cached.
    const live = req.url === "/health" || req.url === "/" ? await modes() : null;
    const byId = Object.fromEntries((live || []).map((m) => [m.id, m]));
    return send(200, {
      status: "ok", active, max: MAX_CONC,
      plugins: { headroom: HR_ENABLED, rtk: RTK_ENABLED, caveman: CAVEMAN_ENABLED, ponytail: PONYTAIL_DEFAULT, agents_principles: !!AGENTS_PRINCIPLES, cloud_principles: !!CLOUD_PRINCIPLES, mcp: MCP_ENABLED && mcpEnabled() },
      agents: {
        openrouter: !!UP_KEY, claude_cli: !!CLAUDE_CLI_BASE, goose: GOOSE_MODEL,
        hermes: NATIVE.hermes.enabled() ? HERMES_API_MODEL : HERMES_MODEL,
        ...(live ? { openclaw: byId.openclaw.available ? OPENCLAW_AGENT : false } : {}),
      },
      ...(live ? { modes: live } : {}),
      stats,
    });
  }
  // ── a native agent's read-only functions (NATIVE.<agent>.functions) ───────
  if (req.method === "GET" && req.url.startsWith("/agents/")) {
    const [name, fn] = req.url.split("?")[0].split("/").filter(Boolean).slice(1);
    const n = NATIVE[name];
    const f = n?.functions?.[fn];
    if (!f) return send(404, { error: { message: "no such agent function" } });
    if (!n.enabled()) return send(503, { error: { message: `${name}: not wired on this gateway` } });
    try {
      const r = await fetch(`${n.base}${f.path}`, { headers: n.auth(), signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      return send(r.ok ? 200 : 502, r.ok ? txt : { error: { message: `${name} ${r.status}: ${txt.slice(0, 300)}` } });
    } catch (e) { return send(502, { error: { message: `${name}: ${String(e.message || e)}` } }); }
  }
  if (req.method === "GET" && req.url.startsWith("/v1/mcp/status")) {
    if (!mcpEnabled()) return send(200, { enabled: false });
    try { return send(200, await getServerCounts()); }
    catch (e) { return send(200, { enabled: true, error: String(e.message || e) }); }
  }
  if (req.method === "GET" && req.url.startsWith("/v1/mcp/search")) {
    if (!mcpEnabled()) return send(200, { enabled: false });
    try {
      const u = new URL(req.url, "http://localhost");
      const q = u.searchParams.get("q") || "";
      const limit = parseInt(u.searchParams.get("limit") || "15", 10);
      return send(200, await searchTools(q, limit));
    } catch (e) { return send(200, { enabled: true, error: String(e.message || e) }); }
  }
  if (req.method === "GET" && req.url.startsWith("/v1/models")) {
    if (!UP_KEY) return send(200, { object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "my-ai-api" }] });
    try {
      const r = await fetch(`${UP_BASE}${UP_MODELS}`, { headers: { "authorization": `Bearer ${UP_KEY}` } });
      if (!r.ok) throw new Error(`openrouter models ${r.status}`);
      return send(200, await r.json());
    } catch (e) {
      return send(200, { object: "list", data: [{ id: DEFAULT_MODEL, object: "model", owned_by: "my-ai-api" }], warning: String(e.message || e) });
    }
  }
  if (req.method === "GET" && req.url.startsWith("/api/version")) return send(200, { version: "0.5.7" });
  if (req.method === "GET" && req.url.startsWith("/api/tags"))
    return send(200, { models: OLLAMA_MODELS.map((n) => ({
      name: n, model: n, modified_at: new Date().toISOString(), size: 0, digest: "",
      details: { format: "gguf", family: "openrouter", families: ["openrouter"], parameter_size: "", quantization_level: "" },
    })) });

  if (req.method === "POST") {
    let payload;
    try { payload = JSON.parse(await readBody(req)); }
    catch { return send(400, { error: { message: "invalid JSON body" } }); }

    await acquire();
    // Hoisted out of the try so the catch can name the agent that actually
    // failed — every backend error used to be labelled my_ai_openrouter_error,
    // which pointed a whole night of claude-bridge debugging at OpenRouter.
    let agentMode = "openrouter";
    try {
      if (req.url.startsWith("/v1/messages")) return await handleAnthropic(payload, res, req.headers);

      if (!Array.isArray(payload.messages)) return send(404, { error: { message: "no messages in body" } });
      const model = payload.model || (await jevTier(payload.messages, req.headers)) || DEFAULT_MODEL;
      const extra = { ...payload };
      delete extra.messages; delete extra.model; delete extra.stream;
      const wantStream = !!payload.stream;
      agentMode = getAgentMode(req.headers, model);

      const compressed = await pipeline(payload.messages, model, req.headers);

      if (wantStream && !isOllama && agentMode === "openrouter") {
        // SSE passthrough — only for OpenRouter (other backends don't stream)
        const r = await forward({ messages: compressed, model, stream: true, extra });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        let lastUsage = null;
        for await (const chunk of r.body) {
          res.write(chunk);
          const s = chunk.toString("utf8");
          const m = s.match(/"usage":\s*\{[^}]*\}/);
          if (m) lastUsage = m[0];
        }
        res.end();
        stats.calls++;
        if (lastUsage) {
          try {
            const u = JSON.parse(`{${lastUsage}}`).usage;
            stats.prompt_tokens += u.prompt_tokens ?? 0;
            stats.completion_tokens += u.completion_tokens ?? 0;
          } catch {}
        }
        return;
      }

      const { text, usage, raw } = await dispatch({ messages: compressed, model, extra, agentMode });
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
      } else {
        send(200, openaiEnvelope(model, text, usage, raw));
      }
    } catch (e) {
      stats.errors++;
      console.error(`[my-ai-api] ${agentMode} backend error: ${String(e.message || e)}`);
      send(502, { error: { message: String(e.message || e), type: `my_ai_${agentMode.replace(/-/g, "_")}_error` } });
    } finally { release(); }
    return;
  }
  send(404, { error: { message: "not found" } });
});

const handler = server.listeners("request")[0];
server.listen(PORT, BIND, () =>
  console.error(`[my-ai-api] API on http://${BIND}:${PORT} (model=${DEFAULT_MODEL}, conc=${MAX_CONC}, headroom=${HR_ENABLED}, rtk=${RTK_ENABLED}, caveman=${CAVEMAN_ENABLED}, ponytail=${PONYTAIL_DEFAULT}, agents=${["openrouter", CLAUDE_CLI_BASE && "claude-cli", "goose", NATIVE.hermes.enabled() ? "hermes(native)" : "hermes", OPENCLAW_BASE && "openclaw"].filter(Boolean).join("+")})`));

if (OLLAMA_PORT && !(OLLAMA_BIND === BIND && OLLAMA_PORT === PORT)) {
  const ollama = http.createServer(handler);
  ollama.on("error", (e) =>
    console.error(`[my-ai-api] Ollama mimic on ${OLLAMA_BIND}:${OLLAMA_PORT} disabled (${e.code || e.message})`));
  ollama.listen(OLLAMA_PORT, OLLAMA_BIND, () =>
    console.error(`[my-ai-api] Ollama mimic on http://${OLLAMA_BIND}:${OLLAMA_PORT} (/api/chat, /api/tags)`));
}
