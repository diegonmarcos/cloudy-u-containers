// Pure half of the per-app crash/log route (api/routes/appLogs.ts): which names are declared,
// how a name is resolved and how a stored events file is read back. No filesystem, no network,
// so shared/libs/__selfcheck__.ts exercises the real decisions.

export type AppKind = "apk" | "containers";

export interface DeclaredApk {
  /** build.json name / fleet label, e.g. "cloud-drive" (the route name). */
  label: string;
  /** Android applicationId, e.g. "com.diegonmarcos.clouddrive". */
  package: string;
}

/** The id Telemetry derives from a package (libs:core Telemetry.appId): tail after "com.diegonmarcos.", dots to '-'. */
export function telemetryAppId(pkg: string): string {
  const prefix = "com.diegonmarcos.";
  return (pkg.startsWith(prefix) ? pkg.slice(prefix.length) : pkg).replace(/\./g, "-");
}

/**
 * The declared route name for [raw] under [kind], or null when it is not declared. An APK is
 * reachable by its label ("cloud-drive") or by the id Telemetry derives from its package
 * ("clouddrive"), so the crash handler needs no per-app wiring; both land on the label.
 */
export function resolveName(kind: AppKind, raw: string, apks: DeclaredApk[], containers: string[]): string | null {
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(raw)) return null;
  if (kind === "containers") return containers.includes(raw) ? raw : null;
  const hit = apks.find((a) => a.label === raw || telemetryAppId(a.package) === raw);
  return hit ? hit.label : null;
}

/** The declared APK list from the constellation fleet manifest (aa_cloud-superapp/data/constellation-fleet.json). */
export function apksFromFleet(fleet: { apps?: Array<{ label?: string; package?: string; kind?: string }> }): DeclaredApk[] {
  const out: DeclaredApk[] = [];
  for (const a of fleet.apps ?? []) {
    if (a.label && a.package) out.push({ label: a.label, package: a.package });
  }
  return out.sort((x, y) => x.label.localeCompare(y.label));
}

export interface StoredEvent { ts: string; kind: string; [k: string]: unknown }

/** Newest-first events out of a jsonl body, optionally one [kind] and newer than [since] (ISO); bad lines are skipped. */
export function readEvents(jsonl: string, opts: { kind?: string; since?: string; limit?: number }): StoredEvent[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const out: StoredEvent[] = [];
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let e: StoredEvent;
    try { e = JSON.parse(lines[i]) as StoredEvent; } catch { continue; }
    if (!e || typeof e.ts !== "string") continue;
    if (opts.kind && e.kind !== opts.kind) continue;
    if (opts.since && e.ts <= opts.since) continue;
    out.push(e);
  }
  return out;
}

/** A client-supplied log file name is only ever one this route wrote: <name>-<kind>-<ms>.log. */
export function isLogFileName(f: string): boolean {
  return /^[A-Za-z0-9_.-]{1,80}-[a-z]+-\d{10,16}\.log$/.test(f) && !f.includes("..");
}
