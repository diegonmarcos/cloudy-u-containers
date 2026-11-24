#!/usr/bin/env bash
# Guard (#1897 incident 2026-11-24): drive the REAL two-Caddy chain the public passthrough tier takes,
#   client -> front edge (infra-sec_caddy-public, layer4 :443, @rest passthrough) -> wg-public ->
#   hub (infra-sec_caddy, layer4 :443) -> hub :8443 TLS (HTTP server),
# with both committed Caddyfiles (or the ones given), each Caddy in its own network namespace so the
# front edge really reaches the hub from 10.1.0.1 (its wg-public address) and the hub really is 10.1.0.2.
# Only what cannot run on a CI runner is changed: ACME (global acme_dns) -> local_certs, secret / log /
# GeoIP paths -> temp files; the hub gets ONE extra site (pt-guard.diegonmarcos.com, an SNI the front edge
# does not terminate, so it takes the passthrough route) that answers 200 with {client_ip}.
# Asserts, from an off-mesh client 198.51.100.7:
#   C1 control: the hub answers pt-guard directly from the front edge's namespace (no PROXY): 200, client 10.1.0.1;
#   C2 passthrough through the front edge: TLS handshake + 200 for pt-guard, body = the REAL client 198.51.100.7;
#   C3 a real private passthrough host (languagetool.diegonmarcos.com): TLS handshake + an HTTP answer (the
#      off-mesh 403 / its error page), and the hub access log records client_ip 198.51.100.7 for it;
#   C4 a host the front edge terminates (www.diegonmarcos.com) still answers.
# On failure it prints the hub/edge layer4 debug lines (the evidence). Prints "RESULT: passthrough-tls-failed"
# when the passthrough gets no TLS/HTTP answer (C2/C3) and "RESULT: passthrough-wrong-client" when it answers
# but the hub sees another client, so the workflow can prove the test red on the incident pair (hub ab0d1a95 + edge 9004ff89).
# Inputs: CADDY_HUB, CADDY_EDGE (default CADDY), HUB_CADDYFILE, EDGE_CADDYFILE (default the committed dists),
# GEO_DB_FILE (the edge's country database). CI only (needs sudo + ip netns; starts throwaway Caddies).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
CADDY_HUB="${CADDY_HUB:-${CADDY:?set CADDY or CADDY_HUB}}"; CADDY_EDGE="${CADDY_EDGE:-${CADDY:-$CADDY_HUB}}"
HUB_CADDYFILE="${HUB_CADDYFILE:-$SVC/infra-sec_caddy/dist/configs/Caddyfile}"
EDGE_CADDYFILE="${EDGE_CADDYFILE:-$SVC/infra-sec_caddy-public/dist/configs/Caddyfile}"
GEO_DB_FILE="${GEO_DB_FILE:?set GEO_DB_FILE to the country database of the edge}"
NS="c2c$$"; CL="${NS}cl"; FE="${NS}fe"; HB="${NS}hb"
W="$(mktemp -d)"; chmod 755 "$W"
cleanup(){
  for n in "$CL" "$FE" "$HB"; do
    for p in $(sudo ip netns pids "$n" 2>/dev/null); do sudo kill "$p" 2>/dev/null || true; done
  done
  sleep 1
  for n in "$CL" "$FE" "$HB"; do sudo ip netns del "$n" 2>/dev/null || true; done
  sudo rm -rf "$W"
}
trap cleanup EXIT
fail(){ echo "FAIL: $*"; evidence; exit 1; }; ok(){ echo "ok: $*"; }
evidence(){
  for s in hub edge; do
    [ -f "$W/$s.log" ] || continue
    echo "── $s: layer4 / proxy_protocol / tls debug lines (last 40) ──"
    sudo grep -E 'layer4|proxy_protocol|PROXY|handshake|tls' "$W/$s.log" | grep -v 'obtain\|certificate\|acme\|issuer\|storage\|cleaning' | tail -40 || true
  done
}
for b in "$CADDY_HUB" "$CADDY_EDGE"; do "$b" version >/dev/null || { echo "FAIL: $b is not runnable"; exit 1; }; done
echo "hub caddy:  $("$CADDY_HUB" version | cut -d' ' -f1), caddy-l4 $("$CADDY_HUB" build-info | awk '$2=="github.com/mholt/caddy-l4"{print $3}')"
echo "edge caddy: $("$CADDY_EDGE" version | cut -d' ' -f1), caddy-l4 $("$CADDY_EDGE" build-info | awk '$2=="github.com/mholt/caddy-l4"{print $3}')"

mkdir -p "$W/secrets" "$W/hub-log" "$W/edge-log" "$W/hub-xdg" "$W/edge-xdg"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=guard \
  -addext basicConstraints=critical,CA:TRUE -keyout "$W/secrets/MESH_CA_KEY" -out "$W/secrets/MESH_CA_CERT" 2>/dev/null
python3 -I - "$HUB_CADDYFILE" "$EDGE_CADDYFILE" "$W" "$GEO_DB_FILE" <<'PY'
import re, sys
hubf, edgef, W, geo = sys.argv[1:]
def block_end(t, k):                                                    # k = index of the opening brace
    d = 0
    for j in range(k, len(t)):
        d += (t[j] == "{") - (t[j] == "}")
        if d == 0: return j + 1
    raise AssertionError("unbalanced braces")
def prep(t, who):
    h = "  acme_dns cloudflare {env.CF_API_TOKEN} {"; i = t.index(h)   # global ACME -> local CA (no network)
    t = t[:i] + "  local_certs\n  skip_install_trust" + t[block_end(t, i + len(h) - 1):]
    t = t.replace("/run/secrets/", f"{W}/secrets/").replace("/var/log/caddy", f"{W}/{who}-log")
    return re.sub(r"db_path \S+", f"db_path {geo}", t)
hub = prep(open(hubf).read(), "hub")
assert "pt-guard.diegonmarcos.com" not in hub
hub += ('\n# ── two-Caddy chain guard: a passthrough SNI that answers with the client the hub believes ──\n'
        'pt-guard.diegonmarcos.com {\n  bind 0.0.0.0 10.0.0.1\n  import access_log\n  respond "{client_ip}" 200\n}\n')
open(f"{W}/hub.caddy", "w").write(hub)
open(f"{W}/edge.caddy", "w").write(prep(open(edgef).read(), "edge"))
PY
ok "configs prepared (hub $(basename "$(dirname "$(dirname "$HUB_CADDYFILE")")")/…, edge $(basename "$(dirname "$(dirname "$EDGE_CADDYFILE")")")/…)"

# ── namespaces: client 198.51.100.7 <-> 198.51.100.1 front edge 10.1.0.1 <-> 10.1.0.2 hub (+10.0.0.1 mesh) ──
for n in "$CL" "$FE" "$HB"; do sudo ip netns add "$n"; sudo ip -n "$n" link set lo up; done
sudo ip link add "${NS}a" netns "$CL" type veth peer name "${NS}b" netns "$FE"
sudo ip link add "${NS}c" netns "$FE" type veth peer name "${NS}d" netns "$HB"
sudo ip -n "$CL" addr add 198.51.100.7/24 dev "${NS}a"; sudo ip -n "$FE" addr add 198.51.100.1/24 dev "${NS}b"
sudo ip -n "$FE" addr add 10.1.0.1/24 dev "${NS}c";     sudo ip -n "$HB" addr add 10.1.0.2/24 dev "${NS}d"
sudo ip -n "$HB" addr add 10.0.0.1/32 dev lo
for l in "$CL:${NS}a" "$FE:${NS}b" "$FE:${NS}c" "$HB:${NS}d"; do sudo ip -n "${l%%:*}" link set "${l#*:}" up; done
ok "namespaces up (client, front edge, hub)"

run(){ # run <ns> <who> <caddy>
  sudo ip netns exec "$1" env HOME="$W" XDG_DATA_HOME="$W/$2-xdg" XDG_CONFIG_HOME="$W/$2-xdg" \
    CF_API_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$3" run --adapter caddyfile --config "$W/$2.caddy" > "$W/$2.log" 2>&1 &
}
get(){ # get <ns> <sni> <ip> -> "<http_code>|<body>"
  sudo ip netns exec "$1" curl -sk -m 8 -o "$W/body" -w '%{http_code}' --resolve "$2:443:$3" "https://$2/" > "$W/code" 2>/dev/null || true
  printf '%s|%s' "$(cat "$W/code" 2>/dev/null)" "$(sudo cat "$W/body" 2>/dev/null | head -c 200)"; sudo rm -f "$W/body"
}
wait_for(){ # wait_for <ns> <sni> <ip> <want-code-regex> <what>
  local r=""
  for _ in $(seq 1 90); do r="$(get "$1" "$2" "$3")"; [[ "${r%%|*}" =~ ^($4)$ ]] && { echo "$r"; return 0; }; sleep 1; done
  echo "$r"; return 1
}
run "$HB" hub "$CADDY_HUB"
r="$(wait_for "$FE" pt-guard.diegonmarcos.com 10.1.0.2 200 hub)" || { sudo tail -30 "$W/hub.log"; fail "C1: the hub never answered pt-guard directly ($r)"; }
[ "$r" = "200|10.1.0.1" ] || fail "C1: hub direct answer is '$r', want '200|10.1.0.1'"
ok "C1 control: the hub answers pt-guard directly from the front edge namespace (no PROXY): $r"
run "$FE" edge "$CADDY_EDGE"
r="$(wait_for "$CL" www.diegonmarcos.com 198.51.100.1 '[1-5][0-9][0-9]' edge)" || { sudo tail -30 "$W/edge.log"; fail "C4: the front edge never answered a terminated host ($r)"; }
ok "C4 a host the front edge terminates answers through it (www: ${r%%|*})"

r="$(get "$CL" pt-guard.diegonmarcos.com 198.51.100.1)"
if [ "$r" != "200|198.51.100.7" ]; then
  case "${r%%|*}" in 200) echo "RESULT: passthrough-wrong-client ('$r')";; *) echo "RESULT: passthrough-tls-failed ('$r')";; esac
  fail "C2: passthrough pt-guard through the front edge is '$r', want '200|198.51.100.7' (TLS handshake + real client)"
fi
ok "C2 passthrough through the front edge: TLS handshake + 200, the hub sees the real client: $r"
r="$(get "$CL" languagetool.diegonmarcos.com 198.51.100.1)"
[[ "${r%%|*}" =~ ^[1-5][0-9][0-9]$ ]] || { echo "RESULT: passthrough-tls-failed (languagetool via the front edge: '$r')"; fail "C3: private passthrough host got no HTTP answer ('$r')"; }
sleep 1
sudo python3 -I - "$W/hub-log/access.log" <<'PY' || fail "C3: the hub access log has no languagetool entry with client_ip 198.51.100.7"
import json, sys
hits = []
for l in open(sys.argv[1]):
    try: e = json.loads(l)
    except ValueError: continue
    q = e.get("request", {})
    if q.get("host") == "languagetool.diegonmarcos.com": hits.append((q.get("client_ip"), q.get("remote_ip"), e.get("status")))
print("hub access log, languagetool entries (client_ip, remote_ip, status):", hits)
sys.exit(0 if any(h[0] == "198.51.100.7" for h in hits) else 1)
PY
ok "C3 private passthrough host: TLS handshake + HTTP ${r%%|*} (off-mesh), hub access log client_ip 198.51.100.7"
echo "ok: two-Caddy chain guard (#1897): front edge passthrough + PROXY -> hub :443 -> hub :8443"
