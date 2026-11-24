# compose.nix — mcp-oauth (Go port), shadow stage of ticket #1877.
# Runs next to the Python mcp-oauth on gcp-proxy, on its own port (4189) with its own sqlite volume, outside every request
# path (Caddy still targets the Python container). Secrets are the Python service's own materialised env file
# (../mcp-oauth/.secrets: INTROSPECT_SECRET, FORM_SECRET). build.ship_hold keeps it out of the ship until #1898 is resolved:
# gcp-proxy is under memory pressure and must not get a second resident process before then.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    mcp-oauth-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      # distroless has no shell: the fresh named volume is root-owned, so the shadow runs as root inside its own
      # read-only container (no shell, no libc, one static binary).
      user = "0:0";
      read_only = true;
      command = [ bin "-listen" bind ];
      env_file = [ "../mcp-oauth/.secrets" ];
      environment = {
        ISSUER         = "https://c3-pub.diegonmarcos.com/mcp-oauth";
        AUTHORIZE_BASE = "https://c3-pvt.diegonmarcos.com/mcp-oauth";
        DB_PATH        = "/data/mcp-oauth.sqlite3";
        ALLOWED_USERS  = "diego";
      };
      volumes = [ "mcp_oauth_go_data:/data" ];
      healthcheck = {
        test = [ "CMD" bin "-healthcheck" "http://${bind}/health" ];
        interval     = "60s";
        timeout      = "30s";
        retries      = 3;
        start_period = "30s";
      };
      # #1898: memswap_limit == mem_limit = no swap for this container (swap-in stalls the edge).
      memswap_limit = buildJson.resources.mem_limit;
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
  volumes = {
    mcp_oauth_go_data = { };
  };
}
