#!/usr/bin/env python3
"""The ledger must survive a foreign document at its path.

This is the exact regression behind `KeyError: 'compressions'`: headroom's
own SavingsTracker resolves the same workspace directory, and the two used
to agree on the filename `proxy_savings.json`. Its document parses perfectly
and carries none of the counters the compress service increments, so the
first POST /compress after any headroom path ran would crash.

Runs standalone — `python3 test_compress_ledger.py` — no framework, no
network, no build. It exercises _load_ledger directly because that is where
the totality guarantee lives.
"""
import json
import os
import sys
import tempfile

TRACKER_SHAPED = {
    "schema_version": 2,
    "lifetime": {"tokens": 123, "usd": 4.5},
    "display_session": {"started": 1757000000},
    "history": [],
    "projects": {},
}


def _load(tmpdir: str, contents=None):
    path = os.path.join(tmpdir, "ledger.json")
    if contents is not None:
        with open(path, "w") as handle:
            json.dump(contents, handle)
    os.environ["HEADROOM_SAVINGS_PATH"] = path
    os.environ["HEADROOM_WORKSPACE_DIR"] = tmpdir
    for stale in ("compress_service",):
        sys.modules.pop(stale, None)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import compress_service  # imported after the env is set — LEDGER is module-level
    return compress_service


def main() -> int:
    counters = ("compressions", "tokens_before", "tokens_after", "tokens_saved")

    with tempfile.TemporaryDirectory() as tmp:
        service = _load(tmp, TRACKER_SHAPED)
        led = service._load_ledger()
        for key in counters:
            assert key in led, f"foreign document lost counter {key}"
            assert led[key] == 0, f"{key} should default to 0, got {led[key]!r}"
        # The foreign keys are preserved rather than dropped: this file is
        # someone else's document only by accident, and discarding data on
        # read would turn a crash into silent loss.
        assert led["schema_version"] == 2
        led["compressions"] += 1  # the line that used to raise
        assert led["compressions"] == 1

    with tempfile.TemporaryDirectory() as tmp:
        service = _load(tmp, {"compressions": "17", "tokens_saved": None})
        led = service._load_ledger()
        assert led["compressions"] == 17, "a string counter must coerce, not crash"
        assert led["tokens_saved"] == 0, "an unusable counter falls back to 0"

    with tempfile.TemporaryDirectory() as tmp:
        service = _load(tmp)  # no file at all
        led = service._load_ledger()
        assert all(led[k] == 0 for k in counters)

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "ledger.json")
        with open(path, "w") as handle:
            handle.write("[1, 2, 3]")  # parses, but is not a dict
        os.environ["HEADROOM_SAVINGS_PATH"] = path
        sys.modules.pop("compress_service", None)
        import compress_service
        assert compress_service._load_ledger()["compressions"] == 0

    # The default path must not be the one headroom's SavingsTracker writes.
    os.environ.pop("HEADROOM_SAVINGS_PATH", None)
    sys.modules.pop("compress_service", None)
    import compress_service
    assert compress_service.LEDGER.name != "proxy_savings.json", (
        "default ledger filename collides with headroom's SavingsTracker again"
    )

    print("ok — ledger is total against foreign, malformed and missing files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
