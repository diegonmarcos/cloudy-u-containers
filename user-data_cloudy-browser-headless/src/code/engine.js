// Playwright engine for headless-api v1. One persistent-less context per session (profile = isolated cookies).
import { chromium } from 'playwright-core';
import { ApiError } from './api.js';

import { toReadable } from './readable.js';
import { linksFn, scrapeFn } from './extract.js';
import { runOcr } from './ocr.js';

const shotOpts = (c, t) => ({ type: c.format === 'jpeg' ? 'jpeg' : 'png', ...(c.format === 'jpeg' && c.quality ? { quality: c.quality } : {}), timeout: t });
const mimeOf = (c) => (c.format === 'jpeg' ? 'image/jpeg' : 'image/png');

// Chromium aborts a navigation with net::ERR_NETWORK_CHANGED whenever the host network stack reports a change.
// The container shares the VM network namespace (host mode: wg0 and the mesh listener need it), and the VM creates and
// destroys docker bridges/veths all the time, each with a link-local address, so a page load can be hit mid-flight.
// Chromium's own guidance is to retry; the cause is transient, the retry is bounded and only for these errors.
const TRANSIENT = /net::ERR_(NETWORK_CHANGED|NETWORK_IO_SUSPENDED|INTERNET_DISCONNECTED|ADDRESS_CHANGED)/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function gotoWithRetry(page, url, opts, { tries = 4, delayMs = 400 } = {}) {
  for (let i = 1; ; i++) {
    try { return await page.goto(url, opts); } catch (e) {
      if (i >= tries || !TRANSIENT.test(String(e && e.message))) throw e;
      await sleep(delayMs * i);
    }
  }
}

export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--mute-audio'];

export function createEngine({ executablePath } = {}) {
  let browser;
  const get = async () => (browser ||= await chromium.launch({ headless: true, executablePath, args: LAUNCH_ARGS }));
  return {
    async newSession() {
      const ctx = await (await get()).newContext({ viewport: { width: 1280, height: 800 } });
      const h = { ctx, page: await ctx.newPage(), log: [], blocked: [] };
      h.page.on('requestfinished', (r) => { h.log.push({ url: r.url(), method: r.method(), type: r.resourceType() }); if (h.log.length > 500) h.log.shift(); });
      await ctx.route('**/*', (route) => (h.blocked.some((p) => route.request().url().includes(p)) ? route.abort() : route.continue()));
      return h;
    },
    async closeSession(h) { await h.ctx.close(); },
    async run(h, c) {
      const { page, ctx } = h;
      const t = c.timeoutMs || 30000;
      switch (c.cmd) {
        case 'open': {
          const resp = await gotoWithRetry(page, c.url, { timeout: t, waitUntil: 'load' });
          // status and the Cloudflare challenge header let the gateway detect a bot wall (it never evades one).
          const hd = resp ? await resp.allHeaders().catch(() => ({})) : {};
          return { url: page.url(), title: await page.title(), status: resp ? resp.status() : 0, ...(hd['cf-mitigated'] ? { cfMitigated: hd['cf-mitigated'] } : {}) };
        }
        case 'wait':
          if (c.selector) await page.waitForSelector(c.selector, { timeout: t });
          else if (c.idle) await page.waitForLoadState('networkidle', { timeout: t });
          else await page.waitForTimeout(Math.min(c.ms, t));
          return { waited: true };
        case 'eval': return (await page.evaluate(c.js)) ?? null;
        case 'click': await page.click(c.selector, { timeout: t }); return { clicked: true };
        case 'type':
          if (c.clear) await page.fill(c.selector, '', { timeout: t });
          await page.type(c.selector, c.text, { timeout: t });
          return { typed: c.text.length };
        case 'scroll':
          if (c.selector) await page.locator(c.selector).scrollIntoViewIfNeeded({ timeout: t });
          else await page.evaluate(([x, y]) => window.scrollTo(x, y), [c.x || 0, c.y || 0]);
          return page.evaluate(() => ({ x: scrollX, y: scrollY }));
        case 'content': return page.content();
        case 'links': return page.evaluate(linksFn, { sameOrigin: !!c.sameOrigin, visibleOnly: !!c.visibleOnly });
        case 'scrape': return page.evaluate(scrapeFn, { elements: c.elements, limit: c.limit || 100 });
        case 'ocr': return runOcr(h, c, t);
        case 'pdf': {
          const buf = await page.pdf({ format: c.format || 'A4', landscape: !!c.landscape, printBackground: c.printBackground !== false });
          return { mime: 'application/pdf', base64: buf.toString('base64') };
        }
        case 'snapshot': {
          const html = await page.content();
          const buf = await page.screenshot({ fullPage: !!c.fullPage, ...shotOpts(c, t) });
          return { url: page.url(), title: await page.title(), html, screenshot: { mime: mimeOf(c), base64: buf.toString('base64') } };
        }
        case 'html': return c.selector ? page.innerHTML(c.selector, { timeout: t }) : page.content();
        case 'text': return page.innerText(c.selector || 'body', { timeout: t });
        case 'readable': return toReadable(await page.content(), page.url(), { format: c.format, maxChars: c.maxChars, cursor: c.cursor });
        case 'screenshot': {
          const buf = c.selector ? await page.locator(c.selector).screenshot(shotOpts(c, t)) : await page.screenshot({ fullPage: !!c.fullPage, ...shotOpts(c, t) });
          return { mime: mimeOf(c), base64: buf.toString('base64') };
        }
        case 'cookies':
          if (c.action === 'set') { await ctx.addCookies(c.cookies || []); return await ctx.cookies(); }
          if (c.action === 'clear') { await ctx.clearCookies(); return []; }
          return ctx.cookies();
        case 'storage': {
          const area = c.area === 'session' ? 'sessionStorage' : 'localStorage';
          return page.evaluate(([a, act, k, v]) => {
            const s = window[a];
            if (act === 'set') s.setItem(k, v);
            else if (act === 'remove') s.removeItem(k);
            else if (act === 'clear') s.clear();
            else if (k) return { [k]: s.getItem(k) };
            return Object.fromEntries(Object.keys(s).map((x) => [x, s.getItem(x)]));
          }, [area, c.action || 'get', c.key, c.value]);
        }
        case 'network':
          if (c.action === 'clear') { h.log.length = 0; return []; }
          if (c.action === 'block') { h.blocked.push(...(c.patterns || [])); return { blocked: h.blocked }; }
          if (c.action === 'unblock') { h.blocked = h.blocked.filter((p) => !(c.patterns || []).includes(p)); return { blocked: h.blocked }; }
          return h.log;
        default: throw new ApiError('bad_request', `unsupported ${c.cmd}`);
      }
    },
  };
}
