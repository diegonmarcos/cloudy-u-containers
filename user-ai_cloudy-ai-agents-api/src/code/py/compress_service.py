#!/usr/bin/env python3
"""compress_service — the my-ai-api compression sidecar + savings dashboard.

A thin, owned FastAPI surface over the vendored Headroom engine. The Node front
POSTs messages here before every OpenRouter forward; we return the compressed
messages plus token metrics, and keep a durable lifetime ledger so /stats and
/dashboard show real savings.

This is the *compress-only* path (`from headroom import compress`) — no upstream
forwarding, no API key. Identical to claude-superset-api's compress_service.py;
the only differences are the service title (my-ai-api) and the default model slug
(an OpenRouter slug, not a Claude one). ML "Kompress" is left disabled by
default on arm64 (SmartCrusher JSON + AST CodeCompressor still run); enable via
HEADROOM_KOMPRESS=<model-id> if a GPU/host can afford it.
"""
from __future__ import annotations

import json
import os
import re
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
PORT = int(os.environ.get("HEADROOM_PORT", "8890"))
PROFILE = os.environ.get("HEADROOM_SAVINGS_PROFILE", "agent-90")
KOMPRESS = os.environ.get("HEADROOM_KOMPRESS", "disabled")  # ML off by default on arm64
MIN_TOKENS = int(os.environ.get("HEADROOM_MIN_TOKENS", "250"))
WORKSPACE = Path(os.environ.get("HEADROOM_WORKSPACE_DIR", str(Path.home() / ".headroom")))
LEDGER = Path(os.environ.get("HEADROOM_SAVINGS_PATH", str(WORKSPACE / "proxy_savings.json")))

# ── Plugin: Caveman — linguistic filler stripping ─────────────────────────────
CAVEMAN_ENABLED = os.environ.get("CAVEMAN_ENABLED", "1") not in ("0", "false", "no")

_FILLER_PATTERNS = [re.compile(p, re.IGNORECASE) for p in [
    r"^(Sure|Certainly|Of course|Absolutely|No problem|Got it|Understood|Will do)[!,.]?\s*",
    r"^I('d| would) (be happy to|love to|be glad to) (help|assist|explain|show)[^.!]*[.!]?\s*",
    r"^(Great|Excellent|Perfect|Awesome)(question|point|idea|choice)?[!,.]?\s*",
    r"^Let me (know|help|explain|break (that|it|this) down|walk you through)[^.!]*[.!]?\s*",
    r"^(Here is|Here's|I'll|Allow me)[^.!]{0,40}\.\s*",
]]
_TRIPLE_BLANK_RE = re.compile(r"\n{3,}")
_EMPTY_CODE_FENCE_RE = re.compile(r"```\s*```", re.MULTILINE)


def _caveman_filter(messages: list[dict]) -> list[dict]:
    """Strip assistant filler phrases + collapse whitespace inflation before Headroom."""
    out: list[dict] = []
    for msg in messages:
        if msg.get("role") != "assistant":
            out.append(msg)
            continue
        content = msg.get("content", "")
        if not isinstance(content, str):
            out.append(msg)
            continue
        for pat in _FILLER_PATTERNS:
            content = pat.sub("", content, count=1)
        content = _EMPTY_CODE_FENCE_RE.sub("", content)
        content = _TRIPLE_BLANK_RE.sub("\n\n", content).strip()
        if content:
            out.append({**msg, "content": content})
        # fully-empty assistant turns are dropped
    return out or messages  # never return empty list

app = FastAPI(title="my-ai-api · compress", docs_url=None, redoc_url=None)


def _load_ledger() -> dict[str, Any]:
    try:
        return json.loads(LEDGER.read_text())
    except Exception:
        return {"compressions": 0, "tokens_before": 0, "tokens_after": 0,
                "tokens_saved": 0, "since": int(time.time())}


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
    model: str = "z-ai/glm-5"
    savings_profile: str | None = None
    caveman_enabled: bool | None = None  # None → use CAVEMAN_ENABLED env default


@app.get("/health")
@app.get("/readyz")
@app.get("/livez")
def health() -> JSONResponse:
    return JSONResponse({"status": "ok", "engine": "headroom", "caveman": CAVEMAN_ENABLED, "ledger": str(LEDGER)})


@app.post("/compress")
def do_compress(body: CompressIn) -> JSONResponse:
    profile = body.savings_profile or PROFILE
    use_caveman = body.caveman_enabled if body.caveman_enabled is not None else CAVEMAN_ENABLED
    msgs = _caveman_filter(body.messages) if use_caveman else body.messages
    try:
        result = compress(
            msgs,
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
<title>my-ai-api · savings</title>
<style>body{font:14px system-ui;margin:2rem;background:#0b0e14;color:#cdd6f4}
h1{font-size:1.2rem}.k{color:#89b4fa}.v{color:#a6e3a1;font-weight:600}
table{border-collapse:collapse}td{padding:.3rem .8rem}</style></head><body>
<h1>my-ai-api — Headroom savings (upstream: OpenRouter)</h1>
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
