import type { FastifyInstance } from "fastify";
import { readFleetData } from "../../shared/libs/fleet-data-core.js";
import { isCaddyAuthenticated } from "../../shared/libs/auth-decision.js";

// ── /fleet-data/* - the personal (tier 1) and fleet/infra (tier 2) datasets of the Cloud apps' fleet data framework (#1547) ──
// GET /fleet-data/manifest           the served data manifest (who may read what), from the private repo
// GET /fleet-data/<tier>/<dataset>   one dataset (<dataset> may be fleet/probes, app/<package>/<name>, ...); ETag / If-None-Match -> 304
// Auth: the global plugin (fleet bearer through Caddy introspection, or the mesh). Tier 1 (personal) additionally REQUIRES a Caddy-authenticated
// caller (X-Auth-User / Remote-User): a bare mesh address is not enough. The source is the private cloud-me-pvt-configs repo only.
export async function registerFleetDataRoutes(app: FastifyInstance) {
  const send = async (file: string, req: { headers: Record<string, unknown> }, reply: any) => {
    const inm = typeof req.headers["if-none-match"] === "string" ? (req.headers["if-none-match"] as string) : undefined;
    const a = await readFleetData(file, inm);
    reply.header("Cache-Control", "private, no-cache");
    if (a.etag) reply.header("ETag", a.etag);
    if (a.status === 200) return reply.type("application/json").send(a.body);
    if (a.status === 304) return reply.code(304).send();
    return reply.code(a.status).send({ error: a.error });
  };
  app.get("/fleet-data/manifest", { schema: { tags: ["fleet-data"], summary: "The fleet data manifest (tiers 1-2) from the private repo" } }, async (req, reply) => send("manifest", req, reply));
  app.get<{ Params: { tier: string; "*": string } }>("/fleet-data/:tier/*", { schema: { tags: ["fleet-data"], summary: "One personal (1) or fleet/infra (2) dataset from the private repo" } }, async (req, reply) => {
    if (req.params.tier === "1" && !isCaddyAuthenticated(req.headers as Record<string, unknown>)) return reply.code(401).send({ error: "tier 1 needs an authenticated caller" });
    return send(`${req.params.tier}/${req.params["*"]}`, req, reply);
  });
}
