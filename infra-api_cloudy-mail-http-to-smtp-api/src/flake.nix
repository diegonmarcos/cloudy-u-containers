{
  description = "HTTP-to-SMTP Proxy API — dist layout v2 (Type A, own code)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-http-to-smtp-proxy-api.json);

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
        # Operator scripts shipped to /opt/containers/<svc>/assets/<name>.
        # Invoked by lifecycle.* actions in build.json (ssh_run on VM host).
        extraAssets = [
          ./scripts/purge-orphan-smtp-proxy.sh
        ];
        composeSpec = import ./compose.nix { inherit buildJson container; };
        nativeBuild = {
          cmd       = nb.cmd;
          binary    = nb.binary;
          baseImage = nb.base_image;
          apt       = nb.apt or "";
        };
        title = "HTTP-to-SMTP Proxy API (v2)";
      };
    });
  };
}
