# compose.nix — cloudy-ai-api, the AI gateway (#1450).
#   /ai/{tokens,embeddings,agents,claude,memory}/<rest> -> the five backend containers;
#   the legacy /<old-name>/<rest> paths are rewritten to the same backends for one release.
#   - Stateless Node reverse proxy (code/index.ts, Node 22 type stripping), no volumes, no secrets.
#   - Host network on oci-apps, bound to the WireGuard IP (wg-only): the hub Caddy on gcp-proxy
#     reaches it over the mesh and enforces the bearer on the public route; auth for the
#     scoped tokens stays with the backends.
#   - ROUTES points every backend at the WireGuard IP: the backends bind there, not on loopback.
{ buildJson, container }:

let
  svc  = container.services or {};
  wgIp = (svc."cloudy-ai-api" or {}).ip or "10.0.0.6";
  port = toString buildJson.ports.app;
  backend = name: p: legacy: { inherit name legacy; url = "http://${wgIp}:${toString p}"; };
  routes = [
    (backend "tokens"     4184 [ "tokens-api" ])
    (backend "embeddings" 7997 [ "embeddings-api" ])
    (backend "agents"     3217 [ "my-ai-api" ])
    (backend "claude"     3117 [ "claude-superset-api" "my-ai_claude-api" ])
    (backend "memory"     3108 [ "session-memory" ])
  ];
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    "cloudy-ai-api" = {
      image = binariesImage;
      container_name = buildJson.containers.app.container_name;
      network_mode = "host";
      user = "node";
      environment = {
        PORT      = port;
        BIND_HOST = wgIp;
        ROUTES    = builtins.toJSON routes;
      };
      healthcheck = {
        test = [
          "CMD" "node" "-e"
          "fetch('http://${wgIp}:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ];
        interval     = "30s";
        timeout      = "10s";
        retries      = 3;
        start_period = "15s";
      };
      deploy.resources = {
        limits       = { memory = buildJson.resources.mem_limit; };
        reservations = { memory = buildJson.resources.mem_reservation; };
      };
    };
  };
}
