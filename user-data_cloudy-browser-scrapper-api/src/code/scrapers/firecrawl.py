"""Firecrawl backend — self-hosted "URL -> clean, LLM-ready markdown" engine.

Why: Firecrawl (github.com/mendableai/firecrawl, MIT) is a hosted paid API whose core
job is: fetch a page, strip boilerplate (nav/ads/footers), extract the main readable
content, convert to markdown. That job is fully reproducible in-house with trafilatura,
so this module fetches the page itself (plain httpx, or cloudflare.render for JS pages)
and runs local extraction — no external API, no API keys.

Fetch strategy:
  • render=False (default): plain httpx GET.
  • render=True: reuse cloudflare.render(url) for JS-heavy pages (SPA content).
"""
import httpx
import trafilatura
from selectolax.parser import HTMLParser

from . import cloudflare
from ._robots import require

_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; scrappers-api/1.0)"}


def _fetch(url: str, render: bool) -> str:
    if render:
        return cloudflare.render(url)
    with httpx.Client(timeout=60, headers=_HEADERS, follow_redirects=True) as c:
        r = c.get(url)
        r.raise_for_status()
        return r.text


def scrape(url: str, render: bool = False, **_):
    """Fetch `url`, extract the main content, and return it as clean markdown."""
    if not url:
        raise ValueError("url required")
    require(url, _HEADERS["User-Agent"])  # robots.txt first (#797)
    html = _fetch(url, render)

    markdown = trafilatura.extract(html, url=url, output_format="markdown") or ""

    tree = HTMLParser(html)
    title_node = tree.css_first("title")
    title = title_node.text(strip=True) if title_node else ""

    return {
        "url": url,
        "markdown": markdown,
        "title": title,
        "_summary": {"chars": len(markdown), "via": "self-hosted-firecrawl"},
    }
