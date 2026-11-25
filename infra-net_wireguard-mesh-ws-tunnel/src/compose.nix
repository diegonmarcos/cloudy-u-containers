# compose.nix — pure attrset describing docker-compose.yml for wireguard-mesh-ws-tunnel.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# wstunnel-server runs on gcp-proxy in network_mode: host so it can reach the
# kernel WG listener at 127.0.0.1:51820 without docker-network NAT.
{ buildJson, container, base_domain ? null }:

let
  app = buildJson.containers.app;
in
{
  services = {
    wireguard-mesh-ws-tunnel = {
      image          = app.image;
      container_name = app.container_name;
      command        = app.command;
      network_mode   = app.network_mode;
      read_only      = app.read_only;
      tmpfs          = app.tmpfs;
      env_file       = [ ".secrets" ];
      environment = {
        TZ = buildJson.timezone or "Europe/Madrid";
      };
      restart = "unless-stopped";
      # #1898: the mesh transport for the hub; shield from the kernel OOM killer (same tier as sshd/wg).
      oom_score_adj = -900;
      deploy = {
        # mem_limit is optional in build.json — reading it unconditionally
        # fails eval with "attribute 'mem_limit' missing".
        resources = if app.resources ? mem_limit
                    then { limits = { memory = app.resources.mem_limit; }; }
                    else {};
      };
      logging = {
        driver = "json-file";
        options = {
          max-size = "1m";
          max-file = "3";
        };
      };
    };
  };
}
