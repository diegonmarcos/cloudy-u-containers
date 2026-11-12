// Integration: real server on a loopback ephemeral port, fake Telegram API. Runs in CI (build.json tests.relay).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.C3BOT_RELAY_TOKEN = 'secret-relay-token';
process.env.C3BOT_RELAY_BOT_TOKEN = 'FAKEBOT';
process.env.C3BOT_ALLOWED_FROM = '42';
process.env.BASE_PATH = '/c3bot-relay';

const sent = [];
const fakeTg = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => b += d);
  req.on('end', () => { sent.push([req.url, JSON.parse(b || '{}')]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 11 } })); });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fakeTg.address().port}`;

const { server, relay, telegram } = await import('../server.js');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `127.0.0.1:${server.address().port}`;
const auth = { authorization: 'Bearer secret-relay-token' };
const inject = (id, from, text) => relay.ingestUpdate({ update_id: id, message: { message_id: id, date: 1, chat: { id: 42 }, from: { id: from }, text } });

test.after(() => { server.closeAllConnections?.(); server.close(); fakeTg.close(); });

test('health is open and reports transports', async () => {
  const j = await (await fetch(`http://${base}/c3bot-relay/health`)).json();
  assert.deepEqual(j.transports, ['ws', 'sse', 'poll']);
  assert.equal(j.botConfigured, true);
});

test('every other route needs the bearer', async () => {
  assert.equal((await fetch(`http://${base}/poll`)).status, 401);
  assert.equal((await fetch(`http://${base}/poll`, { headers: { authorization: 'Bearer nope' } })).status, 401);
});

test('long-poll: returns buffered events immediately and waits for new ones', async () => {
  inject(1, 42, 'first');
  const a = await (await fetch(`http://${base}/poll?after=0&wait=1`, { headers: auth })).json();
  assert.equal(a.events[0].text, 'first');
  const pending = fetch(`http://${base}/poll?after=${a.cursor}&wait=5`, { headers: auth }).then((r) => r.json());
  setTimeout(() => inject(2, 42, 'second'), 50);
  assert.equal((await pending).events[0].text, 'second');
});

test('SSE: replays after Last-Event-ID then streams live', async () => {
  const cur = relay.cursor;
  const res = await fetch(`http://${base}/events`, { headers: { ...auth, 'last-event-id': String(cur - 1) } });
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  setTimeout(() => inject(3, 42, 'live'), 50);
  while (!(buf.includes('second') && buf.includes('live'))) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
  assert.ok(buf.includes('event: telegram.message'));
  assert.ok(buf.includes('live'));
  await reader.cancel();
});

test('POST /send relays to Telegram with the default chat', async () => {
  const r = await (await fetch(`http://${base}/send`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'out' }) })).json();
  assert.deepEqual(r.message_ids, [11]);
  const call = sent.find(([u]) => u.endsWith('/sendMessage'));
  assert.match(call[0], /^\/botFAKEBOT\//);
  assert.equal(call[1].chat_id, '42');
});

test('WebSocket: hello, live push, send frame, bad bearer refused', async () => {
  const bad = new WebSocket(`ws://${base}/ws?token=wrong`);
  await new Promise((r) => { bad.onerror = r; bad.onclose = r; });
  const ws = new WebSocket(`ws://${base}/c3bot-relay/ws?token=secret-relay-token&after=${relay.cursor}`);
  const msgs = [];
  ws.onmessage = (m) => msgs.push(JSON.parse(m.data));
  await new Promise((r) => { ws.onopen = r; });
  const until = async (f) => { for (let i = 0; i < 100 && !msgs.find(f); i++) await new Promise((r) => setTimeout(r, 20)); return msgs.find(f); };
  assert.ok(await until((m) => m.type === 'hello'));
  inject(4, 42, 'wslive');
  assert.equal((await until((m) => m.text === 'wslive')).type, 'telegram.message');
  ws.send(JSON.stringify({ type: 'send', id: 'a1', text: 'via ws' }));
  assert.equal((await until((m) => m.type === 'send.ok')).id, 'a1');
  ws.close();
});

test('messages from non-allowlisted senders never reach any transport', () => {
  const before = relay.cursor;
  inject(5, 999, 'spam');
  assert.equal(relay.cursor, before);
});

test('telegram state is exposed (loop not started in test)', () => { assert.ok(['idle', 'polling', 'error'].includes(telegram.state)); });
