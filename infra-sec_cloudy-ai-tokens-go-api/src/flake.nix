{
  description = "cloudy-ai-tokens-go-api — Go port of the fleet token engine, shadow stage (dist layout v2, Type A own code, #1877)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    # No derived build-<svc>.json: compose.nix does not read it and engine.nix falls back
    # (`container.container.image or null`). A dangling link to cloud-infra's not-yet-derived
    # file breaks the pure render (the store copy points outside the source).
    container = {};

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
          binary    = nb.binary;
          baseImage = nb.base_image;
          apt       = nb.apt or "";
        };
        title = "cloudy-ai-tokens-go-api (shadow, v2)";
      };
    });
  };
}
