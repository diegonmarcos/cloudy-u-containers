/**
 * SQLite persistence layer for C3.
 *
 * Stores: health check history, audit log, deploy log.
 * DB file: /app/data/c3.db (Docker volume) or ~/.local/share/c3/c3.db (local).
 *
 * Uses better-sqlite3 for synchronous, zero-config SQLite.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── DB Path ──────────────────────────────────────────────────────────────

const DB_DIR = process.env.C3_DATA_DIR
  ?? (existsSync("/app/data") ? "/app/data" : join(homedir(), ".local/share/c3"));

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ── Singleton ────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  ensureDir(DB_DIR);
  const dbPath = join(DB_DIR, "c3.db");

  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("busy_timeout = 5000");

  initSchema(_db);
  return _db;
}

// ── Schema ───────────────────────────────────────────────────────────────

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS health_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      vm TEXT NOT NULL,
      tier INTEGER NOT NULL,
      reachable INTEGER NOT NULL,
      ssh_ok INTEGER,
      latency_ms INTEGER,
      disk_percent TEXT,
      mem_used TEXT,
      containers_up INTEGER,
      containers_total INTEGER,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_health_ts ON health_checks(ts);
    CREATE INDEX IF NOT EXISTS idx_health_vm ON health_checks(vm);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      tool TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL,
      source TEXT DEFAULT 'mcp'
    );

    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_log(tool);

    CREATE TABLE IF NOT EXISTS deploy_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      service TEXT NOT NULL,
      step TEXT NOT NULL,
      success INTEGER NOT NULL,
      duration_ms INTEGER,
      output TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_deploy_ts ON deploy_log(ts);
    CREATE INDEX IF NOT EXISTS idx_deploy_svc ON deploy_log(service);

    CREATE TABLE IF NOT EXISTS alert_state (
      vm TEXT PRIMARY KEY,
      last_status TEXT NOT NULL DEFAULT 'ok',
      last_change TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      notified INTEGER NOT NULL DEFAULT 0
    );

    -- ── Metrics: raw per-target time-series samples (cpu/mem/net/disk) ──
    -- Written every poller tick. Kept for METRIC_RAW_RETENTION_HOURS, then
    -- rolled up into metric_rollup and deleted (see rollupMetrics()).
    CREATE TABLE IF NOT EXISTS metric_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      target TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_metric_samples_lookup ON metric_samples(target, metric, ts);
    CREATE INDEX IF NOT EXISTS idx_metric_samples_ts ON metric_samples(ts);

    -- Downsampled rollup: one row per (target, metric, bucket). bucket = 5-minute
    -- floor of ts, ISO string, so this table grows O(targets * metrics * time / 5m)
    -- instead of O(samples), bounding DB size long-term.
    CREATE TABLE IF NOT EXISTS metric_rollup (
      target TEXT NOT NULL,
      metric TEXT NOT NULL,
      bucket TEXT NOT NULL,
      avg REAL NOT NULL,
      min REAL NOT NULL,
      max REAL NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (target, metric, bucket)
    );

    CREATE INDEX IF NOT EXISTS idx_metric_rollup_lookup ON metric_rollup(target, metric, bucket);

    -- ── Alerting: rules + fired/resolved history ──
    CREATE TABLE IF NOT EXISTS alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target TEXT NOT NULL,
      metric TEXT NOT NULL,
      op TEXT NOT NULL,
      threshold REAL NOT NULL,
      for_seconds INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      target TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      status TEXT NOT NULL, -- 'fired' | 'resolved'
      acked INTEGER NOT NULL DEFAULT 0,
      resolved_ts TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_alert_history_rule ON alert_history(rule_id, ts);
    CREATE INDEX IF NOT EXISTS idx_alert_history_status ON alert_history(status);

    -- ── Log lines: docker logs pulled over SSH on-demand, indexed for search ──
    -- Plain LIKE search (no FTS5 dependency) — simplest thing that works.
    CREATE TABLE IF NOT EXISTS log_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      vm TEXT NOT NULL,
      container TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      line TEXT NOT NULL,
      dedupe_key TEXT UNIQUE
    );

    CREATE INDEX IF NOT EXISTS idx_log_lines_ts ON log_lines(ts);
    CREATE INDEX IF NOT EXISTS idx_log_lines_container ON log_lines(vm, container, ts);
  `);
}

// ── Health Checks ────────────────────────────────────────────────────────

export interface HealthRecord {
  vm: string;
  tier: number;
  reachable: boolean;
  sshOk?: boolean;
  latencyMs?: number;
  diskPercent?: string;
  memUsed?: string;
  containersUp?: number;
  containersTotal?: number;
  error?: string;
}

export function recordHealthCheck(record: HealthRecord): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO health_checks (vm, tier, reachable, ssh_ok, latency_ms, disk_percent, mem_used, containers_up, containers_total, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.vm,
    record.tier,
    record.reachable ? 1 : 0,
    record.sshOk != null ? (record.sshOk ? 1 : 0) : null,
    record.latencyMs ?? null,
    record.diskPercent ?? null,
    record.memUsed ?? null,
    record.containersUp ?? null,
    record.containersTotal ?? null,
    record.error ?? null,
  );
}

export interface HealthHistoryQuery {
  vm?: string;
  since?: string;
  limit?: number;
}

export interface HealthHistoryRow {
  id: number;
  ts: string;
  vm: string;
  tier: number;
  reachable: boolean;
  ssh_ok: boolean | null;
  latency_ms: number | null;
  disk_percent: string | null;
  mem_used: string | null;
  containers_up: number | null;
  containers_total: number | null;
  error: string | null;
}

export function getHealthHistory(query: HealthHistoryQuery = {}): HealthHistoryRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.vm) {
    conditions.push("vm = ?");
    params.push(query.vm);
  }
  if (query.since) {
    conditions.push("ts >= ?");
    params.push(query.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 100;

  const rows = db.prepare(
    `SELECT * FROM health_checks ${where} ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as number,
    ts: r.ts as string,
    vm: r.vm as string,
    tier: r.tier as number,
    reachable: r.reachable === 1,
    ssh_ok: r.ssh_ok != null ? r.ssh_ok === 1 : null,
    latency_ms: r.latency_ms as number | null,
    disk_percent: r.disk_percent as string | null,
    mem_used: r.mem_used as string | null,
    containers_up: r.containers_up as number | null,
    containers_total: r.containers_total as number | null,
    error: r.error as string | null,
  }));
}

export function getUptimeReport(vm?: string, hours = 24): {
  vm: string;
  checks: number;
  up: number;
  down: number;
  uptimePercent: number;
}[] {
  const db = getDb();
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const sql = vm
    ? `SELECT vm, COUNT(*) as total, SUM(reachable) as up FROM health_checks WHERE ts >= ? AND vm = ? GROUP BY vm`
    : `SELECT vm, COUNT(*) as total, SUM(reachable) as up FROM health_checks WHERE ts >= ? GROUP BY vm`;

  const params: unknown[] = vm ? [since, vm] : [since];
  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const total = r.total as number;
    const up = r.up as number;
    return {
      vm: r.vm as string,
      checks: total,
      up,
      down: total - up,
      uptimePercent: total > 0 ? Math.round((up / total) * 10000) / 100 : 0,
    };
  });
}

// ── Audit Log ────────────────────────────────────────────────────────────

export function recordAudit(tool: string, target: string, result: string, source = "mcp"): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO audit_log (tool, target, result, source) VALUES (?, ?, ?, ?)`
  ).run(tool, target, result, source);
}

export interface AuditQuery {
  tool?: string;
  since?: string;
  limit?: number;
}

export interface AuditRow {
  id: number;
  ts: string;
  tool: string;
  target: string;
  result: string;
  source: string;
}

export function getAuditLog(query: AuditQuery = {}): AuditRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.tool) {
    conditions.push("tool = ?");
    params.push(query.tool);
  }
  if (query.since) {
    conditions.push("ts >= ?");
    params.push(query.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 100;

  return db.prepare(
    `SELECT * FROM audit_log ${where} ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit) as AuditRow[];
}

// ── Deploy Log ───────────────────────────────────────────────────────────

export function recordDeploy(
  service: string,
  step: string,
  success: boolean,
  durationMs?: number,
  output?: string,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO deploy_log (service, step, success, duration_ms, output) VALUES (?, ?, ?, ?, ?)`
  ).run(service, step, success ? 1 : 0, durationMs ?? null, output?.slice(-2000) ?? null);
}

export interface DeployQuery {
  service?: string;
  since?: string;
  limit?: number;
}

export interface DeployRow {
  id: number;
  ts: string;
  service: string;
  step: string;
  success: boolean;
  duration_ms: number | null;
  output: string | null;
}

export function getDeployHistory(query: DeployQuery = {}): DeployRow[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.service) {
    conditions.push("service = ?");
    params.push(query.service);
  }
  if (query.since) {
    conditions.push("ts >= ?");
    params.push(query.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 50;

  const rows = db.prepare(
    `SELECT * FROM deploy_log ${where} ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r.id as number,
    ts: r.ts as string,
    service: r.service as string,
    step: r.step as string,
    success: r.success === 1,
    duration_ms: r.duration_ms as number | null,
    output: r.output as string | null,
  }));
}

// ── Alert State ──────────────────────────────────────────────────────────

export function getAlertState(vm: string): { lastStatus: string; lastChange: string; notified: boolean } | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM alert_state WHERE vm = ?`).get(vm) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    lastStatus: row.last_status as string,
    lastChange: row.last_change as string,
    notified: row.notified === 1,
  };
}

export function updateAlertState(vm: string, status: string, notified: boolean): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO alert_state (vm, last_status, last_change, notified)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    ON CONFLICT(vm) DO UPDATE SET
      last_status = excluded.last_status,
      last_change = CASE WHEN last_status != excluded.last_status THEN excluded.last_change ELSE last_change END,
      notified = excluded.notified
  `).run(vm, status, notified ? 1 : 0);
}

// ── Cleanup ──────────────────────────────────────────────────────────────

export function pruneOldRecords(daysToKeep = 30): { healthDeleted: number; auditDeleted: number; deployDeleted: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysToKeep * 86400_000).toISOString();

  const h = db.prepare("DELETE FROM health_checks WHERE ts < ?").run(cutoff);
  const a = db.prepare("DELETE FROM audit_log WHERE ts < ?").run(cutoff);
  const d = db.prepare("DELETE FROM deploy_log WHERE ts < ?").run(cutoff);

  // Also prune metrics (raw + rollup) and resolved alert history using the
  // same idiom/route (/db/prune) so retention stays centrally controlled.
  const m = pruneMetrics(daysToKeep);
  const al = db.prepare("DELETE FROM alert_history WHERE status = 'resolved' AND ts < ?").run(cutoff);
  const l = db.prepare("DELETE FROM log_lines WHERE ts < ?").run(cutoff);

  return {
    healthDeleted: h.changes,
    auditDeleted: a.changes,
    deployDeleted: d.changes,
    ...m,
    alertHistoryDeleted: al.changes,
    logLinesDeleted: l.changes,
  } as { healthDeleted: number; auditDeleted: number; deployDeleted: number };
}

// ── Metrics: raw samples + rollup/downsample ────────────────────────────

export type MetricName = "cpu" | "mem" | "net" | "disk";

/** Bucket floor to 5-minute ISO string (UTC), used as the rollup key. */
function bucket5m(ts: Date): string {
  const ms = ts.getTime();
  const bucketMs = Math.floor(ms / (5 * 60_000)) * (5 * 60_000);
  return new Date(bucketMs).toISOString();
}

export function recordMetricSample(target: string, metric: MetricName, value: number): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO metric_samples (target, metric, value) VALUES (?, ?, ?)`
  ).run(target, metric, value);
}

export interface MetricPoint {
  ts: string;
  value: number;
}

/**
 * Query a metric series for a target across [from, to], reading raw samples
 * where available and falling back to rollup buckets for older data.
 * `step` (seconds) coarsens raw rows client-side isn't needed — for raw range
 * we just return points as-is; for rollup range we return one point/bucket.
 */
export function queryMetricSeries(
  target: string,
  metric: MetricName,
  from?: string,
  to?: string,
): MetricPoint[] {
  const db = getDb();
  const fromTs = from ?? new Date(Date.now() - 3600_000).toISOString();
  const toTs = to ?? new Date().toISOString();

  const raw = db.prepare(
    `SELECT ts, value FROM metric_samples WHERE target = ? AND metric = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC`
  ).all(target, metric, fromTs, toTs) as Array<{ ts: string; value: number }>;

  const rolled = db.prepare(
    `SELECT bucket as ts, avg as value FROM metric_rollup WHERE target = ? AND metric = ? AND bucket >= ? AND bucket <= ? ORDER BY bucket ASC`
  ).all(target, metric, fromTs, toTs) as Array<{ ts: string; value: number }>;

  // Merge: rollup covers older/coarser history, raw covers recent detail.
  // De-dupe by ts (raw wins if both exist for the same instant).
  const seen = new Set(raw.map((r) => r.ts));
  const merged = [...rolled.filter((r) => !seen.has(r.ts)), ...raw];
  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return merged;
}

/** Latest raw sample for target/metric, or null. Used by the alert evaluator. */
export function getLatestMetric(target: string, metric: MetricName): MetricPoint | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT ts, value FROM metric_samples WHERE target = ? AND metric = ? ORDER BY ts DESC LIMIT 1`
  ).get(target, metric) as { ts: string; value: number } | undefined;
  return row ?? null;
}

export interface TopMetricRow {
  target: string;
  value: number;
  ts: string;
}

/** Top N targets by latest value of a metric (across all targets seen recently). */
export function getTopByMetric(metric: MetricName, limit = 10): TopMetricRow[] {
  const db = getDb();
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const rows = db.prepare(`
    SELECT target, value, ts FROM metric_samples m
    WHERE metric = ? AND ts >= ?
      AND ts = (SELECT MAX(ts) FROM metric_samples WHERE target = m.target AND metric = m.metric AND ts >= ?)
    ORDER BY value DESC
    LIMIT ?
  `).all(metric, since, since, limit) as TopMetricRow[];
  return rows;
}

/**
 * Rollup/downsample: fold raw samples older than `rawRetentionHours` into
 * metric_rollup (5-minute buckets: avg/min/max/count), then delete the raw
 * rows that were folded. Idempotent — re-running just upserts the same
 * buckets with (possibly) more samples if called before older rows expire.
 * Called from the poller tick (throttled) — see poller.ts.
 */
export function rollupMetrics(rawRetentionHours = 6): { foldedBuckets: number; deletedRaw: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - rawRetentionHours * 3600_000).toISOString();

  const stale = db.prepare(
    `SELECT target, metric, ts, value FROM metric_samples WHERE ts < ?`
  ).all(cutoff) as Array<{ target: string; metric: string; ts: string; value: number }>;

  if (stale.length === 0) return { foldedBuckets: 0, deletedRaw: 0 };

  const buckets = new Map<string, { target: string; metric: string; bucket: string; values: number[] }>();
  for (const row of stale) {
    const bucket = bucket5m(new Date(row.ts));
    const key = `${row.target} ${row.metric} ${bucket}`;
    let entry = buckets.get(key);
    if (!entry) {
      entry = { target: row.target, metric: row.metric, bucket, values: [] };
      buckets.set(key, entry);
    }
    entry.values.push(row.value);
  }

  const upsert = db.prepare(`
    INSERT INTO metric_rollup (target, metric, bucket, avg, min, max, count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(target, metric, bucket) DO UPDATE SET
      avg = (metric_rollup.avg * metric_rollup.count + excluded.avg * excluded.count) / (metric_rollup.count + excluded.count),
      min = MIN(metric_rollup.min, excluded.min),
      max = MAX(metric_rollup.max, excluded.max),
      count = metric_rollup.count + excluded.count
  `);

  const txn = db.transaction(() => {
    for (const entry of buckets.values()) {
      const avg = entry.values.reduce((s, v) => s + v, 0) / entry.values.length;
      const min = Math.min(...entry.values);
      const max = Math.max(...entry.values);
      upsert.run(entry.target, entry.metric, entry.bucket, avg, min, max, entry.values.length);
    }
    db.prepare(`DELETE FROM metric_samples WHERE ts < ?`).run(cutoff);
  });
  txn();

  return { foldedBuckets: buckets.size, deletedRaw: stale.length };
}

export function pruneMetrics(daysToKeep = 30): { metricRollupDeleted: number } {
  const db = getDb();
  const cutoff = new Date(Date.now() - daysToKeep * 86400_000).toISOString();
  const r = db.prepare("DELETE FROM metric_rollup WHERE bucket < ?").run(cutoff);
  return { metricRollupDeleted: r.changes };
}

// ── Alert rules + history ───────────────────────────────────────────────

export type AlertOp = "gt" | "gte" | "lt" | "lte" | "eq";

export interface AlertRule {
  id: number;
  name: string;
  target: string;
  metric: MetricName;
  op: AlertOp;
  threshold: number;
  forSeconds: number;
  enabled: boolean;
  createdTs: string;
}

function rowToRule(r: Record<string, unknown>): AlertRule {
  return {
    id: r.id as number,
    name: r.name as string,
    target: r.target as string,
    metric: r.metric as MetricName,
    op: r.op as AlertOp,
    threshold: r.threshold as number,
    forSeconds: r.for_seconds as number,
    enabled: r.enabled === 1,
    createdTs: r.created_ts as string,
  };
}

export function listAlertRules(): AlertRule[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM alert_rules ORDER BY id ASC`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToRule);
}

export function getAlertRule(id: number): AlertRule | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM alert_rules WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToRule(row) : null;
}

export function createAlertRule(rule: Omit<AlertRule, "id" | "createdTs">): AlertRule {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO alert_rules (name, target, metric, op, threshold, for_seconds, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(rule.name, rule.target, rule.metric, rule.op, rule.threshold, rule.forSeconds, rule.enabled ? 1 : 0);
  return getAlertRule(result.lastInsertRowid as number)!;
}

export function updateAlertRule(id: number, patch: Partial<Omit<AlertRule, "id" | "createdTs">>): AlertRule | null {
  const existing = getAlertRule(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  const db = getDb();
  db.prepare(`
    UPDATE alert_rules SET name = ?, target = ?, metric = ?, op = ?, threshold = ?, for_seconds = ?, enabled = ?
    WHERE id = ?
  `).run(merged.name, merged.target, merged.metric, merged.op, merged.threshold, merged.forSeconds, merged.enabled ? 1 : 0, id);
  return getAlertRule(id);
}

export function deleteAlertRule(id: number): boolean {
  const db = getDb();
  const r = db.prepare(`DELETE FROM alert_rules WHERE id = ?`).run(id);
  return r.changes > 0;
}

export interface AlertHistoryRow {
  id: number;
  ruleId: number;
  ts: string;
  target: string;
  metric: string;
  value: number;
  status: "fired" | "resolved";
  acked: boolean;
  resolvedTs: string | null;
}

function rowToHistory(r: Record<string, unknown>): AlertHistoryRow {
  return {
    id: r.id as number,
    ruleId: r.rule_id as number,
    ts: r.ts as string,
    target: r.target as string,
    metric: r.metric as string,
    value: r.value as number,
    status: r.status as "fired" | "resolved",
    acked: r.acked === 1,
    resolvedTs: (r.resolved_ts as string | null) ?? null,
  };
}

/** The currently-open (unresolved) fired instance for a rule, if any. */
export function getOpenAlertForRule(ruleId: number): AlertHistoryRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM alert_history WHERE rule_id = ? AND status = 'fired' ORDER BY ts DESC LIMIT 1
  `).get(ruleId) as Record<string, unknown> | undefined;
  return row ? rowToHistory(row) : null;
}

export function recordAlertFired(ruleId: number, target: string, metric: string, value: number): AlertHistoryRow {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO alert_history (rule_id, target, metric, value, status) VALUES (?, ?, ?, ?, 'fired')
  `).run(ruleId, target, metric, value);
  return rowToHistory(db.prepare(`SELECT * FROM alert_history WHERE id = ?`).get(result.lastInsertRowid as number) as Record<string, unknown>);
}

export function recordAlertResolved(id: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE alert_history SET status = 'resolved', resolved_ts = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
  `).run(id);
}

export function ackAlert(id: number): AlertHistoryRow | null {
  const db = getDb();
  db.prepare(`UPDATE alert_history SET acked = 1 WHERE id = ?`).run(id);
  const row = db.prepare(`SELECT * FROM alert_history WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToHistory(row) : null;
}

export function getActiveAlerts(): AlertHistoryRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM alert_history WHERE status = 'fired' ORDER BY ts DESC`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToHistory);
}

export function getAlertHistory(limit = 100): AlertHistoryRow[] {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM alert_history ORDER BY ts DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToHistory);
}

// ── Log lines (indexed from `docker logs`, searched via LIKE) ──────────

export interface LogLine {
  ts: string;
  vm: string;
  container: string;
  level: string;
  line: string;
}

export function insertLogLines(lines: LogLine[]): void {
  if (lines.length === 0) return;
  const db = getDb();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO log_lines (ts, vm, container, level, line, dedupe_key)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const txn = db.transaction((rows: LogLine[]) => {
    for (const l of rows) {
      const dedupeKey = `${l.vm} ${l.container} ${l.ts} ${l.line.slice(0, 200)}`;
      insert.run(l.ts, l.vm, l.container, l.level, l.line, dedupeKey);
    }
  });
  txn(lines);
}

export interface LogSearchQuery {
  q?: string;
  service?: string;
  vm?: string;
  container?: string;
  level?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export function searchLogLines(query: LogSearchQuery): LogLine[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.q) {
    conditions.push("line LIKE ?");
    params.push(`%${query.q}%`);
  }
  if (query.vm) {
    conditions.push("vm = ?");
    params.push(query.vm);
  }
  if (query.container) {
    conditions.push("container = ?");
    params.push(query.container);
  }
  if (query.level) {
    conditions.push("level = ?");
    params.push(query.level);
  }
  if (query.from) {
    conditions.push("ts >= ?");
    params.push(query.from);
  }
  if (query.to) {
    conditions.push("ts <= ?");
    params.push(query.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = query.limit ?? 100;

  return db.prepare(
    `SELECT ts, vm, container, level, line FROM log_lines ${where} ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit) as LogLine[];
}
