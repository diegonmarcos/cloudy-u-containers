// Tester: the claude CLI must not go stale, and the declared models must be ones
// that CLI can serve.
//
// The defect: `npm install -g @anthropic-ai/claude-code` was hand-typed in TWO
// Dockerfiles. That installs whatever version the build happened to fetch and
// then FREEZES it in a cached layer, so the agents kept running a CLI old enough
// to refuse the model ids build.json declares — surfacing as "Update to
// 2.1.255+/2.1.280+ to use newer models" from inside `claude -p`, with nothing in
// any log pointing at the CLI. A stale CLI and a correct one look identical until
// a model id is requested.
//
// The fix is ONE declaration (_shared/agent-toolbelt.json#npm_globals) with two
// consumers wired by _shared/engine.nix: the @AGENT_TOOLBELT_NPM@ placeholder at
// build time, and AGENT_NPM_GLOBALS + start.sh's refresh at boot time. These
// assertions hold every link of that chain, and they go red on the mutations that
// brought the defect back:
//   * a version in `channel` (a pin by another name)          -> A2 red
//   * a Dockerfile hand-typing the npm install again          -> B3 red
//   * engine.nix no longer substituting/publishing            -> B4/C1 red
//   * start.sh defining the refresh but never calling it      -> C2 red
//   * start.sh hardcoding the package name                    -> C3 red
//   * the refreshed CLI not first on PATH (baked one wins)    -> C5 red
//   * the model list falling back to claude-opus-5            -> D1/D2 red
//
// Usage: node test-claude-cli-autoupdate.mjs  (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();                                  // .../src/code
const repo = join(here, "../../..");
const read = (rel) => readFileSync(join(repo, rel), "utf8");

const PKG = "@anthropic-ai/claude-code";
// The CLI version whose own model table carries claude-opus-5-5 (verified against
// the installed 2.1.283 binary), and the version the CLI itself names when it
// refuses the newer ids. The FLOOR of the floor: the declaration may raise it,
// never lower it.
const CLI_FLOOR = "2.1.280";
// The newest Opus family the CLI above offers. Also a floor, not a copy of the
// declaration: build.json may declare a NEWER opus, never an older one.
const OPUS_FLOOR = [5, 5];

const toolbelt = JSON.parse(read("_shared/agent-toolbelt.json"));
const engine = read("_shared/engine.nix");
const build = JSON.parse(read("user-ai_my-ai_claude-api/build.json"));
const start = read("user-ai_my-ai_claude-api/src/code/start.sh");
const dockerfile = read("user-ai_my-ai_claude-api/src/code/Dockerfile");

const cmp = (a, b) => {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};

// ── A: the ONE declaration ───────────────────────────────────────────────────
const globals = toolbelt.npm_globals;
check("A1 agent-toolbelt.json declares npm_globals for the claude CLI",
  globals && typeof globals === "object" && globals[PKG] != null,
  JSON.stringify(globals));
const spec = globals?.[PKG] ?? {};
check("A2 the CLI is declared by DIST-TAG, not a frozen version",
  /^(latest|next|beta)$/.test(String(spec.channel)),
  `channel=${JSON.stringify(spec.channel)} — a version here is the stale pin under a new name`);
check(`A3 min_version is a floor >= ${CLI_FLOOR} (the CLI that offers the declared Opus)`,
  typeof spec.min_version === "string" && cmp(spec.min_version, CLI_FLOOR) >= 0,
  `min_version=${JSON.stringify(spec.min_version)}`);

// ── B: build-time consumer ───────────────────────────────────────────────────
const typeA = (toolbelt.containers || []).filter((c) => c.kind === "type-a");
check("B1 the toolbelt still enumerates the Type-A agent containers", typeA.length >= 2,
  JSON.stringify(typeA.map((c) => c.name)));
for (const c of typeA) {
  const df = read(join(c.dir, c.dockerfile));
  check(`B2:${c.name} installs the CLI via @AGENT_TOOLBELT_NPM@`,
    df.includes("@AGENT_TOOLBELT_NPM@"),
    `${c.dir}/${c.dockerfile} does not consume the declaration`);
  // Comment lines are stripped first: these Dockerfiles explain the defect in
  // prose, and prose about the pin must not read as the pin.
  const code = df.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  check(`B3:${c.name} does NOT hand-type an npm install of the CLI`,
    !new RegExp(`npm\\s+install[^\\n]*${PKG.replace("/", "\\/")}`).test(code),
    `${c.dir}/${c.dockerfile} re-pins the CLI locally`);
}
// engine.nix explains this wiring in prose too, so the assertions below run on
// the CODE only — a comment mentioning the placeholder must not pass for the
// substitution that actually replaces it.
const engineCode = engine.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
check("B4 engine.nix derives @AGENT_TOOLBELT_NPM@ from npm_globals",
  engineCode.includes("npm_globals")
    && engineCode.includes('"@AGENT_TOOLBELT_NPM@"')
    && /toolbeltNpmRun\s*\]/.test(engineCode),
  "the placeholder is unsubstituted, so the Dockerfile would ship it literally");

// ── C: boot-time consumer (the half that survives a cached layer) ────────────
check("C1 engine.nix publishes AGENT_NPM_GLOBALS to the agent containers",
  /AGENT_NPM_GLOBALS/.test(engineCode) && /\/\/\s*toolbeltNpmEnv/.test(engineCode),
  "the binding exists but is never spliced into the container environment, so start.sh has nothing to refresh from");
check("C2 start.sh CALLS the refresh on boot, not merely defines it",
  /^refresh_npm_globals\s*\(\)/m.test(start) && /^refresh_npm_globals\s*$/m.test(start),
  "a defined-but-uncalled refresh is a stale CLI with a function that looks like a fix");
check("C3 start.sh names no package and no version",
  !start.includes(PKG) && !/claude-code@/.test(start),
  "a literal here is a second, quietly older declaration of which CLI the agents run");
check("C4 start.sh reads the declaration from the environment",
  start.includes("AGENT_NPM_GLOBALS"), "the refresh is not data-driven");
check("C5 a failed refresh is LOUD (install failure + below-floor both ERROR)",
  /ERROR:[^\n]*install FAILED/.test(start) && /ERROR:[^\n]*BELOW the declared floor/.test(start),
  "silently keeping a stale CLI is the original defect");
check("C6 Dockerfile gives the refresh a writable prefix, first on PATH",
  /NPM_CONFIG_PREFIX=\/home\/appuser\/\.npm-global/.test(dockerfile)
    && /PATH=\/home\/appuser\/\.npm-global\/bin:/.test(dockerfile),
  "appuser cannot write the root global prefix, and the baked CLI would win on PATH");

// ── D: the models that CLI is refreshed FOR ──────────────────────────────────
const opusRank = (id) => {
  const m = /^claude-opus-(\d+)(?:-(\d+))?/.exec(String(id));
  return m ? [Number(m[1]), Number(m[2] || 0)] : null;
};
const atLeastOpus = (id) => {
  const r = opusRank(id);
  return r != null && (r[0] > OPUS_FLOOR[0] || (r[0] === OPUS_FLOOR[0] && r[1] >= OPUS_FLOOR[1]));
};
const rt = build.runtime || {};
check(`D1 runtime.model is an Opus >= claude-opus-${OPUS_FLOOR.join("-")}`,
  atLeastOpus(rt.model), `model=${JSON.stringify(rt.model)}`);
check(`D2 model_aliases["claude-opus"] resolves to that same newest family`,
  atLeastOpus(rt.model_aliases?.["claude-opus"]),
  `claude-opus=${JSON.stringify(rt.model_aliases?.["claude-opus"])}`);
check("D3 the opus alias and the default agree (one answer for 'newest Opus')",
  rt.model_aliases?.["claude-opus"] === rt.model,
  `${rt.model_aliases?.["claude-opus"]} vs ${rt.model}`);

console.log(`\n${fail === 0 ? "OK" : "FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
