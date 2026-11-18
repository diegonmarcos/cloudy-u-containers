// Delivery-status ledger (#1802): Stalwart's own submission / queue / delivery /
// DSN records, correlated per message, and the four-stage status built from them.
//
// Sources (all written by Stalwart itself, see user-comm_tools-stalwart build.json#delivery_ledger):
//   MtaHook  stage=data  -> Submission  (queue id <-> Message-ID, header From, SASL login, envelope)
//                           and inbound null-sender DSNs (parsed by dsn.ts)
//   WebHook  events      -> queue.authenticated-message-queued (spanId=submission session, queueId)
//                           delivery.attempt-start (spanId=attempt, queueId, to[])
//                           delivery.delivered / rcpt-to-rejected / rcpt-to-failed / message-rejected /
//                           mail-from-rejected / connect-error (spanId=attempt, hostname, code, details)
//                           delivery.failed (queueId, to, reason) / delivery.completed (spanId=attempt)
//                           smtp.mail-from-unauthorized, dkim.* errors (spanId=submission session)
// Nothing here is inferred from timing or guessed: a stage with no record is
// "pending" with a reason that names the missing record.
//
// Persistence: append-only JSONL (one record per line), replayed at start,
// records older than the retention window dropped on load.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type MtaHookRequest, type StalwartEvent,
  domainOf, firstAddress, header, normMessageId, queueIdHex,
} from "./stalwart-wire.ts";
import { type Dsn, dsnActionState, parseDsn } from "./dsn.ts";

export type State = "ok" | "pending" | "failed";

export interface Submission {
  queueId: string;
  messageId: string | null;
  at: string;
  saslLogin: string | null;
  envelopeFrom: string;
  envelopeTo: string[];
  headerFrom: string | null;
  size: number;
}

interface QueueRec { queueId: string; spanId: string | null; at: string; from: string | null; to: string[]; size: number | null }
interface Attempt { spanId: string; queueId: string; at: string; to: string[] }
interface RcptEvent { rcpt: string; state: State; at: string; reason: string; host: string | null; code: number | null; hop: "relay" | "mx" | "local" | "dsn" | "queue" }
interface SessionError { type: string; at: string; reason: string }
interface DsnRec { at: string; dsn: Dsn }

export interface LedgerConfig {
  path: string | null;          // JSONL file; null = memory only (tests)
  relayHosts: string[];         // next hops that are relays, not the recipient's MX
  localDomains: string[];       // domains Stalwart delivers into its own store
  retentionDays: number;
}

export interface Stage { state: State; at: string | null; reason?: string }

function s(v: unknown): string | null {
  return v === undefined || v === null ? null : String(v);
}
function list(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).toLowerCase());
  return v === undefined || v === null ? [] : [String(v).toLowerCase()];
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function reasonOf(d: Record<string, unknown>): string {
  const parts = [d.code, d.details, d.reason, d.causedBy]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x)));
  return parts.join(" ").trim();
}

export class Ledger {
  readonly cfg: LedgerConfig;
  private submissions = new Map<string, Submission>();      // queueId -> submission
  private byMessageId = new Map<string, string[]>();          // <msgid> -> queueIds (oldest first)
  private queue = new Map<string, QueueRec>();                // queueId -> queued record
  private attempts = new Map<string, Attempt>();              // attempt spanId -> attempt
  private rcptEvents = new Map<string, RcptEvent[]>();        // queueId -> per-recipient events
  private completed = new Map<string, string>();              // queueId -> at
  private sessionErrors = new Map<string, SessionError[]>();  // submission spanId -> errors
  private dsns: DsnRec[] = [];
  private bounces = new Map<string, RcptEvent>();             // rcpt -> last failed event

  constructor(cfg: LedgerConfig) {
    this.cfg = cfg;
    if (cfg.path) this.load(cfg.path);
  }

  // ── persistence ──────────────────────────────────────────────────────
  private load(path: string): void {
    if (!existsSync(path)) return;
    const cutoff = Date.now() - this.cfg.retentionDays * 86400_000;
    const keep: string[] = [];
    let dropped = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try { rec = JSON.parse(line); } catch { dropped++; continue; }
      const at = Date.parse(rec?.at ?? "");
      if (Number.isFinite(at) && at < cutoff) { dropped++; continue; }
      this.apply(rec);
      keep.push(line);
    }
    if (dropped) writeFileSync(path, keep.length ? keep.join("\n") + "\n" : "");
  }

  private persist(rec: Record<string, unknown>): void {
    if (!this.cfg.path) return;
    try {
      mkdirSync(dirname(this.cfg.path), { recursive: true });
      appendFileSync(this.cfg.path, JSON.stringify(rec) + "\n");
    } catch (e) {
      process.stderr.write(`[delivery-ledger] persist failed: ${e}\n`);
    }
  }

  private apply(rec: any): void {
    if (rec?.k === "ev") this.applyEvent(rec.e as StalwartEvent);
    else if (rec?.k === "sub") this.applySubmission(rec.s as Submission);
    else if (rec?.k === "dsn") this.applyDsn(rec.at, rec.d as Dsn);
  }

  // ── ingest ───────────────────────────────────────────────────────────
  ingestEvents(events: StalwartEvent[]): number {
    let n = 0;
    for (const e of events) {
      if (this.applyEvent(e)) { this.persist({ k: "ev", at: e.at, e }); n++; }
    }
    return n;
  }

  /** One MtaHook call. Returns what it was recorded as. */
  ingestHook(h: MtaHookRequest, at: string = new Date().toISOString()): "submission" | "dsn" | "ignored" {
    if (h.saslLogin && h.queueId) {
      const sub: Submission = {
        queueId: h.queueId,
        messageId: normMessageId(header(h.headers, "Message-ID")),
        at,
        saslLogin: h.saslLogin,
        envelopeFrom: h.envelopeFrom,
        envelopeTo: h.envelopeTo,
        headerFrom: firstAddress(header(h.headers, "From")),
        size: h.size,
      };
      this.applySubmission(sub);
      this.persist({ k: "sub", at, s: sub });
      return "submission";
    }
    if (!h.envelopeFrom) {
      const dsn = parseDsn(h.headers, h.body);
      if (dsn && dsn.recipients.length) {
        this.applyDsn(at, dsn);
        this.persist({ k: "dsn", at, d: dsn });
        return "dsn";
      }
    }
    return "ignored";
  }

  private applySubmission(sub: Submission): void {
    this.submissions.set(sub.queueId, sub);
    if (sub.messageId) {
      const ids = this.byMessageId.get(sub.messageId) ?? [];
      if (!ids.includes(sub.queueId)) ids.push(sub.queueId);
      this.byMessageId.set(sub.messageId, ids);
    }
  }

  private applyDsn(at: string, dsn: Dsn): void {
    this.dsns.push({ at, dsn });
    for (const r of dsn.recipients) {
      const st = dsnActionState(r.action);
      if (st === "failed") {
        this.bounces.set(r.rcpt, {
          rcpt: r.rcpt, state: "failed", at, host: r.remoteMta ?? dsn.reportingMta, code: null, hop: "dsn",
          reason: `DSN ${r.action}${r.status ? " " + r.status : ""}${r.diagnostic ? ": " + r.diagnostic : ""}`,
        });
      }
    }
  }

  private pushRcpt(queueId: string, ev: RcptEvent): void {
    const arr = this.rcptEvents.get(queueId) ?? [];
    arr.push(ev);
    this.rcptEvents.set(queueId, arr);
    if (ev.state === "failed") this.bounces.set(ev.rcpt, ev);
  }

  private hopFor(host: string | null): "relay" | "mx" {
    if (!host) return "mx";
    const h = host.toLowerCase();
    return this.cfg.relayHosts.some((r) => r.toLowerCase() === h) ? "relay" : "mx";
  }

  /** Apply one Stalwart telemetry event. Returns false for events the ledger does not use. */
  private applyEvent(e: StalwartEvent): boolean {
    const d = e.data ?? {};
    const span = s(d.spanId);
    switch (e.type) {
      case "queue.authenticated-message-queued": {
        const q = queueIdHex(d.queueId);
        if (!q) return false;
        this.queue.set(q, { queueId: q, spanId: span, at: e.at, from: s(d.from)?.toLowerCase() ?? null, to: list(d.to), size: num(d.size) });
        return true;
      }
      case "smtp.mail-from-unauthorized":
      case "smtp.mail-from-not-allowed":
      case "queue.quota-exceeded":
      case "dkim.signer-not-found":
      case "dkim.unsupported-algorithm":
      case "dkim.unsupported-key-type": {
        if (!span) return false;
        const arr = this.sessionErrors.get(span) ?? [];
        arr.push({ type: e.type, at: e.at, reason: reasonOf(d) });
        this.sessionErrors.set(span, arr);
        return true;
      }
      case "delivery.attempt-start": {
        const q = queueIdHex(d.queueId);
        if (!q || !span) return false;
        this.attempts.set(span, { spanId: span, queueId: q, at: e.at, to: list(d.to) });
        return true;
      }
      case "delivery.delivered":
      case "delivery.rcpt-to-rejected":
      case "delivery.rcpt-to-failed": {
        const a = span ? this.attempts.get(span) : undefined;
        const rcpt = s(d.to)?.toLowerCase();
        if (!a || !rcpt) return false;
        const host = s(d.hostname);
        const code = num(d.code);
        const hop = this.hopFor(host);
        let state: State;
        let reason: string;
        if (e.type === "delivery.delivered") {
          state = hop === "relay" ? "pending" : "ok";
          reason = hop === "relay"
            ? `accepted by relay ${host} (${reasonOf(d)}); the recipient MX's answer is not visible to the server, only a later DSN can settle it`
            : `accepted by ${host} (${reasonOf(d)})`;
        } else if (e.type === "delivery.rcpt-to-rejected") {
          state = code !== null && code >= 500 ? "failed" : "pending";
          reason = `${state === "failed" ? "rejected" : "deferred"} by ${host}: ${reasonOf(d)}`;
        } else {
          state = "pending";
          reason = `RCPT TO to ${host} did not complete, will retry: ${reasonOf(d)}`;
        }
        this.pushRcpt(a.queueId, { rcpt, state, at: e.at, reason, host, code, hop });
        return true;
      }
      case "delivery.message-rejected":
      case "delivery.mail-from-rejected":
      case "delivery.connect-error": {
        const a = span ? this.attempts.get(span) : undefined;
        if (!a) return false;
        const host = s(d.hostname);
        const code = num(d.code);
        const perm = e.type !== "delivery.connect-error" && code !== null && code >= 500;
        for (const rcpt of a.to) {
          this.pushRcpt(a.queueId, {
            rcpt, state: perm ? "failed" : "pending", at: e.at, host, code, hop: this.hopFor(host),
            reason: `${e.type.replace("delivery.", "")} at ${host ?? "next hop"}${perm ? "" : " (will retry)"}: ${reasonOf(d)}`,
          });
        }
        return true;
      }
      case "delivery.failed": {
        const q = queueIdHex(d.queueId);
        const rcpt = s(d.to)?.toLowerCase();
        if (!q || !rcpt) return false;
        this.pushRcpt(q, { rcpt, state: "failed", at: e.at, host: null, code: null, hop: "queue", reason: `Stalwart gave up: ${reasonOf(d)}` });
        return true;
      }
      case "delivery.completed": {
        const a = span ? this.attempts.get(span) : undefined;
        if (!a) return false;
        this.completed.set(a.queueId, e.at);
        return true;
      }
      default:
        return false;
    }
  }

  // ── lookup ───────────────────────────────────────────────────────────
  /** Resolve a client id (Message-ID in any form, or a Stalwart hex queue id) to queue ids. */
  resolve(id: string): { messageId: string | null; queueIds: string[] } {
    const raw = decodeURIComponent(String(id ?? "").trim());
    if (/^[0-9a-f]{6,20}$/i.test(raw) && !raw.includes("@")) {
      const q = raw.toLowerCase();
      if (this.queue.has(q) || this.submissions.has(q)) {
        return { messageId: this.submissions.get(q)?.messageId ?? null, queueIds: [q] };
      }
    }
    const mid = normMessageId(raw);
    if (mid && this.byMessageId.has(mid)) return { messageId: mid, queueIds: [...(this.byMessageId.get(mid) as string[])] };
    return { messageId: mid, queueIds: [] };
  }

  counters(): Record<string, number> {
    return {
      submissions: this.submissions.size, queued: this.queue.size, attempts: this.attempts.size,
      completed: this.completed.size, dsns: this.dsns.length, bounced_addresses: this.bounces.size,
    };
  }

  submission(q: string): Submission | undefined { return this.submissions.get(q); }
  queued(q: string): QueueRec | undefined { return this.queue.get(q); }
  errorsForSpan(span: string | null): SessionError[] { return span ? this.sessionErrors.get(span) ?? [] : []; }

  /** Last permanent failure recorded for an address (Stalwart delivery result or DSN). */
  lastBounce(rcpt: string): { at: string; reason: string } | null {
    const b = this.bounces.get(rcpt.toLowerCase());
    return b ? { at: b.at, reason: b.reason } : null;
  }

  isLocal(addr: string): boolean {
    const d = domainOf(addr);
    return !!d && this.cfg.localDomains.includes(d);
  }

  // ── stages ───────────────────────────────────────────────────────────
  submittedStage(q: string): Stage {
    const sub = this.submissions.get(q);
    if (sub) return { state: "ok", at: sub.at, reason: `DATA handed to Stalwart by ${sub.saslLogin} (MTA hook, stage data)` };
    const qr = this.queue.get(q);
    if (qr) return { state: "ok", at: qr.at, reason: "implied by the queue record (no MTA-hook record for this message)" };
    return { state: "pending", at: null, reason: "no submission record" };
  }

  receivedStage(q: string): Stage & { queueId?: string } {
    const qr = this.queue.get(q);
    if (qr) return { state: "ok", at: qr.at, queueId: q, reason: `250 2.0.0 Message queued with id ${q}` };
    const sub = this.submissions.get(q);
    return {
      state: "pending",
      at: null,
      reason: sub
        ? "submission seen at DATA but no queue record yet (Stalwart had not answered 250, or the event is still in flight)"
        : "no queue record",
    };
  }

  recipients(q: string): Array<{ rcpt: string; state: State; at: string | null; reason: string; hop?: string; host?: string | null }> {
    const qr = this.queue.get(q);
    const sub = this.submissions.get(q);
    const rcpts = [...new Set([...(qr?.to ?? []), ...(sub?.envelopeTo ?? [])])];
    const evs = (this.rcptEvents.get(q) ?? []).slice().sort((a, b) => a.at.localeCompare(b.at));
    const msgId = sub?.messageId ?? null;
    const dsnEvs: RcptEvent[] = [];
    if (msgId) {
      for (const { at, dsn } of this.dsns) {
        if (dsn.originalMessageId !== msgId) continue;
        for (const r of dsn.recipients) {
          dsnEvs.push({
            rcpt: r.rcpt, state: dsnActionState(r.action), at, host: r.remoteMta ?? dsn.reportingMta, code: null, hop: "dsn",
            reason: `DSN from ${dsn.reportingMta ?? "remote MTA"}: ${r.action}${r.status ? " " + r.status : ""}${r.diagnostic ? " — " + r.diagnostic : ""}`,
          });
        }
      }
    }
    const done = this.completed.get(q);
    const attempted = [...this.attempts.values()].some((a) => a.queueId === q);
    return rcpts.map((rcpt) => {
      const mine = [...evs, ...dsnEvs].filter((e) => e.rcpt === rcpt).sort((a, b) => a.at.localeCompare(b.at));
      // A recipient that already failed stays failed; otherwise the latest record wins.
      const failed = mine.find((e) => e.state === "failed");
      const last = failed ?? mine[mine.length - 1];
      if (last) return { rcpt, state: last.state, at: last.at, reason: last.reason, hop: last.hop, host: last.host };
      if (done && this.isLocal(rcpt)) {
        return { rcpt, state: "ok" as State, at: done, reason: "delivered into the local store (route local); message completed in the queue", hop: "local", host: null };
      }
      if (done) return { rcpt, state: "pending" as State, at: done, reason: "message left the queue without a per-recipient record for this address" };
      return { rcpt, state: "pending" as State, at: null, reason: attempted ? "delivery attempt in progress" : qr ? "queued, not yet attempted" : "no queue record" };
    });
  }

  deliveredStage(q: string): Stage & { recipients: ReturnType<Ledger["recipients"]> } {
    const recipients = this.recipients(q);
    if (!recipients.length) return { state: "pending", at: null, reason: "no recipients recorded", recipients };
    const failed = recipients.filter((r) => r.state === "failed");
    const ok = recipients.filter((r) => r.state === "ok");
    const at = recipients.map((r) => r.at).filter(Boolean).sort().pop() ?? null;
    if (failed.length) return { state: "failed", at, reason: `${failed.length}/${recipients.length} recipient(s) failed`, recipients };
    if (ok.length === recipients.length) return { state: "ok", at, reason: "every recipient accepted by its final hop", recipients };
    return { state: "pending", at, reason: `${ok.length}/${recipients.length} recipient(s) confirmed`, recipients };
  }

  /** Delivery-side context sender_valid needs. */
  senderContext(q: string): { sub?: Submission; queue?: QueueRec; errors: SessionError[] } {
    const qr = this.queue.get(q);
    return { sub: this.submissions.get(q), queue: qr, errors: this.errorsForSpan(qr?.spanId ?? null) };
  }
}
