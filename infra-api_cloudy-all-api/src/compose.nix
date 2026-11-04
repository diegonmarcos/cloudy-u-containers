# compose.nix — docker-compose spec for c3-services-api (Type A own-code)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."c3-services-api".ip or "10.0.0.6";  # oci-apps WG IP
  port = toString buildJson.ports.app;
in
{
  services = {
    c3-services-api = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      env_file = [ ".secrets" ];
      environment = {
        HOST = vmIp;
        PORT = port;
        NODE_ENV = "production";
      };
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
}
