# compose.nix: cloudy-browser-headless (Type A own-code, single container).
# engine.nix serialises this attrset and merges compose-defaults.json.
{ buildJson, container }:

let
  app = buildJson.containers.app;
  svc = container.services;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."cloudy-browser-headless".ip;
  port = toString buildJson.ports.app;
in
{
  services = {
    cloudy-browser-headless = {
      image = binariesImage;
      container_name = app.container_name;
      # Host network (dockerd runs iptables:false, published ports do not forward) and the
      # listener is confined to the WG IP: mesh-only, Caddy path route on top.
      network_mode = "host";
      # BROWSER_TOKEN (bearer) comes from the vault secret src/secrets.yaml (overlaid by the Ship, decrypted to .secrets).
      # Declared explicitly and REQUIRED (no `required = false`): compose refuses to start the container when .secrets
      # is absent, and server.js exits 78 when BROWSER_TOKEN is empty, so a missing secret fails the deploy loudly
      # instead of running with an empty token. The explicit line also keeps the mount in the public render (render-dist).
      env_file = [ ".secrets" ];
      # The Ship render (vault overlaid) auto-adds these two mounts; declaring them here makes the public render identical
      # to the Ship render, so the committed dist/ never drifts (step_verify_committed_dist) and render-dist keeps them.
      volumes = [
        "./.secrets.d:/run/secrets:ro"
        "./.secrets.json:/run/secrets.json:ro"
      ];
      environment = {
        PORT = port;
        HTTP_HOST = vmIp;
        TZ = buildJson.timezone;
        BASE_PATH = app.proxy.base_path;
        MAX_SESSIONS = toString app.limits.max_sessions;
        IDLE_CLOSE_MS = toString app.limits.idle_close_ms;
        CALL_TIMEOUT_MS = toString app.limits.call_timeout_ms;
      };
      # Chromium needs a real /dev/shm; the pids default (256) is too low for a browser.
      shm_size = "1gb";
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
        start_period = "20s";
      };
    };
  };
}
