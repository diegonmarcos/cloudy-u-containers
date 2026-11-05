// Playwright engine for headless-api v1. One persistent-less context per session (profile = isolated cookies).
import { chromium } from 'playwright-core';
import { ApiError } from './api.js';

const READABLE = `(() => {
  const root = document.querySelector('article,main,[role=main]') || document.body;
  const out = [];
  const walk = (n) => {
    if (n.nodeType === 3) { const t = n.textContent.replace(/\\s+/g, ' '); if (t.trim()) out.push(t); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (['script','style','nav','footer','aside','noscript','svg','iframe'].includes(tag)) return;
    const h = /^h([1-6])$/.exec(tag);
    if (h) { out.push('\\n\\n' + '#'.repeat(+h[1]) + ' ' + n.innerText.trim() + '\\n\\n'); return; }
    if (tag === 'a' && n.href) { out.push('[' + n.innerText.trim() + '](' + n.href + ')'); return; }
    if (tag === 'li') out.push('\\n- ');
    if (tag === 'p' || tag === 'br') out.push('\\n\\n');
    n.childNodes.forEach(walk);
  };
  walk(root);
  return { title: document.title, markdown: out.join('').replace(/\\n{3,}/g, '\\n\\n').trim() };
})()`;

export function createEngine({ executablePath } = {}) {
  let browser;
  const get = async () => (browser ||= await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
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
        case 'open': await page.goto(c.url, { timeout: t, waitUntil: 'load' }); return { url: page.url(), title: await page.title() };
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
        case 'html': return c.selector ? page.innerHTML(c.selector, { timeout: t }) : page.content();
        case 'text': return page.innerText(c.selector || 'body', { timeout: t });
        case 'readable': return page.evaluate(READABLE);
        case 'screenshot': {
          const buf = c.selector ? await page.locator(c.selector).screenshot({ timeout: t }) : await page.screenshot({ fullPage: !!c.fullPage, timeout: t });
          return { mime: 'image/png', base64: buf.toString('base64') };
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
