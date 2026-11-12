#!/usr/bin/env python3
"""
JWT Validation Proxy

Validates Bearer JWTs locally using Authelia's JWKS public keys.
No dependency on Authelia's token database — only needs the public key
to verify RSA signatures.

Architecture:
    CLI Client -> Caddy (forward_auth) -> This Proxy -> Local JWT validation
                                              |              (JWKS cached)
                                              v
                                        200 OK + headers (valid)
                                        401 Unauthorized (invalid)
"""

import os
import time
import logging
import jwt
from flask import Flask, request, Response
from jwt import PyJWKClient

# Configuration from environment
JWKS_URL = os.environ.get("JWKS_URL", "https://auth.diegonmarcos.com/jwks.json")
ISSUER = os.environ.get("ISSUER", "https://auth.diegonmarcos.com")
REQUIRED_SCOPE = os.environ.get("REQUIRED_SCOPE", "authelia.bearer.authz")
DEBUG = os.environ.get("DEBUG", "false").lower() == "true"
# JWKS fetch must never eat into the caller's request budget (Cloudflare
# Worker fetches here have a ~10s deadline). Keep this well under that, and
# well under PyJWKClient's 30s default.
JWKS_FETCH_TIMEOUT = float(os.environ.get("JWKS_FETCH_TIMEOUT", "3"))

# Logging setup
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# JWKS TTL, in seconds. PyJWKClient's own jwk-set cache (cache_jwk_set)
# refetches only after this many seconds; its per-kid signing-key cache
# (cache_keys) never expires, so a key already resolved once keeps working
# even while JWKS_URL is unreachable — a stale-but-valid key beats a hung
# request. Built once at import time: a single long-lived PyJWKClient is the
# whole point of caching, so it must never be thrown away on a fetch error
# (that used to force a full refetch, with the default 30s timeout, on every
# single request while Authelia was unreachable — the outage on 2026-08-22).
JWKS_CACHE_TTL = int(os.environ.get("JWKS_CACHE_TTL", "600"))  # 10 min
_jwks_client = PyJWKClient(
    JWKS_URL,
    cache_keys=True,
    cache_jwk_set=True,
    lifespan=JWKS_CACHE_TTL,
    timeout=JWKS_FETCH_TIMEOUT,
)


def get_jwks_client():
    """Return the shared, long-lived JWKS client (see caching note above)."""
    return _jwks_client


# ── MCP OAuth opaque tokens (infra-sec_mcp-oauth, WIP option 31.1) ──────────
# Tokens prefixed `mcpat_` are minted by the MCP OAuth server for claude.ai /
# claude.com connectors. They are opaque, so they are checked with an RFC 7662
# POST to that server's mesh-only /introspect (shared secret header). Unset
# MCP_OAUTH_INTROSPECT_URL = feature off: such tokens get 401, nothing else
# changes. Positive answers are cached briefly; negatives never are.
MCP_OAUTH_PREFIX = "mcpat_"
MCP_OAUTH_INTROSPECT_URL = os.environ.get("MCP_OAUTH_INTROSPECT_URL", "")
MCP_OAUTH_INTROSPECT_SECRET = os.environ.get("MCP_OAUTH_INTROSPECT_SECRET", "")
MCP_OAUTH_TIMEOUT = float(os.environ.get("MCP_OAUTH_TIMEOUT", "3"))
MCP_OAUTH_CACHE_TTL = int(os.environ.get("MCP_OAUTH_CACHE_TTL", "30"))
_mcp_cache = {}  # sha256(token) -> (expires_at, claims)


def _mcp_introspect(token):
    import hashlib
    import json
    import urllib.parse
    import urllib.request

    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _mcp_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    req = urllib.request.Request(
        MCP_OAUTH_INTROSPECT_URL,
        data=urllib.parse.urlencode({"token": token}).encode(),
        headers={"X-Introspect-Secret": MCP_OAUTH_INTROSPECT_SECRET,
                 "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=MCP_OAUTH_TIMEOUT) as r:
        claims = json.loads(r.read())
    if claims.get("active"):
        ttl = min(MCP_OAUTH_CACHE_TTL, max(0, int(claims.get("exp", 0)) - int(time.time())))
        if len(_mcp_cache) > 1000:
            _mcp_cache.clear()
        _mcp_cache[key] = (time.time() + ttl, claims)
    return claims


def mcp_oauth_auth(token):
    if not MCP_OAUTH_INTROSPECT_URL:
        return Response("Invalid token", status=401)
    try:
        claims = _mcp_introspect(token)
    except Exception as e:  # network/HTTP/JSON: fail closed, fast
        logger.error(f"MCP OAuth introspection failed: {e}")
        return Response("Auth server unavailable", status=503)
    if not claims.get("active"):
        return Response("Invalid token", status=401)
    sub = claims.get("sub", "")
    logger.info(f"MCP OAuth token valid for client: {claims.get('client_id', '')}, sub: {sub}")
    response = Response("OK", status=200)
    # Same header contract as the fleet bearer: the human owner is the subject.
    response.headers["X-Auth-User"] = sub
    response.headers["X-Auth-Subject"] = sub
    response.headers["X-Auth-Email"] = sub
    response.headers["X-Auth-Client"] = claims.get("client_id", "")
    return response


# ── Fleet token engine (infra-sec_cloudy-ai-tokens-api) ────────────────────────────────
# Every Bearer is also checked against the engine's live list, so a token the owner
# revokes stops working within TOKENS_CACHE_TTL seconds (<= 60). `ft_` tokens exist
# only in the engine: unreachable engine = 503, never an allow. A signed Authelia JWT
# whose signature is already proven is registered with the engine on first sight
# (so the owner can list/reveal/revoke it); if the engine is unreachable the JWT keeps
# working from its last answer or, with none, on its own signature (availability of
# existing clients beats a new hard dependency; the JWT still expires by itself).
# Unset TOKENS_VERIFY_URL = engine off, behaviour exactly as before.
FLEET_PREFIX = "ft_"
TOKENS_VERIFY_URL = os.environ.get("TOKENS_VERIFY_URL", "")
TOKENS_VERIFY_SECRET = os.environ.get("TOKENS_VERIFY_SECRET", "")
TOKENS_TIMEOUT = float(os.environ.get("TOKENS_TIMEOUT", "3"))
TOKENS_CACHE_TTL = min(60, int(os.environ.get("TOKENS_CACHE_TTL", "30")))
TOKENS_STALE_MAX = int(os.environ.get("TOKENS_STALE_MAX", "300"))
_tokens_cache = {}  # sha256(token|host) -> (fresh_until, answered_at, answer)
TOKENS_BREAKER_S = 10      # after a failed call, do not dial the engine again for this long
_engine_down_until = [0.0]  # (a dead engine must not hold every gunicorn thread for TOKENS_TIMEOUT)


def _engine_ask(token, host, adopt=None):
    import hashlib
    import json
    import urllib.request

    key = hashlib.sha256((token + "|" + host).encode()).hexdigest()
    now = time.time()
    hit = _tokens_cache.get(key)
    if hit and hit[0] > now:
        return hit[2], True
    if _engine_down_until[0] > now:
        return (hit[2], True) if hit and now - hit[1] < TOKENS_STALE_MAX else (None, False)
    body = {"token": token, "host": host}
    if adopt:
        body["adopt"] = adopt
    req = urllib.request.Request(
        TOKENS_VERIFY_URL, data=json.dumps(body).encode(),
        headers={"X-Verify-Secret": TOKENS_VERIFY_SECRET, "Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TOKENS_TIMEOUT) as r:
            ans = json.loads(r.read())
    except Exception as e:  # network/HTTP/JSON
        logger.error(f"token engine unreachable: {type(e).__name__}")
        _engine_down_until[0] = now + TOKENS_BREAKER_S
        if hit and now - hit[1] < TOKENS_STALE_MAX:
            return hit[2], True
        return None, False
    if len(_tokens_cache) > 2000:
        _tokens_cache.clear()
    _tokens_cache[key] = (now + TOKENS_CACHE_TTL, now, ans)
    return ans, True


def fleet_token_auth(token):
    """`ft_` fleet token: valid only if the engine says so."""
    if not TOKENS_VERIFY_URL:
        return Response("Invalid token", status=401)
    ans, _ = _engine_ask(token, request.headers.get("X-Forwarded-Host", ""))
    if ans is None:
        return Response("Auth server unavailable", status=503)
    if not ans.get("active"):
        return Response("Invalid token", status=401)
    name = ans.get("name", "")
    logger.info(f"Fleet token valid: {ans.get('id', '')}")
    response = Response("OK", status=200)
    response.headers["X-Auth-User"] = name
    response.headers["X-Auth-Subject"] = ans.get("subject", "") or name
    response.headers["X-Auth-Email"] = name
    response.headers["X-Auth-Scopes"] = " ".join(ans.get("scopes", []))
    return response


@app.route("/auth", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
def auth():
    """
    Validates Bearer JWT locally using JWKS public key.

    Expected by Caddy forward_auth directive:
    - 2xx: Allow request, forward auth headers to backend
    - 401: Deny request

    Request Headers:
        Authorization: Bearer <token>

    Response Headers (on success):
        X-Auth-User: client_id from token
        X-Auth-Subject: sub claim from token
        X-Auth-Email: email from token (if available)
    """
    auth_header = request.headers.get("Authorization", "")

    if not auth_header.startswith("Bearer "):
        logger.debug("No Bearer token in Authorization header")
        return Response("No Bearer token", status=401)

    token = auth_header[7:].strip()
    # JWT tokens are always ASCII — reject non-ASCII bytes
    if not token.isascii():
        logger.warning(f"Non-ASCII chars in token (len={len(token)}), stripping")
        token = token.encode('ascii', errors='ignore').decode('ascii')

    # Opaque MCP OAuth access token (infra-sec_mcp-oauth, option 31.1): never a
    # JWT, so ask its issuer instead of the JWKS. Disabled unless configured.
    if token.startswith(MCP_OAUTH_PREFIX):
        return mcp_oauth_auth(token)

    # Opaque fleet token minted by the token engine (infra-sec_cloudy-ai-tokens-api).
    if token.startswith(FLEET_PREFIX):
        return fleet_token_auth(token)

    try:
        jwks_client = get_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)

        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=ISSUER,
            options={"verify_aud": False},
        )
    except jwt.ExpiredSignatureError:
        logger.debug("Token expired")
        return Response("Token expired", status=401)
    except jwt.InvalidIssuerError:
        logger.debug(f"Invalid issuer")
        return Response("Invalid token issuer", status=401)
    except jwt.PyJWKClientError as e:
        # Fail fast (short JWKS_FETCH_TIMEOUT above bounds this) rather than
        # hanging the caller. Do NOT drop _jwks_client here: it holds the
        # last-known-good JWKS/signing-key cache, which we want to keep
        # serving on the next request rather than forcing a fresh fetch.
        logger.error(f"JWKS fetch failed: {e}")
        return Response("Auth key server unavailable", status=503)
    except jwt.InvalidTokenError as e:
        logger.debug(f"Invalid token: {e}")
        return Response("Invalid token", status=401)

    # Check required scope
    scopes = payload.get("scp", [])
    if REQUIRED_SCOPE and REQUIRED_SCOPE not in scopes:
        logger.debug(f"Missing scope {REQUIRED_SCOPE}, has: {scopes}")
        return Response("Insufficient scope", status=403)

    client_id = payload.get("client_id", "")
    subject = payload.get("sub", "")

    # Signature is proven; the engine decides whether the owner has revoked it.
    if TOKENS_VERIFY_URL:
        ans, _ = _engine_ask(token, request.headers.get("X-Forwarded-Host", ""), {
            "client_id": client_id, "sub": subject, "exp": payload.get("exp"), "scp": scopes})
        if ans is not None and not ans.get("active"):
            logger.info(f"Token refused by the engine: {ans.get('reason', '')}")
            return Response("Token revoked", status=401)

    logger.info(f"Token valid for client: {client_id}, sub: {subject}")

    response = Response("OK", status=200)
    response.headers["X-Auth-User"] = client_id
    response.headers["X-Auth-Subject"] = subject
    response.headers["X-Auth-Email"] = client_id
    return response


@app.route("/health", methods=["GET"])
def health():
    """Health check endpoint for Docker/orchestration."""
    return Response("OK", status=200)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 4182))
    app.run(host="0.0.0.0", port=port, debug=DEBUG)
