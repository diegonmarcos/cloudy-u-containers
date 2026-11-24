# compose.nix — pure attrset describing docker-compose.yml for cloudy-all-mcp-go.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1874: the Go port of the fleet MCP router runs beside the TypeScript cloudy-all-mcp on the
# same host, on its own port and container name. It is NOT in Caddy's path and no client dials it. No env_file and
# no secret: without ROUTER_BEARER it only reaches the children over their mesh endpoints (the public bearer
# fallback reports "no ROUTER_BEARER" exactly like the old router does without one), which is all list_servers /
# list_tools comparison needs. Port 3140 on the oci-apps WG IP.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    cloudy-all-mcp-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin "--http" ];
      environment = {
        PORT          = toString buildJson.ports.app;
        MCP_HTTP_HOST = buildJson.bind_host;
        TZ            = "Europe/Paris";
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
