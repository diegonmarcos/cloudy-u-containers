// headless-api v1: contract validation, bearer gate, session manager. Pure (engine injected), unit-tested.
import { timingSafeEqual } from 'node:crypto';
import { OCR_ENGINES, OCR_LANGS, LANG_RE } from './ocr.js';

export const CMDS = ['open', 'close', 'wait', 'eval', 'click', 'type', 'scroll', 'html', 'text', 'readable', 'screenshot', 'cookies', 'storage', 'network', 'content', 'pdf', 'links', 'scrape', 'snapshot'];
// Container-only extension commands: NOT in the shared headless-api schema (the phone engine does not implement them), so CMDS stays equal to it.
export const EXT_CMDS = ['ocr'];
export const MAX_TIMEOUT_MS = 120000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class ApiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function checkBearer(header, token) {
  if (!token) throw new ApiError('unauthorized', 'server token not configured');
  const m = /^Bearer (.+)$/.exec(header || '');
  if (!m) throw new ApiError('unauthorized', 'bearer required');
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError('unauthorized', 'bad token');
}

export function validate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ApiError('bad_request', 'command must be an object');
  if (!CMDS.includes(c.cmd) && !EXT_CMDS.includes(c.cmd)) throw new ApiError('bad_request', `unknown cmd ${c.cmd}`);
  if (c.session !== undefined && !ID_RE.test(String(c.session))) throw new ApiError('bad_request', 'bad session id');
  if (c.timeoutMs !== undefined && !(Number.isInteger(c.timeoutMs) && c.timeoutMs >= 1 && c.timeoutMs <= MAX_TIMEOUT_MS)) throw new ApiError('bad_request', 'bad timeoutMs');
  const need = (k) => { if (typeof c[k] !== 'string' || !c[k]) throw new ApiError('bad_request', `${c.cmd} needs ${k}`); };
  if (c.cmd === 'open') {
    need('url');
    if (!/^https?:\/\//i.test(c.url)) throw new ApiError('bad_request', 'url must be http(s)');
  }
  if (c.cmd === 'readable') {
    if (c.format !== undefined && !['markdown', 'json', 'xml'].includes(c.format)) throw new ApiError('bad_request', 'format markdown|json|xml');
    if (c.maxChars !== undefined && !(Number.isInteger(c.maxChars) && c.maxChars >= 500 && c.maxChars <= 200000)) throw new ApiError('bad_request', 'maxChars 500..200000');
    if (c.cursor !== undefined && !/^\d{1,9}$/.test(String(c.cursor))) throw new ApiError('bad_request', 'bad cursor');
  }
  if (c.cmd === 'screenshot' || c.cmd === 'snapshot') {
    if (c.format !== undefined && !['png', 'jpeg'].includes(c.format)) throw new ApiError('bad_request', 'format png|jpeg');
    if (c.quality !== undefined && !(Number.isInteger(c.quality) && c.quality >= 1 && c.quality <= 100)) throw new ApiError('bad_request', 'quality 1..100');
  }
  if (c.cmd === 'ocr') {
    const int = (k, lo, hi) => { if (c[k] !== undefined && !(Number.isInteger(c[k]) && c[k] >= lo && c[k] <= hi)) throw new ApiError('bad_request', `${k} ${lo}..${hi}`); };
    if (c.engine !== undefined && !OCR_ENGINES.includes(c.engine)) throw new ApiError('bad_request', `engine ${OCR_ENGINES.join('|')}`);
    int('minWidth', 1, 10000); int('minHeight', 1, 10000); int('maxImages', 1, 50);
    if (c.lang !== undefined && !(typeof c.lang === 'string' && LANG_RE.test(c.lang) && c.lang.split('+').every((l) => OCR_LANGS.includes(l)))) throw new ApiError('bad_request', `lang ${OCR_LANGS.join('|')} (join with + for up to 3)`);
    for (const k of ['includeScreenshot', 'fullPage']) if (c[k] !== undefined && typeof c[k] !== 'boolean') throw new ApiError('bad_request', `${k} boolean`);
    for (const k of ['escalateBelow', 'lowConfidence']) if (c[k] !== undefined && !(typeof c[k] === 'number' && c[k] >= 0 && c[k] <= 100)) throw new ApiError('bad_request', `${k} 0..100`);
  }
  if (c.cmd === 'scrape') {
    if (!Array.isArray(c.elements) || c.elements.length < 1 || c.elements.length > 20 || !c.elements.every((e) => e && typeof e.selector === 'string' && e.selector)) throw new ApiError('bad_request', 'scrape needs elements[1..20] with selector');
    if (c.limit !== undefined && !(Number.isInteger(c.limit) && c.limit >= 1 && c.limit <= 1000)) throw new ApiError('bad_request', 'limit 1..1000');
  }
  if (c.cmd === 'eval') need('js');
  if (c.cmd === 'click') need('selector');
  if (c.cmd === 'type') { need('selector'); if (typeof c.text !== 'string') throw new ApiError('bad_request', 'type needs text'); }
  if (c.cmd === 'wait') {
    const n = [c.selector, c.idle, c.ms].filter((v) => v !== undefined).length;
    if (n !== 1) throw new ApiError('bad_request', 'wait needs exactly one of selector|idle|ms');
  }
  if (c.cmd === 'storage' && !['local', 'session'].includes(c.area)) throw new ApiError('bad_request', 'storage area local|session');
  return c;
}

export function validateRun(r) {
  if (!r || !Array.isArray(r.steps) || r.steps.length < 1 || r.steps.length > 50) throw new ApiError('bad_request', 'steps 1..50');
  if (r.stepTimeoutMs !== undefined && !(Number.isInteger(r.stepTimeoutMs) && r.stepTimeoutMs >= 1 && r.stepTimeoutMs <= MAX_TIMEOUT_MS)) throw new ApiError('bad_request', 'bad stepTimeoutMs');
  r.steps.forEach(validate);
  return r;
}

export function withTimeout(p, ms, label) {
  let t;
  const to = new Promise((_, rej) => { t = setTimeout(() => rej(new ApiError('timeout', `${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

export class Sessions {
  constructor({ engine, maxSessions = 4, idleCloseMs = 300000, callTimeoutMs = 30000, now = () => Date.now() }) {
    Object.assign(this, { engine, maxSessions, idleCloseMs, callTimeoutMs, now });
    this.map = new Map();
    this.seq = 0;
  }
  list() { return [...this.map.entries()].map(([id, s]) => ({ id, agent: s.agent, idleMs: this.now() - s.last })); }
  async open(c) {
    const id = c.session || `s${++this.seq}-${this.now().toString(36)}`;
    let s = this.map.get(id);
    if (!s) {
      if (this.map.size >= this.maxSessions) throw new ApiError('limit', `max sessions ${this.maxSessions}`);
      s = { handle: await withTimeout(this.engine.newSession({ profile: c.profile || id }), this.callTimeoutMs, 'open'), agent: c.agent || '', last: this.now() };
      this.map.set(id, s);
    }
    s.last = this.now();
    const r = await withTimeout(this.engine.run(s.handle, c), c.timeoutMs || this.callTimeoutMs, 'open');
    return { session: id, result: r };
  }
  async close(id) {
    const s = this.map.get(id);
    if (!s) return false;
    this.map.delete(id);
    await this.engine.closeSession(s.handle).catch(() => {});
    return true;
  }
  async command(c) {
    validate(c);
    if (c.cmd === 'open') return this.open(c);
    if (!c.session) throw new ApiError('bad_request', 'session required');
    if (c.cmd === 'close') return { session: c.session, result: { closed: await this.close(c.session) } };
    const s = this.map.get(c.session);
    if (!s) throw new ApiError('not_found', 'no such session');
    s.last = this.now();
    const r = await withTimeout(this.engine.run(s.handle, c), c.timeoutMs || this.callTimeoutMs, c.cmd);
    s.last = this.now();
    return { session: c.session, result: r };
  }
  async runSteps(r) {
    validateRun(r);
    const out = [];
    let session = r.session;
    let ok = true;
    for (const step of r.steps) {
      const c = { ...step, session: step.session || session, timeoutMs: step.timeoutMs || r.stepTimeoutMs };
      try {
        const x = await this.command(c);
        session = x.session;
        out.push({ ok: true, session: x.session, result: x.result });
      } catch (e) {
        ok = false;
        out.push({ ok: false, error: { code: e.code || 'internal', message: e.message } });
        if (r.stopOnError !== false) break;
      }
    }
    return { ok, session, steps: out };
  }
  async sweep() {
    const dead = [...this.map.entries()].filter(([, s]) => this.now() - s.last >= this.idleCloseMs).map(([id]) => id);
    for (const id of dead) await this.close(id);
    return dead;
  }
  async closeAll() { for (const id of [...this.map.keys()]) await this.close(id); }
}
