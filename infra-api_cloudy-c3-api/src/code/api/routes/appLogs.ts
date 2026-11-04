import type { FastifyInstance } from "fastify";
import { mkdir, writeFile, appendFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "../../shared/libs/config.js";
import { LOGS_DIR, MAX_LOG_BYTES, EVENT_KINDS, withinRateLimit, notifyNtfy } from "./publicLogs.js";
import { resolveName, readEvents, isLogFileName, type AppKind, type DeclaredApk } from "../../shared/libs/app-logs-core.js";

// ── /{apk|containers}/{name}/logs — one declared crash/log route per app ─────────────────────────
//   POST  ingest one event   {kind, title?, message?, log?, meta?}  (meta carries version, device, abi)
//   GET   read them back     ?kind=crash&since=<iso>&limit=50 (newest first); ?file=<logFile> the raw log text
// The names are DECLARED, not typed here: APKs from api/declared-apks.json (generated from the
// constellation fleet manifest by gen-declared-apks.mjs), containers from the containers manifest
// (config services). An undeclared name is a 404.
// AUTH is plugins/auth.ts, unchanged: the mesh (c3-infra-api.mesh.diegonmarcos.com) is trusted, the public path
// (c3-pvt.diegonmarcos.com/c3-infra-api/...) is admitted when Caddy has validated the bearer or the cookie.
// This is the same store the unauthenticated /public/events/:app writes, under a per-kind directory.

const DECLARED_APKS: DeclaredApk[] = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../declared-apks.json", import.meta.url), "utf8")) as { apks: DeclaredApk[] }).apks;
  } catch { return []; }
})();

function declaredContainers(): string[] {
  try { return Object.keys(getConfig().services ?? {}); } catch { return []; }
}

export async function registerAppLogsRoutes(app: FastifyInstance) {
  const dirOf = (kind: AppKind, name: string) => join(LOGS_DIR, "app", kind, name);

  app.post<{
    Params: { kind: AppKind; name: string };
    Body: { kind?: string; title?: string; message?: string; log?: string; meta?: Record<string, unknown> };
  }>("/:kind(apk|containers)/:name/logs", { bodyLimit: MAX_LOG_BYTES + 64 * 1024 }, async (req, reply) => {
    const name = resolveName(req.params.kind, req.params.name, DECLARED_APKS, declaredContainers());
    if (!name) return reply.code(404).send({ error: `${req.params.name} is not a declared ${req.params.kind} name` });
    if (!withinRateLimit(`${req.params.kind}/${name}`)) return reply.code(429).send({ error: "rate limit exceeded (60/min per app)" });
    const body = req.body;
    if (!body?.kind || !EVENT_KINDS.has(body.kind)) return reply.code(400).send({ error: `'kind' must be one of: ${[...EVENT_KINDS].join(", ")}` });
    if (body.log !== undefined && (typeof body.log !== "string" || body.log.length > MAX_LOG_BYTES)) return reply.code(413).send({ error: "log too large" });

    const dir = dirOf(req.params.kind, name);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    let logFile: string | undefined;
    if (body.log) {
      logFile = `${name}-${body.kind}-${now}.log`;
      await writeFile(join(dir, logFile), body.log, "utf8");
    }
    const envelope = { ts: new Date(now).toISOString(), app: name, route: req.params.kind, kind: body.kind, title: body.title, message: body.message, meta: body.meta, logFile };
    await appendFile(join(dir, "events.jsonl"), `${JSON.stringify(envelope)}\n`, "utf8");
    notifyNtfy(name, body.kind, body.title, body.message);
    req.log.info({ app: name, route: req.params.kind, kind: body.kind, logFile }, "app log received");
    return { ok: true, logFile };
  });

  app.get<{
    Params: { kind: AppKind; name: string };
    Querystring: { kind?: string; since?: string; limit?: string; file?: string };
  }>("/:kind(apk|containers)/:name/logs", async (req, reply) => {
    const name = resolveName(req.params.kind, req.params.name, DECLARED_APKS, declaredContainers());
    if (!name) return reply.code(404).send({ error: `${req.params.name} is not a declared ${req.params.kind} name` });
    const dir = dirOf(req.params.kind, name);
    const { file, kind, since, limit } = req.query;
    if (file !== undefined) {
      if (!isLogFileName(file)) return reply.code(400).send({ error: "invalid file" });
      try { return reply.type("text/plain; charset=utf-8").send(await readFile(join(dir, file), "utf8")); }
      catch { return reply.code(404).send({ error: "no such log file" }); }
    }
    let jsonl = "";
    try { jsonl = await readFile(join(dir, "events.jsonl"), "utf8"); } catch { /* nothing posted yet */ }
    const events = readEvents(jsonl, { kind, since, limit: limit ? parseInt(limit, 10) : undefined });
    return { app: name, route: req.params.kind, count: events.length, events };
  });
}
