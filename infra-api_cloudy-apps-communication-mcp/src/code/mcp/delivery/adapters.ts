// Production adapters for the delivery endpoints: Stalwart's directory over the
// JMAP registry (x:Account, x:Domain, x:DkimSignature, x:SenderAuth — the same
// admin channel shared/admin.ts already uses) and the server's DNS resolver.
// Tests inject fixtures instead; nothing here is imported by them.

import { promises as dnsp } from "node:dns";
import type { Directory, TxtResolver } from "./sender-valid.ts";
import type { MxResolver } from "./recipients.ts";

// The host resolver is Hickory over wg0, which is authoritative-with-wildcards for
// the fleet zone (it answers the mesh names, not the public TXT/MX set). SPF,
// DMARC and MX answers must be the ones the rest of the internet sees, so the
// checks use public recursive resolvers (DELIVERY_DNS_SERVERS) and fall back to
// the host resolver only if those cannot be reached.
function resolver(): InstanceType<typeof dnsp.Resolver> {
  const r = new dnsp.Resolver({ timeout: 3000, tries: 2 });
  const servers = (process.env.DELIVERY_DNS_SERVERS ?? "1.1.1.1,9.9.9.9").split(",").map((x) => x.trim()).filter(Boolean);
  if (servers.length) r.setServers(servers);
  return r;
}
const PUBLIC = resolver();
const unreachable = (e: any) => ["ETIMEOUT", "ECONNREFUSED", "ESERVFAIL", "EREFUSED", "ECONNRESET"].includes(e?.code);
async function withFallback<T>(fn: (r: any) => Promise<T>): Promise<T> {
  try { return await fn(PUBLIC); }
  catch (e) { if (unreachable(e)) return fn(dnsp); throw e; }
}

const TTL_MS = 10 * 60_000;

/** Stalwart serialises List<T> as {"0":..,"1":..}; accept that or a real array. */
function listOf<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") return Object.keys(v as object).sort((a, b) => Number(a) - Number(b)).map((k) => (v as Record<string, T>)[k]);
  return [];
}

// Loaded lazily so tests (which inject `get`) never pull in the npm-backed MCP config.
const registryGet = async (type: string): Promise<any[]> => (await import("../shared/admin.js")).stalwartRegistryGet(type);

export function stalwartDirectory(get: (type: string) => Promise<any[]> = registryGet): Directory {
  const cache = new Map<string, { exp: number; v: any[] | null }>();
  const fetchType = async (type: string): Promise<any[] | null> => {
    const c = cache.get(type);
    if (c && c.exp > Date.now()) return c.v;
    let v: any[] | null;
    try { v = await get(type); } catch (e) { process.stderr.write(`[delivery] x:${type}/get failed: ${(e as Error).message}\n`); v = null; }
    cache.set(type, { exp: Date.now() + (v ? TTL_MS : 30_000), v });
    return v;
  };
  const domainNames = async (): Promise<Map<string, string> | null> => {
    const ds = await fetchType("Domain");
    return ds ? new Map(ds.map((d: any) => [String(d.id), String(d.name).toLowerCase()])) : null;
  };
  return {
    async accountAddresses(login) {
      const [accts, doms] = await Promise.all([fetchType("Account"), domainNames()]);
      if (!accts || !doms) return null;
      const l = login.toLowerCase();
      const a = accts.find((x: any) => String(x.name ?? "").toLowerCase() === l || String(x.emailAddress ?? "").toLowerCase() === l);
      if (!a) return [];
      const out = new Set<string>();
      if (a.emailAddress) out.add(String(a.emailAddress).toLowerCase());
      const home = doms.get(String(a.domainId));
      if (home && a.name && !String(a.name).includes("@")) out.add(`${String(a.name).toLowerCase()}@${home}`);
      for (const al of listOf<any>(a.aliases)) {
        if (al?.enabled === false) continue;
        const d = doms.get(String(al?.domainId));
        if (al?.name && d) out.add(`${String(al.name).toLowerCase()}@${d}`);
      }
      return [...out];
    },
    async dkimSigners(domain) {
      const [keys, doms] = await Promise.all([fetchType("DkimSignature"), domainNames()]);
      if (!keys || !doms) return null;
      return keys
        .filter((k: any) => doms.get(String(k.domainId)) === domain.toLowerCase())
        .map((k: any) => ({ selector: String(k.selector ?? ""), stage: String(k.stage ?? "active") }));
    },
    async dkimSignRule() {
      const sa = await fetchType("SenderAuth");
      const rule = sa?.[0]?.dkimSignDomain;
      if (!rule) return null;
      return { match: listOf<any>(rule.match).map((m) => ({ if: String(m.if ?? ""), then: String(m.then ?? "") })), else: String(rule.else ?? "") };
    },
  };
}

export function systemTxt(): TxtResolver {
  return {
    async txt(name) {
      try { return (await withFallback((r) => r.resolveTxt(name)) as string[][]).map((chunks) => chunks.join("")); }
      catch (e: any) { return e?.code === "ENOTFOUND" || e?.code === "ENODATA" ? [] : null; }
    },
  };
}

export function systemMx(): MxResolver {
  return {
    async mx(domain) {
      try { return await withFallback((r) => r.resolveMx(domain)); }
      catch (e: any) {
        if (e?.code === "ENOTFOUND") return null;
        if (e?.code === "ENODATA") return [];
        throw e;
      }
    },
    async a(domain) { try { return await withFallback((r) => r.resolve4(domain)); } catch { return []; } },
    async aaaa(domain) { try { return await withFallback((r) => r.resolve6(domain)); } catch { return []; } },
  };
}
