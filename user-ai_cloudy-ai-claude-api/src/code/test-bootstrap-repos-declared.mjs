// Tester: ticket #557 — what lands in the shared agent tree must be DECLARED.
//
// The bootstrap used to be a hardcoded shell loop naming four repos:
//   for repo in cloud-infra cloud-u-containers cloud-u-android cloud-u-linux
// while the live tree held seven. Three (cloud-data, cloud-me-pvt-my-ai,
// cloud-vault) had been cloned by hand and would have vanished on the next
// volume recreate, and the whole `front` family was missing entirely — so every
// agent asked to touch a front project was working blind, which is the failure
// shape where a missing tree produces confident answers about a DIFFERENT repo
// rather than an honest "not here".
//
// A second list is the defect, not the four names. These assertions hold the
// ONE declaration (build.json runtime.repos) as the only source, and fail if a
// literal repo loop comes back into the shell.
//
// Usage: node test-bootstrap-repos-declared.mjs   (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();                                  // .../src/code
const build = JSON.parse(readFileSync(join(here, "../../build.json"), "utf8"));
const compose = readFileSync(join(here, "../compose.nix"), "utf8");
const start = readFileSync(join(here, "start.sh"), "utf8");

const repos = build?.runtime?.repos;

// ── D: the declaration ───────────────────────────────────────────────────────
check("D1 build.json declares runtime.repos as a non-empty array",
  Array.isArray(repos) && repos.length > 0, JSON.stringify(repos));
check("D2 every entry names a repo",
  repos.every((r) => typeof r.repo === "string" && r.repo.length > 0),
  JSON.stringify(repos));

const names = new Set(repos.map((r) => r.repo));
const dirs = repos.map((r) => r.dir || r.repo);
check("D3 no duplicate checkout directories", new Set(dirs).size === dirs.length,
  JSON.stringify(dirs));

// ── F: the front family, which is the whole point of the ticket ──────────────
// Sourced from front/repos.json, the front registry index — these are its five
// members plus the index itself (GitHub repo `front`, formerly `ffront`). Pinned by name so a reshuffle cannot silently
// drop one and leave agents blind to that project again.
const FRONT = [
  "front",
  "diegonmarcos.github.io",
  "front-assets-cdn",
  "front-data",
  "front-galaxy-gaia",
  "front-unity",
];
for (const f of FRONT) {
  check(`F:${f} is declared`, names.has(f), `runtime.repos has no "${f}"`);
}

// front members are checked out as front-<thing>; the site repo is the one whose
// GitHub name does not follow that, so it carries an explicit dir.
const site = repos.find((r) => r.repo === "diegonmarcos.github.io");
check("F7 diegonmarcos.github.io checks out as front-diegonmarcos (front/repos.json)",
  site?.dir === "front-diegonmarcos", JSON.stringify(site));

// ── R: #731 upstream rename ffront -> front ─────────────────────────────────
// The index repo was renamed on GitHub. The live tree holds ~/git/ffront, so the
// declaration must say so, or bootstrap clones a SECOND copy as ~/git/front and
// the stale ffront checkout lingers beside it.
const front = repos.find((r) => r.repo === "front");
check("R1 front declares renamed_from [\"ffront\"]",
  Array.isArray(front?.renamed_from) && front.renamed_from.includes("ffront"), JSON.stringify(front));
check("R2 the old name is no longer declared as its own repo", !names.has("ffront"));

// R3 behaviour, not text: run start.sh's own bootstrap_repos against a scratch
// HOME holding an old-name checkout, and require it to be MOVED and repointed.
{
  const fn = start.match(/^bootstrap_repos\(\) \{[\s\S]*?^\}$/m)?.[0];
  check("R3a start.sh defines bootstrap_repos", !!fn);
  const home = mkdtempSync(join(tmpdir(), "boot731-"));
  const sh = `set -e; mkdir -p "$HOME/git/ffront"; cd "$HOME/git/ffront"; git init -q .;
    git remote add origin https://github.com/diegonmarcos/ffront.git;
    git remote add gitea http://10.0.0.6:3002/diego/ffront.git; cd /;
    ${fn}
    bootstrap_repos; git -C "$HOME/git/front" remote get-url origin; git -C "$HOME/git/front" remote get-url gitea`;
  const r = spawnSync("bash", ["-c", sh], { encoding: "utf8",
    // GIT_ALLOW_PROTOCOL=file: a fallback clone from GitHub must not be able to fake a pass.
    env: { ...process.env, HOME: home, GIT_ALLOW_PROTOCOL: "file", BRIDGE_BOOTSTRAP_REPOS: JSON.stringify([{ repo: "front", renamed_from: ["ffront"] }]) } });
  const out = (r.stdout || "").trim().split("\n");
  check("R3b the old-name checkout is moved to the declared dir",
    r.status === 0 && existsSync(join(home, "git/front/.git")) && !existsSync(join(home, "git/ffront")),
    `status=${r.status} stderr=${(r.stderr || "").slice(-400)}`);
  check("R3c origin is repointed at the new name", out.includes("https://github.com/diegonmarcos/front.git"), JSON.stringify(out));
  check("R3d the gitea mirror remote is repointed too", out.includes("http://10.0.0.6:3002/diego/front.git"), JSON.stringify(out));
}

// ── C: the pre-#557 repos are still declared ─────────────────────────────────
// Including the three that were only ever cloned by hand. Dropping one here
// would delete it from the tree on the next volume recreate, silently.
for (const r of ["cloud-infra", "cloud-u-containers", "cloud-u-android", "cloud-u-linux",
                 "cloud-me-pvt-data", "cloud-me-pvt-my-ai", "cloud-me-pvt-vault"]) {
  check(`C:${r} is declared`, names.has(r), `runtime.repos has no "${r}"`);
}
// The vault repo was renamed diegonmarcos/cloud-vault -> cloud-me-pvt-vault (#592),
// but everything on the box reads ~/git/cloud-vault, so it keeps that dir.
const vault = repos.find((r) => r.repo === "cloud-me-pvt-vault");
check("C-vault cloud-me-pvt-vault checks out as cloud-vault (dir override)",
  vault?.dir === "cloud-vault", JSON.stringify(vault));
check("C8 cloud-infra clones with submodules (a_solutions is empty without it)",
  repos.find((r) => r.repo === "cloud-infra")?.submodules === true);

// ── W: the wiring, so the declaration is not decorative ──────────────────────
check("W1 compose.nix emits the declaration as BRIDGE_BOOTSTRAP_REPOS",
  /BRIDGE_BOOTSTRAP_REPOS\s*=\s*builtins\.toJSON rt\.repos/.test(compose),
  "compose.nix does not pass runtime.repos through");
check("W2 compose.nix takes no `or` fallback (absence must fail eval, not mean nothing)",
  !/BRIDGE_BOOTSTRAP_REPOS[^;]*\bor\b/.test(compose),
  "a fallback would be a second declaration of what to clone");
check("W3 start.sh reads BRIDGE_BOOTSTRAP_REPOS",
  /BRIDGE_BOOTSTRAP_REPOS/.test(start), "start.sh ignores the declaration");

// The regression guard: no literal repo list may return to the shell.
const literalLoop = /for\s+repo\s+in\s+[a-z][\w.-]*\s+[a-z][\w.-]*/.test(start);
check("W4 start.sh has NO hardcoded repo loop", !literalLoop,
  "a literal `for repo in <names>` is back in start.sh — that is the second declaration #557 removed");

// An unreadable or empty declaration must be LOUD, not a silent empty ~/git.
check("W5 an empty/unreadable declaration is reported as an ERROR",
  /NO repos bootstrapped/.test(start),
  "start.sh can end up with zero repos without saying so");

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
