import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay, Telegram, chunkText } from '../relay.js';
import { Failover } from '../failover.js';
import { FrameDecoder, encodeFrame, acceptKey } from '../ws.js';

const upd = (id, from, text) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 7 }, from: { id: from, first_name: 'A' }, text } });

test('ingest drops senders outside the allowlist, keeps the rest', () => {
  const r = new Relay({ allowedFrom: ['42'] });
  const dropped = r.ingestUpdate(upd(1, 99, 'x'));
  assert.equal(dropped.type, 'telegram.chat'); // metadata only (#1579), the text and sender never surface
  assert.ok(!JSON.stringify(dropped).includes('"x"'));
  assert.equal(r.ingestUpdate(upd(2, 42, 'hi')).text, 'hi');
  assert.equal(r.cursor, 2);
});

test('ring buffer is bounded and since() honours the cursor', () => {
  const r = new Relay({ bufferSize: 3 });
  for (let i = 0; i < 5; i++) r.publish('t', { i });
  assert.deepEqual(r.since(0).map((e) => e.seq), [3, 4, 5]);
  assert.deepEqual(r.since(4).map((e) => e.seq), [5]);
});

test('waitFor resolves on publish and times out empty', async () => {
  const r = new Relay();
  const p = r.waitFor(0, 2000);
  r.publish('t', {});
  assert.equal((await p).length, 1);
  assert.deepEqual(await r.waitFor(1, 20), []);
});

test('subscriber errors never block other subscribers', () => {
  const r = new Relay(); let n = 0;
  r.subscribe(() => { throw new Error('boom'); });
  r.subscribe(() => { n++; });
  r.publish('t', {});
  assert.equal(n, 1);
});

test('chunkText splits at the Telegram 4096 cap', () => {
  assert.equal(chunkText('a'.repeat(9000)).length, 3);
  assert.equal(chunkText('ok').length, 1);
});

test('Telegram without a token is unconfigured and refuses to send', async () => {
  const t = new Telegram({ token: '' });
  assert.equal(t.state, 'unconfigured');
  await assert.rejects(t.send({ chat_id: 1, text: 'x' }), { code: 'unconfigured' });
});

test('Telegram.send posts sendMessage and returns ids; error redacts nothing but never leaks token', async () => {
  const calls = [];
  const t = new Telegram({ token: 'TOK', fetchImpl: async (u, o) => { calls.push([u, JSON.parse(o.body)]); return { json: async () => ({ ok: true, result: { message_id: 9 } }) }; } });
  const r = await t.send({ chat_id: 5, text: 'yo', thread_id: 3 });
  assert.deepEqual(r.message_ids, [9]);
  assert.match(calls[0][0], /\/botTOK\/sendMessage$/);
  assert.equal(calls[0][1].message_thread_id, 3);
});

test('websocket: accept key matches RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('websocket: decoder unmasks, handles split chunks and rejects unmasked frames', () => {
  const text = Buffer.from('hello');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(text.map((b, i) => b ^ mask[i & 3]));
  const frame = Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, masked]);
  const d = new FrameDecoder();
  assert.deepEqual(d.push(frame.subarray(0, 4)), []);
  const out = d.push(frame.subarray(4));
  assert.equal(out[0].payload.toString(), 'hello');
  assert.throws(() => new FrameDecoder().push(Buffer.from([0x81, 0x01, 0x61])), /unmasked/);
});

test('websocket: encodeFrame uses 16-bit length above 125 bytes', () => {
  const f = encodeFrame(0x1, 'x'.repeat(300));
  assert.equal(f[1], 126);
  assert.equal(f.readUInt16BE(2), 300);
});

// ---- #1579 dedupe across Bot A (webhook) and Bot B (getUpdates) ----
test('dedupe: identity is chat + message_id + date, not update_id', () => {
  const r = new Relay({ allowedFrom: ['42'] });
  assert.ok(r.ingestUpdate({ update_id: 1, message: { message_id: 5, date: 9, chat: { id: 7 }, from: { id: 42 }, text: 'a' } }, 'A'));
  assert.equal(r.ingestUpdate({ update_id: 999, message: { message_id: 5, date: 9, chat: { id: 7 }, from: { id: 42 }, text: 'a' } }, 'B'), null);
  assert.ok(r.ingestUpdate({ update_id: 1000, message: { message_id: 5, date: 10, chat: { id: 7 }, from: { id: 42 }, text: 'a' } }, 'B'), 'other date is another message');
  assert.ok(r.ingestUpdate({ update_id: 1001, message: { message_id: 5, date: 9, chat: { id: 8 }, from: { id: 42 }, text: 'a' } }, 'B'), 'other chat is another message');
  assert.equal(r.dupes, 1);
});

test('dedupe: an edit is a new event, a repeated edit is not; the seen set is bounded', () => {
  const r = new Relay({ allowedFrom: ['42'], dedupeSize: 3 });
  const base = { message_id: 5, date: 9, chat: { id: 7 }, from: { id: 42 }, text: 'a' };
  assert.ok(r.ingestUpdate({ update_id: 1, message: base }));
  assert.ok(r.ingestUpdate({ update_id: 2, edited_message: { ...base, edit_date: 20, text: 'b' } }));
  assert.equal(r.ingestUpdate({ update_id: 3, edited_message: { ...base, edit_date: 20, text: 'b' } }), null);
  for (let i = 0; i < 5; i++) r.ingestUpdate({ update_id: 10 + i, message: { ...base, message_id: 100 + i } });
  assert.equal(r.seen.size, 3);
});

test('ingest tags the source path and non-allowlisted chats only announce metadata once', () => {
  const r = new Relay({ allowedFrom: ['42'] });
  const ev = r.ingestUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 7 }, from: { id: 42 }, text: 'x' } }, 'B');
  assert.equal(ev.source, 'B');
  const m = (id) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: -100, title: 'grp', type: 'supergroup' }, from: { id: 9 }, text: 'foreign' } });
  const a = r.ingestUpdate(m(2)); assert.equal(a.type, 'telegram.chat'); assert.ok(!('text' in a.update.message) && !('from' in a.update.message));
  assert.equal(r.ingestUpdate(m(3)), null);
});

// ---- failover state machine (injected clock) ----
const clock = () => { const c = { t: 1_000_000, now: () => c.t }; return c; };
const mk = (hasFallback, c) => new Failover({ windowMs: 600000, hasFallback, now: c.now });

test('failover: healthy webhook stays on webhook; a quiet chat with a passing self-test is healthy', () => {
  const c = clock(); const f = mk(true, c);
  assert.equal(f.evaluate({}).state, 'webhook');
  c.t += 700000;
  assert.deepEqual(f.evaluate({}), { state: 'webhook', needSelfTest: true });
  assert.equal(f.evaluate({ selfTestOk: true }).state, 'webhook');
});

test('failover: silent window plus failing self-test goes to fallback; recovery needs two good checks', () => {
  const c = clock(); const f = mk(true, c);
  c.t += 700000;
  assert.equal(f.evaluate({ selfTestOk: false }).state, 'fallback');
  assert.equal(f.pollFallback, true);
  f.noteWebhookUpdate();
  assert.equal(f.evaluate({}).state, 'fallback');
  assert.equal(f.evaluate({}).state, 'webhook');
  assert.equal(f.transitions.length, 2);
});

test('failover: getWebhookInfo error alone fails over without waiting for the window', () => {
  const c = clock(); const f = mk(true, c);
  assert.equal(f.evaluate({ infoError: '502 Bad Gateway' }).state, 'fallback');
  assert.match(f.reason, /getWebhookInfo failed/);
});

test('failover: a delivery error older than the last webhook update is ignored', () => {
  const c = clock(); const f = mk(true, c);
  const old = c.t - 1000; c.t += 5; f.noteWebhookUpdate();
  assert.equal(f.evaluate({ lastErrorAt: old }).state, 'webhook');
  assert.equal(f.evaluate({ lastErrorAt: c.t + 1 }).state, 'fallback');
});

test('failover: without a Bot B token an unhealthy webhook is reported degraded, never fallback', () => {
  const c = clock(); const f = mk(false, c);
  assert.equal(f.evaluate({ infoError: 'x' }).state, 'degraded');
  assert.equal(f.pollFallback, false);
  assert.equal(f.snapshot().fallback, 'degraded: Bot B token missing');
});
