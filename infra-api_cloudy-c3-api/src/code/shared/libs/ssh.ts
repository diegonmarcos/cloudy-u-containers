import { exec, execAsync, type ExecResult } from "./exec.js";
import { resolveVmId, getVmSshAlias } from "./config.js";
import { audit } from "./audit.js";
import { remoteShellWrap } from "./shell-quote.js";
import { sshArgv, vmMeshAddress } from "./ssh-argv.js";

// ── SSH via alias ──────────────────────────────────────────────────
// All connection logic (host, user, key, ProxyJump, mux) lives in
// ~/.ssh/config. MCP tools just run `ssh <alias> <command>`.
// No custom IP resolution, no WG retry, no mux management.
//
// UserKnownHostsFile=/dev/null: /root/.ssh is a read-only bind mount, so with
// `StrictHostKeyChecking accept-new` ssh accepts the key but cannot append it
// and warns "Failed to add the host to the list of known hosts" on every
// connection — that stderr gets spliced into MCP tool output.
// 2026-09-06: the remote LOGIN shell on oci-apps is fish, which rejects
// `$(...)` ("command substitutions not allowed here") and other POSIX/bash
// syntax the 120+ call sites in this tree were written in. profile's
// container_status had been failing on exactly that for two days while the
// error read as a docker problem. Run every command under `bash -c` with a
// single-quoted body so the login shell only ever sees one opaque argument;
// bash is present on every VM (the login shell is merely fish).
// 2026-10-10: the body is now quoted so fish AND POSIX read it identically —
// the plain '\'' form broke under fish once the command itself held a quote
// (see shell-quote.ts).
export { remoteShellWrap, vmMeshAddress };

export function sshExec(
  vmNameOrAlias: string,
  command: string,
  timeout?: number,
  _noRetry = false,
  connectTimeout = 10,
): ExecResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const sshArgs = sshArgv(alias, remoteShellWrap(command), connectTimeout);
  const effectiveTimeout = timeout ?? 30_000;

  const result = exec("ssh", sshArgs, { timeout: effectiveTimeout });

  audit("ssh", `${alias}: "${command.slice(0, 120)}"`, `exit ${result.exitCode}`);
  return result;
}

export async function sshExecAsync(
  vmNameOrAlias: string,
  command: string,
  timeout?: number,
  _noRetry = false,
  connectTimeout = 10,
): Promise<ExecResult> {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const sshArgs = sshArgv(alias, remoteShellWrap(command), connectTimeout);
  const effectiveTimeout = timeout ?? 30_000;

  const result = await execAsync("ssh", sshArgs, { timeout: effectiveTimeout });

  audit("ssh", `${alias}: "${command.slice(0, 120)}"`, `exit ${result.exitCode}`);
  return result;
}

export function checkVmReachable(vmNameOrAlias: string): ExecResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  // Same alias, options and wrapper as sshExec (mesh path via ~/.ssh/config).
  const result = exec("ssh", sshArgv(alias, remoteShellWrap("echo ok"), 10), { timeout: 15_000 });
  audit("ssh", `${alias}: reachability`, `exit ${result.exitCode}`);
  return result;
}
