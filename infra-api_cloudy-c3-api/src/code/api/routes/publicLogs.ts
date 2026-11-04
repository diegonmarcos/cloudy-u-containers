import type { FastifyInstance } from "fastify";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { execAsync } from "../../shared/libs/exec.js";

// Unauthenticated ingest for client-side log dumps (e.g. galaxy-earth's
// "Log Export" button) — see auth.ts isPublicPath() for the /public/ allowlist.
export const LOGS_DIR = process.env.PUBLIC_LOGS_DIR ?? "/app/public/logs";
export const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2MB — plenty for a browser console dump

// ── /public/events/:app — the default telemetry endpoint every Android app
// ships against (log/debug/action/probe/crash). Reuses LOGS_DIR for storage
// and forwards a compact push to ntfy so events surface in real time.

export const EVENT_KINDS = new Set(["log", "debug", "action", "probe", "crash"]);

// ntfy: same rss.diegonmarcos.com server shared/libs/notify.ts already posts
// to for health alerts, just a per-app topic ("infra-<app>") instead of the
// shared "infra" one. Server config (infra-obs_ntfy) has auth-default-access:
// read-write, so ad-hoc topics need no provisioning — a POST is enough.
// NTFY_TOKEN is only wired for the day that access is tightened; leave unset.
const NTFY_BASE_URL = process.env.NTFY_BASE_URL ?? "https://rss.diegonmarcos.com";
const NTFY_TOKEN = process.env.NTFY_TOKEN;

// Trivial per-app in-memory rate limit — no @fastify/rate-limit dependency
// in this API yet, and a single counter per app is plenty for a telemetry
// default. Resets on restart, not shared across replicas (single instance).
const RATE_LIMIT_MAX = 60; // events/min/app
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
export function withinRateLimit(app: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(app);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(app, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

function sanitiseIdent(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
}

// Fire-and-forget: an ntfy hiccup must never fail the ingest itself.
export function notifyNtfy(app: string, kind: string, title?: string, message?: string) {
  // ntfy topics must match [-_A-Za-z0-9]{1,64} — "infra-" is 6 chars, so
  // clamp the app segment to keep the full topic within the cap.
  const topic = `infra-${app.slice(0, 58)}`;
  // Header values are attacker-supplied: strip control chars (CRLF would let a
  // crafted title smuggle extra headers into the curl invocation) and clamp.
  const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 120);
  const summary = clean(title || (message ? message.slice(0, 80) : kind));
  const args = [
    "-s", "-S",
    "-X", "POST",
    "-H", `Title: ${clean(`[${app}] ${kind}: ${summary}`)}`,
  ];
  if (NTFY_TOKEN) args.push("-H", `Authorization: Bearer ${NTFY_TOKEN}`);
  args.push("-d", message || summary, `${NTFY_BASE_URL}/${topic}`);

  execAsync("curl", args, { timeout: 10_000 })
    .then((result) => {
      if (!result.ok) {
        console.error(`[events] ntfy forward to ${topic} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
    })
    .catch((err) => console.error(`[events] ntfy forward to ${topic} errored:`, err));
}

export async function registerPublicLogsRoutes(app: FastifyInstance) {
  app.post("/public/logs", async (req, reply) => {
    const body = req.body as { source?: string; log?: string } | undefined;
    if (!body?.log || typeof body.log !== "string") {
      return reply.code(400).send({ error: "missing 'log' field" });
    }
    if (body.log.length > MAX_LOG_BYTES) {
      return reply.code(413).send({ error: "log too large" });
    }
    const safeSource = (body.source ?? "client").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    const filename = `${safeSource}-${Date.now()}.log`;
    await mkdir(LOGS_DIR, { recursive: true });
    await writeFile(join(LOGS_DIR, filename), body.log, "utf8");
    req.log.info({ filename, bytes: body.log.length }, "public log received");
    return { ok: true, file: filename };
  });

  app.post<{
    Params: { app: string };
    Body: {
      kind?: string;
      title?: string;
      message?: string;
      log?: string;
      meta?: Record<string, unknown>;
    };
  }>("/public/events/:app", async (req, reply) => {
    const safeApp = sanitiseIdent(req.params.app ?? "");
    if (!safeApp) {
      return reply.code(400).send({ error: "invalid app" });
    }
    if (!withinRateLimit(safeApp)) {
      return reply.code(429).send({ error: `rate limit exceeded (${RATE_LIMIT_MAX}/min per app)` });
    }

    const body = req.body;
    if (!body?.kind || !EVENT_KINDS.has(body.kind)) {
      return reply.code(400).send({ error: `'kind' must be one of: ${[...EVENT_KINDS].join(", ")}` });
    }
    if (body.log !== undefined && (typeof body.log !== "string" || body.log.length > MAX_LOG_BYTES)) {
      return reply.code(413).send({ error: "log too large" });
    }

    await mkdir(LOGS_DIR, { recursive: true });

    const now = Date.now();
    let logFile: string | undefined;
    if (body.log) {
      logFile = `${safeApp}-${body.kind}-${now}.log`;
      await writeFile(join(LOGS_DIR, logFile), body.log, "utf8");
    }

    // Structured envelope, raw log excluded (it already has its own file).
    const envelope = {
      ts: new Date(now).toISOString(),
      app: safeApp,
      kind: body.kind,
      title: body.title,
      message: body.message,
      meta: body.meta,
      logFile,
    };
    await appendFile(join(LOGS_DIR, `${safeApp}-events.jsonl`), `${JSON.stringify(envelope)}\n`, "utf8");

    notifyNtfy(safeApp, body.kind, body.title, body.message);

    req.log.info({ app: safeApp, kind: body.kind, logFile }, "public event received");
    return { ok: true, logFile };
  });
}
