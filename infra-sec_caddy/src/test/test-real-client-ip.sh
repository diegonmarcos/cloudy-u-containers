#!/usr/bin/env bash
# Guard (#1897): the hub Caddy (gcp-proxy) keys every per-IP rate limit on the REAL client, not on the
# public front edge (caddy-public on oci-analytics, 10.1.0.1 over wg-public) that hands it most traffic.
# Two tiers reach the hub from the front edge, both on the hub's layer4 :443:
#   - raw-TLS passthrough (every SNI the front edge does not terminate): the front edge prefixes a PROXY v2
#     header; the hub unwraps it ONLY for a connection from the front edge's wg-public address;
#   - re-proxied L7 (c3-pvt, auth, WKD): the front edge OVERWRITES X-Forwarded-For with its own peer; the hub
#     trusts that header (trusted_proxies) ONLY from the front edge's wg-public address.
# Source: infra-sec_caddy build.json caddy_config.global.front_edge (+ security_snippets keys {client_ip});
# renderers: infra-sec_caddy/src/caddyfile.nix + 00-globals, infra-sec_caddy-public/src/caddyfile-public.nix.
#
# Rendered-text checks (hub + edge, render of build.json and, unless ALLOW_STALE_DIST=1, the committed dists):
#   H1 trusted_proxies is exactly build.json front_edge, every entry a /32 or /128, equal to the
#      wireguard_public peer oci-analytics (wg_ip/32, wg_ipv6/128) in the consolidated data; X-Forwarded-For
#      is the only client-IP header; trusted_proxies_strict on;
#   H2 the layer4 :443 listener starts with the front-edge PROXY route: matcher = remote_ip <front_edge> AND
#      proxy_protocol, handler allow = <front_edge>, then PROXY v2 to the local HTTP server; nothing else in
#      layer4 unwraps PROXY; the HTTP listener still unwraps PROXY from 127.0.0.1/32 only;
#   H3 every rate-limit zone key is {client_ip} or the authenticated identity; no zone keys on the raw
#      connection address or on a client-supplied header; no request matcher reads client_ip (gates stay
#      on remote_ip);
#   E1 the front edge trusts no proxy (no trusted_proxies / client_ip_headers);
#   E2 its layer4 passthrough route to the hub sends PROXY v2;
#   E3 every L7 reverse_proxy to the hub overwrites X-Forwarded-For with {http.request.remote.host}, once,
#      and nothing appends to it.
# Mutation-proven (each mutation must fail), and red on the pre-#1897 render (OLD_REV, fetched if needed).
# Runtime (CADDY set; CI only, .github/workflows/caddy-validate-guard.yml): the rendered PROXY route,
# trusted_proxies and (rate_limiting) snippet on a throwaway instance: a passthrough client is seen as its
# PROXY address and cannot spoof X-Forwarded-For; the front edge's X-Forwarded-For is believed; a spoofed
# X-Forwarded-For or PROXY header from any other peer is ignored; two clients behind the front edge have
# their own buckets; a widened trusted range is caught. The front edge's rendered X-Forwarded-For line
# overwrites a client-sent chain. With GEO_DB_FILE also set, both edge Caddyfiles (dist + render) validate.
# Needs: nix (eval), jq, python3, git; runtime: CADDY, openssl, curl.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
JDIR="${MULTI_SSO_JSON_DIR:-$SVC/../1_cloud-configs/dist}"
OLD_REV="${OLD_REV:-ba72b61dd473541aaeb033e9bc31585625161932}"   # last commit before #1897
for f in "$JDIR/build-caddy.json" "$JDIR/build-caddy-edge.json" "$SVC/infra-sec_caddy/build.json"; do
  [ -f "$f" ] || { echo "FAIL: missing $f (set MULTI_SSO_JSON_DIR)"; exit 1; }; done
W="$(mktemp -d)"; PIDS=""; trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done; rm -rf "$W"' EXIT
fail(){ echo "FAIL: $*"; exit 1; }; ok(){ echo "ok: $*"; }
NIX="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
LIBX="(builtins.getFlake \"github:NixOS/nixpkgs/nixos-24.11\").lib"; [ -z "${NIXPKGS_SRC:-}" ] || LIBX="import $NIXPKGS_SRC/lib"

render(){ # render <tree> <out-prefix>: hub + edge from <tree>'s build.json (security_snippets + global)
  local bj="$1/infra-sec_caddy/build.json" s g
  s="$(jq -c '.caddy_config.security_snippets' "$bj")"; g="$(jq -c '.caddy_config.global' "$bj")"
  jq --argjson s "$s" --argjson g "$g" '.security_snippets=$s|.global=$g' "$JDIR/build-caddy.json" > "$2.hub.json"
  jq --argjson s "$s" --argjson g "$g" '.security_snippets=$s|.global=$g' "$JDIR/build-caddy-edge.json" > "$2.edge.json"
  $NIX eval --impure --raw --expr "let lib=($LIBX); caddyRoutes=builtins.fromJSON (builtins.readFile $2.hub.json); in import $1/infra-sec_caddy/src/caddyfile.nix { inherit lib caddyRoutes; }" > "$2.hub"
  $NIX eval --impure --raw --expr "let lib=($LIBX); caddyPublic=builtins.fromJSON (builtins.readFile $2.edge.json); in import $1/infra-sec_caddy-public/src/caddyfile-public.nix { inherit lib caddyPublic; }" > "$2.edge"
}
render "$SVC" "$W/new"
mkdir -p "$W/oldtree"
git -C "$SVC" cat-file -e "$OLD_REV^{commit}" 2>/dev/null || git -C "$SVC" fetch -q --depth 1 origin "$OLD_REV"
git -C "$SVC" archive "$OLD_REV" infra-sec_caddy/build.json infra-sec_caddy/src infra-sec_caddy-public/src _shared _rebrand-1450 | tar -x -C "$W/oldtree"
render "$W/oldtree" "$W/old"
ok "rendered hub + edge from build.json and from the pre-#1897 tree ($OLD_REV)"

python3 -I - "$W" "$SVC" "$JDIR" "${ALLOW_STALE_DIST:-0}" <<'PY'
import json, re, sys
W, SVC, JDIR, allow_stale = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
FRONT = json.load(open(f"{SVC}/infra-sec_caddy/build.json"))["caddy_config"]["global"]["front_edge"]
UP = json.load(open(f"{W}/new.edge.json"))["private_forward_upstream"]
XFF = "header_up X-Forwarded-For {http.request.remote.host}"

def wgpub(o):
    if isinstance(o, dict):
        if isinstance(o.get("wireguard_public"), dict) and "peers" in o["wireguard_public"]: return o["wireguard_public"]
        for v in o.values():
            r = wgpub(v)
            if r: return r
    elif isinstance(o, list):
        for v in o:
            r = wgpub(v)
            if r: return r
peer = [p for p in wgpub(json.load(open(f"{JDIR}/_cloud-data-consolidated.json")))["peers"] if p["name"] == "oci-analytics"][0]
assert FRONT == [peer["wg_ip"] + "/32", peer["wg_ipv6"] + "/128"], f"build.json front_edge {FRONT} != oci-analytics wg-public {peer['wg_ip']} {peer['wg_ipv6']}"
print(f"ok: build.json front_edge {FRONT} == the wireguard_public peer oci-analytics")
F = " ".join(FRONT)

def block(t, i):
    k = t.index("{", i); d = 0
    for j in range(k, len(t)):
        d += (t[j] == "{") - (t[j] == "}")
        if d == 0: return t[i:j + 1]
    raise AssertionError("unbalanced braces")

def norm(s): return re.sub(r"\s+", " ", re.sub(r"(?m)^\s*#.*$", "", s)).strip()

def zone_keys(t):
    out = []
    for m in re.finditer(r"(?m)^\s*rate_limit \{", t):
        out += re.findall(r"\n\s*zone (\S+) \{\n\s*key\s+(\S+)", block(t, m.start()))
    return out

def check_hub(t):
    tp = re.findall(r"(?m)^\s*trusted_proxies\s+(.*)$", t)
    assert tp == ["static " + F], f"H1: trusted_proxies must be exactly 'static {F}', got {tp}"
    assert all(re.fullmatch(r"[0-9.]+/32|[0-9a-f:]+/128", c) for c in FRONT), "H1: a trusted entry wider than one address"
    assert re.findall(r"(?m)^\s*client_ip_headers\s+(.*)$", t) == ["X-Forwarded-For"], "H1: client_ip_headers must be X-Forwarded-For only"
    assert re.search(r"(?m)^\s*trusted_proxies_strict$", t), "H1: trusted_proxies_strict missing"
    l4 = block(t, t.index("layer4 {")); i443 = l4.index(":443 {"); b443 = block(l4, i443)
    first = re.search(r"\n\s*(@\S+|route)\b", b443[b443.index("{") + 1:]).group(1)
    assert first == "@front_edge_pp", f"H2: the :443 listener must start with the front-edge PROXY route, starts with {first}"
    m = block(b443, b443.index("@front_edge_pp {"))
    assert norm(m) == f"@front_edge_pp {{ remote_ip {F} proxy_protocol }}", f"H2: PROXY matcher must be remote_ip {F} AND proxy_protocol: {m!r}"
    r = norm(block(b443, b443.index("route @front_edge_pp {")))
    want = f"route @front_edge_pp {{ proxy_protocol {{ allow {F} }} proxy {{ proxy_protocol v2 upstream 127.0.0.1:8443 }} }}"
    assert r == want, f"H2: PROXY route is {r!r}, want {want!r}"
    assert len(re.findall(r"proxy_protocol \{", l4)) == 1, "H2: something else in layer4 unwraps PROXY"
    lw = norm(block(t, t.index("listener_wrappers {")))
    assert lw == "listener_wrappers { proxy_protocol { allow 127.0.0.1/32 } tls }", f"H2: HTTP listener PROXY trust changed: {lw}"
    keys = zone_keys(t); assert len(keys) >= 6, f"H3: found only {len(keys)} zones"
    for z, k in keys:
        assert k == "{client_ip}" or k.startswith("{http.request.header.X-Auth-Subject}"), f"H3: zone {z} keyed {k}, not on the real client"
    assert not re.search(r"(?m)^\s*(@\S+\s+)?(not\s+)?client_ip\s", t), "H3: a request matcher reads client_ip (gates must stay on remote_ip)"
    return True

def check_edge(t):
    assert not re.search(r"trusted_proxies|client_ip_headers", t), "E1: the front edge must trust no proxy"
    l4 = block(t, t.index("layer4 {")); rest = norm(block(l4, l4.index("route @rest {")))
    assert rest == f"route @rest {{ proxy {{ proxy_protocol v2 upstream {UP} }} }}", f"E2: passthrough to the hub sends no PROXY v2: {rest}"
    pub = norm(block(l4, l4.index("route @public {")))
    assert pub == "route @public { proxy { proxy_protocol v2 upstream 127.0.0.1:8443 } }", f"E2: local tier changed: {pub}"
    hops = [block(t, m.start()) for m in re.finditer(r"reverse_proxy (https://)?" + re.escape(UP) + r"\b", t)]
    assert len(hops) >= 3, f"E3: found only {len(hops)} L7 hops to the hub"
    for h in hops:
        ops = re.findall(r"header_up\s+[+-]?X-Forwarded-For[^\n]*", h)
        assert ops == [XFF], f"E3: a hop to the hub does not overwrite X-Forwarded-For with its own peer: {ops} in {h[:80]!r}"
    assert "c3-pvt" in t and any("c3-pvt" in t[max(0, t.find(h) - 800):t.find(h)] for h in hops), "E3: c3-pvt hop not found"
    assert not re.search(r"header_up\s+\+X-Forwarded-For", t), "E3: something appends to X-Forwarded-For"
    return True

def fails(f, t):
    try: f(t)
    except (AssertionError, ValueError) as e: return str(e)[:150]
    return None

hub, edge = open(f"{W}/new.hub").read(), open(f"{W}/new.edge").read()
check_hub(hub); print("ok: hub render passes H1-H3")
check_edge(edge); print("ok: edge render passes E1-E3")
for svc, f, r in (("infra-sec_caddy", check_hub, hub), ("infra-sec_caddy-public", check_edge, edge)):
    d = open(f"{SVC}/{svc}/dist/configs/Caddyfile").read(); first = r.split("\n", 1)[0]; i = d.find("\n" + first + "\n")
    if allow_stale: print(f"skip: {svc} committed dist comparison (ALLOW_STALE_DIST=1)"); continue
    assert i >= 0 and d[i + 1:] == r, f"{svc}: committed dist differs from the render (stale dist: re-render with render-dist)"
    print(f"ok: {svc} committed dist equals the render")
for name, f, t in (("hub", check_hub, open(f"{W}/old.hub").read()), ("edge", check_edge, open(f"{W}/old.edge").read())):
    r = fails(f, t); assert r, f"the pre-#1897 {name} render passes: the guard verifies nothing"
    print(f"ok: pre-#1897 {name} render is red ({r})")
def one(t, old, new):
    assert old in t, f"mutation anchor missing: {old!r}"; return t.replace(old, new, 1)
muts = [
    ("hub", "trusted range widened to the wg-public /24", one(hub, "trusted_proxies static " + F, "trusted_proxies static 10.1.0.0/24 fd0c:1d01::/64")),
    ("hub", "mesh trusted as well", one(hub, "trusted_proxies static " + F, "trusted_proxies static " + F + " 10.0.0.0/24")),
    ("hub", "trusts any source", one(hub, "trusted_proxies static " + F, "trusted_proxies static private_ranges")),
    ("hub", "client IP from X-Real-IP", one(hub, "client_ip_headers X-Forwarded-For", "client_ip_headers X-Real-IP X-Forwarded-For")),
    ("hub", "strict dropped", re.sub(r"\n\s*trusted_proxies_strict", "", hub, count=1)),
    ("hub", "anonymous zone back on the connection", one(hub, "zone global {\n        key    {client_ip}", "zone global {\n        key    {remote_host}")),
    ("hub", "denied zone on a client header", one(hub, "zone denied {\n            key    {client_ip}", "zone denied {\n            key    {http.request.header.X-Forwarded-For}")),
    ("hub", "PROXY accepted from any source", one(hub, "            remote_ip " + F + "\n            proxy_protocol\n", "            proxy_protocol\n")),
    ("hub", "PROXY allow widened", one(hub, "allow " + F, "allow 0.0.0.0/0 ::/0")),
    ("hub", "PROXY route dropped", hub[:hub.index("@front_edge_pp {")] + hub[hub.index("route @front_edge_pp {") + len(block(hub, hub.index("route @front_edge_pp {"))):]),
    ("hub", "HTTP listener trusts PROXY from the front edge", one(hub, "      proxy_protocol {\n        allow 127.0.0.1/32", "      proxy_protocol {\n        allow 127.0.0.1/32 10.1.0.1/32")),
    ("hub", "a gate on client_ip", one(hub, "@not_mesh not remote_ip", "@not_mesh not client_ip")),
    ("edge", "passthrough without PROXY", re.sub(r"(route @rest \{\n\s*proxy \{\n(?:\s*#[^\n]*\n)*)\s*proxy_protocol v2\n", r"\1", edge, count=1)),
    ("edge", "c3-pvt hop keeps the client's X-Forwarded-For", one(edge, "    " + XFF + "\n    transport http {\n      tls_server_name c3-pvt", "    transport http {\n      tls_server_name c3-pvt")),
    ("edge", "X-Forwarded-For appended", one(edge, XFF, "header_up +X-Forwarded-For {http.request.remote.host}")),
    ("edge", "X-Forwarded-For from a client header", one(edge, XFF, "header_up X-Forwarded-For {http.request.header.X-Forwarded-For}")),
    ("edge", "front edge trusts proxies", one(edge, "  servers {\n", "  servers {\n    trusted_proxies static private_ranges\n")),
]
for svc, name, m in muts:
    base, f = (hub, check_hub) if svc == "hub" else (edge, check_edge)
    assert m != base, f"mutation {name!r} did not change the text"
    r = fails(f, m); assert r, f"mutation {name!r} ({svc}) passes the checks: the guard verifies nothing"
    print(f"ok: mutation '{name}' ({svc}) is caught ({r})")
PY

if [ -z "${CADDY:-}" ]; then echo "SKIP: runtime + validate (CADDY not set; CI runs them)"; echo "ok: real client IP guard (#1897, rendered text)"; exit 0; fi

# ── validate both edges (the edge needs the geolocation module + the pinned database) ──
mkdir -p "$W/secrets" "$W/log" "$W/xdg"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=guard \
  -addext basicConstraints=critical,CA:TRUE -keyout "$W/secrets/MESH_CA_KEY" -out "$W/secrets/MESH_CA_CERT" 2>/dev/null
validate(){ # validate <caddyfile>
  sed -e "s#/run/secrets/#$W/secrets/#g" -e "s#/var/log/caddy#$W/log#g" -e "s#db_path [^ ]*#db_path ${GEO_DB_FILE:-none}#" "$1" > "$W/v.caddy"
  CF_API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa XDG_DATA_HOME="$W/xdg" XDG_CONFIG_HOME="$W/xdg" "$CADDY" validate --adapter caddyfile --config "$W/v.caddy" > "$W/v.log" 2>&1
}
for c in "infra-sec_caddy/dist/configs/Caddyfile:hub dist" "$W/new.hub:hub render" \
         "infra-sec_caddy-public/dist/configs/Caddyfile:edge dist" "$W/new.edge:edge render"; do
  f="${c%%:*}"; l="${c#*:}"; case "$f" in /*) ;; *) f="$SVC/$f";; esac
  case "$l" in edge*) [ -n "${GEO_DB_FILE:-}" ] || { echo "SKIP: $l validate (GEO_DB_FILE not set)"; continue; };; esac
  validate "$f" || { tail -5 "$W/v.log"; fail "$l does not validate"; }; ok "$l validates"
done

# ── runtime: the rendered hub pieces with the front edge played by 127.0.0.2 ──
PL=19731; PH=19732; PF=19733; PE=19734
python3 -I - "$W/new.hub" "$W/new.edge" "$W" "$PL" "$PH" "$PF" "$PE" <<'PY'
import re, sys
hub, edge, W, pl, ph, pf, pe = open(sys.argv[1]).read(), open(sys.argv[2]).read(), *sys.argv[3:]
F = re.search(r"trusted_proxies static (.*)", hub).group(1)
def block(t, i):
    k = t.index("{", i); d = 0
    for j in range(k, len(t)):
        d += (t[j] == "{") - (t[j] == "}")
        if d == 0: return t[i:j + 1]
l4 = block(hub, hub.index("layer4 {")); b = block(l4, l4.index(":443 {"))
pp = block(b, b.index("@front_edge_pp {")) + "\n" + block(b, b.index("route @front_edge_pp {"))
pp = pp.replace(F, "127.0.0.2/32").replace("127.0.0.1:8443", f"127.0.0.1:{ph}")
tp = "\n".join(re.findall(r"(?m)^\s*(?:trusted_proxies|client_ip_headers)\b.*$|^\s*trusted_proxies_strict$", hub)).replace(F, "@TRUSTED@")
rl = block(hub, hub.index("(rate_limiting) {"))
rl = re.sub(r"(zone global \{\n\s*key\s+\S+\n\s*events )\d+", r"\g<1>5", rl)
def conf(trusted):
    return ("{\n  admin off\n  auto_https disable_redirects\n  skip_install_trust\n  servers {\n    protocols h1 h2\n"
            + tp.replace("@TRUSTED@", trusted) + "\n    listener_wrappers {\n      proxy_protocol {\n        allow 127.0.0.1/32\n      }\n      tls\n    }\n  }\n"
            + f"  layer4 {{\n    :{pl} {{\n{pp}\n      route {{\n        proxy {{\n          proxy_protocol v2\n          upstream 127.0.0.1:{ph}\n        }}\n      }}\n    }}\n  }}\n}}\n"
            + rl + f"\nhttps://t.test:{ph} {{\n  tls internal\n  import rate_limiting\n  respond \"{{remote_host}}|{{client_ip}}\" 200\n}}\n")
open(f"{W}/rt.caddy", "w").write(conf("127.0.0.2/32"))
open(f"{W}/rt-mut.caddy", "w").write(conf("127.0.0.0/8"))
xff = re.search(r"header_up X-Forwarded-For \S+", edge).group(0)
open(f"{W}/front.caddy", "w").write("{\n  admin off\n  auto_https off\n}\n" + f":{pf} {{\n  reverse_proxy 127.0.0.1:{pe} {{\n    {xff}\n  }}\n}}\n")
PY
cat > "$W/echo.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        b = (self.headers.get("X-Forwarded-For") or "").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
python3 -I "$W/echo.py" "$PE" & PIDS="$PIDS $!"
start(){ # start <config> <port> [tls] -> waits until the port answers (over TLS through layer4 with "tls")
  XDG_DATA_HOME="$W/xdg" XDG_CONFIG_HOME="$W/xdg" "$CADDY" run --adapter caddyfile --config "$1" > "$1.log" 2>&1 & PIDS="$PIDS $!"
  for _ in $(seq 1 75); do
    if [ -n "${3:-}" ]; then curl -sk -o /dev/null --resolve "t.test:$2:127.0.0.1" "https://t.test:$2/" && return 0
    else (exec 3<>/dev/tcp/127.0.0.1/"$2") 2>/dev/null && return 0; fi
    sleep 0.2
  done
  tail -20 "$1.log"; fail "caddy did not start ($1)"
}
cat > "$W/probe.py" <<'PY'
import socket, ssl, struct, sys, ipaddress
PL = int(sys.argv[1]); MODE = sys.argv[2]
def req(src, pp=None, xff=None):
    """GET over the layer4 port from source address src; pp = PROXY v2 source address to prefix."""
    s = socket.create_connection(("127.0.0.1", PL), timeout=5, source_address=(src, 0))
    if pp:
        a = ipaddress.ip_address(pp).packed + ipaddress.ip_address("10.1.0.2").packed
        s.sendall(b"\r\n\r\n\x00\r\nQUIT\n\x21\x11" + struct.pack("!H", 12) + a + struct.pack("!HH", 40000, 443))
    c = ssl.create_default_context(); c.check_hostname = False; c.verify_mode = ssl.CERT_NONE
    try:
        t = c.wrap_socket(s, server_hostname="t.test")
        h = "GET / HTTP/1.1\r\nHost: t.test\r\nConnection: close\r\n" + (f"X-Forwarded-For: {xff}\r\n" if xff else "") + "\r\n"
        t.sendall(h.encode()); d = b""
        while True:
            x = t.recv(4096)
            if not x: break
            d += x
    except (ssl.SSLError, OSError) as e:
        return ("ERR", str(e)[:60])
    finally: s.close()
    head, _, body = d.partition(b"\r\n\r\n"); return (int(head.split()[1]), body.decode())
FRONT, OTHER = "127.0.0.2", "127.0.0.3"
r = req(OTHER, xff="198.51.100.9")
if MODE == "mutant":
    assert r == (200, f"{OTHER}|198.51.100.9"), f"mutant instance did not believe the spoof: {r}"
    print("ok: mutation (trusted range widened to 127.0.0.0/8) is caught at runtime: a non-front peer's X-Forwarded-For becomes the client"); sys.exit(0)
assert r == (200, f"{OTHER}|{OTHER}"), f"spoofed X-Forwarded-For from a non-front peer was believed: {r}"
print("ok: X-Forwarded-For from a non-front peer is ignored (client_ip stays the peer)")
r = req(FRONT, pp="198.51.100.7", xff="6.6.6.6")
assert r == (200, "198.51.100.7|198.51.100.7"), f"passthrough client not seen as its PROXY address (or spoofed its XFF): {r}"
print("ok: passthrough tier: the front edge's PROXY v2 address is the client; the client's own X-Forwarded-For is ignored")
r = req(FRONT, xff="198.51.100.8")
assert r == (200, f"{FRONT}|198.51.100.8"), f"front edge X-Forwarded-For not believed / remote changed: {r}"
print("ok: re-proxied tier: the front edge's X-Forwarded-For is the client; remote_ip (gates) stays the front edge")
r = req(OTHER, pp="198.51.100.7")
assert r[0] != 200, f"a PROXY header from a non-front peer was accepted: {r}"
print(f"ok: PROXY header from a non-front peer is refused ({r})")
a = [req(FRONT, xff="198.51.100.21")[0] for _ in range(6)]
assert a == [200] * 5 + [429], f"per-client zone behind the front edge: {a}"
assert req(FRONT, xff="198.51.100.22")[0] == 200, "a second client behind the front edge shares the first one's bucket"
assert req(FRONT, pp="198.51.100.23")[0] == 200, "a passthrough client shares a bucket with the re-proxied ones"
print("ok: clients behind the front edge have their own buckets (5 x 200, 429; the next client 200)")
o = [req("127.0.0.4", xff=f"198.51.100.{40 + i}")[0] for i in range(6)]
assert o == [200] * 5 + [429], f"a non-front peer dodged its bucket by rotating X-Forwarded-For: {o}"
print("ok: a non-front peer rotating X-Forwarded-For stays in its own bucket")
PY
start "$W/rt.caddy" "$PL" tls
python3 -I "$W/probe.py" "$PL" real || { tail -20 "$W/rt.caddy.log"; fail "runtime"; }
kill "${PIDS##* }" 2>/dev/null || true; sleep 1
start "$W/rt-mut.caddy" "$PL" tls
python3 -I "$W/probe.py" "$PL" mutant || { tail -20 "$W/rt-mut.caddy.log"; fail "runtime mutation"; }
kill "${PIDS##* }" 2>/dev/null || true
start "$W/front.caddy" "$PF"
GOT="$(curl -s -H 'X-Forwarded-For: 6.6.6.6, 7.7.7.7' "http://127.0.0.1:$PF/")"
[ "$GOT" = "127.0.0.1" ] || fail "front edge X-Forwarded-For line did not overwrite the client chain: got '$GOT'"
ok "front edge: a client-sent X-Forwarded-For chain is overwritten with the real peer (127.0.0.1)"
echo "ok: real client IP guard (#1897)"
