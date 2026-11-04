// resolve.ts — turn a cloud-data service name into a base URL.
//
// Every other MCP in the fleet hardcodes its backends (`http://10.0.0.6:3015`),
// which is how gitea ended up addressed as :3017 in one tool while cloud-data
// declares :3002. There is exactly one declaration of where a service lives —
// services.<name>.upstream — so read that and nothing else.
//
// Order: env override (deployment escape hatch) → upstream → ip/vm + port.
// No hardcoded fallback: an unresolvable backend must say so, because a
// default that silently points at the wrong port is worse than an error.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

type Json = Record<string, any>;

const GIT_BASE = process.env.GIT_BASE ?? join(homedir(), "git");
const CANDIDATES = [
  "/app/build-cloudy-apps-drive-mcp.json",
  "/app/build-cloud-drive-mcp.json",
  "/app/_cloud-data-consolidated.json",
  join(GIT_BASE, "cloud", "1_cloud-configs", "dist", "_cloud-data-consolidated.json"),
];

let cache: Json | null = null;

function cloudData(): Json {
  if (cache) return cache;
  for (const p of CANDIDATES) {
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, "utf-8"));
      if (d && typeof d === "object") return (cache = d);
    } catch { /* try the next candidate */ }
  }
  return (cache = {});
}

export interface Resolved {
  base: string;      // http://host:port
  basePath: string;  // api base path, e.g. /api/v1
  auth: string;      // declared auth mode, e.g. "bearer"
}

/** Resolve a declared service, or explain precisely why it could not be. */
export function resolveService(
  name: string,
  opts: { urlEnv?: string; basePath?: string } = {},
): Resolved | { error: string } {
  const envUrl = opts.urlEnv ? process.env[opts.urlEnv] : undefined;
  const svc: Json | undefined = cloudData().services?.[name];

  let base = envUrl ?? "";
  if (!base && svc) {
    if (typeof svc.upstream === "string" && svc.upstream) {
      base = `http://${svc.upstream}`;
    } else {
      const ip = svc.ip ?? (svc.vm ? cloudData().vms?.[svc.vm]?.wg_ip : undefined);
      const port = svc.ports?.app ?? svc.port;
      if (ip && port) base = `http://${ip}:${port}`;
    }
  }

  if (!base) {
    return {
      error: svc
        ? `service '${name}' is declared but carries no upstream/ip+port` +
          (opts.urlEnv ? `; set ${opts.urlEnv} to override` : "")
        : `service '${name}' is not declared in cloud-data services{}` +
          (opts.urlEnv ? `; set ${opts.urlEnv} to reach it anyway` : ""),
    };
  }

  return {
    base: base.replace(/\/+$/, ""),
    basePath: opts.basePath ?? svc?.api?.base_path ?? "",
    auth: svc?.api?.auth ?? "none",
  };
}

/** The routing table, read from this service's own build.json. */
export function driveConfig(): Json {
  for (const p of [
    "/app/build-cloudy-apps-drive-mcp.json",
    "/app/build-cloud-drive-mcp.json",
    join(GIT_BASE, "cloud", "1_cloud-configs", "dist", "build-cloud-drive-mcp.json"),
    join(GIT_BASE, "cloud", "a_solutions", "infra-api_cloud-drive-mcp", "build.json"),
  ]) {
    if (!existsSync(p)) continue;
    try {
      const d = JSON.parse(readFileSync(p, "utf-8"));
      if (d?.drive?.methods) return d.drive;
    } catch { /* try the next candidate */ }
  }
  return { backends: {}, methods: {} };
}
