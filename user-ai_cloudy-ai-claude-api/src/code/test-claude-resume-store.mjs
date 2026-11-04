// Tester ticket #548 — the claude backend must NOT answer "0" when the mounted
// task store holds real sessions, and must NEVER render absence as a number.
//
// It exercises claude-resume.mjs (the shared module server.mjs now uses for the
// spawn) against a THROWAWAY store built on the fly, proving the four mutation
// proofs the ticket demands as RED (broken) vs GREEN (fixed):
//
//   M1  RED when tasks/** is absent while projects/** is present — the exact
//       bug: a store holding transcripts but no task dirs reproduces "0 tasks".
//   M2  RED when the store is unreachable and the answer is a NUMBER instead
//       of an explicit error. countTaskFiles returns null (NOT 0) and
//       assertTaskStoreReachable returns an error object the caller must
//       surface.
//   M3  RED when the fix lives in src/ but dist/ carries the old code — the
//       test asserts the DIST copy of claude-resume.mjs (the code /app runs)
//       carries the reachability contract, not just the src copy.
//   M4  RED when a session is pasted by uuid/name instead of resolved via
//       #525 — buildClaudeArgv refuses a non-resolved-id session ref.
//
// Ticket #545 added two more, for the defect one layer up: the store was
// REACHABLE and the bot still failed, because the declared resume ADDRESS was a
// served name — content Claude Code rewrites every single turn.
//
//   M5  RED when the target is a declared string instead of derived — the
//       address must be the session under the declared cwd holding the fullest
//       mounted task store, and a session with zero task files is never it.
//   M6  RED when an addressing MISS prints "the task store is unreachable".
//       That sentence is a claim about IO the code never made, and it was
//       printed in the same breath as "no session matched that name".
//
// Run from the service src/code dir:  node test-claude-resume-store.mjs
// exit 0 = PASS (all mutations defeated), non-zero = FAIL.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClaudeArgv,
  countTaskFiles,
  assertTaskStoreReachable,
  taskStoreUnreachableReason,
  isResolvedSessionId,
  cwdSlug,
  deriveResumeSession,
  RESUME_ERROR_WORDS,
} from "./claude-resume.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (cond, label) => {
  if (cond) { console.log(`  PASS  ${label}`); }
  else { failures++; console.log(`  FAIL  ${label}`); }
};

const SESSION = "6f096941-091d-4b8f-a3bd-03c6f7bc8287"; // resolved id (uuid)
const base = fs.mkdtempSync(path.join(os.tmpdir(), "claude-resume-tst-"));

// ── M1: tasks/** absent while projects/** present → the exact #548 bug ──────
{
  const home = path.join(base, "m1");
  // transcripts present, task store absent — the teleport state Diego measured.
  fs.mkdirSync(path.join(home, ".claude", "projects", "-home-diego"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-home-diego", `${SESSION}.jsonl`), "{}\n");
  const n = countTaskFiles(home, SESSION);
  check(n === null, "M1: tasks/** absent (projects present) is UNREACHABLE (null), not 0");
  check(n !== 0, "M1: absent task store never reads as the number 0");
}

// ── M2: store unreachable → explicit error, never a number ──────────────────
{
  const home = path.join(base, "m2");
  fs.mkdirSync(home, { recursive: true }); // no .claude/tasks at all
  const guard = assertTaskStoreReachable({ claudeHome: home, session: SESSION });
  check(guard && guard.ok === false, "M2: unreachable store yields an explicit guard error");
  check(guard && /task store/i.test(guard.message), "M2: guard error names the task store");
  check(typeof taskStoreUnreachableReason(home, SESSION) === "string"
        && taskStoreUnreachableReason(home, SESSION).length > 0,
        "M2: taskStoreUnreachableReason returns a reason, not a number");
}

// ── M3: dist/ must carry the contract, not just src/ ────────────────────────
// The container runs /app/* which is the DIST copy. A fix confined to src/ with
// dist still holding a version that countTaskFiles-returns-0-or-silently-skips
// reproduces the identical "0 tasks" bug one layer up.
{
  const src = path.join(__dir, "claude-resume.mjs");
  const dist = path.join(__dir, "..", "..", "dist", "code", "arm64", "claude-resume.mjs");
  check(fs.existsSync(src), "M3: src claude-resume.mjs exists");
  if (fs.existsSync(dist)) {
    const distText = fs.readFileSync(dist, "utf8");
    // The dist copy must carry the reachability contract: it must distinguish
    // an absent store (null) from zero, and it must not be a stale pre-fix copy.
    check(/absent or unreadable → UNREACHABLE, never 0|return null; \/\/ absent/.test(distText),
          "M3: dist/claude-resume.mjs returns null on absent store (reachability contract present)");
    check(distText.includes("countTaskFiles"), "M3: dist/claude-resume.mjs defines countTaskFiles");
  } else {
    // my-ai_claude-api is a Type-B build — src/code IS the build context; there
    // is no committed dist/code/arm64 tree to go stale. The mutation that MUST
    // catch drift lives where the runner compares src vs dist (my-ai-api), so
    // here we assert the file exists in the Dockerfile's /app COPY list.
    const df = path.join(__dir, "Dockerfile");
    const dfText = fs.existsSync(df) ? fs.readFileSync(df, "utf8") : "";
    check(/COPY .*claude-resume\.mjs/.test(dfText),
          "M3: claude-resume.mjs is COPY'd into /app (the deployed code) — no stale dist separation for Type-B");
  }
}

// ── M4: session must be a RESOLVED id, never a pasted name/uuid ─────────────
{
  const baseArgs = ["-p", "--output-format", "json"];
  // resolved id → --resume is emitted
  const ok = buildClaudeArgv({ baseArgs, session: SESSION, cwd: "/home/appuser", });
  check(ok.argv.includes("--resume") && ok.argv.includes(SESSION),
        "M4: a resolved id becomes --resume <id>");
  check(ok.spawnOpts.cwd === "/home/appuser", "M4: the resolved session's cwd is set on the spawn");
  // pasted NAME → refused (that is #525's job, never this module's)
  let nameRefused = false;
  try { buildClaudeArgv({ baseArgs, session: "cloud-mail", cwd: "/x" }); } catch { nameRefused = true; }
  check(nameRefused, "M4: a pasted NAME is refused (must resolve through #525 first)");
  // pasted non-session garbage → refused
  let garbRefused = false;
  try { buildClaudeArgv({ baseArgs, session: "not-a-uuid-or-known-name", cwd: "/x" }); } catch { garbRefused = true; }
  check(garbRefused, "M4: garbage / un-resolved refs are refused, never silently trusted");
  check(isResolvedSessionId(SESSION) === true, "M4: resolver ids pass isResolvedSessionId");
  check(isResolvedSessionId("cloud-mail") === false, "M4: names fail isResolvedSessionId");
}

// ── M5 (#545): the address is DERIVED, so a stale declared name cannot break it ─
// The live defect: build.json declared the session's SERVED name, which is built
// from the newest last-prompt record and therefore rewritten every turn. Measured
// 2026-09-20 the served name had become the literal word "go". Nothing about the
// declaration can be allowed to drift — the target is the session under the
// declared cwd holding the fullest mounted task store.
{
  const home = path.join(base, "m5");
  const CWD = "/home/appuser/git/_work/orchestrator";
  const SLUG = "-home-appuser-git--work-orchestrator";
  check(cwdSlug(CWD) === SLUG, `M5: cwd slugs forward exactly as Claude writes it (got ${cwdSlug(CWD)})`);

  const proj = path.join(home, ".claude", "projects", SLUG);
  fs.mkdirSync(proj, { recursive: true });
  const FULL  = "6f096941-091d-4b8f-a3bd-03c6f7bc8287"; // the real orchestrator session
  const THIN  = "11111111-2222-3333-4444-555555555555";
  const BLANK = "99999999-8888-7777-6666-555555555555"; // the #548 blank session
  for (const id of [FULL, THIN, BLANK]) fs.writeFileSync(path.join(proj, `${id}.jsonl`), "{}\n");
  // a rolled shard (#506) sits beside the live transcript and must not be a target
  fs.writeFileSync(path.join(proj, `${FULL}.part2.jsonl`), "{}\n");
  const seed = (id, n) => {
    const d = path.join(home, ".claude", "tasks", id);
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < n; i++) fs.writeFileSync(path.join(d, `${i}.json`), "{}");
  };
  seed(FULL, 510);
  seed(THIN, 4);
  seed(BLANK, 0); // reachable but EMPTY — resuming it is how absence rendered as a number

  const got = deriveResumeSession(home, CWD);
  check(got && got.id === FULL, `M5: the fullest mounted task store wins (got ${got && got.id})`);
  check(got && got.taskCount === 510, `M5: the derivation reports the real count (got ${got && got.taskCount})`);
  // A blank session must be REJECTED, not merely out-scored. Asserting `!== BLANK`
  // against the set above proves nothing: FULL wins on 510 task files whether or
  // not the blank is eligible, so the assertion holds even with the rejection
  // removed. The guard only fails when the blank is the ONLY candidate — that is
  // the #548 shape, a project whose one session carries no tasks, where an
  // eligible blank IS returned and its zero renders as an answer.
  const ONLY_BLANK = "/home/appuser/git/_work/blank-only";
  const bproj = path.join(home, ".claude", "projects", cwdSlug(ONLY_BLANK));
  fs.mkdirSync(bproj, { recursive: true });
  const LONE = "00000000-1111-2222-3333-444444444444";
  fs.writeFileSync(path.join(bproj, `${LONE}.jsonl`), "{}\n");
  seed(LONE, 0);
  check(deriveResumeSession(home, ONLY_BLANK) === null,
        "M5: a session with ZERO task files is never the resume target, even as the only candidate (#548)");
  // A cwd nobody has a transcript under must be null — NOT a guess at some other
  // project's session, which would answer from the wrong conversation.
  check(deriveResumeSession(home, "/home/appuser/git/_work/nothing") === null,
        "M5: an unknown project cwd derives nothing, never another project's session");
  check(deriveResumeSession(path.join(base, "does-not-exist"), CWD) === null,
        "M5: an unmounted claude home derives nothing");
}

// ── M6 (#545): a MISS must not claim the store was unreachable ──────────────
// The pasted failure was one sentence contradicting itself: "the task store is
// unreachable … reason: no session matched that name". The store had just been
// read (40 sessions, hundreds of task files). One sentence per verdict, and no
// verdict sentence may carry a digit.
{
  for (const [kind, words] of Object.entries(RESUME_ERROR_WORDS)) {
    check(!/\d/.test(words), `M6: ${kind} wording carries no digit (absence may never render as a number)`);
    check(/no task count or status is available/.test(words),
          `M6: ${kind} wording says plainly that no count is available`);
  }
  check(!/unreachable/i.test(RESUME_ERROR_WORDS.unaddressed),
        "M6: an addressing miss does NOT claim the task store was unreachable");
  check(!/unreachable/i.test(RESUME_ERROR_WORDS.ambiguous),
        "M6: an ambiguous name does NOT claim the task store was unreachable");
  check(/ambiguous/i.test(RESUME_ERROR_WORDS.ambiguous), "M6: the ambiguous verdict says ambiguous");
  check(/session store/i.test(RESUME_ERROR_WORDS.session_store_void),
        "M6: a void session listing names the SESSION store, not the task store");
  // The declaration must not re-introduce a drifting address: a served name is
  // rewritten every turn, so build.json's pin is empty unless something stable
  // (a custom-title) is deliberately pinned.
  const bj = JSON.parse(fs.readFileSync(path.join(__dir, "..", "..", "build.json"), "utf8"));
  const rs = bj.runtime.resume_session;
  check(typeof rs.cwd === "string" && rs.cwd.length > 0,
        "M6: build.json declares the project cwd — the address the target is derived from");
  check(rs.name === "", "M6: build.json pins no session NAME (a served name drifts every turn — #545)");
}

// ── GREEN end-to-end: reachable store counts real files ─────────────────────
{
  const home = path.join(base, "green");
  const tasksDir = path.join(home, ".claude", "tasks", SESSION);
  fs.mkdirSync(tasksDir, { recursive: true });
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(tasksDir, `t${i}.json`), "{}");
  fs.writeFileSync(path.join(tasksDir, "not-a-task.txt"), "x"); // non-.json ignored
  const n = countTaskFiles(home, SESSION);
  check(n === 3, `GREEN: reachable task store counts only .json task files (got ${n}, want 3)`);
  check(assertTaskStoreReachable({ claudeHome: home, session: SESSION }) === null,
        "GREEN: reachable store passes the guard (no error)");
}

fs.rmSync(base, { recursive: true, force: true });
console.log(failures === 0 ? "\nPASS: all #548 resume/store mutations defeated" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);