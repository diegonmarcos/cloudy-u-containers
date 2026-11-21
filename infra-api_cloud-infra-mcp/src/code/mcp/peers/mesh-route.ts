// #1835 the two first-class routes to every mesh peer: (a) its sshd, (b) its MCP/API over the mesh (Cloud C3 Webserver mesh listener :8004).
// Pure and injectable (no SDK, no network of its own), so the dependency-free tester runs it.
//   * Peers come from shared/mesh-peers.json, GENERATED from the declared WireGuard membership (gen-mesh-peers.mjs), never a hand list.
//   * A call tries MCP, then the plain API, then sshd (curl from inside), and reports which route served it.
//   * The bearer is the fleet bearer the mesh API already uses (SUPERAPP_FLEET_TOKEN, as device.ts; PHONE_FLEET_TOKEN as phone-api-core.ts).
//     It is only ever sent in an Authorization header (or on an ssh stdin script), never as an argument, and redacted from every output.

// The mesh-only origin rule, as phone-api-core.ts phoneBase (no import: the dependency-free tester loads this file with plain node;
// test-mesh-route.mts asserts the two agree).
const MESH_V4 = /^(10\.0\.0|10\.1\.0)\.\d{1,3}$/;
const MESH_SUFFIX = ".mesh.diegonmarcos.com";
export function phoneBase(env: { PHONE_MESH_URL?: string }): { ok: true; value: string } | { ok: false; error: string } {
  let u: URL;
  try { u = new URL((env.PHONE_MESH_URL ?? "").trim()); } catch { return { ok: false, error: "mesh URL is not a URL" }; }
  const host = u.hostname.toLowerCase();
  const mesh = (host.endsWith(MESH_SUFFIX) && host.length > MESH_SUFFIX.length) || (MESH_V4.test(host) && host.split(".").every((o) => Number(o) <= 255));
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { ok: false, error: "mesh URL must be an http(s) origin without credentials" };
  if (!mesh) return { ok: false, error: `mesh URL host ${host} is not a mesh address: the mesh API is never reached over a public host` };
  return { ok: true, value: `${u.protocol}//${u.host}` };
}

export type Route = "mcp" | "api" | "sshd";
/** The transport order: MCP first, the API second, sshd last. */
export const ROUTE_ORDER: readonly Route[] = ["mcp", "api", "sshd"];

export interface Peer { id: string; kind: "vm" | "phone" | "client"; wg_ip: string; ssh: { hosts: string[] }; mcp: { url: string } }

export interface Deps {
  token: string;
  /** HTTP with a method and optional body; throws on network failure. */
  http(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }): Promise<{ status: number; text(): Promise<string> }>;
  /** Run a POSIX sh script on `host` over ssh (script on stdin); throws on failure. */
  ssh(host: string, script: string): Promise<string>;
  now(): number;
}

export function fleetBearer(env: NodeJS.ProcessEnv = process.env): string {
  for (const k of ["SUPERAPP_FLEET_TOKEN", "PHONE_FLEET_TOKEN"]) {
    const raw = (env[k] ?? "").trim();
    if (raw && !/^\$\{[A-Za-z_][A-Za-z0-9_-]*\}$/.test(raw)) return raw; // an unexpanded ${VAR} is a miss, as in device.ts
  }
  return "";
}

export function parsePeers(doc: unknown): Peer[] {
  const list = (doc as { peers?: Peer[] })?.peers;
  if (!Array.isArray(list)) throw new Error("mesh-peers.json has no peers");
  return list;
}

/** Why a peer is not configured on BOTH routes (empty = fine). */
export function routeGaps(p: Peer): string[] {
  const gaps: string[] = [];
  if (!Array.isArray(p.ssh?.hosts) || p.ssh.hosts.length === 0 || p.ssh.hosts.some((h) => !/^[A-Za-z0-9._-]+$/.test(h))) gaps.push("sshd route");
  if (!phoneBase({ PHONE_MESH_URL: p.mcp?.url }).ok) gaps.push("mcp route (not a mesh origin)");
  return gaps;
}

export function findPeer(peers: Peer[], q: string): Peer {
  const k = q.trim().toLowerCase();
  const p = peers.find((x) => x.id.toLowerCase() === k || x.wg_ip === k);
  if (!p) throw new Error(`unknown peer "${q}": declared peers are ${peers.map((x) => x.id).join(", ")}`);
  return p;
}

const APP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** The tools every peer's Cloud C3 Webserver listener serves (mirror of server/src/meshmcp.rs path_of) and the API path each maps to. */
export const TOOLS = ["endpoints_mesh", "endpoints_public", "ipc_index", "app_logs"] as const;
export function toolPath(tool: string, a: Record<string, unknown> = {}): string {
  switch (tool) {
    case "endpoints_mesh": return "/endpoints/mesh";
    case "endpoints_public": return "/endpoints/public";
    case "ipc_index": return "/ipc";
    case "app_logs": {
      if (typeof a.app !== "string" || !APP_RE.test(a.app) || a.app.includes("..")) throw new Error("app must be a fleet app id or package (letters, digits, . _ -)");
      const q = new URLSearchParams();
      if (a.method !== undefined) { if (!["export", "logs", "crashes", "meta"].includes(String(a.method))) throw new Error("method must be one of export, logs, crashes, meta"); q.set("method", String(a.method)); }
      if (a.n !== undefined) q.set("n", String(Math.min(2000, Math.max(1, Math.floor(Number(a.n)) || 1))));
      if (a.errors === true) q.set("errors", "1");
      if (a.crashes !== undefined) q.set("crashes", String(Math.min(20, Math.max(0, Math.floor(Number(a.crashes)) || 0))));
      return `/ipc/${a.app}/logs${q.toString() ? `?${q}` : ""}`;
    }
    default: throw new Error(`unknown tool ${tool}`);
  }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const TIMEOUT = 15_000;

export type Last = { at: number; ok: boolean; detail: string };
/** The last answer per peer per route (in memory, this process). */
const lastAnswer = new Map<string, Last>();
export const lastOf = (peer: string, r: Route): Last | null => lastAnswer.get(`${peer}/${r}`) ?? null;
const record = (peer: string, r: Route, d: Deps, ok: boolean, detail: string) => lastAnswer.set(`${peer}/${r}`, { at: d.now(), ok, detail: detail.slice(0, 200) });

function guard(p: Peer, d: Deps): string {
  const base = phoneBase({ PHONE_MESH_URL: p.mcp.url });
  if (!base.ok) throw new Error(base.error);
  if (!d.token) throw new Error("no fleet bearer in the environment (SUPERAPP_FLEET_TOKEN): refusing to call the mesh API without it");
  return base.value;
}
const clean = (e: unknown, d: Deps) => String((e as Error)?.message ?? e).split(d.token || "\u0000").join("***");

async function httpText(p: Peer, d: Deps, method: string, path: string, body?: string): Promise<string> {
  const base = guard(p, d);
  const headers: Record<string, string> = { authorization: `Bearer ${d.token}`, accept: "application/json, text/event-stream" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await d.http(base + path, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT) });
  const text = await r.text();
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status}${r.status === 401 ? " (the bearer was refused)" : ""} ${text.slice(0, 200)}`);
  return text;
}

let rpcId = 0;
async function rpc(p: Peer, d: Deps, method: string, params?: unknown): Promise<any> {
  const text = await httpText(p, d, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }));
  const j = JSON.parse(text);
  if (j.error) throw new Error(`mcp ${j.error.code}: ${j.error.message}`);
  return j.result;
}

/** The peer's own tools over its MCP endpoint. */
export async function peerTools(p: Peer, d: Deps): Promise<{ name: string; description?: string }[]> {
  try {
    await rpc(p, d, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cloud-infra-mcp", version: "1" } });
    const r = await rpc(p, d, "tools/list");
    record(p.id, "mcp", d, true, `${r.tools.length} tools`);
    return r.tools;
  } catch (e) { record(p.id, "mcp", d, false, clean(e, d)); throw new Error(clean(e, d)); }
}

async function viaSshd(p: Peer, d: Deps, path: string): Promise<string> {
  const base = guard(p, d);
  const script = `T=${shq(d.token)}\ncurl -sS -m 20 --fail-with-body -H "Authorization: Bearer $T" ${shq(base + path)}\n`;
  const errs: string[] = [];
  for (const h of p.ssh.hosts) {
    try { return await d.ssh(h, script); } catch (e) { errs.push(`${h}: ${clean(e, d)}`); }
  }
  throw new Error(errs.join(" | "));
}

export interface Served { peer: string; route: Route; text: string; tried: { route: Route; ok: boolean; error?: string }[] }

/** Run one tool on one peer: MCP first, API second, sshd last (or just `only`). Says which route served it. Throws with every route's error when none did. */
export async function callPeer(p: Peer, tool: string, args: Record<string, unknown>, d: Deps, only?: Route): Promise<Served> {
  const tried: Served["tried"] = [];
  for (const route of only ? [only] : ROUTE_ORDER) {
    try {
      let text: string;
      if (route === "mcp") {
        const r = await rpc(p, d, "tools/call", { name: tool, arguments: args });
        text = (r.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
        if (r.isError) throw new Error(`the peer's tool failed: ${text.slice(0, 200)}`);
      } else if (route === "api") text = await httpText(p, d, "GET", toolPath(tool, args));
      else text = await viaSshd(p, d, toolPath(tool, args));
      record(p.id, route, d, true, `${tool} ok`);
      tried.push({ route, ok: true });
      return { peer: p.id, route, text, tried };
    } catch (e) {
      const msg = clean(e, d);
      record(p.id, route, d, false, msg);
      tried.push({ route, ok: false, error: msg });
    }
  }
  throw new Error(`no route served ${tool} on ${p.id}: ${tried.map((t) => `${t.route}: ${t.error}`).join(" | ")}`);
}

export interface Health { peer: string; kind: string; wg_ip: string; sshd_up: boolean; mcp_up: boolean; api_up: boolean; tool_count: number | null; last: Record<Route, Last | null>; gaps: string[] }

/** Probe every peer on both routes. A peer that does not answer is a row with its flags false, never dropped; this never throws. */
export async function health(peers: Peer[], d: Deps): Promise<Health[]> {
  return Promise.all(peers.map(async (p) => {
    const probe = async (r: Route, fn: () => Promise<void>) => { try { await fn(); return true; } catch (e) { record(p.id, r, d, false, clean(e, d)); return false; } };
    let count: number | null = null;
    const [mcp_up, api_up, sshd_up] = await Promise.all([
      probe("mcp", async () => { count = (await peerTools(p, d)).length; }),
      probe("api", async () => { await httpText(p, d, "GET", "/endpoints/mesh"); record(p.id, "api", d, true, "/endpoints/mesh 200"); }),
      probe("sshd", async () => {
        const errs: string[] = [];
        for (const h of p.ssh.hosts) { try { await d.ssh(h, "true\n"); record(p.id, "sshd", d, true, `${h} ok`); return; } catch (e) { errs.push(`${h}: ${clean(e, d)}`); } }
        throw new Error(errs.join(" | "));
      }),
    ]);
    return { peer: p.id, kind: p.kind, wg_ip: p.wg_ip, sshd_up, mcp_up, api_up, tool_count: mcp_up ? count : null,
      last: { mcp: lastOf(p.id, "mcp"), api: lastOf(p.id, "api"), sshd: lastOf(p.id, "sshd") }, gaps: routeGaps(p) };
  }));
}
