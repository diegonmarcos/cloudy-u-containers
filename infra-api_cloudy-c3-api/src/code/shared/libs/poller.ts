/**
 * Single background poller tick.
 *
 * NOTE ON DEVIATION: the spec asked us to hook new samplers/evaluators onto
 * an "existing poller tick" (grepped for setInterval/etc across api/ and
 * shared/). No such loop exists in this codebase today — the only existing
 * setInterval is cache.ts's cache-file cleanup, which collects nothing.
 * Historically, health/uptime data is pushed by *external* callers hitting
 * `/db/*` and `/notify/*` (e.g. a Dagu DAG or cron), not by an in-process
 * loop. Since there is nothing to attach to, this file creates the ONE new
 * tick the spec requires, and both the metrics sampler and the alert
 * evaluator hook onto THIS SAME tick (see runTick() below) rather than each
 * starting their own interval — satisfying the "don't start a second loop"
 * constraint for everything added after this point.
 *
 * Tick responsibilities, in order, all on one setInterval:
 *   1. sampleAllTargets()   — docker stats over SSH, one batched call per VM
 *   2. rollupMetrics()      — fold stale raw samples into 5-min buckets (throttled)
 *   3. evaluateAlertRules() — compare latest samples to rules, fire/resolve, notify
 *   4. broadcast fleet health snapshot to SSE subscribers (/stream/health)
 */

import { EventEmitter } from "events";
import { getConfig } from "./config.js";
import { sshExecAsync } from "./async-ssh.js";
import { jevAlertOutcome, jevAlertPriority } from "./jev.js";
import {
  recordMetricSample,
  rollupMetrics,
  getLatestMetric,
  listAlertRules,
  getOpenAlertForRule,
  recordAlertFired,
  recordAlertResolved,
  type MetricName,
} from "./db.js";
import { sendNotification } from "./notify.js";

export const TICK_INTERVAL_MS = Number(process.env.C3_POLLER_INTERVAL_MS ?? 60_000);
const ROLLUP_EVERY_N_TICKS = 10; // fold raw samples into rollup every ~10 ticks

let _timer: ReturnType<typeof setInterval> | null = null;
let _tickCount = 0;
let _running = false;

export const pollerEvents = new EventEmitter();
pollerEvents.setMaxListeners(0);

export interface FleetHealthSnapshot {
  timestamp: string;
  vms: Array<{ vm: string; reachable: boolean; containers: Array<{ name: string; state: string; cpu: number | null; mem: number | null }> }>;
}

let _lastSnapshot: FleetHealthSnapshot | null = null;
export function getLastFleetHealthSnapshot(): FleetHealthSnapshot | null {
  return _lastSnapshot;
}

/**
 * Collect `docker stats --no-stream` for every container on every VM, one
 * batched SSH call per VM (mirrors the batching pattern already used in
 * obs.ts's engineContainer/engineVmContext). Writes cpu/mem samples per
 * container target, and a synthetic per-VM disk sample.
 */
async function sampleAllTargets(): Promise<FleetHealthSnapshot> {
  const config = getConfig();
  const vmIds = Object.keys(config.vms).filter((id) => id !== "local" && id !== "all");

  const snapshot: FleetHealthSnapshot = { timestamp: new Date().toISOString(), vms: [] };

  await Promise.all(
    vmIds.map(async (vmId) => {
      const cmd = [
        `echo '===STATS===' && docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null || echo 'unavailable'`,
        `echo '===DISK===' && df -h / 2>/dev/null | tail -1`,
      ].join(" && ");

      const result = await sshExecAsync(vmId, cmd, 15_000);
      if (!result.ok && !result.stdout.includes("===STATS===")) {
        snapshot.vms.push({ vm: vmId, reachable: false, containers: [] });
        return;
      }

      const statsBlock = extractBlock(result.stdout, "===STATS===", "===DISK===");
      const diskBlock = extractBlock(result.stdout, "===DISK===", null);

      const containers: FleetHealthSnapshot["vms"][number]["containers"] = [];
      if (statsBlock && statsBlock !== "unavailable") {
        for (const line of statsBlock.split("\n")) {
          const [name, cpuStr, memStr, netStr] = line.split("|");
          if (!name) continue;
          const cpu = parsePercent(cpuStr);
          const mem = parsePercent(memStr);
          const net = parseNetBytes(netStr);
          const target = name.trim();
          if (cpu != null) recordMetricSample(target, "cpu", cpu);
          if (mem != null) recordMetricSample(target, "mem", mem);
          if (net != null) recordMetricSample(target, "net", net);
          containers.push({ name: target, state: "running", cpu, mem });
        }
      }

      if (diskBlock) {
        const parts = diskBlock.trim().split(/\s+/);
        const usePercent = parseInt(parts[4]?.replace("%", "") ?? "", 10);
        if (!Number.isNaN(usePercent)) recordMetricSample(vmId, "disk", usePercent);
      }

      snapshot.vms.push({ vm: vmId, reachable: true, containers });
    }),
  );

  return snapshot;
}

function extractBlock(output: string, startMarker: string, endMarker: string | null): string {
  const startIdx = output.indexOf(startMarker);
  if (startIdx < 0) return "";
  const afterMarker = startIdx + startMarker.length;
  const endIdx = endMarker ? output.indexOf(endMarker, afterMarker) : -1;
  return (endIdx >= 0 ? output.slice(afterMarker, endIdx) : output.slice(afterMarker)).trim();
}

function parsePercent(s?: string): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace("%", ""));
  return Number.isNaN(v) ? null : v;
}

/** "1.2MB / 3.4MB" -> total bytes (rx+tx), or null. Used as a rough "net" metric. */
function parseNetBytes(s?: string): number | null {
  if (!s) return null;
  const parts = s.split("/").map((p) => p.trim());
  if (parts.length !== 2) return null;
  const total = parts.reduce((sum, p) => sum + (parseSize(p) ?? 0), 0);
  return total;
}

function parseSize(s: string): number | null {
  const m = s.match(/^([\d.]+)\s*([kKmMgGtT]?i?B)$/);
  if (!m) return null;
  const value = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult: Record<string, number> = {
    b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
  };
  return value * (mult[unit] ?? 1);
}

function compareOp(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
    default: return false;
  }
}

/**
 * Compare latest sample for each enabled rule's (target, metric) against its
 * threshold. Fires a new alert_history row + ntfy notification on 0->1
 * transition; resolves it (+ recovery notification) on 1->0. Idempotent: a
 * rule that stays breached across ticks does not re-fire or re-notify.
 */
// call id + fire time of the Jev decision made for each open alert rule (for the outcome on resolve)
const jevCalls = new Map<number | string, { call: string; at: number }>();

export async function evaluateAlertRules(): Promise<void> {
  const rules = listAlertRules().filter((r) => r.enabled);
  for (const rule of rules) {
    const point = getLatestMetric(rule.target, rule.metric as MetricName);
    if (!point) continue;

    const breached = compareOp(point.value, rule.op, rule.threshold);
    const open = getOpenAlertForRule(rule.id);

    if (breached && !open) {
      const fired = recordAlertFired(rule.id, rule.target, rule.metric, point.value);
      const jev = await jevAlertPriority({ rule: rule.name, target: rule.target, metric: rule.metric, op: rule.op, threshold: rule.threshold, value: point.value });
      if (jev.call) jevCalls.set(rule.id, { call: jev.call, at: Date.now() });
      sendNotification({
        title: `ALERT: ${rule.name}`,
        message: `${rule.target} ${rule.metric} ${rule.op} ${rule.threshold} (current: ${point.value})`,
        // #882 S3: Jev may re-rank (default|high|urgent, never below default); no opinion = "high" as before
        priority: jev.priority ?? "high",
        tags: ["rotating_light", "alert"],
      });
      pollerEvents.emit("alert", fired);
    } else if (!breached && open) {
      recordAlertResolved(open.id);
      // #882 outcome: how long the alert stayed open is the observed answer to "how urgent was it"
      const asked = jevCalls.get(rule.id);
      if (asked) { jevCalls.delete(rule.id); void jevAlertOutcome(asked.call, Date.now() - asked.at); }
      sendNotification({
        title: `RESOLVED: ${rule.name}`,
        message: `${rule.target} ${rule.metric} back within bounds (current: ${point.value})`,
        priority: "default",
        tags: ["white_check_mark"],
      });
      pollerEvents.emit("alert-resolved", { ...open, status: "resolved" });
    }
  }
}

async function runTick(): Promise<void> {
  if (_running) return; // never overlap ticks
  _running = true;
  _tickCount++;
  try {
    _lastSnapshot = await sampleAllTargets();
    pollerEvents.emit("health", _lastSnapshot);

    if (_tickCount % ROLLUP_EVERY_N_TICKS === 0) {
      rollupMetrics();
    }

    await evaluateAlertRules();
  } catch (err) {
    process.stderr.write(`[c3-api] poller tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  } finally {
    _running = false;
  }
}

/** Start the single background poller tick. Safe to call multiple times. */
export function startPoller(): void {
  if (_timer) return;
  _timer = setInterval(runTick, TICK_INTERVAL_MS);
  _timer.unref?.();
  // Kick one off immediately so /metrics and /stream/health have data
  // without waiting a full interval after boot.
  void runTick();
}

export function stopPoller(): void {
  if (_timer) clearInterval(_timer);
  _timer = null;
}
