// The field shapes the Android clients bind (cloudy-u-android 3794ec7f for #1802,
// 9561a289 for #1803), derived from the ledger / checker results. Pure mapping, no
// new facts: a field whose underlying record does not exist yet is null.

import type { CheckResult } from "./recipients.ts";

type Tri = boolean | null;
const tri = (state: string | undefined): Tri => (state === "ok" ? true : state === "failed" ? false : null);

export interface SentView {
  submission: { accepted: Tri; at: string | null; smtp_code: number | null; message_id: string | null; text: string };
  sender: { may_use_from: Tri; dkim_signed: Tri; dkim_selector: string | null; spf_aligned: Tri; dmarc_aligned: Tri; at: string | null; text: string };
  recipients: Array<{ address: string; state: "pending" | "delivered" | "deferred" | "bounced"; at: string | null; smtp_code: number | null; remote_mx: string | null; detail: string }>;
}

export function sentView(status: any): SentView {
  const st = status?.stages ?? {};
  const rec = st.received ?? {};
  const sv = st.sender_valid ?? {};
  const c = sv.checks ?? {};
  const spf = c.spf;
  return {
    submission: {
      accepted: tri(rec.state),
      at: rec.at ?? null,
      smtp_code: rec.state === "ok" ? 250 : null,
      message_id: status?.messageId ?? null,
      text: rec.reason ?? "",
    },
    sender: {
      may_use_from: tri(c.from_authorized?.state),
      dkim_signed: tri(c.dkim?.state),
      dkim_selector: c.dkim?.state === "ok" && Array.isArray(c.dkim.selectors) ? (c.dkim.selectors[0] ?? null) : null,
      spf_aligned: spf && spf.state !== "pending" && typeof spf.aligned === "boolean" ? spf.aligned && spf.state === "ok" : null,
      dmarc_aligned: tri(c.dmarc?.state),
      at: sv.at ?? null,
      text: sv.reason ?? "",
    },
    recipients: (st.delivered?.recipients ?? []).map((r: any) => ({
      address: r.rcpt,
      state: r.state === "ok" ? "delivered" : r.state === "failed" ? "bounced" : r.deferral ? "deferred" : "pending",
      at: r.at ?? null,
      smtp_code: typeof r.code === "number" ? r.code : null,
      remote_mx: r.host ?? null,
      detail: r.reason ?? "",
    })),
  };
}

export type ClientVerdict = "ok" | "risky" | "will_fail" | "unknown";
export interface ClientCheck { check: "syntax" | "domain" | "mailbox" | "past_bounce" | "disposable_role" | "size_limit"; outcome: "pass" | "warn" | "fail" | "unknown"; detail?: string; accepts_all?: boolean }

/** #1803 client shape. `sizeBytes` is the request's message_size_bytes (null when not sent). */
export function checkView(r: CheckResult, sizeBytes: number | null): { address: string; verdict: ClientVerdict; reason: string; checks: ClientCheck[] } {
  const k = r.checks;
  const out: ClientCheck[] = [];
  out.push({ check: "syntax", outcome: k.syntax.state === "ok" ? "pass" : "fail", ...(k.syntax.reason ? { detail: k.syntax.reason } : {}) });
  out.push({
    check: "domain",
    outcome: k.domain_mx.state === "ok" ? "pass" : k.domain_mx.state === "fail" ? "fail" : "unknown",
    detail: k.domain_mx.reason ?? (k.domain_mx.hosts.length ? `MX: ${k.domain_mx.hosts.join(", ")}` : undefined),
  });
  const mb = k.mailbox.state;
  out.push({
    check: "mailbox",
    outcome: mb === "exists" ? "pass" : mb === "does_not_exist" ? "fail" : mb === "accepts_all" ? "warn" : "unknown",
    detail: k.mailbox.reason,
    ...(mb === "accepts_all" ? { accepts_all: true } : {}),
  });
  out.push(k.past_bounce.state === "bounced"
    ? { check: "past_bounce", outcome: "warn", detail: `${k.past_bounce.at}: ${k.past_bounce.reason}` }
    : { check: "past_bounce", outcome: "pass" });
  const hints = [k.disposable ? "disposable domain" : null, k.role ? "role address" : null].filter(Boolean) as string[];
  out.push(hints.length ? { check: "disposable_role", outcome: "warn", detail: hints.join(", ") } : { check: "disposable_role", outcome: "pass" });
  const lim = k.size_limit.bytes;
  let sizeOutcome: ClientCheck["outcome"] = "unknown";
  let sizeDetail = k.size_limit.reason ?? "";
  if (lim !== null && lim > 0) {
    sizeDetail = `server limit ${lim} bytes (EHLO SIZE at ${k.size_limit.host})`;
    sizeOutcome = sizeBytes === null ? "pass" : sizeBytes <= lim ? "pass" : "fail";
    if (sizeBytes !== null && sizeBytes > lim) sizeDetail = `message ${sizeBytes} bytes exceeds the server limit of ${lim} bytes`;
  } else if (lim === 0) {
    sizeOutcome = "pass";
    sizeDetail = "server advertises SIZE without a limit";
  }
  out.push({ check: "size_limit", outcome: sizeOutcome, ...(sizeDetail ? { detail: sizeDetail } : {}) });

  let verdict: ClientVerdict = r.verdict === "fail" ? "will_fail" : r.verdict;
  let reason = r.reason;
  if (sizeOutcome === "fail") { verdict = "will_fail"; reason = sizeDetail; }
  return { address: r.address, verdict, reason, checks: out };
}
