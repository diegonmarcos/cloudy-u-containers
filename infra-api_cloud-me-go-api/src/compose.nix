# compose.nix — pure attrset describing docker-compose.yml for cloud-me-go-api.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1882: the Go port runs beside the Node cloud-me-api on the same host (oci-analytics), own port (8134), own container
# name, outside every request path. No env_file: the vault mapping of the CME_KEY_*_B64 deploy keys for this service name belongs to the
# switch-over, so ALLOW_NO_KEYS=1 lets it start and no repo syncs until then. Clones and key files live on size-capped tmpfs, never on the VM disk.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    cloud-me-go-api = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin ];
      environment = {
        PORT = toString buildJson.ports.app;
        BIND_HOST = buildJson.bind_host;
        TZ = "Europe/Paris";
        ALLOW_NO_KEYS = "1";
      };
      tmpfs = [
        "/data:size=96m,mode=0700"
        "/run/keys:size=1m,mode=0700"
      ];
      healthcheck = {
        test = [ "CMD" bin "-healthcheck" "http://${bind}/me/health" ];
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
