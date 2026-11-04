/**
 * File-based result cache for observability calls.
 *
 * Structure: $CACHE_DIR/obs/<endpoint>/<target>/<timestamp>.json
 * Retention: 7 days (configurable), cleaned on startup + daily timer.
 *
 * Every UP/HEALTH/PROFILING call writes a copy here for debugging.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync, rmdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const CACHE_BASE = process.env.C3_DATA_DIR
  ?? (existsSync("/app/data") ? "/app/data" : join(homedir(), ".local/share/c3"));
const CACHE_DIR = join(CACHE_BASE, "cache", "obs");
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 86_400_000;
const CLEANUP_INTERVAL_MS = 6 * 3_600_000; // every 6 hours

// Ensure cache root exists
try {
  mkdirSync(CACHE_DIR, { recursive: true });
} catch {}

/**
 * Write a result to the file cache.
 * Non-blocking (writes synchronously but fast — small JSON files).
 */
export function cacheWrite(
  endpoint: string,
  target: string,
  data: unknown,
): string {
  const dir = join(CACHE_DIR, sanitize(endpoint), sanitize(target));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ts}.json`;
  const filepath = join(dir, filename);

  try {
    writeFileSync(filepath, JSON.stringify(data, null, 2));
  } catch {}

  return filepath;
}

/**
 * Read cached results for an endpoint+target, newest first.
 */
export function cacheRead(
  endpoint: string,
  target: string,
  limit = 10,
): Array<{ ts: string; data: unknown }> {
  const dir = join(CACHE_DIR, sanitize(endpoint), sanitize(target));
  if (!existsSync(dir)) return [];

  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    return files.map((f) => {
      const raw = readFileSync(join(dir, f), "utf-8");
      return {
        ts: f.replace(".json", "").replace(/-/g, (m, i) => (i < 19 ? (i === 10 ? "T" : [4, 7].includes(i) ? "-" : [13, 16].includes(i) ? ":" : m) : m)),
        data: JSON.parse(raw),
      };
    });
  } catch {
    return [];
  }
}

/**
 * List all cached endpoints and targets.
 */
export function cacheList(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!existsSync(CACHE_DIR)) return result;

  try {
    for (const endpoint of readdirSync(CACHE_DIR)) {
      const endpointDir = join(CACHE_DIR, endpoint);
      if (!statSync(endpointDir).isDirectory()) continue;
      result[endpoint] = readdirSync(endpointDir).filter((t) => {
        try {
          return statSync(join(endpointDir, t)).isDirectory();
        } catch {
          return false;
        }
      });
    }
  } catch {}

  return result;
}

/**
 * Prune cache files older than RETENTION_DAYS.
 * Returns count of deleted files.
 */
export function cachePrune(): number {
  const cutoff = Date.now() - RETENTION_MS;
  let deleted = 0;

  function pruneDir(dir: string) {
    if (!existsSync(dir)) return;
    try {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        const st = statSync(path);
        if (st.isDirectory()) {
          pruneDir(path);
          // Remove empty dirs
          try {
            const remaining = readdirSync(path);
            if (remaining.length === 0) rmdirSync(path);
          } catch {}
        } else if (st.isFile() && st.mtimeMs < cutoff) {
          unlinkSync(path);
          deleted++;
        }
      }
    } catch {}
  }

  pruneDir(CACHE_DIR);
  return deleted;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
}

// ── Auto-cleanup timer ─────────────────────────────────────────────────

let _cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startCacheCleanup(): void {
  if (_cleanupTimer) return;

  // Initial prune
  cachePrune();

  // Schedule periodic cleanup
  _cleanupTimer = setInterval(() => {
    cachePrune();
  }, CLEANUP_INTERVAL_MS);

  // Don't block process exit
  _cleanupTimer.unref();
}
