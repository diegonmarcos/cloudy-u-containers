"""Store-site price lookup (#903): one item, the declared chains' own search pages, the offers they
publish as schema.org JSON-LD. Nothing here guesses a price.

For each enabled adapter in prices.json: robots.txt must allow the search URL (scrapers/_robots.py,
the same gate as the generic crawler), the page is fetched once with an honest user agent, every
`Product` with an `Offer` price is read from its JSON-LD, the hits are narrowed to those whose
name/brand contain every word asked for, and the cheapest is the answer. A chain that answers
nothing usable says why (blocked / no offers / no match) instead of showing a number.

Results are cached in memory for ttl_minutes per (adapter, item) and each site is asked at most once
every min_interval_s, so a phone refreshing the table cannot hammer a shop. The URL is built only
from the declared template and the URL-quoted item: the caller names no host.
"""
import json
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote

from ._robots import allowed

UA = "Mozilla/5.0 (compatible; scrappers-api/0.1; +https://api.diegonmarcos.com/scrappers)"
HERE = Path(__file__).parent.parent
_LD = re.compile(r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', re.S | re.I)

_lock = threading.Lock()
_cache: dict = {}      # (adapter, q) -> (fetched_at, result)
_last_hit: dict = {}   # adapter -> monotonic time of the last site request
_robots: dict = {}     # robots.txt url -> (status, text), one read per site per process


def config() -> dict:
    return json.loads((HERE / "prices.json").read_text())


def _walk(node, out):
    """Every dict under [node] whose @type is Product."""
    if isinstance(node, list):
        for n in node:
            _walk(n, out)
    elif isinstance(node, dict):
        t = node.get("@type")
        if t == "Product" or (isinstance(t, list) and "Product" in t):
            out.append(node)
        for v in node.values():
            if isinstance(v, (dict, list)):
                _walk(v, out)


def _price(offers):
    """(price, currency) of an Offer / list of Offers / AggregateOffer, or None."""
    if isinstance(offers, list):
        found = [p for p in (_price(o) for o in offers) if p]
        return min(found, key=lambda p: p[0]) if found else None
    if not isinstance(offers, dict):
        return None
    raw = offers.get("price", offers.get("lowPrice"))
    try:
        value = float(str(raw).replace(",", "."))
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    return value, offers.get("priceCurrency") or "EUR"


def parse_offers(html: str, base_url: str) -> list:
    """[{title, brand, price, currency, url}] for every Product with a price in the page's JSON-LD."""
    products: list = []
    for block in _LD.findall(html):
        try:
            _walk(json.loads(block), products)
        except ValueError:
            continue
    seen, hits = set(), []
    for p in products:
        priced = _price(p.get("offers"))
        name = p.get("name")
        if not priced or not isinstance(name, str):
            continue
        brand = p.get("brand")
        brand = brand.get("name") if isinstance(brand, dict) else brand
        url = p.get("url") or ""
        if url.startswith("/"):
            base = re.match(r"https?://[^/]+", base_url)
            url = (base.group(0) if base else "") + url
        key = (url or name, priced[0])
        if key in seen:
            continue
        seen.add(key)
        hits.append({"title": name.strip(), "brand": brand if isinstance(brand, str) else "",
                     "price": priced[0], "currency": priced[1], "url": url})
    return hits


def best_match(hits: list, q: str):
    """The cheapest hit whose title+brand contains every word of [q], or None."""
    words = [w for w in re.split(r"\W+", q.lower()) if w]
    ok = [h for h in hits if all(w in (h["title"] + " " + h["brand"]).lower() for w in words)]
    return min(ok, key=lambda h: h["price"]) if ok else None


def _fetch(adapter_id: str, url: str, gap: float) -> str:
    with _lock:
        wait = _last_hit.get(adapter_id, 0) + gap - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _last_hit[adapter_id] = time.monotonic()
    import httpx  # lazy: the per-service tester runs on the stdlib alone

    with httpx.Client(follow_redirects=True, timeout=20, headers={"User-Agent": UA}) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.text


def lookup(adapter_id: str, a: dict, q: str, cfg: dict, fetch=_fetch, now=time.time) -> dict:
    """One adapter's answer: status ok | no_match | no_offers | blocked | error, never a made-up price."""
    out = {"adapter": adapter_id, "label": a["label"], "fetched_at": int(now() * 1000)}
    url = a["search_url"].replace("{q_path}", quote(q.strip().lower().replace(" ", "-"), safe="-")).replace("{q}", quote(q, safe=""))
    out["search_url"] = url
    ok, why = allowed(url, UA, cache=_robots)
    if not ok:
        return {**out, "status": "blocked", "detail": why}
    try:
        html = fetch(adapter_id, url, cfg.get("min_interval_s", 2))
    except Exception as e:  # a site fault is a data fault, reported as such
        return {**out, "status": "error", "detail": f"{type(e).__name__}: {e}"[:200]}
    hits = parse_offers(html, url)[: cfg.get("max_hits", 40)]
    if not hits:
        return {**out, "status": "no_offers", "detail": "the page published no priced products"}
    best = best_match(hits, q)
    if not best:
        return {**out, "status": "no_match", "detail": f"{len(hits)} priced products, none named '{q}'"}
    return {**out, "status": "ok", "detail": "", "hits": len(hits), **best}


def scrape(q: str, brands: str | None = None, **_) -> dict:
    """Every enabled adapter (narrowed to the comma-separated [brands] when given) for item [q]."""
    q = (q or "").strip()[:80]
    if not q:
        raise ValueError("q required")
    cfg = config()
    want = {b.strip().lower() for b in (brands or "").split(",") if b.strip()}
    results, catalog = [], []
    ttl = cfg.get("ttl_minutes", 30) * 60
    for aid, a in cfg["adapters"].items():
        catalog.append({"adapter": aid, "label": a["label"], "enabled": a["enabled"], "brands": a["brands"],
                        "why": a.get("why") or a.get("terms", "")})
        if not a["enabled"] or (want and not want & set(a["brands"])):
            continue
        key = (aid, q.lower())
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            results.append({**hit[1], "cached": True})
            continue
        res = lookup(aid, a, q, cfg)
        if res["status"] in ("ok", "no_match", "no_offers"):
            _cache[key] = (time.time(), res)
        results.append(res)
    return {"q": q, "results": results, "adapters": catalog,
            "_summary": {"asked": len(results), "priced": sum(r["status"] == "ok" for r in results)}}
