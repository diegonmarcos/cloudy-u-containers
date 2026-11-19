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
  # #1802/#1803 delivery REST surface (build.json#delivery_api) -> env for code/mcp/delivery/index.ts.
  dapi   = buildJson.delivery_api or {};
  dprobe = dapi.probe or {};
  csv    = l: builtins.concatStringsSep "," l;
  probeOverrides = csv (map (d: "${d}=${dprobe.overrides.${d}}") (builtins.attrNames (dprobe.overrides or {})));

  proxiedMcpsJson = builtins.toJSON {
    children = map resolveChild proxyCfg.children;
    retry    = proxyCfg.retry;
  };
in
{
  services = {
    # The app runs as 10001:999 (the image's appuser) but ./data is created on
    # the host by the deploy user (1001), so every ledger write failed with
    # EACCES and the #1802 delivery-status ledger was never persisted
    # (2026-11-19, "persist failed: EACCES /data/delivery-ledger.jsonl").
    # Same one-shot root repair as user-data_cloudy-browser-scrapper-api.
    # `$$` = compose escape for a literal `$`.
    "cloudy-apps-communication-mcp-data-owner" = {
      image          = "busybox:1.37";
      container_name = "${name}-data-owner";
      user           = "0:0";
      restart        = "no";
      network_mode   = "none";
      volumes        = [ "./data:/data" ];
      command        = [ "sh" "-c" "set -eu; chown -R 10001:999 /data; left=$$(find /data ! -user 10001 | wc -l); echo \"[comm-mcp-data-owner] wrong-owner paths left=$$left\"; [ \"$$left\" -eq 0 ]" ];
    };
    "cloudy-apps-communication-mcp" = {
      depends_on     = { "cloudy-apps-communication-mcp-data-owner" = { condition = "service_completed_successfully"; }; };
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
        # Mattermost runs on this VM bound to the WG IP (user-comm_chat-mattermost ports.app, oci-apps), never on
        # loopback: the MM_URL=http://127.0.0.1:8065 carried by the secrets file made every mattermost call
        # "fetch failed". environment wins over env_file, so the declared address is the one used.
        MM_URL              = "http://${vmIp}:8065";
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
        DELIVERY_LEDGER_PATH    = dapi.ledger_path or "/data/delivery-ledger.jsonl";
        DELIVERY_RETENTION_DAYS = toString (dapi.retention_days or 90);
        DELIVERY_RELAY_HOSTS    = csv (dapi.relay_hosts or []);
        DELIVERY_LOCAL_DOMAINS  = csv (dapi.local_domains or []);
        DELIVERY_INGEST_ALLOWED = csv (dapi.ingest_allowed or [ mailWgIp ]);
        DELIVERY_DNS_SERVERS    = csv (dapi.dns_servers or []);
        PROBE_HELO              = dprobe.helo or "localhost";
        PROBE_MAIL_FROM         = dprobe.mail_from or "";
        PROBE_PORT              = toString (dprobe.port or 25);
        PROBE_TIMEOUT_MS        = toString (dprobe.timeout_ms or 6000);
        PROBE_DIALOGUE_BUDGET_MS    = toString (dprobe.timeout_ms or 6000);
        PROBE_CONNECT_TIMEOUT_MS    = toString (dprobe.connect_timeout_ms or 3000);
        PROBE_CANARY_HOST           = dprobe.canary_host or "gmail-smtp-in.l.google.com";
        PROBE_PORT25_RECHECK_MS     = toString (dprobe.recheck_ms or 3600000);
        RECIPIENT_REQUEST_BUDGET_MS = toString (dprobe.request_budget_ms or 8000);
        PROBE_OVERRIDES         = probeOverrides;
        RECIPIENT_CACHE_TTL_MS         = toString (dapi.recipient_cache_ttl_ms or 21600000);
        RECIPIENT_CACHE_TTL_UNKNOWN_MS = toString (dapi.recipient_cache_ttl_unknown_ms or 900000);
        RECIPIENT_RATE_LIMIT           = toString (dapi.recipient_rate_limit_per_min or 60);
      };
      # ssh-keys.nix populates /opt/ssh-keys/<container>/ from build.json `ssh`. The two secret mounts are what
      # the Ship render (vault overlaid) adds; declaring them keeps the public render identical (no dist drift).
      volumes = [
        "/opt/ssh-keys/${name}:/root/.ssh:ro"
        "./.secrets.d:/run/secrets:ro"
        "./.secrets.json:/run/secrets.json:ro"
        # #1802 delivery-status ledger (JSONL). deploy.excludes keeps rsync off it.
        "./data:/data"
      ];
      deploy.resources = {
        reservations = { memory = app.resources.mem_reservation; };
      };
    };
  };
}
