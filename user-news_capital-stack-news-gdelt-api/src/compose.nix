# compose.nix — docker-compose spec for news-gdelt (Type A own-code)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."news-gdelt".ip or "10.0.0.6";  # oci-apps WG IP
  port = toString buildJson.ports.app;
in
{
  services = {
    news-gdelt = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      environment = {
        NODE_ENV = "production";
        CACHE_DIR = "/app/cache";
        FETCH_INTERVAL = "900";
        TZ = buildJson.timezone;
        BASE_PATH = "/news";
        PORT = port;
        # bindHost() reads MCP_HTTP_HOST. Source defaults to 127.0.0.1.
        # WG IP keeps the listener confined to the WG mesh on host network.
        MCP_HTTP_HOST = vmIp;
      };
      volumes = [
        "news_gdelt_cache:/app/cache"
      ];
      healthcheck = {
        test = [
          "CMD-SHELL"
          "curl -fsS http://${vmIp}:${port}/health >/dev/null 2>&1 || exit 1"
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "15s";
      };
    };
  };
  volumes = {
    news_gdelt_cache = {};
  };
}
