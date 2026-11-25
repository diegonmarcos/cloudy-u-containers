# compose.nix — auth-broker (Go port), shadow stage of ticket #1877.
# One container per provider, like the Python broker, on ports 4280-4283 beside its 4180-4183 on the same host, outside every
# request path. The Go binary reads the Python service's own build.json (mounted read-only from ../auth-broker/) and takes
# the same secrets from ../auth-broker/.secrets, so no allowlist or secret is copied. build.ship_hold keeps it out of the ship.
{ buildJson, container }:

let
  bin = "/usr/local/bin/${buildJson.docker.native_build.binary}";
  mk = id:
    let
      c = buildJson.containers.${id};
      bind = "${buildJson.bind_host}:${toString c.port}";
    in {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = c.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin ];
      env_file = [ "../auth-broker/.secrets" ];
      environment = {
        BROKER_PROVIDER = id;
        PORT = toString c.port;
        BIND_HOST = buildJson.bind_host;
        BROKER_CONFIG = "/etc/auth-broker/build.json";
      };
      volumes = [ "../auth-broker/build.json:/etc/auth-broker/build.json:ro" ];
      healthcheck = {
        test = [ "CMD" bin "-healthcheck" "http://${bind}${c.healthcheck}" ];
        interval = "60s"; timeout = "10s"; retries = 3; start_period = "20s";
      };
      deploy.resources = {
        limits = { memory = c.resources.mem_limit; };
        reservations = { memory = c.resources.mem_reservation; };
      };
      logging = { driver = "json-file"; options = { max-size = "1m"; max-file = "3"; }; };
    };
in
{
  services = {
    auth-broker-go-google = mk "google";
    auth-broker-go-github = mk "github";
    auth-broker-go-cloudflare = mk "cloudflare";
    auth-broker-go-email = mk "email";
  };
}
