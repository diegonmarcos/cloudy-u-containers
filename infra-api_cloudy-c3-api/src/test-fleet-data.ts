// The fleet data read side (shared/libs/fleet-data-core.ts + api/routes/fleetData.ts): only validated names are fetched, only from the PRIVATE
// source with the server token, a body must parse and carry a schemaVersion, ETag / 304, a stale copy survives an outage, tier 1 needs an
// authenticated caller, the route is registered. Usage: node test-fleet-data.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDatasetPath, readFleetData, clearFleetDataCache, etagOf, validBody, TTL_MS, PVT_RAW } from "./code/shared/libs/fleet-data-core.ts";

for (const ok of ["fleet/probes", "personal/wallet", "a", "app/com.diegonmarcos.cloudtoolssmallllms/tools-models"]) assert.ok(isDatasetPath(ok), ok);
for (const bad of ["../x", "a/../b", "A", "a//b", "", "app/notapackage/x", "app/com.x/", "a b", ".env"]) assert.ok(!isDatasetPath(bad), bad);
assert.ok(validBody('{"schemaVersion":1}') && !validBody("{}") && !validBody("[1]") && !validBody("{ half") && !validBody('{"schemaVersion":"1"}'));
assert.ok(PVT_RAW.includes("cloud-me-pvt-configs"), "the source is the private repo, never a public one");

const env = { FLEET_DATA_TOKEN: "t" } as NodeJS.ProcessEnv;
let calls = 0; let urls: string[] = []; let hdrs: Record<string, string> = {}; let mode: "ok" | "half" | "down" | "404" = "ok";
const f = async (u: string, h: Record<string, string>) => {
  calls++; urls.push(u); hdrs = h;
  if (mode === "down") throw new Error("down");
  if (mode === "404") return { ok: false, status: 404, text: async () => "" };
  return { ok: true, status: 200, text: async () => (mode === "half" ? '{"schemaVersion":' : '{"schemaVersion":1,"v":1}') };
};
clearFleetDataCache();
const a = await readFleetData("2/fleet/probes", undefined, f, env, 1000);
assert.equal(a.status, 200); assert.equal(a.body, '{"schemaVersion":1,"v":1}'); assert.equal(a.etag, etagOf(a.body!));
assert.equal(urls[0], PVT_RAW + "2/fleet/probes.json"); assert.equal(hdrs.Authorization, "token t");
assert.equal((await readFleetData("2/fleet/probes", a.etag, f, env, 2000)).status, 304, "If-None-Match -> 304");
assert.equal(calls, 1, "second read inside the TTL is cached");
mode = "down";
assert.equal((await readFleetData("2/fleet/probes", undefined, f, env, 1000 + TTL_MS + 1)).status, 200, "stale copy served while the source is down");
clearFleetDataCache(); mode = "half";
assert.equal((await readFleetData("1/personal/wallet", undefined, f, env, 5)).status, 502, "a half-written file is never served");
clearFleetDataCache(); mode = "404";
assert.equal((await readFleetData("2/nope", undefined, f, env, 5)).status, 404);
for (const bad of ["3/x", "2/../x", "2/A", "x", ""]) assert.equal((await readFleetData(bad, undefined, f, env, 5)).status, 400, bad);
assert.equal((await readFleetData("manifest", undefined, f, {} as NodeJS.ProcessEnv, 5)).status, 503, "no server token, no answer");
mode = "ok"; clearFleetDataCache();
assert.equal((await readFleetData("manifest", undefined, f, env, 5)).status, 200);

const app = readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8");
assert.match(app, /registerFleetDataRoutes\)/, "the route is registered");
const route = readFileSync(new URL("./code/api/routes/fleetData.ts", import.meta.url), "utf8");
assert.match(route, /req\.params\.tier === "1" && !isCaddyAuthenticated/, "tier 1 needs an authenticated caller");
console.log("test-fleet-data: PASS");
