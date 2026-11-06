import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, CMDS, EXT_CMDS } from '../api.js';
import { runOcr, normalize, sniffMime, targetWidth, paddleRecognize, OCR_DEFAULTS } from '../ocr.js';
import { imagesFn } from '../extract.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32)]);
const mkRes = (status, body, type = 'image/png') => ({ ok: () => status < 400, status: () => status, body: async () => body, headers: () => ({ 'content-type': type }) });
const harness = ({ items, responses = {}, shot = png } = {}) => {
  const closed = [];
  const scratch = {
    evaluate: async (fn, arg) => (typeof arg === 'string' && arg.startsWith('data:') ? (arg.includes('YmFk') ? { w: 0, h: 0 } : { w: 600, h: 800 }) : undefined),
    locator: () => ({ screenshot: async () => png }),
    close: async () => closed.push('scratch'),
  };
  const page = {
    url: () => 'https://x.test/p', title: async () => 'T',
    evaluate: async (fn, arg) => (fn === imagesFn ? { total: items.length, items: items.filter((i) => i.width >= arg.minWidth && i.height >= arg.minHeight) } : { w: 1280, h: 900 }),
    screenshot: async () => shot,
    waitForLoadState: async () => {}, waitForTimeout: async () => {},
  };
  const ctx = { newPage: async () => scratch, request: { get: async (u) => { const r = responses[u]; if (!r) throw new Error('net down'); return r; } } };
  return { page, ctx, closed };
};
const factory = (texts) => async () => { let n = 0; return { recognize: async () => texts[n++] || { text: '', confidence: 0 }, close: async () => { factory.closed = true; } }; };

test('ocr is a container extension: not in the shared command list, validated', () => {
  assert.ok(!CMDS.includes('ocr') && EXT_CMDS.includes('ocr'));
  assert.ok(validate({ cmd: 'ocr', session: 's1', engine: 'paddle', minWidth: 100, minHeight: 100, includeScreenshot: true, lang: 'eng+fra', maxImages: 5, escalateBelow: 55 }));
  for (const bad of [{ engine: 'x' }, { minWidth: 0 }, { maxImages: 51 }, { lang: 'klingon' }, { lang: 'eng+xxx' }, { includeScreenshot: 'yes' }, { escalateBelow: 101 }]) assert.throws(() => validate({ cmd: 'ocr', ...bad }), /bad|engine|min|max|lang|boolean|escalate|0\.\./i);
});
test('defaults', () => {
  const o = normalize({});
  assert.equal(o.engine, 'tesseract'); assert.equal(o.minWidth, 150); assert.equal(o.lang, 'eng'); assert.equal(o.escalateBelow, 0); assert.equal(OCR_DEFAULTS.maxImages, 12);
});
test('sniffMime and targetWidth', () => {
  assert.equal(sniffMime(png, ''), 'image/png');
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'application/octet-stream'), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from('<svg xmlns="x"></svg>'), ''), 'image/svg+xml');
  assert.equal(sniffMime(png, 'image/webp; charset=x'), 'image/webp');
  assert.equal(targetWidth(600), 1200); assert.equal(targetWidth(1000), 1500); assert.equal(targetWidth(5000), 3000);
});
test('ocr: structured list, size filter, per-image failure does not fail the call', async () => {
  const items = [
    { src: 'https://x.test/a.png', alt: 'a', width: 600, height: 800 },
    { src: 'https://x.test/tiny.png', alt: 'icon', width: 32, height: 32 },
    { src: 'https://x.test/gone.png', alt: 'g', width: 400, height: 400 },
    { src: 'data:image/png;base64,AAAA', alt: 'd', width: 300, height: 300 },
    { src: 'data:text/plain,bad', alt: 'b', width: 300, height: 300 },
  ];
  const h = harness({ items, responses: { 'https://x.test/a.png': mkRes(200, png), 'https://x.test/gone.png': mkRes(404, Buffer.alloc(0)) } });
  const r = await runOcr(h, { cmd: 'ocr' }, 30000, { factory: factory([{ text: 'Contents Chapter 1', confidence: 91 }, { text: 'smudge', confidence: 30 }]) });
  assert.equal(r.images_found, 4); assert.equal(r.images_total, 5);
  assert.equal(r.images_ocr, 2); assert.equal(r.images_failed, 2);
  const [a, gone, d, bad] = r.results;
  assert.deepEqual([a.src, a.alt, a.width, a.height, a.ocr_text, a.confidence, a.engine], ['https://x.test/a.png', 'a', 600, 800, 'Contents Chapter 1', 91, 'tesseract']);
  assert.equal(a.low_confidence, undefined);
  assert.equal(gone.error.code, 'fetch_failed');
  assert.equal(d.low_confidence, true); assert.equal(d.ocr_text, 'smudge');
  assert.equal(bad.error.code, 'bad_image');
  assert.equal(r.text, 'Contents Chapter 1\n\nsmudge');
  assert.deepEqual(h.closed, ['scratch']);
});
test('ocr: no images gives an empty result and never loads the model', async () => {
  let made = 0;
  const r = await runOcr(harness({ items: [] }), { cmd: 'ocr' }, 30000, { factory: async () => { made++; } });
  assert.equal(made, 0); assert.deepEqual([r.images_found, r.results, r.text], [0, [], '']);
});
test('ocr: maxImages caps and flags truncated', async () => {
  const items = [1, 2, 3].map((i) => ({ src: `https://x.test/${i}.png`, alt: '', width: 500, height: 500 }));
  const responses = Object.fromEntries(items.map((i) => [i.src, mkRes(200, png)]));
  const r = await runOcr(harness({ items, responses }), { cmd: 'ocr', maxImages: 2 }, 30000, { factory: factory([{ text: 'a', confidence: 90 }, { text: 'b', confidence: 90 }]) });
  assert.equal(r.results.length, 2); assert.equal(r.truncated, true); assert.equal(r.images_found, 3);
});
test('ocr: includeScreenshot adds a screenshot entry even without images', async () => {
  const r = await runOcr(harness({ items: [] }), { cmd: 'ocr', includeScreenshot: true }, 30000, { factory: factory([{ text: 'baked into canvas', confidence: 88 }]) });
  assert.equal(r.results.length, 1); assert.equal(r.results[0].kind, 'screenshot'); assert.equal(r.text, 'baked into canvas');
});
test('ocr: time budget skips the remaining images instead of overrunning', async () => {
  const items = [1, 2].map((i) => ({ src: `https://x.test/${i}.png`, alt: '', width: 500, height: 500 }));
  const responses = Object.fromEntries(items.map((i) => [i.src, mkRes(200, png)]));
  let t = 0; const now = () => (t += 1000);
  const r = await runOcr(harness({ items, responses }), { cmd: 'ocr' }, 1000, { factory: factory([]), now });
  assert.equal(r.images_failed, 2); assert.equal(r.results[0].error.code, 'timeout');
});
test('paddle: not configured is a per-image error; configured sidecar is used; escalation is opt-in', async () => {
  await assert.rejects(paddleRecognize(png, 'eng', { env: {} }), /not configured/);
  const f = async (u, init) => { assert.equal(u, 'http://pp:8/ocr'); assert.equal(init.headers.authorization, 'Bearer t'); return { ok: true, json: async () => ({ text: ' hello ', confidence: 97.26 }) }; };
  assert.deepEqual(await paddleRecognize(png, 'eng', { env: { PADDLE_OCR_URL: 'http://pp:8/', PADDLE_OCR_TOKEN: 't' }, f }), { text: 'hello', confidence: 97.3 });
  const items = [{ src: 'https://x.test/a.png', alt: '', width: 500, height: 500 }];
  const responses = { 'https://x.test/a.png': mkRes(200, png) };
  const paddle = async () => ({ text: 'better', confidence: 95 });
  const off = await runOcr(harness({ items, responses }), { cmd: 'ocr' }, 30000, { factory: factory([{ text: 'bad', confidence: 40 }]), paddle });
  assert.equal(off.results[0].engine, 'tesseract');
  const on = await runOcr(harness({ items, responses }), { cmd: 'ocr', escalateBelow: 60 }, 30000, { factory: factory([{ text: 'bad', confidence: 40 }]), paddle });
  assert.deepEqual([on.results[0].engine, on.results[0].ocr_text, on.results[0].escalated_from], ['paddle', 'better', 'tesseract']);
  const unconf = await runOcr(harness({ items, responses }), { cmd: 'ocr', engine: 'paddle' }, 30000, { factory: factory([]), paddle: (b, l) => paddleRecognize(b, l, { env: {} }) });
  assert.equal(unconf.results[0].error.code, 'unsupported'); assert.equal(unconf.images_failed, 1);
});
