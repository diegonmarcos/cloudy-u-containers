"""Apify backend — self-hosted BFS crawl engine (the Crawlee idea, in-house).

Why: Apify/Crawlee (github.com/apify/crawlee, Apache-2) is at its core a request
QUEUE + BFS crawl + visited-dedup + limits. That core is fully reproducible locally
with a deque and selectolax (already a dependency) — no actor marketplace, no
external API, no API keys.

Fetch strategy per page:
  • render=False (default): plain httpx GET.
  • render=True: reuse cloudflare.render(url) for JS-heavy pages.

Kept lean: no Playwright, no crawlee/scrapy framework — just a queue + parser.
"""
from collections import deque
from urllib.parse import urljoin, urlparse

import httpx
from selectolax.parser import HTMLParser

from . import cloudflare
from ._robots import allowed

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; scrappers-api/1.0)"}
_HARD_MAX_PAGES = 200


def _fetch(url: str, render: bool) -> str:
    if render:
        return cloudflare.render(url)
    with httpx.Client(timeout=60, headers=_HEADERS, follow_redirects=True) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.text


def scrape(
    start_url: str,
    max_pages: int = 50,
    same_domain: bool = True,
    selector: str | None = None,
    render: bool = False,
    **_,
):
    """BFS-crawl from `start_url` via an in-process request queue, dedup visited URLs."""
    if not start_url:
        raise ValueError("start_url required")
    max_pages = max(1, min(int(max_pages), _HARD_MAX_PAGES))

    start_domain = urlparse(start_url).netloc
    queue: deque[str] = deque([start_url])
    visited: set[str] = set()
    pages: list[dict] = []
    # #797 every page is asked of its site's robots.txt (read once per site); a disallowed page is
    # skipped and counted, never fetched.
    robots: dict = {}
    refused: list[str] = []

    while queue and len(pages) < max_pages:
        url = queue.popleft()
        if url in visited:
            continue
        visited.add(url)

        if not allowed(url, _HEADERS["User-Agent"], cache=robots)[0]:
            refused.append(url)
            continue
        try:
            html = _fetch(url, render)
        except httpx.HTTPError:
            continue

        tree = HTMLParser(html)
        title_node = tree.css_first("title")
        title = title_node.text(strip=True) if title_node else ""

        if selector:
            matches = [n.text(strip=True) for n in tree.css(selector) if n.text(strip=True)]
        else:
            matches = None

        links: list[str] = []
        for a in tree.css("a[href]"):
            href = a.attributes.get("href")
            if not href:
                continue
            abs_url = urljoin(url, href)
            if not abs_url.startswith(("http://", "https://")):
                continue
            if same_domain and urlparse(abs_url).netloc != start_domain:
                continue
            links.append(abs_url)
            if abs_url not in visited and abs_url not in queue:
                queue.append(abs_url)

        page: dict = {"url": url, "title": title, "links": links}
        if matches is not None:
            page["selector_matches"] = matches
        else:
            body_node = tree.css_first("body")
            page["text"] = body_node.text(strip=True, separator=" ")[:5000] if body_node else ""
        pages.append(page)

    return {
        "start_url": start_url,
        "pages": pages,
        "robots_refused": refused,
        "_summary": {"crawled": len(pages), "robots_refused": len(refused), "via": "self-hosted-crawlee"},
    }
