"""#1428/#1429 YouTube Download for the Cloud Browser Scrap Tools (libs:scraper calls this).

Extraction runs here, not on the phone: yt-dlp is heavy and changes often. The phone keeps the
light paths (audio extract from an already downloaded file, libs:media-convert-audio).
Legal: YouTube's ToS restricts downloading; clients show "Only download content you have rights to".

Modes: video (best video+audio up to `quality` p), audio (best audio-only stream, bitrate cap
`quality` kbps), audio_extract (best video downloaded, audio track extracted to m4a by ffmpeg).
yt-dlp is imported lazily so the stdlib tester can check the pure request rules.
"""
import re
import tempfile
from pathlib import Path

MODES = ("video", "audio", "audio_extract")
VIDEO_Q = (2160, 1440, 1080, 720, 480, 360, 240, 144)
AUDIO_Q = (320, 256, 160, 128, 96, 64)
_YT = re.compile(r"^https://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|live/)|youtu\.be/)")


def validate(url: str, mode: str, quality: int | None) -> None:
    if not url or not _YT.match(url):
        raise ValueError("url must be an https YouTube video link")
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if quality is not None:
        allowed = AUDIO_Q if mode == "audio" else VIDEO_Q
        if quality not in allowed:
            raise ValueError(f"quality {quality} not in {allowed}")


def format_selector(mode: str, quality: int | None) -> str:
    if mode == "audio":
        return f"bestaudio[abr<={quality}]/bestaudio" if quality else "bestaudio"
    h = f"[height<={quality}]" if quality else ""
    return f"bestvideo{h}+bestaudio/best{h}"


def ydl_options(mode: str, quality: int | None, out_dir: str) -> dict:
    opts = {
        "format": format_selector(mode, quality),
        "outtmpl": str(Path(out_dir) / "%(title).80s [%(id)s].%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "restrictfilenames": True,
    }
    if mode == "video":
        opts["merge_output_format"] = "mp4"
    if mode == "audio_extract":
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}]
    return opts


def download(url: str, mode: str, quality: int | None = None) -> Path:
    validate(url, mode, quality)
    import yt_dlp  # lazy: image dependency only
    out = tempfile.mkdtemp(prefix="ytdl-")
    with yt_dlp.YoutubeDL(ydl_options(mode, quality, out)) as y:
        y.extract_info(url, download=True)
    files = sorted(Path(out).iterdir(), key=lambda p: p.stat().st_size, reverse=True)
    if not files:
        raise RuntimeError("yt-dlp produced no file")
    return files[0]
