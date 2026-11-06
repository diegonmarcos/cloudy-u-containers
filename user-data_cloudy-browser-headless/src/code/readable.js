// headless-api v1 `readable`: rendered HTML -> clean agent-ready document (markdown | json | xml).
// Pipeline: strip boilerplate -> Mozilla Readability (Apache-2.0) -> Turndown + GFM tables (MIT).
// Same approach as the edge-md-scraper Worker (cloudy-u-android 9_others/cf-workers/edge-md-scraper), run in the container.
// Pure and DOM-engine-injected-free: takes an HTML string, returns plain data, unit-tested with fixtures (no browser).
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import gfmPkg from 'turndown-plugin-gfm';

export const FORMATS = ['markdown', 'json', 'xml'];
export const DEFAULT_MAX_CHARS = 20000;
export const MAX_MAX_CHARS = 200000;
const MAX_HTML = 5 * 1024 * 1024;
const MAX_LINKS = 200;

const STRIP = 'script,style,noscript,template,svg,iframe,canvas,nav,footer,aside,form,[role=navigation],[role=banner],[role=contentinfo],[role=dialog],[aria-hidden=true],[hidden]';
const NOISE = /(^|[-_ ])(cookie|cookies|consent|gdpr|banner|advert|adverts|ad|ads|sponsor|sponsored|promo|popup|modal|newsletter|subscribe|share|social|breadcrumb|breadcrumbs)([-_ ]|$)/i;
const KEEP_TAGS = new Set(['HTML', 'BODY', 'MAIN', 'ARTICLE']);
const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|ref_src|ref_url|spm|trk|trkid)$/i;

export function cleanUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  return u.toString();
}

const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function strip(doc, base) {
  doc.querySelectorAll(STRIP).forEach((e) => { if (!KEEP_TAGS.has(e.tagName)) e.remove(); });
  doc.querySelectorAll('[class],[id]').forEach((e) => {
    if (KEEP_TAGS.has(e.tagName) || !e.isConnected) return;
    if (NOISE.test(e.getAttribute('class') || '') || NOISE.test(e.getAttribute('id') || '')) e.remove();
  });
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (/^data:/i.test(src) || !src) img.replaceWith(doc.createTextNode(squash(img.getAttribute('alt'))));
  });
  doc.querySelectorAll('a[href]').forEach((a) => {
    const c = cleanUrl(a.getAttribute('href'), base);
    if (c) a.setAttribute('href', c);
    else a.replaceWith(...a.childNodes);
  });
}

function extract(html, url) {
  const dom = new JSDOM(html.slice(0, MAX_HTML), { url });
  const doc = dom.window.document;
  strip(doc, url);
  const lang = doc.documentElement.getAttribute('lang') || '';
  const docTitle = squash(doc.title);
  let article = null;
  try { article = new Readability(doc.cloneNode(true), { charThreshold: 100, keepClasses: true }).parse(); } catch { /* fall through to body */ }
  let content = article && article.content;
  if (!content || squash(article.textContent).length < 80) {
    const root = doc.querySelector('main,article,[role=main]') || doc.body;
    content = root ? root.innerHTML : '';
  }
  return { content, title: squash((article && article.title) || docTitle), lang, excerpt: squash(article && article.excerpt) };
}

function normaliseTables(root) {
  root.querySelectorAll('table').forEach((t) => {
    t.querySelectorAll('caption').forEach((c) => c.remove());
    const rows = [...t.querySelectorAll('tr')];
    if (!rows.length) { t.remove(); return; }
    const first = rows[0];
    first.querySelectorAll('td').forEach((td) => {
      const th = t.ownerDocument.createElement('th');
      th.innerHTML = td.innerHTML;
      td.replaceWith(th);
    });
    t.querySelectorAll('td,th').forEach((c) => { c.innerHTML = squash(c.textContent).replace(/\|/g, '\\|'); });
  });
}

// Token trim outside code fences: Turndown pads list markers ("-   x", "1.  x") and escapes a leading dash ("\\--flag").
function tighten(md) {
  return md.split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : part
    .replace(/^(\s*)-\s{2,}/gm, '$1- ')
    .replace(/^(\s*)(\d+\.)\s{2,}/gm, '$1$2 ')
    .replace(/\\(-{1,2})(?=[A-Za-z0-9])/g, '$1'))).join('');
}

function toMarkdown(root) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-', linkStyle: 'inlined' });
  td.use(gfmPkg.gfm);
  td.remove(['script', 'style', 'noscript']);
  td.addRule('fencedLang', {
    filter: (n) => n.nodeName === 'PRE' && n.firstChild && n.firstChild.nodeName === 'CODE',
    replacement: (_c, n) => {
      const code = n.firstChild;
      const lang = ((code.getAttribute('class') || '').match(/(?:language|lang)-([\w+-]+)/) || [])[1] || '';
      return `\n\n\`\`\`${lang}\n${code.textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    },
  });
  return tighten(td.turndown(root.innerHTML).replace(/\n{3,}/g, '\n\n').trim());
}

// Ordered block model shared by json and xml: s = section {h, level, text}, l = list, t = table {headers, rows}, a = link.
function blocks(root) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && (cur.h || cur.text)) out.push(cur); cur = null; };
  const addText = (s) => { const t = squash(s); if (!t) return; cur ||= { k: 's', h: '', level: 0, text: '' }; cur.text += (cur.text ? '\n' : '') + t; };
  const walk = (n) => {
    for (const c of n.children) {
      const tag = c.tagName.toLowerCase();
      const h = /^h([1-6])$/.exec(tag);
      if (h) { flush(); cur = { k: 's', h: squash(c.textContent), level: +h[1], text: '' }; }
      else if (tag === 'ul' || tag === 'ol') { flush(); const items = [...c.querySelectorAll('li')].map((li) => squash(li.textContent)).filter(Boolean); if (items.length) out.push({ k: 'l', items }); }
      else if (tag === 'table') {
        flush();
        const rows = [...c.querySelectorAll('tr')].map((tr) => [...tr.children].map((x) => squash(x.textContent)));
        if (rows.length) out.push({ k: 't', headers: rows[0], rows: rows.slice(1) });
      }
      else if (tag === 'pre') addText(c.textContent);
      else if (['p', 'blockquote', 'dd', 'dt', 'figcaption', 'summary'].includes(tag)) addText(c.textContent);
      else if (c.children.length) walk(c);
      else addText(c.textContent);
    }
  };
  walk(root);
  flush();
  return out;
}

function linksOf(root) {
  const seen = new Set();
  const out = [];
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    const text = squash(a.textContent);
    if (!href || !text || seen.has(href)) return;
    seen.add(href);
    out.push({ text, href });
  });
  return out.slice(0, MAX_LINKS);
}

const yaml = (s) => JSON.stringify(squash(s));
const mdTable = (t) => {
  const row = (r) => `| ${r.join(' | ')} |`;
  return [row(t.headers), row(t.headers.map(() => '---')), ...t.rows.map(row)].join('\n');
};
const xe = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function jsonOf(meta, page, links, first) {
  const doc = { meta };
  const sections = page.filter((b) => b.k === 's').map((b) => ({ ...(b.h ? { h: b.h } : {}), ...(b.level ? { level: b.level } : {}), ...(b.text ? { text: b.text } : {}) }));
  const lists = page.filter((b) => b.k === 'l').map((b) => b.items);
  const tables = page.filter((b) => b.k === 't').map((b) => ({ headers: b.headers, rows: b.rows }));
  if (sections.length) doc.sections = sections;
  if (lists.length) doc.lists = lists;
  if (tables.length) doc.tables = tables;
  if (first && links.length) doc.links = links;
  return JSON.stringify(doc);
}

function xmlOf(meta, page, links, first) {
  const m = `<meta t="${xe(meta.title)}" u="${xe(meta.url)}" f="${xe(meta.fetched_at)}"${meta.lang ? ` l="${xe(meta.lang)}"` : ''}/>`;
  const body = page.map((b) => {
    if (b.k === 's') return `<s${b.h ? ` h="${xe(b.h)}"` : ''}${b.level ? ` l="${b.level}"` : ''}>${xe(b.text)}</s>`;
    if (b.k === 'l') return `<ul>${b.items.map((i) => `<i>${xe(i)}</i>`).join('')}</ul>`;
    const r = (cells, hd) => `<r${hd ? ' h="1"' : ''}>${cells.map((c) => `<c>${xe(c)}</c>`).join('')}</r>`;
    return `<table>${r(b.headers, true)}${b.rows.map((x) => r(x)).join('')}</table>`;
  }).join('');
  const ls = first ? links.map((l) => `<a href="${xe(l.href)}">${xe(l.text)}</a>`).join('') : '';
  return `<doc>${m}${body}${ls}</doc>`;
}

// Cursor semantics: markdown = character offset; json/xml = index of the first block of the page. Opaque to callers.
function pageBlocks(all, start, budget, size) {
  let end = start;
  let used = 0;
  while (end < all.length) {
    const s = size(all[end]);
    if (end > start && used + s > budget) break;
    used += s;
    end++;
  }
  return { page: all.slice(start, end), end };
}

export function toReadable(html, url, opts = {}) {
  const format = opts.format || 'markdown';
  if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join('|')}`);
  const maxChars = Math.min(Math.max(opts.maxChars || DEFAULT_MAX_CHARS, 500), MAX_MAX_CHARS);
  const start = opts.cursor ? parseInt(opts.cursor, 10) : 0;
  if (!Number.isInteger(start) || start < 0) throw new Error('bad cursor');
  const fetchedAt = opts.fetchedAt || new Date().toISOString();

  const { content, title, lang, excerpt } = extract(html, url);
  const root = new JSDOM(`<body>${content}</body>`, { url }).window.document.body;
  normaliseTables(root);
  const meta = { title, url, fetched_at: fetchedAt, ...(lang ? { lang } : {}), ...(excerpt ? { excerpt } : {}) };
  const links = linksOf(root);
  const first = start === 0;

  if (format === 'markdown') {
    const full = toMarkdown(root);
    const head = first ? `---\ntitle: ${yaml(title)}\nsource: ${yaml(url)}\nfetched_at: ${yaml(fetchedAt)}\n---\n\n` : '';
    let end = Math.min(full.length, start + maxChars);
    if (end < full.length) { const cut = full.lastIndexOf('\n', end); if (cut > start + maxChars / 2) end = cut; }
    const body = full.slice(start, end).trim();
    const truncated = end < full.length;
    const markdown = head + body;
    const tables = first ? [...root.querySelectorAll('table')].map((t) => {
      const rows = [...t.querySelectorAll('tr')].map((tr) => [...tr.children].map((x) => squash(x.textContent)));
      return mdTable({ headers: rows[0] || [], rows: rows.slice(1) });
    }) : [];
    return { format, title, url, markdown, content: markdown, links: first ? links : [], tables, meta, chars: markdown.length, truncated, ...(truncated ? { next: String(end) } : {}) };
  }

  const all = [...blocks(root)];
  const size = (b) => (b.k === 's' ? 40 + b.h.length + b.text.length : b.k === 'l' ? b.items.reduce((n, i) => n + i.length + 8, 10) : JSON.stringify([b.headers, b.rows]).length + 20);
  const reserve = first ? Math.min(links.reduce((n, l) => n + l.text.length + l.href.length + 20, 0), Math.floor(maxChars / 4)) + 200 : 0;
  const { page, end } = pageBlocks(all, start, maxChars - reserve, size);
  let shownLinks = links;
  if (first) { let n = 0; shownLinks = links.filter((l) => (n += l.text.length + l.href.length + 20) <= reserve); }
  const content2 = format === 'json' ? jsonOf(meta, page, shownLinks, first) : xmlOf(meta, page, shownLinks, first);
  const truncated = end < all.length;
  return { format, title, url, content: content2, meta, chars: content2.length, truncated, ...(truncated ? { next: String(end) } : {}) };
}
