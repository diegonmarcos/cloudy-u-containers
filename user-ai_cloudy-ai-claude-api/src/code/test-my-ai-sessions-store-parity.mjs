// Tester: ticket #539 — the :3117 claude-superset container reuses the SAME
// cross-device session-store module my-ai-api ships (deriveSessionName +
// resolveResumeAddress from #525). It must stay byte-identical to the source
// module: a second private copy growing next to a call site is exactly the
// "#525, no second identity copy" defect this file exists to prevent. If the
// shared module changes, this tester fails until BOTH copies are updated.
//
// Usage: node test-my-ai-sessions-store-parity.mjs   (exit 0 = PASS)
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = process.cwd(); // <repo>/user-ai_my-ai_claude-api/src/code
const mine = join(here, "sessions-store.mjs");
const sibling = join(here, "../../../user-ai_my-ai-api/src/code/sessions-store.mjs");

const a = readFileSync(mine, "utf8");
const b = readFileSync(sibling, "utf8");

if (a !== b) {
  const al = a.split("\n").length;
  const bl = b.split("\n").length;
  console.log(`FAIL  sessions-store.mjs parity — claude-api (${al} lines) != my-ai-api (${bl} lines)`);
  console.log("  The resolver and deriver live in ONE module; edit the shared source in");
  console.log("  user-ai_my-ai_api/src/code/sessions-store.mjs and copy it over, do not fork it.");
  process.exit(1);
}
console.log("PASS  sessions-store.mjs is byte-identical to the my-ai-api shared module");
process.exit(0);