"""#1872: a kid missing from a successfully fetched JWKS is 401 (not 503); a real JWKS fetch failure
is 503; a kid miss forces at most one JWKS refetch per JWKS_REFETCH_MIN_INTERVAL. The Go shadow
(infra-sec_introspect-proxy-go, fleetauth/jwks_test.go) pins the same three cases."""
import base64
import http.server
import os
import sys
import threading
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "code"))
os.environ.setdefault("TOKENS_VERIFY_URL", "http://engine.invalid/v1/verify")  # as test_tokens_engine
os.environ.setdefault("TOKENS_VERIFY_SECRET", "s")
import main  # noqa: E402

ISS = main.ISSUER
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _b64(n):
    return base64.urlsafe_b64encode(n.to_bytes((n.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()


def _doc(use="sig"):
    nums = KEY.public_key().public_numbers()
    return ('{"keys":[{"kty":"RSA","kid":"k1","use":"%s","alg":"RS256","n":"%s","e":"%s"}]}'
            % (use, _b64(nums.n), _b64(nums.e)))


class FakeJWKS:
    """Fake Authelia JWKS endpoint: configurable answer, counts fetches."""

    def __init__(self):
        self.status, self.body, self.fetches = 200, _doc(), 0
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                outer.fetches += 1
                data = outer.body.encode()
                self.send_response(outer.status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        self.srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/jwks" % self.srv.server_port


@pytest.fixture()
def jwks(monkeypatch):
    f = FakeJWKS()
    monkeypatch.setattr(main, "_jwks_client", type(main._jwks_client)(
        f.url, cache_keys=True, cache_jwk_set=True, lifespan=600, timeout=2))
    monkeypatch.setattr(main, "JWKS_REFETCH_MIN_INTERVAL", 60.0, raising=False)
    monkeypatch.setattr(main, "TOKENS_VERIFY_URL", "")
    yield f
    f.srv.shutdown()


def call(kid):
    headers = {"kid": kid} if kid else {}
    tok = jwt.encode({"iss": ISS, "exp": int(time.time()) + 3600, "scp": [main.REQUIRED_SCOPE]},
                     KEY, algorithm="RS256", headers=headers)
    with main.app.test_request_context("/auth", headers={"Authorization": "Bearer " + tok}):
        r = main.auth()
    return r.status_code, r.get_data(as_text=True)


@pytest.mark.parametrize("kid", ["nope", None])
def test_kid_missing_from_fetched_jwks_is_401(jwks, kid):
    assert call(kid) == (401, "Invalid token")


def test_known_kid_still_200(jwks):
    assert call("k1")[0] == 200


@pytest.mark.parametrize("status,use", [(500, "sig"), (404, "sig"), (200, "enc")])
def test_real_fetch_failure_stays_503(jwks, status, use):
    # non-2xx, or a 200 whose set holds no signing keys (use=enc): PyJWKClientError
    jwks.status, jwks.body = status, _doc(use=use)
    assert call("nope") == (503, "Auth key server unavailable")


def test_unknown_kid_refetch_is_bounded(jwks, monkeypatch):
    assert call("k1")[0] == 200          # fills the cache
    base = jwks.fetches
    for i in range(20):
        assert call("rand-%d" % i) == (401, "Invalid token")
    assert jwks.fetches - base == 1      # exactly one forced refetch for 20 misses
    real = time.monotonic
    monkeypatch.setattr(main.time, "monotonic", lambda: real() + 61)
    assert call("rand-late")[0] == 401
    assert jwks.fetches - base == 2      # window reopened
    before = jwks.fetches
    assert call("k1")[0] == 200 and jwks.fetches == before  # last-known-good key, no fetch
