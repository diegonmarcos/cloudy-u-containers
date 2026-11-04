"""YouTube public playlist scraper — no API key, no browser, no OAuth.

Fetches the playlist page and parses the embedded `ytInitialData` JSON that
YouTube server-renders into the HTML. Returns the ordered track list.
Public (or unlisted-with-link) playlists only.

ponytail: first page only (~100 tracks). YouTube paginates the rest behind
InnerTube continuation tokens (POST /youtubei/v1/browse). `_summary.truncated`
flags when there's more; wire continuation-following only when a >100-track
playlist actually needs full coverage — not before.

Known ceiling: depends on YouTube's `ytInitialData` shape (currently the
`lockupViewModel` component — the old `playlistVideoRenderer` was retired).
If YouTube changes the markup, update the extraction here — that's the inherent
cost of HTML scraping vs. the Data API (which needs a key/quota). READ-ONLY:
this lists a public playlist; it cannot write/sync to an account.
"""
import json
import re

import httpx

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_YTINIT = re.compile(r"ytInitialData\s*=\s*(\{.*?\})\s*;\s*</script>", re.DOTALL)
_LIST_ID = re.compile(r"[?&]list=([A-Za-z0-9_-]+)")
_DUR = re.compile(r"^\d+(?::\d{2}){1,2}$")  # 3:55 or 1:02:03
_CHANNEL_PREFIX = "Go to channel "


def _playlist_url(playlist_url=None, playlist_id=None, url=None) -> tuple[str, str]:
    raw = playlist_url or url or ""
    pid = playlist_id
    if not pid and raw:
        m = _LIST_ID.search(raw)
        pid = m.group(1) if m else None
    if not pid:
        raise ValueError("need playlist_id or a playlist_url containing ?list=<ID>")
    return f"https://www.youtube.com/playlist?list={pid}", pid


def _extract_init(html: str) -> dict:
    m = _YTINIT.search(html)
    if not m:
        raise RuntimeError("ytInitialData not found (playlist private/empty, or YouTube markup changed)")
    return json.loads(m.group(1))


def _collect_key(node, key: str, out: list) -> None:
    """In-order walk collecting every value under `key` (preserves document/playlist order)."""
    if isinstance(node, dict):
        if key in node:
            out.append(node[key])
        for v in node.values():
            _collect_key(v, key, out)
    elif isinstance(node, list):
        for v in node:
            _collect_key(v, key, out)


def _find(node, pred):
    """First value anywhere in the tree satisfying pred(value) -> bool, else None."""
    if pred(node):
        return node
    if isinstance(node, dict):
        for v in node.values():
            r = _find(v, pred)
            if r is not None:
                return r
    elif isinstance(node, list):
        for v in node:
            r = _find(v, pred)
            if r is not None:
                return r
    return None


def _duration_seconds(text: str):
    if not text:
        return None
    parts = [int(p) for p in text.split(":")]
    s = 0
    for p in parts:
        s = s * 60 + p
    return s


def scrape(playlist_url=None, playlist_id=None, url=None, **_):
    target, pid = _playlist_url(playlist_url, playlist_id, url)
    # SOCS=CAI skips YouTube's EU cookie-consent interstitial (which otherwise
    # 302s cookieless requests to consent.youtube.com and strips ytInitialData).
    # Same minimal value yt-dlp uses. Verified empirically 2026-07.
    with httpx.Client(
        follow_redirects=True, timeout=30,
        headers={"User-Agent": UA}, cookies={"SOCS": "CAI"},
    ) as c:
        resp = c.get(target, params={"hl": "en"})
        resp.raise_for_status()
    data = _extract_init(resp.text)

    lockups: list = []
    _collect_key(data, "lockupViewModel", lockups)

    tracks = []
    for lv in lockups:
        if lv.get("contentType") != "LOCKUP_CONTENT_TYPE_VIDEO":
            continue
        vid = lv.get("contentId")
        if not vid:
            continue
        md = lv.get("metadata", {}).get("lockupMetadataViewModel", {})
        title_node = md.get("title")
        title = title_node.get("content", "") if isinstance(title_node, dict) else ""
        label = _find(md, lambda n: isinstance(n, str) and n.startswith(_CHANNEL_PREFIX))
        artist = label[len(_CHANNEL_PREFIX):] if label else ""
        dur = _find(lv.get("contentImage", {}), lambda n: isinstance(n, str) and _DUR.match(n)) or ""
        tracks.append({
            "title": title,
            "artist": artist,           # uploading channel
            "video_id": vid,
            "url": f"https://www.youtube.com/watch?v={vid}",
            "duration": dur,
            "duration_seconds": _duration_seconds(dur),
        })

    more: list = []
    _collect_key(data, "continuationItemRenderer", more)
    return {
        "playlist_url": target,
        "playlist_id": pid,
        "tracks": tracks,
        "_summary": {"tracks": len(tracks), "truncated": bool(more)},
    }


if __name__ == "__main__":  # smoke test (needs network) — a large stable public playlist
    out = scrape(playlist_id="PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI")
    assert out["_summary"]["tracks"] > 0, "expected at least one track"
    assert all(t["video_id"] and t["title"] for t in out["tracks"]), "tracks need id+title"
    print(f"OK — {out['_summary']['tracks']} tracks, truncated={out['_summary']['truncated']}")
    print("sample:", out["tracks"][0])
