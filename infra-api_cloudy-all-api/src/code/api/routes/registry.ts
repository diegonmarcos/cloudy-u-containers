import type { FastifyInstance } from "fastify";
import { registry } from "../../registry/index.js";
import { getReachUrl } from "../../registry/reach.js";
import { rawHttpRequest } from "../../shared/http.js";

export async function registerRegistryRoutes(app: FastifyInstance) {
  app.get("/health", {
    schema: { hide: true },
  }, async () => {
    return { status: "ok", service: "c3-services-mcp-api", version: "1.0.0" };
  });

  app.get("/", {
    schema: {
      tags: ["Registry"],
      summary: "List all services with API status",
      response: {
        200: {
          type: "object",
          properties: {
            services: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  displayName: { type: "string" },
                  description: { type: "string" },
                  vm: { type: "string" },
                  apiType: { type: "string" },
                  endpointCount: { type: "number" },
                  hasSpec: { type: "boolean" },
                },
              },
            },
            total: { type: "number" },
          },
        },
      },
    },
  }, async () => {
    const services = registry.list().map((s) => ({
      name: s.name,
      displayName: s.displayName,
      description: s.description,
      vm: s.vm,
      apiType: s.api?.type ?? (s.mcp ? "mcp" : "no-api"),
      endpointCount: s.api?.endpointCount ?? s.mcp?.toolsCount ?? 0,
      hasSpec: !!s.api?.specUrl,
    }));
    return { services, total: services.length };
  });

  app.get<{ Params: { service: string } }>("/:service", {
    schema: {
      tags: ["Registry"],
      summary: "Get service detail",
      params: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"],
      },
    },
  }, async (req, reply) => {
    const svc = registry.get(req.params.service);
    if (!svc) {
      reply.code(404);
      return { error: `Service '${req.params.service}' not found` };
    }
    return svc;
  });

  // Reachability probe for health-check callers (CF Worker, monitoring).
  // Hits the service's WG-mesh /health endpoint with a short timeout and
  // returns a tiny JSON envelope. Avoids leaking upstream payload shape.
  app.get<{ Params: { service: string } }>("/:service/reach", {
    schema: {
      tags: ["Registry"],
      summary: "Probe service reachability via its WG-mesh /health endpoint",
      params: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            service:   { type: "string" },
            reachable: { type: "boolean" },
            status:    { type: "number" },
          },
        },
        404: {
          type: "object",
          properties: {
            error:     { type: "string" },
            reachable: { type: "boolean" },
          },
        },
      },
    },
  }, async (req, reply) => {
    // Probe ANY container (not just API/MCP services) via its declared healthcheck
    // path on the WG mesh. Reach targets are data-driven from build-c3-services-api.json
    // (.services.<name>.healthcheck, stamped by the derive). null = unknown or no healthcheck.
    const url = getReachUrl(req.params.service);
    if (!url) {
      reply.code(404);
      return {
        error: `Service '${req.params.service}' not found or declares no healthcheck`,
        reachable: false,
      };
    }
    const result = rawHttpRequest("GET", url, undefined, 5_000);
    return { service: req.params.service, reachable: result.ok, status: result.status };
  });

  app.get<{ Params: { service: string } }>("/:service/spec", {
    schema: {
      tags: ["Registry"],
      summary: "Get OpenAPI spec for a service",
      params: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"],
      },
    },
  }, async (req, reply) => {
    const svc = registry.get(req.params.service);
    if (!svc) {
      reply.code(404);
      return { error: `Service '${req.params.service}' not found` };
    }
    if (!svc.api?.specUrl) {
      reply.code(404);
      return { error: `Service '${req.params.service}' has no OpenAPI spec` };
    }
    const spec = await registry.fetchSpec(req.params.service);
    if (!spec) {
      reply.code(502);
      return { error: "Failed to fetch spec from service" };
    }
    return spec;
  });
}
