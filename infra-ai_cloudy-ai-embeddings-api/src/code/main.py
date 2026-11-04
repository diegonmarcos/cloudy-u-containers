"""Fleet embeddings + rerank + PDF text server (mesh-only).

Infinity (https://github.com/michaelfeil/infinity) serves the OpenAI-compatible POST /embeddings (bge-m3), POST /rerank
(bge-reranker-v2-m3), GET /models; gate.py is the ASGI front that listens at once, answers /health, /ready and POST /pdf
(raw application/pdf body -> {pages, text}) and forwards the rest once the models are loaded. The weights are fetched off the
event loop first (so /health stays answerable during the download), then Infinity's own startup loads them from the cache.
Models and sizes come from build.json via the environment (compose.nix); nothing is hardcoded here beyond the defaults.
"""
import asyncio
import os

from huggingface_hub import snapshot_download
from infinity_emb import create_server
from infinity_emb.args import EngineArgs

import gate

BATCH = int(os.environ.get("BATCH_SIZE", "8"))
MODELS = [os.environ.get("EMBED_MODEL", "BAAI/bge-m3"), os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-v2-m3")]
SKIP = ["onnx/*", "*.onnx", "*.onnx_data", "*.msgpack", "*.h5", "*.ot", "imgs/*", "*.md"]


def _args(model: str) -> EngineArgs:
    # CPU torch, no BetterTransformer (needs optimum), no warmup (a max-batch warmup doubles peak RAM); the served name is the
    # model id, so clients send "BAAI/bge-m3" / "BAAI/bge-reranker-v2-m3".
    return EngineArgs(model_name_or_path=model, served_model_name=model, engine="torch", device="cpu", batch_size=BATCH,
                      bettertransformer=False, model_warmup=False, trust_remote_code=False)


state = gate.State()
infinity = create_server(engine_args_list=[_args(m) for m in MODELS])


async def load():
    """Download (off the loop), then run Infinity's startup; on any failure record it and retry with a growing pause."""
    loop = asyncio.get_running_loop()
    delay = 5
    while True:
        try:
            for model in MODELS:
                await loop.run_in_executor(None, lambda m=model: snapshot_download(m, ignore_patterns=SKIP))
            await infinity.router.lifespan_context(infinity).__aenter__()
            state.ready, state.error = True, None
            return
        except Exception as e:  # noqa: BLE001 - a failed load is retried, never fatal to /health
            state.error = ("%s: %s" % (type(e).__name__, e))[:300]
            await asyncio.sleep(delay)
            delay = min(delay * 2, 300)


app = gate.build(state, infinity, load)
