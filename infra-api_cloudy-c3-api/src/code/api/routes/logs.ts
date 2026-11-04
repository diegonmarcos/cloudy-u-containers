// ── Logs Routes — search + live tail over container logs ──
// Logs are pulled on-demand over SSH (docker logs), the exact same mechanism
// files.ts/getContainerLog already uses, then indexed into SQLite (log_lines)
// so repeated searches don't re-fetch, and `q` can filter with a plain LIKE
// (no FTS5 dependency — better-sqlite3 FTS availability isn't guaranteed in
// this build, and LIKE is the simplest thing that actually works).

import { FastifyPluginAsync } from "fastify";
import { spawn } from "child_process";
import { getConfig, resolveVmId, getVmSshAlias } from "../../shared/libs/config.js";
import { sshExecAsync } from "../../shared/libs/async-ssh.js";
import { insertLogLines, searchLogLines, type LogLine } from "../../shared/libs/db.js";
import { validateContainerName } from "../../shared/libs/validators.js";

function guessLevel(line: string): string {
  if (/\b(error|fatal|panic|exception)\b/i.test(line)) return "error";
  if (/\bwarn(ing)?\b/i.test(line)) return "warn";
  return "info";
}

/** Resolve which (vm, container) pairs to pull fresh logs for. */
function resolveTargets(service?: string): Array<{ vm: string; container: string }> {
  const config = getConfig();
  const targets: Array<{ vm: string; container: string }> = [];

  if (service) {
    const svc = config.services[service];
    if (!svc || !svc.vm || svc.vm === "local" || svc.vm === "all") return [];
    for (const c of svc.containers ?? [service]) {
      targets.push({ vm: svc.vm, container: c });
    }
    return targets;
  }

  return targets; // no service given: search only what's already indexed
}

async function pullAndIndex(vm: string, container: string): Promise<void> {
  const result = await sshExecAsync(vm, `docker logs --tail 500 --timestamps ${container} 2>&1`, 15_000);
  if (!result.stdout) return;

  const lines: LogLine[] = [];
  for (const raw of result.stdout.split("\n")) {
    if (!raw.trim()) continue;
    // docker --timestamps prefixes each line with an RFC3339 timestamp
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/);
    const ts = m ? m[1] : new Date().toISOString();
    const text = m ? m[2] : raw;
    lines.push({ ts, vm, container, level: guessLevel(text), line: text.slice(0, 4000) });
  }
  insertLogLines(lines);
}

const P_vmContainer = {
  type: "object" as const,
  properties: { vmId: { type: "string" as const }, container: { type: "string" as const } },
  required: ["vmId", "container"],
};

export const registerLogsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { q?: string; service?: string; level?: string; from?: string; to?: string; limit?: string } }>(
    "/logs/search",
    {
      schema: {
        tags: ["Logs"],
        summary: "Search container logs (pulls fresh logs for `service` if given, then LIKE-searches the index)",
        querystring: {
          type: "object" as const,
          properties: {
            q: { type: "string" as const },
            service: { type: "string" as const },
            level: { type: "string" as const, enum: ["info", "warn", "error"] },
            from: { type: "string" as const },
            to: { type: "string" as const },
            limit: { type: "string" as const },
          },
        },
      },
    },
    async (req) => {
      const { q, service, level, from, to, limit } = req.query;

      const targets = resolveTargets(service);
      if (targets.length > 0) {
        await Promise.all(targets.map((t) => pullAndIndex(t.vm, t.container).catch(() => {})));
      }

      const rows = searchLogLines({
        q,
        level,
        from,
        to,
        limit: limit ? parseInt(limit, 10) : 100,
      });
      return { total: rows.length, lines: rows };
    },
  );

  // ── Live tail via SSE, killing the SSH child on client disconnect ──
  app.get<{ Params: { vmId: string; container: string } }>(
    "/logs/stream/:vmId/:container",
    { schema: { tags: ["Logs"], summary: "SSE live tail of a container's logs", params: P_vmContainer } },
    async (req, reply) => {
      const { vmId: vmParam, container } = req.params;
      validateContainerName(container);
      const vmId = resolveVmId(vmParam);
      const alias = getVmSshAlias(vmId);

      reply.hijack(); // we own the raw response now — fastify must not touch it
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const child = spawn("ssh", [
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        alias, `docker logs -f --tail 20 --timestamps ${container}`,
      ], { stdio: ["ignore", "pipe", "pipe"] });

      const send = (event: string, data: string) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString("utf-8").split("\n")) {
          if (line.trim()) send("log", line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        send("stderr", chunk.toString("utf-8"));
      });
      child.on("close", (code) => {
        send("close", `ssh exited (${code})`);
        try { reply.raw.end(); } catch { /* already closed */ }
      });
      child.on("error", (err) => {
        send("error", err.message);
        try { reply.raw.end(); } catch { /* already closed */ }
      });

      // MUST clean up the SSH child on client disconnect — otherwise every
      // dropped SSE connection leaks an `ssh ... docker logs -f` process.
      const cleanup = () => {
        if (!child.killed) {
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } }, 1_000);
        }
      };
      req.raw.on("close", cleanup);
      reply.raw.on("close", cleanup);
    },
  );
};
