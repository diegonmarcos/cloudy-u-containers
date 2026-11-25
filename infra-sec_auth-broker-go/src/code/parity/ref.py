#!/usr/bin/env python3
"""Reference driver for the auth-broker parity harness (#1877).

Loads the ORIGINAL Python service (infra-sec_auth-broker/src/code/main.py, unmodified) from PY_APP_DIR and runs one
provider the way main() does (BROKER_CONFIG, BROKER_PROVIDER, secrets from the environment), with test seams that
only touch the module's own namespace:
  * `time` is a fake whose time() reads a file the harness writes (both sides see the same instant);
  * `secrets` is a deterministic byte stream (sha256(seed || counter)), so sids, states, verifiers and one-time codes
    are identical on both sides when the same requests arrive in the same order. The Go side mirrors the stream;
  * `print` lines go to stderr (the harness reads READY from stdout).

  ref.py serve PORT CLOCKFILE SEED     serve BROKER_PROVIDER from BROKER_CONFIG
  ref.py check                         construct the Broker and print OK or the SystemExit message
"""
import base64
import hashlib
import importlib.util
import json
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
    spec = importlib.util.spec_from_file_location("broker_main", os.path.join(APP, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["broker_main"] = mod
    spec.loader.exec_module(mod)
    st = Stream(seed)
    mod.secrets = types.SimpleNamespace(
        token_bytes=st.bytes,
        token_hex=lambda n: st.bytes(n).hex(),
        token_urlsafe=lambda n: base64.urlsafe_b64encode(st.bytes(n)).rstrip(b"=").decode("ascii"),
        randbelow=lambda n: int.from_bytes(st.bytes(8), "big") % n,
    )
    if clockfile:
        mod.time = types.SimpleNamespace(time=lambda: float(open(clockfile).read().strip()))
    return mod


def build(mod):
    cfg = json.load(open(os.environ["BROKER_CONFIG"]))
    return mod.Broker(cfg, os.environ["BROKER_PROVIDER"], os.environ)


def serve(port, clockfile, seed):
    mod = load(clockfile, seed)
    b = build(mod)
    srv = mod.ThreadingHTTPServer(("127.0.0.1", int(port)), mod.make_handler(b))
    print("READY", flush=True)
    srv.serve_forever()


def check():
    mod = load(None, "check")
    try:
        build(mod)
        print("OK")
    except SystemExit as e:
        print("EXIT:" + str(e.code))
    except Exception as e:  # noqa: BLE001
        print("EXC:" + type(e).__name__)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "serve":
        serve(*sys.argv[2:])
    elif cmd == "check":
        check()
