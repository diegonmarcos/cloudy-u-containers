# compose.nix — docker-compose spec for capital-stack-finterminal-api (Type A, own code)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  # WG IP from cloud-data — bound by source (defensive default 127.0.0.1
  # in main.rs; we override via FIN_API_HOST). Host network mode means the
  # service stays on the WG mesh only.
  vmIp = svc."capital-stack-finterminal-api".ip or "10.0.0.6";
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    capital-stack-finterminal-api = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      environment = {
        FIN_API_PORT = toString app.port;
        FIN_API_HOST = vmIp;
        RUST_LOG = "info,tower_http=info";
        # SEC EDGAR rejects a User-Agent without a contact address (403); the public contact of the fleet owner.
        FINTERM_CONTACT = "(me@diegonmarcos.com)";
        # The normalised answers are kept in this SQLite file (cache table) and restored on start.
        FINTERM_DB = "/data/finterm.db";
      };
      volumes = [ "finterm_data:/data" ];
      deploy.resources = {
        limits       = { memory = "512M"; cpus = "1.0"; };
        reservations = { memory = "128M"; };
      };
    };
  };
  volumes = {
    finterm_data = { name = "finterm_data"; };
  };
}
