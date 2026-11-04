// Tester: ticket #561 — ONE mount pattern for the shared git tree.
//
// Diego, 2026-09-20: "make all mounts same pattern!!! fucking mess!!!!!!"
//
// Three agent containers mounted ONE docker volume (cloud-git-gh) through THREE
// mechanisms, at TWO paths:
//
//   my-ai_claude-api   hand-written lines in its own compose.nix   /home/appuser/git
//   my-ai-api          engine flag agent.git_tree                  /home/appuser/git
//   hermes-agent       engine flag + agent.git_tree_mount          /opt/data/git
//
// The per-container `git_tree_mount` field documented itself as "the container's
// own $HOME/git" and NOTHING checked that claim. hermes runs with HOME=/root
// (measured on the box 2026-09-20), so an agent doing the natural `ls $HOME/git`
// got "No such file or directory" and reported that the repositories did not
// exist — the exact symptom #416 was closed on, arriving through a different
// door. A mount point is not a per-service opinion.
//
// This asserts the collapse held: one canonical path, one mechanism, no second
// declaration anywhere, and the path published as an env var so nothing
// downstream has to infer it from $HOME again.
//
// Usage: node test-git-tree-one-mount-pattern.mjs   (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const repoRoot = join(process.cwd(), "../../..");
const engine = readFileSync(join(repoRoot, "_shared/engine.nix"), "utf8");

// ── C: ONE canonical path, declared once ────────────────────────────────────
check("C1 the engine declares a single canonical mount path",
  /gitTreeMountPath\s*=\s*"\/home\/appuser\/git"/.test(engine),
  "no gitTreeMountPath = \"/home/appuser/git\" in _shared/engine.nix");

check("C2 both the volume mount and working_dir read that ONE binding",
  /volumes\s*=\s*lib\.unique[\s\S]{0,200}?\$\{gitTreeKey\}:\$\{gitTreeMount\}/.test(engine)
  && /working_dir\s*=\s*gitTreeMount/.test(engine),
  "mount and working_dir do not both derive from gitTreeMount");

// The whole point of the ticket: the path must not be inferable-only. hermes
// proved an agent WILL guess $HOME/git and be wrong.
check("C3 the path is published to the container as AGENT_GIT_TREE",
  /AGENT_GIT_TREE\s*=\s*gitTreeMount;/.test(engine),
  "AGENT_GIT_TREE is not bound to gitTreeMount — agents would infer it from $HOME again");

// ── G: the dead per-container field cannot come back silently ───────────────
check("G1 setting agent.git_tree_mount is a build error",
  /_gitTreeMountGuard\s*=[\s\S]{0,200}?agentSpec \? git_tree_mount[\s\S]{0,60}?throw/.test(engine),
  "no throw guard on the removed per-container field");

// A `let` binding nothing references is NEVER evaluated in Nix. Without a
// forcing site the throw above is decoration: it passes whether or not a stale
// git_tree_mount is present, which is the same hollow-green shape the guard
// exists to prevent.
check("G2 the guard is FORCED, not merely defined",
  /builtins\.seq _gitTreeMountGuard/.test(engine),
  "the guard is never evaluated — Nix laziness makes it unreachable and it can never fire");

// Forcing it only through gitTreeMount would skip any container with
// git_tree=false, where a stale field would sit in the declaration looking live.
check("G3 the guard is forced on EVERY container, not only git-tree ones",
  /applyDefaults\s*=\s*spec:[\s\S]{0,400}?builtins\.seq _gitTreeMountGuard/.test(engine),
  "applyDefaults does not force the guard — a git_tree=false container could keep a stale field");

// ── B: no build.json still carries the dead field ───────────────────────────
{
  const offenders = readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("."))
    .filter((e) => existsSync(join(repoRoot, e.name, "build.json")))
    .filter((e) => {
      const agent = JSON.parse(readFileSync(join(repoRoot, e.name, "build.json"), "utf8")).agent || {};
      return Object.prototype.hasOwnProperty.call(agent, "git_tree_mount");
    })
    .map((e) => e.name);
  check("B1 no build.json declares agent.git_tree_mount",
    offenders.length === 0,
    `still set in: ${offenders.join(", ")}`);
}

// Every container that mounts the tree must do it through the flag — that IS
// the one pattern. A container mounting it any other way is the mess again.
{
  const agents = readdirSync(repoRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(repoRoot, e.name, "build.json")))
    .map((e) => e.name)
    .filter((n) => {
      const agent = JSON.parse(readFileSync(join(repoRoot, n, "build.json"), "utf8")).agent || {};
      return agent.git_tree === true;
    });
  check("B2 at least the three known agent containers opt in via the flag",
    agents.length >= 3, `only ${agents.length} container(s) set agent.git_tree: ${agents.join(", ")}`);
}

// ── S: no second declaration in any service's own compose.nix ───────────────
// This is what claude-api was doing and the other two were not: a hand-written
// PAIR of lines (service mount + top-level pinned name). One of the pair going
// missing is invisible — compose invents a project-scoped empty volume and no
// error is raised at all.
{
  const offenders = [];
  for (const e of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const f = join(repoRoot, e.name, "src/compose.nix");
    if (!existsSync(f)) continue;
    const code = readFileSync(f, "utf8")
      .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    if (/git_gh/.test(code) || /cloud-git-gh/.test(code)) offenders.push(e.name);
  }
  check("S1 no service compose.nix hand-writes the git_gh mount or its pinned name",
    offenders.length === 0,
    `second declaration still present in: ${offenders.join(", ")}`);
}

// The pinned top-level name is the half whose absence is silent. Assert the
// engine supplies it, since no compose.nix may any more.
check("S2 the engine supplies the pinned top-level volume name",
  /volumes = \(spec\.volumes or \{\}\)[\s\S]{0,120}?\$\{gitTreeKey\}" = \{ name = gitTreeName; \}/.test(engine)
  && /gitTreeName\s*=\s*"cloud-git-gh"/.test(engine),
  "the engine does not pin the volume name — compose would invent a project-scoped empty volume");

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
