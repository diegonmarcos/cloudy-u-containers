// The per-app crash/log route (api/routes/appLogs.ts): names are DECLARED (fleet manifest for APKs, containers manifest for
// containers), an undeclared name is refused, a stored event reads back newest first, and the route is registered.
// Usage: node test-app-logs.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveName, readEvents, isLogFileName, telemetryAppId, apksFromFleet } from "./code/shared/libs/app-logs-core.ts";

const decl = JSON.parse(readFileSync(new URL("./code/api/declared-apks.json", import.meta.url), "utf8")) as { apks: Array<{ label: string; package: string }> };
assert.ok(decl.apks.length > 10, "the declared apk list is generated, not empty");
assert.equal(new Set(decl.apks.map((a) => a.label)).size, decl.apks.length, "labels are unique");
assert.equal(new Set(decl.apks.map((a) => telemetryAppId(a.package))).size, decl.apks.length, "the Telemetry-derived ids are unique, so one id names one app");
const drive = decl.apks.find((a) => a.label === "cloud-drive");
assert.equal(drive?.package, "com.diegonmarcos.clouddrive", "cloud-drive is declared");

const apks = apksFromFleet({ apps: [{ label: "cloud-drive", package: "com.diegonmarcos.clouddrive" }, { label: "no-package" }, { package: "x.y" }] });
assert.deepEqual(apks.map((a) => a.label), ["cloud-drive"], "an entry without both a label and a package is not declared");
assert.equal(resolveName("apk", "cloud-drive", decl.apks, []), "cloud-drive");
assert.equal(resolveName("apk", "clouddrive", decl.apks, []), "cloud-drive", "the id Telemetry derives lands on the label");
assert.equal(resolveName("apk", "not-an-app", decl.apks, ["c3-infra-api"]), null, "an undeclared apk is refused");
assert.equal(resolveName("containers", "c3-infra-api", decl.apks, ["c3-infra-api"]), "c3-infra-api");
assert.equal(resolveName("containers", "cloud-drive", decl.apks, ["c3-infra-api"]), null, "the two kinds do not share names");
assert.equal(resolveName("containers", "../etc", decl.apks, ["../etc"]), null, "a traversal name is refused even if declared");

const jl = [
  JSON.stringify({ ts: "2026-10-22T10:00:00.000Z", kind: "log" }),
  "not json",
  JSON.stringify({ ts: "2026-10-22T11:00:00.000Z", kind: "crash", title: "A" }),
  JSON.stringify({ ts: "2026-10-22T12:00:00.000Z", kind: "crash", title: "B" }),
  "",
].join("\n");
assert.deepEqual(readEvents(jl, {}).map((e) => e.ts.slice(11, 13)), ["12", "11", "10"], "newest first, bad lines skipped");
assert.deepEqual(readEvents(jl, { kind: "crash", limit: 1 }).map((e) => e.title), ["B"]);
assert.equal(readEvents(jl, { since: "2026-10-22T11:00:00.000Z" }).length, 1, "since is exclusive");
assert.ok(isLogFileName("cloud-drive-crash-1791542833487.log"));
assert.ok(!isLogFileName("../../etc/passwd") && !isLogFileName("events.jsonl"), "only files this route wrote can be read back");

const app = readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8");
assert.match(app, /await app\.register\(registerAppLogsRoutes\)/, "the route is registered");
const route = readFileSync(new URL("./code/api/routes/appLogs.ts", import.meta.url), "utf8");
assert.match(route, /"\/:kind\(apk\|containers\)\/:name\/logs"/, "one route shape for both kinds");
console.log("PASS: app-logs");
