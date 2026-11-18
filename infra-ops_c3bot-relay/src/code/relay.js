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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Relay {
  constructor({ bufferSize = 500, allowedFrom = [], dedupeSize = 2000, statePath = '', saveDelayMs = 200 } = {}) {
    this.bufferSize = bufferSize;
    this.dedupeSize = dedupeSize;
    this.seen = new Set();     // dedupe keys across webhook and getUpdates delivery, insertion ordered
    this.chatSig = new Map();  // chat metadata already announced (telegram.chat events)
    this.dupes = 0;
    this.allowed = new Set(allowedFrom.map(Number));
    this.events = [];      // ring of {seq, ts, type, ...}
    this.seq = 0;
    this.subs = new Set(); // fn(event)
    this.waiters = new Set();
    // Restart safety (#1795): the event ring, the cursor and the dedupe keys survive a redeploy when statePath is set
    // (a file on a persistent volume). Writes are debounced and atomic (tmp + rename). A missing or unreadable file starts
    // empty; an unwritable one keeps the relay running in memory and is reported in persist (shown by /health).
    this.statePath = statePath; this.saveDelayMs = saveDelayMs; this.saveTimer = null;
    this.persist = { enabled: !!statePath, loaded: false, lastSaveAt: null, error: null };
    if (statePath) this.load();
  }
  load() {
    try {
      const j = JSON.parse(readFileSync(this.statePath, 'utf8'));
      if (Array.isArray(j.events)) this.events = j.events.slice(-this.bufferSize);
      this.seq = Math.max(+j.seq || 0, this.events.length ? this.events[this.events.length - 1].seq : 0);
      if (Array.isArray(j.seen)) this.seen = new Set(j.seen.slice(-this.dedupeSize));
      this.persist.loaded = true;
    } catch (e) { if (e.code !== 'ENOENT') this.persist.error = `load: ${e.message}`; }
  }
  save() {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, seq: this.seq, events: this.events, seen: [...this.seen] }));
      renameSync(tmp, this.statePath);
      this.persist.lastSaveAt = Date.now(); this.persist.error = null;
    } catch (e) { this.persist.error = `save: ${e.message}`; }
  }
  scheduleSave() {
    if (!this.statePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }
  flush() { if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } this.save(); }
  get cursor() { return this.seq; }
  publish(type, data) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, ...data };
    this.events.push(ev);
    if (this.events.length > this.bufferSize) this.events.shift();
    this.scheduleSave();
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
  // Dedupe key shared by both ingestion paths: the same Telegram message can arrive by webhook and again by getUpdates
  // (around a mode switch) with different update_ids, so identity is chat + message_id + date (+ edit_date for an edit).
  static dedupeKey(u) {
    const m = u.message || u.edited_message || u.channel_post;
    if (!m || m.chat?.id == null || m.message_id == null) return null;
    return `${m.chat.id}:${m.message_id}:${m.date}${u.edited_message ? `:e${m.edit_date ?? ''}` : ''}`;
  }
  // true when the key was already seen (and counts it); records it otherwise, evicting the oldest.
  isDuplicate(key) {
    if (key == null) return false;
    if (this.seen.has(key)) { this.dupes++; return true; }
    this.seen.add(key);
    if (this.seen.size > this.dedupeSize) this.seen.delete(this.seen.values().next().value);
    return false;
  }
  // Inbound Telegram update -> event. Only allowlisted senders are surfaced (same rule as cloud-infra-mcp telegram.ts).
  // `source` names the ingestion path ('A' webhook, 'P' getUpdates fallback). Every event carries `update`: the raw update for
  // allowlisted senders; for everyone else only chat/topic metadata (no text, no sender) in a telegram.chat event,
  // which lets consumers keep their chat and topic registry without surfacing foreign traffic.
  ingestUpdate(u, source = 'A') {
    const m = u.message || u.edited_message || u.channel_post;
    if (!m) return null;
    if (this.isDuplicate(Relay.dedupeKey(u))) return null;
    const from = m.from?.id;
    if (this.allowed.size && !this.allowed.has(Number(from))) return this.announceChat(u, m, source);
    return this.publish('telegram.message', {
      source, update: u, update_id: u.update_id, chat_id: m.chat?.id, thread_id: m.message_thread_id ?? null,
      from: { id: from, username: m.from?.username ?? null, name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null },
      message_id: m.message_id, text: m.text ?? m.caption ?? '', date: m.date,
    });
  }
  announceChat(u, m, source) {
    if (!m.chat) return null;
    const topic = m.forum_topic_created?.name ?? m.forum_topic_edited?.name ?? m.reply_to_message?.forum_topic_created?.name ?? '';
    const sig = `${m.chat.id}|${m.chat.title ?? ''}|${m.chat.type ?? ''}|${m.message_thread_id ?? ''}|${topic}`;
    if (this.chatSig.has(sig)) return null;
    this.chatSig.set(sig, 1);
    if (this.chatSig.size > 500) this.chatSig.delete(this.chatSig.keys().next().value);
    const chat = { id: m.chat.id, type: m.chat.type, title: m.chat.title, first_name: m.chat.first_name, last_name: m.chat.last_name };
    const message = { message_id: m.message_id, date: m.date, chat };
    if (m.message_thread_id !== undefined) message.message_thread_id = m.message_thread_id;
    if (m.is_topic_message !== undefined) message.is_topic_message = m.is_topic_message;
    if (m.forum_topic_created) message.forum_topic_created = m.forum_topic_created;
    if (m.forum_topic_edited) message.forum_topic_edited = m.forum_topic_edited;
    if (m.reply_to_message?.forum_topic_created) message.reply_to_message = { forum_topic_created: m.reply_to_message.forum_topic_created };
    return this.publish('telegram.chat', { source, update: { update_id: u.update_id, message }, chat_id: chat.id, thread_id: m.message_thread_id ?? null });
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
  getWebhookInfo() { return this.api('getWebhookInfo', {}, 10000); }
  setWebhook({ url, secret_token, allowed_updates = ['message', 'edited_message'] }) {
    return this.api('setWebhook', { url, secret_token, allowed_updates, max_connections: 4 }, 15000);
  }
  // `gate()` (optional) decides per iteration whether this loop may call getUpdates; Bot A only polls while the webhook
  // is deleted (the unhealthy-webhook fallback mode), so a closed gate idles the loop without ever touching Telegram.
  async loop(onUpdate, { pollTimeoutS = 50, backoffMs = 5000, gate = null, idleMs = 2000 } = {}) {
    if (!this.configured) return;
    while (!this.stopped) {
      if (gate && !gate()) { this.state = 'standby'; await new Promise((r) => setTimeout(r, idleMs)); continue; }
      try {
        this.state = 'polling';
        const j = await this.api('getUpdates', { timeout: pollTimeoutS, offset: this.offset, allowed_updates: ['message', 'edited_message'] }, (pollTimeoutS + 15) * 1000);
        if (!j.ok) { this.state = 'error'; this.lastError = `${j.error_code || ''} ${j.description || ''}`.trim(); await new Promise((r) => setTimeout(r, backoffMs)); continue; }
        this.lastError = null;
        for (const u of j.result) { this.offset = u.update_id + 1; onUpdate(u); }
      } catch (e) {
        this.state = 'error'; this.lastError = String(e.message || e).split(this.token).join('***');
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  stop() { this.stopped = true; }
}
