# compose.nix — docker-compose spec for caddy
# introspect-proxy lives in its own service folder (bb-sec_introspect-proxy)
# and runs as its own compose project; Caddy reaches it over host network
# at 127.0.0.1:4182 (or 10.0.0.1:4182 for WG-side forward_auth).
{ buildJson, container }:

let
  multiSso = ((container.edge_auth or {}).multi_sso or {}).enabled or false;
in
{
  services = {
    caddy = {
      # Image declared in build.json (containers.app.image); compose reads it
      # directly so a single source of truth governs which binary image runs.
      image = buildJson.containers.app.image;
      container_name = buildJson.containers.app.container_name;
      # REQUIRED: the caddy-l4 image's default CMD is ["/bin/sh"] (it ships a bare
      # shell, NOT `caddy run`). Without an explicit command the container runs sh,
      # exits instantly, and :443 goes dark with empty logs — the gcp-proxy outage
      # of 2026-06-19. Every caddy-l4 consumer MUST declare this command.
      command = [ "caddy" "run" "--config" "/etc/caddy/Caddyfile" "--adapter" "caddyfile" ];
      network_mode = "host";
      # Deviation from the fleet-wide restart:no convention (_shared/compose-defaults.json).
      # Caddy is the sole ingress for every public route (443/8443); a stopped/removed
      # container here blacks out the whole public surface until a manual `build.sh ship`.
      # unless-stopped auto-reopens it after a crash, OOM-kill, or host reboot.
      restart = "unless-stopped";
      env_file = [ ".secrets" ];
      cap_add = [ "NET_BIND_SERVICE" ];
      read_only = false;
      volumes = [
        # Per-key secret files from the sops pipeline (.secrets.d/<KEY>, mode
        # 0600) — carries the mesh-CA PEM key+cert that the pki global block
        # (00-globals.caddy.tpl) reads at /run/secrets/MESH_CA_{KEY,CERT}.
        # Multi-line PEM can't ride the .secrets env_file, files can.
        "./.secrets.d:/run/secrets:ro"
        "./configs/Caddyfile:/etc/caddy/Caddyfile:ro"
        "./configs/error.html:/srv/error.html:ro"
        "./configs/dashboard.html:/srv/dashboard.html:ro"
        "./configs/ntfy-setup.html:/srv/ntfy-setup.html:ro"
        "./configs/mail:/srv/mail:ro"
        "./configs/wkd:/srv/wkd:ro"
      ] ++ (if multiSso then [
        # edge_auth.multi_sso.enabled: the sign-in chooser served on auth./account.
        "./configs/sso-chooser.html:/srv/sso-chooser.html:ro"
      ] else []) ++ [
        "caddy_logs:/var/log/caddy"
        "caddy_data:/data"
        "caddy_config:/config"
      ];
      # #1898: swap-capped at the same figure as the memory limit (memswap_limit == memory means
      # NO swap for this container: a swapped-out caddy refaults at HDD speed and stalls the edge),
      # and shielded from the kernel OOM killer (-900, same tier as sshd/wg, see _shared/oom-priority.json).
      memswap_limit = "192M";
      oom_score_adj = -900;
      deploy.resources = {
        limits       = { memory = "192M"; };
        reservations = { memory = "96M"; };
      };
    };
  };

  volumes = {
    caddy_data   = { driver = "local"; };
    caddy_config = { driver = "local"; };
    caddy_logs   = { driver = "local"; };
  };
}
