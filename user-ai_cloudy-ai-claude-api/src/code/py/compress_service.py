#!/usr/bin/env python3
"""compress_service — the superset's compression sidecar + savings dashboard.

A thin, owned FastAPI surface over the vendored Headroom engine. The Node front
POSTs messages here before every `claude -p`; we return the compressed messages
plus token metrics, and keep a durable lifetime ledger so /stats and /dashboard
show real savings.

This is the *compress-only* path (`from headroom import compress`) — no upstream
forwarding, no metered API key. ML "Kompress" is left disabled by default on
arm64 (SmartCrusher JSON + AST CodeCompressor still run); enable via
HEADROOM_KOMPRESS=<model-id> if a GPU/host can afford it.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel

from headroom import compress  # vendored, Apache-2.0

# Fail-closed default: bind loopback only. Prod (compose.nix) overrides to the
# WireGuard IP. NEVER default to 0.0.0.0 — with host networking that exposes the
# public NIC.
HOST = os.environ.get("HEADROOM_BIND", "127.0.0.1")
PORT = int(os.environ.get("HEADROOM_PORT", "8787"))
PROFILE = os.environ.get("HEADROOM_SAVINGS_PROFILE", "agent-90")
KOMPRESS = os.environ.get("HEADROOM_KOMPRESS", "disabled")  # ML off by default on arm64
MIN_TOKENS = int(os.environ.get("HEADROOM_MIN_TOKENS", "250"))
WORKSPACE = Path(os.environ.get("HEADROOM_WORKSPACE_DIR", str(Path.home() / ".headroom")))
# NOT proxy_savings.json. That filename belongs to headroom's own
# SavingsTracker, which resolves the same workspace directory and writes a
# completely different shape — {schema_version, lifetime, display_session,
# history, projects}, with no counters at the top level. Sharing the name
# meant the first headroom path to run in this container silently replaced
# this ledger with a document that parses fine and has none of the keys the
# counters below index, so the next POST /compress died on KeyError.
LEDGER = Path(os.environ.get("HEADROOM_SAVINGS_PATH", str(WORKSPACE / "superset_savings.json")))

# The counters every reader below indexes directly. Kept as one constant so
# the load path and the empty case cannot drift apart.
_LEDGER_DEFAULTS: dict[str, int] = {
    "compressions": 0, "tokens_before": 0, "tokens_after": 0, "tokens_saved": 0,
}

app = FastAPI(title="claude-api-superset · compress", docs_url=None, redoc_url=None)


def _load_ledger() -> dict[str, Any]:
    """The ledger, guaranteed to carry every counter its readers index.

    Falling back only when the file fails to PARSE was the bug: any JSON
    object that parses was trusted verbatim, so a foreign document — see the
    LEDGER comment above — passed straight through and the first increment
    raised KeyError. Merging over the defaults makes every reader total no
    matter what is on disk, and coercing to int means a string counter cannot
    turn an increment into a TypeError instead.
    """
    try:
        parsed = json.loads(LEDGER.read_text())
    except Exception:
        parsed = {}
    if not isinstance(parsed, dict):
        parsed = {}
    led: dict[str, Any] = {**_LEDGER_DEFAULTS, "since": int(time.time()), **parsed}
    for key in _LEDGER_DEFAULTS:
        try:
            led[key] = int(led[key])
        except (TypeError, ValueError):
            led[key] = 0
    return led


def _save_ledger(led: dict[str, Any]) -> None:
    try:
        WORKSPACE.mkdir(parents=True, exist_ok=True)
        tmp = LEDGER.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(led))
        tmp.replace(LEDGER)
    except Exception as exc:  # never let a ledger write fail a compression
        print(f"[compress] ledger write skipped: {exc}", flush=True)


LEDGER_STATE = _load_ledger()


class CompressIn(BaseModel):
    messages: list[dict[str, Any]]
    model: str = "claude-sonnet-4-6"
    savings_profile: str | None = None


@app.get("/health")
@app.get("/readyz")
@app.get("/livez")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "engine": "headroom", "ledger": str(LEDGER)})


@app.post("/compress")
def do_compress(body: CompressIn) -> JSONResponse:
    profile = body.savings_profile or PROFILE
    try:
        result = compress(
            body.messages,
            model=body.model,
            savings_profile=profile,
            kompress_model=KOMPRESS,
            min_tokens_to_compress=MIN_TOKENS,
        )
    except Exception as exc:
        # Fail open: hand back the originals so the front degrades to passthrough.
        print(f"[compress] error, passthrough: {exc}", flush=True)
        return JSONResponse({"messages": body.messages, "tokens_before": 0,
                             "tokens_after": 0, "tokens_saved": 0,
                             "compression_ratio": 0.0, "error": str(exc)})

    LEDGER_STATE["compressions"] += 1
    LEDGER_STATE["tokens_before"] += result.tokens_before
    LEDGER_STATE["tokens_after"] += result.tokens_after
    LEDGER_STATE["tokens_saved"] += result.tokens_saved
    _save_ledger(LEDGER_STATE)

    return JSONResponse({
        "messages": result.messages,
        "tokens_before": result.tokens_before,
        "tokens_after": result.tokens_after,
        "tokens_saved": result.tokens_saved,
        "compression_ratio": result.compression_ratio,
        "transforms_applied": result.transforms_applied,
    })


@app.get("/stats")
def stats() -> JSONResponse:
    led = LEDGER_STATE
    ratio = (led["tokens_saved"] / led["tokens_before"]) if led.get("tokens_before") else 0.0
    return JSONResponse({**led, "lifetime_ratio": round(ratio, 4)})


@app.get("/metrics")
def metrics() -> PlainTextResponse:
    led = LEDGER_STATE
    lines = [
        "# HELP headroom_compressions_total Total compression calls.",
        "# TYPE headroom_compressions_total counter",
        f"headroom_compressions_total {led['compressions']}",
        "# HELP headroom_tokens_saved_total Total tokens removed by compression.",
        "# TYPE headroom_tokens_saved_total counter",
        f"headroom_tokens_saved_total {led['tokens_saved']}",
        "# HELP headroom_tokens_before_total Total input tokens seen pre-compression.",
        "# TYPE headroom_tokens_before_total counter",
        f"headroom_tokens_before_total {led['tokens_before']}",
    ]
    return PlainTextResponse("\n".join(lines) + "\n")


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard() -> str:
    return """<!doctype html><html><head><meta charset=utf-8>
<title>claude-api-superset · savings</title>
<style>body{font:14px system-ui;margin:2rem;background:#0b0e14;color:#cdd6f4}
h1{font-size:1.2rem}.k{color:#89b4fa}.v{color:#a6e3a1;font-weight:600}
table{border-collapse:collapse}td{padding:.3rem .8rem}</style></head><body>
<h1>claude-api-superset — Headroom savings</h1>
<table id=t></table>
<script>
async function tick(){const s=await (await fetch('/stats')).json();
 const rows=[['compressions',s.compressions],['tokens before',s.tokens_before],
 ['tokens after',s.tokens_after],['tokens saved',s.tokens_saved],
 ['lifetime ratio',(s.lifetime_ratio*100).toFixed(1)+'%']];
 document.getElementById('t').innerHTML=rows.map(r=>
 `<tr><td class=k>${r[0]}</td><td class=v>${r[1]}</td></tr>`).join('');}
tick();setInterval(tick,3000);
</script></body></html>"""


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
