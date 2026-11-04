// sessions-store.mjs — SINGLE declaration of the cross-device session store.
//
// server.mjs serves /sessions from SESSIONS_DIR and route.mjs persists telegram
// chat history into the SAME store, so the directory is declared HERE once and
// both derive from it — route.mjs never restates the path as a literal.
//
// On-disk format is NDJSON, and the store holds TWO shapes — this module is the
// single owner of BOTH, via normalizeSessionRecord below:
//
//   a) what saveTelegramHistory writes: one flat `{role, content}` per line.
//   b) what a device syncs in: a Claude Code transcript, one record per line
//      shaped `{type, message:{role, content}}`, where content is EITHER a
//      plain string OR an array of typed blocks, and where most lines are not
//      messages at all.
//
// server.mjs's /sessions/<device>/<id> GET serves either back verbatim and
// /resume reads either — there is ONE parser for both and it lives here. Do not
// grow a second one next to a call site (that is exactly the #513 defect).
//
// HISTORY is NOT capped here: route.mjs's HISTORY_CAP is only the SEND WINDOW
// (token budget). The file on disk is the durable memory and keeps the whole
// conversation. Do not "helpfully" cap writes in this module to match.
import fs from "node:fs";
import path from "node:path";

export const SESSIONS_DIR = process.env.BRIDGE_SESSIONS_DIR ||
  path.join(process.env.HOME || ".", ".goose-sessions");

// Resume bound (#513). The live store holds a 127,487,011-byte session: reading
// it whole and assigning every message to state.history is an OOM or an
// unusable context, not a resume. /resume takes the TAIL — at most
// RESUME_MAX_BYTES off the end of the file, at most RESUME_MAX_MESSAGES out of
// that window — and always reports what it skipped. Declared once in
// build.json runtime.sessions.resume and exported by compose.nix; both halves
// live here so server.mjs (which does the tail read) and commands.mjs (which
// applies the message cap) share ONE declaration.
export const RESUME_MAX_BYTES = parseInt(process.env.BRIDGE_RESUME_MAX_BYTES || "1048576", 10);
export const RESUME_MAX_MESSAGES = parseInt(process.env.BRIDGE_RESUME_MAX_MESSAGES || "120", 10);
// How many sessions /resume and /sessions list. Must cover the WHOLE store, not
// a round number: measured live, Diego's session is rank 18 of the 40 the store
// holds, so the old hardcoded 10 hid the one session #513 exists to offer him.
export const RESUME_MAX_LISTED = parseInt(process.env.BRIDGE_RESUME_MAX_LISTED || "40", 10);

// ── Naming bounds (#516) ───────────────────────────────────────────────────
// A listing of 40 UUIDs tells Diego nothing about what any session IS, and half
// the store is written inside the same 60 seconds so the timestamp does not
// disambiguate them either. deriveSessionName below gives every row a label.
//
// It must NEVER read a whole file: the store holds a 127,487,011-byte session
// and two others over 100 MB, and /sessions stats every device directory on
// every call, so naming-by-reading would turn the listing into an OOM on
// exactly the sessions Diego most wants back. Naming therefore reads at most
// NAME_HEAD_BYTES off the front plus NAME_TAIL_BYTES off the end, both by
// positional read — never fs.readFileSync. Declared in build.json
// runtime.sessions.name and exported by compose.nix, like the resume bounds.
export const NAME_HEAD_BYTES = parseInt(process.env.BRIDGE_NAME_HEAD_BYTES || "65536", 10);
export const NAME_TAIL_BYTES = parseInt(process.env.BRIDGE_NAME_TAIL_BYTES || "32768", 10);
// Row width. A phone shows ~40 chars before wrapping; 40 wrapped rows are a
// wall, so a long prompt is truncated with an ellipsis rather than folded.
export const NAME_MAX_CHARS = parseInt(process.env.BRIDGE_NAME_MAX_CHARS || "60", 10);

// Telegram bot chatKeys carry ':' (chat:id and chat:id:thread) which FAIL
// server.mjs's safeSeg (/^[A-Za-z0-9._-]+$/) on the /sessions/<device>/<id>
// endpoint. Sanitise deterministically so the same chat maps to the same file
// across restarts AND /resume's round-trip (listing → GET) still works.
export const safeSessionId = (chatKey) =>
  String(chatKey || "").replace(/[^A-Za-z0-9._-]/g, "_");

export const telegramSessionPath = (chatKey) =>
  path.join(SESSIONS_DIR, "telegram", `${safeSessionId(chatKey)}.jsonl`);

// Serialise history to NDJSON exactly as /resume expects: one JSON object per
// line, each carrying role + content (the fields /resume filters on).
export const serializeHistory = (history) =>
  (history || [])
    .map((m) => JSON.stringify({ role: m.role, content: m.content }))
    .join("\n");

// ── The ONE session-record parser ───────────────────────────────────────────
// Measured on the real store (#513), Diego's live session is 9,006 lines that
// split like this:
//
//   assistant / array content   3698      last-prompt                538
//   user      / array content   1905      mode                       533
//   user      / string content    86      custom-title               534
//                                         attachment                1373
//                                         system / file-history /
//                                         queue-operation             221
//
// So a parser that only accepts `{role, content}` yields ZERO messages from a
// Claude Code transcript — the "session had no readable messages" dead end —
// and one that assumes content is a string mangles 5,603 of the 5,689 messages.

// Flatten one content block to text. Unknown and unsendable block types (a
// `thinking` block is a signature blob that cannot be replayed) contribute
// nothing rather than JSON noise.
const blockToText = (b) => {
  if (typeof b === "string") return b;
  if (!b || typeof b !== "object") return "";
  if (b.type === "text") return typeof b.text === "string" ? b.text : "";
  if (b.type === "tool_use") {
    let input = "";
    try { input = JSON.stringify(b.input ?? {}); } catch { input = "(uninspectable input)"; }
    return `[tool_use ${b.name || "?"}] ${input}`;
  }
  if (b.type === "tool_result") return flattenContent(b.content);
  return "";
};

// Content may be a plain string (both shapes produce these) or an array of
// typed blocks (Claude Code). Anything else flattens to "".
export const flattenContent = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(blockToText).filter((t) => t !== "").join("\n");
};

// One record (already JSON.parsed) -> `{role, content}` or null when the record
// is not a message. Accepts BOTH on-disk shapes: the nested Claude Code
// `{type, message:{role, content}}` and this module's own flat `{role, content}`.
// Records with no role at all (last-prompt, mode, attachment, custom-title,
// system, file-history-*, queue-operation) are skipped, never thrown on.
export const normalizeSessionRecord = (rec) => {
  if (!rec || typeof rec !== "object") return null;
  const m = rec.message && typeof rec.message === "object" ? rec.message : rec;
  if (typeof m.role !== "string" || m.content === undefined) return null;
  const content = flattenContent(m.content);
  if (content === "") return null;
  return { role: m.role, content };
};

// NDJSON text -> messages. `limit > 0` keeps only the LAST `limit` of them:
// /resume resumes the tail of a conversation, and the newest messages are the
// ones worth the context budget. Malformed lines are skipped, never thrown.
export const parseSessionMessages = (text, limit = 0) => {
  const msgs = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const m = normalizeSessionRecord(rec);
    if (m) msgs.push(m);
  }
  return limit > 0 && msgs.length > limit ? msgs.slice(-limit) : msgs;
};

// Read the last `bytes` of a file WITHOUT pulling the whole thing into memory —
// the point of the #513 bound. The first line of that window is almost always
// cut in half, so it is dropped and the caller only ever sees whole NDJSON
// records. `bytes <= 0` or a window bigger than the file reads the file whole.
export const readTailBytes = (file, bytes) => {
  const size = fs.statSync(file).size;
  if (!(bytes > 0) || bytes >= size) return fs.readFileSync(file, "utf8");
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buf, 0, bytes, size - bytes); } finally { fs.closeSync(fd); }
  const window = buf.toString("utf8");
  const nl = window.indexOf("\n");
  return nl === -1 ? "" : window.slice(nl + 1);
};

// Read the FIRST `bytes` of a file, the mirror of readTailBytes and the other
// half of the #516 bound. The last line of the window is almost always cut in
// half, so it is dropped and callers only ever see whole NDJSON records.
// `bytes <= 0` or a window bigger than the file reads the file whole.
export const readHeadBytes = (file, bytes) => {
  const size = fs.statSync(file).size;
  if (!(bytes > 0) || bytes >= size) return fs.readFileSync(file, "utf8");
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, buf, 0, bytes, 0); } finally { fs.closeSync(fd); }
  const window = buf.toString("utf8");
  const nl = window.lastIndexOf("\n");
  return nl === -1 ? "" : window.slice(0, nl);
};

// ── Session naming (#516) ───────────────────────────────────────────────────
// Diego's complaint was "add the namee!!!!!!" under a listing of 40 bare UUIDs.
// A label has to come from the file, and it CANNOT come from reading the file
// (see the NAME_*_BYTES note above), so it comes from two bounded windows.
//
// The rungs below are in this order because of what the REAL store actually
// holds, measured over all 40 sessions on 2026-09-19 — not because of what the
// format looks like it should hold:
//
//   1. custom-title      7-9 files. Diego TITLED these ("tasks", "cloud-mail",
//                        "u0_nixos", "qute"). His own word beats anything
//                        inferred, so it wins outright.
//   2. last-prompt       28 files. Claude Code writes {"type":"last-prompt",
//                        "lastPrompt":"..."} — a purpose-built single field
//                        holding the last thing he typed, with no wrapper
//                        markup in it. It is at the END of the file, reached by
//                        one positional read, never a scan.
//   3. first user message Reached through the ONE normaliser below, so this
//                        module still has a single parser. This is the rung
//                        that names the bot's own flat {role,content} telegram
//                        NDJSON, which has neither of the two records above.
//   4. cwd basename      Honest, and marked as a fallback so it cannot be
//                        mistaken for a real title.
//   5. "(unnamed)"       A 146-byte bridge-session stub has nothing at all.
//
// Rung 3 is deliberately BELOW rung 2, which inverts the obvious "name it after
// the first thing he asked". The head of a real transcript is usually not a
// prompt: 12 of the 40 files open with a "<local-command-caveat>" wrapper, 7
// more with "<local-command-stdout>Set model to ...", 2 with "This session is
// being continued from a previous conversation...", one with a box-drawing TUI
// dump. Naming from the head alone gives a dozen rows the SAME useless label,
// which is the bug this ticket is about wearing a different shirt. Chasing that
// with a blacklist of wrapper prefixes is a list that grows every time upstream
// adds a markup tag; lastPrompt is one field that is already exactly the answer.
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// One label -> one scannable line. Strips the terminal escapes and control
// characters that a pasted prompt carries (the store holds a pasted browser
// error complete with \r, and TUI dumps full of them) and collapses every run
// of whitespace, so a multi-line prompt becomes one row instead of forty.
export const cleanLabel = (s) =>
  String(s ?? "")
    .replace(ANSI_ESCAPE, "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Is this "user message" actually machine-generated markup rather than something
// Diego typed? Claude Code injects turns wrapped in an XML-ish envelope —
// <local-command-caveat>, <local-command-stdout>, <system-reminder>,
// <command-name> — and they open the transcript far more often than a real
// prompt does: of the 40 real sessions, 12 open with a caveat wrapper and 7 more
// with command output. Named from those, a dozen rows would share one
// meaningless label, which is the bug this ticket is about in a different shirt.
//
// This is ONE structural rule, not a list of tag names to keep extending: a
// prompt a human typed does not begin with a closed markup tag. A new upstream
// wrapper is therefore handled the day it appears, without touching this file.
const WRAPPED = /^<[A-Za-z][A-Za-z0-9-]*>/;
const isWrapped = (s) => WRAPPED.test(cleanLabel(s));

// Truncate to a phone-scannable width, with an ellipsis so a cut label is
// visibly cut rather than silently misleading.
export const truncateLabel = (s, max = NAME_MAX_CHARS) => {
  const t = cleanLabel(s);
  return max > 0 && t.length > max ? `${t.slice(0, max - 1)}\u2026` : t;
};

// Derive a label for ONE session file. Returns {name, from} — `from` names the
// rung that produced it so a fallback is VISIBLE to the caller instead of
// looking like a title Diego chose. Reads at most NAME_HEAD_BYTES +
// NAME_TAIL_BYTES and never fs.readFileSync's a bounded file; an unreadable
// file yields a fallback, never a throw, because one bad file must not take the
// whole listing down.
export const deriveSessionName = (file, opts = {}) => {
  const headBytes = opts.headBytes ?? NAME_HEAD_BYTES;
  const tailBytes = opts.tailBytes ?? NAME_TAIL_BYTES;
  const maxChars = opts.maxChars ?? NAME_MAX_CHARS;
  let head = "", tail = "";
  try { head = readHeadBytes(file, headBytes); } catch { /* unreadable: fall through */ }
  try { tail = readTailBytes(file, tailBytes); } catch { /* unreadable: fall through */ }

  const records = (text) => {
    const out = [];
    for (const line of String(text ?? "").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* partial/garbage line */ }
    }
    return out;
  };

  let title = null, cwd = null;
  for (const rec of records(head)) {
    if (!rec || typeof rec !== "object") continue;
    if (!title && rec.type === "custom-title" && typeof rec.customTitle === "string" && cleanLabel(rec.customTitle))
      title = rec.customTitle;
    if (!cwd && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
  }
  if (title) return { name: truncateLabel(title, maxChars), from: "title" };

  // The LAST last-prompt in the tail window is the most recent one: Claude Code
  // appends a fresh record per turn (538 of them in the 127 MB file), so the
  // final one carries the newest prompt.
  let lastPrompt = null;
  for (const rec of records(tail)) {
    if (rec && typeof rec === "object" && rec.type === "last-prompt" &&
        typeof rec.lastPrompt === "string" && cleanLabel(rec.lastPrompt)) lastPrompt = rec.lastPrompt;
  }
  if (lastPrompt) return { name: truncateLabel(lastPrompt, maxChars), from: "last-prompt" };

  // Rung 3 goes through parseSessionMessages — the ONE parser — so the flat
  // telegram NDJSON and a Claude Code transcript are read by the same code here
  // as everywhere else in this module. This is the rung that names the bot's own
  // telegram chats, whose lines are flat {role,content} with neither of the
  // records above.
  const firstUser = parseSessionMessages(head)
    .find((m) => m.role === "user" && cleanLabel(m.content) && !isWrapped(m.content));
  if (firstUser) return { name: truncateLabel(firstUser.content, maxChars), from: "first-message" };

  if (cwd) return { name: truncateLabel(`${path.basename(cwd)} (no prompt yet)`, maxChars), from: "cwd" };
  return { name: "(unnamed)", from: "none" };
};

// ── Address resolution (#525) ────────────────────────────────────────────────
// /resume's argument is a NAME, never a UUID: #516 made the name visible, #525
// makes the name the ADDRESS, and #513 is what became possible once a live
// session is addressable. This is the ONE place an address resolves to a
// session. It matches against the `name` field that THIS module derived (see
// deriveSessionName) and server.mjs serves — never a name the caller computes,
// so there is exactly one declaration of what a session is called, and no
// second private copy grows next to a call site.
//
// Resolution order, all against the served listing:
//   1. exact name   — the row Diego saw is the row he gets back.
//   2. unique prefix — a phone cannot comfortably type a 60-char truncated
//      label, and the listing's row IS that label, so a prefix of it must
//      address the same session when ONLY ONE session's name starts with it.
//   3. id fallback  — the id is not the address, but it is the TIEBREAKER: the
//      listing shows it on its own line, an ambiguous name is settled with it,
//      and the few sessions the namer cannot label ("(unnamed)") are only
//      reachable by it. /resume <id> keeps working exactly as before (#513).
//
// A session is an id, not a file. The same id on two devices (or, under #506's
// rollover, a session whose closed files archive and whose newest file carries
// the resume forward) is ONE session: same id, newest mtime wins. Two DIFFERENT
// ids that share a name are different sessions, and they must be surfaced, not
// guessed between — silently picking is how a resume lands in the wrong
// conversation. Returns {ok:true, session, matchedBy, deviceCount} when exactly
// one session matched, {ok:false, ambiguous:[rows]} when a name/prefix belongs
// to several distinct ids, and {ok:false, miss:true} when nothing did. An empty
// or whitespace-only address is a miss, never a guess.
export const resolveResumeAddress = (rows, arg) => {
  const address = String(arg ?? "").trim();
  const lowered = address.toLowerCase();
  const nameOf = (r) => String(r.name ?? "").trim().toLowerCase();
  if (!lowered) return { ok: false, miss: true };

  let byName = rows.filter((r) => nameOf(r) === lowered);
  let matchedBy = "name";
  if (byName.length === 0) {
    byName = rows.filter((r) => nameOf(r).startsWith(lowered) && nameOf(r) !== lowered);
    matchedBy = "prefix";
  }
  if (byName.length > 0) {
    // Newest first, one entry per id: a session spread across devices or rolled
    // files is one target, so the newest file of the session carries it.
    const newestPerId = new Map();
    for (const row of [...byName].sort((a, b) => b.mtime - a.mtime)) {
      if (!newestPerId.has(row.id)) newestPerId.set(row.id, row);
    }
    const unique = [...newestPerId.values()];
    if (unique.length === 1) {
      const session = unique[0];
      return {
        ok: true,
        session,
        matchedBy,
        deviceCount: new Set(byName.filter((r) => r.id === session.id).map((r) => r.device)).size,
      };
    }
    return { ok: false, ambiguous: unique, matchedBy };
  }

  // No name matched: fall back to the id, the tiebreaker.
  const byId = rows.filter((r) => r.id === address);
  if (byId.length === 0) return { ok: false, miss: true };
  const newest = [...byId].sort((a, b) => b.mtime - a.mtime)[0];
  return {
    ok: true,
    session: newest,
    matchedBy: "id",
    deviceCount: new Set(byId.map((r) => r.device)).size,
  };
};

// Persist a chat's FULL history, overwriting the previous file. A failed write
// logs and returns false — callers must continue, never take the turn down.
export const saveTelegramHistory = (chatKey, history) => {
  try {
    const p = telegramSessionPath(chatKey);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, serializeHistory(history) + "\n");
    return true;
  } catch (e) {
    console.error(`[gateway] session write failed for ${chatKey}: ${e.message}`);
    return false;
  }
};

// Read a chat's full persisted history back (the survival-on-restart path).
// null when no file exists. Malformed lines are skipped, never thrown.
export const loadTelegramHistory = (chatKey) => {
  let raw;
  try {
    const p = telegramSessionPath(chatKey);
    if (!fs.existsSync(p)) return null;
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    console.error(`[gateway] session read failed for ${chatKey}: ${e.message}`);
    return null;
  }
  return parseSessionMessages(raw);
};

// Remove a chat's persisted history (used by /new so a cleared chat stays
// cleared across a restart, not resurrected from disk).
export const clearTelegramHistory = (chatKey) => {
  try {
    const p = telegramSessionPath(chatKey);
    if (fs.existsSync(p)) fs.rmSync(p);
  } catch (e) {
    console.error(`[gateway] session clear failed for ${chatKey}: ${e.message}`);
  }
};

// Does this chatKey name a telegram chat (as opposed to mattermost or other
// transports)? Both telegram bots use the "telegram"/"telegram-claude" key
// prefix, so a leading "telegram" identifies them. Used to scope persistence —
// only telegram chats are part of the /sessions store.
export const isTelegramChat = (chatKey) =>
  typeof chatKey === "string" && (chatKey === "telegram" || chatKey.startsWith("telegram:") || chatKey.startsWith("telegram-claude:"));