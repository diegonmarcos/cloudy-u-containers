/**
 * VM / Container / Service lifecycle control.
 *
 * Replaces the Rust API's ondemand.rs — drives everything through CLI tools
 * (gcloud, oci) and SSH/Docker directly.
 */

import { sshExec, checkVmReachable } from "./ssh.js";
import { getConfig, resolveVmId, getVmSshAlias, composeCd } from "./config.js";
import { exec } from "./exec.js";
import { audit } from "./audit.js";
import { controlContainer } from "./docker.js";
// Used to resolve an OCI instance OCID from its display name — the VM config
// carries no OCID, which is why OCI power actions previously bailed out.
import { listInstances } from "./cloud/oci.js";
import { validateContainerName, validatePathComponent } from "./validators.js";

// ─── Result type ────────────────────────────────────────────────────────────

export interface ControlResult {
  ok: boolean;
  message: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureVmReachable(vmId: string): ControlResult | null {
  const check = checkVmReachable(vmId);
  if (!check.ok) {
    return {
      ok: false,
      message: `VM ${getVmSshAlias(vmId)} (${vmId}) is not reachable via SSH.`,
    };
  }
  return null;
}

/**
 * Resolve an OCI instance OCID from its display name.
 *
 * The VM config carries no instance OCID (only gcloud_instance/gcloud_zone for
 * GCP), which is why vmStart/vmReset used to give up on OCI VMs and print an
 * `oci compute instance action ... --instance-id <OCID>` string for a human to
 * run. The OCID is discoverable: `oci compute instance list` returns
 * display-name alongside id, and listInstances() already wraps that with
 * compartment resolution. Looking it up here turns those dead-ends into real
 * out-of-band control.
 *
 * Matches on display-name == alias first, then == vmId, so it works whether the
 * console name follows the SSH alias or the internal id.
 */
function resolveOciInstanceId(vmId: string, alias: string): { ok: boolean; id?: string; error?: string } {
  const listed = listInstances();
  if (!listed.ok) return { ok: false, error: listed.error ?? "oci compute instance list failed" };
  const match =
    listed.instances.find((i) => i.name === alias) ??
    listed.instances.find((i) => i.name === vmId);
  if (!match?.id) {
    const names = listed.instances.map((i) => i.name).join(", ") || "(none)";
    return { ok: false, error: `no OCI instance named "${alias}" or "${vmId}". Found: ${names}` };
  }
  return { ok: true, id: match.id };
}

/**
 * OCI instance power action that does NOT require SSH.
 *
 * WHY THIS EXISTS: the previous OCI branches called checkVmReachable() first
 * and refused to act when it failed. That is exactly backwards — you need a
 * reset PRECISELY when the box is unreachable. A VM that still answers SSH can
 * be rebooted with `sudo reboot`; one that is wedged cannot, and that was the
 * only case where the tool mattered. Proven on 2026-08-12: gcp-proxy wedged
 * (RUNNING at the hypervisor, no SSH / no WireGuard / no ICMP) and every
 * in-band path was gone, so recovery required a human on the cloud console.
 * OCI VMs had the same hole with no way out at all.
 *
 * ACTION semantics (OCI): SOFTRESET/SOFTSTOP ask the guest OS politely and so
 * need a responsive guest; RESET/STOP are hypervisor-level power operations
 * and work on a hung instance. Use the hard variants here — a soft action on a
 * wedged VM just times out, which is the failure mode being fixed.
 */
function ociInstanceAction(
  vmId: string,
  alias: string,
  action: "START" | "RESET" | "STOP",
  auditKey: string,
): ControlResult {
  const resolved = resolveOciInstanceId(vmId, alias);
  if (!resolved.ok) {
    audit(auditKey, `${alias} (oci)`, `OCID_LOOKUP_FAILED`);
    return {
      ok: false,
      message:
        `OCI VM ${alias}: could not resolve instance OCID — ${resolved.error}. ` +
        `Run manually: oci compute instance action --action ${action} --instance-id <OCID>`,
    };
  }
  const result = exec("oci", [
    "compute", "instance", "action",
    "--action", action,
    "--instance-id", resolved.id!,
    "--output", "json",
  ], { timeout: 60_000 });
  audit(auditKey, `${alias} (oci/api)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
  if (!result.ok) {
    return {
      ok: false,
      message: `Failed to ${action} OCI VM ${alias}: ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  return { ok: true, message: `OCI VM ${alias}: ${action} initiated (out-of-band, no SSH required).` };
}

/**
 * Serial console output — the one diagnostic that survives a wedged VM.
 *
 * MISSING UNTIL 2026-08-12, and its absence was felt: when gcp-proxy hung
 * during a deploy there was no way to see whether it had OOM'd, panicked, or
 * was simply mid-boot. SSH, mesh DNS and even the gcloud MCP proxy all route
 * through the fleet, so once the hub died every observability path died with
 * it. Serial console is read straight from the cloud provider's control plane
 * and therefore keeps working when the guest is completely unresponsive — it
 * is the only tool here that answers "why did it die?" rather than "is it
 * dead?".
 *
 * DELIBERATELY DOES NOT CALL checkVmReachable(). Gating this on SSH would make
 * it useless in the only situation it is for.
 */
export function vmSerialConsole(vmNameOrAlias: string, lines = 200): ControlResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const vm = config.vms[vmId];
  const alias = getVmSshAlias(vmId);
  const tail = (text: string): string => {
    const all = text.split("\n");
    return all.length > lines ? all.slice(-lines).join("\n") : text;
  };

  if (vm.method === "gcloud") {
    if (!vm.gcloud_instance || !vm.gcloud_zone) {
      return {
        ok: false,
        message: `GCP VM ${alias} (${vmId}) missing gcloud_instance or gcloud_zone in config.`,
      };
    }
    const result = exec("gcloud", [
      "compute", "instances", "get-serial-port-output",
      vm.gcloud_instance, "--zone", vm.gcloud_zone,
    ], { timeout: 60_000 });
    audit("vm_serial_console", `${alias} (gcloud)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
    if (!result.ok) {
      return {
        ok: false,
        message: `Failed to read serial console for ${alias}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, message: `Serial console for ${alias} (last ${lines} lines):\n\n${tail(result.stdout)}` };
  }

  // OCI: console history is a two-step capture-then-read, unlike GCP's single
  // read. Capture snapshots the current buffer into a resource, which is then
  // fetched by its own OCID.
  const resolved = resolveOciInstanceId(vmId, alias);
  if (!resolved.ok) {
    audit("vm_serial_console", `${alias} (oci)`, "OCID_LOOKUP_FAILED");
    return { ok: false, message: `OCI VM ${alias}: ${resolved.error}` };
  }
  const capture = exec("oci", [
    "compute", "console-history", "capture",
    "--instance-id", resolved.id!,
    "--output", "json",
  ], { timeout: 60_000 });
  if (!capture.ok) {
    audit("vm_serial_console", `${alias} (oci)`, "CAPTURE_FAILED");
    return { ok: false, message: `Failed to capture console history for ${alias}: ${capture.stderr.trim()}` };
  }
  let historyId = "";
  try {
    historyId = String((JSON.parse(capture.stdout) as { data?: { id?: string } })?.data?.id ?? "");
  } catch { /* fall through to the empty-id check */ }
  if (!historyId) {
    return { ok: false, message: `OCI VM ${alias}: console-history capture returned no id.` };
  }
  const content = exec("oci", [
    "compute", "console-history", "get-content",
    "--instance-console-history-id", historyId,
    "--file", "-",
  ], { timeout: 60_000 });
  audit("vm_serial_console", `${alias} (oci)`, content.ok ? "OK" : "GET_CONTENT_FAILED");
  if (!content.ok) {
    return { ok: false, message: `Failed to read console history for ${alias}: ${content.stderr.trim()}` };
  }
  return { ok: true, message: `Serial console for ${alias} (last ${lines} lines):\n\n${tail(content.stdout)}` };
}

// ─── VM lifecycle ───────────────────────────────────────────────────────────

export function vmStart(vmNameOrAlias: string): ControlResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const vm = config.vms[vmId];
  const alias = getVmSshAlias(vmId);

  if (vm.method === "gcloud") {
    if (!vm.gcloud_instance || !vm.gcloud_zone) {
      return {
        ok: false,
        message: `GCP VM ${alias} (${vmId}) missing gcloud_instance or gcloud_zone in config.`,
      };
    }
    const result = exec("gcloud", [
      "compute", "instances", "start",
      vm.gcloud_instance, "--zone", vm.gcloud_zone, "--format=json",
    ]);
    audit("vm_start", `${alias} (gcloud)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
    if (!result.ok) {
      return {
        ok: false,
        message: `Failed to start GCP VM ${alias}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, message: `GCP VM ${alias} start initiated.` };
  }

  // OCI VMs — no instance OCID in config, so we cannot use `oci compute instance action`.
  // Attempt SSH to check if already running; otherwise advise manual start.
  const reachable = checkVmReachable(vmId);
  if (reachable.ok) {
    audit("vm_start", `${alias} (oci)`, "ALREADY_RUNNING");
    return { ok: true, message: `OCI VM ${alias} is already running.` };
  }

  // Not reachable — it may be genuinely STOPPED rather than merely unhealthy,
  // which SSH alone cannot distinguish. Issue a real START through the control
  // plane instead of asking the operator to do it by hand. START on an
  // already-running instance is rejected by OCI, so this cannot disturb a VM
  // that is up but simply not answering SSH.
  audit("vm_start", `${alias} (oci)`, "UNREACHABLE — issuing control-plane START");
  return ociInstanceAction(vmId, alias, "START", "vm_start");
}

export function vmStop(vmNameOrAlias: string): ControlResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const vm = config.vms[vmId];
  const alias = getVmSshAlias(vmId);

  if (vm.method === "gcloud") {
    if (!vm.gcloud_instance || !vm.gcloud_zone) {
      return {
        ok: false,
        message: `GCP VM ${alias} (${vmId}) missing gcloud_instance or gcloud_zone in config.`,
      };
    }
    const result = exec("gcloud", [
      "compute", "instances", "stop",
      vm.gcloud_instance, "--zone", vm.gcloud_zone, "--format=json",
    ]);
    audit("vm_stop", `${alias} (gcloud)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
    if (!result.ok) {
      return {
        ok: false,
        message: `Failed to stop GCP VM ${alias}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, message: `GCP VM ${alias} stop initiated.` };
  }

  // OCI VMs — graceful shutdown via SSH
  const reachable = checkVmReachable(vmId);
  if (!reachable.ok) {
    audit("vm_stop", `${alias} (oci)`, "ALREADY_STOPPED");
    return { ok: true, message: `OCI VM ${alias} appears to be already stopped (unreachable).` };
  }

  const result = sshExec(vmId, "sudo shutdown -h now", 15_000);
  audit("vm_stop", `${alias} (oci/ssh)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);

  // shutdown command often returns non-zero because the connection drops
  return { ok: true, message: `OCI VM ${alias} shutdown command sent.` };
}

export function vmReset(vmNameOrAlias: string): ControlResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const vm = config.vms[vmId];
  const alias = getVmSshAlias(vmId);

  if (vm.method === "gcloud") {
    if (!vm.gcloud_instance || !vm.gcloud_zone) {
      return {
        ok: false,
        message: `GCP VM ${alias} (${vmId}) missing gcloud_instance or gcloud_zone in config.`,
      };
    }
    const result = exec("gcloud", [
      "compute", "instances", "reset",
      vm.gcloud_instance, "--zone", vm.gcloud_zone, "--format=json",
    ]);
    audit("vm_reset", `${alias} (gcloud)`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
    if (!result.ok) {
      return {
        ok: false,
        message: `Failed to reset GCP VM ${alias}: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }
    return { ok: true, message: `GCP VM ${alias} reset initiated.` };
  }

  // OCI VMs. Prefer a graceful in-guest reboot when the VM still answers SSH —
  // it lets services shut down cleanly. When it does NOT answer, fall through
  // to a hypervisor-level RESET rather than giving up.
  //
  // This used to return an error telling the operator to run
  // `oci compute instance action --action RESET --instance-id <OCID>` by hand,
  // which meant the tool refused to work in the only situation a reset is for:
  // a wedged, unreachable VM. See ociInstanceAction() for the full rationale.
  const reachable = checkVmReachable(vmId);
  if (reachable.ok) {
    sshExec(vmId, "sudo reboot", 15_000);
    audit("vm_reset", `${alias} (oci/ssh)`, "SENT");
    // `reboot` drops the connection, so a non-zero exit is expected here.
    return { ok: true, message: `OCI VM ${alias} reboot command sent (graceful, via SSH).` };
  }

  audit("vm_reset", `${alias} (oci)`, "UNREACHABLE — escalating to hypervisor RESET");
  return ociInstanceAction(vmId, alias, "RESET", "vm_reset");
}

// ─── Container lifecycle ────────────────────────────────────────────────────

export function containerStart(
  vmNameOrAlias: string,
  containerName: string,
): ControlResult {
  validateContainerName(containerName);
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("container_start", `${containerName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const { ok, output } = controlContainer(vmId, containerName, "start");
  audit("container_start", `${containerName}@${alias}`, ok ? "OK" : "FAILED");
  return {
    ok,
    message: ok
      ? `Container ${containerName} started on ${alias}.`
      : `Failed to start ${containerName} on ${alias}: ${output.trim()}`,
  };
}

export function containerStop(
  vmNameOrAlias: string,
  containerName: string,
): ControlResult {
  validateContainerName(containerName);
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("container_stop", `${containerName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const { ok, output } = controlContainer(vmId, containerName, "stop");
  audit("container_stop", `${containerName}@${alias}`, ok ? "OK" : "FAILED");
  return {
    ok,
    message: ok
      ? `Container ${containerName} stopped on ${alias}.`
      : `Failed to stop ${containerName} on ${alias}: ${output.trim()}`,
  };
}

export function containerRestart(
  vmNameOrAlias: string,
  containerName: string,
): ControlResult {
  validateContainerName(containerName);
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("container_restart", `${containerName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const { ok, output } = controlContainer(vmId, containerName, "restart");
  audit("container_restart", `${containerName}@${alias}`, ok ? "OK" : "FAILED");
  return {
    ok,
    message: ok
      ? `Container ${containerName} restarted on ${alias}.`
      : `Failed to restart ${containerName} on ${alias}: ${output.trim()}`,
  };
}

// ─── Service lifecycle ──────────────────────────────────────────────────────

export function serviceStart(
  vmNameOrAlias: string,
  serviceName: string,
): ControlResult {
  validatePathComponent(serviceName);
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("service_start", `${serviceName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const remotePath = `${config.remote_base}/${serviceName}`;
  const result = sshExec(vmId, `${composeCd(remotePath)} && docker compose $COMPOSE_ARGS up -d`, 60_000);

  audit(
    "service_start",
    `${serviceName}@${alias}`,
    result.ok ? "OK" : `FAILED (exit ${result.exitCode})`,
  );

  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    ok: result.ok,
    message: result.ok
      ? `Service ${serviceName} started on ${alias}.\n${output}`
      : `Failed to start service ${serviceName} on ${alias}: ${output}`,
  };
}

export function serviceStop(
  vmNameOrAlias: string,
  serviceName: string,
): ControlResult {
  validatePathComponent(serviceName);
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("service_stop", `${serviceName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const remotePath = `${config.remote_base}/${serviceName}`;
  const result = sshExec(vmId, `${composeCd(remotePath)} && docker compose $COMPOSE_ARGS down`, 60_000);

  audit(
    "service_stop",
    `${serviceName}@${alias}`,
    result.ok ? "OK" : `FAILED (exit ${result.exitCode})`,
  );

  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    ok: result.ok,
    message: result.ok
      ? `Service ${serviceName} stopped on ${alias}.\n${output}`
      : `Failed to stop service ${serviceName} on ${alias}: ${output}`,
  };
}

// ─── Service restart ────────────────────────────────────────────────────

export function serviceRestart(
  vmNameOrAlias: string,
  serviceName: string,
): ControlResult {
  validatePathComponent(serviceName);
  const vmId = resolveVmId(vmNameOrAlias);
  const config = getConfig();
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("service_restart", `${serviceName}@${alias}`, "VM_UNREACHABLE");
    return unreachable;
  }

  const remotePath = `${config.remote_base}/${serviceName}`;
  const result = sshExec(vmId, `${composeCd(remotePath)} && docker compose $COMPOSE_ARGS down && docker compose $COMPOSE_ARGS up -d`, 90_000);

  audit(
    "service_restart",
    `${serviceName}@${alias}`,
    result.ok ? "OK" : `FAILED (exit ${result.exitCode})`,
  );

  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    ok: result.ok,
    message: result.ok
      ? `Service ${serviceName} restarted on ${alias}.\n${output}`
      : `Failed to restart service ${serviceName} on ${alias}: ${output}`,
  };
}

// ─── VM drain ───────────────────────────────────────────────────────────

export function vmDrain(vmNameOrAlias: string): ControlResult {
  const vmId = resolveVmId(vmNameOrAlias);
  const alias = getVmSshAlias(vmId);

  const unreachable = ensureVmReachable(vmId);
  if (unreachable) {
    audit("vm_drain", alias, "VM_UNREACHABLE");
    return unreachable;
  }

  const result = sshExec(vmId, "docker ps -q | xargs -r docker stop", 120_000);

  audit(
    "vm_drain",
    alias,
    result.ok ? "OK" : `FAILED (exit ${result.exitCode})`,
  );

  const output = `${result.stdout}${result.stderr}`.trim();
  return {
    ok: result.ok,
    message: result.ok
      ? `All containers stopped on ${alias}.\n${output}`
      : `Failed to drain ${alias}: ${output}`,
  };
}
