// Tester: ticket #556 — the agents actually have the memory system.
//
// THE DEFECT: a-context-inject-memory.sh has been called "inject-memory" since
// it was written and injected NO memory — only the principles checklist. A real
// store was mounted the whole time in the shared tree (a 72-line MEMORY.md index
// over ~169 entries under memory-entries/{feedback,project,reference}). Every
// agent that ever ran on oci-apps started with zero recall, and nothing said so,
// because the hook's own NAME made it look handled. That is the worst version of
// this failure: not a broken feature, an absent one wearing the label of a
// present one.
//
// Two properties this pins, and they pull against each other:
//   INDEX ONLY — entries are read on demand. A layout where the entry directory
//   auto-loads has already turned a 4.5k-token preload into 87k once; injecting
//   the entries here would repeat it on every agent session.
//   ABSENCE IS LOUD — a hook that silently emits nothing is indistinguishable
//   from one whose memory is merely empty. The agent must be TOLD it has no
//   recall, or it will answer from the conversation as though it did.
//
// SCOPE (narrowed by the second half of #556). The DECLARATION and the WIRING
// used to be checked here, against this container's own build.json
// runtime.memory and compose.nix. Both moved: the memory system is declared
// once in _shared/agent-memory.nix and published by engine.nix to EVERY
// container with agent.git_tree, because while it lived here it reached claude
// and NOT goose or hermes (measured 2026-09-24 inside the running containers:
// only cloud-agi-claude had AGENT_MEMORY_*). Those checks, plus the per-runtime
// consumption paths, now live in _shared/test-agent-memory-one-declaration.mjs,
// which EVALUATES the declaration and mutation-proves it.
//
// What stays here is the part that is genuinely claude's: the SessionStart hook
// is the only one of the three surfaces that injects the index ITSELF, so it is
// the only one that can bulk-read the entry tree by accident.
//
// Usage: node test-agent-memory-system.mjs   (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();
const hook = readFileSync(join(here, "claude-config/hooks/a-context-inject-memory.sh"), "utf8");

// ── W: the hook consumes the declaration, it does not restate it ────────────
// The path itself is asserted (and mutation-proved) in
// _shared/test-agent-memory-one-declaration.mjs. What matters here is that this
// hook takes it from the environment: a literal path baked into the hook would
// be the second declaration that left goose and hermes with nothing.
check("W1 the hook reads AGENT_MEMORY_DIR from the environment", /AGENT_MEMORY_DIR/.test(hook));
check("W2 the hook never retypes the store path",
  !/4___ASSETS___\/4\.3\.Memory\/home-diego/.test(hook),
  "a path literal here can drift from _shared/agent-memory.nix without anything failing");

// ── I: index only ───────────────────────────────────────────────────────────
check("I1 the hook cats the INDEX", /cat "\$\{_mem_dir\}\/\$\{_mem_index\}"/.test(hook));
// The load-bearing negative: never bulk-read the entry tree at session start.
const bulk = /cat\s+[^\n]*\$\{?_mem_entries/.test(hook)
          || /find\s+[^\n]*_mem_entries[^\n]*-exec\s+cat/.test(hook);
check("I2 the hook NEVER bulk-reads the entries", !bulk,
  "injecting memory-entries/ at session start is the 4.5k→87k preload blowup");

// ── L: absence is loud ──────────────────────────────────────────────────────
check("L1 an unset AGENT_MEMORY_DIR is announced", /MEMORY: UNAVAILABLE/.test(hook));
check("L2 an unreadable index is announced", /MEMORY: UNREACHABLE/.test(hook));
check("L3 both say the agent has NO recall, not merely 'no memory found'",
  (hook.match(/WITHOUT recall/g) || []).length >= 2,
  "the agent must know it is answering without memory, not assume empty == none exists");

// ── R: the write rule travels with the read ─────────────────────────────────
// An agent that can read but not write the store accumulates nothing.
check("R1 the hook states where a NEW entry goes", /memory-entries|_mem_entries/.test(hook) && /<type>/.test(hook));
check("R2 the hook states the index gets ONE pointer line", /ONE line/.test(hook));
check("R3 the hook forbids putting entry content in the index",
  /NEVER put entry content in the index/.test(hook));
check("R4 recalled entries are flagged as possibly stale",
  /VERIFY it still exists/.test(hook),
  "a memory naming a deleted file must not be acted on blind");

// ── X: one pointer convention, one memory system ────────────────────────────
// The hook injects an index whose pointers are ../memory-entries/... relative
// to the index's own directory; the agent must be told that, and told to
// write new pointers the same way, or it invents a second convention.
check("X1 the hook states pointers are relative to the index's directory",
  /relative to the index's own directory/.test(hook)
  && /\.\.\/\$\{_mem_entries\}\/<repo>\/<child>\/<type>_<name>\.md/.test(hook));
// #546 moved the entries BY REPO; <home>/memory-entries/ is now a view of one
// symlink per repo. The by-type form this hook first taught would write a real
// memory-entries/<type>/ directory, which check-memory-layout.sh M6 fails RED.
check("X3 the hook teaches NO by-type entries directory (memory-entries/<type>/)",
  !/_mem_entries\}\/<type>\//.test(hook) && !/memory-entries\/<type>\//.test(hook),
  "entries are filed 4___ASSETS___/4.3.Memory/<repo>/<child>/<type>_<name>.md; <type> is a file-name prefix");
check("X4 the hook says a new repo/child is declared in layout.json AND created",
  /layout\.json/.test(hook) && /AND created on disk/.test(hook),
  "the layout guard fails on a repo or child declared on only one side");
check("X2 the hook forbids any other file or subdirectory beside the index",
  /NEVER put any other file or subdirectory beside the index/.test(hook));
// Claude Code's NATIVE auto-memory is a second, private store at
// ~/.claude/projects/<cwd-slug>/memory/ — per dispatch cwd, inside the
// container, never committed. Left on, every dispatched agent is told to write
// memories THERE (flat files beside a MEMORY.md), so what it records dies with
// the workdir and the shared store never sees it. autoMemoryEnabled:false
// (verified in the 2.1.281 binary: "When false, Claude will not read from or
// write to the auto-memory directory") leaves the hook's store as the only one.
const settings = JSON.parse(readFileSync(join(here, "claude-config/settings.json"), "utf8"));
check("N1 Claude Code's private per-cwd auto-memory is OFF",
  settings.autoMemoryEnabled === false,
  `autoMemoryEnabled=${JSON.stringify(settings.autoMemoryEnabled)} — agents would write memory into a throwaway per-workdir dir`);
check("N2 no autoMemoryDirectory redirects native memory into the store",
  !("autoMemoryDirectory" in settings),
  "native memory writes entries beside MEMORY.md — pointed at the store it would fill memory/ with entry files");

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
