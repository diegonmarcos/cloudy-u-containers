# compose.nix — pure attrset describing docker-compose.yml for cloudy-drive-git-proxy-go-api.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1882: the Go port runs beside the Node git-proxy on the same host (oci-analytics), own port (8133), own container name,
# outside every request path (not in Caddy, no client dials it). No env_file: the vault mapping of GITHUB_TOKEN for this service name belongs to the
# switch-over, so ALLOW_NO_TOKEN=1 lets it start and upstream-dialling routes answer 502 upstream_error until then.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    cloudy-drive-git-proxy-go-api = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin ];
      environment = {
        PORT = toString buildJson.ports.app;
        BIND_HOST = buildJson.bind_host;
        TZ = "Europe/Paris";
        ALLOW_NO_TOKEN = "1";
      };
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "-healthcheck" "http://${bind}/git/health" ];
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
