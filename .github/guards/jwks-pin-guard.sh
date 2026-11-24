#!/usr/bin/env bash
# #1872: introspect-proxy (Python) and introspect-proxy-go run host-net, so
# they cannot resolve the authelia container by name and fetch the JWKS from
# Authelia's auth-net bridge IP. That IP is only stable because authelia pins
# networks.auth-net.ipv4_address in its compose. If the two drift (authelia
# re-addressed, or a JWKS_URL edited), every Bearer validation at the edge
# fails. Every JWKS_URL host in both introspect composes must equal authelia's
# pinned auth-net address. Mutation: a copy with a different JWKS host is red.
set -euo pipefail
ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
check() { # $1 authelia compose, rest: introspect composes
  local a="$1"; shift
  local pin; pin="$(awk '/^    authelia = \{/{f=1} f&&/networks\.auth-net\.ipv4_address/{match($0,/"[0-9.]+"/); print substr($0,RSTART+1,RLENGTH-2); exit}' "$a")"
  [ -n "$pin" ] || { echo "RED $a: authelia has no pinned auth-net ipv4_address"; return 1; }
  local rc=0 f h
  for f in "$@"; do
    h="$(grep -oE 'JWKS_URL *= *"http://[0-9.]+:9091/' "$f" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort -u)"
    [ -n "$h" ] || { echo "RED $f: no JWKS_URL on an IP"; rc=1; continue; }
    [ "$h" = "$pin" ] || { echo "RED $f: JWKS_URL host $h != authelia auth-net pin $pin"; rc=1; }
  done
  return $rc
}
A="$ROOT/infra-sec_authelia/src/compose.nix"
P="$ROOT/infra-sec_introspect-proxy/src/compose.nix"
G="$ROOT/infra-sec_introspect-proxy-go/src/compose.nix"
check "$A" "$P" "$G"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
sed 's#http://172\.18\.0\.3:9091/#http://172.18.0.9:9091/#' "$G" > "$T/g.nix"
if check "$A" "$P" "$T/g.nix" >/dev/null; then echo "RED mutation: drifted JWKS host not caught"; exit 1; fi
sed '/networks\.auth-net\.ipv4_address/d' "$A" > "$T/a.nix"
if check "$T/a.nix" "$P" "$G" >/dev/null; then echo "RED mutation: unpinned authelia not caught"; exit 1; fi
echo "OK JWKS_URL in both introspect proxies matches authelia's pinned auth-net IP; mutations caught"
