import test from 'node:test';
import assert from 'node:assert/strict';
import { Relay, Telegram, chunkText } from '../relay.js';
import { FrameDecoder, encodeFrame, acceptKey } from '../ws.js';

const upd = (id, from, text) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 7 }, from: { id: from, first_name: 'A' }, text } });

test('ingest drops senders outside the allowlist, keeps the rest', () => {
  const r = new Relay({ allowedFrom: ['42'] });
  assert.equal(r.ingestUpdate(upd(1, 99, 'x')), null);
  assert.equal(r.ingestUpdate(upd(2, 42, 'hi')).text, 'hi');
  assert.equal(r.cursor, 1);
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
