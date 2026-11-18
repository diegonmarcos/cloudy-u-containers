// Recipient check (#1803): POST /v1/recipients/check {addresses:[...]}.
//
// Per address: syntax, domain_mx (MX, else the RFC 5321 §5.1 implicit MX from
// A/AAAA, null MX = fail), mailbox (RCPT probe from the server, never DATA; a
// catch-all is accepts_all and a deferral is unknown, never ok), past_bounce
// (from the #1802 ledger), disposable / role hints, size_limit (EHLO SIZE).
// Results are cached with a TTL; callers are rate-limited per caller id.
//
// Verdict:
//   fail     syntax invalid, domain has no mail host (NXDOMAIN / null MX / no MX+A+AAAA),
//            or the recipient's own server said the mailbox does not exist.
//   risky    the address is deliverable-looking but: catch-all, past bounce, disposable or role.
//   ok       only when the mailbox probe got an explicit accept AND catch-all was ruled out
//            AND no risk hint applies.
//   unknown  everything else (probe unreachable, greylisted, policy refusal, DNS failure).

import { domainToASCII } from "node:url";
import type { Ledger } from "./ledger.ts";
import { type Connector, type ProbeResult, probeMailbox } from "./smtp-probe.ts";

export interface MxResolver {
  /** [] = NODATA; null = NXDOMAIN; throws on resolver failure. */
  mx(domain: string): Promise<Array<{ exchange: string; priority: number }> | null>;
  a(domain: string): Promise<string[]>;
  aaaa(domain: string): Promise<string[]>;
}

export interface CheckerConfig {
  helo: string;
  mailFrom: string;
  probePort: number;
  probeTimeoutMs: number;
  maxMxTried: number;
  /** Domains probed at a fixed host:port instead of their MX (the fleet's own Stalwart over wg0). */
  probeOverrides: Record<string, { host: string; port: number }>;
  cacheTtlMs: number;
  cacheTtlUnknownMs: number;
  maxAddressesPerRequest: number;
  rateLimit: { addresses: number; perMs: number };
  random?: () => string;
}

export type Verdict = "ok" | "risky" | "fail" | "unknown";

export interface CheckResult {
  address: string;
  verdict: Verdict;
  reason: string;
  checks: {
    syntax: { state: "ok" | "fail"; reason?: string; normalized?: string };
    domain_mx: { state: "ok" | "fail" | "unknown"; hosts: string[]; implicit?: boolean; null_mx?: boolean; reason?: string };
    mailbox: { state: "exists" | "does_not_exist" | "accepts_all" | "unknown" | "not_checked"; host?: string; code?: number | null; reason: string };
    past_bounce: { state: "none" | "bounced"; at?: string; reason?: string };
    disposable: boolean;
    role: boolean;
    size_limit: { bytes: number | null; host?: string; reason?: string };
  };
  cached: boolean;
  checked_at: string;
}

const ROLE = new Set(["abuse", "admin", "administrator", "billing", "compliance", "contact", "devnull", "dns", "ftp", "hello", "help", "hostmaster", "info", "inquiries", "it", "jobs", "legal", "list", "mail", "mailer-daemon", "marketing", "media", "news", "no-reply", "noreply", "do-not-reply", "donotreply", "office", "postmaster", "press", "privacy", "root", "sales", "security", "service", "support", "sysadmin", "team", "webmaster", "www"]);

// Small, conservative seed list of widely known throwaway providers. A hint only:
// it can only move a verdict to "risky", never to "fail".
const DISPOSABLE = new Set(["10minutemail.com", "20minutemail.com", "33mail.com", "anonaddy.me", "burnermail.io", "discard.email", "dispostable.com", "emailondeck.com", "fakeinbox.com", "getairmail.com", "getnada.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "harakirimail.com", "inboxkitten.com", "mailcatch.com", "maildrop.cc", "mailinator.com", "mailinator.net", "mailnesia.com", "mailpoof.com", "mintemail.com", "mohmal.com", "moakt.com", "mytemp.email", "sharklasers.com", "spam4.me", "spambox.us", "spamgourmet.com", "temp-mail.org", "temp-mail.io", "tempail.com", "tempmail.dev", "tempmailo.com", "tempr.email", "throwawaymail.com", "trashmail.com", "trashmail.de", "yopmail.com", "yopmail.fr", "yopmail.net"]);

const DOT_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const QUOTED = /^"([\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function checkSyntax(input: string): { ok: boolean; reason?: string; local?: string; domain?: string; normalized?: string } {
  const a = String(input ?? "").trim();
  if (!a) return { ok: false, reason: "empty" };
  if (a.length > 254) return { ok: false, reason: "longer than 254 characters" };
  const at = a.lastIndexOf("@");
  if (at <= 0 || at === a.length - 1) return { ok: false, reason: "missing local part or domain" };
  const local = a.slice(0, at);
  const rawDomain = a.slice(at + 1).replace(/\.$/, "");
  if (local.length > 64) return { ok: false, reason: "local part longer than 64 characters" };
  if (!DOT_ATOM.test(local) && !QUOTED.test(local)) {
    // RFC 6531 (SMTPUTF8) local parts: accept non-ASCII letters, still no spaces/specials.
    if (!/^[^\s"(),:;<>@[\\\]]+$/.test(local) || /^\.|\.\.|\.$/.test(local)) return { ok: false, reason: "invalid local part" };
  }
  if (/^\[.*\]$/.test(rawDomain)) return { ok: false, reason: "address literals are not accepted" };
  const domain = domainToASCII(rawDomain.toLowerCase());
  if (!domain) return { ok: false, reason: "invalid domain" };
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1])) return { ok: false, reason: "invalid domain" };
  return { ok: true, local, domain, normalized: `${local}@${domain}` };
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(max: number, windowMs: number, now: () => number = Date.now) {
    this.max = max; this.windowMs = windowMs; this.now = now;
  }
  /** Takes `n` tokens for `caller`; returns ms to wait (0 = allowed). */
  take(caller: string, n: number): number {
    const t = this.now();
    const arr = (this.hits.get(caller) ?? []).filter((x) => t - x < this.windowMs);
    if (arr.length + n > this.max) {
      this.hits.set(caller, arr);
      const oldest = arr[0] ?? t;
      return Math.max(1, this.windowMs - (t - oldest));
    }
    for (let i = 0; i < n; i++) arr.push(t);
    this.hits.set(caller, arr);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return 0;
  }
}

export class RecipientChecker {
  private cache = new Map<string, { exp: number; r: CheckResult }>();
  readonly limiter: RateLimiter;
  readonly cfg: CheckerConfig;
  private readonly dns: MxResolver;
  private readonly connector: Connector;
  private readonly ledger: Ledger | null;
  private readonly now: () => number;
  constructor(cfg: CheckerConfig, dns: MxResolver, connector: Connector, ledger: Ledger | null, now: () => number = Date.now) {
    this.cfg = cfg; this.dns = dns; this.connector = connector; this.ledger = ledger; this.now = now;
    this.limiter = new RateLimiter(cfg.rateLimit.addresses, cfg.rateLimit.perMs, now);
  }

  async check(address: string): Promise<CheckResult> {
    const key = String(address ?? "").trim().toLowerCase();
    const hit = this.cache.get(key);
    if (hit && hit.exp > this.now()) return { ...hit.r, cached: true };
    const r = await this.compute(address);
    const ttl = r.verdict === "unknown" ? this.cfg.cacheTtlUnknownMs : this.cfg.cacheTtlMs;
    this.cache.set(key, { exp: this.now() + ttl, r });
    if (this.cache.size > 20_000) { const t = this.now(); for (const [k, v] of this.cache) if (v.exp <= t) this.cache.delete(k); }
    return r;
  }

  private async compute(address: string): Promise<CheckResult> {
    const checked_at = new Date(this.now()).toISOString();
    const syn = checkSyntax(address);
    const base: CheckResult = {
      address: String(address ?? ""),
      verdict: "unknown",
      reason: "",
      checks: {
        syntax: syn.ok ? { state: "ok", normalized: syn.normalized } : { state: "fail", reason: syn.reason },
        domain_mx: { state: "unknown", hosts: [] },
        mailbox: { state: "not_checked", reason: "not reached" },
        past_bounce: { state: "none" },
        disposable: false,
        role: false,
        size_limit: { bytes: null, reason: "not reached" },
      },
      cached: false,
      checked_at,
    };
    if (!syn.ok) { base.verdict = "fail"; base.reason = `syntax: ${syn.reason}`; return base; }
    const addr = syn.normalized as string;
    const domain = syn.domain as string;
    const local = (syn.local as string).toLowerCase();
    base.checks.role = ROLE.has(local.split("+")[0]);
    base.checks.disposable = DISPOSABLE.has(domain) || [...DISPOSABLE].some((d) => domain.endsWith("." + d));
    const b = this.ledger?.lastBounce(addr) ?? null;
    if (b) base.checks.past_bounce = { state: "bounced", at: b.at, reason: b.reason };

    // ── domain_mx ──
    const override = this.cfg.probeOverrides[domain];
    let hosts: string[] = [];
    try {
      const mx = await this.dns.mx(domain);
      if (mx === null) {
        base.checks.domain_mx = { state: "fail", hosts: [], reason: `${domain} does not exist (NXDOMAIN)` };
      } else if (mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === ".")) {
        base.checks.domain_mx = { state: "fail", hosts: [], null_mx: true, reason: `${domain} publishes a null MX (RFC 7505): it accepts no mail` };
      } else if (mx.length) {
        hosts = mx.filter((m) => m.exchange && m.exchange !== ".").sort((x, y) => x.priority - y.priority).map((m) => m.exchange.replace(/\.$/, "").toLowerCase());
        base.checks.domain_mx = { state: "ok", hosts };
      } else {
        const [a, aaaa] = await Promise.all([this.dns.a(domain).catch(() => []), this.dns.aaaa(domain).catch(() => [])]);
        if (a.length || aaaa.length) { hosts = [domain]; base.checks.domain_mx = { state: "ok", hosts, implicit: true, reason: "no MX; implicit MX from A/AAAA (RFC 5321 §5.1)" }; }
        else base.checks.domain_mx = { state: "fail", hosts: [], reason: `${domain} has no MX and no A/AAAA` };
      }
    } catch (e) {
      base.checks.domain_mx = { state: "unknown", hosts: [], reason: `DNS lookup failed: ${(e as Error).message}` };
    }
    if (base.checks.domain_mx.state === "fail") { base.verdict = "fail"; base.reason = `domain_mx: ${base.checks.domain_mx.reason}`; return base; }

    // ── mailbox + size_limit ──
    const targets = override ? [override] : hosts.slice(0, this.cfg.maxMxTried).map((h) => ({ host: h, port: this.cfg.probePort }));
    let probe: ProbeResult | null = null;
    for (const t of targets) {
      probe = await probeMailbox(this.connector, t.host, addr, {
        helo: this.cfg.helo, mailFrom: this.cfg.mailFrom, timeoutMs: this.cfg.probeTimeoutMs, port: t.port, random: this.cfg.random,
      });
      if (probe.connected) break; // a reachable MX answered; do not shop for a friendlier one
    }
    if (probe) {
      base.checks.mailbox = { state: probe.mailbox, host: probe.host, code: probe.code, reason: probe.reason };
      base.checks.size_limit = probe.sizeLimit === null
        ? { bytes: null, host: probe.host, reason: probe.connected ? "SIZE not advertised" : "server not reached" }
        : { bytes: probe.sizeLimit, host: probe.host, reason: probe.sizeLimit === 0 ? "SIZE advertised without a limit" : undefined };
    } else {
      base.checks.mailbox = { state: "unknown", reason: "no mail host to probe" };
    }

    // ── verdict ──
    const mb = base.checks.mailbox.state;
    const hints: string[] = [];
    if (base.checks.past_bounce.state === "bounced") hints.push(`bounced before (${base.checks.past_bounce.at})`);
    if (base.checks.disposable) hints.push("disposable domain");
    if (base.checks.role) hints.push("role address");
    if (mb === "does_not_exist") { base.verdict = "fail"; base.reason = `mailbox: ${base.checks.mailbox.reason}`; }
    else if (mb === "accepts_all") { base.verdict = "risky"; base.reason = ["catch-all domain", ...hints].join("; "); }
    else if (mb === "exists") { base.verdict = hints.length ? "risky" : "ok"; base.reason = hints.length ? hints.join("; ") : `mailbox confirmed by ${base.checks.mailbox.host}`; }
    else if (hints.length && base.checks.past_bounce.state === "bounced") { base.verdict = "risky"; base.reason = [...hints, `mailbox unverified: ${base.checks.mailbox.reason}`].join("; "); }
    else { base.verdict = "unknown"; base.reason = `mailbox: ${base.checks.mailbox.reason}${hints.length ? "; " + hints.join("; ") : ""}`; }
    return base;
  }
}
