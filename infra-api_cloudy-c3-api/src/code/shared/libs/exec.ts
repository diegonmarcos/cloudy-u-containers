import { spawnSync, spawn } from "child_process";
import { SOPS_AGE_KEY_FILE } from "./paths.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
  // 2026-09-06: true when the child was killed by OUR timeout (not a
  // generic failure). mail-ops read `result.timedOut` to tell a slow
  // post-hoc transaction from a broken one; the field never existed here,
  // so that branch was dead (tsc TS2339) — every timeout rendered as a
  // plain "Error:". Both exec paths now set it.
  timedOut: boolean;
}

// Cloud CLIs (gcloud/oci/aws) read config from $HOME/.config/<tool> or
// $HOME/.<tool>. The entrypoint overrides HOME=/tmp/c3-home so SSH finds
// its writable .ssh dir, but that breaks every cloud CLI which then can't
// find /root/.config/gcloud, /root/.oci/config, etc. Override HOME=/root
// when invoking cloud CLIs so they hit the materialised configs.
const CLOUD_CLIS = new Set(["gcloud", "bq", "gsutil", "oci", "aws", "az", "kubectl", "helm"]);
function resolveExecEnv(command: string): NodeJS.ProcessEnv {
  const base = { ...process.env, SOPS_AGE_KEY_FILE } as NodeJS.ProcessEnv;
  if (CLOUD_CLIS.has(command)) base.HOME = "/root";
  return base;
}

export function exec(
  command: string,
  args: string[],
  // `input` feeds the child's stdin. Use it for anything secret — an argv
  // element is readable by any process that can stat /proc/<pid>/cmdline.
  options?: { timeout?: number; cwd?: string; input?: string }
): ExecResult {
  const timeout = options?.timeout ?? 30_000;
  const result = spawnSync(command, args, {
    timeout,
    cwd: options?.cwd,
    input: options?.input,
    encoding: "utf-8",
    env: resolveExecEnv(command),
    maxBuffer: 10 * 1024 * 1024,
  });

  // spawnSync reports its own timeout as error.code ETIMEDOUT (status null,
  // signal SIGTERM); a child that merely exits 124 is NOT our timeout.
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
    ok: result.status === 0,
    timedOut,
  };
}

export function execAsync(
  command: string,
  args: string[],
  options?: { timeout?: number; cwd?: string }
): Promise<ExecResult> {
  const timeout = options?.timeout ?? 30_000;
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options?.cwd,
      env: resolveExecEnv(command),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");
    proc.stdout.on("data", (d: string) => { stdout += d; });
    proc.stderr.on("data", (d: string) => { stderr += d; });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 1_000);
        resolve({ stdout, stderr, exitCode: 1, ok: false, timedOut: true });
      }
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr, exitCode: code ?? 1, ok: code === 0, timedOut: false });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr: stderr + err.message, exitCode: 1, ok: false, timedOut: false });
      }
    });
  });
}
