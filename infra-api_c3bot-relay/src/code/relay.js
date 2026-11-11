// Core of c3bot-relay: an in-memory event log with a cursor, fan-out to subscribers, and the Telegram bridge.
// Transport-agnostic: server.js maps WS, SSE and long-poll onto subscribe() / since() / waitFor().

export const TELEGRAM_MAX = 4096;

export function chunkText(text, max = TELEGRAM_MAX) {
  const s = String(text);
  if (s.length <= max) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
  return out;
}

export class Relay {
  constructor({ bufferSize = 500, allowedFrom = [] } = {}) {
    this.bufferSize = bufferSize;
    this.allowed = new Set(allowedFrom.map(Number));
    this.events = [];      // ring of {seq, ts, type, ...}
    this.seq = 0;
    this.subs = new Set(); // fn(event)
    this.waiters = new Set();
  }
  get cursor() { return this.seq; }
  publish(type, data) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, ...data };
    this.events.push(ev);
    if (this.events.length > this.bufferSize) this.events.shift();
    for (const s of this.subs) { try { s(ev); } catch { /* one bad subscriber never blocks the rest */ } }
    for (const w of [...this.waiters]) w();
    return ev;
  }
  since(after = 0, limit = 100) {
    return this.events.filter((e) => e.seq > after).slice(0, limit);
  }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  // Long-poll primitive: resolves with events after `after`, or [] when waitMs elapses.
  waitFor(after, waitMs, limit = 100) {
    const now = this.since(after, limit);
    if (now.length || waitMs <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      let t;
      const w = () => { clearTimeout(t); this.waiters.delete(w); resolve(this.since(after, limit)); };
      t = setTimeout(w, waitMs);
      this.waiters.add(w);
    });
  }
  // Inbound Telegram update -> event. Only allowlisted senders are surfaced (same rule as cloud-infra-mcp telegram.ts).
  ingestUpdate(u) {
    const m = u.message || u.edited_message || u.channel_post;
    if (!m) return null;
    const from = m.from?.id;
    if (this.allowed.size && !this.allowed.has(Number(from))) return null;
    return this.publish('telegram.message', {
      update_id: u.update_id, chat_id: m.chat?.id, thread_id: m.message_thread_id ?? null,
      from: { id: from, username: m.from?.username ?? null, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null },
      message_id: m.message_id, text: m.text ?? m.caption ?? '', date: m.date,
    });
  }
}

// Telegram Bot API client + getUpdates loop. `token` is read by the caller from the environment (vault secret); never logged.
export class Telegram {
  constructor({ token, fetchImpl = fetch, base = 'https://api.telegram.org' } = {}) {
    this.token = token || ''; this.f = fetchImpl; this.base = base;
    this.state = token ? 'idle' : 'unconfigured';
    this.lastError = null; this.offset = 0; this.stopped = false;
  }
  get configured() { return !!this.token; }
  async api(method, body, timeoutMs = 15000) {
    const r = await this.f(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.json();
  }
  async send({ chat_id, text, thread_id }) {
    if (!this.configured) throw Object.assign(new Error('telegram bot token not configured'), { code: 'unconfigured' });
    const results = [];
    for (const part of chunkText(text)) {
      const body = { chat_id, text: part };
      if (thread_id != null) body.message_thread_id = thread_id;
      const j = await this.api('sendMessage', body);
      if (!j.ok) throw Object.assign(new Error(j.description || 'sendMessage failed'), { code: 'telegram' });
      results.push(j.result.message_id);
    }
    return { message_ids: results };
  }
  async loop(onUpdate, { pollTimeoutS = 50, backoffMs = 5000 } = {}) {
    if (!this.configured) return;
    while (!this.stopped) {
      try {
        this.state = 'polling';
        const j = await this.api('getUpdates', { timeout: pollTimeoutS, offset: this.offset, allowed_updates: ['message', 'edited_message'] }, (pollTimeoutS + 15) * 1000);
        if (!j.ok) { this.state = 'error'; this.lastError = `${j.error_code || ''} ${j.description || ''}`.trim(); await new Promise((r) => setTimeout(r, backoffMs)); continue; }
        this.lastError = null;
        for (const u of j.result) { this.offset = u.update_id + 1; onUpdate(u); }
      } catch (e) {
        this.state = 'error'; this.lastError = String(e.message || e).replace(this.token, '***');
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  stop() { this.stopped = true; }
}
