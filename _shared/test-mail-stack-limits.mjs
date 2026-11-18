// Tester: the oci-mail stack (stalwart, stalwart-sorter, maddy, mail-puller)
// renders with ceilings sized for the box it actually runs on.
//
// THE DEFECT. oci-mail is a VM.Standard.E2.1.Micro: 1 OCPU, 954MiB. On
// 2026-10-13 it ran load 6-10 with io PSI ~78% and cpu PSI ~74%; stalwart sat
// at 110-160% CPU having read 105GB in 21h. Every mail container rendered
// with the 2G `app` category default from _shared/memory-ceiling.nix -- a
// ceiling twice the size of the machine, i.e. no ceiling -- and no CPU cap, so
// stalwart could starve maddy (the MX leg) of the one core.
//
// The CPU half of the cause was the stalwart-sorter poll: one pass Email/get's
// every message (~11.7k) with bodyStructure + headers, and took ~8 min on this
// box, so POLL_INTERVAL=300 kept stalwart busy ~60% of the time.
//
// WHY THIS RENDERS INSTEAD OF GREPPING (same reasoning as
// test-kg-store-memory-ceiling.mjs): a grep for "384M" passes just as happily
// when compose.nix hardcodes it and ignores build.json. So each compose.nix is
// EVALUATED, then re-evaluated with a MUTATED declaration to prove the
// rendered value follows it, and the result is pushed through the engine's
// own memory-ceiling.nix to prove the category default does not override it.
//
// WHY FLOORS AS WELL AS CEILINGS. restart is "no" fleet-wide (container-init
// owns lifecycle), so an OOM kill is an outage, not a blip. The floors encode
// what was measured on the box 2026-10-13; going under them is the
// documented 256M-on-stalwart thrash wall (_shared/docker.nix: 2909
// memory.max breach events) or an OOM.
//
// Usage: node _shared/test-mail-stack-limits.mjs   (cwd anywhere)
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

// nix is a HARD dependency, never a skip (per-service-tests.yml installs it).
let nixOk = true;
try { execFileSync("nix-instantiate", ["--version"], { stdio: "pipe" }); }
catch { nixOk = false; }
check("L0 nix-instantiate is available (this tester EVALUATES, it does not grep)",
  nixOk, "install nix in the job — a missing evaluator must fail, not skip");
if (!nixOk) { console.error("NOT GREEN"); process.exit(1); }

const nixEval = (expr) => JSON.parse(execFileSync(
  "nix-instantiate", ["--eval", "--strict", "--json", "--expr", expr],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// stalwart's compose.nix takes nixpkgs `lib` for three helpers. A pure-builtins
// shim keeps this tester free of a nixpkgs fetch (the same property
// memory-ceiling.nix is written to keep).
const LIB_SHIM = `{
  findFirst = pred: default: list:
    let m = builtins.filter pred list; in if m == [] then default else builtins.head m;
  flatten = let f = x: if builtins.isList x then builtins.concatMap f x else [ x ]; in f;
  optionalAttrs = c: a: if c then a else {};
}`;

const toBytes = (s) => {
  const m = /^([0-9]+)([KkMmGg])[iI]?[bB]?$/.exec(String(s));
  return m ? Number(m[1]) * ({ k: 1024, m: 1048576, g: 1073741824 })[m[2].toLowerCase()] : null;
};

// role: build.json containers.<role>; svc: rendered compose service name;
// floor: the measured-on-box minimum; extraArgs: what this compose.nix takes.
const STACK = [
  { dir: "user-comm_tools-stalwart", role: "app",    svc: "stalwart",        floor: "384M", args: `lib = ${LIB_SHIM}; base_domain = "diegonmarcos.com";` },
  { dir: "user-comm_tools-stalwart", role: "sorter", svc: "stalwart-sorter", floor: "64M",  args: `lib = ${LIB_SHIM}; base_domain = "diegonmarcos.com";` },
  { dir: "user-comm_tools-maddy",    role: "app",    svc: "maddy",           floor: "128M", args: `base_domain = "diegonmarcos.com";` },
  { dir: "user-comm_mail-puller",    role: "app",    svc: "mail-puller",     floor: "64M",  args: "" },
];
const VM_RAM = toBytes("954M");     // E2.1.Micro, `free -m` total
const HOST_RESERVE = toBytes("250M"); // kernel, dockerd, fluent-bit, sshd, watchdogs

const bj = (dir) => JSON.parse(readFileSync(join(ROOT, dir, "build.json"), "utf8"));

// Render one service dir, optionally overriding containers.<role>.resources.<k>.
const renderExpr = (e, override = {}) => {
  const base = `builtins.fromJSON (builtins.readFile ./${e.dir}/build.json)`;
  const attrs = Object.entries(override).map(([k, v]) => `${k} = "${v}";`).join(" ");
  const bjExpr = attrs === "" ? base : `
    let b = ${base}; c = b.containers.${e.role}; in
    b // { containers = b.containers // {
      ${e.role} = c // { resources = (c.resources or {}) // { ${attrs} }; }; }; }`;
  return `let b = (${bjExpr}); in
    import ./${e.dir}/src/compose.nix { buildJson = b; container = b.containers.app; ${e.args} }`;
};
const render = (e, o) => nixEval(renderExpr(e, o)).services[e.svc];

// The engine's guard, applied exactly as engine.nix applies it.
const throughCeiling = (e) => nixEval(`
  let b = builtins.fromJSON (builtins.readFile ./${e.dir}/build.json);
      spec = (${renderExpr(e)});
  in (import ./_shared/memory-ceiling.nix {
       policy = (builtins.fromJSON (builtins.readFile ./_shared/compose-defaults.json)).memory_limit;
       category = b.category or null; title = "${e.dir}"; services = spec.services;
     }).${e.svc}.deploy.resources.limits.memory`);

let total = 0;
for (const e of STACK) {
  const tag = `${e.svc}`;
  const res = ((bj(e.dir).containers || {})[e.role] || {}).resources || {};
  const lim = res.mem_limit;

  check(`L1 ${tag} declares containers.${e.role}.resources.mem_limit`,
    toBytes(lim) !== null, `got ${JSON.stringify(lim)}`);
  if (toBytes(lim) === null) continue;
  total += toBytes(lim);

  const s = render(e);
  const limits = ((s.deploy || {}).resources || {}).limits || {};
  check(`L2 ${tag} rendered limits.memory equals the declaration`,
    limits.memory === lim, `rendered ${limits.memory} vs declared ${lim}`);
  check(`L3 ${tag} rendered ceiling FOLLOWS the declaration (mem_limit 999M -> 999M)`,
    (render(e, { mem_limit: "999M" }).deploy.resources.limits || {}).memory === "999M",
    "compose.nix is ignoring build.json");
  check(`L4 ${tag} survives the engine's memory-ceiling.nix (not replaced by the 2G category default)`,
    throughCeiling(e) === lim, `engine renders ${throughCeiling(e)}`);
  check(`L5 ${tag} mem_limit >= measured floor ${e.floor} (restart:no — an OOM kill is an outage)`,
    toBytes(lim) >= toBytes(e.floor), `declared ${lim}`);
  check(`L6 ${tag} mem_limit < VM RAM (a ceiling above the box caps nothing)`,
    toBytes(lim) < VM_RAM, `declared ${lim}`);
}

check(`L7 the four ceilings together leave the host >= 250MiB of the 954MiB`,
  total + HOST_RESERVE <= VM_RAM, `sum ${Math.round(total / 1048576)}MiB`);

// ── CPU: stalwart may not take the whole core from maddy ─────────────────
{
  const e = STACK[0];
  const declared = bj(e.dir).containers.app.resources.cpus;
  const rendered = ((render(e).deploy || {}).resources || {}).limits || {};
  check("C1 stalwart declares containers.app.resources.cpus",
    typeof declared === "string" && Number(declared) > 0, `got ${JSON.stringify(declared)}`);
  check("C2 stalwart rendered limits.cpus equals the declaration",
    rendered.cpus === declared, `rendered ${JSON.stringify(rendered.cpus)}`);
  check("C3 stalwart cpus < 1 (leaves maddy part of the single OCPU)",
    Number(rendered.cpus) > 0 && Number(rendered.cpus) < 1, `rendered ${rendered.cpus}`);
  check("C4 stalwart cpus FOLLOWS the declaration (0.5 -> 0.5)",
    (render(e, { cpus: "0.5" }).deploy.resources.limits || {}).cpus === "0.5");
}

// ── the sorter poll that drove stalwart's CPU ─────────────────────────────
{
  const env = render(STACK[1]).environment || {};
  check("P1 stalwart-sorter POLL_INTERVAL >= 1800s (one pass ~8 min on oci-mail; 300s = ~60% duty)",
    Number(env.POLL_INTERVAL) >= 1800, `got ${JSON.stringify(env.POLL_INTERVAL)}`);
}

// ── memory.low: protect stalwart's hot pages, without starving the host ──
// reservations.memory renders to cgroup v2 memory.low. 2026-11-18 the box
// was refaulting ~12MB/s of file pages; stalwart (~70MiB resident) gets a
// floor that also covers its hot RocksDB pages. The sum stays far under RAM
// because memory.low that overcommits the box protects nothing.
{
  const resv = (e) => {
    const r = ((bj(e.dir).containers || {})[e.role] || {}).resources || {};
    return toBytes((r.reservations || {}).memory || r.mem_reservation);
  };
  const st = render(STACK[0]);
  const rendered = toBytes((((st.deploy || {}).resources || {}).reservations || {}).memory);
  check("R1 stalwart rendered reservations.memory >= 96M (resident ~70MiB + hot RocksDB pages)",
    rendered !== null && rendered >= toBytes("96M"), `rendered ${rendered}`);
  check("R2 stalwart reservation <= its mem_limit",
    rendered !== null && rendered <= toBytes(bj(STACK[0].dir).containers.app.resources.mem_limit));
  const sum = STACK.reduce((a, e) => a + (resv(e) || 0), 0);
  check("R3 mail-stack reservations together <= 320MiB (memory.low must not overcommit the 954MiB box)",
    sum > 0 && sum <= toBytes("320M"), `sum ${Math.round(sum / 1048576)}MiB`);
}

// ── file re-reads: the sorter must not make Stalwart read every blob ──────
// 2026-11-18, oci-mail: io PSI some 61.6 / full 13.4, ~12MB/s of file
// refaults, stalwart 1474MB of cgroup reads. Stalwart v0.16.5 reads the WHOLE
// raw message blob for any Email/get that names one of BLOB_READING
// (crates/jmap/src/email/get.rs `needs_body`); headers and the rest come from
// stored metadata. The sorter's per-pass list had bodyStructure in it, so each
// pass read the entire ~11.7k-message mailbox off the boot disk. These read
// the Rust source because the property list IS source; the crate's own
// `email_props_never_force_a_blob_read` test gates the same thing in cargo.
{
  const BLOB_READING = ["bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues"];
  const crate = join(ROOT, "user-comm_tools-stalwart/src/crate/src");
  const filters = readFileSync(join(crate, "filters.rs"), "utf8");
  const m = /pub const EMAIL_PROPS: &\[&str\] = &\[([^\]]*)\];/.exec(filters);
  const props = m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  check("B1 stalwart-sorter EMAIL_PROPS parses and is non-empty", props.length > 0,
    "pub const EMAIL_PROPS not found in filters.rs");
  const bad = props.filter((p) => BLOB_READING.includes(p));
  check("B2 stalwart-sorter per-pass EMAIL_PROPS names no blob-reading property",
    props.length > 0 && bad.length === 0, `found ${bad.join(", ")}`);
  check("B3 stalwart-sorter fetches bodyStructure through the per-process AttachTypeCache only",
    /attach_cache\.missing\(/.test(filters) && /email_get\(&missing, &\["bodyStructure"\]\)/.test(filters),
    "bodyStructure must be fetched only for ids the cache does not hold");
  const routing = readFileSync(join(crate, "routing.rs"), "utf8");
  const rm = /let props: Vec<&str> = \[([^\]]*)\]/.exec(routing);
  const rprops = rm ? [...rm[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  check("B4 stalwart-sorter routing pass names no blob-reading property",
    rprops.length > 0 && !rprops.some((p) => BLOB_READING.includes(p)), `got ${JSON.stringify(rprops)}`);
}

// ── mail-puller: cadence and no FETCH on an idle cycle ────────────────────
{
  const dir = join(ROOT, "user-comm_mail-puller/src");
  const secs = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")).defaults.poll_fallback_secs;
  check("P2 mail-puller poll_fallback_secs in [60, 300] (30s woke it 2880x/day; >300s delays mail)",
    Number(secs) >= 60 && Number(secs) <= 300, `got ${JSON.stringify(secs)}`);
  const loop = readFileSync(join(dir, "crate/src/imap_loop.rs"), "utf8");
  const gate = loop.indexOf("if nothing_new(select.uid_next, from_uid)");
  const fetch = loop.indexOf("fetch_and_deliver(&mut session");
  check("P3 mail-puller checks UIDNEXT before UID FETCH (n:* past the end returns the last message's BODY[])",
    gate !== -1 && fetch !== -1 && gate < fetch, "nothing_new gate missing or after the fetch");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
