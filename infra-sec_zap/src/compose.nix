# compose.nix — pure attrset describing docker-compose.yml for OWASP ZAP.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Posture (owner-authorized ethical-hacking tooling, OWN services only):
#   • Headless daemon bound to the oci-apps WireGuard IP (10.0.0.6) ONLY — the
#     public IP is never bound, so ZAP is private/mesh-only (no Caddy route, no
#     public DNS).
#   • Native API-key auth: every call needs api.key=$ZAP_API_KEY. FAILS CLOSED —
#     if ZAP_API_KEY is unset the container refuses to start, so the API is never
#     served keyless.
#   • The declared target allowlist is enforced as ZAP context/scope by the c3
#     MCP zap_* tools (which set the include-in-context regex from
#     _shared/security-testing-allowlist.json) AND re-checked in the MCP layer
#     before every spider/scan — out-of-scope targets are refused and logged.
#   • Steel can optionally route through ZAP as an upstream proxy for passive
#     scanning (ZAP proxy on the same wg0 address).
{ buildJson, container }:

let
  app = buildJson.containers.app;

  zapImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";

  wgIp = "10.0.0.6";                       # oci-apps wg0 — the only bound address
  port = toString buildJson.ports.app;     # 8086

  # $$ escapes compose interpolation so the literal $ZAP_API_KEY reaches the
  # container shell (value supplied by env_file .secrets at runtime).
  zapEntry = ''
    if [ -z "$$ZAP_API_KEY" ]; then
      echo "[zap] ZAP_API_KEY is unset — refusing to start (fail closed). Set the vault secret ZAP_API_KEY." >&2
      exit 1
    fi
    exec zap.sh -daemon \
      -host ${wgIp} -port ${port} \
      -config api.key="$$ZAP_API_KEY" \
      -config api.addrs.addr.name=10.0.0.* \
      -config api.addrs.addr.regex=true \
      -config database.recoverylog=false
  '';
in
{
  services = {
    app = {
      image = zapImage;
      container_name = app.container_name;
      network_mode = "host";
      init = true;
      user = "zap";
      env_file = [ ".secrets" ];
      environment = {
        TZ = buildJson.timezone;
      };
      entrypoint = [ "/bin/bash" "-c" ];
      command = [ zapEntry ];
      healthcheck = {
        # /JSON/core/view/version/ needs the key; the base / returns 200 once the
        # daemon is up, enough to prove liveness without embedding the key here.
        test = [ "CMD-SHELL" "curl -fsS http://${wgIp}:${port}/ >/dev/null 2>&1 || exit 1" ];
        interval = "30s";
        timeout  = "10s";
        retries  = 3;
        start_period = "60s";
      };
      deploy.resources = {
        limits       = { memory = "2G"; cpus = "1.5"; };
        reservations = { memory = "256M"; };
      };
    };
  };
}
