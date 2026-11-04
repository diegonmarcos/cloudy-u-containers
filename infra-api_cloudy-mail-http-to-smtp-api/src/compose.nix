# compose.nix — docker-compose spec for http-to-smtp-proxy-api (Type A)
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    http-to-smtp-proxy-api = {
      image = binariesImage;
      container_name = app.container_name;
      restart = "no";
      # 0.4 MiB resident on gcp-proxy (944 MB VM): size the ceiling to the
      # workload, not the api category default (2G).
      deploy.resources.limits.memory = "64M";
      network_mode = "host";
      env_file = [ ".secrets" ];
      environment = {
        # Primary delivery: Maddy on the standard :25 (host network on
        # oci-mail). Maddy stays fully operational — receives + serves
        # IMAP/SMTPS for legacy clients and historical mail.
        SMTP_HOST = "10.0.0.3";
        SMTP_PORT = "25";
        LISTEN_HOST = svc."http-to-smtp-proxy-api".ip;
        LISTEN_PORT = toString buildJson.ports.app;
        # Shadow (parallel) delivery: Stalwart on :2025. Stalwart is the
        # JMAP backend — receives the same email in parallel so JMAP
        # clients (LTT.rs, cypht) see it too. Sieve rules run there
        # independent of Maddy's filtering.
        SMTP_SHADOW_HOST = "10.0.0.3";
        SMTP_SHADOW_PORT = "2025";
      };
    };
  };
}
