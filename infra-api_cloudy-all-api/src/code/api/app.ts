import Fastify from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { authPlugin } from "./plugins/auth.js";
import { errorHandler } from "./plugins/error-handler.js";

// Routes
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerProxyRoutes } from "./routes/proxy.js";
import { registerMatomoRoutes } from "./routes/matomo.js";
import { registerSyncthingRoutes } from "./routes/syncthing.js";
import { registerMailuRoutes } from "./routes/mailu.js";
import { registerNtfyRoutes } from "./routes/ntfy.js";
import { registerOllamaRoutes } from "./routes/ollama.js";
import { registerRadicaleRoutes } from "./routes/radicale.js";

export async function buildApp() {
  const app = Fastify({
    logger: { level: "info" },
  });

  await app.register(cors, { origin: true, credentials: true });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "C3 Services — Unified Service API Gateway",
        version: "1.0.0",
        description: "Unified gateway to all self-hosted service APIs. Proxies OpenAPI services and wraps custom REST/protocol services.",
      },
      tags: [
        { name: "Registry", description: "Service catalog and API discovery" },
        { name: "Proxy", description: "Generic proxy for OpenAPI-compatible services" },
        { name: "Matomo", description: "Web analytics (Matomo)" },
        { name: "Syncthing", description: "File synchronization (Syncthing)" },
        { name: "Mailu", description: "Email server administration (Mailu)" },
        { name: "ntfy", description: "Push notifications (ntfy)" },
        { name: "Ollama", description: "LLM inference (Ollama)" },
        { name: "Radicale", description: "Calendar and contacts (Radicale CalDAV)" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  await app.register(authPlugin);
  app.setErrorHandler(errorHandler);

  // Routes (no prefix — Caddy handle_path /services/* strips the prefix)
  await app.register(registerRegistryRoutes);
  await app.register(registerProxyRoutes);
  await app.register(registerMatomoRoutes);
  await app.register(registerSyncthingRoutes);
  await app.register(registerMailuRoutes);
  await app.register(registerNtfyRoutes);
  await app.register(registerOllamaRoutes);
  await app.register(registerRadicaleRoutes);

  return app;
}
