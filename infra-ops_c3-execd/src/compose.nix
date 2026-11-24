# compose.nix — pure attrset describing docker-compose.yml for c3-execd.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1875: the sidecar runs on oci-apps beside cloudy-c3-api, bound to
# loopback only (network_mode host so the Node containers reach 127.0.0.1:4187). Nothing in
# the request path calls it yet; the TS shadow hook replays read-only calls and logs the
# comparison. Root inside the container is required to read the ssh key mount and the docker
# socket; the filesystem is read-only, every capability is dropped, and the policy (command
# allowlist, docker rule table, alias check) is what bounds what a caller can do.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    c3-execd = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      user = "0:0";
      cap_drop = [ "ALL" ];
      security_opt = [ "no-new-privileges:true" ];
      command = [ bin "-listen" bind ];
      environment = {
        HOME = "/root";
        SSH_CONFIG = "/root/.ssh/config";
        DOCKER_SOCK = "/var/run/docker.sock";
        EXECD_TOKEN_FILE = "/run/c3-execd/token"; # generated on first start, 0600; callers mount the dir read-only
      };
      volumes = app.volumes;
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "-healthcheck" "http://${bind}/health" ];
        interval     = "60s";
        timeout      = "15s";
        retries      = 3;
        start_period = "10s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
