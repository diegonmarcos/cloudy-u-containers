// Tests the phone mesh-endpoint client (#1490): mesh-only base URL, bearer handling, request paths, error mapping.
// Run: npx tsx test-phone-api.mts   (no network, no SDK: the fetch is a stub)
import assert from "node:assert/strict";
import { phoneBase, appName, logsPath, phoneGet, type FetchLike, type PhoneEnv } from "./mcp/tools/phone-api-core.ts";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log(`ok - ${name}`); };
const TOKEN = "tok-SECRET-123";
const env = (over: Partial<PhoneEnv> = {}): PhoneEnv => ({ PHONE_MESH_URL: "http://phone.mesh.diegonmarcos.com:8004", PHONE_FLEET_TOKEN: TOKEN, ...over });
const stub = (status: number, body: string, seen: { url?: string; headers?: Record<string, string> } = {}): FetchLike => async (url, init) => {
  seen.url = url; seen.headers = init.headers;
  return { status, ok: status >= 200 && status < 300, text: async () => body };
};

await t("the base URL is a mesh origin: mesh namespace or a mesh-subnet IPv4", () => {
  assert.deepEqual(phoneBase(env()), { ok: true, value: "http://phone.mesh.diegonmarcos.com:8004" });
  assert.deepEqual(phoneBase(env({ PHONE_MESH_URL: "http://10.0.0.9:8004/" })), { ok: true, value: "http://10.0.0.9:8004" });
  assert.equal(phoneBase(env({ PHONE_MESH_URL: "http://10.1.0.9:8004" })).ok, true);
});

await t("a public, loopback, wildcard, credentialed or path-carrying base URL is refused", () => {
  for (const bad of ["https://example.com", "http://8.8.8.8:8004", "http://127.0.0.1:8004", "http://0.0.0.0:8004", "http://10.2.0.9:8004", "http://10.0.0.999:1",
    "http://phone.mesh.diegonmarcos.com.attacker.com", "http://mesh.diegonmarcos.com", "http://evil-mesh.diegonmarcos.com", "http://u:p@phone.mesh.diegonmarcos.com",
    "http://phone.mesh.diegonmarcos.com/x", "http://phone.mesh.diegonmarcos.com/?a=1", "ftp://phone.mesh.diegonmarcos.com", "not a url", ""]) {
    assert.equal(phoneBase(env({ PHONE_MESH_URL: bad })).ok, false, bad);
  }
  assert.equal(phoneBase({}).ok, false);
});

await t("no token: nothing is sent", async () => {
  let called = false;
  const r = await phoneGet("/logs/calc", env({ PHONE_FLEET_TOKEN: "" }), async () => { called = true; throw new Error("x"); });
  assert.equal(r.ok, false);
  assert.equal(called, false);
});

await t("the bearer goes in the Authorization header, to the mesh base only, and never into an output", async () => {
  const seen: any = {};
  const ok = await phoneGet("/endpoints/public", env(), stub(200, "{\"title\":\"Public Endpoints\"}", seen));
  assert.deepEqual(ok, { ok: true, value: "{\"title\":\"Public Endpoints\"}" });
  assert.equal(seen.url, "http://phone.mesh.diegonmarcos.com:8004/endpoints/public");
  assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!seen.url.includes(TOKEN), "no token in the URL");
  const echo = await phoneGet("/logs/x", env(), stub(500, `server echoed ${TOKEN} back`));
  assert.ok(!echo.ok && !JSON.stringify(echo).includes(TOKEN), "an echoed token is redacted");
  const boom = await phoneGet("/logs/x", env(), async () => { throw new Error(`connect failed for ${TOKEN}`); });
  assert.ok(!boom.ok && !JSON.stringify(boom).includes(TOKEN), "a thrown error is redacted");
});

await t("status codes map to a hint", async () => {
  const e = async (s: number) => { const r = await phoneGet("/logs/x", env(), stub(s, "{}")); return r.ok ? "" : r.error; };
  assert.match(await e(401), /bearer was refused/);
  assert.match(await e(503), /no fleet token/);
  assert.match(await e(502), /log export did not answer/);
});

await t("apps logs: <app> is one path segment, the query is clamped, the method is the provider's", () => {
  assert.deepEqual(logsPath({ app: "calc" }), { ok: true, value: "/ipc/calc/logs" });
  assert.deepEqual(logsPath({ app: "com.diegonmarcos.cloudcalc", n: 99999, errors: true, crashes: 99, method: "export" }), { ok: true, value: "/ipc/com.diegonmarcos.cloudcalc/logs?method=export&n=2000&errors=1&crashes=20" });
  assert.deepEqual(logsPath({ app: "calc", n: -4, crashes: -1 }), { ok: true, value: "/ipc/calc/logs?n=1&crashes=0" });
  for (const bad of ["", "../x", "a/b", "a b", "..", "a..b", ".x", "x?y", "x#y", 5, undefined]) assert.equal(appName(bad).ok, false, String(bad));
  assert.equal(logsPath({ app: "calc", method: "shell" }).ok, false);
});

await t("an app name with a reserved character is encoded, never a second path segment", () => {
  const r = logsPath({ app: "a_b-c.d" });
  assert.ok(r.ok && r.value === "/ipc/a_b-c.d/logs");
});

console.log(`${n} tests passed`);
