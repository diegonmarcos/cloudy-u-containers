"""The ASGI front of the embeddings service: it listens at once and loads the models behind it.

Infinity downloads (about 4.6 GB the first time) and loads both models before it serves a request, so a bare Infinity server
is not listening for minutes after a deploy and the ship's 120 s health wait fails. This front answers /health (liveness: the
process is up) and /ready (readiness: 200 only once the models are loaded) and /pdf itself, forwards every other path to the
Infinity app once it is ready and answers 503 until then (callers fall back to their own ranking).
"""
import asyncio

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

import pdftext


class State:
    """Loader state: ready flips true when the models are up; error holds the last load failure."""
    def __init__(self):
        self.ready = False
        self.error = None


def build(state: State, inner, load):
    """Returns the ASGI app. [inner] is the Infinity app, [load] a coroutine function started at server startup."""
    shell = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    tasks = []

    @shell.get("/health")
    async def health():
        return {"status": "ok", "ready": state.ready}

    @shell.get("/ready")
    async def ready():
        if not state.ready:
            raise HTTPException(status_code=503, detail=state.error or "models loading")
        return {"ready": True}

    @shell.post("/pdf")
    async def pdf(request: Request):
        data = await request.body()
        try:
            return await run_in_threadpool(pdftext.extract, data)
        except ValueError as e:
            raise HTTPException(status_code=413 if "larger" in str(e) else 422, detail=str(e))

    async def loading(send):
        body = b'{"detail":"models loading, try again shortly"}'
        await send({"type": "http.response.start", "status": 503,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"retry-after", b"30")]})
        await send({"type": "http.response.body", "body": body})

    async def app(scope, receive, send):
        kind = scope["type"]
        if kind == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    tasks.append(asyncio.get_running_loop().create_task(load()))
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if kind == "http" and scope.get("path") in ("/health", "/ready", "/pdf"):
            return await shell(scope, receive, send)
        if not state.ready:
            if kind == "http":
                return await loading(send)
            return
        return await inner(scope, receive, send)

    return app
