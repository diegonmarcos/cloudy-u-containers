/**
 * Text file retrieval for infrastructure configs, logs, status, and reports.
 *
 * All functions are synchronous and security-aware:
 * - Secret values are NEVER exposed (only existence is reported)
 * - Sensitive patterns in output are redacted
 * - Container/path names are validated before use
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getConfig, getServiceDir, resolveVmId, getVmSshAlias, getServicesForVm } from "./config.js";
import { SOLUTIONS_DIR } from "./paths.js";
import { sshExec } from "./ssh.js";
import { healthDeclared, healthDrift, metricsSnapshot } from "./health.js";
import { listServices } from "./discovery.js";
import { securityScan } from "./security.js";

// ── Security Helpers ─────────────────────────────────────────────────────

const SENSITIVE_PATTERN = /\b(password|secret|token|key)\b/i;

/**
 * Redact the value portion of lines containing sensitive keywords.
 * Handles formats like: KEY=value, "key": "value", key: value
 */
function redactSensitiveLines(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      if (!SENSITIVE_PATTERN.test(line)) return line;
      // Redact after = (env-style)
      if (line.includes("=")) {
        return line.replace(/=.*/, "=***REDACTED***");
      }
      // Redact after : (YAML / JSON style)
      if (line.includes(":")) {
        return line.replace(/:.*/, ": ***REDACTED***");
      }
      // Fallback: redact entire line value
      return "***REDACTED***";
    })
    .join("\n");
}

/**
 * Redact WireGuard private keys from wg show output.
 */
function redactWireGuardKeys(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim().toLowerCase();
      if (trimmed.startsWith("private key:")) {
        return line.replace(/:.*/, ": ***REDACTED***");
      }
      if (trimmed.startsWith("preshared key:")) {
        return line.replace(/:.*/, ": ***REDACTED***");
      }
      return line;
    })
    .join("\n");
}

const CONTAINER_NAME_RE = /^[a-zA-Z0-9_.-]+$/;

const ALLOWED_CONFIG_FILES = new Set(["build.json", "docker-compose.yml", "flake.nix"]);

// ── Exported Functions ───────────────────────────────────────────────────

/**
 * Reads a config file from a service's directory on disk.
 *
 * Lookup paths by filename:
 * - build.json       -> {serviceDir}/build.json
 * - docker-compose.yml -> {serviceDir}/dist/docker-compose.yml
 * - flake.nix        -> {serviceDir}/src/flake.nix
 *
 * Sensitive lines (password, secret, token, key) are redacted.
 */
export function getConfigFile(service: string, filename = "build.json"): string {
  try {
    if (!ALLOWED_CONFIG_FILES.has(filename)) {
      return `Error: unsupported filename "${filename}". Allowed: ${Array.from(ALLOWED_CONFIG_FILES).join(", ")}`;
    }

    let serviceDir: string;
    try {
      serviceDir = getServiceDir(service);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error: ${message}`;
    }

    let filePath: string;
    switch (filename) {
      case "docker-compose.yml":
        filePath = join(serviceDir, "dist", filename);
        break;
      case "flake.nix":
        filePath = join(serviceDir, "src", filename);
        break;
      default:
        filePath = join(serviceDir, filename);
        break;
    }

    if (!existsSync(filePath)) {
      return `Error: file not found: ${filePath}`;
    }

    const content = readFileSync(filePath, "utf-8");
    return redactSensitiveLines(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error reading config file: ${message}`;
  }
}

/**
 * Gets container logs via SSH.
 *
 * Validates container name (alphanumeric, dash, underscore, dot only).
 * Returns log output as a string.
 */
export function getContainerLog(
  vmId: string,
  container: string,
  lines = 100,
  since?: string,
): string {
  try {
    // Validate container name
    if (!CONTAINER_NAME_RE.test(container)) {
      return `Error: invalid container name "${container}". Only alphanumeric, dash, underscore, and dot are allowed.`;
    }

    const resolvedVm = resolveVmId(vmId);
    const safeTail = Math.max(1, Math.min(Math.floor(lines), 10000));

    let cmd = `docker logs --tail ${safeTail}`;
    if (since) {
      // Basic validation for since format
      const sinceRe = /^\d+[smhd]$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;
      if (!sinceRe.test(since)) {
        return `Error: invalid --since format "${since}". Expected: '1h', '30m', '2d', or '2024-01-01'`;
      }
      cmd += ` --since ${since}`;
    }
    cmd += ` ${container} 2>&1`;

    const result = sshExec(resolvedVm, cmd, 15_000);
    if (!result.ok) {
      return `Error getting logs (exit ${result.exitCode}): ${(result.stdout + result.stderr).trim()}`;
    }

    return (result.stdout + result.stderr).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/**
 * SSHs into a VM and runs a combined status command covering:
 * uptime, WireGuard, Docker containers, disk, and memory.
 *
 * WireGuard private keys are redacted from output.
 */
export function getVmStatus(vmId: string): string {
  try {
    const resolvedVm = resolveVmId(vmId);
    const alias = getVmSshAlias(resolvedVm);

    const cmd = [
      'uptime',
      'echo "===WG==="',
      'sudo wg show 2>/dev/null || echo "(no wg)"',
      'echo "===DOCKER==="',
      'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
      'echo "===DISK==="',
      'df -h /',
      'echo "===MEM==="',
      'free -h',
    ].join(" && ");

    const result = sshExec(resolvedVm, cmd, 20_000);
    if (!result.ok) {
      return `Error: SSH to ${alias} failed (exit ${result.exitCode}): ${result.stderr.trim()}`;
    }

    const output = result.stdout;
    return redactWireGuardKeys(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error: ${message}`;
  }
}

/**
 * Generates a text report based on reportType.
 *
 * Supported types:
 * - "health"     -- Declared + drift summary as markdown
 * - "services"   -- All services with VM, category, domain
 * - "drift"      -- Detailed drift report (declared vs deployed)
 * - "resources"  -- Container resource usage (CPU, memory, I/O)
 * - "security"   -- Security scan findings
 */
export function getReport(reportType: string): string {
  try {
    switch (reportType) {
      case "health": {
        const declared = healthDeclared();
        const drift = healthDrift();

        const missing = drift.filter((d) => d.status === "missing");
        const extra = drift.filter((d) => d.status === "extra");
        const unknown = drift.filter((d) => d.status === "unknown");

        const lines: string[] = [
          "# Health Report",
          "",
          `## Declared: ${declared.vmCount} VMs, ${declared.serviceCount} services`,
          "",
          `## Drift: ${missing.length} missing, ${extra.length} extra`,
          "",
        ];

        if (missing.length > 0) {
          lines.push("### Missing (declared but not deployed)");
          for (const entry of missing) {
            lines.push(`- ${entry.service}`);
          }
          lines.push("");
        }

        if (extra.length > 0) {
          lines.push("### Extra (deployed but not declared)");
          for (const entry of extra) {
            lines.push(`- ${entry.service}`);
          }
          lines.push("");
        }

        if (unknown.length > 0) {
          lines.push("### Unknown (VM unreachable)");
          for (const entry of unknown) {
            lines.push(`- ${entry.service}`);
          }
          lines.push("");
        }

        if (missing.length === 0 && extra.length === 0 && unknown.length === 0) {
          lines.push("All services aligned. No drift detected.");
          lines.push("");
        }

        return lines.join("\n");
      }

      case "services": {
        const services = listServices();
        const lines: string[] = [
          "# Services Report",
          "",
          "| Service | VM | Category | Domain |",
          "|---------|-----|----------|--------|",
        ];

        for (const svc of services) {
          const domain = svc.domain ?? "(none)";
          const alias = svc.alias ?? svc.vm;
          lines.push(`| ${svc.name} | ${alias} | ${svc.category} | ${domain} |`);
        }

        lines.push("");
        lines.push(`Total: ${services.length} services`);
        return lines.join("\n");
      }

      case "drift": {
        const drift = healthDrift();
        const lines: string[] = [
          "# Drift Report (Declared vs Deployed)",
          "",
          "| Service | Declared | Deployed | Status |",
          "|---------|----------|----------|--------|",
        ];

        for (const entry of drift) {
          const declared = entry.declared ? "YES" : "NO";
          const deployed = entry.deployed ? "YES" : "NO";
          lines.push(`| ${entry.service} | ${declared} | ${deployed} | ${entry.status} |`);
        }

        lines.push("");

        const ok = drift.filter((d) => d.status === "ok").length;
        const missing = drift.filter((d) => d.status === "missing").length;
        const extra = drift.filter((d) => d.status === "extra").length;
        const unknown = drift.filter((d) => d.status === "unknown").length;
        lines.push(`Summary: ${ok} ok, ${missing} missing, ${extra} extra, ${unknown} unknown`);
        return lines.join("\n");
      }

      case "resources": {
        const metrics = metricsSnapshot();
        const lines: string[] = [
          "# Resources Report",
          "",
          "| VM | Container | CPU | Memory | Net I/O | Block I/O |",
          "|-----|-----------|-----|--------|---------|-----------|",
        ];

        for (const vmMetrics of metrics) {
          if (vmMetrics.error) {
            lines.push(`| ${vmMetrics.alias} | - | - | - | - | ${vmMetrics.error} |`);
            continue;
          }
          for (const c of vmMetrics.containers) {
            lines.push(
              `| ${vmMetrics.alias} | ${c.name} | ${c.cpuPercent} | ${c.memUsage} | ${c.netIO} | ${c.blockIO} |`,
            );
          }
        }

        lines.push("");
        const totalContainers = metrics.reduce((sum, vm) => sum + vm.containers.length, 0);
        lines.push(`Total: ${totalContainers} containers across ${metrics.length} VMs`);
        return lines.join("\n");
      }

      case "security": {
        const results = securityScan();
        const lines: string[] = [
          "# Security Scan Report",
          "",
        ];

        for (const vmResult of results) {
          lines.push(`## ${vmResult.vm}`);
          lines.push("");
          lines.push(`**Findings**: ${vmResult.summary.critical} critical, ${vmResult.summary.warn} warnings, ${vmResult.summary.info} info`);
          lines.push("");

          const critical = vmResult.findings.filter((f) => f.severity === "critical");
          if (critical.length > 0) {
            lines.push("### Critical");
            for (const f of critical) {
              lines.push(`- **${f.check}** (${f.target}): ${f.details}`);
            }
            lines.push("");
          }

          const warn = vmResult.findings.filter((f) => f.severity === "warn");
          if (warn.length > 0) {
            lines.push("### Warnings");
            for (const f of warn) {
              lines.push(`- ${f.check} (${f.target}): ${f.details}`);
            }
            lines.push("");
          }
        }

        return lines.join("\n");
      }

      default:
        return `Error: unknown report type "${reportType}". Supported: health, services, drift, resources, security`;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error generating report: ${message}`;
  }
}

/**
 * Checks secrets file existence for a specific service or all services.
 *
 * Reports whether:
 * - src/secrets.yaml exists (sops-encrypted source)
 * - dist/.secrets exists (decrypted output)
 *
 * NEVER reads or returns the contents of secrets files.
 */
export function getSecretsStatus(service?: string): string {
  try {
    const config = getConfig();
    const serviceNames = service
      ? [service]
      : Object.keys(config.services).sort();

    const lines: string[] = [];

    for (const name of serviceNames) {
      if (!config.services[name]) {
        lines.push(`${name}: ERROR (unknown service)`);
        continue;
      }

      let serviceDir: string;
      try {
        serviceDir = getServiceDir(name);
      } catch {
        lines.push(`${name}: ERROR (could not resolve service directory)`);
        continue;
      }

      // Check if the service directory itself exists.
      // 2026-09-04: this printed a bare "directory not found" for 68 of 74
      // services, which reads like a per-service fault. The real cause is
      // almost always that the a_solutions source tree is not checked out in
      // this container at all (it is a git submodule of cloud-infra, and the
      // repos volume clones without submodules) — so say which path was
      // probed and name that cause once, instead of 68 identical mysteries.
      if (!existsSync(serviceDir)) {
        const treeMissing = !existsSync(SOLUTIONS_DIR);
        lines.push(
          treeMissing
            ? `${name}: UNKNOWN (service source tree not available at ${SOLUTIONS_DIR} — a_solutions submodule not checked out)`
            : `${name}: ERROR (directory not found: ${serviceDir})`,
        );
        continue;
      }

      const secretsYamlPath = join(serviceDir, "src", "secrets.yaml");
      const dotSecretsPath = join(serviceDir, "dist", ".secrets");

      const hasSecretsYaml = existsSync(secretsYamlPath);
      const hasDotSecrets = existsSync(dotSecretsPath);

      if (!hasSecretsYaml) {
        lines.push(`${name}: secrets.yaml=NO (no secrets configured)`);
      } else if (hasSecretsYaml && hasDotSecrets) {
        lines.push(`${name}: secrets.yaml=YES, .secrets=YES`);
      } else {
        lines.push(`${name}: secrets.yaml=YES, .secrets=NO (needs: build.sh secrets)`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error checking secrets status: ${message}`;
  }
}
