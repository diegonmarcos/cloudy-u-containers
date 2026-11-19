# compose.nix — pure attrset describing docker-compose.yml for stalwart.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
{ buildJson, container, base_domain, lib }:

let
  app    = buildJson.containers.app;
  sorter = buildJson.containers.sorter;

  # Image name is taken from build.json docker.{registry,image}. Stalwart's
  # docker.image = "stalwart" (no -binaries suffix), so the compose reference
  # must match — not a templated "<name>-binaries". Getting this wrong yields
  # "manifest denied" at compose pull time because the package doesn't exist.
  binariesImage = "${buildJson.docker.registry}/${buildJson.docker.image}:latest";
  appPort       = toString app.port;

  # Internal JMAP listener port (= what Stalwart binds INSIDE its container).
  # SoT: extra_ports entry where service == "jmap_tls" — already declared
  # in build.json with container_port = 443 (v0.16 standard binding).
  # Used by the sorter sidecar which is on the docker bridge network and
  # must reach Stalwart via container DNS + internal port, not host port.
  jmapInternalEntry = lib.findFirst
    (ep: (ep.service or null) == "jmap_tls")
    null
    (app.extra_ports or []);
  appJmapInternalPort = toString (
    if jmapInternalEntry == null
    then throw "stalwart compose.nix: no extra_ports entry with service=\"jmap_tls\" — sorter cannot derive JMAP_URL. Fix: declare jmap_tls in build.json::containers.app.extra_ports."
    else jmapInternalEntry.container_port
  );

  # Port mappings driven by extra_ports[].bind in build.json. The `bind` field
  # accepts either a single string ("10.0.0.3") or a list of strings
  # (["10.0.0.3" "10.1.0.3"]) — Phase 4 of the wg-public migration adds the
  # second wg-public bind so Caddy on oci-analytics can reach mail ports via
  # the public-trust mesh (10.1.0.x) without traversing wg0 (10.0.0.x).
  # Format per emitted line: "BIND_IP:HOST_PORT:CONTAINER_PORT".
  bindList = ep:
    let raw = ep.bind or "0.0.0.0"; in
    if builtins.isList raw then raw else [ raw ];

  # extra_ports[].container_port (v0.16 maps offset host port → standard
  # container port; v0.14/v0.15 omitted the field so host == container).
  portMappings = lib.flatten (map (ep:
    let containerPort = ep.container_port or ep.port; in
    map (ip: "${ip}:${toString ep.port}:${toString containerPort}") (bindList ep)
  ) (app.extra_ports or []));
in
{
  services = {
    stalwart = {
      # v0.16.5 migrated bootstrap (data-store-only config.json + JMAP-object
      # settings in RocksDB). config.toml is NOT used in v0.16+ (v0.13 format,
      # incompatible). recovery_mode flag in build.json gates STALWART_RECOVERY_{MODE,ADMIN}
      # env vars; flip true for first bootstrap, false for production.
      image          = "stalwartlabs/stalwart:v0.16.5";
      container_name = app.container_name;
      entrypoint     = [ "stalwart" "--config" "/opt/stalwart-mail/etc/config.json" ];
      ports          = portMappings;
      env_file       = [ ".secrets" ];
      environment = {
        TZ = buildJson.timezone;
        # Tells Stalwart what URL clients reach Caddy on so JMAP Session
        # apiUrl/downloadUrl/uploadUrl/eventSourceUrl don't leak the
        # container's internal listener bind port (:2443).
        STALWART_PUBLIC_URL = "https://${buildJson.domain}";
        STALWART_HOSTNAME   = buildJson.domain;
      } // (lib.optionalAttrs (buildJson.recovery_mode or false) {
        # ── RECOVERY-MODE BOOTSTRAP ONLY ──────────────────────────────
        # Set buildJson.recovery_mode = true on FIRST v0.16 boot to wipe
        # settings/quotas/reports/directory and accept admin via the env
        # admin credential below. Then run `stalwart-cli apply` against
        # this container to seed Domain + Account + Listener etc. AFTER
        # successful apply, flip back to false and redeploy — Stalwart
        # boots into production mode with the persisted JMAP-object state.
        STALWART_RECOVERY_MODE  = "1";
        STALWART_RECOVERY_ADMIN = "admin:\${ADMIN_PASSWORD}";
      });
      # Overrides the image's HEALTHCHECK (stalwartlabs/stalwart v0.16.5
      # Dockerfile: interval 30s, timeout 5s, start-period 30s, retries 3).
      # The probe is the image's own, with $STALWART_HEALTHCHECK_URL written
      # out (compose would interpolate a bare `$`). Only the timing changes:
      # on oci-mail (1 OCPU, 954MiB) 2026-11-18, under IO pressure Stalwart
      # answered SMTP fine but /healthz/live took longer than 5s, so it was
      # reported unhealthy (FailingStreak 7) while serving mail.
      healthcheck = {
        test = [ "CMD-SHELL" "curl -fsSk -H 'X-Forwarded-For: 127.0.0.1' https://127.0.0.1:443/healthz/live || curl -fsS -H 'X-Forwarded-For: 127.0.0.1' http://127.0.0.1:8080/healthz/live || exit 1" ];
        interval     = "60s";
        timeout      = "20s";
        retries      = 3;
        start_period = "180s";
      };
      volumes = [
        "stalwart_data:/opt/stalwart-mail/data"
        # TLS provisioned out-of-band by Caddy (shared with maddy's /opt/containers/maddy/tls)
        "/opt/containers/maddy/tls:/opt/stalwart-mail/tls:ro"
        "./configs/config.json:/opt/stalwart-mail/etc/config.json:ro"
      ];
      # Ceilings come from build.json containers.app.resources.{mem_limit,cpus}
      # (the ONE declaration; numbers and the measurements behind them are in
      # its _doc_limits). Read conditionally, same as the sorter below: a
      # removed declaration degrades to the engine's category default instead
      # of `attribute missing`. Gate: _shared/test-mail-stack-limits.mjs.
      deploy.resources = {
        reservations = { memory = app.resources.reservations.memory; };
      } // lib.optionalAttrs (app.resources ? mem_limit || app.resources ? cpus) {
        limits =
          lib.optionalAttrs (app.resources ? mem_limit) { memory = app.resources.mem_limit; }
          // lib.optionalAttrs (app.resources ? cpus) { cpus = app.resources.cpus; };
      };
    };
    stalwart-sorter = {
      image          = sorter.image;
      container_name = sorter.container_name;
      entrypoint     = [ "jmap-sorter" ];
      env_file       = [ ".secrets" ];
      environment = {
        # Container-to-container: use the bridge-network DNS name (matches
        # app.container_name) + the INTERNAL JMAP port. Previous value
        # `https://localhost:${appPort}` was a long-standing bug — the sorter
        # is on `stalwart_default` bridge so `localhost` = sorter's own
        # loopback (nothing listening), and `appPort` is the HOST mapping
        # (2443), not the internal one (443). Result: Connection refused
        # every 120s → cleanup_stale() never runs → renamed/old folders
        # accumulate as duplicates in Stalwart's mailbox list.
        JMAP_URL       = "https://${app.container_name}:${appJmapInternalPort}";
        RULES_PATH     = "/data/mail-rules.json";
        STARTUP_DELAY  = "20";
        # 30s (the code default) re-queried 27 filter views over a 9k-message
        # Inbox every half minute and was the bulk of this box's IO pressure
        # (psi io full ~15% -- 15% of every window with EVERY task stalled on
        # disk, on 2 cores shared with maddy). Nothing these views partition on
        # is fast-moving: the tightest time window is measured in hours, and
        # read-state can lag a few minutes without anyone noticing. 300s is the
        # same work at a tenth the cost.
        #
        # 300 -> 1800 (2026-10-13). On oci-mail (1 OCPU E2.1.Micro, ~950MiB)
        # one pass -- Email/get of ~11.7k messages with bodyStructure + headers
        # for 34 views, then the routing pass -- took ~8 min (21:56 -> 22:04),
        # so a 300s sleep kept Stalwart busy ~60% of the time: 110-160% CPU and
        # 105GB read in 21h, load 6-10. At 1800s the same pass is ~20% duty.
        # Nothing user-visible waits on it: the SuperApp's `.reapply` sentinel
        # still forces an immediate pass (checked every 10s, see main.rs TICK).
        # Gate: _shared/test-mail-stack-limits.mjs (>= 1800).
        POLL_INTERVAL  = "1800";
      };
      # Only the rules travel as an asset now — the sorter itself is compiled
      # into the image (docker.native_build), so there is no interpreter and
      # no source file to keep in sync with the container.
      volumes = [
        "./assets/mail-rules.json:/data/mail-rules.json:ro"
      ];
      # Reservations are a floor and always declared; a memory LIMIT is
      # optional and only emitted when build.json still declares one.
      # 9ad4168d2 removed limits fleet-wide (memory.max is a local wall that
      # force-reclaims per-container regardless of host free RAM) but left
      # this reference behind, so every stalwart build since then died with
      # `attribute 'mem_limit' missing`. Reading it conditionally means the
      # next limit removal degrades to "no limit" instead of a build break.
      deploy.resources = {
        reservations = { memory = sorter.resources.mem_reservation; };
      } // lib.optionalAttrs (sorter.resources ? mem_limit) {
        limits = { memory = sorter.resources.mem_limit; };
      };
    };
  };
  volumes = {
    stalwart_data = {};
  };
  # #1821: oci-apps' firewall (b_infra firewall.nix) forwards and masquerades only 172.16.0.0/12.
  # Docker's default pool there is exhausted (every 172.17-31 /16 is taken), so the stalwart_default
  # bridge was handed 192.168.144.0/20: its outbound traffic (DNS, the OCI relay, the maddy relay) was
  # dropped by the FORWARD policy and every DNS check timed out (SPF/DKIM/DMARC 15 s each). Pinning a
  # subnet inside 172.16.0.0/12 that no other network uses (172.16.0.0/16 is unused) fixes that, and also
  # makes the local-container source range match comm-mcp's ingest allow-list (172.16.0.0/12).
  networks = {
    default = {
      ipam.config = [ { subnet = "172.16.100.0/24"; } ];
    };
  };
}
