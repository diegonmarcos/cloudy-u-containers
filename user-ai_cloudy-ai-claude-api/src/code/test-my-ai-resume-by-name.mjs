// Tester: ticket #539 — :3117 must resume the saved orchestrator session,
// never spawn a blank `claude -p` per message, and an unreachable session
// store must fail with WORDS, never with a number.
//
// Drives the REAL server.mjs (the :3117 claude-superset front) on a temp port
// with a temp store and a SHIM `claude` binary that records its argv and
// stdin, so the assertions check what the real service actually spawns — the
// exact args, the exact prompt, the exact reply text. Self-contained: no real
// session, no real claude, no network beyond the loopback test listener.
//
// Mutation-proven (see ticket report for pasted runs):
//   * drop `--resume` from callClaude                       -> checks R1/R2 red
//   * resolve name→id only again (revert #525 reuse)        -> check R1 red
//   * fall through to a blank session when the store is
//     unreachable (no STORE_ERROR_WORDS early return)       -> check E1/E2 red
//   * emit a digit inside the store-error wording           -> check E2 red
//   * apply resume to excluded models too (drop the
//     RESUME_EXCLUDE_MODELS gate)                           -> check X1 red
//   * green on the tree at HEAD after the fix               -> all green
//
// Usage: node test-my-ai-resume-by-name.mjs   (exit 0 = PASS)
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const TMP = mkdtempSync(join(tmpdir(), "myai-claude-resume-539-"));
// Ports in the 23xxx/25xxx ranges — disjoint from the my-ai-api testers'
// fixed 13927/13928 so a parallel per-service-tests run cannot collide.
const PORT = 23000 + ((TMP.length * 2654435761) % 2000);
const OLLAMA = 25000 + ((TMP.length * 40503) % 2000);
const PORT2 = PORT + 4000;
const OLLAMA2 = OLLAMA + 4000;

const STORE = join(TMP, "store");
const DEAD_STORE = join(TMP, "store-missing");
mkdirSync(STORE, { recursive: true });
// #548 mounted-task-store fixture: the resume spawn reads the session's task
// store under HOME/.claude/tasks/<id>/. The resume test runs the REAL server.mjs,
// so HOME must be a temp dir whose task store is reachable or the reachability
// guard (deliverable 5) trips and the test asserts the error path, not a resume.
const TASK_HOME = join(TMP, "taskhome");
mkdirSync(join(TASK_HOME, ".claude", "tasks", "6f096941-091d-4b8f-a3bd-03c6f7bc8287"), { recursive: true });

// ── fixture store ───────────────────────────────────────────────────────────
// A real Claude-Code-shaped transcript whose derived name (deriveSessionName,
// last-prompt rung) is exactly "orchestrator live session". Small enough that
// the head/tail name windows cover it whole.
const FIXTURE_ID = "6f096941-091d-4b8f-a3bd-03c6f7bc8287";
const fixt = [
  JSON.stringify({ type: "checkpoint", uuid: FIXTURE_ID, cwd: "/home/appuser/git/work/orchestrator", version: 2 }),
  JSON.stringify({ type: "message", uuid: "msg-1", message: { role: "user", content: [{ type: "text", text: "first turn" }] } }),
  JSON.stringify({ type: "last-prompt", lastPrompt: "orchestrator live session" }),
  JSON.stringify({ type: "message", uuid: "msg-2", message: { role: "assistant", content: [{ type: "text", text: "ready" }] } }),
].join("\n") + "\n";
mkdirSync(join(STORE, "localhost"), { recursive: true });
writeFileSync(join(STORE, "localhost", `${FIXTURE_ID}.jsonl`), fixt);

// A SECOND session whose name starts with the same prefix — proves the resolver
// surfaces ambiguity instead of guessing between two sessions.
mkdirSync(join(STORE, "localhost2"), { recursive: true });
const FIXTURE_ID_2 = "aaaaaaaa-1111-2222-3333-444444444444";
writeFileSync(join(STORE, "localhost2", `${FIXTURE_ID_2}.jsonl`),
  JSON.stringify({ type: "last-prompt", lastPrompt: "orchestrator live session, other device" }) + "\n");

// ── shim `claude` ───────────────────────────────────────────────────────────
// Records argv + stdin so the test asserts what the server SPAWNS, then answers
// with the JSON shape `claude -p --output-format json` really produces.
const SHIM = join(TMP, "shim-claude.sh");
const argvFile = join(TMP, "last-argv.txt");
const promptFile = join(TMP, "last-prompt.txt");
const callFile = join(TMP, "call-count.txt");
const cwdFile = join(TMP, "last-cwd.txt");
writeFileSync(SHIM, `#!/usr/bin/env bash
printf '%s\n' "$@" > "\${SHIM_ARGV_FILE:-/tmp/_shim_argv}"
printf '%s' "\$PWD" > "\${SHIM_CWD_FILE:-/tmp/_shim_cwd}"
cat > "\${SHIM_PROMPT_FILE:-/dev/null}"
n=$(cat "\${SHIM_CALL_FILE:-/dev/null}" 2>/dev/null || echo 0)
echo $((n + 1)) > "\${SHIM_CALL_FILE:-/dev/null}"
printf '%s' '{"result":"shim-ok","usage":{"input_tokens":7,"output_tokens":2}}'
exit 0
`);
chmodSync(SHIM, 0o755);

// ── harness ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startServer = async (env, port, ollama) => {
  const child = spawn("node", ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRIDGE_PORT: String(port),
      BRIDGE_BIND: "127.0.0.1",
      BRIDGE_OLLAMA_PORT: String(ollama),
      BRIDGE_OLLAMA_BIND: "127.0.0.1",
      HEADROOM_ENABLED: "0",
      BRIDGE_DEFAULT_MODEL: "claude-sonnet-4-6",
      CLAUDE_BIN: SHIM,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return { child, out };
    } catch { /* not up yet */ }
  }
  child.kill();
  throw new Error(`server did not come up: ${out.slice(0, 500)}`);
};

const chat = async (port, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
};

const resetShim = () => {
  try { writeFileSync(argvFile, ""); writeFileSync(promptFile, ""); writeFileSync(callFile, "0"); } catch {}
};

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  <- ${detail}`}`);
  if (!ok) failures++;
};

// ── R1/R2: declared name resolves → `--resume <id>` and last-user prompt ──
{
  resetShim();
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live session",
    // #548: the resume spawn runs in the DECLARED project cwd so the transcript
    // lookup (keyed on the cwd slug) finds the session. TMP exists on the test
    // host; a production deployment declares the orchestrator's real slug dir.
    BRIDGE_RESUME_CWD: TMP,
    // #548 reachability guard needs a mounted task store at HOME/.claude/tasks/<id>.
    HOME: TASK_HOME,
    SHIM_ARGV_FILE: argvFile,
    SHIM_PROMPT_FILE: promptFile,
    SHIM_CALL_FILE: callFile,
    SHIM_CWD_FILE: cwdFile,
  }, PORT, OLLAMA);
  try {
    const res = await chat(PORT, {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "user", content: "first turn" },
        { role: "user", content: "second turn, the new message" },
      ],
    });
    const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n") : [];
    const prompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";
    const spawnedCwd = existsSync(cwdFile) ? readFileSync(cwdFile, "utf8") : "";
    check("R1 --resume carries the resolved session id", argv.includes("--resume") && argv[argv.indexOf("--resume") + 1] === FIXTURE_ID,
      `argv=${JSON.stringify(argv)}`);
    check("R1b #548 resume spawn runs in the DECLARED project cwd (transcript lookup keys on cwd slug)",
      spawnedCwd === TMP,
      `spawnedCwd=${JSON.stringify(spawnedCwd)}, TMP=${TMP}`);
    check("R2 resumed prompt is the LAST user turn only (no history echo)",
      prompt.trim() === "second turn, the new message",
      `prompt=${JSON.stringify(prompt)}`);
    check("R2b no --append-system-prompt on resume", !argv.includes("--append-system-prompt"), `argv=${JSON.stringify(argv)}`);
    check("R3 reply body is the shim text (normal 200 shape)", res.status === 200 && /shim-ok/.test(res.json?.choices?.[0]?.message?.content ?? ""),
      `status=${res.status} body=${JSON.stringify(res.json).slice(0, 160)}`);
  } finally { child.kill(); }
}

// ── E1/E2: declared name but store UNREACHABLE → LOUD words, never a number ─
{
  resetShim();
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: DEAD_STORE, // does not exist: the store cannot be read
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live session",
    SHIM_ARGV_FILE: argvFile,
    SHIM_PROMPT_FILE: promptFile,
    SHIM_CALL_FILE: callFile,
  }, PORT2, OLLAMA2);
  try {
    const res = await chat(PORT2, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "how many tasks are open?" }],
    });
    const text = res.json?.choices?.[0]?.message?.content ?? "";
    // #545: the SESSION store is what is dead here, not the task store. The two
    // failures now carry different prefixes on purpose — "[task store error]" is
    // reserved for a task store that was actually reached and could not be read.
    check("E1 reply is the worded session-store error", text.startsWith("[resume error]"), `reply=${JSON.stringify(text)}`);
    check("E2 reply contains NO digit anywhere", !/\d/.test(text), `reply=${JSON.stringify(text)}`);
    check("E3 no blank claude was spawned", (existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "0") === "0",
      `spawn-count=${existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "(no file)"}`);
  } finally { child.kill(); }
}

// ── F1: NAME RESOLVES but the MOUNTED TASK STORE is unreachable → words ───
// #548's real gap: 547 covered only a name that cannot be resolved. The deeper
// defect is a RESOLVED name whose ~/.claude/tasks/<id>/ mounted store is absent
// or unreadable — claude would then spawn into an empty task dir and TaskList
// would legitimately return 0, rendering absence as a confident number. A count
// may only be emitted from a store that was READ; this block proves absence of
// the mounted task store fails loud (mutation: drop the assertTaskStoreReachable
// call in run() → this block goes RED with a number and a spawn).
{
  resetShim();
  const port = PORT + 3000;
  // Session store is REACHABLE (the name resolves) but HOME has NO task store.
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live session",
    BRIDGE_RESUME_CWD: TMP,
    HOME: join(TMP, "no-task-home"), // exists, but no .claude/tasks/<id>
    SHIM_ARGV_FILE: argvFile,
    SHIM_CALL_FILE: callFile,
  }, port, OLLAMA + 3000);
  try {
    const res = await chat(port, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "how many tasks are open?" }],
    });
    const text = res.json?.choices?.[0]?.message?.content ?? "";
    check("F1 resolved name + unreachable task store → worded error", text.startsWith("[task store error]"), `reply=${JSON.stringify(text)}`);
    check("F1b reply contains NO digit anywhere", !/\d/.test(text), `reply=${JSON.stringify(text)}`);
    check("F1c no claude was spawned (no number could be fabricated)",
      (existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "0") === "0",
      `spawn-count=${existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "(no file)"}`);
  } finally { child.kill(); }
}

// ── G1: resolved name + REACHABLE mounted task store → resume succeeds ──────
// The positive control for F1: the same session, but the task store IS mounted,
// must resume (--resume with the declared cwd) and return the shim body — NOT
// the worded error. Together F1/G1 prove the guard discriminates on the mounted
// task store, the exact #548 before/after control (0 → real count).
{
  resetShim();
  const port = PORT + 4000;
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live session",
    BRIDGE_RESUME_CWD: TMP,
    HOME: TASK_HOME, // reachable task store
    SHIM_ARGV_FILE: argvFile,
    SHIM_CALL_FILE: callFile,
  }, port, OLLAMA + 4000);
  try {
    const res = await chat(port, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "second turn, the new message" }],
    });
    const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n") : [];
    const text = res.json?.choices?.[0]?.message?.content ?? "";
    check("G1 reachable task store → --resume spawns (not the error path)", argv.includes("--resume"), `argv=${JSON.stringify(argv)}`);
    check("G1b reachable task store → shim reply, no error words", /shim-ok/.test(text), `reply=${JSON.stringify(text)}`);
  } finally { child.kill(); }
}

// ── M1: declared name matches nothing → same LOUD words ─────────────────────
{
  resetShim();
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "a name that does not exist in the store",
    SHIM_ARGV_FILE: argvFile,
  }, PORT2 + 8000, OLLAMA2 + 8000);
  try {
    const res = await chat(PORT2 + 8000, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "how many tasks are open?" }],
    });
    const text = res.json?.choices?.[0]?.message?.content ?? "";
    check("M1 unresolvable name → worded error", text.startsWith("[resume error]") && /no session matched/.test(text), `reply=${JSON.stringify(text)}`);
  } finally { child.kill(); }
}

// ── A1: declared name is a prefix of SEVERAL sessions → ambiguous, no digit ──
{
  resetShim();
  const port = PORT2 + 9000;
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live", // prefix of both fixtures
    SHIM_ARGV_FILE: argvFile,
    SHIM_CALL_FILE: callFile,
  }, port, OLLAMA2 + 9000);
  try {
    const res = await chat(port, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "how many tasks are open?" }],
    });
    const text = res.json?.choices?.[0]?.message?.content ?? "";
    check("A1 ambiguous name → worded error", text.startsWith("[resume error]") && /ambiguous/.test(text), `reply=${JSON.stringify(text)}`);
    check("A1b ambiguous reply contains NO digit", !/\d/.test(text), `reply=${JSON.stringify(text)}`);
    check("A1c no blank claude was spawned", (existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "0") === "0",
      `spawn-count=${existsSync(callFile) ? readFileSync(callFile, "utf8").trim() : "(no file)"}`);
  } finally { child.kill(); }
}

// ── N1: NO declaration → current fresh-spawn behaviour (no --resume) ────────
{
  resetShim();
  const port = PORT2 + 12000;
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE, // no BRIDGE_RESUME_SESSION_NAME
    SHIM_ARGV_FILE: argvFile,
    SHIM_PROMPT_FILE: promptFile,
  }, port, OLLAMA2 + 12000);
  try {
    await chat(port, { model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello" }] });
    const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n") : [];
    check("N1 undeclared target → no --resume (fresh session path preserved)", !argv.includes("--resume"), `argv=${JSON.stringify(argv)}`);
  } finally { child.kill(); }
}

// ── X1: excluded model (haiku indexing) does NOT append into the session ───
{
  resetShim();
  const port = PORT2 + 16000;
  const { child } = await startServer({
    BRIDGE_SESSIONS_DIR: STORE,
    BRIDGE_RESUME_SESSION_NAME: "orchestrator live session",
    BRIDGE_RESUME_EXCLUDE_MODELS: JSON.stringify(["claude-haiku-4-5"]),
    BRIDGE_MODEL_ALIASES: JSON.stringify({ "claude-sonnet": "claude-sonnet-4-6", "claude-haiku": "claude-haiku-4-5" }),
    SHIM_ARGV_FILE: argvFile,
  }, port, OLLAMA2 + 16000);
  try {
    await chat(port, { model: "claude-haiku:latest", messages: [{ role: "user", content: "index this" }] });
    const argv = existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n") : [];
    check("X1 haiku indexing stays one-shot (no --resume)", !argv.includes("--resume"), `argv=${JSON.stringify(argv)}`);
  } finally { child.kill(); }
}

console.log(failures === 0 ? "ALL GREEN" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);