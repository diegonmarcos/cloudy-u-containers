"""PDF to plain text, pure Python (pypdf): no native tools, same on arm64 and amd64."""
import io

from pypdf import PdfReader

MAX_BYTES = 25 * 1024 * 1024
MAX_PAGES = 500


def extract(data: bytes) -> dict:
    """Returns {pages, text, truncated}; raises ValueError for an empty, oversized or unreadable PDF."""
    if not data:
        raise ValueError("empty body")
    if len(data) > MAX_BYTES:
        raise ValueError("pdf larger than %d bytes" % MAX_BYTES)
    if not data.lstrip()[:5].startswith(b"%PDF"):
        raise ValueError("not a PDF")
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise ValueError("encrypted PDF")
        total = len(reader.pages)
        parts = []
        for page in list(reader.pages)[:MAX_PAGES]:
            parts.append((page.extract_text() or "").strip())
    except ValueError:
        raise
    except Exception as e:  # pypdf raises many types on damaged files
        raise ValueError("unreadable PDF: %s" % type(e).__name__)
    return {"pages": total, "text": "\n\n".join(p for p in parts if p), "truncated": total > MAX_PAGES}
