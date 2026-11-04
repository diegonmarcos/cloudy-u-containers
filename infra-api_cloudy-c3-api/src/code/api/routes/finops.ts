// ── FinOps Routes — "What it costs" ──
// Cloud provider operations and cost tracking

import type { FastifyInstance } from "fastify";
import * as oci from "../../shared/libs/cloud/oci.js";
import * as gcp from "../../shared/libs/cloud/gcp.js";

export async function registerFinOpsRoutes(app: FastifyInstance) {
  app.get("/cloud/oci/instances", { schema: { tags: ["FinOps"] } }, async () => {
    return oci.listInstances();
  });

  app.get("/cloud/gcp/instances", { schema: { tags: ["FinOps"] } }, async () => {
    return gcp.listInstances();
  });

  app.get("/cloud/oci/resources", { schema: { tags: ["FinOps"] } }, async () => {
    return oci.listResources();
  });

  app.get("/cloud/gcp/resources", { schema: { tags: ["FinOps"] } }, async () => {
    return gcp.listResources();
  });

  app.get("/cloud/oci/costs", { schema: { tags: ["FinOps"] } }, async () => {
    return oci.getCosts();
  });

  app.get("/cloud/gcp/costs", { schema: { tags: ["FinOps"] } }, async () => {
    return gcp.getCosts();
  });

  app.get("/cloud/summary", { schema: { tags: ["FinOps"] } }, async () => {
    const safe = <T>(fn: () => T): T | { ok: false; error: string } => {
      try { return fn(); }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    };
    return {
      oci: {
        instances: safe(() => oci.listInstances()),
        resources: safe(() => oci.listResources()),
        costs: safe(() => oci.getCosts()),
      },
      gcp: {
        instances: safe(() => gcp.listInstances()),
        resources: safe(() => gcp.listResources()),
        costs: safe(() => gcp.getCosts()),
      },
    };
  });
}
