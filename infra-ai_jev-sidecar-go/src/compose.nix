# compose.nix — pure attrset describing docker-compose.yml for jev-sidecar-go.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1879: the Go jev-gate runs `serve` beside the Python jev-sidecar on the same host, own port (3143), own container name, HOME on a tmpfs so its journal, cache and budget ledger are its own. NO OPENROUTER_API_KEY and no env_file: it can never spend, so every decision answers no_key and the live comparison covers /health, /precision, bad requests and the decision envelope; the key paths are covered by the parity harness against a mock Decisions server. It is NOT in Caddy's path and no client dials it.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    jev-sidecar-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin "serve" ];
      tmpfs = [ "/home/nonroot:uid=65532,gid=65532,mode=0700,size=64m" ];
      environment = {
        PORT = toString buildJson.ports.app;
        TZ   = "Europe/Paris";
        HOME = "/home/nonroot";
        JEV_GATE_BIND = "10.0.0.6";
        JEV_GATE_PORT = "3143";
      };
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "healthcheck" "http://${bind}/health" ];
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
