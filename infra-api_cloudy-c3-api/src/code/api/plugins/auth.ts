import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { isAllowed } from "../../shared/libs/auth-decision.js";

async function authHook(req: FastifyRequest, reply: FastifyReply) {
  // Public paths, WireGuard mesh, or a caller Caddy already authenticated (bearer via introspect-proxy, cookie via Authelia)
  if (isAllowed(req.url, req.ip, req.headers)) return;

  req.log.warn({
    url: req.url,
    ip: req.ip,
    hasXAuthUser: !!req.headers["x-auth-user"],
    hasRemoteUser: !!req.headers["remote-user"],
    headers: Object.keys(req.headers),
  }, "AUTH REJECTED — 401");
  reply.code(401).send({ error: "Unauthorized — use bearer token via Caddy" });
}

async function authPluginFn(app: FastifyInstance) {
  app.addHook("onRequest", authHook);
}

export const authPlugin = fp(authPluginFn, { name: "auth" });
