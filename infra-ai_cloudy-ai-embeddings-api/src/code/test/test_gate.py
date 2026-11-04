import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import gate  # noqa: E402
from test_pdftext import PDF  # noqa: E402


async def call(app, method, path, body=b""):
    """Drives the ASGI app once, with no server: returns (status, body)."""
    sent = []
    fed = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive():
        return fed.pop(0) if fed else {"type": "http.disconnect"}

    async def send(m):
        sent.append(m)

    await app({"type": "http", "method": method, "path": path, "raw_path": path.encode(), "query_string": b"", "headers": [],
               "scheme": "http", "server": ("t", 80), "client": ("c", 1), "http_version": "1.1", "root_path": ""}, receive, send)
    status = next(m["status"] for m in sent if m["type"] == "http.response.start")
    return status, b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")


class Gate(unittest.TestCase):
    def setUp(self):
        self.state = gate.State()
        self.inner_calls = []

        async def inner(scope, receive, send):
            self.inner_calls.append(scope["path"])
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"inner"})

        async def load():
            self.state.ready = True

        self.load = load
        self.app = gate.build(self.state, inner, load)

    def run_(self, *a):
        return asyncio.run(call(self.app, *a))

    def test_health_answers_before_the_models_are_loaded(self):
        status, body = self.run_("GET", "/health")
        self.assertEqual(status, 200)
        self.assertIn(b'"ready":false', body)

    def test_ready_is_503_until_loaded_and_carries_the_error(self):
        self.state.error = "boom"
        status, body = self.run_("GET", "/ready")
        self.assertEqual(status, 503)
        self.assertIn(b"boom", body)
        self.state.ready = True
        self.assertEqual(self.run_("GET", "/ready")[0], 200)

    def test_other_paths_are_503_while_loading_and_forwarded_after(self):
        self.assertEqual(self.run_("POST", "/embeddings", b"{}")[0], 503)
        self.assertEqual(self.inner_calls, [])
        self.state.ready = True
        self.assertEqual(self.run_("POST", "/embeddings", b"{}"), (200, b"inner"))
        self.assertEqual(self.inner_calls, ["/embeddings"])

    def test_pdf_is_served_by_the_front_even_while_loading(self):
        status, body = self.run_("POST", "/pdf", PDF)
        self.assertEqual(status, 200)
        self.assertIn(b"Hello fleet", body)
        self.assertEqual(self.run_("POST", "/pdf", b"not a pdf")[0], 422)
        self.assertEqual(self.inner_calls, [])

    def test_lifespan_starts_the_loader_and_completes(self):
        async def go():
            inbox = asyncio.Queue()
            sent = []
            await inbox.put({"type": "lifespan.startup"})

            async def send(m):
                sent.append(m["type"])
                if m["type"] == "lifespan.startup.complete":
                    await asyncio.sleep(0)       # let the loader task run
                    await inbox.put({"type": "lifespan.shutdown"})

            await self.app({"type": "lifespan"}, inbox.get, send)
            return sent

        sent = asyncio.run(go())
        self.assertEqual(sent, ["lifespan.startup.complete", "lifespan.shutdown.complete"])
        self.assertTrue(self.state.ready)


if __name__ == "__main__":
    unittest.main()
