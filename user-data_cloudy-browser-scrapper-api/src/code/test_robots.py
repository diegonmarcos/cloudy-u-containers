#!/usr/bin/env python3
"""#797 tester: the fleet scraper fetches nothing a site's robots.txt forbids.

  R1  _robots.allowed against a real local HTTP server: rules for `*`, a group for scrappers-api
      that overrides `*`, no robots.txt (404 = allowed), 401/403 and 5xx (= disallow-all), a dead
      host (= disallow-all), one robots.txt read per site with a cache.
  R2  every generic-URL platform (crawl, cloudflare, firecrawl, apify) asks robots.txt before it
      fetches: crawl/cloudflare/firecrawl call require() before their first fetch, apify calls
      allowed() inside its page loop before _fetch.
  MUT each rule above, broken on a copy of the source, makes this tester fail for that reason.

Stdlib only (the per-service runner has no image dependencies): run from src/code.
"""
import http.server
import os
import re
import socket
import sys
import threading
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "scrapers")

ROBOTS = {
    "/robots.txt": None,  # set per case: (status, body)
}


class Handler(http.server.BaseHTTPRequestHandler):
    hits = 0

    def do_GET(self):
        if self.path == "/robots.txt":
            Handler.hits += 1
            status, body = ROBOTS["/robots.txt"]
            data = body.encode()
            self.send_response(status)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(200)
            self.end_headers()

    def log_message(self, *a):
        pass


def load(source: str) -> types.ModuleType:
    m = types.ModuleType("robots_under_test")
    exec(compile(source, "_robots.py", "exec"), m.__dict__)
    return m


def r1(mod, base: str, dead: str) -> list:
    bad = []
    ua = "Mozilla/5.0 (compatible; scrappers-api/0.1)"

    def case(status, body, path, want, label):
        ROBOTS["/robots.txt"] = (status, body)
        ok, why = mod.allowed(base + path, ua, timeout=5)
        if ok != want:
            bad.append(f"R1 {label}: allowed={ok} ({why}), want {want}")

    case(200, "User-agent: *\nDisallow: /private\n", "/public/page", True, "a path * allows")
    case(200, "User-agent: *\nDisallow: /private\n", "/private/x", False, "a path * disallows")
    case(200, "User-agent: scrappers-api\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "/any", False, "our own group overrides *")
    case(404, "", "/any", True, "no robots.txt (404)")
    case(403, "", "/any", False, "robots.txt 403")
    case(401, "", "/any", False, "robots.txt 401")
    case(503, "", "/any", False, "robots.txt 5xx")
    ok, _ = mod.allowed(dead + "/x", ua, timeout=2)
    if ok:
        bad.append("R1 a host that does not answer was treated as allowing")
    ROBOTS["/robots.txt"] = (200, "User-agent: *\nDisallow: /no\n")
    Handler.hits = 0
    cache = {}
    for p in ("/a", "/b", "/no"):
        mod.allowed(base + p, ua, timeout=5, cache=cache)
    if Handler.hits != 1:
        bad.append(f"R1 a cached crawl read robots.txt {Handler.hits} times, want 1")
    try:
        mod.require(base + "/no", ua, timeout=5)
        bad.append("R1 require() let a disallowed URL through")
    except PermissionError as e:
        if "disallowed" not in str(e):
            bad.append(f"R1 require() refused without the reason: {e}")
    return bad


def r2(sources: dict) -> list:
    bad = []

    def before(name, gate, fetch):
        s = sources[name]
        g, f = s.find(gate), s.find(fetch)
        if g < 0:
            bad.append(f"R2 {name} never asks robots.txt ({gate} missing)")
        elif f >= 0 and f < g:
            bad.append(f"R2 {name} fetches ({fetch}) before it asks robots.txt")

    before("crawl.py", "require(url, UA)", "c.get(url)")
    before("crawl.py", "require(url, UA)", "cloudflare.render(url)")
    before("cloudflare.py", "require(url, _UA)", "html = render(url)")
    before("firecrawl.py", "require(url,", "html = _fetch(url, render)")
    loop = sources["apify.py"][sources["apify.py"].find("while queue"):]
    if not re.search(r"if not allowed\(url, .*cache=robots\)\[0\]:\s*\n\s*refused\.append\(url\)\s*\n\s*continue", loop):
        bad.append("R2 apify.py does not skip a page robots.txt disallows before _fetch")
    elif loop.find("allowed(url") > loop.find("_fetch(url"):
        bad.append("R2 apify.py fetches before it asks robots.txt")
    return bad


def check(robots_src: str, sources: dict, base: str, dead: str) -> list:
    return r1(load(robots_src), base, dead) + r2(sources)


def main() -> int:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    dead = f"http://127.0.0.1:{s.getsockname()[1]}"  # bound, never listening: refused
    s.close()

    robots = open(os.path.join(SRC, "_robots.py"), encoding="utf-8").read()
    sources = {n: open(os.path.join(SRC, n), encoding="utf-8").read() for n in ("crawl.py", "cloudflare.py", "firecrawl.py", "apify.py")}
    failures = 0

    bad = check(robots, sources, base, dead)
    for b in bad:
        print("  FAIL  " + b)
    print("  PASS  R1-R2" if not bad else "")
    failures += len(bad)

    mutations = [
        ("5xx-allowed", "_robots.py", "status >= 500", "status >= 600", "R1 robots.txt 5xx"),
        ("403-allowed", "_robots.py", "status in (401, 403)", "status in (401,)", "R1 robots.txt 403"),
        ("404-forbidden", "_robots.py", "return True, f\"no robots.txt", "return False, f\"no robots.txt", "R1 no robots.txt (404)"),
        ("rules-ignored", "_robots.py", "if rp.can_fetch(agent, url):", "if True:", "R1 a path * disallows"),
        ("star-only", "_robots.py", "rp.can_fetch(agent, url)", "rp.can_fetch(\"*\", url)", "R1 our own group overrides *"),
        ("dead-host-allowed", "_robots.py", "except (urllib.error.URLError, OSError, ValueError):\n        return None, \"\"", "except (urllib.error.URLError, OSError, ValueError):\n        return 404, \"\"", "R1 a host that does not answer"),
        ("no-cache", "_robots.py", "if cache is not None and where in cache:", "if False:", "R1 a cached crawl read robots.txt"),
        ("crawl-ungated", "crawl.py", "    require(url, UA)\n", "", "R2 crawl.py never asks robots.txt"),
        ("cloudflare-ungated", "cloudflare.py", "    require(url, _UA)\n", "", "R2 cloudflare.py never asks robots.txt"),
        ("firecrawl-ungated", "firecrawl.py", "    require(url, _HEADERS[\"User-Agent\"])  # robots.txt first (#797)\n", "", "R2 firecrawl.py never asks robots.txt"),
        ("apify-ungated", "apify.py", "        if not allowed(url, _HEADERS[\"User-Agent\"], cache=robots)[0]:\n            refused.append(url)\n            continue\n", "", "R2 apify.py does not skip"),
    ]
    for name, file, old, new, want in mutations:
        r_src, srcs = robots, dict(sources)
        if file == "_robots.py":
            if old not in r_src:
                print(f"  VOID  MUT {name}: the edit did not land"); failures += 1; continue
            r_src = r_src.replace(old, new)
        else:
            if old not in srcs[file]:
                print(f"  VOID  MUT {name}: the edit did not land"); failures += 1; continue
            srcs[file] = srcs[file].replace(old, new)
        try:
            got = check(r_src, srcs, base, dead)
        except Exception as e:  # a mutant that crashes the check is still caught, for the wrong reason
            got = [f"crashed: {e}"]
        if not got:
            print(f"  FAIL  MUT {name}: the tester passed a broken gate"); failures += 1
        elif not any(want in g for g in got):
            print(f"  FAIL  MUT {name}: red for the wrong reason: {got}"); failures += 1
        else:
            print(f"  PASS  MUT {name}")
    server.shutdown()
    print(f"── R1-R2 + {len(mutations)} mutations: {failures} failure(s) ──")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
