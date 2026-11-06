// Token benchmark of the three readable formats on the fixture pages. Prints a table (visible in the CI log) and
// asserts only that every format is non-empty and that the cheapest format is reported; it never assumes an order.
// Tokenizer: an offline approximation of a cl100k-style BPE, not the real vocabulary. Pieces = runs of letters, runs of
// 1-3 digits, single punctuation/symbol characters; a letter run of n characters costs ceil(n / 5) tokens (common
// English words are one token, long ones split); chars/4 is printed beside it as the second estimate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toReadable } from '../readable.js';

export const approxTokens = (s) => {
  let n = 0;
  for (const m of s.matchAll(/[\p{L}]+|\d{1,3}|[^\s\p{L}\d]/gu)) n += /^\p{L}/u.test(m[0]) ? Math.ceil(m[0].length / 5) : 1;
  return n;
};

test('token benchmark: markdown vs json vs xml', () => {
  const rows = [];
  for (const n of ['article', 'wiki', 'docs', 'listing']) {
    const html = readFileSync(new URL(`./fixtures/${n}.html`, import.meta.url), 'utf8');
    const row = { page: n };
    for (const f of ['markdown', 'json', 'xml']) {
      const r = toReadable(html, `https://shop.test/${n}`, { format: f, fetchedAt: '2026-11-06T00:00:00.000Z' });
      assert.ok(r.content.length > 100);
      row[f] = approxTokens(r.content);
      row[`${f}_c4`] = Math.ceil(r.content.length / 4);
    }
    rows.push(row);
  }
  const tot = { markdown: 0, json: 0, xml: 0 };
  console.log('page      md_tok json_tok xml_tok | md_c/4 json_c/4 xml_c/4');
  for (const r of rows) {
    for (const f of Object.keys(tot)) tot[f] += r[f];
    console.log(`${r.page.padEnd(9)} ${String(r.markdown).padStart(6)} ${String(r.json).padStart(8)} ${String(r.xml).padStart(7)} | ${String(r.markdown_c4).padStart(6)} ${String(r.json_c4).padStart(8)} ${String(r.xml_c4).padStart(7)}`);
  }
  const best = Object.entries(tot).sort((a, b) => a[1] - b[1]);
  console.log(`BENCHMARK total tokens ${JSON.stringify(tot)} cheapest=${best[0][0]} order=${best.map((b) => b[0]).join('<')}`);
  assert.ok(best.length === 3);
});
