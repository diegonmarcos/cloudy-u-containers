// ── Observability Routes — "How it's doing" ──
// Health, profiling, diagnostics, testing, alerting, database

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  healthAlive,
  healthDeclared,
  healthDeployed,
  healthDrift,
  healthStatus,
  checkTier1All,
  checkTier2All,
  checkTier3All,
  checkUp,
  checkHealth,
  checkReach,
} from "../../shared/libs/health.js";
import {
  up, upAll, upAllContainers,
  health, healthAll,
  profile, profileAllServices, profileAllContainers,
} from "../../shared/libs/obs.js";
import { cacheRead, cachePrune, startCacheCleanup } from "../../shared/libs/cache.js";
import { profileContainer, profileVm } from "../../shared/libs/diagnostics.js";
import { runTestSuite } from "../../shared/libs/tests.js";
import { getContainerLog, getVmStatus, getReport } from "../../shared/libs/files.js";
import {
  sendNotification,
  alertHealthDown,
  alertHealthRecovered,
  alertCertExpiring,
  alertDiskFull,
} from "../../shared/libs/notify.js";
import {
  getHealthHistory,
  getUptimeReport,
  getAuditLog,
  getDeployHistory,
  getAlertState,
  updateAlertState,
  pruneOldRecords,
} from "../../shared/libs/db.js";
import { resolveVmId } from "../../shared/libs/config.js";
import { DAGU_API, DAGU_API_PATH, daguHeaders } from "../../shared/libs/ops.js";
import { pollerEvents, getLastFleetHealthSnapshot, type FleetHealthSnapshot } from "../../shared/libs/poller.js";

// ── Zod schemas for validated endpoints ──

const sendSchema = z.object({
  title: z.string(),
  message: z.string(),
  priority: z.enum(["min", "low", "default", "high", "urgent"]).optional(),
  tags: z.array(z.string()).optional(),
});

const healthDownSchema = z.object({
  target: z.string(),
  details: z.string().optional(),
});

const healthRecoveredSchema = z.object({
  target: z.string(),
});

const certExpiringSchema = z.object({
  domain: z.string(),
  daysRemaining: z.number(),
});

const diskFullSchema = z.object({
  vm: z.string(),
  percent: z.string(),
});

const healthHistorySchema = z.object({
  vm: z.string(),
  limit: z.number().optional(),
});

const uptimeReportSchema = z.object({
  vm: z.string(),
  days: z.number().optional(),
});

const auditLogSchema = z.object({
  tool: z.string().optional(),
  target: z.string().optional(),
  limit: z.number().optional(),
});

const deployHistorySchema = z.object({
  service: z.string().optional(),
  limit: z.number().optional(),
});

const alertStateSchema = z.object({
  vm: z.string(),
});

const alertUpdateSchema = z.object({
  vm: z.string(),
  status: z.string(),
  notified: z.boolean(),
});

const pruneSchema = z.object({
  days: z.number().optional(),
});

type SuiteName = "connectivity" | "dns" | "tls" | "routes" | "containers" | "wireguard" | "full" | "deploy";
const VALID_SUITES = new Set<string>(["connectivity", "dns", "tls", "routes", "containers", "wireguard", "full", "deploy"]);

const P_vmId = { type: "object" as const, properties: { vmId: { type: "string" as const } }, required: ["vmId"] };
const P_target = { type: "object" as const, properties: { target: { type: "string" as const } }, required: ["target"] };
const P_container = { type: "object" as const, properties: { container: { type: "string" as const } }, required: ["container"] };
const P_suite = { type: "object" as const, properties: { suite: { type: "string" as const } }, required: ["suite"] };
const P_suiteTarget = { type: "object" as const, properties: { suite: { type: "string" as const }, target: { type: "string" as const } }, required: ["suite", "target"] };
const P_vmContainer = { type: "object" as const, properties: { vmId: { type: "string" as const }, container: { type: "string" as const } }, required: ["vmId", "container"] };
const P_type = { type: "object" as const, properties: { type: { type: "string" as const } }, required: ["type"] };

export const registerObservabilityRoutes: FastifyPluginAsync = async (app) => {
  // ── Health (from health.ts) ──

  app.get("/health", { schema: { tags: ["Observability"] } }, async () => {
    return healthAlive();
  });

  app.get("/health/declared", { schema: { tags: ["Observability"] } }, async () => {
    return healthDeclared();
  });

  app.get("/health/deployed", { schema: { tags: ["Observability"] } }, async () => {
    return healthDeployed();
  });

  app.get<{ Params: { vmId: string } }>(
    "/health/deployed/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return healthDeployed(vmId);
    },
  );

  app.get("/health/drift", { schema: { tags: ["Observability"] } }, async () => {
    return healthDrift();
  });

  app.get("/health/status", { schema: { tags: ["Observability"] } }, async () => {
    return healthStatus();
  });

  app.get<{ Params: { vmId: string } }>(
    "/health/status/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return healthStatus(vmId);
    },
  );

  // Tiered health
  app.get("/health/tier1", { schema: { tags: ["Observability"] } }, async () => {
    return checkTier1All();
  });

  app.get<{ Params: { vmId: string } }>(
    "/health/tier1/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return checkTier1All(vmId);
    },
  );

  app.get("/health/tier2", { schema: { tags: ["Observability"] } }, async () => {
    return checkTier2All();
  });

  app.get<{ Params: { vmId: string } }>(
    "/health/tier2/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return checkTier2All(vmId);
    },
  );

  app.get("/health/tier3", { schema: { tags: ["Observability"] } }, async () => {
    return checkTier3All();
  });

  app.get<{ Params: { vmId: string } }>(
    "/health/tier3/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return checkTier3All(vmId);
    },
  );

  // ── Generic /up and /health — works for VMs, services, and containers ──

  app.get<{ Params: { target: string } }>(
    "/up/:target",
    {
      schema: {
        tags: ["Observability"],
        params: P_target,
        summary: "Quick TCP check — is the target up? (VM, service, or container)",
        description: "Fast check: VM=ssh-keyscan, service=VM reachable+containers running, container=docker state",
      },
    },
    async (req) => {
      return checkUp(req.params.target);
    },
  );

  app.get<{ Params: { target: string } }>(
    "/health/:target",
    {
      schema: {
        tags: ["Observability"],
        params: P_target,
        summary: "Full health check — SSH + docker health (VM, service, or container)",
        description: "Deep check: VM=full SSH auth, service=SSH+docker inspect health, container=docker health status",
      },
    },
    async (req) => {
      return checkHealth(req.params.target);
    },
  );

  app.get<{ Params: { target: string } }>(
    "/reach/:target",
    {
      schema: {
        tags: ["Observability"],
        params: P_target,
        summary: "Route reachability — probe HTTPS/HTTP/TCP through Caddy",
        description: "Tests actual route: looks up service domain from topology, probes HTTPS → HTTP → TCP. Verifies the full path (Cloudflare → Caddy → service) is working.",
      },
    },
    async (req) => {
      return checkReach(req.params.target);
    },
  );

  // ── Profiling (from profiling.ts) ──

  app.get<{ Params: { container: string } }>(
    "/profiling/:container",
    { schema: { tags: ["Observability"], params: P_container } },
    async (req) => {
      return profileContainer(req.params.container);
    },
  );

  app.get<{ Params: { vmId: string } }>(
    "/profiling/vm/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return profileVm(vmId);
    },
  );

  // ── Tests (from tests.ts) ──

  app.get<{ Params: { suite: string } }>(
    "/tests/run/:suite",
    { schema: { tags: ["Observability"], params: P_suite } },
    async (req, reply) => {
      const { suite } = req.params;
      if (!VALID_SUITES.has(suite)) {
        reply.code(400).send({ error: `Invalid suite: ${suite}. Valid: ${Array.from(VALID_SUITES).join(", ")}` });
        return;
      }
      return runTestSuite(suite as SuiteName);
    },
  );

  app.get<{ Params: { suite: string; target: string } }>(
    "/tests/run/:suite/:target",
    { schema: { tags: ["Observability"], params: P_suiteTarget } },
    async (req, reply) => {
      const { suite, target } = req.params;
      if (!VALID_SUITES.has(suite)) {
        reply.code(400).send({ error: `Invalid suite: ${suite}. Valid: ${Array.from(VALID_SUITES).join(", ")}` });
        return;
      }
      return runTestSuite(suite as SuiteName, target);
    },
  );

  // Convenience shortcuts
  for (const suite of VALID_SUITES) {
    app.get(`/tests/${suite}`, { schema: { tags: ["Observability"] } }, async () => {
      return runTestSuite(suite as SuiteName);
    });
  }

  // ── Workflows (GitHub Actions) ──

  app.get("/workflows", { schema: { tags: ["Observability"] } }, async () => {
    try {
      const resp = await fetch(
        "https://api.github.com/repos/diegonmarcos/cloudy-t-infra/actions/runs?per_page=15",
        { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) },
      );
      if (!resp.ok) return { runs: [], error: `GitHub API ${resp.status}` };
      const data = await resp.json() as { workflow_runs: Array<Record<string, unknown>> };
      return {
        runs: (data.workflow_runs || []).map((r: Record<string, unknown>) => ({
          name: r.name,
          branch: r.head_branch,
          status: r.status,
          conclusion: r.conclusion,
          created_at: r.created_at,
          url: r.html_url,
        })),
      };
    } catch (e: unknown) {
      return { runs: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Workflows (Dagu DAGs) ──

  app.get("/workflows/dagu", { schema: { tags: ["Observability"] } }, async () => {
    try {
      // Was hardcoded to /api/v2/dags — confirmed live against the deployed
      // server (2026-09-06) that path answers the SPA's index.html (HTTP 200
      // text/html), not JSON, because the deployed Dagu serves its REST API
      // at /api/v1 (the SPA's own getConfig() reports apiURL: "/api/v1").
      // resp.json() below was throwing on every call and this endpoint has
      // been silently returning `{dags: [], error: ...}` regardless of
      // what Dagu actually has registered. DAGU_API_PATH already resolves
      // to the correct, data-driven base path (shared/libs/ops.ts) — this
      // was the one caller still bypassing it with its own hardcoded guess.
      const resp = await fetch(
        `${DAGU_API}${DAGU_API_PATH}/dags`,
        { signal: AbortSignal.timeout(10000), headers: daguHeaders() },
      );
      if (!resp.ok) return { dags: [], error: `Dagu API ${resp.status}` };
      const data = await resp.json() as { dags?: Array<Record<string, unknown>> };
      return {
        dags: (data.dags || []).map((d: Record<string, unknown>) => {
          const dag = d.dag as Record<string, unknown> | undefined;
          const run = d.latestDAGRun as Record<string, unknown> | undefined;
          return {
            name: dag?.name ?? d.fileName,
            schedule: dag?.schedule ? (dag.schedule as Array<Record<string, unknown>>).map((s) => s.expression).join(", ") : "",
            status: run?.statusLabel ?? null,
            startedAt: run?.startedAt ?? null,
            finishedAt: run?.finishedAt ?? null,
            dagRunId: run?.dagRunId ?? null,
            suspended: d.suspended ?? false,
          };
        }),
      };
    } catch (e: unknown) {
      return { dags: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── Files: logs, status, reports (from files.ts) ──

  app.get<{ Params: { vmId: string; container: string }; Querystring: { lines?: string; since?: string } }>(
    "/files/logs/:vmId/:container",
    { schema: { tags: ["Observability"], params: P_vmContainer } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      const lines = req.query.lines ? parseInt(req.query.lines, 10) : undefined;
      return { content: getContainerLog(vmId, req.params.container, lines, req.query.since) };
    },
  );

  app.get<{ Params: { vmId: string } }>(
    "/files/status/:vmId",
    { schema: { tags: ["Observability"], params: P_vmId } },
    async (req) => {
      const vmId = resolveVmId(req.params.vmId);
      return { content: getVmStatus(vmId) };
    },
  );

  app.get<{ Params: { type: string } }>(
    "/files/report/:type",
    { schema: { tags: ["Observability"], params: P_type } },
    async (req) => {
      return { content: getReport(req.params.type) };
    },
  );

  // ── Notifications (from notify.ts) ──

  app.post(
    "/notify/send",
    {
      schema: {
        tags: ["Observability"],
        summary: "Send a push notification",
        body: zodToJsonSchema(sendSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const data = sendSchema.parse(req.body);
      return sendNotification(data);
    }
  );

  app.post(
    "/notify/health/down",
    {
      schema: {
        tags: ["Observability"],
        summary: "Alert for VM/service down",
        body: zodToJsonSchema(healthDownSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { target, details } = healthDownSchema.parse(req.body);
      return alertHealthDown(target, details ?? "");
    }
  );

  app.post(
    "/notify/health/recovered",
    {
      schema: {
        tags: ["Observability"],
        summary: "Alert for VM/service recovery",
        body: zodToJsonSchema(healthRecoveredSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { target } = healthRecoveredSchema.parse(req.body);
      return alertHealthRecovered(target);
    }
  );

  app.post(
    "/notify/cert/expiring",
    {
      schema: {
        tags: ["Observability"],
        summary: "Alert for expiring TLS certificate",
        body: zodToJsonSchema(certExpiringSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { domain, daysRemaining } = certExpiringSchema.parse(req.body);
      return alertCertExpiring(domain, daysRemaining);
    }
  );

  app.post(
    "/notify/disk/full",
    {
      schema: {
        tags: ["Observability"],
        summary: "Alert for disk space warning",
        body: zodToJsonSchema(diskFullSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { vm, percent } = diskFullSchema.parse(req.body);
      return alertDiskFull(vm, percent);
    }
  );

  // ── Database (from database.ts) ──

  app.get(
    "/db/health/history",
    {
      schema: {
        tags: ["Observability"],
        summary: "Get health check history for a VM",
        querystring: zodToJsonSchema(healthHistorySchema),
        response: { 200: { type: "array" } },
      },
    },
    async (req) => {
      const { vm, limit } = healthHistorySchema.parse(req.query);
      return getHealthHistory({ vm, limit });
    }
  );

  app.get(
    "/db/uptime/report",
    {
      schema: {
        tags: ["Observability"],
        summary: "Get uptime statistics for a VM",
        querystring: zodToJsonSchema(uptimeReportSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { vm, days } = uptimeReportSchema.parse(req.query);
      return getUptimeReport(vm, days);
    }
  );

  app.get(
    "/db/audit",
    {
      schema: {
        tags: ["Observability"],
        summary: "Get audit log entries",
        querystring: zodToJsonSchema(auditLogSchema),
        response: { 200: { type: "array" } },
      },
    },
    async (req) => {
      const { tool, limit } = auditLogSchema.parse(req.query);
      return getAuditLog({ tool, limit });
    }
  );

  app.get(
    "/db/deploy/history",
    {
      schema: {
        tags: ["Observability"],
        summary: "Get deployment history",
        querystring: zodToJsonSchema(deployHistorySchema),
        response: { 200: { type: "array" } },
      },
    },
    async (req) => {
      const { service, limit } = deployHistorySchema.parse(req.query);
      return getDeployHistory({ service, limit });
    }
  );

  app.get(
    "/db/alert/state",
    {
      schema: {
        tags: ["Observability"],
        summary: "Get current alert state",
        querystring: zodToJsonSchema(alertStateSchema),
        response: { 200: { type: "object", nullable: true } },
      },
    },
    async (req) => {
      const { vm } = alertStateSchema.parse(req.query);
      return getAlertState(vm);
    }
  );

  app.post(
    "/db/alert/update",
    {
      schema: {
        tags: ["Observability"],
        summary: "Update alert state",
        body: zodToJsonSchema(alertUpdateSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { vm, status, notified } = alertUpdateSchema.parse(req.body);
      updateAlertState(vm, status, notified);
      return { ok: true, vm, status, notified };
    }
  );

  app.post(
    "/db/prune",
    {
      schema: {
        tags: ["Observability"],
        summary: "Remove old records from database",
        body: zodToJsonSchema(pruneSchema),
        response: { 200: { type: "object" } },
      },
    },
    async (req) => {
      const { days } = pruneSchema.parse(req.body);
      const result = pruneOldRecords(days);
      return { ok: true, ...result };
    }
  );

  // ── v2: Async observability engine ──────────────────────────────────────

  startCacheCleanup();

  // UP
  app.get("/v2/up/:target", {
    schema: { tags: ["Observability v2"], summary: "Fast UP check (TCP+HTTP+ping+docker)", params: P_target },
  }, async (req) => up((req.params as { target: string }).target));

  app.get("/v2/up/all-services", {
    schema: { tags: ["Observability v2"], summary: "UP check all services in parallel" },
  }, async () => upAll());

  app.get("/v2/up/all-containers", {
    schema: { tags: ["Observability v2"], summary: "UP check all containers in parallel" },
  }, async () => upAllContainers());

  // HEALTH
  app.get("/v2/health/:target", {
    schema: { tags: ["Observability v2"], summary: "Health check with auto-profiling on failure", params: P_target },
  }, async (req) => health((req.params as { target: string }).target));

  app.get("/v2/health/all-services", {
    schema: { tags: ["Observability v2"], summary: "Health check all services" },
  }, async () => healthAll());

  // PROFILING
  app.get("/v2/profiling/:target", {
    schema: { tags: ["Observability v2"], summary: "Deep 4-engine profiling", params: P_target },
  }, async (req) => profile((req.params as { target: string }).target));

  app.get("/v2/profiling/all-services", {
    schema: { tags: ["Observability v2"], summary: "Profile all services" },
  }, async () => profileAllServices());

  app.get("/v2/profiling/all-containers", {
    schema: { tags: ["Observability v2"], summary: "Profile all containers" },
  }, async () => profileAllContainers());

  // CACHE
  app.get("/v2/cache", {
    schema: { tags: ["Observability v2"], summary: "List cached results" },
  }, async (req) => {
    const endpoint = (req.query as { endpoint?: string }).endpoint;
    const target = (req.query as { target?: string }).target;
    const limit = parseInt((req.query as { limit?: string }).limit ?? "10", 10);
    return cacheRead(endpoint ?? "*", target ?? "*", limit);
  });

  app.get("/v2/cache/:endpoint/:target", {
    schema: { tags: ["Observability v2"], summary: "Get cached results for endpoint+target" },
  }, async (req) => {
    const { endpoint, target } = req.params as { endpoint: string; target: string };
    return cacheRead(endpoint, target, 10);
  });

  app.post("/v2/cache/prune", {
    schema: { tags: ["Observability v2"], summary: "Prune cached files older than 7 days" },
  }, async () => {
    const pruned = cachePrune();
    return { ok: true, pruned };
  });

  // ── SLO: uptime % vs target + error budget, derived from getUptimeReport ──
  // (same uptime source as /db/uptime/report above — not refetched independently)

  const DEFAULT_SLO_TARGET = 99.9;
  const DEFAULT_SLO_HOURS = 24 * 30; // 30d window

  function computeSlo(vm: string | undefined, targetPercent: number, hours: number) {
    const rows = getUptimeReport(vm, hours);
    return rows.map((r) => {
      const errorBudgetPercent = 100 - targetPercent; // allowed downtime %, e.g. 0.1
      const consumedPercent = Math.max(0, 100 - r.uptimePercent);
      const remainingPercent = errorBudgetPercent - consumedPercent;
      const remainingBudgetPercentOfBudget = errorBudgetPercent > 0
        ? Math.round((remainingPercent / errorBudgetPercent) * 10000) / 100
        : null;
      return {
        vm: r.vm,
        target: targetPercent,
        uptimePercent: r.uptimePercent,
        checks: r.checks,
        windowHours: hours,
        errorBudgetPercent,
        errorBudgetConsumedPercent: Math.round(consumedPercent * 10000) / 10000,
        errorBudgetRemainingPercent: Math.round(remainingPercent * 10000) / 10000,
        errorBudgetRemainingPercentOfBudget: remainingBudgetPercentOfBudget,
        breached: remainingPercent < 0,
      };
    });
  }

  app.get<{ Querystring: { target?: string; hours?: string } }>(
    "/slo",
    {
      schema: {
        tags: ["Observability"],
        summary: "Uptime % vs target + error budget remaining, for every VM",
        querystring: {
          type: "object" as const,
          properties: {
            target: { type: "string" as const, description: "SLO target percent, default 99.9" },
            hours: { type: "string" as const, description: "Lookback window in hours, default 720 (30d)" },
          },
        },
      },
    },
    async (req) => {
      const target = req.query.target ? parseFloat(req.query.target) : DEFAULT_SLO_TARGET;
      const hours = req.query.hours ? parseInt(req.query.hours, 10) : DEFAULT_SLO_HOURS;
      return { slos: computeSlo(undefined, target, hours) };
    },
  );

  app.get<{ Params: { service: string }; Querystring: { target?: string; hours?: string } }>(
    "/slo/:service",
    {
      schema: {
        tags: ["Observability"],
        summary: "Uptime % vs target + error budget remaining, for one service/VM",
        params: { type: "object" as const, properties: { service: { type: "string" as const } }, required: ["service"] },
        querystring: {
          type: "object" as const,
          properties: {
            target: { type: "string" as const },
            hours: { type: "string" as const },
          },
        },
      },
    },
    async (req, reply) => {
      const target = req.query.target ? parseFloat(req.query.target) : DEFAULT_SLO_TARGET;
      const hours = req.query.hours ? parseInt(req.query.hours, 10) : DEFAULT_SLO_HOURS;
      const slos = computeSlo(req.params.service, target, hours);
      if (slos.length === 0) {
        reply.code(404).send({ error: `No health-check history for ${req.params.service}` });
        return;
      }
      return slos[0];
    },
  );

  // ── SSE: fleet health pushed on the shared poller tick ──
  // Same hook pattern as the metrics sampler / alert evaluator: subscribe to
  // pollerEvents ("health" is emitted once per tick in poller.ts's runTick()),
  // no separate interval is started here.

  app.get("/stream/health", { schema: { tags: ["Observability"], summary: "SSE stream of fleet health snapshots, pushed on each poller tick" } }, async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const write = (snapshot: FleetHealthSnapshot) => {
      reply.raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
    };

    const last = getLastFleetHealthSnapshot();
    if (last) write(last);

    const onHealth = (snapshot: FleetHealthSnapshot) => write(snapshot);
    pollerEvents.on("health", onHealth);

    req.raw.on("close", () => {
      pollerEvents.off("health", onHealth);
    });
  });
};
