{
  description = "Maddy Mail Server — declarative all-in-one SMTP/IMAP (dist layout v2, flake as orchestrator)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-maddy.json);

    engine       = import ../../_shared/engine.nix;
    lib          = nixpkgs.lib;

    # Mail rules are COMPILED, not computed here. _shared/lib/derive-mail-rules.ts
    # reads the canonicals (which live in Stalwart's src/; the two JSONs beside
    # this flake are symlinks back to them) and writes dist/assets/mail-rules.json
    # — the Maddy subset. This flake only READS that file: to mount it, and to
    # learn which folders exist. Was toMaddyJson + builtins.toJSON here.
    maddyRules = builtins.fromJSON (builtins.readFile ../dist/assets/mail-rules.json);

    # F0 sender-classification folders (Fa..Fk, Fz) -- the ONLY category
    # folders Maddy routes into now (see toMaddyJson). Unlike Stalwart,
    # nothing here auto-creates a target mailbox: apply-rules' SQL-direct
    # COPY only UPDATEs an existing mboxes row, it never INSERTs one, so
    # these must exist before the first apply-rules run or every copy into
    # them silently no-ops. `maddy imap-mboxes create` is idempotent enough
    # for a boot-time init.sh (errors on a folder that already exists;
    # piped to /dev/null + `|| true` like every other create call here).
    # Every folder the subset routes into. Same list as before: the emitter
    # builds one rule per sender view, in view order.
    senderFolders = map (r: r.folder) (maddyRules.rules or []);

    # base_domain derived from service domain: "mail.example.com" → "example.com"
    base_domain =
      lib.concatStringsSep "." (lib.drop 1 (lib.splitString "." buildJson.domain));

    # Per-port listener prefixes: reads extra_ports[].bind from build.json and
    # generates LISTEN_25, LISTEN_465, LISTEN_993, LISTEN_143 etc. for template
    # substitution. Each LISTEN_<port> expands to a SCHEME://IP:PORT line — or
    # space-separated multi-listener line when bind is a list (Phase 4 dual-bind
    # on wg0 + wg-public, e.g. `tls://10.0.0.3:993 tls://10.1.0.3:993`).
    # Backward compat: bind as string still works (single entry).
    schemeFor = ep:
      if (ep.protocol or "") == "tls" then "tls://" else "tcp://";
    bindIpsFor = ep:
      let raw = ep.bind or "0.0.0.0"; in
      if builtins.isList raw then raw else [ raw ];
    listenLineFor = ep:
      let
        scheme = schemeFor ep;
        port   = toString ep.port;
        ips    = bindIpsFor ep;
      in lib.concatStringsSep " " (map (ip: "${scheme}${ip}:${port}") ips);
    bindVars = builtins.listToAttrs (
      map (ep: { name = "LISTEN_${toString ep.port}"; value = listenLineFor ep; })
          (buildJson.containers.app.extra_ports or [])
    );

    maddyConfVars = bindVars // {
      DOMAIN         = base_domain;
      MAIL_DOMAIN    = buildJson.domain;
      OCI_RELAY_HOST = buildJson.oci_relay.host;
      OCI_RELAY_PORT = buildJson.oci_relay.port;
      STALWART_RELAY_HOST = buildJson.stalwart_relay.host;
      STALWART_RELAY_PORT = toString buildJson.stalwart_relay.port;
    };

    # User creation block — generated from build.json#users (this service's SoT).
    # Each user gets creds create + creds password (UPSERT) + imap-acct create.
    # Every line goes through init.sh's `prov` helper rather than ending in
    # `|| true`: maddy's create verbs error on an object that already exists,
    # which is the normal path on every boot after the first, so `|| true` made
    # a real failure (locked credentials.db, uninjected password) look exactly
    # like a healthy no-op. `prov` separates the two into _exists vs _failed
    # tallies that the SUMMARY line — and configs/assert-provisioning.sh —
    # report on. The tally base names below are the contract with that script:
    # accounts / users / imap / mailboxes.
    # Use -p flag (not pipe) — maddy creds password tries TurnOnRawIO on stdin
    # even when piped, which fails without a TTY (inappropriate ioctl for device).
    # Shell-level $ENV refs are built via string concat to avoid Nix interpolation
    # confusion with multi-line `''...''` strings.
    mkUserLines = key: u:
      let
        addr      = "${u.name}@${base_domain}";
        passShell = "\"$" + u.pass_env + "\"";
      in lib.concatStringsSep "\n" [
        "prov accounts 'creds:create ${u.name}'   maddy creds create   -p ${passShell} ${addr}"
        "prov users    'creds:password ${u.name}' maddy creds password -p ${passShell} ${addr}"
        "prov imap     'imap-acct ${u.name}'      maddy imap-acct create ${addr}"
      ];

    userBlock = lib.concatStringsSep "\n" (lib.mapAttrsToList mkUserLines (buildJson.users or {}));

    mkFolderLines = key: u:
      let addr = "${u.name}@${base_domain}";
      in lib.concatMapStringsSep "\n"
        (f: "prov mailboxes 'mboxes:${u.name}' maddy imap-mboxes create ${addr} '${f}'")
        senderFolders;

    folderBlock = lib.concatStringsSep "\n" (lib.mapAttrsToList mkFolderLines (buildJson.users or {}));

    initShVars = {
      BASE_DOMAIN          = base_domain;
      USER_CREATION_BLOCK  = userBlock;
      FOLDER_CREATION_BLOCK = folderBlock;
    };

    # Host-side assertion (build.json#compose.post_hook). Separate from init.sh
    # on purpose: init.sh is the container entrypoint and cannot exit non-zero
    # without taking the mail server down with it.
    assertShVars = {
      CONTAINER_NAME = buildJson.containers.app.container_name;
    };

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir = ./.;
        templates = [
          { name = "init.sh";       vars = initShVars; }
          { name = "assert-provisioning.sh"; vars = assertShVars; }
          { name = "maddy.conf.tpl"; vars = maddyConfVars; }
        ];
        # Two scripts only:
        #   mail-sieve-subset-delivery-time.sh — per-message at delivery (jq)
        #   mail-sieve-subset-post-hoc.sh      — batch maintenance (sqlite + jq)
        # Both consume /data/mail-rules.json (derived Maddy subset of canonical
        # rules via _shared/lib/derive-mail-rules.ts (toMaddyJson); same SoT also
        # renders Stalwart's default.sieve).
        # The retired pre-SQL scripts live in src/z-archive/ for the transition
        # period — NOT bundled here, NOT mounted into the container, NOT
        # referenced by build.json#lifecycle. Will be deleted in a follow-up
        # commit after Phase 4 prod migration + 30-day soak (see z-archive/README.md).
        extraAssets = [
          ./mail-sieve-subset-delivery-time.sh
          ./mail-sieve-subset-delivery-shadow.sh
          ./mail-sieve-subset-post-hoc.sh
          # A file on disk, compiled by derive-mail-rules.ts and committed like
          # the rest of dist/. Consumed by the subset scripts at
          # /data/mail-rules.json; filename stable so mounts need no change.
          { name = "mail-rules.json"; src = ../dist/assets/mail-rules.json; }
        ];
        composeSpec = import ./compose.nix { inherit buildJson container base_domain; };
        title = "Maddy Mail Server";
      };
    });
  };
}
