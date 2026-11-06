// The fleet data read side (shared/libs/fleet-data-core.ts + api/routes/fleetData.ts): only validated names are read, only from the PRIVATE
// source over git+SSH with a read-only deploy key, a body must parse and carry a schemaVersion, the ETag is the checkout commit sha with 304,
// a stale checkout survives an outage, no deploy key -> 503, tier 1 needs an authenticated caller, the route is registered.
// The git/ssh transport is replaced with an in-memory FleetRepo, so this runs with node alone and no network. Usage: node test-fleet-data.ts (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDatasetPath, readFleetData, validBody, PVT_SOURCE, type FleetRepo } from "./code/shared/libs/fleet-data-core.ts";

for (const ok of ["fleet/probes", "personal/wallet", "a", "app/com.diegonmarcos.cloudtoolssmallllms/tools-models"]) assert.ok(isDatasetPath(ok), ok);
for (const bad of ["../x", "a/../b", "A", "a//b", "", "app/notapackage/x", "app/com.x/", "a b", ".env"]) assert.ok(!isDatasetPath(bad), bad);
assert.ok(validBody('{"schemaVersion":1}') && !validBody("{}") && !validBody("[1]") && !validBody("{ half") && !validBody('{"schemaVersion":"1"}'));
assert.ok(PVT_SOURCE.includes("cloud-me-pvt-configs"), "the source is the private repo, never a public one");
assert.ok(PVT_SOURCE.startsWith("git@"), "the source is read over SSH, never an HTTPS token URL");

// A fake checkout: `commit` is the HEAD the transport reports (null = unreachable with no prior checkout); `files` is the current checkout.
let heads = 0;
let commit: string | null = "c0ffee";
let files: Record<string, string> = { "2/fleet/probes": '{"schemaVersion":1,"v":1}', "manifest": '{"schemaVersion":1}' };
const repo: FleetRepo = {
  async head() { heads++; return commit; },
  readDataset(file) { return file in files ? files[file] : null; },
};

// 200 with the commit-sha ETag, then If-None-Match -> 304
const a = await readFleetData("2/fleet/probes", undefined, repo, {}, 1000);
assert.equal(a.status, 200); assert.equal(a.body, '{"schemaVersion":1,"v":1}'); assert.equal(a.etag, '"c0ffee"');
assert.equal((await readFleetData("2/fleet/probes", '"c0ffee"', repo, {}, 2000)).status, 304, "If-None-Match -> 304");

// A stale checkout is still served while the source is down (head keeps returning the last good commit).
commit = "c0ffee"; // transport reports the stale HEAD rather than null
assert.equal((await readFleetData("2/fleet/probes", undefined, repo, {}, 3000)).status, 200, "stale copy served while the source is down");

// The source is unreachable and there is no prior checkout -> 502.
commit = null;
assert.equal((await readFleetData("2/fleet/probes", undefined, repo, {}, 4000)).status, 502, "no checkout, source down -> 502");
commit = "c0ffee";

// A half-written file is never served.
files = { ...files, "1/personal/wallet": '{"schemaVersion":' };
assert.equal((await readFleetData("1/personal/wallet", undefined, repo, {}, 5000)).status, 502, "a half-written file is never served");

// A missing dataset -> 404 (the checkout is good, the file is absent).
assert.equal((await readFleetData("2/nope", undefined, repo, {}, 6000)).status, 404);

// Bad names never reach the transport -> 400.
for (const bad of ["3/x", "2/../x", "2/A", "x", ""]) assert.equal((await readFleetData(bad, undefined, repo, {}, 7000)).status, 400, bad);

// No deploy key configured -> a clean 503, with no transport built (repoArg omitted, empty env).
assert.equal((await readFleetData("manifest", undefined, undefined, {}, 8000)).status, 503, "no deploy key, no answer");

// manifest is served like any dataset.
assert.equal((await readFleetData("manifest", undefined, repo, {}, 9000)).status, 200);

const app = readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8");
assert.match(app, /registerFleetDataRoutes\)/, "the route is registered");
const route = readFileSync(new URL("./code/api/routes/fleetData.ts", import.meta.url), "utf8");
assert.match(route, /req\.params\.tier === "1" && !isCaddyAuthenticated/, "tier 1 needs an authenticated caller");
console.log("test-fleet-data: PASS");
