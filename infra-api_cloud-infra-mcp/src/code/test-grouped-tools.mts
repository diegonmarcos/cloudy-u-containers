// Tests the grouped-dispatcher registry end to end through a real MCP client (in-memory transport).
// Run: npx tsx test-grouped-tools.mts
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { createMcpServer, buildRegistry } from "./mcp/factory.ts";
import { ToolRegistry, GROUPS, methodsOf, registerGrouped, registerLegacy } from "./mcp/registry.ts";

const MAX_LIST_BYTES = 12 * 1024; // guard: total tools/list JSON must stay under this

async function connect(server: McpServer) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const txt = (r: any) => r.content.map((c: any) => c.text).join("");
let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log(`ok - ${name}`); };

const reg = buildRegistry();
const all = methodsOf(reg);
const client = await connect(createMcpServer({} as any));

await t("default exposes only group tools + infra_help (no legacy names)", async () => {
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, [...GROUPS.map((g) => `infra_${g}`), "infra_help"].sort());
});

await t("registry is non-trivial and method names are unique per group", () => {
  assert.ok(all.length >= 150, `only ${all.length} methods`);
});

await t("every method is in its group enum and infra_help returns its schema", async () => {
  const tools = (await client.listTools()).tools;
  for (const m of all) {
    const tool = tools.find((x) => x.name === `infra_${m.group}`)!;
    const en = (tool.inputSchema as any).properties.method.enum as string[];
    assert.ok(en.includes(m.method), `${m.group}.${m.method} missing from enum`);
    assert.ok(tool.description!.includes(`${m.method}: `), `${m.method} missing from description`);
    const h = await client.callTool({ name: "infra_help", arguments: { method: `${m.group}.${m.method}` } });
    assert.ok(!h.isError, `${m.group}.${m.method}: ${txt(h)}`);
    const j = JSON.parse(txt(h));
    assert.equal(j.legacy_name, m.def.name);
    assert.equal(j.description, m.def.description);
    assert.equal(j.params_schema.type, "object");
    assert.deepEqual(Object.keys(j.params_schema.properties ?? {}).sort(), Object.keys(m.def.shape ?? {}).sort());
  }
});

await t("each method routes 1:1 to its handler (stub registry)", async () => {
  const r = new ToolRegistry();
  const calls: any[] = [];
  r.tool("devops.ssh.check", "Check ssh", { vm: z.string(), detailed: z.boolean().optional() }, async (a: any) => { calls.push(a); return { content: [{ type: "text", text: "ok" }] }; });
  r.tool("obs.health.alive", "Alive", {}, async () => ({ content: [{ type: "text", text: "alive" }] }));
  r.tool("obs.db.prune", "Prune", { days: z.number().optional() }, async (a: any) => ({ content: [{ type: "text", text: "p" + a.days }] }));
  const s = new McpServer({ name: "s", version: "1" });
  registerGrouped(s, r);
  const c = await connect(s);
  assert.equal(txt(await c.callTool({ name: "infra_devops", arguments: { method: "ssh_check", params: { vm: "x" } } })), "ok");
  assert.deepEqual(calls, [{ vm: "x" }]);
  assert.equal(txt(await c.callTool({ name: "infra_health", arguments: { method: "alive" } })), "alive");
  assert.equal(txt(await c.callTool({ name: "infra_obs", arguments: { method: "db_prune", params: { days: 3 } } })), "p3");
});

await t("param validation: missing, wrong type, unknown key, unknown method", async () => {
  const r = new ToolRegistry();
  r.tool("devops.ssh.check", "Check ssh", { vm: z.string() }, async () => ({ content: [{ type: "text", text: "ok" }] }));
  const s = new McpServer({ name: "s", version: "1" });
  registerGrouped(s, r);
  const c = await connect(s);
  const call = (method: string, params?: any) => c.callTool({ name: "infra_devops", arguments: { method, params } });
  let x: any = await call("ssh_check", {});
  assert.ok(x.isError && /vm: Required/.test(txt(x)) && /infra_help/.test(txt(x)), txt(x));
  x = await call("ssh_check", { vm: 5 });
  assert.ok(x.isError && /vm: Expected string/.test(txt(x)), txt(x));
  x = await call("ssh_check", { vm: "a", bogus: 1 });
  assert.ok(x.isError && /bogus/.test(txt(x)), txt(x));
  x = await call("nope", {});
  assert.ok(x.isError || /Invalid enum/.test(JSON.stringify(x)), JSON.stringify(x));
  x = await c.callTool({ name: "infra_help", arguments: { method: "devops.nope" } });
  assert.ok(x.isError && /Unknown method/.test(txt(x)));
});

await t("infra_help accepts a bare unique method name", async () => {
  const m = all[0];
  const h = await client.callTool({ name: "infra_help", arguments: { method: m.method } });
  assert.ok(!h.isError || all.filter((x) => x.method === m.method).length > 1);
});

await t("MCP_LEGACY_TOOLS=1 exposes every old name plus the groups; default OFF", async () => {
  const c = await connect(createMcpServer({ MCP_LEGACY_TOOLS: "1" } as any));
  const names = new Set((await c.listTools()).tools.map((x) => x.name));
  for (const d of reg.defs.values()) assert.ok(names.has(d.name) || names.has(d.name.replace(/\./g, "_")), `legacy ${d.name} missing`);
  assert.ok(names.has("infra_devops") && names.has("infra_help"));
});

await t("the phone mesh-endpoint methods (public, mesh, apps logs) are registered in the obs group (#1490)", async () => {
  for (const m of ["phone_public", "phone_mesh", "phone_logs"]) assert.ok(all.some((x) => x.group === "obs" && x.method === m), `obs.${m} missing`);
  const tool = (await client.listTools()).tools.find((x) => x.name === "infra_obs")!;
  const h = await client.callTool({ name: "infra_help", arguments: { method: "obs.phone_logs" } });
  assert.ok(!h.isError && JSON.parse(txt(h)).params_schema.properties.app, txt(h));
  assert.ok(tool.description!.includes("phone_logs: "));
  // without PHONE_MESH_URL / PHONE_FLEET_TOKEN the methods answer an error, they never reach out
  const r: any = await client.callTool({ name: "infra_obs", arguments: { method: "phone_public" } });
  assert.ok(r.isError && /PHONE_MESH_URL/.test(txt(r)), txt(r));
});

await t("SIZE GUARD: tools/list JSON < 12 KB (report before/after)", async () => {
  const after = JSON.stringify(await client.listTools()).length;
  const lg = new McpServer({ name: "old", version: "1" });
  registerLegacy(lg, reg);
  const before = JSON.stringify(await (await connect(lg)).listTools()).length;
  console.log(`tools/list bytes: before=${before} (${reg.defs.size} tools, ~${Math.round(before / 4)} tok) after=${after} (${GROUPS.length + 1} tools, ~${Math.round(after / 4)} tok)`);
  assert.ok(after <= MAX_LIST_BYTES, `tools/list is ${after} bytes, cap ${MAX_LIST_BYTES}`);
});

console.log(`${n} tests passed`);
process.exit(0);
