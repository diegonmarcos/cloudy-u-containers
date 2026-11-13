#!/usr/bin/env bash
# Test for render-dist-reinject-secret-mounts.sh: stripped mounts are put back byte-identical; a
# changed non-secret field (container name) is kept; a service without mounts gets none.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; H="$HERE/../render-dist-reinject-secret-mounts.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
P=0; F=0; ok() { P=$((P+1)); echo "  ok   $1"; }; bad() { F=$((F+1)); echo "  FAIL $1"; }
R="$T/r"; mkdir -p "$R/svc/dist/compose"; git -C "$R" init -q
C="$R/svc/dist/compose/docker-compose.yml"
printf '# header\n{"services":{"a":{"container_name":"old","env_file":[".secrets"],"volumes":["./.secrets.d:/run/secrets:ro","./.secrets.json:/run/secrets.json:ro"]},"b":{"container_name":"b"}}}\n' > "$C"
git -C "$R" add -A; git -C "$R" -c user.email=t@t -c user.name=t commit -q -m base
cp "$C" "$T/committed"
printf '# header\n{"services":{"a":{"container_name":"new","volumes":[]},"b":{"container_name":"b"}}}\n' > "$C"
bash "$H" "$R" svc >/dev/null 2>&1 || bad "helper failed"
j=$(tail -n1 "$C")
[ "$(printf '%s' "$j" | jq -c '.services.a.volumes')" = '["./.secrets.d:/run/secrets:ro","./.secrets.json:/run/secrets.json:ro"]' ] && ok "volumes restored in committed order" || bad "volumes"
[ "$(printf '%s' "$j" | jq -c '.services.a.env_file')" = '[".secrets"]' ] && ok "env_file restored" || bad "env_file"
[ "$(printf '%s' "$j" | jq -r '.services.a.container_name')" = new ] && ok "non-secret change kept" || bad "container_name"
[ "$(printf '%s' "$j" | jq -c '.services.b|keys')" = '["container_name"]' ] && ok "service without mounts untouched" || bad "b touched"
[ "$(head -n1 "$C")" = "# header" ] && ok "header kept" || bad "header"
# fixed point: the committed copy with a changed name only differs in the name
sed 's/"old"/"new"/' "$T/committed" | cmp -s - "$C" && ok "byte-identical to committed apart from the changed field" || bad "not byte-identical"
echo "render-dist-reinject-secret-mounts.test: $P passed, $F failed"; [ "$F" -eq 0 ]
