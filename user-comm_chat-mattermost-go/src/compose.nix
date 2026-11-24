# compose.nix - pure attrset describing docker-compose.yml for chat-mattermost-go.
#
# Shadow stage of ticket #1880: the Go port of the Mattermost ntfy bridge runs beside the live Python bridge (container
# mattermost-bots) with MM_BRIDGE_SHADOW=1: no Mattermost credential, no Mattermost call, read-only C3 calls, the
# webhook post is a counted local no-op. It follows the same ntfy topics and serves the /c3 handler on its own port.
{ buildJson, container }:

let
  bin    = "/usr/local/bin/${buildJson.docker.native_build.binary}";
  bind   = buildJson.bind_host;
  port   = buildJson.ports.c3_shadow;
  live   = builtins.fromJSON (builtins.readFile ../../user-comm_chat-mattermost/build.json);
  ntfyB  = builtins.fromJSON (builtins.readFile ../../infra-obs_ntfy/build.json);
  topics = builtins.concatStringsSep "," (map (t: t.name) ntfyB.topics);
in
{
  services = {
    mattermost-bots-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = buildJson.containers.app.container_name;
      network_mode = "host";
      read_only = true;
      cap_drop = [ "ALL" ];
      security_opt = [ "no-new-privileges:true" ];
      command = [ bin ];
      environment = {
        TZ = "Europe/Paris";
        MM_BRIDGE_SHADOW = "1";
        NTFY_URL = "http://${bind}:8090";
        TOPICS = topics;
        C3_API_URL = live.c3.api_url;
        C3_BIND_IP = bind;
        C3_PORT = toString port;
      };
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "healthcheck" "http://${bind}:${toString port}/health" ];
        interval     = "60s";
        timeout      = "30s";
        retries      = 3;
        start_period = "30s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
