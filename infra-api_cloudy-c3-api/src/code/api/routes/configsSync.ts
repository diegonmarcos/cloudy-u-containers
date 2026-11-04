import type { FastifyInstance } from "fastify";
import { readConfigFile, isConfigFileName } from "../../shared/libs/configs-sync-core.js";

// ── /configs/* - the files the configs-sync engine commits to its data repo ──
// GET /configs/containers   the declarative C3 Containers page data (containers-declared.json)
// GET /configs/file/:name   any other published JSON (consolidated, fleet, build/build-<app>.json)
// Read-only; the data repo is the only source (no local copy to go stale).
export async function registerConfigsSyncRoutes(app: FastifyInstance) {
  app.get("/configs/containers", { schema: { tags: ["configs"], summary: "Declared containers (group, category, metadata) from the configs-sync data repo" } }, async (_req, reply) => {
    try {
      return reply.type("application/json").send(await readConfigFile("containers-declared.json"));
    } catch (e) {
      return reply.code(502).send({ error: "configs-sync data repo unreachable", detail: String((e as Error).message) });
    }
  });
  app.get<{ Params: { "*": string } }>("/configs/file/*", { schema: { tags: ["configs"], summary: "One published JSON file of the configs-sync data repo" } }, async (req, reply) => {
    const name = req.params["*"];
    if (!isConfigFileName(name)) return reply.code(400).send({ error: "bad file name" });
    try {
      return reply.type("application/json").send(await readConfigFile(name));
    } catch (e) {
      return reply.code(502).send({ error: "configs-sync data repo unreachable", detail: String((e as Error).message) });
    }
  });
}
