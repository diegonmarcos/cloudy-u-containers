"""Instagram scraper via instaloader.

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


def scrape(handle: str, max_posts: int = 60, **_):
    """Return the profile's posts (thumb urls), followers, highlights, tagged, counts."""
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
        "authenticated": bool(_who),
    }
    return result
