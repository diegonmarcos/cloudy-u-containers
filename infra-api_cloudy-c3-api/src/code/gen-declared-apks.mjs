// Regenerates api/declared-apks.json (the APK half of the per-app log route's declaration) from the
// constellation fleet manifest of cloud-u-android: node gen-declared-apks.mjs <constellation-fleet.json>
// The container half is read at runtime from the containers manifest (_cloud-data-consolidated.json services).
import { readFileSync, writeFileSync } from "node:fs";
const src = process.argv[2];
if (!src) { console.error("usage: node gen-declared-apks.mjs <constellation-fleet.json>"); process.exit(2); }
const fleet = JSON.parse(readFileSync(src, "utf8"));
const apks = (fleet.apps ?? []).filter((a) => a.label && a.package)
  .map((a) => ({ label: a.label, package: a.package }))
  .sort((x, y) => x.label.localeCompare(y.label));
writeFileSync(new URL("./api/declared-apks.json", import.meta.url), JSON.stringify({ _generated_from: "aa_cloud-superapp/data/constellation-fleet.json", apks }, null, 2) + "\n");
console.log(`declared-apks.json: ${apks.length} apks`);
