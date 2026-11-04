#!/usr/bin/env python3
"""#903 tester: GET /prices reads only what a store publishes, and invents nothing.

  P1  parse_offers reads schema.org Products with an Offer price from a JSON-LD ItemList (the shape
      OBI and Euronics serve), resolves a relative url, drops a product with no/zero price and a
      duplicate, and ignores an unreadable block.
  P2  best_match keeps only hits whose title+brand contain every asked word and takes the cheapest;
      none -> None (never the nearest guess).
  P3  lookup: robots.txt disallow -> status blocked and the page is NEVER fetched; a fetch fault ->
      error; no priced products -> no_offers; products but none named -> no_match; else ok with the
      real price.
  P4  scrape: a disabled adapter is listed with its reason and never asked; `brands` narrows the
      adapters asked; the second identical ask is served from the cache without a fetch.
  P5  prices.json: every enabled adapter has a search_url and brands; every disabled one says why.

Stdlib only: run from src/code.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scrapers import prices  # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  {detail}"))
    if not cond:
        FAILS.append(name)


def page(*products, extra=""):
    items = [{"@type": "ListItem", "position": i, "item": p} for i, p in enumerate(products)]
    ld = json.dumps({"@context": "https://schema.org", "@type": "ItemList", "itemListElement": items})
    return f'<html><script type="application/ld+json">{{broken</script>{extra}<script type="application/ld+json">{ld}</script></html>'


def prod(name, price, url="/p/1", brand="Bosch", cur="EUR"):
    p = {"@type": "Product", "name": name, "brand": brand, "url": url}
    if price is not None:
        p["offers"] = {"@type": "Offer", "price": str(price), "priceCurrency": cur}
    return p


# ── P1
html = page(prod("Bosch Bohrmaschine GSB 13", "74.99", "/p/7509672/x"), prod("Bosch Akku Bohrer", "129,50", "https://www.obi.de/p/2"),
            prod("Ohne Preis", None, "/p/3"), prod("Gratis", "0", "/p/4"), prod("Bosch Bohrmaschine GSB 13", "74.99", "/p/7509672/x"))
hits = prices.parse_offers(html, "https://www.obi.de/search/bohrmaschine/")
check("P1 reads priced products only", [h["title"] for h in hits] == ["Bosch Bohrmaschine GSB 13", "Bosch Akku Bohrer"], hits)
check("P1 relative url resolved", hits[0]["url"] == "https://www.obi.de/p/7509672/x", hits[0])
check("P1 decimal comma read", hits[1]["price"] == 129.5, hits[1])
check("P1 no JSON-LD -> empty", prices.parse_offers("<html></html>", "https://x.de/") == [])

# ── P2
hs = [{"title": "Bosch Bohrmaschine", "brand": "Bosch", "price": 80.0}, {"title": "Bohrmaschine Makita", "brand": "Makita", "price": 60.0},
      {"title": "Schrauber", "brand": "Bosch", "price": 10.0}]
check("P2 cheapest of the matches", prices.best_match(hs, "bohrmaschine")["price"] == 60.0)
check("P2 every word must match", prices.best_match(hs, "bosch bohrmaschine")["price"] == 80.0)
check("P2 no match -> None", prices.best_match(hs, "fernseher") is None)

# ── P3
A = {"label": "OBI", "search_url": "https://shop.test/s/{q_path}/?q={q}", "enabled": True, "brands": ["obi"]}
CFG = {"min_interval_s": 0, "max_hits": 40}
fetched = []
allow = [True, "ok"]
prices.allowed = lambda url, ua, **kw: (allow[0], allow[1])


def fake(body=None, exc=None):
    def f(aid, url, gap):
        fetched.append(url)
        if exc:
            raise exc
        return body
    return f


allow[:] = [False, "disallowed for scrappers-api by https://shop.test/robots.txt"]
r = prices.lookup("obi", A, "bohrmaschine", CFG, fetch=fake(html))
check("P3 robots disallow -> blocked, no fetch", r["status"] == "blocked" and not fetched, (r, fetched))
allow[:] = [True, "allowed"]
r = prices.lookup("obi", A, "bohrmaschine", CFG, fetch=fake(exc=OSError("down")))
check("P3 fetch fault -> error", r["status"] == "error" and "price" not in r, r)
r = prices.lookup("obi", A, "bohrmaschine", CFG, fetch=fake("<html></html>"))
check("P3 no products -> no_offers", r["status"] == "no_offers" and "price" not in r, r)
r = prices.lookup("obi", A, "fernseher", CFG, fetch=fake(html))
check("P3 products, none named -> no_match", r["status"] == "no_match" and "price" not in r, r)
r = prices.lookup("obi", A, "Bohrmaschine", CFG, fetch=fake(html))
check("P3 match -> ok with the published price", r["status"] == "ok" and r["price"] == 74.99 and r["currency"] == "EUR", r)
check("P3 url built from the template + quoted item only", fetched[-1] == "https://shop.test/s/bohrmaschine/?q=Bohrmaschine", fetched[-1])
r = prices.lookup("obi", A, "a b/../c", CFG, fetch=fake(html))
check("P3 hostile item cannot leave the template", fetched[-1].startswith("https://shop.test/s/") and "../" not in fetched[-1], fetched[-1])

# ── P4
cfg = {"ttl_minutes": 30, "min_interval_s": 0, "max_hits": 40, "adapters": {
    "obi": {**A, "enabled": True}, "off": {"label": "Off", "search_url": "https://off.test/{q}", "enabled": False, "brands": ["off"], "why": "403"},
    "eu": {"label": "EU", "search_url": "https://eu.test/{q}", "enabled": True, "brands": ["euronics"]}}}
prices.config = lambda: cfg
asked = []


def counting(aid, url, gap):
    asked.append(aid)
    return html


orig_lookup = prices.lookup
prices.lookup = lambda aid, a, q, c, fetch=counting, now=None: orig_lookup(aid, a, q, c, fetch=counting)
out = prices.scrape("bohrmaschine")
check("P4 disabled adapter never asked, listed with reason", asked == ["obi", "eu"] and any(a["adapter"] == "off" and a["why"] == "403" for a in out["adapters"]), (asked, out["adapters"]))
asked.clear()
prices.scrape("bohrmaschine")
check("P4 second ask is cached", asked == [], asked)
asked.clear()
out = prices.scrape("kabel", brands="euronics")
check("P4 brands narrows the adapters asked", asked == ["eu"] and [r["adapter"] for r in out["results"]] == ["eu"], (asked, out))
try:
    prices.scrape("  ")
    check("P4 empty item refused", False)
except ValueError:
    check("P4 empty item refused", True)

# ── P5
real = json.load(open(os.path.join(HERE, "prices.json")))
for aid, a in real["adapters"].items():
    if a["enabled"]:
        check(f"P5 {aid} enabled adapter complete", "{q" in a["search_url"] and a["brands"] and a.get("terms"), a)
    else:
        check(f"P5 {aid} disabled adapter says why", bool(a.get("why")), a)

print("FAILED: " + ", ".join(FAILS) if FAILS else "all prices checks passed")
sys.exit(1 if FAILS else 0)
