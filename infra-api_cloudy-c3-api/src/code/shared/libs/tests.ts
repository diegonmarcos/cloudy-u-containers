import { sshExec, checkVmReachable } from "./ssh.js";
import { getConfig, resolveVmId, getVmSshAlias, getServiceDir } from "./config.js";
import { exec } from "./exec.js";
import { listContainers } from "./docker.js";
import { listServices, getService } from "./discovery.js";
import { getDeployHistory } from "./db.js";
import { AUTHELIA_TOKEN_PATH } from "./paths.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// ── Types ────────────────────────────────────────────────────────────────

export interface TestResult {
  name: string;
  target: string;
  passed: boolean;
  timeMs: number;
  details: string;
  error?: string;
}

export interface TestSuiteResult {
  suite: string;
  tests: TestResult[];
  passed: number;
  failed: number;
  total: number;
  timeMs: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function runTest(
  name: string,
  target: string,
  fn: () => { passed: boolean; details: string },
): TestResult {
  const start = Date.now();
  try {
    const { passed, details } = fn();
    return { name, target, passed, timeMs: Date.now() - start, details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      target,
      passed: false,
      timeMs: Date.now() - start,
      details: "Exception thrown during test",
      error: message,
    };
  }
}

function buildSuiteResult(suite: string, tests: TestResult[], suiteStart: number): TestSuiteResult {
  const passed = tests.filter((t) => t.passed).length;
  return {
    suite,
    tests,
    passed,
    failed: tests.length - passed,
    total: tests.length,
    timeMs: Date.now() - suiteStart,
  };
}

/**
 * Get all VM IDs from config, optionally filtered to a single target.
 */
function getVmIds(target?: string): string[] {
  if (target) {
    return [resolveVmId(target)];
  }
  const config = getConfig();
  return Object.keys(config.vms);
}

/**
 * Get all services that have a domain configured.
 */
function getServicesWithDomains(): { name: string; domain: string }[] {
  const services = listServices();
  const result: { name: string; domain: string }[] = [];
  for (const svc of services) {
    if (svc.domain) {
      result.push({ name: svc.name, domain: svc.domain });
    }
  }
  return result;
}

// ── Individual Test Functions ────────────────────────────────────────────

/**
 * Ping the WireGuard IP of a VM to verify tunnel connectivity.
 */
export function testWgPing(vmId: string): TestResult {
  const resolved = resolveVmId(vmId);
  const config = getConfig();
  const vmConfig = config.vms[resolved];
  const ip = vmConfig?.ip ?? "unknown";
  const alias = getVmSshAlias(resolved);

  return runTest("wg-ping", `${alias} (${ip})`, () => {
    const result = exec("ping", ["-c", "1", "-W", "3", ip], { timeout: 10_000 });
    if (result.ok) {
      // Extract round-trip time from ping output
      const rttMatch = result.stdout.match(/time[=<]([\d.]+)\s*ms/);
      const rtt = rttMatch ? `${rttMatch[1]}ms` : "ok";
      return { passed: true, details: `Ping to ${ip} succeeded (${rtt})` };
    }
    return { passed: false, details: `Ping to ${ip} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` };
  });
}

/**
 * Run a full SSH session to verify authentication works end-to-end.
 */
export function testSshSession(vmId: string): TestResult {
  const resolved = resolveVmId(vmId);
  const alias = getVmSshAlias(resolved);

  return runTest("ssh-session", alias, () => {
    const result = sshExec(resolved, "true", 15_000);
    if (result.ok) {
      return { passed: true, details: `SSH session to ${alias} succeeded` };
    }
    return {
      passed: false,
      details: `SSH session to ${alias} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    };
  });
}

/**
 * Verify DNS resolution for a domain using dig.
 */
export function testDnsResolve(domain: string): TestResult {
  return runTest("dns-resolve", domain, () => {
    const result = exec("dig", ["+short", domain], { timeout: 10_000 });
    const output = result.stdout.trim();
    if (result.ok && output.length > 0) {
      // Show resolved addresses (may be multiple lines for CNAME chains)
      const addresses = output.split("\n").filter((l) => l.trim()).join(", ");
      return { passed: true, details: `Resolved: ${addresses}` };
    }
    if (result.ok && output.length === 0) {
      return { passed: false, details: `DNS query returned no records for ${domain}` };
    }
    return { passed: false, details: `dig failed: ${result.stderr.trim() || `exit ${result.exitCode}`}` };
  });
}

/**
 * Check the TLS certificate for a domain: valid subject and not expired.
 */
export function testTlsCert(domain: string): TestResult {
  return runTest("tls-cert", domain, () => {
    const cmd = `echo | openssl s_client -servername ${domain} -connect ${domain}:443 2>/dev/null | openssl x509 -noout -dates -subject`;
    const result = exec("bash", ["-c", cmd], { timeout: 15_000 });
    const output = result.stdout.trim();

    if (!result.ok || output.length === 0) {
      return {
        passed: false,
        details: `TLS handshake failed for ${domain}: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      };
    }

    // Parse notAfter date
    const notAfterMatch = output.match(/notAfter\s*=\s*(.+)/);
    if (!notAfterMatch) {
      return { passed: false, details: `Could not parse certificate expiry from: ${output}` };
    }

    const expiryDate = new Date(notAfterMatch[1].trim());
    const now = new Date();

    if (isNaN(expiryDate.getTime())) {
      return { passed: false, details: `Invalid expiry date: ${notAfterMatch[1]}` };
    }

    if (expiryDate <= now) {
      return { passed: false, details: `Certificate EXPIRED on ${expiryDate.toISOString()}` };
    }

    // Extract subject for info
    const subjectMatch = output.match(/subject\s*=\s*(.+)/);
    const subject = subjectMatch ? subjectMatch[1].trim() : "unknown";
    const daysLeft = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    return {
      passed: true,
      details: `Valid until ${expiryDate.toISOString()} (${daysLeft}d left), subject: ${subject}`,
    };
  });
}

/**
 * Check that an HTTPS route returns an acceptable status code.
 * 200-403 are all acceptable (401/403 means auth is required, which is expected).
 */
export function testHttpRoute(domain: string): TestResult {
  return runTest("http-route", domain, () => {
    const result = exec(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", `https://${domain}/`],
      { timeout: 15_000 },
    );

    const statusCode = parseInt(result.stdout.trim(), 10);

    if (!result.ok && isNaN(statusCode)) {
      return {
        passed: false,
        details: `curl failed for https://${domain}/: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      };
    }

    if (statusCode >= 200 && statusCode <= 403) {
      return { passed: true, details: `HTTP ${statusCode}` };
    }

    return { passed: false, details: `HTTP ${statusCode} (expected 200-403)` };
  });
}

/**
 * Inspect a Docker container's health status and restart count.
 * Passes if the container is running and has fewer than 10 restarts.
 */
export function testContainerHealth(vmId: string, containerName: string): TestResult {
  const resolved = resolveVmId(vmId);
  const alias = getVmSshAlias(resolved);

  return runTest("container-health", `${containerName}@${alias}`, () => {
    const fmt = "'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}'";
    const result = sshExec(resolved, `docker inspect --format ${fmt} ${containerName}`, 15_000);

    if (!result.ok) {
      return {
        passed: false,
        details: `docker inspect failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      };
    }

    const output = result.stdout.trim();
    const parts = output.split("|");
    const status = parts[0] ?? "unknown";
    const health = parts[1] ?? "none";
    const restarts = parseInt(parts[2] ?? "0", 10);

    const isRunning = status === "running";
    const restartsOk = isNaN(restarts) || restarts < 10;

    if (isRunning && restartsOk) {
      const healthInfo = health !== "none" ? `, health=${health}` : "";
      return {
        passed: true,
        details: `Status: ${status}${healthInfo}, restarts: ${isNaN(restarts) ? "?" : restarts}`,
      };
    }

    const reasons: string[] = [];
    if (!isRunning) reasons.push(`status=${status} (not running)`);
    if (!restartsOk) reasons.push(`restarts=${restarts} (>=10)`);

    return { passed: false, details: reasons.join("; ") };
  });
}

/**
 * Check if a TCP port is open on a given IP.
 */
export function testPortOpen(ip: string, port: number): TestResult {
  return runTest("port-open", `${ip}:${port}`, () => {
    const result = exec(
      "bash",
      ["-c", `timeout 3 bash -c 'echo > /dev/tcp/${ip}/${port}'`],
      { timeout: 10_000 },
    );

    if (result.ok) {
      return { passed: true, details: `Port ${port} is open on ${ip}` };
    }
    return { passed: false, details: `Port ${port} is closed or unreachable on ${ip}` };
  });
}

/**
 * REGRESSION #412: obs_debug_db_deploy used to return [] for every query
 * because recordDeploy had no callers, so deploy_log stayed empty even for
 * services that were provably deployed. The deploy recorder is now wired
 * into every deployment tool; an empty deploy_log means that wiring broke
 * again (or the deployment pipeline stopped shipping entirely). Fail loudly
 * instead of letting the tool silently report a clean history.
 */
export function testDeployHistoryPopulated(): TestResult {
  return runTest("deploy-history-populated", "deploy_log", () => {
    const rows = getDeployHistory({});
    if (rows.length === 0) {
      return {
        passed: false,
        details:
          "getDeployHistory() returned []. deploy_log has no rows: recordDeploy " +
          "is not being called by the deployment tools (ticket #412 regression) " +
          "or no deployment has ever been recorded. An empty deploy history for " +
          "provably deployed services is the fail-open this check exists to catch.",
      };
    }
    const latest = rows[0];
    return {
      passed: true,
      details:
        `deploy_log has ${rows.length} rows (limit 50); most recent: ` +
        `${latest.service} ${latest.step} at ${latest.ts} (success=${latest.success})`,
    };
  });
}

// ── Suite Runners ────────────────────────────────────────────────────────

/**
 * Run the "connectivity" suite: WireGuard ping + SSH session for all (or one) VM(s).
 */
function runConnectivitySuite(target?: string): TestSuiteResult {
  const start = Date.now();
  const vmIds = getVmIds(target);
  const tests: TestResult[] = [];

  for (const vmId of vmIds) {
    tests.push(testWgPing(vmId));
    tests.push(testSshSession(vmId));
  }

  return buildSuiteResult("connectivity", tests, start);
}

/**
 * Run the "dns" suite: DNS resolution for all services with domains.
 */
function runDnsSuite(): TestSuiteResult {
  const start = Date.now();
  const services = getServicesWithDomains();
  const tests: TestResult[] = [];

  for (const { domain } of services) {
    tests.push(testDnsResolve(domain));
  }

  return buildSuiteResult("dns", tests, start);
}

/**
 * Run the "tls" suite: TLS certificate validation for all services with domains.
 */
function runTlsSuite(): TestSuiteResult {
  const start = Date.now();
  const services = getServicesWithDomains();
  const tests: TestResult[] = [];

  for (const { domain } of services) {
    tests.push(testTlsCert(domain));
  }

  return buildSuiteResult("tls", tests, start);
}

/**
 * Run the "routes" suite: HTTP route check for all services with domains.
 */
function runRoutesSuite(): TestSuiteResult {
  const start = Date.now();
  const services = getServicesWithDomains();
  const tests: TestResult[] = [];

  for (const { domain } of services) {
    tests.push(testHttpRoute(domain));
  }

  return buildSuiteResult("routes", tests, start);
}

/**
 * Run the "containers" suite: container health check for all running containers.
 * If target is provided, only check that VM.
 */
function runContainersSuite(target?: string): TestSuiteResult {
  const start = Date.now();
  const vmIds = getVmIds(target);
  const tests: TestResult[] = [];

  for (const vmId of vmIds) {
    try {
      const { containers, ok } = listContainers(vmId);
      if (!ok) {
        // Record a single failure for the unreachable VM
        const alias = getVmSshAlias(vmId);
        tests.push({
          name: "container-list",
          target: alias,
          passed: false,
          timeMs: 0,
          details: `Could not list containers on ${alias}`,
        });
        continue;
      }

      for (const container of containers) {
        if (container.name) {
          tests.push(testContainerHealth(vmId, container.name));
        }
      }
    } catch (err) {
      const alias = getVmSshAlias(vmId);
      const message = err instanceof Error ? err.message : String(err);
      tests.push({
        name: "container-list",
        target: alias,
        passed: false,
        timeMs: 0,
        details: `Exception listing containers on ${alias}`,
        error: message,
      });
    }
  }

  return buildSuiteResult("containers", tests, start);
}

/**
 * Run the "wireguard" suite: WireGuard ping for all VMs + wg show parse on each.
 */
function runWireguardSuite(): TestSuiteResult {
  const start = Date.now();
  const config = getConfig();
  const vmIds = Object.keys(config.vms);
  const tests: TestResult[] = [];

  // Ping all VMs over WireGuard
  for (const vmId of vmIds) {
    tests.push(testWgPing(vmId));
  }

  // Parse wg show on each reachable VM
  for (const vmId of vmIds) {
    const alias = getVmSshAlias(vmId);
    tests.push(
      runTest("wg-show", alias, () => {
        const result = sshExec(vmId, "wg show all dump 2>/dev/null | head -20", 15_000);
        if (result.ok && result.stdout.trim().length > 0) {
          const lines = result.stdout.trim().split("\n");
          const peerCount = lines.length > 1 ? lines.length - 1 : 0;
          return { passed: true, details: `WireGuard active, ${peerCount} peer(s)` };
        }
        if (result.ok && result.stdout.trim().length === 0) {
          return { passed: false, details: "WireGuard interface not found or no peers" };
        }
        return {
          passed: false,
          details: `wg show failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        };
      }),
    );
  }

  return buildSuiteResult("wireguard", tests, start);
}

// ── New Test Suites ──────────────────────────────────────────────────────

/**
 * Run the "auth" suite: Test Authelia OIDC flow, verify bearer token works.
 */
function runAuthSuite(): TestSuiteResult {
  const start = Date.now();
  const tests: TestResult[] = [];

  // Test 1: Authelia API health
  tests.push(
    runTest("authelia-health", "auth.diegonmarcos.com", () => {
      const result = exec("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", "https://auth.diegonmarcos.com/api/health"], { timeout: 15_000 });
      const code = parseInt(result.stdout.trim(), 10);
      return {
        passed: code === 200,
        details: code === 200 ? "Authelia health OK" : `HTTP ${code}`,
      };
    }),
  );

  // Test 2: Bearer token exists and not expired
  tests.push(
    runTest("bearer-token", "authelia_tokens.json", () => {
      if (!existsSync(AUTHELIA_TOKEN_PATH)) {
        return { passed: false, details: "No token file found" };
      }
      try {
        const tokens = JSON.parse(readFileSync(AUTHELIA_TOKEN_PATH, "utf-8"));
        if (!tokens.access_token) {
          return { passed: false, details: "No access_token in file" };
        }
        // Check expiry if present
        if (tokens.expires_at) {
          const expiry = new Date(tokens.expires_at);
          const remaining = expiry.getTime() - Date.now();
          if (remaining <= 0) {
            return { passed: false, details: `Token expired ${Math.abs(Math.floor(remaining / 1000))}s ago` };
          }
          return { passed: true, details: `Token valid for ${Math.floor(remaining / 1000)}s` };
        }
        return { passed: true, details: "Token present (no expiry info)" };
      } catch {
        return { passed: false, details: "Failed to parse token file" };
      }
    }),
  );

  return buildSuiteResult("auth", tests, start);
}

/**
 * Run the "secrets" suite: Validate all services with secrets.yaml have decrypted .secrets.
 */
function runSecretsSuite(): TestSuiteResult {
  const start = Date.now();
  const config = getConfig();
  const tests: TestResult[] = [];

  for (const [name, svc] of Object.entries(config.services)) {
    try {
      const serviceDir = getServiceDir(name);
      const secretsYaml = join(serviceDir, "src", "secrets.yaml");
      const dotSecrets = join(serviceDir, "dist", ".secrets");

      if (existsSync(secretsYaml)) {
        tests.push(
          runTest("secrets-decrypted", name, () => {
            return {
              passed: existsSync(dotSecrets),
              details: existsSync(dotSecrets)
                ? "secrets.yaml → .secrets OK"
                : "secrets.yaml exists but no .secrets (run build.sh secrets)",
            };
          }),
        );
      }
    } catch {
      // Service folder may not exist
    }
  }

  return buildSuiteResult("secrets", tests, start);
}

/**
 * Run the "compose" suite: Validate docker-compose.yml syntax.
 */
function runComposeSuite(): TestSuiteResult {
  const start = Date.now();
  const config = getConfig();
  const tests: TestResult[] = [];

  for (const [name] of Object.entries(config.services)) {
    try {
      const serviceDir = getServiceDir(name);
      const composePath = join(serviceDir, "dist", "docker-compose.yml");

      if (existsSync(composePath)) {
        tests.push(
          runTest("compose-syntax", name, () => {
            const result = exec("docker", ["compose", "-f", composePath, "config"], {
              timeout: 10_000,
              cwd: join(serviceDir, "dist"),
            });
            return {
              passed: result.ok,
              details: result.ok
                ? "docker-compose.yml syntax valid"
                : `Syntax error: ${result.stderr.slice(0, 200)}`,
            };
          }),
        );
      }
    } catch {
      // Service folder may not exist
    }
  }

  return buildSuiteResult("compose", tests, start);
}

/**
 * Run the "volumes" suite: Check that declared Docker volumes exist and have data.
 */
function runVolumesSuite(target?: string): TestSuiteResult {
  const start = Date.now();
  const vmIds = getVmIds(target);
  const tests: TestResult[] = [];

  for (const vmId of vmIds) {
    const alias = getVmSshAlias(vmId);
    tests.push(
      runTest("volume-list", alias, () => {
        const result = sshExec(vmId, "docker volume ls -q | wc -l", 10_000);
        if (!result.ok) {
          return { passed: false, details: `Failed to list volumes: ${result.stderr}` };
        }
        const count = parseInt(result.stdout.trim(), 10);
        return {
          passed: count >= 0,
          details: `${count} volume(s) found`,
        };
      }),
    );
  }

  return buildSuiteResult("volumes", tests, start);
}

/**
 * Run the "resources" suite: Memory/disk threshold test — fail if any VM is >85% disk or >90% memory.
 */
function runResourcesSuite(target?: string): TestSuiteResult {
  const start = Date.now();
  const vmIds = getVmIds(target);
  const tests: TestResult[] = [];

  for (const vmId of vmIds) {
    const alias = getVmSshAlias(vmId);

    // Disk check
    tests.push(
      runTest("disk-usage", alias, () => {
        const result = sshExec(vmId, "df / | tail -1 | awk '{print $5}' | sed 's/%//'", 10_000);
        if (!result.ok) {
          return { passed: false, details: `Failed to check disk: ${result.stderr}` };
        }
        const percent = parseInt(result.stdout.trim(), 10);
        return {
          passed: percent < 85,
          details: `Disk usage: ${percent}% ${percent >= 85 ? "(CRITICAL)" : ""}`,
        };
      }),
    );

    // Memory check
    tests.push(
      runTest("memory-usage", alias, () => {
        const result = sshExec(vmId, "free | grep Mem | awk '{printf \"%.0f\", $3/$2 * 100}'", 10_000);
        if (!result.ok) {
          return { passed: false, details: `Failed to check memory: ${result.stderr}` };
        }
        const percent = parseInt(result.stdout.trim(), 10);
        return {
          passed: percent < 90,
          details: `Memory usage: ${percent}% ${percent >= 90 ? "(WARNING)" : ""}`,
        };
      }),
    );
  }

  return buildSuiteResult("resources", tests, start);
}

/**
 * Run the "latency" suite: Service response time test — curl with -w timing.
 */
function runLatencySuite(): TestSuiteResult {
  const start = Date.now();
  const services = getServicesWithDomains();
  const tests: TestResult[] = [];

  for (const { domain } of services) {
    tests.push(
      runTest("response-time", domain, () => {
        const result = exec("curl", [
          "-s", "-o", "/dev/null",
          "-w", "%{time_total}",
          "-m", "10",
          `https://${domain}/`,
        ], { timeout: 15_000 });

        if (!result.ok) {
          return { passed: false, details: `Request failed: ${result.stderr}` };
        }

        const timeSeconds = parseFloat(result.stdout.trim());
        const timeMs = Math.round(timeSeconds * 1000);
        return {
          passed: timeMs < 5000,
          details: `${timeMs}ms ${timeMs >= 5000 ? "(SLOW)" : ""}`,
        };
      }),
    );
  }

  return buildSuiteResult("latency", tests, start);
}

/**
 * Run the "images" suite: Check for outdated/old base images.
 */
function runImagesSuite(target?: string): TestSuiteResult {
  const start = Date.now();
  const vmIds = getVmIds(target);
  const tests: TestResult[] = [];

  for (const vmId of vmIds) {
    const alias = getVmSshAlias(vmId);

    tests.push(
      runTest("image-age", alias, () => {
        // Get images older than 180 days
        const result = sshExec(vmId, `docker image ls --format '{{.CreatedAt}}' | awk '{print $1}' | sort -u | head -5`, 10_000);
        if (!result.ok) {
          return { passed: true, details: "Could not check image age" };
        }
        const dates = result.stdout.trim().split("\n").filter(Boolean);
        return {
          passed: true,
          details: `Oldest images from: ${dates.join(", ") || "none"}`,
        };
      }),
    );
  }

  return buildSuiteResult("images", tests, start);
}

/**
 * Run the "cross-vm" suite: WireGuard connectivity between VMs.
 */
function runCrossVmSuite(): TestSuiteResult {
  const start = Date.now();
  const config = getConfig();
  const vmIds = Object.keys(config.vms);
  const tests: TestResult[] = [];

  if (vmIds.length < 2) {
    return buildSuiteResult("cross-vm", [{
      name: "insufficient-vms",
      target: "all",
      passed: false,
      timeMs: 0,
      details: "Need at least 2 VMs for cross-VM tests",
    }], start);
  }

  // Ping from first VM to all others
  const sourceVm = vmIds[0];
  const sourceAlias = getVmSshAlias(sourceVm);

  for (let i = 1; i < vmIds.length; i++) {
    const targetVm = vmIds[i];
    const targetIp = config.vms[targetVm].ip;
    const targetAlias = getVmSshAlias(targetVm);

    tests.push(
      runTest("wg-cross-ping", `${sourceAlias} → ${targetAlias}`, () => {
        const result = sshExec(sourceVm, `ping -c 1 -W 3 ${targetIp}`, 10_000);
        return {
          passed: result.ok,
          details: result.ok ? `Ping ${targetIp}: OK` : `Ping ${targetIp}: FAILED`,
        };
      }),
    );
  }

  return buildSuiteResult("cross-vm", tests, start);
}

/**
 * Run the "deploy" suite: deploy history must never be empty (ticket #412).
 */
function runDeploySuite(): TestSuiteResult {
  const start = Date.now();
  return buildSuiteResult("deploy", [testDeployHistoryPopulated()], start);
}

// ── Master Dispatcher ────────────────────────────────────────────────────

type SuiteName = "connectivity" | "dns" | "tls" | "routes" | "containers" | "wireguard" | "auth" | "secrets" | "compose" | "volumes" | "resources" | "latency" | "images" | "cross-vm" | "deploy" | "full";

/**
 * Run a named test suite, optionally scoped to a specific VM target.
 *
 * Available suites:
 * - "connectivity" — WireGuard ping + SSH for all VMs (or target VM)
 * - "dns"          — DNS resolution for all services with domains
 * - "tls"          — TLS certificate validation for all services with domains
 * - "routes"       — HTTP route check for all services with domains
 * - "containers"   — Container health for all running containers (or target VM)
 * - "wireguard"    — WireGuard ping + wg show for all VMs
 * - "deploy"       — Deploy history must not be empty (ticket #412 regression)
 * - "full"         — All of the above combined into one suite
 */
export function runTestSuite(suite: SuiteName, target?: string): TestSuiteResult {
  switch (suite) {
    case "connectivity":
      return runConnectivitySuite(target);

    case "dns":
      return runDnsSuite();

    case "tls":
      return runTlsSuite();

    case "routes":
      return runRoutesSuite();

    case "containers":
      return runContainersSuite(target);

    case "wireguard":
      return runWireguardSuite();

    case "auth":
      return runAuthSuite();

    case "secrets":
      return runSecretsSuite();

    case "compose":
      return runComposeSuite();

    case "volumes":
      return runVolumesSuite(target);

    case "resources":
      return runResourcesSuite(target);

    case "latency":
      return runLatencySuite();

    case "images":
      return runImagesSuite(target);

    case "cross-vm":
      return runCrossVmSuite();

    case "deploy":
      return runDeploySuite();

    case "full": {
      const start = Date.now();
      const suites = [
        runConnectivitySuite(target),
        runDnsSuite(),
        runTlsSuite(),
        runRoutesSuite(),
        runContainersSuite(target),
        runWireguardSuite(),
        runAuthSuite(),
        runSecretsSuite(),
        runComposeSuite(),
        runVolumesSuite(target),
        runResourcesSuite(target),
        runLatencySuite(),
        runImagesSuite(target),
        runCrossVmSuite(),
        runDeploySuite(),
      ];

      // Flatten all tests into one combined suite
      const allTests: TestResult[] = [];
      for (const s of suites) {
        allTests.push(...s.tests);
      }

      return buildSuiteResult("full", allTests, start);
    }

    default: {
      const validSuites: SuiteName[] = [
        "connectivity", "dns", "tls", "routes", "containers", "wireguard",
        "auth", "secrets", "compose", "volumes", "resources", "latency", "images", "cross-vm",
        "deploy",
        "full",
      ];
      return {
        suite: String(suite),
        tests: [{
          name: "invalid-suite",
          target: String(suite),
          passed: false,
          timeMs: 0,
          details: `Unknown suite "${String(suite)}". Valid: ${validSuites.join(", ")}`,
        }],
        passed: 0,
        failed: 1,
        total: 1,
        timeMs: 0,
      };
    }
  }
}
