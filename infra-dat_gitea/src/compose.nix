# compose.nix — docker-compose spec for gitea (Type B wrap-upstream)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  app = buildJson.containers.app;
  giteaConfig = buildJson.gitea;
  gate     = giteaConfig.gate;
  identity = buildJson.proxy.primary.identity;
  portHttp = buildJson.ports.app;
  portSsh  = buildJson.ssh_port;
  domain   = buildJson.domain;
  socketDir = builtins.dirOf gate.socket;

  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    gitea = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      env_file = [ ".secrets" ];
      environment = {
        SSH_PORT                                     = toString portSsh;
        SSH_LISTEN_PORT                              = toString portSsh;
        GITEA__server__HTTP_PORT                     = toString portHttp;
        GITEA__server__SSH_PORT                      = toString portSsh;
        GITEA__server__SSH_LISTEN_PORT               = toString portSsh;
        GITEA__server__SSH_LISTEN_HOST               = buildJson.ssh_listen_host;
        GITEA__server__DISABLE_SSH                   = "false";
        GITEA__server__ROOT_URL                      = "https://${domain}";
        # Gitea >=1.24 defaults to "auto": it builds clone_url/html_url from the
        # request's Host, so a mesh caller of 10.0.0.6:3002 was handed
        # http://10.0.0.6:3002/... — unreachable off-mesh, and indistinguishable
        # from the service being down for a client that honours the listing.
        # "never" makes ROOT_URL (the public edge) the only projection.
        GITEA__server__PUBLIC_URL_DETECTION          = "never";
        GITEA__server__SSH_DOMAIN                    = domain;
        GITEA__mirror__DEFAULT_INTERVAL              = giteaConfig.mirror_interval;
        GITEA__repository__ENABLE_PUSH_CREATE_USER   = "true";
        GITEA__repository__ENABLE_PUSH_CREATE_ORG    = "true";
        # HTTP only on a unix socket that gitea-gate alone mounts (see
        # build.json gitea.gate._doc): gitea trusts its user header from ANY
        # peer, so no TCP listener may reach it. :3002 is the gate.
        GITEA__server__PROTOCOL                      = "http+unix";
        GITEA__server__HTTP_ADDR                     = gate.socket;
        # Reverse-proxy auth: the edge maps a validated fleet identity to a
        # gitea user (build.json proxy.primary.identity). An unknown name must
        # never create an account.
        GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION     = "true";
        GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION_API = "true";
        GITEA__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION  = "false";
        GITEA__service__ENABLE_REVERSE_PROXY_EMAIL              = "false";
        GITEA__service__ENABLE_REVERSE_PROXY_FULL_NAME          = "false";
        GITEA__security__REVERSE_PROXY_AUTHENTICATION_USER      = identity.header;
        # The image default is `*` (any peer may rewrite the client IP). The
        # only peer left is the gate over the socket, which chi-proxy reports
        # as 127.0.0.1; the gate forwards X-Real-IP only from trusted_proxies.
        GITEA__security__REVERSE_PROXY_TRUSTED_PROXIES          = "127.0.0.1/32";
        GITEA__security__REVERSE_PROXY_LIMIT                    = "1";
      };
      volumes = [
        "gitea_data:/data"
        "gitea_http:${socketDir}"
        # DELIBERATELY NOT MOUNTED HERE: cloud-git-gh, the agents' shared
        # working tree. It used to be mounted at /data/git-gh, and that mount
        # was the root writer.
        #
        # Gitea never used it. Every reference to /data/git-gh in this repo is
        # a COMMENT — Gitea serves its own repositories out of
        # /data/gitea-repositories and has no code path that reads or writes
        # /data/git-gh. The mount existed for filing reasons alone ("Gitea is
        # the fleet's git host and this is git data").
        #
        # What it cost: this container sets no `user` and the Gitea image
        # inits its supervision tree as root, so it was the ONLY root-capable
        # process holding the agents' tree read-write. Measured 2026-09-20:
        # 260 root-owned entries across four repos — cloud-data-my-ai-memory
        # (247, including .git/config, .git/HEAD, ~117 object fanout dirs, all
        # of c_tasks/ and the whole a_sessions/galaxy/ tree), cloud-infra (8),
        # cloud-data (4), cloud-u-linux (1). Agents run as uid 10001 and
        # cannot write root-owned paths, so their commits failed deep inside a
        # subprocess with "insufficient permission for adding an object" and
        # the turn still reported success. That is why the c_tasks backlog
        # went stale and why #540's session sync kept failing on
        # a_sessions/galaxy — not a sync bug, a permission denial nobody saw.
        #
        # The chown is the repair; removing this mount is the fix. Do not add
        # it back: Gitea gains nothing from it and is the one process here
        # that can poison the tree for everyone else.
        "/etc/timezone:/etc/timezone:ro"
        "/etc/localtime:/etc/localtime:ro"
      ];
      healthcheck = {
        test = [ "CMD" "curl" "-fsS" "--unix-socket" gate.socket "http://localhost/api/healthz" ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
      };
    };

    # The only door to gitea's HTTP: forwards the identity header only from
    # the measured edge for this vhost, strips it from everyone else.
    gitea-gate = {
      image = gate.image;
      container_name = "${app.container_name}-gate";
      network_mode = "host";
      depends_on = [ "gitea" ];   # gitea must release :3002 before the gate binds it
      volumes = [
        "gitea_http:${socketDir}"
        "./configs/gate.Caddyfile:/etc/caddy/Caddyfile:ro"
      ];
      tmpfs = [ "/data" "/config" ];   # the image's VOLUMEs; nothing here needs to persist
      healthcheck = {
        test = [ "CMD" "wget" "-q" "-O" "/dev/null" "http://127.0.0.1:${toString portHttp}/api/healthz" ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
      };
    };
  };
  volumes = {
    gitea_data = {};
    # Holds only the socket. tmpfs owned by the image's git user (1000), so
    # gitea can create it; mounted by gitea and gitea-gate and nothing else.
    gitea_http = {
      driver_opts = { type = "tmpfs"; device = "tmpfs"; o = "size=1m,uid=1000,gid=1000,mode=0770"; };
    };
    # git_gh is gone on purpose — see the volumes list above. Declaring a
    # volume this project no longer mounts would be dead code that invites
    # someone to "restore the missing mount". The pinned-name declaration
    # still lives in user-ai_cloudy-ai-claude-api and _shared/engine.nix, which
    # are the projects that actually use the tree.
  };
}
