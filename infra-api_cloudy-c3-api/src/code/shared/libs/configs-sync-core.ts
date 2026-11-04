// Read side of the configs-sync data repo (cloud_db_infra-ops-obsv_configs-sync), shared by the
// c3-infra-api route and tested without a server. The data repo is public; only an allowlisted
// file name (a flat *.json or build/build-*.json) is ever fetched.
export const DATA_REPO_RAW =
  process.env.CONFIGS_SYNC_RAW ?? "https://raw.githubusercontent.com/diegonmarcos/cloudy_db_infra-ops-obsv_configs-sync/main/";
export const TTL_MS = 60_000;

const NAME_RE = /^(build\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.json$/;
export function isConfigFileName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes("..");
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
const cache = new Map<string, { at: number; body: string }>();

/** Fetch one JSON file of the data repo; 60 s cache, a stale copy is served when the fetch fails. */
export async function readConfigFile(name: string, f: Fetcher = fetch as unknown as Fetcher, now = Date.now()): Promise<string> {
  if (!isConfigFileName(name)) throw new Error("bad file name");
  const hit = cache.get(name);
  if (hit && now - hit.at < TTL_MS) return hit.body;
  try {
    const r = await f(DATA_REPO_RAW + name);
    if (!r.ok) throw new Error(`data repo answered ${r.status}`);
    const body = await r.text();
    JSON.parse(body); // never cache or serve a half-written file
    cache.set(name, { at: now, body });
    return body;
  } catch (e) {
    if (hit) return hit.body;
    throw e;
  }
}
export function clearConfigCache() { cache.clear(); }
