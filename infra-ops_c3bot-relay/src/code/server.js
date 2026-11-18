// c3bot-relay: Telegram <-> c3 over WebSocket (/ws), SSE (/events) and long-poll (/poll); outbound POST /send.
// Session lease POST /claim, POST /release, GET /claim (#1795). Bearer-gated (C3BOT_RELAY_TOKEN); /health is open. Bot tokens come from the vault secret env only.
// Ingestion: Bot A (the c3-bot, C3BOT_A_BOT_TOKEN) in WEBHOOK mode posts to POST /telegram/webhook (public edge route,
// authenticated by Telegram's secret_token header = C3BOT_WEBHOOK_SECRET, not by the bearer). Fallback is the SAME token in
// polling mode: while the webhook is unhealthy the relay calls deleteWebhook and reads getUpdates, then setWebhook again when
// the public route recovers (failover.js). One consumer at a time, so no 409. Outbound stays on Bot A.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Relay, Telegram } from './relay.js';
import { Failover } from './failover.js';
import { accept } from './ws.js';
import { Lease } from './lease.js';

const env = process.env;
const PORT = +(env.PORT || 3119);
const HOST = env.HTTP_HOST || '127.0.0.1';
const BASE = env.BASE_PATH || '/c3bot-relay';
const TOKEN = env.C3BOT_RELAY_TOKEN || '';
const MAX_CLIENTS = +(env.MAX_CLIENTS || 32);
const POLL_MAX_WAIT_S = +(env.POLL_MAX_WAIT_S || 50);
const DEFAULT_CHAT = (env.C3BOT_ALLOWED_FROM || '').split(',')[0].trim() || null;

// Fail loudly: a missing bearer must stop the container (health and Ship go red), never serve open.
if (!TOKEN && env.NODE_ENV !== 'test') { console.error('FATAL: C3BOT_RELAY_TOKEN is not set (vault secret not mounted); refusing to start'); process.exit(78); }

export const relay = new Relay({
  bufferSize: +(env.BUFFER_SIZE || 500),
  allowedFrom: (env.C3BOT_ALLOWED_FROM || '').split(',').map((s) => s.trim()).filter(Boolean),
});
const TG_BASE = env.TELEGRAM_API_BASE || undefined;
const WEBHOOK_SECRET = env.C3BOT_WEBHOOK_SECRET || '';
const WEBHOOK_URL = env.C3BOT_WEBHOOK_URL || 'https://c3-pub.diegonmarcos.com/c3bot-webhook';
export const botA = new Telegram({ token: env.C3BOT_A_BOT_TOKEN, base: TG_BASE });   // webhook, getUpdates fallback, outbound
export const telegram = botA;
export const lease = new Lease({ defaultTtlS: +(env.LEASE_TTL_S || 900) });
export const failover = new Failover({ windowMs: +(env.HEALTH_WINDOW_S || 600) * 1000, configured: botA.configured && !!WEBHOOK_SECRET });
let pollEnabled = false; // true only after deleteWebhook succeeded; the getUpdates loop never runs beside a webhook
const sender = () => botA;
const selfTests = new Set();
let clients = 0;

const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const bearerOk = (req, url) => {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
  return !!TOKEN && !!t && eq(t, TOKEN);
};
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 1e6) { no(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('invalid JSON')); } });
});
const route = (req) => {
  const url = new URL(req.url, 'http://x');
  let path = url.pathname;
  if (path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
  return { url, path };
};
const health = () => ({
  ok: true, telegram: telegram.state, telegramError: telegram.lastError, cursor: relay.cursor, clients, transports: ['ws', 'sse', 'poll'],
  tokenConfigured: !!TOKEN, botConfigured: botA.configured, lease: { held: !!lease.live(), expiresAt: lease.live() ? lease.expiresAt : null },
  ingest: { ...failover.snapshot(), webhookSecretConfigured: !!WEBHOOK_SECRET, botA: botA.state, polling: pollEnabled, dupes: relay.dupes },
});

async function doSend(msg) {
  const chat_id = msg.chat_id ?? DEFAULT_CHAT;
  if (!chat_id || typeof msg.text !== 'string' || !msg.text) throw Object.assign(new Error('chat_id (or default) and text required'), { status: 400 });
  try {
    const r = await sender().send({ chat_id, text: msg.text, thread_id: msg.thread_id });
    relay.publish('telegram.sent', { chat_id, text: msg.text, ...r });
    return r;
  } catch (e) { throw Object.assign(e, { status: e.code === 'unconfigured' ? 503 : 502 }); }
}

// Webhook receiver. Authenticated ONLY by Telegram's secret_token header (constant-time compare); no secret configured
// means the route answers 503 rather than accepting anonymous posts. The body is answered 200 fast; one bad update never
// makes Telegram retry-storm (a 200 is returned for parseable bodies even when the update is dropped).
async function webhook(req, res) {
  if (!WEBHOOK_SECRET) return json(res, 503, { ok: false, error: 'webhook secret not configured' });
  const h = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (!h || !eq(h, WEBHOOK_SECRET)) return json(res, 401, { ok: false, error: 'unauthorized' });
  let u; try { u = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  if (u && typeof u.selftest === 'string') { selfTests.add(u.selftest); return json(res, 200, { ok: true, selftest: true }); }
  failover.noteWebhookUpdate();
  relay.ingestUpdate(u, 'A');
  json(res, 200, { ok: true });
}

// Self-test of the whole public path: POST a probe to our own public webhook URL with the secret header and see it arrive.
export async function selfTest(f = fetch) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const r = await f(WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': WEBHOOK_SECRET }, body: JSON.stringify({ selftest: nonce }), signal: AbortSignal.timeout(10000) });
    const ok = r.status === 200 && selfTests.has(nonce);
    selfTests.delete(nonce);
    return ok;
  } catch { return false; }
}

// Mode switch. Entering polling: deleteWebhook first, the getUpdates loop opens only after it succeeded (drop_pending_updates
// false, so queued updates are read by getUpdates). Leaving polling: close the loop first, then setWebhook.
async function enterPolling() {
  try { const j = await botA.api('deleteWebhook', { drop_pending_updates: false }, 15000); pollEnabled = !!j.ok; if (!j.ok) failover.reason = `deleteWebhook failed: ${j.description || 'not ok'}`; }
  catch (e) { pollEnabled = false; failover.reason = `deleteWebhook failed: ${String(e.message || e).split(botA.token).join('***')}`; }
}
async function leavePolling() {
  pollEnabled = false;
  try { const j = await botA.setWebhook({ url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET }); if (!j.ok) { failover.actionFailed('setWebhook', j.description || 'not ok'); await enterPolling(); } }
  catch (e) { failover.actionFailed('setWebhook', String(e.message || e).split(botA.token).join('***')); await enterPolling(); }
}

// One health tick. In webhook mode: idempotent setWebhook if unregistered, getWebhookInfo (error / last_error), self-test of
// the public route when the chat has been silent. In polling mode: self-test the public route and switch back when it
// has been healthy for recoverChecks ticks. Secrets are never logged.
export async function healthTick({ self = selfTest } = {}) {
  if (failover.state === 'degraded') return failover.snapshot();
  if (failover.polling) {
    if (!pollEnabled) await enterPolling(); // a failed deleteWebhook is retried every tick
    const r = failover.evaluate({ selfTestOk: await self() });
    if (r.action === 'setWebhook') await leavePolling();
    return failover.snapshot();
  }
  const sig = {};
  try {
    let j = await botA.getWebhookInfo();
    if (!j.ok) sig.infoError = `${j.error_code || ''} ${j.description || 'not ok'}`.trim();
    else {
      if (j.result.url !== WEBHOOK_URL) {
        const set = await botA.setWebhook({ url: WEBHOOK_URL, secret_token: WEBHOOK_SECRET });
        if (!set.ok) sig.notRegistered = true; else { j = await botA.getWebhookInfo(); }
      }
      if (j.ok && j.result.last_error_date) { sig.lastErrorAt = j.result.last_error_date * 1000; sig.lastErrorMessage = j.result.last_error_message; }
    }
  } catch (e) { sig.infoError = String(e.message || e).split(botA.token).join('***'); }
  let r = failover.evaluate(sig);
  if (r.needSelfTest) r = failover.evaluate({ ...sig, selfTestOk: await self() });
  if (r.action === 'deleteWebhook') await enterPolling();
  return failover.snapshot();
}

export const server = http.createServer(async (req, res) => {
  try {
    const { url, path } = route(req);
    if (req.method === 'GET' && path === '/health') return json(res, 200, health());
    if (req.method === 'POST' && (path === '/telegram/webhook' || path === '/webhook')) return await webhook(req, res);
    if (!bearerOk(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });

    // Session lease (#1795): one answering session for non-reply owner messages. Holder names are bearer-only (not in /health).
    if (req.method === 'POST' && path === '/claim') { const b = await readBody(req); return json(res, 200, { ok: true, ...lease.claim(b.session, b.ttl) }); }
    if (req.method === 'POST' && path === '/release') { const b = await readBody(req); return json(res, 200, { ok: true, ...lease.release(b.session) }); }
    if (req.method === 'GET' && path === '/claim') return json(res, 200, { ok: true, ...lease.snapshot() });

    if (req.method === 'POST' && path === '/send') return json(res, 200, { ok: true, ...(await doSend(await readBody(req))) });

    if (req.method === 'GET' && path === '/poll') { // long-poll fallback: cursor in, events + new cursor out
      const after = +(url.searchParams.get('after') || 0);
      const wait = Math.min(+(url.searchParams.get('wait') || 25), POLL_MAX_WAIT_S) * 1000;
      const aborted = new Promise((r) => req.on('close', () => r(null)));
      const evs = await Promise.race([relay.waitFor(after, wait), aborted]);
      if (evs === null) return;
      return json(res, 200, { ok: true, head: relay.cursor, cursor: evs.length ? evs[evs.length - 1].seq : Math.max(after, 0), events: evs });
    }

    if (req.method === 'GET' && path === '/events') { // SSE, resumable with Last-Event-ID or ?after=
      if (clients >= MAX_CLIENTS) return json(res, 429, { ok: false, error: 'too many clients' });
      clients++;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const after = +(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      const write = (e) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.write(': connected\n\n');
      for (const e of relay.since(after, relay.bufferSize)) write(e);
      const unsub = relay.subscribe(write);
      const ka = setInterval(() => res.write(': keepalive\n\n'), 20000);
      req.on('close', () => { clearInterval(ka); unsub(); clients--; });
      return;
    }
    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) { json(res, e.status || 500, { ok: false, error: e.message }); }
});

// WebSocket /ws: server pushes events as JSON text; client may send {type:"send",chat_id?,text} or {type:"since",after}.
server.on('upgrade', (req, socket) => {
  const { url, path } = route(req);
  if (path !== '/ws') return socket.destroy();
  if (!bearerOk(req, url)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  if (clients >= MAX_CLIENTS) { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  clients++;
  let unsub = () => {};
  const conn = accept(req, socket, {
    onClose: () => { unsub(); clients--; },
    onMessage: async (text, c) => {
      let m; try { m = JSON.parse(text); } catch { return c.send(JSON.stringify({ type: 'error', error: 'invalid JSON' })); }
      if (m.type === 'send') {
        try { c.send(JSON.stringify({ type: 'send.ok', id: m.id ?? null, ...(await doSend(m)) })); }
        catch (e) { c.send(JSON.stringify({ type: 'error', id: m.id ?? null, error: e.message })); }
      } else if (m.type === 'since') for (const e of relay.since(+m.after || 0, relay.bufferSize)) c.send(JSON.stringify(e));
      else c.send(JSON.stringify({ type: 'error', error: 'unknown type' }));
    },
  });
  if (!conn) { clients--; return; }
  const after = +(url.searchParams.get('after') || 0);
  conn.send(JSON.stringify({ type: 'hello', cursor: relay.cursor, telegram: telegram.state }));
  for (const e of relay.since(after, relay.bufferSize)) conn.send(JSON.stringify(e));
  unsub = relay.subscribe((e) => conn.send(JSON.stringify(e)));
});

if (env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => console.log(`c3bot-relay on ${HOST}:${PORT}${BASE} botA=${botA.configured} webhookSecret=${!!WEBHOOK_SECRET}`));
  botA.loop((u) => relay.ingestUpdate(u, 'P'), { gate: () => pollEnabled && failover.polling });
  const every = +(env.CHECK_INTERVAL_S || 60) * 1000;
  healthTick().catch(() => {});
  const timer = setInterval(() => healthTick().catch(() => {}), every);
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { clearInterval(timer); telegram.stop(); server.close(); process.exit(0); });
}
