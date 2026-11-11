// Tester: the OOM kill order (#1641) is rendered, not just declared.
// Evaluates _shared/oom-priority.nix with a bare nix-instantiate (no nixpkgs), checks that
// build.json runtime.oom_score_adj reaches every service, that a service's own value wins,
// that a service with no declaration renders unchanged, that a bad value throws, and that
// _shared/oom-priority.json agrees with the build.json files it lists.
// Usage: node _shared/test-oom-priority.mjs
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SHARED, "..");
let pass = 0, fail = 0;
const check = (n, c, d = "") => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.error(`FAIL ${n}${d ? ` - ${d}` : ""}`));

try { execFileSync("nix-instantiate", ["--version"], { stdio: "pipe" }); }
catch { console.error("FAIL M0 nix-instantiate missing (a missing evaluator must fail, not skip)"); process.exit(1); }

const ev = (expr) => JSON.parse(execFileSync("nix-instantiate", ["--eval", "--strict", "--json", "--expr", expr],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const render = (adj, services) => ev(`import ${SHARED}/oom-priority.nix { adj = ${adj}; services = ${services}; }`);

const r1 = render("-900", `{ a = { image = "x"; }; b = { oom_score_adj = 5; }; }`);
check("O1 declared value reaches every service", r1.a.oom_score_adj === -900);
check("O2 a service's own oom_score_adj wins", r1.b.oom_score_adj === 5);
const r2 = render("null", `{ a = { image = "x"; }; }`);
check("O3 no declaration renders exactly as before (no key added)", !("oom_score_adj" in r2.a));
let threw = false;
try { render("1001", `{ a = {}; }`); } catch { threw = true; }
check("O4 out-of-range value throws", threw);

const engine = readFileSync(join(SHARED, "engine.nix"), "utf8");
check("O5 engine.nix applies oom-priority.nix to the rendered services", /applyOomPriority\s*\(\s*applyMemoryCeiling/.test(engine));

const doc = JSON.parse(readFileSync(join(SHARED, "oom-priority.json"), "utf8"));
for (const t of doc.tiers) for (const d of t.applied) {
  const b = JSON.parse(readFileSync(join(ROOT, d, "build.json"), "utf8"));
  check(`O6 ${d} build.json runtime.oom_score_adj == tier ${t.tier} (${t.adj})`, (b.runtime || {}).oom_score_adj === t.adj, `got ${(b.runtime || {}).oom_score_adj}`);
}
const mcp = JSON.parse(readFileSync(join(ROOT, "infra-api_cloud-infra-mcp/build.json"), "utf8"));
const names = doc.tiers.flatMap(t => t.applied);
check("O7 c3 control plane has the lowest adj of the whole list", doc.tiers.every(t => t.adj >= -900) && doc.tiers.find(t => t.applied.includes("infra-api_cloud-infra-mcp")).adj === Math.min(...doc.tiers.map(t => t.adj)));
check("O8 control plane is not sacrificial and never restart-always", names.includes("infra-api_cloud-infra-mcp") && !JSON.stringify(mcp).includes('"restart": "always"'));
const comp = readFileSync(join(ROOT, "infra-api_cloud-infra-mcp/src/compose.nix"), "utf8");
check("O9 mcp compose.nix reads its memory budget from build.json (no literal)", /limits\.memory = app\.resources\.mem_limit/.test(comp) && /reservations\.memory = app\.resources\.mem_reservation/.test(comp));
check("O10 mcp has no restart policy override in compose.nix", !/restart\s*=/.test(comp));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
