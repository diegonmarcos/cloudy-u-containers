# ══════════════════════════════════════════════════════════════════
# oom-priority.nix — the fleet OOM kill order, declared per service.
#
# THE DEFECT (#1641). Every container on oci-apps rendered with the same
# kernel OOM priority (oom_score_adj 0), so under memory pressure the c3
# control-plane MCP (restart policy "no" by owner policy, so a kill means it
# stays dead) was as killable as a scratch scanner. 71 services declare ~326G of
# cgroup ceilings against 24G of RAM; something is always going to be killed, and
# the only question the fleet can still answer is WHICH.
#
# THE RULE. build.json runtime.oom_score_adj is the ONE declaration. Negative =
# protected (killed last), positive = sacrificial (killed first), absent = the
# kernel default (0). A service's own compose.nix wins over it (a per-container
# value in a multi-container service stays possible). The ordering and its
# rationale live in _shared/oom-priority.json; _shared/test-oom-priority.mjs
# keeps the two in step.
#
# PURE ON PURPOSE (builtins only), same as memory-ceiling.nix, so the tester can
# evaluate it with a bare nix-instantiate.
# ══════════════════════════════════════════════════════════════════
{
  # buildJson.runtime.oom_score_adj, or null when the service declares none.
  adj ? null
, # Service name, for the error message only.
  title ? "service"
, # The compose `services` attrset.
  services
}:

let
  valid = builtins.isInt adj && adj >= (-1000) && adj <= 1000;

  apply = _name: svc:
    if svc ? oom_score_adj then svc
    else svc // { oom_score_adj = adj; };
in
  if adj == null then services
  else if !valid then throw (
    "${title}: runtime.oom_score_adj must be an integer in [-1000, 1000], got "
    + builtins.toJSON adj
  )
  else builtins.mapAttrs apply services
