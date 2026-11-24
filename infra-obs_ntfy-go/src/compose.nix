# compose.nix - pure attrset describing docker-compose.yml for ntfy-go.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1878: the Go port of the six ntfy Python sidecars runs beside the live ones on the same host,
# one container per role from ONE image (the single static binary, subcommand as the command). NTFY_DRY_RUN=1 on every
# sender: they log what they WOULD publish and never reach a topic, so no notification is duplicated. rss-gateway and
# topic-scanner only read (ntfy poll over the WG address, cache.db opened read-only) and listen on their own ports on
# the oci-apps WG IP. No Caddy route, no client, no secret mount. Host network: the live ntfy answers on 10.0.0.6:8090.
{ buildJson, container }:

let
  bin    = "/usr/local/bin/${buildJson.docker.native_build.binary}";
  image  = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  bind   = buildJson.bind_host;
  ntfy   = "http://${bind}:8090";
  assets = "/opt/containers/ntfy/assets";

  mem =
       (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
    // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});

  common = {
    inherit image;
    network_mode = "host";
    read_only = true;
    cap_drop = [ "ALL" ];
    security_opt = [ "no-new-privileges:true" ];
    deploy.resources = mem;
  };

  probe = port: path: {
    # distroless: no shell or curl; the binary probes itself.
    test = [ "CMD" bin "healthcheck" "http://${bind}:${toString port}${path}" ];
    interval     = "60s";
    timeout      = "30s";
    retries      = 3;
    start_period = "30s";
  };

  state = "/state:uid=65532,gid=65532,mode=0700,size=8m";
in
{
  services = {
    rss-gateway = common // {
      container_name = buildJson.containers.app.container_name;
      command = [ bin "rss-gateway" ];
      environment = {
        TZ = "Europe/Paris";
        LISTEN = "${bind}:${toString buildJson.ports.rss_gateway}";
        NTFY_URL = ntfy;
      };
      volumes = [
        "${assets}/profiles-config.json:/etc/ntfy/profiles-config.json:ro"
        "${assets}/channels-config.json:/etc/ntfy/channels-config.json:ro"
      ];
      healthcheck = probe buildJson.ports.rss_gateway "/feed/health";
    };

    topic-scanner = common // {
      container_name = buildJson.containers."topic-scanner".container_name;
      command = [ bin "topic-scanner" ];
      # cache.db is root-owned in the live ntfy volume and opened read-only (mode=ro); a WAL reader still needs the -shm file
      # writable, hence the volume is mounted rw and the process runs as root with every capability dropped.
      user = "0:0";
      environment = {
        TZ = "Europe/Paris";
        LISTEN = "${bind}:${toString buildJson.ports.topic_scanner}";
        NTFY_DB = "/var/cache/ntfy/cache.db";
      };
      volumes = [ "ntfy_cache:/var/cache/ntfy" ];
      healthcheck = probe buildJson.ports.topic_scanner "/health";
    };

    notify-broker = common // {
      container_name = buildJson.containers."notify-broker".container_name;
      command = [ bin "notify-broker" ];
      tmpfs = [ state ];
      environment = {
        TZ = "Europe/Paris";
        LISTEN = "${bind}:${toString buildJson.ports.notify_broker}";
        NTFY_DRY_RUN = "1";
        NOTIFY_POLICY_PATH = "/app/build-notify.json";
        NOTIFY_STATE_PATH = "/state/notify-state.json";
      };
      volumes = [ "${assets}/build-notify.json:/app/build-notify.json:ro" ];
      healthcheck = probe buildJson.ports.notify_broker "/health";
    };

    github-rss = common // {
      container_name = buildJson.containers."github-rss".container_name;
      command = [ bin "github-rss" ];
      tmpfs = [ state ];
      environment = {
        TZ = "Europe/Paris";
        NTFY_DRY_RUN = "1";
        NTFY_URL = ntfy;
        SEEN_FILE = "/state/github-seen.json";
      };
    };

    syslog-bridge = common // {
      container_name = buildJson.containers."syslog-bridge".container_name;
      command = [ bin "syslog-bridge" ];
      tmpfs = [ state ];
      user = "0:0";
      environment = {
        TZ = "Europe/Paris";
        NTFY_DRY_RUN = "1";
        NTFY_URL = ntfy;
        SYSLOG_FILE = "/var/log/messages";
        SYSLOG_STATE_FILE = "/state/syslog-offset.txt";
      };
      volumes = [ "/var/log:/var/log:ro" ];
    };
  };

  # The live ntfy cache volume (project "ntfy", volume "ntfy_cache"), shared read-only-in-practice with the scanner.
  volumes.ntfy_cache = { external = true; name = "ntfy_ntfy_cache"; };
}
