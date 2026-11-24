# compose.nix — pure attrset describing docker-compose.yml for maddy.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
{ buildJson, container, base_domain }:

let
  app = buildJson.containers.app;

  # Engine wraps the upstream maddy image into
  # ghcr.io/diegonmarcos/<name>-binaries:latest; at runtime we pull that image.
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    maddy = {
      image = binariesImage;
      container_name = app.container_name;
      # host network: maddy binds privileged SMTP/IMAP/submission ports
      # (25/143/465/587/993). VM INPUT policy is DROP except WG + lo, so
      # mail ports stay reachable only via the Caddy L4 proxy on gcp-proxy.
      network_mode = "host";
      entrypoint = [ "sh" "/etc/maddy/init.sh" ];
      env_file = [ ".secrets" ];
      environment = {
        # maddy-sorter's own config (init.sh backgrounds it before `exec
        # maddy run` -- same container, same process tree, so it sees
        # these same env vars too; maddy itself ignores the ones it
        # doesn't know about).
        IMAPSQL_DB = "/data/imapsql.db";
        RULES_PATH = "/data/mail-rules.json";
        # #1883 per-message classifier engine: shadow = shell answers, Rust (maddy-sorter deliver) is compared and
        # logged; rust = Rust answers with the shell as per-message fallback; shell = pre-migration behaviour.
        DELIVER_ENGINE = "shadow";
        STARTUP_DELAY = "30";
        # 120 -> 300 (2026-11-18 oci-mail incident: load 13, IO PSI ~75%,
        # maddy 145 GB read). Only the category COPIES wait on this; INBOX
        # delivery is immediate and unaffected.
        POLL_INTERVAL = "300";
        # The pre-apply imapsql.db backup is a full file copy. It ran on every
        # pass that found new mail, evicting the DB's page cache from this
        # 128-192M cgroup each time. Now at most one per 6 h (newest-20
        # retention unchanged). See db::backup_if_due.
        BACKUP_MIN_INTERVAL = "21600";
      };
      volumes = [
        "maddy_data:/data"
        # Config + startup script (rendered by engine into dist/configs/)
        "./configs/maddy.conf.tpl:/etc/maddy/maddy.conf.tpl:ro"
        "./configs/init.sh:/etc/maddy/init.sh:ro"
        # Wildcard cert from Caddy, pushed out-of-band to the VM
        "./tls:/data/tls:ro"
        # DKIM keys: init.sh writes from DKIM_PRIVATE_KEY_B64 secret into the
        # maddy_data volume at /data/dkim. DO NOT bind-mount ./dkim here —
        # it would shadow the volume path with a read-only host dir and
        # crash init on first start. Source of truth is the sops secret.
        # Delivery-time Sieve-subset filter. Maddy forks the script per incoming
        # message via imap_filter.command (see maddy.conf.tpl). mail-rules.json
        # is the canonical single source of truth (also drives Stalwart's Sieve
        # via _shared/lib/derive-mail-rules.ts; here we mount the Maddy subset).
        "./assets/mail-rules.json:/data/mail-rules.json:ro"
        "./assets/mail-sieve-subset-delivery-time.sh:/usr/local/bin/mail-sieve-subset-delivery-time:ro"
        # #1883: the imap_filter command is this wrapper; it runs the shell script above (authoritative) and the Rust
        # `maddy-sorter deliver` side by side (DELIVER_ENGINE=shadow), see the script header.
        "./assets/mail-sieve-subset-delivery-shadow.sh:/usr/local/bin/mail-sieve-subset-delivery-shadow:ro"
        # Post-hoc maintenance script (operator-triggered via build.sh
        # post-hoc-* lifecycle hooks). SQL-direct on imapsql.db for 30k-scale
        # safety. Subcommands: integrity-check, integrity-fix, recover-headers,
        # apply-rules, dedupe, cleanup-mailboxes, all.
        "./assets/mail-sieve-subset-post-hoc.sh:/usr/local/bin/mail-sieve-subset-post-hoc:ro"
      ];
      # Ceiling from build.json containers.app.resources.mem_limit (the ONE
      # declaration, measured numbers in its _doc_mem_limit); the older
      # resources.limits.memory shape is still honoured. Read conditionally so
      # a removed declaration degrades to the engine's category default
      # (_shared/memory-ceiling.nix) instead of a build failure.
      # (Pure nix rather than lib.optionalAttrs: this compose.nix isn't
      # passed `lib`.) Gate: _shared/test-mail-stack-limits.mjs.
      deploy.resources = {
        reservations = { memory = app.resources.reservations.memory; };
      } // (if app.resources ? mem_limit
            then { limits = { memory = app.resources.mem_limit; }; }
            else if app.resources ? limits
            then { limits = { memory = app.resources.limits.memory; }; }
            else {});
    };
  };
  volumes = {
    maddy_data = {};
  };
}
