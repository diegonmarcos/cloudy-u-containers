import type { FastifyInstance } from "fastify";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { applySample, claudeView, getOpenRouter, loadStore, saveStore, validateClaudeBody } from "../../shared/libs/ai-usage.js";

// Cloud SuperApp Notify > Resources AI card (ticket #1151).
//   POST /ai/usage/claude  pushed by Claude Code posters (auth: the global auth plugin; bearer via Caddy, or mesh)
//   GET  /ai/usage         Claude (latest + small history) merged with OpenRouter (server-side, cached ~5 min)
const DIR = join(process.env.C3_DATA_DIR ?? (existsSync("/app/data") ? "/app/data" : join(homedir(), ".local/share/c3")), "ai-usage");

export async function registerAiUsageRoutes(app: FastifyInstance) {
  app.post("/ai/usage/claude", { schema: { tags: ["AI"], summary: "Record a Claude Code usage sample (five_hour / seven_day rate limits, or rate_limited)" } }, async (req, reply) => {
    const v = validateClaudeBody(req.body, Math.floor(Date.now() / 1000));
    if (!v.ok) return reply.code(400).send({ error: "invalid body", details: v.errors });
    saveStore(DIR, applySample(loadStore(DIR), v.sample));
    return reply.code(202).send({ ok: true });
  });

  app.get("/ai/usage", { schema: { tags: ["AI"], summary: "Claude + OpenRouter usage for the SuperApp AI card" } }, async (_req, reply) => {
    const now = Date.now();
    const openrouter = await getOpenRouter(process.env, fetch, now);
    return reply.send({ generated_at: Math.floor(now / 1000), claude: claudeView(loadStore(DIR), Math.floor(now / 1000)), openrouter });
  });
}
