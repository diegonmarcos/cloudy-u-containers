// ── Alerts Routes — rule CRUD, active alerts, ack, history ──
// Reuses the same alert_history "fired/resolved" concept as the existing
// alert_state table (see /db/alert/state, /db/alert/update in observability.ts)
// but for rule-based metric thresholds rather than a single vm up/down flag.
// The evaluator runs on the shared poller tick (shared/libs/poller.ts) and
// fires through the existing notify.ts / ntfy sink — no new notification path.

import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  listAlertRules,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  getActiveAlerts,
  getAlertHistory,
  ackAlert,
  type AlertOp,
  type MetricName,
} from "../../shared/libs/db.js";

const METRICS: [MetricName, ...MetricName[]] = ["cpu", "mem", "net", "disk"];
const OPS: [AlertOp, ...AlertOp[]] = ["gt", "gte", "lt", "lte", "eq"];

const ruleSchema = z.object({
  name: z.string(),
  target: z.string(),
  metric: z.enum(METRICS),
  op: z.enum(OPS),
  threshold: z.number(),
  forSeconds: z.number().optional().default(0),
  enabled: z.boolean().optional().default(true),
});

const ruleUpdateSchema = ruleSchema.partial();

const P_id = { type: "object" as const, properties: { id: { type: "string" as const } }, required: ["id"] };

function parseId(idStr: string, reply: { code: (n: number) => { send: (b: unknown) => void } }): number | null {
  const id = parseInt(idStr, 10);
  if (Number.isNaN(id)) {
    reply.code(400).send({ error: `Invalid id: ${idStr}` });
    return null;
  }
  return id;
}

export const registerAlertsRoutes: FastifyPluginAsync = async (app) => {
  // ── Rules CRUD ──

  app.get("/alerts/rules", { schema: { tags: ["Alerts"], summary: "List alert rules" } }, async () => {
    return listAlertRules();
  });

  app.post(
    "/alerts/rules",
    {
      schema: {
        tags: ["Alerts"],
        summary: "Create an alert rule",
        body: zodToJsonSchema(ruleSchema),
      },
    },
    async (req, reply) => {
      const parsed = ruleSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: parsed.error.message });
        return;
      }
      return createAlertRule(parsed.data);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/alerts/rules/:id",
    { schema: { tags: ["Alerts"], summary: "Get one alert rule", params: P_id } },
    async (req, reply) => {
      const id = parseId(req.params.id, reply);
      if (id == null) return;
      const rule = getAlertRule(id);
      if (!rule) { reply.code(404).send({ error: `No alert rule ${id}` }); return; }
      return rule;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/alerts/rules/:id",
    {
      schema: {
        tags: ["Alerts"],
        summary: "Update an alert rule",
        params: P_id,
        body: zodToJsonSchema(ruleUpdateSchema),
      },
    },
    async (req, reply) => {
      const id = parseId(req.params.id, reply);
      if (id == null) return;
      const parsed = ruleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: parsed.error.message });
        return;
      }
      const updated = updateAlertRule(id, parsed.data);
      if (!updated) { reply.code(404).send({ error: `No alert rule ${id}` }); return; }
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/alerts/rules/:id",
    { schema: { tags: ["Alerts"], summary: "Delete an alert rule", params: P_id } },
    async (req, reply) => {
      const id = parseId(req.params.id, reply);
      if (id == null) return;
      const ok = deleteAlertRule(id);
      if (!ok) { reply.code(404).send({ error: `No alert rule ${id}` }); return; }
      return { ok: true, id };
    },
  );

  // ── Active / ack / history ──

  app.get("/alerts/active", { schema: { tags: ["Alerts"], summary: "Currently-fired (unresolved) alerts" } }, async () => {
    return getActiveAlerts();
  });

  app.post<{ Params: { id: string } }>(
    "/alerts/:id/ack",
    { schema: { tags: ["Alerts"], summary: "Acknowledge a fired alert", params: P_id } },
    async (req, reply) => {
      const id = parseId(req.params.id, reply);
      if (id == null) return;
      const alert = ackAlert(id);
      if (!alert) { reply.code(404).send({ error: `No alert history row ${id}` }); return; }
      return alert;
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/alerts/history",
    {
      schema: {
        tags: ["Alerts"],
        summary: "Full fired/resolved alert history",
        querystring: { type: "object" as const, properties: { limit: { type: "string" as const } } },
      },
    },
    async (req) => {
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 100;
      return getAlertHistory(limit);
    },
  );
};
