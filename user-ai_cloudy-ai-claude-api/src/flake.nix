{
  description = "my-ai_claude-api — OpenAI/Ollama/Anthropic mimic over the subscription Claude CLI + vendored Headroom compression (successor to kg-bridge)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    # build-cloud-agi-claude.json, not build-my-ai_claude-api.json: the #542
    # rename changed containers.app.container_name to cloud-agi-claude, and
    # cloud-infra's config emitter derives this generated file's NAME from that
    # value. So the rename silently moved the target — 1_cloud-configs/dist/
    # now holds build-cloud-agi-{claude,goose,hermes}.json and no longer holds
    # the old spellings. The symlink beside this file kept naming the old one,
    # which nix reports as "Path ... does not exist in Git repository" and which
    # failed Ship run 35995862469. A container rename is therefore NOT a
    # one-field change: it moves this filename too.
    container = builtins.fromJSON (builtins.readFile ./build-cloud-agi-claude.json);

    engine = import ../../_shared/engine.nix;
    nb = buildJson.docker.native_build;

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir = ./.;
        templates = [];
        composeSpec = import ./compose.nix { inherit buildJson container; };
        nativeBuild = {
          # Service-vendored multi-stage Dockerfile (Rust+Python Headroom build →
          # Node front + claude CLI). Same wiring as infra-obs_matomo: point the
          # engine at our Dockerfile so it is copied verbatim to
          # dist/code/<arch>/Dockerfile and the ship engine builds it. Without
          # this the engine generates a single-binary recipe and the multi-stage
          # build is lost (binaries image never pushed).
          dockerfile = ./code/Dockerfile;
          # Sibling build-context the Dockerfile COPYs from. cp -rL'd next to the
          # Dockerfile by the engine. Headroom (Apache-2.0) is fetched at a
          # pinned upstream commit inside the Dockerfile, not vendored here.
          extraFiles = [
            ./code/py
            ./code/server.mjs
            ./code/claude-resume.mjs
            ./code/login.mjs
            ./code/sessions-store.mjs
            ./code/package.json
            ./code/start.sh
            # #764: the ONE Jev gate shared by claude, goose and hermes. Staged
            # by basename, so the Dockerfile COPYs it as jev-gate/.
            ../../_shared/jev-gate
            ./code/claude-config
          ];
          cmd       = nb.cmd or "";
          binary    = nb.entrypoint or "";
          baseImage = nb.base_image;
          apt       = nb.apt or "";
        };
        title = "my-ai_claude-api";
      };
    });
  };
}
