// The read side of the fleet data route (#1547): GET /fleet-data/manifest and GET /fleet-data/<tier>/<dataset> serve the PERSONAL (tier 1) and
// FLEET/INFRA (tier 2) datasets of the Cloud apps' fleet data framework. The source is the PRIVATE repo cloud-me-pvt-configs (folder fleet-data/),
// read with a server-side token (FLEET_DATA_TOKEN, never logged, never sent to a client); nothing here ever comes from a public repo. Only a
// validated dataset name is fetched, a body is served only when it parses and carries an integer schemaVersion (a half-written file is never
// served), the answer carries an ETag (sha256 of the body) and honours If-None-Match, and a stale copy survives a short outage.
// Pure and dependency-free: the tester runs it with node alone.
import { createHash } from "node:crypto";

export const PVT_RAW =
  process.env.FLEET_DATA_RAW ?? "https://raw.githubusercontent.com/diegonmarcos/cloud-me-pvt-configs/main/fleet-data/";
export const TTL_MS = 60_000;

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** `a`, `fleet/probes`, `app/<package>/<dataset>`: lower-case segments, no empty one, no dot-dot. */
export function isDatasetPath(path: string): boolean {
  if (!path || path.includes("..")) return false;
  const parts = path.split("/");
  if (parts[0] === "app") return parts.length >= 3 && PACKAGE.test(parts[1]) && parts.slice(2).every((s) => SEGMENT.test(s));
  return parts.every((s) => SEGMENT.test(s));
}

export function isTier(t: string): t is "1" | "2" { return t === "1" || t === "2"; }

export interface Answer { status: number; body?: string; etag?: string; error?: string }
type Fetcher = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const cache = new Map<string, { at: number; body: string }>();

export function etagOf(body: string): string { return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`; }

/** The body is a JSON object with an integer schemaVersion >= 1 (the clients refuse anything else). */
export function validBody(body: string): boolean {
  try { const o = JSON.parse(body); return o !== null && typeof o === "object" && !Array.isArray(o) && Number.isInteger(o.schemaVersion) && o.schemaVersion >= 1; } catch { return false; }
}

/** `file` is `manifest` or `<tier>/<dataset path>`; the private repo path is fleet-data/<file>.json. */
export async function readFleetData(file: string, ifNoneMatch: string | undefined, f: Fetcher = fetch as unknown as Fetcher, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<Answer> {
  const ok = file === "manifest" || (isTier(file.split("/")[0]) && isDatasetPath(file.split("/").slice(1).join("/")));
  if (!ok) return { status: 400, error: "bad dataset name" };
  const token = env.FLEET_DATA_TOKEN;
  if (!token) return { status: 503, error: "private source not configured" };
  let body: string | undefined;
  const hit = cache.get(file);
  if (hit && now - hit.at < TTL_MS) body = hit.body;
  else {
    try {
      const r = await f(`${PVT_RAW}${file}.json`, { Authorization: `token ${token}`, Accept: "application/json" });
      if (r.status === 404) return { status: 404, error: "no such dataset" };
      if (!r.ok) throw new Error(`source answered ${r.status}`);
      const text = await r.text();
      if (!validBody(text)) throw new Error("not a dataset (JSON object with schemaVersion)");
      cache.set(file, { at: now, body: text });
      body = text;
    } catch (e) {
      if (hit) body = hit.body;
      else return { status: 502, error: "private source unavailable" };
    }
  }
  const etag = etagOf(body);
  if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, etag };
  return { status: 200, body, etag };
}
export function clearFleetDataCache() { cache.clear(); }
