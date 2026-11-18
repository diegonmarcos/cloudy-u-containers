# compose.nix — cloudy-apps-communication-mcp (#1450): cloud-mail-mcp + cloud-mattermost-mcp merged.
#   One Node MCP server (code/mcp, Node 22 + tsx) exposing the `mail` and `mattermost` meta-tools plus the
#   proxied google-personal-mcp tools. Replaces cloud-mail-mcp on the same port (3103); the engine's port
#   eviction hands the port over at deploy.
#
#   Env and volumes are a SUPERSET of the two services it replaces:
#     cloud-mail-mcp        host network, extra_hosts pin, every MAIL/MADDY/STALWART var, PROXIED_MCPS,
#                           /opt/ssh-keys/<container>:/root/.ssh:ro (mail_admin_users ssh to oci-mail)
#     cloud-mattermost-mcp  MCP_HTTP_PORT + MCP_HTTP_HOST; MM_* come from the secrets file
#   Rationale for each mail setting (host network, extra_hosts, SMTP-by-IP, STALWART_ADMIN_URL override) is
#   documented in infra-api_cloud-mail-mcp/src/compose.nix; the values are identical here.
#   Secrets (MADDY_ME_*/MAIL_*, RESEND_API_KEY, STALWART_ADMIN_*, CF_API_*, MM_*) come from the sops file in
#   the private vault via .secrets; never committed.
{ buildJson, container }:

let
  svc  = container.services or {};
  app  = buildJson.containers.app;
  mh   = buildJson.mail_hosts;
  mp   = buildJson.mail_ports;
  name = app.container_name;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  # Same host (oci-apps) and therefore the same WG IP as the two services it replaces.
  vmIp  = (svc.${name} or svc."cloud-mail-mcp" or {}).ip or "10.0.0.6";
  port  = toString buildJson.ports.app;
  stalwartJmap = "https://${mh.stalwart}:${toString mp.stalwart_jmap_https}";
  mailWgIp     = "10.0.0.3";   # oci-mail over the mesh

  # Child MCPs resolved from cloud-data services{} (same as cloud-mail-mcp). Host network -> WG IPs.
  proxyCfg = buildJson.proxied_mcps or { children = []; retry = {
    initial_ms              = 10000;
    max_ms                  = 120000;
    max_retry_state_entries = 32;
  }; };
  resolveChild = child:
    let s = svc.${child.service}; in {
      inherit (child) name path;
      url = "http://${s.ip}:${toString s.ports.app}${child.path}";
    };
  proxiedMcpsJson = builtins.toJSON {
    children = map resolveChild proxyCfg.children;
    retry    = proxyCfg.retry;
  };
in
{
  services = {
    "cloudy-apps-communication-mcp" = {
      image          = binariesImage;
      container_name = name;
      network_mode   = "host";
      env_file       = [ ".secrets" ];
      extra_hosts    = [
        "${mh.maddy}:${mailWgIp}"
        "${mh.stalwart}:${mailWgIp}"
      ];
      environment = {
        # cloud-mail-mcp set PORT, cloud-mattermost-mcp set MCP_HTTP_PORT; the merged code reads MCP_HTTP_PORT.
        PORT                = port;
        MCP_HTTP_PORT       = port;
        MCP_HTTP_HOST       = vmIp;
        MAIL_HOST           = mh.maddy;
        MADDY_HOST          = mh.maddy;
        MADDY_SMTP_IP       = mailWgIp;
        STALWART_SMTP_IP    = mailWgIp;
        MADDY_IMAP_PORT     = toString mp.maddy_imap;
        MADDY_SMTP_PORT     = toString mp.maddy_smtp;
        STALWART_HOST       = mh.stalwart;
        STALWART_IMAP_PORT  = toString mp.stalwart_imap;
        STALWART_SMTP_PORT  = toString mp.stalwart_smtp;
        STALWART_JMAP_URL   = stalwartJmap;
        STALWART_ADMIN_URL  = stalwartJmap;
        PROXIED_MCPS        = proxiedMcpsJson;
      };
      # ssh-keys.nix populates /opt/ssh-keys/<container>/ from build.json `ssh`. The two secret mounts are what
      # the Ship render (vault overlaid) adds; declaring them keeps the public render identical (no dist drift).
      volumes = [
        "/opt/ssh-keys/${name}:/root/.ssh:ro"
        "./.secrets.d:/run/secrets:ro"
        "./.secrets.json:/run/secrets.json:ro"
      ];
      deploy.resources = {
        reservations = { memory = app.resources.mem_reservation; };
      };
    };
  };
}
