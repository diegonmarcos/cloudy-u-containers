# compose.nix — pure attrset describing docker-compose.yml for c3bot-relay-go.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1873: the Go port runs beside the Node c3bot-relay on the same host, on its own port, with its
# own container name and its own (tmpfs) state. It is NOT in Caddy's path and no client dials it. SHADOW_EPHEMERAL=1:
# random per-process bearer and webhook secret, bot token ignored, so it never reads the live relay's queue, never talks
# to Telegram and never claims a lease on the live relay. No env_file, no secret mount.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    c3bot-relay-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin "-listen" bind ];
      # Writable state for the nonroot user without a volume the generated Dockerfile would have to pre-create.
      tmpfs = [ "/state:uid=65532,gid=65532,mode=0700,size=16m" ];
      environment = {
        SHADOW_EPHEMERAL      = "1";
        SHADOW_CHECK_INTERVAL = "1h";
        PORT                  = toString buildJson.ports.app;
        HTTP_HOST             = buildJson.bind_host;
        TZ                    = "Europe/Paris";
        BASE_PATH             = "/c3bot-relay";
        BUFFER_SIZE           = toString app.limits.buffer_size;
        MAX_CLIENTS           = toString app.limits.max_clients;
        POLL_MAX_WAIT_S       = toString app.limits.poll_max_wait_s;
        C3BOT_ALLOWED_FROM    = app.limits.allowed_from;
        RELAY_STATE_FILE      = "/state/state.json";
      };
      healthcheck = {
        # distroless: no shell or curl; the binary probes itself.
        test = [ "CMD" bin "-healthcheck" "http://${bind}/health" ];
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
