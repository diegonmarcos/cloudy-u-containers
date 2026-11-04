"""Generic web crawl — httpx fetch + optional CSS-selector extraction (selectolax).

Covers the ad-hoc crawls crawlee-cloud used to run. No browser/headless — static HTML only;
if a target needs JS rendering, that's a future upgrade (playwright), not the lean default.

#797 robots.txt first: a URL the site's robots.txt disallows (or a site whose robots.txt cannot be
read) is refused before any fetch, rendered or not — see _robots.py.
"""
import httpx
from selectolax.parser import HTMLParser

from ._robots import require

UA = "Mozilla/5.0 (compatible; scrappers-api/0.1; +https://api.diegonmarcos.com/scrappers)"


def scrape(url: str, selector: str | None = None, render: bool = False, **_):
    if not url:
        raise ValueError("url required")
    require(url, UA)
    if render:
        # JS-heavy or anti-bot target → render via Cloudflare Browser Rendering instead of httpx.
        from . import cloudflare
        html = cloudflare.render(url)
    else:
        with httpx.Client(follow_redirects=True, timeout=30, headers={"User-Agent": UA}) as c:
            r = c.get(url)
            r.raise_for_status()
        html = r.text
    tree = HTMLParser(html)

    if selector:
        items = [n.text(strip=True) for n in tree.css(selector) if n.text(strip=True)]
        return {"url": url, "selector": selector, "items": items, "_summary": {"matched": len(items)}}

    # No selector → return page title + all links (a lightweight sitemap-ish crawl).
    title = tree.css_first("title")
    links = list({a.attributes.get("href") for a in tree.css("a[href]") if a.attributes.get("href")})
    return {
        "url": url,
        "title": title.text(strip=True) if title else "",
        "links": links,
        "_summary": {"links": len(links), "bytes": len(html)},
    }
