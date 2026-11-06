// cloudy-browser-headless: headless-api v1 over HTTP. Bearer-gated (BROWSER_TOKEN); /health is open.
import http from 'node:http';
import { ApiError, Sessions, checkBearer } from './api.js';
import { createEngine } from './engine.js';

const PORT = +(process.env.PORT || 3118);
const HOST = process.env.HTTP_HOST || '127.0.0.1';
const BASE = process.env.BASE_PATH || '/cloudy-browser-headless';
const TOKEN = process.env.BROWSER_TOKEN || '';
// Fail loudly: a missing secret must stop the container (health and Ship go red), never run with an empty token.
if (!TOKEN) {
  console.error('FATAL: BROWSER_TOKEN is not set (vault secret not mounted); refusing to start');
  process.exit(78);
}
const sessions = new Sessions({
  engine: createEngine(),
  maxSessions: +(process.env.MAX_SESSIONS || 4),
  idleCloseMs: +(process.env.IDLE_CLOSE_MS || 300000),
  callTimeoutMs: +(process.env.CALL_TIMEOUT_MS || 30000),
});
setInterval(() => sessions.sweep().catch(() => {}), 15000).unref();

const STATUS = { bad_request: 400, unauthorized: 401, not_found: 404, timeout: 504, limit: 429, denied: 403 };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => {
  let b = '';
  req.on('data', (d) => { b += d; if (b.length > 2e6) { no(new ApiError('bad_request', 'body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new ApiError('bad_request', 'invalid JSON')); } });
});

export const server = http.createServer(async (req, res) => {
  try {
    let path = new URL(req.url, 'http://x').pathname;
    if (path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, sessions: sessions.map.size, max: sessions.maxSessions, tokenConfigured: !!TOKEN });
    checkBearer(req.headers.authorization, TOKEN);
    if (req.method === 'GET' && path === '/sessions') return send(res, 200, { ok: true, result: sessions.list() });
    const del = /^\/sessions\/([^/]+)$/.exec(path);
    if (req.method === 'DELETE' && del) return send(res, 200, { ok: true, result: { closed: await sessions.close(del[1]) } });
    if (req.method === 'POST' && path === '/command') return send(res, 200, { ok: true, ...(await sessions.command(await readBody(req))) });
    if (req.method === 'POST' && path === '/run') return send(res, 200, await sessions.runSteps(await readBody(req)));
    throw new ApiError('not_found', 'no such route');
  } catch (e) {
    send(res, STATUS[e.code] || 500, { ok: false, error: { code: e.code || 'internal', message: e.message } });
  }
});
server.listen(PORT, HOST, () => console.log(`cloudy-browser-headless on ${HOST}:${PORT}${BASE}`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => sessions.closeAll().finally(() => process.exit(0)));
