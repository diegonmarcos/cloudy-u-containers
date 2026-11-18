// Stalwart v0.16.5 wire formats the delivery ledger consumes (#1802).
//
// 1. WebHook (telemetry subscriber) body, crates/common/src/telemetry/webhooks:
//      {"events":[{"id":"<ts><typeId>","createdAt":"<rfc3339>","type":"delivery.delivered",
//                  "data":{"spanId":<u64>,"queueId":<u64>,"to":"a@b","code":250,...}}]}
//    Keys are trc::Key::as_str() (camelCase). spanId / queueId are u64 and routinely
//    exceed 2^53, so JSON.parse would silently round them: every bare integer that
//    follows one of those keys is quoted BEFORE parsing. The queue id is then
//    re-expressed in lowercase hex, which is the form Stalwart itself prints
//    ("250 2.0.0 Message queued with id <hex>.", MtaHook context.queue.id).
//
// 2. MtaHook request, crates/smtp/src/inbound/hooks/mod.rs:
//      {"context":{"stage":"data","sasl":{"login":".."},"queue":{"id":"<hex>"},"client":{..}},
//       "envelope":{"from":{"address":".."},"to":[{"address":".."}]},
//       "message":{"headers":[["From"," a@b"],...],"contents":"<body>","size":N}}
//    The expected answer is {"action":"accept"}.
//
// Pure module: node builtins only, so `node --test` runs it without npm install.

export interface StalwartEvent {
  id: string;
  at: string;          // RFC 3339
  type: string;        // e.g. "delivery.delivered"
  data: Record<string, unknown>;
}

const BIGINT_KEYS = ["spanId", "queueId"];

/** Quote the u64 values of spanId/queueId so JSON.parse keeps every digit. */
export function quoteBigInts(raw: string): string {
  const re = new RegExp(`"(${BIGINT_KEYS.join("|")})"\\s*:\\s*(-?\\d+)`, "g");
  return raw.replace(re, (_m, k, v) => `"${k}":"${v}"`);
}

/** Decimal (as delivered in webhook JSON) or hex (as printed by Stalwart) -> lowercase hex. */
export function queueIdHex(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return BigInt(s).toString(16);
  if (/^(0x)?[0-9a-f]+$/.test(s)) return s.replace(/^0x/, "");
  return null;
}

export function parseWebhookBody(raw: string): StalwartEvent[] {
  const parsed = JSON.parse(quoteBigInts(raw)) as { events?: unknown };
  const list = Array.isArray(parsed?.events) ? parsed.events : [];
  const out: StalwartEvent[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    if (!e || typeof e.type !== "string") continue;
    out.push({
      id: String(e.id ?? ""),
      at: typeof e.createdAt === "string" ? e.createdAt : new Date().toISOString(),
      type: e.type,
      data: (e.data && typeof e.data === "object" ? e.data : {}) as Record<string, unknown>,
    });
  }
  return out;
}

export interface MtaHookRequest {
  stage: string;
  queueId: string | null;
  saslLogin: string | null;
  envelopeFrom: string;          // "" for the null sender <>
  envelopeTo: string[];
  headers: Array<[string, string]>;
  body: string;
  size: number;
}

export function parseMtaHookBody(raw: string): MtaHookRequest {
  const r = JSON.parse(raw) as any;
  const ctx = r?.context ?? {};
  const headers: Array<[string, string]> = Array.isArray(r?.message?.headers)
    ? r.message.headers.filter((h: unknown) => Array.isArray(h) && h.length >= 2).map((h: unknown[]) => [String(h[0]), String(h[1])])
    : [];
  return {
    stage: String(ctx.stage ?? ""),
    queueId: queueIdHex(ctx.queue?.id),
    saslLogin: ctx.sasl?.login ? String(ctx.sasl.login) : null,
    envelopeFrom: String(r?.envelope?.from?.address ?? "").toLowerCase(),
    envelopeTo: Array.isArray(r?.envelope?.to) ? r.envelope.to.map((t: any) => String(t?.address ?? "").toLowerCase()).filter(Boolean) : [],
    headers,
    body: typeof r?.message?.contents === "string" ? r.message.contents : "",
    size: Number(r?.message?.size ?? 0) || 0,
  };
}

export function header(headers: Array<[string, string]>, name: string): string | null {
  const n = name.toLowerCase();
  for (const [k, v] of headers) if (k.trim().toLowerCase() === n) return unfold(v);
  return null;
}

export function unfold(v: string): string {
  return v.replace(/\r?\n[ \t]+/g, " ").trim();
}

/** Normalise a Message-ID (bracketed, URL-encoded or bare) to "<id@host>". Case is kept: the left part is case-sensitive. */
export function normMessageId(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = String(v).trim();
  try { if (/%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s); } catch { /* keep raw */ }
  const m = s.match(/<([^<>\s]+)>/);
  const core = m ? m[1] : s.replace(/^<|>$/g, "");
  if (!core || /\s/.test(core)) return null;
  return `<${core}>`;
}

/** First addr-spec in a header value: `"Name" <a@b>` / `a@b (c)` -> "a@b" (lowercased). */
export function firstAddress(v: string | null): string | null {
  if (!v) return null;
  const angle = v.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (angle) return angle[1].toLowerCase();
  const bare = v.match(/([^\s<>(),;:"]+@[^\s<>(),;:"]+)/);
  return bare ? bare[1].toLowerCase() : null;
}

export function domainOf(addr: string | null): string | null {
  if (!addr) return null;
  const i = addr.lastIndexOf("@");
  return i > 0 ? addr.slice(i + 1).toLowerCase() : null;
}

/** "user+tag@example.org" -> "user@example.org" (sub-address tag stripped). */
export function baseAddress(addr: string | null): string | null {
  if (!addr) return null;
  const i = addr.lastIndexOf("@");
  if (i <= 0) return addr.toLowerCase();
  return (addr.slice(0, i).split("+")[0] + addr.slice(i)).toLowerCase();
}
