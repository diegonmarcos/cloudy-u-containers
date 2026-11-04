# compose.nix — embeddings-api: Infinity (embeddings + rerank) plus /pdf, one container.
#   - Own code (Type A), packaged by the ship engine (native_build.type=image-wrapper).
#   - Host network, bound to oci-apps' WireGuard address only (mesh direct-dial rule, #1104): the phone and the
#     other VMs dial http://embeddings-api.mesh.diegonmarcos.com:7997, never a public address. Host network is also
#     what gives the container outbound DNS and internet (the weights come from Hugging Face): on this VM a bridge
#     network cannot reach the fleet resolver or the internet (first deploy, 2026-10-25, name resolution failed).
#   - CPU torch; models are downloaded on first start into a named volume and kept across redeploys.
#   - restart unless-stopped so a host reboot brings it back; the memory cap keeps a model spike off
#     the neighbours (about 5 GB resident for both models).
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  port = toString buildJson.ports.app;
  bind = buildJson.runtime.wg_bind or "10.0.0.6";
  m    = buildJson.models;
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";
in
{
  services = {
    embeddings-api = {
      image          = binariesImage;
      container_name = app.container_name;
      restart        = "unless-stopped";
      network_mode   = "host";
      command        = [ "uvicorn" "main:app" "--host" bind "--port" port ];
      env_file       = [];
      environment = {
        EMBED_MODEL  = m.embed;
        RERANK_MODEL = m.rerank;
        BATCH_SIZE   = toString m.batch_size;
        # No analytics from a private fleet service.
        INFINITY_ANONYMOUS_USAGE_STATS = "0";
        HF_HUB_DISABLE_TELEMETRY       = "1";
        OMP_NUM_THREADS                = "4";
      };
      volumes = app.volumes;
      # /health is the gate's liveness (the process listens at once; the models load behind it), so the ship's
      # health wait goes green in seconds; /ready is 200 only once both models are loaded.
      healthcheck = {
        test = [ "CMD" "python3" "-c" "import urllib.request; urllib.request.urlopen('http://${bind}:${port}/health', timeout=4)" ];
        interval     = "10s";
        timeout      = "5s";
        # Loading the weights holds the event loop for tens of seconds; 20 misses = 200 s before "unhealthy".
        retries      = 20;
        start_period = "60s";
      };
      deploy.resources =
           (if buildJson.resources ? mem_limit       then { limits       = { memory = buildJson.resources.mem_limit; };       } else {})
        // (if buildJson.resources ? mem_reservation then { reservations = { memory = buildJson.resources.mem_reservation; }; } else {});
    };
  };
  volumes = {
    embeddings_api_hf = {};
  };
}
