/**
 * Async SSH execution — non-blocking version of ssh.ts.
 * Uses SSH aliases from ~/.ssh/config — no custom mux, no IP resolution.
 *
 * ERROR HANDLING: Every function catches all exceptions and returns
 * structured errors with timing. Never throws — always returns a result.
 */

import { execAsync } from "./async-exec.js";
import type { ExecResult } from "./async-exec.js";
import { resolveVmId, getVmSshAlias } from "./config.js";

/** Error result with context */
function errorResult(
  error: string,
  context: string,
  startMs: number,
): ExecResult {
  return {
    stdout: "",
    stderr: `[${context}] ${error}`,
    exitCode: 1,
    ok: false,
    timedOut: false,
    command: context,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Async SSH exec via alias — non-blocking.
 * All connection logic lives in ~/.ssh/config.
 * NEVER throws — catches all errors, returns structured result with timing.
 */
export async function sshExecAsync(
  vmNameOrAlias: string,
  command: string,
  timeout?: number,
): Promise<ExecResult> {
  const startMs = Date.now();
  const ctx = `ssh:${vmNameOrAlias}`;

  let vmId: string;
  try {
    vmId = resolveVmId(vmNameOrAlias);
  } catch (err) {
    return errorResult(
      `VM resolve failed: ${err instanceof Error ? err.message : String(err)}`,
      ctx, startMs,
    );
  }

  const alias = getVmSshAlias(vmId);

  const result = await execAsync(
    "ssh",
    [
      "-o", "BatchMode=yes",
      // /root/.ssh is a read-only bind mount — without this, accept-new warns
      // on every connection and that stderr contaminates tool output.
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      alias, command,
    ],
    { timeout: timeout ?? 15_000 },
  );

  // Enrich timeout errors with SSH context
  if (result.timedOut) {
    result.stderr = `[SSH TIMEOUT after ${result.timeoutMs}ms] ${alias}\n` +
      `Command: ${command.slice(0, 300)}\n` +
      `Duration: ${result.durationMs}ms\n` +
      `Partial output (${result.stdout.length} bytes): ${result.stdout.slice(-200)}`;
  }

  return result;
}

/**
 * Async TCP probe via ssh-keyscan — no auth, very fast.
 * NEVER throws.
 */
export async function tcpProbeAsync(
  host: string,
  timeout = 5_000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await execAsync("ssh-keyscan", ["-T", "3", host], { timeout });
    const ms = Date.now() - start;
    if (result.timedOut) {
      return { ok: false, ms, error: `TCP probe timeout after ${timeout}ms for ${host}` };
    }
    return {
      ok: result.ok && result.stdout.trim().length > 0,
      ms,
      ...(!result.ok ? { error: `TCP probe failed: ${result.stderr.slice(0, 200)}` } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: `TCP probe exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Async ping probe — fast ICMP check. NEVER throws.
 */
export async function pingAsync(
  host: string,
  timeout = 3_000,
): Promise<{ ok: boolean; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const result = await execAsync("ping", ["-c", "1", "-W", "2", host], { timeout });
    const ms = Date.now() - start;
    if (result.timedOut) {
      return { ok: false, ms, error: `Ping timeout after ${timeout}ms for ${host}` };
    }
    return {
      ok: result.ok,
      ms,
      ...(!result.ok ? { error: `Ping failed: ${result.stderr.slice(0, 200)}` } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - start,
      error: `Ping exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Async curl probe — HTTP status code only, fast. NEVER throws.
 */
export async function curlStatusAsync(
  url: string,
  timeout = 5_000,
): Promise<{ ok: boolean; status: number; ms: number; timedOut?: boolean; error?: string }> {
  const start = Date.now();
  try {
    const result = await execAsync(
      "curl",
      ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "5", "--connect-timeout", "3", url],
      { timeout },
    );
    const ms = Date.now() - start;
    if (result.timedOut) {
      return { ok: false, status: 0, ms, timedOut: true, error: `Curl timeout after ${timeout}ms for ${url}` };
    }
    const status = parseInt(result.stdout.trim(), 10) || 0;
    return {
      ok: status > 0 && status < 500,
      status,
      ms,
      ...(status === 0 ? { error: result.stderr.trim().slice(0, 300) || "connection failed" } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - start,
      error: `Curl exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Async curl with body — for content verification. NEVER throws.
 */
export async function curlAsync(
  url: string,
  timeout = 10_000,
): Promise<{
  ok: boolean;
  status: number;
  body: string;
  headers: string;
  ms: number;
  timedOut?: boolean;
  error?: string;
}> {
  const start = Date.now();
  try {
    const result = await execAsync(
      "curl",
      ["-s", "-D-", "-m", "8", "--connect-timeout", "3", url],
      { timeout },
    );
    const ms = Date.now() - start;

    if (result.timedOut) {
      return {
        ok: false, status: 0, body: result.stdout.slice(0, 1000), headers: "", ms,
        timedOut: true,
        error: `Curl timeout after ${timeout}ms for ${url}. Partial body: ${result.stdout.length} bytes`,
      };
    }

    if (!result.ok && !result.stdout.trim()) {
      return {
        ok: false, status: 0, body: "", headers: "", ms,
        error: `Curl failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`,
      };
    }

    // Split headers from body (double CRLF separator)
    const raw = result.stdout;
    const sep = raw.indexOf("\r\n\r\n");
    const headers = sep >= 0 ? raw.slice(0, sep) : "";
    const body = sep >= 0 ? raw.slice(sep + 4) : raw;

    // Extract status code from first header line
    const statusMatch = headers.match(/HTTP\/[\d.]+ (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    return {
      ok: status >= 200 && status < 500,
      status,
      body: body.slice(0, 50_000),
      headers,
      ms,
    };
  } catch (err) {
    return {
      ok: false, status: 0, body: "", headers: "",
      ms: Date.now() - start,
      error: `Curl exception: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
