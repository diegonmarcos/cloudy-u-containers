// ── Pure drift-matching helpers (ticket #476) ───────────────────────────
//
// Extracted verbatim from code/shared/libs/health.ts so that healthDrift()
// and its tester can share ONE implementation without dragging in the
// runtime (config.json, SSH, docker, filesystem). This module has ZERO
// imports by design: importing it must never load the VM/container runtime,
// which is what let the old test-drift-multi-container.ts justify an inline
// port that silently drifted from production.
//
// The behaviour here is the canonical one — it is what healthDrift() in
// health.ts used before the extraction. Do not "improve" it in one caller
// and forget the other; change it here and both move together.
//
// Motivations (kept from the original sites):
//   - "Up" prefix (case-insensitive) is liveness, not existence: `docker ps
//     -a` lists Exited/Created/Dead containers too, and a declared service
//     only counts as deployed while at least one of its containers is
//     actually running (ticket #395 — umami was reported deployed=true
//     status=ok while all three of its containers were Exited).
//   - Glob patterns like "photoprism_*" (from build.json container_name
//     entries) match any deployed container whose name fits, falling back to
//     an exact-name match for legacy single-container services.

export interface DriftContainer {
  name?: string;
  status?: string;
}

export function hasGlob(pat: string): boolean {
  return pat.includes("*") || pat.includes("?");
}

export function globToRegex(pat: string): RegExp {
  return new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

// True when ANY deployed name matches ANY declared pattern (exact or glob).
export function isDeployed(declared: string[], deployed: string[]): boolean {
  return deployed.some((name) =>
    declared.some((pat) => (hasGlob(pat) ? globToRegex(pat).test(name) : pat === name))
  );
}

// Liveness, not existence (ticket #395): only statuses starting with "Up"
// (case-insensitive) count as running.
export function isRunning(status: string | undefined): boolean {
  return (status ?? "").toLowerCase().startsWith("up");
}

// Reduce a docker ps -a listing to the names of the containers actually
// running. `?? ""` mirrors health.ts: a declared-but-unnamed container still
// enters the set (the empty string simply never matches a declared name).
export function runningNames(containers: DriftContainer[]): string[] {
  return containers.filter((c) => isRunning(c.status)).map((c) => c.name ?? "");
}