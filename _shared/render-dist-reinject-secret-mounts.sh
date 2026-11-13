#!/usr/bin/env bash
# render-dist helper: a public-checkout render drops the secret mounts the vault render has (the engine
# gates them on the sops file existing). Put back, per service in dist/compose/docker-compose.yml, exactly the
# secret mount entries the COMMITTED compose has (volumes naming /run/secrets, env_file naming .secrets), so a
# render of a vault-secret service reproduces the committed compose instead of drifting or being refused.
# Usage: render-dist-reinject-secret-mounts.sh <repo_root> <service>   (after the render, before the guard)
# Only adds entries the committed file already had; never prints values.
set -eu
ROOT="${1:?repo root}"; SVC="${2:?service}"; REL="$SVC/dist/compose/docker-compose.yml"
F="$ROOT/$REL"
[ -f "$F" ] || { echo "reinject: no $REL, nothing to do"; exit 0; }
OLD=$(git -C "$ROOT" show "HEAD:$REL" 2>/dev/null) || { echo "reinject: $REL not committed, nothing to do"; exit 0; }
head_part=$(grep -n '^{' "$F" | head -1 | cut -d: -f1)
[ -n "$head_part" ] || { echo "reinject: no json line in $REL"; exit 0; }
old_json=$(printf '%s\n' "$OLD" | grep '^{' | head -1)
T="$(mktemp)"; trap 'rm -f "$T"' EXIT
jq -S -c --argjson old "$old_json" '
  def sec_vol: select(type=="string" and test("/run/secrets|\\.secrets"));
  def sec_env: select(type=="string" and test("\\.secrets"));
  .services |= with_entries(
    .key as $k | ($old.services[$k] // {}) as $o | .value |=
      ( (if (($o.volumes // []) | map(sec_vol) | length) > 0 then
           .volumes = ((.volumes // []) as $cur
             | (($o.volumes | map(sec_vol)) | map(select(. as $v | $cur | index($v) | not))) as $add
             | if ($add|length)==0 then $cur
               else (($cur + $add) as $u | if (($u|sort)==(($o.volumes)|sort)) then $o.volumes else $u end) end)
         else . end)
      | (if (($o.env_file // []) | map(sec_env) | length) > 0 then
           .env_file = ((.env_file // []) as $cur
             | (($o.env_file | map(sec_env)) | map(select(. as $v | $cur | index($v) | not))) as $add
             | if ($add|length)==0 then $cur
               else (($cur + $add) as $u | if (($u|sort)==(($o.env_file)|sort)) then $o.env_file else $u end) end)
         else . end) ) )' < <(sed -n "${head_part}p" "$F") > "$T"
# the engine writes the json line without a trailing newline; keep it byte-identical
{ head -n $((head_part-1)) "$F"; printf '%s' "$(cat "$T")"; } > "$T.new" && mv "$T.new" "$F"
echo "reinject: secret mounts of $REL restored from the committed copy"
