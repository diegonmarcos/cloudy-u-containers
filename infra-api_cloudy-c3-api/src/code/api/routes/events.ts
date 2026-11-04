// ── Events Routes — unified timeline ──
// GET /events unions four existing history sources (no new tables invented):
//   - deploy_log     (getDeployHistory in db.ts)      -> type "deploy"
//   - alert_history  (getAlertHistory in db.ts)       -> type "alert"
//   - audit_log      (getAuditLog in db.ts)           -> type "ops"
//   - GitHub Actions runs (same live API call as observability.ts's
//     GET /workflows — there is no persisted table for CI runs, so this
//     reuses the existing live source rather than fabricating one)
//                                                      -> type "ci"

import { FastifyPluginAsync } from "fastify";
import { getDeployHistory, getAlertHistory, getAuditLog } from "../../shared/libs/db.js";

export type EventType = "deploy" | "alert" | "ops" | "ci";

export interface TimelineEvent {
  type: EventType;
  ts: string;
  summary: string;
  detail: Record<string, unknown>;
}

const VALID_TYPES = new Set<EventType>(["deploy", "alert", "ops", "ci"]);

async function fetchCiEvents(): Promise<TimelineEvent[]> {
  try {
    const resp = await fetch(
      "https://api.github.com/repos/diegonmarcos/cloudy-t-infra/actions/runs?per_page=15",
      { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) },
    );
    if (!resp.ok) return [];
    const data = await resp.json() as { workflow_runs?: Array<Record<string, unknown>> };
    return (data.workflow_runs ?? []).map((r) => ({
      type: "ci" as const,
      ts: String(r.created_at ?? new Date().toISOString()),
      summary: `${r.name} (${r.head_branch}): ${r.conclusion ?? r.status}`,
      detail: {
        name: r.name,
        branch: r.head_branch,
        status: r.status,
        conclusion: r.conclusion,
        url: r.html_url,
      },
    }));
  } catch {
    // Best-effort — GitHub API may be unreachable; don't fail the whole timeline.
    return [];
  }
}

function inWindow(ts: string, from?: string, to?: string): boolean {
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

export const registerEventsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { from?: string; to?: string; type?: string; limit?: string } }>(
    "/events",
    {
      schema: {
        tags: ["Events"],
        summary: "Unified timeline: deploys, alerts, ops actions, and CI runs",
        querystring: {
          type: "object" as const,
          properties: {
            from: { type: "string" as const, description: "ISO timestamp lower bound" },
            to: { type: "string" as const, description: "ISO timestamp upper bound" },
            type: { type: "string" as const, enum: ["deploy", "alert", "ops", "ci"] },
            limit: { type: "string" as const },
          },
        },
      },
    },
    async (req, reply) => {
      const { from, to, type, limit: limitStr } = req.query;
      if (type && !VALID_TYPES.has(type as EventType)) {
        reply.code(400).send({ error: `Invalid type: ${type}. Valid: ${Array.from(VALID_TYPES).join(", ")}` });
        return;
      }
      const limit = limitStr ? parseInt(limitStr, 10) : 200;

      const wantTypes = type ? new Set([type as EventType]) : VALID_TYPES;
      const events: TimelineEvent[] = [];

      if (wantTypes.has("deploy")) {
        for (const d of getDeployHistory({ limit: 500 })) {
          events.push({
            type: "deploy",
            ts: d.ts,
            summary: `${d.service} ${d.step}: ${d.success ? "OK" : "FAILED"}`,
            detail: { service: d.service, step: d.step, success: d.success, durationMs: d.duration_ms },
          });
        }
      }

      if (wantTypes.has("alert")) {
        for (const a of getAlertHistory(500)) {
          events.push({
            type: "alert",
            ts: a.ts,
            summary: `${a.status.toUpperCase()}: ${a.target} ${a.metric}=${a.value}`,
            detail: { ruleId: a.ruleId, target: a.target, metric: a.metric, value: a.value, status: a.status, acked: a.acked },
          });
        }
      }

      if (wantTypes.has("ops")) {
        for (const a of getAuditLog({ limit: 500 })) {
          events.push({
            type: "ops",
            ts: a.ts,
            summary: `${a.tool} ${a.target}: ${a.result}`,
            detail: { tool: a.tool, target: a.target, result: a.result, source: a.source },
          });
        }
      }

      if (wantTypes.has("ci")) {
        events.push(...await fetchCiEvents());
      }

      const filtered = events
        .filter((e) => inWindow(e.ts, from, to))
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
        .slice(0, limit);

      return { events: filtered, count: filtered.length };
    },
  );
};
