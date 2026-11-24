# compose.nix — pure attrset describing docker-compose.yml for capital-stack-news-gdelt-go-api.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1882: the Go port runs beside the Node news-gdelt on the same host, own port (3142), own container name and its own tmpfs cache (it never touches the Node service's SQLite volume). It is NOT in Caddy's path and no client dials it. FETCH_INTERVAL 3600 keeps its extra pressure on the GDELT API low while both run.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    capital-stack-news-gdelt-go-api = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin  ];
      tmpfs = [ "/cache:uid=65532,gid=65532,mode=0700,size=64m" ];
      environment = {
        PORT = toString buildJson.ports.app;
        TZ   = "Europe/Paris";
        MCP_HTTP_HOST = "10.0.0.6";
        CACHE_DIR = "/cache";
        FETCH_INTERVAL = "3600";
        BASE_PATH = "/news";
      };
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
