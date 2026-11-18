#!/usr/bin/env python3
"""#1686 tester: scrappers-api Instagram serves the repo export by default, live stays opt-in.

  I1  source=repo (the default) decodes the .json.js wrapper, maps profile/posts/highlights/followers,
      keeps every other export section under `export`, honours max_posts, caches one fetch per file.
  I2  an unknown handle on source=repo is a ValueError naming source=live; an unknown source is a ValueError.
  I3  the default request (no source) never imports instaloader.
  I4  ScrapeReq declares `source`, so the API passes it through.

Stdlib only: run from src/code.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from scrapers import instagram as ig  # noqa: E402

FIX = {
    "_description": "fixture",
    "profile": {"username": "diegonmarcos", "name": "N", "bio": "B", "following": 2, "followers": 3, "posts": 3, "photo": "p.jpg"},
    "posts": [{"media": "a"}, {"media": "b"}, {"media": "c"}],
    "highlights": [{"label": "Travel"}],
    "followers": ["x", "y"],
    "liked": [{"url": "u"}],
    "saved_collections": [{"name": "C"}],
}
WRAP = '// GENERATED\n(function () {\n  var g = globalThis;\n  g.PORTAL_DATA = g.PORTAL_DATA || {};\n  g.PORTAL_DATA["ig2-diegonmarcos"] = ' + json.dumps(FIX, indent=2) + ';\n})();\n'
calls = []


def fake_fetch(url):
    calls.append(url)
    return WRAP


ig._fetch = fake_fetch
fails = 0


def check(name, cond):
    global fails
    print(("ok: " if cond else "FAIL: ") + name)
    fails += 0 if cond else 1


if "instaloader" in sys.modules:
    del sys.modules["instaloader"]
r = ig.scrape(handle="diegonmarcos", max_posts=2)
check("I3 default source never imports instaloader", "instaloader" not in sys.modules)
check("I1 profile mapped", r["profile"]["username"] == "diegonmarcos" and r["profile"]["followers"] == 3 and r["profile"]["full_name"] == "N")
check("I1 max_posts honoured", len(r["posts"]) == 2)
check("I1 highlights and followers mapped", r["highlights"] == FIX["highlights"] and r["followers"] == FIX["followers"])
check("I1 every other section kept", set(r["export"]) == {"_description", "liked", "saved_collections"})
check("I1 summary says repo", r["_summary"]["source"] == "repo" and r["_summary"]["posts"] == 2)
check("I1 url points at the dataset file", calls[0].endswith("data-ig2-diegonmarcos.json.js"))
ig.scrape(handle="diegonmarcos")
check("I1 one fetch per file (cache)", len(calls) == 1)
try:
    ig.scrape(handle="nobody-here")
    check("I2 unknown handle raises", False)
except ValueError as e:
    check("I2 unknown handle raises and names source=live", "source=live" in str(e))
try:
    ig.scrape(handle="diegonmarcos", source="bogus")
    check("I2 unknown source raises", False)
except ValueError:
    check("I2 unknown source raises", True)
src = open(os.path.join(HERE, "main.py")).read()
check("I4 ScrapeReq declares source", "    source: str | None = None" in src)
# mutation: a wrapper without the assignment must not decode
try:
    ig._parse_dataset("{}")
    check("MUT parse requires the PORTAL_DATA assignment", False)
except ValueError:
    check("MUT parse requires the PORTAL_DATA assignment", True)
sys.exit(1 if fails else 0)
