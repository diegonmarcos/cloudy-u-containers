/**
 * Async exec — non-blocking alternative to exec.ts (spawnSync).
 * Uses child_process.spawn with Promise wrapper.
 *
 * TIMEOUT HANDLING: On timeout, returns partial stdout/stderr collected so far,
 * exitCode=124, ok=false, timedOut=true, with the command and timeout in the error.
 */

import { spawn } from "child_process";
import { SOPS_AGE_KEY_FILE } from "./paths.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
  timedOut: boolean;
  command: string;
  durationMs: number;
  timeoutMs?: number;
}

export function execAsync(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string },
): Promise<ExecResult> {
  const timeoutMs = options?.timeout ?? 30_000;
  const startMs = Date.now();
  const cmdStr = `${command} ${args.join(" ")}`.slice(0, 200);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    let wasTimeout = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, {
        cwd: options?.cwd,
        env: { ...process.env, SOPS_AGE_KEY_FILE },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        exitCode: 127,
        ok: false,
        timedOut: false,
        command: cmdStr,
        durationMs: Date.now() - startMs,
      });
      return;
    }

    // stdio is always piped here, but the typings say the streams may be
    // null (they are, when stdio is "ignore"); guard so tsc is clean.
    proc.stdout?.on("data", (d) => chunks.push(d));
    proc.stderr?.on("data", (d) => errChunks.push(d));

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = Date.now() - startMs;
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      resolve({
        stdout,
        stderr: wasTimeout
          ? `[TIMEOUT after ${timeoutMs}ms] ${cmdStr}\n` +
            `Partial stderr (${stderr.length} bytes): ${stderr.slice(-500)}`
          : stderr,
        exitCode,
        ok: exitCode === 0,
        timedOut: wasTimeout,
        command: cmdStr,
        durationMs,
        ...(wasTimeout ? { timeoutMs } : {}),
      });
    };

    proc.on("close", (code) => finish(code ?? 1));
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: `exec error: ${err.message}`,
        exitCode: 1,
        ok: false,
        timedOut: false,
        command: cmdStr,
        durationMs: Date.now() - startMs,
      });
    });

    timer = setTimeout(() => {
      if (!settled) {
        wasTimeout = true;
        proc.kill("SIGKILL");
        // Give 500ms for SIGKILL to produce close event, then force finish
        setTimeout(() => finish(124), 500);
      }
    }, timeoutMs);
  });
}

/**
 * Run a shell script string asynchronously.
 */
export function shellAsync(
  script: string,
  timeout?: number,
): Promise<ExecResult> {
  return execAsync("sh", ["-c", script], { timeout });
}
