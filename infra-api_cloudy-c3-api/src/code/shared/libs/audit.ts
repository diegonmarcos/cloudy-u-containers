/**
 * Structured audit logging for mutating operations.
 * Logs go to both stderr (real-time) and SQLite (persistent).
 */

import { recordAudit } from "./db.js";

export function audit(tool: string, target: string, result: string, source = "mcp"): void {
  const ts = new Date().toISOString();
  // Real-time stderr logging
  process.stderr.write(`[cloud-infra] [AUDIT] ${ts} ${tool} ${target} → ${result}\n`);
  // Persistent storage
  try {
    recordAudit(tool, target, result, source);
  } catch {
    // Fail gracefully if DB is unavailable
  }
}
