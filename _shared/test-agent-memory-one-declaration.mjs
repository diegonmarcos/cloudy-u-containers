// Tester: ticket #556 — EVERY oci-apps agent has the memory system, and the
// layout that made it affordable cannot be undone.
//
// THE DEFECT THIS PINS. #556's first pass wired the memory store into the
// claude container by declaring `runtime.memory` in my-ai_claude-api's OWN
// build.json. Measured inside the running containers 2026-09-24:
//
//   cloud-agi-claude   AGENT_MEMORY_DIR=/home/appuser/git/cloud-me-pvt-my-ai/4___ASSETS___/4.3.Memory/home-diego
//   my-ai-api (goose)  AGENT_GIT_TREE only — no AGENT_MEMORY_* at all
//   hermes-agent       AGENT_GIT_TREE only — no AGENT_MEMORY_* at all
//
// Two of the three agents still ran with zero recall behind a ticket that read
// as done. That is the per-container-declaration-of-a-fleet-wide-fact shape
// #561 removed from `agent.git_tree_mount`, returning through a different door.
//
// WHY THIS EVALUATES INSTEAD OF GREPPING. Every value here is DERIVED: the
// store's absolute path from the git-tree mount, the briefing text from the
// path, the per-runtime env alias from build.json. Grepping for the strings
// would pass just as happily if agent-memory.nix hardcoded the path and ignored
// the mount — the "green that verified nothing" shape this fleet keeps
// producing. So _shared/agent-memory.nix is EVALUATED (builtins only, no pkgs,
// no lib, same as memory-ceiling.nix), and the load-bearing assertions
// re-evaluate it MUTATED to prove the outputs follow their inputs.
//
// THE OTHER HALF — the layout. Claude Code auto-loads the index PLUS every .md
// under a SUBDIRECTORY of the index's directory. A reorg into memory/<type>/
// turned 129 entries into auto-loaded imports and took session preload from
// ~4.5k to ~87k tokens (350,661 chars). So the briefing must forbid both the
// subdirectory and the bulk read, in words, because the agent is the thing that
// would recreate it.
//
// Usage: node _shared/test-agent-memory-one-declaration.mjs   (cwd anywhere)
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SHARED, "..");

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS ${n}`))
  : (fail++, console.error(`FAIL ${n}${d ? ` — ${d}` : ""}`));

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

// ── nix is a HARD dependency, never a skip ──────────────────────────────────
// A tester that quietly passes when its evaluator is missing reports coverage
// it does not have — the same defect one layer up.
let nixOk = true;
try { execFileSync("nix-instantiate", ["--version"], { stdio: "pipe" }); }
catch { nixOk = false; }
check("N0 nix-instantiate is available (this tester EVALUATES, it does not grep)",
  nixOk, "install nix in the job — a missing evaluator must fail, not skip");
if (!nixOk) { console.error("NOT GREEN"); process.exit(1); }

const nixEval = (expr) => JSON.parse(execFileSync(
  "nix-instantiate", ["--eval", "--strict", "--json", "--expr", expr],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// { ok: true } when the expression evaluates, { ok: false } when it throws.
const nixThrows = (expr) =>
  !nixEval(`(builtins.tryEval (builtins.deepSeq (${expr}) "ok")).success`);

// Render the module. The mount is the input worth mutating: every other value
// is derived from it, so a hardcoded path shows up as a mutation that does not
// move. A build.json carrying runtime.memory is exercised separately (A7).
const mem = (mount = "/home/appuser/git") => nixEval(`
  let m = import ./_shared/agent-memory.nix {
    gitTreeMount = "${mount}";
    buildJson = { runtime = {}; };
    title = "tester";
  };
  # aliasEnv is a function; drop it so the rest can serialise.
  in builtins.removeAttrs m [ "aliasEnv" ]`);

// ── A: ONE declaration ──────────────────────────────────────────────────────
check("A0 _shared/agent-memory.nix exists — the single declaration",
  existsSync(join(SHARED, "agent-memory.nix")));

const engine = read("_shared/engine.nix");
check("A1 engine.nix imports it rather than carrying its own copy",
  /import\s+\.\/agent-memory\.nix\s*\{/.test(engine));
check("A2 the module is handed the SAME mount the tree uses",
  /import\s+\.\/agent-memory\.nix\s*\{\s*\n?\s*gitTreeMount\s*=\s*gitTreeMountPath;/.test(engine),
  "a second path literal here is the drift this ticket is about");
check("A3 engine.nix splices the env into the git-tree contract",
  /\/\/\s*agentMemory\.env\b/.test(engine));
check("A4 engine.nix splices the per-runtime alias too",
  /\/\/\s*\(agentMemory\.aliasEnv\s+agentSpec\)/.test(engine));
// The negative that matters: no literal store path anywhere but the module.
// dist/ is excluded because it is the module's own RENDERED output (a compose
// file carries AGENT_MEMORY_DIR because agent-memory.nix put it there), not a
// second hand-written declaration; a stale dist is caught by Ship's
// committed-dist check, not here. Every source file is still scanned.
{
  const strays = execFileSync("sh", ["-c",
    "grep -rl --exclude-dir=dist '4___ASSETS___/4.3.Memory/home-diego' --include='*.nix' --include='*.sh' --include='*.mjs' --include='*.yaml' --include='*.yml' . "
    + "| grep -v '^./_shared/agent-memory.nix$' | grep -v '^./_shared/test-agent-memory-one-declaration.mjs$' || true"],
    { cwd: ROOT, encoding: "utf8" }).trim();
  check("A5 the store path is written in exactly ONE place",
    strays === "",
    `also names it: ${strays.split("\n").join(", ")} — each copy is a place it can drift`);
}
// And no build.json may re-declare it: the guard must exist AND fire.
{
  const decls = execFileSync("sh", ["-c",
    "grep -l '\"memory\": {' */build.json 2>/dev/null || true"],
    { cwd: ROOT, encoding: "utf8" }).trim();
  check("A6 no build.json declares runtime.memory any more", decls === "",
    `still declared in: ${decls.split("\n").join(", ")}`);
}
check("A7 a build.json that re-declares runtime.memory is a BUILD ERROR",
  nixThrows(`import ./_shared/agent-memory.nix {
      gitTreeMount = "/home/appuser/git";
      buildJson = { runtime = { memory = { dir = "somewhere/else"; }; }; };
      title = "tester";
    }`),
  "a silently-ignored stale declaration reads as live — that is where this value came from");

// ── D: the values are DERIVED, not retyped ──────────────────────────────────
const base = mem();
check("D1 the store resolves under the shared tree mount",
  base.dir === "/home/appuser/git/cloud-me-pvt-my-ai/4___ASSETS___/4.3.Memory/home-diego", base.dir);
check("D2 the absolute path FOLLOWS the mount (mutation)",
  mem("/mnt/elsewhere").dir === "/mnt/elsewhere/cloud-me-pvt-my-ai/4___ASSETS___/4.3.Memory/home-diego",
  `got ${mem("/mnt/elsewhere").dir} — a hardcoded path would have ignored the mutated mount`);
check("D3 the briefing FOLLOWS the mount too (mutation)",
  mem("/mnt/elsewhere").briefing.includes("/mnt/elsewhere/cloud-me-pvt-my-ai")
  && !mem("/mnt/elsewhere").briefing.includes("/home/appuser/git/cloud-data"),
  "the text an agent is shown must be derived from the same binding, not pasted");
check("D4 the entry types are an enumerated list, not free text",
  Array.isArray(base.types) && base.types.length === 4
  && ["feedback", "project", "reference", "user"].every((t) => base.types.includes(t)),
  JSON.stringify(base.types));

// ── L: the layout that cost 82k tokens/session ──────────────────────────────
check("L1 entries are a SIBLING of the index, never nested under it",
  !base.entries.includes("/") && !base.entries.startsWith(base.index),
  `entries=${base.entries} — a path under the index's directory is auto-loaded`);
check("L2 the briefing FORBIDS anything else beside the index",
  /NEVER put anything else in memory\/ — above all no subdirectory/.test(base.briefing),
  "the agent is the thing that would recreate the blowup");
check("L3 the briefing carries the MEASUREMENT, not just the rule",
  /4\.5k/.test(base.briefing) && /87k/.test(base.briefing),
  "a rule without its cost gets optimised away by the next agent");
check("L4 the briefing FORBIDS bulk-reading the entries",
  /NEVER bulk-read the entries/.test(base.briefing));
check("L5 the briefing is the POINTER, never the index content",
  base.briefing.length < 2000,
  `briefing is ${base.briefing.length} chars — pasting the index into every request is the same bulk load`);
check("L6 absence is LOUD — the agent is told it has no recall",
  /WITHOUT recall/.test(base.briefing),
  "an agent that cannot read the index must not answer from the conversation as though it could");
check("L7 recalled entries are flagged as possibly stale",
  /VERIFY it still exists/.test(base.briefing));
check("L8 the write rule travels with the read rule",
  /Add ONE line/.test(base.briefing) && /NEVER put entry content in the index/.test(base.briefing),
  "an agent that can read but not write the store accumulates nothing");

// ── X: ONE pointer convention (#556 second pass) ────────────────────────────
// The index used to be read from the store root while every pointer in it was
// written ../memory-entries/... (relative to a memory/ dir, the shape the
// devices see through ~/.claude/projects/<slug>/memory). From the store root
// that pointer resolved to a directory that does not exist, and the hook taught
// a third form. So: the index has its own directory, and the pointer the agents
// are TAUGHT, resolved from that directory, must land in the entries dir.
// Derived from the evaluated module, so a mutated index or pointer goes red.
check("X1 the index sits in its own directory, not at the store root",
  posix.dirname(base.index) !== "." && !posix.dirname(base.index).includes("/"),
  `index=${base.index}`);
check("X2 the taught pointer, resolved from the index's directory, lands in the entries",
  posix.normalize(posix.join(posix.dirname(base.index), base.pointer)).startsWith(`${base.entries}/`),
  `${base.pointer} from ${posix.dirname(base.index)}/ -> ${posix.normalize(posix.join(posix.dirname(base.index), base.pointer))}`);
check("X3 the briefing teaches exactly that pointer for new entries",
  base.briefing.includes(`[Title](${base.pointer})`));
check("X4 the entries are NOT under the index's directory",
  !base.entries.startsWith(`${posix.dirname(base.index)}/`) && base.entries !== posix.dirname(base.index));

// ── Y: entries are filed BY REPO (#546), the layout guard's shape ───────────
// 4___ASSETS___/4.3.Memory/<repo>/<child>/<type>_<name>.md, reached through the per-repo
// symlinks of <home>/memory-entries/. The first pass taught
// memory-entries/<type>/<name>.md; an agent following it writes a real
// memory-entries/<type>/ directory and check-memory-layout.sh M6 goes RED.
check("Y1 the taught pointer is <repo>/<child>/<type>_<name>.md",
  base.pointer === "../memory-entries/<repo>/<child>/<type>_<name>.md", base.pointer);
check("Y2 the briefing teaches NO by-type directory",
  !/<type>\/<name>/.test(base.briefing) && /file-name PREFIX, never a directory/.test(base.briefing),
  "an agent taught memory-entries/<type>/ creates the directory M6 rejects");
check("Y3 the briefing names where a new repo/child is declared",
  /4\.2\.Config\/layout\.json/.test(base.briefing) && /AND created/.test(base.briefing),
  "the guard fails on a repo or child declared on only one side");

// ── R: every agent container is actually reached ─────────────────────────────
// Derived, not a literal roster: every container declaring agent.git_tree gets
// the env, so the set this covers cannot silently stop matching the fleet.
const agentServices = execFileSync("sh", ["-c",
  "grep -l '\"git_tree\": true' */build.json | sed 's#/build.json##' | sort"],
  { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
check("R0 the three agent runtimes are the ones declaring agent.git_tree",
  ["user-ai_hermes-agent", "user-ai_cloudy-ai-agents-api", "user-ai_cloudy-ai-claude-api"]
    .every((s) => agentServices.includes(s)),
  `declared: ${agentServices.join(", ")}`);
// No agent container may set AGENT_MEMORY_* itself — that is the second
// declaration all over again, and compose lets the service win the merge.
for (const svc of agentServices) {
  const composePath = join(ROOT, svc, "src/compose.nix");
  if (!existsSync(composePath)) continue;
  check(`R1:${svc} compose.nix does NOT set AGENT_MEMORY_* itself`,
    !/^\s*AGENT_MEMORY_[A-Z]+\s*=/m.test(readFileSync(composePath, "utf8")),
    "the service's own environment wins the git-tree merge, so this would shadow the one declaration");
}

// ── P: each runtime's own consumption path ──────────────────────────────────
// The three do NOT read memory the same way, and pretending they do is how two
// of them ended up with none.
//
// claude: Claude Code SessionStart hook, has a Read tool, gets the INDEX.
const hook = read("user-ai_cloudy-ai-claude-api/src/code/claude-config/hooks/a-context-inject-memory.sh");
check("P1 claude reads the index through AGENT_MEMORY_DIR", /AGENT_MEMORY_DIR/.test(hook));
check("P2 claude's hook cats the INDEX, never the entries",
  /cat "\$\{_mem_dir\}\/\$\{_mem_index\}"/.test(hook)
  && !/cat\s+[^\n]*\$\{?_mem_entries/.test(hook));

// goose: no hook, no CLAUDE.md. Its one context surface is .goosehints
// (goose 1.44 CONTEXT_FILE_NAMES), written at start from the declaration.
const startSh = read("user-ai_cloudy-ai-agents-api/src/code/start.sh");
check("P3 goose gets a .goosehints file",
  /\.goosehints/.test(startSh));
check("P4 goose's hints come from the declaration, not a retyped path",
  /AGENT_MEMORY_BRIEFING/.test(startSh)
  && !/4___ASSETS___\/4\.3\.Memory\/home-diego/.test(startSh),
  "baking the path into start.sh would be the second declaration again");
check("P5 goose's hints land where goose looks for them",
  /XDG_CONFIG_HOME\}\/goose\/\.goosehints/.test(startSh),
  "goose reads global hints from $XDG_CONFIG_HOME/goose/, which the Dockerfile sets to /app/.config");
check("P6 an unset briefing is LOUD for goose",
  /WARNING: AGENT_MEMORY_BRIEFING is unset/.test(startSh));

// goose/hermes chat modes on the front are OpenRouter forwards; the injected
// system message is their ONLY context surface.
const server = read("user-ai_cloudy-ai-agents-api/src/code/server.mjs");
check("P7 the front injects the briefing into the system prompt",
  /process\.env\.AGENT_MEMORY_BRIEFING/.test(server)
  && /parts\.push\(AGENT_MEMORY_BRIEFING\)/.test(server));
check("P8 the front never retypes the store path",
  !/4___ASSETS___\/4\.3\.Memory\/home-diego/.test(server));
check("P9 an unset briefing is LOUD on the front",
  /AGENT_MEMORY_BRIEFING unset/.test(server));

// hermes: reads no AGENT_* var. Its system-prompt extension is a name it owns.
const hermesBuild = JSON.parse(read("user-ai_hermes-agent/build.json"));
check("P10 hermes declares the env var NAME its binary reads",
  hermesBuild?.agent?.memory_briefing_env === "HERMES_EPHEMERAL_SYSTEM_PROMPT",
  JSON.stringify(hermesBuild?.agent?.memory_briefing_env));
check("P11 hermes declares the NAME, never the briefing TEXT",
  !JSON.stringify(hermesBuild).includes("bulk-read"),
  "a second copy of the text is how the three runtimes came to be told three different things");
check("P12 the alias resolves to the SAME briefing (mutation-proof)",
  nixEval(`
    let m = import ./_shared/agent-memory.nix {
      gitTreeMount = "/home/appuser/git";
      buildJson = { runtime = {}; };
      title = "tester";
    }; in (m.aliasEnv { memory_briefing_env = "HERMES_EPHEMERAL_SYSTEM_PROMPT"; }).HERMES_EPHEMERAL_SYSTEM_PROMPT == m.briefing`),
  "two texts under two names is the drift, not the fix");
check("P13 a container declaring no alias gets no extra var",
  Object.keys(nixEval(`
    let m = import ./_shared/agent-memory.nix {
      gitTreeMount = "/home/appuser/git";
      buildJson = { runtime = {}; };
      title = "tester";
    }; in m.aliasEnv { }`)).length === 0);

// ── S: src/dist parity for the files this ticket touched ────────────────────
// /app in the built container is the DIST copy: an edit to src/ alone is INERT
// — it ships nothing, deploys nothing, and every other check still passes while
// the container keeps running the old code (#539).
for (const rel of ["start.sh", "server.mjs"]) {
  const s = join(ROOT, "user-ai_cloudy-ai-agents-api/src/code", rel);
  const d = join(ROOT, "user-ai_cloudy-ai-agents-api/dist/code/arm64", rel);
  check(`S:${rel} is byte-identical src == dist`,
    existsSync(d) && readFileSync(s, "utf8") === readFileSync(d, "utf8"),
    "regenerate dist in the SAME commit as the src edit, or this fix deploys nothing");
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
