// ── Ops: push events and DAG triggers ──

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { audit } from "./audit.js";
import { syncRepos, getConfigPath } from "./paths.js";
import { execAsync } from "./async-exec.js";

// Resolve Dagu API from cloud-data topology (env override available)
function resolveDaguApi(): string {
  if (process.env.DAGU_API) return process.env.DAGU_API;
  try {
    const { readFileSync } = require("fs");
    const { getConfigPath } = require("./paths.js");
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    const svc = topo.services?.dagu;
    const vm = svc?.vm ? topo.vms?.[svc.vm] : null;
    if (vm?.wg_ip && svc?.port) return `http://${vm.wg_ip}:${svc.port}`;
  } catch {}
  // Dagu runs on oci-apps 10.0.0.6:8070 (not 10.0.0.3 — that's oci-mail).
  return "http://10.0.0.6:8070";
}

// Resolve the Dagu REST API base path from cloud-data (services.dagu.api.base_path).
// Data-driven: the deployed dagu image serves its API at /api/v1 — hardcoding /api/v2
// silently hit the SPA (HTTP 200 HTML), so triggers reported success but did nothing.
function resolveDaguApiPath(): string {
  if (process.env.DAGU_API_PATH) return process.env.DAGU_API_PATH;
  try {
    const { readFileSync } = require("fs");
    const { getConfigPath } = require("./paths.js");
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    const bp = topo.services?.dagu?.api?.base_path;
    if (typeof bp === "string" && bp.startsWith("/")) return bp;
  } catch {}
  return "/api/v1";
}
const DAGU_API = resolveDaguApi();
const DAGU_API_PATH = resolveDaguApiPath();
const DAGU_USER = process.env.DAGU_USERNAME ?? "";
const DAGU_PASS = process.env.DAGU_PASSWORD ?? "";

// Store last push event for Dagu jobs to read
const EVENTS_DIR = "/tmp/c3-events";
try { mkdirSync(EVENTS_DIR, { recursive: true }); } catch {}

export interface PushEvent {
  ref?: string;
  repo?: string;
  sender?: string;
  head_commit?: { id: string; message: string; timestamp: string };
  commits?: Array<{ id: string; message: string; added: string[]; modified: string[]; removed: string[] }>;
  modified_files?: string[];
}

export interface PushEventResult {
  ok: boolean;
  message: string;
  dagu_triggered: boolean;
  dagu_error?: string;
  event_id: string;
}

export async function handlePushEvent(event: PushEvent): Promise<PushEventResult> {
  const eventId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

  // Persist event for Dagu/other consumers
  const eventPath = join(EVENTS_DIR, "last-push.json");
  const latestPath = join(EVENTS_DIR, `push-${eventId}.json`);
  const payload = { ...event, event_id: eventId, received_at: new Date().toISOString() };
  writeFileSync(eventPath, JSON.stringify(payload, null, 2));
  writeFileSync(latestPath, JSON.stringify(payload, null, 2));

  // Aggregate modified files from commits if not provided directly
  const modified = event.modified_files ?? extractModifiedFiles(event);

  audit("ops/push-event", event.repo ?? "cloud", `${modified.length} files, event=${eventId}`, "gha");

  // Force-sync local repos so topology/configs reflect the new push
  syncRepos(true);

  // Trigger Dagu cloud-data-sync DAG
  let daguTriggered = false;
  let daguError: string | undefined;

  try {
    const resp = await triggerDag("cloud-data-sync");
    daguTriggered = resp.ok;
    if (!resp.ok) daguError = resp.error;
  } catch (e: unknown) {
    daguError = e instanceof Error ? e.message : String(e);
  }

  const msg = daguTriggered
    ? `Push event received (${modified.length} files). Dagu cloud-data-sync triggered.`
    : `Push event received (${modified.length} files). Dagu trigger failed: ${daguError}`;

  return { ok: true, message: msg, dagu_triggered: daguTriggered, dagu_error: daguError, event_id: eventId };
}

function extractModifiedFiles(event: PushEvent): string[] {
  if (!event.commits?.length) return [];
  const files = new Set<string>();
  for (const c of event.commits) {
    for (const f of c.added ?? []) files.add(f);
    for (const f of c.modified ?? []) files.add(f);
    for (const f of c.removed ?? []) files.add(f);
  }
  return [...files];
}

/** Auth headers for Dagu API (basic auth from env) */
export function daguHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (DAGU_USER && DAGU_PASS) {
    h["Authorization"] = "Basic " + Buffer.from(`${DAGU_USER}:${DAGU_PASS}`).toString("base64");
  }
  return h;
}

/** Dagu API base URL */
export { DAGU_API, DAGU_API_PATH };

async function triggerDag(name: string): Promise<{ ok: boolean; dagRunId?: string; error?: string }> {
  // Try REST API first (Dagu <2.5). Path is data-driven (services.dagu.api.base_path).
  const url = `${DAGU_API}${DAGU_API_PATH}/dags/${name}/start`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...daguHeaders() },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });

    if (resp.ok) {
      const data = await resp.json().catch(() => ({})) as { dagRunId?: string };
      return { ok: true, dagRunId: data.dagRunId };
    }

    // If 405 Method Not Allowed — Dagu 2.5+ doesn't support POST trigger via REST
    // Fall back to SSH + docker exec
    if (resp.status === 405 || resp.status === 401) {
      return triggerDagViaSsh(name);
    }

    const body = await resp.text().catch(() => "");
    return { ok: false, error: `HTTP ${resp.status}: ${body}` };
  } catch (e) {
    // Network error — try SSH fallback
    return triggerDagViaSsh(name);
  }
}

async function triggerDagViaSsh(name: string): Promise<{ ok: boolean; dagRunId?: string; error?: string }> {
  // Resolve Dagu VM from topology (default: oci-analytics)
  //
  // 2026-09-04: this function could never run. It called a bare `execAsync`
  // that was never imported (ReferenceError the moment the HTTP path fell
  // through to it) AND passed (string, number) to a (command, args[],
  // options) signature. It also used require() inside an ESM module
  // ("type": "module"), which throws — silently swallowed by the catch, so
  // the topology lookup was dead code and the default alias always won.
  let sshAlias = "oci-analytics";
  try {
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    const svc = topo.services?.dagu;
    if (svc?.vm) {
      const vm = topo.vms?.[svc.vm];
      if (vm?.ssh_alias) sshAlias = vm.ssh_alias;
    }
  } catch { /* fall back to the default alias */ }

  const r = await execAsync("ssh", [
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    sshAlias,
    `docker exec dagu dagu start ${name}`,
  ], { timeout: 30_000 });
  if (r.ok) {
    return { ok: true };
  }
  return { ok: false, error: `SSH trigger failed: ${(r.stderr || r.stdout || "").trim() || "no output"}` };
}
