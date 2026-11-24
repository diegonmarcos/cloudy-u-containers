#!/usr/bin/env bash
# Guard (#1896): authenticated edge traffic gets its own, larger allowance; anonymous stays strict per IP.
# Source: build.json caddy_config.security_snippets (auth_rate_limit, auth_mcp_rate_limit, denied_rate_limit,
# backstop_rate_limit); renderer: src/caddyfile.nix + _shared/edge-auth.nix (opt-in `rateLimit`).
#
# Asserted on the Caddyfile rendered from build.json (and on the committed dist, unless ALLOW_STALE_DIST=1):
#   1. anonymous zones unchanged: global / mcp / jmap keep build.json's key/events/window, per IP, and only
#      skip requests the gate marked as carrying a credential (`not vars ea_cred 1`);
#   2. backstop: every security rate-limit snippet carries the per-IP backstop zone from build.json;
#   3. refused credentials stay strict: every credential forward_auth (fleet, bearer, session cookie, broker,
#      Cloudflare Access) in all 3 gate flavours counts a 3xx/4xx/5xx in the per-IP `denied` zone, while the
#      plain Authelia branch (no credential at all) has no handle_response and excludes the session cookie;
#   4. authenticated zones run AFTER forward_auth: they live only in the named route, reached only through
#      `invoke` (Caddy sorts invoke after forward_auth), behind the ea_cred marker; values from build.json;
#   5. no rate-limit key is the credential (Authorization / Cookie / X-Fleet-Authorization / CF JWT), no log_key;
#   6. switch: without auth_rate_limit the render carries none of it, and the ON render with the #1896
#      additions removed equals the OFF render (ON only adds); the edge Caddyfile (caddy-public) carries none.
# Mutation-proven: each mutation below must FAIL the checks, and so must the pre-#1896 (OFF) render.
# Needs: nix (eval only), jq, python3. Inputs: MULTI_SSO_JSON_DIR (cloud-infra 1_cloud-configs/dist).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/../../.." && pwd)"
CADDY_SRC="$SVC/infra-sec_caddy/src"; PUB_SRC="$SVC/infra-sec_caddy-public/src"
JDIR="${MULTI_SSO_JSON_DIR:-$SVC/../1_cloud-configs/dist}"
HUB_JSON="$JDIR/build-caddy.json"; EDGE_JSON="$JDIR/build-caddy-edge.json"
BJ="$SVC/infra-sec_caddy/build.json"
for f in "$HUB_JSON" "$EDGE_JSON" "$BJ"; do [ -f "$f" ] || { echo "FAIL: missing $f (set MULTI_SSO_JSON_DIR)"; exit 1; }; done
command -v jq >/dev/null && command -v nix >/dev/null && command -v python3 >/dev/null || { echo "FAIL: jq, nix and python3 are required"; exit 1; }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
NIX="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
if [ -n "${NIXPKGS_SRC:-}" ]; then LIBX="import $NIXPKGS_SRC/lib"
else LIBX="(builtins.getFlake \"github:NixOS/nixpkgs/nixos-24.11\").lib"; fi
render(){ # render <hub|edge> <json>
  if [ "$1" = hub ]; then
    $NIX eval --impure --raw --expr "let lib=($LIBX); caddyRoutes=builtins.fromJSON (builtins.readFile $2); in import $CADDY_SRC/caddyfile.nix { inherit lib caddyRoutes; }"
  else
    $NIX eval --impure --raw --expr "let lib=($LIBX); caddyPublic=builtins.fromJSON (builtins.readFile $2); in import $PUB_SRC/caddyfile-public.nix { inherit lib caddyPublic; }"
  fi
}
# build.json is the source: its security_snippets override whatever the derived json carries.
SS="$(jq -c '.caddy_config.security_snippets' "$BJ")"
[ "$(echo "$SS" | jq -r '.auth_rate_limit.events // empty')" != "" ] || { echo "FAIL: build.json security_snippets.auth_rate_limit missing (this guard pins the shipped ON state)"; exit 1; }
jq --argjson s "$SS" '.security_snippets=$s' "$HUB_JSON" > "$W/hub-on.json"
jq --argjson s "$SS" '.security_snippets=($s|del(.auth_rate_limit,.auth_mcp_rate_limit,.denied_rate_limit,.backstop_rate_limit,._doc_auth_rate_limit))' "$HUB_JSON" > "$W/hub-off.json"
jq --argjson s "$SS" '.security_snippets=$s' "$EDGE_JSON" > "$W/edge-on.json"
render hub "$W/hub-on.json" > "$W/on.txt"
render hub "$W/hub-off.json" > "$W/off.txt"
render edge "$W/edge-on.json" > "$W/edge.txt"
jq -c '.caddy_config.security_snippets' "$BJ" > "$W/ss.json"
jq -c '[.mcp_routes[]?.parent_domain]' "$W/hub-on.json" > "$W/mcp.json"

python3 -I - "$W" "$SVC" "${ALLOW_STALE_DIST:-0}" <<'PY'
import json, re, sys
W, SVC, allow_stale = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
ss = json.load(open(f"{W}/ss.json")); mcp_hosts = json.load(open(f"{W}/mcp.json"))
CRED = ("ea_fleet", "ea_bearer", "ea_session_ck", "ea_broker", "ea_cfaccess")
GATES = ("edge_auth", "edge_auth_offmesh", "edge_auth_ws")

def block(t, start):
    """Text from `start` (index of a line holding the opening brace) to its matching close brace."""
    k = t.index("{", start); d = 0
    for j in range(k, len(t)):
        d += (t[j] == "{") - (t[j] == "}")
        if d == 0: return t[start:j + 1]
    raise AssertionError("unbalanced braces")

def snippet(t, name):
    i = t.find(f"({name}) {{")
    assert i >= 0, f"snippet ({name}) missing"
    return block(t, i)

def zones(txt):
    out = {}
    for m in re.finditer(r"\bzone (\S+) \{", txt):
        b = block(txt, m.start())
        g = lambda f: (re.search(rf"\n\s*{f}\s+(\S+)", b) or [None, None])[1]
        out[m.group(1)] = {"key": g("key"), "events": g("events"), "window": g("window"), "body": b}
    return out

def want(z, r, label):
    assert z is not None, f"{label}: zone {r['zone']} missing"
    for f in ("key", "events", "window"):
        assert z[f] == str(r[f]), f"{label}: zone {r['zone']} {f} is {z[f]!r}, build.json says {r[f]!r}"

def fwd_blocks(t):
    return [(m.group(1), block(t, m.start())) for m in re.finditer(r"forward_auth @(\w+) \S+ \{", t)]

def check(t):
    # 1 + 2: anonymous zones unchanged (per IP, build.json values) and the backstop on every snippet
    for snip, key in (("rate_limiting", "rate_limit"), ("rate_limiting_mcp", "mcp_rate_limit"), ("rate_limiting_jmap", "jmap_rate_limit")):
        s = snippet(t, snip); z = zones(s); r = ss[key]
        want(z.get(r["zone"]), r, snip)
        assert z[r["zone"]]["key"] == "{remote_host}", f"{snip}: anonymous zone must stay per IP"
        assert re.search(r"match \{\s*not vars ea_cred 1\s*\}", z[r["zone"]]["body"]), f"{snip}: anonymous zone does not skip credentialed requests"
        b = ss["backstop_rate_limit"]; want(z.get(b["zone"]), b, f"{snip} backstop")
        assert "match" not in z[b["zone"]]["body"], f"{snip}: the backstop must apply to every request"
    # 3: refused credentials counted per IP; the no-credential branch untouched
    d = ss["denied_rate_limit"]
    assert d["key"] == "{remote_host}", "denied zone must be per IP"
    for g in GATES:
        s = snippet(t, g); fb = fwd_blocks(s); names = [n for n, _ in fb]
        for n in ("ea_fleet", "ea_bearer", "ea_session", "ea_session_ck"):
            assert n in names, f"{g}: forward_auth @{n} missing"
        for n, b in fb:
            if n in CRED:
                assert "@ea_denied status 3xx 4xx 5xx" in b and "handle_response @ea_denied" in b, f"{g}: @{n} does not count refusals"
                hz = zones(b); want(hz.get(d["zone"]), d, f"{g} @{n} denied")
                assert "copy_response_headers" in b and "copy_response\n" in b, f"{g}: @{n} refusal is not passed through"
            elif n == "ea_session":
                assert "handle_response" not in b and "rate_limit" not in b, f"{g}: the no-credential Authelia branch was changed"
            else:
                raise AssertionError(f"{g}: unexpected forward_auth @{n}")
        sm = block(s, s.index("@ea_session {"))
        assert "not header Cookie *authelia_session=*" in sm, f"{g}: @ea_session still takes session cookies (refusals would not be counted)"
        for n in names:
            if n in CRED:
                assert re.search(rf"\n\s*vars @{n} ea_cred 1\n", s), f"{g}: @{n} is not marked ea_cred"
        assert re.search(r"\n\s*vars @ea_session ea_cred", s) is None, f"{g}: the no-credential branch must not be marked"
        assert re.search(r"\n\s*@ea_authed vars ea_cred 1\n", s), f"{g}: @ea_authed matcher missing"
        assert re.search(r"\n\s*invoke @ea_authed edge_rl_authed\n", s), f"{g}: authenticated zones not invoked after forward_auth"
        # 4: nothing in the gate rate-limits outside a handle_response (a bare rate_limit sorts BEFORE forward_auth)
        top = s
        for _, b in fb: top = top.replace(b, "")
        assert not re.search(r"(?m)^\s*rate_limit\b", top), f"{g}: a rate_limit at gate level would run before forward_auth"
    # 4: the authenticated zones exist once, only inside the named route
    i = t.find("&(edge_rl_authed) {"); assert i >= 0, "named route edge_rl_authed missing"
    nr = block(t, i); z = zones(nr)
    a, am = ss["auth_rate_limit"], ss["auth_mcp_rate_limit"]
    want(z.get(a["zone"]), a, "authed"); want(z.get(am["zone"]), am, "authed_mcp")
    for r in (a, am):
        assert len(re.findall(rf"\bzone {re.escape(r['zone'])} \{{", t)) == 1, f"zone {r['zone']} must exist only in the named route"
    assert int(a["events"]) > int(ss["rate_limit"]["events"]) and int(am["events"]) > int(ss["mcp_rate_limit"]["events"]), "authenticated allowance must exceed the anonymous one"
    hosts = " ".join(mcp_hosts); assert hosts, "no MCP hosts"
    assert f"not host {hosts}" in z[a["zone"]]["body"] and f"not path_regexp {am['path_regexp']}" in z[a["zone"]]["body"], "authed zone must exclude MCP traffic"
    assert f"host {hosts}" in z[am["zone"]]["body"] and f"path_regexp {am['path_regexp']}" in z[am["zone"]]["body"], "authed_mcp zone must match MCP hosts and paths"
    assert t.count("invoke @ea_authed edge_rl_authed") == 3 and t.count("edge_rl_authed") == 4, "edge_rl_authed must be reached only via the 3 gate invokes"
    # 5: no key is (or contains) the credential; keys never logged
    for k in re.findall(r"\n\s*key\s+(\S+)", "\n".join(block(t, m.start()) for m in re.finditer(r"rate_limit \{", t))):
        assert not re.search(r"(?i)authorization|cookie|cf-access|jwt", k), f"rate-limit key uses the credential: {k}"
    assert "log_key" not in t, "rate-limit keys must never be logged"
    return True

def fails(t):
    try: check(t)
    except AssertionError as e: return str(e)
    return None

on = open(f"{W}/on.txt").read(); off = open(f"{W}/off.txt").read(); edge = open(f"{W}/edge.txt").read()
check(on); print("ok: rendered (build.json) Caddyfile passes checks 1-5")
d = open(f"{SVC}/infra-sec_caddy/dist/configs/Caddyfile").read()
first = on.split("\n", 1)[0]; i = d.find("\n" + first + "\n")
if allow_stale:
    print("skip: committed dist comparison (ALLOW_STALE_DIST=1)")
else:
    assert i >= 0 and d[i + 1:] == on, "committed dist differs from the render of build.json (stale dist: re-render with render-dist)"
    print("ok: committed dist equals the render of build.json")
# 6. switch: OFF carries nothing; ON only adds; the edge carries nothing
MARK = ("ea_cred", "@ea_denied", "edge_rl_authed", "zone backstop", "@ea_session_ck", "#1896")
for label, txt in (("OFF render", off), ("caddy-public render", edge),
                   ("caddy-public dist", open(f"{SVC}/infra-sec_caddy-public/dist/configs/Caddyfile").read())):
    bad = [m for m in MARK if m in txt]; assert not bad, f"{label} carries #1896 text: {bad}"
print("ok: OFF render and caddy-public carry none of it")
s = on
s = re.sub(r"\n\s*# #1896: a credential the auth service refuses[^\n]*\n\s*@ea_denied status[^\n]*\n\s*handle_response @ea_denied \{.*?\n\s*copy_response\n\s*\}", "", s, flags=re.S)
s = re.sub(r"\n\s*# #1896: a request carrying the Authelia session cookie.*?\n\s*invoke @ea_authed edge_rl_authed", "", s, flags=re.S)
s = re.sub(r"\n\n  # #1896: authenticated requests.*?\n  &\(edge_rl_authed\) \{.*?\n  \}(?=\n)", "", s, count=1, flags=re.S)
s = re.sub(r"\n        match \{\n          not vars ea_cred 1\n        \}", "", s)
s = re.sub(r"\n      zone backstop \{\n(?:        [^\n]*\n){3}      \}", "", s)
s = s.replace("      not header Cookie *authelia_session=*\n      not path {args[:]}", "      not path {args[:]}")
assert s == off, "ON render minus the #1896 additions differs from the OFF render (something else changed)"
print("ok: ON only adds (ON minus the additions == OFF)")
# Red on the old render, and mutation proof
r = fails(off); assert r, "the pre-#1896 (OFF) render passes the checks: the guard verifies nothing"
print(f"ok: pre-#1896 render is red ({r})")
def nth(t, old, new, n=1):
    assert t.count(old) >= n, f"mutation anchor missing: {old!r}"
    parts = t.split(old); return old.join(parts[:n]) + new + old.join(parts[n:])
bear = re.search(r"forward_auth @ea_bearer \S+ \{", on).group(0)
fb = block(on, on.index(bear)); fb_cut = re.sub(r"\n\s*# #1896: a credential.*?\n\s*copy_response\n\s*\}", "", fb, flags=re.S)
sess = block(on, on.index(re.search(r"forward_auth @ea_session \S+ \{", on).group(0)))
muts = {
    "backstop dropped": re.sub(r"\n      zone backstop \{\n(?:        [^\n]*\n){3}      \}", "", on, count=1),
    "authed key = raw Authorization": on.replace("key    " + ss["auth_rate_limit"]["key"], "key    {http.request.header.Authorization}", 1),
    "bearer refusal not counted": on.replace(fb, fb_cut, 1),
    "authed zone before forward_auth": nth(on, "    invoke @ea_authed edge_rl_authed\n", "    rate_limit {\n      zone authed2 {\n        key    {remote_host}\n        events 1000\n        window 1m\n      }\n    }\n    invoke @ea_authed edge_rl_authed\n"),
    "anonymous limit raised": nth(on, "zone global {\n        key    {remote_host}\n        events 100", "zone global {\n        key    {remote_host}\n        events 1000"),
    "anonymous branch touched": on.replace(sess, sess[:-1] + "  @ea_denied status 4xx\n      handle_response @ea_denied {\n        copy_response\n      }\n    }", 1),
    "authed events not from build.json": nth(on, "events " + str(ss["auth_rate_limit"]["events"]) + "\n", "events 999\n"),
    "anonymous zone counts credentialed": nth(on, "\n        match {\n          not vars ea_cred 1\n        }", ""),
    "invoke missing": nth(on, "    invoke @ea_authed edge_rl_authed\n", ""),
    "key logged": nth(on, "    rate_limit {\n      zone global", "    rate_limit {\n      log_key\n      zone global"),
}
for name, m in muts.items():
    assert m != on, f"mutation {name!r} did not change the text"
    r = fails(m); assert r, f"mutation {name!r} passes the checks: the guard verifies nothing"
    print(f"ok: mutation '{name}' is caught ({r})")
print("ok: authed rate limit guard (#1896)")
PY
