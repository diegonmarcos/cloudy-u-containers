#!/usr/bin/env bash
# Guard: on the hosts listed in build.json caddy_config.edge_auth.bearer_passthrough
# (jmap., mails.) the edge must NOT introspect `Authorization: Bearer` -- Stalwart
# validates its own OAuth/API tokens, and an edge 401 meant mail clients never
# reached it (2026-10-18). Everywhere else the Bearer check stays, and a request
# with no Authorization must still be refused at the edge.
#
# Part 1 (static): the list is exactly the declared mail hosts; both rendered
#   Caddyfiles carry `not host <list>` in every @ea_bearer matcher; the jmap site
#   still imports the edge gate and its own rate-limit bundle.
# Part 2 (runtime): real Caddy + the real rendered (edge_auth_offmesh) snippet with
#   stub auth upstreams: Bearer on jmap. reaches the backend; Bearer on another
#   host is refused by introspect; no Authorization on jmap. is refused by Authelia.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$HERE/../.."
python3 -I - "$SVC" <<'PY'
import json, re, sys
svc = sys.argv[1]
ea = json.load(open(svc + "/infra-sec_caddy/build.json"))["caddy_config"]["edge_auth"]
hosts = [e["host"] for e in ea.get("bearer_passthrough", [])]
assert hosts == ["jmap.diegonmarcos.com", "mails.diegonmarcos.com"], f"bearer_passthrough must be exactly the JMAP hosts, got {hosts}"
want = "not host " + " ".join(hosts)
for f in ("infra-sec_caddy/dist/configs/Caddyfile", "infra-sec_caddy-public/dist/configs/Caddyfile"):
    t = open(f"{svc}/{f}").read()
    ms = re.findall(r"@ea_bearer \{\n(.*?)\n    \}", t, re.S)
    assert len(ms) == 3, f"{f}: expected 3 @ea_bearer matchers, got {len(ms)}"
    for m in ms:
        assert want in m, f"{f}: @ea_bearer lacks '{want}'"
    assert len(re.findall(r"forward_auth @ea_bearer ", t)) == 3, f"{f}: introspection for other hosts was removed"
hub = open(svc + "/infra-sec_caddy/dist/configs/Caddyfile").read()
site = re.search(r"\n  jmap\.diegonmarcos\.com \{\n(.*?)\n  \}\n", hub, re.S).group(1)
assert "import security_jmap" in site and "import edge_auth_offmesh" in site, "jmap site lost its rate limit or edge gate"
print("ok: static - bearer passthrough limited to", hosts, "; gate and jmap rate limit intact")
PY
CADDY="$(command -v caddy || true)"
[ -n "$CADDY" ] || CADDY="$(ls -d /nix/store/*-caddy-2.*/bin/caddy 2>/dev/null | head -1 || true)"
[ -n "$CADDY" ] || { command -v nix >/dev/null || { echo "FAIL: neither caddy nor nix available" >&2; exit 1; }
  CADDY="$(nix --extra-experimental-features 'nix-command flakes' build --no-link --print-out-paths nixpkgs#caddy)/bin/caddy"; }
W="$(mktemp -d)"; PIDS=""
trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done; rm -rf "$W"' EXIT
P=19491; IP=19492; AP=19493; BP=19494
# stub upstreams: introspect -> 401 "edge-introspect", authelia -> 401 "edge-authelia", backend -> 401 "stalwart"
cat > "$W/stub.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
port, tag = int(sys.argv[1]), sys.argv[2]
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401); self.send_header("X-Who", tag); self.send_header("Content-Length", str(len(tag))); self.end_headers(); self.wfile.write(tag.encode())
    do_POST = do_GET
    def log_message(self, *a): pass
HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
for s in "$IP edge-introspect" "$AP edge-authelia" "$BP stalwart"; do
  set -- $s; python3 -I "$W/stub.py" "$1" "$2" & PIDS="$PIDS $!"
done
python3 -I - "$SVC/infra-sec_caddy/dist/configs/Caddyfile" "$W" "$P" "$IP" "$AP" "$BP" <<'PY'
import re, sys
def strip_rl(s):
    # Stock Caddy lacks caddy-ratelimit: drop every rate_limit block (brace-matched; #1896 nests them in
    # handle_response), the #1896 named route and its invokes. Rate limiting is guarded by
    # test-authed-rate-limit.sh and by the plugin build in caddy-validate-guard.yml.
    for pat in (r"\n[ \t]*rate_limit \{", r"\n[ \t]*&\(edge_rl_authed\) \{"):
        while True:
            m = re.search(pat, s)
            if not m: break
            k = s.index("{", m.start()); d = 0
            for j in range(k, len(s)):
                d += (s[j] == "{") - (s[j] == "}")
                if d == 0: break
            s = s[:m.start()] + s[j + 1:]
    return re.sub(r"\n[ \t]*invoke @ea_authed \S+", "", s)
f, w, p, ip, ap, bp = sys.argv[1:]
t = open(f).read()
i = t.index("  (edge_auth_offmesh) {")
depth = 0; seen = False
for j in range(i, len(t)):
    depth += (t[j] == "{") - (t[j] == "}")
    seen = seen or t[j] == "{"
    if seen and depth == 0: break
snip = strip_rl(t[i:j + 1])
auth = re.findall(r"forward_auth @ea_session (\S+) \{", snip)[0]
snip = snip.replace("forward_auth @ea_bearer 10.0.0.1:4182", f"forward_auth @ea_bearer 127.0.0.1:{ip}")
snip = snip.replace("forward_auth @ea_fleet 10.0.0.1:4182", f"forward_auth @ea_fleet 127.0.0.1:{ip}")
snip = snip.replace(f"forward_auth @ea_session {auth}", f"forward_auth @ea_session 127.0.0.1:{ap}")
open(w + "/Caddyfile", "w").write("{\n  admin off\n  auto_https off\n  order respond before handle\n}\n" + snip +
  f"\n:{p} {{\n  import edge_auth_offmesh /.well-known/acme-challenge/*\n  reverse_proxy 127.0.0.1:{bp}\n}}\n")
PY
"$CADDY" run --config "$W/Caddyfile" --adapter caddyfile >"$W/log" 2>&1 & PIDS="$PIDS $!"
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$P/" && break; sleep 0.2; done
probe() { curl -s -D "$W/h" -o "$W/b" -H "Host: $1" "${@:2}" "http://127.0.0.1:$P/.well-known/jmap" || true
  echo "$(head -1 "$W/h" | cut -d' ' -f2) $(tr -d '\r' < "$W/b")"; }
r=$(probe jmap.diegonmarcos.com -H 'Authorization: Bearer bogus')
[ "$r" = "401 stalwart" ] || { echo "FAIL: bogus Bearer on jmap. -> '$r' (want 401 from stalwart)"; tail -5 "$W/log"; exit 1; }
r=$(probe jmap.diegonmarcos.com)
[ "$r" = "401 edge-authelia" ] || { echo "FAIL: no auth on jmap. -> '$r' (want refused at the edge)"; exit 1; }
r=$(probe other.diegonmarcos.com -H 'Authorization: Bearer bogus')
[ "$r" = "401 edge-introspect" ] || { echo "FAIL: bogus Bearer on another host -> '$r' (want edge introspection)"; exit 1; }
echo "ok: runtime - jmap Bearer -> stalwart; jmap no-auth -> edge refuses; other host Bearer -> edge introspects"
