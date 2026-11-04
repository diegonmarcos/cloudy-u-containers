"""robots.txt gate for the generic crawler (#797): a page is fetched only when the site's
robots.txt lets this agent fetch it.

RFC 9309 semantics, with urllib.robotparser's conservative choices where the RFC leaves room:
  robots.txt 2xx            -> its rules decide (the `scrappers-api` group if present, else `*`)
  robots.txt 401 / 403      -> everything disallowed
  any other 4xx             -> no rules, everything allowed (the site publishes none)
  5xx, or no answer at all  -> everything disallowed (the site could not have said yes)

Stdlib only, so the per-service tester runs without the image's dependencies. The leading
underscore keeps it out of main.py's platform auto-discovery.
"""
import urllib.error
import urllib.request
from urllib import robotparser
from urllib.parse import urlsplit

AGENT = "scrappers-api"


def robots_url(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}/robots.txt"


def _get(url: str, ua: str, timeout: float):
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, OSError, ValueError):
        return None, ""


def allowed(url: str, ua: str, agent: str = AGENT, timeout: float = 15, get=_get, cache: dict | None = None):
    """(may this agent fetch url, why) — the why is what a refused /scrape reports.

    [cache] (robots URL -> answer) lets one multi-page crawl read each robots.txt once."""
    where = robots_url(url)
    if cache is not None and where in cache:
        status, text = cache[where]
    else:
        status, text = get(where, ua, timeout)
        if cache is not None:
            cache[where] = (status, text)
    if status is None or status >= 500:
        return False, f"robots.txt unreachable ({status or 'no answer'}): treated as disallow-all"
    if status in (401, 403):
        return False, f"robots.txt answered {status}: treated as disallow-all"
    if status >= 400:
        return True, f"no robots.txt ({status})"
    rp = robotparser.RobotFileParser()
    rp.parse(text.splitlines())
    if rp.can_fetch(agent, url):
        return True, "allowed by robots.txt"
    return False, f"disallowed for {agent} by {where}"


def require(url: str, ua: str, **kw) -> None:
    """Raise PermissionError (a 422 from /scrape, with the reason) unless robots.txt allows url."""
    ok, why = allowed(url, ua, **kw)
    if not ok:
        raise PermissionError(f"{url}: {why}")
