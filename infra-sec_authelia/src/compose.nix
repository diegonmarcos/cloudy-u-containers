# compose.nix — pure attrset describing docker-compose.yml for authelia.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
{ buildJson, container, base_domain }:

let
  svc = container.services;
  app = buildJson.containers.app;
  redis = buildJson.containers.redis;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  redisImage    = redis.image;
in
{
  services = {
    authelia = {
      image = binariesImage;
      container_name = app.container_name;
      entrypoint = [ "sh" "/config/init.sh" ];
      env_file = [ ".secrets" ];
      environment = {
        TZ = buildJson.timezone;
        X_AUTHELIA_CONFIG_FILTERS = "template";
      };
      volumes = [
        "authelia_data:/data"
        "./configs:/config:ro"
      ];
      # NOTE: .secrets, .secrets.d/, .secrets.json are auto-mounted by
      # _shared/engine.nix when src/secrets.yaml exists. Authelia's
      # configuration.yml uses {{ secret "/run/secrets/X" }} for all secret
      # references including the multi-line JWKS PEM. No oidc_jwks.pem
      # carve-out, no legacy /config/.secrets.d mount needed.
      ports = [ "${svc.authelia.ip}:${toString buildJson.ports.app}:9091" ];
      # Static IP pin: infra-sec_introspect-proxy's JWKS_URL targets this
      # address directly (the host-published port's docker-proxy hangs).
      # Keep in sync with that JWKS_URL if this ever changes.
      networks.auth-net.ipv4_address = "172.18.0.3";
      # service_healthy (not service_started): authelia FATALs with no retry if
      # it connects while redis is still "LOADING the dataset" — that race took
      # down all auth + mail (2026-06-20). The redis healthcheck below only goes
      # healthy once PING returns PONG (redis withholds PONG during LOADING).
      depends_on.redis = { condition = "service_healthy"; };
      # Override the image's built-in HEALTHCHECK: the upstream authelia image
      # ships a `wget --spider .../api/health` probe on an aggressive interval,
      # and on a thrashing box those wget probes stack (observed 55s+ elapsed
      # each) instead of returning instantly. A 60s interval + start_period
      # stops the pile-up without hiding a real outage.
      healthcheck = {
        test = [ "CMD" "wget" "--quiet" "--no-check-certificate" "--tries=1" "--spider"
                 "http://localhost:9091/authelia/api/health" ];
        interval     = "60s";
        timeout      = "10s";
        retries      = 3;
        start_period = "40s";
      };
      cap_add = [ "DAC_OVERRIDE" ];
      # #1898: memswap_limit == memory limit = no swap for the auth portal (swap-in stalls the edge).
      memswap_limit = "128M";
      deploy.resources = {
        limits       = { memory = "128M"; cpus = "1.0"; };
        reservations = { memory = "32M"; };
      };
    };
    redis = {
      image = redisImage;
      container_name = redis.container_name;
      env_file = [ ".secrets" ];
      command = "sh -c 'redis-server --port ${toString buildJson.ports.redis} --requirepass $$AUTHELIA_REDIS_PASSWORD --appendonly yes --appendfsync everysec --save 900 1 --save 300 10'";
      volumes = [ "authelia_redis_data:/data" ];
      # Static IP pin, same treatment as authelia's above: the embedded-DNS
      # service-name lookup ("redis") was observed timing out on this host
      # (authelia FATAL "lookup redis: i/o timeout" 2026-08-31, and 6s
      # per-request session stalls before that) — configuration.yml.tpl now
      # dials this address directly, keeping DNS out of the auth hot path.
      networks.auth-net.ipv4_address = "172.18.0.4";
      # Healthy ONLY when PING returns PONG — redis returns -LOADING (no PONG)
      # while replaying the AOF, so this gates authelia until the dataset is
      # fully loaded. grep -q PONG is required because redis-cli exits 0 even on
      # a -LOADING error reply. start_period must exceed the AOF replay window: replaying the incr AOF took 204s on gcp-proxy (2026-10-30 14:04), so the old 10s + 12x5s budget flagged it unhealthy mid-load and failed authelia's depends_on (Ship run 41063222260).
      healthcheck = {
        test = [ "CMD-SHELL" "redis-cli -p ${toString buildJson.ports.redis} -a \"$$AUTHELIA_REDIS_PASSWORD\" ping 2>/dev/null | grep -q PONG" ];
        interval = "5s";
        timeout = "3s";
        retries = 12;
        start_period = "300s";
      };
      deploy.resources = {
        limits       = { memory = "48M"; cpus = "1.0"; };
        reservations = { memory = "16M"; };
      };
    };
  };
  volumes = {
    authelia_data = {};
    authelia_redis_data = {};
  };
  networks = {
    # Explicit subnet (matches what Docker's IPAM had already assigned)
    # so authelia's static ipv4_address above is valid on every recreate.
    auth-net = {
      driver = "bridge";
      ipam.config = [ { subnet = "172.18.0.0/16"; } ];
    };
  };
}
