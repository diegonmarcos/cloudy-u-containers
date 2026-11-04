# compose.nix — docker-compose spec for scrappers-api (Type A own-code)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."scrappers-api".ip or "10.0.0.6";  # oci-apps WG IP
  port = toString buildJson.ports.app;
in
{
  services = {
    # #824: the named volumes were created root-owned before the image switched
    # to the non-root appuser (10001:999), so every scrape's _persist() hit
    # EACCES on /app/data and the API answered 500. Docker never re-owns an
    # existing volume, so a one-shot root repair runs before the app on every
    # deploy. `$$` = compose escape for a literal `$`.
    scrappers-api-volume-owner = {
      image = "busybox:1.37";
      container_name = "scrappers-api-volume-owner";
      user = "0:0";
      restart = "no";
      network_mode = "none";
      volumes = [ "scrappers_data:/v/data" "scrappers_session:/v/session" ];
      command = [ "sh" "-c" "set -eu; chown -R 10001:999 /v/data /v/session; left=$$(find /v/data /v/session ! -user 10001 | wc -l); echo \"[scrappers-volume-owner] wrong-owner paths left=$$left\"; [ \"$$left\" -eq 0 ]" ];
    };
    scrappers-api = {
      depends_on = { scrappers-api-volume-owner = { condition = "service_completed_successfully"; }; };
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      # NOTE: when the burner IG account exists, add `env_file = [ ".secrets" ];` here plus a
      # sops src/secrets.yaml carrying IG_BURNER_USER / IG_BURNER_PASS. Until then the IG scraper
      # runs anonymously (public profiles only) and needs no secrets.
      environment = {
        PYTHONUNBUFFERED = "1";
        DATA_DIR = "/app/data";
        TZ = buildJson.timezone;
        BASE_PATH = "/scrappers";
        PORT = port;
        # Confine the listener to the WG mesh on host networking.
        HTTP_HOST = vmIp;
      };
      volumes = [
        "scrappers_data:/app/data"        # flat-JSON scrape output (restic-backed)
        "scrappers_session:/app/session"  # instaloader burner session cache
      ];
      healthcheck = {
        test = [
          "CMD-SHELL"
          "curl -fsS http://${vmIp}:${port}/health >/dev/null 2>&1 || exit 1"
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "20s";
      };
    };
  };
  volumes = {
    scrappers_data = {};
    scrappers_session = {};
  };
}
