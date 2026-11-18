// Restart safety (#1795): events, cursor and dedupe keys survive a new Relay on the same state file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Relay } from '../relay.js';

const upd = (id, text) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 42 }, from: { id: 42 }, text } });

test('a restarted relay keeps unread messages, the cursor and dedupe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-')); const f = join(dir, 'state', 'relay-state.json');
  const a = new Relay({ allowedFrom: ['42'], statePath: f });
  a.ingestUpdate(upd(1, 'hello')); a.ingestUpdate(upd(2, 'second')); a.flush();
  assert.ok(existsSync(f)); assert.equal(a.persist.error, null);
  const b = new Relay({ allowedFrom: ['42'], statePath: f });
  assert.equal(b.persist.loaded, true); assert.equal(b.cursor, 2);
  assert.deepEqual(b.since(0).map((e) => e.text), ['hello', 'second']);
  assert.equal(b.ingestUpdate(upd(2, 'second')), null, 'a redelivered update stays a duplicate');
  assert.equal(b.ingestUpdate(upd(3, 'third')).seq, 3, 'seq continues, never reused');
});

test('the ring bound holds across a reload', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'relay-')), 's.json');
  const a = new Relay({ allowedFrom: ['42'], statePath: f, bufferSize: 3 });
  for (let i = 1; i <= 5; i++) a.ingestUpdate(upd(i, `m${i}`)); a.flush();
  const b = new Relay({ allowedFrom: ['42'], statePath: f, bufferSize: 3 });
  assert.deepEqual(b.since(0).map((e) => e.seq), [3, 4, 5]); assert.equal(b.cursor, 5);
});

test('a corrupt file starts empty and reports it; no statePath means memory only', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'relay-')), 's.json'); writeFileSync(f, '{not json');
  const r = new Relay({ statePath: f }); assert.equal(r.cursor, 0); assert.match(r.persist.error, /^load:/);
  const m = new Relay(); m.publish('x', {}); m.flush(); assert.equal(m.persist.enabled, false);
});

test('an unwritable state dir keeps the relay running and reports the error', { skip: process.getuid?.() === 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-')); chmodSync(dir, 0o500);
  const r = new Relay({ statePath: join(dir, 's.json') }); r.publish('x', { a: 1 }); r.flush();
  assert.match(r.persist.error, /^save:/); assert.equal(r.since(0).length, 1);
});
