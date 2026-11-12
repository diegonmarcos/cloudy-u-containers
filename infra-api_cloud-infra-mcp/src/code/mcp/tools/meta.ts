// ══════════════════════════════════════════════════════════════════════════════
// meta.ts — 4 grouped meta-tools replacing 105 individual tools
//
// infra.devops  → devops.build.* / docker.* / ssh.* / vm.* / container.* /
//                 service.* / front.* / workflows.*
// infra.obs     → obs.debug.*  (docker_logs, vps_*, profiles, vm diags, db)
// infra.finops  → obs.finops.* / obs.health.* / obs.notify.* / obs.db.*
// infra.sec     → sec.*
// ══════════════════════════════════════════════════════════════════════════════

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── shared libs (delivery) ──────────────────────────────────────────────────
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { exec, execAsync } from "../../shared/libs/exec.js";
import { sshExec, sshExecAsync, checkVmReachable, vmMeshAddress } from "../../shared/libs/ssh.js";
import { getConfig, getServiceDir, getServiceFolder, resolveVmId, getVmSshAlias, composeCd } from "../../shared/libs/config.js";
import { BUILD_SCRIPT, SOLUTIONS_DIR, FRONT_DIR, CLOUD_DATA_DIR, resolveCloudDataPath, getConsolidatedPath } from "../../shared/libs/paths.js";
import { audit } from "../../shared/libs/audit.js";
import {
  containerTop, containerDiff, containerInspectFull, containerEvents,
  containerPause, containerUnpause, containerExecCmd, caddyCertRepair,
  logsSearch, logsMulti, dockerSystemDf, composeUpAll,
} from "../../shared/libs/docker.js";
import {
  vmStart, vmStop, vmReset, vmDrain,
  containerStart, containerStop, containerRestart,
  serviceStart, serviceStop, serviceRestart,
} from "../../shared/libs/control.js";
import { DAGU_API, DAGU_API_PATH, daguHeaders } from "../../shared/libs/ops.js";

// ── shared libs (obs) ───────────────────────────────────────────────────────
import {
  healthAlive, healthDeclared, healthDeployed, healthDrift, healthStatus,
  checkTier1All, checkTier2All, checkTier3All, healthEndpoints, metricsSnapshot,
} from "../../shared/libs/health.js";
import {
  profileContainer, profileVm, profileService,
  vmNetwork, vmTop, vmDiskUsage, vmJournal,
} from "../../shared/libs/diagnostics.js";
import { runTestSuite } from "../../shared/libs/tests.js";
import { getVmStatus, getReport, getSecretsStatus } from "../../shared/libs/files.js";
import {
  getHealthHistory, getUptimeReport, getAuditLog, getDeployHistory,
  getAlertState, updateAlertState, pruneOldRecords,
} from "../../shared/libs/db.js";

// ── shared libs (finops cloud) ──────────────────────────────────────────────
import * as oci from "../../shared/libs/cloud/oci.js";
import * as gcp from "../../shared/libs/cloud/gcp.js";
import * as aws from "../../shared/libs/cloud/aws.js";

// ── shared libs (notify) ───────────────────────────────────────────────────
import {
  sendNotification, alertHealthDown, alertHealthRecovered,
  alertCertExpiring, alertDiskFull,
} from "../../shared/libs/notify.js";

// ── shared libs (security) ─────────────────────────────────────────────────
import { securityScan, securityDocker, securitySshKeys, securityTokens } from "../../shared/libs/security.js";
import { getConfigPath } from "../../shared/libs/paths.js";
import { handleSteelZap } from "./security-testing.js";
import { handleBacklog } from "./backlog.js";

// ── shared libs (health cloud/mail via SSH+Docker) ─────────────────────────
const REPORT_VM = "oci-analytics";
const REPORT_IMAGE = "ghcr.io/diegonmarcos/cloud-data-reports:latest";
const REPORTS_WORKDIR = "/var/lib/dagu/data/cloud-data/reports";
const SSH_KEYS_MOUNT = "/opt/ssh-keys/dagu:/root/.ssh:ro";
const DAGU_VOLUME = "dagu_data:/var/lib/dagu/data";
const FRESH_CLOUD_TIMEOUT = 300_000;
const FRESH_MAIL_TIMEOUT = 180_000;
const READ_ONLY_TIMEOUT = 15_000;

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
const SAFE_SINCE_RE = /^\d+[smhd]$|^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/;

function validateContainerName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) throw new Error(`Invalid container name: ${name}`);
}
function validateSince(since: string): void {
  if (!SAFE_SINCE_RE.test(since)) throw new Error(`Invalid since format: ${since}`);
}
function validatePath(path: string): void {
  if (!SAFE_NAME_RE.test(path)) throw new Error(`Invalid path component: ${path}`);
}
function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
function errText(t: string) { return { content: [{ type: "text" as const, text: t }], isError: true as const }; }
function jsonText(label: string, data: unknown) {
  const t = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text(`${label}\n\n${t}`);
}
function formatControl(result: { ok: boolean; message: string }) {
  return { content: [{ type: "text" as const, text: result.message }], isError: !result.ok };
}

// ── Report helpers (health_cloud + health_mail) ────────────────────────────

async function triggerAndReadFile(target: string, outFile: string, timeoutMs: number): Promise<string> {
  const inner = `bash build.sh ${target} 1>&2 && cat dist/${outFile}`;
  const cmd = [
    "docker", "run", "--rm", "--network", "host",
    "-v", DAGU_VOLUME, "-v", SSH_KEYS_MOUNT,
    "-w", REPORTS_WORKDIR, "--entrypoint", "sh",
    REPORT_IMAGE, "-c", `'${inner.replace(/'/g, "'\\''")}'`,
  ].join(" ");
  const res = await sshExecAsync(REPORT_VM, cmd, timeoutMs);
  if (res.exitCode !== 0)
    throw new Error(`Report "${target}" failed (exit ${res.exitCode}): ${(res.stderr || "").slice(0, 400)}`);
  return res.stdout || "";
}

async function readCachedFile(outFile: string): Promise<string> {
  const inner = `cat /data/cloud-data/reports/dist/${outFile} 2>/dev/null || echo '__MISSING__'`;
  const cmd = [
    "docker", "run", "--rm", "-v", "dagu_data:/data:ro",
    "--entrypoint", "sh", "alpine:3.19", "-c", `'${inner.replace(/'/g, "'\\''")}'`,
  ].join(" ");
  const res = await sshExecAsync(REPORT_VM, cmd, READ_ONLY_TIMEOUT);
  return (res.stdout || "").replace(/__MISSING__\s*$/, "");
}

function extractCloudSection(md: string, startMarker: string, endMarker?: string): string {
  const start = md.indexOf(startMarker);
  if (start < 0) return "";
  const tail = md.slice(start);
  if (!endMarker) return tail;
  const end = tail.indexOf(endMarker, startMarker.length);
  return end < 0 ? tail : tail.slice(0, end);
}

function extractMailSection(md: string, heading: string): string {
  const lines = md.split("\n");
  const startRegex = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  let i = lines.findIndex((l) => startRegex.test(l));
  if (i < 0) return "";
  const out: string[] = [lines[i]];
  for (let j = i + 1; j < lines.length; j++) {
    if (/^##\s+/.test(lines[j])) break;
    out.push(lines[j]);
  }
  return out.join("\n");
}

async function safeAsync(fn: () => Promise<string>) {
  try { return text(await fn()); }
  catch (e) { return text(`ERROR: ${e instanceof Error ? e.message : String(e)}`); }
}

// ── Workflows helpers ──────────────────────────────────────────────────────

function resolveGhRepo(): string {
  try {
    const config = getConfig();
    // 2026-09-04: was `${owner}/cloud` — the pre-rename name, which still
    // resolves to a stale repo, so gh queries silently hit the wrong one.
    return `${(config as any).owner?.github ?? "diegonmarcos"}/cloud-infra`;
  } catch {}
  return "diegonmarcos/cloudy-t-infra";
}
const GH_REPO = resolveGhRepo();

async function gh(args: string[], timeout = 15_000) {
  const r = await execAsync("gh", args, { timeout });
  return { ok: r.ok, stdout: r.stdout, stderr: r.stderr };
}

async function daguFetch(path: string, method = "GET", body?: string) {
  try {
    const resp = await fetch(`${DAGU_API}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...daguHeaders() },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const t = await resp.text();
    if (!resp.ok) return { ok: false, data: null, error: `HTTP ${resp.status}: ${t.slice(0, 200)}` };
    if (!t) return { ok: false, data: null, error: "empty response body" };
    try { return { ok: true, data: JSON.parse(t) }; }
    catch { return { ok: false, data: null, error: `non-JSON: ${t.slice(0, 200)}` }; }
  } catch (e) {
    return { ok: false, data: null, error: `${e instanceof Error ? e.message : String(e)}` };
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] || "").length)));
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const fmtRow = (r: string[]) => r.map((c, i) => ` ${(c || "").padEnd(widths[i])} `).join("│");
  return [fmtRow(headers), sep, ...rows.map(fmtRow)].join("\n");
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface GhaRun {
  name: string; workflowName: string; status: string; conclusion: string;
  updatedAt: string; headBranch: string; databaseId: number; url?: string; event?: string;
}
interface DaguDag {
  name: string; statusText?: string; startedAt?: string; finishedAt?: string; schedule?: string;
}

function mapV2Entry(d: any): DaguDag {
  return {
    name: d.dag?.name ?? d.fileName ?? d.name ?? "?",
    statusText: d.latestDAGRun?.statusLabel ?? d.latestRun?.statusLabel ?? d.status?.statusLabel,
    startedAt: d.latestDAGRun?.startedAt ?? d.latestRun?.startedAt ?? d.status?.startedAt,
    finishedAt: d.latestDAGRun?.finishedAt ?? d.latestRun?.finishedAt ?? d.status?.finishedAt,
    schedule: Array.isArray(d.dag?.schedule) ? d.dag.schedule.map((s: any) => s.expression ?? s).join(", ") : undefined,
  };
}
function mapV1Entry(d: any): DaguDag {
  return {
    name: d.DAG?.Name ?? d.Name ?? "?",
    statusText: d.Status?.StatusText,
    startedAt: d.Status?.StartedAt,
    finishedAt: d.Status?.FinishedAt,
    schedule: d.DAG?.Schedule,
  };
}

async function ghaRuns24h(filter?: string): Promise<{ runs: GhaRun[]; error?: string }> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const args = ["run", "list", "--repo", GH_REPO, "--limit", "100",
    "--json", "name,workflowName,status,conclusion,updatedAt,headBranch,databaseId,url,event"];
  if (filter) args.push("--status", filter);
  const r = await gh(args, 20_000);
  if (!r.ok) return { runs: [], error: r.stderr.trim() };
  try {
    const all: GhaRun[] = JSON.parse(r.stdout);
    return { runs: all.filter((run) => run.updatedAt >= cutoff) };
  } catch { return { runs: [], error: "JSON parse failed" }; }
}

async function ghaWorkflows() {
  const r = await gh(["workflow", "list", "--repo", GH_REPO, "--json", "id,name,state", "--all"], 10_000);
  if (!r.ok) return [] as { id: number; name: string; state: string }[];
  try { return JSON.parse(r.stdout) as { id: number; name: string; state: string }[]; }
  catch { return [] as { id: number; name: string; state: string }[]; }
}

async function daguList(): Promise<{ dags: DaguDag[]; error?: string }> {
  const r = await daguFetch(`${DAGU_API_PATH}/dags`);
  if (!r.ok) return { dags: [], error: r.error };
  const data = r.data as any;
  if (Array.isArray(data?.dags))    return { dags: data.dags.map(mapV2Entry) };
  if (Array.isArray(data?.items))   return { dags: data.items.map(mapV2Entry) };
  if (Array.isArray(data?.results)) return { dags: data.results.map(mapV2Entry) };
  if (Array.isArray(data?.data))    return { dags: data.data.map(mapV2Entry) };
  if (Array.isArray(data))          return { dags: data.map(mapV2Entry) };
  if (Array.isArray(data?.DAGs))    return { dags: data.DAGs.map(mapV1Entry) };
  const keys = data && typeof data === "object" ? Object.keys(data).slice(0, 20).join(",") : typeof data;
  return { dags: [], error: `unexpected format (keys=[${keys}])` };
}

// ── VPS-ops helpers ────────────────────────────────────────────────────────

const PRESETS: Record<string, Record<string, string[]>> = {
  gcloud: {
    "instances": ["compute","instances","list","--format=table(name,zone,status,machineType,networkInterfaces[0].accessConfigs[0].natIP)"],
    "disks": ["compute","disks","list","--format=table(name,zone,sizeGb,status,type)"],
    "billing": ["billing","accounts","list"],
    "projects": ["projects","list","--format=table(projectId,name,lifecycleState)"],
    "iam": ["iam","service-accounts","list","--format=table(email,displayName,disabled)"],
    "firewall": ["compute","firewall-rules","list","--format=table(name,direction,allowed,sourceRanges,targetTags)"],
    "snapshots": ["compute","snapshots","list","--format=table(name,diskSizeGb,status,sourceDisk)"],
    "networks": ["compute","networks","list"],
    "regions": ["compute","regions","list","--format=table(name,status,quotas.CPUS.limit)"],
    "auth": ["auth","list"],
    "tf-plan": ["__terraform__","plan"],
    "tf-apply": ["__terraform__","apply"],
    "tf-drift": ["__terraform__","plan","-detailed-exitcode"],
    "tf-state": ["__terraform__","state","list"],
    "tf-output": ["__terraform__","output","-json"],
  },
  oci: {
    "instances": ["compute","instance","list","--compartment-id","${OCI_COMPARTMENT_ID}","--output","table","--query","data[*].{Name:\"display-name\",State:\"lifecycle-state\",Shape:shape,AD:\"availability-domain\"}"],
    "volumes": ["bv","volume","list","--compartment-id","${OCI_COMPARTMENT_ID}","--output","table"],
    "vcn": ["network","vcn","list","--compartment-id","${OCI_COMPARTMENT_ID}","--output","table"],
    "budget": ["budgets","budget","list","--compartment-id","${OCI_TENANCY_ID}","--output","table"],
    "limits": ["limits","service","list","--compartment-id","${OCI_COMPARTMENT_ID}","--output","table"],
    "auth": ["iam","region","list","--output","table"],
    "tf-plan": ["__terraform__","plan"],
    "tf-apply": ["__terraform__","apply"],
    "tf-drift": ["__terraform__","plan","-detailed-exitcode"],
    "tf-state": ["__terraform__","state","list"],
    "tf-output": ["__terraform__","output","-json"],
  },
  gh: {
    "repos": ["repo","list","diegonmarcos","--json","name,visibility,updatedAt","--jq",'.[] | "\\(.name) (\\(.visibility)) \\(.updatedAt[:10])"'],
    "issues": ["issue","list","--repo","diegonmarcos/cloudy-t-infra","--state","open","--json","number,title,updatedAt"],
    "prs": ["pr","list","--repo","diegonmarcos/cloudy-t-infra","--state","open","--json","number,title,headRefName"],
    "runs": ["run","list","--repo","diegonmarcos/cloudy-t-infra","--limit","10","--json","name,status,conclusion,updatedAt"],
    "workflows": ["workflow","list","--repo","diegonmarcos/cloudy-t-infra","--json","name,id,state"],
    "releases": ["release","list","--repo","diegonmarcos/cloudy-t-infra","--limit","5"],
    "secrets": ["secret","list","--repo","diegonmarcos/cloudy-t-infra"],
    "auth": ["auth","status"],
  },
  wrangler: {
    "workers": ["d1","list"],
    "kv": ["kv","namespace","list"],
    "r2": ["r2","bucket","list"],
    "pages": ["pages","project","list"],
    "tail": ["tail","--format","pretty"],
    "auth": ["whoami"],
  },
  hcloud: {
    "servers": ["server","list","-o","columns=id,name,status,server_type,datacenter,ipv4,ipv6"],
    "images": ["image","list","-o","columns=id,type,name,description,disk_size,created"],
    "volumes": ["volume","list","-o","columns=id,name,size,server,location"],
    "firewalls": ["firewall","list","-o","columns=id,name,rules_count"],
    "ssh-keys": ["ssh-key","list","-o","columns=id,name,fingerprint"],
    "networks": ["network","list","-o","columns=id,name,ip_range"],
    "auth": ["context","active"],
    "tf-plan": ["__terraform__","plan"],
    "tf-apply": ["__terraform__","apply"],
    "tf-drift": ["__terraform__","plan","-detailed-exitcode"],
    "tf-state": ["__terraform__","state","list"],
    "tf-output": ["__terraform__","output","-json"],
  },
  cloudflare: {
    "zones": ["__cf_api__","/zones?per_page=50","result[].{name,status,plan.name}"],
    "dns": ["__cf_api__","/zones/${CF_ZONE_ID}/dns_records?per_page=100","result[].{type,name,content,proxied}"],
    "workers": ["__cf_api__","/accounts/${CF_ACCOUNT_ID}/workers/scripts","result[].{id,modified_on}"],
    "firewall": ["__cf_api__","/zones/${CF_ZONE_ID}/firewall/rules","result[].{description,action,filter.expression}"],
    "analytics": ["__cf_api__","/zones/${CF_ZONE_ID}/analytics/dashboard?since=-1440","result.totals"],
    "auth": ["__cf_api__","/user/tokens/verify","result.status"],
    "tf-plan": ["__terraform__","plan"],
    "tf-apply": ["__terraform__","apply"],
    "tf-drift": ["__terraform__","plan","-detailed-exitcode"],
    "tf-state": ["__terraform__","state","list"],
    "tf-output": ["__terraform__","output","-json"],
  },
  ghcr: {
    "images": ["__ghcr__","list"],
    "tags": ["__ghcr__","tags"],
    "delete": ["__ghcr__","delete"],
    "auth": ["__ghcr__","auth"],
  },
};

const TF_DIRS: Record<string, string> = {
  gcloud: "b_infra/terraform/gcp",
  oci: "b_infra/terraform/oci",
  cloudflare: "b_infra/terraform/cloudflare",
  hcloud: "b_infra/terraform/hetzner",
};

async function runCli(cmd: string, args: string[], timeout = 30_000): Promise<string> {
  const which = await execAsync("bash", ["-c", `command -v ${cmd}`], { timeout: 3_000 });
  if (!which.ok) return `${cmd} CLI not found. Install it first.`;
  const r = await execAsync(cmd, args, { timeout });
  if (r.ok) return r.stdout.trim() || "(no output)";
  return `EXIT ${r.exitCode}\n${r.stderr.trim()}\n${r.stdout.trim()}`.trim();
}

async function runCloudflareApi(path: string, jqFilter?: string): Promise<string> {
  const token = process.env.CF_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!token) return "CF_API_TOKEN not set.";
  const expandedPath = path.replace("${CF_ZONE_ID}", process.env.CF_ZONE_ID ?? "").replace("${CF_ACCOUNT_ID}", process.env.CF_ACCOUNT_ID ?? "");
  const url = `https://api.cloudflare.com/client/v4${expandedPath}`;
  const curlArgs = ["-sf","--max-time","10","-H",`Authorization: Bearer ${token}`,"-H","Content-Type: application/json",url];
  const r = await execAsync("curl", curlArgs, { timeout: 15_000 });
  if (!r.ok) return `API call failed: ${r.stderr.trim()}`;
  if (jqFilter) {
    const jq = await execAsync("bash", ["-c", `echo '${r.stdout.replace(/'/g, "'\\''")}' | jq '.${jqFilter}'`], { timeout: 5_000 });
    return jq.ok ? jq.stdout.trim() : r.stdout.trim();
  }
  const jq = await execAsync("bash", ["-c", `echo '${r.stdout.replace(/'/g, "'\\''")}' | jq '.'`], { timeout: 5_000 });
  return jq.ok ? jq.stdout.trim() : r.stdout.trim();
}

async function runTerraform(provider: string, tfArgs: string[]): Promise<string> {
  const tfDir = TF_DIRS[provider];
  if (!tfDir) return `No terraform directory configured for ${provider}`;
  const GIT_BASE = process.env.GIT_BASE ?? require("os").homedir() + "/git";
  const fullPath = `${GIT_BASE}/cloud/${tfDir}`;
  const sections: string[] = [`TERRAFORM → ${provider.toUpperCase()} (${tfDir})`, "─".repeat(50)];
  const initCheck = await execAsync("bash", ["-c", `test -d ${fullPath}/.terraform`], { timeout: 3_000 });
  if (!initCheck.ok) {
    sections.push("Running terraform init...");
    const init = await execAsync("terraform", ["-chdir=" + fullPath, "init", "-no-color"], { timeout: 60_000 });
    if (!init.ok) { sections.push(`Init failed: ${init.stderr.trim()}`); return sections.join("\n"); }
  }
  const r = await execAsync("terraform", ["-chdir=" + fullPath, ...tfArgs, "-no-color"], { timeout: 120_000 });
  sections.push(r.stdout.trim());
  if (!r.ok && r.stderr.trim()) sections.push(`\nSTDERR: ${r.stderr.trim()}`);
  if (tfArgs[0] === "plan" && tfArgs.includes("-detailed-exitcode") && r.exitCode === 2)
    sections.push("\nDRIFT DETECTED — terraform plan shows pending changes");
  return sections.join("\n");
}

async function runGhcr(action: string): Promise<string> {
  const sections: string[] = ["GHCR (GitHub Container Registry)", "─".repeat(50)];
  switch (action) {
    case "list": {
      const r = await execAsync("gh", ["api","/user/packages?package_type=container&per_page=50","--jq",'.[] | "\\(.name) (\\(.visibility)) updated:\\(.updated_at[:10])"'], { timeout: 15_000 });
      if (!r.ok) {
        const r2 = await execAsync("gh", ["api","/users/diegonmarcos/packages?package_type=container&per_page=50","--jq",'.[] | "\\(.name) (\\(.visibility)) updated:\\(.updated_at[:10])"'], { timeout: 15_000 });
        sections.push(r2.ok ? r2.stdout.trim() : `Error: ${r2.stderr.trim()}`);
      } else { sections.push(r.stdout.trim() || "No packages found"); }
      break;
    }
    case "tags": {
      const pkgs = await execAsync("gh", ["api","/users/diegonmarcos/packages?package_type=container&per_page=20","--jq",".[].name"], { timeout: 15_000 });
      if (!pkgs.ok) { sections.push(`Error: ${pkgs.stderr.trim()}`); break; }
      for (const pkg of pkgs.stdout.trim().split("\n").filter(Boolean).slice(0, 10)) {
        const tags = await execAsync("gh", ["api",`/users/diegonmarcos/packages/container/${encodeURIComponent(pkg)}/versions?per_page=5`,"--jq",'.[] | "  \\(.metadata.container.tags | join(",")) \\(.updated_at[:10])"'], { timeout: 10_000 });
        sections.push(`${pkg}:`); sections.push(tags.ok ? tags.stdout.trim() : "  (error fetching tags)");
      }
      break;
    }
    case "auth": {
      const r = await execAsync("gh", ["auth","token"], { timeout: 5_000 });
      sections.push(r.ok ? "Authenticated (token available)" : "Not authenticated");
      break;
    }
    default: sections.push(`Unknown GHCR action: ${action}. Available: list, tags, auth`);
  }
  return sections.join("\n");
}

async function handleVpsCommand(provider: string, command: string): Promise<string> {
  const presets = PRESETS[provider];
  const sections: string[] = [];
  if (!command || command === "help") {
    sections.push(`${provider.toUpperCase()} — Available commands:`);
    sections.push("═".repeat(50));
    if (presets) {
      for (const [name, args] of Object.entries(presets)) {
        const preview = args[0] === "__cf_api__" ? `API: ${args[1]}` : args.join(" ").slice(0, 60);
        sections.push(`  ${name.padEnd(15)} ${preview}`);
      }
    }
    sections.push(`\n  Or pass raw args: any ${provider} CLI arguments`);
    return sections.join("\n");
  }
  if (presets?.[command]) {
    const args = presets[command];
    if (args[0] === "__cf_api__") return runCloudflareApi(args[1], args[2]);
    if (args[0] === "__terraform__") return runTerraform(provider, args.slice(1));
    if (args[0] === "__ghcr__") return runGhcr(args[1]);
    const expandedArgs = args.map((a) => a.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? ""));
    sections.push(`${provider.toUpperCase()} → ${command}`, "─".repeat(50));
    sections.push(await runCli(provider === "cloudflare" ? "curl" : provider, expandedArgs));
    return sections.join("\n");
  }
  const rawArgs = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
  const cleanArgs = rawArgs.map((a) => a.replace(/^["']|["']$/g, ""));
  sections.push(`${provider.toUpperCase()} → ${command}`, "─".repeat(50));
  if (provider === "cloudflare") sections.push(await runCloudflareApi(cleanArgs[0], cleanArgs[1]));
  else sections.push(await runCli(provider, cleanArgs));
  return sections.join("\n");
}

// ── FinOps helpers (from finops.ts) ────────────────────────────────────────

interface TopologyVm { ip: string; wg_ip?: string; ssh_alias?: string; description?: string; [k: string]: unknown; }
interface TopologyService { category: string; vm: string; containers?: string[]; domain?: string; frozen?: boolean; [k: string]: unknown; }

function loadTopology(): { vms: Record<string, TopologyVm>; services: Record<string, TopologyService> } {
  // 2026-09-04: was a hand-rolled list containing join(CLOUD_DATA_DIR, "..",
  // "cloud", ...) — "cloud" is the PRE-RENAME repo dirname. The checkout is
  // named "cloud-infra" (paths.ts fixed exactly this for SOLUTIONS_DIR on
  // 2026-08-21 but these inline copies were missed), so every dev/host
  // fallback resolved to a directory that does not exist and loadTopology()
  // returned {} — which is why finops.vps / finops.assets / finops.services
  // all rendered empty tables with 0 VMs and $0/mo.
  // Route through the canonical resolver so this cannot drift again.
  const candidates = [
    resolveCloudDataPath("build-cloud-infra-mcp.json"),
    getConsolidatedPath(),
  ];
  // MERGE, don't first-wins. build-cloud-infra-mcp.json carries an enriched
  // `services` map but has NO `vms` key at all, so returning on the first
  // existing candidate yielded vms:{} and made finops.vps/finops.assets render
  // "0 VMs / $0/mo" even with a perfectly good consolidated file sitting right
  // behind it. Take each key from the first candidate that actually has it.
  let vms: Record<string, TopologyVm> = {};
  let services: Record<string, TopologyService> = {};
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8"));
      if (Object.keys(vms).length === 0 && raw.vms && Object.keys(raw.vms).length > 0) vms = raw.vms;
      if (Object.keys(services).length === 0 && raw.services && Object.keys(raw.services).length > 0) services = raw.services;
      if (Object.keys(vms).length > 0 && Object.keys(services).length > 0) break;
    } catch { /* try next */ }
  }
  return { vms, services };
}

function loadServicePorts(): Map<string, number> {
  const ports = new Map<string, number>();
  try {
    const dirs = readdirSync(SOLUTIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const dir of dirs) {
      const bjPath = join(SOLUTIONS_DIR, dir, "build.json");
      if (!existsSync(bjPath)) continue;
      try { const bj = JSON.parse(readFileSync(bjPath, "utf-8")); if (bj.name && bj.ports?.app) ports.set(bj.name, Number(bj.ports.app)); }
      catch { /* skip */ }
    }
  } catch { /* no solutions dir */ }
  return ports;
}

const VM_COSTS: Record<string, { provider: string; tier: string; monthly: number; specs: string }> = {
  "gcp-E2-f_0": { provider: "GCP", tier: "Free", monthly: 0, specs: "E2-micro (0.25 vCPU / 1GB)" },
  "oci-E2-f_0": { provider: "OCI", tier: "Free", monthly: 0, specs: "E2.1.Micro (1 OCPU / 1GB)" },
  "oci-E2-f_1": { provider: "OCI", tier: "Free", monthly: 0, specs: "E2.1.Micro (1 OCPU / 1GB)" },
  "oci-A1-f_0": { provider: "OCI", tier: "Free", monthly: 0, specs: "A1.Flex (4 OCPU / 24GB / 100GB)" },
  "gcp-T4-p_0": { provider: "GCP", tier: "Spot", monthly: 120, specs: "N1-Std-4 + T4 GPU (4 vCPU / 15GB)" },
  "oci-A1-p_0": { provider: "OCI", tier: "Paid", monthly: 30, specs: "A1.Flex Paid (8 OCPU / 32GB)" },
};

async function collectVmResources(vmId: string): Promise<{ disk?: string; mem?: string; load?: string }> {
  try {
    const script = ["echo '===disk==='","df -h / 2>/dev/null | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'" ,"echo '===mem==='","free -m 2>/dev/null | awk '/Mem:/{printf \"%dMB/%dMB (%.0f%%)\", $3, $2, $3/$2*100}'","echo","echo '===load==='","cat /proc/loadavg 2>/dev/null | awk '{print $1}'"].join("\n");
    const r = await sshExecAsync(vmId, script, 10_000, true, 3);
    if (!r.ok) return {};
    const section = (name: string) => {
      const marker = `===${name}===`;
      const start = r.stdout.indexOf(marker);
      if (start === -1) return undefined;
      const after = start + marker.length;
      const contentStart = r.stdout[after] === "\n" ? after + 1 : after;
      const end = r.stdout.indexOf("===", contentStart);
      return (end === -1 ? r.stdout.slice(contentStart) : r.stdout.slice(contentStart, end)).trim() || undefined;
    };
    return { disk: section("disk"), mem: section("mem"), load: section("load") };
  } catch { return {}; }
}

async function countDockerContainers(vmId: string): Promise<{ running: number; total: number }> {
  try {
    const r = await sshExecAsync(vmId, "docker ps -a --format '{{.Status}}' 2>/dev/null | wc -l && docker ps --format '{{.Status}}' 2>/dev/null | wc -l", 8_000, true, 3);
    if (!r.ok) return { running: 0, total: 0 };
    const lines = r.stdout.trim().split("\n");
    return { total: parseInt(lines[0]) || 0, running: parseInt(lines[1]) || 0 };
  } catch { return { running: 0, total: 0 }; }
}

async function finOpsVps(): Promise<string> {
  const { vms, services } = loadTopology();
  const activeVms = Object.entries(vms).filter(([_, v]) => v.wg_ip && v.ip !== "TBD");
  const sections: string[] = [];
  const vmServiceCount: Record<string, number> = {};
  const vmContainerCount: Record<string, number> = {};
  for (const [_, svc] of Object.entries(services)) {
    if (!svc.vm || svc.vm === "local" || svc.frozen) continue;
    vmServiceCount[svc.vm] = (vmServiceCount[svc.vm] || 0) + 1;
    vmContainerCount[svc.vm] = (vmContainerCount[svc.vm] || 0) + (svc.containers?.length || 0);
  }
  const resourceResults = await Promise.allSettled(activeVms.map(async ([vmId]) => ({ vmId, resources: await collectVmResources(vmId), containers: await countDockerContainers(vmId) })));
  const liveData = new Map<string, { resources: { disk?: string; mem?: string; load?: string }; containers: { running: number; total: number } }>();
  for (const r of resourceResults) { if (r.status === "fulfilled") liveData.set(r.value.vmId, r.value); }
  const rows: string[][] = [];
  let totalMonthly = 0;
  for (const [vmId, vm] of activeVms) {
    const cost = VM_COSTS[vmId] ?? { provider: "?", tier: "?", monthly: 0, specs: "unknown" };
    const alias = vm.ssh_alias ?? vmId;
    const live = liveData.get(vmId);
    totalMonthly += cost.monthly;
    rows.push([alias, cost.provider, cost.tier, cost.monthly === 0 ? "FREE" : `$${cost.monthly}/mo`, cost.specs, `${vmServiceCount[vmId] || 0} svc`, live ? `${live.containers.running}/${live.containers.total}` : "?", live?.resources.disk ?? "N/A", live?.resources.mem ?? "N/A", live?.resources.load ?? "N/A"]);
  }
  sections.push("VPS COST ANALYSIS", "═".repeat(70));
  sections.push(formatTable(["VM","Cloud","Tier","Cost","Specs","Svc","Containers","Disk","Memory","Load"], rows));
  sections.push("");
  sections.push(`Total monthly: $${totalMonthly}/mo (${activeVms.filter(([id]) => (VM_COSTS[id]?.monthly ?? 0) === 0).length} free, ${activeVms.filter(([id]) => (VM_COSTS[id]?.monthly ?? 0) > 0).length} paid)`);
  const activeServices = Object.entries(services).filter(([_, s]) => s.vm !== "local" && !s.frozen).length;
  if (activeServices > 0 && totalMonthly > 0) sections.push(`Cost per service: $${(totalMonthly / activeServices).toFixed(2)}/mo`);
  return sections.join("\n");
}

async function finOpsServices(): Promise<string> {
  const { vms, services } = loadTopology();
  const ports = loadServicePorts();
  const sections: string[] = [];
  const entries: { name: string; vm: string; vmAlias: string; containers: number; category: string; hasDomain: boolean; frozen: boolean; port?: number }[] = [];
  for (const [name, svc] of Object.entries(services)) {
    if (svc.vm === "local") continue;
    const vmAlias = vms[svc.vm]?.ssh_alias ?? svc.vm;
    entries.push({ name, vm: svc.vm, vmAlias, containers: svc.containers?.length ?? 0, category: svc.category, hasDomain: !!svc.domain, frozen: !!svc.frozen, port: ports.get(name) });
  }
  entries.sort((a, b) => a.vmAlias.localeCompare(b.vmAlias) || a.name.localeCompare(b.name));
  sections.push("SERVICE RESOURCE MAP", "═".repeat(70));
  sections.push(formatTable(["Service","VM","Category","Containers","Domain","Port","Status"], entries.map((e) => [e.name, e.vmAlias, e.category, String(e.containers), e.hasDomain ? "yes" : "no", e.port ? String(e.port) : "-", e.frozen ? "FROZEN" : "active"])));
  sections.push("", "BY VM:");
  const byVm = new Map<string, { services: number; containers: number; domains: number }>();
  for (const e of entries) {
    const prev = byVm.get(e.vmAlias) ?? { services: 0, containers: 0, domains: 0 };
    prev.services++; prev.containers += e.containers; if (e.hasDomain) prev.domains++;
    byVm.set(e.vmAlias, prev);
  }
  for (const [alias, data] of byVm) sections.push(`  ${alias}: ${data.services} services, ${data.containers} containers, ${data.domains} domains`);
  sections.push("", "BY CATEGORY:");
  const byCat = new Map<string, number>();
  for (const e of entries) byCat.set(e.category, (byCat.get(e.category) ?? 0) + 1);
  for (const [cat, count] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) sections.push(`  ${cat}: ${count} services`);
  sections.push("", `Total: ${entries.length} services, ${entries.reduce((s, e) => s + e.containers, 0)} containers, ${entries.filter((e) => e.hasDomain).length} with domains, ${entries.filter((e) => e.frozen).length} frozen`);
  return sections.join("\n");
}

async function finOpsAssets(): Promise<string> {
  const { vms, services } = loadTopology();
  const sections: string[] = ["INFRASTRUCTURE ASSETS", "═".repeat(70)];
  sections.push("\n── VIRTUAL MACHINES ──");
  const vmRows = Object.entries(vms).filter(([_, v]) => v.ip !== "TBD").map(([id, v]) => [v.ssh_alias ?? id, v.ip ?? "-", v.wg_ip ?? "-", v.description ?? "-"]);
  sections.push(formatTable(["VM","Public IP","WG IP","Description"], vmRows));
  sections.push("\n── DOMAINS ──");
  const domains = new Set<string>();
  for (const svc of Object.values(services)) { if (svc.domain) domains.add(svc.domain.split("/")[0]); }
  const sortedDomains = [...domains].sort();
  sections.push(`  ${sortedDomains.length} unique domains:`);
  for (const d of sortedDomains) sections.push(`    ${d}`);
  sections.push("\n── CONTAINER COUNT BY VM ──");
  const containersByVm = new Map<string, string[]>();
  for (const [name, svc] of Object.entries(services)) {
    if (!svc.vm || svc.vm === "local") continue;
    const alias = vms[svc.vm]?.ssh_alias ?? svc.vm;
    const prev = containersByVm.get(alias) ?? [];
    prev.push(...(svc.containers ?? []).map((c) => `${name}/${c}`));
    containersByVm.set(alias, prev);
  }
  for (const [alias, containers] of [...containersByVm.entries()].sort()) sections.push(`  ${alias}: ${containers.length} declared containers`);
  sections.push("\n── PORTS ALLOCATED ──");
  const ports = loadServicePorts();
  const portsByVm = new Map<string, { name: string; port: number }[]>();
  for (const [name, svc] of Object.entries(services)) {
    const port = ports.get(name);
    if (!port || !svc.vm) continue;
    const alias = vms[svc.vm]?.ssh_alias ?? svc.vm;
    const prev = portsByVm.get(alias) ?? [];
    prev.push({ name, port });
    portsByVm.set(alias, prev);
  }
  for (const [alias, ents] of [...portsByVm.entries()].sort()) {
    const sorted = ents.sort((a, b) => a.port - b.port);
    sections.push(`  ${alias}: ${sorted.map((e) => `${e.port}(${e.name})`).join(", ")}`);
  }
  sections.push("\n── CLOUDFLARE DNS ──");
  const cfCandidates = [getConsolidatedPath()];
  const cfPath = cfCandidates.find((p) => existsSync(p));
  if (cfPath) {
    try {
      const cf = JSON.parse(readFileSync(cfPath, "utf-8"));
      const records = (Array.isArray(cf.dns?.cloudflare) && cf.dns.cloudflare.length > 0 ? cf.dns.cloudflare : cf.dns?.derived_entries) ?? [];
      if (Array.isArray(records)) {
        sections.push(`  ${records.length} DNS records`);
        const byType = new Map<string, number>();
        for (const r of records) { const t = r.type ?? "?"; byType.set(t, (byType.get(t) ?? 0) + 1); }
        for (const [t, c] of [...byType.entries()].sort()) sections.push(`    ${t}: ${c}`);
      }
    } catch { sections.push("  parse error"); }
  } else { sections.push("  _cloud-data-consolidated.json not found"); }
  sections.push("\n── GIT REPOSITORIES ──");
  for (const repo of ["cloud","cloud-data","unix","vault","front","tools"]) {
    const repoPath = join(CLOUD_DATA_DIR, "..", repo);
    if (existsSync(join(repoPath, ".git"))) sections.push(`  ${repo}: ${repoPath}`);
  }
  const totalContainers = [...containersByVm.values()].reduce((s, c) => s + c.length, 0);
  sections.push("", `TOTALS: ${vmRows.length} VMs, ${sortedDomains.length} domains, ${totalContainers} containers, ${ports.size} ports allocated`);
  return sections.join("\n");
}

// ── Frontend helpers ───────────────────────────────────────────────────────

interface BuildJsonConfig { name: string; framework: string; port?: number; src?: string; dist?: string; build?: Array<{ mod: string; [k: string]: any }>; serve?: { mode?: string; dir?: string }; }
let _projectsCache: Map<string, { dir: string; category: string; config: BuildJsonConfig }> | null = null;
let _projectsCacheTimestamp = 0;
const PROJECTS_TTL = 60 * 1000;

function findProjects(): Map<string, { dir: string; category: string; config: BuildJsonConfig }> {
  const now = Date.now();
  if (_projectsCache && now - _projectsCacheTimestamp < PROJECTS_TTL) return _projectsCache;
  const projects = new Map<string, { dir: string; category: string; config: BuildJsonConfig }>();
  const entries = readdirSync(FRONT_DIR).filter((name) => {
    const full = join(FRONT_DIR, name);
    return statSync(full).isDirectory() && !name.startsWith(".") && name !== "node_modules" && name !== "1.ops" && name !== "a0_docs" && name !== "0.spec";
  });
  for (const entry of entries) {
    const entryPath = join(FRONT_DIR, entry);
    const buildJson = join(entryPath, "build.json");
    if (existsSync(buildJson)) {
      try { const config = JSON.parse(readFileSync(buildJson, "utf-8")) as BuildJsonConfig; projects.set(entry, { dir: entryPath, category: entry, config }); }
      catch { /* skip */ }
      continue;
    }
    if (!statSync(entryPath).isDirectory()) continue;
    try {
      for (const sub of readdirSync(entryPath)) {
        const subPath = join(entryPath, sub);
        const subBuildJson = join(subPath, "build.json");
        if (existsSync(subBuildJson)) {
          try { const config = JSON.parse(readFileSync(subBuildJson, "utf-8")) as BuildJsonConfig; const key = projects.has(sub) ? `${entry}/${sub}` : sub; projects.set(key, { dir: subPath, category: entry, config }); }
          catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  _projectsCache = projects;
  _projectsCacheTimestamp = Date.now();
  return projects;
}

// ── GHA + Dagu workflow functions ──────────────────────────────────────────

async function workflowsGha(): Promise<string> {
  const sections: string[] = ["GHA WORKFLOWS — LAST 24H", "═".repeat(70)];
  const wfs = await ghaWorkflows();
  sections.push(`\n${wfs.length} workflows registered (${wfs.filter((w) => w.state === "active").length} active)\n`);
  const { runs, error } = await ghaRuns24h();
  if (error) { sections.push(`Error fetching runs: ${error}`); return sections.join("\n"); }
  if (runs.length === 0) { sections.push("No runs in the last 24 hours."); return sections.join("\n"); }
  const byConclusion = new Map<string, number>();
  for (const r of runs) { const key = r.conclusion || r.status; byConclusion.set(key, (byConclusion.get(key) || 0) + 1); }
  sections.push("Summary: " + [...byConclusion.entries()].map(([k, v]) => `${v} ${k}`).join(", "), "");
  sections.push(formatTable(["Workflow","Result","Branch","Event","When","ID"], runs.map((r) => [r.workflowName.length > 35 ? r.workflowName.slice(0, 35) + "…" : r.workflowName, r.conclusion || r.status, r.headBranch, r.event ?? "-", timeAgo(r.updatedAt), String(r.databaseId)])));
  sections.push("\nBY WORKFLOW:");
  const byWf = new Map<string, { success: number; failure: number; other: number }>();
  for (const r of runs) {
    const prev = byWf.get(r.workflowName) ?? { success: 0, failure: 0, other: 0 };
    if (r.conclusion === "success") prev.success++; else if (r.conclusion === "failure") prev.failure++; else prev.other++;
    byWf.set(r.workflowName, prev);
  }
  for (const [name, counts] of [...byWf.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts: string[] = [];
    if (counts.success) parts.push(`${counts.success} ok`);
    if (counts.failure) parts.push(`${counts.failure} FAIL`);
    if (counts.other) parts.push(`${counts.other} other`);
    sections.push(`  ${name}: ${parts.join(", ")}`);
  }
  return sections.join("\n");
}

async function workflowsGhaErrors(): Promise<string> {
  const sections: string[] = ["GHA FAILURES — LAST 24H", "═".repeat(70)];
  const { runs, error } = await ghaRuns24h("failure");
  if (error) return `Error: ${error}`;
  if (runs.length === 0) { sections.push("No failures in the last 24 hours."); return sections.join("\n"); }
  sections.push(`${runs.length} failed run(s)\n`);
  for (const r of runs) {
    sections.push(`── ${r.workflowName} (${timeAgo(r.updatedAt)}) ──`, `  Branch: ${r.headBranch} | ID: ${r.databaseId}`);
    const logResult = await gh(["run","view",String(r.databaseId),"--repo",GH_REPO,"--log-failed"], 15_000);
    if (logResult.ok && logResult.stdout.trim()) {
      const relevant = logResult.stdout.trim().split("\n").slice(-15);
      sections.push(`  Log (last ${relevant.length} lines):`);
      for (const line of relevant) sections.push(`    ${line}`);
    } else { sections.push("  (no failed logs available)"); }
    sections.push("");
  }
  return sections.join("\n");
}

async function workflowsGhaTrigger(workflowName?: string): Promise<string> {
  const sections: string[] = [];
  if (!workflowName || workflowName === "all") {
    const wfs = await ghaWorkflows();
    const active = wfs.filter((w) => w.state === "active");
    sections.push(`Triggering ${active.length} active workflows...`);
    const results = await Promise.allSettled(active.map(async (wf) => {
      const r = await gh(["workflow","run",String(wf.id),"--repo",GH_REPO,"--ref","main"], 10_000);
      return { name: wf.name, ok: r.ok, error: r.stderr.trim() };
    }));
    for (const r of results) { if (r.status === "fulfilled") sections.push(`  ${r.value.ok ? "+" : "x"} ${r.value.name}${r.value.ok ? "" : ` — ${r.value.error}`}`); }
  } else {
    const wfs = await ghaWorkflows();
    const match = wfs.find((w) => w.name === workflowName || w.name.includes(workflowName) || String(w.id) === workflowName);
    if (!match) return `Workflow not found: "${workflowName}"\nAvailable: ${wfs.map((w) => w.name).join(", ")}`;
    const r = await gh(["workflow","run",String(match.id),"--repo",GH_REPO,"--ref","main"], 10_000);
    sections.push(r.ok ? `+ Triggered: ${match.name}` : `x Failed: ${match.name} — ${r.stderr.trim()}`);
  }
  return sections.join("\n");
}

async function workflowsDagu(): Promise<string> {
  const sections: string[] = ["DAGU WORKFLOWS", "═".repeat(70)];
  const { dags, error } = await daguList();
  if (error) { sections.push(`Dagu API error: ${error}`); return sections.join("\n"); }
  if (dags.length === 0) { sections.push("No DAGs found."); return sections.join("\n"); }
  sections.push(`${dags.length} DAGs\n`);
  sections.push(formatTable(["DAG","Status","Last Run","Schedule"], dags.map((d) => [d.name, d.statusText ?? "unknown", d.startedAt ? timeAgo(d.startedAt) : "-", d.schedule ?? "-"])));
  return sections.join("\n");
}

async function workflowsDaguErrors(): Promise<string> {
  const sections: string[] = ["DAGU ERRORS — LAST 24H", "═".repeat(70)];
  const { dags, error } = await daguList();
  if (error) return `Dagu API error: ${error}`;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const failed: { name: string; status: string; when: string }[] = [];
  for (const d of dags) {
    const statusText = (d.statusText ?? "").toLowerCase();
    const finishedAt = d.finishedAt ? new Date(d.finishedAt).getTime() : 0;
    if ((statusText === "error" || statusText === "failed" || statusText === "cancel") && finishedAt > cutoff)
      failed.push({ name: d.name, status: statusText, when: d.finishedAt ? timeAgo(d.finishedAt) : "?" });
  }
  if (failed.length === 0) { sections.push("No Dagu failures in the last 24 hours."); return sections.join("\n"); }
  sections.push(`${failed.length} failed DAG(s)\n`);
  for (const f of failed) sections.push(`  x ${f.name} — ${f.status} (${f.when})`);
  return sections.join("\n");
}

async function workflowsDaguTrigger(dagName?: string): Promise<string> {
  const sections: string[] = [];
  if (!dagName || dagName === "all") {
    const { dags, error } = await daguList();
    if (error) return `Dagu API error: ${error}`;
    sections.push(`Triggering ${dags.length} DAGs...`);
    for (const d of dags) {
      if (!d.name) continue;
      const r = await daguFetch(`${DAGU_API_PATH}/dags/${encodeURIComponent(d.name)}/start`, "POST", "{}");
      sections.push(`  ${r.ok ? "+" : "x"} ${d.name}${r.ok ? "" : ` — ${r.error}`}`);
    }
  } else {
    const r = await daguFetch(`${DAGU_API_PATH}/dags/${encodeURIComponent(dagName)}/start`, "POST", "{}");
    sections.push(r.ok ? `+ Triggered: ${dagName}` : `x Failed: ${dagName} — ${r.error}`);
  }
  return sections.join("\n");
}

// ══════════════════════════════════════════════════════════════════════════════
// META-TOOL 1: infra.devops
// ══════════════════════════════════════════════════════════════════════════════

export function registerMetaDevops(server: McpServer): void {
  server.tool(
    "infra.devops",
    "DevOps operations: build, ship, docker, container, VM, service, frontend, workflows, backlog (safe ticket read/add/update, never delete). Pass method + params.",
    {
      method: z.enum([
        "backlog.add","backlog.get","backlog.list","backlog.update",
        "build.all","build.backup","build.docker","build.secrets_status","build.service","build.ship",
        "caddy.cert_repair",
        "container.restart","container.start","container.stop",
        "docker.compose_up","docker.compose_up_all","docker.control","docker.diff","docker.events",
        "docker.exec","docker.inspect","docker.pause","docker.ps","docker.system_df","docker.top","docker.unpause",
        "front.build","front.deploy","front.dev_server",
        "service.restart","service.start","service.stop",
        "ssh.check",
        "vm.drain","vm.reset","vm.start","vm.stop",
        "workflows.all","workflows.dagu","workflows.dagu_errors","workflows.dagu_ok","workflows.dagu_trigger",
        "workflows.gha","workflows.gha_errors","workflows.gha_ok","workflows.gha_trigger",
      ]).describe("DevOps operation to perform"),
      params: z.record(z.unknown()).optional().describe("Operation parameters"),
    },
    async ({ method, params }) => {
      const p = (params ?? {}) as any;
      try {
        if (method.startsWith("backlog.")) {
          return text(await handleBacklog(method.replace(/^backlog\./, ""), p));
        }
        switch (method) {
          // ── build ──
          case "build.service": {
            const svcDir = getServiceDir(p.service);
            const buildSh = join(svcDir, "build.sh");
            if (!existsSync(buildSh)) return errText(`No build.sh found for ${p.service}`);
            const result = exec("sh", [buildSh, p.step ?? "all"], { timeout: 120_000, cwd: svcDir });
            return { content: [{ type: "text" as const, text: [`Build ${p.service} (${p.step ?? "all"}): ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-3000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-1000)}` : ""].join("\n") }], isError: !result.ok };
          }
          case "build.all": {
            const args = [BUILD_SCRIPT, "build"];
            if (p.dryRun) args.unshift("-n");
            const result = exec("sh", args, { timeout: 300_000, cwd: SOLUTIONS_DIR });
            return { content: [{ type: "text" as const, text: [`Build all: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-5000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-2000)}` : ""].join("\n") }], isError: !result.ok };
          }
          case "build.ship": {
            const svcDir = getServiceDir(p.service);
            const buildSh = join(svcDir, "build.sh");
            if (!existsSync(buildSh)) return errText(`No build.sh found for ${p.service}`);
            const result = exec("sh", [buildSh, "ship"], { timeout: 300_000, cwd: svcDir });
            audit("devops.build.ship", p.service, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
            return { content: [{ type: "text" as const, text: [`Ship ${p.service}: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-5000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-2000)}` : ""].join("\n") }], isError: !result.ok };
          }
          case "build.docker": {
            const svcDir = getServiceDir(p.service);
            const buildSh = join(svcDir, "build.sh");
            if (!existsSync(buildSh)) return errText(`No build.sh found for ${p.service}`);
            const result = exec("sh", [buildSh, "docker"], { timeout: 600_000, cwd: svcDir });
            return { content: [{ type: "text" as const, text: [`Docker build ${p.service}: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-5000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-2000)}` : ""].join("\n") }], isError: !result.ok };
          }
          case "build.secrets_status": {
            const config = getConfig();
            const services = p.service ? { [p.service]: config.services[p.service] } : config.services;
            if (p.service && !config.services[p.service]) return errText(`Unknown service: ${p.service}`);
            const lines: string[] = ["# Secrets Status", ""];
            for (const [name, svc] of Object.entries(services)) {
              if (!svc) continue;
              const svcDir = getServiceDir(name);
              const secretsYaml = join(svcDir, "src", "secrets.yaml");
              const secretsDir = join(svcDir, "dist", ".secrets");
              let status = "no secrets.yaml";
              if (existsSync(secretsYaml)) {
                try { const c = readFileSync(secretsYaml, "utf-8"); status = (c.includes("sops:") || c.includes("ENC[AES256_GCM")) ? "encrypted (sops)" : "PLAINTEXT WARNING"; }
                catch { status = "read error"; }
              }
              lines.push(`**${name}** (${(svc as any).vm}): ${status}${existsSync(secretsDir) ? " | dist/.secrets exists" : ""}`);
            }
            return text(lines.join("\n"));
          }
          case "build.backup": {
            const vmId = resolveVmId(p.vm);
            const config = getConfig();
            const svc = config.services[p.service];
            if (!svc) return errText(`Unknown service: ${p.service}`);
            const remotePath = `${config.remote_base}/${getServiceFolder(p.service)}`;
            validatePath(getServiceFolder(p.service));
            const backupType = p.type ?? "borg";
            const cmd = `${composeCd(remotePath)} && (docker compose run --rm backup-${backupType} 2>&1 || docker compose run --rm backup 2>&1)`;
            const result = sshExec(vmId, cmd, 300_000);
            audit("devops.build.backup", `${backupType} ${p.service}@${getVmSshAlias(vmId)}`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
            return { content: [{ type: "text" as const, text: [`Backup ${backupType} for ${p.service}@${p.vm}: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- output ---\n${result.stdout.slice(-3000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-1000)}` : ""].join("\n") }], isError: !result.ok };
          }
          // ── ssh ──
          case "ssh.check": {
            const vmId = resolveVmId(p.vm);
            const alias = getVmSshAlias(vmId);
            const config = getConfig();
            const vmConfig = config.vms[vmId];
            const ping = checkVmReachable(vmId);
            if (!ping.ok) return errText(`${alias} (${vmId}) @ ${vmMeshAddress(vmConfig)}: UNREACHABLE\n${ping.stderr}`);
            if (!p.detailed) return text(`${alias} (${vmId}) @ ${vmMeshAddress(vmConfig)}: REACHABLE`);
            const info = sshExec(vmId, 'echo "=== Uptime ===" && uptime && echo "=== Memory ===" && free -h && echo "=== Disk ===" && df -h / && echo "=== Docker ===" && docker ps --format "table {{.Names}}\\t{{.Status}}" 2>/dev/null || echo "Docker not available"', 15_000);
            const header = `${alias} (${vmId}) @ ${vmMeshAddress(vmConfig)}: REACHABLE`;
            if (!info.ok) return text(`${header}\n\n(SSH exec failed — exit ${info.exitCode})${info.stderr ? `\n${info.stderr}` : ""}`);
            return text(`${header}\n\n${info.stdout}`);
          }
          // ── docker ──
          case "docker.ps": {
            const vmId = resolveVmId(p.vm);
            const cmd = p.all ? 'docker ps -a --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}"' : 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}"';
            const result = sshExec(vmId, cmd);
            const body = result.ok ? (result.stdout || "No containers found") : `SSH FAILED (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`;
            return { content: [{ type: "text" as const, text: `Containers on ${getVmSshAlias(vmId)} (${vmId}):\n\n${body}` }], isError: !result.ok };
          }
          case "docker.control": {
            validateContainerName(p.container);
            const vmId = resolveVmId(p.vm);
            const result = sshExec(vmId, `docker ${p.action} ${p.container}`);
            audit("devops.docker.control", `${p.action} ${p.container}@${getVmSshAlias(vmId)}`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
            return { content: [{ type: "text" as const, text: `docker ${p.action} ${p.container} on ${getVmSshAlias(vmId)}: ${result.ok ? "OK" : "FAILED"}\n${result.stdout}${result.stderr}` }], isError: !result.ok };
          }
          case "docker.compose_up": {
            const config = getConfig();
            const svc = config.services[p.service];
            if (!svc) return errText(`Unknown service: ${p.service}`);
            if ((svc as any).vm === "local" || (svc as any).vm === "all") return errText(`Cannot compose for vm=${(svc as any).vm}`);
            const vmId = (svc as any).vm;
            validatePath(p.service);
            const remotePath = `${config.remote_base}/${p.service}`;
            const cmd = `${composeCd(remotePath)} && docker compose down 2>/dev/null; docker compose up -d`;
            const result = sshExec(vmId, cmd, 60_000);
            audit("docker_compose_up", `${p.service}@${getVmSshAlias(vmId)}`, result.ok ? "OK" : `FAILED (exit ${result.exitCode})`);
            return { content: [{ type: "text" as const, text: `docker compose up ${p.service} on ${getVmSshAlias(vmId)}:\n${result.ok ? "SUCCESS" : "FAILED"}\n\n${result.stdout}${result.stderr}` }], isError: !result.ok };
          }
          case "docker.compose_up_all": {
            const result = composeUpAll(p.vm);
            return { content: [{ type: "text" as const, text: `compose up all on ${p.vm}:\n${result.ok ? "ALL OK" : "PARTIAL FAILURE"}\n\n${result.output}` }], isError: !result.ok };
          }
          case "docker.top": { validateContainerName(p.container); const r = containerTop(p.vm, p.container); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          case "docker.diff": { validateContainerName(p.container); const r = containerDiff(p.vm, p.container); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          case "docker.inspect": { validateContainerName(p.container); const r = containerInspectFull(p.vm, p.container); return r.ok ? text(JSON.stringify(r.data, null, 2)) : errText(`Error: ${String(r.data)}`); }
          case "docker.events": { validateContainerName(p.container); if (p.since) validateSince(p.since); const r = containerEvents(p.vm, p.container, p.since); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          case "docker.pause": { validateContainerName(p.container); const r = containerPause(p.vm, p.container); return { content: [{ type: "text" as const, text: r.output }], isError: !r.ok }; }
          case "docker.unpause": { validateContainerName(p.container); const r = containerUnpause(p.vm, p.container); return { content: [{ type: "text" as const, text: r.output }], isError: !r.ok }; }
          case "docker.exec": { validateContainerName(p.container); const r = containerExecCmd(p.vm, p.container, p.command); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          case "caddy.cert_repair": { const c = p.container ?? "caddy"; validateContainerName(c); const r = caddyCertRepair(p.vm ?? "gcp-proxy", c, p.dry_run ?? true, p.all_mesh ?? false); return r.ok ? text(r.output) : errText(r.output); }
          case "docker.system_df": { const r = dockerSystemDf(p.vm); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          // ── vm ──
          case "vm.start": return formatControl(vmStart(p.vm));
          case "vm.stop": return formatControl(vmStop(p.vm));
          case "vm.reset": return formatControl(vmReset(p.vm));
          case "vm.drain": return formatControl(vmDrain(p.vm));
          // ── container ──
          case "container.start": return formatControl(containerStart(p.vm, p.name));
          case "container.stop": return formatControl(containerStop(p.vm, p.name));
          case "container.restart": return formatControl(containerRestart(p.vm, p.name));
          // ── service ──
          case "service.start": return formatControl(serviceStart(p.vm, p.service));
          case "service.stop": return formatControl(serviceStop(p.vm, p.service));
          case "service.restart": return formatControl(serviceRestart(p.vm, p.service));
          // ── front ──
          case "front.build": {
            const projects = findProjects();
            const proj = projects.get(p.project);
            if (!proj) return errText(`Unknown project: ${p.project}`);
            const buildSh = join(proj.dir, "build.sh");
            if (!existsSync(buildSh)) return errText(`No build.sh in ${proj.dir}`);
            const cmd = p.command ?? "build";
            const result = exec("sh", [buildSh, cmd], { timeout: 120_000, cwd: proj.dir });
            return { content: [{ type: "text" as const, text: [`front build ${p.project} ${cmd}: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-3000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-1000)}` : ""].join("\n") }], isError: !result.ok };
          }
          case "front.dev_server": {
            const projects = findProjects();
            const proj = projects.get(p.project);
            if (!proj) return errText(`Unknown project: ${p.project}`);
            const buildSh = join(proj.dir, "build.sh");
            if (!existsSync(buildSh)) return errText(`No build.sh in ${proj.dir}`);
            const result = exec("sh", [buildSh, p.action], { timeout: 15_000, cwd: proj.dir });
            return { content: [{ type: "text" as const, text: [`front ${p.action} ${p.project}: ${result.ok ? "OK" : "FAILED"}`, result.stdout ? `\n${result.stdout}` : "", result.stderr ? `\nstderr: ${result.stderr}` : ""].join("\n") }], isError: !result.ok };
          }
          case "front.deploy": {
            const deployScript = join(FRONT_DIR, "deploy.sh");
            if (!existsSync(deployScript)) return errText(`deploy.sh not found in ${FRONT_DIR}`);
            const args = [deployScript];
            if (p.phase && p.phase !== "all") args.push(p.phase);
            const result = exec("sh", args, { timeout: 300_000, cwd: FRONT_DIR });
            return { content: [{ type: "text" as const, text: [`front deploy ${p.phase ?? "all"}: ${result.ok ? "SUCCESS" : "FAILED"}`, `Exit code: ${result.exitCode}`, result.stdout ? `\n--- stdout ---\n${result.stdout.slice(-5000)}` : "", result.stderr ? `\n--- stderr ---\n${result.stderr.slice(-2000)}` : ""].join("\n") }], isError: !result.ok };
          }
          // ── workflows ──
          case "workflows.all":
            return safeAsync(async () => {
              const [ghaResult, daguResult] = await Promise.allSettled([workflowsGha(), workflowsDagu()]);
              return [ghaResult.status === "fulfilled" ? ghaResult.value : `GHA ERROR: ${ghaResult.reason}`, "", daguResult.status === "fulfilled" ? daguResult.value : `DAGU ERROR: ${daguResult.reason}`].join("\n");
            });
          case "workflows.gha": return safeAsync(workflowsGha);
          case "workflows.gha_errors": return safeAsync(workflowsGhaErrors);
          case "workflows.gha_ok":
            return safeAsync(async () => {
              const { runs, error } = await ghaRuns24h("success");
              if (error) return `Error: ${error}`;
              if (runs.length === 0) return "No successful runs in the last 24 hours.";
              const rows = runs.map((r) => [r.workflowName.length > 40 ? r.workflowName.slice(0, 40) + "…" : r.workflowName, r.headBranch, timeAgo(r.updatedAt)]);
              return `GHA SUCCESSES — LAST 24H\n${"═".repeat(70)}\n${runs.length} successful run(s)\n\n${formatTable(["Workflow","Branch","When"], rows)}`;
            });
          case "workflows.gha_trigger":
            return safeAsync(async () => {
              if (!p.workflow) { const wfs = await ghaWorkflows(); return `Available workflows:\n${wfs.map((w) => `  ${w.state === "active" ? "+" : "x"} ${w.name} (id: ${w.id})`).join("\n")}`; }
              return workflowsGhaTrigger(p.workflow);
            });
          case "workflows.dagu": return safeAsync(workflowsDagu);
          case "workflows.dagu_errors": return safeAsync(workflowsDaguErrors);
          case "workflows.dagu_ok":
            return safeAsync(async () => {
              const { dags, error } = await daguList();
              if (error) return `Dagu API error: ${error}`;
              const cutoff = Date.now() - 24 * 60 * 60 * 1000;
              const ok = dags.filter((d) => { const st = (d.statusText ?? "").toLowerCase(); const fin = d.finishedAt ? new Date(d.finishedAt).getTime() : 0; return (st === "success" || st === "done") && fin > cutoff; });
              if (ok.length === 0) return "No successful Dagu runs in the last 24 hours.";
              return `DAGU SUCCESSES — LAST 24H\n${"═".repeat(70)}\n${ok.length} successful DAG(s)\n\n${formatTable(["DAG","When"], ok.map((d) => [d.name, d.finishedAt ? timeAgo(d.finishedAt) : "?"]))}`;
            });
          case "workflows.dagu_trigger":
            return safeAsync(async () => {
              if (!p.dag) { const { dags, error } = await daguList(); if (error) return `Dagu API error: ${error}`; return `Available DAGs:\n${dags.map((d) => `  ${d.name} (${d.schedule ?? "manual"})`).join("\n")}`; }
              return workflowsDaguTrigger(p.dag);
            });
          default: return errText(`Unknown method: ${method}`);
        }
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// META-TOOL 2: infra.obs
// ══════════════════════════════════════════════════════════════════════════════

export function registerMetaObs(server: McpServer): void {
  server.tool(
    "infra.obs",
    "Observability / debug: configs-sync data repo files (debug.configs_sync: file, default containers-declared.json), per-app crash/log events (debug.app_logs: kind apk|containers, name, event_kind, since, limit, file), docker logs, VPS CLI proxies (gcloud/oci/gh/wrangler/hcloud/cloudflare/ghcr), container profiles, VM diagnostics, test suites, status/report, DB queries.",
    {
      method: z.enum([
        "db.alert_state","db.alert_update","db.prune",
        "debug.db_audit","debug.db_deploy","debug.db_health_history","debug.db_uptime",
        "debug.app_logs","debug.configs_sync","debug.docker_logs","debug.docker_logs_multi","debug.docker_logs_search",
        "debug.profile_container","debug.profile_service","debug.profile_vm",
        "debug.report","debug.test",
        "debug.vm_disk","debug.vm_journal","debug.vm_network","debug.vm_status","debug.vm_top",
        "debug.vps_cloudflare","debug.vps_gcloud","debug.vps_gh","debug.vps_ghcr",
        "debug.vps_hetzner","debug.vps_oci","debug.vps_wrangler",
      ]).describe("Observability operation"),
      params: z.record(z.unknown()).optional().describe("Operation parameters"),
    },
    async ({ method, params }) => {
      const p = (params ?? {}) as any;
      try {
        switch (method) {
          // ── per-app crash/log route of c3-infra-api: GET /{apk|containers}/{name}/logs ──
          case "debug.app_logs": {
            const kind = p.kind === "containers" ? "containers" : "apk";
            if (typeof p.name !== "string" || !/^[A-Za-z0-9_.-]{1,80}$/.test(p.name)) return errText("Error: name is required (a declared apk label like cloud-drive, or a container name)");
            const q = new URLSearchParams();
            if (p.file) q.set("file", String(p.file));
            else { if (p.event_kind) q.set("kind", String(p.event_kind)); if (p.since) q.set("since", String(p.since)); if (p.limit) q.set("limit", String(Math.floor(p.limit))); }
            const base = process.env.C3_INFRA_API_URL ?? "http://c3-infra-api.mesh.diegonmarcos.com:8081";
            const resp = await fetch(`${base}/${kind}/${p.name}/logs${q.size ? `?${q}` : ""}`, { signal: AbortSignal.timeout(15_000) });
            const body = await resp.text();
            return resp.ok ? text(body) : errText(`Error: HTTP ${resp.status} ${body.slice(0, 300)}`);
          }
          // ── configs-sync data repo (cloud_db_infra-ops-obsv_configs-sync): the engine's published JSONs ──
          case "debug.configs_sync": {
            const file = typeof p.file === "string" ? p.file : "containers-declared.json";
            if (!/^(build\/)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}\.json$/.test(file) || file.includes("..")) return errText("Error: file must be a published *.json name (e.g. containers-declared.json, _cloud-data-consolidated.json, build/build-<app>.json)");
            const raw = process.env.CONFIGS_SYNC_RAW ?? "https://raw.githubusercontent.com/diegonmarcos/cloudy_db_infra-ops-obsv_configs-sync/main/";
            const resp = await fetch(raw + file, { signal: AbortSignal.timeout(20_000) });
            const body = await resp.text();
            return resp.ok ? text(body) : errText(`Error: HTTP ${resp.status} ${body.slice(0, 300)}`);
          }
          // ── docker logs ──
          case "debug.docker_logs": {
            validateContainerName(p.container);
            if (p.since) validateSince(p.since);
            const vmId = resolveVmId(p.vm);
            const safeTail = Math.max(1, Math.min(Math.floor(p.lines ?? 100), 10000));
            let cmd = `docker logs --tail ${safeTail}`;
            if (p.since) cmd += ` --since ${p.since}`;
            cmd += ` ${p.container}`;
            const result = sshExec(vmId, cmd, 15_000);
            const output = (result.stdout + result.stderr).trim();
            return text(`Logs for ${p.container} on ${getVmSshAlias(vmId)}:\n\n${output || "(empty)"}`);
          }
          case "debug.docker_logs_search": { validateContainerName(p.container); const r = logsSearch(p.vm, p.container, p.pattern, p.lines); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          case "debug.docker_logs_multi": { const r = logsMulti(p.service, p.lines); return r.ok ? text(r.output) : errText(`Error: ${r.output}`); }
          // ── profiles ──
          case "debug.profile_container": return jsonText(`Profile ${p.container}`, profileContainer(p.container));
          case "debug.profile_vm": return jsonText(`Profile VM ${p.vm}`, profileVm(resolveVmId(p.vm)));
          case "debug.profile_service": return jsonText(`Profile service: ${p.service}`, profileService(p.service));
          // ── VM diagnostics ──
          case "debug.vm_network": return jsonText(`Network: ${p.vm}`, vmNetwork(resolveVmId(p.vm)));
          case "debug.vm_top": return jsonText(`Top: ${p.vm}`, vmTop(resolveVmId(p.vm)));
          case "debug.vm_disk": return jsonText(`Disk usage: ${p.vm}`, vmDiskUsage(resolveVmId(p.vm)));
          case "debug.vm_journal": return jsonText(`Journal: ${p.vm}`, vmJournal(resolveVmId(p.vm), p.lines, p.unit));
          case "debug.vm_status": return text(getVmStatus(p.vm));
          // ── tests & reports ──
          case "debug.test": return jsonText(`Test suite: ${p.suite}`, runTestSuite(p.suite, p.target));
          case "debug.report": return text(getReport(p.type));
          // ── DB read ──
          case "debug.db_health_history": return jsonText(`Health history: ${p.vm}`, getHealthHistory({ vm: p.vm, limit: p.limit }));
          case "debug.db_uptime": return jsonText(`Uptime report: ${p.vm}`, getUptimeReport(p.vm, p.days ? p.days * 24 : 24 * 7));
          case "debug.db_audit": return jsonText("Audit log", getAuditLog({ tool: p.tool, limit: p.limit }));
          case "debug.db_deploy": return jsonText(`Deploy history${p.service ? `: ${p.service}` : ""}`, getDeployHistory({ service: p.service, limit: p.limit }));
          // ── alert DB (exec) ──
          case "db.alert_state": return jsonText(`Alert state: ${p.vm}`, getAlertState(p.vm));
          case "db.alert_update": updateAlertState(p.vm, p.status, p.notified); return text(`Alert state updated: ${p.vm} → ${p.status} (notified=${p.notified})`);
          case "db.prune": { const r = pruneOldRecords(p.days); return text(`Pruned ${r.healthDeleted + r.auditDeleted + r.deployDeleted} old records (health: ${r.healthDeleted}, audit: ${r.auditDeleted}, deploy: ${r.deployDeleted})`); }
          // ── VPS CLI proxies ──
          case "debug.vps_gcloud": return safeAsync(() => handleVpsCommand("gcloud", p.command ?? "help"));
          case "debug.vps_oci": return safeAsync(() => handleVpsCommand("oci", p.command ?? "help"));
          case "debug.vps_gh": return safeAsync(() => handleVpsCommand("gh", p.command ?? "help"));
          case "debug.vps_wrangler": return safeAsync(() => handleVpsCommand("wrangler", p.command ?? "help"));
          case "debug.vps_hetzner": return safeAsync(() => handleVpsCommand("hcloud", p.command ?? "help"));
          case "debug.vps_cloudflare": return safeAsync(() => handleVpsCommand("cloudflare", p.command ?? "help"));
          case "debug.vps_ghcr": return safeAsync(() => handleVpsCommand("ghcr", p.command ?? "help"));
          default: return errText(`Unknown method: ${method}`);
        }
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// META-TOOL 3: infra.finops
// ══════════════════════════════════════════════════════════════════════════════

export function registerMetaFinops(server: McpServer): void {
  server.tool(
    "infra.finops",
    "Financial operations + health checks + notifications: VPS costs, cloud provider stats, health reports, alerts.",
    {
      method: z.enum([
        "finops.all","finops.assets","finops.aws_costs","finops.aws_instances","finops.aws_resources",
        "finops.cloud_summary","finops.gcp_costs","finops.gcp_costs_by_vm","finops.gcp_costs_history",
        "finops.gcp_instances","finops.gcp_resources","finops.oci_costs","finops.oci_costs_history",
        "finops.oci_instances","finops.oci_resources","finops.services","finops.vps",
        "health.cloud","health.cloud_up","health.deployed","health.mail","health.mail_inbound",
        "health.mail_outbound","health.mail_profile","health.mail_up","health.resources_all",
        "health.resources_db","health.resources_vm","health.status","health.tier1","health.tier2","health.tier3",
        "health.alive","health.declared","health.drift","health.endpoints",
        "notify.cert_expiring","notify.disk_full","notify.health_down","notify.health_recovered","notify.send",
      ]).describe("FinOps / health / notify operation"),
      params: z.record(z.unknown()).optional().describe("Operation parameters"),
    },
    async ({ method, params }) => {
      const p = (params ?? {}) as any;
      try {
        switch (method) {
          // ── finops (from finops.ts) ──
          case "finops.all":
            return safeAsync(async () => {
              const [vps, services, assets] = await Promise.all([finOpsVps(), finOpsServices(), finOpsAssets()]);
              return [vps, "", services, "", assets].join("\n");
            });
          case "finops.vps": return safeAsync(finOpsVps);
          case "finops.services": return safeAsync(finOpsServices);
          case "finops.assets": return safeAsync(finOpsAssets);
          // ── finops cloud (from finops-cloud.ts) ──
          case "finops.oci_instances": return jsonText("OCI instances", oci.listInstances());
          case "finops.gcp_instances": return jsonText("GCP instances", gcp.listInstances());
          case "finops.oci_resources": return jsonText("OCI resources", oci.listResources());
          case "finops.gcp_resources": return jsonText("GCP resources", gcp.listResources());
          case "finops.oci_costs": return jsonText("OCI costs", oci.getCosts());
          case "finops.oci_costs_history": { const m = Math.min(Math.max(p.months ?? 3, 1), 12); return jsonText("OCI cost history", oci.getCostsHistory(m)); }
          case "finops.gcp_costs": return jsonText("GCP costs", gcp.getCosts());
          case "finops.gcp_costs_history": { const m = Math.min(Math.max(p.months ?? 6, 1), 24); return jsonText("GCP cost history", gcp.getCostsHistory(m)); }
          case "finops.gcp_costs_by_vm": { const m = Math.min(Math.max(p.months ?? 6, 1), 24); return jsonText("GCP costs per VM", gcp.getCostsByVm(m)); }
          case "finops.aws_instances": return jsonText("AWS instances", aws.listInstances());
          case "finops.aws_resources": return jsonText("AWS resources", aws.listResources());
          case "finops.aws_costs": return jsonText("AWS costs", aws.getCosts());
          case "finops.cloud_summary": return jsonText("Cloud summary", { oci: { instances: oci.listInstances(), resources: oci.listResources(), costs: oci.getCosts() }, gcp: { instances: gcp.listInstances(), resources: gcp.listResources(), costs: gcp.getCosts() }, aws: { instances: aws.listInstances(), resources: aws.listResources(), costs: aws.getCosts() } });
          // ── health (from observability-read.ts) ──
          case "health.alive": return jsonText("Health: OK", healthAlive());
          case "health.declared": return jsonText("Declared services", healthDeclared());
          case "health.deployed": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Deployed containers", healthDeployed(vmId)); }
          case "health.drift": return jsonText("Config drift", healthDrift());
          case "health.status": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Health status", healthStatus(vmId)); }
          case "health.tier1": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Tier 1 Health", checkTier1All(vmId)); }
          case "health.tier2": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Tier 2 Health", checkTier2All(vmId)); }
          case "health.tier3": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Tier 3 Health", checkTier3All(vmId)); }
          case "health.endpoints": return jsonText("Endpoint Health", healthEndpoints());
          // ── health cloud (from health_cloud.ts) ──
          case "health.cloud":
            return safeAsync(async () => {
              const md = await triggerAndReadFile("daily", "cloud_health_daily.md", FRESH_CLOUD_TIMEOUT);
              return md || "(empty report — check dagu logs)";
            });
          case "health.cloud_up":
            return safeAsync(async () => {
              const md = p.fresh ? await triggerAndReadFile("daily", "cloud_health_daily.md", FRESH_CLOUD_TIMEOUT) : await readCachedFile("cloud_health_daily.md");
              if (!md.trim()) return "(no report on disk — call health.cloud first)";
              const summary = extractCloudSection(md, "## Executive Summary", "\n---\n");
              const issues = extractCloudSection(md, "### Top Issues", "\n---\n");
              const header = md.split("\n").slice(0, 10).join("\n");
              return [header, summary, issues].filter(Boolean).join("\n\n");
            });
          case "health.resources_all":
            return safeAsync(async () => {
              const raw = await readCachedFile("cloud_health_daily.json");
              if (!raw.trim()) return "(no report on disk — call health.cloud first)";
              const j = JSON.parse(raw);
              return JSON.stringify({ date: j.date, time: j.time, fleet_running: j.fleet_running, fleet_total: j.fleet_total, fleet_unhealthy: j.fleet_unhealthy, exec_summary: j.exec_summary, vms: (j.vms ?? []).map((v: Record<string, unknown>) => ({ name: v.name, ip: v.ip, status: v.status, disk_pct: v.disk_pct, mem_pct: v.mem_pct, load: v.load, uptime: v.uptime, containers_running: v.containers_running, containers_total: v.containers_total, containers_unhealthy: v.containers_unhealthy })) }, null, 2);
            });
          case "health.resources_vm":
            return safeAsync(async () => {
              const raw = await readCachedFile("cloud_health_daily.json");
              if (!raw.trim()) return "(no report on disk — call health.cloud first)";
              const j = JSON.parse(raw);
              const hit = (j.vms ?? []).find((v: Record<string, unknown>) => v.name === p.vm || v.ip === p.vm);
              if (!hit) return `VM "${p.vm}" not found. Available: ${(j.vms ?? []).map((v: { name: string }) => v.name).join(", ")}`;
              return JSON.stringify(hit, null, 2);
            });
          case "health.resources_db":
            return safeAsync(async () => {
              const raw = await readCachedFile("cloud_health_daily.json");
              if (!raw.trim()) return "(no report on disk — call health.cloud first)";
              return JSON.stringify(JSON.parse(raw).databases ?? [], null, 2);
            });
          // ── health mail (from health_mail.ts) ──
          case "health.mail":
            return safeAsync(async () => {
              const md = await triggerAndReadFile("mail", "cloud_mail_full.md", FRESH_MAIL_TIMEOUT);
              return md || "(empty report — check dagu logs)";
            });
          case "health.mail_up":
            return safeAsync(async () => {
              const md = p.fresh ? await triggerAndReadFile("mail", "cloud_mail_full.md", FRESH_MAIL_TIMEOUT) : await readCachedFile("cloud_mail_full.md");
              if (!md.trim()) return "(no mail report on disk — call health.mail first)";
              return md.split("\n").slice(0, 20).join("\n");
            });
          case "health.mail_profile":
            return safeAsync(async () => {
              const raw = await readCachedFile("cloud_mail_full.json");
              return raw || "(no mail report on disk — call health.mail first)";
            });
          case "health.mail_inbound":
            return safeAsync(async () => {
              const md = await readCachedFile("cloud_mail_full.md");
              if (!md.trim()) return "(no mail report on disk — call health.mail first)";
              const a = extractMailSection(md, "6\\. E2E DELIVERY");
              const b = extractMailSection(md, "4\\. DNS AUTH");
              return [a, b].filter(Boolean).join("\n\n") || "(section not found in report)";
            });
          case "health.mail_outbound":
            return safeAsync(async () => {
              const md = await readCachedFile("cloud_mail_full.md");
              if (!md.trim()) return "(no mail report on disk — call health.mail first)";
              const tier0 = extractMailSection(md, "Tier 0: Path Checker");
              const dns = extractMailSection(md, "4\\. DNS AUTH");
              return (tier0 + "\n\n" + dns).trim() || md.split("\n").slice(0, 40).join("\n");
            });
          // ── notify (from observability.ts) ──
          case "notify.send": { const r = sendNotification({ title: p.title, message: p.message, priority: p.priority, tags: p.tags }); return r.ok ? text("Notification sent") : errText(`Error: ${r.error}`); }
          case "notify.health_down": { const r = alertHealthDown(p.target, p.details ?? ""); return r.ok ? text("Alert sent") : errText(`Error: ${(r as any).error}`); }
          case "notify.health_recovered": { const r = alertHealthRecovered(p.target); return r.ok ? text("Alert sent") : errText(`Error: ${r.error}`); }
          case "notify.cert_expiring": { const r = alertCertExpiring(p.domain, p.daysRemaining); return r.ok ? text("Alert sent") : errText(`Error: ${r.error}`); }
          case "notify.disk_full": { const r = alertDiskFull(p.vm, p.percent); return r.ok ? text("Alert sent") : errText(`Error: ${r.error}`); }
          default: return errText(`Unknown method: ${method}`);
        }
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// META-TOOL 4: infra.sec
// ══════════════════════════════════════════════════════════════════════════════

export function registerMetaSec(server: McpServer): void {
  server.tool(
    "infra.sec",
    "Security operations: full audit, Docker security, SSH keys, token scan, topology, secrets status. Owner-authorized security testing of OWN services: Steel Browser (sec.steel_*) and OWASP ZAP (sec.zap_*), every target gated by the declared allowlist.",
    {
      method: z.enum([
        "sec.all","sec.docker","sec.scan","sec.secrets_status","sec.ssh_keys","sec.tokens","sec.topology",
        "sec.steel_health","sec.steel_session_create","sec.steel_navigate","sec.steel_screenshot","sec.steel_scrape",
        "sec.zap_health","sec.zap_context_sync","sec.zap_spider","sec.zap_ajax_spider","sec.zap_active_scan","sec.zap_alerts","sec.zap_report",
      ]).describe("Security operation"),
      params: z.record(z.unknown()).optional().describe("Operation parameters"),
    },
    async ({ method, params }) => {
      const p = (params ?? {}) as any;
      try {
        if (method.startsWith("sec.steel_") || method.startsWith("sec.zap_")) {
          return await handleSteelZap(method.replace(/^sec\./, ""), p);
        }
        switch (method) {
          case "sec.all": {
            const config = getConfig();
            const vmIds = Object.keys(config.vms);
            const sections: string[] = [];
            const scanResult = securityScan();
            sections.push(`SECURITY SCAN (all VMs)\n${"─".repeat(60)}\n${typeof scanResult === "string" ? scanResult : JSON.stringify(scanResult, null, 2)}`);
            for (const vmId of vmIds) {
              try { const r = securityDocker(vmId); sections.push(`\nDOCKER SECURITY: ${vmId}\n${"─".repeat(60)}\n${typeof r === "string" ? r : JSON.stringify(r, null, 2)}`); }
              catch (e) { sections.push(`\nDOCKER SECURITY: ${vmId} — FAILED: ${e}`); }
            }
            for (const vmId of vmIds) {
              try { const r = securitySshKeys(vmId); sections.push(`\nSSH KEYS: ${vmId}\n${"─".repeat(60)}\n${typeof r === "string" ? r : JSON.stringify(r, null, 2)}`); }
              catch (e) { sections.push(`\nSSH KEYS: ${vmId} — FAILED: ${e}`); }
            }
            const tokenResult = securityTokens();
            sections.push(`\nTOKEN SCAN\n${"─".repeat(60)}\n${typeof tokenResult === "string" ? tokenResult : JSON.stringify(tokenResult, null, 2)}`);
            return text(sections.join("\n\n"));
          }
          case "sec.scan": { const vmId = p.vm ? resolveVmId(p.vm) : undefined; return jsonText("Security scan results", securityScan(vmId)); }
          case "sec.docker": return jsonText(`Docker security: ${p.vm}`, securityDocker(resolveVmId(p.vm)));
          case "sec.ssh_keys": return jsonText(`SSH keys: ${p.vm}`, securitySshKeys(resolveVmId(p.vm)));
          case "sec.tokens": return jsonText("Token scan", securityTokens());
          case "sec.topology": {
            const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
            const exposed = Object.entries(topo.services as Record<string, any>).filter(([, s]) => (s as any).domain).map(([name, s]: [string, any]) => ({ name, domain: s.domain, vm: s.vm }));
            return jsonText("Security topology", { exposedServices: exposed, wireguard: topo.wireguard, firewalls: topo.firewalls, os_firewalls: topo.os_firewalls });
          }
          case "sec.secrets_status": return text(getSecretsStatus(p.service));
          default: return errText(`Unknown method: ${method}`);
        }
      } catch (e) { return errText(`Error: ${e instanceof Error ? e.message : String(e)}`); }
    }
  );
}
