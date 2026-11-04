# compose.nix — docker-compose for session-memory (central Claude session-log SQLite).
# engine.nix serialises this via lib.generators.toYAML, merging compose-defaults.json.
#
# WG-ONLY: host network, listener bound to the VM WireGuard IP (10.0.0.6) — reachable
# from any mesh device (phone/desktop) to push/list/fetch transcripts, never public.
# The SQLite file lives on the session_memory_data named volume (survives restarts).
{ buildJson, container }:

let
  app = buildJson.containers.app;
  svc = container.services or {};
  wgIp = svc."session-memory".ip or "10.0.0.6";
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    session-memory = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      environment = {
        MEM_PORT = toString buildJson.ports.app;
        MEM_BIND = wgIp;
        MEM_DB   = "/data/sessions.db";
      };
      volumes = [ "session_memory_data:/data" ];
      healthcheck = {
        test = [
          "CMD" "node" "-e"
          "fetch('http://${wgIp}:${toString buildJson.ports.app}/health').catch(()=>process.exit(1))"
        ];
        interval     = "30s";
        timeout      = "10s";
        retries      = 3;
        start_period = "15s";
      };
    };
  };
  volumes = {
    session_memory_data = { name = "session-memory-data"; };
  };
}
