"""#1872/#1877: SHADOW_MIRROR_URL replays each /auth decision to the Go port and compares, log only.
Off by default; never changes the live answer; counts match/mismatch; never logs a token."""
import http.server
import logging
import os
import sys
import threading
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "code"))
os.environ.setdefault("TOKENS_VERIFY_URL", "http://engine.invalid/v1/verify")
os.environ.setdefault("TOKENS_VERIFY_SECRET", "s")
import main  # noqa: E402

SECRET_TOKEN = "Bearer notajwt_supersecretvalue123"


class FakeGo:
    def __init__(self):
        self.status, self.body, self.hdrs, self.seen = 401, b"Invalid token", {}, []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.seen.append(dict(self.headers))
                self.send_response(outer.status)
                for k, v in outer.hdrs.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(outer.body)))
                self.end_headers()
                self.wfile.write(outer.body)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d" % self.srv.server_port


@pytest.fixture()
def go(monkeypatch):
    f = FakeGo()
    monkeypatch.setattr(main, "SHADOW_MIRROR_URL", f.url)
    for k in main._shadow_stats:
        main._shadow_stats[k] = 0
    yield f
    f.srv.shutdown()


def _call(tok=SECRET_TOKEN):
    return main.app.test_client().get("/auth", headers={"Authorization": tok})


def _wait(key, n=1):
    for _ in range(100):
        if main._shadow_stats[key] >= n:
            return
        time.sleep(0.05)
    raise AssertionError(main._shadow_stats)


def test_off_by_default_is_inert(monkeypatch):
    monkeypatch.setattr(main, "SHADOW_MIRROR_URL", "")
    assert _call().status_code == 401
    assert sum(main._shadow_stats[k] for k in ("match", "mismatch", "dropped", "mirror_error")) == 0


def test_match_is_counted_and_headers_replayed(go):
    r = _call()
    assert r.status_code == 401 and r.get_data() == b"Invalid token"
    _wait("match")
    assert go.seen[0]["Authorization"] == SECRET_TOKEN
    assert main._shadow_stats["mismatch"] == 0


def test_status_mismatch_is_counted_and_live_answer_unchanged(go, caplog):
    go.status = 200
    with caplog.at_level(logging.ERROR):
        r = _call()
        _wait("mismatch")
    assert r.status_code == 401
    assert "shadow-mirror MISMATCH" in caplog.text
    assert "supersecretvalue123" not in caplog.text


def test_body_mismatch_detected(go):
    go.body = b"Token expired"
    _call()
    _wait("mismatch")


def test_identity_header_mismatch_detected(go):
    go.hdrs = {"X-Auth-User": "someone"}
    _call()
    _wait("mismatch")


def test_dead_mirror_never_breaks_live_path(monkeypatch):
    monkeypatch.setattr(main, "SHADOW_MIRROR_URL", "http://127.0.0.1:9")
    for k in main._shadow_stats:
        main._shadow_stats[k] = 0
    assert _call().status_code == 401
    _wait("mirror_error")


def test_stats_endpoint(go):
    r = main.app.test_client().get("/shadow-stats")
    assert r.status_code == 200 and r.get_json()["enabled"] is True
