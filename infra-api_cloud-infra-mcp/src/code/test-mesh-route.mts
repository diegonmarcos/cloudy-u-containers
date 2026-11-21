// #1835 tests of the two-route mesh transport. Run: node --experimental-strip-types test-mesh-route.mts (no network, no SDK; CI-only, nothing installed)
//   G  declared peers == configured peers, on BOTH routes (guard, against the declared WireGuard membership)
//   O  transport order: MCP, then API, then sshd; the answer names the route that served it
//   B  bearer required: no token, nothing is sent; wrong token refused; token never in output or argv
//   M  mesh-only: a peer URL outside the mesh is refused, and the phone listener binds the mesh address only (Rust source guard)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { derive } from "./gen-mesh-peers.mjs";
import { ROUTE_ORDER, callPeer, fleetBearer, findPeer, health, parsePeers, phoneBase, routeGaps, toolPath, type Deps, type Peer } from "./mcp/peers/mesh-route.ts";
import { phoneBase as coreBase } from "./mcp/tools/phone-api-core.ts";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log(`ok - ${name}`); };
const here = (p: string) => new URL(p, import.meta.url);
const peers = parsePeers(JSON.parse(readFileSync(here("mcp/peers/mesh-peers.json"), "utf8")));
const build = JSON.parse(readFileSync(here("../../build.json"), "utf8"));
const TOKEN = "tok-SECRET-xyz";

// where the declared membership lives: the consolidated dist of cloudy-t-infra (CI: $MULTI_SSO_JSON_DIR), or a sibling checkout
const candidates = [process.env.MESH_MEMBERSHIP_JSON, process.env.MULTI_SSO_JSON_DIR && `${process.env.MULTI_SSO_JSON_DIR}/_cloud-data-consolidated.json`,
  new URL("../../../../cloudy-t-infra/1_cloud-configs/dist/_cloud-data-consolidated.json", import.meta.url).pathname,
  new URL("../../../../../cloudy-t-infra/1_cloud-configs/dist/_cloud-data-consolidated.json", import.meta.url).pathname].filter(Boolean) as string[];
const declaredFile = candidates.find((f) => existsSync(f));

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
function deps(over: Partial<Deps> & { calls?: Call[]; status?: Record<string, number> } = {}): Deps {
  return {
    token: TOKEN,
    http: async (url, init) => {
      over.calls?.push({ url, method: init.method, headers: init.headers, body: init.body });
      const st = over.status?.[url.endsWith("/mcp") ? "mcp" : "api"] ?? 200;
      const body = url.endsWith("/mcp")
        ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: JSON.parse(init.body!).method === "tools/list" ? { tools: [{ name: "a" }, { name: "b" }] } : { content: [{ type: "text", text: "via-mcp" }] } })
        : "via-api";
      return { status: st, text: async () => body };
    },
    ssh: over.ssh ?? (async () => "via-sshd"),
    now: () => 1000,
  };
}
const one: Peer = peers.find((p) => p.kind === "phone")!;

await t("G declared peers == peers configured on the sshd route AND the MCP route", () => {
  assert.ok(declaredFile, "the declared mesh membership (cloudy-t-infra consolidated dist) must be reachable: set MESH_MEMBERSHIP_JSON");
  const cfg = JSON.parse(readFileSync(declaredFile!, "utf8"));
  const wg = cfg.native.wireguard;
  const declared = [...wg.peers.map((p: any) => p.name), ...Object.keys(wg.clients)].sort();
  assert.ok(declared.length >= 8, "the mesh has VMs and clients");
  assert.deepEqual(peers.map((p) => p.id).sort(), declared, "mesh-peers.json drifted from the declared membership: node gen-mesh-peers.mjs <consolidated>");
  assert.deepEqual(derive(cfg, build).peers, peers, "mesh-peers.json is not what the generator derives");
  for (const p of peers) assert.deepEqual(routeGaps(p), [], `${p.id} lacks a route`);
  const sshd = peers.filter((p) => p.ssh.hosts.length).map((p) => p.id).sort();
  const mcp = peers.filter((p) => p.mcp.url).map((p) => p.id).sort();
  assert.deepEqual(sshd, declared); assert.deepEqual(mcp, declared);
  for (const ph of build.ssh.phones) { const p = peers.find((x) => x.id === ph.wg_client)!; assert.equal(p.kind, "phone"); assert.ok(p.ssh.hosts.includes(ph.alias), `${ph.alias} doors kept`); }
});

await t("G a peer missing either route is reported", () => {
  assert.deepEqual(routeGaps({ ...one, ssh: { hosts: [] } }), ["sshd route"]);
  assert.equal(routeGaps({ ...one, mcp: { url: "http://8.8.8.8:8004" } }).length, 1);
});

await t("O the order is MCP, API, sshd", () => assert.deepEqual([...ROUTE_ORDER], ["mcp", "api", "sshd"]));

await t("O MCP answers: it serves, and only MCP was tried", async () => {
  const calls: Call[] = [];
  const r = await callPeer(one, "endpoints_mesh", {}, deps({ calls }));
  assert.equal(r.route, "mcp"); assert.equal(r.text, "via-mcp"); assert.deepEqual(r.tried, [{ route: "mcp", ok: true }]);
  assert.ok(calls.every((c) => c.url === `${one.mcp.url}/mcp` && c.method === "POST"));
});

await t("O MCP down: the API serves; both down: sshd serves; the route is reported each time", async () => {
  const a = await callPeer(one, "endpoints_mesh", {}, deps({ status: { mcp: 404 } }));
  assert.equal(a.route, "api"); assert.deepEqual(a.tried.map((x) => x.route), ["mcp", "api"]);
  let script = "";
  const s = await callPeer(one, "endpoints_mesh", {}, deps({ status: { mcp: 503, api: 503 }, ssh: async (_h, sc) => { script = sc; return "via-sshd"; } }));
  assert.equal(s.route, "sshd"); assert.deepEqual(s.tried.map((x) => x.route), ["mcp", "api", "sshd"]);
  assert.ok(script.includes(`${one.mcp.url}/endpoints/mesh`));
  const none = callPeer(one, "endpoints_mesh", {}, deps({ status: { mcp: 503, api: 503 }, ssh: async () => { throw new Error("refused"); } }));
  await assert.rejects(none, /no route served endpoints_mesh.*mcp: .*api: .*sshd: /);
});

await t("O sshd tries each door of a phone in order", async () => {
  const seen: string[] = [];
  await callPeer(one, "ipc_index", {}, deps({ ssh: async (h) => { seen.push(h); if (seen.length < 2) throw new Error("closed"); return "ok"; } }), "sshd");
  assert.deepEqual(seen, one.ssh.hosts.slice(0, 2));
});

await t("B bearer required: no token sends nothing; the token is only an Authorization header, never in an error, argv or the ssh host", async () => {
  const calls: Call[] = []; let sshCalled = false;
  await assert.rejects(callPeer(one, "ipc_index", {}, { ...deps({ calls, ssh: async () => { sshCalled = true; return ""; } }), token: "" }), /no fleet bearer/);
  assert.equal(calls.length, 0); assert.equal(sshCalled, false);
  const c2: Call[] = [];
  await callPeer(one, "ipc_index", {}, deps({ calls: c2 }));
  assert.ok(c2.every((c) => c.headers.authorization === `Bearer ${TOKEN}` && !c.url.includes(TOKEN) && !(c.body ?? "").includes(TOKEN)));
  const hosts: string[] = [];
  await callPeer(one, "ipc_index", {}, deps({ status: { mcp: 500, api: 500 }, ssh: async (h, sc) => { hosts.push(h); assert.ok(sc.includes(TOKEN) && !h.includes(TOKEN)); return "x"; } }));
  const d = deps({ status: { mcp: 401, api: 401 }, ssh: async () => { throw new Error(`denied ${TOKEN}`); } });
  await assert.rejects(callPeer(one, "ipc_index", {}, d), (e: Error) => !e.message.includes(TOKEN) && /bearer was refused/.test(e.message));
  assert.equal(fleetBearer({ SUPERAPP_FLEET_TOKEN: "${SUPERAPP_FLEET_TOKEN}" } as any), "");
  assert.equal(fleetBearer({ PHONE_FLEET_TOKEN: "abc" } as any), "abc");
});

await t("M mesh only: a non-mesh peer URL is refused before anything is sent, and phoneBase agrees with phone-api-core", async () => {
  const calls: Call[] = [];
  for (const bad of ["https://example.com", "http://8.8.8.8:8004", "http://127.0.0.1:8004", "http://0.0.0.0:8004", "http://10.2.0.9:8004", "http://u:p@10.0.0.9:8004", "http://10.0.0.9:8004/x"]) {
    await assert.rejects(callPeer({ ...one, mcp: { url: bad } }, "ipc_index", {}, deps({ calls })), /no route served/);
    assert.equal(phoneBase({ PHONE_MESH_URL: bad }).ok, false, bad);
    assert.equal(phoneBase({ PHONE_MESH_URL: bad }).ok, coreBase({ PHONE_MESH_URL: bad }).ok, bad);
  }
  assert.equal(calls.length, 0);
  for (const good of ["http://10.0.0.10:8004", "http://10.1.0.9:8004", "http://a37.mesh.diegonmarcos.com:8004"]) assert.equal(phoneBase({ PHONE_MESH_URL: good }).ok, coreBase({ PHONE_MESH_URL: good }).ok);
  for (const p of peers) assert.ok(phoneBase({ PHONE_MESH_URL: p.mcp.url }).ok, p.id);
});

await t("M the phone's mcp endpoint sits behind the bearer gate and the mesh-only bind (Rust source guard)", () => {
  const f = [new URL("../../../../cloudy-u-android/ac_cloud-c3-webserver/server/src/meshlogs.rs", import.meta.url).pathname, new URL("../../../../../cloudy-u-android/ac_cloud-c3-webserver/server/src/meshlogs.rs", import.meta.url).pathname].find((x) => existsSync(x));
  if (!f) { console.log("  (cloudy-u-android not checked out here: the Rust tests cover it)"); return; }
  const src = readFileSync(f, "utf8");
  const route = src.slice(src.indexOf("pub fn route("), src.indexOf("pub fn start("));
  assert.ok(route.indexOf("authorize(") >= 0 && route.indexOf("authorize(") < route.indexOf("meshmcp::MCP_PATH"), "the bearer gate precedes /mcp");
  assert.ok(src.includes("TcpListener::bind((addr, m.port))") && src.includes("mm.is_mesh(ip)") && src.includes("m.check_bind()?"), "mesh-only bind and peer filter");
});

await t("tool paths: the API route is the same path the MCP tool maps to, and arguments are refused when unsafe", () => {
  assert.equal(toolPath("app_logs", { app: "calc", n: 99999, errors: true }), "/ipc/calc/logs?n=2000&errors=1");
  for (const bad of ["../x", "a/b", "a b", ""]) assert.throws(() => toolPath("app_logs", { app: bad }));
  assert.throws(() => toolPath("shell"));
});

await t("health: every declared peer is a row; a peer that answers nothing is shown with its flags false; this never throws", async () => {
  const dead: Deps = { token: TOKEN, http: async () => { throw new Error("timeout"); }, ssh: async () => { throw new Error("closed"); }, now: () => 5 };
  const rows = await health(peers, dead);
  assert.deepEqual(rows.map((r) => r.peer), peers.map((p) => p.id));
  assert.ok(rows.every((r) => !r.sshd_up && !r.mcp_up && !r.api_up && r.tool_count === null && r.last.mcp?.ok === false && r.last.sshd?.at === 5));
  const live = await health([one], deps());
  assert.deepEqual([live[0].sshd_up, live[0].mcp_up, live[0].api_up, live[0].tool_count], [true, true, true, 2]);
  assert.equal(live[0].last.api?.ok, true);
  const half = await health([one], { ...deps(), ssh: async () => { throw new Error("sshd closed"); } });
  assert.deepEqual([half[0].sshd_up, half[0].mcp_up], [false, true], "sshd closed, MCP still serves");
});

await t("findPeer by id or mesh address; unknown lists the declared", () => {
  assert.equal(findPeer(peers, "SAMSUNG-A37").id, "samsung-a37");
  assert.equal(findPeer(peers, "10.0.0.10").id, "samsung-a37");
  assert.throws(() => findPeer(peers, "nope"), /declared peers are/);
});

console.log(`${n} passed`);
