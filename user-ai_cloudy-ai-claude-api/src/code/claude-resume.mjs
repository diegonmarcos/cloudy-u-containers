// claude-resume.mjs — the ONE place the claude backend turns a *resolved*
// session into `claude -p --resume <session> --cwd <dir>` spawn arguments, and
// the ONE place that answers "is the mounted task store reachable?".
//
// Ticket #548: the claude backend returned "0 tasks" because a fresh `claude
// -p` spawn lands in a brand-new session uuid whose `~/.claude/tasks/<uuid>/`
// directory is empty — Claude keeps the *task store* (keyed by session uuid) in
// a separate tree from the transcript store (`~/.claude/projects/...`), and the
// teleport shipped only the transcript half. The bot therefore asked a session
// that had no task files, and Claude's TaskList legitimately returned zero.
//
// The fix has two halves and BOTH are declared here, not scattered:
//
//  1. SPAWN: when a caller supplies a resolved session id + its project cwd
//     (already resolved by name upstream — see #525's resolveResumeAddress in
//     the goose gateway's sessions-store.mjs), pass `--resume <id>` AND spawn
//     with `--cwd` set to the session's project slug. Claude then lands in the
//     session whose task directory was just mounted, so TaskList reads the
//     real files instead of an empty fresh dir.
//
//     This module does NOT resolve names to ids. Resolution is #525's job and
//     lives in ONE place (sessions-store.mjs). A caller that hands this module
//     a raw uuid it guessed instead of a session the resolver returned is a
//     bug upstream, and this module refuses to be a second resolver — it only
//     trusts ids that resolve against the mounted store.
//
//  2. ABSENCE-IS-LOUD: "the store is unreachable" must never render as a
//     number. If a resume was requested but the mounted task store for that
//     session cannot be read, callers get an EXPLICIT error object. A bot
//     that relays "0" when the real answer is unknowable is the exact failure
//     family #400/#509/#548 is about.
//
// Pure / side-effect-free: import this from server.mjs and from tests.
import fs from "node:fs";
import path from "node:path";

// #525's resolver (goose gateway, sessions-store.mjs) turns a NAME into a
// session id. This module RECEIVES the resolved id — it never resolves a name
// itself (that would be the second resolver the ticket forbids). It accepts a
// value ONLY if it is an already-resolved session id (or absent). A caller that
// hands it a name ("cloud-mail") or a guessed literal uuid instead of the
// resolver's answer is rejected, so the spawn can never land in a session the
// store did not declare. This is what keeps the "pasted vs resolved" contract
// testable in isolation.
const RESOLVED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isResolvedSessionId = (s) =>
  typeof s === "string" && RESOLVED_ID_RE.test(s.trim());

// Where a session's Claude task files live, relative to a claude home (the
// mounted store). Keyed by session uuid — NOT by cwd — which is the whole
// reason a fresh spawn saw nothing.
export const taskStoreDir = (claudeHome, sessionId) =>
  path.join(claudeHome, ".claude", "tasks", String(sessionId || ""));

// Number of task JSON files in a session's store. Returns a number >= 0 when
// readable; null when the store is unreachable (missing dir / unreadable).
// Callers MUST check `=== null` and surface an error — a null is NOT zero.
export const countTaskFiles = (claudeHome, sessionId) => {
  const dir = taskStoreDir(claudeHome, sessionId);
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return null;
    const entries = fs.readdirSync(dir);
    let n = 0;
    for (const e of entries) {
      const p = path.join(dir, e);
      try { if (fs.statSync(p).isFile() && e.endsWith(".json")) n++; } catch { /* unreadable single file: still count reachable dir */ }
    }
    return n;
  } catch {
    return null; // absent or unreadable → UNREACHABLE, never 0
  }
};

// Human-readable reason the store is unreachable (or "" when reachable).
// DELIBERATELY digit-free: this string is relayed verbatim into the chat, and a
// count may never be emitted from a store that was not read. The session id is
// NOT embedded — a uuid carries digits, and "no digit in the reply" is the
// #400/#509/#548 contract. The path may be logged elsewhere for an operator; the
// user-visible reason only says WHICH store and WHY, never a number.
export const taskStoreUnreachableReason = (claudeHome, sessionId) => {
  const dir = taskStoreDir(claudeHome, sessionId);
  if (!sessionId) return "the task store is unreachable because no session was addressed";
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return "the mounted task store for this session is not a directory";
    return ""; // dir exists → reachable (an empty dir is a legitimate 0-task read, not absence)
  } catch (e) {
    if (e.code === "ENOENT") return "the task store for this session is missing — is the agi-memory store mounted into this container?";
    return `the task store is unreadable: ${e.code || e.message}`;
  }
};

// Build the `claude -p` argument vector for a (possibly resumed) call.
//   - session: resolved session id (from #525's resolver) — optional.
//   - cwd:     the project directory that session's transcript lives under.
// Returns { argv, spawnOpts } where argv is the full argument list for
// spawn(claude, argv, spawnOpts) and spawnOpts carries the cwd when set.
export const buildClaudeArgv = ({ baseArgs, session, cwd }) => {
  const argv = [...(baseArgs || [])];
  const spawnOpts = {};
  if (session) {
    // session is a RESOLVED id only — never a name, never a guessed uuid.
    if (!isResolvedSessionId(session)) {
      throw new Error(
        `refusing to spawn with an unresolved session ref "${session}" — ` +
        "resume sessions must come from the #525 resolver, not a pasted name/uuid");
    }
    argv.push("--resume", session.trim());
  }
  if (cwd) {
    spawnOpts.cwd = String(cwd);
  }
  return { argv, spawnOpts };
};

// ── #545: the resume ADDRESS is derived, never a snapshot of a prompt ────────
// A session's SERVED name (deriveSessionName) is a display label built from the
// newest `last-prompt` record, and Claude Code appends one every single turn.
// Declaring that label as the resume address therefore declares something that
// changes on every message: measured 2026-09-20, the orchestrator session's
// served name had become the literal word "go" while build.json still carried a
// days-old prompt tag, so every request missed and the bot answered with an
// error instead of the task count. Re-snapshotting the name fixes it until the
// next message — the address itself has to stop being mutable content.
//
// What IS stable about the target is what the bot is FOR: it is the session
// that owns the task store. So the address is derived at request time — among
// the sessions whose transcript lives under the declared project cwd, the one
// holding the most task files. Same fullest-store heuristic the backlog display
// uses (canonicalSessionDir in cloud-me-pvt-my-ai/1.1.Product-Backlog), and
// it self-corrects when the orchestrator session rotates instead of going stale.

// Claude slugs a cwd into its transcript directory name by replacing every
// non-alphanumeric character with "-":
//   /home/appuser/git/_work/orchestrator → -home-appuser-git--work-orchestrator
// Forward-only on purpose: un-slugging is ambiguous ("_" and "/" both became
// "-"), so the declared cwd is slugged to find the dir, never the other way.
export const cwdSlug = (cwd) => String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");

// The resumable session for a project cwd: the one whose mounted task store
// holds the most files. Sessions with NO readable task store are skipped — one
// of them is exactly the blank session whose TaskList answers zero (#548), and
// resuming it would render absence as a plausible number. Returns
// { id, taskCount } or null when nothing under this cwd has a task store.
export const deriveResumeSession = (claudeHome, cwd) => {
  const dir = path.join(claudeHome, ".claude", "projects", cwdSlug(cwd));
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  let best = null;
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    // Bare-uuid files only: #506's rollover leaves suffixed shards beside the
    // live transcript, and the live file is the one that carries the resume.
    const id = f.slice(0, -6);
    if (!isResolvedSessionId(id)) continue;
    const taskCount = countTaskFiles(claudeHome, id);
    if (!taskCount) continue; // null (unreachable) or 0 (blank) are both "not a target"
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch { /* raced away: mtime 0 loses ties */ }
    // Fullest wins; equal stores are settled by the newest transcript so the
    // pick is deterministic rather than readdir order.
    if (!best || taskCount > best.taskCount || (taskCount === best.taskCount && mtime > best.mtime)) {
      best = { id, taskCount, mtime };
    }
  }
  return best ? { id: best.id, taskCount: best.taskCount } : null;
};

// ── #545: one sentence per VERDICT ───────────────────────────────────────────
// Every resume failure used to print "the task store is unreachable", including
// a pure addressing miss — so a store that had just been read (40 sessions
// listed, hundreds of task files) was reported to Diego as an IO failure, in the
// same sentence as "no session matched that name". A message that contradicts
// itself is worse than no message: it sends the reader to the wrong half of the
// system. These are the only words a failed resume may produce, and they are
// number-free — a count may only ever be emitted by a store that was read.
export const RESUME_ERROR_WORDS = {
  // The declared name matched nothing AND no session under the declared project
  // has a task store. Nothing was wrong with reading; nothing was addressable.
  unaddressed:
    "[resume error] no session matched the declared name and none could be derived from the mounted task store, so I could not load the saved session. no task count or status is available.",
  // A declared name that belongs to several distinct sessions. Picking one
  // silently is how a resume lands in the wrong conversation.
  ambiguous:
    "[resume error] the declared session name is ambiguous — more than one saved session answers to it, so I will not guess which. no task count or status is available.",
  // The session listing itself came back empty/unreadable.
  session_store_void:
    "[resume error] the session store could not be read, so no saved session was found. no task count or status is available.",
};

// Guard used by server.mjs BEFORE a resumed spawn: if the request asked to
// resume a session but its task store is unreachable, return the error object
// so the caller surfaces an explicit message instead of a number.
export const assertTaskStoreReachable = ({ claudeHome, session }) => {
  if (!session) return null; // not a resumed call — nothing to verify
  const reason = taskStoreUnreachableReason(claudeHome, session);
  if (reason) {
    return {
      ok: false,
      type: "superset_task_store_unreachable",
      message: `cannot resume: ${reason}`,
    };
  }
  return null;
};
