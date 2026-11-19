# compose.nix — docker-compose spec for c3-public-api (Type A own-code)
# Runs on oci-apps (#1816; was oci-analytics), host-network, public via the edge Caddy at /c3-public-api/*.
# Reverse-proxies /analytics/* to matomo/umami/openobserve (resolved at build time
# from cloud-data, cross-VM via wg0). Bridges /mail/http-to-smtp (Bearer) to maddy
# on oci-mail (maddy's dual-write relays to stalwart) — same JSON-in/SMTP-out contract
# as the legacy aa-sui_tools-http-to-smtp-proxy-api Rust binary, so the CF Worker
# is unchanged.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";

  # Host WG IP for binding + healthcheck: the deploy.host's address from cloud-data.
  # svc."c3-public-api" appears once the derive engine has run. The safety-net
  # default is the oci-apps wg0 IP (#1816 moved it there from oci-analytics
  # 10.0.0.4) so the flake evaluates even before 9_others has emitted this entry.
  myIp = svc."c3-public-api".ip or "10.0.0.6";
  port = toString buildJson.ports.app;
  basePath = buildJson.proxy.primary.base_path;

  # Resolve analytics backend slugs -> URLs using cloud-data svc table.
  mkBackend = _slug: cfg:
    let s = svc.${cfg.service}; in {
      url = "http://${s.ip}:${toString s.ports.app}${cfg.rewrite_path}";
      service = cfg.service;
      methods = cfg.methods;
      auth_header_env = cfg.auth_header_env or null;
    };
  backends = builtins.mapAttrs mkBackend buildJson.backends;
  backendsJson = builtins.toJSON backends;
  limitsJson = builtins.toJSON buildJson.limits;

  # Mail target — primary (maddy). Resolved from build.json#mail.primary
  # which names a service + a port slug.
  mailPrimaryService = buildJson.mail.primary.service;
  mailPrimaryVia = buildJson.mail.primary.via;

  primarySvc = svc.${mailPrimaryService};

  # Resolve port slug -> port number against extra_ports (services own this
  # map keyed by port number with a `service` slug field).
  portForVia = svcEntry: via:
    let
      ports = svcEntry.extra_ports or {};
      matches = builtins.filter (k: (ports.${k}.service or "") == via) (builtins.attrNames ports);
    in if matches == [] then null else builtins.elemAt matches 0;

  primaryPort = portForVia primarySvc mailPrimaryVia;

  # #1811 named targets -> { host, port } for X-Mail-Target. A target whose
  # service or port slug is not (yet) in cloud-data is left OUT, so the bridge
  # answers 503 for it instead of the whole render failing; the CF Worker only
  # switches to the targets once they are live.
  resolveTarget = _name: t:
    let s = svc.${t.service} or null;
        p = if s == null then null else portForVia s t.via;
    in if p == null then null else { host = s.ip; port = builtins.fromJSON p; };
  resolvedTargets = builtins.mapAttrs resolveTarget (buildJson.mail.targets or {});
  mailTargets = builtins.listToAttrs (map (n: { name = n; value = resolvedTargets.${n}; })
    (builtins.filter (n: resolvedTargets.${n} != null) (builtins.attrNames resolvedTargets)));
  mailTargetsJson = builtins.toJSON mailTargets;

  # Profile ▸ Connect (#566) — every value from build.json#profile_connect.
  pc = buildJson.profile_connect;
in
{
  services = {
    c3-public-api = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      env_file = [ ".secrets" ];
      environment = {
        HOST = myIp;
        PORT = port;
        NODE_ENV = "production";
        BASE_PATH = basePath;
        # Analytics passthrough config (same shape as c3-analytics-api).
        BACKENDS_JSON = backendsJson;
        LIMITS_JSON = limitsJson;
        # Mail bridge config (replicates http-to-smtp-proxy-api contract).
        SMTP_HOST = primarySvc.ip;
        SMTP_PORT = primaryPort;
        MAIL_TARGETS_JSON = mailTargetsJson;
        SMTP_HELO_DOMAIN = buildJson.mail.helo_domain;
        # Profile ▸ Connect: bearer + mailed code → the plaintext profile bundle (#589).
        PROFILE_CONNECT_MAIL_TO = pc.mail_to;
        PROFILE_CONNECT_MAIL_FROM = pc.mail_from;
        PROFILE_CONNECT_CODE_TTL_S = toString pc.code_ttl_s;
        PROFILE_CONNECT_RESEND_COOLDOWN_S = toString pc.resend_cooldown_s;
        PROFILE_CONNECT_MAX_ATTEMPTS = toString pc.max_attempts;
        PROFILE_CONNECT_BUNDLE_DIR = pc.bundle_mount;
        PROFILE_CONNECT_BUNDLE_FILE = pc.bundle_file;
        PROFILE_CONNECT_SCHEMA_FILE = pc.schema_file;
      };
      volumes = [
        # Bundle (plaintext, #589) + schema only; read-only. The source is the
        # SAME entry the ship's step_host_sync fills (#586) — one declaration.
        "${buildJson.deploy.host_sync.profile_bundle.host_dir}:${pc.bundle_mount}:ro"
      ];
      healthcheck = {
        test = [
          "CMD-SHELL"
          "curl -fsS http://${myIp}:${port}/health >/dev/null 2>&1 || exit 1"
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "15s";
      };
      deploy.resources = {
        limits       = { memory = "192M"; cpus = "1.0"; };
        reservations = { memory = "48M"; };
      };
    };
  };
}
