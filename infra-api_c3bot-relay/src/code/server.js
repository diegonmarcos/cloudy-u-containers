// c3bot-relay: Telegram <-> c3 over WebSocket (/ws), SSE (/events) and long-poll (/poll); outbound POST /send.
// Bearer-gated (C3BOT_RELAY_TOKEN); /health is open. Bot token (C3BOT_RELAY_BOT_TOKEN) comes from the vault secret env only.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Relay, Telegram } from './relay.js';
import { accept } from './ws.js';

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
export const telegram = new Telegram({ token: env.C3BOT_RELAY_BOT_TOKEN, base: env.TELEGRAM_API_BASE || undefined });
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
const health = () => ({ ok: true, telegram: telegram.state, telegramError: telegram.lastError, cursor: relay.cursor, clients, transports: ['ws', 'sse', 'poll'], tokenConfigured: !!TOKEN, botConfigured: telegram.configured });

async function doSend(msg) {
  const chat_id = msg.chat_id ?? DEFAULT_CHAT;
  if (!chat_id || typeof msg.text !== 'string' || !msg.text) throw Object.assign(new Error('chat_id (or default) and text required'), { status: 400 });
  try {
    const r = await telegram.send({ chat_id, text: msg.text, thread_id: msg.thread_id });
    relay.publish('telegram.sent', { chat_id, text: msg.text, ...r });
    return r;
  } catch (e) { throw Object.assign(e, { status: e.code === 'unconfigured' ? 503 : 502 }); }
}

export const server = http.createServer(async (req, res) => {
  try {
    const { url, path } = route(req);
    if (req.method === 'GET' && path === '/health') return json(res, 200, health());
    if (!bearerOk(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' });

    if (req.method === 'POST' && path === '/send') return json(res, 200, { ok: true, ...(await doSend(await readBody(req))) });

    if (req.method === 'GET' && path === '/poll') { // long-poll fallback: cursor in, events + new cursor out
      const after = +(url.searchParams.get('after') || 0);
      const wait = Math.min(+(url.searchParams.get('wait') || 25), POLL_MAX_WAIT_S) * 1000;
      const aborted = new Promise((r) => req.on('close', () => r(null)));
      const evs = await Promise.race([relay.waitFor(after, wait), aborted]);
      if (evs === null) return;
      return json(res, 200, { ok: true, cursor: evs.length ? evs[evs.length - 1].seq : Math.max(after, 0), events: evs });
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
  server.listen(PORT, HOST, () => console.log(`c3bot-relay on ${HOST}:${PORT}${BASE} telegram=${telegram.state}`));
  telegram.loop((u) => relay.ingestUpdate(u));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { telegram.stop(); server.close(); process.exit(0); });
}
