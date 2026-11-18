{
  description = "Stalwart Mail Server v0.16.5 — SHADOW MODE (JMAP/Sieve testing, offset ports) — dist layout v2";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-stalwart.json);

    engine    = import ../../_shared/engine.nix;
    lib       = nixpkgs.lib;

    # Mail rules are COMPILED, not computed here. _shared/lib/derive-mail-rules.ts
    # turns mail-rules-general.json + the profile overlay into real files:
    #   templates/default.sieve.tpl   (this flake names it, engine renders it)
    #   dist/assets/mail-rules.json   (mounted verbatim, see extraAssets)
    # This flake's job is orchestration — which file goes where in the image —
    # so it neither builds a Sieve script nor serialises JSON any more.

    # base_domain derived from service domain: "jmap.example.com" → "example.com"
    base_domain =
      lib.concatStringsSep "." (lib.drop 1 (lib.splitString "." buildJson.domain));

    # Admin password hash (SHA-512 crypt) — generated from secrets, baked into config.
    # This is a HASH, not the plaintext password — safe to include in config.
    adminHash = "$6$StalwartShadow$TnGwCZsckFjb/S6BcJV5UL8Gxf25mlA4eO2WI1G7jDYCwdMTfeSQUAUcR2H6mujyRMTjAWMHf3SyRNW/3.r7a/";

    # Port comes from container spec (build.json#containers.app.port — the
    # HTTPS admin port Stalwart binds; same value surfaces via the
    # cloud-data derive pipeline into build-stalwart.json).
    appPort = toString buildJson.containers.app.port;

    # ── Template variable sets ──────────────────────────────────────
    configTomlVars = {
      DOMAIN     = buildJson.domain;
      ADMIN_HASH = adminHash;
    };

    # User creation block — generated from build.json#users (this service's SoT).
    # Each user becomes a Stalwart "individual" principal POSTed via the admin API.
    # Each role is mapped: admin→admin, all others→user. Aliases land in `emails`.
    mkUserLines = key: u:
      let
        addr   = "${u.name}@${base_domain}";
        emails = [ addr ] ++ (lib.optionals (u ? aliases) (map (a: "${a}@${base_domain}") u.aliases));
        emailsJson = "[" + lib.concatStringsSep "," (map (e: "\"${e}\"") emails) + "]";
        emailsJsonEsc = lib.replaceStrings ["\""] ["\\\""] emailsJson;
        role   = if key == "admin" then "admin" else "user";
        pwVar = (lib.toUpper key) + "_PW";
        # Shell-level var reference; rendered into the final script as $ADMIN_PW etc.
        pwRef = "$" + pwVar;
        passShell = "\"$" + u.pass_env + "\"";
      in lib.concatStringsSep "\n" [
        "${pwVar}=$(cat /opt/containers/stalwart/.secrets.d/${u.pass_env} 2>/dev/null || echo ${passShell})"
        "_post \"user ${addr}\" \"{\\\"type\\\":\\\"individual\\\",\\\"name\\\":\\\"${addr}\\\",\\\"secrets\\\":[\\\"${pwRef}\\\"],\\\"emails\\\":${emailsJsonEsc},\\\"roles\\\":[\\\"${role}\\\"]}\""
      ];

    userBlock = lib.concatStringsSep "\n\n" (lib.mapAttrsToList mkUserLines (buildJson.users or {}));

    # Bind IP for the admin API listener — activate.sh runs on the host (post-hook
    # via SSH), so it must hit the Docker-bound host IP, not localhost. Pull the
    # first bind from extra_ports[service==jmap_tls] in build.json.
    activateBindIp =
      let
        ports = buildJson.containers.app.extra_ports or [];
        jmap  = lib.findFirst (p: (p.service or "") == "jmap_tls") (builtins.head ports) ports;
        bind  = jmap.bind or "127.0.0.1";
      in if builtins.isList bind then builtins.head bind else bind;

    # ── Folder bootstrap — pulled from mail-rules-general.json ───────
    # folders_ui = parent containers, folders = leaf-name map (short → pretty).
    # Emit as `name|parent\n…` for the shell template. Parents first.
    mailRulesGeneral = builtins.fromJSON (builtins.readFile ./mail-rules-general.json);
    parentFolders    = mailRulesGeneral.folders_ui or [];
    leafFolders      = mailRulesGeneral.folders or {};

    # Each leaf's parent is the parent_ui whose first 2 chars match the leaf's
    # first 2 chars (e.g. "11    🛡️ Admin & Finance" → "10 _ ADMIN").
    findParent = leafName:
      let
        leafPrefix = builtins.substring 0 1 leafName;
        match = lib.findFirst (p: builtins.substring 0 1 p == leafPrefix) "" parentFolders;
      in match;

    leafLines = lib.mapAttrsToList (k: v: "${v}|${findParent v}") leafFolders;
    parentLines = map (p: "${p}|") parentFolders;
    foldersLines = lib.concatStringsSep "\n" (parentLines ++ leafLines);

    # User mailbox local-parts paired with their secret-env var name.
    # Format: "me=ME_PASSWORD no-reply=NOREPLY_PASSWORD" — the activate
    # script parses each pair to load the right password file.
    usersList = lib.concatStringsSep " " (
      map (u: "${u.name}=${u.pass_env}") (lib.attrValues (buildJson.users or {}))
    );

    # Same users, but carrying everything activate.sh Step A needs to CREATE
    # a missing Stalwart account: local-part, role, secret-env name, aliases.
    # Format: "me|Admin|ME_PASSWORD| no-reply|User|NOREPLY_PASSWORD|noreply"
    # — space-separated records of four pipe-separated fields (the alias field
    # is empty for most users, hence the trailing pipe; a fixed arity keeps the
    # parser a plain split). Role follows the same key=="admin" convention as
    # mkUserLines, but spelled the way v0.16.5 spells it: admin-ness is
    # roles.@type on the account object, "Admin" or "User".
    usersAccounts = lib.concatStringsSep " " (lib.mapAttrsToList
      (key: u: "${u.name}|${if key == "admin" then "Admin" else "User"}|${u.pass_env}|"
               + lib.concatStringsSep "," (u.aliases or []))
      (buildJson.users or {}));

    # Admin-role user — used by activate.sh for any admin-scope JMAP calls
    # (readiness probe, MtaRoute/MtaOutboundStrategy upserts). Sourced from
    # build.json#users.admin (the role mapping is owned by mkUserLines:
    # key=="admin" → role="admin"). The pre-v0.16 magic "admin:$ADMIN_PASSWORD"
    # only exists in recovery_mode; in normal operation we must auth as the
    # actual bootstrap-created admin principal.
    adminUser    = buildJson.users.admin or { name = "admin"; pass_env = "ADMIN_PASSWORD"; };
    adminEmail   = "${adminUser.name}@${base_domain}";
    adminPassEnv = adminUser.pass_env;

    # Trusted IP ranges for fail2ban/auth-ban bypass — declared in
    # build.json#allowed_ips, emitted space-separated for activate.sh Step F,
    # which upserts them as AllowedIp registry objects via JMAP (v0.16.5 has
    # no live config.toml; server.allowed-ip lives only in the RocksDB registry).
    allowedIpsList = buildJson.allowed_ips or [ "10.0.0.0/24" "172.18.0.0/16" ];
    allowedIps     = lib.concatStringsSep " " allowedIpsList;

    activateShVars = {
      BASE_DOMAIN          = base_domain;
      APP_PORT             = appPort;
      BIND_IP              = activateBindIp;
      USER_CREATION_BLOCK  = userBlock;  # unused by new template, kept for back-compat
      USERS_LIST           = usersList;
      USERS_ACCOUNTS       = usersAccounts;
      FOLDERS_LINES        = foldersLines;
      ADMIN_EMAIL          = adminEmail;
      ADMIN_PASS_ENV       = adminPassEnv;
      ALLOWED_IPS          = allowedIps;
    };

    # Outbound MTA routes — declared in build.json#mta_routes, emitted as
    # a sibling data file in configs/. activate.sh loops over it and upserts
    # MtaRoute + MtaOutboundStrategy via JMAP. Secrets are referenced by env
    # var name only; the script reads /opt/containers/stalwart/.secrets.d/<VAR>
    # at activation time.
    mtaRoutesJson = builtins.toJSON (buildJson.mta_routes or []);

    # #1802 delivery-status ledger — build.json#delivery_ledger emitted as a
    # data-only sibling (configs/delivery-ledger.json); activate.sh Step I
    # hands it to apply-delivery-ledger.py, which upserts the WebHook + MtaHook.
    deliveryLedgerJson = builtins.toJSON (buildJson.delivery_ledger or {});

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir = ./.;
        templates = [
          # v0.14/v0.15 legacy main config (TOML). Kept during migration so a
          # rollback can re-mount it; v0.16 uses config.json below instead.
          { name = "config.toml";  vars = configTomlVars; }
          # v0.16+ data-store config (JSON). Everything else (listeners,
          # auth, sieve) lives as JMAP objects inside RocksDB and is seeded
          # via stalwart-cli apply during recovery-mode bootstrap.
          { name = "config.json";  vars = {}; }
          { name = "activate.sh";  vars = activateShVars; }
          # Sieve compiled by _shared/lib/derive-mail-rules.ts into
          # templates/default.sieve.tpl — the engine renders it like any other
          # template (banner + @VAR@ subst, of which it has none).
          { name = "default.sieve"; vars = {}; }
          # Outbound relay routes — data-only JSON consumed by activate.sh.
          { name = "mta-routes.json"; text = mtaRoutesJson; }
          # Python helper (data-driven JMAP MtaRoute/MtaOutboundStrategy upsert).
          { name = "apply-mta-routes.py"; vars = {}; }
          # Python helper: upsert LE wildcard cert as JMAP Certificate object.
          { name = "apply-tls-cert.py"; vars = {}; }
          # #1802: delivery-status ledger data + its JMAP upsert helper.
          { name = "delivery-ledger.json"; text = deliveryLedgerJson; }
          { name = "apply-delivery-ledger.py"; vars = {}; }
        ];
        # mail-rules.json bind-mounted from dist/assets/. The sorter itself is
        # compiled into its own image (build.json::docker.native_build).
        # mail-rules.json is DERIVED from general + profile-diego canonicals.
        # The {name;src;} form is needed for derived assets so the dest
        # name is stable (otherwise baseNameOf would hash-prefix it).
        extraAssets = [
          # A file on disk, compiled by derive-mail-rules.ts and committed like
          # the rest of dist/. Was a pkgs.writeText of a JSON string built in
          # Nix; nothing here computes it any more.
          { name = "mail-rules.json"; src = ../dist/assets/mail-rules.json; }
        ];
        composeSpec = import ./compose.nix { inherit buildJson container base_domain lib; };
        title = "Stalwart Mail Server (Shadow)";
      };
    });
  };
}
