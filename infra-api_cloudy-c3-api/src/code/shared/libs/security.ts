/**
 * Security scanning and auditing.
 *
 * Checks: privileged containers, root users, exposed ports,
 * Docker daemon config, SSH authorized_keys, token expiry.
 */

import { sshExec } from "./ssh.js";
import { getConfig, resolveVmId, getVmSshAlias } from "./config.js";
import { exec } from "./exec.js";
import { existsSync, readFileSync } from "fs";
import { AUTHELIA_TOKEN_PATH } from "./paths.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  check: string;
  target: string;
  severity: "info" | "warn" | "critical";
  details: string;
}

export interface SecurityScanResult {
  vm: string;
  findings: SecurityFinding[];
  summary: { info: number; warn: number; critical: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function summarize(findings: SecurityFinding[]): { info: number; warn: number; critical: number } {
  return {
    info: findings.filter((f) => f.severity === "info").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    critical: findings.filter((f) => f.severity === "critical").length,
  };
}

// ── Security Scan ────────────────────────────────────────────────────────

export function securityScan(vmFilter?: string): SecurityScanResult[] {
  const config = getConfig();
  const vmIds = vmFilter ? [resolveVmId(vmFilter)] : Object.keys(config.vms);
  const results: SecurityScanResult[] = [];

  for (const vmId of vmIds) {
    const alias = getVmSshAlias(vmId);
    const findings: SecurityFinding[] = [];

    // Batch SSH: privileged + root + ports + capabilities in one call
    const cmd = [
      // Privileged containers
      `docker ps --format '{{.Names}}' -q | xargs -r docker inspect --format '{{.Name}} PRIV={{.HostConfig.Privileged}} PID={{.HostConfig.PidMode}} NET={{.HostConfig.NetworkMode}}' 2>/dev/null`,
      "echo '===ROOT==='",
      // Containers running as root
      `docker ps --format '{{.Names}}' -q | xargs -r docker inspect --format '{{.Name}} USER={{.Config.User}}' 2>/dev/null`,
      "echo '===PORTS==='",
      // Published ports bound to 0.0.0.0
      `docker ps --format '{{.Names}}\\t{{.Ports}}' 2>/dev/null`,
      "echo '===RESTART==='",
      // High restart counts
      `docker ps -a --format '{{.Names}}\\t{{.Status}}' 2>/dev/null | grep -i restarting || true`,
    ].join(" && ");

    const result = sshExec(vmId, cmd, 20_000);
    if (!result.ok) {
      findings.push({
        check: "ssh_access",
        target: alias,
        severity: "critical",
        details: `Cannot SSH to ${alias}: ${result.stderr.trim()}`,
      });
      results.push({ vm: alias, findings, summary: summarize(findings) });
      continue;
    }

    const sections = result.stdout.split("===");
    const privSection = (sections[0] ?? "").trim();
    const rootSection = sections.find((s) => s.startsWith("ROOT==="))?.replace("ROOT===", "").trim() ?? "";
    const portsSection = sections.find((s) => s.startsWith("PORTS==="))?.replace("PORTS===", "").trim() ?? "";
    const restartSection = sections.find((s) => s.startsWith("RESTART==="))?.replace("RESTART===", "").trim() ?? "";

    // Check privileged
    for (const line of privSection.split("\n").filter(Boolean)) {
      if (line.includes("PRIV=true")) {
        const name = line.split(" ")[0]?.replace("/", "") ?? "unknown";
        findings.push({
          check: "privileged_container",
          target: `${name}@${alias}`,
          severity: "critical",
          details: `Container ${name} runs in privileged mode`,
        });
      }
      if (line.includes("PID=host")) {
        const name = line.split(" ")[0]?.replace("/", "") ?? "unknown";
        findings.push({
          check: "host_pid",
          target: `${name}@${alias}`,
          severity: "warn",
          details: `Container ${name} uses host PID namespace`,
        });
      }
    }

    // Check root
    for (const line of rootSection.split("\n").filter(Boolean)) {
      if (line.includes("USER=") && !line.includes("USER=") === false) {
        const parts = line.split(" ");
        const name = parts[0]?.replace("/", "") ?? "unknown";
        const user = parts.find((p) => p.startsWith("USER="))?.replace("USER=", "") ?? "";
        if (user === "" || user === "root" || user === "0") {
          findings.push({
            check: "root_user",
            target: `${name}@${alias}`,
            severity: "info",
            details: `Container ${name} runs as root (user="${user || "default/root"}")`,
          });
        }
      }
    }

    // Check wide port bindings
    for (const line of portsSection.split("\n").filter(Boolean)) {
      if (line.includes("0.0.0.0:")) {
        const [containerName, ports] = line.split("\t");
        // Only flag if a sensitive port is bound to all interfaces
        const portMatches = ports?.match(/0\.0\.0\.0:(\d+)/g) ?? [];
        for (const match of portMatches) {
          const port = match.replace("0.0.0.0:", "");
          findings.push({
            check: "wide_port_binding",
            target: `${containerName}@${alias}`,
            severity: "info",
            details: `Port ${port} bound to 0.0.0.0 (all interfaces)`,
          });
        }
      }
    }

    // Check restarting containers
    for (const line of restartSection.split("\n").filter(Boolean)) {
      const [name] = line.split("\t");
      findings.push({
        check: "container_restarting",
        target: `${name}@${alias}`,
        severity: "warn",
        details: `Container ${name} is in restarting state`,
      });
    }

    results.push({ vm: alias, findings, summary: summarize(findings) });
  }

  return results;
}

// ── Docker Security Info ─────────────────────────────────────────────────

export interface DockerSecurityInfo {
  vm: string;
  securityOptions: string[];
  storageDriver: string;
  cgroupVersion: string;
  oomKillDisable: boolean;
  liveRestore: boolean;
  usernsRemap: string;
  raw: string;
}

export function securityDocker(vmNameOrAlias: string): DockerSecurityInfo {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const result = sshExec(vmId, `docker info --format '{{json .}}' 2>/dev/null`, 15_000);

  if (!result.ok) {
    return {
      vm: alias,
      securityOptions: [],
      storageDriver: "unknown",
      cgroupVersion: "unknown",
      oomKillDisable: false,
      liveRestore: false,
      usernsRemap: "",
      raw: result.stderr,
    };
  }

  try {
    const info = JSON.parse(result.stdout.trim());
    return {
      vm: alias,
      securityOptions: info.SecurityOptions ?? [],
      storageDriver: info.Driver ?? "unknown",
      cgroupVersion: info.CgroupVersion ?? "unknown",
      oomKillDisable: info.OomKillDisable ?? false,
      liveRestore: info.LiveRestoreEnabled ?? false,
      usernsRemap: info.DockerRootDir?.includes("userns") ? "enabled" : (info.UsernsMode ?? ""),
      raw: result.stdout.trim(),
    };
  } catch {
    return {
      vm: alias,
      securityOptions: [],
      storageDriver: "unknown",
      cgroupVersion: "unknown",
      oomKillDisable: false,
      liveRestore: false,
      usernsRemap: "",
      raw: result.stdout.trim(),
    };
  }
}

// ── SSH Keys Audit ───────────────────────────────────────────────────────

export interface SshKeysAudit {
  vm: string;
  keyCount: number;
  keys: { type: string; comment: string }[];
  raw: string;
}

export function securitySshKeys(vmNameOrAlias: string): SshKeysAudit {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const result = sshExec(vmId, "cat ~/.ssh/authorized_keys 2>/dev/null || echo '(no authorized_keys)'", 10_000);

  const lines = result.stdout.trim().split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("("));
  const keys = lines.map((line) => {
    const parts = line.trim().split(/\s+/);
    return {
      type: parts[0] ?? "unknown",
      comment: parts[2] ?? "(no comment)",
    };
  });

  return {
    vm: alias,
    keyCount: keys.length,
    keys,
    raw: result.stdout.trim(),
  };
}

// ── Token Status ─────────────────────────────────────────────────────────

export interface TokenStatus {
  hasToken: boolean;
  expiresAt?: string;
  isExpired?: boolean;
  remainingSeconds?: number;
}

export function securityTokens(): TokenStatus {
  if (!existsSync(AUTHELIA_TOKEN_PATH)) {
    return { hasToken: false };
  }

  try {
    const tokens = JSON.parse(readFileSync(AUTHELIA_TOKEN_PATH, "utf-8"));
    const accessToken = tokens.access_token;
    const expiresAt = tokens.expires_at;

    if (!accessToken) {
      return { hasToken: false };
    }

    if (expiresAt) {
      const expiry = new Date(expiresAt);
      const now = new Date();
      const remaining = Math.floor((expiry.getTime() - now.getTime()) / 1000);

      return {
        hasToken: true,
        expiresAt: expiry.toISOString(),
        isExpired: remaining <= 0,
        remainingSeconds: remaining,
      };
    }

    // Try decoding JWT to find exp claim
    const parts = accessToken.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (payload.exp) {
        const expiry = new Date(payload.exp * 1000);
        const remaining = Math.floor((expiry.getTime() - Date.now()) / 1000);
        return {
          hasToken: true,
          expiresAt: expiry.toISOString(),
          isExpired: remaining <= 0,
          remainingSeconds: remaining,
        };
      }
    }

    return { hasToken: true };
  } catch {
    return { hasToken: false };
  }
}
