# compose.nix — tokens-api, the fleet token engine.
#   - Own code (Type A), packaged by the ship engine (native_build.type=image-wrapper).
#   - Host network on oci-apps, bound to the host's WireGuard IP (wg-only policy): the
#     hub Caddy and introspect-proxy on gcp-proxy reach it over the mesh.
#   - ONE gunicorn worker: the store is one sqlite file guarded by an in-process lock.
#   - Secrets (sops, src/secrets.yaml -> .secrets via env_file): TOKENS_FLEET_KEY (encrypts the
#     stored token values) and TOKENS_VERIFY_SECRET (shared with introspect-proxy).
{ buildJson, container }:

let
  svc  = container.services;
  self = svc."tokens-api";
  port = toString buildJson.ports.app;
  bind = "${self.ip}:${port}";
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    tokens-api = {
      image = binariesImage;
      container_name = buildJson.containers.app.container_name;
      network_mode = "host";
      # The image-wrapper image runs as uid 10001 but a fresh named volume is root-owned, so the sqlite file
      # cannot be created. Start as root, hand /data to the app user, and let gunicorn drop to that user
      # for the worker (the only process that touches a token).
      user = "0:0";
      command = [
        "sh" "-c"
        "chown 10001:999 /data && exec gunicorn --bind ${bind} --user 10001 --group 999 --workers 1 --threads 4 --timeout 30 main:app"
      ];
      environment = {
        DB_PATH     = "/data/tokens.sqlite3";
        OWNER_EMAIL = "me@diegonmarcos.com";
        # Clients that count as the owner: the Authelia client of the owner's own devices.
        # Agent clients (claude-*, dagu-*, mattermost-*) are never admins.
        ADMIN_CLIENT_IDS = "cloud-admin";
        # The hub Caddy (gcp-proxy) is the only source whose Remote-Email header is believed.
        TRUSTED_PROXIES = "10.0.0.1/32";
        INTROSPECT_URL  = "http://10.0.0.1:4182/auth";
        PORT            = port;
      };
      volumes = [ "tokens_api_data:/data" ];
      healthcheck = {
        test = [ "CMD" "python3" "-c" "import urllib.request; urllib.request.urlopen('http://${bind}/health', timeout=8)" ];
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
  volumes = {
    tokens_api_data = {};
  };
}
