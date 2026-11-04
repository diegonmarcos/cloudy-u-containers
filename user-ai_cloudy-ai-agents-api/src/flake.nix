{
  description = "my-ai-api — polyglot OpenRouter proxy with Headroom compression and plugin pipeline";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    # build-cloud-agi-goose.json, and a SYMLINK into cloud-infra's dist rather
    # than the 52,827-byte regular file that used to sit here. #542 renamed
    # containers.app.container_name to cloud-agi-goose, which moves this
    # generated file's NAME (the emitter writes `build-${containerName}.json`),
    # so the old name is gone from dist. claude-api failed loudly on that same
    # rename (run 35995862469); this service did NOT — because the copy here was
    # frozen, not linked, so it kept building from a pre-rename config with no
    # error at all. Measured staleness in that frozen copy: secret_env_vars was
    # missing GH_TOKEN, runtime.call_timeout_ms was 180000 not 860000,
    # runtime.claude_model and runtime.sessions.{name,resume} were absent
    # entirely, and .services still named four retired services
    # (c3-infra-mcp, c3-services-mcp, claude-superset-api, cloud-cgc-mcp) while
    # missing ten live ones.
    #
    # Switching to the link changes NOTHING the build actually consumes, which
    # is why it is safe to do here and was worth verifying rather than assuming:
    # compose.nix reads `buildJson.runtime` / `buildJson.containers.app` from
    # ../build.json, never this file, and _shared/engine.nix touches this file
    # only as `container.container.image` — a fallback for
    # buildJson.upstream_image, which is declared ("python:3.13-slim"), and the
    # two .container.image values are byte-identical anyway. The only field
    # whose VALUE moves is .container.container_name (my-ai-api →
    # cloud-agi-goose), read by nothing in this flake. What the link buys is
    # that the staleness above can never silently return.
    container  = builtins.fromJSON (builtins.readFile ./build-cloud-agi-goose.json);

    engine = import ../../_shared/engine.nix;
    nb     = buildJson.docker.native_build;

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir      = ./.;
        templates   = [];
        composeSpec = import ./compose.nix { inherit buildJson container; };
        nativeBuild = {
          dockerfile = ./code/Dockerfile;
          extraFiles = [
            ./code/vendor
            ./code/py
            ./code/server.mjs
            ./code/gateway.mjs
            ./code/bots.json
            ./code/sessions-store.mjs
            ./code/bots
            ./code/mcp.mjs
            # http-post.mjs was added to src and hand-copied into dist/, but
            # never added HERE — and this list, not the committed dist/, is what
            # becomes the docker build context ("Building nix flake -> dist/").
            # The committed copy was therefore overwritten by a flake output
            # that omitted it, and `COPY ... http-post.mjs` failed with
            # "/http-post.mjs: not found" the moment that layer was not cached.
            # test-my-ai-flake-copies-complete.mjs now fails if any file the
            # Dockerfile COPYs is missing from this list.
            ./code/http-post.mjs
            ./code/package.json
            ./code/start.sh
            # #764: the ONE Jev gate shared by claude, goose and hermes. Staged
            # by basename, so the Dockerfile COPYs it as jev-gate/.
            ../../_shared/jev-gate
            ./code/principles
            ./code/configs
          ];
          cmd       = nb.cmd or "";
          binary    = nb.entrypoint or "";
          baseImage = nb.base_image;
          apt       = nb.apt or "";
        };
        title = "my-ai-api";
      };
    });
  };
}
