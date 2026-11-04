# compose.nix — docker-compose spec for c3-infra-api (Type A own-code)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."c3-infra-api".ip or "10.0.0.6";  # oci-apps WG IP
  port = toString buildJson.ports.app;

  # base_domain derived from proxy parent_domain
  # e.g. "api.diegonmarcos.com" → "diegonmarcos.com"
  parent_domain = buildJson.proxy.primary.parent_domain;
  base_domain =
    let parts = builtins.filter (s: s != "") (builtins.split "\\." parent_domain);
        str = builtins.filter builtins.isString parts;
    in builtins.concatStringsSep "." (builtins.tail str);
  auth_domain = "auth.${base_domain}";
  auth_token_url = "https://${auth_domain}/api/oidc/token";
in
{
  services = {
    c3-infra-api = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      env_file = [ ".secrets" ];
      environment = {
        HOST = vmIp;
        PORT = port;
        NODE_ENV = "production";
        GIT_BASE = "/root/git";
        AUTHELIA_OIDC_CLIENT_ID = app.container_name;
        AUTHELIA_OIDC_CLIENT_SECRET = "\${AUTHELIA_OIDC_C3_INFRA_MCP_SECRET}";
        AUTHELIA_TOKEN_URL = auth_token_url;
        RESEND_API_KEY = "\${RESEND_API_KEY}";
        CF_API_KEY = "\${CF_API_KEY}";
        CF_API_EMAIL = "\${CF_API_EMAIL}";
        PATH = "/usr/local/nix-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        REPO_SYNC = "off";
      };
      volumes = [
        "/opt/ssh-keys/${app.container_name}:/root/.ssh:ro"
        "/nix/store:/nix/store:ro"
        "/home/ubuntu/.nix-profile/bin:/usr/local/nix-bin:ro"
        "~/.config/gcloud:/root/.config/gcloud"
        "octocode_repos:/root/git"
        "c3_public_logs:/app/public/logs"
        # Personal data (names/emails/phones), one file per install id. A named
        # volume so an erasure is a real unlink that survives redeploys, rather
        # than a record that reappears when the container is recreated.
        "c3_fleet_profiles:/app/data/fleet-profiles"
      ];
      healthcheck = {
        test = [
          "CMD-SHELL"
          "curl -fsS http://${vmIp}:${port}/health >/dev/null 2>&1 || exit 1"
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "15s";
      };
    };
  };
  volumes = {
    octocode_repos = { name = "octocode_repos"; };
    c3_public_logs = { };
    c3_fleet_profiles = { };
  };
}
