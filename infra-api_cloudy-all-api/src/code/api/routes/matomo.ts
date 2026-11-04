import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { registry } from "../../registry/index.js";

const MATOMO_BASE = registry.getBaseUrl("matomo") ?? "http://10.0.0.6:8080";

function matomoApiCall(method: string, params: Record<string, string> = {}): unknown {
  const token = process.env.MATOMO_API_TOKEN ?? "";
  const qs = new URLSearchParams({
    module: "API",
    method,
    format: "JSON",
    token_auth: token,
    ...params,
  });
  const result = rawHttpRequest("GET", `${MATOMO_BASE}/?${qs.toString()}`);
  return result.ok ? result.data : { error: result.error, status: result.status };
}

export async function registerMatomoRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { idSite?: string; period?: string; date?: string } }>("/matomo/visits", {
    schema: {
      tags: ["Matomo"],
      summary: "Get visit summary",
      querystring: {
        type: "object",
        properties: {
          idSite: { type: "string", default: "1" },
          period: { type: "string", default: "day" },
          date: { type: "string", default: "today" },
        },
      },
    },
  }, async (req) => {
    return matomoApiCall("VisitsSummary.get", {
      idSite: req.query.idSite ?? "1",
      period: req.query.period ?? "day",
      date: req.query.date ?? "today",
    });
  });

  app.get("/matomo/sites", {
    schema: {
      tags: ["Matomo"],
      summary: "List all tracked sites",
    },
  }, async () => {
    return matomoApiCall("SitesManager.getAllSites");
  });

  app.get<{ Querystring: { idSite?: string; period?: string; date?: string } }>("/matomo/actions", {
    schema: {
      tags: ["Matomo"],
      summary: "Get page view and action stats",
      querystring: {
        type: "object",
        properties: {
          idSite: { type: "string", default: "1" },
          period: { type: "string", default: "day" },
          date: { type: "string", default: "today" },
        },
      },
    },
  }, async (req) => {
    return matomoApiCall("Actions.get", {
      idSite: req.query.idSite ?? "1",
      period: req.query.period ?? "day",
      date: req.query.date ?? "today",
    });
  });

  app.get<{ Querystring: { idSite?: string; period?: string; date?: string } }>("/matomo/referrers", {
    schema: {
      tags: ["Matomo"],
      summary: "Get referrer stats",
      querystring: {
        type: "object",
        properties: {
          idSite: { type: "string", default: "1" },
          period: { type: "string", default: "day" },
          date: { type: "string", default: "today" },
        },
      },
    },
  }, async (req) => {
    return matomoApiCall("Referrers.get", {
      idSite: req.query.idSite ?? "1",
      period: req.query.period ?? "day",
      date: req.query.date ?? "today",
    });
  });

  app.get<{ Querystring: { idSite?: string; period?: string; date?: string; segment?: string } }>("/matomo/live", {
    schema: {
      tags: ["Matomo"],
      summary: "Get last visits (live)",
      querystring: {
        type: "object",
        properties: {
          idSite: { type: "string", default: "1" },
          period: { type: "string", default: "day" },
          date: { type: "string", default: "today" },
          segment: { type: "string" },
        },
      },
    },
  }, async (req) => {
    return matomoApiCall("Live.getLastVisitsDetails", {
      idSite: req.query.idSite ?? "1",
      period: req.query.period ?? "day",
      date: req.query.date ?? "today",
      ...(req.query.segment ? { segment: req.query.segment } : {}),
    });
  });
}
