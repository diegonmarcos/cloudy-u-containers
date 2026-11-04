/**
 * Push notifications via ntfy (rss.diegonmarcos.com).
 *
 * Used by the scheduler to alert on health failures,
 * and available as an on-demand tool.
 */

import { exec } from "./exec.js";

// Resolve ntfy URL from cloud-data topology (env override available)
function resolveNtfyUrl(): string {
  if (process.env.NTFY_URL) return process.env.NTFY_URL;
  try {
    const { getConfig } = require("./config.js");
    const config = getConfig();
    const svc = config.services?.ntfy;
    if (svc?.domain) return `https://${svc.domain.split("/")[0]}/infra`;
  } catch {}
  return "https://rss.diegonmarcos.com/infra";
}
const NTFY_URL = resolveNtfyUrl();

export type Priority = "min" | "low" | "default" | "high" | "urgent";

export interface NotifyOptions {
  title: string;
  message: string;
  priority?: Priority;
  tags?: string[];
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
}

export function sendNotification(opts: NotifyOptions): NotifyResult {
  const args = [
    "-s", "-S",
    "-X", "POST",
    "-H", `Title: ${opts.title}`,
    "-H", `Priority: ${opts.priority ?? "default"}`,
  ];

  if (opts.tags && opts.tags.length > 0) {
    args.push("-H", `Tags: ${opts.tags.join(",")}`);
  }

  args.push("-d", opts.message, NTFY_URL);

  const result = exec("curl", args, { timeout: 15_000 });

  if (!result.ok) {
    return { ok: false, error: result.stderr.trim() || `exit ${result.exitCode}` };
  }

  return { ok: true };
}

/**
 * Convenience: send a health alert.
 */
export function alertHealthDown(vm: string, details: string): NotifyResult {
  return sendNotification({
    title: `VM DOWN: ${vm}`,
    message: details,
    priority: "high",
    tags: ["rotating_light", "cloud"],
  });
}

export function alertHealthRecovered(vm: string): NotifyResult {
  return sendNotification({
    title: `VM RECOVERED: ${vm}`,
    message: `${vm} is reachable again.`,
    priority: "default",
    tags: ["white_check_mark", "cloud"],
  });
}

export function alertCertExpiring(domain: string, daysLeft: number): NotifyResult {
  return sendNotification({
    title: `CERT EXPIRING: ${domain}`,
    message: `TLS certificate for ${domain} expires in ${daysLeft} days.`,
    priority: daysLeft <= 3 ? "urgent" : "high",
    tags: ["lock", "warning"],
  });
}

export function alertDiskFull(vm: string, percent: string): NotifyResult {
  return sendNotification({
    title: `DISK FULL: ${vm}`,
    message: `Disk usage at ${percent} on ${vm}.`,
    priority: "high",
    tags: ["floppy_disk", "warning"],
  });
}
