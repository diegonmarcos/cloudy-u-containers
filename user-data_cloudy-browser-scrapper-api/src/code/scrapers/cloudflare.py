"""Cloudflare Browser Rendering backend — headless-Chromium fetch at the CF edge.

Why: JS-rendered SPAs (Pinterest, LinkedIn, IG) and anti-bot targets that reject the
plain httpx path (crawl.py). Requests egress from Cloudflare IPs (rotatable), so they
dodge the datacenter-IP 999/bot walls a self-hosted VM scraper hits.

Used two ways:
  • as its own platform:  POST /scrape/cloudflare {url, selector}
  • as a fetch strategy behind crawl.py (render=true in a scrappers.json target)

Secrets (env, from src/secrets.yaml → sops): CF_ACCOUNT_ID, CF_API_TOKEN.
Docs: https://developers.cloudflare.com/browser-rendering/rest-api/
"""
import os
import httpx
from selectolax.parser import HTMLParser

from ._robots import require

# The agent robots.txt is asked about (the render itself runs at the Cloudflare edge).
_UA = "Mozilla/5.0 (compatible; scrappers-api/0.1; +https://api.diegonmarcos.com/scrappers)"
API = "https://api.cloudflare.com/client/v4/accounts/{acct}/browser-rendering/{endpoint}"


def _creds():
    acct, token = os.environ.get("CF_ACCOUNT_ID"), os.environ.get("CF_API_TOKEN")
    if not acct or not token:
        raise RuntimeError("Cloudflare Browser Rendering needs CF_ACCOUNT_ID + CF_API_TOKEN (add to src/secrets.yaml)")
    return acct, token


def render(url: str, wait_ms: int = 0) -> str:
    """Return the fully-rendered HTML of `url` via Cloudflare Browser Rendering /content."""
    if not url:
        raise ValueError("url required")
    acct, token = _creds()
    body: dict = {"url": url}
    if wait_ms:
        body["gotoOptions"] = {"waitUntil": "networkidle0", "timeout": max(wait_ms, 30000)}
    with httpx.Client(timeout=60) as c:
        r = c.post(API.format(acct=acct, endpoint="content"),
                   headers={"Authorization": f"Bearer {token}"}, json=body)
        r.raise_for_status()
        data = r.json()
    if not data.get("success", False):
        raise RuntimeError(f"cloudflare render failed: {data.get('errors')}")
    return data["result"]


def scrape(url: str, selector: str | None = None, **_):
    """Module interface (mirrors crawl.py) but over a real browser render; robots.txt first (#797)."""
    require(url, _UA)
    html = render(url)
    tree = HTMLParser(html)
    if selector:
        items = [n.text(strip=True) for n in tree.css(selector) if n.text(strip=True)]
        return {"url": url, "selector": selector, "items": items,
                "_summary": {"matched": len(items), "via": "cloudflare"}}
    title = tree.css_first("title")
    links = list({a.attributes.get("href") for a in tree.css("a[href]") if a.attributes.get("href")})
    return {
        "url": url,
        "title": title.text(strip=True) if title else "",
        "links": links,
        "_summary": {"links": len(links), "bytes": len(html), "via": "cloudflare"},
    }
