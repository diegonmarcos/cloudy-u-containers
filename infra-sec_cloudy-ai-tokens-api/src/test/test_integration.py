"""Hub integration: the REAL tokens-api and the REAL introspect-proxy wired together over a fake wire.

generate -> use (edge accepts) -> revoke -> edge rejects within the cache window; an Authelia JWT is adopted on
first use, listed, revealed and revoked the same way; a non-owner client can do none of it.
"""
import base64
import importlib.util
import io
import json
import os
import sys

import pytest

HERE = os.path.dirname(__file__)
KEY = base64.urlsafe_b64encode(b"i" * 32).decode()
SECRET = "wire-secret"
os.environ["TOKENS_VERIFY_URL"] = "http://tokens-api.mesh.diegonmarcos.com:4184/v1/verify"
os.environ["TOKENS_VERIFY_SECRET"] = SECRET


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


engine_mod = load("tokens_engine_main", "../code/main.py")
try:
    proxy_mod = load("introspect_main", "../../../infra-sec_introspect-proxy/src/code/main.py")
except FileNotFoundError:  # pragma: no cover - the proxy lives beside this service in the repo
    proxy_mod = None
pytestmark = pytest.mark.skipif(proxy_mod is None, reason="introspect-proxy source not beside this service")

OWNER_JWT = "o.w.n"


@pytest.fixture()
def hub(tmp_path, monkeypatch):
    now = [1_800_000_000.0]
    engine = engine_mod.create_app({
        "DB_PATH": str(tmp_path / "t.sqlite3"), "FLEET_KEY": KEY, "VERIFY_SECRET": SECRET,
        "introspect": lambda t: (200, "cloud-admin") if t == OWNER_JWT else (200, "claude-opus"),
        "clock": lambda: now[0],
    }).test_client()

    class Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def wire(req, timeout=0):  # introspect-proxy's POST /v1/verify lands on the engine app
        r = engine.post("/v1/verify", data=req.data, headers=dict(req.header_items()))
        assert r.status_code == 200, r.get_data()
        return Resp(r.get_data())

    monkeypatch.setattr("urllib.request.urlopen", wire)
    monkeypatch.setattr(proxy_mod.time, "time", lambda: now[0])
    proxy_mod._tokens_cache.clear()
    return engine, now


def edge(token, host="tokens-api.diegonmarcos.com"):
    with proxy_mod.app.test_request_context("/auth", headers={"Authorization": "Bearer " + token, "X-Forwarded-Host": host}):
        return proxy_mod.auth().status_code


OWNER = {"Authorization": "Bearer " + OWNER_JWT}


def test_generate_use_revoke_rejected(hub):
    engine, now = hub
    t = engine.post("/v1/tokens", json={"name": "ci", "audience": "*.diegonmarcos.com", "scopes": ["x"], "ttl_days": 7}, headers=OWNER).get_json()
    assert edge(t["value"]) == 200                                   # use
    assert edge(t["value"], host="evil.example.com") == 401          # audience is enforced at the edge
    assert engine.post("/v1/tokens/%s/revoke" % t["id"], headers=OWNER).status_code == 200
    now[0] += proxy_mod.TOKENS_CACHE_TTL + 1
    assert edge(t["value"]) == 401                                   # rejected within the cache window
    assert proxy_mod.TOKENS_CACHE_TTL <= 60


def test_authelia_jwt_adopted_listed_then_revoked(hub, monkeypatch):
    engine, now = hub

    class K:
        key = "k"

    class J:
        def get_signing_key_from_jwt(self, t):
            return K()

    monkeypatch.setattr(proxy_mod, "get_jwks_client", lambda: J())
    monkeypatch.setattr(proxy_mod.jwt, "decode", lambda *a, **k: {
        "client_id": "dagu-cc", "sub": "dagu", "exp": 1_900_000_000, "scp": [proxy_mod.REQUIRED_SCOPE]})
    assert edge("a.b.c") == 200
    rows = engine.get("/v1/tokens", headers=OWNER).get_json()["tokens"]
    assert [(r["kind"], r["source"]) for r in rows] == [("authelia", "adopted")]
    assert engine.post("/v1/tokens/%s/reveal" % rows[0]["id"], headers=OWNER).get_json()["value"] == "a.b.c"
    engine.post("/v1/tokens/%s/revoke" % rows[0]["id"], headers=OWNER)
    now[0] += proxy_mod.TOKENS_CACHE_TTL + 1
    assert edge("a.b.c") == 401


def test_agent_client_is_not_the_owner(hub):
    engine, _ = hub
    agent = {"Authorization": "Bearer agent.jwt"}
    assert engine.get("/v1/tokens", headers=agent).status_code == 403
    assert engine.post("/v1/tokens", json={"name": "x"}, headers=agent).status_code == 403
