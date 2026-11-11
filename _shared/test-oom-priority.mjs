// Tester: the OOM kill order (#1641) is rendered, not just declared.
// Evaluates _shared/oom-priority.nix with a bare nix-instantiate (no nixpkgs), checks that
// build.json runtime.oom_score_adj reaches every service, that a service's own value wins,
// that a service with no declaration renders unchanged, that a bad value throws, and that
// _shared/oom-priority.json agrees with the build.json files it lists.
// #1659 adds the MCP tier (_shared/test/oom-mcp-tier.json): every MCP server on oci-apps carries the
// lowest score, in build.json AND in the rendered compose, and nothing else is ranked as safe.
// Usage: node _shared/test-oom-priority.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

// ── #1659: every MCP server on oci-apps is in the last tier ─────────────────────────────────
// _shared/test/oom-mcp-tier.json is the tier; build.json runtime.oom_score_adj is the declaration;
// dist/compose is what the deploy hands to docker. All three must agree.
const tier = JSON.parse(readFileSync(join(SHARED, "test/oom-mcp-tier.json"), "utf8"));
const svcDirs = readdirSync(ROOT).filter(d => !d.startsWith(".") && !d.startsWith("_") && !d.startsWith("z_") && existsSync(join(ROOT, d, "build.json"))).sort();
const builds = Object.fromEntries(svcDirs.map(d => { try { return [d, JSON.parse(readFileSync(join(ROOT, d, "build.json"), "utf8"))]; } catch { return [d, null]; } }));
const adjOf = (d) => (builds[d]?.runtime || {}).oom_score_adj;
const isMcp = (d) => builds[d] && typeof builds[d].mcp === "object" && builds[d].mcp !== null && builds[d].deploy?.host === tier.host;
const declaredMcp = svcDirs.filter(isMcp);
check("M1 discovery: the repo declares MCP servers on oci-apps", declaredMcp.length >= 10, `found ${declaredMcp.length}`);
check("M2 the tier lists exactly the services that declare an mcp block on oci-apps",
  JSON.stringify(declaredMcp) === JSON.stringify([...tier.applied].sort()),
  `declared but not in tier: ${declaredMcp.filter(d => !tier.applied.includes(d)).join(", ") || "-"}; in tier but not declared: ${tier.applied.filter(d => !declaredMcp.includes(d)).join(", ") || "-"}`);
// A service may be listed pending_deploy_gate while its redeploy is held back; it then may still
// carry no value, never a different one. The list must be empty or absent in the end state.
const pending = new Set(tier.pending_deploy_gate?.services || []);
check("M3a pending_deploy_gate names only declared MCP services, at most one", pending.size <= 1 && [...pending].every(d => declaredMcp.includes(d)));
const tierOk = (d, v) => v === tier.adj || (pending.has(d) && v === undefined);
for (const d of declaredMcp) check(`M3 ${d} build.json runtime.oom_score_adj == ${tier.adj}${pending.has(d) ? " (pending deploy gate)" : ""}`, tierOk(d, adjOf(d)), `got ${adjOf(d)}`);
check("M4 the mcp tier equals the lowest adj of oom-priority.json and is above -1000", tier.adj === Math.min(...doc.tiers.map(t => t.adj)) && tier.adj > -1000);

// Nothing that is not an MCP server is ranked as safe or safer: not in a build.json, not as a
// literal in a compose.nix, not in a rendered compose.
const safer = [];
const composeOf = (d) => {
  const p = join(ROOT, d, "dist/compose/docker-compose.yml");
  if (!existsSync(p)) return null;
  const line = readFileSync(p, "utf8").split("\n").find(l => l.startsWith("{"));
  try { return line ? JSON.parse(line) : null; } catch { return null; }
};
const rendered = {};
for (const d of svcDirs) {
  const mcp = isMcp(d);
  const a = adjOf(d);
  if (!mcp && Number.isInteger(a) && a <= tier.adj) safer.push(`${d} build.json ${a}`);
  const nix = join(ROOT, d, "src/compose.nix");
  if (!mcp && existsSync(nix)) for (const m of readFileSync(nix, "utf8").matchAll(/oom_score_adj\s*=\s*(-?\d+)/g)) if (Number(m[1]) <= tier.adj) safer.push(`${d} compose.nix ${m[1]}`);
  const c = composeOf(d);
  if (!c) continue;
  rendered[d] = c;
  if (!mcp) for (const [n, s] of Object.entries(c.services || {})) if (Number.isInteger(s.oom_score_adj) && s.oom_score_adj <= tier.adj) safer.push(`${d} dist ${n} ${s.oom_score_adj}`);
}
check("M5 nothing that is not an MCP server is ranked as safe or safer than the mcp tier", safer.length === 0, safer.join(" | "));
check("M6 rendered composes were read (a missing dist must not pass silently)", Object.keys(rendered).length >= 40, `read ${Object.keys(rendered).length}`);

// The declaration reaches the compose the deploy applies: every MCP server container carries the
// tier value there, with restart "no"; a non-server container of an MCP service is ranked above it.
const notRendered = new Set(tier.not_rendered.services);
let servers = 0;
for (const d of declaredMcp) {
  const c = rendered[d];
  if (!c) { check(`M7 ${d} has a rendered compose or is listed not_rendered`, notRendered.has(d)); continue; }
  check(`M7 ${d} is not listed not_rendered while it has a dist`, !notRendered.has(d));
  const serverNames = new Set(Object.values(builds[d].containers || {}).map(x => x.container_name));
  for (const [n, s] of Object.entries(c.services || {})) {
    const name = s.container_name || n;
    if (serverNames.has(name)) {
      servers++;
      check(`M8 ${name}: rendered oom_score_adj == ${tier.adj}${pending.has(d) ? " (pending deploy gate)" : ""}`, tierOk(d, s.oom_score_adj), `got ${s.oom_score_adj}`);
      check(`M9 ${name}: restart policy stays "no"`, s.restart === "no", `got ${s.restart}`);
    } else {
      const want = tier.non_server_containers[d];
      check(`M10 ${name} (job of ${d}) is ranked above the mcp tier`, Number.isInteger(s.oom_score_adj) && s.oom_score_adj > tier.adj && s.oom_score_adj === want, `got ${s.oom_score_adj}, want ${want}`);
    }
  }
}
check("M11 every declared MCP server container was found in a rendered compose", servers === declaredMcp.filter(d => rendered[d]).reduce((n, d) => n + Object.keys(builds[d].containers || {}).length, 0), `found ${servers}`);
const cgc = "user-ai_cloud-cgc-pub-mcp";
check("M12 cgc jobs take their value from build.json runtime.job_oom_score_adj", builds[cgc].runtime.job_oom_score_adj === tier.non_server_containers[cgc] && /jobOomAdj = buildJson\.runtime\.job_oom_score_adj/.test(readFileSync(join(ROOT, cgc, "src/compose.nix"), "utf8")));
// Rendering proof for the multi-container case: the service-wide value does not override a job's own.
const r3 = render(String(tier.adj), `{ server = { image = "x"; }; job = { oom_score_adj = ${tier.non_server_containers[cgc]}; }; }`);
check("M13 engine rule: servers get the tier value, a job keeps its own", r3.server.oom_score_adj === tier.adj && r3.job.oom_score_adj === tier.non_server_containers[cgc]);
// The guard must be able to fail.
const fakeSafer = [{ d: "x", a: tier.adj }].filter(x => x.a <= tier.adj).length === 1 && [{ d: "x", a: tier.adj + 1 }].filter(x => x.a <= tier.adj).length === 0;
check("M14 self-check: an equal score counts as 'as safe', a higher one does not", fakeSafer);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
