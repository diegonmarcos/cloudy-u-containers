#!/usr/bin/env python3
"""Reference driver for the mcp-oauth parity harness (#1877).

Loads the ORIGINAL Python service (infra-sec_mcp-oauth/src/code/main.py, unmodified) from PY_APP_DIR, with the
configuration in the environment as in production, and two test seams that only touch the module's own namespace:
  * `time` is a fake whose time() reads a file the harness writes (both sides see the same instant);
  * `secrets` is a deterministic byte stream (sha256(seed || counter)), so client ids, codes and tokens are
    identical on both sides when the same requests arrive in the same order. The Go side mirrors the stream.

  ref.py serve PORT CLOCKFILE SEED
"""
import base64
import hashlib
import importlib.util
import os
import sys
import types

APP = os.environ["PY_APP_DIR"]


class Stream:
    def __init__(self, seed):
        self.seed, self.ctr, self.buf = seed.encode(), 0, b""

    def bytes(self, n):
        while len(self.buf) < n:
            self.buf += hashlib.sha256(self.seed + self.ctr.to_bytes(8, "big")).digest()
            self.ctr += 1
        out, self.buf = self.buf[:n], self.buf[n:]
        return out


def load(clockfile, seed):
    spec = importlib.util.spec_from_file_location("mcp_oauth_main", os.path.join(APP, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["mcp_oauth_main"] = mod
    spec.loader.exec_module(mod)
    st = Stream(seed)
    mod.secrets = types.SimpleNamespace(
        token_bytes=st.bytes,
        token_hex=lambda n: st.bytes(n).hex(),
        token_urlsafe=lambda n: base64.urlsafe_b64encode(st.bytes(n)).rstrip(b"=").decode("ascii"),
    )
    mod.time = types.SimpleNamespace(time=lambda: float(open(clockfile).read().strip()))
    return mod


def serve(port, clockfile, seed):
    mod = load(clockfile, seed)
    from werkzeug.serving import make_server
    srv = make_server("127.0.0.1", int(port), mod.app, threaded=False)
    print("READY", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    {"serve": serve}[sys.argv[1]](*sys.argv[2:])
