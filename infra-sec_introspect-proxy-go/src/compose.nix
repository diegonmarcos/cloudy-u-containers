# compose.nix — pure attrset describing docker-compose.yml for introspect-proxy-go.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# Shadow stage of ticket #1872: the Go port runs beside the Python introspect-proxy on the
# same host, on its own port, and is NOT in Caddy's request path (Caddy's forward_auth still
# targets 10.0.0.1:4182). Every SHADOW_COMPARE_INTERVAL it sends a fixed fixture set (no
# credentials: random ft_/mcpat_ tokens, JWTs with the live kid and a junk signature) to both
# itself and the Python container, against the live Authelia JWKS and tokens-api, and logs
# `shadow-compare PASS|FAIL: N cases, M mismatches`.
#
# Configuration is the Python container's, value for value (same JWKS_URL pin, ISSUER,
# REQUIRED_SCOPE, TOKENS_VERIFY_URL, TOKENS_CACHE_TTL). TOKENS_VERIFY_SECRET is read from the
# Python service's own materialised env_file on this host (../introspect-proxy/.secrets, written
# by its ship's secrets step), so no secret is copied or re-encrypted for the shadow.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  bind = "${buildJson.bind_host}:${toString buildJson.ports.app}";
  bin  = "/usr/local/bin/${buildJson.docker.native_build.binary}";
in
{
  services = {
    introspect-proxy-go = {
      image = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
      container_name = app.container_name;
      network_mode = "host";
      read_only = true;
      command = [ bin "-listen" bind ];
      env_file = [ "../introspect-proxy/.secrets" ];
      environment = {
        JWKS_URL          = "http://172.18.0.3:9091/jwks.json";
        ISSUER            = "https://auth.diegonmarcos.com";
        REQUIRED_SCOPE    = "authelia.bearer.authz";
        TOKENS_VERIFY_URL = "http://tokens-api.mesh.diegonmarcos.com:4184/v1/verify";
        TOKENS_CACHE_TTL  = "30";
        SHADOW_COMPARE_URL      = "http://10.0.0.1:4182";
        SHADOW_COMPARE_INTERVAL = "6h";
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
