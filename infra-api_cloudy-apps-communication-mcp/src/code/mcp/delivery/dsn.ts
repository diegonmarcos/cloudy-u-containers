// RFC 3464 delivery status notification parser (#1802).
//
// Input: the MtaHook view of an inbound message — the header list and the raw
// body (everything after the header block). A DSN is
//   Content-Type: multipart/report; report-type=delivery-status; boundary=...
// with a message/delivery-status part (per-message fields, blank line, then one
// block per recipient) and usually a text/rfc822-headers or message/rfc822 part
// carrying the ORIGINAL headers, which is where the original Message-ID is read
// from. Nothing is inferred from free text: a message that is not a
// multipart/report with a delivery-status part yields null.

import { header, normMessageId, unfold } from "./stalwart-wire.ts";

export interface DsnRecipient {
  rcpt: string;
  action: string;            // failed | delayed | delivered | relayed | expanded
  status: string | null;     // e.g. 5.1.1
  diagnostic: string | null; // Diagnostic-Code value
  remoteMta: string | null;
  lastAttempt: string | null;
}

export interface Dsn {
  originalMessageId: string | null;
  originalEnvelopeId: string | null;
  reportingMta: string | null;
  recipients: DsnRecipient[];
}

function param(ct: string, name: string): string | null {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i");
  const m = ct.match(re);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

function splitHeadersBody(part: string): { headers: Array<[string, string]>; body: string } {
  const idx = part.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? part.slice(0, idx) : part;
  const body = idx >= 0 ? part.slice(idx).replace(/^\r?\n\r?\n/, "") : "";
  return { headers: parseHeaderBlock(head), body };
}

export function parseHeaderBlock(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length) { out[out.length - 1][1] += "\n" + line; continue; }
    const i = line.indexOf(":");
    if (i > 0) out.push([line.slice(0, i).trim(), line.slice(i + 1)]);
  }
  return out.map(([k, v]) => [k, unfold(v)]);
}

function fields(block: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of parseHeaderBlock(block)) m.set(k.toLowerCase(), v);
  return m;
}

/** "rfc822; a@b" -> "a@b" */
function typed(v: string | undefined): string | null {
  if (!v) return null;
  const i = v.indexOf(";");
  return (i >= 0 ? v.slice(i + 1) : v).trim().replace(/^<|>$/g, "").toLowerCase() || null;
}

function decodeTransfer(body: string, cte: string | null): string {
  if (cte && cte.toLowerCase().trim() === "base64") {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; }
  }
  if (cte && cte.toLowerCase().trim() === "quoted-printable") {
    return body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

export function parseDsn(headers: Array<[string, string]>, body: string): Dsn | null {
  const ct = header(headers, "Content-Type") ?? "";
  if (!/^\s*multipart\/report/i.test(ct)) return null;
  const rt = param(ct, "report-type");
  if (rt && rt.toLowerCase() !== "delivery-status") return null;
  const boundary = param(ct, "boundary");
  if (!boundary) return null;

  const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?[ \\t]*\\r?\\n?`));
  let statusPart: string | null = null;
  let original: Array<[string, string]> | null = null;
  for (const raw of parts) {
    if (!raw.trim()) continue;
    const { headers: ph, body: pb } = splitHeadersBody(raw);
    const pct = (header(ph, "Content-Type") ?? "text/plain").toLowerCase();
    const decoded = decodeTransfer(pb, header(ph, "Content-Transfer-Encoding"));
    if (pct.startsWith("message/delivery-status") || pct.startsWith("message/global-delivery-status")) statusPart = decoded;
    else if (pct.startsWith("text/rfc822-headers") || pct.startsWith("message/rfc822") || pct.startsWith("message/global-headers")) {
      original = splitHeadersBody(decoded).headers;
    }
  }
  if (statusPart === null) return null;

  const blocks = statusPart.replace(/\r\n/g, "\n").split(/\n[ \t]*\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return null;
  const perMsg = fields(blocks[0]);
  const recipients: DsnRecipient[] = [];
  for (const b of blocks.slice(perMsg.has("final-recipient") ? 0 : 1)) {
    const f = fields(b);
    const rcpt = typed(f.get("final-recipient")) ?? typed(f.get("original-recipient"));
    const action = (f.get("action") ?? "").toLowerCase().trim();
    if (!rcpt || !action) continue;
    recipients.push({
      rcpt,
      action,
      status: f.get("status")?.trim() ?? null,
      diagnostic: f.has("diagnostic-code") ? (f.get("diagnostic-code") as string).replace(/^[^;]*;\s*/, "").trim() || null : null,
      remoteMta: typed(f.get("remote-mta")),
      lastAttempt: f.get("last-attempt-date") ?? null,
    });
  }
  return {
    originalMessageId: original ? normMessageId(header(original, "Message-ID")) : null,
    originalEnvelopeId: perMsg.get("original-envelope-id")?.trim() ?? null,
    reportingMta: typed(perMsg.get("reporting-mta")),
    recipients,
  };
}

/**
 * DSN Action -> ledger state (RFC 3464 §2.3.3). failed => failed; delayed => pending;
 * delivered / expanded => ok; relayed (handed to a system that does not return DSNs,
 * so the final result is unknowable) => pending.
 */
export function dsnActionState(action: string): "ok" | "pending" | "failed" {
  if (action === "failed") return "failed";
  if (action === "delivered" || action === "expanded") return "ok";
  return "pending";
}
