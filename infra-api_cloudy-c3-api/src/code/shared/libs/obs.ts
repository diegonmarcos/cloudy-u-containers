/**
 * Observability v2 — UP / HEALTH / PROFILING engines.
 *
 * All async, all parallel (6-core pool), all cached to disk.
 *
 * UP:        Fast (~200ms). TCP + HTTP status + ping + docker state. No auth.
 * HEALTH:    Medium (~2-5s). Full handshake + auto-escalates to profiling on failure.
 * PROFILING: Deep (~10-30s). 4 engines: URL, Container, Network, VM.
 */

import { getConfig, resolveVmId, getVmSshAlias, serviceContainerNames } from "./config.js";
import { sshPool, httpPool, Pool, runAsBulk } from "./pool.js";
import {
  sshExecAsync,
  tcpProbeAsync,
  pingAsync,
  curlStatusAsync,
  curlAsync,
} from "./async-ssh.js";
import { cacheWrite } from "./cache.js";
import type { ExecResult } from "./async-exec.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface Resolved {
  container?: string;
  service?: string;
  vm?: string;
  wg_ip?: string;
  domain?: string;
  containers?: string[];
}

export interface UpProbe {
  ok: boolean;
  ms: number;
  [key: string]: unknown;
}

export interface PerfTiming {
  // Milliseconds per phase, plus the `*_triggered` booleans profile() records
  // for its conditional engines C/D (tsc TS2322 until the index admitted them).
  [phase: string]: number | boolean;
}

export interface UpResult {
  target: string;
  resolved: Resolved;
  url: UpProbe | null;
  vm: UpProbe | null;
  container: UpProbe | null;
  up: boolean;
  ms: number;
  perf: PerfTiming;
}

export interface UpAllResult {
  timestamp: string;
  total: number;
  up: number;
  down: number;
  services: UpResult[];
  ms: number;
  perf: PerfTiming;
}

export interface HealthCheck {
  ok: boolean;
  ms: number;
  [key: string]: unknown;
}

export interface HealthResult {
  target: string;
  resolved: Resolved;
  up: { url: boolean; vm: boolean; container: boolean };
  checks: {
    url: HealthCheck | null;
    vm: HealthCheck | null;
    container: HealthCheck | null;
  };
  healthy: boolean;
  profiling: ProfilingResult | null;
  ms: number;
  perf: PerfTiming;
}

export interface ProfilingStep {
  step: string;
  ok?: boolean;
  ms?: number;
  skipped?: boolean;
  [key: string]: unknown;
}

export interface ProfilingEngine {
  ran: boolean;
  reason?: string;
  steps: ProfilingStep[];
  verdict: string;
  ms: number;
}

export interface ProfilingResult {
  target: string;
  resolved: Resolved;
  engines: {
    a_url: ProfilingEngine | null;
    b_container: ProfilingEngine | null;
    c_network: ProfilingEngine | null;
    d_vm: ProfilingEngine | null;
  };
  diagnosis: string;
  ms: number;
  perf: PerfTiming;
}

// ── Smart resolution ─────────────────────────────────────────────────────

/**
 * Given ANY input (container name, service name, VM name),
 * resolve EVERYTHING from topology: container → service → VM → WG IP → domain.
 */
export function resolve(target: string): Resolved {
  const config = getConfig();
  const result: Resolved = {};

  // 1. Is it a VM?
  const vmAliasMap: Record<string, string> = {};
  for (const [vmId, vm] of Object.entries(config.vms)) {
    const alias = vm.ssh_alias ?? vmId;
    vmAliasMap[alias] = vmId;
    vmAliasMap[vmId] = vmId;
  }

  if (vmAliasMap[target]) {
    const vmId = vmAliasMap[target];
    const vm = config.vms[vmId];
    result.vm = vmId;
    result.wg_ip = vm?.wg_ip ?? vm?.ip;
    // Collect all containers on this VM
    const containers: string[] = [];
    for (const [_name, svc] of Object.entries(config.services)) {
      if (svc.vm === vmId) {
        containers.push(...serviceContainerNames(svc, _name));
      }
    }
    result.containers = containers;
    return result;
  }

  // 2. Is it a service?
  if (config.services[target]) {
    const svc = config.services[target];
    result.service = target;
    result.vm = svc.vm;
    result.domain = svc.domain;
    result.containers = serviceContainerNames(svc, target);
    if (svc.vm && config.vms[svc.vm]) {
      result.wg_ip = config.vms[svc.vm].wg_ip ?? config.vms[svc.vm].ip;
    }
    return result;
  }

  // 3. Container name — scan services for matching container
  for (const [svcName, svc] of Object.entries(config.services)) {
    if (serviceContainerNames(svc, svcName).includes(target)) {
      result.container = target;
      result.service = svcName;
      result.vm = svc.vm;
      result.domain = svc.domain;
      result.containers = [target];
      if (svc.vm && config.vms[svc.vm]) {
        result.wg_ip = config.vms[svc.vm].wg_ip ?? config.vms[svc.vm].ip;
      }
      return result;
    }
  }

  // 4. Fallback: treat as container name, unknown VM
  result.container = target;
  result.containers = [target];
  return result;
}

// ── UP Engine ────────────────────────────────────────────────────────────

/**
 * UP — Fast parallel probes. No auth, no handshakes.
 * Probes URL + VM + Container simultaneously.
 */
export async function up(target: string): Promise<UpResult> {
  const t0 = Date.now();
  const resolved = resolve(target);
  const t_resolve = Date.now();

  // Launch all probes in parallel
  const [urlProbe, vmProbe, containerProbe] = await Promise.all([
    probeUrl(resolved),
    probeVm(resolved),
    probeContainer(resolved),
  ]);
  const t_probes = Date.now();

  const result: UpResult = {
    target,
    resolved,
    url: urlProbe,
    vm: vmProbe,
    container: containerProbe,
    up:
      (urlProbe?.ok ?? true) &&
      (vmProbe?.ok ?? true) &&
      (containerProbe?.ok ?? true),
    ms: Date.now() - t0,
    perf: {
      resolve_ms: t_resolve - t0,
      probes_parallel_ms: t_probes - t_resolve,
      url_ms: urlProbe?.ms ?? 0,
      vm_ms: vmProbe?.ms ?? 0,
      container_ms: containerProbe?.ms ?? 0,
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("up", target, result);
  return result;
}

/**
 * UP all — probe every service with a domain, in parallel via pool.
 */
export async function upAll(): Promise<UpAllResult> {
  const t0 = Date.now();
  const config = getConfig();
  const t_config = Date.now();

  const targets = Object.entries(config.services)
    .filter(([, svc]) => svc.vm && svc.vm !== "local" && svc.vm !== "all")
    .map(([name]) => name);

  const pool = new Pool(6);
  const results = await runAsBulk(() => pool.map(targets, (t) => up(t)));
  const t_pool = Date.now();

  const upCount = results.filter((r) => r.up).length;

  const allResult: UpAllResult = {
    timestamp: new Date().toISOString(),
    total: results.length,
    up: upCount,
    down: results.length - upCount,
    services: results,
    ms: Date.now() - t0,
    perf: {
      config_ms: t_config - t0,
      pool_parallel_ms: t_pool - t_config,
      targets_count: targets.length,
      slowest_ms: Math.max(...results.map((r) => r.ms), 0),
      fastest_ms: Math.min(...results.map((r) => r.ms), Infinity),
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("up", "_all", allResult);
  return allResult;
}

/**
 * UP all containers — every container across all VMs.
 */
export async function upAllContainers(): Promise<UpAllResult> {
  const t0 = Date.now();
  const config = getConfig();

  const containers: string[] = [];
  for (const [_name, svc] of Object.entries(config.services)) {
    containers.push(...serviceContainerNames(svc, _name));
  }
  const t_resolve = Date.now();

  const pool = new Pool(6);
  const results = await runAsBulk(() => pool.map(containers, (c) => up(c)));
  const t_pool = Date.now();

  const upCount = results.filter((r) => r.up).length;
  const allResult: UpAllResult = {
    timestamp: new Date().toISOString(),
    total: results.length,
    up: upCount,
    down: results.length - upCount,
    services: results,
    ms: Date.now() - t0,
    perf: {
      resolve_ms: t_resolve - t0,
      pool_parallel_ms: t_pool - t_resolve,
      targets_count: containers.length,
      slowest_ms: Math.max(...results.map((r) => r.ms), 0),
      fastest_ms: Math.min(...results.map((r) => r.ms), Infinity),
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("up", "_all-containers", allResult);
  return allResult;
}

// ── UP probes (fast, parallel, never throw) ──────────────────────────────

async function probeUrl(resolved: Resolved): Promise<UpProbe | null> {
  if (!resolved.domain) return null;
  const t0 = Date.now();

  const url = resolved.domain.startsWith("http")
    ? resolved.domain
    : `https://${resolved.domain}`;

  try {
    return await httpPool.run(async () => {
      const result = await curlStatusAsync(url, 5_000);
      return {
        ok: result.ok,
        ms: result.ms,
        status: result.status,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `probeUrl exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function probeVm(resolved: Resolved): Promise<UpProbe | null> {
  if (!resolved.vm || !resolved.wg_ip) return null;
  const t0 = Date.now();

  try {
    return await sshPool.run(async () => {
      const [tcp, ping] = await Promise.all([
        tcpProbeAsync(resolved.wg_ip!, 5_000),
        pingAsync(resolved.wg_ip!, 3_000),
      ]);

      return {
        ok: tcp.ok || ping.ok,
        ms: Math.max(tcp.ms, ping.ms),
        tcp: tcp.ok,
        ping: ping.ok,
        ...(tcp.error ? { tcp_error: tcp.error } : {}),
        ...(ping.error ? { ping_error: ping.error } : {}),
      };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `probeVm exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function probeContainer(resolved: Resolved): Promise<UpProbe | null> {
  if (!resolved.vm || !resolved.containers?.length) return null;
  if (resolved.vm === "local" || resolved.vm === "all") return null;
  const t0 = Date.now();

  try {
    return await sshPool.run(async () => {
      const names = resolved.containers!;
      const cmd = names
        .map(
          (n) =>
            `docker inspect --format '${n}:{{.State.Status}}' ${n} 2>/dev/null || echo '${n}:not-found'`,
        )
        .join(" && ");

      const start = Date.now();
      const result = await sshExecAsync(resolved.vm!, cmd, 10_000);
      const ms = Date.now() - start;

      if (result.timedOut) {
        return {
          ok: false, ms,
          timedOut: true,
          error: `SSH timeout after ${ms}ms checking containers on ${resolved.vm}`,
          partial_stdout: result.stdout.slice(-200),
        };
      }

      if (!result.ok) {
        return { ok: false, ms, error: result.stderr.trim().slice(0, 300) };
      }

      const states: Record<string, string> = {};
      for (const line of result.stdout.trim().split("\n")) {
        const [name, status] = line.split(":");
        if (name && status) states[name.trim()] = status.trim();
      }

      const allRunning = Object.values(states).every((s) => s === "running");
      return { ok: allRunning, ms, states };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `probeContainer exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── HEALTH Engine ────────────────────────────────────────────────────────

/**
 * HEALTH — Full handshake + verification. Auto-triggers profiling on failure.
 */
export async function health(target: string): Promise<HealthResult> {
  const t0 = Date.now();
  const resolved = resolve(target);

  // Phase A: Run UP first (parallel probes)
  const upResult = await up(target);
  const t_up = Date.now();

  // Phase B: Full handshakes (parallel)
  const [urlCheck, vmCheck, containerCheck] = await Promise.all([
    healthCheckUrl(resolved),
    healthCheckVm(resolved),
    healthCheckContainer(resolved),
  ]);
  const t_checks = Date.now();

  const isHealthy =
    (urlCheck?.ok ?? true) &&
    (vmCheck?.ok ?? true) &&
    (containerCheck?.ok ?? true);

  // Phase C: Auto-trigger profiling if ANY check failed
  let profilingResult: ProfilingResult | null = null;
  if (!isHealthy) {
    profilingResult = await profile(target);
  }
  const t_profiling = Date.now();

  const result: HealthResult = {
    target,
    resolved,
    up: {
      url: upResult.url?.ok ?? true,
      vm: upResult.vm?.ok ?? true,
      container: upResult.container?.ok ?? true,
    },
    checks: {
      url: urlCheck,
      vm: vmCheck,
      container: containerCheck,
    },
    healthy: isHealthy,
    profiling: profilingResult,
    ms: Date.now() - t0,
    perf: {
      phase_a_up_ms: t_up - t0,
      phase_b_checks_parallel_ms: t_checks - t_up,
      url_check_ms: urlCheck?.ms ?? 0,
      vm_check_ms: vmCheck?.ms ?? 0,
      container_check_ms: containerCheck?.ms ?? 0,
      phase_c_profiling_ms: isHealthy ? 0 : t_profiling - t_checks,
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("health", target, result);
  return result;
}

/**
 * HEALTH all — all services, parallel via pool.
 */
export async function healthAll(): Promise<{
  timestamp: string;
  total: number;
  healthy: number;
  unhealthy: number;
  services: HealthResult[];
  ms: number;
  perf: PerfTiming;
}> {
  const t0 = Date.now();
  const config = getConfig();
  const t_config = Date.now();

  const targets = Object.entries(config.services)
    .filter(([, svc]) => svc.vm && svc.vm !== "local" && svc.vm !== "all")
    .map(([name]) => name);

  const pool = new Pool(6);
  const results = await runAsBulk(() => pool.map(targets, (t) => health(t)));
  const t_pool = Date.now();

  const healthyCount = results.filter((r) => r.healthy).length;
  const allResult = {
    timestamp: new Date().toISOString(),
    total: results.length,
    healthy: healthyCount,
    unhealthy: results.length - healthyCount,
    services: results,
    ms: Date.now() - t0,
    perf: {
      config_ms: t_config - t0,
      pool_parallel_ms: t_pool - t_config,
      targets_count: targets.length,
      slowest_ms: Math.max(...results.map((r) => r.ms), 0),
      fastest_ms: Math.min(...results.map((r) => r.ms), Infinity),
      avg_ms: results.length > 0 ? Math.round(results.reduce((s, r) => s + r.ms, 0) / results.length) : 0,
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("health", "_all", allResult);
  return allResult;
}

// ── HEALTH checks (full handshake, never throw) ─────────────────────────

async function healthCheckUrl(resolved: Resolved): Promise<HealthCheck | null> {
  if (!resolved.domain) return null;
  const t0 = Date.now();

  const url = resolved.domain.startsWith("http")
    ? resolved.domain
    : `https://${resolved.domain}`;

  try {
    return await httpPool.run(async () => {
      const start = Date.now();
      const result = await curlAsync(url, 10_000);
      const ms = Date.now() - start;

      return {
        ok: result.ok,
        ms,
        status: result.status,
        tls_valid: result.ok,
        content_length: result.body.length,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `healthCheckUrl exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function healthCheckVm(resolved: Resolved): Promise<HealthCheck | null> {
  if (!resolved.vm) return null;
  if (resolved.vm === "local" || resolved.vm === "all") return null;
  const t0 = Date.now();

  try {
    return await sshPool.run(async () => {
      const start = Date.now();
      const result = await sshExecAsync(resolved.vm!, "uname -n", 10_000);
      const ms = Date.now() - start;
      return {
        ok: result.ok,
        ms,
        ssh_auth: result.ok,
        hostname: result.ok ? result.stdout.trim() : undefined,
        ...(result.timedOut ? { timedOut: true, error: `SSH timeout after ${ms}ms to ${resolved.vm}` } : {}),
        ...(!result.ok && !result.timedOut ? { error: result.stderr.trim().slice(0, 300) } : {}),
      };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `healthCheckVm exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function healthCheckContainer(
  resolved: Resolved,
): Promise<HealthCheck | null> {
  if (!resolved.vm || !resolved.containers?.length) return null;
  if (resolved.vm === "local" || resolved.vm === "all") return null;
  const t0 = Date.now();

  try {
    return await sshPool.run(async () => {
      const names = resolved.containers!;
      const cmd = names
        .map(
          (n) =>
            `docker inspect --format '${n}|{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}' ${n} 2>/dev/null || echo '${n}|not-found|none|0|false'`,
        )
        .join(" && ");

      const start = Date.now();
      const result = await sshExecAsync(resolved.vm!, cmd, 10_000);
      const ms = Date.now() - start;

      if (result.timedOut) {
        return {
          ok: false, ms, timedOut: true,
          error: `SSH timeout after ${ms}ms checking containers on ${resolved.vm}`,
          partial_stdout: result.stdout.slice(-200),
        };
      }

      if (!result.ok) {
        return { ok: false, ms, error: result.stderr.trim().slice(0, 300) };
      }

      const containers: Array<{
        name: string;
        state: string;
        health: string;
        restarts: number;
        oom: boolean;
      }> = [];

      for (const line of result.stdout.trim().split("\n")) {
        const [name, state, healthStatus, restarts, oom] = line.split("|");
        containers.push({
          name: name?.trim() ?? "",
          state: state?.trim() ?? "unknown",
          health: healthStatus?.trim() ?? "none",
          restarts: parseInt(restarts?.trim() ?? "0", 10),
          oom: oom?.trim() === "true",
        });
      }

      const allHealthy = containers.every(
        (c) =>
          c.state === "running" &&
          (c.health === "healthy" || c.health === "none" || c.health === "") &&
          !c.oom,
      );

      return { ok: allHealthy, ms, containers };
    });
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `healthCheckContainer exception after ${Date.now() - t0}ms: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── PROFILING Engine ─────────────────────────────────────────────────────

/**
 * PROFILING — Deep diagnostics. 4 engines run based on context.
 */
export async function profile(target: string): Promise<ProfilingResult> {
  const t0 = Date.now();
  const resolved = resolve(target);

  // Engine A+B in parallel (independent) — wrapped in try/catch
  let engineA: ProfilingEngine | null = null;
  let engineB: ProfilingEngine | null = null;
  try {
    [engineA, engineB] = await Promise.all([
      engineUrl(resolved).catch((err): ProfilingEngine => ({
        ran: true, steps: [{ step: "engine_error", ok: false, error: `engineUrl crashed after ${Date.now() - t0}ms: ${err?.message ?? err}` }],
        verdict: "Engine A crashed", ms: Date.now() - t0,
      })),
      engineContainer(resolved).catch((err): ProfilingEngine => ({
        ran: true, steps: [{ step: "engine_error", ok: false, error: `engineContainer crashed after ${Date.now() - t0}ms: ${err?.message ?? err}` }],
        verdict: "Engine B crashed", ms: Date.now() - t0,
      })),
    ]);
  } catch (err) {
    // Should not happen with inner catches, but safety net
  }
  const t_ab = Date.now();

  // Engine C: only if URL probe failed but container is running
  let engineC: ProfilingEngine | null = null;
  const urlFailed = engineA && !engineA.steps.some((s) => s.step === "external_curl" && s.ok);
  const containerRunning = engineB?.steps.some(
    (s) => s.step === "inspect" && s.ok,
  );
  if (urlFailed && containerRunning) {
    try {
      engineC = await engineNetwork(resolved);
    } catch (err) {
      engineC = {
        ran: true, steps: [{ step: "engine_error", ok: false, error: `engineNetwork crashed after ${Date.now() - t_ab}ms: ${err instanceof Error ? err.message : String(err)}` }],
        verdict: "Engine C crashed", ms: Date.now() - t_ab,
      };
    }
  }
  const t_c = Date.now();

  // Engine D: only if container or VM issues detected
  let engineD: ProfilingEngine | null = null;
  const containerFailed = engineB && !engineB.steps.every((s) => s.ok !== false);
  if (containerFailed || (engineC && !engineC.steps.every((s) => s.ok !== false))) {
    try {
      engineD = await engineVmContext(resolved);
    } catch (err) {
      engineD = {
        ran: true, steps: [{ step: "engine_error", ok: false, error: `engineVmContext crashed after ${Date.now() - t_c}ms: ${err instanceof Error ? err.message : String(err)}` }],
        verdict: "Engine D crashed", ms: Date.now() - t_c,
      };
    }
  }
  const t_d = Date.now();

  const diagnosis = generateDiagnosis(engineA, engineB, engineC, engineD);

  const result: ProfilingResult = {
    target,
    resolved,
    engines: {
      a_url: engineA,
      b_container: engineB,
      c_network: engineC,
      d_vm: engineD,
    },
    diagnosis,
    ms: Date.now() - t0,
    perf: {
      engines_ab_parallel_ms: t_ab - t0,
      engine_a_ms: engineA?.ms ?? 0,
      engine_b_ms: engineB?.ms ?? 0,
      engine_c_ms: engineC ? t_c - t_ab : 0,
      engine_c_triggered: !!engineC,
      engine_d_ms: engineD ? t_d - t_c : 0,
      engine_d_triggered: !!engineD,
      total_ms: Date.now() - t0,
    },
  };

  cacheWrite("profiling", target, result);
  return result;
}

/**
 * PROFILING all services — parallel via pool.
 */
export async function profileAllServices(): Promise<{
  timestamp: string;
  total: number;
  results: ProfilingResult[];
  ms: number;
  perf: PerfTiming;
}> {
  const t0 = Date.now();
  const config = getConfig();

  const targets = Object.entries(config.services)
    .filter(([, svc]) => svc.vm && svc.vm !== "local" && svc.vm !== "all")
    .map(([name]) => name);

  const pool = new Pool(6);
  const results = await runAsBulk(() => pool.map(targets, (t) => profile(t)));
  const t_pool = Date.now();

  return {
    timestamp: new Date().toISOString(),
    total: results.length,
    results,
    ms: Date.now() - t0,
    perf: {
      pool_parallel_ms: t_pool - t0,
      targets_count: targets.length,
      slowest_ms: Math.max(...results.map((r) => r.ms), 0),
      fastest_ms: Math.min(...results.map((r) => r.ms), Infinity),
      total_ms: Date.now() - t0,
    },
  };
}

/**
 * PROFILING all containers — parallel via pool.
 */
export async function profileAllContainers(): Promise<{
  timestamp: string;
  total: number;
  results: ProfilingResult[];
  ms: number;
  perf: PerfTiming;
}> {
  const t0 = Date.now();
  const config = getConfig();

  const containers: string[] = [];
  for (const [_name, svc] of Object.entries(config.services)) {
    containers.push(...serviceContainerNames(svc, _name));
  }

  const pool = new Pool(6);
  const results = await runAsBulk(() => pool.map(containers, (c) => profile(c)));
  const t_pool = Date.now();

  return {
    timestamp: new Date().toISOString(),
    total: results.length,
    results,
    ms: Date.now() - t0,
    perf: {
      pool_parallel_ms: t_pool - t0,
      targets_count: containers.length,
      slowest_ms: Math.max(...results.map((r) => r.ms), 0),
      fastest_ms: Math.min(...results.map((r) => r.ms), Infinity),
      total_ms: Date.now() - t0,
    },
  };
}

// ── Engine A: URL → Container (outside-in) ───────────────────────────────

async function engineUrl(resolved: Resolved): Promise<ProfilingEngine | null> {
  if (!resolved.domain) return null;
  const t0 = Date.now();

  const steps: ProfilingStep[] = [];
  const url = resolved.domain.startsWith("http")
    ? resolved.domain
    : `https://${resolved.domain}`;

  // A1: External curl
  const curl = await curlAsync(url, 10_000);
  steps.push({
    step: "external_curl",
    ok: curl.ok,
    status: curl.status,
    ms: curl.ms,
    content_length: curl.body.length,
    ...(curl.error ? { error: curl.error } : {}),
  });

  if (curl.ok) {
    // A2: Smart content check based on content type
    const isHtml = curl.body.includes("<!DOCTYPE") || curl.body.includes("<html");
    const isJson =
      curl.body.trimStart().startsWith("{") ||
      curl.body.trimStart().startsWith("[");

    if (isHtml) {
      const titleMatch = curl.body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const scriptCount = (curl.body.match(/<script/gi) || []).length;
      const styleCount = (curl.body.match(/<link[^>]*stylesheet/gi) || []).length;
      const bodySize = curl.body.length;

      steps.push({
        step: "content_html",
        ok: bodySize > 100,
        title: titleMatch?.[1]?.trim() ?? "(no title)",
        scripts: scriptCount,
        stylesheets: styleCount,
        bodySize,
      });

      // A3: Check linked assets (first 3 CSS/JS)
      const assetUrls = extractAssetUrls(curl.body, url);
      if (assetUrls.length > 0) {
        const assetChecks = await Promise.all(
          assetUrls.slice(0, 3).map(async (assetUrl) => {
            const r = await curlStatusAsync(assetUrl, 5_000);
            return { url: assetUrl, ok: r.ok, status: r.status, ms: r.ms };
          }),
        );
        steps.push({
          step: "assets",
          ok: assetChecks.every((a) => a.ok),
          checked: assetChecks,
        });
      }
    } else if (isJson) {
      try {
        const parsed = JSON.parse(curl.body);
        steps.push({
          step: "content_json",
          ok: true,
          keys: Object.keys(parsed).slice(0, 10),
        });
      } catch {
        steps.push({ step: "content_json", ok: false, error: "invalid JSON" });
      }
    }
  } else if (resolved.vm && resolved.containers?.length) {
    // A4: External curl failed — try local curl inside container
    const container = resolved.containers[0];
    const a4Start = Date.now();
    const localResult = await sshExecAsync(
      resolved.vm,
      `docker exec ${container} curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:8080/health 2>/dev/null || echo '000'`,
      15_000,
    );
    const a4Ms = Date.now() - a4Start;

    if (localResult.timedOut) {
      steps.push({
        step: "local_curl", ok: false, ms: a4Ms, timedOut: true,
        error: `Local curl timeout after ${a4Ms}ms. Completed steps: ${steps.map(s => `${s.step}(${s.ms}ms)`).join(", ")}`,
      });
    } else {
      const localStatus = parseInt(localResult.stdout.trim(), 10) || 0;
      steps.push({
        step: "local_curl",
        ok: localStatus >= 200 && localStatus < 500,
        status: localStatus,
        ms: a4Ms,
        note: localStatus >= 200 && localStatus < 500
          ? "App responds locally — network path issue"
          : "App not responding locally — app crash",
      });
    }
  }

  const allOk = steps.every((s) => s.ok !== false);
  return {
    ran: true,
    steps,
    verdict: allOk
      ? "URL healthy"
      : steps.find((s) => s.step === "local_curl" && s.ok)
        ? "App OK, network path broken"
        : "URL unreachable",
    ms: Date.now() - t0,
  };
}

// ── Engine B: Container internals ────────────────────────────────────────

async function engineContainer(
  resolved: Resolved,
): Promise<ProfilingEngine | null> {
  if (!resolved.vm || !resolved.containers?.length) return null;
  if (resolved.vm === "local" || resolved.vm === "all") return null;
  const t0 = Date.now();

  const steps: ProfilingStep[] = [];
  const container = resolved.containers[0];
  const vmId = resolved.vm;

  // B1+B2+B3+B4 in a single batched SSH call for max efficiency
  const batchCmd = [
    // B1: inspect
    `echo '===INSPECT===' && docker inspect --format '{{.State.Status}}|{{.State.Health.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.Created}}' ${container} 2>/dev/null || echo 'not-found'`,
    // B2: stats
    `echo '===STATS===' && docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}' ${container} 2>/dev/null || echo 'unavailable'`,
    // B3: logs
    `echo '===LOGS===' && docker logs --tail 20 ${container} 2>&1 | tail -20`,
    // B4: ports
    `echo '===PORTS===' && docker port ${container} 2>/dev/null || echo 'no-ports'`,
  ].join(" && ");

  const start = Date.now();
  const result = await sshExecAsync(vmId, batchCmd, 20_000);
  const ms = Date.now() - start;

  if (result.timedOut) {
    steps.push({
      step: "ssh_batch", ok: false, ms, timedOut: true,
      error: `SSH timeout after ${ms}ms on ${vmId}. Partial output: ${result.stdout.length} bytes`,
      partial_stdout: result.stdout.slice(-300),
    });
    return { ran: true, steps, verdict: `SSH timeout after ${ms}ms`, ms: Date.now() - t0 };
  }

  if (!result.ok && !result.stdout.includes("===INSPECT===")) {
    steps.push({ step: "ssh_connect", ok: false, ms, error: result.stderr.trim().slice(0, 300) });
    return { ran: true, steps, verdict: "VM unreachable", ms: Date.now() - t0 };
  }

  const output = result.stdout;

  // Parse B1: inspect
  const inspectBlock = extractBlock(output, "===INSPECT===", "===STATS===");
  if (inspectBlock && inspectBlock !== "not-found") {
    const [state, healthStatus, restarts, oom, created] = inspectBlock.split("|");
    steps.push({
      step: "inspect",
      ok: state === "running",
      state,
      health: healthStatus,
      restarts: parseInt(restarts ?? "0", 10),
      oom: oom === "true",
      created,
    });
  } else {
    steps.push({ step: "inspect", ok: false, error: "container not found" });
  }

  // Parse B2: stats
  const statsBlock = extractBlock(output, "===STATS===", "===LOGS===");
  if (statsBlock && statsBlock !== "unavailable") {
    const [cpu, mem, memPct, net, block, pids] = statsBlock.split("|");
    steps.push({
      step: "stats",
      ok: true,
      cpu,
      mem,
      memPercent: memPct,
      netIO: net,
      blockIO: block,
      pids,
    });
  }

  // Parse B3: logs
  const logsBlock = extractBlock(output, "===LOGS===", "===PORTS===");
  if (logsBlock) {
    const hasErrors = /error|fatal|panic|exception|ECONNREFUSED/i.test(logsBlock);
    const lines = logsBlock.split("\n").filter(Boolean);
    steps.push({
      step: "logs",
      ok: !hasErrors,
      errors: hasErrors,
      lineCount: lines.length,
      lastLines: lines.slice(-5),
    });
  }

  // Parse B4: ports
  const portsBlock = extractBlock(output, "===PORTS===", null);
  if (portsBlock && portsBlock !== "no-ports") {
    const portLines = portsBlock.split("\n").filter(Boolean);
    steps.push({
      step: "ports",
      ok: portLines.length > 0,
      published: portLines,
    });
  } else {
    steps.push({ step: "ports", ok: true, published: [], note: "no ports published" });
  }

  const allOk = steps.every((s) => s.ok !== false);
  return {
    ran: true,
    steps,
    verdict: allOk ? "Container healthy" : "Container issues detected",
    ms: Date.now() - t0,
  };
}

// ── Engine C: Network path ───────────────────────────────────────────────

async function engineNetwork(
  resolved: Resolved,
): Promise<ProfilingEngine | null> {
  if (!resolved.vm || !resolved.domain) return null;
  const t0 = Date.now();

  const steps: ProfilingStep[] = [];
  const vmId = resolved.vm;

  // C1+C2 batched SSH call
  const netCmd = [
    // C1: WireGuard status
    `echo '===WG===' && sudo wg show 2>/dev/null | head -10 || echo 'wg-unavailable'`,
    // C2: nft/iptables rules
    `echo '===NFT===' && sudo nft list ruleset 2>/dev/null | grep -i 'dnat\\|masq' | head -10 || echo 'no-rules'`,
  ].join(" && ");

  const c12Start = Date.now();
  const result = await sshExecAsync(vmId, netCmd, 15_000);
  const c12Ms = Date.now() - c12Start;

  if (result.timedOut) {
    steps.push({
      step: "ssh_batch_c12", ok: false, ms: c12Ms, timedOut: true,
      error: `SSH timeout after ${c12Ms}ms on ${vmId}. Partial output: ${result.stdout.length} bytes`,
      partial_stdout: result.stdout.slice(-300),
    });
    return { ran: true, steps, verdict: `SSH timeout after ${c12Ms}ms`, ms: Date.now() - t0 };
  }

  if (!result.ok && !result.stdout.includes("===WG===")) {
    steps.push({ step: "ssh_connect", ok: false, ms: c12Ms, error: result.stderr.trim().slice(0, 300) });
    return { ran: true, steps, verdict: "VM unreachable for network check", ms: Date.now() - t0 };
  }

  // Parse C1: WireGuard
  const wgBlock = extractBlock(result.stdout, "===WG===", "===NFT===");
  steps.push({
    step: "wireguard",
    ok: wgBlock !== "wg-unavailable" && wgBlock.includes("peer"),
    ms: c12Ms,
    detail: wgBlock?.slice(0, 200),
  });

  // Parse C2: NFT rules
  const nftBlock = extractBlock(result.stdout, "===NFT===", null);
  steps.push({
    step: "nft_rules",
    ok: true,
    ms: c12Ms,
    detail: nftBlock?.slice(0, 300),
  });

  // C3: Mid-path probe — curl from gcp-proxy to target VM:port
  if (resolved.wg_ip) {
    const c3Start = Date.now();
    const midResult = await sshExecAsync(
      "gcp-proxy",
      `curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://${resolved.wg_ip}:8080/ 2>/dev/null || echo '000'`,
      10_000,
    );
    const c3Ms = Date.now() - c3Start;

    if (midResult.timedOut) {
      steps.push({
        step: "midpath_curl", ok: false, ms: c3Ms, timedOut: true,
        from: "gcp-proxy", to: `${resolved.wg_ip}:8080`,
        error: `Mid-path curl timeout after ${c3Ms}ms. Completed steps: ${steps.map(s => `${s.step}(${s.ms}ms)`).join(", ")}`,
      });
    } else {
      const midStatus = parseInt(midResult.stdout.trim(), 10) || 0;
      steps.push({
        step: "midpath_curl",
        ok: midStatus > 0 && midStatus < 500,
        ms: c3Ms,
        from: "gcp-proxy",
        to: `${resolved.wg_ip}:8080`,
        status: midStatus,
      });
    }
  }

  return {
    ran: true,
    reason: "URL failed but container running",
    steps,
    verdict: steps.every((s) => s.ok !== false)
      ? "Network path OK"
      : "Network path issue detected",
    ms: Date.now() - t0,
  };
}

// ── Engine D: VM context ─────────────────────────────────────────────────

async function engineVmContext(
  resolved: Resolved,
): Promise<ProfilingEngine | null> {
  if (!resolved.vm) return null;
  if (resolved.vm === "local" || resolved.vm === "all") return null;
  const t0 = Date.now();

  const steps: ProfilingStep[] = [];
  const vmId = resolved.vm;

  // D1-D5 in a single SSH batch
  const vmCmd = [
    `echo '===DISK===' && df -h / 2>/dev/null | tail -1`,
    `echo '===MEM===' && free -m 2>/dev/null | grep Mem`,
    `echo '===LOAD===' && cat /proc/loadavg 2>/dev/null`,
    `echo '===DOCKER===' && docker info --format '{{.ContainersRunning}}/{{.Containers}} containers, {{.Images}} images' 2>/dev/null || echo 'docker-error'`,
    `echo '===SYSTEMD===' && systemctl --failed --no-pager --no-legend 2>/dev/null | head -5 || echo 'systemd-unavailable'`,
  ].join(" && ");

  const sshStart = Date.now();
  const result = await sshExecAsync(vmId, vmCmd, 15_000);
  const sshMs = Date.now() - sshStart;

  if (result.timedOut) {
    steps.push({
      step: "ssh_batch_d15", ok: false, ms: sshMs, timedOut: true,
      error: `SSH timeout after ${sshMs}ms on ${vmId}. Partial output: ${result.stdout.length} bytes`,
      partial_stdout: result.stdout.slice(-300),
    });
    return { ran: true, steps, verdict: `SSH timeout after ${sshMs}ms`, ms: Date.now() - t0 };
  }

  if (!result.ok && !result.stdout.includes("===DISK===")) {
    steps.push({ step: "ssh_connect", ok: false, ms: sshMs, error: result.stderr.trim().slice(0, 300) });
    return { ran: true, steps, verdict: "VM unreachable for context check", ms: Date.now() - t0 };
  }

  // Parse D1: disk
  const diskBlock = extractBlock(result.stdout, "===DISK===", "===MEM===");
  if (diskBlock) {
    const parts = diskBlock.trim().split(/\s+/);
    const usePercent = parseInt(parts[4]?.replace("%", "") ?? "0", 10);
    steps.push({
      step: "disk",
      ok: usePercent < 90,
      ms: sshMs,
      total: parts[1],
      used: parts[2],
      available: parts[3],
      percent: parts[4],
    });
  }

  // Parse D2: memory
  const memBlock = extractBlock(result.stdout, "===MEM===", "===LOAD===");
  if (memBlock) {
    const parts = memBlock.trim().split(/\s+/);
    steps.push({
      step: "memory",
      ok: true,
      ms: sshMs,
      total: parts[1],
      used: parts[2],
      free: parts[3],
    });
  }

  // Parse D3: load
  const loadBlock = extractBlock(result.stdout, "===LOAD===", "===DOCKER===");
  if (loadBlock) {
    const loadAvg = parseFloat(loadBlock.trim().split(" ")[0] ?? "0");
    steps.push({
      step: "load",
      ok: loadAvg < 4, // 4 cores max on A1.Flex
      ms: sshMs,
      load1m: loadBlock.trim().split(" ")[0],
      load5m: loadBlock.trim().split(" ")[1],
      load15m: loadBlock.trim().split(" ")[2],
    });
  }

  // Parse D4: docker
  const dockerBlock = extractBlock(result.stdout, "===DOCKER===", "===SYSTEMD===");
  steps.push({
    step: "docker",
    ok: dockerBlock !== "docker-error",
    ms: sshMs,
    detail: dockerBlock?.trim(),
  });

  // Parse D5: systemd
  const systemdBlock = extractBlock(result.stdout, "===SYSTEMD===", null);
  const failedUnits = systemdBlock?.trim();
  steps.push({
    step: "systemd",
    ok: !failedUnits || failedUnits === "systemd-unavailable" || failedUnits === "",
    ms: sshMs,
    failed: failedUnits === "systemd-unavailable" ? undefined : failedUnits,
  });

  const allOk = steps.every((s) => s.ok !== false);
  return {
    ran: true,
    steps,
    verdict: allOk ? "VM healthy" : "VM issues detected",
    ms: Date.now() - t0,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractBlock(
  output: string,
  startMarker: string,
  endMarker: string | null,
): string {
  const startIdx = output.indexOf(startMarker);
  if (startIdx < 0) return "";
  const afterMarker = startIdx + startMarker.length;
  const endIdx = endMarker ? output.indexOf(endMarker, afterMarker) : -1;
  return (endIdx >= 0
    ? output.slice(afterMarker, endIdx)
    : output.slice(afterMarker)
  ).trim();
}

function extractAssetUrls(html: string, baseUrl: string): string[] {
  const urls: string[] = [];
  const base = baseUrl.replace(/\/+$/, "");

  // CSS links
  const cssRegex = /href=["']([^"']+\.css[^"']*)/gi;
  let match: RegExpExecArray | null;
  while ((match = cssRegex.exec(html)) !== null) {
    urls.push(resolveUrl(match[1], base));
  }

  // JS scripts
  const jsRegex = /src=["']([^"']+\.js[^"']*)/gi;
  while ((match = jsRegex.exec(html)) !== null) {
    urls.push(resolveUrl(match[1], base));
  }

  return urls;
}

function resolveUrl(href: string, base: string): string {
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return `https:${href}`;
  if (href.startsWith("/")) {
    const origin = base.match(/^https?:\/\/[^/]+/)?.[0] ?? base;
    return `${origin}${href}`;
  }
  return `${base}/${href}`;
}

function generateDiagnosis(
  a: ProfilingEngine | null,
  b: ProfilingEngine | null,
  c: ProfilingEngine | null,
  d: ProfilingEngine | null,
): string {
  const issues: string[] = [];

  if (a) {
    const curlStep = a.steps.find((s) => s.step === "external_curl");
    const localStep = a.steps.find((s) => s.step === "local_curl");
    if (curlStep && !curlStep.ok) {
      if (localStep?.ok) {
        issues.push(
          `External URL returns ${curlStep.status} but app responds locally — check Caddy/WireGuard`,
        );
      } else if (localStep && !localStep.ok) {
        issues.push(
          `App not responding locally (HTTP ${localStep.status}) — check container logs`,
        );
      } else {
        issues.push(`URL unreachable (HTTP ${curlStep.status})`);
      }
    }
  }

  if (b) {
    const inspectStep = b.steps.find((s) => s.step === "inspect");
    const logsStep = b.steps.find((s) => s.step === "logs");
    if (inspectStep && !inspectStep.ok) {
      issues.push(
        `Container state: ${inspectStep.state ?? "unknown"}, restarts: ${inspectStep.restarts ?? 0}${inspectStep.oom ? ", OOM KILLED" : ""}`,
      );
    }
    if (logsStep?.errors) {
      const lastLines = (logsStep.lastLines as string[]) ?? [];
      const errorLine = lastLines.find((l) =>
        /error|fatal|panic/i.test(l),
      );
      if (errorLine) issues.push(`Log error: ${errorLine.slice(0, 200)}`);
    }
  }

  if (c) {
    const midpath = c.steps.find((s) => s.step === "midpath_curl");
    if (midpath && !midpath.ok) {
      issues.push(
        `Mid-path probe failed: gcp-proxy → ${midpath.to} returns ${midpath.status}`,
      );
    }
  }

  if (d) {
    const disk = d.steps.find((s) => s.step === "disk");
    if (disk && !disk.ok) {
      issues.push(`Disk usage critical: ${disk.percent}`);
    }
    const load = d.steps.find((s) => s.step === "load");
    if (load && !load.ok) {
      issues.push(`High load: ${load.load1m}`);
    }
  }

  return issues.length > 0 ? issues.join(". ") + "." : "All checks passed.";
}
