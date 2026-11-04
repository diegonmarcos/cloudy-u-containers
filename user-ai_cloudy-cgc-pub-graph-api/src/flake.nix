{
  description = "SurrealDB Hybrid Knowledge Graph — dist layout v2 (Type B, wrap upstream)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";

  outputs = { self, nixpkgs }: let
    forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" ];

    # ── Data sources (declarative JSON) ────────────────────────────
    buildJson = builtins.fromJSON (builtins.readFile ../build.json);
    container = builtins.fromJSON (builtins.readFile ./build-kg-store-pub.json);

    # build-kg-graph_schema.json — emitted by 9_others/build.sh derive,
    # symlinked into ./build-kg-graph_schema.json. SoT for embedder config
    # + vector index list. When embedder.enabled=false, vector_indexes is []
    # → MTREE block becomes a single comment line (declarative gating).
    kgSchema  = builtins.fromJSON (builtins.readFile ./build-kg-graph_schema.json);
    embedder  = kgSchema.embedder;

    # Compose MTREE DDL from the schema's vector_indexes array. Each entry
    # is { name, table, field, type, dimension, dtype }.
    vectorIndexesDdl =
      if (builtins.length kgSchema.vector_indexes) == 0 then
        "-- (no MTREE indexes — embedder disabled in build.json#kg.embedder.enabled)"
      else
        builtins.concatStringsSep "\n" (map (i:
          "DEFINE INDEX ${i.name} ON ${i.table} FIELDS ${i.field} ${i.type} DIMENSION ${toString i.dimension} TYPE ${i.dtype};"
        ) kgSchema.vector_indexes);

    engine = import ../../_shared/engine.nix;

  in {
    packages = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = engine {
        inherit pkgs buildJson container;
        srcDir = ./.;
        templates = [
          # SurrealDB schema — placeholders substituted from kgSchema JSON,
          # so the embedder/vector-index half is fully data-driven.
          # SurrealDB v2 accepts '#' line-comments, so the engine banner
          # prefix renders as valid SurrealQL.
          {
            name = "schema.surql";
            vars = {
              EMBEDDER_MODEL      = embedder.model;
              EMBEDDER_DIM        = toString embedder.dim;
              EMBEDDER_ENABLED    = if embedder.enabled then "true" else "false";
              VECTOR_INDEXES_DDL  = vectorIndexesDdl;
            };
          }
        ];
        # post_hook (build.json compose.post_hook): reconciles the live root
        # user to SURREAL_PASS after a rotation — see the script header.
        extraAssets = [ ./code/kg-root-pass-reconcile.sh ];
        composeSpec = import ./compose.nix { inherit buildJson container; };
        title = "SurrealDB Hybrid Knowledge Graph";
      };
    });
  };
}
