# compose.nix — pure attrset describing docker-compose.yml for kg-store (SurrealDB).
# engine.nix serialises it via lib.generators.toYAML, merging compose-defaults.json.
{ buildJson, container }:

let
  app  = buildJson.containers.app;
  port = toString buildJson.ports.app;

  # Engine builds per-arch Dockerfiles into dist/code/<arch>/ and wraps them
  # into a GHCR image; at runtime we pull the published binaries image.
  binariesImage = "ghcr.io/diegonmarcos/${buildJson.name}-binaries:latest";

  # ── Memory budget, declared in build.json, never written here ────────
  # build.json containers.app.resources carries every number; no size literal
  # is written in this file. Two halves, and neither works alone:
  #
  #   cgroup ceiling  mem_limit            -> deploy.resources.limits.memory
  #   engine budget   rocksdb_block_cache  -> SURREAL_ROCKSDB_BLOCK_CACHE_SIZE
  #                   rocksdb_write_buffer -> SURREAL_ROCKSDB_WRITE_BUFFER_SIZE
  #
  # Without the ceiling, SurrealDB sizes its LRU block cache from the memory it
  # can see, which with no cgroup is the whole host:
  #   ROCKSDB_BLOCK_CACHE_SIZE default = max(visible/2 - 1GiB, 16MiB)
  #   (surrealdb v2.3.7, crates/core/src/kvs/rocksdb/cnf.rs:125-143)
  # On oci-apps that is 23.41GiB/2 - 1GiB ≈ 10.7GB — which is, to within
  # rounding, the 10.6GB a restart returned on 2026-09-21.
  #
  # Without the engine budget, the ceiling alone would just turn an unbounded
  # cache into a cgroup OOM kill: the cache is cgroup-aware, but it aims at
  # half the cap and floors at 16MiB, and the memtables (WRITE_BUFFER_SIZE ×
  # MAX_WRITE_BUFFER_NUMBER, default up to 128MiB × 32 = 4GiB) are sized off
  # host RAM tiers independently. So both are declared, explicitly.
  #
  # The cache is declared separately from the ceiling (2026-10-10) so the
  # ceiling can grow for ingest headroom without the cache growing with it: a
  # full graph refresh peaked at ~945MiB of the old 1G cap, so mem_limit went
  # to 2G while the cache stayed at 512M. Bounds enforced below, at render
  # time: cache <= 1/2 of the cap, and cache + memtables < the cap.
  toBytes = field: s:
    let parts = builtins.match "([0-9]+)([KkMmGg])[iI]?[bB]?" s; in
    if parts == null
    then throw ("${buildJson.name}: containers.app.resources.${field} = "
                + "\"${s}\" is not <integer><K|M|G>[i][B]; the RocksDB "
                + "budget is computed from it and cannot be guessed.")
    else (builtins.fromJSON (builtins.elemAt parts 0)) *
         (let u = builtins.elemAt parts 1; in
          if      u == "G" || u == "g" then 1073741824
          else if u == "M" || u == "m" then 1048576
          else                              1024);

  memLimit = app.resources.mem_limit;
  memBytes = toBytes "mem_limit" memLimit;

  blockCacheBytes      = toBytes "rocksdb_block_cache"  app.resources.rocksdb_block_cache;
  writeBufferBytes     = toBytes "rocksdb_write_buffer" app.resources.rocksdb_write_buffer;
  maxWriteBufferNumber = 2;

  engineBudget =
    if blockCacheBytes * 2 > memBytes
    then throw ("${buildJson.name}: rocksdb_block_cache (${toString blockCacheBytes} B) "
                + "exceeds half of mem_limit ${memLimit}; the cache would crowd "
                + "out the memtables, WAL and process inside the cgroup.")
    else if blockCacheBytes + writeBufferBytes * maxWriteBufferNumber >= memBytes
    then throw ("${buildJson.name}: RocksDB cache + memtables do not fit under "
                + "mem_limit ${memLimit}; that is an OOM kill waiting for load.")
    else {
      SURREAL_ROCKSDB_BLOCK_CACHE_SIZE        = toString blockCacheBytes;
      SURREAL_ROCKSDB_WRITE_BUFFER_SIZE       = toString writeBufferBytes;
      SURREAL_ROCKSDB_MAX_WRITE_BUFFER_NUMBER = toString maxWriteBufferNumber;
    };
in
{
  services = {
    surrealdb = {
      image          = binariesImage;
      container_name = app.container_name;
      network_mode   = "host";
      # Always-on data store — override the fleet-wide restart:no default
      # (compose-defaults.json) so a stop/reboot/crash brings it back instead
      # of leaving the knowledge graph dark until someone notices.
      restart        = "unless-stopped";
      # Run as root: the surrealdb image's default non-root user cannot create the
      # RocksDB dir in the root-owned `${data_path}:/data` host bind mount
      # ("PermissionDenied"). Single-tenant, 127.0.0.1-bound file store — same
      # root pattern as the reindex job. Without this the container crash-loops.
      user           = "0:0";
      env_file       = [ ".secrets" ];
      # Names verified against surrealdb v2.3.7 source (cnf.rs), not guessed.
      # BLOCK_CACHE_SIZE and WRITE_BUFFER_SIZE are BYTES.
      #
      # Root credentials come from the ENVIRONMENT, never argv: `surreal start`
      # reads SURREAL_USER / SURREAL_PASS itself (clap env fallbacks of --user
      # / --pass). The old `--pass ''${SURREAL_ROOT_PASSWORD}` was interpolated
      # by compose into Config.Cmd, so `docker inspect`, `ps` and every tool
      # that prints a command line showed the root password; on 2026-10-10 it
      # reached an agent session's output and both stores were rotated.
      # SURREAL_PASS itself arrives via env_file ".secrets" (sops fragment
      # src/secrets.root-rotation.yaml). surreal only CREATES the root user
      # from it on an empty datastore, so an existing store is brought to the
      # new value by the post_hook assets/kg-root-pass-reconcile.sh.
      environment = engineBudget // { SURREAL_USER = "root"; };
      deploy = {
        resources = {
          limits       = { memory = memLimit; };
          reservations = { memory = app.resources.mem_reservation; };
        };
      };
      command = "start --log info --bind 127.0.0.1:${port} file:/data/surreal.db";
      volumes = [ "${buildJson.data_path}:/data" ];
      healthcheck = {
        test         = [ "CMD" "/surreal" "is-ready" "--conn" "http://localhost:${port}" ];
        interval     = "15s";
        timeout      = "15s";
        retries      = 5;
        start_period = "30s";
      };
    };
  };
}
