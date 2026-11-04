import type { FastifyInstance } from "fastify";
import { registry } from "../../registry/index.js";
import { rawHttpRequest } from "../../shared/http.js";

interface ProxyBody {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function registerProxyRoutes(app: FastifyInstance) {
  app.post<{ Params: { service: string }; Body: ProxyBody }>("/:service/proxy", {
    schema: {
      tags: ["Proxy"],
      summary: "Proxy request to an OpenAPI service",
      params: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"],
      },
      body: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "API path (e.g. /api/v1/users)" },
          body: { description: "Request body (for POST/PUT/PATCH)" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "Extra headers" },
        },
        required: ["method", "path"],
      },
    },
  }, async (req, reply) => {
    const baseUrl = registry.getBaseUrl(req.params.service);
    if (!baseUrl) {
      reply.code(404);
      return { error: `Service '${req.params.service}' not found` };
    }

    const svc = registry.get(req.params.service)!;
    if (!svc.api || svc.api.type === "no-api") {
      reply.code(400);
      return { error: `Service '${req.params.service}' has no API` };
    }

    const { method, path, body, headers } = req.body;
    const url = `${baseUrl}${path}`;

    // Pass through service-specific API tokens from env
    const envToken = process.env[`${req.params.service.toUpperCase()}_API_TOKEN`];
    const allHeaders: Record<string, string> = {
      ...headers,
    };
    if (envToken) {
      allHeaders["Authorization"] = `Bearer ${envToken}`;
    }

    const result = rawHttpRequest(
      method,
      url,
      body ? JSON.stringify(body) : undefined,
      30_000,
      Object.keys(allHeaders).length > 0 ? allHeaders : undefined,
    );

    reply.code(result.status || 502);
    return result.data ?? { error: result.error };
  });
}
