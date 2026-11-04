import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Router } from "../router.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
// A child's own CallToolResult (has content[]) is passed through untouched.
const passthrough = (v: any) => (v && Array.isArray(v.content) ? v : text(v));

export function registerRouterTools(server: McpServer, router: Router): void {
  server.tool("list_servers", "List the fleet MCP servers behind this router (name, aliases, purpose).", {}, async () =>
    text(router.listServers()));

  server.tool("list_tools", "List one server's tools with their input schemas. Old cloud-* names work as aliases.",
    { server: z.string().describe("server name from list_servers") },
    async ({ server: s }) => passthrough(await router.listTools(s)));

  server.tool("call", "Call one tool on one fleet server.",
    {
      server: z.string().describe("server name from list_servers"),
      tool: z.string().describe("tool name from list_tools"),
      args: z.record(z.unknown()).optional().describe("tool arguments"),
    },
    async ({ server: s, tool, args }) => passthrough(await router.call(s, tool, args)));
}
