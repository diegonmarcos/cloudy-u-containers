#!/usr/bin/env bash
# Guard: the hub Caddyfile must load inside the container's memory limit, and the sites that front
# the login portal and the API must be present and adapt.
#
# Why (2026-10-22 outage): a shared handle_errors snippet carried a ~160-entry host map and was imported
# on 341 sites. The adapted config grew 1 MB -> 4.5 MB, `caddy validate` peaked at 230 MB RSS against the
# container's 192M limit (102 MB before), the hub caddy was OOM-killed, and every hub-routed host
# (auth., api., git., vault., ...) reset or returned 502. Every earlier guard checked the TEXT of the render;
# none loaded it.
#
# Checks on infra-sec_caddy/dist/configs/Caddyfile (what Ship deploys):
#   1. adapts and validates with a real Caddy (modules the stock binary lacks - layer4, rate_limit, the
#      Cloudflare DNS provider - are stripped; that only UNDER-counts memory, so the budget is conservative);
#   2. adapted JSON size <= ADAPT_MAX_BYTES;
#   3. validate peak RSS <= BUDGET_PCT of the compose memory limit (stripped config, so no runtime headroom
#      is hidden: the limit also has to hold l4, rate limiting, TLS and live connections);
#   4. auth.diegonmarcos.com and api.diegonmarcos.com are served by the adapted config.
# Mutation proof: a Caddyfile with the snippet's host map inlined 341 times must FAIL checks 2 and 3.
# Needs: caddy (CADDY, PATH or the nix store), jq, python3.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
CF="${HUB_CADDYFILE:-$SVC/infra-sec_caddy/dist/configs/Caddyfile}"
COMPOSE="$SVC/infra-sec_caddy/dist/compose/docker-compose.yml"
ADAPT_MAX_BYTES="${ADAPT_MAX_BYTES:-2500000}"
BUDGET_PCT="${BUDGET_PCT:-65}"
CADDY="${CADDY:-$(command -v caddy || true)}"
[ -n "$CADDY" ] || CADDY="$(ls -d /nix/store/*-caddy-2.*/bin/caddy 2>/dev/null | head -1 || true)"
if [ -z "$CADDY" ]; then
  command -v nix >/dev/null || { echo "FAIL: neither caddy nor nix available (set CADDY)"; exit 1; }
  CADDY="$(nix --extra-experimental-features 'nix-command flakes' build --no-link --print-out-paths nixpkgs#caddy)/bin/caddy"
fi
command -v jq >/dev/null && command -v python3 >/dev/null || { echo "FAIL: jq and python3 are required"; exit 1; }
[ -f "$CF" ] && [ -f "$COMPOSE" ] || { echo "FAIL: missing $CF or $COMPOSE"; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
LIMIT_MB="$(jq -r '.services.caddy.deploy.resources.limits.memory' <(sed -n '/^{/,$p' "$COMPOSE") | sed -E 's/[Mm]$//')"
case "$LIMIT_MB" in ''|*[!0-9]*) echo "FAIL: cannot read the caddy memory limit from the compose file ($LIMIT_MB)"; exit 1;; esac
BUDGET_MB=$(( LIMIT_MB * BUDGET_PCT / 100 ))

strip_modules() { # strip_modules <in> <out>: drop what the stock Caddy cannot load
  python3 - "$1" "$2" <<'PY'
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
s = open(sys.argv[1]).read()
s = re.sub(r'\n\s*acme_dns cloudflare \{.*?\n  \}\n', '\n', s, count=1, flags=re.S)
i = s.find('\n    layer4 {')
if i >= 0:
    k = s.find('{', i); d = 0
    while True:
        d += (s[k] == '{') - (s[k] == '}')
        if d == 0: break
        k += 1
    s = s[:i] + s[k+1:]
s = strip_rl(s)
s = re.sub(r'\n\s*tls \{\n\s*dns cloudflare [^\n]*\n(?:\s*[a-z_]+ [^\n]*\n)*?\s*\}\n', '\n', s)
# Mesh vhosts (#1797) carry `tls { issuer acme { dns cloudflare ... } issuer internal { ca mesh } }`: drop
# only the ACME issuer, so the block keeps its internal issuer and still adapts.
s = re.sub(r'\n\s*issuer acme \{\n\s*dns cloudflare [^\n]*\n(?:\s*[a-z_]+ [^\n]*\n)*?\s*\}\n', '\n', s)
open(sys.argv[2], 'w').write(s)
PY
}

# Throwaway mesh CA + XDG dirs so validate can provision `issuer internal { ca mesh }`.
mkdir -p "$W/xdg" "$W/secrets"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 -subj /CN=guard \
  -addext basicConstraints=critical,CA:TRUE -keyout "$W/secrets/MESH_CA_KEY" -out "$W/secrets/MESH_CA_CERT" 2>/dev/null
mkdir -p "$W/log"
prep() { sed -e "s#/run/secrets/#$W/secrets/#g" -e "s#/var/log/caddy#$W/log#g" "$1" > "$2"; }

measure() { # measure <caddyfile> -> prints "<rc> <rss_mb> <adapted_bytes>"
  python3 - "$CADDY" "$1" "$W" <<'PY'
import os, resource, subprocess, sys
caddy, cf, w = sys.argv[1:4]
env = dict(os.environ, CF_API_TOKEN="x", XDG_DATA_HOME=w + "/xdg", XDG_CONFIG_HOME=w + "/xdg")
a = subprocess.run([caddy, "adapt", "--config", cf, "--adapter", "caddyfile"], capture_output=True, env=env)
open(w + "/adapted.json", "wb").write(a.stdout)
p = subprocess.run([caddy, "validate", "--config", cf, "--adapter", "caddyfile"], capture_output=True, env=env)
rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss // 1024  # max of the two children, KB -> MB
print(p.returncode if a.returncode == 0 else a.returncode, rss, len(a.stdout))
if p.returncode:
    sys.stderr.write(p.stderr.decode()[-400:])
PY
}

check() { # check <label> <caddyfile>; sets RC RSS BYTES
  strip_modules "$2" "$W/in.s"; prep "$W/in.s" "$W/in.p"
  read -r RC RSS BYTES < <(measure "$W/in.p")
}

check real "$CF"
[ "$RC" = 0 ] || { echo "FAIL: the hub Caddyfile does not adapt/validate (rc=$RC)"; exit 1; }
echo "ok: hub Caddyfile adapts and validates"
[ "$BYTES" -le "$ADAPT_MAX_BYTES" ] || { echo "FAIL: adapted config is $BYTES bytes (> $ADAPT_MAX_BYTES): something is expanded per site"; exit 1; }
echo "ok: adapted config $BYTES bytes (<= $ADAPT_MAX_BYTES)"
[ "$RSS" -le "$BUDGET_MB" ] || { echo "FAIL: validate peak ${RSS} MB > ${BUDGET_MB} MB (${BUDGET_PCT}% of the ${LIMIT_MB}M container limit)"; exit 1; }
echo "ok: validate peak ${RSS} MB <= ${BUDGET_MB} MB (${BUDGET_PCT}% of ${LIMIT_MB}M)"
for h in auth.diegonmarcos.com api.diegonmarcos.com; do
  jq -e --arg h "$h" '[.apps.http.servers[].routes[]?|select(.match[]?.host[]?==$h)]|length>0' "$W/adapted.json" >/dev/null \
    || { echo "FAIL: $h is not served by the adapted config"; exit 1; }
  echo "ok: $h is served"
done

# Mutation proof: the outage shape (a 160-entry map inlined on every site) must trip the budget.
python3 - "$CF" "$W/mut.cf" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
big = "      map {host} {fb_path} {\n" + "".join("        h%03d.diegonmarcos.com p%03d/\n" % (i, i) for i in range(160)) + "        default \"\"\n      }\n"
# every `import edge_errors` is replaced by an inline handle_errors carrying the map
s = re.sub(r'^(\s*)import edge_errors\s*$', lambda m: m.group(1) + "handle_errors {\n" + big + m.group(1) + "  respond \"{err.message}\" {err.status_code}\n" + m.group(1) + "}", s, flags=re.M)
open(sys.argv[2], 'w').write(s)
PY
check mutant "$W/mut.cf"
if [ "$RC" = 0 ] && [ "$BYTES" -le "$ADAPT_MAX_BYTES" ] && [ "$RSS" -le "$BUDGET_MB" ]; then
  echo "FAIL: the budget did not catch the per-site map mutation (rc=$RC, ${RSS} MB, $BYTES bytes) - the guard verifies nothing"; exit 1
fi
echo "ok: mutation (map inlined per site) trips the guard (rc=$RC, ${RSS} MB, $BYTES bytes)"
echo "ok: hub resource budget guard"
