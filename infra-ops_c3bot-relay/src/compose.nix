# compose.nix: c3bot-relay (Type A own-code, single container, zero npm deps).
# engine.nix serialises this attrset and merges compose-defaults.json.
{ buildJson, container }:

let
  app = buildJson.containers.app;
  svc = container.services;
  vmIp = svc."c3bot-relay".ip;
  port = toString buildJson.ports.app;
in
{
  services = {
    c3bot-relay = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}:latest";
      container_name = app.container_name;
      # Host network (dockerd runs iptables:false) with the listener confined to the WG IP: mesh-only.
      network_mode = "host";
      # C3BOT_RELAY_TOKEN (bearer), C3BOT_WEBHOOK_SECRET, and C3BOT_A_BOT_TOKEN (Bot A, the one token) arrive ONLY through .secrets
      # (vault secrets.yaml, overlaid by the Ship, decrypted to .secrets). Never in this block.
      env_file = [ ".secrets" ];
      volumes = [
        "./.secrets.d:/run/secrets:ro"
        "./.secrets.json:/run/secrets.json:ro"
      ];
      environment = {
        PORT = port;
        HTTP_HOST = vmIp;
        TZ = buildJson.timezone;
        BASE_PATH = app.proxy.base_path;
        BUFFER_SIZE = toString app.limits.buffer_size;
        MAX_CLIENTS = toString app.limits.max_clients;
        POLL_MAX_WAIT_S = toString app.limits.poll_max_wait_s;
        C3BOT_ALLOWED_FROM = app.limits.allowed_from;
        # #1579: public webhook URL registered at Telegram (c3-pub sink, fleet-addressing.json), failover health window and tick.
        C3BOT_WEBHOOK_URL = "https://c3-pub.diegonmarcos.com/c3bot-webhook";
        HEALTH_WINDOW_S = toString app.limits.health_window_s;
        CHECK_INTERVAL_S = toString app.limits.check_interval_s;
      };
      deploy.resources = {
        limits = {
          memory = app.resources.mem_limit;
          pids = app.resources.pids_limit;
        };
        reservations.memory = app.resources.mem_reservation;
      };
      healthcheck = {
        test = [ "CMD" "node" "-e" "fetch('http://${vmIp}:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "10s";
      };
    };
  };
}
