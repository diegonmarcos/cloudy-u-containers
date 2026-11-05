# ══════════════════════════════════════════════════════════════════
# re-ship marker (#1104/#1102/#1292): earlier caddy deploys were stranded by a transient scp drop, then by stale committed dist (render mismatch); #1292 redirect-host gate shipped after the dist re-render
# caddyfile.nix — pure-Nix Caddyfile generator (v2 engine)
#
# Reads build-caddy.json (data-driven from 1_cicd/dist/) and
# returns the fully-rendered Caddyfile string. Pure-syntax fragments
# live as `.caddy.tpl` files in `./snippets/`; this file only does
# orchestration: read → substitute @PLACEHOLDER@ → assemble.
#
# Last meaningful change: 2026-05-08 split snippets out of Nix string
# literals into ./snippets/*.caddy.tpl (orchestration vs data).
# ══════════════════════════════════════════════════════════════════
{ lib, caddyRoutes }:

let
  # ── Snippet loader: read .caddy.tpl + apply @KEY@ substitutions ──
  readTpl = name: builtins.readFile (./snippets + "/${name}");

  # subst :: { "@KEY@" = "value"; ... } -> string -> string
  subst = subs: text:
    lib.replaceStrings (lib.attrNames subs) (lib.attrValues subs) text;

  # Drop trailing newline (templates end with `\n`; for inline use we strip it)
  stripTrail = s: lib.removeSuffix "\n" s;

  # ── Dual-bind public *.diegonmarcos.com routes to BOTH the public socket
  # and the WG-internal IP. Hickory wildcards *.diegonmarcos.com → wgBindIp
  # for the WG fast-path (skips Cloudflare); without dual-binding here,
  # WG traffic lands on the more-specific listener created by *.mesh.diegonmarcos.com blocks
  # (which doesn't carry the public host matchers) and falls through to an
  # empty 200 response. Source-of-truth: build.json caddy_config.global.wg_bind_ip.
  wgBindIp = caddyRoutes.global.wg_bind_ip or "10.0.0.1";
  publicBindLine = "  bind 0.0.0.0 ${wgBindIp}";

  # ── Mesh source CIDRs for every WG gate (@wg / @not_wg) ──
  # Space-separated CIDR list; mirrors config.json wireguard.subnet +
  # subnet_v6. MUST stay dual-stack: wg0 became dual-stack 2026-07-26 and
  # Hickory answers both A and AAAA for *.diegonmarcos.com, so a client that
  # prefers IPv6 (curl, Node, Claude Code's MCP client) arrives from
  # fd0c:1d00::/64. While this gate was IPv4-only those clients matched
  # neither @wg nor @bearer and got a bare 403 on every mesh-only route.
  wgCidrs = caddyRoutes.global.wg_cidrs or "10.0.0.0/24 fd0c:1d00::/64";

  # ── Security snippets (data-driven from caddyRoutes.security_snippets) ──
  ss = caddyRoutes.security_snippets or {};

  securityHeaders = let h = ss.security_headers; in
    subst {
      "@HSTS_MAX_AGE@"      = toString h.hsts_max_age;
      "@FRAME_OPTIONS@"     = h.frame_options;
      "@REFERRER_POLICY@"   = h.referrer_policy;
      "@PERMISSIONS_POLICY@" = h.permissions_policy;
      "@CORS_ORIGIN@"       = h.cors_origin;
      "@CORS_METHODS@"      = h.cors_methods;
      "@CORS_HEADERS@"      = h.cors_headers;
      "@HIDE_HEADERS@"      = lib.concatMapStringsSep "\n        " (x: "-${x}") (h.hide_headers or []);
    } (readTpl "10-security-headers.caddy.tpl");

  mkRateLimiting = name: r:
    subst {
      "@RL_SNIPPET@" = name;
      "@RL_ZONE@"   = r.zone;
      "@RL_KEY@"    = r.key;
      "@RL_EVENTS@" = toString r.events;
      "@RL_WINDOW@" = r.window;
    } (readTpl "11-rate-limiting.caddy.tpl");
  rateLimiting = mkRateLimiting "rate_limiting" ss.rate_limit;
  rateLimitingMcp = mkRateLimiting "rate_limiting_mcp" ss.mcp_rate_limit;
  rateLimitingJmap = mkRateLimiting "rate_limiting_jmap" ss.jmap_rate_limit;

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
  securityMcpSnippet = readTpl "18-security-mcp-snippet.caddy.tpl";
  securityJmapSnippet = readTpl "19-security-jmap-snippet.caddy.tpl";

  # `sec` and `secNoLimit` are used inline as `import` lines inside site
  # blocks. Indentation is non-trivial here — we keep the original
  # whitespace exactly to preserve output formatting.
  sec = ''
      import security
      import request_limits'';

  secNoLimit = ''
      import security'';

  secMcp = ''
      import security_mcp
      import request_limits'';

  # ── Auth snippets ──
  auth = caddyRoutes.auth or {};
  # Container IP, NOT the host-published 10.0.0.1:9091: dialing the published
  # port from a container hairpins through docker-proxy, which HANGS on this
  # host (15s stalls then context-canceled — took auth.diegonmarcos.com down
  # 2026-08-31). Same pin + same reason as introspect-proxy's JWKS_URL; the
  # address is pinned in infra-sec_authelia/src/compose.nix (auth-net .3) —
  # keep the three in sync.
  autheliaUpstream   = "172.18.0.3:9091";
  introspectUpstream = caddyRoutes.auth_upstreams.introspect_proxy or "10.0.0.1:4182";

  authelia = stripTrail (subst {
    "@AUTHELIA_UPSTREAM@" = autheliaUpstream;
    "@AUTHELIA_URI@"      = auth.authelia_uri;
    "@AUTHELIA_COPY@"     = lib.concatStringsSep " " auth.authelia_copy;
  } (readTpl "20-authelia.caddy.tpl"));

  bearer = stripTrail (subst {
    "@INTROSPECT_UPSTREAM@" = introspectUpstream;
    "@INTROSPECT_URI@"      = auth.introspect_uri;
    "@INTROSPECT_COPY@"     = lib.concatStringsSep " " auth.introspect_copy;
  } (readTpl "21-bearer.caddy.tpl"));

  # ── Shared public-edge auth gate (owner rule 2026-10-16) ──
  # ONE definition, rendered into this Caddyfile and into the edge's
  # (_shared/edge-auth.nix). `ea.gate <domain>` is the `import` line every
  # public site carries (empty only for hosts declared public_open in
  # build.json caddy_config.edge_auth); `ea.gateOff` is the same gate enforced
  # only against non-mesh sources, for sites whose mesh peers the WG gate
  # already trusts. This hub dials Authelia on the docker bridge.
  ea = import ../../_shared/edge-auth.nix {
    inherit lib auth wgCidrs introspectUpstream autheliaUpstream;
    edgeAuth = caddyRoutes.edge_auth or {};
  };

  # MCP OAuth AS routes on the MCP hub (WIP option 31.1, _shared/mcp-oauth.nix).
  # Inert while build-caddy.json carries no `mcp_oauth` block.
  mo = import ../../_shared/mcp-oauth.nix {
    inherit lib auth autheliaUpstream;
    cfg = caddyRoutes.mcp_oauth or null;
    edgeAuth = caddyRoutes.edge_auth or {};
  };

  # Mesh-only guard for the private *.mesh.diegonmarcos.com / *.db / s3 names (tier a). These
  # sites bind 0.0.0.0, and the edge's layer4 tier forwards every non-public SNI
  # here untouched, so without this a public client could present any *.mesh.diegonmarcos.com SNI
  # and be proxied with no auth at all. Same sources as mkPrivateMeshRoute.
  meshGuard = ''
    @not_mesh not remote_ip ${meshOnlySources}
    error @not_mesh "Forbidden" 403'';

  # ── Shared 401/403 fallback (ONE handler, rendered once in (edge_errors)) ──
  # A browser (Accept: text/html) denied with 401/403 is redirected to the static
  # Pages fallback page of the service that owns the host; every other client keeps
  # the plain status (bearer clients, MCPs, CI). Host -> page comes from
  # _shared/fallback-services.json (generated from build.json): declared hosts,
  # mesh name <name>.mesh.diegonmarcos.com and cloud.<name>.mesh.diegonmarcos.com. Unknown hosts land on the index.
  fb = builtins.fromJSON (builtins.readFile ../../_shared/fallback-services.json);
  fbHosts = lib.concatMap (s:
    map (h: { inherit h; slug = s.slug; }) (s.hosts ++ lib.optionals (s.mesh != null) [ s.mesh "cloud.${s.mesh}" ])) fb.services;
  # A host shared by several services (mcp.) has no single page: it falls to the index.
  fbByHost = lib.groupBy (e: e.h) fbHosts;
  fbUnique = lib.filter (h: lib.length (lib.unique (map (e: e.slug) fbByHost.${h})) == 1) (lib.attrNames fbByHost);
  fbMapLines = lib.concatMapStringsSep "\n" (h: "        ${h} ${(lib.head fbByHost.${h}).slug}/") fbUnique;
  fallbackBlock = ''
      @deny_html {
        expression `{err.status_code} == 401 || {err.status_code} == 403`
        header Accept *text/html*
      }
      handle @deny_html {
        map {host} {fb_path} {
${fbMapLines}
          default ""
        }
        header Vary Accept
        redir ${fb.pages_base}{fb_path}?rd=https://{host}{path} 302
      }
      @deny_plain expression `{err.status_code} == 401 || {err.status_code} == 403`
      handle @deny_plain {
        respond "{err.message}" {err.status_code}
      }'';

  handleErrorsBody = let
    eh = caddyRoutes.error_handler or { status_codes = [502 503 504]; error_html = "/srv/error.html"; };
    codesExpr = lib.concatMapStringsSep " || " (c: "{err.status_code} == ${toString c}") eh.status_codes;
    errPath = eh.error_html;
  in stripTrail (subst {
    "@CODES_EXPR@" = codesExpr;
    "@FALLBACK_BLOCK@" = fallbackBlock;
    "@ERR_ROOT@"   = lib.removeSuffix "/error.html" errPath;
    "@ERR_FILE@"   = baseNameOf errPath;
  } (readTpl "22-handle-errors.caddy.tpl"));

  # The error pages are ONE named route; every site only `invoke`s it.
  # `import` of a snippet expands its text at every site, so the fallback host
  # map (~160 entries) x 341 sites made the adapted config 4.5x larger and
  # `caddy validate` peak at 230 MB against the container's 192M limit: the hub
  # caddy was OOM-killed (outage 2026-10-22). A named route is adapted once
  # (apps.http.named_routes); each site carries a one-line invoke handler.
  # Guard: src/test/test-hub-resource-budget.sh.
  edgeErrorPagesRoute = "&(edge_error_pages) {\n" + handleErrorsBody + "\n  }";
  edgeErrorsSnippet = "(edge_errors) {\n  handle_errors {\n    invoke edge_error_pages\n  }\n  }";
  handleErrors = "  import edge_errors";

  protectedTpl       = readTpl "23-protected.caddy.tpl";
  protectedCustomTpl = readTpl "24-protected-custom.caddy.tpl";

  # Shared empty-body guard (snippet 35): injected into every reverse_proxy
  # block so an upstream 200 with Content-Length 0 (a blank white page) becomes
  # a truthful 502 that handle_errors renders, instead of a silent false green.
  emptyGuard = stripTrail (readTpl "35-empty-body-guard.caddy.tpl");

  # route.strip_authorization (service build.json proxy.primary): withhold the
  # fleet bearer from the upstream once introspect-proxy has validated it.
  # Without it, an upstream with its OWN Authorization scheme (gitea) reads
  # the fleet JWT as one of its tokens and 401s a request the gate already
  # passed — no bearer client could reach gitea's API or clone through the
  # edge. Bearer branch only: the Authelia branch never carries a fleet
  # bearer, and a Basic header there is the upstream's own credential.
  bearerHeaderUp = opts:
    if opts.strip_authorization or false then "\n        header_up -Authorization" else "";

  # route.identity (service build.json proxy.primary.identity): map the
  # identity the gate validated to the upstream's own user and send it in the
  # upstream's reverse-proxy-auth header. All of it lives in identity.nix;
  # every route without the key renders byte-identical to before.
  identityOf = import ./identity.nix;

  mkProtectedOpt = opts: upstream: let id = identityOf opts; in subst {
    "@BEARER_BLOCK@"       = bearer;
    "@BEARER_IDENTITY@"    = id.bearer;
    "@BEARER_HEADER_UP@"   = bearerHeaderUp opts + id.bearerHeaderUp;
    "@AUTHELIA_BLOCK@"     = authelia;
    "@AUTHELIA_IDENTITY@"  = id.session;
    "@AUTHELIA_HEADER_UP@" = id.sessionHeaderUp;
    "@UPSTREAM@"           = upstream;
    "@EMPTY_GUARD@"        = emptyGuard;
  } protectedTpl;
  mkProtected = mkProtectedOpt {};

  mkProtectedCustomOpt = opts: upstreamUrl: transportBlock: let id = identityOf opts; in subst {
    "@BEARER_BLOCK@"       = bearer;
    "@BEARER_IDENTITY@"    = id.bearer;
    "@BEARER_HEADER_UP@"   = bearerHeaderUp opts + id.bearerHeaderUp;
    "@AUTHELIA_BLOCK@"     = authelia;
    "@AUTHELIA_IDENTITY@"  = id.session;
    "@AUTHELIA_HEADER_UP@" = id.sessionHeaderUp;
    "@UPSTREAM@"           = upstreamUrl;
    "@TRANSPORT_BLOCK@"    = transportBlock;
    "@EMPTY_GUARD@"        = emptyGuard;
  } protectedCustomTpl;
  mkProtectedCustom = mkProtectedCustomOpt {};

  # ── WG-only gates (fail-closed posture; route.wg_only from build.json
  #    proxy.primary, defaulted true unless wg_only:false — see derive engine) ──
  # Two shapes for two scopes:
  #  · wgGateBody — wraps a single handle's BODY in an order-independent
  #    `handle @wg {…} handle { respond 403 }` pair. MUST be used INSIDE an
  #    outer handle/handle_path so the 403 catch-all is scoped to that path and
  #    never leaks to sibling routes in a shared site block. Mirrors the
  #    mkMcpRouteGroup per-endpoint pattern. Used by mkPathEntry.
  #  · wgSiteLine — a top-of-site `@not_wg not remote_ip … respond 403` guard
  #    for whole-domain blocks (relies on the global `order respond before
  #    handle`, same as mkSubdomainRoute's wgBlock). Used by mkNtfyBlock /
  #    mkProxyDashboardBlock.
  wgGateBody = isWg: body:
    if isWg then ''@wg remote_ip ${wgCidrs}
        handle @wg {
          ${body}
        }
        handle {
          error "Forbidden" 403
        }''
    else body;
  wgSiteLine = isWg:
    if isWg then ''@not_wg not remote_ip ${wgCidrs}
      error @not_wg "Forbidden" 403''
    else "";

  mkGithubProxy = path: ''
    rewrite * /${path}{uri}
    reverse_proxy https://diegonmarcos.github.io {
      header_up Host diegonmarcos.github.io
      header_up X-Real-IP {http.request.remote.host}
    }
  '';

  # ── Route generators ──
  # listen: optional — when the derive emits a "listen" field (e.g. "10.0.0.1:465"
  # for listen_scope=wg), Caddy binds only on that IP:port. Absent → :<port> =
  # all interfaces = current public behavior. One data-driven knob flips public
  # vs WG-only per entry in config.json → vms[gcp-proxy].public_ports[].
  #
  # sni: optional — when present, the route is matched by TLS SNI inside a
  # shared listener block. Multiple routes with the same listenSpec get
  # collapsed into one listener with per-SNI sub-routes. Phase 3 of the
  # public-surface collapse: lets IMAPS, SMTPS, JMAP, … all share :443 via
  # SNI hostname routing.
  routeListenSpec = route: route.listen or ":${toString route.port}";

  # Slugify hostname for caddy-l4 named matcher (dots/hyphens → underscores)
  sniSlug = host: lib.replaceStrings ["." "-"] ["_" "_"] host;

  l4PlainTpl = readTpl "50-l4-plain-route.caddy.tpl";
  l4SniTpl   = readTpl "51-l4-sni-route.caddy.tpl";

  # Plain (non-SNI) route — direct TCP proxy, used for ports like :25
  mkPlainRoute = route:
    let
      pp = route.proxy_protocol or false;
      ppLine = if pp then "\n                proxy_protocol v2" else "";
    in subst {
      "@COMMENT@"  = route.comment or "";
      "@UPSTREAM@" = route.upstream;
      "@PP_LINE@"  = ppLine;
    } l4PlainTpl;

  # Per-SNI inner dispatch route (used inside the outer @mail gate)
  mkSniInnerRoute = route:
    let
      pp = route.proxy_protocol or false;
      ppLine = if pp then "\n                  proxy_protocol v2" else "";
    in subst {
      "@COMMENT@"     = route.comment or "";
      "@SNI@"         = route.sni;
      "@SNI_MATCHER@" = "@sni_${sniSlug route.sni}";
      "@UPSTREAM@"    = route.upstream;
      "@PP_LINE@"     = ppLine;
    } l4SniTpl;

  # Group routes by listenSpec → one listener block per spec.
  groupRoutesByListen = routes:
    lib.foldl' (acc: r:
      let k = routeListenSpec r; in
      acc // { ${k} = (acc.${k} or []) ++ [ r ]; }
    ) {} routes;

  # caddy-l4 SNI mux pattern (per upstream issue #294 + tls.md docs):
  #   1. Outer @<gate> tls { sni <hostA> <hostB> ... } gates ALL mail SNIs in
  #      one matcher, forcing a single ClientHello parse before any nested
  #      matchers run. Avoids the prefetch-race where a bare `tls` matcher
  #      wins against not-yet-parsed SNI matchers.
  #   2. Inner per-SNI sub-routes dispatch to the right upstream after the
  #      outer matcher already accepted the connection.
  #   3. Default fall-through uses `not { tls { sni <hostA> ... } }` instead
  #      of bare `@any_tls tls` — bare `tls` matches on first 5 bytes (TLS
  #      record header) before SNI parse and would always win the race.
  # Source: https://github.com/mholt/caddy-l4/issues/294
  mkL4ListenerBlock = listenSpec: routes:
    let
      sniRoutes    = lib.filter (r: (r ? sni) && r.sni != null) routes;
      plainRoutes  = lib.filter (r: !((r ? sni) && r.sni != null)) routes;
      sniHostList  = map (r: r.sni) sniRoutes;
      sniArgs      = lib.concatStringsSep " " sniHostList;
      hasSni       = sniHostList != [];

      plainOut     = lib.concatMapStringsSep "\n" mkPlainRoute plainRoutes;

      # SNI mux block: flat per-SNI matchers + `not` fall-through.
      # Nested matchers inside a `route` block are NOT valid Caddyfile syntax
      # (parser treats `@name` as handler-directive). #294 pattern works flat.
      sniMuxBlock = if !hasSni then "" else ''

          # ── SNI mux (issue #294 pattern, flat) ─────────────────────────
${lib.concatMapStringsSep "\n" mkSniInnerRoute sniRoutes}
          # Fall-through: TLS that does NOT match any mail SNI → internal HTTPS
          # `not { tls { sni ... } }` forces ClientHello parse, avoiding the
          # bare-`tls` race condition (issue #294).
          @notmail not {
            tls {
              sni ${sniArgs}
            }
          }
          route @notmail {
            proxy {
              # Carry the real client address across the local hop. The
              # :8443 HTTP server unwraps it via listener_wrappers
              # proxy_protocol (00-globals.caddy.tpl), so remote_ip
              # matchers (wg-only tier gate) see the true client instead
              # of 127.0.0.1 — which had every request, including genuine
              # WG clients, answered "Forbidden" (vault regression).
              proxy_protocol v2
              upstream 127.0.0.1:8443
            }
          }'';
    in ''
        ${listenSpec} {
${plainOut}${sniMuxBlock}
        }'';

  mkL4Section =
    if (caddyRoutes.l4_routes or []) == [] then ""
    else
      let grouped = groupRoutesByListen caddyRoutes.l4_routes; in ''

      layer4 {
  ${lib.concatStringsSep "\n" (lib.mapAttrsToList mkL4ListenerBlock grouped)}
      }
  '';

  # ── APK vhost with no web target: landing redirect even when signed in ──
  # (url-scheme.md). cloud-{apk}.diegonmarcos.com for an APK that declares no
  # container web target. Nothing to proxy, so no auth wall either: every
  # request 302s to the app's landing page; /login still hands off to Authelia.
  # Owner rule 2026-10-16: no anonymous 302 to GitHub Pages any more -- the
  # shared gate runs first (anonymous -> Authelia login), and only a caller that
  # passed it is sent on to the landing page. `redir` sorts BEFORE forward_auth,
  # so it must live inside a handle, never at site level.
  mkLandingOnlyRoute = route:
    ''
    # ${route.comment or route.domain}
    ${route.domain} {
  ${publicBindLine}
  ${sec}
      ${ea.gate route.domain}
      handle {
        redir ${route.landing} 302
      }
      ${handleErrors}
    }
  '';

  # ── multi-SSO site additions (edge_auth.multi_sso, see _shared/edge-auth.nix) ──
  # Only the auth vhost (multiSso.primaryHost) is touched, only when the flag is on:
  #  · the site also answers the extra hosts (account.diegonmarcos.com)
  #  · GET / from a browser with no Authelia session gets the three-button chooser
  #    (Authelia button -> /?ui=authelia, which falls through to the Authelia SPA)
  #  · /oauth2/<provider>/* is the broker (device-flow broker), one instance per provider
  msSite = ea.multiSso;
  mkSsoProviderHandle = p: ''
      handle ${p.prefix}/* {
        reverse_proxy ${p.upstream} {
          header_up X-Real-IP {http.request.remote.host}
        }
      }
'';
  ssoSiteBlock = ''
      # multi-SSO chooser (edge_auth.multi_sso): browser, no Authelia session, not ?ui=authelia
      @sso_chooser {
        method GET
        path /
        not query ui=authelia
        not header Cookie *${msSite.autheliaCookie}=*
        header Accept *text/html*
      }
      handle @sso_chooser {
        root * /srv
        rewrite * /sso-chooser.html
        header Cache-Control "no-store"
        file_server
      }
'' + lib.concatMapStrings mkSsoProviderHandle msSite.providers;

  mkSubdomainRoute = route: if (route.landing_only or false) then mkLandingOnlyRoute route else
    let
      isSsoSite = msSite.enabled && route.domain == msSite.primaryHost;
      siteDomain = if isSsoSite then lib.concatStringsSep ", " ([ route.domain ] ++ msSite.extraHosts) else route.domain;
      ssoBlock = if isSsoSite then ssoSiteBlock else "";
      # Shadow the shared builders with this route's per-vhost options.
      mkProtected       = mkProtectedOpt route;
      mkProtectedCustom = mkProtectedCustomOpt route;
      isNoAuth = (route.auth or null) == "none";
      # The derive engine emits wg_only:true ONLY for private routes and OMITS the
      # field for public ones (wgOnly ?? true at the source). So "absent" reliably
      # means PUBLIC — default false here. Fail-closed lives at the derive, NOT here:
      # defaulting true would wrongly gate public routes (vpn WG-join, matrix federation).
      isWgOnly = route.wg_only or false;
      hasMaxUpload = (route.max_upload or null) != null;
      hasTimeout = (route.timeout or null) != null;
      hasTlsSkipVerify = route.tls_skip_verify or false;
      tlsServerName = route.tls_server_name or null;
      hasTlsServerName = tlsServerName != null;
      hasLandingPage = (route.landing_page or null) != null;
      hasBypassPaths = (route.bypass_paths or null) != null;

      # Public-landing fallback REMOVED (owner rule 2026-10-16: no route may
      # answer an anonymous request, and a 302 to GitHub Pages was one). The
      # shared gate (import edge_auth, below) now sends an anonymous browser to
      # Authelia instead. caddy_config.public_landing is left in the data for
      # the url-scheme docs/tests but no longer renders anything here.
      #
      # Which gate flavour this vhost carries (tier b / tier a):
      #  · public (not wg_only)            -> edge_auth, enforced for every source
      #  · wg_only with off-mesh exemptions (well-known grafts, bypass_paths: JMAP
      #    discovery, mobile-app login, ...) -> edge_auth_offmesh: those paths are
      #    reachable off-mesh, so off-mesh callers must authenticate; mesh peers
      #    keep the WG gate's trust
      #  · wg_only, nothing exposed        -> no gate; @not_wg 403s every non-mesh source
      gateLine =
        if !isWgOnly then ea.gate route.domain
        else if wgExemptPaths != [] then ea.gateOff route.domain
        else "";

      # Per-route security bundle override (route.security_import, from the
      # service build.json): lets a vhost swap the shared global rate-limit
      # zone for its own without forking the rest of the (security) posture.
      secImport = route.security_import or null;
      secLine =
        if secImport != null then
          (if hasMaxUpload then "      import ${secImport}"
           else "      import ${secImport}\n      import request_limits")
        else if hasMaxUpload then secNoLimit else sec;
      uploadBlock = if hasMaxUpload then ''

      request_body {
        max_size ${route.max_upload}
      }'' else "";

      upstreamUrl = if hasTlsServerName || hasTlsSkipVerify then "https://${route.upstream}" else route.upstream;

      # #876: a Kotlin/Wasm APK host (derive: web.kind wasm + url_scheme.wasm_origin) carries
      # web.serve_path, the path its bundle lives at on route.upstream (an https origin, e.g.
      # GitHub Pages). The vhost is gated by the shared edge_auth import above (bearer or
      # Authelia, anonymous -> Authelia), so this block only maps the path: the rewrite runs
      # inside a `handle` (forced below), i.e. AFTER the site-level forward_auth, which
      # therefore sees the original URI. Absent serve_path: nothing here changes.
      servePath = (route.web or {}).serve_path or null;
      hasServePath = servePath != null;
      servePrefix = if hasServePath then lib.removeSuffix "/" servePath else "";
      serveHost = if hasServePath then lib.removePrefix "https://" route.upstream else "";

      proxyBlock =
        if hasServePath then
          ''    rewrite * ${servePrefix}{uri}
    reverse_proxy ${route.upstream} {
        header_up Host ${serveHost}
        header_up X-Real-IP {http.request.remote.host}
      }''
        else if isNoAuth && hasTlsSkipVerify then
          ''    reverse_proxy https://${route.upstream} {
        header_up X-Real-IP {http.request.remote.host}
        transport http {
      tls_insecure_skip_verify
    }
      }''
        else if isNoAuth then
          ''    reverse_proxy ${route.upstream} {
        header_up X-Real-IP {http.request.remote.host}
      }''
        else if hasTlsServerName && hasTimeout then
          mkProtectedCustom upstreamUrl ''
        transport http {
          tls
          tls_server_name ${tlsServerName}
          read_timeout ${route.timeout}
          write_timeout ${route.timeout}
        }''
        else if hasTlsServerName then
          mkProtectedCustom upstreamUrl ''
        transport http {
          tls
          tls_server_name ${tlsServerName}
        }''
        else if hasTlsSkipVerify && hasTimeout then
          mkProtectedCustom upstreamUrl ''
        transport http {
          tls_insecure_skip_verify
          read_timeout ${route.timeout}
          write_timeout ${route.timeout}
        }''
        else if hasTlsSkipVerify then
          mkProtectedCustom upstreamUrl ''
        transport http {
          tls_insecure_skip_verify
        }''
        else if hasTimeout then
          mkProtectedCustom route.upstream ''
        transport http {
          read_timeout ${route.timeout}
          write_timeout ${route.timeout}
        }''
        else mkProtected route.upstream;

      landingBlock = if hasLandingPage then ''
      # Root path → landing page (proxied, keeps our domain)
      @root path =/
      handle @root {
        ${mkGithubProxy route.landing_page}
      }

      # All other paths → auth + upstream'' else "";

      bypassBlock = if hasBypassPaths then
        lib.concatMapStringsSep "\n" (p: ''
      handle ${p} {
        reverse_proxy ${route.upstream}
      }'') route.bypass_paths
      else "";

      # Paths that must stay reachable off-mesh even on a wg_only vhost. Two
      # sources, same requirement: well-known grafts (public per spec) and
      # bypass_paths (declared auth-skip endpoints — mobile-app login, OAuth
      # callbacks, and the auth vhost's own public OIDC machine endpoints).
      # The WG gate's `respond` is ordered before every `handle`, so on a
      # wg_only route BOTH were dead code off-mesh unless the path is exempted
      # from the @not_wg matcher itself — e.g. RFC 8620 JMAP discovery answered
      # 403, and every bypass_paths on a wg_only route (chat /api/v4/*,
      # playlist OAuth callbacks) was silently unreachable off-mesh despite
      # being declared as a public bypass. Exempting them is what makes those
      # declarations do what they say; every other path stays gated.
      wgExemptPaths = (map (wk: wk.path) matchingWellKnown)
                      ++ (if hasBypassPaths then route.bypass_paths else []);
      # client_cert (vault, #1117): the route also accepts a per-device mTLS client
      # certificate. verify_if_given REJECTS an invalid certificate at the handshake,
      # so a non-empty verified subject is proof of a chain-valid fleet client cert and
      # lifts the source-IP gate. No cert = the original mesh-only 403. There is no
      # source-country gate in this Caddy, so "cert bypasses the geo-fence" holds by
      # construction (the only source gate is @not_wg).
      clientCaDer = route.client_ca_der or [];
      hasClientCert = isWgOnly && clientCaDer != [];
      certCond = if hasClientCert then "\n        expression `{http.request.tls.client.subject} == \"\"`" else "";
      tlsClientBlock = if hasClientCert then ''
      tls {
        client_auth {
          mode verify_if_given
          trust_pool inline {
            ${lib.concatMapStringsSep "\n            " (c: "trust_der ${c}") clientCaDer}
          }
        }
      }'' else "";
      wgBlock = if isWgOnly && (wgExemptPaths != [] || hasClientCert) then ''
      @not_wg {
        not remote_ip ${wgCidrs}${if wgExemptPaths != [] then "\n        not path ${lib.concatStringsSep " " wgExemptPaths}" else ""}${certCond}
      }
      error @not_wg "Forbidden" 403''
      else if isWgOnly then ''
      @not_wg not remote_ip ${wgCidrs}
      error @not_wg "Forbidden" 403'' else "";

      # Static JSON at GET / — used when the upstream's runtime response
      # leaks internal details (e.g. Stalwart JMAP Session baking :2443 into
      # apiUrl). We declare the override in service build.json under
      # proxy.primary.root_response_json; Caddy emits `handle /` with the
      # JSON serialised verbatim via Caddy's backtick `respond` body form.
      # All other paths still hit the reverse_proxy upstream.
      hasRootJson = (route.root_response_json or null) != null;
      rootJsonBlock = if hasRootJson then ''
      @root_get_only method GET HEAD
      handle @root_get_only {
        @root_path path /
        handle @root_path {
          header Content-Type application/json
          respond `${builtins.toJSON route.root_response_json}` 200
        }
      }'' else "";

      # well_known graft — any service may declare `proxy.well_known[]` with
      # `target_domain` matching this proxy route's domain. The aggregator in
      # cloud-data-config-derive.ts collects them into `well_known_routes`; we
      # filter by target_domain and emit per-path handlers BEFORE the catch-all
      # reverse_proxy. Mirrors mkGithubPagesRoute's existing behaviour so the
      # mechanism is symmetric across every Caddy route flavour.
      proxyDomains = lib.splitString ", " route.domain;
      matchingWellKnown = builtins.filter
        (wk: builtins.elem wk.target_domain proxyDomains)
        wellKnownRoutes;
      wellKnownBlock = lib.concatMapStringsSep "\n" mkWellKnownBlock matchingWellKnown;

      # When well_known handlers are emitted, the catch-all proxyBlock
      # MUST be wrapped in a `handle { }` block. In Caddy v2, mixing
      # bare directives (`reverse_proxy …`) with `handle` blocks at the
      # same site-block level lets the bare directive win for the
      # catch-all match — including the exact `/` path the well_known
      # `handle / { redir 308 }` is supposed to intercept. Symptom:
      # https://jmap.diegonmarcos.com/ returned Stalwart's JSON 404
      # instead of the declared 308 redirect to /.well-known/jmap.
      # Mirrors the existing mkGithubPagesRoute behaviour (lines 414-419)
      # so the wrap is symmetric across every Caddy route flavour.
      # WG-only routes must ALSO handle-wrap the proxy. The `@not_wg respond
      # 403` guard (wgBlock) relies on the global `order respond before handle`
      # so it pre-empts `handle` blocks — but NOT a bare `reverse_proxy` (the
      # auth:none branch, e.g. vault). Wrapping guarantees the guard fires
      # before the proxy for non-WG clients regardless of auth mode.
      wrappedProxyBlock = if (wellKnownBlock != "" || isWgOnly || hasServePath) then ''
      handle {
        ${proxyBlock}
      }'' else proxyBlock;

    in ''
    # ${route.comment or route.domain}
    ${siteDomain} {
  ${publicBindLine}
  ${secLine}${uploadBlock}${(identityOf route).siteStrip}
  ${gateLine}
  ${tlsClientBlock}
  ${wgBlock}
  ${ssoBlock}${bypassBlock}${landingBlock}
  ${rootJsonBlock}
  ${wellKnownBlock}
      ${wrappedProxyBlock}
      ${handleErrors}
    }
  '';

  wellKnownRoutes = caddyRoutes.well_known_routes or [];

  mkWellKnownBlock = wk:
    let
      hasRedirect = (wk.redirect_to or null) != null;
      hasTlsSkipVerify = wk.tls_skip_verify or false;
      proxyDirective =
        if hasRedirect then
          # Permanent 308 — preserves method + body, avoids client surprise
          # on POST/PUT. Spec-friendly for /.well-known autoconfig.
          # Explicit `${wk.path}` matcher disambiguates Caddy's parser: the
          # 2-arg form `redir /.well-known/jmap 308` is parsed as
          # `<matcher=/.well-known/jmap> <to=308>` (because the first arg
          # starts with `/`), so the matcher never fires on `/` and the
          # directive is a no-op (empty 200). The 3-arg form
          # `redir / /.well-known/jmap 308` parses unambiguously as
          # `<matcher=/> <to=/.well-known/jmap> <code=308>`.
          "        redir ${wk.path} ${wk.redirect_to} 308"
        else if hasTlsSkipVerify then ''
          reverse_proxy https://${wk.upstream} {
            transport http {
              tls_insecure_skip_verify
            }
          }'' else "        reverse_proxy ${wk.upstream}";
      # Optional INTERNAL rewrite before proxying. Why this exists: Stalwart
      # answers /.well-known/jmap with a 307 whose Location is RELATIVE
      # (`/jmap/session`). That is legal — RFC 8620 lets the session resource
      # redirect — but a client that mishandles relative Locations reports
      # "EndpointNotFoundException: Unable to fetch session object" and the
      # account simply never connects (Cloud-Mail, 2026-09-01). Rewriting here
      # serves the session AT the discovery URL, so no client has to follow
      # anything. Fixes every JMAP client at once instead of patching one.
      rewriteLine = if (wk.rewrite_to or null) != null
        then "        rewrite * ${wk.rewrite_to}\n" else "";
    in ''
      # ${wk.comment or wk.path} (well-known — public per spec)
      handle ${wk.path} {
  ${rewriteLine}${proxyDirective}
      }'';

  mkGithubPagesRoute = route:
    let
      hasWkd = route.wkd or false;
      routeDomains = lib.splitString ", " route.domain;
      matchingWellKnown = builtins.filter (wk: builtins.elem wk.target_domain routeDomains) wellKnownRoutes;
      wellKnownBlocks = lib.concatMapStringsSep "\n" mkWellKnownBlock matchingWellKnown;

      wkdBlock = if hasWkd then ''
      # WKD — PGP public key discovery (no auth — must be public per spec)
      handle_path /.well-known/openpgpkey/* {
        root * /srv/wkd
        file_server
      }
  ${wellKnownBlocks}
      handle {
        ${mkGithubProxy route.github_path}
      }'' else if wellKnownBlocks != "" then ''
  ${wellKnownBlocks}
      handle {
        ${mkGithubProxy route.github_path}
      }'' else "    ${mkGithubProxy route.github_path}";
    in ''
    # ${route.comment or route.domain}
    ${route.domain} {
  ${publicBindLine}
  ${sec}
  ${ea.gate route.domain}
  ${wkdBlock}
      ${handleErrors}
    }
  '';

  # #1450: legacy path rewrites (old API names -> renamed), one release. The files live in the
  # containers repo (_rebrand-1450/) and are included, verbatim, in the matching site block.
  legacyRedirectsApi = builtins.readFile ../../_rebrand-1450/caddy-legacy-redirects.caddy;
  legacyRedirectsPvt = builtins.readFile ../../_rebrand-1450/caddy-legacy-redirects-pvt.caddy;
  indentLines = text: lib.concatMapStringsSep "\n" (l: if l == "" then l else "    " + l) (lib.splitString "\n" (lib.removeSuffix "\n" text));
  legacyRedirectsFor = domain:
    if domain == "api.diegonmarcos.com" then (indentLines (lib.concatStringsSep "\n" (lib.filter (l: !(lib.hasPrefix "# handle" l)) (lib.splitString "\n" legacyRedirectsApi))) + "\n")
    else "";

  mcpHosts = map (g: g.parent_domain) (caddyRoutes.mcp_routes or []);

  # #1450: parts = { blocks (the handle blocks of the group); site (the standalone site) }, so a
  # REST path group declared on an MCP host (mcp.diegonmarcos.com/cloudy-browser-headless) can be
  # merged into that host's single site block. Two site blocks for one host fail `caddy adapt`.
  mkPathRouteParts = group:
    let
      hasLandingPage = (group.landing_page or null) != null;
      hasFallback = (group.fallback or null) != null;

      mkPathEntry = path:
        let
          isGithubPages = (path.type or null) == "github_pages";
          hasRedirectBare = path.redirect_bare or false;
          hasPublicPaths = (path.public_paths or null) != null;
          # Fail-closed: WG-only unless build.json set wg_only:false (derive default).
          # Gate is applied INSIDE each handle/handle_path so the 403 catch-all is
          # path-scoped and never swallows sibling routes in the shared site block.
          # public_paths are gated too (the "gate everything" decision).
          # Absent wg_only means PUBLIC (derive omits it for public). Default false.
          isWg = path.wg_only or false;

          redirectBlock = if hasRedirectBare then ''
      @${builtins.replaceStrings ["/"] [""] path.base_path}_bare path ${path.base_path}
      handle @${builtins.replaceStrings ["/"] [""] path.base_path}_bare {
        redir {path}/ permanent
      }
  '' else "";

          publicPathsBlock = if hasPublicPaths then
            lib.concatMapStringsSep "\n" (pp: ''
      handle ${pp} {
        ${wgGateBody isWg ''uri strip_prefix ${path.base_path}
        reverse_proxy ${path.upstream}''}
      }'') path.public_paths
          else "";

          mainBlock =
            if isGithubPages then ''
      handle_path ${path.base_path}/* {
        ${wgGateBody isWg ''rewrite * /${path.github_path}/{path}
        reverse_proxy https://diegonmarcos.github.io {
          header_up Host diegonmarcos.github.io
        }''}
      }''
            else ''
      handle_path ${path.base_path}/* {
        ${wgGateBody isWg (mkProtected path.upstream)}
      }'';

        in "${redirectBlock}${publicPathsBlock}\n${mainBlock}";

      activePaths = builtins.filter (p: p ? upstream || (p.type or null) == "github_pages") group.paths;
      pathBlocks = lib.concatMapStringsSep "\n" mkPathEntry activePaths;

      landingRootBlock = if hasLandingPage then ''
      @root path =/
      handle @root {
        ${mkGithubProxy group.landing_page}
      }
  '' else "";

      fallbackBlock = if hasFallback then ''
      handle {
        ${group.fallback}
      }'' else if hasLandingPage then ''
      handle {
        ${mkGithubProxy group.landing_page}
      }'' else "";

      siteText = ''
    # ${group.comment or group.parent_domain}
    ${group.parent_domain} {
  ${publicBindLine}
  ${sec}
  ${ea.gate group.parent_domain}
  ${legacyRedirectsFor group.parent_domain}${landingRootBlock}${pathBlocks}
  ${fallbackBlock}
      ${handleErrors}
    }
  '';
    in { blocks = pathBlocks; site = siteText; };

  mkPathRouteGroup = group: (mkPathRouteParts group).site;

  mkMcpRouteGroup = group:
    let
      mkEndpoint = ep:
        let
          proxyBody = ''reverse_proxy ${ep.upstream} {
          flush_interval -1
          header_up X-Real-IP {http.request.remote.host}
          header_up Accept "application/json, text/event-stream"
        }'';
          # Per-endpoint gate. Three shapes, in increasing openness:
          #
          #  1. bearer_auth  — WG peers pass straight through; everyone else must
          #     present `Authorization: Bearer <token>`, which is verified by
          #     forward_auth against the introspection upstream (Authelia-issued
          #     OIDC access tokens). Anything else is 403. This is the ONLY way an
          #     MCP endpoint is reachable off-mesh: an agent outside WireGuard
          #     (a container, CI, Claude Code on the web) can hold a token, and a
          #     random caller cannot.
          #
          #     Note the bearer branch does NOT fall back to the Authelia browser
          #     flow the way mkProtected does. An MCP client speaks JSON-RPC over
          #     Streamable HTTP and cannot follow a login redirect — a 302 to
          #     auth.diegonmarcos.com would surface as an opaque parse error, so
          #     a missing/!valid token is a clean 403 instead.
          #
          #  2. wg_only      — WG peers only, 403 for everyone else.
          #  3. neither      — fully public. The MCP hub itself emits no auth, so
          #     a bare proxy really is open to the internet.
          #
          # Each shape is a `handle` chain, never a bare matcher: handles are
          # source-order first-match-wins, so the deny cannot be reordered around.
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
          error "Forbidden" 403
        }'';
          wgGate = ''@wg remote_ip ${wgCidrs}
        handle @wg {
          ${proxyBody}
        }
        handle {
          error "Forbidden" 403
        }'';
          inner = if (ep.bearer_auth or false) then bearerGate
                  else if (ep.wg_only or false) then wgGate
                  else proxyBody;
        in ''
      handle_path ${ep.base_path}/* {
        ${inner}
      }'';
      # #1450: REST path groups declared on this same host (cloudy-browser-headless) join this site.
      mergedPathBlocks = lib.concatMapStringsSep "\n" (g: (mkPathRouteParts g).blocks)
        (lib.filter (g: g.parent_domain == group.parent_domain) caddyRoutes.path_routes);
      endpointBlocks = (lib.concatMapStringsSep "\n" mkEndpoint group.endpoints) + "\n" + mergedPathBlocks;
      fallbackMsg = group.fallback_message or "MCP Hub";
    in ''
    # ${group.comment or group.parent_domain}
    ${group.parent_domain} {
  ${publicBindLine}
  ${secMcp}
  ${ea.gateOff group.parent_domain}
  ${mo.block group.parent_domain}
  ${endpointBlocks}
      handle {
        respond "${fallbackMsg}" 200
      }
      ${handleErrors}
    }
  '';

  # Redirect hosts (mail. -> webmail., capital-stack-finterminal-api. -> c3-pvt path) sit BEHIND the shared gate
  # (owner ruling 2026-10-29, ticket #1292): a browser without a session is sent to sign-in
  # (sso.), a fleet bearer is introspected, and only then does the 308 run. No machine
  # endpoint lives on these two hosts (IMAP/SMTP are L4 on imap./smtps., JMAP discovery
  # is on mails. and the apex well-known), so no exemption path is declared.
  mkRedirectRoute = route: ''
    # ${route.comment or route.domain}
    ${route.domain} {
  ${publicBindLine}
  ${sec}
  ${ea.gate route.domain}
      handle {
        redir ${route.target} 308
      }
      ${handleErrors}
    }
  '';

  # ── Routing tiers (ticket #1104; declaration: _shared/fleet-addressing.json `tiers`) ──
  # pvt : ONE site, c3-pvt.diegonmarcos.com/{container}, behind the shared edge_auth gate
  #       (Authelia session cookie for web, fleet bearer for API/MCP clients). The path is
  #       the route's `container`; handle_path strips it, so the upstream sees its own root.
  #       One site with N small handles replaces N sites that each carried the full gate.
  # pub : ONE site, c3-pub.diegonmarcos.com (Cloudflare proxied), no gate, explicit
  #       allowlist only; every other path is a 404 and reaches no upstream.
  fa = builtins.fromJSON (builtins.readFile ../../_shared/fleet-addressing.json);
  c3PvtHost = fa.tiers.pvt.host;
  c3PubHost = fa.tiers.pub.host;

  # The IdP is never mounted under a path (cookie domain, OIDC issuer); the empty-body guard is
  # NOT inlined per handle (45 copies is the 2026-10-22 OOM shape); API clients see upstream errors as-is.
  c3PvtExcluded = [ "authelia" ];
  c3PvtRoutes = lib.attrValues (lib.listToAttrs (map (r: lib.nameValuePair r.container r)
    (lib.filter (r: (r.container or null) != null && !(r.landing_only or false) && !(builtins.elem r.container c3PvtExcluded)) caddyRoutes.routes)));

  mkC3PvtHandle = r: let
    flush = if lib.hasSuffix "-mcp" r.container then "        flush_interval -1\n" else "";
  in ''
      handle_path /${r.container}/* {
        reverse_proxy ${r.upstream} {
          header_up X-Real-IP {http.request.remote.host}
${flush}        }
      }'';

  # #1450: the AI gateway answers on ONE public prefix, /ai/{tokens,embeddings,agents,claude,memory},
  # behind the same shared gate (cookie or bearer) as every other c3-pvt container path.
  c3PvtAliases = [ { path = "/ai"; container = "cloudy-ai-api"; } ];
  c3PvtAliasHandles = lib.concatMapStringsSep "\n" (a:
    let r = lib.findFirst (x: x.container == a.container) null c3PvtRoutes;
    in if r == null then throw "c3-pvt alias ${a.path}: no route for container ${a.container}"
       else ''
      handle_path ${a.path}/* {
        reverse_proxy ${r.upstream} {
          header_up X-Real-IP {http.request.remote.host}
        }
      }'') c3PvtAliases;

  mkC3PvtSite = ''
    # Routing tier pvt (#1104): path per container behind the shared gate (cookie or bearer)
    ${c3PvtHost} {
  ${publicBindLine}
  ${sec}
  ${ea.gate c3PvtHost}
${indentLines legacyRedirectsPvt}
${lib.concatMapStringsSep "\n" mkC3PvtHandle c3PvtRoutes}
${c3PvtAliasHandles}
      handle {
        error "Not Found" 404
      }
      ${handleErrors}
    }
  '';

  mkC3PubSite = let
    an = caddyRoutes.special.analytics;
    jmap = lib.filter (wk: wk.target_domain == "jmap.diegonmarcos.com" && wk.path == "/.well-known/jmap") wellKnownRoutes;
    trk = lib.concatMapStringsSep " " (p: "/analytics-api" + p) an.public_tracking_paths;
    mkPortal = path: to: ''
      handle ${path} {
        redir ${to}/ 302
      }'';
  in ''
    # Routing tier pub (#1104): Cloudflare-proxied, no gate, explicit allowlist (fleet-addressing.json tiers.pub)
    ${c3PubHost} {
  ${publicBindLine}
  ${sec}
      handle /health {
        respond "ok" 200
      }
${lib.concatStringsSep "\n" (lib.mapAttrsToList mkPortal fa.tiers.pub.portals)}
${lib.concatMapStringsSep "\n" mkWellKnownBlock jmap}
      @c3pub_matomo path ${trk}
      handle @c3pub_matomo {
        uri strip_prefix /analytics-api
        reverse_proxy ${an.matomo_upstream}
      }
      @c3pub_umami path /analytics-api/umami/script.js /analytics-api/umami/api/send
      handle @c3pub_umami {
        uri strip_prefix /analytics-api/umami
        reverse_proxy ${an.umami_upstream}
      }
${lib.concatStringsSep "\n" (lib.mapAttrsToList mkPubSink (lib.filterAttrs (n: _: !(lib.hasPrefix "_" n)) (fa.tiers.pub.sinks or {})))}
      handle {
        error "Not Found" 404
      }
      ${handleErrors}
    }
  '';

  # c3-pub write-only sinks (fleet-addressing.json tiers.pub.sinks): a public path forwarded to one c3-pvt
  # container under a fixed rewrite prefix, e.g. the app log sink to c3-public-api /analytics/openobserve.
  # The matcher takes BOTH the bare path and the subtree: the app clients post to the bare URL
  # (https://c3-pub.../analytics-api/openobserve) and `handle <path>/*` alone left that 404 (#1104).
  mkPubSink = path: sink: let
    route = lib.findFirst (r: r.container == sink.container) null c3PvtRoutes;
    base = lib.removeSuffix "/*" path;
  in if route == null then throw "tiers.pub.sinks ${path}: container ${sink.container} is not a c3-pvt route" else ''
      @pubsink_${lib.replaceStrings [ "/" "-" "." "*" ] [ "_" "_" "_" "" ] base} path ${base} ${path}
      handle @pubsink_${lib.replaceStrings [ "/" "-" "." "*" ] [ "_" "_" "_" "" ] base} {
        # One path substitution serves the bare path and the subtree: <base> -> <rewrite_prefix>. strip_prefix + rewrite
        # (#1104) turned the bare path into "/" and the upstream (exact prefix proxy) answered 404 on the trailing slash.
        uri path_regexp ^${base} ${sink.rewrite_prefix}
        reverse_proxy ${route.upstream}
      }'';

  # ── Special route generators ──
  mkMailBlock =
    let mail = caddyRoutes.special.mail or null;
    in if mail == null then ""
    else let
      mkMailPath = path:
        let
          isStatic = (path.type or null) == "static";
          isNoAuth = (path.auth or null) == "none";
          hasTlsSkipVerify = path.tls_skip_verify or false;
          hasAssetPaths = (path.asset_paths or null) != null;

          proxyBlock =
            if isNoAuth && hasTlsSkipVerify then
              ''reverse_proxy https://${path.upstream} {
            transport http {
              tls_insecure_skip_verify
            }
          }''
            else if isNoAuth then
              "reverse_proxy ${path.upstream}"
            else
              mkProtected path.upstream;

          mainBlock =
            if isStatic then ''
      # ${path.comment or path.base_path} (static)
      handle ${path.base_path}/config {
        root * /srv/mail
        rewrite * /servermail-config.html
        file_server
      }
      handle ${path.base_path}* {
        root * /srv/mail
        rewrite * /servermail.html
        file_server
      }''
            else ''
      # ${path.comment or path.base_path}
      handle_path ${path.base_path}/* {
        ${proxyBlock}
      }
      handle_path ${path.base_path} {
        ${proxyBlock}
      }'';

          assetBlocks = if hasAssetPaths then
            lib.concatMapStringsSep "\n" (ap: ''
      handle ${ap}/* {
        ${proxyBlock}
      }'') path.asset_paths
          else "";

        in "${mainBlock}\n${assetBlocks}";

      pathBlocks = lib.concatMapStringsSep "\n" mkMailPath (mail.paths or []);
    in ''
    # ${mail.comment or "mail"}
    ${mail.domain} {
  ${publicBindLine}
  ${sec}
      ${ea.gate mail.domain}
      @root path =/
      handle @root {
        ${mkGithubProxy mail.landing_page}
      }

  ${pathBlocks}

      handle {
        ${mkGithubProxy mail.landing_page}
      }

      ${handleErrors}
    }
  '';

  mkNtfyBlock =
    let
      ntfy          = caddyRoutes.special.ntfy or null;
      gatewayUp     = if ntfy != null then ntfy.gateway_upstream or null else null;
      hasGateway    = gatewayUp != null;
      feedNoAuth    = (ntfy.feed_auth or "") == "none";
      # /feed* is served by the rss-gateway sidecar. Default: same 3-tier auth as
      # the main ntfy block (JWT / ntfy-token / cookie). When feed_auth=="none"
      # (wg0-only sites): bare reverse_proxy — on-mesh is the only way in, so
      # Cloud Mail polls the RSS tree without a token.
      gatewayBlock  = if !hasGateway then ""
        else if feedNoAuth then ''
      handle /feed* {
        reverse_proxy ${gatewayUp}
      }
''      else ''
      handle /feed* {
        @gw_jwt header_regexp Authorization "${auth.ntfy_jwt_pattern}"
        handle @gw_jwt {
  ${bearer}
          reverse_proxy ${gatewayUp}
        }
        @gw_token header_regexp Authorization "${auth.ntfy_token_pattern}"
        handle @gw_token {
          reverse_proxy ${gatewayUp}
        }
        handle {
  ${authelia}
          reverse_proxy ${gatewayUp}
        }
      }
'';
    in if ntfy == null then ""
    # Safety: serving /feed/* with no auth is only sound when the whole site is
    # wg0-gated — otherwise the RSS tree would be world-readable. Fail eval.
    else assert (!feedNoAuth) || (ntfy.wg_only or false);
    ''
    # ${ntfy.comment or "ntfy"}
    ${ntfy.domain} {
  ${publicBindLine}
  ${sec}
      ${if (ntfy.wg_only or false) then "" else ea.gate ntfy.domain}
      ${wgSiteLine (ntfy.wg_only or false)}
      handle /setup {
  ${authelia}
        root * /srv
        rewrite * /ntfy-setup.html
        file_server
      }
      ${gatewayBlock}
      @authelia_jwt header_regexp Authorization "${auth.ntfy_jwt_pattern}"
      handle @authelia_jwt {
  ${bearer}
        reverse_proxy ${ntfy.upstream}
      }
      @ntfy_token header_regexp Authorization "${auth.ntfy_token_pattern}"
      handle @ntfy_token {
        reverse_proxy ${ntfy.upstream}
      }
      handle {
  ${authelia}
        reverse_proxy ${ntfy.upstream}
      }
      ${handleErrors}
    }
  '';

  mkAnalyticsBlock =
    let a = caddyRoutes.special.analytics or null;
    in if a == null then ""
    else let
      trackingPaths = lib.concatStringsSep " " a.public_tracking_paths;
      umamiPublicPaths = lib.concatStringsSep " " a.umami_public_paths;
    in ''
    # ${a.comment or "Analytics"}
    ${a.domain} {
  ${publicBindLine}
  ${sec}
      ${ea.gate a.domain}
      @tracking {
        path ${trackingPaths}
      }
      handle @tracking {
        reverse_proxy ${a.matomo_upstream}
      }

      @umami_public {
        path ${umamiPublicPaths}
      }
      handle @umami_public {
        uri strip_prefix /umami
        reverse_proxy ${a.umami_upstream}
      }
      handle_path /umami/* {
        @umami_bearer header Authorization Bearer*
        handle @umami_bearer {
  ${bearer}
          reverse_proxy ${a.umami_upstream}
        }
        handle {
  ${authelia}
          reverse_proxy ${a.umami_upstream}
        }
      }
      @umami_root path /umami
      handle @umami_root {
        redir /umami/ permanent
      }

      ${mkProtected a.matomo_upstream}

      ${handleErrors}
    }
  '';

  mkProxyDashboardBlock =
    let pd = caddyRoutes.special.proxy_dashboard or null;
        # When auth=="none" (WG-only sites), serve static files directly —
        # the WG network is the auth boundary, mirroring ntfy feed_auth:"none".
        isNoAuth = (pd.auth or "") == "none";
        dashboardServe = ''
        root * /srv
        rewrite * /dashboard.html
        file_server'';
    in if pd == null then ""
    else ''
    # ${pd.comment or "Proxy dashboard"}
    ${pd.domain} {
  ${publicBindLine}
  ${sec}
      ${if (pd.wg_only or false) then "" else ea.gate pd.domain}
      ${wgSiteLine (pd.wg_only or false)}
      ${if isNoAuth then dashboardServe else ''
      @bearer header Authorization Bearer*
      handle @bearer {
  ${bearer}
        ${dashboardServe}
      }
      handle {
  ${authelia}
        ${dashboardServe}
      }''}
      ${handleErrors}
    }
  '';

  # ── Internal / canonical / portless / S3 / DB-placeholder routes ──
  internalTpl   = readTpl "30-internal-route.caddy.tpl";
  canonicalTpl  = readTpl "31-canonical-app.caddy.tpl";
  portlessTpl   = readTpl "32-portless-app.caddy.tpl";
  dbTpl         = readTpl "33-db-placeholder.caddy.tpl";
  s3Tpl         = readTpl "34-s3-route.caddy.tpl";

  # ── Private mesh names: cloud.<name>.mesh.diegonmarcos.com (docs: url-scheme.md) ──
  # Rendered as their OWN site blocks. Each one is gated to the WG mesh plus
  # same-host docker/loopback sources: wg-public (10.1.0.0/24, the public
  # edge) and every public address get 403, so a cloud.*.mesh.diegonmarcos.com name is never
  # served to the internet even if someone points a resolver at us.
  # #1123: the mesh namespace is <name>.mesh.diegonmarcos.com (a subdomain of the
  # owner's domain, served only by fleet DNS). The public .app TLD alias is gone
  # (owner decision, no transition): every declared name already is a mesh name.
  withMesh = s: s;
  meshOnlySources = "${wgCidrs} 172.16.0.0/12 127.0.0.0/8 ::1/128";
  mkPrivateMeshRoute = e: ''
  ${withMesh e.service} {
${publicBindLine}
    tls {
      issuer internal {
        ca mesh
      }
    }
    @not_mesh not remote_ip ${meshOnlySources}
    error @not_mesh "Forbidden" 403
    handle {
      reverse_proxy ${e.upstream} {
${emptyGuard}
      }
    }
${handleErrors}
  }
'';
  privateMeshRoutes = caddyRoutes.private_mesh_routes or [];

  mkInternalRoute = route: subst {
    "@MESH_GUARD@"       = meshGuard;
    "@SERVICE@"          = withMesh route.service;
    "@UPSTREAM@"         = route.upstream;
    "@EMPTY_GUARD@"      = emptyGuard;
    "@HANDLE_ERRORS@"    = handleErrors;
    "@PUBLIC_BIND_LINE@" = publicBindLine;
  } internalTpl;

  mkS3Route = route: subst {
    "@MESH_GUARD@"       = meshGuard;
    "@SERVICE@"          = withMesh route.service;
    "@BUCKET@"           = route.bucket;
    "@S3_ENDPOINT@"      = route.s3_endpoint;
    "@S3_HOST@"          = route.s3_host;
    "@PUBLIC_BIND_LINE@" = publicBindLine;
  } s3Tpl;

  mkCanonicalAppRoute = entry: subst {
    "@MESH_GUARD@"       = meshGuard;
    "@SERVICE@"          = withMesh entry.service;
    "@UPSTREAM@"         = entry.upstream;
    "@EMPTY_GUARD@"      = emptyGuard;
    "@HANDLE_ERRORS@"    = handleErrors;
    "@PUBLIC_BIND_LINE@" = publicBindLine;
  } canonicalTpl;

  msgs = caddyRoutes.messages or {};
  mkPortlessAppRoute = entry: subst {
    "@MESH_GUARD@"       = meshGuard;
    "@SERVICE@"          = withMesh entry.service;
    "@PLACEHOLDER_MSG@"  = msgs.portless_placeholder;
    "@PUBLIC_BIND_LINE@" = publicBindLine;
  } portlessTpl;

  canonicalHttpEntries = lib.filter
    (e: e.kind == "canonical" && (e.protocol == "http" || e.protocol == "https"))
    (caddyRoutes.all_app_urls or []);

  portlessEntries = lib.filter
    (e: e.kind == "portless")
    (caddyRoutes.all_app_urls or []);

  internalRouteNames =
    let names = map (r: r.service) (caddyRoutes.internal_routes or []);
    in lib.genAttrs names (_: true);

  dedupedCanonicals = lib.filter
    (e: !(internalRouteNames.${e.service} or false))
    canonicalHttpEntries;

  dedupedPortless = lib.filter
    (e: !(internalRouteNames.${e.service} or false))
    portlessEntries;

  dbCatalogEntries = caddyRoutes.all_db_urls or [];

  mkDbPlaceholderRoute = e: subst {
    "@MESH_GUARD@"       = meshGuard;
    "@SERVICE@"          = e.service;
    "@CONTAINER@"        = e.container or "?";
    "@ENGINE@"           = e.engine or "?";
    "@PORT@"             = toString (e.port or 0);
    "@UPSTREAM@"         = e.upstream or "(embedded)";
    "@DB_PATH@"          = e.path or "-";
    "@VM@"               = e.vm or "-";
    "@PUBLIC_BIND_LINE@" = publicBindLine;
  } dbTpl;

  global = caddyRoutes.global or {};
  odt    = caddyRoutes.on_demand_tls or {};

  # ── Globals block (assembled from 00-globals.caddy.tpl) ──
  globalsBlock = subst {
    "@DEBUG_LINE@"  = if (global.debug or false) then "debug" else "";
    "@ADMIN_BIND@"  = global.admin_bind;
    "@ORDER@"       = global.order;
    "@AUTO_HTTPS@"  = global.auto_https;
    "@ODT_ASK_URL@" = odt.ask_url;
    "@L4_SECTION@"  = mkL4Section;
  } (readTpl "00-globals.caddy.tpl");

  # ── On-demand TLS ask endpoint ──
  odtAskBlock = subst {
    "@ODT_ASK_PORT@"    = lib.elemAt (lib.splitString ":" odt.ask_bind) 1;
    "@ODT_ASK_BIND_IP@" = lib.elemAt (lib.splitString ":" odt.ask_bind) 0;
  } (readTpl "05-odt-ask.caddy.tpl");

  # ── MTA-STS ──
  mta = caddyRoutes.mta_sts or {};
  mtaMxLines = lib.concatMapStringsSep "\n" (m: "mx: ${m}") (mta.mx or []);
  mtaStsBlock = subst {
    "@MTA_DOMAIN@"      = mta.domain or "";
    "@PUBLIC_BIND_LINE@" = publicBindLine;
    "@SEC_NO_LIMIT@"    = secNoLimit;
    "@EDGE_GATE@"       = ea.gate (mta.domain or "");
    "@MTA_POLICY_PATH@" = mta.policy_path or "";
    "@MTA_MODE@"        = mta.mode or "";
    "@MTA_MX_LINES@"    = mtaMxLines;
    "@MTA_MAX_AGE@"     = toString (mta.max_age or 604800);
  } (readTpl "90-mta-sts.caddy.tpl");

  httpRedirectBlock = subst {
    "@WG_BIND_IP@" = wgBindIp;
  } (readTpl "91-http-redirect.caddy.tpl");

  # ── Catch-all ──
  catch = caddyRoutes.catch_all or {};
  catchPage = catch.page or "/srv/error.html";
  catchAllBlock = subst {
    "@CATCH_DOMAIN@"     = catch.domain or "";
    "@PUBLIC_BIND_LINE@" = publicBindLine;
    "@SEC_NO_LIMIT@"     = secNoLimit;
    "@EDGE_GATE@"        = ea.gate (catch.domain or "");
    "@CATCH_ROOT@"       = lib.removeSuffix ("/" + baseNameOf catchPage) catchPage;
    "@CATCH_FILE@"       = baseNameOf catchPage;
    "@CATCH_REDIRECT@"   = catch.redirect_to or "";
  } (readTpl (if (catch.redirect_to or null) != null then "99-catch-all-redirect.caddy.tpl" else "99-catch-all.caddy.tpl"));

in ''
${globalsBlock}
${odtAskBlock}

  ${edgeErrorPagesRoute}
  ${edgeErrorsSnippet}
  # ════════════════════════════════════════════════════════════
  # SECURITY SNIPPETS
  # ════════════════════════════════════════════════════════════

  ${securityHeaders}
  ${rateLimiting}
  ${rateLimitingMcp}
  ${rateLimitingJmap}
  ${blockBots}
  ${blockScanners}
  ${requestLimits}
  ${ipBlock}
  ${accessLog}
  ${securitySnippet}
  ${securityMcpSnippet}
  ${securityJmapSnippet}

  # ── Shared public-edge auth gate (see ea in caddyfile.nix / _shared/edge-auth.nix) ──
${ea.snippets}
  # ════════════════════════════════════════════════════════════
  # SUBDOMAIN ROUTES (from routes[])
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkSubdomainRoute caddyRoutes.routes}

  # ════════════════════════════════════════════════════════════
  # GITHUB PAGES PROXIES (from github_pages_proxies[])
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkGithubPagesRoute caddyRoutes.github_pages_proxies}

  # ════════════════════════════════════════════════════════════
  # PATH-BASED ROUTES (from path_routes[])
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkPathRouteGroup (lib.filter (g: !(builtins.elem g.parent_domain mcpHosts)) caddyRoutes.path_routes)}

  # ════════════════════════════════════════════════════════════
  # MCP ROUTES (from mcp_routes[])
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkMcpRouteGroup caddyRoutes.mcp_routes}

  # ════════════════════════════════════════════════════════════
  # REDIRECTS (from redirects[])
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkRedirectRoute (caddyRoutes.redirects or [])}

  # ════════════════════════════════════════════════════════════
  # SPECIAL ROUTES (from special{})
  # ════════════════════════════════════════════════════════════

${mkC3PvtSite}

${mkC3PubSite}

${mkMailBlock}

${mkAnalyticsBlock}

${mkNtfyBlock}

${mkProxyDashboardBlock}

  # ════════════════════════════════════════════════════════════
  # INTERNAL ROUTES — portless *.mesh.diegonmarcos.com via HTTP:80 on WireGuard
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkInternalRoute (caddyRoutes.internal_routes or [])}

  # ════════════════════════════════════════════════════════════
  # PRIVATE MESH NAMES — cloud.<name>.mesh.diegonmarcos.com (WG mesh only)
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkPrivateMeshRoute privateMeshRoutes}

  # ════════════════════════════════════════════════════════════
  # APP URL ALIASES — {container}-{protocol}-{port}.mesh.diegonmarcos.com canonical routes
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkCanonicalAppRoute dedupedCanonicals}

${lib.concatMapStringsSep "\n" mkPortlessAppRoute dedupedPortless}

  # ════════════════════════════════════════════════════════════
  # DB ZONE — {container}-{engine}-{port}.db HTTPS catalog endpoints
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkDbPlaceholderRoute dbCatalogEntries}

  # ════════════════════════════════════════════════════════════
  # S3 ROUTES — OCI Object Storage via mesh short names
  # ════════════════════════════════════════════════════════════

${lib.concatMapStringsSep "\n" mkS3Route (caddyRoutes.s3_routes or [])}

  # ════════════════════════════════════════════════════════════
  # MTA-STS — enforce TLS for inbound email delivery
  # ════════════════════════════════════════════════════════════

${mtaStsBlock}

  # ════════════════════════════════════════════════════════════
  # HTTP :80 → HTTPS 308 redirect (mesh bind only)
  # ════════════════════════════════════════════════════════════

${httpRedirectBlock}

  # ════════════════════════════════════════════════════════════
  # CATCH-ALL — data-driven from caddyRoutes.catch_all
  # ════════════════════════════════════════════════════════════

${catchAllBlock}
''
