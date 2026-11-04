// ── Operations Routes — "How we run it" ──
// VM, container, and service lifecycle control + push events

import type { FastifyInstance } from "fastify";
import {
  vmStart, vmStop, vmReset,
  containerStart, containerStop, containerRestart,
  serviceStart, serviceStop,
} from "../../shared/libs/control.js";
import { handlePushEvent } from "../../shared/libs/ops.js";
import {
  updateContainer,
  containerStatsOne,
  inspectContainerDetails,
  checkImageUpdate,
  runAllowlistedExecCommand,
  EXEC_COMMAND_ALLOWLIST,
} from "../../shared/libs/docker.js";
import { listContainers } from "../../shared/libs/docker.js";
import { getConfig } from "../../shared/libs/config.js";
import { sshExec } from "../../shared/libs/ssh.js";

const vmIdParams = { type: "object" as const, properties: { vmId: { type: "string" as const } }, required: ["vmId"] };
const vmContainerParams = { type: "object" as const, properties: { vmId: { type: "string" as const }, name: { type: "string" as const } }, required: ["vmId", "name"] };
const vmServiceParams = { type: "object" as const, properties: { vmId: { type: "string" as const }, service: { type: "string" as const } }, required: ["vmId", "service"] };

export async function registerOperationsRoutes(app: FastifyInstance) {
  // VM lifecycle
  app.post<{ Params: { vmId: string } }>(
    "/vms/:vmId/start",
    { schema: { tags: ["Operations"], params: vmIdParams } },
    async (req) => vmStart(req.params.vmId),
  );

  app.post<{ Params: { vmId: string } }>(
    "/vms/:vmId/stop",
    { schema: { tags: ["Operations"], params: vmIdParams } },
    async (req) => vmStop(req.params.vmId),
  );

  app.post<{ Params: { vmId: string } }>(
    "/vms/:vmId/reset",
    { schema: { tags: ["Operations"], params: vmIdParams } },
    async (req) => vmReset(req.params.vmId),
  );

  // Container lifecycle
  app.post<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/start",
    { schema: { tags: ["Operations"], params: vmContainerParams } },
    async (req) => containerStart(req.params.vmId, req.params.name),
  );

  app.post<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/stop",
    { schema: { tags: ["Operations"], params: vmContainerParams } },
    async (req) => containerStop(req.params.vmId, req.params.name),
  );

  app.post<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/restart",
    { schema: { tags: ["Operations"], params: vmContainerParams } },
    async (req) => containerRestart(req.params.vmId, req.params.name),
  );

  // Service lifecycle
  app.post<{ Params: { vmId: string; service: string } }>(
    "/vms/:vmId/services/:service/start",
    { schema: { tags: ["Operations"], params: vmServiceParams } },
    async (req) => serviceStart(req.params.vmId, req.params.service),
  );

  app.post<{ Params: { vmId: string; service: string } }>(
    "/vms/:vmId/services/:service/stop",
    { schema: { tags: ["Operations"], params: vmServiceParams } },
    async (req) => serviceStop(req.params.vmId, req.params.service),
  );

  // ── Push event (GHA → C3 → Dagu) ──

  app.post<{ Body: {
    ref?: string;
    repo?: string;
    sender?: string;
    head_commit?: { id: string; message: string; timestamp: string };
    commits?: Array<{ id: string; message: string; added: string[]; modified: string[]; removed: string[] }>;
    modified_files?: string[];
  } }>(
    "/ops/push-event",
    {
      schema: {
        tags: ["Operations"],
        body: {
          type: "object" as const,
          properties: {
            ref: { type: "string" as const },
            repo: { type: "string" as const },
            sender: { type: "string" as const },
            head_commit: { type: "object" as const },
            commits: { type: "array" as const },
            modified_files: { type: "array" as const, items: { type: "string" as const } },
          },
        },
      },
    },
    async (req) => handlePushEvent(req.body),
  );

  // ── Container update (pull + recreate) ──

  app.post<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/update",
    { schema: { tags: ["Operations"], summary: "Pull latest image and recreate the container", params: vmContainerParams } },
    async (req) => updateContainer(req.params.vmId, req.params.name),
  );

  // ── VM backup ──
  // Tars the volumes declared in this VM's services' `backup` config
  // (same source as /cloud-data/backup-targets in inventory.ts) into
  // timestamped archives on the VM itself under /opt/backups/.

  app.post<{ Params: { vmId: string } }>(
    "/vms/:vmId/backup",
    { schema: { tags: ["Operations"], summary: "Tar declared backup volumes for all services on this VM", params: vmIdParams } },
    async (req, reply) => {
      const { vmId } = req.params;
      const config = getConfig();
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const results: Array<{ service: string; ok: boolean; output: string; archive?: string }> = [];

      for (const [svcName, svc] of Object.entries(config.services)) {
        const s = svc as any;
        if (s.vm !== vmId || !s.backup?.enabled) continue;
        const volumes: string[] = s.backup.volumes ?? [];
        if (volumes.length === 0) continue;

        const archive = `/opt/backups/${svcName}-${ts}.tar.gz`;
        const cmd = `mkdir -p /opt/backups && tar czf ${archive} ${volumes.map((v) => `'${v.replace(/'/g, "'\\''")}'`).join(" ")} 2>&1`;
        const result = sshExec(vmId, cmd, 120_000);
        results.push({ service: svcName, ok: result.ok, output: `${result.stdout}${result.stderr}`.trim(), archive: result.ok ? archive : undefined });
      }

      if (results.length === 0) {
        reply.code(404).send({ error: `No backup-enabled services found for vm ${vmId}` });
        return;
      }

      return { ok: results.every((r) => r.ok), vm: vmId, results };
    },
  );

  // ── Allowlisted container exec (deny-by-default, no shell interpolation) ──

  app.post<{ Params: { vmId: string; name: string }; Body: { command?: string } }>(
    "/vms/:vmId/containers/:name/exec",
    {
      schema: {
        tags: ["Operations"],
        summary: "Run an allowlisted command against a container. Rejects anything not on the allowlist.",
        params: vmContainerParams,
        body: {
          type: "object" as const,
          properties: { command: { type: "string" as const, enum: Object.keys(EXEC_COMMAND_ALLOWLIST) } },
          required: ["command"],
        },
      },
    },
    async (req, reply) => {
      const { command } = req.body ?? {};
      if (!command || !(command in EXEC_COMMAND_ALLOWLIST)) {
        reply.code(400).send({ error: `command must be one of: ${Object.keys(EXEC_COMMAND_ALLOWLIST).join(", ")}` });
        return;
      }
      return runAllowlistedExecCommand(req.params.vmId, req.params.name, command);
    },
  );

  // ── Container inspect (env/mounts/ports/digest, secrets redacted) ──

  app.get<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/inspect",
    { schema: { tags: ["Operations"], summary: "Container config: env (secrets redacted), mounts, ports, image digest", params: vmContainerParams } },
    async (req, reply) => {
      const result = inspectContainerDetails(req.params.vmId, req.params.name);
      if (!result.ok) {
        reply.code(502).send({ error: result.error ?? "inspect failed" });
        return;
      }
      return result.details;
    },
  );

  // ── Container live stats ──

  app.get<{ Params: { vmId: string; name: string } }>(
    "/vms/:vmId/containers/:name/stats",
    { schema: { tags: ["Operations"], summary: "Live docker stats snapshot for one container", params: vmContainerParams } },
    async (req, reply) => {
      const result = containerStatsOne(req.params.vmId, req.params.name);
      if (!result.ok) {
        reply.code(502).send({ error: result.error ?? "stats failed" });
        return;
      }
      return result.stats;
    },
  );

  // ── Fleet-wide update check: image digest vs upstream ──

  app.get(
    "/updates",
    { schema: { tags: ["Operations"], summary: "Per-service image digest vs upstream digest, with a summary count" } },
    async () => {
      const config = getConfig();
      const details: ReturnType<typeof checkImageUpdate>[] = [];

      for (const vmId of Object.keys(config.vms)) {
        if (vmId === "local" || vmId === "all") continue;
        const { containers } = listContainers(vmId, false);
        for (const c of containers) {
          if (!c.name) continue;
          try {
            details.push(checkImageUpdate(vmId, c.name));
          } catch {
            // Unreachable VM or inspect failure — skip rather than fail the whole report.
          }
        }
      }

      const updatesAvailable = details.filter((d) => d.updateAvailable === true);
      return {
        summary: `${updatesAvailable.length} updates available`,
        count: updatesAvailable.length,
        details,
      };
    },
  );
}
