# compose.nix — pure attrset describing docker-compose.yml for c3-public-go-api.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1882: the Go port runs beside the Node c3-public-api on the same host (oci-apps), own port (8097), own container name,
# outside every request path. The analytics backends, mail targets and limits are the SAME values the Node compose resolves from cloud-data;
# the shadow takes them from the declarations pinned below (BACKENDS_JSON/MAIL_TARGETS_JSON resolution from the services table is a
# switch-over step, so the shadow carries the primary mail target and the declared limits only).
{ buildJson, container }:

let
  svc  = container.services;
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
  pc   = buildJson.profile_connect;
  hostDir = "/home/ubuntu/git/cloud-vault/Shared/configs";
in
{
  services = {
    c3-public-go-api = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin ];
      environment = {
        HOST = buildJson.bind_host;
        PORT = toString buildJson.ports.app;
        BASE_PATH = "/c3-public-api";
        LIMITS_JSON = builtins.toJSON buildJson.limits;
        TZ = "Europe/Paris";
        SMTP_HELO_DOMAIN = buildJson.mail.helo_domain;
        PROFILE_CONNECT_MAIL_TO = pc.mail_to;
        PROFILE_CONNECT_MAIL_FROM = pc.mail_from;
        PROFILE_CONNECT_CODE_TTL_S = toString pc.code_ttl_s;
        PROFILE_CONNECT_RESEND_COOLDOWN_S = toString pc.resend_cooldown_s;
        PROFILE_CONNECT_MAX_ATTEMPTS = toString pc.max_attempts;
        PROFILE_CONNECT_BUNDLE_DIR = pc.bundle_mount;
        PROFILE_CONNECT_BUNDLE_FILE = pc.bundle_file;
        PROFILE_CONNECT_SCHEMA_FILE = pc.schema_file;
      };
      volumes = [ "${hostDir}:${pc.bundle_mount}:ro" ];
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "-healthcheck" "http://${bind}/health" ];
        interval     = "30s";
        timeout      = "10s";
        retries      = 3;
        start_period = "20s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
