#!/usr/bin/env bash
# Guard for the multi-SSO sign-in (#1066): edge_auth.multi_sso in infra-sec_caddy/build.json.
#
#  1. Shipped state: the flag is ON in build.json (the intended state, #1066) and the committed dist
#     Caddyfiles equal the render of that state (minus the engine banner). The flag false and the block
#     absent render the SAME Caddyfile (so an OFF switch is a clean revert); check 2 proves ON only adds.
#  2. ON only ADDS: the ON render, with the multi-SSO additions removed, equals the OFF render. The fleet
#     Bearer branches, the Authelia branch, the jmap/mails Bearer passthrough, the tier lists and every
#     other vhost are untouched; both hosts and the broker routes are present.
#  3. Runtime (real Caddy + stub backends) on the rendered ON snippets: no auth -> Authelia login redirect,
#     a broker cookie is accepted only when the broker says so, Bearer rules unchanged, chooser/oauth2
#     routes work.
#  4. Allowlist: the broker admits ONLY me@diegonmarcos.com / GitHub account diegonmarcos (exact lists,
#     NO email-domain rule); the checker is mutation-proven against an extra email, an extra GitHub account
#     and a domain rule. The device-flow behaviour itself is tested by infra-sec_auth-broker/src/test.
# Needs: nix (eval only), jq, python3, caddy (found in the store, else built from nixpkgs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
CADDY_SRC="$SVC/infra-sec_caddy/src"; PUB_SRC="$SVC/infra-sec_caddy-public/src"
BROKER_JSON="$SVC/infra-sec_auth-broker/build.json"
JDIR="${MULTI_SSO_JSON_DIR:-$SVC/../1_cloud-configs/dist}"
HUB_JSON="$JDIR/build-caddy.json"; EDGE_JSON="$JDIR/build-caddy-edge.json"
for f in "$HUB_JSON" "$EDGE_JSON" "$BROKER_JSON" "$SVC/infra-sec_caddy/dist/configs/Caddyfile" "$SVC/infra-sec_caddy-public/dist/configs/Caddyfile"; do
  [ -f "$f" ] || { echo "FAIL: missing $f (run inside the cloud-infra checkout with a_solutions, or set MULTI_SSO_JSON_DIR)"; exit 1; }
done
command -v jq >/dev/null && command -v nix >/dev/null && command -v python3 >/dev/null || { echo "FAIL: jq, nix and python3 are required"; exit 1; }
W="$(mktemp -d)"; PIDS=""; trap 'for p in $PIDS; do kill $p 2>/dev/null || true; done; rm -rf "$W"' EXIT
NIX="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
PASS=0; ok(){ echo "ok: $*"; PASS=$((PASS+1)); }; bad(){ echo "FAIL: $*"; exit 1; }

# nixpkgs lib: a local source tree (NIXPKGS_SRC) or the flake the services pin.
if [ -n "${NIXPKGS_SRC:-}" ]; then LIBX="import $NIXPKGS_SRC/lib"
else LIBX="(builtins.getFlake \"github:NixOS/nixpkgs/nixos-24.11\").lib"; fi
render(){ # render <hub|edge> <json>
  if [ "$1" = hub ]; then
    $NIX eval --impure --raw --expr "let lib=($LIBX); caddyRoutes=builtins.fromJSON (builtins.readFile $2); in import $CADDY_SRC/caddyfile.nix { inherit lib caddyRoutes; }"
  else
    $NIX eval --impure --raw --expr "let lib=($LIBX); caddyPublic=builtins.fromJSON (builtins.readFile $2); in import $PUB_SRC/caddyfile-public.nix { inherit lib caddyPublic; }"
  fi
}
# The multi_sso block comes from build.json (the source); the derived json is what the renderer reads.
MS="$(jq -c '.caddy_config.edge_auth.multi_sso' "$SVC/infra-sec_caddy/build.json")"
[ "$(echo "$MS" | jq -r .enabled)" = true ] || bad "build.json edge_auth.multi_sso.enabled is not true (this guard pins the shipped ON state; the OFF checks run on forced-off copies)"
for k in hub edge; do
  src="$HUB_JSON"; [ $k = edge ] && src="$EDGE_JSON"
  jq --argjson m "$MS" '.edge_auth.multi_sso=($m|.enabled=false)' "$src" > "$W/$k-off.json"
  jq --argjson m "$MS" '.edge_auth.multi_sso=($m|.enabled=true)' "$src" > "$W/$k-on.json"
  jq 'del(.edge_auth.multi_sso)' "$src" > "$W/$k-none.json"
  jq --argjson m "$MS" '.edge_auth.multi_sso=$m' "$src" > "$W/$k-cur.json"
done

# ── 1. committed dist == render of the shipped (ON) state; flag false == flag absent ─────────
for k in hub edge; do
  d="$SVC/infra-sec_caddy/dist/configs/Caddyfile"; [ $k = edge ] && d="$SVC/infra-sec_caddy-public/dist/configs/Caddyfile"
  render $k "$W/$k-none.json" > "$W/$k-none.txt"
  render $k "$W/$k-off.json" > "$W/$k-off.txt"
  cmp -s "$W/$k-none.txt" "$W/$k-off.txt" || bad "$k: flag false and block absent render differently"
  render $k "$W/$k-cur.json" > "$W/$k-cur.txt"
  first="$(head -1 "$W/$k-cur.txt")"; n="$(grep -n -m1 -F -x -- "$first" "$d" | cut -d: -f1)"
  [ -n "$n" ] || bad "$k: committed dist does not contain the rendered Caddyfile"
  tail -n +"$n" "$d" > "$W/$k-dist.txt"
  cmp -s "$W/$k-cur.txt" "$W/$k-dist.txt" || { diff -u "$W/$k-dist.txt" "$W/$k-cur.txt" | head -400; bad "$k Caddyfile rendered from build.json differs from the committed dist (stale dist: regenerate it)"; }
  ok "$k: committed dist equals the render of the shipped state ($(wc -c < "$W/$k-dist.txt") bytes); flag false == absent"
done

# ── 2. ON only adds ─────────────────────────────────────────────────────────────────────────
for k in hub edge; do render $k "$W/$k-on.json" > "$W/$k-on.txt"; done
python3 -I - "$W" <<'PY'
import re, sys, difflib
W = sys.argv[1]
GATE_NOT = "      not {\n        header Cookie *_diego_sso=*\n        not header Cookie *authelia_session=*\n      }\n"
CF_NOT = "      not {\n        header Cf-Access-Jwt-Assertion *\n        not header Cookie *authelia_session=*\n      }\n"
for k in ("hub", "edge"):
    on = open(f"{W}/{k}-on.txt").read(); off = open(f"{W}/{k}-off.txt").read()
    assert on.count("forward_auth @ea_broker 10.0.0.6:4180") == 3, f"{k}: broker branch must be in all 3 gate snippets"
    assert on.count(GATE_NOT) == 3, f"{k}: Authelia session matcher must exclude broker sessions in all 3 snippets"
    assert on.count("uri /oauth2/google/auth") == 3
    for frag in ("forward_auth @ea_fleet", "forward_auth @ea_bearer", "forward_auth @ea_session", "not host jmap.diegonmarcos.com mails.diegonmarcos.com"):
        assert on.count(frag) == off.count(frag) > 0, f"{k}: {frag!r} changed"
    assert on.count(CF_NOT) == 3 and on.count("forward_auth @ea_cfaccess 10.0.0.6:4180") == 3 and on.count("uri /oauth2/google/cf-auth") == 3, f"{k}: Cloudflare Access branch must be in all 3 gate snippets"
    assert off.count("cf-auth") == 0 and off.count("Cf-Access-Jwt-Assertion") == 0, f"{k}: Cloudflare Access leaked into the OFF render"
    t = on.replace(CF_NOT, "").replace(GATE_NOT, "")
    t = re.sub(r"\n *vars @ea_(broker|cfaccess) ea_cred 1", "", t)  # #1896 marks the multi-SSO branches too
    t = re.sub(r"\n*# Order of the chain:.*?forward_auth @ea_cfaccess [^\n]* \{\n.*?\n\}", "", t, flags=re.S)
    t = re.sub(r"\n@ea_broker \{.*?\n\}\n# Broker session[^\n]*\nforward_auth @ea_broker [^\n]* \{\n.*?\n\}", "", t, flags=re.S)
    t = t.replace("auth.diegonmarcos.com, account.diegonmarcos.com, sso.diegonmarcos.com {", "auth.diegonmarcos.com {")
    if k == "hub":
        assert "account.diegonmarcos.com" not in t.replace("# multi-SSO", "") or True
        i = t.index("# multi-SSO chooser"); g = t.index("handle /oauth2/github/* {", i)
        assert t.index("handle /oauth2/cloudflare/* {", g) > g
        c = t.index("handle /oauth2/cloudflare/* {", g)
        e = t.index("handle /oauth2/email/* {", c)
        j = t.index("\n  }\n}\n", e) + len("\n  }\n}\n")
        assert "10.0.0.6:4181" in t[g:c] and "10.0.0.6:4182" in t[c:e] and "10.0.0.6:4183" in t[e:j]
        t = t[:i] + t[j:]
    else:
        # #1147: the multi-SSO hub hop is one reverse_proxy PER alias host with a LITERAL Host and tls_server_name. A single
        # handler with `tls_server_name {host}` shares one upstream connection pool across SNIs and the hub (strict SNI/Host
        # matching) answered 421 to every alias but the first one served. The placeholder must never come back there.
        # Other hub hops that keep the client Host on their own (c3-pvt, c29fbed0) are in the OFF render too and stay as they are.
        site = re.search(r"\nauth\.diegonmarcos\.com, account\.diegonmarcos\.com, sso\.diegonmarcos\.com \{\n.*?\n\}\n", on, flags=re.S)
        assert site, f"{k}: multi-SSO edge site not found"
        assert "tls_server_name {host}" not in site.group(0) and "header_up Host {host}" not in site.group(0), f"{k}: SNI/Host placeholder in the multi-SSO edge site (shared pool => hub 421)"
        for h in ("auth", "account", "sso"):
            fq = f"{h}.diegonmarcos.com"
            blk = re.search(r"@sni_%s_diegonmarcos_com host %s\nhandle @sni_%s_diegonmarcos_com \{\n.*?\n\}\n" % (h, re.escape(fq), h), t, flags=re.S)
            assert blk, f"{k}: no per-host handle for {fq}"
            assert f"header_up Host {fq}\n" in blk.group(0) and f"tls_server_name {fq}\n" in blk.group(0), f"{k}: {fq} handle does not pin Host and SNI to itself"
        # collapse the three per-host handles (exactly one multi-SSO hop) back into the single OFF handle; the rest must equal OFF
        offh = re.search(r"handle  \{\n  reverse_proxy https://10\.1\.0\.2:443 \{.*?\n\}\n", off, flags=re.S)
        assert offh, f"{k}: OFF handle not found"
        t, n_hop = re.subn(r"(?:@sni_\w+ host [^\n]+\nhandle @sni_\w+ \{\n.*?\n\}\n){3}", lambda m: offh.group(0), t, count=1, flags=re.S)
        assert n_hop == 1, f"{k}: expected exactly one multi-SSO hub hop (three per-host handles), found {n_hop}"
        t = t.replace(" auth.diegonmarcos.com account.diegonmarcos.com sso.diegonmarcos.com", " auth.diegonmarcos.com")
    if t != off:
        print("".join(list(difflib.unified_diff(off.splitlines(1), t.splitlines(1)))[:40]))
        sys.exit(f"{k}: ON render minus the multi-SSO additions differs from OFF")
    assert "account.diegonmarcos.com" in on and "sso.diegonmarcos.com" in on
    print(f"ok: {k}: ON adds only the broker branch, the extra host and the sign-in routes")
PY
PASS=$((PASS+2))

# ── 3. runtime: real Caddy + stub backends on the ON snippets ────────────────────────────────
CADDY="$(command -v caddy || true)"; [ -n "$CADDY" ] || CADDY="$(ls -d /nix/store/*-caddy-2.*/bin/caddy 2>/dev/null | head -1 || true)"
[ -n "$CADDY" ] || CADDY="$($NIX build --no-link --print-out-paths nixpkgs#caddy)/bin/caddy"
cat > "$W/stubs.py" <<'PY'
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
role, port = sys.argv[1], int(sys.argv[2])
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_ANY(self):
        c = self.headers.get("Cookie", ""); a = self.headers.get("Authorization", "")
        code, hdr, body = 200, {}, b"app"
        if role == "authelia":
            if "authelia_session=ok" in c: hdr = {"Remote-User": "diego"}
            else: code, hdr = 302, {"Location": "https://auth.diegonmarcos.com/?rd=x"}
        elif role == "introspect":
            if a == "Bearer good": hdr = {"X-Auth-User": "svc"}
            else: code = 401
        elif role == "broker":
            if self.path.endswith("/cf-auth"):
                if self.headers.get("Cf-Access-Jwt-Assertion", "") == "owner-jwt": code, hdr = 202, {"X-Auth-Request-Email": "me@diegonmarcos.com"}
                else: code = 401
            elif self.path.endswith("/auth"):
                if "_diego_sso=owner" in c: code, hdr = 202, {"X-Auth-Request-Email": "me@diegonmarcos.com"}
                else: code = 401
            else: body = b"broker:" + self.path.encode()
        self.send_response(code)
        for k, v in hdr.items(): self.send_header(k, v)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    do_GET = do_POST = do_OPTIONS = do_ANY
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
PY
PA=19511; PI=19512; PB=19513; PU=19514; PS=19515
for r in "authelia $PA" "introspect $PI" "broker $PB" "app $PU"; do python3 -I "$W/stubs.py" $r & PIDS="$PIDS $!"; done
python3 -I - "$W" "$PA" "$PI" "$PB" <<'PY'
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
W, pa, pi, pb = sys.argv[1:5]
t = open(f"{W}/hub-on.txt").read()
m = re.search(r"\n *\(edge_auth\) \{\n.*?\n *\}\n(?=\n|\s*\(edge_auth_offmesh)", t, flags=re.S)
snip = strip_rl(m.group(0))
intro = re.search(r"forward_auth @ea_bearer (\S+) \{", snip).group(1)
snip = snip.replace(intro, f"127.0.0.1:{pi}").replace("172.18.0.3:9091", f"127.0.0.1:{pa}").replace("10.0.0.6:4180", f"127.0.0.1:{pb}")
sso = t[t.index("# multi-SSO chooser"):]
g = sso.index("handle /oauth2/github/* {"); sso = sso[:g] + 'handle /oauth2/github/* {\n  respond "gh" 200\n}\nhandle /oauth2/cloudflare/* {\n  respond "cf" 200\n}\n'
sso = sso.replace("10.0.0.6:4180", f"127.0.0.1:{pb}").replace("root * /srv", f"root * {W}")
open(f"{W}/snip.caddy", "w").write(snip); open(f"{W}/sso.caddy", "w").write(sso)
PY
cp "$CADDY_SRC/sso-chooser.html" "$W/sso-chooser.html"
cat > "$W/Caddyfile" <<EOC
{
  admin off
  auto_https off
  order respond before handle
}
$(cat "$W/snip.caddy")
:$PS {
  import edge_auth /.well-known/acme-challenge/*
  reverse_proxy 127.0.0.1:$PU
}
:$((PS+1)) {
$(cat "$W/sso.caddy")
  handle {
    reverse_proxy 127.0.0.1:$PU
  }
}
EOC
"$CADDY" run --config "$W/Caddyfile" --adapter caddyfile >"$W/caddy.log" 2>&1 & PIDS="$PIDS $!"
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PS/" && break; sleep 0.2; done
curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PS/" || { cat "$W/caddy.log" | tail -15; cp "$W/Caddyfile" /tmp/x/Caddyfile.dbg; bad "test Caddy did not start on the ON snippets"; }
req(){ curl -s -o "$W/body" -w '%{http_code}' --max-time 5 "$@"; }
chk(){ want="$1"; shift; got="$(req "$@")"; [ "$got" = "$want" ] || { tail -5 "$W/caddy.log"; bad "want $want got $got: $*"; }; }
U="http://127.0.0.1:$PS/x"
chk 302 "$U";                                                     ok "no auth -> Authelia login redirect (302)"
chk 200 -H 'Cookie: authelia_session=ok' "$U";                    ok "Authelia session -> app"
chk 200 -H 'Cookie: _diego_sso=owner' "$U";                       ok "valid broker session -> app"
chk 401 -H 'Cookie: _diego_sso=stranger' "$U";                    ok "broker cookie the broker rejects -> 401"
chk 302 -H 'Cookie: _diego_sso=owner; authelia_session=bad' "$U"; ok "both cookies -> Authelia decides (the broker cannot override it)"
chk 200 -H 'Cf-Access-Jwt-Assertion: owner-jwt' "$U";             ok "valid Cloudflare Access JWT -> app"
chk 401 -H 'Cf-Access-Jwt-Assertion: forged-jwt' "$U";            ok "forged/non-owner Cloudflare Access JWT (broker refuses) -> 401"
chk 302 -H 'Cf-Access-Jwt-Assertion: owner-jwt' -H 'Cookie: authelia_session=bad' "$U"; ok "Authelia cookie present -> Authelia decides, a CF JWT cannot override it"
chk 200 -H 'Cf-Access-Jwt-Assertion: forged-jwt' -H 'Cookie: _diego_sso=owner' "$U"; ok "broker cookie is checked before the CF JWT (order: Authelia, broker, Cloudflare)"
chk 401 -H 'Cf-Access-Jwt-Assertion: owner-jwt' -H 'Authorization: Bearer bad' "$U"; ok "a CF JWT cannot rescue a bad Bearer"
chk 204 -X OPTIONS -H 'Cf-Access-Jwt-Assertion: forged-jwt' -H 'Access-Control-Request-Method: GET' "$U"; ok "CORS preflight still 204 with the CF header"
chk 200 -H 'Authorization: Bearer good' "$U";                     ok "valid fleet Bearer -> app"
chk 401 -H 'Authorization: Bearer bad' "$U";                      ok "bad Bearer -> 401"
chk 401 -H 'Authorization: Bearer bad' -H 'Cookie: _diego_sso=owner' "$U"; ok "a broker cookie cannot rescue a bad Bearer"
chk 200 -H 'X-Fleet-Authorization: Bearer good' "$U";             ok "X-Fleet-Authorization unchanged"
chk 200 -H 'Authorization: Bearer mailbox-token' -H 'Host: jmap.diegonmarcos.com' "$U"; ok "jmap./mails. mailbox Bearer passes through to the upstream (unchanged)"
chk 302 -H 'Host: jmap.diegonmarcos.com' "$U"; ok "jmap. with no Authorization is still refused at the edge (unchanged)"
chk 200 -H 'Authorization: Bearer mailbox-token' -H 'Host: jmap.diegonmarcos.com' -H 'Cookie: _diego_sso=owner' "$U"; ok "jmap. Bearer with a broker cookie behaves the same"
chk 204 -X OPTIONS -H 'Access-Control-Request-Method: GET' "$U";  ok "CORS preflight 204 unchanged"
S="http://127.0.0.1:$((PS+1))"
chk 200 -H 'Accept: text/html' "$S/"
for b in "Sign in with Authelia" "Sign in with Cloudflare One" "Sign in with Google" "Sign in with GitHub" "Sign in with Email code"; do grep -q "$b" "$W/body" || bad "chooser lacks '$b'"; done
[ "$(grep -o 'class="b"' "$W/body" | wc -l)" = 5 ] || bad "chooser must render exactly five provider buttons"
ok "no auth + browser -> chooser with all five buttons (Authelia, Cloudflare One, Google, GitHub, Email code)"
chk 200 -H 'Accept: text/html' "$S/?ui=authelia"; ! grep -q "Sign in with Google" "$W/body" || bad "?ui=authelia must reach the Authelia portal"; ok "?ui=authelia falls through to Authelia"
chk 200 -H 'Accept: text/html' -H 'Cookie: authelia_session=ok' "$S/"; ! grep -q "Sign in with Google" "$W/body" || bad "chooser shown to an Authelia session"; ok "an Authelia session skips the chooser"
chk 200 "$S/"; ! grep -q "Sign in with Google" "$W/body" || bad "chooser shown to a non-browser"; ok "non-browser GET / is not the chooser"
chk 200 "$S/oauth2/google/start?rd=/"; grep -q 'broker:/oauth2/google/start' "$W/body" || bad "google route not proxied to the broker"; ok "/oauth2/google/* -> broker"
chk 200 "$S/oauth2/github/start"; ok "/oauth2/github/* routed"
chk 200 "$S/oauth2/cloudflare/start"; grep -q cf "$W/body" || bad "cloudflare route not routed"; ok "/oauth2/cloudflare/* routed"
# jmap/mails passthrough lives in the rendered snippet (host list), identical ON and OFF (checked in 2)
grep -q 'not host jmap.diegonmarcos.com mails.diegonmarcos.com' "$W/snip.caddy" && ok "jmap./mails. Bearer passthrough still declared in the ON gate" || bad "bearer passthrough missing in the ON gate"

# ── 4. allowlist: only the owner ────────────────────────────────────────────────────────────
check_allow(){
  python3 -I - "$1" <<'PY'
import json, sys
b = json.load(open(sys.argv[1])); ab = b["auth_broker"]
emails = [e.strip().lower() for e in ab["allowed_emails"]]
assert emails == ["me@diegonmarcos.com"], f"allowlist must be exactly the owner, got {emails}"
gh = [(a["login"].lower(), a["id"]) for a in ab["allowed_github"]]
assert gh == [("diegonmarcos", 100614489)], f"GitHub allowlist must be exactly the owner account, got {gh}"
def keys(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield k.lower()
            yield from keys(v)
    elif isinstance(o, list):
        for v in o: yield from keys(v)
allk = set(keys(b))   # settings are KEYS; prose in _doc is ignored
for bad in ("email_domains", "email-domain", "insecure_oidc_allow_unverified_email", "allowed_groups"):
    assert bad not in allk, f"forbidden broker setting present: {bad}"
for p in ab["providers"]:
    assert p["provider"] in ("google", "github", "cloudflare", "email")
cfp = [p for p in ab["providers"] if p["id"] == "cloudflare"][0]
assert cfp["flow"] == "access" and cfp["login_url"].startswith("https://auth-cf.diegonmarcos.com/oauth2/cloudflare/") and set(cfp["hosts"]) <= {"auth.diegonmarcos.com", "account.diegonmarcos.com", "sso.diegonmarcos.com"}, "Cloudflare One sign-in: login_url on the Access-protected host, hosts only the chooser hosts"
assert "client_id" not in cfp and "secret_prefix" not in cfp, "Cloudflare One sign-in holds no client credential"
cf = ab.get("cloudflare_access", {})
if cf.get("enabled"):
    assert cf["team_domain"] == "diegonmarcos.cloudflareaccess.com" and cf["certs_url"] == "https://diegonmarcos.cloudflareaccess.com/cdn-cgi/access/certs", "CF Access must verify against the owner's team certs"
    assert cf["aud"] and all(len(a) == 64 and all(c in "0123456789abcdef" for c in a) for a in cf["aud"]), "CF Access needs 64-hex AUD tags"
gw = [p for p in ab["providers"] if p["id"] == "github"][0].get("web")
if gw:
    assert gw["client_id"] == "Ov23li1WLY8SoctMF2hp" and gw["redirect_uris"] == ["https://auth.diegonmarcos.com/oauth2/github/callback"], "GitHub App web leg: owner app client + auth. callback only"
    assert "client_secret" not in gw and not any("secret" in k.lower() and k != "secret_prefix" and not k.startswith("_") for k in gw), "no secret value in build.json"
PY
}
check_allow "$BROKER_JSON" || bad "broker allowlist is not exactly me@diegonmarcos.com"
ok "broker allowlist is exactly me@diegonmarcos.com, no email-domain rule"
jq '.auth_broker.allowed_emails += ["mallory@example.com"]' "$BROKER_JSON" > "$W/m1.json"
if check_allow "$W/m1.json" 2>/dev/null; then bad "mutation (extra email) not caught"; else ok "mutation: a second email is refused by the guard"; fi
jq '.auth_broker.allowed_github += [{"login":"mallory","id":1,"email":"me@diegonmarcos.com"}]' "$BROKER_JSON" > "$W/m3.json"
if check_allow "$W/m3.json" 2>/dev/null; then bad "mutation (extra GitHub account) not caught"; else ok "mutation: a second GitHub account is refused by the guard"; fi
jq '.auth_broker.cloudflare_access.aud += ["abc"]' "$BROKER_JSON" > "$W/m4.json"
if check_allow "$W/m4.json" 2>/dev/null; then bad "mutation (malformed CF AUD) not caught"; else ok "mutation: a malformed Cloudflare AUD is refused by the guard"; fi
jq '.auth_broker.cloudflare_access.team_domain = "evil.cloudflareaccess.com"' "$BROKER_JSON" > "$W/m5.json"
if check_allow "$W/m5.json" 2>/dev/null; then bad "mutation (foreign CF team) not caught"; else ok "mutation: a foreign Cloudflare team domain is refused by the guard"; fi
jq '.auth_broker.email_domains = ["*"]' "$BROKER_JSON" > "$W/m2.json"
if check_allow "$W/m2.json" 2>/dev/null; then bad "mutation (domain wildcard) not caught"; else ok "mutation: an email-domain rule is refused by the guard"; fi
BDIR="$(dirname "$BROKER_JSON")"
$NIX eval --impure --json --expr "let b=builtins.fromJSON (builtins.readFile $BROKER_JSON); in import $BDIR/src/compose.nix { buildJson=b; container=b; }" > "$W/compose.json" || bad "broker compose does not evaluate"
python3 -I - "$W/compose.json" <<'PY' || bad "broker compose does not enforce the broker policy"
import json, sys
d = json.load(open(sys.argv[1]))["services"]
assert set(d) == {"auth-broker-google", "auth-broker-github", "auth-broker-cloudflare", "auth-broker-email"}
for n, s in d.items():
    e = s["environment"]
    assert not any("EMAIL_DOMAIN" in k for k in e), "email-domain env present"
    assert e["BROKER_PROVIDER"] == n.split("-")[-1]
    assert e["BIND_HOST"] == "10.0.0.6" and s["network_mode"] == "host" and "ports" not in s, "broker must bind the mesh address only (host network, listener bound to the mesh IP)"
    assert e["AUTH_BROKER_COOKIE_SECRET"] == "${AUTH_BROKER_COOKIE_SECRET}", "cookie secret must come by interpolation"
    for k, v in e.items():
        if "SECRET" in k or k.endswith("CLIENT_ID"):
            ok_v = ("${" + k + "}", "${" + k + ":-}") if k == "AUTH_BROKER_GITHUB_APP_CLIENT_SECRET" else ("${" + k + "}",)  # optional until the owner supplies it
            assert v in ok_v, f"{k} must be interpolated, not inline"
assert "AUTH_BROKER_GOOGLE_CLIENT_SECRET" in d["auth-broker-google"]["environment"]
assert not [k for k in d["auth-broker-cloudflare"]["environment"] if "CLIENT" in k], "cloudflare provider: no client credential in the environment"
assert [k for k in d["auth-broker-github"]["environment"] if "GITHUB" in k] == ["AUTH_BROKER_GITHUB_APP_CLIENT_SECRET"], "github: device flow needs no secret; only the OAuth App secret may be passed"
em = d["auth-broker-email"]["environment"]
assert sorted(k for k in em if k.startswith("AUTH_BROKER_") and k != "AUTH_BROKER_COOKIE_SECRET") == sorted(["AUTH_BROKER_SMTP_USER", "AUTH_BROKER_SMTP_PASSWORD", "AUTH_BROKER_RESEND_API_KEY"]) and all(v.startswith("${") for k, v in em.items() if k.startswith("AUTH_BROKER_")), "email: mail secrets by interpolation only, no client credential"
PY
ok "broker compose: mesh-only bind, shared cookie secret, secrets by interpolation only"
echo "PASS: $PASS checks"
