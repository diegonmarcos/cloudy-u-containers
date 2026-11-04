// Tester: every file the Dockerfile COPYs must be staged by the flake.
//
// WHY THIS EXISTS — measured 2026-09-20, Ship run 35523940910:
//   #19 [runtime 8/18] COPY server.mjs mcp.mjs sessions-store.mjs http-post.mjs package.json /app/
//   ERROR: failed to calculate checksum ... "/http-post.mjs": not found
//
// http-post.mjs was added to src/code and hand-copied into dist/code/arm64, and
// it is committed there — so every local check said it was present. But the ship
// engine does not use the committed dist: it REGENERATES it ("Building nix flake
// -> dist/") from nativeBuild.extraFiles in src/flake.nix, and that list never
// gained the file. The flake output silently replaced the committed dist with
// one missing http-post.mjs, and the COPY failed as soon as that docker layer
// was not served from cache.
//
// The failure mode is what makes this worth a guard: it is INVISIBLE until a
// cache miss, so it can sit latent for days and then fail a deploy that has
// nothing to do with the file. And the green that followed was worse — the next
// Ship "succeeded" with Build and Deploy both SKIPPED, which reads exactly like
// a successful deploy.
//
// Usage: node test-my-ai-flake-copies-complete.mjs   (cwd = <repo>/user-ai_my-ai-api/src/code)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();                       // .../src/code
const dockerfile = readFileSync(join(here, "Dockerfile"), "utf8");
const flake = readFileSync(join(here, "../flake.nix"), "utf8");

// The flake's staged set, as written. Paths are nix path literals (./code/x).
// Staged entries are ./code/<x> or (#764) ../../_shared/<x>; the engine stages
// both by basename, so the COPY source is the basename. Path kept for F5.
const staged = new Map(
  [...flake.matchAll(/^\s*(\.\/code|\.\.\/\.\.\/_shared)\/([^\s#]+)\s*$/gm)].map((m) => {
    const rel = m[2].replace(/\/$/, "");
    return [rel, m[1] === "./code" ? join(here, rel) : join(here, "../../../_shared", rel)];
  })
);
const extraFiles = new Set(staged.keys());
check("F1 the flake declares a non-empty extraFiles list", extraFiles.size > 0,
  "no ./code/* entries parsed from src/flake.nix");

// Every COPY source in the runtime stage. `COPY --from=builder` pulls from
// another image layer, not the context, so those are correctly excluded.
const copySources = [];
for (const line of dockerfile.split("\n")) {
  const t = line.trim();
  if (!t.startsWith("COPY ")) continue;
  if (t.includes("--from=")) continue;
  const parts = t.slice(5).trim().split(/\s+/);
  parts.pop();                                     // the destination
  for (const p of parts) copySources.push(p.replace(/\/$/, ""));
}
check("F2 the Dockerfile has context COPY lines to check", copySources.length > 0,
  "no non---from COPY lines parsed");

// The real assertion. A COPY source is satisfied when the flake stages that
// exact path, or a directory containing it (./code/bots covers bots/x.mjs).
const uncovered = copySources.filter((src) => {
  if (extraFiles.has(src)) return false;
  const top = src.split("/")[0];
  return !extraFiles.has(top);
});
check("F3 every Dockerfile COPY source is staged by the flake",
  uncovered.length === 0,
  `NOT staged in src/flake.nix: ${uncovered.join(", ")}`);

// The specific regression, pinned by name so a future reshuffle cannot quietly
// drop it again.
check("F4 http-post.mjs is staged (the #559 build failure)",
  extraFiles.has("http-post.mjs"),
  "src/flake.nix extraFiles is missing ./code/http-post.mjs");

// A staged path that does not exist on disk stages nothing and fails the same
// way, just one step earlier — catch that too.
const missingOnDisk = [...staged].filter(([, p]) => !existsSync(p)).map(([f]) => f);
check("F5 every staged path exists in src/code",
  missingOnDisk.length === 0,
  `declared in flake but absent on disk: ${missingOnDisk.join(", ")}`);

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
