import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { registry } from "../../registry/index.js";

const SYNCTHING_BASE = registry.getBaseUrl("syncthing") ?? "http://10.0.0.3:8384";

function syncthingGet(path: string): unknown {
  const apiKey = process.env.SYNCTHING_API_KEY ?? "";
  const result = rawHttpRequest("GET", `${SYNCTHING_BASE}${path}`, undefined, 10_000, {
    "X-API-Key": apiKey,
  });
  return result.ok ? result.data : { error: result.error, status: result.status };
}

export async function registerSyncthingRoutes(app: FastifyInstance) {
  app.get("/syncthing/status", {
    schema: {
      tags: ["Syncthing"],
      summary: "Get system status",
    },
  }, async () => {
    return syncthingGet("/rest/system/status");
  });

  app.get("/syncthing/config", {
    schema: {
      tags: ["Syncthing"],
      summary: "Get current configuration",
    },
  }, async () => {
    return syncthingGet("/rest/config");
  });

  app.get("/syncthing/folders", {
    schema: {
      tags: ["Syncthing"],
      summary: "List all synced folders with status",
    },
  }, async () => {
    const config = syncthingGet("/rest/config") as Record<string, unknown>;
    if ("error" in config) return config;
    const folders = (config as { folders?: unknown[] }).folders ?? [];
    return { folders };
  });

  app.get("/syncthing/devices", {
    schema: {
      tags: ["Syncthing"],
      summary: "List connected devices",
    },
  }, async () => {
    return syncthingGet("/rest/system/connections");
  });
}
