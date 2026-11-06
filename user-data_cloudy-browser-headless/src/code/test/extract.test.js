import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { linksFn, scrapeFn } from '../extract.js';

const html = '<html><body><a href="/a">A  one</a><a href="https://other.test/b">B</a><a href="/a">dup</a><a href="mailto:x@y.z">m</a><ul><li class="i" data-id="1">x</li><li class="i" data-id="2">y</li></ul></body></html>';
const withDom = (f) => {
  const w = new JSDOM(html, { url: 'https://site.test/p' }).window;
  Object.assign(globalThis, { document: w.document, location: w.location, getComputedStyle: w.getComputedStyle.bind(w) });
  try { return f(); } finally { delete globalThis.document; delete globalThis.location; delete globalThis.getComputedStyle; }
};

test('links: absolute, deduplicated, http(s) only, same-origin filter', () => {
  const all = withDom(() => linksFn({}));
  assert.deepEqual(all.links.map((l) => l.href), ['https://site.test/a', 'https://other.test/b']);
  assert.equal(all.links[0].text, 'A one');
  assert.deepEqual(withDom(() => linksFn({ sameOrigin: true })).links.map((l) => l.href), ['https://site.test/a']);
});
test('scrape: text, html and requested attrs per element, limit, bad selector reported', () => {
  const r = withDom(() => scrapeFn({ elements: [{ selector: 'li.i', attrs: ['data-id', 'nope'] }, { selector: '!!' }], limit: 1 }));
  assert.equal(r.results[0].count, 2);
  assert.equal(r.results[0].items.length, 1);
  assert.deepEqual(r.results[0].items[0].attrs, { 'data-id': '1' });
  assert.equal(r.results[0].items[0].text, 'x');
  assert.match(r.results[0].items[0].html, /<li/);
  assert.ok(r.results[1].error);
});
