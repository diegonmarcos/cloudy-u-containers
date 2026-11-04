"""Pinterest scraper via gallery-dl (public boards, no login needed).

gallery-dl resolves a board URL to its pins; we take the image urls + captions.
"""
import json
import subprocess


def scrape(board_url: str, max_pins: int = 100, **_):
    if not board_url:
        raise ValueError("board_url required")
    # gallery-dl --dump-json emits one JSON array of [msg_type, url, metadata] tuples.
    cmd = ["gallery-dl", "--dump-json", "--range", f"1-{max_pins}", board_url]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(f"gallery-dl failed: {proc.stderr.strip()[:300]}")

    pins = []
    for entry in json.loads(proc.stdout or "[]"):
        # entry = [type, url, meta] for downloadable items (type == 3).
        if isinstance(entry, list) and len(entry) >= 3 and isinstance(entry[2], dict):
            meta = entry[2]
            pins.append({
                "media": entry[1] if isinstance(entry[1], str) else meta.get("url", ""),
                "caption": meta.get("description") or meta.get("title") or "",
                "board": meta.get("board", {}).get("name", "") if isinstance(meta.get("board"), dict) else "",
            })

    return {"board_url": board_url, "pins": pins, "_summary": {"pins": len(pins)}}
