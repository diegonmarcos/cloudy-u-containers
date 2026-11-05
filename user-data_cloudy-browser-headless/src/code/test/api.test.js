import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CMDS, Sessions, checkBearer, validate, validateRun } from '../api.js';

const fake = () => {
  const calls = [];
  return { calls, newSession: async () => ({}), closeSession: async () => {}, run: async (_h, c) => { calls.push(c.cmd); if (c.cmd === 'wait' && c.ms === 99) await new Promise((r) => setTimeout(r, 200)); return { ok: c.cmd }; } };
};

test('command list matches the shared schema', () => {
  const p = new URL('../../../../../../ab_cloud-libs-shared/libs/headless-api/headless-api.json', import.meta.url);
  let schema;
  try { schema = JSON.parse(readFileSync(p, 'utf8')); } catch { return; } // schema lives in another repo; checked when present
  assert.deepEqual([...CMDS].sort(), Object.keys(schema.commands).sort());
});
test('validate rejects bad commands', () => {
  assert.throws(() => validate({ cmd: 'nope' }), /unknown cmd/);
  assert.throws(() => validate({ cmd: 'open', url: 'file:///etc/passwd' }), /http/);
  assert.throws(() => validate({ cmd: 'wait', selector: 'a', ms: 1 }), /exactly one/);
  assert.throws(() => validate({ cmd: 'click', session: 'bad id!', selector: 'a' }), /session/);
  assert.throws(() => validate({ cmd: 'html', timeoutMs: 999999 }), /timeoutMs/);
  assert.ok(validate({ cmd: 'wait', idle: true }));
});
test('bearer gate fails closed', () => {
  assert.throws(() => checkBearer('Bearer x', ''), /not configured/);
  assert.throws(() => checkBearer(undefined, 't'), /bearer required/);
  assert.throws(() => checkBearer('Bearer nope', 'tttt'), /bad token/);
  checkBearer('Bearer tttt', 'tttt');
});
test('max sessions enforced', async () => {
  const s = new Sessions({ engine: fake(), maxSessions: 2 });
  await s.command({ cmd: 'open', url: 'https://a.test', session: 'a' });
  await s.command({ cmd: 'open', url: 'https://a.test', session: 'b' });
  await assert.rejects(s.command({ cmd: 'open', url: 'https://a.test', session: 'c' }), { code: 'limit' });
  await s.command({ cmd: 'open', url: 'https://a.test', session: 'a' }); // reuse ok
});
test('idle sweep closes sessions', async () => {
  let t = 0;
  const s = new Sessions({ engine: fake(), idleCloseMs: 1000, now: () => t });
  await s.command({ cmd: 'open', url: 'https://a.test', session: 'a' });
  t = 999; assert.deepEqual(await s.sweep(), []);
  t = 1000; assert.deepEqual(await s.sweep(), ['a']);
  await assert.rejects(s.command({ cmd: 'html', session: 'a' }), { code: 'not_found' });
});
test('per-call timeout', async () => {
  const s = new Sessions({ engine: fake(), callTimeoutMs: 50 });
  await s.command({ cmd: 'open', url: 'https://a.test', session: 'a' });
  await assert.rejects(s.command({ cmd: 'wait', ms: 99, session: 'a' }), { code: 'timeout' });
});
test('run steps: sequential, stops on error, reuses session', async () => {
  const s = new Sessions({ engine: fake() });
  const r = await s.runSteps({ steps: [{ cmd: 'open', url: 'https://a.test', session: 'x' }, { cmd: 'text' }, { cmd: 'html', session: 'ghost' }, { cmd: 'text' }] });
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 3);
  assert.equal(r.steps[1].ok, true);
  assert.equal(r.steps[2].error.code, 'not_found');
  assert.throws(() => validateRun({ steps: [] }), /steps/);
});
