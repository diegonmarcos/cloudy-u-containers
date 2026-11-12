# compose.nix — docker-compose spec for google-workspace-mcp (Type A own-code, Python)
# engine.nix serialises this attrset via lib.generators.toYAML and merges
# compose-defaults.json into every service.
{ buildJson, container }:

let
  svc = container.services;
  app = buildJson.containers.app;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
  vmIp = svc."google-workspace-mcp".ip or "10.0.0.6";
  port = toString buildJson.ports.app;
in
{
  services = {
    google-workspace-mcp = {
      image = binariesImage;
      container_name = app.container_name;
      network_mode = "host";
      environment = {
        WORKSPACE_MCP_HOST = vmIp;
        WORKSPACE_MCP_PORT = port;
        PORT = port;
        USER_GOOGLE_EMAIL = buildJson.user_google_email;
        # Service-account + domain-wide-delegation auth (no interactive OAuth). The SA
        # key is materialised at the path below from the sops secret. Redeploy 2026-07-11
        # to actually roll this config onto the running container (prior ships skipped it
        # as "unchanged", so the container was still on the OAuth-client codepath).
        # Vendored workspace-mcp v1.14.3 reads GOOGLE_SERVICE_ACCOUNT_KEY_PATH
        # (auth/google_auth.py:_get_service_account_credentials). NOT _KEY_FILE —
        # that's the newer upstream `main` var name and has no effect here.
        GOOGLE_SERVICE_ACCOUNT_KEY_PATH = "/run/secrets/GOOGLE_SERVICE_ACCOUNT_KEY";
        # #1659 bounded memory. Heavy Drive calls stream through this directory
        # on the container's disk (never tmpfs: a tmpfs would count against the
        # memory limit again); it has a quota and is swept by age from /health.
        WORKSPACE_MCP_TMP_DIR = "/tmp/workspace-mcp";
        # At most this many file-moving calls at once; the rest wait, then get
        # a clear "busy" answer.
        WORKSPACE_MCP_HEAVY_CONCURRENCY = "2";
        # glibc gives every thread its own malloc arena (8 x cores); with upload
        # worker threads that is retained memory that never returns to the OS.
        MALLOC_ARENA_MAX = "2";
      };
      # Memory budget: build.json containers.app.resources is the one declaration.
      deploy.resources = {
        limits.memory = app.resources.mem_limit;
        reservations.memory = app.resources.mem_reservation;
      };
      # DIR-bind, not file-bind (2026-07-03): runc on oci-apps dies with
      # "mknod .../run/secrets/...: read-only file system" creating a FILE
      # mountpoint (tmpfs /run didn't help), while the fleet's standard
      # `.secrets.d:/run/secrets:ro` DIR-bind works on the same VM (rig).
      # The key file keeps its .secrets.d name; the env path points at it.
      volumes = [
        "./.secrets.d:/run/secrets:ro"
      ];
      healthcheck = {
        test = [
          "CMD"
          "curl"
          "-f"
          "http://${vmIp}:${port}/health"
        ];
        interval = "30s";
        timeout = "10s";
        retries = 3;
        start_period = "15s";
      };
    };
  };
}
