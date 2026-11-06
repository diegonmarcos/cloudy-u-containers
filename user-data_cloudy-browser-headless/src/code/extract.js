// In-page extractors for headless-api links/scrape (also the reference for the phone engine). Self-contained functions run by page.evaluate.
export const linksFn = (o) => {
  const out = []; const seen = new Set();
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  for (const a of document.querySelectorAll('a[href]')) {
    let href; try { href = new URL(a.getAttribute('href'), document.baseURI); } catch { continue; }
    if (href.protocol !== 'http:' && href.protocol !== 'https:') continue;
    if (o.sameOrigin && href.origin !== location.origin) continue;
    if (o.visibleOnly && !vis(a)) continue;
    const h = href.href; if (seen.has(h)) continue; seen.add(h);
    out.push({ text: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200), href: h });
  }
  return { count: out.length, links: out };
};

export const scrapeFn = (o) => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  return { results: o.elements.map((el) => {
    let nodes = []; try { nodes = [...document.querySelectorAll(el.selector)]; } catch (e) { return { selector: el.selector, count: 0, items: [], error: String(e.message || e) }; }
    const items = nodes.slice(0, o.limit).map((n) => {
      const attrs = {}; for (const a of (el.attrs || [])) { const v = n.getAttribute(a); if (v !== null) attrs[a] = v; }
      return { text: (n.innerText || n.textContent || '').trim(), html: n.outerHTML, attrs, visible: vis(n) };
    });
    return { selector: el.selector, count: nodes.length, items };
  }) };
};
