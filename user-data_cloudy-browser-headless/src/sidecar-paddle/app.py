"""PaddleOCR sidecar for cloudy-browser-headless (SCAFFOLD, not built or deployed; tesseract is the shipping engine).

Contract used by code/ocr.js paddleRecognize:
  POST /ocr  {"image_base64": "...", "lang": "eng|fra|deu|spa|ita|por"}  ->  {"text": "...", "confidence": 0..100}
  Authorization: Bearer $PADDLE_OCR_TOKEN when the variable is set (the headless container sets PADDLE_OCR_URL / PADDLE_OCR_TOKEN).
Follow-up to ship: a separate image (python:3.11-slim, requirements.txt below, models baked in at build time), its own build.json entry,
mesh-only listener, mem_limit about 3G (PaddleOCR PP-OCRv4 server models), then set PADDLE_OCR_URL in the headless container environment.
Run: uvicorn app:app --host 127.0.0.1 --port 3119
"""
import base64, hmac, io, os
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

LANG = {"eng": "en", "fra": "fr", "deu": "german", "spa": "es", "ita": "it", "por": "pt"}
TOKEN = os.environ.get("PADDLE_OCR_TOKEN", "")
app = FastAPI()
_engines = {}


class Req(BaseModel):
    image_base64: str
    lang: str = "eng"


def engine(lang):
    if lang not in _engines:
        from paddleocr import PaddleOCR  # imported lazily: the model load is slow
        _engines[lang] = PaddleOCR(use_angle_cls=True, lang=LANG.get(lang.split("+")[0], "en"), show_log=False)
    return _engines[lang]


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/ocr")
def ocr(req: Req, authorization: str = Header(default="")):
    if TOKEN and not hmac.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(401, "bad token")
    import numpy as np
    from PIL import Image
    img = np.array(Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB"))
    res = engine(req.lang).ocr(img, cls=True) or [[]]
    lines = [(l[1][0], float(l[1][1])) for l in (res[0] or [])]
    conf = 100 * sum(c for _, c in lines) / len(lines) if lines else 0
    return {"text": "\n".join(t for t, _ in lines), "confidence": round(conf, 1)}
