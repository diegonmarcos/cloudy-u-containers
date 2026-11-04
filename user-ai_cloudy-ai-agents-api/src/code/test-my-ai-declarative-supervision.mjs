// Tester: ticket #545 — problems 2 (supervision) and the restart declaration.
// Two declarative contracts, asserted against the RESOLVED declarations (not a
// hardcoded container name or a literal path a refactor can move):
//
//  A) The restart policy is DECLARED, and it is the ONE declaration that wins.
//     compose.nix declares `restart = "unless-stopped"` for the service;
//     _shared/engine.nix deep-merges _shared/compose-defaults.json into every
//     service (mergeSvc = lib.recursiveUpdate composeDefaults svc), so a
//     per-service override beats the fleet-wide `restart: "no"` default. A
//     refactor that moves compose.nix/engine.nix/compose-defaults.json, or a
//     declaration that names anything but unless-stopped, must FAIL, not skip.
//
//  B) gateway.mjs is SUPERVISED: start.sh must launch it through the respawn
//     loop (not as a bare background `node /app/gateway.mjs` that dies and
//     stays dead inside a green container). Plus a RUNTIME proof that respawn
//     actually restarts a process when it dies.
//
// Usage: node test-my-ai-declarative-supervision.mjs
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  <- ${detail}`}`);
  if (!ok) failures++;
};

// ── Resolved declarations (paths are discovered, not hardcoded) ─────────────
const root = process.cwd(); // <repo>/user-ai_my-ai-api/src/code
const serviceRoot = join(root, ".."); // .../src
const repoRoot = join(serviceRoot, "../.."); // cloud-u-containers repo root
const composeDecl = join(serviceRoot, "compose.nix");
const engineDecl = join(repoRoot, "_shared/engine.nix");
const composeDefaults = join(repoRoot, "_shared/compose-defaults.json");
const startScript = join(serviceRoot, "code/start.sh");

const mustRead = (p, label) => {
  if (!existsSync(p)) { check(`resolve: ${label} is present and readable`, false, `missing ${p}`); return null; }
  return readFileSync(p, "utf8");
};

// A) Restart policy — resolved declaration chain.
const compose = mustRead(composeDecl, "src/compose.nix");
if (compose) {
  // The declaration must name unless-stopped, inside the service block, not a
  // fleet default and not a comment.
  check("A restart policy declared as unless-stopped in compose.nix service",
    /restart\s+=\s*"unless-stopped";/.test(compose), `compose.nix lacks restart = \"unless-stopped\"`);
}
const engine = mustRead(engineDecl, "_shared/engine.nix");
if (engine) {
  // The ONE merge that makes a per-service override win the fleet default.
  check("A engine.nix deep-merges compose defaults into every service",
    /recursiveUpdate composeDefaults svc/.test(engine) || /lib\.recursiveUpdate composeDefaults/.test(engine),
    "engine.nix no longer deep-merges compose-defaults (override semantics lost)");
}
const defaults = mustRead(composeDefaults, "_shared/compose-defaults.json");
if (defaults) {
  // The fleet default this fix overrides must actually BE the harmful
  // restart:"no" — otherwise the declaration is a no-op, not a fix.
  check("A fleet default restart is \"no\" (the value being overridden)",
    /"restart"\s*:\s*"no"/.test(defaults), "fleet compose default restart is not 'no' — declaration may be a no-op");
}

// A2) The RESOLVED declaration — the rendered dist compose the runtime docks.
// compose.nix is the source declaration; the engine renders it (merged over
// compose-defaults.json) into dist/compose/docker-compose.yml, and THAT is the
// file the container is actually brought up from. Declaring restart in
// compose.nix but never regenerating dist means the deployed compose still
// carries restart:"no" — the #545 dist trap applied to the restart policy. The
// rendered artifact must resolve to unless-stopped, or this check is red.
const distComposePath = join(repoRoot, "user-ai_my-ai-api/dist/compose/docker-compose.yml");
const distCompose = mustRead(distComposePath, "dist/compose/docker-compose.yml");
if (distCompose) {
  // The banner (a # comment block) is stripped; the body is one JSON object.
  const body = distCompose.split("\n").filter((l) => !l.startsWith("#")).join("");
  let parsed = null;
  try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
  const resolvedRestart = parsed?.services?.["my-ai-api"]?.restart;
  check("A rendered dist compose resolves restart to unless-stopped",
    resolvedRestart === "unless-stopped",
    `dist/compose/docker-compose.yml service restart resolves to ${JSON.stringify(resolvedRestart)} — regenerate dist from compose.nix`);
}

// B) gateway.mjs supervision — declared in start.sh.
const start = mustRead(startScript, "src/code/start.sh");
if (start) {
  check("B gateway launched through respawn supervision",
    /respawn gateway node \/app\/gateway\.mjs/.test(start), "start.sh does not put gateway under respawn");
  // The old unsupervised form `( node /app/gateway.mjs ... ) &` must be gone —
  // a process launched bare dies and nothing restarts it.
  check("B no bare background gateway launch remains",
    !/\(\s*node \/app\/gateway\.mjs\b/.test(start), "a bare `( node /app/gateway.mjs ... ) &` remains in start.sh");
  check("B start.sh defines the respawn loop",
    /^respawn\(\) \{/m.test(start), "respawn function body missing from start.sh");
}

// B-runtime: prove respawn restarts a process when it dies.
{
  if (start) {
    // Extract just the respawn() function body and run it in isolation.
    const lines = start.split("\n");
    const i0 = lines.findIndex((l) => l.trim() === "respawn() {");
    let i1 = -1;
    for (let i = i0 + 1; i < lines.length; i++) { if (lines[i].trim() === "}") { i1 = i; break; } }
    if (i0 >= 0 && i1 > i0) {
      const fn = lines.slice(i0, i1 + 1).join("\n");
      const dir = mkdtempSync(join(tmpdir(), "respawn-probe-"));
      const probe = join(dir, "probe.sh");
      writeFileSync(probe, `${fn}\nrespawn probe /bin/sh -c "exit 3"\n`);
      // Bound the run (respawn never exits) and count how many times the dead
      // process was relaunched. grep -c counts the '[respawn] probe:' log lines.
      let relaunched = 0;
      let panic = "";
      try {
        const out = execSync(`timeout 5 bash "${probe}" 2>&1 || true`, { encoding: "utf8" });
        relaunched = (out.match(/\[respawn\] probe: exited with status/g) || []).length;
      } catch (e) { panic = String(e.message || e); }
      rmSync(dir, { recursive: true, force: true });
      check("B-runtime respawn restarts a process that exited non-zero", relaunched >= 2, `respawn relaunched only ${relaunched} time(s)${panic ? ` (${panic})` : ""}`);
    } else {
      check("B-runtime respawn restarts a process that exited non-zero", false, "could not extract respawn() body from start.sh");
    }
  }
}

console.log(failures === 0 ? "ALL GREEN" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
