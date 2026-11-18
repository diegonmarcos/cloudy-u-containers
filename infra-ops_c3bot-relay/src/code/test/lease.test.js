// Lease unit tests + HTTP routes (#1795): one winner, renew, expiry, release, validation, bearer gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Lease } from '../lease.js';

test('first claimer wins, a second session is refused until expiry', () => {
  let t = 1000; const l = new Lease({ now: () => t });
  const a = l.claim('sess-a', 60); assert.equal(a.granted, true); assert.equal(a.holder, 'sess-a');
  const b = l.claim('sess-b', 60); assert.equal(b.granted, false); assert.equal(b.holder, 'sess-a'); assert.equal(b.retryInS, 60);
  t += 59_999; assert.equal(l.claim('sess-b', 60).granted, false);
  t += 1; const b2 = l.claim('sess-b', 60); assert.equal(b2.granted, true); assert.equal(b2.holder, 'sess-b'); assert.equal(b2.renewed, false);
});

test('the holder renews and keeps the lease', () => {
  let t = 0; const l = new Lease({ now: () => t });
  l.claim('a', 60); t = 50_000; const r = l.claim('a', 60);
  assert.equal(r.granted, true); assert.equal(r.renewed, true); assert.equal(r.expiresAt, 110_000);
  t = 100_000; assert.equal(l.claim('b', 60).granted, false); assert.equal(l.snapshot().renewals, 1);
});

test('release frees the lease only for the holder', () => {
  const l = new Lease();
  l.claim('a'); assert.equal(l.release('b').released, false); assert.equal(l.snapshot().holder, 'a');
  assert.equal(l.release('a').released, true); assert.equal(l.snapshot().holder, null); assert.equal(l.claim('b').granted, true);
});

test('ttl is clamped and defaulted; bad session names are rejected', () => {
  let t = 0; const l = new Lease({ now: () => t, minTtlS: 30, maxTtlS: 3600, defaultTtlS: 900 });
  assert.equal(l.claim('a', 1).ttl, 30); assert.equal(l.claim('a', 99999).ttl, 3600); assert.equal(l.claim('a').ttl, 900);
  for (const bad of [undefined, '', 'has space', 'x'.repeat(129), 7]) assert.throws(() => l.claim(bad), /session/);
});

test('concurrent claimers: exactly one of many wins', () => {
  const l = new Lease(); const r = Array.from({ length: 20 }, (_, i) => l.claim(`s${i}`, 60));
  assert.equal(r.filter((x) => x.granted).length, 1); assert.equal(r[0].granted, true);
});

test('HTTP: /claim, /release, GET /claim are bearer-gated and /health hides the holder', async () => {
  process.env.NODE_ENV = 'test'; process.env.C3BOT_RELAY_TOKEN = 'secret-relay-token'; process.env.BASE_PATH = '/c3bot-relay';
  const { server } = await import('../server.js');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const u = (p) => `http://127.0.0.1:${server.address().port}/c3bot-relay${p}`;
  const auth = { authorization: 'Bearer secret-relay-token', 'content-type': 'application/json' };
  const post = (p, b, h = auth) => fetch(u(p), { method: 'POST', headers: h, body: JSON.stringify(b) });
  try {
    assert.equal((await post('/claim', { session: 'x' }, { 'content-type': 'application/json' })).status, 401);
    const a = await (await post('/claim', { session: 'sess-a', ttl: 60 })).json(); assert.equal(a.granted, true);
    const b = await (await post('/claim', { session: 'sess-b', ttl: 60 })).json(); assert.equal(b.granted, false); assert.equal(b.holder, 'sess-a');
    assert.equal((await post('/claim', { session: 'bad name' })).status, 400);
    const g = await (await fetch(u('/claim'), { headers: auth })).json(); assert.equal(g.holder, 'sess-a');
    const h = await (await fetch(u('/health'))).json(); assert.equal(h.lease.held, true); assert.ok(!JSON.stringify(h).includes('sess-a'));
    assert.equal((await (await post('/release', { session: 'sess-a' })).json()).released, true);
    assert.equal((await (await post('/claim', { session: 'sess-b' })).json()).granted, true);
  } finally { server.closeAllConnections?.(); server.close(); }
});
