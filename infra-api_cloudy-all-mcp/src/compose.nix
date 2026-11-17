# compose.nix — cloudy-all-mcp, the fleet MCP router (#1450).
#   Stateless Node MCP server (code/mcp, Node 22 + tsx). Host network on oci-apps, bound to the WireGuard
#   IP (the fleet design premise: iptables:false, no published ports). The single secret ROUTER_BEARER
#   (the public-route fallback bearer toward the child MCPs) comes from the sops secrets file via .secrets.
{ buildJson, container }:

let
  svc  = container.services or {};
  app  = buildJson.containers.app;
  vmIp = (svc."cloudy-all-mcp" or {}).ip or "10.0.0.6";
  port = toString buildJson.ports.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    "cloudy-all-mcp" = {
      image          = binariesImage;
      container_name = app.container_name;
      network_mode   = "host";
      env_file       = [ ".secrets" ];
      environment = {
        PORT          = port;
        MCP_HTTP_HOST = vmIp;
      };
      healthcheck = {
        test = [
          "CMD" "node" "-e"
          "fetch('http://${vmIp}:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ];
        interval     = "30s";
        timeout      = "10s";
        retries      = 3;
        start_period = "20s";
      };
      deploy.resources = {
        limits       = { memory = "256M"; };
        reservations = { memory = app.resources.mem_reservation; };
      };
    };
  };
}
