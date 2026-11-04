// Tester: ticket #539 — the dist trap. cloud-u-containers carries BOTH
// src/code/*.mjs and dist/code/arm64/*.mjs, and /app in the built container is
// the DIST copy: an edit to src/ alone is INERT (it ships nothing, it deploys
// nothing, and every test still passes — but the container keeps running the
// old code). This tester pins the #539 fix into dist by asserting the two
// copies AGREE on the code paths this ticket changed.
//
// It must fail when the fix exists only in src/:
//   * dist/code/arm64/bots/route.mjs missing entirely (the pre-#539 snapshot
//     predates the bots/ split) -> check A red
//   * dist/code/arm64/bots/route.mjs differing from src/code/bots/route.mjs
//     (someone re-fixes src and forgets to rebuild dist) -> check A red
//   * dist still missing the post-#539 shared module set (mcp.mjs,
//     sessions-store.mjs, bots.json) -> checks B/C/D red
//
// Regenerate dist with the service build (build.sh ship / build) and commit it
// in the SAME commit as the src fix. Usage: node test-my-ai-src-dist-parity.mjs
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const here = process.cwd(); // <repo>/user-ai_my-ai-api/src/code
const src = (rel) => join(here, rel);
const dist = (rel) => join(here, `../../dist/code/arm64/${rel}`);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  <- ${detail}`}`);
  if (!ok) failures++;
};

const same = (a, b) => {
  if (!existsSync(a)) return `missing src ${a}`;
  if (!existsSync(b)) return `missing dist ${b}`;
  return readFileSync(a, "utf8") === readFileSync(b, "utf8") ? null : `src/dist differ: ${a} vs ${b}`;
};

const routeSrc = src("bots/route.mjs");
const routeDist = dist("bots/route.mjs");
check("A bots/route.mjs is byte-identical src == dist", same(routeSrc, routeDist) === null, same(routeSrc, routeDist) ?? "");

for (const rel of ["mcp.mjs", "sessions-store.mjs", "bots.json"]) {
  const d = same(src(rel), dist(rel));
  check(`B-${rel} dist carries the shared module ${rel}`, d === null, d ?? "");
}

// The dist snapshot must not be the pre-bots era: gateway + server + the bots
// dir must all be present and current.
const gate = same(src("gateway.mjs"), dist("gateway.mjs"));
check("C gateway.mjs is byte-identical src == dist", gate === null, gate ?? "");

const tg = same(src("bots/telegram.mjs"), dist("bots/telegram.mjs"));
check("D bots/telegram.mjs is byte-identical src == dist", tg === null, tg ?? "");

// #545 extended the guard: start.sh is also staged into dist/code/arm64 and is
// ALSO the ticket's live code path (the respawn supervision). A fix to start.sh
// in src alone (never regenerated into dist) would ship nothing.
const st = same(src("start.sh"), dist("start.sh"));
check("E start.sh is byte-identical src == dist", st === null, st ?? "");

console.log(failures === 0 ? "ALL GREEN" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);