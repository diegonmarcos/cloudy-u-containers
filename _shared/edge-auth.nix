# ══════════════════════════════════════════════════════════════════
# edge-auth.nix — the ONE shared public-edge auth gate, rendered into BOTH
# Caddyfiles (hub: infra-sec_caddy, edge: infra-sec_caddy-public).
#
# Policy (owner, 2026-10-16) lives in build.json caddy_config.edge_auth and is
# carried by the derive into build-caddy.json / build-caddy-edge.json:
#   a) private          — mesh only (wg_only / *.app): 403 to every non-mesh source
#   b) public-protected — DEFAULT for anything public: `import edge_auth`
#   c) public-open      — ONLY hosts listed in edge_auth.public_open (each with a reason)
# The CI guard (cloud-infra 9_others/test/edge-auth-gate.test.sh) renders both
# Caddyfiles' dist and fails on a site that is in no tier or in two.
#
# Two flavours of the same snippet:
#   edge_auth          — enforced for every source           (public hosts)
#   edge_auth_offmesh  — enforced only for NON-mesh sources  (hosts whose mesh
#                        clients are already trusted by the WG gate: mcp.,
#                        and wg_only vhosts that deliberately expose a few paths
#                        off-mesh, e.g. JMAP discovery)
# ══════════════════════════════════════════════════════════════════
{ lib
, edgeAuth ? {}            # caddy_config.edge_auth from the build json
, auth                     # caddy_config.auth (uris + copy_headers)
, autheliaUpstream         # forward_auth target for the session branch
, introspectUpstream       # forward_auth target for the bearer branch
, wgCidrs                  # mesh source CIDRs (space separated)
# #1896 authenticated rate limit, opt-in (null = off: the gate renders byte-identical, which is what
# the edge Caddyfile (infra-sec_caddy-public) gets). Set by the hub from build.json security_snippets:
#   { route = "<named route invoked after auth>"; denied = { zone; key; events; window; }; }
, rateLimit ? null
}:
# Fail closed AND loud: a build json without the policy block (e.g. the derive
# ran from a checkout that predates it) must break the render. Rendering with an
# empty list would gate auth. with its own gate -- a login lockout.
assert (edgeAuth.public_open or []) != [] ||
  throw "edge_auth.public_open missing from the build json: refusing to render a Caddyfile without the declared tier list (infra-sec_caddy/build.json caddy_config.edge_auth)";
let
  tpl = builtins.readFile ./edge-auth.caddy.tpl;
  subst = subs: text: lib.replaceStrings (lib.attrNames subs) (lib.attrValues subs) text;

  note = name: offmesh: ws:
    if ws then "  # ${name}: enforced for every source EXCEPT `Upgrade: websocket` requests (wstunnel on vpn.)."
    else if offmesh then "  # ${name}: same gate, enforced only against NON-mesh sources (mesh peers are trusted by the WG gate)."
    else "  # ${name}: enforced for every source.";

  # ── multi-SSO (edge_auth.multi_sso) ── Google/GitHub sign-in through the auth
  # broker (device-flow broker) beside Authelia. ONE flag: `enabled`. With it false (or the
  # block absent) EVERY value below is the empty string, so the rendered gate is
  # byte-identical to the pre-multi-SSO text (guard: infra-sec_caddy/src/test/
  # test-multi-sso.sh). With it true the gate gains a third branch:
  #   Cookie carries the broker cookie AND no Authelia session cookie -> forward_auth
  #   to the broker's /auth; everything else keeps the existing Authelia branch.
  # Bearer branches are untouched (a Bearer never reaches the session matchers).
  ms        = edgeAuth.multi_sso or {};
  msOn      = ms.enabled or false;
  msCookie  = ms.cookie_name or "_diego_sso";
  msAuthCk  = ms.authelia_cookie or "authelia_session";
  msProvs   = ms.providers or [];
  msAuthProv = lib.head msProvs;
  # Cloudflare Access JWT (edge_auth.multi_sso.cloudflare_access): third credential, verified by the broker.
  cfa       = ms.cloudflare_access or {};
  cfOn      = msOn && (cfa.enabled or false);
  cfHeader  = cfa.header or "Cf-Access-Jwt-Assertion";
  msNot = if !msOn then "" else
    "      not {\n        header Cookie *${msCookie}=*\n        not header Cookie *${msAuthCk}=*\n      }\n"
    + (if cfOn then "      not {\n        header ${cfHeader} *\n        not header Cookie *${msAuthCk}=*\n      }\n" else "");
  msBlock = name: offmesh: ws: if !msOn then "" else
    let extra = (if ws then "\n      not header Upgrade websocket" else "")
              + (if offmesh then "\n      not remote_ip ${wgCidrs}" else "");
    in ''

    @ea_broker {
      header Cookie *${msCookie}=*
      not header Cookie *${msAuthCk}=*
      not header Authorization Bearer*
      not header X-Fleet-Authorization Bearer*
      not path {args[:]}
      not {
        method OPTIONS
        header Access-Control-Request-Method *
      }${extra}
    }
    # Broker session (Google / GitHub, allowlisted to the owner by the broker itself).
    forward_auth @ea_broker ${msAuthProv.upstream} {
      header_up -Connection
      header_up -Upgrade
      uri ${msAuthProv.prefix}/auth
      copy_headers X-Auth-Request-Email${rlDeny}
    }'' + (if !cfOn then "" else ''

    # Order of the chain: Authelia session, else broker cookie (above), else Cloudflare Access JWT.
    # The JWT is verified by the broker (signature, issuer, audience, expiry, owner email only).
    @ea_cfaccess {
      header ${cfHeader} *
      not header Cookie *${msAuthCk}=*
      not header Cookie *${msCookie}=*
      not header Authorization Bearer*
      not header X-Fleet-Authorization Bearer*
      not path {args[:]}
      not {
        method OPTIONS
        header Access-Control-Request-Method *
      }${extra}
    }
    forward_auth @ea_cfaccess ${msAuthProv.upstream} {
      header_up -Connection
      header_up -Upgrade
      uri ${msAuthProv.prefix}/cf-auth
      copy_headers X-Auth-Request-Email${rlDeny}
    }'');

  # ── #1896 authenticated rate limit (opt-in: rateLimit) ──
  # Anonymous traffic keeps the per-IP zones of the security snippets. A request that carries a
  # credential is marked (vars ea_cred) by the branch matcher it hits, which takes it out of the
  # strict per-IP zone (`match { not vars ea_cred 1 }` there), and then:
  #   - the auth service refuses it (any 3xx/4xx/5xx from forward_auth): the refusal is counted in
  #     the strict per-IP zone `denied` (handle_response below), so a fake or expired credential
  #     gets no more than the anonymous allowance;
  #   - it passes: `invoke` (Caddy sorts it AFTER forward_auth and before handle) runs the hub's
  #     named route, whose zones are keyed on the identity headers the auth service copied back,
  #     never on the credential itself.
  # The Authelia branch is split so a request with NO credential keeps the untouched plain branch:
  # only a request that carries the session cookie takes @ea_session_ck (same Authelia call).
  rlOn = rateLimit != null;
  # Lines are built explicitly (not '' strings, whose indentation stripping would flatten them).
  rlLines = ind: ls: lib.concatMapStrings (l: "\n" + ind + l) ls;
  rlDeny = if !rlOn then "" else let d = rateLimit.denied; in rlLines "      " [
    "# #1896: a credential the auth service refuses counts in the strict per-IP zone."
    "@ea_denied status 3xx 4xx 5xx"
    "handle_response @ea_denied {"
    "  rate_limit {"
    "    zone ${d.zone} {"
    "      key    ${d.key}"
    "      events ${toString d.events}"
    "      window ${d.window}"
    "    }"
    "  }"
    "  copy_response_headers"
    "  copy_response"
    "}"
  ];
  rlSessionNot = if !rlOn then "" else "      not header Cookie *${msAuthCk}=*\n";
  # No blank line inside the gate: test-multi-sso.sh cuts the snippet at the first `}` + blank line.
  rlBlock = offmesh: ws: if !rlOn then "" else rlLines "    " ([
    "# #1896: a request carrying the Authelia session cookie (and no Bearer): the same Authelia call"
    "# as @ea_session, but a refused cookie is counted (ea_denied)."
    "@ea_session_ck {"
    "  header Cookie *${msAuthCk}=*"
    "  not header Authorization Bearer*"
    "  not header X-Fleet-Authorization Bearer*"
    "  not path {args[:]}"
    "  not {"
    "    method OPTIONS"
    "    header Access-Control-Request-Method *"
    "  }"
  ] ++ lib.optional ws "  not header Upgrade websocket"
    ++ lib.optional offmesh "  not remote_ip ${wgCidrs}"
    ++ [
    "}"
    "forward_auth @ea_session_ck ${autheliaUpstream} {"
    "  # A websocket upgrade must not reach the auth subrequest: an introspect/authelia"
    "  # backend that gets Connection: Upgrade never answers and the edge hangs."
    "  header_up -Connection"
    "  header_up -Upgrade"
    "  uri ${auth.authelia_uri or "/api/authz/forward-auth"}"
    "  header_up X-Forwarded-Uri {http.request.orig_uri}"
    ("  copy_headers ${lib.concatStringsSep " " (auth.authelia_copy or [ "Remote-User" ])}" + rlDeny)
    "}"
    "# #1896: mark every credential branch (vars sorts before rate_limit and forward_auth). A marked"
    "# request that reaches `invoke` (sorted after forward_auth) passed its forward_auth, so the named"
    "# route only ever sees authenticated requests."
    "vars @ea_fleet ea_cred 1"
    "vars @ea_bearer ea_cred 1"
    "vars @ea_session_ck ea_cred 1"
  ] ++ lib.optional msOn "vars @ea_broker ea_cred 1"
    ++ lib.optional cfOn "vars @ea_cfaccess ea_cred 1"
    ++ [
    "@ea_authed vars ea_cred 1"
    "invoke @ea_authed ${rateLimit.route}"
  ]);

  mk = name: offmesh: ws: note name offmesh ws + "\n" + lib.removeSuffix "\n" (subst {
    "@GATE@"                = name;
    # edge_auth.bearer_passthrough: on these hosts the edge does NOT introspect
    # `Authorization: Bearer` (@ea_bearer never matches, and @ea_session already
    # excludes Bearer), so the upstream validates it. No Authorization at all still
    # reaches the Authelia branch and is refused.
    "@EA_PASS@"             = if passHosts == [] then "" else "      not host ${lib.concatStringsSep " " passHosts}\n";
    "@EA_OFFMESH@"          = if offmesh then "\n      not remote_ip ${wgCidrs}" else "";
    # WebSocket-upgrade exemption (wstunnel on vpn.): the client cannot do a
    # bearer/cookie handshake; the server enforces its own secret path prefix.
    "@EA_EXTRA@"            = if ws then "\n      not header Upgrade websocket" else "";
    "@INTROSPECT_UPSTREAM@" = introspectUpstream;
    "@INTROSPECT_URI@"      = auth.introspect_uri or "/auth";
    "@INTROSPECT_COPY@"     = lib.concatStringsSep " " (auth.introspect_copy or [ "X-Auth-User" ]);
    "@AUTHELIA_UPSTREAM@"   = autheliaUpstream;
    "@AUTHELIA_URI@"        = auth.authelia_uri or "/api/authz/forward-auth";
    "@AUTHELIA_COPY@"       = lib.concatStringsSep " " (auth.authelia_copy or [ "Remote-User" ]);
    "@EA_SSO_NOT@"          = msNot;
    "@EA_SSO_BLOCK@"        = msBlock name offmesh ws;
    "@EA_DENY@"             = rlDeny;
    "@EA_RL_SESSION_NOT@"   = rlSessionNot;
    "@EA_RL@"               = rlBlock offmesh ws;
  } tpl);

  entries   = edgeAuth.public_open or [];
  openHosts = map (e: e.host) (lib.filter (e: (e.scope or "host") == "host") entries)
              ++ (if msOn then (ms.hosts or []) else []);   # multi-SSO sign-in hosts are the IdP vhost
  hostsOf = domain: map (s: builtins.head (lib.splitString "/" s)) (lib.splitString ", " domain);
  # Always exempt on every host (owner-approved tier c): ACME http-01.
  acmePath = "/.well-known/acme-challenge/*";
  pathsOf = host: lib.concatMap (e: e.paths or []) (lib.filter (e: (e.scope or "") == "paths" && e.host == host) entries);
  # TEMPORARY, explicit, reported by the guard on every run: hosts whose gate is
  # held back until their client can authenticate (edge_auth.held). Remove the
  # entry to gate them.
  heldHosts = map (e: e.host) (edgeAuth.held or []);
  passHosts = map (e: e.host) (edgeAuth.bearer_passthrough or []);
  wsHosts = map (e: e.host) (lib.filter (e: (e.scope or "") == "websocket") entries);
  argsFor = domain: lib.concatStringsSep " " ([ acmePath ] ++ lib.concatMap pathsOf (hostsOf domain));
in rec {
  inherit openHosts;

  # What the auth vhost needs when multi-SSO is on (consumed by caddyfile.nix on the
  # hub and caddyfile-public.nix on the edge). Everything is empty/false when off.
  multiSso = {
    enabled     = msOn;
    primaryHost = ms.primary_host or "";
    extraHosts  = lib.filter (h: h != (ms.primary_host or "")) (ms.hosts or []);
    providers   = msProvs;
    cookie      = msCookie;
    autheliaCookie = msAuthCk;
  };

  # The two (snippet) definitions, emitted once per Caddyfile.
  snippets = ''
  # (edge_auth) -- the ONE public-edge auth gate (cloud-u-containers _shared/edge-auth.*).
  # Owner rule 2026-10-16: PUBLIC URL = fleet Bearer OR Authelia session cookie.
  #   - `Authorization: Bearer ...` -> introspect-proxy (the same door the MCP routes
  #     use); an invalid token gets the introspector's own 401/403.
  #   - `X-Fleet-Authorization: Bearer ...` -> the same introspect-proxy (the token is
  #     moved into Authorization on the sub-request only); it wins over Authorization
  #     and is stripped before proxying, so a mailbox credential in `Authorization`
  #     (Stalwart Basic/Bearer on jmap./mails.) reaches the upstream untouched.
  #   - anything else -> Authelia forward-auth: a valid session cookie passes;
  #     otherwise Authelia answers 401 to API / non-browser clients and 302 to
  #     auth. (with rd=) to browsers. Nothing reaches an upstream anonymously.
  #   - Tier c (public_open in build.json caddy_config.edge_auth) is exempted by
  #     the PATH ARGS of the import: `import edge_auth <path>...` -- always
  #     /.well-known/acme-challenge/* plus that host's own declared paths.
  #   - CORS preflight (OPTIONS + Access-Control-Request-Method) cannot carry
  #     credentials: it is answered 204 right here and never proxied. Plain
  #     OPTIONS (WebDAV) is still gated.
  # forward_auth sorts before handle / respond / reverse_proxy, so importing this
  # at the top of a site gates every handle in it. `redir` sorts BEFORE
  # forward_auth: a site-level `redir` next to this import would run ungated, so
  # it must be wrapped in `handle { }` (the CI guard rejects a bare one).
${mk "edge_auth" false false}
${mk "edge_auth_offmesh" true false}
${mk "edge_auth_ws" false true}
'';

  # True when EVERY name of a (possibly "a, b"-joined) site address is declared public-open.
  isOpen = domain: let hs = hostsOf domain; in hs != [] && lib.all (h: builtins.elem h openHosts) hs;

  # The line a site block carries. Public-open hosts carry none (the guard checks
  # they are listed); everything else imports the gate.
  # `kind`: "all" (default flavour) or "offmesh". A host declared websocket-exempt
  # gets edge_auth_ws instead.
  gateKind = kind: domain:
    if isOpen domain || lib.any (h: builtins.elem h heldHosts) (hostsOf domain) then ""
    else let hs = hostsOf domain; isWs = lib.any (h: builtins.elem h wsHosts) hs;
         name = if isWs then "edge_auth_ws" else if kind == "offmesh" then "edge_auth_offmesh" else "edge_auth";
    in "import ${name} ${argsFor domain}";
  gate    = gateKind "all";
  gateOff = gateKind "offmesh";
}
