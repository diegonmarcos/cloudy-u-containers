// ── Metrics Routes — time-series cpu/mem/net/disk samples ──
// Sampler runs on the shared poller tick (see shared/libs/poller.ts).
// This module only exposes read endpoints over the metric_samples/metric_rollup tables.

import { FastifyPluginAsync } from "fastify";
import { queryMetricSeries, getTopByMetric, type MetricName } from "../../shared/libs/db.js";

const VALID_METRICS = new Set<string>(["cpu", "mem", "net", "disk"]);

const P_target = { type: "object" as const, properties: { target: { type: "string" as const } }, required: ["target"] };

function parseMetric(m: unknown): MetricName {
  const s = typeof m === "string" ? m : "cpu";
  if (!VALID_METRICS.has(s)) throw new Error(`Invalid metric: ${s}. Valid: cpu, mem, net, disk`);
  return s as MetricName;
}

/**
 * Coarsen a series to at most ~`step`-second resolution by picking every
 * Nth point. Simple and dependency-free — no need for a real resampling
 * library since points are already either raw (~1/tick) or 5m rollup.
 */
function applyStep(points: { ts: string; value: number }[], stepSeconds?: number): { ts: string; value: number }[] {
  if (!stepSeconds || stepSeconds <= 0 || points.length < 2) return points;
  const spanMs = new Date(points[points.length - 1].ts).getTime() - new Date(points[0].ts).getTime();
  const avgGapMs = spanMs / Math.max(1, points.length - 1);
  const everyN = Math.max(1, Math.round((stepSeconds * 1000) / Math.max(avgGapMs, 1)));
  if (everyN <= 1) return points;
  return points.filter((_, i) => i % everyN === 0);
}

export const registerMetricsRoutes: FastifyPluginAsync = async (app) => {
  // ── Generic query: q="<target>:<metric>" (simplest thing that supports
  // the ask without inventing a query language / adding a parser dependency) ──
  app.get<{ Querystring: { q?: string; from?: string; to?: string; step?: string } }>(
    "/metrics/query",
    {
      schema: {
        tags: ["Metrics"],
        summary: "Query a metric series by 'target:metric' selector",
        querystring: {
          type: "object" as const,
          properties: {
            q: { type: "string" as const, description: "e.g. 'vm-1:cpu' or 'my-container:mem'" },
            from: { type: "string" as const },
            to: { type: "string" as const },
            step: { type: "string" as const, description: "seconds" },
          },
        },
      },
    },
    async (req, reply) => {
      const { q, from, to, step } = req.query;
      if (!q || !q.includes(":")) {
        reply.code(400).send({ error: "q must be '<target>:<metric>', e.g. 'vm-1:cpu'" });
        return;
      }
      const [target, metricRaw] = q.split(":", 2);
      let metric: MetricName;
      try {
        metric = parseMetric(metricRaw);
      } catch (err) {
        reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const points = queryMetricSeries(target, metric, from, to);
      return { target, metric, points: applyStep(points, step ? parseInt(step, 10) : undefined) };
    },
  );

  // ── Series for a specific target ──
  app.get<{ Params: { target: string }; Querystring: { metric?: string; from?: string; to?: string; step?: string } }>(
    "/metrics/series/:target",
    {
      schema: {
        tags: ["Metrics"],
        summary: "Time-series for one target",
        params: P_target,
        querystring: {
          type: "object" as const,
          properties: {
            metric: { type: "string" as const, enum: ["cpu", "mem", "net", "disk"] },
            from: { type: "string" as const },
            to: { type: "string" as const },
            step: { type: "string" as const },
          },
        },
      },
    },
    async (req, reply) => {
      const { target } = req.params;
      const { metric: metricRaw, from, to, step } = req.query;
      let metric: MetricName;
      try {
        metric = parseMetric(metricRaw ?? "cpu");
      } catch (err) {
        reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const points = queryMetricSeries(target, metric, from, to);
      return { target, metric, points: applyStep(points, step ? parseInt(step, 10) : undefined) };
    },
  );

  // ── Top N targets by latest metric value ──
  app.get<{ Querystring: { by?: string; limit?: string } }>(
    "/metrics/top",
    {
      schema: {
        tags: ["Metrics"],
        summary: "Top targets by latest cpu/mem value",
        querystring: {
          type: "object" as const,
          properties: {
            by: { type: "string" as const, enum: ["cpu", "mem"] },
            limit: { type: "string" as const },
          },
        },
      },
    },
    async (req, reply) => {
      const by = req.query.by ?? "cpu";
      if (by !== "cpu" && by !== "mem") {
        reply.code(400).send({ error: "by must be 'cpu' or 'mem'" });
        return;
      }
      const limit = req.query.limit ? parseInt(req.query.limit, 10) : 10;
      return { by, top: getTopByMetric(by, limit) };
    },
  );
};
