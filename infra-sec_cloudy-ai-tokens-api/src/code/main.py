#!/usr/bin/env python3
"""
tokens-api: the fleet token engine.

Owns every fleet bearer token the owner can see, reveal, generate and revoke:
  * `ft_...` opaque fleet tokens it mints itself (name, audience, scopes, expiry);
  * Authelia JWTs, adopted the first time a verifier has checked their signature
    (or imported by hand), so the list is "every token the fleet uses".

Storage: one sqlite file. Token values are AES-256-GCM encrypted under a key derived
from the fleet key (TOKENS_FLEET_KEY, delivered by sops). They are retrievable
(owner decision: no one-way hashing) but never on disk in plaintext, never in a log, never
in the audit trail. Lookup uses an HMAC index, so the database alone reveals nothing.

Two callers:
  * verifiers (introspect-proxy), mesh only, authenticated by X-Verify-Secret:
      POST /v1/verify          live answer: active, revoked, expired, audience.
  * the owner (Cloud Account app, Authelia session through Caddy), owner-only:
      GET  /v1/tokens, GET /v1/tokens/<id>, POST /v1/tokens,
      POST /v1/tokens/import, POST /v1/tokens/<id>/reveal, POST /v1/tokens/<id>/revoke,
      GET  /v1/audit
"""

import base64
import fnmatch
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from flask import Flask, Response, jsonify, request

PREFIX = "ft_"
ADMIN_SCOPE = "tokens:admin"
_SCOPE_RE = re.compile(r"^[A-Za-z0-9:._*/-]{1,64}$")
_AUD_RE = re.compile(r"^[A-Za-z0-9.*_-]{1,128}$")

logger = logging.getLogger("tokens-api")


# ── crypto ─────────────────────────────────────────────────────────────────
class Vault:
    """Encrypts token values and derives their lookup index from one fleet key."""

    def __init__(self, fleet_key_b64: str):
        try:
            raw = base64.urlsafe_b64decode(fleet_key_b64.strip() + "=" * (-len(fleet_key_b64.strip()) % 4))
        except Exception as e:  # noqa: BLE001
            raise ValueError("TOKENS_FLEET_KEY is not base64") from e
        if len(raw) < 32:
            raise ValueError("TOKENS_FLEET_KEY must decode to at least 32 bytes")
        self._enc = hmac.new(raw, b"tokens-api/enc/v1", hashlib.sha256).digest()
        self._idx = hmac.new(raw, b"tokens-api/idx/v1", hashlib.sha256).digest()

    def index(self, value: str) -> str:
        return hmac.new(self._idx, value.encode(), hashlib.sha256).hexdigest()

    def seal(self, token_id: str, value: str):
        nonce = os.urandom(12)
        return nonce, AESGCM(self._enc).encrypt(nonce, value.encode(), token_id.encode())

    def open(self, token_id: str, nonce: bytes, ct: bytes) -> str:
        return AESGCM(self._enc).decrypt(nonce, ct, token_id.encode()).decode()


def _jwt_claims(value: str) -> dict:
    """Unverified claims of a JWT (display only: the signature is the verifier's job)."""
    parts = value.split(".")
    if len(parts) != 3:
        return {}
    try:
        body = parts[1] + "=" * (-len(parts[1]) % 4)
        c = json.loads(base64.urlsafe_b64decode(body))
        return c if isinstance(c, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


# ── store ──────────────────────────────────────────────────────────────────
class Store:
    def __init__(self, path: str, vault: Vault):
        self.vault = vault
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.lock:
            self.db.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS tokens(
                  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
                  audience TEXT NOT NULL, scopes TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '',
                  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER,
                  last_used_at INTEGER, created_by TEXT NOT NULL, source TEXT NOT NULL,
                  hint TEXT NOT NULL, idx TEXT NOT NULL UNIQUE, nonce BLOB NOT NULL, ct BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS audit(
                  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL,
                  action TEXT NOT NULL, token_id TEXT, token_name TEXT, detail TEXT NOT NULL DEFAULT '');
                """
            )
            self.db.commit()

    # audit never receives a token value: callers pass ids, names and short reasons only
    def audit(self, actor, action, token_id="", token_name="", detail=""):
        with self.lock:
            self.db.execute(
                "INSERT INTO audit(ts,actor,action,token_id,token_name,detail) VALUES(?,?,?,?,?,?)",
                (int(time.time()), actor, action, token_id, token_name, detail[:200]),
            )
            self.db.commit()

    def insert(self, *, name, kind, audience, scopes, subject, expires_at, created_by, source, value):
        token_id = "tk_" + secrets.token_hex(5)
        nonce, ct = self.vault.seal(token_id, value)
        with self.lock:
            self.db.execute(
                "INSERT INTO tokens(id,name,kind,audience,scopes,subject,created_at,expires_at,created_by,source,hint,idx,nonce,ct)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (token_id, name, kind, audience, json.dumps(scopes), subject, int(time.time()), expires_at,
                 created_by, source, value[-4:], self.vault.index(value), nonce, ct),
            )
            self.db.commit()
        return token_id

    def by_index(self, value):
        with self.lock:
            return self.db.execute("SELECT * FROM tokens WHERE idx=?", (self.vault.index(value),)).fetchone()

    def get(self, token_id):
        with self.lock:
            return self.db.execute("SELECT * FROM tokens WHERE id=?", (token_id,)).fetchone()

    def all(self):
        with self.lock:
            return self.db.execute("SELECT * FROM tokens ORDER BY created_at DESC, id").fetchall()

    def touch(self, token_id, now):
        with self.lock:
            self.db.execute("UPDATE tokens SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)",
                            (now, token_id, now - 60))
            self.db.commit()

    def revoke(self, token_id, now):
        with self.lock:
            cur = self.db.execute("UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", (now, token_id))
            self.db.commit()
            return cur.rowcount

    def audit_rows(self, limit):
        with self.lock:
            return self.db.execute("SELECT * FROM audit ORDER BY seq DESC LIMIT ?", (limit,)).fetchall()


def status_of(row, now):
    if row["revoked_at"] is not None:
        return "revoked"
    if row["expires_at"] is not None and row["expires_at"] <= now:
        return "expired"
    return "active"


def public(row, now):
    """Metadata only. The value and its ciphertext never leave through here."""
    return {
        "id": row["id"], "name": row["name"], "kind": row["kind"], "audience": row["audience"],
        "scopes": json.loads(row["scopes"]), "subject": row["subject"], "status": status_of(row, now),
        "created_at": row["created_at"], "expires_at": row["expires_at"], "revoked_at": row["revoked_at"],
        "last_used_at": row["last_used_at"], "created_by": row["created_by"], "source": row["source"],
        "hint": row["hint"],
    }


def _audience_ok(audience: str, host: str) -> bool:
    if not host or audience.strip() in ("", "*"):
        return True
    host = host.split(":")[0].lower()
    return any(fnmatch.fnmatchcase(host, g.strip().lower()) for g in audience.split(",") if g.strip())


def _norm_audience(v):
    items = v if isinstance(v, list) else [x for x in str(v if v is not None else "*").split(",")]
    items = [str(x).strip() for x in items if str(x).strip()] or ["*"]
    if len(items) > 20 or not all(_AUD_RE.match(x) for x in items):
        raise ValueError("audience must be host globs (letters, digits, . * _ -)")
    return ",".join(items)


def _norm_scopes(v):
    items = v if isinstance(v, list) else [x for x in str(v or "").replace(",", " ").split()]
    items = [str(x).strip() for x in items if str(x).strip()]
    if len(items) > 30 or not all(_SCOPE_RE.match(x) for x in items):
        raise ValueError("invalid scope")
    return items


# ── app ────────────────────────────────────────────────────────────────────
def default_introspect(url, timeout):
    """Ask the fleet's introspect-proxy whether a bearer JWT is valid; returns (status, client_id)."""
    def run(token):
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.headers.get("X-Auth-User", "")
        except urllib.error.HTTPError as e:
            return e.code, ""
        except Exception as e:  # noqa: BLE001
            logger.error("introspect unreachable: %s", type(e).__name__)
            return 503, ""
    return run


def create_app(config=None):
    cfg = {
        "DB_PATH": os.environ.get("DB_PATH", "/data/tokens.sqlite3"),
        "FLEET_KEY": os.environ.get("TOKENS_FLEET_KEY", ""),
        "VERIFY_SECRET": os.environ.get("TOKENS_VERIFY_SECRET", ""),
        "OWNER_EMAIL": os.environ.get("OWNER_EMAIL", ""),
        "ADMIN_CLIENT_IDS": os.environ.get("ADMIN_CLIENT_IDS", "cloud-admin"),
        "TRUSTED_PROXIES": os.environ.get("TRUSTED_PROXIES", ""),
        "INTROSPECT_URL": os.environ.get("INTROSPECT_URL", "http://10.0.0.1:4182/auth"),
        "INTROSPECT_TIMEOUT": float(os.environ.get("INTROSPECT_TIMEOUT", "3")),
    }
    cfg.update(config or {})
    if not cfg["VERIFY_SECRET"]:
        raise ValueError("TOKENS_VERIFY_SECRET is required")
    vault = Vault(cfg["FLEET_KEY"])
    store = Store(cfg["DB_PATH"], vault)
    admins = {c.strip() for c in str(cfg["ADMIN_CLIENT_IDS"]).replace(" ", ",").split(",") if c.strip()}
    proxies = [ipaddress.ip_network(p.strip(), strict=False) for p in str(cfg["TRUSTED_PROXIES"]).split(",") if p.strip()]
    introspect = cfg.get("introspect") or default_introspect(cfg["INTROSPECT_URL"], cfg["INTROSPECT_TIMEOUT"])
    clock = cfg.get("clock") or time.time

    app = Flask("tokens-api")
    app.config["STORE"] = store

    def deny(code, msg):
        return jsonify({"error": msg}), code

    @app.after_request
    def no_store(resp):
        resp.headers["Cache-Control"] = "no-store"
        return resp

    # ── who is calling the owner API ─────────────────────────────────────
    def owner_actor():
        """(actor, None) for the owner, (None, response) otherwise. Fail closed."""
        now = int(clock())
        h = request.headers.get("Authorization", "")
        if h.startswith("Bearer "):
            t = h[7:].strip()
            if t.startswith(PREFIX):
                row = store.by_index(t)
                if row and status_of(row, now) == "active" and ADMIN_SCOPE in json.loads(row["scopes"]):
                    store.touch(row["id"], now)
                    return "token:" + row["id"], None
                return None, deny(403, "owner only")
            status, client = introspect(t)
            if status == 200 and client in admins:
                return "client:" + client, None
            if status == 503:
                return None, deny(503, "auth unavailable")
            return None, deny(401 if status in (401, 0) else 403, "owner only")
        email = request.headers.get("Remote-Email", "")
        if email and cfg["OWNER_EMAIL"] and hmac.compare_digest(email.lower(), cfg["OWNER_EMAIL"].lower()):
            try:
                src = ipaddress.ip_address(request.remote_addr or "")
            except ValueError:
                src = None
            if src is not None and any(src in n for n in proxies):
                return "session:" + email.lower(), None
        return None, deny(401, "authentication required")

    # ── verifiers ────────────────────────────────────────────────────────
    @app.post("/v1/verify")
    def verify():
        if not hmac.compare_digest(request.headers.get("X-Verify-Secret", ""), cfg["VERIFY_SECRET"]):
            return deny(403, "forbidden")
        body = request.get_json(silent=True) or {}
        token = str(body.get("token", ""))
        host = str(body.get("host", ""))
        if not token:
            return jsonify({"active": False, "reason": "no token"})
        now = int(clock())
        row = store.by_index(token)
        if row is None:
            adopt = body.get("adopt")
            if token.startswith(PREFIX) or not isinstance(adopt, dict):
                return jsonify({"active": False, "reason": "unknown"})
            # A JWT the verifier already checked (signature, issuer, scope): register it so the owner sees it.
            exp = adopt.get("exp")
            exp = int(exp) if isinstance(exp, (int, float)) else None
            client = str(adopt.get("client_id", ""))[:80]
            scp = adopt.get("scp") if isinstance(adopt.get("scp"), list) else []
            try:
                tid = store.insert(
                    name=(client or "authelia") + " (adopted)", kind="authelia", audience="*",
                    scopes=_norm_scopes([str(s) for s in scp]), subject=str(adopt.get("sub", ""))[:120],
                    expires_at=exp, created_by="verifier", source="adopted", value=token)
                store.audit("verifier", "adopt", tid, client)
            except (sqlite3.IntegrityError, ValueError):
                pass
            row = store.by_index(token)
            if row is None:
                return jsonify({"active": True, "known": False})
        st = status_of(row, now)
        if st != "active":
            return jsonify({"active": False, "reason": st, "id": row["id"]})
        if not _audience_ok(row["audience"], host):
            return jsonify({"active": False, "reason": "audience", "id": row["id"]})
        store.touch(row["id"], now)
        return jsonify({"active": True, "known": True, "id": row["id"], "name": row["name"], "kind": row["kind"],
                        "subject": row["subject"], "scopes": json.loads(row["scopes"]),
                        "audience": row["audience"], "exp": row["expires_at"]})

    # ── owner API ────────────────────────────────────────────────────────
    @app.get("/v1/tokens")
    def list_tokens():
        actor, err = owner_actor()
        if err:
            return err
        now = int(clock())
        return jsonify({"tokens": [public(r, now) for r in store.all()]})

    @app.get("/v1/tokens/<token_id>")
    def one_token(token_id):
        actor, err = owner_actor()
        if err:
            return err
        row = store.get(token_id)
        return jsonify(public(row, int(clock()))) if row else deny(404, "not found")

    @app.post("/v1/tokens")
    def create():
        actor, err = owner_actor()
        if err:
            return err
        b = request.get_json(silent=True) or {}
        name = str(b.get("name", "")).strip()
        if not 1 <= len(name) <= 80:
            return deny(400, "name required (1-80 chars)")
        try:
            aud = _norm_audience(b.get("audience", "*"))
            scopes = _norm_scopes(b.get("scopes", []))
        except ValueError as e:
            return deny(400, str(e))
        now = int(clock())
        exp = None
        if b.get("ttl_days") not in (None, "", 0):
            try:
                days = int(b["ttl_days"])
            except (TypeError, ValueError):
                return deny(400, "ttl_days must be a number")
            if not 1 <= days <= 3650:
                return deny(400, "ttl_days must be 1-3650")
            exp = now + days * 86400
        value = PREFIX + base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
        tid = store.insert(name=name, kind="fleet", audience=aud, scopes=scopes, subject="", expires_at=exp,
                           created_by=actor, source="generated", value=value)
        store.audit(actor, "generate", tid, name, "audience=%s scopes=%s" % (aud, ",".join(scopes)))
        out = public(store.get(tid), now)
        out["value"] = value  # shown once here; retrievable later through /reveal (audited)
        return jsonify(out), 201

    @app.post("/v1/tokens/import")
    def import_token():
        actor, err = owner_actor()
        if err:
            return err
        b = request.get_json(silent=True) or {}
        value = str(b.get("value", "")).strip()
        name = str(b.get("name", "")).strip()
        if not value or not 1 <= len(name) <= 80:
            return deny(400, "name and value required")
        claims = _jwt_claims(value)
        try:
            aud = _norm_audience(b.get("audience", "*"))
            scp = b.get("scopes") if b.get("scopes") is not None else claims.get("scp", [])
            scopes = _norm_scopes([str(s) for s in scp] if isinstance(scp, list) else scp)
        except ValueError as e:
            return deny(400, str(e))
        exp = b.get("expires_at", claims.get("exp"))
        exp = int(exp) if isinstance(exp, (int, float)) else None
        if store.by_index(value):
            return deny(409, "already known")
        tid = store.insert(name=name, kind="authelia" if claims else "imported", audience=aud, scopes=scopes,
                           subject=str(claims.get("sub", ""))[:120], expires_at=exp, created_by=actor,
                           source="imported", value=value)
        store.audit(actor, "import", tid, name)
        return jsonify(public(store.get(tid), int(clock()))), 201

    @app.post("/v1/tokens/<token_id>/reveal")
    def reveal(token_id):
        actor, err = owner_actor()
        if err:
            return err
        row = store.get(token_id)
        if not row:
            return deny(404, "not found")
        try:
            value = vault.open(row["id"], row["nonce"], row["ct"])
        except Exception:  # noqa: BLE001
            return deny(500, "cannot decrypt")
        store.audit(actor, "reveal", row["id"], row["name"])
        return jsonify({"id": row["id"], "name": row["name"], "value": value})

    @app.post("/v1/tokens/<token_id>/revoke")
    def revoke(token_id):
        actor, err = owner_actor()
        if err:
            return err
        row = store.get(token_id)
        if not row:
            return deny(404, "not found")
        if store.revoke(token_id, int(clock())):
            store.audit(actor, "revoke", row["id"], row["name"])
        return jsonify(public(store.get(token_id), int(clock())))

    @app.get("/v1/audit")
    def audit_log():
        actor, err = owner_actor()
        if err:
            return err
        try:
            limit = max(1, min(500, int(request.args.get("limit", "100"))))
        except ValueError:
            limit = 100
        return jsonify({"audit": [dict(r) for r in store.audit_rows(limit)]})

    @app.get("/health")
    def health():
        return Response("OK", status=200)

    return app


def _build():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
    return create_app()


app = _build() if os.environ.get("TOKENS_FLEET_KEY") else None

if __name__ == "__main__":
    (app or _build()).run(host=os.environ.get("BIND_HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 4184)))
