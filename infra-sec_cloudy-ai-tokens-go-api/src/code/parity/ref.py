#!/usr/bin/env python3
"""Reference driver for the tokens-api parity harness (#1877).

Loads the ORIGINAL Python service (infra-sec_cloudy-ai-tokens-api/src/code/main.py, unmodified) from PY_APP_DIR and
runs it with two test seams that only touch the module's own namespace:
  * `time` is a fake whose time() reads a file the harness writes (both sides see the same instant);
  * `secrets` is a deterministic byte stream (sha256(seed || counter)), so token ids and values are identical on
    both sides when the same requests arrive in the same order. The Go side mirrors the stream in the test.

  ref.py serve   PORT DB CLOCKFILE SEED      serve the Flask app (env: PARITY_FLEET_KEY, TOKENS_VERIFY_SECRET, ...)
  ref.py fixture DB CLOCKFILE SEED           build a sqlite fixture through the Python Store/Vault, print the ids/values
  ref.py vault                               stdin {"key","cases":[{"id","value","nonce"}]} -> {"cases":[{"idx","ct"}]}
  ref.py open                                stdin {"key","cases":[{"id","nonce","ct"}]} -> {"cases":[{"value"|"error"}]}
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


def load(clockfile=None, seed="seed"):
    os.environ.pop("TOKENS_FLEET_KEY", None)  # main.py builds the app at import when this is set
    spec = importlib.util.spec_from_file_location("tokens_main", os.path.join(APP, "main.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["tokens_main"] = mod
    spec.loader.exec_module(mod)
    st = Stream(seed)
    mod.secrets = types.SimpleNamespace(token_bytes=st.bytes, token_hex=lambda n: st.bytes(n).hex())
    if clockfile:
        mod.time = types.SimpleNamespace(time=lambda: float(open(clockfile).read().strip()))
    return mod


def serve(port, db, clockfile, seed):
    mod = load(clockfile, seed)
    app = mod.create_app({"DB_PATH": db, "FLEET_KEY": os.environ["PARITY_FLEET_KEY"]})
    from werkzeug.serving import make_server
    srv = make_server("127.0.0.1", int(port), app, threaded=False)
    print("READY", flush=True)
    srv.serve_forever()


def fixture(db, clockfile, seed):
    mod = load(clockfile, seed)
    key = os.environ["PARITY_FLEET_KEY"]
    store = mod.Store(db, mod.Vault(key))
    now = int(float(open(clockfile).read().strip()))
    out = {}

    def add(label, **kw):
        value = kw.pop("value")
        tid = store.insert(value=value, **kw)
        out[label] = {"id": tid, "value": value}
        return tid

    add("admin", name="fixture admin", kind="fleet", audience="*", scopes=["tokens:admin", "read"], subject="",
        expires_at=now + 86400 * 30, created_by="fixture", source="generated", value="ft_FIXTUREADMINtokenvalue0123456789abcdefghi")
    add("plain", name="fixture plain", kind="fleet", audience="svc.example.org,*.mesh.example.org", scopes=["read"],
        subject="", expires_at=None, created_by="fixture", source="generated", value="ft_FIXTUREPLAINtokenvalue0123456789abcdefghij")
    tid = add("revoked", name="fixture revoked", kind="fleet", audience="*", scopes=[], subject="",
              expires_at=now + 1000, created_by="fixture", source="generated", value="ft_FIXTUREREVOKEDtokenvalue0123456789abcdefgh")
    store.revoke(tid, now - 5)
    add("expired", name="fixture expired", kind="fleet", audience="*", scopes=["read"], subject="",
        expires_at=now - 10, created_by="fixture", source="generated", value="ft_FIXTUREEXPIREDtokenvalue0123456789abcdefghi")
    add("adopted", name="cloud-admin (adopted)", kind="authelia", audience="*", scopes=["authelia.bearer.authz"],
        subject="u-1", expires_at=now + 500, created_by="verifier", source="adopted",
        value=".".join(base64.urlsafe_b64encode(x).rstrip(b"=").decode() for x in (b'{"alg":"RS256"}', b'{"sub":"u-1"}', b"sig")))
    store.audit("fixture", "generate", out["admin"]["id"], "fixture admin", "audience=* scopes=tokens:admin,read")
    store.audit("verifier", "adopt", out["adopted"]["id"], "cloud-admin")
    print(json.dumps(out))


def vault_cmd():
    req = json.load(sys.stdin)
    mod = load()
    v = mod.Vault(req["key"])
    res = []
    for c in req["cases"]:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        ct = AESGCM(v._enc).encrypt(bytes.fromhex(c["nonce"]), c["value"].encode(), c["id"].encode())
        res.append({"idx": v.index(c["value"]), "ct": ct.hex()})
    print(json.dumps({"cases": res}))


def open_cmd():
    req = json.load(sys.stdin)
    mod = load()
    v = mod.Vault(req["key"])
    res = []
    for c in req["cases"]:
        try:
            res.append({"value": v.open(c["id"], bytes.fromhex(c["nonce"]), bytes.fromhex(c["ct"]))})
        except Exception as e:  # noqa: BLE001
            res.append({"error": type(e).__name__})
    print(json.dumps({"cases": res}))


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    {"serve": serve, "fixture": fixture, "vault": lambda: vault_cmd(), "open": lambda: open_cmd()}[cmd](*args)
