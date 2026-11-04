// The configs-sync read side (shared/libs/configs-sync-core.ts + api/routes/configsSync.ts): only allowlisted
// JSON names are fetched, a half-written file is never served, a stale copy survives an outage, the route is registered.
// Usage: node test-configs-sync.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isConfigFileName, readConfigFile, clearConfigCache, TTL_MS } from "./code/shared/libs/configs-sync-core.ts";

for (const ok of ["containers-declared.json", "_cloud-data-consolidated.json", "build/build-caddy.json"]) assert.ok(isConfigFileName(ok), ok);
for (const bad of ["../x.json", "a/b.json", "build/../x.json", "x.sh", ".env", "build/x.txt", "", "a b.json"]) assert.ok(!isConfigFileName(bad), bad);

let calls = 0; let mode: "ok" | "half" | "down" = "ok";
const f = async () => { calls++; if (mode === "down") throw new Error("down"); return { ok: true, status: 200, text: async () => (mode === "half" ? '{"containers":[' : '{"containers":[]}') }; };
clearConfigCache();
assert.equal(await readConfigFile("containers-declared.json", f, 1000), '{"containers":[]}');
await readConfigFile("containers-declared.json", f, 2000);
assert.equal(calls, 1, "second read inside the TTL is cached");
mode = "down";
assert.equal(await readConfigFile("containers-declared.json", f, 1000 + TTL_MS + 1), '{"containers":[]}', "stale copy served while the data repo is down");
clearConfigCache(); mode = "half";
await assert.rejects(readConfigFile("containers-declared.json", f, 5), "a half-written file is refused");
await assert.rejects(readConfigFile("../etc.json", f, 5), "a traversal name is refused");

const app = readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8");
assert.match(app, /registerConfigsSyncRoutes\)/, "the route is registered");
console.log("test-configs-sync: PASS");
