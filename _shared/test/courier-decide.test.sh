#!/usr/bin/env bash
# Tester for _shared/courier-decide.sh (run by dispatch-cloud-infra.yml before every decision).
# Builds a throwaway repo with one service and replays the flow that went red four times on 2026-11-18.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
decide="$here/courier-decide.sh"
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
g() { git -C "$t" -c user.name=t -c user.email=t@t "$@"; }
fail=0
check() { # name expected-action expected-services expected-after output
  local a s af
  a=$(printf '%s\n' "$5" | sed -n 's/^action=//p'); s=$(printf '%s\n' "$5" | sed -n 's/^services=//p')
  af=$(printf '%s\n' "$5" | sed -n 's/^after=//p')
  if [ "$a" = "$2" ] && [ "$s" = "$3" ] && [ "$af" = "$4" ]; then echo "PASS $1"
  else echo "FAIL $1: got action=$a services=$s after=$af, want action=$2 services=$3 after=$4"; fail=1; fi
}

g init -q -b main
mkdir -p "$t/svc-a/src" "$t/svc-a/dist" "$t/_shared"
echo '{}' > "$t/svc-a/build.json"; echo '#!/bin/sh' > "$t/svc-a/build.sh"
echo v1 > "$t/svc-a/src/app.conf"; echo v1 > "$t/svc-a/dist/app.conf"; echo x > "$t/_shared/lib.nix"
g add -A; g commit -qm base; base=$(g rev-parse HEAD)

# 1. src-only push -> no Ship dispatch; render-dist gets the service.
echo v2 > "$t/svc-a/src/app.conf"; g commit -qam "svc-a: src change"; src=$(g rev-parse HEAD)
check "src-only push -> render, no Ship" render svc-a "$src" "$(bash "$decide" push "$base" "$src" "$t")"

# 2. render-dist commits the dist and hands back by workflow_dispatch -> Ship at the render sha.
echo v2 > "$t/svc-a/dist/app.conf"; g commit -qam "ci(render-dist): re-render svc-a/dist [skip ci]"; rnd=$(g rev-parse HEAD)
out=$(bash "$decide" workflow_dispatch "$base" "$rnd" "$t")
check "render commit -> Ship at that sha" ship "" "$rnd" "$out"
printf '%s\n' "$out" | grep -qx "before=$base" && echo "PASS render hand-back keeps the push's before" || { echo "FAIL before not kept"; fail=1; }

# 3. dist-only push -> Ship, as before.
echo v3 > "$t/svc-a/dist/app.conf"; g commit -qam "svc-a: dist only"; dst=$(g rev-parse HEAD)
check "dist-only push -> Ship" ship "" "$dst" "$(bash "$decide" push "$rnd" "$dst" "$t")"

# Extra: build.json-only push (the maddy 97218a2 shape) is a render input too.
echo '{"x":1}' > "$t/svc-a/build.json"; g commit -qam "svc-a: build.json"; bj=$(g rev-parse HEAD)
check "build.json-only push -> render" render svc-a "$bj" "$(bash "$decide" push "$dst" "$bj" "$t")"
# Extra: non-service paths only -> Ship, as before.
echo y > "$t/_shared/lib.nix"; g commit -qam "shared"; sh=$(g rev-parse HEAD)
check "_shared-only push -> Ship" ship "" "$sh" "$(bash "$decide" push "$bj" "$sh" "$t")"
# Extra: undiffable range (branch creation) -> Ship, the old behaviour.
check "zero before -> Ship" ship "" "$sh" "$(bash "$decide" push 0000000000000000000000000000000000000000 "$sh" "$t")"

[ "$fail" = 0 ] && echo "courier-decide: all cases pass" || { echo "courier-decide: FAILED"; exit 1; }
