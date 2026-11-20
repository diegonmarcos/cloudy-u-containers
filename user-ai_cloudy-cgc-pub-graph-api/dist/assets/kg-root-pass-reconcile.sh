#!/bin/sh
# kg-root-pass-reconcile.sh — compose post_hook for kg-store / kg-store-pub.
#
# Brings the LIVE SurrealDB root user's password to the value in SURREAL_PASS.
#
# Why a hook: `surreal start` only uses SURREAL_USER/SURREAL_PASS to CREATE the
# initial root user ("Only if no other root user exists" — surreal 2.7 --help).
# On a store that already has one, changing the secret changes nothing, so a
# rotation needs a `DEFINE USER OVERWRITE` executed with the previous password.
# Rotated 2026-10-10 after both root passwords leaked through `docker inspect`
# (they were passed as `--pass <pw>` on the command line).
#
# Idempotent: if SURREAL_PASS already authenticates it does nothing. Otherwise it
# tries each PREVIOUS password still present in .secrets.d (SURREAL_ROOT_PASSWORD),
# rewrites root with it, and verifies the new one. Runs on the VM host from the
# service's DEPLOY_PATH. No secret is ever put on a command line (curl reads
# credentials from a config on stdin, the query from a 0600 file) or printed.
set -eu
cd "$(dirname "$0")/.."
SD=.secrets.d
PREVIOUS="SURREAL_ROOT_PASSWORD"

port=$(grep -o -- '--bind 127.0.0.1:[0-9]*' compose/docker-compose.yml | head -1 | cut -d: -f2)
[ -n "$port" ] || { echo "[kg-root] cannot read the --bind port from compose/docker-compose.yml"; exit 1; }
[ -s "$SD/SURREAL_PASS" ] || { echo "[kg-root] $SD/SURREAL_PASS missing — the rotation fragment did not decrypt"; exit 1; }
url="http://127.0.0.1:$port"

i=0
until [ "$(curl -s -m5 -o /dev/null -w '%{http_code}' "$url/health" || true)" = 200 ]; do
    i=$((i + 1)); [ "$i" -ge 60 ] && { echo "[kg-root] $url not ready after 300s"; exit 1; }
    sleep 5
done

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT INT TERM
chmod 700 "$tmp"
printf 'RETURN 1;' > "$tmp/probe.surql"

# sql <password-file> <query-file> -> prints the HTTP code; body in $tmp/out
sql() {
    { printf 'user = "root:'
      tr -d '\n' < "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
      printf '"\n'
    } | curl -s -m60 -o "$tmp/out" -w '%{http_code}' -K - -X POST \
            -H 'Accept: application/json' --data-binary @"$2" "$url/sql" || echo 000
}

if [ "$(sql "$SD/SURREAL_PASS" "$tmp/probe.surql")" = 200 ]; then
    echo "[kg-root] :$port root password already matches SURREAL_PASS"
    exit 0
fi

for prev in $PREVIOUS; do
    [ -s "$SD/$prev" ] || continue
    [ "$(sql "$SD/$prev" "$tmp/probe.surql")" = 200 ] || continue
    ( umask 077
      printf "DEFINE USER OVERWRITE root ON ROOT PASSWORD '"
      tr -d '\n' < "$SD/SURREAL_PASS" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g"
      printf "' ROLES OWNER;"
    ) > "$tmp/rotate.surql"
    code=$(sql "$SD/$prev" "$tmp/rotate.surql")
    rm -f "$tmp/rotate.surql"
    if [ "$code" != 200 ] || [ "$(jq -r '.[0].status // empty' "$tmp/out" 2>/dev/null)" != OK ]; then
        echo "[kg-root] :$port DEFINE USER failed (http $code, status $(jq -r '.[0].status // "?"' "$tmp/out" 2>/dev/null))"
        exit 1
    fi
    if [ "$(sql "$SD/SURREAL_PASS" "$tmp/probe.surql")" = 200 ]; then
        echo "[kg-root] :$port root password rotated from $prev to SURREAL_PASS (verified)"
        exit 0
    fi
    echo "[kg-root] :$port rotation reported OK but SURREAL_PASS still does not authenticate"
    exit 1
done

echo "[kg-root] :$port neither SURREAL_PASS nor any previous password ($PREVIOUS) authenticates as root"
exit 1
