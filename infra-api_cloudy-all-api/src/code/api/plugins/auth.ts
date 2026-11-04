import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";

const PUBLIC_PATHS = new Set([
  "/health",
  "/docs",
  "/docs/",
  "/docs/json",
  "/docs/yaml",
]);

function isPublicPath(url: string): boolean {
  if (url.startsWith("/docs")) return true;
  return PUBLIC_PATHS.has(url);
}

function isMeshRequest(req: FastifyRequest): boolean {
  const ip = req.ip;
  return ip.startsWith("10.0.0.") || ip.startsWith("172.") || ip === "127.0.0.1" || ip === "::1";
}

function isCaddyAuthenticated(req: FastifyRequest): boolean {
  return !!(req.headers["x-auth-user"] || req.headers["remote-user"]);
}

async function authHook(req: FastifyRequest, reply: FastifyReply) {
  if (isPublicPath(req.url)) return;
  if (isMeshRequest(req)) return;
  if (isCaddyAuthenticated(req)) return;

  req.log.warn({
    url: req.url,
    ip: req.ip,
    hasXAuthUser: !!req.headers["x-auth-user"],
    hasRemoteUser: !!req.headers["remote-user"],
  }, "AUTH REJECTED — 401");
  reply.code(401).send({ error: "Unauthorized — use bearer token via Caddy" });
}

async function authPluginFn(app: FastifyInstance) {
  app.addHook("onRequest", authHook);
}

export const authPlugin = fp(authPluginFn, { name: "auth" });
