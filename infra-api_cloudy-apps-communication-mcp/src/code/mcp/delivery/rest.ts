// REST surface of the fleet mail API for #1802 / #1803. Mounted by http.ts in
// front of the MCP transport; the contract is DELIVERY-API.md next to build.json.
//
//   GET  /v1/sent/{messageId}/status        one message (Message-ID, any form, or Stalwart hex queue id)
//   POST /v1/sent/status        {ids:[..]}  batch, max 100
//   POST /v1/recipients/check   {addresses:[..]}
//   GET  /v1/delivery/health                ledger counters (no message data)
//   POST /v1/internal/stalwart/events       Stalwart WebHook   (oci-mail WG source only)
//   POST /v1/internal/stalwart/mta-hook     Stalwart MtaHook   (oci-mail WG source only)
//
// Auth follows the service: it is WG-mesh-only (Caddy wg_only + the listener bound
// to the oci-apps WG address); there is no bearer. Errors: {"error": "<text>", "code": "<slug>"}.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Ledger } from "./ledger.ts";
import { senderValid, type Directory, type TxtResolver } from "./sender-valid.ts";
import type { RecipientChecker } from "./recipients.ts";
import { parseMtaHookBody, parseWebhookBody } from "./stalwart-wire.ts";
import { checkView, sentView } from "./client-view.ts";

export interface RestDeps {
  ledger: Ledger;
  directory: Directory;
  txt: TxtResolver;
  checker: RecipientChecker;
  /** Source addresses allowed on /v1/internal/* (oci-mail's WG IPs). */
  ingestAllowed: string[];
  maxBatchIds?: number;
}

const JSON_LIMIT = 1 << 20;            // 1 MiB for client requests and webhook batches
const HOOK_LIMIT = 80 * (1 << 20);     // MtaHook carries the whole message (Stalwart caps uploads at 50 MB)

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra });
  res.end(s);
}
function fail(res: ServerResponse, status: number, code: string, error: string, extra: Record<string, string> = {}): void {
  send(res, status, { error, code }, extra);
}

class TooLarge extends Error {}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) { reject(new TooLarge(`body over ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sourceIp(req: IncomingMessage): string {
  return String(req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}
/** Rate-limit key: the first X-Forwarded-For hop Caddy sets, else the socket peer. */
export function callerId(req: IncomingMessage): string {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return xff || sourceIp(req);
}

/** SASL login "user" or "user@domain" vs the client's account address. */
export function accountMatches(login: string | null | undefined, account: string): boolean {
  if (!login) return false;
  const l = login.toLowerCase(), a = account.toLowerCase();
  return l === a || (!l.includes("@") && a.split("@")[0] === l);
}

export async function statusFor(deps: RestDeps, id: string, account: string | null = null): Promise<Record<string, unknown>> {
  const { ledger } = deps;
  const resolved = ledger.resolve(id);
  const { messageId } = resolved;
  // Keyed by account + Message-ID: with an account, only that account's submissions count.
  const queueIds = account ? resolved.queueIds.filter((q) => accountMatches(ledger.submission(q)?.saslLogin, account)) : resolved.queueIds;
  if (!queueIds.length) return { id, account, messageId, found: false, reason: "no Stalwart record for this id (unknown Message-ID / queue id, another account's message, or older than the retention window)", submission: null, sender: null, recipients: null };
  const q = queueIds[queueIds.length - 1];
  const sv = await senderValid(ledger, q, deps.directory, deps.txt);
  const delivered = ledger.deliveredStage(q);
  const status = {
    id,
    found: true,
    account: account ?? ledger.submission(q)?.saslLogin ?? null,
    messageId: ledger.submission(q)?.messageId ?? messageId,
    queueId: q,
    ...(queueIds.length > 1 ? { queueIds } : {}),
    stages: {
      submitted: ledger.submittedStage(q),
      received: ledger.receivedStage(q),
      sender_valid: sv,
      delivered,
    },
  };
  // Client fields (submission / sender / recipients) next to the stage detail they come from.
  return { ...status, ...sentView(status) };
}

/** Map with bounded concurrency (probes are real TCP sessions; keep them few). */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

/** Returns true when the request was a /v1 route (handled here), false to fall through to MCP. */
export async function handleRest(req: IncomingMessage, res: ServerResponse, deps: RestDeps): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://local");
  const p = url.pathname.replace(/\/+$/, "");
  if (!p.startsWith("/v1/")) return false;
  const m = req.method ?? "GET";
  try {
    // ── ingest (Stalwart -> ledger) ──
    if (p.startsWith("/v1/internal/stalwart/")) {
      if (m !== "POST") { fail(res, 405, "method_not_allowed", "POST only"); return true; }
      if (!deps.ingestAllowed.includes(sourceIp(req))) { fail(res, 403, "forbidden", "ingest accepts the mail server's WG addresses only"); return true; }
      if (p === "/v1/internal/stalwart/events") {
        const events = parseWebhookBody(await readBody(req, JSON_LIMIT));
        const used = deps.ledger.ingestEvents(events);
        send(res, 200, { received: events.length, recorded: used });
        return true;
      }
      if (p === "/v1/internal/stalwart/mta-hook") {
        const raw = await readBody(req, HOOK_LIMIT);
        // Answer accept first: the hook is synchronous in Stalwart's DATA path and
        // the ledger must never add latency or a reject to real mail.
        send(res, 200, { action: "accept" });
        setImmediate(() => {
          try { deps.ledger.ingestHook(parseMtaHookBody(raw)); }
          catch (e) { process.stderr.write(`[delivery] mta-hook parse failed: ${(e as Error).message}\n`); }
        });
        return true;
      }
      fail(res, 404, "not_found", `no route ${p}`);
      return true;
    }

    if (m === "GET" && p === "/v1/delivery/health") {
      send(res, 200, { status: "ok", ledger: deps.ledger.counters() });
      return true;
    }

    // ── #1802 ──
    const one = p.match(/^\/v1\/sent\/(.+)\/status$/);
    if (one && m === "GET") {
      const body = await statusFor(deps, one[1], url.searchParams.get("account"));
      if (!body.found) { send(res, 404, { error: body.reason, code: "not_found", id: body.id, messageId: body.messageId }); return true; }
      send(res, 200, body);
      return true;
    }
    if (p === "/v1/sent/status") {
      if (m !== "POST") { fail(res, 405, "method_not_allowed", "POST only"); return true; }
      const j = JSON.parse(await readBody(req, JSON_LIMIT) || "{}");
      const ids = j?.ids;
      const max = deps.maxBatchIds ?? 100;
      if (!Array.isArray(ids) || !ids.length || ids.some((x: unknown) => typeof x !== "string" || !x)) { fail(res, 400, "invalid_request", "body must be {\"ids\": [\"<message-id or queue id>\", ...]}"); return true; }
      if (ids.length > max) { fail(res, 400, "too_many_ids", `at most ${max} ids per request`); return true; }
      const account = typeof j?.account === "string" && j.account ? j.account : null;
      const results = await Promise.all([...new Set(ids as string[])].map((id) => statusFor(deps, id, account)));
      send(res, 200, { results });
      return true;
    }

    // ── #1803 ──
    if (p === "/v1/recipients/check") {
      if (m !== "POST") { fail(res, 405, "method_not_allowed", "POST only"); return true; }
      const j = JSON.parse(await readBody(req, JSON_LIMIT) || "{}");
      const addrs = j?.addresses;
      const max = deps.checker.cfg.maxAddressesPerRequest;
      if (!Array.isArray(addrs) || !addrs.length || addrs.some((x: unknown) => typeof x !== "string")) { fail(res, 400, "invalid_request", "body must be {\"addresses\": [\"user@example.org\", ...]}"); return true; }
      if (addrs.length > max) { fail(res, 400, "too_many_addresses", `at most ${max} addresses per request`); return true; }
      const uniq = [...new Set((addrs as string[]).map((a) => a.trim()))];
      const wait = deps.checker.limiter.take(callerId(req), uniq.length);
      if (wait > 0) { fail(res, 429, "rate_limited", `rate limit: ${deps.checker.cfg.rateLimit.addresses} addresses per ${Math.round(deps.checker.cfg.rateLimit.perMs / 1000)}s per caller`, { "Retry-After": String(Math.ceil(wait / 1000)) }); return true; }
      const size = j?.message_size_bytes;
      if (size !== undefined && size !== null && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) { fail(res, 400, "invalid_request", "message_size_bytes must be a non-negative number"); return true; }
      const raw = await pool(uniq, 4, (a) => deps.checker.check(a));
      // `checks` is the client's list form; the full per-check record stays in `check_details`.
      const results = raw.map((r) => ({ ...checkView(r, typeof size === "number" ? size : null), check_details: r.checks, cached: r.cached, checked_at: r.checked_at }));
      send(res, 200, { results });
      return true;
    }

    fail(res, 404, "not_found", `no route ${m} ${p}`);
    return true;
  } catch (e) {
    if (e instanceof TooLarge) { if (!res.headersSent) fail(res, 413, "too_large", e.message); return true; }
    if (e instanceof SyntaxError) { if (!res.headersSent) fail(res, 400, "invalid_json", e.message); return true; }
    process.stderr.write(`[delivery] ${m} ${p} failed: ${(e as Error).stack ?? e}\n`);
    if (!res.headersSent) fail(res, 500, "internal", "internal error");
    return true;
  }
}
