import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { registry } from "../../registry/index.js";

const MAILU_BASE = registry.getBaseUrl("maddy") ?? "http://10.0.0.3:8444";

function mailuGet(path: string): unknown {
  const apiKey = process.env.MAILU_API_KEY ?? "";
  const result = rawHttpRequest("GET", `${MAILU_BASE}${path}`, undefined, 10_000, {
    Authorization: apiKey,
  });
  return result.ok ? result.data : { error: result.error, status: result.status };
}

export async function registerMailuRoutes(app: FastifyInstance) {
  app.get("/mailu/domains", {
    schema: {
      tags: ["Mailu"],
      summary: "List all mail domains",
    },
  }, async () => {
    return mailuGet("/api/v1/domain");
  });

  app.get("/mailu/users", {
    schema: {
      tags: ["Mailu"],
      summary: "List all mail users",
    },
  }, async () => {
    return mailuGet("/api/v1/user");
  });

  app.get("/mailu/aliases", {
    schema: {
      tags: ["Mailu"],
      summary: "List all mail aliases",
    },
  }, async () => {
    return mailuGet("/api/v1/alias");
  });
}
