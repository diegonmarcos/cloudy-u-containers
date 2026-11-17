# compose.nix — pure attrset describing docker-compose.yml for languagetool.
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
#
# LanguageTool runs in rules-only mode (no n-grams).
#
# N-GRAMS (DEFERRED — ~24 GB data):
#   To enable: add volume "ngrams:/ngrams:ro" + env languageModel="/ngrams".
#   Download: https://languagetool.org/download/ngram-data/  (one .zip per language)
#   Install on oci-apps: extract to /opt/languagetool/ngrams/<lang>/, declare named volume.
{ buildJson, container }:

let
  app = buildJson.containers.app;
in
{
  services = {
    languagetool = {
      image          = app.image;
      container_name = app.container_name;
      env_file       = [];
      # JVM heap + any langtool_* passthrough live in build.json
      # (containers.app.environment); the `_doc` key is stripped here.
      # N-GRAMS HOOK (disabled): add langtool_languageModel = "/ngrams" there.
      environment = builtins.removeAttrs app.environment [ "_doc" ];
      ports = [ "${toString app.port}:${toString app.port}" ];
      volumes = app.volumes;
      deploy = {
        # mem_limit/mem_reservation are optional in build.json (only
        # mem_reservation is declared fleet-wide today). Reading them
        # unconditionally fails eval with "attribute ... missing".
        resources =
             (if app.resources ? mem_limit       then { limits       = { memory = app.resources.mem_limit; };       } else {})
          // (if app.resources ? mem_reservation then { reservations = { memory = app.resources.mem_reservation; }; } else {});
      };
      logging = {
        driver = "json-file";
        options = {
          max-size = "1m";
          max-file = "3";
        };
      };
    } // (if buildJson.containers.app ? cloud_run_bridge then { profiles = [ "cloud-run" ]; } else {});
  };

  volumes = {
    languagetool_data = {};
    # N-GRAMS HOOK (disabled):
    # ngrams = {
    #   driver = "local";
    #   driver_opts = {
    #     type  = "none";
    #     o     = "bind";
    #     device = "/opt/languagetool/ngrams";
    #   };
    # };
  };
}
