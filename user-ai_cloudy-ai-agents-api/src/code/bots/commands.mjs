// commands.mjs — Telegram slash commands (/help, /new, /status, ...).
//
// Shared across all Telegram bots in the roster (see bots.json) — each bot
// gets its own per-chat state via route.mjs's getState, keyed by the
// conversationKey the caller passes in (which already encodes chat + topic).
// oauthLoginWorkflow: the re-login instructions are worded ONCE, in route.mjs,
// because the automatic auth-required recovery there hands out the same text.
// Two copies had already drifted (#546).
import { getState, routeToGoose, MYAI_LOCAL_URL, HISTORY_CAP, clearChatHistory, oauthLoginWorkflow } from "./route.mjs";
// The session format contract and the resume bound are declared ONCE, in
// sessions-store.mjs. /resume parses nothing itself (#513): a second parser
// here is what made a Claude Code transcript read as "no readable messages".
// Same for the ADDRESS (#525): the name is derived and served there, and
// resolved there too — this module formats the verdict, it never re-derives.
import { parseSessionMessages, RESUME_MAX_BYTES, RESUME_MAX_MESSAGES, RESUME_MAX_LISTED, resolveResumeAddress } from "../sessions-store.mjs";

// ── Slash commands ───────────────────────────────────────────────────────────
export const COMMANDS = [
  { command: "start",      description: "welcome message + capability summary" },
  { command: "help",       description: "list all commands" },
  { command: "new",        description: "clear this chat's conversation history" },
  { command: "health",     description: "show my-ai-api health" },
  { command: "usage",      description: "show usage stats" },
  { command: "model",      description: "show/set the model" },
  { command: "agent",      description: "show/set the agent mode (goose|hermes|claude|openrouter)" },
  { command: "mcp",        description: "show MCP server/tool status" },
  { command: "tools",      description: "search available MCP tools" },
  { command: "ponytail",   description: "show/set compression mode (off|lite|full|ultra)" },
  { command: "headroom",   description: "show/set headroom compression (on|off)" },
  { command: "rtk",        description: "show/set RTK tool-noise stripping (on|off)" },
  { command: "caveman",    description: "show/set caveman filler stripping (on|off)" },
  { command: "principles", description: "show/set principles injection (on|off)" },
  { command: "status",     description: "show current agent/model/history/plugin state" },
  { command: "statusline", description: "one-line compact status" },
  { command: "context",    description: "token/context gauge (alias /ctx)" },
  { command: "resume",     description: "list or resume a cross-device session" },
  { command: "sessions",   description: "list previous sessions (optional: search <q>)" },
  { command: "compress",   description: "summarize + compress this chat's history (alias /compact)" },
  { command: "retry",      description: "re-run your last message" },
  { command: "undo",       description: "remove the last user+assistant exchange" },
  { command: "stop",       description: "best-effort ack — interrupt the current turn" },
  { command: "sendfile",   description: "send a file from this host into the chat: /sendfile <path>" },
  { command: "whoami",     description: "show your Telegram id and access tier" },
  { command: "login",      description: "log the claude agent in — returns an OAuth link" },
  { command: "code",       description: "finish /login by sending the code from the link" },
  // Group/topic visibility and management — handled in telegram.mjs, not
  // here, because they need the Telegram API (tgPost) and the raw message
  // envelope (chat id, thread id), neither of which this module sees.
  { command: "chats",        description: "list groups/topics this bot has seen since last restart" },
  { command: "topics",       description: "list forum topics seen in this chat" },
  { command: "chatinfo",     description: "show live info about this chat" },
  { command: "newtopic",     description: "create a forum topic in this group" },
  { command: "renametopic",  description: "rename the current forum topic" },
  { command: "closetopic",   description: "close the current forum topic" },
  { command: "reopentopic",  description: "reopen the current forum topic" },
];

// Aliases: alias command -> canonical command handled in the switch.
const ALIASES = { commands: "help", reset: "new", ctx: "context", compact: "compress" };

const HELP_TEXT = "Commands:\n" + COMMANDS.map((c) => `/${c.command} — ${c.description}`).join("\n") +
  "\n\nAliases: /commands=/help /reset=/new /ctx=/context /compact=/compress";

const onOff = (v) => (v === null || v === undefined ? "server default" : v ? "on" : "off");
const parseOnOff = (arg) => {
  const v = (arg || "").toLowerCase().trim();
  if (v === "on") return true;
  if (v === "off") return false;
  return undefined;
};

const jget = async (url) => {
  const res = await fetch(url);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, text }; }
};

// Same shape as jget, for the login handshake. Network errors are returned
// rather than thrown so a chat command answers instead of going silent.
const jpost = async (url, body) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, text }; }
  } catch (e) { return { ok: false, status: 0, text: String(e.message || e) }; }
};

// ── Cross-device session listing (#513) ──────────────────────────────────────
// /sessions already enumerates EVERY device directory under the store and
// returns {device, id, mtime, size}. The bot used to throw the device away and
// keep only device === "telegram", so Diego's live Claude Code session — synced
// in under device "localhost" — was invisible to /resume even though it was
// sitting right there in the response. There is no fixed device list: whatever
// directories the store holds are the devices.
const listSessions = async () => {
  const r = await jget(`${MYAI_LOCAL_URL}/sessions`);
  if (!Array.isArray(r.json)) return { error: `sessions list unavailable: ${JSON.stringify(r.json || r.text)}`.slice(0, 300) };
  return { sessions: r.json.slice().sort((a, b) => b.mtime - a.mtime) };
};

const fmtBytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// ── ONE row renderer for both /resume and /sessions (#516) ──────────────────
// Diego's whole complaint about the #513 listing was that 40 bare UUIDs say
// nothing about what any session IS ("add the namee!!!!!!"), and that half the
// store was written inside the same 60 seconds so the timestamp does not tell
// them apart either. The name leads the row because it is the ADDRESS now
// (#525): it is what /resume <name> resolves, so it is the only field worth
// scanning. The id follows on its own indented line because it is the
// TIEBREAKER — when two sessions share a name, or the namer could not label one
// ("(unnamed)"), the id settles which one, and a phone wraps a 150-char single
// line into mush.
//
// The name is NOT derived here. server.mjs's /sessions serves it, from the one
// normaliser in sessions-store.mjs — this module never opens a session file.
// `name` missing at all (a server older than this commit) degrades to an honest
// marker instead of silently reprinting the UUID as if it were a name.
const fmtRow = (s) =>
  `${s.name || "(unnamed)"}\n   ${s.id} · ${s.device} · ${new Date(s.mtime).toISOString()} · ${fmtBytes(s.size)}`;

// WG-only claude-superset-api endpoint (same env the gateway routes chat to).
const CLAUDE_CLI_BASE = process.env.CLAUDE_CLI_BASE_URL || "";

export const handleCommand = async (cmdIn, arg, chatKey, meta = {}, defaultAgent = "goose") => {
  const cmd = ALIASES[cmdIn] || cmdIn;
  const state = getState(chatKey, defaultAgent);
  switch (cmd) {
    case "start":
      return "👋 my-ai-api gateway. I route your messages to an LLM agent (goose by default) with a compression/plugin pipeline in front. Try /help for the full command list.";
    case "help":
      return HELP_TEXT;
    case "new":
      state.history = [];
      clearChatHistory(chatKey); // also drop any persisted copy so /new stays fresh across a restart
      return "🧹 fresh conversation";
    case "health": {
      const r = await jget(`${MYAI_LOCAL_URL}/health`);
      if (!r.ok && !r.json) return `[error] ${r.status}: ${r.text || ""}`.slice(0, 300);
      const j = r.json || {};
      return `status=${j.status} active=${j.active}/${j.max} agents=${JSON.stringify(j.agents)} plugins=${JSON.stringify(j.plugins)}`;
    }
    case "usage": {
      const r = await jget(`${MYAI_LOCAL_URL}/health`);
      if (r.json?.stats) {
        const s = r.json.stats;
        return `calls=${s.calls} errors=${s.errors} prompt_tokens=${s.prompt_tokens} completion_tokens=${s.completion_tokens} tokens_saved=${s.tokens_saved}`;
      }
      return "usage stats endpoint not available";
    }
    case "model":
      if (!arg) return `model: ${state.model || "(server default)"}`;
      state.model = arg;
      return `model set to ${arg}`;
    case "agent":
      if (!arg) return `agent: ${state.agent}`;
      if (!["goose", "hermes", "claude", "openrouter"].includes(arg)) return "invalid agent — choose one of: goose, hermes, claude, openrouter";
      state.agent = arg;
      return `agent set to ${arg}`;
    case "mcp": {
      const r = await jget(`${MYAI_LOCAL_URL}/v1/mcp/status`);
      if (r.json?.enabled === false) return "MCP disabled on the server";
      if (Array.isArray(r.json)) return r.json.map((s) => `${s.server}: ${s.count} tools`).join("\n") || "(no servers)";
      return `mcp status unavailable: ${JSON.stringify(r.json || r.text)}`.slice(0, 300);
    }
    case "tools": {
      if (!arg) return "usage: /tools <query>";
      const r = await jget(`${MYAI_LOCAL_URL}/v1/mcp/search?q=${encodeURIComponent(arg)}`);
      if (r.json?.enabled === false) return "MCP disabled on the server";
      if (Array.isArray(r.json)) return r.json.length ? r.json.map((t) => `${t.name} — ${t.description || ""}`).join("\n") : "(no matches)";
      return `tools search unavailable: ${JSON.stringify(r.json || r.text)}`.slice(0, 300);
    }
    case "ponytail": {
      const valid = ["off", "lite", "full", "ultra"];
      if (!arg) return `ponytail: ${state.ponytail || "(server default)"}`;
      if (!valid.includes(arg)) return `invalid — choose one of: ${valid.join(", ")}`;
      state.ponytail = arg;
      return `ponytail set to ${arg}`;
    }
    case "headroom": case "rtk": case "caveman": case "principles": {
      const key = cmd;
      if (!arg) return `${key}: ${onOff(state.toggles[key])}`;
      const b = parseOnOff(arg);
      if (b === undefined) return "usage: on|off";
      state.toggles[key] = b;
      return `${key} set to ${b ? "on" : "off"}`;
    }
    case "status": {
      const t = state.toggles;
      return [
        `agent: ${state.agent}`,
        `model: ${state.model || "(server default)"}`,
        `history: ${state.history.length} messages (~${Math.floor(state.history.length / 2)} turns)`,
        `ponytail: ${state.ponytail || "(server default)"}`,
        `plugins: headroom=${onOff(t.headroom)} rtk=${onOff(t.rtk)} caveman=${onOff(t.caveman)} principles=${onOff(t.principles)}`,
      ].join("\n");
    }
    case "statusline": {
      const r = await jget(`${MYAI_LOCAL_URL}/health`);
      const s = r.json?.stats || {};
      const t = state.toggles;
      const flags = `hr:${onOff(t.headroom)},rtk:${onOff(t.rtk)},cm:${onOff(t.caveman)},pr:${onOff(t.principles)}`;
      return `${state.model || "(default)"} · ${state.agent} · ${s.prompt_tokens ?? "?"}tok in/${s.completion_tokens ?? "?"}tok out · ponytail:${state.ponytail || "default"} · plugins:${flags}`;
    }
    case "context": {
      const r = await jget(`${MYAI_LOCAL_URL}/health`);
      const s = r.json?.stats || {};
      const pt = s.prompt_tokens ?? 0, ct = s.completion_tokens ?? 0;
      return `tokens in=${pt} out=${ct} total=${pt + ct} model=${state.model || "(server default)"}\n` +
        `(note: this is my-ai-api server's own cumulative accounting, not Claude Code's context window)`;
    }
    case "resume": {
      const { sessions, error } = await listSessions();
      if (error) return error;
      if (!arg) {
        if (sessions.length === 0) return "(no saved sessions in the store)";
        // The device is PART of the listing, not a filter on it — two devices
        // can hold different sessions with unrelated ids and Diego has to be
        // able to tell which machine he is resuming.
        const shown = sessions.slice(0, RESUME_MAX_LISTED);
        const more = sessions.length - shown.length;
        return shown
          .map(fmtRow)
          .join("\n") + (more > 0 ? `\n(+${more} older not shown)` : "") + "\n\nuse /resume <name>";
      }
      // #525: the NAME is the address. resolveResumeAddress is the ONE resolver
      // (sessions-store.mjs): exact name first, then a unique name prefix —
      // the listing's row is the truncated label, so the only way a phone can
      // comfortably retype it is by its beginning — then the id as the
      // tiebreaker for duplicate or unnameable sessions. It dedupes by id
      // (a session spanning devices or #506-rolled files is ONE target, newest
      // file wins) and, when an address belongs to several DIFFERENT sessions,
      // it says so instead of guessing between them.
      const verdict = resolveResumeAddress(sessions, arg);
      if (verdict.ok) {
        const pick = verdict.session;
        const holderWord = verdict.matchedBy === "id" ? "id" : "session";
        const dupNote = verdict.deviceCount > 1
          ? ` (${verdict.deviceCount} devices hold this ${holderWord} — picked the newest, ${pick.device})`
          : "";
        // Ask for the TAIL only. The live store holds a 127 MB transcript;
        // pulling it whole would be an OOM here and an unusable context upstream.
        const r = await jget(`${MYAI_LOCAL_URL}/sessions/${encodeURIComponent(pick.device)}/${encodeURIComponent(pick.id)}?tail=${RESUME_MAX_BYTES}`);
        if (!r.ok) return `[error] could not load session ${arg} from ${pick.device}: ${r.status}`;
        // A one-line session parses as JSON, so jget hands it back as .json.
        const raw = r.text !== undefined ? String(r.text) : JSON.stringify(r.json ?? "");
        const loaded = Buffer.byteLength(raw);
        // ONE parser, in sessions-store.mjs — it accepts the bot's own flat
        // {role, content} lines AND Claude Code's {type, message:{role, content}}
        // records with typed content blocks, and skips the non-message records.
        const msgs = parseSessionMessages(raw, RESUME_MAX_MESSAGES);
        if (msgs.length === 0) return `session ${arg} on ${pick.device} had no readable messages in its last ${fmtBytes(loaded)}`;
        // HISTORY_CAP is only the send window applied at routeToGoose time; the
        // resumed tail is kept whole in state.history (and re-persisted on the
        // next turn) rather than truncated to ~10 turns.
        state.history = msgs;
        const skipped = Math.max(0, pick.size - loaded);
        const label = pick.name && pick.name !== "(unnamed)" ? pick.name : pick.id;
        return `▶️ resumed "${label}" from ${pick.device}${dupNote} — ${msgs.length} messages ` +
          `from the last ${fmtBytes(loaded)} of ${fmtBytes(pick.size)} (${fmtBytes(skipped)} older not loaded)`;
      }
      if (verdict.ambiguous) {
        return `ℹ️ ${verdict.ambiguous.length} sessions are named "${arg}" — say which one:\n` +
          verdict.ambiguous.map(fmtRow).join("\n") +
          `\n(${verdict.ambiguous.length} sessions share this name — resume one by its id above)`;
      }
      return `no session "${arg}" in the store — /resume with no name lists what is there`;
    }
    case "sessions": {
      const [sub, ...rest] = (arg || "").split(/\s+/);
      // Same store, same listing as /resume — a /sessions that showed only
      // telegram while /resume offers every device would just be the #513 bug
      // wearing the other command's name.
      const { sessions: mine, error } = await listSessions();
      if (error) return error;
      if (sub === "search") {
        const q = rest.join(" ").trim();
        if (!q) return "usage: /sessions search <q>";
        // Match the NAME as well as the id (#516). A listing that shows names
        // but can only be searched by UUID is half a fix — "search cloud-mail"
        // has to find the session called cloud-mail.
        const ql = q.toLowerCase();
        const matched = mine.filter((s) => s.id.includes(q) || String(s.name || "").toLowerCase().includes(ql));
        return matched.length ? matched.map(fmtRow).join("\n") : `(no matches for "${q}")`;
      }
      // Same renderer as /resume: identical rows from identical data, so the two
      // commands can never drift into showing different things again.
      const plain = mine.slice(0, RESUME_MAX_LISTED).map(fmtRow).join("\n");
      if (sub) return "search isn't available for this argument — showing plain list instead:\n" +
        (mine.length ? plain : "(no saved sessions)");
      return mine.length ? plain : "(no saved sessions)";
    }
    case "compress": {
      const n = state.history.length;
      if (n === 0) return "🗜️ nothing to compress (history is empty)";
      const transcript = state.history.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n");
      const summaryPrompt = `Summarize the following conversation concisely, preserving important facts, decisions, and open questions. Reply with just the summary text.\n\n${transcript}`;
      state.history = [];
      const summary = await routeToGoose(summaryPrompt, chatKey);
      state.history = [{ role: "assistant", content: summary }];
      return `🗜️ compressed (${n}→1)`;
    }
    case "retry": {
      if (state.history.length && state.history[state.history.length - 1].role === "assistant") state.history.pop();
      let lastUser = null;
      for (let i = state.history.length - 1; i >= 0; i--) {
        if (state.history[i].role === "user") { lastUser = state.history[i].content; state.history.splice(i, 1); break; }
      }
      if (lastUser === null) return "no previous user message to retry";
      return await routeToGoose(lastUser, chatKey);
    }
    case "undo": {
      if (state.history.length === 0) return "↩️ nothing to undo";
      state.history.splice(-2, 2);
      return "↩️ undone";
    }
    case "stop": {
      state.busy = false;
      return "⏹️ ack — current turn interrupted (requests are short-lived; nothing long-running to stop)";
    }
    case "whoami": {
      const id = meta.fromId ?? "(unknown)";
      const tier = meta.allowFrom && meta.allowFrom.length > 0 && meta.allowFrom.includes(String(id)) ? "admin" : "open-access";
      return `your Telegram id: ${id}\naccess tier: ${tier}`;
    }

    // ── claude-superset-api interactive login ────────────────────────────────
    // The subscription CLI authenticates by browser OAuth, and nobody can open
    // a shell on the VM from a phone. /login starts `claude setup-token` in
    // the superset container and hands back its authorize URL; /code carries
    // the pasted code to the *same still-running* process (restarting it would
    // void the PKCE state). See claude-superset-api/src/code/login.mjs.
    case "login": {
      if (!CLAUDE_CLI_BASE) return "CLAUDE_CLI_BASE_URL unset — cannot reach claude-superset-api";
      const r = await jpost(`${CLAUDE_CLI_BASE}/auth/login/start`, {});
      const j = r.json || {};
      if (!r.ok || !j.url) return `login failed: ${j.error || r.text || r.status}${j.output ? `\n${j.output}` : ""}`;
      return oauthLoginWorkflow(j.url);
    }
    case "code": {
      if (!CLAUDE_CLI_BASE) return "CLAUDE_CLI_BASE_URL unset — cannot reach claude-superset-api";
      if (!arg || !arg.trim()) return "usage: /code <the-code-from-the-login-link>";
      const r = await jpost(`${CLAUDE_CLI_BASE}/auth/login/code`, { code: arg.trim() });
      const j = r.json || {};
      return r.ok && j.ok
        ? `✅ ${j.message || "logged in"} — the claude agent should answer now.`
        : `login failed: ${j.error || r.text || r.status}${j.output ? `\n${j.output}` : ""}`;
    }
    default:
      return "unknown command, try /help";
  }
};
