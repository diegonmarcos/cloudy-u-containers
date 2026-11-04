import { sshExec } from "./ssh.js";
import { getConfig, resolveVmId, getVmSshAlias } from "./config.js";
import { listContainers } from "./docker.js";
import { exec } from "./exec.js";
import type { z } from "zod";
import type { DiagnosticCheckSchema, ProfilingResponseSchema } from "./schemas.js";

type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;
type ProfilingResponse = z.infer<typeof ProfilingResponseSchema>;

function timedCheck(name: string, fn: () => { passed: boolean; details: string }): DiagnosticCheck {
  const start = Date.now();
  try {
    const result = fn();
    return { name, ...result, durationMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name,
      passed: false,
      details: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

function findContainerVm(containerName: string): string | null {
  const config = getConfig();
  for (const [vmId] of Object.entries(config.vms)) {
    const { containers } = listContainers(vmId, true);
    if (containers.some((c) => c.name === containerName)) {
      return vmId;
    }
  }
  return null;
}

export function profileContainer(containerName: string): ProfilingResponse {
  // Find which VM has this container
  const vmId = findContainerVm(containerName);
  if (!vmId) {
    return {
      container: containerName,
      checks: [{ name: "locate", passed: false, details: "Container not found on any VM" }],
      passed: 0,
      failed: 1,
      total: 1,
    };
  }

  const alias = getVmSshAlias(vmId);
  const config = getConfig();
  const vmConfig = config.vms[vmId];
  const checks: DiagnosticCheck[] = [];

  // Check 1: WireGuard ping
  checks.push(timedCheck("wg_ping", () => {
    // 2026-09-04: this pinged vmConfig.ip — the PUBLIC address — despite being
    // named wg_ping. Providers drop ICMP to public IPs (oci-mail reported
    // "Ping to 130.110.251.193: FAILED" while SSH over the mesh was fine), so
    // the check reported a false failure on every healthy VM. Probe the
    // WireGuard address, falling back to the public IP only if no wg_ip.
    const target = vmConfig.wg_ip ?? vmConfig.ip;
    const via = vmConfig.wg_ip ? "wg" : "public";
    const result = exec("ping", ["-c", "1", "-W", "3", target], { timeout: 5_000 });
    return {
      passed: result.ok,
      details: `Ping to ${target} (${via}): ${result.ok ? "OK" : "FAILED"}`,
    };
  }));

  // Check 2: SSH connectivity
  checks.push(timedCheck("ssh_connect", () => {
    const result = sshExec(vmId, "echo ok", 10_000);
    return {
      passed: result.ok,
      details: result.ok ? "SSH session: OK" : `SSH failed: ${result.stderr}`,
    };
  }));

  // Check 3+4: container status + networks (single inspect, no subshell)
  checks.push(timedCheck("container_status", () => {
    // 2026-09-04: {{.State.Health.Status}} makes `docker inspect` FAIL
    // outright on any container without a healthcheck (State.Health is nil),
    // so this check reported "Container inspect failed:" for healthy
    // containers like maddy. Guard the field with {{if}}.
    // 2026-09-06: the network half used a `$(docker inspect ...)` subshell,
    // which the fish login shell on oci-apps refuses ("command substitutions
    // not allowed here") — the check failed for EVERY container on that VM
    // and the error text read like a docker fault. sshExec now runs under
    // bash -c, and this no longer needs a subshell at all: the network NAMES
    // are the keys of .NetworkSettings.Networks, one template, one call.
    const result = sshExec(vmId,
      `docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' ${containerName}`,
      10_000);

    if (!result.ok) {
      // stderr can be empty (the remote command redirects it, or ssh itself
      // failed) — never render a bare "failed:" with nothing after it.
      const why = (result.stderr || result.stdout || "").trim() || "no error output from remote command";
      return { passed: false, details: `Container inspect failed: ${why}` };
    }

    const [status, health, restarts, oom, networks] = result.stdout.trim().split("|");
    const isRunning = status === "running";
    const details = [
      `Status: ${status}`,
      health ? `Health: ${health}` : null,
      `Restarts: ${restarts}`,
      oom === "true" ? "OOM KILLED!" : null,
      networks?.trim() ? `Networks: ${networks.trim()}` : null,
    ].filter(Boolean).join(", ");

    return { passed: isRunning, details };
  }));

  // Batch checks 5+7: port reachability from host + iptables DNAT (single SSH call)
  checks.push(timedCheck("port_reachability", () => {
    const result = sshExec(vmId, [
      `docker port ${containerName} 2>/dev/null`,
      `sudo nft list ruleset 2>/dev/null | grep -i "${containerName}" | head -5 || echo "(no DNAT rules found)"`,
    ].join(" && echo '===DNAT===' && "), 10_000);

    // 2026-09-04: this ignored result.ok entirely and treated "no published
    // ports" as a FAILURE, while wg_port_probe treats the identical condition
    // as a pass. Publishing no ports is a normal, intentional configuration
    // (host networking, mesh-only services), so it is not a fault — only an
    // actual SSH/docker failure is.
    if (!result.ok) {
      const why = (result.stderr || "").trim() || "no error output from remote command";
      return { passed: false, details: `Port lookup failed: ${why}` };
    }

    const parts = result.stdout.split("===DNAT===");
    const ports = (parts[0] ?? "").trim();
    const dnat = (parts[1] ?? "").trim();

    return {
      passed: true,
      details: [
        ports ? `Ports: ${ports}` : "No ports published",
        dnat ? `DNAT: ${dnat}` : "",
      ].filter(Boolean).join("\n"),
    };
  }));

  // Check 6: port reachability via WireGuard
  checks.push(timedCheck("wg_port_probe", () => {
    // Get published ports from container
    const portResult = sshExec(vmId, `docker port ${containerName} 2>/dev/null | head -3`, 5_000);
    if (!portResult.ok || !portResult.stdout.trim()) {
      return { passed: true, details: "No published ports to probe" };
    }

    const portLines = portResult.stdout.trim().split("\n");
    const results: string[] = [];
    for (const line of portLines.slice(0, 3)) {
      // 2026-09-06: probe the address the port is actually BOUND to.
      // `docker port` prints e.g. "8090/tcp -> 10.0.0.6:8090" — mesh-only
      // services bind the WireGuard address, so probing the public IP (as
      // this did) reported "CLOSED" for a perfectly reachable port. A
      // wildcard bind (0.0.0.0 / [::]) falls back to wg_ip, then public.
      const match = line.match(/->\s*\[?([^\]\s]+)\]?:(\d+)\s*$/);
      if (match) {
        const bound = match[1];
        const port = match[2];
        const host = bound === "0.0.0.0" || bound === "::" ? (vmConfig.wg_ip ?? vmConfig.ip) : bound;
        const probe = exec("bash", ["-c", `timeout 3 bash -c "echo > /dev/tcp/${host}/${port}" 2>/dev/null`], { timeout: 5_000 });
        results.push(`${host}:${port} ${probe.ok ? "OPEN" : "CLOSED"}`);
      }
    }

    return {
      passed: results.some((r) => r.includes("OPEN")),
      details: results.join(", ") || "No ports to probe",
    };
  }));

  // Check 7: container resource usage
  checks.push(timedCheck("resources", () => {
    const result = sshExec(vmId, `docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}" ${containerName} 2>/dev/null`, 10_000);
    if (!result.ok) {
      return { passed: true, details: "Stats unavailable" };
    }

    const [cpu, mem, memPct, net, block, pids] = result.stdout.trim().split("|");
    return {
      passed: true,
      details: `CPU: ${cpu}, Mem: ${mem} (${memPct}), Net I/O: ${net}, Block I/O: ${block}, PIDs: ${pids}`,
    };
  }));

  // Check 8: container logs (last 5 lines for errors)
  checks.push(timedCheck("recent_logs", () => {
    const result = sshExec(vmId, `docker logs --tail 5 ${containerName} 2>&1`, 5_000);
    const output = result.stdout.trim();
    const hasErrors = /error|fatal|panic|exception/i.test(output);
    return {
      passed: !hasErrors,
      details: output || "(empty)",
    };
  }));

  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed).length;

  return {
    container: containerName,
    vm: alias,
    checks,
    passed,
    failed,
    total: checks.length,
  };
}

export function profileVm(vmNameOrAlias: string): ProfilingResponse[] {
  const vmId = resolveVmId(vmNameOrAlias);
  const { containers } = listContainers(vmId, false);

  return containers.map((c) => profileContainer(c.name));
}

// ── New: Profile by service name ─────────────────────────────────────────

export function profileService(serviceName: string): ProfilingResponse[] {
  const config = getConfig();
  const svc = config.services[serviceName];
  if (!svc) throw new Error(`Unknown service: ${serviceName}`);
  if (svc.vm === "local" || svc.vm === "all") {
    throw new Error(`Cannot profile service with vm=${svc.vm}`);
  }

  const vmId = svc.vm;
  const { containers } = listContainers(vmId, true);
  const matching = containers.filter((c) => c.name.includes(serviceName));

  if (matching.length === 0) {
    return [{
      container: serviceName,
      vm: getVmSshAlias(vmId),
      checks: [{ name: "locate", passed: false, details: `No containers found matching "${serviceName}"` }],
      passed: 0,
      failed: 1,
      total: 1,
    }];
  }

  return matching.map((c) => profileContainer(c.name));
}

// ── New: VM-level diagnostics ────────────────────────────────────────────

export function vmNetwork(vmNameOrAlias: string): { ok: boolean; output: string } {
  const vmId = resolveVmId(vmNameOrAlias);
  const result = sshExec(vmId, "ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null", 10_000);
  return { ok: result.ok, output: (result.stdout + result.stderr).trim() };
}

export function vmTop(vmNameOrAlias: string): { ok: boolean; output: string } {
  const vmId = resolveVmId(vmNameOrAlias);
  const result = sshExec(vmId, "ps aux --sort=-%mem | head -20", 10_000);
  return { ok: result.ok, output: (result.stdout + result.stderr).trim() };
}

export function vmDiskUsage(vmNameOrAlias: string): { ok: boolean; output: string } {
  const vmId = resolveVmId(vmNameOrAlias);
  const remoteBase = getConfig().remote_base;
  // 2026-09-06 (second pass): the first rewrite ran `du` over /var/lib/docker
  // — 80 GB of overlay2 on oci-apps, minutes of I/O — and the tool call
  // timed out at 60 s with nothing shown. Docker already accounts for its
  // own space (`docker system df`, instant); du only the human-sized trees,
  // each under a hard `timeout`, and never fail on du's exit code.
  //
  // 2026-09-07 (third pass): `docker system df` has no timeout of its own and
  // BLOCKS while the daemon is busy — on oci-apps mid-cgc-restore (multi-GB
  // GHCR pulls) it never returned, so the 55 s ssh deadline killed the whole
  // chain with the output ending at the "--- docker ---" banner and ok:false.
  // `|| echo` cannot rescue a command that never exits; only `timeout` can.
  // Every section now runs under its own `timeout`, and a section that blows
  // its cap says so instead of silently truncating everything after it.
  const cmd = [
    "df -h / | tail -1",
    "echo '--- docker (docker system df) ---'",
    "timeout 20 docker system df 2>/dev/null || echo '(docker system df unavailable or >20s — daemon busy)'",
    "echo '--- other trees (du, 20s cap each) ---'",
    `timeout 20 sudo -n du -xsh ${remoteBase} /var/log /tmp /home /root /var/cache 2>/dev/null | sort -rh`,
    `echo '--- ${remoteBase}/* ---'`,
    `timeout 20 sudo -n du -xsh ${remoteBase}/* 2>/dev/null | sort -rh | head -20`,
    "true",
  ].join("; ");
  const result = sshExec(vmId, cmd, 75_000);
  let output = (result.stdout + (result.stderr ? "\n" + result.stderr : "")).trim();
  // The root df line is the answer to "is the disk full?" — the docker and du
  // breakdowns are colour. Getting the first and losing the rest is a partial
  // result worth returning as ok, clearly marked, not an error with the one
  // number the caller actually needed buried in a false failure.
  const gotDf = /\d+%/.test(output.split("\n")[0] || "");
  if (result.timedOut) {
    output += "\n(truncated — the ssh command hit its deadline; sections above are complete)";
  }
  return { ok: gotDf || (result.ok && output.length > 0), output: output || "(no output — ssh failed or du unreadable)" };
}

export function vmJournal(
  vmNameOrAlias: string,
  lines = 100,
  unit?: string,
): { ok: boolean; output: string } {
  const vmId = resolveVmId(vmNameOrAlias);
  const safeLines = Math.max(1, Math.min(Math.floor(lines), 5000));
  // Whitelist, not quoting: this string is interpolated into a shell command
  // run over ssh, so a unit containing $ or ` would expand even inside quotes.
  const unitArg = unit && /^[A-Za-z0-9@._\-]+$/.test(unit) ? ` -u ${unit}` : "";
  const result = sshExec(
    vmId,
    `journalctl --no-pager -n ${safeLines}${unitArg} 2>/dev/null || echo "(journalctl unavailable)"`,
    15_000,
  );
  return { ok: result.ok, output: (result.stdout + result.stderr).trim() };
}
