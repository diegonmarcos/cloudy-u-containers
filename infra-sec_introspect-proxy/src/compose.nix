# compose.nix — pure attrset describing docker-compose.yml for introspect-proxy.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Single service: introspect-proxy — OIDC token introspection sidecar for Caddy
#   - Own code (Type A) packaged by ship engine via native_build.type=image-wrapper
#   - host networking so Caddy at 127.0.0.1 can forward_auth to :4182
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    introspect-proxy = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      # Bind to deploy host's WireGuard IP (data-driven from build.json bind_host).
      # Caddy forward_auth on gcp-proxy reaches us via WG (auth_upstreams =
      # `${vm.wg_ip}:${port}` per cloud-data-config-derive.ts). 0.0.0.0 is
      # forbidden by wg0-only policy; 127.0.0.1 unreachable from Caddy.
      command = [
        "gunicorn"
        "--bind" "${buildJson.bind_host}:${toString buildJson.ports.app}"
        # threads 1 -> 4: a single worker+thread meant ONE slow request (a cold
        # JWKS validation on a thrashing box) blocked /health, so docker's probe
        # timed out and re-fired every 30s, stacking hung python probes for half
        # an hour and adding to the memory pressure. 4 threads keeps /health
        # answerable while a real request is in flight.
        "--workers" "1" "--threads" "4" "--timeout" "120"
        "main:app"
      ];
      environment = {
        # Fetch keys straight from Authelia, NOT via
        # https://auth.diegonmarcos.com/jwks.json. That public hostname is a
        # circular dependency: the auth.diegonmarcos.com route is itself gated by
        # forward_auth against THIS proxy, so a cold JWKS fetch cannot complete
        # and every bearer validation fails "Auth key server unavailable" (502).
        # This is also the URL Authelia's own discovery document advertises as
        # jwks_uri. ISSUER stays on the public name — it is compared against the
        # token's `iss` claim, never dialled.
        #
        # NOT http://10.0.0.1:9091/jwks.json (Authelia's WireGuard-bound
        # publish address): its host-side docker-proxy for that published
        # port was observed hung on gcp-proxy 2026-08-22 (socket stayed
        # LISTEN, new connections got no SYN-ACK/RST, every fetch ate the
        # full HTTP timeout) — a known docker-proxy hang class, not a code
        # bug here. Target Authelia's auth-net bridge IP directly instead;
        # that path bypasses docker-proxy entirely and was verified live:
        # `docker exec introspect-proxy curl -sS -m5 -o /dev/null -w '%{http_code}'
        # http://172.18.0.3:9091/jwks.json` -> 200.
        # CAVEAT: this IP is dynamically assigned by Docker's IPAM for the
        # auth-net bridge and is only guaranteed stable until authelia's
        # container is next recreated (its build.json ships with
        # compose_flags "--build", which recreates on every ship). If mail
        # auth starts failing again after an authelia deploy, re-verify this
        # IP with `docker network inspect authelia_auth-net` and update here,
        # or pin authelia to a static ipv4_address on auth-net.
        JWKS_URL       = "http://172.18.0.3:9091/jwks.json";
        ISSUER         = "https://auth.diegonmarcos.com";
        REQUIRED_SCOPE = "authelia.bearer.authz";
        PORT           = toString buildJson.ports.app;
        # Fleet token engine (infra-sec_cloudy-ai-tokens-api, mesh name tokens-api.mesh.diegonmarcos.com): every Bearer is checked against its
        # live list, so a token revoked in Cloud Account stops working within TOKENS_CACHE_TTL (<= 60 s).
        # TOKENS_VERIFY_SECRET arrives through the env_file (src/secrets.yaml).
        TOKENS_VERIFY_URL = "http://tokens-api.mesh.diegonmarcos.com:4184/v1/verify";
        TOKENS_CACHE_TTL  = "30";
      };
      healthcheck = {
        # Hit the actual bind address (host network + wg0-only bind = no localhost
        # listener). bind_host is data-driven from build.json (10.0.0.1 on gcp-proxy).
        test = [
          "CMD" "python3" "-c"
          "import urllib.request; urllib.request.urlopen('http://${buildJson.bind_host}:${toString buildJson.ports.app}/health', timeout=25)"
        ];
        # The request itself answers in ~10 ms; what costs time is `docker exec` + python3 start-up on
        # gcp-proxy (944 MB RAM, swapping, load 10 during a ship). Measured 2026-10-17: a passing probe
        # took 9.3 s of the old 10 s budget, and probes timed out (exit -1) for 3+ hours of "unhealthy"
        # while /health answered 200 from the host. The address is right (wg0-only bind, no localhost
        # listener), so the budget is what changed: 30 s for the probe, 25 s for the socket inside it so
        # a hung request cannot outlive docker's timeout and stack probes.
        interval     = "60s";
        timeout      = "30s";
        retries      = 3;
        start_period = "60s";
      };
        # mem_limit/mem_reservation are optional in build.json (only
        # mem_reservation is declared fleet-wide today). Reading them
        # unconditionally fails eval with "attribute ... missing".
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
