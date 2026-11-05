#!/usr/bin/env bash
# Guard: every phone cloudy-c3-mcp (peers-control) dials is declared ONCE (build.json
# ssh.phones) and every consumer matches its phone entry.
#
# History: SUPERAPP_HOSTS once named aliases no config defined ("Could not
# resolve hostname" looked like a dead phone); later the MCP knew one phone
# (wg client `termux`, 10.0.0.9) while a second phone (samsung-a37,
# 10.0.0.10) joined the mesh, so every tool dialled the offline one.
#   - ssh.extra_hosts must be EXACTLY phones x doors x {v4,v6}, each row
#     carrying its phone's wg_client (the derive resolves the address from
#     cloud-infra config.json native.wireguard.clients; never restated here);
#   - compose.nix SUPERAPP_PHONES and device.ts's default must name declared aliases;
#   - device.ts's id map must send each phones[].id to that phone's alias.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
bad() { echo "FAIL $*"; fail=1; }
J=build.json
DEV=src/code/mcp/peers/device.ts

[ "$(jq '.ssh.phones|length' $J)" -ge 1 ] || bad "build.json ssh.phones is empty"
inc=$(jq -r '.ssh.phones[] | select((.alias|type)!="string" or (.id|type)!="string" or (.wg_client|type)!="string") | .alias // "?"' $J)
[ -z "$inc" ] || bad "incomplete ssh.phones entries: $inc"
dup=$(jq -r '[.ssh.phones[].alias, .ssh.phones[].id] | group_by(.)[] | select(length>1)[0]' $J)
[ -z "$dup" ] || bad "phone alias/id declared twice: $dup"

want=$(jq -c '[.ssh.phones[] as $p | .ssh.doors[] as $d | ("v4","v6") as $f |
  {host: ($p.alias + $d.suffix + (if $f=="v6" then "-v6" else "" end)), wg_client: $p.wg_client, family: $f, user: $d.user, port: $d.port}] | sort_by(.host)' $J)
have=$(jq -c '[.ssh.extra_hosts[] | {host, wg_client, family: (.family // "v4"), user, port}] | sort_by(.host)' $J)
if [ "$want" = "$have" ]; then echo "ok   extra_hosts == phones x doors (each row on its phone's wg_client)"
else bad "ssh.extra_hosts drifted from ssh.phones x ssh.doors"; diff <(jq . <<<"$want") <(jq . <<<"$have") || true; fi

aliases=$(jq -r '.ssh.phones[].alias' $J)
check() { # $1 = where, $2 = comma list
  local a
  [ -n "$2" ] || { bad "$1: no phone list found"; return; }
  for a in ${2//,/ }; do
    [ "$a" = local ] && continue
    if grep -qxF "$a" <<<"$aliases"; then echo "ok   $1: $a"; else bad "$1: phone '$a' is not in build.json ssh.phones"; fi
  done
}
check compose.nix "$(sed -n 's/.*SUPERAPP_PHONES *= *"\([^"]*\)".*/\1/p' src/compose.nix | head -1)"
check device.ts  "$(sed -n 's/^export const PHONES.*?? "\([^"]*\)")$/\1/p' $DEV | head -1)"
grep -q 'SUPERAPP_HOSTS *= *"' src/compose.nix && bad "compose.nix still sets SUPERAPP_HOSTS (one phone); use SUPERAPP_PHONES"

while IFS=$'\t' read -r id alias; do
  if grep -qE "\"$id\": *\"$alias\"" $DEV; then echo "ok   device.ts maps $id -> $alias"
  else bad "device.ts PHONE_IDS does not map \"$id\" to \"$alias\""; fi
done < <(jq -r '.ssh.phones[] | [.id, .alias] | @tsv' $J)

[ "$fail" = 0 ] && echo "PASS superapp-hosts-declared" || exit 1
