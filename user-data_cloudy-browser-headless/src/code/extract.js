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

// In-page enumeration of the <img> elements for the ocr command: absolute src (currentSrc, lazy data-src fallback), alt, natural and rendered size,
// kept when at least minWidth x minHeight (natural size, the rendered size when the image is not decoded yet) and not rendered below 32 px
// (avatars, icons, pixels), deduplicated by src, document order.
export const imagesFn = (o) => {
  const items = []; const seen = new Set(); let total = 0;
  for (const im of document.images) {
    total++;
    let src = im.currentSrc || im.src || '';
    const lazy = im.getAttribute('data-src') || im.getAttribute('data-lazy-src') || im.getAttribute('data-original') || '';
    if (lazy && (!src || /^data:image\/(gif|svg)/.test(src) && src.length < 400)) { try { src = new URL(lazy, document.baseURI).href; } catch { /* keep src */ } }
    if (!src || seen.has(src)) continue;
    const r = im.getBoundingClientRect();
    const w = im.naturalWidth || Math.round(r.width); const h = im.naturalHeight || Math.round(r.height);
    if (w < o.minWidth || h < o.minHeight) continue;
    if (r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32)) continue; // rendered as an icon, avatar or tracking pixel
    seen.add(src);
    items.push({ src, alt: (im.getAttribute('alt') || '').trim().slice(0, 300), width: w, height: h });
  }
  return { total, items };
};
