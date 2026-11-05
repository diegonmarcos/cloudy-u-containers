// cloudy-c3-mcp -> the phone's Cloud-Webserver mesh endpoint (#1490). Pure: no imports, so it is testable without the MCP SDK.
//
// The phone serves, on its MESH address only and with the fleet bearer on every path:
//   GET /endpoints/public   the API tab's Public Endpoints page (JSON)
//   GET /endpoints/mesh     the API tab's Mesh Endpoints page (JSON)
//   GET /logs/<app>         the app's log export (recent logcat + crash ring), the app's <package>.logexport provider relayed
// This module builds those requests and refuses anything that is not the mesh: the base URL must be in the mesh namespace
// (*.mesh.diegonmarcos.com) or a mesh-subnet IPv4, never a public host, and the bearer is never written to any output.

export const MESH_SUFFIX = ".mesh.diegonmarcos.com";
export const LOG_METHODS = ["meta", "logs", "crashes", "export"] as const;
export type LogMethod = (typeof LOG_METHODS)[number];

export interface PhoneEnv {
  PHONE_MESH_URL?: string; // e.g. http://<phone-mesh-name-or-ip>:8004 (mesh only)
  PHONE_FLEET_TOKEN?: string; // the fleet bearer, from the sops-managed environment; never printed
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const MESH_V4 = /^(10\.0\.0|10\.1\.0)\.\d{1,3}$/;

/** The mesh base URL (no trailing slash), or why it is refused. */
export function phoneBase(env: PhoneEnv): Result<string> {
  const raw = (env.PHONE_MESH_URL ?? "").trim();
  if (!raw) return { ok: false, error: "PHONE_MESH_URL is not set (the phone's mesh endpoint, e.g. http://<mesh-name>:8004)" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, error: "PHONE_MESH_URL is not a URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, error: "PHONE_MESH_URL must be http(s)" };
  if (u.username || u.password) return { ok: false, error: "PHONE_MESH_URL must not carry credentials" };
  if (u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return { ok: false, error: "PHONE_MESH_URL must be an origin only" };
  const host = u.hostname.toLowerCase();
  const mesh = host.endsWith(MESH_SUFFIX) && host.length > MESH_SUFFIX.length || (MESH_V4.test(host) && host.split(".").every((o) => Number(o) <= 255));
  if (!mesh) return { ok: false, error: `PHONE_MESH_URL host ${host} is not a mesh address (*${MESH_SUFFIX} or 10.0.0.x / 10.1.0.x): the phone's log export is never reached over a public host` };
  return { ok: true, value: `${u.protocol}//${u.host}` };
}

/** An app id or package as the phone's fleet manifest names it: one path segment. */
export function appName(s: unknown): Result<string> {
  if (typeof s !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) || s.includes("..")) return { ok: false, error: "app must be a fleet app id or package (letters, digits, . _ -)" };
  return { ok: true, value: s };
}

export interface LogsParams { app: unknown; n?: unknown; errors?: unknown; crashes?: unknown; method?: unknown }

/** `/logs/<app>?...` with every number clamped like the provider does. */
export function logsPath(p: LogsParams): Result<string> {
  const a = appName(p.app);
  if (!a.ok) return a;
  const q = new URLSearchParams();
  if (p.method !== undefined) {
    if (!(LOG_METHODS as readonly string[]).includes(String(p.method))) return { ok: false, error: `method must be one of ${LOG_METHODS.join(", ")}` };
    q.set("method", String(p.method));
  }
  if (p.n !== undefined) q.set("n", String(Math.min(2000, Math.max(1, Math.floor(Number(p.n)) || 1))));
  if (p.errors === true || p.errors === 1) q.set("errors", "1");
  if (p.crashes !== undefined) q.set("crashes", String(Math.min(20, Math.max(0, Math.floor(Number(p.crashes)) || 0))));
  const qs = q.toString();
  return { ok: true, value: `/logs/${encodeURIComponent(a.value)}${qs ? `?${qs}` : ""}` };
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

/** GET one path of the phone's mesh endpoint with the fleet bearer. Returns the body text, or an error that never contains the token. */
export async function phoneGet(path: string, env: PhoneEnv, fetchImpl: FetchLike = fetch as unknown as FetchLike, timeoutMs = 15_000): Promise<Result<string>> {
  const base = phoneBase(env);
  if (!base.ok) return base;
  const token = (env.PHONE_FLEET_TOKEN ?? "").trim();
  if (!token) return { ok: false, error: "PHONE_FLEET_TOKEN is not set (the fleet bearer): refusing to call the phone without it" };
  const redact = (s: string) => s.split(token).join("***");
  try {
    const r = await fetchImpl(base.value + path, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const body = await r.text();
    if (r.ok) return { ok: true, value: body };
    const hint = r.status === 401 ? " (the bearer was refused)" : r.status === 503 ? " (the phone has no fleet token: is the SuperApp installed?)" : r.status === 502 ? " (that app's log export did not answer: is it installed and up to date?)" : "";
    return { ok: false, error: `HTTP ${r.status}${hint} ${redact(body).slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: `the phone's mesh endpoint did not answer: ${redact(String((e as Error)?.message ?? e))}` };
  }
}
