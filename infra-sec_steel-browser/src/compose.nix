# compose.nix — pure attrset describing docker-compose.yml for steel-browser.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Posture (owner-authorized ethical-hacking tooling, OWN services only):
#   • Steel has NO native API auth (upstream). So Steel ("app") runs on a
#     PRIVATE docker bridge with NO published port — it is reachable only by the
#     bearer-auth Caddy sidecar ("auth") on the same bridge, never from the mesh
#     or host directly, and the Chrome DevTools port (9223) is never published.
#   • The Caddy sidecar publishes ONLY on the oci-apps WireGuard IP (10.0.0.6),
#     requires Authorization: Bearer $STEEL_API_KEY, and FAILS CLOSED: if
#     STEEL_API_KEY is unset the sidecar refuses to start, so Steel is never
#     reachable without the vault secret. No public port, no Caddy edge route,
#     no public DNS (private-only, wg_only by omission of any proxy block).
#   • NO residential/mobile proxy pool and NO third-party CAPTCHA-solver env is
#     set — those opt-in features stay unconfigured.
#   • The declared target allowlist is enforced in the c3 MCP tool layer
#     (_shared/security-testing-allowlist.*); Steel itself performs no target
#     filtering, so it must never be exposed outside this authed path.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  auth = buildJson.containers.auth;

  # Engine wraps the pinned upstream (build.json containers.app.image, digest-
  # pinned) into ghcr.io/diegonmarcos/steel-browser-binaries; we pull that here.
  steelImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  caddyImage = auth.image;

  wgIp      = "10.0.0.6";           # oci-apps wg0 — the only exposed listener
  steelPort = toString buildJson.ports.app;  # 3000 inside the container
  meshPort  = toString buildJson.ports.app;  # published mesh port (10.0.0.6:3000)

  caddyEntry = ''
    if [ -z "$STEEL_API_KEY" ]; then
      echo "[steel-auth] STEEL_API_KEY is unset — refusing to start (fail closed). Set the vault secret STEEL_API_KEY." >&2
      exit 1
    fi
    exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
  '';
in
{
  services = {
    app = {
      image = steelImage;
      container_name = app.container_name;
      networks = [ "steelnet" ];
      init = true;
      env_file = [ ".secrets" ];
      environment = {
        TZ   = buildJson.timezone;
        # Steel listens on 3000 inside the container; never published.
        PORT = steelPort;
        # Explicitly leave proxy pools / CAPTCHA solvers unconfigured.
        # (No PROXY_URL, no *_CAPTCHA_* — opt-in features stay off.)
      };
      # No `ports:` — Steel is reachable ONLY via the auth sidecar over steelnet.
      # Node is always present in the Steel image; any HTTP response (200/404)
      # means the server is up, so the check does not depend on a specific path
      # or on wget/curl being installed.
      healthcheck = {
        test = [ "CMD-SHELL" "node -e 'require(\"http\").get(\"http://127.0.0.1:${steelPort}/\",r=>process.exit(0)).on(\"error\",()=>process.exit(1))'" ];
        interval = "30s";
        timeout  = "10s";
        retries  = 3;
        start_period = "40s";
      };
      deploy.resources = {
        limits       = { memory = "2G"; cpus = "1.5"; };
        reservations = { memory = "256M"; };
      };
    };

    auth = {
      image = caddyImage;
      container_name = auth.container_name;
      networks = [ "steelnet" ];
      init = true;
      env_file = [ ".secrets" ];
      entrypoint = [ "/bin/sh" "-c" ];
      command = [ caddyEntry ];
      ports = [ "${wgIp}:${meshPort}:3000" ];
      volumes = [ "./configs/steel-auth.Caddyfile:/etc/caddy/Caddyfile:ro" ];
      # service_started, not service_healthy: the proxy should come up as soon
      # as Steel is running; it does not need Steel's healthcheck to pass first
      # (the reverse_proxy simply 502s until Steel answers).
      depends_on = { app = { condition = "service_started"; }; };
      healthcheck = {
        test = [ "CMD-SHELL" "wget -qO /dev/null http://127.0.0.1:3000/healthz || exit 1" ];
        interval = "30s";
        timeout  = "10s";
        retries  = 3;
        start_period = "10s";
      };
      deploy.resources = {
        limits       = { memory = "64M"; cpus = "0.5"; };
        reservations = { memory = "16M"; };
      };
    };
  };

  networks = {
    steelnet = { driver = "bridge"; };
  };
}
