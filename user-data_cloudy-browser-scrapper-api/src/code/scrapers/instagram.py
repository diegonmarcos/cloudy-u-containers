"""Instagram scraper: the repo dataset by default, instaloader as an opt-in live refresh.

#1686: a logged-out instaloader fetch from Cloud Run gets HTTP 429, so the default source is the
Instagram export already published in cloudy-u-android (ac_cloud-me/data/web/mysocials/
data-ig<N>-<handle>.json.js, the same data the My Socials page renders). source="live" runs the
instaloader path below unchanged.

Diego's account is PRIVATE, so anonymous access returns nothing — a dedicated BURNER
account (IG_BURNER_USER/IG_BURNER_PASS from dist/.secrets) that follows him is required.
The burner session is cached under SESSION_DIR so we log in rarely (login = the risky op).
NEVER use the main account here. Rate-limited; posts + followers + highlights + tagged.
"""
import os
from pathlib import Path

SESSION_DIR = Path(os.environ.get("SESSION_DIR", "/app/session"))


def _loader():
    import instaloader
    L = instaloader.Instaloader(
        download_pictures=False, download_videos=False, download_video_thumbnails=False,
        download_geotags=False, download_comments=False, save_metadata=False,
        max_connection_attempts=1,  # fail fast, don't hammer IG
    )
    user = os.environ.get("IG_BURNER_USER")
    pw = os.environ.get("IG_BURNER_PASS")
    if not user:
        return L, None  # anonymous (public profiles only)
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    sess = SESSION_DIR / f"session-{user}"
    try:
        L.load_session_from_file(user, str(sess))
    except FileNotFoundError:
        if not pw:
            raise RuntimeError("burner session missing and IG_BURNER_PASS unset")
        L.login(user, pw)                 # the one risky call — happens rarely
        L.save_session_to_file(str(sess))
    return L, user


# handle -> dataset file stem; the stems are the My Socials data files (DATA, not code: override with IG_DATASET_INDEX).
DATASET_BASE = os.environ.get(
    "IG_DATASET_BASE",
    "https://raw.githubusercontent.com/diegonmarcos/cloudy-u-android/main/ac_cloud-me/data/web/mysocials/",
)
DATASET_INDEX = {
    "diegocnmarcos_": "data-ig0-diegocnmarcos_",
    "diegocmarcos_": "data-ig1-diegocmarcos_",
    "diegonmarcos": "data-ig2-diegonmarcos",
}
if os.environ.get("IG_DATASET_INDEX"):
    import json as _json
    DATASET_INDEX.update(_json.loads(os.environ["IG_DATASET_INDEX"]))

_CACHE: dict = {}


def _fetch(url: str) -> str:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "scrappers-api"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def _parse_dataset(text: str) -> dict:
    """The .json.js wrapper is `g.PORTAL_DATA["<key>"] = {...};`: decode the object after the assignment."""
    import json
    i = text.index("] = ") + 4
    obj, _ = json.JSONDecoder().raw_decode(text[i:])
    return obj


def _repo(handle: str, max_posts: int | None) -> dict:
    stem = DATASET_INDEX.get(handle)
    if not stem:
        raise ValueError(f"no repo dataset for handle '{handle}' (known: {', '.join(sorted(DATASET_INDEX))}); use source=live")
    url = DATASET_BASE + stem + ".json.js"
    if url not in _CACHE:
        _CACHE[url] = _parse_dataset(_fetch(url))
    d = _CACHE[url]
    p = d.get("profile", {})
    posts = list(d.get("posts", []))
    if max_posts is not None:
        posts = posts[:max_posts]
    result = {
        "profile": {
            "username": p.get("username", handle),
            "full_name": p.get("name", ""),
            "biography": p.get("bio", ""),
            "followers": p.get("followers", 0),
            "following": p.get("following", 0),
            "posts": p.get("posts", len(d.get("posts", []))),
            "is_private": None,
            "photo": p.get("photo"),
        },
        "posts": posts,
        "highlights": d.get("highlights", []),
        "followers": d.get("followers", []),
        "tagged": [],
        # every other section of the export is kept as-is (Rule 16: nothing dropped)
        "export": {k: v for k, v in d.items() if k not in ("profile", "posts", "highlights", "followers")},
        "_source": {"kind": "repo", "url": url},
    }
    result["_summary"] = {
        "posts": len(posts), "followers_listed": len(result["followers"]),
        "highlights": len(result["highlights"]), "tagged": 0,
        "authenticated": False, "source": "repo",
        "export_sections": sorted(result["export"].keys()),
    }
    return result


def scrape(handle: str, max_posts: int = 60, source: str = "repo", **_):
    """source="repo" (default): the published export. source="live": instaloader (posts, followers, highlights, tagged)."""
    if source == "repo":
        return _repo(handle, max_posts)
    if source != "live":
        raise ValueError(f"unknown source '{source}' (repo | live)")
    import instaloader
    L, _who = _loader()
    profile = instaloader.Profile.from_username(L.context, handle)

    posts = []
    for i, post in enumerate(profile.get_posts()):
        if i >= max_posts:
            break
        posts.append({
            "shortcode": post.shortcode,
            "media": post.url,                 # thumbnail/display url
            "is_video": post.is_video,
            "caption": (post.caption or "")[:300],
            "likes": post.likes,
            "time": post.date_utc.isoformat(),
        })

    result = {
        "profile": {
            "username": profile.username,
            "full_name": profile.full_name,
            "biography": profile.biography,
            "followers": profile.followers,
            "following": profile.followees,
            "posts": profile.mediacount,
            "is_private": profile.is_private,
        },
        "posts": posts,
        "highlights": [],
        "followers": [],
        "tagged": [],
    }

    # Login-only data (needs the burner to be an accepted follower).
    if _who:
        try:
            result["highlights"] = [
                {"label": h.title, "cover": h.cover_url, "count": h.itemcount}
                for h in L.get_highlights(profile)
            ]
        except Exception:
            pass
        try:
            result["followers"] = [f.username for f in profile.get_followers()]
        except Exception:
            pass
        try:
            result["tagged"] = [p.url for p in profile.get_tagged_posts()]
        except Exception:
            pass

    result["_summary"] = {
        "posts": len(posts), "followers_listed": len(result["followers"]),
        "highlights": len(result["highlights"]), "tagged": len(result["tagged"]),
        "authenticated": bool(_who), "source": "live",
    }
    return result
