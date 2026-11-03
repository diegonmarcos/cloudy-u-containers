#!/usr/bin/env python3
"""#1429 tester: YouTube download request rules (ytdl.py).

  Y1 validate: https YouTube links only (watch, shorts, youtu.be); others and http refused.
  Y2 validate: mode in video|audio|audio_extract; quality from the mode's own ladder.
  Y3 format_selector: audio caps abr, video caps height, no quality = best.
  Y4 ydl_options: no playlists; video merges to mp4; audio_extract adds FFmpegExtractAudio m4a.
  MUT each rule above, broken on a copy of the source, makes this tester fail.

Stdlib only; run from src/code.
"""
import sys, types
from pathlib import Path

SRC = (Path(__file__).parent / "ytdl.py").read_text()


def load(src):
    m = types.ModuleType("ytdl_t")
    exec(compile(src, "ytdl.py", "exec"), m.__dict__)
    return m


def check(m):
    def bad(*a):
        try:
            m.validate(*a)
        except ValueError:
            return True
        return False
    assert not bad("https://www.youtube.com/watch?v=abc", "video", 720), "Y1 watch"
    assert not bad("https://youtu.be/abc", "audio", 128), "Y1 youtu.be"
    assert not bad("https://www.youtube.com/shorts/abc", "audio_extract", None), "Y1 shorts"
    assert bad("http://www.youtube.com/watch?v=abc", "video", None), "Y1 http"
    assert bad("https://evil.com/youtube.com/watch?v=a", "video", None), "Y1 host"
    assert bad("https://www.youtube.com/watch?v=abc", "mp3", None), "Y2 mode"
    assert bad("https://www.youtube.com/watch?v=abc", "video", 128), "Y2 video ladder"
    assert bad("https://www.youtube.com/watch?v=abc", "audio", 720), "Y2 audio ladder"
    assert m.format_selector("audio", 128) == "bestaudio[abr<=128]/bestaudio", "Y3 audio"
    assert m.format_selector("audio", None) == "bestaudio", "Y3 audio best"
    assert m.format_selector("video", 720) == "bestvideo[height<=720]+bestaudio/best[height<=720]", "Y3 video"
    assert m.format_selector("audio_extract", None) == "bestvideo+bestaudio/best", "Y3 extract"
    o = m.ydl_options("video", 1080, "/x")
    assert o["noplaylist"] is True and o["merge_output_format"] == "mp4", "Y4 video"
    assert "postprocessors" not in o, "Y4 video no pp"
    e = m.ydl_options("audio_extract", None, "/x")
    assert e["postprocessors"] == [{"key": "FFmpegExtractAudio", "preferredcodec": "m4a"}], "Y4 extract"
    assert "merge_output_format" not in e, "Y4 extract no merge"
    assert "merge_output_format" not in m.ydl_options("audio", None, "/x"), "Y4 audio"


MUTANTS = {
    "Y1 http": ('^https://', '^https?://'),
    "Y1 host": ('(www\\.|m\\.|music\\.)?', '.*'),
    "Y2 mode": ('if mode not in MODES', 'if False'),
    "Y2 ladder": ('AUDIO_Q if mode == "audio" else VIDEO_Q', 'AUDIO_Q + VIDEO_Q'),
    "Y3 abr": ('[abr<={quality}]', '[abr>={quality}]'),
    "Y3 height": ('[height<={quality}]', '[height>={quality}]'),
    "Y4 playlist": ('"noplaylist": True', '"noplaylist": False'),
    "Y4 merge": ('if mode == "video":', 'if mode != "audio":'),
    "Y4 extract": ('"preferredcodec": "m4a"', '"preferredcodec": "mp3"'),
}

if __name__ == "__main__":
    check(load(SRC))
    print("real source: green")
    survived = []
    for name, (a, b) in MUTANTS.items():
        assert a in SRC, f"mutant anchor missing: {name}"
        try:
            check(load(SRC.replace(a, b, 1)))
            survived.append(name)
        except AssertionError:
            pass
    if survived:
        print("SURVIVED:", survived); sys.exit(1)
    print(f"{len(MUTANTS)} mutants killed")
