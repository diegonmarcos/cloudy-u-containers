// Tester: ticket #558 — the shared tree repairs its own ownership, declaratively.
//
// The tree has ONE owner, 10001. When anything writes into it as another uid,
// every agent silently loses the tree: git dies with "detected dubious
// ownership" or "insufficient permission for adding an object" deep inside a
// subprocess, and the turn still reports success. Measured 2026-09-20: 260
// root-owned paths across four repos.
//
// The writer was gitea (a read-write mount it never used, running as root);
// that mount is gone. This asserts the OTHER half: the repair is part of the
// declaration, so it runs on every deploy and no one has to shell into the box.
// An ssh one-off would fix today and nothing else — and it cannot be the answer
// anyway, because a phone with a dead tunnel cannot reach the host.
//
// Agents cannot repair this themselves: they run as 10001 and chown on a
// root-owned path is EPERM. That is why the repair must be a separate service
// running as root, not a line in an agent's start.sh.
//
// Usage: node test-git-tree-owner-repair.mjs   (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const engine = readFileSync(join(process.cwd(), "../../../_shared/engine.nix"), "utf8");

// ── R: the repair service exists and can actually do the job ────────────────
check("R1 engine.nix declares the repair service",
  /gitTreeRepairSvc\s*=\s*\{/.test(engine), "no gitTreeRepairSvc in _shared/engine.nix");

// Only root can chown a root-owned path. Without this the service starts, finds
// 260 files it cannot touch, and the whole thing is theatre.
check("R2 the repair runs as root",
  /gitTreeRepairSvc[\s\S]{0,400}?user\s*=\s*"0:0"/.test(engine),
  "repair service does not set user = \"0:0\"");

check("R3 the repair mounts the shared tree",
  /gitTreeRepairSvc[\s\S]{0,600}?volumes\s*=\s*\[\s*"\$\{gitTreeKey\}:/.test(engine),
  "repair service does not mount gitTreeKey");

check("R4 the repair chowns to the declared owner uid",
  /chown \$\{gitTreeOwnerUid\}:\$\{gitTreeOwnerGid\}/.test(engine),
  "no chown to gitTreeOwnerUid:gitTreeOwnerGid");

check("R5 the owner uid is 10001 (the uid that owns the tree)",
  /gitTreeOwnerUid\s*=\s*"10001"/.test(engine), "gitTreeOwnerUid is not 10001");

// R6 — the bug that took the telegram bots down on 2026-09-20.
// Compose interpolates `$VAR` in its OWN config before the container sees it,
// so a bare `$bad` in this command becomes the empty string and the script
// silently turns into `[ "" -eq 0 ]`, which errors and exits 1. Via
// service_completed_successfully that blocks every agent container from
// starting: my-ai-api sat in `created` state and both bots were unreachable,
// while the only evidence was a compose warning nobody reads:
//   warning: The "bad" variable is not set. Defaulting to a blank string.
// Every `$` in the command must be `$$` (compose's escape, reaching the shell
// as one `$`) — the same escape the credential.helper above already uses.
{
  const start = engine.indexOf("gitTreeRepairSvc");
  const block = engine.slice(start, engine.indexOf("gitTreeDependsOn"))
    .split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  // A `$` that is NOT doubled and NOT a nix antiquotation `${...}`.
  const bare = [...block.matchAll(/(?<![$])\$(?![${])/g)];
  check("R6 every `$` in the repair command is escaped as `$$` for compose",
    start !== -1 && bare.length === 0,
    `${bare.length} bare $ found — compose will blank them and the repair exits 1, blocking every agent`);
}

// R7 — the check is uid AND gid. A uid-only find let 10001:0 paths read as repaired.
check("R7 the wrong-owner predicate tests both uid and gid, and every find uses it",
  /gitTreeWrong\s*=\s*"[^"]*-uid \$\{gitTreeOwnerUid\}[^"]*-o[^"]*-gid \$\{gitTreeOwnerGid\}/.test(engine)
  && (engine.match(/find \/git-tree \$\{gitTreeWrong\}/g) || []).length === 3
  && !/find \/git-tree ! -uid/.test(engine),
  "a find in the repair still checks uid only");

// ── F: fail-closed. A partial repair must not read as success ───────────────
// This is the whole lesson of the ticket: the original defect was invisible
// because a failure to write reported as a success.
check("F1 the repair exits non-zero if any path is still wrong",
  /\[ \\"\$\$left\\" -eq 0 \] \|\|[\s\S]{0,200}?exit 1/.test(engine),
  "the repair can finish with paths still mis-owned and still exit 0");

check("F2 the repair reports before/after counts to the deploy log",
  /paths not owned by \$\{gitTreeOwnerUid\}:\$\{gitTreeOwnerGid\}: before=\$\$bad after=\$\$left/.test(engine),
  "no before/after line — the deploy log would not show whether it did anything");

// ── W: the agents actually wait for it ──────────────────────────────────────
check("W1 the wait is service_completed_successfully, not merely started",
  /gitTreeDependsOn\s*=\s*\{[\s\S]{0,200}?condition\s*=\s*"service_completed_successfully"/.test(engine),
  "agents would start while the repair is still running");

check("W2 every git-tree service gets that depends_on",
  /depends_on\s*=\s*\n?\s*let d = svc\.depends_on/.test(engine),
  "mergeGitTreeInto does not add depends_on");

// Compose refuses to mix the two depends_on shapes. A service already carrying
// the LIST form would otherwise make the whole file invalid, or silently keep
// list semantics (wait-for-start) which does not wait for a one-shot to finish.
check("W3 an existing LIST depends_on is converted, not mixed",
  /builtins\.isList d[\s\S]{0,300}?service_started/.test(engine),
  "a list-form depends_on would break or silently weaken the wait");

// ── D: no self-deadlock ─────────────────────────────────────────────────────
// The repair must NOT go through mergeGitTreeInto, or it would depend on
// itself and the project would never start.
check("D1 the repair is added AFTER the per-service merge",
  /lib\.mapAttrs[\s\S]{0,400}?\/\/ \(if wantsGitTree then \{ "\$\{gitTreeRepairKey\}" = gitTreeRepairSvc; \}/.test(engine),
  "the repair is inside the mapAttrs — it would depend on itself");

check("D2 the repair does not restart (it is one-shot)",
  /gitTreeRepairSvc[\s\S]{0,400}?restart\s*=\s*"no"/.test(engine),
  "a restarting repair would loop forever after it succeeds");

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
