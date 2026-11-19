// Unit tests for email-forwarder.js (run: node src/test-email-forwarder.mjs, exit 0 = pass).
// Mocks global fetch; no network. Proves the leg/acceptance contract:
//   Google + Maddy run in parallel; accept if either lands; reject only if both
//   fail; each failed leg retries in the background and logs its own lost-leg line;
//   live.com fallback is unchanged; there is no worker->Stalwart leg (maddy's
//   stalwart_queue feeds Stalwart, a second leg would duplicate).
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import worker, { _retry } from './email-forwarder.js';

_retry.sleep = async () => {};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  GOOGLE_EMAIL: 'me@x.test', GOOGLE_SA_EMAIL: 'sa@x.test',
  GOOGLE_SA_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  HTTP_TO_SMTP_PROXY_API_URL: 'https://proxy.test/mail/http-to-smtp',
  C3_HEALTH_URL: 'https://health.test/', C3_BEARER_TOKEN: 't',
  HTTP_TO_SMTP_PROXY_API_KEY: 'k', BACKUP_EMAIL: 'bk@x.test',
};

// behaviour: { google: n failures before success (Infinity = never), maddy: same, healthy }
function setup({ google = 0, maddy = 0, healthy = true, googleThrows = false } = {}) {
  const calls = { google: 0, maddy: 0, other: [] };
  globalThis.fetch = async (url) => {
    url = String(url);
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'a' });
    if (url.includes('gmail.googleapis.com')) {
      if (googleThrows) throw new Error('boom');
      return ++calls.google > google ? Response.json({ id: '1' }) : new Response('err', { status: 500 });
    }
    if (url === env.HTTP_TO_SMTP_PROXY_API_URL) {
      return ++calls.maddy > maddy ? Response.json({ status: 'delivered' }) : new Response('err', { status: 502 });
    }
    if (url === env.C3_HEALTH_URL) return healthy ? Response.json({ status: 'healthy' }) : new Response('x', { status: 500 });
    calls.other.push(url);
    return new Response('?', { status: 404 });
  };
  const logs = [];
  console.error = (...a) => logs.push(a.join(' '));
  console.warn = () => {}; console.log = () => {};
  return { calls, logs };
}

async function run(opts) {
  const { calls, logs } = setup(opts);
  const pending = [];
  const out = { rejected: null, forwarded: false };
  const message = {
    from: 'a@s.test', to: 'me@x.test',
    headers: new Map([['Message-ID', '<id1@s.test>']]),
    raw: new Response('Subject: hi\r\n\r\nbody').body,
    setReject: (r) => { out.rejected = r; },
    forward: async () => { out.forwarded = true; },
  };
  await worker.email(message, env, { waitUntil: (p) => pending.push(p) });
  const inline = { ...calls };
  await Promise.all(pending);
  return { ...out, inline, calls, logs };
}

const tests = {
  async 'both ok: accepted, no retries, no loss logs'() {
    const r = await run();
    assert.equal(r.rejected, null);
    assert.deepEqual([r.calls.google, r.calls.maddy], [1, 1]);
    assert.equal(r.logs.filter((l) => /LEG_LOST/.test(l)).length, 0);
  },
  async 'legs run in parallel: both attempted inline even if one fails'() {
    const r = await run({ google: Infinity });
    assert.equal(r.inline.google, 1); assert.equal(r.inline.maddy, 1);
  },
  async 'google down, maddy ok: accepted; google retried then GOOGLE_LEG_LOST'() {
    const r = await run({ google: Infinity });
    assert.equal(r.rejected, null);
    assert.equal(r.calls.google, 3);               // 1 inline + 2 background
    assert.ok(r.logs.some((l) => /^GOOGLE_LEG_LOST target=google message_id=<id1@s.test>/.test(l)));
    assert.ok(!r.logs.some((l) => /MESH_LEG_LOST/.test(l)));
  },
  async 'maddy down, google ok: accepted; MESH_LEG_LOST target=maddy'() {
    const r = await run({ maddy: Infinity });
    assert.equal(r.rejected, null);
    assert.equal(r.calls.maddy, 3);
    assert.ok(r.logs.some((l) => /^MESH_LEG_LOST target=maddy message_id=<id1@s.test> from=a@s.test to=me@x.test status=HTTP 502/.test(l)));
  },
  async 'maddy transient: recovered by background retry, nothing logged lost'() {
    const r = await run({ maddy: 1 });
    assert.equal(r.rejected, null);
    assert.equal(r.calls.maddy, 2);
    assert.equal(r.logs.filter((l) => /LEG_LOST/.test(l)).length, 0);
  },
  async 'google transient: recovered by background retry'() {
    const r = await run({ google: 2 });
    assert.equal(r.calls.google, 3);
    assert.equal(r.logs.filter((l) => /LEG_LOST/.test(l)).length, 0);
  },
  async 'both down: rejected so the sender retries'() {
    const r = await run({ google: Infinity, maddy: Infinity });
    assert.match(r.rejected, /both failed/);
  },
  async 'google leg throwing does not lose the maddy result'() {
    const r = await run({ googleThrows: true });
    assert.equal(r.rejected, null);
  },
  async 'unhealthy: live.com fallback still forwards'() {
    const r = await run({ healthy: false });
    assert.equal(r.forwarded, true); assert.equal(r.rejected, null);
  },
  async 'healthy: no live.com forward'() {
    assert.equal((await run()).forwarded, false);
  },
  async 'no worker->Stalwart leg (would duplicate; maddy queue feeds it)'() {
    const r = await run({ maddy: Infinity });
    assert.deepEqual(r.calls.other, []);
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); process.stdout.write(`ok:   ${name}\n`); }
  catch (e) { failed++; process.stdout.write(`FAIL: ${name}\n  ${e.message}\n`); }
}
process.stdout.write(failed ? `FAILED (${failed})\n` : 'PASS\n');
process.exit(failed ? 1 : 0);
