import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { authPlugin } from "./plugins/auth.js";
import { errorHandler } from "./plugins/error-handler.js";

// ── 6 Pillars ────────────────────────────────────
import { registerInventoryRoutes } from "./routes/inventory.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerSecurityRoutes } from "./routes/security.js";
import { registerFinOpsRoutes } from "./routes/finops.js";
import { registerPublicLogsRoutes } from "./routes/publicLogs.js";
import { registerAppLogsRoutes } from "./routes/appLogs.js";
import { registerFleetProfileRoutes } from "./routes/fleetProfile.js";
import { registerMetricsRoutes } from "./routes/metrics.js";
import { registerLogsRoutes } from "./routes/logs.js";
import { registerAlertsRoutes } from "./routes/alerts.js";
import { registerEventsRoutes } from "./routes/events.js";
import { registerReportsRoutes } from "./routes/reports.js";
import { registerWorkflowsRoutes } from "./routes/workflows.js";
import { registerConfigsSyncRoutes } from "./routes/configsSync.js";
import { registerAiUsageRoutes } from "./routes/aiUsage.js";
import { startPoller } from "../shared/libs/poller.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: "info" },
  });

  // CORS
  await app.register(cors, { origin: true, credentials: true });

  // OpenAPI / Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: "C3 — Cloud Control Center API",
        version: "3.0.0",
        description: "Unified API for cloud infrastructure management. Replaces the Rust API.",
      },
      tags: [
        { name: "Inventory", description: "Service catalog, topology, config, and discovery" },
        { name: "Delivery", description: "Build, deploy, and CI/CD pipeline" },
        { name: "Operations", description: "VM, container, and service lifecycle control" },
        { name: "Observability", description: "Health, profiling, diagnostics, testing, and alerting" },
        { name: "Security", description: "Security scanning, auditing, and compliance" },
        { name: "FinOps", description: "Cloud provider operations and cost tracking" },
        { name: "Metrics", description: "Time-series metrics: query, series, top consumers" },
        { name: "Logs", description: "Log search and live tail" },
        { name: "Alerts", description: "Alert rules, active alerts, and history" },
        { name: "AI", description: "Claude and OpenRouter usage for the SuperApp AI card" },
        { name: "Events", description: "Unified timeline of deploys, alerts, ops actions, and CI runs" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // Auth
  await app.register(authPlugin);

  // Error handler
  app.setErrorHandler(errorHandler);

  // Routes (no prefix — Caddy handle_path /c3-api/* strips the prefix)
  // Note: Delivery pillar is MCP-only (build/deploy), no REST routes
  await app.register(registerInventoryRoutes);
  await app.register(registerOperationsRoutes);
  await app.register(registerObservabilityRoutes);
  await app.register(registerSecurityRoutes);
  await app.register(registerFinOpsRoutes);
  await app.register(registerPublicLogsRoutes);
  await app.register(registerAppLogsRoutes);
  await app.register(registerFleetProfileRoutes);
  await app.register(registerMetricsRoutes);
  await app.register(registerLogsRoutes);
  await app.register(registerAlertsRoutes);
  await app.register(registerEventsRoutes);
  await app.register(registerReportsRoutes);
  await app.register(registerWorkflowsRoutes);
  await app.register(registerConfigsSyncRoutes);
  await app.register(registerAiUsageRoutes);

  // Background poller tick (metrics sampler + alert evaluator + SSE health
  // broadcast all hook onto this single tick — see shared/libs/poller.ts).
  // NOTE: this was never actually started anywhere before this change, even
  // though metrics.ts/alerts.ts already assumed it ran — starting it here.
  startPoller();

  return app;
}
