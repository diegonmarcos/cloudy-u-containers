# ══════════════════════════════════════════════════════════════════
# re-ship marker (#1104/#1102): earlier caddy deploys were stranded by a transient scp drop, then by stale committed dist (render mismatch); dist re-rendered
# caddyfile-public.nix — public-edge L7 allowlist generator
#
# Renders the Caddyfile for the caddy-public service on oci-analytics.
# DATA-DRIVEN: reads build-caddy-public.json (symlink → 1_cicd/dist/)
# and emits ONLY the declared-public allowlist at the edge; EVERYTHING
# else forwards to gcp-proxy over wg-public (private_forward_upstream).
#
# Pure-syntax fragments live as `.caddy.tpl` files in `./snippets/`;
# this file only does orchestration: read → substitute @PLACEHOLDER@ →
# assemble — mirroring infra-sec_caddy/src/caddyfile.nix.
#
# Fail-closed posture (security invariant):
#   · ONLY auth=="none" subdomains, gh-pages, well-known, and explicitly
#     declared `public_paths` are served with a REAL upstream at the edge.
#   · base_path itself, authed subdomains, wg_only routes, and any host or
#     path not explicitly handled → forwarded to gcp-proxy, whose @wg gate
#     (remote_ip 10.0.0.0/24) 403s the public client. NEVER served here.
#   · EVERY forward/fallback target == caddyPublic.private_forward_upstream
#     (10.1.0.2:443). NEVER a wg0 (10.0.0.x) address for the fallback.
# ══════════════════════════════════════════════════════════════════
{ lib, caddyPublic }:

let
  # ── Snippet loader: read .caddy.tpl + apply @KEY@ substitutions ──
  readTpl = name: builtins.readFile (./snippets + "/${name}");
  subst = subs: text:
    lib.replaceStrings (lib.attrNames subs) (lib.attrValues subs) text;
  stripTrail = s: lib.removeSuffix "\n" s;

  # ── Critical fail-closed target: gcp-proxy over wg-public ──
  privateUpstream = caddyPublic.private_forward_upstream;

  # Forward helper — every non-allowlisted host/path lands here.
  fwd = "reverse_proxy ${privateUpstream}";

  # Real-client IP carry-over for any reverse_proxy that serves a real
  # upstream at the edge (mirrors caddyfile.nix's header_up usage).
  xreal = "header_up X-Real-IP {http.request.remote.host}";

  # ── Security snippets (data-driven from caddyPublic.security_snippets) ──
  ss = caddyPublic.security_snippets or {};

  securityHeaders = let h = ss.security_headers; in
    subst {
      "@HSTS_MAX_AGE@"       = toString h.hsts_max_age;
      "@FRAME_OPTIONS@"      = h.frame_options;
      "@REFERRER_POLICY@"    = h.referrer_policy;
      "@PERMISSIONS_POLICY@" = h.permissions_policy;
      "@CORS_ORIGIN@"        = h.cors_origin;
      "@CORS_METHODS@"       = h.cors_methods;
      "@CORS_HEADERS@"       = h.cors_headers;
      "@HIDE_HEADERS@"       = lib.concatMapStringsSep "\n        " (x: "-${x}") (h.hide_headers or []);
    } (readTpl "10-security-headers.caddy.tpl");

  rateLimiting = let r = ss.rate_limit; in
    subst {
      "@RL_ZONE@"   = r.zone;
      "@RL_KEY@"    = r.key;
      "@RL_EVENTS@" = toString r.events;
      "@RL_WINDOW@" = r.window;
      "@RL_STATIC_ZONE@"   = r.static_zone or "static";
      "@RL_STATIC_EVENTS@" = toString (r.static_events or 3000);
      "@RL_STATIC_WINDOW@" = r.static_window or "1m";
      "@RL_STATIC_RE@"     = r.static_path_regexp or ''(?i)\.(svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|json|webmanifest|mp4|webm)$'';
    } (readTpl "11-rate-limiting.caddy.tpl");

  blockBots = let uas = lib.concatStringsSep "|" ss.bot_blocker.user_agents; in
    subst { "@BOT_UAS@" = uas; } (readTpl "12-block-bots.caddy.tpl");

  blockScanners = let paths = lib.concatStringsSep " " ss.scanner_blocker.paths; in
    subst { "@SCANNER_PATHS@" = paths; } (readTpl "13-block-scanners.caddy.tpl");

  requestLimits = let r = ss.request_limits; in
    subst { "@REQ_MAX_BODY@" = r.max_body; } (readTpl "14-request-limits.caddy.tpl");

  ipBlock = let
    cidrs = ss.ip_block.cidrs or [];
    body = if cidrs == []
      then "# no blocked CIDRs"
      else ''@blocked_ips remote_ip ${lib.concatStringsSep " " cidrs}
    respond @blocked_ips 403'';
  in subst { "@IP_BLOCK_BODY@" = body; } (readTpl "15-ip-block.caddy.tpl");

  accessLog = let a = ss.access_log; in
    subst {
      "@LOG_PATH@"      = a.path;
      "@LOG_ROLL_SIZE@" = a.roll_size;
      "@LOG_ROLL_KEEP@" = toString a.roll_keep;
      "@LOG_FORMAT@"    = a.format;
    } (readTpl "16-access-log.caddy.tpl");

  securitySnippet = readTpl "17-security-snippet.caddy.tpl";

  # `sec` imported inline at the top of every served site block.
  sec = ''  import security'';

  # ── Geo-fence (#1102): _shared/geo-fence.json is the one declaration. Every site is fenced
  # unless ALL its names are declared in global_hosts (static pages, protocol endpoints).
  geoCfg = builtins.fromJSON (builtins.readFile ../../_shared/geo-fence.json);
  geoFenceSnippet = subst {
    "@GEO_EXEMPT@" = lib.concatStringsSep " " geoCfg.exempt_cidrs;
    "@GEO_DB@"     = geoCfg.db.file;
    "@GEO_ALLOW@"  = lib.concatStringsSep " " geoCfg.allowed_countries;
  } (readTpl "18-geo-fence.caddy.tpl");
  geoHosts = domain: map (x: builtins.head (lib.splitString "/" x)) (lib.splitString ", " domain);
  geo = domain:
    if lib.all (h: builtins.hasAttr h geoCfg.global_hosts) (geoHosts domain) then ""
    else "  import geo_fence";

  # ── Bearer introspection (MCP bearer tier) — same 21-bearer snippet the hub
  # renders, pointed at the same introspection upstream over the mesh. Needed
  # here because bearer-gated MCP endpoints terminate at THIS edge: a public
  # client can only ever present its token where its TLS ends, and that is
  # never gcp-proxy. wgCidrs mirrors caddyfile.nix's binding for the @wg
  # parity branch in mkMcpRouteGroup below.
  auth = caddyPublic.auth or {};
  introspectUpstream = (caddyPublic.auth_upstreams or {}).introspect_proxy or "10.0.0.1:4182";
  bearer = stripTrail (subst {
    "@INTROSPECT_UPSTREAM@" = introspectUpstream;
    "@INTROSPECT_URI@"      = auth.introspect_uri or "/auth";
    "@INTROSPECT_COPY@"     = lib.concatStringsSep " " (auth.introspect_copy or [ "X-Auth-User" ]);
  } (readTpl "21-bearer.caddy.tpl"));
  wgCidrs = (caddyPublic.global or {}).wg_cidrs or "10.0.0.0/24 fd0c:1d00::/64";

  # ── Shared public-edge auth gate (owner rule 2026-10-16) ──
  # The SAME definition the hub renders (_shared/edge-auth.nix). Every site below
  # carries `ea.gate <domain>` unless the host is declared public_open in
  # build.json caddy_config.edge_auth. Bearer branch = the introspect-proxy over
  # the mesh (as for the MCP routes). Session branch = Authelia's published port
  # on the hub's wg0 address (auth_upstreams.authelia_mesh) -- NOT the hub's auth
  # vhost, whose reverse_proxy would overwrite the X-Forwarded-Host/-Uri that
  # tell Authelia which site is being gated.
  ea = import ../../_shared/edge-auth.nix {
    inherit lib auth wgCidrs introspectUpstream;
    edgeAuth = caddyPublic.edge_auth or {};
    autheliaUpstream = (caddyPublic.auth_upstreams or {}).authelia_mesh or "10.0.0.1:9091";
  };

  # MCP OAuth AS routes on the public MCP hub (WIP option 31.1,
  # _shared/mcp-oauth.nix). Same renderer and data as the hub; the AS upstream
  # and Authelia are both dialled over the mesh. Inert while
  # build-caddy-edge.json carries no `mcp_oauth` block.
  mo = import ../../_shared/mcp-oauth.nix {
    inherit lib auth;
    cfg = caddyPublic.mcp_oauth or null;
    edgeAuth = caddyPublic.edge_auth or {};
    autheliaUpstream = (caddyPublic.auth_upstreams or {}).authelia_mesh or "10.0.0.1:9091";
  };

  # ── Error handler (snippet-driven from caddyPublic.error_handler) ──
  eh = caddyPublic.error_handler or { status_codes = [ 502 503 504 ]; error_html = "/srv/error.html"; };
  codesExpr = lib.concatMapStringsSep " || " (c: "{err.status_code} == ${toString c}") eh.status_codes;
  handleErrors = stripTrail (subst {
    "@GEO_PAGE@"   = stripTrail (readTpl "geo-restricted.html.tpl");
    "@CODES_EXPR@" = codesExpr;
    "@ERR_ROOT@"   = lib.removeSuffix "/error.html" eh.error_html;
    "@ERR_FILE@"   = baseNameOf eh.error_html;
  } (readTpl "22-handle-errors.caddy.tpl"));

  # ── layer4 SNI mux (caddy-l4 module) — caddy-public IS the smart :443 edge ──
  # caddy-public IS the :443 edge (formerly a separate blind L4 relay). Three tiers, in order
  # (caddy-l4 #294 flat pattern: a final `not { tls { sni … } }` forces the
  # ClientHello parse so the bare-tls prefetch race can't win):
  #   1. mail SNIs (imap./smtps.) → L4-forward to maddy — raw IMAPS/SMTPS, never L7.
  #   2. pure-public SNIs → local :8443 with PROXY-protocol (L7 terminate + serve).
  #   3. everything else (private + mixed api./analytics.) → raw-TLS passthrough to
  #      gcp-proxy (private_forward_upstream). No termination ⇒ no re-encryption;
  #      gcp-proxy terminates + its @wg gate 403s public clients (source 10.1.0.1).
  mailL4     = caddyPublic.mail_l4_routes or [];
  # multi-SSO (edge_auth.multi_sso): the extra sign-in host(s) are terminated here like auth.
  publicSnis = (caddyPublic.public_sni_hosts or []) ++ (if ea.multiSso.enabled then ea.multiSso.extraHosts else []) ++ (map (e: e.host) geoCfg.edge_terminated);
  sniSlug    = h: lib.replaceStrings [ "." "-" ] [ "_" "_" ] h;
  allMuxSnis = (map (r: r.sni) mailL4) ++ publicSnis;
  mkMailL4Route = r: ''
        @m_${sniSlug r.sni} tls sni ${r.sni}
        route @m_${sniSlug r.sni} {
          proxy {
            upstream ${r.upstream}
          }
        }'';
  l4Section = ''

      layer4 {
        :443 {
${lib.concatMapStringsSep "\n" mkMailL4Route mailL4}
          @public tls sni ${lib.concatStringsSep " " publicSnis}
          route @public {
            proxy {
              proxy_protocol v2
              upstream 127.0.0.1:8443
            }
          }
          @rest not {
            tls {
              sni ${lib.concatStringsSep " " allMuxSnis}
            }
          }
          route @rest {
            proxy {
              upstream ${privateUpstream}
            }
          }
        }
      }'';

  # ── Globals block (snippet-driven from 00-globals.caddy.tpl) ──
  # https_port 8443 (the L7 server), proxy_protocol→tls listener_wrapper (unwraps
  # the PP from our own layer4 tier-2), ACME DNS-01 (Cloudflare wildcard cert).
  # @L4_SECTION@ = the layer4 mux above — caddy-public owns 0.0.0.0:443 directly.
  global = caddyPublic.global or {};
  odt    = caddyPublic.on_demand_tls or {};
  globalsBlock = subst {
    "@DEBUG_LINE@"  = if (global.debug or false) then "debug" else "";
    "@ADMIN_BIND@"  = global.admin_bind;
    "@ORDER@"       = global.order;
    "@AUTO_HTTPS@"  = global.auto_https;
    "@ODT_ASK_URL@" = odt.ask_url or "http://127.0.0.1:2020";
    "@L4_SECTION@"  = l4Section;
  } (readTpl "00-globals.caddy.tpl");

  # ── Helpers to recognise gh-pages domains (multi-domain "a, b" field) ──
  ghPages = caddyPublic.github_pages_proxies or [];
  ghPagesDomainLists = map (g: lib.splitString ", " g.domain) ghPages;
  ghPagesDomains = lib.flatten ghPagesDomainLists;

  wellKnownRoutes = caddyPublic.well_known_routes or [];

  # Static assets on gh-pages sites: GitHub Pages sends max-age=600, so a
  # WebView re-entry after 10 min refetches every icon. Serve them with a day
  # of freshness + a week of stale-while-revalidate; the upstream ETag is kept
  # so revalidation is a cheap 304. HTML stays on GitHub's short max-age.
  ghStaticRe = (ss.rate_limit or {}).static_path_regexp or ''(?i)\.(svg|png|jpe?g|gif|webp|avif|ico|css|js|mjs|map|woff2?|ttf|otf|json|webmanifest|mp4|webm)$'';
  mkGithubProxy = path: ''
    @gh_static path_regexp gh_static `${ghStaticRe}`
    header @gh_static {
      Cache-Control "public, max-age=86400, stale-while-revalidate=604800"
      -Expires
      defer
    }
    rewrite * /${path}{uri}
    reverse_proxy https://diegonmarcos.github.io {
      header_up Host diegonmarcos.github.io
      ${xreal}
    }'';

  # ── well-known handle block (public per spec) ──
  mkWellKnownBlock = wk:
    let
      hasRedirect = (wk.redirect_to or null) != null;
      hasTlsSkipVerify = wk.tls_skip_verify or false;
    in
    if hasRedirect then
      # 3-arg redir form is unambiguous: <matcher=path> <to> <code>.
      "      redir ${wk.path} ${wk.redirect_to} 308"
    else if hasTlsSkipVerify then ''
      handle ${wk.path} {
        reverse_proxy https://${wk.upstream} {
          ${xreal}
          transport http {
            tls_insecure_skip_verify
          }
        }
      }''
    else ''
      handle ${wk.path} {
        reverse_proxy ${wk.upstream} {
          ${xreal}
        }
      }'';

  # ── GitHub Pages site blocks ──
  # If a gh-pages domain ALSO appears as a well_known target_domain, emit
  # those well-known handlers BEFORE the gh-pages catch-all.
  mkGithubPagesRoute = group:
    let
      groupDomains = lib.splitString ", " group.domain;
      matchingWellKnown = builtins.filter
        (wk: builtins.elem wk.target_domain groupDomains) wellKnownRoutes;
      wellKnownBlocks = lib.concatMapStringsSep "\n" mkWellKnownBlock matchingWellKnown;
      # WKD (PGP key discovery, /.well-known/openpgpkey/*) is served from
      # /srv/wkd on gcp-proxy — caddy-public has no key store, so forward it to
      # the hub (NOT the gh-pages catch-all, which would 404 on github.io).
      wkdBlock = if (group.wkd or false) then ''
      handle /.well-known/openpgpkey/* {
        ${fwd}
      }'' else "";
      body =
        if (wellKnownBlocks != "" || wkdBlock != "") then ''
      ${wkdBlock}
      ${wellKnownBlocks}
          handle {
            ${mkGithubProxy group.github_path}
          }''
        else "      ${mkGithubProxy group.github_path}";
    in ''
    # gh-pages: ${group.comment or group.domain}
    ${group.domain} {
    ${sec}
    ${geo group.domain}
      ${ea.gate group.domain}
      ${body}
      ${handleErrors}
    }'';

  # ── Public subdomains (public_routes) ──
  # auth=="none" → serve the real upstream at the edge.
  # auth!=="none" → forward to gcp-proxy (do NOT serve unauthed).
  mkSubdomainRoute = route:
    let isNoAuth = (route.auth or null) == "none";
    in ''
    # subdomain: ${route.comment or route.domain}
    ${route.domain} {
    ${sec}
    ${geo route.domain}
    ${ea.gate route.domain}
    ${if isNoAuth then ''  reverse_proxy ${route.upstream} {
        ${xreal}
      }'' else "  ${fwd}"}
      ${handleErrors}
    }'';

  # ── Public path-route groups (public_path_routes) ──
  # Serve ONLY each path's explicit `public_paths`; the base_path itself is
  # authed/private and is NOT served — it falls into the site catch-all that
  # forwards to gcp-proxy. The catch-all guarantees every non-public path on
  # the host forwards to the private hub (fail-closed).
  mkPublicPathHandle = upstream: pp: ''
      handle ${pp} {
        reverse_proxy ${upstream} {
          ${xreal}
        }
      }'';

  mkPathRouteGroup = group:
    let
      mkPathPublicHandles = path:
        let publicPaths = path.public_paths or [];
        in lib.concatMapStringsSep "\n" (mkPublicPathHandle path.upstream) publicPaths;
      publicHandles = lib.concatStringsSep "\n"
        (builtins.filter (s: s != "") (map mkPathPublicHandles group.paths));
    in ''
    # path-host: ${group.comment or group.parent_domain}
    ${group.parent_domain} {
    ${sec}
    ${geo group.parent_domain}
    ${ea.gate group.parent_domain}
    ${publicHandles}
      handle {
        ${fwd}
      }
      ${handleErrors}
    }'';

  # ── well_known_routes whose target_domain is NOT a gh-pages domain ──
  # Group by target_domain → one site with the handlers + a catch-all forward.
  nonGhWellKnown = builtins.filter
    (wk: !(builtins.elem wk.target_domain ghPagesDomains)) wellKnownRoutes;

  nonGhWkDomains = lib.unique (map (wk: wk.target_domain) nonGhWellKnown);

  mkNonGhWellKnownSite = domain:
    let
      entries = builtins.filter (wk: wk.target_domain == domain) nonGhWellKnown;
      blocks = lib.concatMapStringsSep "\n" mkWellKnownBlock entries;
    in ''
    # well-known host: ${domain}
    ${domain} {
    ${sec}
    ${geo domain}
    ${ea.gate domain}
    ${blocks}
      handle {
        ${fwd}
      }
      ${handleErrors}
    }'';

  # ── MCP hub (public_mcp_routes) — port of caddyfile.nix mkMcpRouteGroup ──
  # mcp.diegonmarcos.com is in public_sni_hosts, so layer4 @public routes it to
  # THIS L7 tier; without a site block here Caddy holds no cert for the SNI and
  # every public MCP client dies in the handshake ("tlsv1 alert internal
  # error") — which is exactly how the hub-only rendering failed. Two tiers
  # reach this edge (the derive's isEdgeMcp filter): fully-public endpoints
  # (wg_only:false — cloud-cgc-pub-mcp) proxy bare; bearer_auth endpoints
  # (cloud-infra-mcp) verify `Authorization: Bearer` by forward_auth against
  # the introspection upstream over the mesh. No Authelia browser fallback for
  # the same reason as the hub: an MCP client speaks JSON-RPC and cannot
  # follow a login redirect, so no/invalid token is a clean 403.
  # The @wg branch is kept for hub parity (a mesh client that lands here still
  # passes); a wg_only endpoint WITHOUT bearer_auth should never be emitted to
  # this file — if one ever is, it renders as WG-or-403, fail closed.
  # Endpoint upstreams are direct mesh addresses (plain HTTP) — deliberately
  # NOT `fwd`, whose plain reverse_proxy to the hub's TLS port is untested.
  mcpGroups = caddyPublic.public_mcp_routes or [];
  mkMcpRouteGroup = group:
    let
      mkEndpoint = ep:
        let
          proxyBody = ''reverse_proxy ${ep.upstream} {
          flush_interval -1
          ${xreal}
          header_up Accept "application/json, text/event-stream"
        }'';
          bearerGate = ''@wg remote_ip ${wgCidrs}
        handle @wg {
          ${proxyBody}
        }
        @bearer header Authorization Bearer*
        handle @bearer {
${bearer}
          ${proxyBody}
        }
${denyBlock}'';
          # 401 + WWW-Authenticate when the MCP OAuth AS is configured (_shared/mcp-oauth.nix).
          denyBlock = let d = mo.deny group.parent_domain ep.base_path; in
            if d != null then d else ''
        handle {
          respond "Forbidden" 403
        }'';
          wgGate = ''@wg remote_ip ${wgCidrs}
        handle @wg {
          ${proxyBody}
        }
        handle {
          respond "Forbidden" 403
        }'';
          inner = if (ep.bearer_auth or false) then bearerGate
                  else if (ep.wg_only or false) then wgGate
                  else proxyBody;
        in ''
      handle_path ${ep.base_path}/* {
        ${inner}
      }'';
      endpointBlocks = lib.concatMapStringsSep "\n" mkEndpoint group.endpoints;
      fallbackMsg = group.fallback_message or "MCP Hub";
    in ''
    # mcp-hub: ${group.comment or group.parent_domain}
    ${group.parent_domain} {
    ${sec}
    ${geo group.parent_domain}
    ${ea.gateOff group.parent_domain}
    ${mo.block group.parent_domain}
    ${endpointBlocks}
      # Bare host: human hint. Any other path is not a public MCP route
      # (mesh-only / wg_only, or unknown): answer 404 JSON so MCP clients
      # report "not found" instead of a 200 text/plain "Unexpected content type".
      handle / {
        respond "${fallbackMsg}" 200
      }
      handle {
        header Content-Type application/json
        respond `{"jsonrpc":"2.0","id":null,"error":{"code":-32004,"message":"No public MCP route at this path (mesh-only or unknown). ${fallbackMsg}"}}` 404
      }
      ${handleErrors}
    }'';

  # ── Edge-terminated hosts (_shared/geo-fence.json edge_terminated, #1102/#1104) ──
  # Hosts that used to be raw-TLS passthrough to the hub (which only ever sees 10.1.0.1) are
  # terminated HERE so the country fence can see the client, then proxied to the hub over TLS
  # (same SNI/Host). The edge gate and the hub's own gate both stay on: auth is unchanged.
  mkEdgeTerminatedSite = e: ''
    # edge-terminated: ${e.host} -- ${e.reason}
    ${e.host} {
    ${sec}
    ${geo e.host}
    ${ea.gate e.host}
      reverse_proxy https://${privateUpstream} {
        flush_interval -1
        # Caddy >= 2.11 rewrites Host to the upstream hostport (10.1.0.2:443) for an https
        # upstream. The hub enforces strict SNI/Host matching (its mTLS vault vhost turns
        # strict_sni_host on), so SNI=${e.host} + Host=10.1.0.2:443 is answered 421. Keep the
        # client's Host, as the oidc-public handle already does.
        header_up Host {host}
        ${xreal}
        transport http {
          tls_server_name ${e.host}
        }
      }
      ${handleErrors}
    }'';

  # ── OIDC public machine endpoints (oidc_public) ──
  # The bearer-gated MCP tier needs its tokens MINTED from off-mesh, and the
  # hub 403s auth.diegonmarcos.com for non-WG clients by design. This serves
  # ONLY the declared machine endpoints (token endpoint, discovery, JWKS) at
  # the edge, straight to the authelia upstream over the mesh; every other
  # path on the host — the login portal, the authorization endpoint, the
  # admin surface — answers 403 here, keeping the browser-facing portal
  # mesh-only. A public token endpoint yields nothing without a client
  # secret; this is the standard shape of every public IdP.
  # Deliberately NOT `fwd` (plain HTTP at the hub's TLS port, untested) and
  # deliberately not the portal-wide mkSubdomainRoute: explicit paths only,
  # fail closed.
  # OWNER DECISION (2026-10-15): auth.diegonmarcos.com must be FULLY open to
  # the internet — the Authelia login page reachable off-mesh. Declared in data:
  # when authelia's proxy.primary.wg_only is false (→ oidc_public.wg_only=false)
  # this site proxies ALL paths to Authelia via the hub (security / request
  # limits / crowdsec / TLS kept via the sec snippet); the explicit-paths + 403 shape
  # above applies only while wg_only is true/absent (fail closed).
  # oidc_public.upstream carries the hub-auth-vhost mesh endpoint (data-driven;
  # see the derive comment for WHY it is the hub over wg0, not authelia:9091).
  oidcPub = caddyPublic.oidc_public or null;
  mkOidcPublicSite =
    if oidcPub == null then "" else
    let
      oidcUpstream = oidcPub.upstream or "https://10.0.0.1:8443";
      fullyOpen = (oidcPub.wg_only or true) == false;
      # multi-SSO on: the vhost answers several names; forward the requested one.
      ssoSite  = ea.multiSso.enabled && oidcPub.domain == ea.multiSso.primaryHost;
      hostRef  = if ssoSite then "{host}" else oidcPub.domain;
      siteName = if ssoSite then lib.concatStringsSep ", " ([ oidcPub.domain ] ++ ea.multiSso.extraHosts) else oidcPub.domain;
      mkOidcHandle = p: ''
      handle ${p} {
        reverse_proxy ${oidcUpstream} {
          header_up Host ${hostRef}
          ${xreal}
          transport http {
            tls
            tls_server_name ${hostRef}
          }
        }
      }'';
      handles = lib.concatMapStringsSep "\n" mkOidcHandle (oidcPub.paths or []);
      # Multi-SSO (#1147): one handle PER host, each with a LITERAL Host and tls_server_name. The
      # hub enforces strict SNI/Host matching (its mTLS vault vhost turns strict_sni_host on) and a
      # reverse_proxy transport pools upstream connections per address, not per SNI. One handler with
      # `tls_server_name {host}` therefore reused whichever TLS connection was opened first, and the
      # hub answered 421 to every other alias (sso. 302, account./auth. 421). One handler per host =
      # one transport and one connection pool per SNI. Same shape as the c3-pvt edge site (c29fbed0).
      ssoHostHandle = h: ''
      @sni_${builtins.replaceStrings [ "." "-" ] [ "_" "_" ] h} host ${h}
      handle @sni_${builtins.replaceStrings [ "." "-" ] [ "_" "_" ] h} {
        reverse_proxy ${oidcUpstream} {
          header_up Host ${h}
          ${xreal}
          transport http {
            tls
            tls_server_name ${h}
          }
        }
      }'';
      ssoHostHandles = lib.concatMapStringsSep "\n" ssoHostHandle ([ oidcPub.domain ] ++ ea.multiSso.extraHosts);
    in if fullyOpen then ''
    # oidc-public: wg_only:false — whole IdP host open (owner decision 2026-10-15)
    ${siteName} {
    ${sec}
    ${geo oidcPub.domain}
    ${ea.gate oidcPub.domain}
    ${if ssoSite then ssoHostHandles else mkOidcHandle ""}
      ${handleErrors}
    }'' else ''
    # oidc-public: machine endpoints only; portal stays mesh-only
    ${oidcPub.domain} {
    ${sec}
    ${geo oidcPub.domain}
    ${ea.gate oidcPub.domain}
    ${handles}
      handle {
        respond "Forbidden" 403
      }
      ${handleErrors}
    }'';

  # NOTE: there is intentionally NO L7 *.diegonmarcos.com fail-closed site.
  # Private/unmatched subdomains are handled one tier earlier by the layer4
  # @rest passthrough (raw TLS → gcp-proxy 10.1.0.2:443, no termination), so
  # caddy-public never terminates TLS for a private host and never needs the
  # wildcard cert. (A named *.diegonmarcos.com L7 site would re-introduce the
  # wildcard-cert DNS-01 collision with gcp-proxy that broke issuance.)

in ''
${globalsBlock}
  # ════════════════════════════════════════════════════════════
  # SECURITY SNIPPETS
  # ════════════════════════════════════════════════════════════

  ${securityHeaders}
  ${rateLimiting}
  ${blockBots}
  ${blockScanners}
  ${requestLimits}
  ${ipBlock}
  ${accessLog}
  ${securitySnippet}

${geoFenceSnippet}

  # ── Shared public-edge auth gate (_shared/edge-auth.nix; same text as the hub's) ──
${ea.snippets}
  # ════════════════════════════════════════════════════════════
  # GITHUB PAGES PROXIES (served at edge — public static sites)
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n\n" mkGithubPagesRoute ghPages}

  # ════════════════════════════════════════════════════════════
  # PUBLIC SUBDOMAINS (auth==none — served at edge; routed here by layer4 @public)
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n\n" mkSubdomainRoute (builtins.filter (r: (r.auth or null) == "none") (caddyPublic.public_routes or []))}

  # ════════════════════════════════════════════════════════════
  # MCP HUB (public_mcp_routes — public + bearer tiers served at edge)
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n\n" mkMcpRouteGroup mcpGroups}

  # ════════════════════════════════════════════════════════════
  # OIDC PUBLIC MACHINE ENDPOINTS (token/discovery/JWKS only; portal 403s)
  # ════════════════════════════════════════════════════════════

${mkOidcPublicSite}

  # ════════════════════════════════════════════════════════════
  # EDGE-TERMINATED HOSTS (fenced, then proxied to the hub)
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n\n" mkEdgeTerminatedSite geoCfg.edge_terminated}

  # ════════════════════════════════════════════════════════════
  # NO L7 *.diegonmarcos.com catch-all — a named-wildcard site would force
  # caddy-public to provision a *.diegonmarcos.com ACME cert, colliding with
  # gcp-proxy's wildcard DNS-01 (shared _acme-challenge.diegonmarcos.com TXT) —
  # which is exactly what broke cert issuance. The layer4 @rest tier already
  # raw-TLS-passes every non-public SNI to gcp-proxy, so no host ever reaches
  # :8443 without an explicit per-host public site above. caddy-public therefore
  # requests ONLY per-host certs for its declared-public hosts (no wildcard).
  # ════════════════════════════════════════════════════════════
''
