import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toReadable, cleanUrl } from '../readable.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), 'utf8');
const AT = '2026-11-06T00:00:00.000Z';
const read = (n, o = {}) => toReadable(fx(n), `https://shop.test/${n}`, { fetchedAt: AT, ...o });
const HTML_TAG = /<\/?[a-z][a-z0-9]*[\s>/]/i;

test('markdown: headings, lists, tables, links and code survive', () => {
  const r = read('article');
  assert.match(r.markdown, /^---\ntitle: "[^"]+"\nsource: "https:\/\/shop.test\/article"\nfetched_at: "2026-11-06T00:00:00.000Z"\n---/);
  assert.match(r.markdown, /^# Tide Tables Explained$/m);
  assert.match(r.markdown, /^## Reading the table$/m);
  assert.match(r.markdown, /^- Find your harbour$/m);
  assert.match(r.markdown, /\| Day \| High water \| Height \(m\) \|\n\| --- \| --- \| --- \|\n\| Mon \| 06:12 \| 4.1 \|/);
  assert.match(r.markdown, /\[full guide\]\(https:\/\/example.org\/guide\?id=7\)/);
  assert.match(r.markdown, /```js\nconst h = rows.map/);
  assert.equal(r.tables.length, 1);
  assert.equal(r.meta.lang, 'en');
});

test('boilerplate, scripts, styles, cookie banners, ads, tracking params and base64 images are removed', () => {
  const r = read('article');
  for (const bad of ['cookies', 'BUY NOW', 'Copyright', 'window.track', 'color:red', 'utm_source', 'fbclid', 'base64', 'iVBOR']) {
    assert.ok(!r.markdown.includes(bad), `markdown still has ${bad}`);
  }
  assert.ok(!r.markdown.includes('/about'), 'nav link removed');
});

test('no HTML tags in any format output', () => {
  for (const n of ['article', 'wiki', 'docs', 'listing']) {
    const r = read(n);
    assert.ok(!HTML_TAG.test(r.markdown), `${n} markdown has html`);
  }
  // xml is markup by design, but must carry no HTML tags of the page: only the doc/meta/s/ul/i/table/r/c/a vocabulary
  const x = read('article', { format: 'xml' }).content;
  const tags = new Set([...x.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]));
  assert.deepEqual([...tags].sort(), ['a', 'c', 'doc', 'i', 'meta', 's', 'table', 'r', 'ul'].sort());
});

test('a table with no header row still renders as a markdown table', () => {
  const r = read('docs');
  assert.match(r.markdown, /\| Flag \| Meaning \|\n\| --- \| --- \|\n\| --json \| Print JSON \|/);
  assert.ok(!r.markdown.includes('mailto:'));
});

test('json: compact, no nulls, tables round-trip', () => {
  const r = read('wiki', { format: 'json' });
  assert.ok(!/\n|\s{2}/.test(r.content), 'minified');
  assert.ok(!r.content.includes('null'));
  const d = JSON.parse(r.content);
  assert.deepEqual(Object.keys(d.meta).sort(), ['fetched_at', 'lang', 'title', 'url'].concat(d.meta.excerpt ? ['excerpt'] : []).sort());
  assert.deepEqual(d.tables[0].headers, ['Tower', 'Country', 'Height (m)']);
  assert.deepEqual(d.tables[0].rows[2], ['Cordouan', 'France', '68']);
  assert.ok(d.sections.some((s) => s.h === 'History' && s.level === 2));
  assert.deepEqual(d.links.map((l) => l.href), ['https://shop.test/wiki/Lens', 'https://shop.test/wiki/Buoy']);
  // round trip: json table -> markdown table equals the markdown output's table
  const md = read('wiki').markdown;
  const rows = [d.tables[0].headers, ...d.tables[0].rows].map((c) => `| ${c.join(' | ')} |`);
  for (const line of rows) assert.ok(md.includes(line), `markdown lacks ${line}`);
});

test('xml: compact, short names, tables round-trip', () => {
  const r = read('listing', { format: 'xml' });
  assert.ok(r.content.startsWith('<doc><meta '));
  assert.ok(!/>\s+</.test(r.content), 'no whitespace between tags');
  const t = /<table>(.*?)<\/table>/.exec(r.content)[1];
  const rows = [...t.matchAll(/<r( h="1")?>(.*?)<\/r>/g)].map((m) => [...m[2].matchAll(/<c>(.*?)<\/c>/g)].map((c) => c[1]));
  const j = JSON.parse(read('listing', { format: 'json' }).content).tables[0];
  assert.deepEqual(rows, [j.headers, ...j.rows]);
  assert.match(r.content, /<s h="Used bikes" l="1">/);
  assert.match(r.content, /<a href="https:\/\/shop.test\/sizing">sizing page<\/a>/);
});

test('size cap holds and the cursor continues without loss or overlap (markdown)', () => {
  const big = `<html><body><main><h1>Long</h1>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph number ${i} carries enough words to count as real prose for the extractor to keep.</p>`).join('')}</main></body></html>`;
  let out = '';
  let cursor;
  let pages = 0;
  do {
    const r = toReadable(big, 'https://t.test/long', { fetchedAt: AT, maxChars: 3000, cursor });
    assert.ok(r.markdown.length <= 3000 + 400, `page ${pages} is ${r.markdown.length}`); // + frontmatter on page 1
    out += r.markdown.replace(/^---[\s\S]*?---\n\n/, '') + '\n\n';
    cursor = r.next;
    pages++;
  } while (cursor && pages < 100);
  assert.ok(pages > 3);
  for (let i = 0; i < 400; i++) assert.equal(out.split(`Paragraph number ${i} `).length - 1, 1, `paragraph ${i}`);
});

test('size cap and cursor for json blocks', () => {
  const big = `<html><body><main><h1>Long</h1>${Array.from({ length: 200 }, (_, i) => `<h2>Part ${i}</h2><p>Part ${i} has a few sentences of prose so the section is not dropped as empty by the filter.</p>`).join('')}</main></body></html>`;
  let seen = 0;
  let cursor;
  let pages = 0;
  do {
    const r = toReadable(big, 'https://t.test/long', { fetchedAt: AT, format: 'json', maxChars: 2000, cursor });
    assert.ok(r.content.length <= 2400);
    seen += (JSON.parse(r.content).sections || []).length;
    cursor = r.next;
    pages++;
  } while (cursor && pages < 100);
  assert.ok(seen >= 200, `seen ${seen}`);
});

test('cleanUrl strips tracking and rejects non-http', () => {
  assert.equal(cleanUrl('/a?x=1&utm_medium=m&gclid=z', 'https://h.test/b'), 'https://h.test/a?x=1');
  assert.equal(cleanUrl('javascript:alert(1)', 'https://h.test/'), null);
});
