# compose.nix — cloudy-apps-drive-mcp (#1450): cloud-drive-mcp + cloud-vault-mcp merged.
#   One Node MCP server (code/mcp, Node 22 + tsx). `drive` is always served; `cloud_vault` only to a direct
#   mesh hit (gate.ts: TCP peer in VAULT_MESH_CIDR, default 10.0.0.0/24, and no X-Forwarded-*/Authorization
#   header), so the Caddy route never sees the vault tool. Replaces cloud-drive-mcp on the same port (3109);
#   the engine's port eviction hands the port over at deploy.
#
#   Env and volumes are a SUPERSET of the two services it replaces:
#     cloud-drive-mcp  host network, optional .secrets, PORT, MCP_HTTP_HOST
#     cloud-vault-mcp  the same + /home/ubuntu/git/vault:/vault:ro, VAULT_PATH, CONFIG_PATH
#   The `drive` routing table rides in build.json and reaches the container inside
#   build-cloudy-apps-drive-mcp.json (resolve.ts reads it at runtime). Rationale for host network and the
#   optional env_file: infra-api_cloud-drive-mcp/src/compose.nix.
{ buildJson, container }:

let
  svc  = container.services or {};
  app  = buildJson.containers.app;
  name = app.container_name;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  # Same host (oci-apps) and therefore the same WG IP as the two services it replaces.
  vmIp = (svc.${name} or svc."cloud-drive-mcp" or {}).ip or "10.0.0.6";
  port = toString buildJson.ports.app;
in
{
  services = {
    "cloudy-apps-drive-mcp" = {
      image          = binariesImage;
      container_name = name;
      network_mode   = "host";
      # Neither old service had a secrets.yaml; Ship then writes no .secrets, and a required env_file would
      # abort compose before the pull. Vaultwarden credentials are read from the mounted vault tree instead.
      env_file       = [ { path = ".secrets"; required = false; } ];
      # The PRIVATE credential tree, read-only: every cloud_vault method is read-only and reads $VAULT_PATH
      # straight off disk.
      volumes = [ "/home/ubuntu/git/vault:/vault:ro" ];
      environment = {
        PORT          = port;
        MCP_HTTP_HOST = vmIp;
        VAULT_PATH    = "/vault";
        # build.include_cloud_data = "true": the ship engine copies the consolidated fleet JSON into /app.
        CONFIG_PATH   = "/app/_cloud-data-consolidated.json";
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
    };
  };
}
