// sender_valid stage (#1802): may the authenticated account use that From, did
// Stalwart sign it with DKIM, and does SPF/DMARC alignment hold for the domain.
//
// Every check reads a record, never a guess:
//   from_authorized  Stalwart already refused any envelope MAIL FROM the account
//                    does not own (smtp.mail-from-unauthorized: the message is
//                    never queued). The header From is then compared with that
//                    authorised envelope sender and, if it differs, with the
//                    account's own addresses in Stalwart's directory (x:Account).
//   dkim             Stalwart v0.16.5 signs in the DATA pipeline and emits no event on
//                    success, so the evidence is its signing configuration:
//                    x:SenderAuth.dkimSignDomain (which domain it signs for this
//                    session) + an `active` x:DkimSignature for that domain, and
//                    the absence of a DKIM signing error in the submission span.
//                    `evidence` says exactly that, so no client mistakes it for a
//                    header read off the wire.
//   dmarc / spf      DNS TXT records of the From and envelope domains, read by the
//                    server's resolver. DMARC passes when DKIM passes aligned, so
//                    dmarc gates sender_valid and spf is reported, not gated.

import { domainOf } from "./stalwart-wire.ts";
import type { Ledger, State } from "./ledger.ts";

export interface Directory {
  /** Every address the SASL login may send as; null when the directory cannot be read. */
  accountAddresses(login: string): Promise<string[] | null>;
  /** Active/pending/retiring DKIM keys for a domain; null when unreadable. */
  dkimSigners(domain: string): Promise<Array<{ selector: string; stage: string }> | null>;
  /** x:SenderAuth.dkimSignDomain as {match:[{if,then}], else}; null when unreadable. */
  dkimSignRule(): Promise<{ match: Array<{ if: string; then: string }>; else: string } | null>;
}

export interface TxtResolver {
  /** TXT records joined per record; [] for NXDOMAIN/NODATA; null on resolver failure. */
  txt(name: string): Promise<string[] | null>;
}

export interface Check { state: State; reason: string; [k: string]: unknown }

const DEFAULT_SIGN_IF = "is_local_domain(sender_domain) && !is_empty(authenticated_as)";

const TWO_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.jp", "com.br", "com.mx", "co.nz", "com.ar", "com.es", "co.za", "com.tr"]);
export function orgDomain(d: string): string {
  const labels = d.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const last2 = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

function tag(record: string, name: string): string | null {
  const m = record.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;\\s]+)`, "i"));
  return m ? m[1].toLowerCase() : null;
}

export async function senderValid(
  ledger: Ledger, queueId: string, dir: Directory, dns: TxtResolver,
): Promise<{ state: State; at: string | null; reason: string; checks: Record<string, Check> }> {
  const { sub, queue, errors } = ledger.senderContext(queueId);
  const at = queue?.at ?? sub?.at ?? null;
  const checks: Record<string, Check> = {};
  const envFrom = (sub?.envelopeFrom || queue?.from || "").toLowerCase();
  const login = sub?.saslLogin ?? null;
  const headerFrom = sub?.headerFrom ?? null;

  // ── from_authorized ──────────────────────────────────────────────────
  const unauthorized = errors.find((e) => e.type.startsWith("smtp.mail-from-"));
  if (unauthorized) {
    checks.from_authorized = { state: "failed", reason: `Stalwart refused the envelope sender: ${unauthorized.type} ${unauthorized.reason}`.trim() };
  } else if (!sub) {
    checks.from_authorized = { state: "pending", reason: "no MTA-hook record for this message, so the header From and the SASL login are unknown" };
  } else if (!headerFrom) {
    checks.from_authorized = { state: "failed", reason: "message has no parseable From header", login, envelope_from: envFrom };
  } else {
    const base = (a: string) => a.replace(/\+[^@]*@/, "@");
    if (base(headerFrom) === base(envFrom)) {
      checks.from_authorized = { state: "ok", reason: `header From equals the envelope sender Stalwart authorised for ${login}`, login, from: headerFrom };
    } else {
      const addrs = await dir.accountAddresses(login as string);
      if (addrs === null) checks.from_authorized = { state: "pending", reason: "Stalwart directory unreadable; header From differs from the envelope sender", login, from: headerFrom };
      else if (addrs.map((a) => base(a.toLowerCase())).includes(base(headerFrom))) checks.from_authorized = { state: "ok", reason: `${headerFrom} is an address of account ${login}`, login, from: headerFrom };
      else checks.from_authorized = { state: "failed", reason: `${headerFrom} is not an address of account ${login}`, login, from: headerFrom };
    }
  }

  // ── dkim ─────────────────────────────────────────────────────────────
  const envDomain = domainOf(envFrom);
  const fromDomain = domainOf(headerFrom) ?? envDomain;
  let signDomain: string | null = null;
  const dkimErr = errors.find((e) => e.type.startsWith("dkim."));
  const rule = await dir.dkimSignRule();
  if (dkimErr) {
    checks.dkim = { state: "failed", reason: `signing error in the submission session: ${dkimErr.type} ${dkimErr.reason}`.trim(), evidence: "event" };
  } else if (!queue) {
    checks.dkim = { state: "pending", reason: "no queue record yet" };
  } else if (rule === null) {
    checks.dkim = { state: "pending", reason: "Stalwart's signing rule (x:SenderAuth) is unreadable" };
  } else {
    const isDefault = rule.match.length === 1 && rule.match[0].if.replace(/\s+/g, " ").trim() === DEFAULT_SIGN_IF && rule.match[0].then.trim() === "sender_domain" && rule.else.trim() === "false";
    if (!isDefault) {
      checks.dkim = { state: "pending", reason: "custom x:SenderAuth.dkimSignDomain rule; the ledger only evaluates Stalwart's default rule", rule };
    } else if (!envDomain || !ledger.cfg.localDomains.includes(envDomain)) {
      checks.dkim = { state: "failed", reason: `the default rule signs local sender domains only; envelope domain is ${envDomain ?? "empty"}` };
    } else {
      signDomain = envDomain;
      const keys = await dir.dkimSigners(signDomain);
      const active = (keys ?? []).filter((k) => k.stage === "active");
      if (keys === null) checks.dkim = { state: "pending", reason: "Stalwart DKIM keys (x:DkimSignature) unreadable", d: signDomain };
      else if (!active.length) checks.dkim = { state: "failed", reason: `no active DKIM key for ${signDomain}`, d: signDomain };
      else checks.dkim = { state: "ok", reason: `signed d=${signDomain} (rule: sender_domain, authenticated); no signing error in the session`, d: signDomain, selectors: active.map((k) => k.selector), evidence: "signer_config" };
    }
  }

  // ── spf (reported) / dmarc (gating) ──────────────────────────────────
  if (envDomain) {
    const txt = await dns.txt(envDomain);
    const spf = (txt ?? []).find((t) => /^v=spf1(\s|$)/i.test(t)) ?? null;
    const aligned = !!fromDomain && orgDomain(envDomain) === orgDomain(fromDomain);
    if (txt === null) checks.spf = { state: "pending", reason: `DNS TXT lookup for ${envDomain} failed`, domain: envDomain };
    else if (!spf) checks.spf = { state: "failed", reason: `${envDomain} publishes no SPF record`, domain: envDomain, aligned };
    else checks.spf = { state: aligned ? "ok" : "failed", reason: aligned ? `SPF policy published for ${envDomain}, aligned with From` : `envelope domain ${envDomain} is not aligned with From ${fromDomain}`, domain: envDomain, record: spf, aligned };
  }
  if (fromDomain) {
    let name = `_dmarc.${fromDomain}`;
    let txt = await dns.txt(name);
    if (txt !== null && !txt.some((t) => /^v=DMARC1/i.test(t)) && orgDomain(fromDomain) !== fromDomain) {
      name = `_dmarc.${orgDomain(fromDomain)}`;
      txt = await dns.txt(name);
    }
    const rec = (txt ?? []).find((t) => /^v=DMARC1/i.test(t)) ?? null;
    if (txt === null) checks.dmarc = { state: "pending", reason: `DNS TXT lookup for ${name} failed` };
    else if (!rec) checks.dmarc = { state: "failed", reason: `${fromDomain} publishes no DMARC record` };
    else {
      const strict = tag(rec, "adkim") === "s";
      const dkimOk = checks.dkim?.state === "ok" && !!signDomain;
      const aligned = dkimOk && (strict ? signDomain === fromDomain : orgDomain(signDomain as string) === orgDomain(fromDomain));
      if (checks.dkim?.state === "pending") checks.dmarc = { state: "pending", reason: "waiting on the DKIM check", record: rec };
      else checks.dmarc = {
        state: aligned ? "ok" : "failed",
        reason: aligned ? `DKIM d=${signDomain} aligned with From ${fromDomain} (adkim=${strict ? "s" : "r"})` : `no aligned DKIM signature for From ${fromDomain}`,
        record: rec, policy: tag(rec, "p"),
      };
    }
  }

  const gating = [checks.from_authorized, checks.dkim, checks.dmarc].filter(Boolean) as Check[];
  const failed = Object.entries(checks).filter(([k, c]) => k !== "spf" && c.state === "failed");
  let state: State;
  let reason: string;
  if (failed.length) { state = "failed"; reason = failed.map(([k, c]) => `${k}: ${c.reason}`).join("; "); }
  else if (gating.length === 3 && gating.every((c) => c.state === "ok")) { state = "ok"; reason = "From authorised, DKIM signed, DMARC aligned"; }
  else { state = "pending"; reason = Object.entries(checks).filter(([k, c]) => k !== "spf" && c.state !== "ok").map(([k, c]) => `${k}: ${c.reason}`).join("; ") || "checks incomplete"; }
  return { state, at, reason, checks };
}
