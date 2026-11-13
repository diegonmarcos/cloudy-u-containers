# compose.nix — pure attrset describing docker-compose.yml for mcp-oauth.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Single service: mcp-oauth — MCP OAuth 2.1 authorization server (option 31.1, WIP)
#   - Own code (Type A) packaged by ship engine via native_build.type=image-wrapper
#   - host networking, bound to the deploy host's WireGuard IP (bind_host) like
#     introspect-proxy: Caddy (hub + edge) and introspect-proxy reach it over wg0.
#   - ONE gunicorn worker: the token store is a single sqlite file guarded by an
#     in-process lock, and the consent-form HMAC key must be shared (FORM_SECRET).
#   - Secrets (dist/.secrets via env_file): INTROSPECT_SECRET (shared with
#     introspect-proxy's MCP_OAUTH_INTROSPECT_SECRET), FORM_SECRET.
{ buildJson, container }:

let
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
in
{
  services = {
    mcp-oauth = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      command = [
        "gunicorn" "--bind" bind
        "--workers" "1" "--threads" "4" "--timeout" "30"
        "main:app"
      ];
      env_file = [ ".secrets" ];
      # The host data dir (./data) is owned by the deploy user, not the image's
      # appuser (uid 10001): sqlite could not open /data/mcp-oauth.sqlite3, /health
      # returned 500 and the container never turned healthy. Run as root like the
      # other bind-mount-data services (no-new-privileges stays on).
      user = "0:0";
      volumes = app.volumes;
      environment = {
        ISSUER        = "https://mcp.diegonmarcos.com";
        DB_PATH       = "/data/mcp-oauth.sqlite3";
        # Comma/space list of Authelia usernames allowed to approve a client.
        ALLOWED_USERS = "diego";
        PORT          = toString buildJson.ports.app;
      };
      healthcheck = {
        test = [
          "CMD" "python3" "-c"
          "import urllib.request; urllib.request.urlopen('http://${bind}/health', timeout=25)"
        ];
        interval     = "60s";
        timeout      = "30s";
        retries      = 3;
        start_period = "60s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
