{
  description = "Fleet token engine (dist layout v2, Type A own code)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-tokens-api.json);

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
          cmd       = nb.cmd;
          # Not a compiled binary — ENTRYPOINT is baked by ship engine
          # (native_build type=image-wrapper). Engine's Type A Dockerfile
          # stub uses baseNameOf(binary) only as a label.
          binary    = nb.entrypoint;
          baseImage = nb.base_image;
          apt       = nb.apt or "";
        };
        title = "Tokens API (v2)";
      };
    });
  };
}
