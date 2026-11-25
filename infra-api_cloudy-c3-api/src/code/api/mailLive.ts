// #1926 Live mail probes the C3 API runs itself (read-only): DNS records of the mail domains, TLS certificate expiry of the
// public mail hostnames, reachability of the public MX. The targets are DECLARED here as data; the probe functions are
// injected into collectLive() so the test runs with no network.
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import type { DnsRow, Live, PortRow, TlsRow } from "./mailStack.js";

export const MAIL_DOMAINS: ReadonlyArray<{ domain: string; dkimSelectors: readonly string[]; mailHost: string }> = [
  { domain: "diegonmarcos.com", dkimSelectors: ["default"], mailHost: "mail.diegonmarcos.com" },
];

/** Public hostnames whose certificate is read (SNI mux on :443 serves imap./smtps.; jmap., webmail., mail. are HTTPS). */
export const TLS_TARGETS: ReadonlyArray<{ host: string; port: number; role: string }> = [
  { host: "imap.diegonmarcos.com", port: 443, role: "IMAP client endpoint (Caddy L4 SNI mux)" },
  { host: "smtps.diegonmarcos.com", port: 443, role: "SMTPS submission endpoint (Caddy L4 SNI mux)" },
  { host: "jmap.diegonmarcos.com", port: 443, role: "Stalwart JMAP" },
  { host: "mail.diegonmarcos.com", port: 443, role: "Maddy host (HTTPS admin)" },
  { host: "webmail.diegonmarcos.com", port: 443, role: "cloud-webmail" },
  { host: "mta-sts.diegonmarcos.com", port: 443, role: "MTA-STS policy host" },
];

export const PORT_TARGETS: ReadonlyArray<{ host: string; port: number; role: string }> = [
  { host: "route1.mx.cloudflare.net", port: 25, role: "public MX 1 (Cloudflare Email Routing)" },
  { host: "route2.mx.cloudflare.net", port: 25, role: "public MX 2 (Cloudflare Email Routing)" },
  { host: "route3.mx.cloudflare.net", port: 25, role: "public MX 3 (Cloudflare Email Routing)" },
  { host: "imap.diegonmarcos.com", port: 443, role: "IMAP over the :443 SNI mux" },
  { host: "smtps.diegonmarcos.com", port: 443, role: "SMTPS over the :443 SNI mux" },
];

export interface Probes {
  resolveMx(name: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>;
  reverse(ip: string): Promise<string[]>;
  cert(host: string, port: number): Promise<{ notAfter: string; issuer: string; latencyMs: number }>;
  tcp(host: string, port: number): Promise<number>;
}

const resolver = new dns.Resolver();
resolver.setServers(["1.1.1.1", "9.9.9.9"]);

export const realProbes: Probes = {
  resolveMx: (n) => resolver.resolveMx(n),
  resolveTxt: async (n) => (await resolver.resolveTxt(n)).map((c) => c.join("")),
  resolve4: (n) => resolver.resolve4(n),
  reverse: (ip) => resolver.reverse(ip),
  cert: (host, port) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const s = tls.connect({ host, port, servername: host, timeout: 8000, rejectUnauthorized: false }, () => {
        const c = s.getPeerCertificate();
        s.end();
        if (!c || !c.valid_to) return reject(new Error("no certificate presented"));
        resolve({ notAfter: new Date(c.valid_to).toISOString(), issuer: String((c.issuer as any)?.O ?? (c.issuer as any)?.CN ?? ""), latencyMs: Date.now() - t0 });
      });
      s.on("timeout", () => { s.destroy(); reject(new Error("timeout")); });
      s.on("error", (e) => reject(e));
    }),
  tcp: (host, port) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const s = net.connect({ host, port, timeout: 5000 }, () => { s.destroy(); resolve(Date.now() - t0); });
      s.on("timeout", () => { s.destroy(); reject(new Error("timeout")); });
      s.on("error", (e) => reject(e));
    }),
};

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 160);

export async function collectDns(p: Probes): Promise<DnsRow[]> {
  const rows: DnsRow[] = [];
  for (const { domain, dkimSelectors, mailHost } of MAIL_DOMAINS) {
    const add = (type: string, selector: string, name: string, value: string, ok: boolean, note = "") =>
      rows.push({ domain, type, selector, name, value, ok, note });
    try {
      const mx = (await p.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
      if (!mx.length) add("MX", "", domain, "", false, "no MX records");
      for (const m of mx) add("MX", "", domain, `${m.priority} ${m.exchange}`, true);
    } catch (e) { add("MX", "", domain, "", false, msg(e)); }
    const txt = async (type: string, selector: string, name: string, want: RegExp, required: boolean) => {
      try {
        const hit = (await p.resolveTxt(name)).filter((v) => want.test(v));
        if (!hit.length) add(type, selector, name, "", false, "record missing");
        for (const v of hit) add(type, selector, name, v, true);
      } catch (e) { add(type, selector, name, "", false, required ? msg(e) : `missing (${msg(e)})`); }
    };
    await txt("SPF", "", domain, /^v=spf1/i, true);
    await txt("DMARC", "", `_dmarc.${domain}`, /^v=DMARC1/i, true);
    for (const sel of dkimSelectors) await txt("DKIM", sel, `${sel}._domainkey.${domain}`, /v=DKIM1/i, true);
    await txt("MTA-STS", "", `_mta-sts.${domain}`, /^v=STSv1/i, false);
    await txt("TLS-RPT", "", `_smtp._tls.${domain}`, /^v=TLSRPTv1/i, false);
    try {
      const ips = await p.resolve4(mailHost);
      if (!ips.length) add("PTR", "", mailHost, "", false, "mail host has no A record");
      for (const ip of ips) {
        try {
          const names = await p.reverse(ip);
          add("PTR", "", ip, names.join(", "), names.length > 0, names.length ? "" : "no PTR");
        } catch (e) { add("PTR", "", ip, "", false, msg(e)); }
      }
    } catch (e) { add("PTR", "", mailHost, "", false, msg(e)); }
  }
  return rows;
}

export async function collectTls(p: Probes, now: number = Date.now()): Promise<TlsRow[]> {
  return Promise.all(TLS_TARGETS.map(async (t): Promise<TlsRow> => {
    try {
      const c = await p.cert(t.host, t.port);
      return { ...t, ok: true, notAfter: c.notAfter, daysLeft: Math.floor((Date.parse(c.notAfter) - now) / 86400000), issuer: c.issuer, latencyMs: c.latencyMs, error: "" };
    } catch (e) {
      return { ...t, ok: false, notAfter: null, daysLeft: null, issuer: "", latencyMs: null, error: msg(e) };
    }
  }));
}

export async function collectPorts(p: Probes): Promise<PortRow[]> {
  return Promise.all(PORT_TARGETS.map(async (t): Promise<PortRow> => {
    try { return { ...t, ok: true, latencyMs: await p.tcp(t.host, t.port), error: "" }; }
    catch (e) { return { ...t, ok: false, latencyMs: null, error: msg(e) }; }
  }));
}

export async function collectLive(p: Probes = realProbes, now: number = Date.now()): Promise<Live> {
  const [dnsRows, tlsRows, ports] = await Promise.all([collectDns(p), collectTls(p, now), collectPorts(p)]);
  return { checkedAt: new Date(now).toISOString(), dns: dnsRows, tls: tlsRows, ports };
}
