import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { registry } from "../../registry/index.js";

const NTFY_BASE = registry.getBaseUrl("ntfy") ?? "http://10.0.0.6:8090";

export async function registerNtfyRoutes(app: FastifyInstance) {
  app.get("/ntfy/health", {
    schema: {
      tags: ["ntfy"],
      summary: "Check ntfy server health",
    },
  }, async (_req, reply) => {
    const result = rawHttpRequest("GET", `${NTFY_BASE}/v1/health`);
    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });

  app.post<{
    Body: { topic: string; message: string; title?: string; priority?: number; tags?: string[] };
  }>("/ntfy/publish", {
    schema: {
      tags: ["ntfy"],
      summary: "Publish a notification",
      body: {
        type: "object",
        properties: {
          topic: { type: "string" },
          message: { type: "string" },
          title: { type: "string" },
          priority: { type: "number", minimum: 1, maximum: 5 },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["topic", "message"],
      },
    },
  }, async (req, reply) => {
    const { topic, message, title, priority, tags } = req.body;
    const payload: Record<string, unknown> = { topic, message };
    if (title) payload.title = title;
    if (priority) payload.priority = priority;
    if (tags) payload.tags = tags;

    const result = rawHttpRequest("POST", NTFY_BASE, JSON.stringify(payload));
    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });
}
