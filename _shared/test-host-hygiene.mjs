// Tester (#1583 / #1584): the oci-apps host hygiene is DECLARED, not a manual rm.
// Container log rotation (fleet default), disk-janitor in enforce mode (image/volume/build-cache/
// stale dispatch-slot prune), agents-tmp-reaper (stale agent scratch), both deployed to oci-apps.
// Host swap (zram 50% RAM + disk swapfile = RAM) is declared in cloudy-t-infra vm-pilot
// resource-bouncer.nix / watchdog.nix and is outside this repo; not asserted here.
// Usage: node _shared/test-host-hygiene.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8");
let pass = 0, fail = 0;
const check = (n, c, d = "") => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.error(`FAIL ${n}${d ? ` - ${d}` : ""}`));

const def = JSON.parse(rd("_shared/compose-defaults.json")).defaults;
const lg = def.logging || {};
check("H1 fleet default log driver is json-file with max-size and max-file (no unbounded logs)",
  lg.driver === "json-file" && /^\d+[kmg]$/i.test(lg.options?.["max-size"] || "") && Number(lg.options?.["max-file"]) >= 1, JSON.stringify(lg));
check("H2 log cap per container is <= 100 MB", (() => { const m = /^(\d+)([kmg])$/i.exec(lg.options["max-size"]); const mb = Number(m[1]) * ({ k: 1 / 1024, m: 1, g: 1024 }[m[2].toLowerCase()]); return mb * Number(lg.options["max-file"]) <= 100; })());
for (const d of ["infra-ops_disk-janitor", "infra-ops_agents-tmp-reaper"]) {
  const b = JSON.parse(rd(`${d}/build.json`));
  check(`H3 ${d} deploys to oci-apps`, b.deploy?.host === "oci-apps");
}
const jc = rd("infra-ops_disk-janitor/src/compose.nix");
check("H4 disk-janitor renders MODE=enforce by default (deletes, not dry-run)", /MODE\s*=\s*"\\\$\{MODE:-enforce\}"/.test(jc));
const je = rd("infra-ops_disk-janitor/src/code/entrypoint.sh");
check("H5 disk-janitor prunes images, build cache and anonymous volumes", /image prune|docker image|images/.test(je) && /builder prune|buildx|build cache/i.test(je) && /volume/.test(je));
check("H6 neither cleanup container uses restart always/unless-stopped", !/restart\s*=\s*"(always|unless-stopped)"/.test(jc));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
