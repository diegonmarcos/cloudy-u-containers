// ── Backlog tools (#1585): MCP registrations over backlog-core.ts (policy + transport, no SDK imports so it is unit-testable). ──
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { handleBacklog } from "./backlog-core.js";
export { handleBacklog } from "./backlog-core.js";

// ── registry tools (HTTP server, factory.ts): devops.repo.backlog_* ─────────

function wrap(fn: () => Promise<string>) {
  return fn()
    .then((text) => ({ content: [{ type: "text" as const, text }] }))
    .catch((err) => ({ content: [{ type: "text" as const, text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }], isError: true }));
}

export function registerBacklogTools(server: McpServer): void {
  server.tool("devops.repo.backlog_list",
    "Product Backlog (cloudy-a-docs): newest ticket ids with their session folder, the total and the next free id. Read-only.",
    { limit: z.number().int().optional().describe("max ids returned (1-500, default 50)") },
    ({ limit }) => wrap(() => handleBacklog("list", { limit })));
  server.tool("devops.repo.backlog_get",
    "Product Backlog: one ticket JSON by id (e.g. 1585). Read-only.",
    { id: z.string().describe("ticket id, digits, optional leading #") },
    ({ id }) => wrap(() => handleBacklog("get", { id })));
  server.tool("devops.repo.backlog_add",
    "Product Backlog: create a NEW ticket (next free id) as tasks/<session>/<id>.json with status pending. Subject and description are required; nothing existing is touched.",
    { session: z.string().describe("session folder name"), subject: z.string(), description: z.string(), scope: z.record(z.unknown()).optional() },
    (a) => wrap(() => handleBacklog("add", a)));
  server.tool("devops.repo.backlog_update",
    "Product Backlog: merge an update into one ticket. Allowed: status (not 'deleted'), subject, description_append, metadata progress (appended, dated), done, decision, closed, blocker, related. Never deletes or blanks a ticket.",
    { id: z.string(), patch: z.record(z.unknown()).describe("fields to merge, see description") },
    ({ id, patch }) => wrap(() => handleBacklog("update", { id, patch })));
}
