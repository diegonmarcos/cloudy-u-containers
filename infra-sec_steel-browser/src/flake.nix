{
  description = "Steel Browser — owner-authorized security-testing headless browser (dist layout v2, Type B wrap-upstream)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-steel-browser.json);

    engine = import ../../_shared/engine.nix;

    # Bearer-auth Caddy sidecar. {env.STEEL_API_KEY} is substituted by Caddy at
    # load; the sidecar entrypoint fails closed when the key is empty, so an
    # unset secret means Steel is never reachable. Caddy uses '#' comments, so
    # the engine banner header is harmless here.
    steelAuthCaddyfile = ''
      {
      	admin off
      	auto_https off
      }
      :3000 {
      	handle /healthz {
      		respond "ok" 200
      	}
      	@authed header Authorization "Bearer {env.STEEL_API_KEY}"
      	handle @authed {
      		reverse_proxy steel-browser:3000
      	}
      	handle {
      		respond "unauthorized — steel-browser is owner-only; present a valid bearer" 401
      	}
      }
    '';

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir = ./.;
        templates = [
          { name = "steel-auth.Caddyfile"; text = steelAuthCaddyfile; }
        ];
        composeSpec = import ./compose.nix { inherit buildJson container; };
        title = "Steel Browser — security-testing headless browser";
      };
    });
  };
}
