# compose.nix — docker-compose spec for git-proxy-api (Type A, own code).
#
# Runs on oci-analytics, host network, bound to that VM's wg0 address. Caddy on
# gcp-proxy reverse-proxies api.diegonmarcos.com/git/* here after forward_auth
# against infra-sec_introspect-proxy, so the phone presents the Authelia bearer
# it already holds and never sees a GitHub credential (#647).
#
# Every value below comes from build.json. The two runtime dependencies
# (auth.diegonmarcos.com/jwks.json, api.github.com) are declared in
# build.json#runtime and read by the code itself — nothing is hardcoded here
# that build.json does not already say.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";

  # oci-analytics wg0 address, from cloud-data once the derive engine has run.
  # The literal is only a safety net so the flake still evaluates on the very
  # first ship, before 9_others has emitted this service's entry — the same
  # fallback c3-public-api uses on this VM. 0.0.0.0 is forbidden by the wg0-only
  # bind policy and 127.0.0.1 is unreachable from Caddy, so neither is an option.
  myIp = svc."git-proxy-api".ip or "10.0.0.4";
  port = toString buildJson.ports.app;
in
{
  services = {
    git-proxy-api = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      # GITHUB_TOKEN only. Decrypted from src/secrets.yaml by the ship's
      # step_secrets and written to dist/.secrets — it exists nowhere in this
      # repo in plaintext and never travels to a client.
      env_file = [ ".secrets" ];
      environment = {
        BIND_HOST = myIp;
        PORT = port;
        NODE_ENV = "production";
      };
      volumes = [ ];
      healthcheck = {
        # node, not curl: the base image needs no extra package for this, and
        # the probe hits the real bind address (host network + wg0-only bind
        # means there is no localhost listener to cheat against).
        test = [
          "CMD-SHELL"
          ("node -e \"require('http').get('http://${myIp}:${port}/health',"
            + "r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\"")
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "15s";
      };
      # Read only what build.json actually declares: reading an absent attribute
      # fails eval with "attribute ... missing", and only mem_reservation is
      # declared fleet-wide today.
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
}
