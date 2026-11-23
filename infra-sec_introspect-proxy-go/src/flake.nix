{
  description = "introspect-proxy-go — Go port of the Caddy forward_auth Bearer check, shadow stage (dist layout v2, Type A own code, #1872)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    # The derived build-<svc>.json appears once cloud-infra's gen-configs has seen this new
    # service; nothing here reads it, so its absence on the first render is not an error.
    container = if builtins.pathExists ./build-introspect-proxy-go.json
      then builtins.fromJSON (builtins.readFile ./build-introspect-proxy-go.json)
      else {};

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
        title = "introspect-proxy-go (shadow, v2)";
      };
    });
  };
}
