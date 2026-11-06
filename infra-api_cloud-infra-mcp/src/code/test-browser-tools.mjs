// browser.* (#1498): backend routing, secrets by env name, request shape. Run: node --experimental-strip-types test-browser-tools.mjs
import assert from "node:assert/strict";
import { target, call, readUrl } from "./mcp/tools/browser-core.ts";

const env = { C3_PHONE_MESH_URL: "http://10.0.0.9:8004/", C3_PHONE_FLEET_TOKEN: "ft", C3_BROWSER_URL: "https://mcp.example/cloudy-browser-headless/", C3_BROWSER_TOKEN: "bt" };
assert.deepEqual(target("phone", "command", env), { url: "http://10.0.0.9:8004/browser/command", bearer: "ft" });
assert.deepEqual(target("container", "run", env), { url: "https://mcp.example/cloudy-browser-headless/run", bearer: "bt" });
assert.throws(() => target("phone", "command", {}), /phone backend not configured/);
assert.throws(() => target("container", "command", { C3_BROWSER_URL: "https://x" }), /container backend not configured/);
assert.deepEqual(target("container", "command", { C3_BROWSER_TOKEN: "t" }), { url: "http://10.0.0.6:3118/command", bearer: "t" });

const seen = [];
const fake = async (url, init) => { seen.push([url, init.headers.authorization, JSON.parse(init.body)]); return new Response(JSON.stringify({ ok: true, session: "s1" })); };
const r = await call("container", "command", { cmd: "open", url: "https://a.test" }, fake, env);
assert.equal(r.ok, true);
assert.deepEqual(seen[0], ["https://mcp.example/cloudy-browser-headless/command", "Bearer bt", { cmd: "open", url: "https://a.test" }]);
const bad = await call("phone", "run", { steps: [] }, async () => new Response("<html>", { status: 502 }), env);
assert.equal(bad.ok, false);
assert.equal(bad.error.message, "HTTP 502");

// browser.read = open + readable in ONE run call; returns the page content only (no HTML), with the continuation cursor
const runs = [];
const rf = async (url, init) => { runs.push([url, JSON.parse(init.body)]); return new Response(JSON.stringify({ ok: true, session: "s9", steps: [{ ok: true, session: "s9", result: { url: "https://a.test/" } }, { ok: true, session: "s9", result: { format: "markdown", title: "A", url: "https://a.test/", content: "# A\n\ntext", truncated: true, next: "20000" } }] })); };
const rd = await readUrl({ backend: "container", url: "https://a.test", format: "markdown", maxChars: 5000 }, rf, env);
assert.equal(runs[0][0], "https://mcp.example/cloudy-browser-headless/run");
assert.deepEqual(runs[0][1].steps.map((x) => x.cmd), ["open", "readable"]);
assert.equal(runs[0][1].steps[1].maxChars, 5000);
assert.deepEqual(rd, { ok: true, session: "s9", url: "https://a.test/", title: "A", format: "markdown", content: "# A\n\ntext", truncated: true, next: "20000" });
assert.ok(!/<[a-z][^>]*>/i.test(rd.content), "browser.read returns no HTML tags");
await readUrl({ backend: "container", url: "https://a.test", session: "s9", cursor: "20000" }, rf, env);
assert.deepEqual(runs[1][1].steps.map((x) => x.cmd), ["readable"]);
assert.equal(runs[1][1].steps[0].cursor, "20000");
const failed = await readUrl({ backend: "container", url: "https://a.test" }, async () => new Response(JSON.stringify({ ok: false, session: "s", steps: [{ ok: false, error: { code: "timeout", message: "open timed out" } }] })), env);
assert.equal(failed.ok, false);
assert.equal(failed.error.code, "timeout");
console.log("ok - browser tools");
