// Tester: the kg-store containers can never render UNCAPPED again.
//
// THE DEFECT. Measured on oci-apps 2026-09-21: restarting kg-store and
// kg-store-pub took available RAM from 1,303MB to 11,855MB — the pair had
// eaten ~10.6GB. `docker stats` showed the HOST total as the denominator
// ("6.066GiB / 23.41GiB"), i.e. no cgroup limit existed at all. SurrealDB's
// RocksDB backend sizes its LRU block cache at max(visible/2 - 1GiB, 16MiB)
// (surrealdb v2.3.7, crates/core/src/kvs/rocksdb/cnf.rs:125-143), so with no
// cgroup "visible" was 23.41GiB and the cache was entitled to ~10.7GB. The
// predicted number and the measured number agree; this was not a bug in
// SurrealDB, it was a correctly sized cache against the wrong denominator.
//
// WHY THIS TESTER RENDERS INSTEAD OF GREPPING. Both halves of the fix are
// derived values: the cgroup ceiling and the SURREAL_ROCKSDB_* budget are
// computed in compose.nix from ONE number in build.json. Grepping for the
// strings would pass just as happily if compose.nix hardcoded "1G" and
// ignored the declaration — the "green that verified nothing" shape. So the
// compose specs are actually EVALUATED (they are pure functions of
// { buildJson, container }, needing no nixpkgs), and the key assertion
// re-renders with a MUTATED declaration to prove the rendered value follows it.
//
// The engine-side guard (_shared/memory-ceiling.nix) is evaluated too, for the
// same reason: a `throw` nobody executes is decoration.
//
// Usage: node _shared/test-kg-store-memory-ceiling.mjs   (cwd anywhere)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHARED = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SHARED, "..");

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS ${n}`))
  : (fail++, console.error(`FAIL ${n}${d ? ` — ${d}` : ""}`));

// ── nix is a HARD dependency, never a skip ────────────────────────────────
// A tester that quietly passes when its evaluator is missing is worse than no
// tester: it reports coverage it does not have. See .github/workflows/
// per-service-tests.yml, which installs nix for exactly this file.
let nixOk = true;
try {
  execFileSync("nix-instantiate", ["--version"], { stdio: "pipe" });
} catch {
  nixOk = false;
}
check("M0 nix-instantiate is available (this tester EVALUATES, it does not grep)",
  nixOk, "install nix in the job — a missing evaluator must fail, not skip");
if (!nixOk) { console.error("NOT GREEN"); process.exit(1); }

const nixEval = (expr) => JSON.parse(execFileSync(
  "nix-instantiate", ["--eval", "--strict", "--json", "--expr", expr],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// Returns { ok: true, value } or { ok: false } when the expression throws.
const nixTry = (expr) => {
  const r = nixEval(`builtins.tryEval (builtins.deepSeq (${expr}) "ok")`);
  return r.success ? { ok: true, value: r.value } : { ok: false };
};

const SERVICES = ["user-ai_cloud-me-cgc-pvt-graph-api", "user-ai_cloudy-cgc-pub-graph-api"];
const bj = (svc) => JSON.parse(readFileSync(join(ROOT, svc, "build.json"), "utf8"));

// The roster above is a literal, so it cannot notice a third SurrealDB service
// appearing. Derive the true set from the declarations and compare — a roster
// that silently stops covering the fleet is the same defect one layer up.
{
  const all = execFileSync("sh", ["-c",
    "grep -l '\"db_engine\": \"surrealdb\"' */build.json"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
    .map((p) => p.replace(/\/build\.json$/, "")).sort();
  check("M-roster every SurrealDB service is covered by this tester",
    JSON.stringify(all) === JSON.stringify([...SERVICES].sort()),
    `declared surrealdb services: ${all.join(", ")}`);
}

// Render a service's compose spec, optionally with mem_limit overridden — the
// mutation that proves the rendered value tracks the declaration.
// `override` is either a mem_limit string (the original mutation) or an object
// of containers.app.resources fields to replace.
const renderExpr = (svc, override = null) => {
  const base = `builtins.fromJSON (builtins.readFile ./${svc}/build.json)`;
  const fields = override === null ? {}
    : typeof override === "string" ? { mem_limit: override } : override;
  const attrs = Object.entries(fields).map(([k, v]) => `${k} = "${v}";`).join(" ");
  const bjExpr = attrs === "" ? base : `
    let b = ${base}; a = b.containers.app; in
    b // { containers = b.containers // {
      app = a // { resources = a.resources // { ${attrs} }; }; }; }`;
  return `
    let b = (${bjExpr});
    in import ./${svc}/src/compose.nix { buildJson = b; container = b.containers.app; }`;
};
const renderSpec = (svc, override = null) => nixEval(renderExpr(svc, override));

const toBytes = (s) => {
  const m = /^([0-9]+)([KkMmGg])[iI]?[bB]?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1024, m: 1048576, g: 1073741824 })[m[2].toLowerCase()];
};

// The knob names, as verified in surrealdb v2.3.7 source. A typo here is
// invisible at runtime — SurrealDB ignores unknown SURREAL_* vars and quietly
// keeps its host-sized default, which is the whole defect. So the roster is
// asserted verbatim, and an EXTRA/renamed key fails too.
const KNOBS = [
  "SURREAL_ROCKSDB_BLOCK_CACHE_SIZE",         // cnf.rs:127, bytes
  "SURREAL_ROCKSDB_WRITE_BUFFER_SIZE",        // cnf.rs:55,  bytes
  "SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER",  // cnf.rs:31,  count
];

for (const svc of SERVICES) {
  const declared = ((bj(svc).containers || {}).app || {}).resources || {};
  const lim = declared.mem_limit;

  // ── A. the declaration exists, in build.json, as a real size ──────────
  check(`M1 ${svc} declares containers.app.resources.mem_limit`,
    typeof lim === "string" && toBytes(lim) !== null,
    `got ${JSON.stringify(lim)}`);
  if (toBytes(lim) === null) continue;

  const spec = renderSpec(svc);
  const names = Object.keys(spec.services);
  check(`M2 ${svc} renders exactly one service`, names.length === 1, names.join(","));
  const s = spec.services[names[0]];

  // ── B. the RENDERED compose carries a cgroup ceiling ──────────────────
  const rendered = ((s.deploy || {}).resources || {}).limits || {};
  check(`M3 ${svc} rendered compose carries deploy.resources.limits.memory`,
    typeof rendered.memory === "string" && toBytes(rendered.memory) !== null,
    `got ${JSON.stringify(rendered.memory)} — this is the cgroup cap whose absence made docker stats show 23.41GiB`);

  // ── C. it IS the declaration, not a coincidence ───────────────────────
  check(`M4 ${svc} rendered ceiling equals the build.json declaration`,
    rendered.memory === lim, `rendered ${rendered.memory} vs declared ${lim}`);

  // ── D. the engine-level bound exists, spelled correctly ───────────────
  const env = s.environment || {};
  for (const k of KNOBS) {
    check(`M5 ${svc} sets ${k}`,
      typeof env[k] === "string" && /^[0-9]+$/.test(env[k]),
      `got ${JSON.stringify(env[k])}`);
  }
  check(`M6 ${svc} sets no OTHER SURREAL_ROCKSDB_* key (a typo is a silent no-op)`,
    Object.keys(env).filter((k) => k.startsWith("SURREAL_ROCKSDB_")).length === KNOBS.length,
    `saw ${Object.keys(env).filter((k) => k.startsWith("SURREAL_ROCKSDB_")).join(",")}`);

  // ── E. the engine budget must FIT inside the cgroup ceiling ───────────
  // Otherwise the cap merely converts the leak into an OOM kill, which is the
  // half-fix this ticket is specifically about not shipping.
  const capB = toBytes(lim);
  const budget = Number(env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE)
    + Number(env.SURREAL_ROCKSDB_WRITE_BUFFER_SIZE)
      * Number(env.SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER);
  check(`M7 ${svc} cache+memtable budget (${budget}) fits under the cap (${capB})`,
    budget > 0 && budget < capB,
    "an engine budget >= the cgroup cap is an OOM kill waiting for load");

  // ── F. THE derivation proof: move the declaration, both halves move ────
  // Nothing else in this file can distinguish "reads build.json" from
  // "hardcodes the same string".
  const mutated = renderSpec(svc, "4G");
  const ms = mutated.services[names[0]];
  check(`M8 ${svc} ceiling FOLLOWS the declaration (mem_limit 4G -> rendered 4G)`,
    ms.deploy.resources.limits.memory === "4G",
    `rendered ${ms.deploy.resources.limits.memory} — compose.nix is ignoring build.json`);
  // The RocksDB budget has its OWN declaration (rocksdb_block_cache /
  // rocksdb_write_buffer) so the ceiling can grow for ingest headroom without
  // the cache growing with it (2026-10-10, ~945MiB peak against a 1G cap).
  check(`M9 ${svc} RocksDB block cache FOLLOWS its own declaration`,
    Number(env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE) === toBytes(declared.rocksdb_block_cache)
      && Number(renderSpec(svc, { rocksdb_block_cache: "256M" })
        .services[names[0]].environment.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE) === toBytes("256M"),
    `rendered ${env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE} vs declared ${declared.rocksdb_block_cache}`);
  check(`M9b ${svc} memtable size FOLLOWS its own declaration`,
    Number(env.SURREAL_ROCKSDB_WRITE_BUFFER_SIZE) === toBytes(declared.rocksdb_write_buffer)
      && Number(renderSpec(svc, { rocksdb_write_buffer: "64M" })
        .services[names[0]].environment.SURREAL_ROCKSDB_WRITE_BUFFER_SIZE) === toBytes("64M"),
    `rendered ${env.SURREAL_ROCKSDB_WRITE_BUFFER_SIZE} vs declared ${declared.rocksdb_write_buffer}`);
  check(`M9c ${svc} raising the ceiling does NOT grow the cache (mem_limit 4G keeps it bounded)`,
    ms.environment.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE === env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE,
    `4G rendered cache ${ms.environment.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE}, declared-limit render ${env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE}`);

  // ── H0. the ingest-headroom floor (2026-10-10) ────────────────────────
  // A full cgc graph refresh peaked at ~945MiB of a 1G cap and restarted both
  // stores mid-ingest. 2G is the floor; going back under it is a regression.
  check(`M20 ${svc} mem_limit >= 2G (full graph refresh peaked at ~945MiB)`,
    capB >= toBytes("2G"), `declared ${lim}`);
  check(`M21 ${svc} rendered block cache <= half of mem_limit`,
    Number(env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE) * 2 <= capB,
    `cache ${env.SURREAL_ROCKSDB_BLOCK_CACHE_SIZE} vs limit ${capB}`);
  check(`M22 ${svc} compose.nix REFUSES a block cache above half of mem_limit`,
    nixTry(renderExpr(svc, { mem_limit: "2G", rocksdb_block_cache: "1536M" })).ok === false,
    "a 1.5G cache under a 2G cap rendered cleanly — the bound is not enforced");
  check(`M23 ${svc} compose.nix REFUSES a cache+memtable budget that does not fit`,
    nixTry(renderExpr(svc, { mem_limit: "1G", rocksdb_block_cache: "512M", rocksdb_write_buffer: "256M" })).ok === false,
    "512M + 2x256M under a 1G cap rendered cleanly — that is an OOM kill waiting for load");

  // ── G. no literal size in compose.nix ─────────────────────────────────
  const src = readFileSync(join(ROOT, svc, "src/compose.nix"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  for (const v of [lim, declared.rocksdb_block_cache, declared.rocksdb_write_buffer]) {
    check(`M10 ${svc} compose.nix hardcodes no size literal "${v}"`,
      !new RegExp(`"${v}"`).test(code),
      `the string "${v}" appears in code — two declarations, one of them will lie`);
  }
}

// ── H. the FLEET default: uncapped must be unreachable, not merely unused ──
const defaults = JSON.parse(readFileSync(join(SHARED, "compose-defaults.json"), "utf8"));
const policy = defaults.memory_limit;
check("M11 compose-defaults.json declares the memory_limit policy",
  !!policy && policy.required === true && !!policy.by_category,
  "no fleet policy — a service declaring nothing would be uncapped again");

// Data-driven, not a hand-kept roster: every category any build.json actually
// uses must have a default, so adding a service in a new category fails the
// build instead of slipping through uncapped.
{
  const cats = new Set();
  const dirs = execFileSync("sh", ["-c",
    "find . -mindepth 2 -maxdepth 2 -name build.json -type f -not -path './.git/*'"],
    { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const uncovered = [];
  for (const p of dirs) {
    const d = JSON.parse(readFileSync(join(ROOT, p), "utf8"));
    if (!d.category) continue;           // no category -> must declare its own
    cats.add(d.category);
    if (!(d.category in (policy.by_category || {}))) uncovered.push(`${p}:${d.category}`);
  }
  check(`M12 every category in use has a default (${cats.size} categories)`,
    cats.size > 0 && uncovered.length === 0,
    `uncovered: ${uncovered.join(", ")}`);
}

// ── I. the guard, EXECUTED ────────────────────────────────────────────────
const POL = "(builtins.fromJSON (builtins.readFile ./_shared/compose-defaults.json)).memory_limit";
const ceil = (category, services) =>
  `import ./_shared/memory-ceiling.nix { policy = ${POL}; category = ${category}; title = "t"; services = ${services}; }`;

check("M13 an uncapped container in a KNOWN category inherits the default",
  nixEval(ceil('"data"', "{ a = { deploy.resources.limits.pids = 256; }; }"))
    .a.deploy.resources.limits.memory === policy.by_category.data,
  "the fleet default is not being injected");

check("M14 injecting the default does not clobber the fleet pids:256",
  nixEval(ceil('"data"', "{ a = { deploy.resources.limits.pids = 256; }; }"))
    .a.deploy.resources.limits.pids === 256);

check("M15 a container's OWN declared ceiling wins over the default",
  nixEval(ceil('"data"', '{ a.deploy.resources.limits.memory = "48M"; }'))
    .a.deploy.resources.limits.memory === "48M",
  "a service that sized itself must not be overruled");

check("M16 the NO-LIMIT case is caught: uncapped + no category default THROWS",
  nixTry(ceil("null", "{ a = {}; }")).ok === false,
  "an uncapped container evaluated cleanly — uncapped is still reachable, which is the defect");

check("M17 the guard covers EVERY container, not just the first",
  nixTry(ceil("null", '{ a.deploy.resources.limits.memory = "1G"; b = {}; }')).ok === false,
  "one capped sibling was enough to hide an uncapped one");

// ── J. the guard is actually wired into the engine ────────────────────────
{
  const eng = readFileSync(join(SHARED, "engine.nix"), "utf8");
  check("M18 engine.nix imports memory-ceiling.nix and feeds it the policy",
    /import\s+\.\/memory-ceiling\.nix/.test(eng)
      && /policy\s*=\s*composeDefaultsFile\.memory_limit/.test(eng),
    "the guard exists but nothing calls it");
  check("M19 engine.nix applies the ceiling to the rendered services attrset",
    /services\s*=\s*applyMemoryCeiling\s*\(/.test(eng),
    "applyMemoryCeiling is defined but never applied — decoration");
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
