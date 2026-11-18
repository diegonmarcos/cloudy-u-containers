#!/usr/bin/env bash
# Guard (#1797): single-label mesh names are served from ONE publicly trusted
# *.mesh.diegonmarcos.com wildcard, without exposing anything new.
#
# Why: every <name>.mesh.diegonmarcos.com vhost used to carry its own leaf from
# the private `pki { ca mesh }`. Android (no mesh-ca.crt in its store) failed
# each handshake with "Trust anchor for certification path not found".
#
# What this asserts on the RENDERED Caddyfile:
#   1. a `*.mesh.diegonmarcos.com` site exists, is gated by @not_mesh -> 403,
#      gets its cert over ACME DNS-01 (dns cloudflare), never from the mesh CA,
#      and proxies nothing;
#   2. every single-label mesh vhost keeps the @not_mesh source gate and has
#      NO tls{} block of its own (no internal issuer, no on_demand, no
#      force_automate), so Caddy 2.10+ serves it from the managed wildcard and
#      never issues a per-name cert (names stay out of CT logs);
#   3. the multi-label cloud.<name>.mesh aliases get one public cert per name
#      (first issuer ACME DNS-01; the mesh CA only as the Let's Encrypt
#      rate-limit fallback) and keep the gate;
#   3b. no mesh vhost takes its certificate from the internal issuer, except as
#      that fallback and the underscore names no public CA can issue;
#   4. globals: the mesh CA (`pki { ca mesh }`) and `acme_dns cloudflare` are
#      still there; no `prefer_wildcard` (rejected by the 2.10+ adapter: wildcard
#      preference is the default) and no tls_automate_names for mesh names;
#   5. public routes unchanged: with BASELINE_CADDYFILE=<older render>, every
#      site block whose address is NOT under .mesh.diegonmarcos.com must be
#      byte-identical between the two renders;
#   2b. one-label names that are not valid hostnames (underscore canonical
#      aliases) keep `tls force_automate { issuer internal { ca mesh } }` and
#      each has a hyphenated twin served by the wildcard;
#   6. with a `caddy` binary on PATH (or CADDY=...), the file adapts and the
#      adapted JSON never names a single-label (LDH) mesh host in any TLS
#      automation policy or the automate loader (a per-name certificate).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CF="${CADDYFILE:-$HERE/../../dist/configs/Caddyfile}"
MESH="${MESH_DOMAIN:-mesh.diegonmarcos.com}"
MESH_RE="${MESH//./\\.}"
fail=0; ok(){ echo "ok   $*"; }; bad(){ echo "FAIL $*" >&2; fail=1; }
[ -f "$CF" ] || { echo "FAIL no Caddyfile at $CF" >&2; exit 1; }

# Print every top-level site block as: <addr>\t<body with \n escaped as \x01>.
blocks() {
  awk '
    /^  [^ #(&{][^{]*\{$/ && !inb { addr=$0; sub(/^  /,"",addr); sub(/ \{$/,"",addr); inb=1; body=""; next }
    inb && /^  \}$/ { gsub(/\n/,"\001",body); printf "%s\t%s\n", addr, body; inb=0; next }
    inb { body = body $0 "\n" }
  ' "$1"
}
ALL="$(blocks "$CF")"
body_of() { awk -F'\t' -v a="$1" '$1==a {print $2; exit}' <<<"$ALL" | tr '\001' '\n'; }

# ── 1. the wildcard site ──
W="$(body_of "*.$MESH")"
if [ -z "$W" ]; then bad "no *.$MESH site block"; else
  grep -q '^  bind 0.0.0.0 ' <<<"$W"                   && ok "wildcard: byte-matching public bind" || bad "wildcard: bind line missing/different"
  grep -q '@not_mesh not remote_ip ' <<<"$W"            && ok "wildcard: @not_mesh matcher"        || bad "wildcard: @not_mesh matcher missing"
  grep -q 'error @not_mesh "Forbidden" 403' <<<"$W"     && ok "wildcard: off-mesh 403"             || bad "wildcard: off-mesh 403 missing"
  grep -q 'dns cloudflare {env.CF_API_TOKEN}' <<<"$W"   && ok "wildcard: ACME DNS-01 issuer"       || bad "wildcard: not issued via dns cloudflare"
  grep -q 'issuer internal' <<<"$W"                     && bad "wildcard: uses the private mesh CA" || ok "wildcard: not the private CA"
  grep -qE 'reverse_proxy|file_server|root \*' <<<"$W"  && bad "wildcard: serves content"          || ok "wildcard: proxies/serves nothing"
fi

# ── 2. single-label mesh vhosts ──
single="$(awk -F'\t' -v re="^[a-z0-9-]+\\\\.${MESH_RE//\\/\\\\}\$" '$1 ~ re {print $1}' <<<"$ALL")"
n_single=$(grep -c . <<<"$single" || true)
[ "$n_single" -ge 1 ] && ok "$n_single single-label mesh vhosts" || bad "no single-label mesh vhosts found"
bad_gate=0; bad_tls=0
while IFS= read -r h; do
  [ -n "$h" ] || continue
  b="$(body_of "$h")"
  if ! grep -q '@not_mesh not remote_ip ' <<<"$b" || ! grep -q 'error @not_mesh "Forbidden" 403' <<<"$b"; then
    bad "$h: lost the @not_mesh source gate"; bad_gate=$((bad_gate+1)); fi
  if grep -qE '^\s*tls(\s|\{|$)|issuer internal|on_demand|force_automate' <<<"$b"; then
    bad "$h: carries its own tls{} (per-name cert / private CA)"; bad_tls=$((bad_tls+1)); fi
done <<<"$single"
[ "$bad_gate" -eq 0 ] && ok "every single-label mesh vhost keeps the @not_mesh gate"
[ "$bad_tls" -eq 0 ]  && ok "no single-label mesh vhost has a per-name tls{} (wildcard serves them)"

# ── 2b. one-label names that are NOT valid hostnames (underscore canonical
#        aliases) cannot be in a public SAN: they keep the private CA, pinned
#        with force_automate so the wildcard does not replace their leaf ──
nonldh="$(awk -F'\t' -v sfx=".$MESH" '{ a=$1; if (substr(a, length(a)-length(sfx)+1) != sfx) next; l=substr(a,1,length(a)-length(sfx)); if (l ~ /[.*, ]/ || l == "") next; if (l !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) print a }' <<<"$ALL")"
n_nonldh=$(grep -c . <<<"$nonldh" || true); bad_nonldh=0
while IFS= read -r h; do
  [ -n "$h" ] || continue
  b="$(body_of "$h")"
  grep -q 'tls force_automate {' <<<"$b" && grep -q 'issuer internal' <<<"$b" && grep -q 'ca mesh' <<<"$b" \
    || { bad "$h: non-LDH mesh name not pinned to the mesh CA (tls force_automate + issuer internal)"; bad_nonldh=$((bad_nonldh+1)); }
  if grep -q 'on_demand' <<<"$b"; then bad "$h: on_demand defeats the force_automate pin (wildcard wins at handshake)"; bad_nonldh=$((bad_nonldh+1)); fi
  grep -q 'error @not_mesh "Forbidden" 403' <<<"$b" || { bad "$h: lost the @not_mesh gate"; bad_nonldh=$((bad_nonldh+1)); }
  twin="${h//_/-}"; tb="$(body_of "$twin")"
  if [ -z "$tb" ]; then bad "$h: no hyphenated twin $twin"; bad_nonldh=$((bad_nonldh+1))
  elif grep -qE '^\s*tls(\s|\{|$)|issuer internal' <<<"$tb" || ! grep -q 'error @not_mesh "Forbidden" 403' <<<"$tb"; then
    bad "$twin: twin must be wildcard-served (no tls{}) and gated"; bad_nonldh=$((bad_nonldh+1)); fi
done <<<"$nonldh"
[ "$bad_nonldh" -eq 0 ] && ok "$n_nonldh non-LDH one-label mesh vhosts pinned to the mesh CA + gate, each with a wildcard-served hyphenated twin"

# ── 3. multi-label cloud.<name>.mesh aliases: one public cert per name ──
#      first issuer ACME DNS-01; the mesh CA may follow ONLY as the
#      Let's Encrypt rate-limit fallback; never on_demand; gate kept.
multi="$(awk -F'\t' -v sfx=".$MESH" '{ a=$1; if (substr(a, length(a)-length(sfx)+1) == sfx) { l=substr(a,1,length(a)-length(sfx)); if (l ~ /\./ && l !~ /[ ,*]/) print a } }' <<<"$ALL")"
n_multi=$(grep -c . <<<"$multi" || true)
bad_multi=0
while IFS= read -r h; do
  [ -n "$h" ] || continue
  b="$(body_of "$h")"
  first="$(grep -oE 'issuer (acme|internal)' <<<"$b" | head -1)"
  [ "$first" = "issuer acme" ] && grep -q 'dns cloudflare {env.CF_API_TOKEN}' <<<"$b" \
    || { bad "$h: first issuer is not ACME DNS-01 ($first)"; bad_multi=$((bad_multi+1)); }
  if grep -q 'on_demand' <<<"$b"; then bad "$h: on_demand on a public per-name cert"; bad_multi=$((bad_multi+1)); fi
  grep -q 'error @not_mesh "Forbidden" 403' <<<"$b" || { bad "$h: lost the @not_mesh gate"; bad_multi=$((bad_multi+1)); }
done <<<"$multi"
[ "$bad_multi" -eq 0 ] && ok "$n_multi multi-label mesh vhosts: public ACME DNS-01 first (mesh CA only as fallback) + gate"

# ── 3b. no mesh vhost uses the internal issuer as its certificate source.
#        Allowed: internal AFTER acme (rate-limit fallback), and the pinned
#        underscore names (no public CA can issue them; twin checked in 2b).
bad_int=0
while IFS=$'\t' read -r a body; do
  case "$a" in *".$MESH") ;; *) continue ;; esac
  b="$(tr '\001' '\n' <<<"$body")"
  grep -q 'issuer internal' <<<"$b" || continue
  first="$(grep -oE 'issuer (acme|internal)' <<<"$b" | head -1)"
  [ "$first" = "issuer acme" ] && continue
  case "${a%.$MESH}" in *_*) grep -q 'tls force_automate {' <<<"$b" && continue ;; esac
  bad "$a: served from the internal issuer"; bad_int=$((bad_int+1))
done <<<"$ALL"
[ "$bad_int" -eq 0 ] && ok "no mesh vhost takes its certificate from the internal issuer (except fallback / underscore pins)"

# ── 4. globals ──
grep -qE '^\s*ca mesh \{' "$CF"                  && ok "pki { ca mesh } still declared" || bad "pki ca mesh missing (breaks underscore pins, *.db and the cloud.* fallback)"
grep -q 'acme_dns cloudflare {env.CF_API_TOKEN}' "$CF" && ok "global acme_dns cloudflare"  || bad "global acme_dns cloudflare missing"
grep -q 'prefer_wildcard' "$CF"                  && bad "prefer_wildcard set (Caddy 2.10+ rejects it)" || ok "no prefer_wildcard (default in 2.10+)"
grep -qE "tls_automate_names.*\.${MESH_RE}" "$CF" && bad "tls_automate_names lists a mesh name (per-name cert)" || ok "no tls_automate_names for mesh names"

# ── 5. public routes unchanged vs a baseline render ──
if [ -n "${BASELINE_CADDYFILE:-}" ]; then
  pub() { blocks "$1" | awk -F'\t' -v sfx=".$MESH" '{ a=$1; if (a ~ /\*/ && index(a, sfx)) next; n=split(a, hs, /, */); m=0; for (i=1;i<=n;i++) if (substr(hs[i], length(hs[i])-length(sfx)+1) == sfx) m++; if (m==0) print }' | sort; }
  if diff <(pub "$BASELINE_CADDYFILE") <(pub "$CF") >/dev/null; then
    ok "public (non-mesh) site blocks byte-identical to baseline ($(pub "$CF" | wc -l) blocks)"
  else
    bad "public (non-mesh) site blocks differ from baseline:"; diff <(pub "$BASELINE_CADDYFILE" | cut -f1) <(pub "$CF" | cut -f1) >&2 || true
  fi
else
  echo "skip public-route baseline diff (set BASELINE_CADDYFILE=<previous render>)"
fi

# ── 6. adapt with a real caddy (optional) ──
CADDY_BIN="${CADDY:-$(command -v caddy || true)}"
if [ -n "$CADDY_BIN" ] && [ -x "$CADDY_BIN" ]; then
  J="$(mktemp)"; trap 'rm -f "$J"' EXIT
  if "$CADDY_BIN" adapt --config "$CF" --adapter caddyfile > "$J" 2>/dev/null; then
    ok "caddy adapt accepts the Caddyfile"
    leak="$(python3 -c '
import json,re,sys
cfg=json.load(open(sys.argv[1])); sfx="."+sys.argv[2]
pols=((cfg.get("apps",{}).get("tls",{}).get("automation") or {}).get("policies") or [])
auto=((cfg.get("apps",{}).get("tls",{}).get("certificates") or {}).get("automate") or [])
subs=[s for p in pols for s in (p.get("subjects") or [])]+list(auto)
one=lambda s: s.endswith(sfx) and re.fullmatch(r"[a-z0-9]([a-z0-9-]*[a-z0-9])?", s[:-len(sfx)]) is not None
print(" ".join(sorted({s for s in subs if one(s)})))
wc=[p for p in pols if "*"+sfx in (p.get("subjects") or [])]
iss=[i.get("module") for p in wc for i in (p.get("issuers") or [])]
print("WILDCARD_ISSUERS="+",".join(iss))
' "$J" "$MESH")"
    names="$(head -1 <<<"$leak")"; iss="$(tail -1 <<<"$leak")"
    [ -z "$names" ] && ok "no TLS automation policy names a single-label mesh host" || bad "per-name TLS policy for: $names"
    case "$iss" in *acme*) ok "wildcard policy issuers: ${iss#WILDCARD_ISSUERS=}";; *) bad "wildcard policy has no ACME issuer ($iss)";; esac
    case "$iss" in *internal*) bad "wildcard policy includes the internal issuer";; esac
  else
    bad "caddy adapt rejected the Caddyfile"; "$CADDY_BIN" adapt --config "$CF" --adapter caddyfile 2>&1 | tail -3 >&2
  fi
else
  echo "skip caddy adapt (no caddy binary; set CADDY=...)"
fi
exit $fail
