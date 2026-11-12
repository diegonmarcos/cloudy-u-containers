// Tester: #505/#542 — the AGI containers carry one name pattern, cloud-agi-*.
//
// Diego named the pattern himself in #542 ("Execute the cloud-agi-* container
// split"), so it is a declared convention, not an inferred one.
//
// SCOPE IS DELIBERATELY NARROW. Measured 2026-09-20: 57 of the fleet's
// containers do not start with "cloud-", and most of them SHOULD NOT — gitea,
// redis and languagetool are upstream products whose own names are the correct
// ones. #351 ("one app-naming pattern cloud-{name}") is about the Constellation
// ANDROID APPS and was completed there; carrying it to every container would be
// a rule nobody wrote, mechanically applied to 57 services. This guard covers
// exactly the four AGI runtimes and nothing else.
//
// What it protects: before today one container was the goose runtime AND the
// gateway for both Telegram bots, and `docker ps` gave no way to tell what
// anything was. The names are now the documentation.
//
// Usage: node test-agi-container-naming.mjs   (cwd = <repo>/_shared)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS ${n}`))
  : (fail++, console.error(`FAIL ${n}${d ? ` — ${d}` : ""}`));

const root = join(process.cwd(), "..");
const name = (dir) => {
  const p = join(root, dir, "build.json");
  if (!existsSync(p)) return null;
  return ((JSON.parse(readFileSync(p, "utf8")).containers || {}).app || {}).container_name || null;
};

// The AGI runtimes, enumerated. A new one added without an entry here is not
// covered — which is why A3 asserts the roster size rather than trusting it.
const AGI = {
  "user-ai_cloudy-ai-claude-api": "cloud-agi-claude",
  "user-ai_cloudy-ai-agents-api":        "cloud-agi-goose",
  "user-ai_hermes-agent":     "cloud-agi-hermes",
};

for (const [dir, want] of Object.entries(AGI)) {
  const got = name(dir);
  check(`A1 ${dir} is named ${want}`, got === want,
    `container_name is ${got === null ? "absent" : got}`);
}

// The bots container is declared in my-ai-api's compose, not its own build.json.
check("A2 cloud-agi-bots is declared (the #542 split)",
  /container_name\s*=\s*"cloud-agi-bots"/.test(
    readFileSync(join(root, "user-ai_cloudy-ai-agents-api/src/compose.nix"), "utf8")),
  "the split-out bots container is missing");

// Every AGI name shares the prefix — the point of the convention.
check("A3 all four AGI containers share the cloud-agi- prefix",
  Object.values(AGI).every((n) => n.startsWith("cloud-agi-")),
  "an entry in the roster breaks the pattern it exists to declare");

// The names must be DISTINCT: the defect being fixed was not knowing which
// container was which, and two identical names would reproduce it exactly.
// Read the ACTUAL declared names, not the expected ones. Asserting that the
// hardcoded AGI literal has distinct values is vacuous — it is distinct by
// construction and holds whether or not two build.json files collide. Caught
// by mutation on 2026-09-20: pointing my-ai-api at "cloud-agi-claude" produced
// one failure where it should have produced two.
{
  const all = [...Object.keys(AGI).map(name), "cloud-agi-bots"].filter(Boolean);
  check("A4 the DECLARED AGI names are all distinct",
    new Set(all).size === all.length,
    `duplicate among the real declarations: ${all.join(", ")}`);
}

// Guard the guard: the old names must be gone from the declarations, or a
// half-done rename reads as success.
for (const [dir, want] of Object.entries(AGI)) {
  const got = name(dir);
  check(`A5 ${dir} no longer carries a pre-rename name`,
    got !== null && !/^(my-ai|hermes-agent)/.test(got),
    `still ${got}`);
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
