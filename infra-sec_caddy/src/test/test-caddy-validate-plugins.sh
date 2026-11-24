#!/usr/bin/env bash
# Guard (#1896): the hub Caddyfile must load in a Caddy built like the image (xcaddy + caddy-l4 +
# caddy-ratelimit + caddy-dns/cloudflare, src/code/Dockerfile), with NOTHING stripped -- the stock-Caddy
# guards (test-hub-resource-budget.sh, the runtime tests) have to drop rate_limit, so only this one proves
# the rate-limit syntax and directive ordering the edge actually runs.
#   1. CADDY carries the three plugin modules (a stock binary is refused, not skipped);
#   2. `caddy validate` accepts the committed dist Caddyfile AND the Caddyfile rendered from src + build.json
#      (so a source change is validated before render-dist / Ship);
#   3. runtime, on the rendered #1896 snippets with stub auth services and small test limits: anonymous
#      requests hit 429 at the anonymous limit; an authenticated identity keeps going past it and is limited
#      by its own zone; a second identity has its own bucket; a refused Bearer gets the auth service's 401
#      until the per-IP denied limit, then 429; a refused session cookie keeps Authelia's 302 + Location;
#   4. mutation proof: a broken rate_limit zone must fail validate.
# Runs in CI only (.github/workflows/caddy-validate-guard.yml): it builds nothing itself and starts a
# throwaway Caddy on 127.0.0.1. Needs: CADDY (plugin build), nix (eval), jq, python3, openssl, curl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
CADDY="${CADDY:?set CADDY to a Caddy built with caddy-l4, caddy-ratelimit and caddy-dns/cloudflare}"
JDIR="${MULTI_SSO_JSON_DIR:-$SVC/../1_cloud-configs/dist}"
BJ="$SVC/infra-sec_caddy/build.json"; DIST="$SVC/infra-sec_caddy/dist/configs/Caddyfile"
for f in "$JDIR/build-caddy.json" "$BJ" "$DIST"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done
W="$(mktemp -d)"; PIDS=""; trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done; rm -rf "$W"' EXIT
fail(){ echo "FAIL: $*"; exit 1; }; ok(){ echo "ok: $*"; }

# 1. plugin build
"$CADDY" list-modules > "$W/mods"
for m in http.handlers.rate_limit layer4 dns.providers.cloudflare; do
  grep -qx "$m" "$W/mods" || fail "CADDY lacks module $m (not the image's plugin build)"
done
ok "CADDY $("$CADDY" version | cut -d' ' -f1) has rate_limit, layer4 and the Cloudflare DNS provider"

# 2. validate dist and the render of src + build.json
NIX="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
LIBX="(builtins.getFlake \"github:NixOS/nixpkgs/nixos-24.11\").lib"; [ -z "${NIXPKGS_SRC:-}" ] || LIBX="import $NIXPKGS_SRC/lib"
jq --argjson s "$(jq -c '.caddy_config.security_snippets' "$BJ")" --argjson g "$(jq -c '.caddy_config.global' "$BJ")" '.security_snippets=$s|.global=$g' "$JDIR/build-caddy.json" > "$W/hub.json"
$NIX eval --impure --raw --expr "let lib=($LIBX); caddyRoutes=builtins.fromJSON (builtins.readFile $W/hub.json); in import $SVC/infra-sec_caddy/src/caddyfile.nix { inherit lib caddyRoutes; }" > "$W/render.caddy"
mkdir -p "$W/secrets" "$W/log" "$W/xdg"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=guard \
  -addext basicConstraints=critical,CA:TRUE -keyout "$W/secrets/MESH_CA_KEY" -out "$W/secrets/MESH_CA_CERT" 2>/dev/null
validate(){ # validate <caddyfile>
  sed -e "s#/run/secrets/#$W/secrets/#g" -e "s#/var/log/caddy#$W/log#g" "$1" > "$W/v.caddy"
  CF_API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa XDG_DATA_HOME="$W/xdg" XDG_CONFIG_HOME="$W/xdg" "$CADDY" validate --adapter caddyfile --config "$W/v.caddy" > "$W/v.log" 2>&1
}
validate "$DIST" || { tail -5 "$W/v.log"; fail "committed dist Caddyfile does not validate"; }
ok "committed dist Caddyfile validates"
validate "$W/render.caddy" || { tail -5 "$W/v.log"; fail "Caddyfile rendered from src + build.json does not validate"; }
ok "Caddyfile rendered from src + build.json validates"

# 4. mutation: a broken zone must be refused
python3 -I - "$W/render.caddy" "$W/mut.caddy" <<'PY'
import sys
t = open(sys.argv[1]).read(); a = "zone global {\n        key    {client_ip}\n        events 100"
assert a in t, "mutation anchor missing"
open(sys.argv[2], "w").write(t.replace(a, "zone global {\n        key    {client_ip}\n        events many", 1))
PY
if validate "$W/mut.caddy"; then fail "a broken rate_limit zone validates: the guard verifies nothing"; fi
ok "mutation (broken rate_limit zone) is refused by validate"

# 3. runtime on the rendered #1896 pieces
grep -q 'invoke @ea_authed edge_rl_authed' "$W/render.caddy" || fail "the render carries no #1896 authenticated rate limit"
cat > "$W/stub.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
kind, port = sys.argv[1], int(sys.argv[2])
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def do_ANY(self):
        a = self.headers.get("Authorization", ""); c = self.headers.get("Cookie", "")
        code, hdr = 200, {}
        if kind == "introspect":
            if a in ("Bearer good1", "Bearer good2"): hdr["X-Auth-User"] = a.split()[1]
            else: code = 401
        elif kind == "authelia":
            if "authelia_session=good" in c: hdr["Remote-User"] = "owner"
            elif "authelia_session=" in c: code, hdr = 302, {"Location": "https://auth.example/?rd=x"}
            else: code = 401
        body = f"{kind}-{code}".encode()
        self.send_response(code)
        for k, v in hdr.items(): self.send_header(k, v)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_GET = do_POST = do_ANY
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
PI=19621; PA=19622; PU=19623; PS=19624
for s in "introspect $PI" "authelia $PA" "app $PU"; do python3 -I "$W/stub.py" $s & PIDS="$PIDS $!"; done
# Small test limits (anonymous 10, denied 10, authed 30) so the run is quick; the zones, keys, matchers and
# placement are the rendered ones.
python3 -I - "$W/render.caddy" "$W/rt.caddy" "$PI" "$PA" "$PU" "$PS" <<'PY'
import re, sys
src, out, pi, pa, pu, ps = sys.argv[1:]
t = open(src).read()
def block(start):
    k = t.index("{", start); d = 0
    for j in range(k, len(t)):
        d += (t[j] == "{") - (t[j] == "}")
        if d == 0: return t[start:j + 1]
rl = block(t.index("(rate_limiting) {")); nr = block(t.index("&(edge_rl_authed) {")); ea = block(t.index("(edge_auth) {"))
intro = re.search(r"forward_auth @ea_bearer (\S+) \{", ea).group(1)
auth = re.search(r"forward_auth @ea_session (\S+) \{", ea).group(1)
ea = ea.replace(f" {intro} {{", f" 127.0.0.1:{pi} {{").replace(f" {auth} {{", f" 127.0.0.1:{pa} {{")
def lim(txt, zone, n): return re.sub(rf"(zone {zone} \{{\n\s*key\s+\S+\n\s*events )\d+", rf"\g<1>{n}", txt)
rl = lim(rl, "global", 10); ea = lim(ea, "denied", 10); nr = lim(nr, "authed", 30)
open(out, "w").write("{\n  admin off\n  auto_https off\n  order respond before handle\n}\n" + rl + "\n" + nr + "\n" + ea +
  f"\n:{ps} {{\n  import rate_limiting\n  import edge_auth /.well-known/acme-challenge/*\n  reverse_proxy 127.0.0.1:{pu}\n}}\n")
PY
"$CADDY" run --config "$W/rt.caddy" --adapter caddyfile > "$W/rt.log" 2>&1 & PIDS="$PIDS $!"
for _ in $(seq 1 60); do curl -s -o /dev/null -H "Authorization: Bearer good2" "http://127.0.0.1:$PS/" && break; sleep 0.2; done
python3 -I - "$PS" <<'PY' || { tail -20 "$W/rt.log"; exit 1; }
import http.client, sys
port = int(sys.argv[1])
def get(n, path="/", **hdr):
    out = []
    for _ in range(n):
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=5); c.request("GET", path, headers=hdr)
        r = c.getresponse(); r.read(); out.append((r.status, r.getheader("Location"))); c.close()
    return out
def codes(x): return [s for s, _ in x]
# authenticated identity: far past the anonymous limit (10), limited by its own zone (30)
a = codes(get(30, Authorization="Bearer good1"))
assert a == [200] * 30, f"authenticated requests were limited before their own allowance: {a}"
assert codes(get(1, Authorization="Bearer good1")) == [429], "authenticated zone does not limit at its own allowance"
assert codes(get(5, Authorization="Bearer good2")) == [200] * 5, "a second identity shares the first one's bucket"
print("ok: authenticated: 30 x 200 (> anonymous 10), 31st 429, second identity has its own bucket")
# anonymous (public path, no credential): strict per-IP zone
n = codes(get(12, "/.well-known/acme-challenge/x"))
assert n[:10] == [200] * 10 and n[10:] == [429, 429], f"anonymous limit changed: {n}"
print("ok: anonymous: 10 x 200 then 429 (per-IP zone unchanged)")
# a refused Bearer: the auth service's 401 until the per-IP denied limit, then 429
f = codes(get(12, Authorization="Bearer fake"))
assert f[:10] == [401] * 10 and f[10:] == [429, 429], f"refused Bearer not limited per IP: {f}"
print("ok: refused Bearer: 10 x 401 then 429 (fake tokens buy nothing)")
PY
# A fresh instance for the cookie passthrough (the denied zone above is exhausted for 127.0.0.1).
kill "${PIDS##* }" 2>/dev/null || true; sleep 1
"$CADDY" run --config "$W/rt.caddy" --adapter caddyfile > "$W/rt2.log" 2>&1 & PIDS="$PIDS $!"
for _ in $(seq 1 60); do curl -s -o /dev/null -H "Authorization: Bearer good2" "http://127.0.0.1:$PS/" && break; sleep 0.2; done
python3 -I - "$PS" <<'PY' || { tail -20 "$W/rt2.log"; exit 1; }
import http.client, sys
port = int(sys.argv[1])
def one(**hdr):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=5); c.request("GET", "/x", headers=hdr)
    r = c.getresponse(); b = r.read(); return r.status, r.getheader("Location"), b
s, loc, _ = one(Cookie="authelia_session=expired")
assert (s, loc) == (302, "https://auth.example/?rd=x"), f"refused session cookie lost Authelia's redirect: {s} {loc}"
s, _, b = one(Cookie="authelia_session=good")
assert (s, b) == (200, b"app-200"), f"valid session cookie not passed: {s} {b}"
s, _, _ = one()
assert s == 401, f"no credential must reach the plain Authelia branch: {s}"
print("ok: refused cookie keeps Authelia's 302 + Location; valid cookie passes; no credential -> Authelia 401")
PY
ok "caddy validate guard (#1896)"
