// ocr command of cloudy-browser-headless: render the page, enumerate its <img> above a size threshold, download each, OCR it, and return a
// structured list (plus an entry for the rendered screenshot when asked). Default engine: Tesseract LSTM through tesseract.js (WebAssembly, no system
// package; the language data ships in the image through the @tesseract.js-data/* npm packages, nothing is downloaded at run time). Opt-in engine
// "paddle": an HTTP sidecar (PADDLE_OCR_URL, scaffold in ../sidecar-paddle), not shipped by default. Pure of Playwright: the page and context are
// injected, the OCR engines are injectable, so the logic is unit-tested without a browser or a model.
import { createRequire } from 'node:module';
import { mkdirSync, symlinkSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { imagesFn } from './extract.js';

export const OCR_ENGINES = ['tesseract', 'paddle'];
export const OCR_LANGS = ['eng', 'fra', 'deu', 'spa', 'ita', 'por']; // bundled traineddata (Dockerfile deps in package.json)
export const OCR_DEFAULTS = { engine: 'tesseract', minWidth: 150, minHeight: 150, maxImages: 12, lang: 'eng', lowConfidence: 60, escalateBelow: 0 };
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40e6;
export const SCREENSHOT_MAX_HEIGHT = 6000;
export const LANG_RE = /^[a-z]{3}(\+[a-z]{3}){0,2}$/;

export class OcrError extends Error { constructor(code, message) { super(message); this.code = code; } }

/** Options with defaults applied (validation is api.js validate). */
export function normalize(c) {
  const d = OCR_DEFAULTS;
  return {
    engine: c.engine || d.engine, minWidth: c.minWidth ?? d.minWidth, minHeight: c.minHeight ?? d.minHeight, maxImages: c.maxImages ?? d.maxImages,
    lang: c.lang || d.lang, includeScreenshot: !!c.includeScreenshot, fullPage: c.fullPage !== false, escalateBelow: c.escalateBelow ?? d.escalateBelow,
    lowConfidence: c.lowConfidence ?? d.lowConfidence,
  };
}

// ───────────────────────── engines ─────────────────────────
let langDir;
/** One directory holding <lang>.traineddata.gz for every bundled language (symlinks into the npm packages; copies when links are refused). */
export function ensureLangDir(require = createRequire(import.meta.url)) {
  if (langDir) return langDir;
  const dir = path.join(tmpdir(), 'ocr-langdata');
  mkdirSync(dir, { recursive: true });
  for (const l of OCR_LANGS) {
    const dst = path.join(dir, `${l}.traineddata.gz`);
    if (existsSync(dst)) continue;
    const src = path.join(path.dirname(require.resolve(`@tesseract.js-data/${l}`)), '4.0.0_best_int', `${l}.traineddata.gz`);
    try { symlinkSync(src, dst); } catch { copyFileSync(src, dst); }
  }
  return (langDir = dir);
}

/** Tesseract (LSTM only, OEM 1) worker factory: returns { recognize(buf) -> {text, confidence}, close() }. One worker per call, terminated after it. */
export async function tesseractFactory(lang) {
  const { createWorker } = await import('tesseract.js');
  const dir = ensureLangDir();
  const w = await createWorker(lang, 1, { langPath: dir, gzip: true, cachePath: dir, cacheMethod: 'none', logger: () => {} });
  return {
    async recognize(buf) {
      const { data } = await w.recognize(buf);
      return { text: String(data.text || '').trim(), confidence: Math.round((Number(data.confidence) || 0) * 10) / 10 };
    },
    async close() { await w.terminate().catch(() => {}); },
  };
}

/** PaddleOCR through an HTTP sidecar: POST {PADDLE_OCR_URL}/ocr {image_base64, lang} -> {text, confidence 0..100}. Bearer PADDLE_OCR_TOKEN when set. */
export async function paddleRecognize(buf, lang, { env = process.env, f = fetch } = {}) {
  const base = (env.PADDLE_OCR_URL || '').replace(/\/+$/, '');
  if (!base) throw new OcrError('unsupported', 'paddle engine not configured (set PADDLE_OCR_URL to a PaddleOCR sidecar; see sidecar-paddle, not shipped by default)');
  const r = await f(`${base}/ocr`, { method: 'POST', headers: { 'content-type': 'application/json', ...(env.PADDLE_OCR_TOKEN ? { authorization: `Bearer ${env.PADDLE_OCR_TOKEN}` } : {}) }, body: JSON.stringify({ image_base64: buf.toString('base64'), lang }), signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new OcrError('internal', `paddle sidecar HTTP ${r.status}`);
  const j = await r.json();
  return { text: String(j.text || '').trim(), confidence: Math.round((Number(j.confidence) || 0) * 10) / 10 };
}

// One OCR job at a time per container (the wasm worker holds a few hundred MB; the container is capped at 2G with Chromium inside).
let tail = Promise.resolve();
export const exclusive = (fn) => { const run = tail.then(fn, fn); tail = run.then(() => {}, () => {}); return run; };

// ───────────────────────── image bytes ─────────────────────────
const MIME_BY_MAGIC = [[[0x89, 0x50, 0x4e, 0x47], 'image/png'], [[0xff, 0xd8, 0xff], 'image/jpeg'], [[0x47, 0x49, 0x46, 0x38], 'image/gif'], [[0x42, 0x4d], 'image/bmp']];
export function sniffMime(buf, hinted) {
  if (hinted && /^image\//.test(hinted) && hinted !== 'image/octet-stream') return hinted.split(';')[0].trim();
  for (const [sig, mime] of MIME_BY_MAGIC) if (sig.every((b, i) => buf[i] === b)) return mime;
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('utf8', 0, 512).includes('<svg')) return 'image/svg+xml';
  if (buf.length > 12 && buf.toString('latin1', 4, 12).startsWith('ftypavif')) return 'image/avif';
  return 'image/png';
}

function parseDataUrl(u) {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(u);
  if (!m) throw new OcrError('bad_image', 'malformed data URL');
  const buf = /;base64/i.test(m[2]) ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  return { buf, mime: m[1] };
}

/** Image bytes of a src: data: decoded, blob: read inside the page, http(s) through the browser context (cookies, redirects, referer). */
export async function fetchImage({ page, ctx }, src, { timeout = 15000, maxBytes = MAX_IMAGE_BYTES } = {}) {
  let out;
  if (src.startsWith('data:')) out = parseDataUrl(src);
  else if (src.startsWith('blob:')) {
    const u = await page.evaluate(async (b) => { const blob = await (await fetch(b)).blob(); return new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); }); }, src);
    out = parseDataUrl(u);
  } else if (/^https?:\/\//i.test(src)) {
    const r = await ctx.request.get(src, { timeout, maxRedirects: 5, headers: { referer: page.url() } });
    if (!r.ok()) throw new OcrError('fetch_failed', `HTTP ${r.status()}`);
    out = { buf: await r.body(), mime: (r.headers()['content-type'] || '') };
  } else throw new OcrError('bad_image', `unsupported src scheme`);
  if (!out.buf.length) throw new OcrError('bad_image', 'empty image');
  if (out.buf.length > maxBytes) throw new OcrError('too_large', `image is ${out.buf.length} bytes (cap ${maxBytes})`);
  return { buf: out.buf, mime: sniffMime(out.buf, out.mime) };
}

/** Target render width: small images are enlarged (OCR wants text roughly 30 px tall), big ones capped. */
export const targetWidth = (w) => (w < 750 ? w * 2 : w < 1500 ? 1500 : Math.min(w, 3000));

/** Flatten any browser-decodable image (png jpeg gif webp avif svg bmp, transparency included) onto white, scaled for OCR, as PNG, using a scratch page. */
export async function renderForOcr(scratch, { buf, mime }) {
  const url = `data:${mime};base64,${buf.toString('base64')}`;
  const dim = await scratch.evaluate(async (u) => {
    document.body.style.cssText = 'margin:0;background:#fff';
    document.body.innerHTML = '<div id="o" style="display:inline-block;background:#fff"><img id="i" style="display:block"></div>';
    const im = document.getElementById('i');
    im.src = u;
    try { await im.decode(); } catch { return { w: 0, h: 0 }; }
    return { w: im.naturalWidth, h: im.naturalHeight };
  }, url);
  if (!dim.w || !dim.h) throw new OcrError('bad_image', 'not a decodable image');
  if (dim.w * dim.h > MAX_IMAGE_PIXELS) throw new OcrError('too_large', `${dim.w}x${dim.h} px exceeds ${MAX_IMAGE_PIXELS} px`);
  const tw = targetWidth(dim.w);
  await scratch.evaluate((w) => { document.getElementById('i').style.width = `${w}px`; }, tw);
  const png = await scratch.locator('#o').screenshot({ type: 'png', timeout: 20000 });
  return { png, width: dim.w, height: dim.h };
}

// ───────────────────────── the command ─────────────────────────
/**
 * @param h      session handle { page, ctx }
 * @param c      validated ocr command
 * @param budget milliseconds this call may use (the command timeout); remaining images are reported as skipped instead of overrunning it
 * @param deps   { factory(lang), paddle(buf, lang), now }
 */
export async function runOcr(h, c, budget = 30000, deps = {}) {
  const o = normalize(c);
  const now = deps.now || Date.now;
  const deadline = now() + Math.floor(budget * 0.85);
  const factory = deps.factory || tesseractFactory;
  const paddle = deps.paddle || ((buf, lang) => paddleRecognize(buf, lang));
  const { page, ctx } = h;
  const found = await page.evaluate(imagesFn, { minWidth: o.minWidth, minHeight: o.minHeight });
  const todo = found.items.slice(0, o.maxImages);
  const out = { url: page.url(), title: await page.title(), engine: o.engine, lang: o.lang, images_total: found.total, images_found: found.items.length, images_ocr: 0, images_failed: 0, truncated: found.items.length > todo.length, results: [], text: '' };
  if (!todo.length && !o.includeScreenshot) return out;

  return exclusive(async () => {
    let worker; let scratch;
    // tesseract is created lazily so a paddle-only call, or a page without images, never loads the wasm model
    const lazyTess = async (buf) => { worker = worker || factory(o.lang); return (await worker).recognize(buf); };
    const run = async (name, buf) => (name === 'paddle' ? paddle(buf, o.lang) : lazyTess(buf));
    const entry = (base, r) => ({ ...base, ocr_text: r.text, confidence: r.confidence, engine: r.engine, ...(r.confidence < o.lowConfidence ? { low_confidence: true } : {}), ...(r.escalated ? { escalated_from: 'tesseract' } : {}), ...(r.escalation_error ? { escalation_error: r.escalation_error } : {}) });
    const recognizeAuto = async (buf) => {
      const first = await run(o.engine, buf);
      let r = { ...first, engine: o.engine };
      // optional escalation, default off: a low-confidence tesseract result is retried with paddle when the sidecar is configured
      if (o.engine === 'tesseract' && o.escalateBelow > 0 && first.confidence < o.escalateBelow) {
        try { const p = await paddle(buf, o.lang); if (p.confidence >= first.confidence) r = { ...p, engine: 'paddle', escalated: true }; } catch (e) { r.escalation_error = String(e.message || e).slice(0, 160); }
      }
      return r;
    };
    try {
      // the screenshot is taken first: with a second tab open the original page can stall in page.screenshot
      const shot = {};
      if (o.includeScreenshot) {
        try {
          const vp = await page.evaluate(() => ({ w: document.documentElement.clientWidth, h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) }));
          const clip = o.fullPage ? { x: 0, y: 0, width: vp.w, height: Math.min(vp.h, SCREENSHOT_MAX_HEIGHT) } : undefined;
          Object.assign(shot, { vp, clip, png: await page.screenshot({ type: 'png', ...(clip ? { fullPage: true, clip } : {}), timeout: 20000 }) });
        } catch (e) { shot.error = e; }
      }
      scratch = await ctx.newPage();
      for (const im of todo) {
        const base = { kind: 'img', src: im.src.startsWith('data:') ? `${im.src.slice(0, 60)}...` : im.src, alt: im.alt, width: im.width, height: im.height };
        try {
          if (now() >= deadline) throw new OcrError('timeout', 'skipped: time budget of the call used up');
          const img = await fetchImage(h, im.src);
          const { png, width, height } = await renderForOcr(scratch, img);
          const r = await recognizeAuto(png);
          out.results.push(entry({ ...base, width: im.width || width, height: im.height || height }, r));
          out.images_ocr++;
        } catch (e) {
          out.images_failed++;
          out.results.push({ ...base, ocr_text: '', confidence: 0, engine: o.engine, error: { code: e.code || 'internal', message: String(e.message || e).slice(0, 240) } });
        }
      }
      if (o.includeScreenshot) {
        const base = { kind: 'screenshot', src: o.fullPage ? 'screenshot:page' : 'screenshot:viewport', alt: '', width: 0, height: 0 };
        try {
          if (now() >= deadline) throw new OcrError('timeout', 'skipped: time budget of the call used up');
          if (shot.error) throw shot.error;
          const { png, clip, vp } = shot;
          const r = await recognizeAuto(png);
          out.results.push(entry({ ...base, width: clip ? clip.width : vp.w, height: clip ? clip.height : 0, ...(clip && vp.h > SCREENSHOT_MAX_HEIGHT ? { cropped_to: SCREENSHOT_MAX_HEIGHT } : {}) }, r));
          out.images_ocr++;
        } catch (e) {
          out.images_failed++;
          out.results.push({ ...base, ocr_text: '', confidence: 0, engine: o.engine, error: { code: e.code || 'internal', message: String(e.message || e).slice(0, 240) } });
        }
      }
    } finally {
      if (scratch) await scratch.close().catch(() => {});
      if (worker) { try { await (await worker).close(); } catch { /* already gone */ } }
    }
    out.text = out.results.filter((r) => r.ocr_text).map((r) => r.ocr_text).join('\n\n');
    return out;
  });
}
