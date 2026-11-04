// Run: node --test mcp/router.test.ts   (Node >= 22.18, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, type Backend, type ServerEntry } from "./router.ts";
import { DEFAULT_CATALOG, SELF, loadCatalog } from "./catalog.ts";

const entries: ServerEntry[] = [
  { name: "cloudy-c3-mcp", aliases: ["cloud-infra-mcp"], description: "c3", urls: ["http://c3/mcp"] },
  { name: "cloudy-apps-communication-mcp", aliases: ["cloud-mail-mcp", "cloud-mattermost-mcp"], description: "comm", urls: ["http://comm/mcp"] },
  { name: "cloudy-all-mcp", description: "self", urls: ["http://self/mcp"] },
];

function fake(tools: Record<string, string[]>) {
  const calls: Array<{ s: string; t: string; a: unknown }> = [];
  let lists = 0;
  const backend: Backend = {
    async listTools(e) {
      lists++;
      if (!tools[e.name]) throw new Error("connection refused");
      return tools[e.name].map((name) => ({ name, description: `d ${name}` }));
    },
    async callTool(e, t, a) { calls.push({ s: e.name, t, a }); return { content: [{ type: "text", text: `${e.name}:${t}` }] }; },
  };
  return { backend, calls, lists: () => lists };
}

test("list_servers names every server once, sorted, without urls, and hides itself", () => {
  const r = new Router(entries, fake({}).backend, { selfName: "cloudy-all-mcp" });
  const l = r.listServers();
  assert.deepEqual(l.map((s) => s.name), ["cloudy-apps-communication-mcp", "cloudy-c3-mcp"]);
  assert.deepEqual(l[1].aliases, ["cloud-infra-mcp"]);
  assert.ok(!JSON.stringify(l).includes("http://"));
});

test("old names resolve as aliases (case-insensitive)", async () => {
  const f = fake({ "cloudy-apps-communication-mcp": ["mail", "mattermost"] });
  const r = new Router(entries, f.backend);
  for (const n of ["cloud-mail-mcp", "cloud-mattermost-mcp", "CLOUDY-apps-communication-mcp"]) {
    const out: any = await r.listTools(n);
    assert.equal(out.server, "cloudy-apps-communication-mcp");
  }
});

test("unknown server lists the known names", async () => {
  const r = new Router(entries, fake({}).backend, { selfName: "cloudy-all-mcp" });
  const out: any = await r.call("nope", "x", {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /unknown server 'nope'.*cloudy-c3-mcp/);
  assert.equal(((await r.call(undefined, "x", {})) as any).isError, true);
});

test("the router never routes to itself", async () => {
  const f = fake({ "cloudy-all-mcp": ["call"] });
  const r = new Router(entries, f.backend, { selfName: "cloudy-all-mcp" });
  assert.equal(((await r.call("cloudy-all-mcp", "call", {})) as any).isError, true);
  assert.equal(f.calls.length, 0);
});

test("call forwards tool and args to the right backend and returns its result", async () => {
  const f = fake({ "cloudy-c3-mcp": ["devops_ssh_exec"] });
  const r = new Router(entries, f.backend);
  const out: any = await r.call("cloud-infra-mcp", "devops_ssh_exec", { host: "a" });
  assert.equal(out.content[0].text, "cloudy-c3-mcp:devops_ssh_exec");
  assert.deepEqual(f.calls, [{ s: "cloudy-c3-mcp", t: "devops_ssh_exec", a: { host: "a" } }]);
});

test("missing args default to {}; non-object args are rejected before any backend call", async () => {
  const f = fake({ "cloudy-c3-mcp": ["t"] });
  const r = new Router(entries, f.backend);
  await r.call("cloudy-c3-mcp", "t", undefined);
  assert.deepEqual(f.calls[0].a, {});
  for (const bad of [null, [], "x", 3]) assert.equal(((await r.call("cloudy-c3-mcp", "t", bad)) as any).isError, true);
  assert.equal(f.calls.length, 1);
});

test("unknown tool is refused with near matches and never reaches callTool", async () => {
  const f = fake({ "cloudy-c3-mcp": ["devops_ssh_exec", "devops_ssh_keys", "other"] });
  const r = new Router(entries, f.backend);
  const out: any = await r.call("cloudy-c3-mcp", "devops_ssh", {});
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no tool 'devops_ssh'.*devops_ssh_exec/);
  assert.equal(f.calls.length, 0);
  assert.equal(((await r.call("cloudy-c3-mcp", "", {})) as any).isError, true);
});

test("tool lists are cached for the ttl and refreshed after it", async () => {
  let t = 0;
  const f = fake({ "cloudy-c3-mcp": ["a"] });
  const r = new Router(entries, f.backend, { ttlMs: 1000, now: () => t });
  await r.listTools("cloudy-c3-mcp"); await r.listTools("cloudy-c3-mcp");
  assert.equal(f.lists(), 1);
  t = 1001;
  await r.listTools("cloudy-c3-mcp");
  assert.equal(f.lists(), 2);
});

test("a stale cache is refreshed once when a tool is missing", async () => {
  const tools = { "cloudy-c3-mcp": ["a"] };
  const f = fake(tools);
  const r = new Router(entries, f.backend, { ttlMs: 60_000 });
  await r.listTools("cloudy-c3-mcp");
  tools["cloudy-c3-mcp"].push("b"); // server gained a tool
  const out: any = await r.call("cloudy-c3-mcp", "b", {});
  assert.equal(out.isError, undefined);
  assert.equal(f.lists(), 2);
});

test("backend failures become isError results, not exceptions", async () => {
  const r = new Router(entries, fake({}).backend);
  const lt: any = await r.listTools("cloudy-c3-mcp");
  assert.equal(lt.isError, true);
  assert.match(lt.content[0].text, /connection refused/);
  const c: any = await r.call("cloudy-c3-mcp", "t", {});
  assert.equal(c.isError, true);
});

test("duplicate claims on one name are rejected at construction", () => {
  assert.throws(() => new Router([
    { name: "a", aliases: ["x"], description: "", urls: [] },
    { name: "b", aliases: ["X"], description: "", urls: [] },
  ], fake({}).backend), /claimed by both/);
});

test("default catalog: final layout, every name ends in -mcp (except the legacy services child), aliases cover the old names", () => {
  const names = DEFAULT_CATALOG.map((e) => e.name);
  for (const n of ["cloudy-c3-mcp", "cloudy-android-mcp", "cloudy-apps-communication-mcp", "cloudy-apps-drive-mcp", "cloudy-cgc-pub-mcp", "cloud-me-cgc-pvt-mcp", "google-workspace-mcp", "google-personal-mcp"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(!names.includes(SELF), "self is not in its own catalog");
  const old = ["cloud-infra-mcp", "cloud-superapp-mcp", "cloud-mail-mcp", "cloud-mattermost-mcp", "cloud-vault-mcp", "cloud-drive-mcp", "cloud-cgc-pub-mcp", "cloud-cgc-pvt-mcp", "cloud-services-mcp"];
  const r = new Router(DEFAULT_CATALOG, fake({}).backend, { selfName: SELF });
  for (const o of old) assert.ok(!("isError" in (r.resolve(o) as object)), `alias ${o}`);
  assert.ok(DEFAULT_CATALOG.every((e) => e.urls.length > 0));
});

test("ROUTER_SERVERS overrides the catalog and is validated", () => {
  assert.equal(loadCatalog({}), DEFAULT_CATALOG);
  assert.equal(loadCatalog({ ROUTER_SERVERS: '[{"name":"x","description":"","urls":["http://x/mcp"]}]' })[0].name, "x");
  assert.throws(() => loadCatalog({ ROUTER_SERVERS: '[{"name":"x"}]' }), /ROUTER_SERVERS/);
});
