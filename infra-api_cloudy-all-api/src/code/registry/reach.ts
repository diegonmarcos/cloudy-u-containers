/**
 * Generic liveness-probe targets for ALL containers (not just API/MCP services).
 *
 * Built from the same peer map the registry uses (see peer-map.ts), but reads
 * the full `.services` map — every container that declares ip + app-port +
 * healthcheck. The derive (cloud-data-config-derive.ts deriveServiceConnections)
 * stamps `healthcheck` onto each peer entry from its app container.
 *
 * Used by the /:service/reach route so the cloud-spec helper pages can probe any
 * container, regardless of whether it exposes an API.
 */
import { existsSync, readFileSync } from "node:fs";
import { peerMapCandidates, describeCandidates } from "./peer-map.js";

interface PeerEntry {
  ip?: string;
  ports?: Record<string, number>;
  healthcheck?: string;
}
interface BuildFile {
  services?: Record<string, PeerEntry>;
}

function pickAppPort(ports: Record<string, number> | undefined): number {
  if (!ports) return 0;
  if (typeof ports.app === "number") return ports.app;
  for (const v of Object.values(ports)) if (typeof v === "number") return v;
  return 0;
}

function loadReachMap(): Map<string, string> {
  // Named from this container's own build.json — see peer-map.ts.
  const candidates = peerMapCandidates();

  const map = new Map<string, string>();
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as BuildFile;
      for (const [name, s] of Object.entries(raw.services ?? {})) {
        const port = pickAppPort(s.ports);
        if (!s.ip || !port || !s.healthcheck) continue;
        map.set(name, `http://${s.ip}:${port}${s.healthcheck}`);
      }
      console.error(`[reach] loaded ${map.size} probe targets from ${p}`);
      return map;
    } catch (e) {
      console.error(`[reach] failed to parse ${p}:`, e);
    }
  }
  console.error(`[reach] peer map unreadable — empty reach map (${describeCandidates(candidates)})`);
  return map;
}

const REACH_MAP = loadReachMap();

/** Full health-probe URL (http://wgIp:appPort+healthcheck) for any container, or null. */
export function getReachUrl(name: string): string | null {
  return REACH_MAP.get(name) ?? null;
}

/** Names of all containers that have a probe target. */
export function reachServiceNames(): string[] {
  return [...REACH_MAP.keys()];
}
