# compose.nix — tokens-api (Go port), shadow stage of ticket #1877.
# Runs next to the Python cloudy-ai-tokens-api on oci-apps, on its own port (4188) with its own sqlite volume, outside every
# request path. Secrets are the Python service's own materialised env file (../cloudy-ai-tokens-api/.secrets), so no secret is
# copied or re-encrypted for the shadow. build.ship_hold keeps it out of the ship until #1898 is resolved.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    cloudy-ai-tokens-go-api = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      # distroless has no shell: the fresh named volume is root-owned, so the shadow runs as root inside its own
      # read-only container (no shell, no libc, one static binary).
      user = "0:0";
      read_only = true;
      command = [ bin "-listen" bind ];
      env_file = [ "../cloudy-ai-tokens-api/.secrets" ];
      environment = {
        DB_PATH          = "/data/tokens.sqlite3";
        OWNER_EMAIL      = "me@diegonmarcos.com";
        ADMIN_CLIENT_IDS = "cloud-admin";
        TRUSTED_PROXIES  = "10.0.0.1/32";
        INTROSPECT_URL   = "http://10.0.0.1:4182/auth";
      };
      volumes = [ "tokens_go_data:/data" ];
      healthcheck = {
        test = [ "CMD" bin "-healthcheck" "http://${bind}/health" ];
        interval     = "60s";
        timeout      = "30s";
        retries      = 3;
        start_period = "30s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
  volumes = {
    tokens_go_data = { };
  };
}
