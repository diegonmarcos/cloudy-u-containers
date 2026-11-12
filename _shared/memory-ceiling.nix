# ══════════════════════════════════════════════════════════════════
# memory-ceiling.nix — no container may render UNCAPPED.
#
# THE DEFECT. kg-store and kg-store-pub declared no memory limit, so
# `docker stats` showed them against the HOST total ("6.066GiB / 23.41GiB")
# — the tell that no cgroup limit exists at all. SurrealDB's RocksDB backend
# sizes its LRU block cache from the memory it can SEE:
#
#   ROCKSDB_BLOCK_CACHE_SIZE default = max(visible_memory / 2 - 1GiB, 16MiB)
#   (surrealdb v2.3.7, crates/core/src/kvs/rocksdb/cnf.rs:125-143)
#
# With no cgroup, "visible" is the whole box: 23.41GiB / 2 - 1GiB ≈ 10.7GB of
# cache the engine is entitled to hold and never returns. Measured on oci-apps
# 2026-09-21: restarting the two containers took available RAM from 1,303MB to
# 11,855MB — ~10.6GB, the predicted number. The leak was a CORRECTLY SIZED
# cache against the wrong denominator.
#
# WHY IT WAS SILENT. A service that declares nothing got no limit, and nothing
# anywhere said so. That is the property removed here: uncapped is no longer a
# reachable state. Every service either declares its own ceiling, or inherits
# the one declared for its category in _shared/compose-defaults.json, or the
# BUILD FAILS. There is no fourth outcome.
#
# WHY CATEGORY. build.json already classifies every service (the same field
# the directory prefix encodes), and build.schema.json already enumerates the
# values. Deriving the default from it adds no new concept to keep in sync — a
# parallel "tier"/"class" field would be a second classification that could
# disagree with the first.
#
# PURE ON PURPOSE — builtins only, no pkgs, no lib. engine.nix cannot be
# evaluated without a full nixpkgs; this file can, with a bare
# `nix-instantiate --eval`, which is what lets _shared/test-kg-store-memory-
# ceiling.mjs exercise the THROW instead of merely grepping for it. A guard
# nothing can execute is the "green that verified nothing" shape.
# ══════════════════════════════════════════════════════════════════
{
  # The `memory_limit` block of _shared/compose-defaults.json.
  policy
, # buildJson.category, or null when the service declares none.
  category ? null
, # Service name, for the error message only.
  title ? "service"
, # The compose `services` attrset, post default-merge.
  services
}:

let
  # Compose reads the ceiling from deploy.resources.limits.memory (v3 shape).
  # The v2 top-level `mem_limit` key is accepted as a declaration too: a
  # service that spells it that way IS capped, and failing its build over
  # spelling would be a guard enforcing a preference, not an outcome.
  declared = svc:
    let l = ((svc.deploy or {}).resources or {}).limits or {};
    in l.memory or (svc.mem_limit or null);

  byCategory = policy.by_category or {};
  catKey     = if category == null then "" else category;
  fallback   = byCategory.${catKey} or null;

  # Set deploy.resources.limits.memory without disturbing anything already
  # there (notably the fleet-wide pids:256 from compose-defaults.json).
  withMemory = svc: mem:
    let
      d = svc.deploy    or {};
      r = d.resources   or {};
      l = r.limits      or {};
    in svc // { deploy = d // { resources = r // { limits = l // { memory = mem; }; }; }; };

  apply = name: svc:
    if declared svc != null then svc
    else if fallback != null then withMemory svc fallback
    else throw (
      "${title}: container \"${name}\" would render with NO memory limit, and "
      + "category ${if category == null then "<none>" else "\"${category}\""} has no "
      + "default in _shared/compose-defaults.json:memory_limit.by_category. "
      + "An uncapped container sizes its caches from the HOST's RAM — that is how "
      + "kg-store ate ~10.6GB of oci-apps unnoticed. Fix it by declaring "
      + "containers.<role>.resources.mem_limit in build.json and reading it in "
      + "compose.nix (see user-ai_cloud-me-cgc-pvt-graph-api), or by adding a default for this "
      + "category. Going uncapped is deliberately not an option."
    );
in
  # `required: false` exists only so the policy block is self-describing; it is
  # never set. Read it here rather than hardcoding `true` so the file says what
  # it obeys.
  if (policy.required or true) == true
  then builtins.mapAttrs apply services
  else services
