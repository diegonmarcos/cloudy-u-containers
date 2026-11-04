"""Engine unit tests: generate, list, reveal, revoke -> verifier rejects, non-owner denied, nothing leaks."""
import base64
import json
import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "code"))
import main  # noqa: E402

KEY = base64.urlsafe_b64encode(b"k" * 32).decode()
SECRET = "verify-secret"
OWNER_JWT = "owner.jwt.value"
AGENT_JWT = "agent.jwt.value"


class Clock:
    t = 1_800_000_000

    def __call__(self):
        return self.t


@pytest.fixture()
def env(tmp_path):
    clock = Clock()
    seen = {}

    def introspect(token):
        seen["last"] = token
        return {OWNER_JWT: (200, "cloud-admin"), AGENT_JWT: (200, "claude-opus")}.get(token, (401, ""))

    app = main.create_app({
        "DB_PATH": str(tmp_path / "t.sqlite3"), "FLEET_KEY": KEY, "VERIFY_SECRET": SECRET,
        "OWNER_EMAIL": "owner@example.com", "TRUSTED_PROXIES": "10.0.0.0/24",
        "introspect": introspect, "clock": clock,
    })
    return app, app.test_client(), clock, tmp_path


OWNER = {"Authorization": "Bearer " + OWNER_JWT}


def verify(c, token, host="", adopt=None):
    body = {"token": token, "host": host}
    if adopt:
        body["adopt"] = adopt
    return c.post("/v1/verify", json=body, headers={"X-Verify-Secret": SECRET}).get_json()


def make(c, **kw):
    kw.setdefault("name", "ci")
    r = c.post("/v1/tokens", json=kw, headers=OWNER)
    assert r.status_code == 201, r.get_data()
    return r.get_json()


def test_generate_list_reveal_roundtrip(env):
    _, c, _, _ = env
    t = make(c, name="mcp client", audience=["mcp.diegonmarcos.com"], scopes=["mcp:read"], ttl_days=30)
    assert t["value"].startswith("ft_") and t["status"] == "active"
    listed = c.get("/v1/tokens", headers=OWNER).get_json()["tokens"]
    assert [x["id"] for x in listed] == [t["id"]]
    assert "value" not in listed[0] and listed[0]["hint"] == t["value"][-4:]
    rv = c.post("/v1/tokens/%s/reveal" % t["id"], headers=OWNER).get_json()
    assert rv["value"] == t["value"]  # retrievable at any time, owner decision


def test_revoke_makes_verifier_reject_immediately(env):
    _, c, _, _ = env
    t = make(c)
    assert verify(c, t["value"])["active"] is True
    assert c.post("/v1/tokens/%s/revoke" % t["id"], headers=OWNER).get_json()["status"] == "revoked"
    v = verify(c, t["value"])
    assert v["active"] is False and v["reason"] == "revoked"


def test_expiry_and_audience(env):
    _, c, clock, _ = env
    t = make(c, audience="*.diegonmarcos.com", ttl_days=1)
    assert verify(c, t["value"], host="x.diegonmarcos.com")["active"] is True
    assert verify(c, t["value"], host="evil.example.com")["reason"] == "audience"
    clock.t += 86401
    assert verify(c, t["value"], host="x.diegonmarcos.com")["reason"] == "expired"


def test_unknown_and_forged_ft_tokens_rejected(env):
    _, c, _, _ = env
    assert verify(c, "ft_" + "A" * 43)["active"] is False
    assert verify(c, "ft_" + "A" * 43, adopt={"client_id": "x"})["active"] is False  # ft_ is never adopted


def test_verify_requires_shared_secret(env):
    _, c, _, _ = env
    assert c.post("/v1/verify", json={"token": "x"}).status_code == 403
    assert c.post("/v1/verify", json={"token": "x"}, headers={"X-Verify-Secret": "no"}).status_code == 403


def test_non_owner_denied_everywhere(env):
    _, c, _, _ = env
    t = make(c)
    agent = {"Authorization": "Bearer " + AGENT_JWT}
    for method, path in [("get", "/v1/tokens"), ("get", "/v1/audit"), ("post", "/v1/tokens"),
                         ("post", "/v1/tokens/%s/reveal" % t["id"]), ("post", "/v1/tokens/%s/revoke" % t["id"])]:
        assert getattr(c, method)(path, headers=agent, json={"name": "x"}).status_code == 403, path
    assert c.get("/v1/tokens").status_code == 401
    assert c.get("/v1/tokens", headers={"Authorization": "Bearer nope"}).status_code == 401
    # a non-admin fleet token cannot manage tokens either
    plain = make(c, scopes=["mcp:read"])
    assert c.get("/v1/tokens", headers={"Authorization": "Bearer " + plain["value"]}).status_code == 403


def test_admin_scoped_fleet_token_and_trusted_session(env):
    _, c, _, _ = env
    adm = make(c, name="admin", scopes=["tokens:admin"])
    assert c.get("/v1/tokens", headers={"Authorization": "Bearer " + adm["value"]}).status_code == 200
    ok = {"Remote-Email": "Owner@Example.com"}
    assert c.get("/v1/tokens", headers=ok, environ_overrides={"REMOTE_ADDR": "10.0.0.1"}).status_code == 200
    # the header is forgeable from anywhere else: only the trusted proxy may carry it
    assert c.get("/v1/tokens", headers=ok, environ_overrides={"REMOTE_ADDR": "203.0.113.9"}).status_code == 401
    assert c.get("/v1/tokens", headers={"Remote-Email": "x@y.z"}, environ_overrides={"REMOTE_ADDR": "10.0.0.1"}).status_code == 401
    c.post("/v1/tokens/%s/revoke" % adm["id"], headers=OWNER)
    assert c.get("/v1/tokens", headers={"Authorization": "Bearer " + adm["value"]}).status_code == 403


def test_adoption_of_verified_authelia_jwt_and_revoke(env):
    _, c, _, _ = env
    jwt = "aaa.bbb.ccc"
    a = {"client_id": "dagu-cc", "sub": "dagu", "exp": 1_800_100_000, "scp": ["authelia.bearer.authz"]}
    assert verify(c, jwt, adopt=a)["active"] is True
    row = c.get("/v1/tokens", headers=OWNER).get_json()["tokens"][0]
    assert row["kind"] == "authelia" and row["source"] == "adopted" and row["expires_at"] == 1_800_100_000
    assert c.post("/v1/tokens/%s/reveal" % row["id"], headers=OWNER).get_json()["value"] == jwt
    c.post("/v1/tokens/%s/revoke" % row["id"], headers=OWNER)
    assert verify(c, jwt, adopt=a)["active"] is False  # revocation sticks; re-presenting does not re-adopt


def test_import_reads_jwt_claims(env):
    _, c, _, _ = env
    claims = base64.urlsafe_b64encode(json.dumps({"exp": 1_800_500_000, "scp": ["a.b"], "sub": "s"}).encode()).decode().rstrip("=")
    value = "h.%s.sig" % claims
    r = c.post("/v1/tokens/import", json={"name": "legacy", "value": value}, headers=OWNER)
    assert r.status_code == 201 and r.get_json()["expires_at"] == 1_800_500_000
    assert c.post("/v1/tokens/import", json={"name": "legacy", "value": value}, headers=OWNER).status_code == 409


def test_audit_has_events_and_never_a_value(env):
    _, c, _, _ = env
    t = make(c)
    c.post("/v1/tokens/%s/reveal" % t["id"], headers=OWNER)
    c.post("/v1/tokens/%s/revoke" % t["id"], headers=OWNER)
    raw = c.get("/v1/audit", headers=OWNER).get_data(as_text=True)
    acts = [r["action"] for r in json.loads(raw)["audit"]]
    assert acts == ["revoke", "reveal", "generate"]
    assert t["value"] not in raw and t["value"][3:] not in raw


def test_value_never_in_plaintext_on_disk(env):
    app, c, _, tmp = env
    t = make(c)
    app.config["STORE"].db.execute("PRAGMA wal_checkpoint(FULL)")
    blob = b"".join(open(os.path.join(tmp, f), "rb").read() for f in os.listdir(tmp))
    assert t["value"].encode() not in blob and t["value"][3:].encode() not in blob
    db = sqlite3.connect(str(tmp / "t.sqlite3"))
    assert db.execute("SELECT ct FROM tokens").fetchone()[0] != t["value"].encode()


def test_wrong_key_cannot_read(env):
    app, c, _, tmp = env
    make(c)
    other = main.create_app({"DB_PATH": str(tmp / "t.sqlite3"), "FLEET_KEY": base64.urlsafe_b64encode(b"z" * 32).decode(),
                             "VERIFY_SECRET": SECRET, "introspect": lambda t: (200, "cloud-admin")})
    tid = other.test_client().get("/v1/tokens", headers=OWNER).get_json()["tokens"][0]["id"]
    assert other.test_client().post("/v1/tokens/%s/reveal" % tid, headers=OWNER).status_code == 500


def test_input_validation(env):
    _, c, _, _ = env
    for bad in [{"name": ""}, {"name": "x", "ttl_days": 99999}, {"name": "x", "scopes": ["bad scope!"]},
                {"name": "x", "audience": "a b;c"}]:
        assert c.post("/v1/tokens", json=bad, headers=OWNER).status_code == 400, bad


def test_missing_key_fails_startup():
    with pytest.raises(ValueError):
        main.create_app({"DB_PATH": ":memory:", "FLEET_KEY": "", "VERIFY_SECRET": "x"})
