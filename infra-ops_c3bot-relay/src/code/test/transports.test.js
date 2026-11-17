// Integration: real server on a loopback ephemeral port, fake Telegram API. Runs in CI (build.json tests.relay).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.NODE_ENV = 'test';
process.env.C3BOT_RELAY_TOKEN = 'secret-relay-token';
process.env.C3BOT_A_BOT_TOKEN = 'FAKEA';
process.env.C3BOT_WEBHOOK_SECRET = 'wh-secret';
process.env.C3BOT_WEBHOOK_URL = 'https://edge.invalid/c3bot-webhook';
process.env.HEALTH_WINDOW_S = '600';
process.env.C3BOT_ALLOWED_FROM = '42';
process.env.BASE_PATH = '/c3bot-relay';

const sent = [];
let webhookUrl = '';
let failSet = false;
let infoMode = 'ok'; // ok | error | delivery-error
const fakeInfo = () => infoMode === 'error' ? { ok: false, error_code: 502, description: 'Bad Gateway' }
  : { ok: true, result: { url: webhookUrl, last_error_date: infoMode === 'delivery-error' ? Math.ceil(Date.now() / 1000) + 1 : 0, last_error_message: 'Wrong response from the webhook: 502' } };
const fakeTg = http.createServer((req, res) => {
  let b = ''; req.on('data', (d) => b += d);
  req.on('end', () => {
    const body = JSON.parse(b || '{}'); sent.push([req.url, body]); res.setHeader('content-type', 'application/json');
    if (req.url.endsWith('/getWebhookInfo')) return res.end(JSON.stringify(fakeInfo()));
    if (req.url.endsWith('/setWebhook')) { if (failSet) return res.end(JSON.stringify({ ok: false, error_code: 500, description: 'boom' })); webhookUrl = body.url; return res.end(JSON.stringify({ ok: true, result: true })); }
    if (req.url.endsWith('/deleteWebhook')) { webhookUrl = ''; return res.end(JSON.stringify({ ok: true, result: true })); }
    res.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
  });
});
await new Promise((r) => fakeTg.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${fakeTg.address().port}`;

const { server, relay, botA, failover, healthTick } = await import('../server.js');
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
  assert.match(call[0], /^\/botFAKEA\//);
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

test('botA.state is exposed (loop not started in test)', () => { assert.ok(['idle', 'polling', 'error', 'standby'].includes(telegram.state)); });

// ---- #1579 webhook ingestion (Bot A), mode switching (webhook <-> getUpdates on the same token) and dedupe ----
const post = (body, secret = 'wh-secret', path = '/c3bot-relay/telegram/webhook') =>
  fetch(`http://${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret == null ? {} : { 'x-telegram-bot-api-secret-token': secret }) }, body: JSON.stringify(body) });
const tgUpd = (id, mid, from, text, date = 100) => ({ update_id: id, message: { message_id: mid, date, chat: { id: 42, type: 'private' }, from: { id: from }, text } });

test('webhook: wrong or missing secret_token is 401 and ingests nothing; the relay bearer does not substitute', async () => {
  const before = relay.cursor;
  assert.equal((await post(tgUpd(900, 900, 42, 'x'), 'nope')).status, 401);
  assert.equal((await post(tgUpd(900, 900, 42, 'x'), null)).status, 401);
  assert.equal((await fetch(`http://${base}/c3bot-relay/telegram/webhook`, { method: 'POST', headers: auth, body: '{}' })).status, 401);
  assert.equal(relay.cursor, before);
});

test('webhook: a valid post is ingested, reaches /poll, carries source A and the raw update', async () => {
  const after = relay.cursor;
  assert.equal((await post(tgUpd(901, 901, 42, 'reply via webhook'))).status, 200);
  const j = await (await fetch(`http://${base}/c3bot-relay/poll?after=${after}&wait=1`, { headers: auth })).json();
  const ev = j.events.find((e) => e.text === 'reply via webhook');
  assert.equal(ev.source, 'A');
  assert.equal(ev.update.message.text, 'reply via webhook');
});

test('webhook: senders outside the allowlist are dropped but announce chat metadata only', async () => {
  const after = relay.cursor;
  assert.equal((await post(tgUpd(902, 902, 99, 'secret stranger text'))).status, 200);
  const j = await (await fetch(`http://${base}/c3bot-relay/poll?after=${after}&wait=1`, { headers: auth })).json();
  assert.ok(!j.events.some((e) => e.type === 'telegram.message'));
  const meta = j.events.find((e) => e.type === 'telegram.chat');
  assert.ok(meta);
  assert.ok(!JSON.stringify(meta).includes('stranger'));
});

test('dedupe across A and B: same chat/message_id/date from both paths is surfaced once', async () => {
  const after = relay.cursor;
  await post(tgUpd(910, 55, 42, 'same message', 777));            // Bot A webhook
  relay.ingestUpdate(tgUpd(31337, 55, 42, 'same message', 777), 'P'); // getUpdates copy, different update_id
  const j = await (await fetch(`http://${base}/c3bot-relay/poll?after=${after}&wait=1`, { headers: auth })).json();
  assert.equal(j.events.filter((e) => e.text === 'same message').length, 1);
  assert.equal(j.events.find((e) => e.text === 'same message').source, 'A');
  relay.ingestUpdate(tgUpd(31338, 56, 42, 'other message', 777), 'B'); // new message_id is not a duplicate
  assert.equal(relay.since(after).filter((e) => e.text === 'other message').length, 1);
});

test('health: webhook healthy -> polling stays off; state and secrets-free snapshot exposed', async () => {
  const snap = await healthTick({ self: async () => true });
  assert.equal(snap.state, 'webhook');
  assert.equal(webhookUrl, 'https://edge.invalid/c3bot-webhook'); // registered declaratively with setWebhook
  assert.ok(sent.find(([u, b]) => u.endsWith('/setWebhook') && b.secret_token === 'wh-secret'));
  const h = await (await fetch(`http://${base}/c3bot-relay/health`)).json();
  assert.equal(h.ingest.state, 'webhook');
  assert.ok(!JSON.stringify(h).includes('wh-secret') && !JSON.stringify(h).includes('FAKE'));
});

test('mode switch: getWebhookInfo error -> deleteWebhook then Bot A polls; route healthy again -> setWebhook and polling stops', async () => {
  const calls = () => sent.map(([u]) => u.split('/').pop());
  infoMode = 'error';
  const n0 = sent.length;
  assert.equal((await healthTick({ self: async () => true })).state, 'polling');
  assert.ok(calls().slice(n0).includes('deleteWebhook'));
  assert.equal(webhookUrl, '' , 'deleteWebhook cleared the registration');
  assert.equal(failover.polling, true);
  assert.equal((await (await fetch(`http://${base}/c3bot-relay/health`)).json()).ingest.polling, true);
  infoMode = 'ok';
  await healthTick({ self: async () => false });      // route still down: stay in polling
  assert.equal(failover.state, 'polling');
  await healthTick({ self: async () => true });        // 1 good
  assert.equal(failover.state, 'polling');
  const n1 = sent.length;
  assert.equal((await healthTick({ self: async () => true })).state, 'webhook'); // 2 good
  assert.ok(calls().slice(n1).includes('setWebhook'));
  assert.equal(webhookUrl, 'https://edge.invalid/c3bot-webhook');
  assert.equal((await (await fetch(`http://${base}/c3bot-relay/health`)).json()).ingest.polling, false);
});

test('mode switch: Telegram-reported delivery error switches to polling, a polled update is deduped against the webhook copy', async () => {
  infoMode = 'delivery-error';
  assert.equal((await healthTick({ self: async () => true })).state, 'polling');
  infoMode = 'ok';
  const after = relay.cursor;
  await post(tgUpd(920, 77, 42, 'dup across modes', 555));       // arrived by webhook just before the outage
  relay.ingestUpdate(tgUpd(4001, 77, 42, 'dup across modes', 555), 'P'); // re-delivered by getUpdates after deleteWebhook
  assert.equal(relay.since(after).filter((e) => e.text === 'dup across modes').length, 1);
  await healthTick({ self: async () => true }); await healthTick({ self: async () => true });
  assert.equal(failover.state, 'webhook');
});

test('mode switch: a failing setWebhook on the way back keeps polling', async () => {
  infoMode = 'error';
  await healthTick({ self: async () => true });
  assert.equal(failover.state, 'polling');
  infoMode = 'ok'; failSet = true;
  await healthTick({ self: async () => true }); await healthTick({ self: async () => true });
  assert.equal(failover.state, 'polling');
  assert.equal(failover.polling, true);
  failSet = false;
  await healthTick({ self: async () => true }); await healthTick({ self: async () => true });
  assert.equal(failover.state, 'webhook');
});

test('webhook: other POST paths fall through to the bearer gate (route is exact)', async () => {
  assert.equal((await post({}, 'wh-secret', '/c3bot-relay/other')).status, 401); // falls to the bearer gate
});
