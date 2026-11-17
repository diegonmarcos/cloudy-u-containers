#!/usr/bin/env python3
"""
MCP OAuth authorization server for mcp.diegonmarcos.com (option 31.1, WIP).

Implements the pieces of the MCP authorization spec (2025-06-18) that a
claude.ai / claude.com connector, or a localhost MCP client, needs before it
holds a token:

    GET  /.well-known/oauth-authorization-server[/<svc>]   RFC 8414
    GET  /.well-known/oauth-protected-resource[/<svc>]     RFC 9728
    GET  /<svc>/.well-known/oauth-*                        (path-relative variants)
    POST /register                                         RFC 7591 (DCR)
    GET  /authorize    consent page   (Authelia session REQUIRED, see below)
    POST /authorize    approve -> 302 redirect_uri?code=..&state=..
    POST /token        authorization_code (PKCE S256 only) + refresh_token
    POST /introspect   RFC 7662, mesh-only + shared secret; NOT routed by Caddy

Owner rule "public URL = bearer or Authelia cookie": /authorize is exempted
from the edge_auth gate (public_open list) but Caddy puts an explicit
Authelia forward_auth in front of it, which sets Remote-User. This service
additionally refuses /authorize without Remote-User and, if ALLOWED_USERS is
set, for any user not listed. Without a logged-in Authelia session no code
is ever issued, so no token is ever issued.

Tokens are opaque (`mcpat_...` access, `mcprt_...` refresh). Only their
SHA-256 is stored (sqlite). introspect-proxy recognises the `mcpat_` prefix
and asks /introspect instead of verifying a JWT, so a minted token passes
the existing bearer gate exactly like the fleet bearer.
"""

import base64
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import urlencode, urlsplit

from flask import Flask, Response, jsonify, request

ISSUER = os.environ.get("ISSUER", "https://mcp.diegonmarcos.com").rstrip("/")
# #1252: the AS front door is split over the surviving tiers. ISSUER is the c3-pub URL (discovery, register,
# token: public-open); AUTHORIZE_BASE is the c3-pvt URL of /authorize (Authelia session gate). Default: same as ISSUER.
AUTHORIZE_BASE = os.environ.get("AUTHORIZE_BASE", ISSUER).rstrip("/")
DB_PATH = os.environ.get("DB_PATH", "/data/mcp-oauth.sqlite3")
INTROSPECT_SECRET = os.environ.get("INTROSPECT_SECRET", "")
FORM_SECRET = os.environ.get("FORM_SECRET", "") or secrets.token_hex(32)
ALLOWED_USERS = [u for u in os.environ.get("ALLOWED_USERS", "").replace(",", " ").split() if u]
SCOPES = os.environ.get("SCOPES", "mcp").split()
ACCESS_TTL = int(os.environ.get("ACCESS_TTL", "3600"))
REFRESH_TTL = int(os.environ.get("REFRESH_TTL", str(30 * 86400)))
CODE_TTL = int(os.environ.get("CODE_TTL", "300"))
MAX_CLIENTS = int(os.environ.get("MAX_CLIENTS", "200"))
# Exact HTTPS callbacks allowed for DCR. Loopback (http://localhost|127.0.0.1|[::1],
# any port, any path) is always allowed for native clients (RFC 8252 s7.3).
ALLOWED_REDIRECTS = os.environ.get(
    "ALLOWED_REDIRECTS",
    "https://claude.ai/api/mcp/auth_callback https://claude.com/api/mcp/auth_callback",
).split()
ACCESS_PREFIX = "mcpat_"
REFRESH_PREFIX = "mcprt_"
SVC_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,62}$")

logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
log = logging.getLogger("mcp-oauth")

app = Flask(__name__)

# ── storage ─────────────────────────────────────────────────────────────
_lock = threading.Lock()
_conn = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY, secret_hash TEXT, redirect_uris TEXT NOT NULL,
  client_name TEXT, auth_method TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS codes (
  code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, sub TEXT NOT NULL, scope TEXT, resource TEXT,
  expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL,
  sub TEXT NOT NULL, scope TEXT, resource TEXT, expires INTEGER NOT NULL,
  family TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family);
"""


def db():
    global _conn
    if _conn is None:
        d = os.path.dirname(DB_PATH)
        if d:
            os.makedirs(d, exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(SCHEMA)
    return _conn


def q(sql, args=(), one=False):
    with _lock:
        cur = db().execute(sql, args)
        rows = cur.fetchall()
    return (rows[0] if rows else None) if one else rows


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def now():
    return int(time.time())


def gc():
    t = now()
    q("DELETE FROM codes WHERE expires < ?", (t,))
    q("DELETE FROM tokens WHERE expires < ?", (t,))


# ── helpers ─────────────────────────────────────────────────────────────
def oauth_error(err, desc, status=400):
    r = jsonify({"error": err, "error_description": desc})
    r.status_code = status
    r.headers["Cache-Control"] = "no-store"
    return r


def redirect_allowed(uri):
    if not isinstance(uri, str) or len(uri) > 512:
        return False
    try:
        u = urlsplit(uri)
        u.port  # raises on a bad port
    except ValueError:
        return False
    if u.fragment:
        return False
    if u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1"):
        return True
    return uri in ALLOWED_REDIRECTS


def resource_for(svc):
    return f"{ISSUER}/{svc}" if svc else ISSUER


def as_metadata():
    return {
        "issuer": ISSUER,
        "authorization_endpoint": f"{AUTHORIZE_BASE}/authorize",
        "token_endpoint": f"{ISSUER}/token",
        "registration_endpoint": f"{ISSUER}/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_post", "client_secret_basic"],
        "scopes_supported": SCOPES,
    }


def pr_metadata(svc):
    return {
        "resource": resource_for(svc),
        "authorization_servers": [ISSUER],
        "bearer_methods_supported": ["header"],
        "scopes_supported": SCOPES,
    }


def json_nostore(obj, status=200):
    r = jsonify(obj)
    r.status_code = status
    r.headers["Cache-Control"] = "no-store"
    return r


def form_sig(fields):
    msg = json.dumps(fields, sort_keys=True).encode()
    return hmac.new(FORM_SECRET.encode(), msg, hashlib.sha256).hexdigest()


def client_auth(form):
    """Return (client_row, error_response). Supports none / post / basic."""
    cid, csec = form.get("client_id"), form.get("client_secret")
    ah = request.headers.get("Authorization", "")
    if ah.startswith("Basic "):
        try:
            raw = base64.b64decode(ah[6:]).decode()
            cid, csec = raw.split(":", 1)
        except Exception:
            return None, oauth_error("invalid_client", "bad basic auth", 401)
    if not cid:
        return None, oauth_error("invalid_client", "client_id required", 401)
    row = q("SELECT client_id, secret_hash, auth_method FROM clients WHERE client_id=?", (cid,), one=True)
    if not row:
        return None, oauth_error("invalid_client", "unknown client", 401)
    if row[2] != "none":
        if not csec or not hmac.compare_digest(h(csec), row[1] or ""):
            return None, oauth_error("invalid_client", "bad client secret", 401)
    return row, None


def mint_pair(client_id, sub, scope, resource, family=None):
    family = family or secrets.token_hex(16)
    at = ACCESS_PREFIX + secrets.token_urlsafe(32)
    rt = REFRESH_PREFIX + secrets.token_urlsafe(32)
    t = now()
    q("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?)", (h(at), "access", client_id, sub, scope, resource, t + ACCESS_TTL, family))
    q("INSERT INTO tokens VALUES (?,?,?,?,?,?,?,?)", (h(rt), "refresh", client_id, sub, scope, resource, t + REFRESH_TTL, family))
    return json_nostore({
        "access_token": at, "token_type": "Bearer", "expires_in": ACCESS_TTL,
        "refresh_token": rt, "scope": scope,
    })


# ── discovery ───────────────────────────────────────────────────────────
@app.get("/.well-known/oauth-authorization-server")
@app.get("/.well-known/oauth-authorization-server/<svc>")
@app.get("/.well-known/openid-configuration")
@app.get("/<svc>/.well-known/oauth-authorization-server")
def well_known_as(svc=None):
    return jsonify(as_metadata())


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/<path:svc>")
@app.get("/<svc>/.well-known/oauth-protected-resource")
def well_known_pr(svc=None):
    # /.well-known/oauth-protected-resource/<svc>/mcp -> resource .../<svc>/mcp
    if svc and not all(SVC_RE.match(p) for p in svc.split("/")):
        return oauth_error("invalid_request", "bad resource path", 404)
    return jsonify(pr_metadata(svc))


# ── RFC 7591 dynamic client registration ────────────────────────────────
@app.post("/register")
@app.post("/<svc>/register")
def register(svc=None):
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return oauth_error("invalid_client_metadata", "JSON body required")
    uris = body.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 10:
        return oauth_error("invalid_redirect_uri", "redirect_uris required (1..10)")
    bad = [u for u in uris if not redirect_allowed(u)]
    if bad:
        return oauth_error("invalid_redirect_uri", "redirect_uri not allowed: claude.ai/claude.com callback or localhost only")
    method = body.get("token_endpoint_auth_method", "none")
    if method not in ("none", "client_secret_post", "client_secret_basic"):
        return oauth_error("invalid_client_metadata", "unsupported token_endpoint_auth_method")
    gts = body.get("grant_types", ["authorization_code", "refresh_token"])
    if not isinstance(gts, list) or set(gts) - {"authorization_code", "refresh_token"}:
        return oauth_error("invalid_client_metadata", "unsupported grant_types")
    rts = body.get("response_types", ["code"])
    if rts != ["code"]:
        return oauth_error("invalid_client_metadata", "response_types must be [code]")
    name = str(body.get("client_name", ""))[:100]

    gc()
    (count,) = q("SELECT COUNT(*) FROM clients", one=True)
    if count >= MAX_CLIENTS:
        # Evict the oldest client that holds no live tokens.
        q("DELETE FROM clients WHERE client_id IN (SELECT c.client_id FROM clients c "
          "WHERE NOT EXISTS (SELECT 1 FROM tokens t WHERE t.client_id=c.client_id) "
          "ORDER BY c.created LIMIT 1)")
        (count,) = q("SELECT COUNT(*) FROM clients", one=True)
        if count >= MAX_CLIENTS:
            return oauth_error("temporarily_unavailable", "client registry full", 503)

    cid = "mcpc_" + secrets.token_urlsafe(16)
    secret = secrets.token_urlsafe(32) if method != "none" else None
    t = now()
    q("INSERT INTO clients VALUES (?,?,?,?,?,?)",
      (cid, h(secret) if secret else None, json.dumps(uris), name, method, t))
    out = {
        "client_id": cid, "client_id_issued_at": t, "redirect_uris": uris,
        "token_endpoint_auth_method": method, "grant_types": gts,
        "response_types": ["code"], "client_name": name,
    }
    if secret:
        out["client_secret"] = secret
        out["client_secret_expires_at"] = 0
    log.info("registered client %s (%s) redirect=%s", cid, name, uris)
    return json_nostore(out, 201)


# ── /authorize ──────────────────────────────────────────────────────────
AUTHZ_FIELDS = ("client_id", "redirect_uri", "state", "code_challenge", "scope", "resource")


def _authz_check(params):
    """Validate an authorization request. Returns (fields, err_response)."""
    user = request.headers.get("Remote-User", "").strip()
    if not user:
        # Caddy's Authelia forward_auth should have stopped this already.
        return None, Response("Authelia session required", status=401)
    if ALLOWED_USERS and user not in ALLOWED_USERS:
        return None, Response("User not allowed", status=403)
    cid = params.get("client_id", "")
    row = q("SELECT redirect_uris, client_name FROM clients WHERE client_id=?", (cid,), one=True)
    if not row:
        return None, Response("Unknown client_id", status=400)
    ruri = params.get("redirect_uri", "")
    registered = json.loads(row[0])
    if not ruri and len(registered) == 1:
        ruri = registered[0]
    if ruri not in registered or not redirect_allowed(ruri):
        # Never redirect to an unverified URI (RFC 6749 s4.1.2.1).
        return None, Response("redirect_uri mismatch", status=400)

    def back(err, desc):
        qs = {"error": err, "error_description": desc}
        if params.get("state"):
            qs["state"] = params["state"]
        return None, Response(status=302, headers={"Location": ruri + ("&" if "?" in ruri else "?") + urlencode(qs)})

    if params.get("response_type") != "code":
        return back("unsupported_response_type", "response_type must be code")
    if params.get("code_challenge_method") != "S256":
        return back("invalid_request", "PKCE S256 required")
    cc = params.get("code_challenge", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", cc):
        return back("invalid_request", "bad code_challenge")
    scope = params.get("scope") or " ".join(SCOPES)
    if set(scope.split()) - set(SCOPES):
        return back("invalid_scope", "unsupported scope")
    fields = {
        "client_id": cid, "redirect_uri": ruri, "state": params.get("state", ""),
        "code_challenge": cc, "scope": scope, "resource": params.get("resource", ""),
        "sub": user, "client_name": row[1] or cid,
    }
    return fields, None


@app.get("/authorize")
@app.get("/<svc>/authorize")
def authorize_get(svc=None):
    fields, err = _authz_check(request.args)
    if err:
        return err
    fields["exp"] = now() + CODE_TTL
    sig = form_sig(fields)
    hidden = "".join(
        f'<input type="hidden" name="{k}" value="{html.escape(str(v))}">'
        for k, v in fields.items())
    page = f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize MCP client</title>
<style>body{{font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}}button{{padding:.6rem 1.2rem;margin-right:.5rem}}</style>
</head><body><h1>Authorize MCP access</h1>
<p><b>{html.escape(fields['client_name'])}</b> wants access to <code>{html.escape(fields['resource'] or ISSUER)}</code>
as <b>{html.escape(fields['sub'])}</b> (scope: {html.escape(fields['scope'])}).</p>
<p>It will be redirected to <code>{html.escape(fields['redirect_uri'])}</code>.</p>
<form method="post" action="{html.escape(urlsplit(AUTHORIZE_BASE).path)}/authorize">{hidden}<input type="hidden" name="sig" value="{sig}">
<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form>
</body></html>"""
    r = Response(page, mimetype="text/html")
    r.headers["Cache-Control"] = "no-store"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'"
    return r


@app.post("/authorize")
@app.post("/<svc>/authorize")
def authorize_post(svc=None):
    user = request.headers.get("Remote-User", "").strip()
    if not user:
        return Response("Authelia session required", status=401)
    f = request.form
    fields = {k: f.get(k, "") for k in AUTHZ_FIELDS + ("sub", "client_name")}
    try:
        fields["exp"] = int(f.get("exp", "0"))
    except ValueError:
        return Response("bad form", status=400)
    if not hmac.compare_digest(form_sig(fields), f.get("sig", "")):
        return Response("bad form signature", status=400)
    if fields["exp"] < now():
        return Response("consent expired, start again", status=400)
    if fields["sub"] != user or (ALLOWED_USERS and user not in ALLOWED_USERS):
        return Response("session user changed", status=403)
    ruri = fields["redirect_uri"]
    sep = "&" if "?" in ruri else "?"
    qs = {"state": fields["state"]} if fields["state"] else {}
    if f.get("decision") != "approve":
        qs.update(error="access_denied")
        return Response(status=302, headers={"Location": ruri + sep + urlencode(qs)})
    code = secrets.token_urlsafe(32)
    q("INSERT INTO codes VALUES (?,?,?,?,?,?,?,?)",
      (h(code), fields["client_id"], ruri, fields["code_challenge"], user,
       fields["scope"], fields["resource"], now() + CODE_TTL))
    qs = {"code": code, **qs, "iss": ISSUER}
    log.info("code issued client=%s sub=%s", fields["client_id"], user)
    return Response(status=302, headers={"Location": ruri + sep + urlencode(qs)})


# ── /token ──────────────────────────────────────────────────────────────
def pkce_ok(verifier, challenge):
    if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier or ""):
        return False
    d = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return hmac.compare_digest(d, challenge)


@app.post("/token")
@app.post("/<svc>/token")
def token(svc=None):
    f = request.form
    client, err = client_auth(f)
    if err:
        return err
    cid = client[0]
    gt = f.get("grant_type")
    if gt == "authorization_code":
        code = f.get("code", "")
        with _lock:  # single-use: read + delete atomically
            cur = db().execute(
                "SELECT client_id, redirect_uri, challenge, sub, scope, resource, expires FROM codes WHERE code_hash=?",
                (h(code),))
            row = cur.fetchone()
            if row:
                db().execute("DELETE FROM codes WHERE code_hash=?", (h(code),))
        if not row or row[6] < now():
            return oauth_error("invalid_grant", "unknown or expired code")
        if row[0] != cid:
            return oauth_error("invalid_grant", "code was issued to another client")
        if f.get("redirect_uri", row[1]) != row[1]:
            return oauth_error("invalid_grant", "redirect_uri mismatch")
        if not pkce_ok(f.get("code_verifier"), row[2]):
            return oauth_error("invalid_grant", "PKCE verification failed")
        resource = f.get("resource") or row[5]
        return mint_pair(cid, row[3], row[4], resource)
    if gt == "refresh_token":
        rt = f.get("refresh_token", "")
        with _lock:
            cur = db().execute(
                "SELECT client_id, sub, scope, resource, expires, family FROM tokens WHERE token_hash=? AND kind='refresh'",
                (h(rt),))
            row = cur.fetchone()
            if row:
                # Rotation: the old refresh token dies now.
                db().execute("DELETE FROM tokens WHERE token_hash=?", (h(rt),))
        if not row or row[4] < now():
            return oauth_error("invalid_grant", "unknown or expired refresh_token")
        if row[0] != cid:
            return oauth_error("invalid_grant", "refresh_token was issued to another client")
        scope = f.get("scope") or row[2]
        if set(scope.split()) - set((row[2] or "").split()):
            return oauth_error("invalid_scope", "scope exceeds original grant")
        # Old access tokens of the family are revoked along with the old refresh.
        q("DELETE FROM tokens WHERE family=? AND kind='access'", (row[5],))
        return mint_pair(cid, row[1], scope, row[3], family=row[5])
    return oauth_error("unsupported_grant_type", "authorization_code or refresh_token")


# ── RFC 7662 introspection (mesh-only, used by introspect-proxy) ────────
def lookup_access(tok):
    if not tok.startswith(ACCESS_PREFIX):
        return None
    row = q("SELECT client_id, sub, scope, resource, expires FROM tokens WHERE token_hash=? AND kind='access'",
            (h(tok),), one=True)
    if not row or row[4] < now():
        return None
    return {"active": True, "client_id": row[0], "sub": row[1], "username": row[1],
            "scope": row[2], "aud": row[3] or ISSUER, "exp": row[4], "iss": ISSUER,
            "token_type": "Bearer"}


@app.post("/introspect")
def introspect():
    if not INTROSPECT_SECRET:
        return oauth_error("server_error", "introspection disabled (INTROSPECT_SECRET unset)", 503)
    given = request.headers.get("X-Introspect-Secret", "")
    if not hmac.compare_digest(given, INTROSPECT_SECRET):
        return oauth_error("invalid_client", "bad introspection secret", 401)
    return json_nostore(lookup_access(request.form.get("token", "")) or {"active": False})


@app.post("/revoke")
def revoke():
    tok = request.form.get("token", "")
    q("DELETE FROM tokens WHERE token_hash=?", (h(tok),))
    return Response(status=200)


@app.get("/health")
def health():
    db()
    return Response("OK", status=200)


if __name__ == "__main__":
    app.run(host=os.environ.get("BIND", "127.0.0.1"), port=int(os.environ.get("PORT", "4183")))
