// infra_peers device tools route mesh first. Run: node --experimental-strip-types --no-warnings test-phone-route.mts (stubs only)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runOnPhone, BEARER_REFUSED, parsePeers, type Deps } from "./mcp/peers/mesh-route.ts";

const TOKEN = "tok-SECRET-xyz";
const peers = parsePeers(JSON.parse(readFileSync(new URL("mcp/peers/mesh-peers.json", import.meta.url), "utf8")));
let n = 0;
const t = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`ok - ${name}`); };
type H = (url: string, init: { body?: string; headers: Record<string, string> }) => Promise<{ status: number; text(): Promise<string> }>;
const mk = (http: H): Deps => ({ token: TOKEN, http: http as Deps["http"], ssh: async () => { throw new Error("deps.ssh must not be used"); }, now: () => 1 });
const answers: H = async (_u, init) => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: `phone says ${JSON.parse(init.body!).params?.name}` }] } }) });
const refused: H = async () => { throw new Error("fetch failed: connect ECONNREFUSED 10.0.0.10:8004"); };
const st = (code: number): H => async () => ({ status: code, text: async () => `denied ${TOKEN}` });
const base = { alias: "samsung-a37", tool: "peers.apps", args: {}, peers };

await t("phone tool call goes to the mesh when it answers (ssh untouched)", async () => {
  let ssh = 0; const urls: string[] = [];
  const r = await runOnPhone({ ...base, deps: mk(async (u, i) => { urls.push(u); return answers(u, i); }), ssh: async () => { ssh++; return "ssh"; } });
  assert.equal(r.route, "mesh"); assert.equal(r.text, "phone says peers.apps"); assert.equal(ssh, 0);
  assert.ok(urls.every((u) => u === "http://10.0.0.10:8004/mcp"));
});
await t("auto falls back to ssh on ECONNREFUSED and says so", async () => {
  const r = await runOnPhone({ ...base, deps: mk(refused), ssh: async () => "via ssh" });
  assert.equal(r.route, "ssh"); assert.equal(r.text, "via ssh"); assert.match(r.note ?? "", /mesh unavailable.*ECONNREFUSED/);
});
await t("route=mesh never touches ssh, even when the mesh is down", async () => {
  let ssh = 0;
  await assert.rejects(runOnPhone({ ...base, route: "mesh", deps: mk(refused), ssh: async () => { ssh++; return "x"; } }), /route=mesh, ssh not tried/);
  assert.equal(ssh, 0);
});
await t("route=ssh never touches the mesh", async () => {
  let http = 0;
  const r = await runOnPhone({ ...base, route: "ssh", deps: mk(async (u, i) => { http++; return answers(u, i); }), ssh: async () => "via ssh" });
  assert.equal(r.route, "ssh"); assert.equal(http, 0);
});
await t("401 is reported as bearer refused and does NOT fall back", async () => {
  for (const route of ["auto", "mesh"] as const) {
    let ssh = 0;
    await assert.rejects(runOnPhone({ ...base, route, deps: mk(st(401)), ssh: async () => { ssh++; return "x"; } }), (e: Error) => { assert.ok(e.message.includes(BEARER_REFUSED)); return true; });
    assert.equal(ssh, 0);
  }
});
await t("a tool error from the phone is its answer, not a missing route", async () => {
  let ssh = 0;
  const err: H = async () => ({ status: 200, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "no such app" }] } }) });
  await assert.rejects(runOnPhone({ ...base, deps: mk(err), ssh: async () => { ssh++; return "x"; } }), /answered with an error.*no such app/);
  assert.equal(ssh, 0);
});
await t("5xx on the mesh falls back; the bearer is never in any output", async () => {
  const r = await runOnPhone({ ...base, deps: mk(st(503)), ssh: async () => "ok" });
  assert.equal(r.route, "ssh"); assert.ok(!JSON.stringify(r).includes(TOKEN));
  for (const code of [401, 403, 404]) await assert.rejects(runOnPhone({ ...base, route: "mesh", deps: mk(st(code)), ssh: async () => "" }), (e: Error) => { assert.ok(!e.message.includes(TOKEN)); return true; });
  await assert.rejects(runOnPhone({ ...base, route: "mesh", deps: mk(st(503)), ssh: async () => "" }), (e: Error) => { assert.ok(!e.message.includes(TOKEN)); return true; });
});
await t("a non-mesh origin is refused (no public host), unknown phone goes to ssh on auto", async () => {
  const bad = peers.map((p) => p.id === "samsung-a37" ? { ...p, mcp: { url: "https://phone.example.com" } } : p);
  let http = 0;
  const r = await runOnPhone({ ...base, peers: bad, deps: mk(async (u, i) => { http++; return answers(u, i); }), ssh: async () => "via ssh" });
  assert.equal(r.route, "ssh"); assert.equal(http, 0);
  const r2 = await runOnPhone({ ...base, alias: "local", deps: mk(answers), ssh: async () => "loc" });
  assert.equal(r2.route, "ssh");
});
console.log(`${n} passed`);
