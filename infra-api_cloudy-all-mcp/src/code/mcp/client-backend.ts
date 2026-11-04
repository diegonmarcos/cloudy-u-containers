// client-backend.ts — the SDK-backed Backend: one short-lived MCP client per
// operation, trying each of the entry's urls in order (mesh first, public with
// the bearer second). Stateless on purpose: no pooled sessions to go stale.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Backend, ServerEntry, ToolInfo } from "./router.ts";

const TIMEOUT_MS = parseInt(process.env.ROUTER_TIMEOUT_MS || "30000", 10);

function bearer(): string | undefined {
  return process.env.ROUTER_BEARER || process.env.FLEET_BEARER || undefined;
}

async function withClient<T>(entry: ServerEntry, fn: (c: Client) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const url of entry.urls) {
    const isPublic = url.startsWith("https://");
    if (isPublic && !bearer()) { errors.push(`${url}: no ROUTER_BEARER for the public route`); continue; }
    const client = new Client({ name: "cloudy-all-mcp", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: isPublic ? { headers: { Authorization: `Bearer ${bearer()}` } } : undefined,
    });
    try {
      await client.connect(transport, { timeout: TIMEOUT_MS });
      return await fn(client);
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await client.close().catch(() => {});
    }
  }
  throw new Error(errors.join(" | ") || "no endpoint configured");
}

export const clientBackend: Backend = {
  async listTools(entry) {
    return withClient(entry, async (c) => {
      const out: ToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const r = await c.listTools(cursor ? { cursor } : undefined, { timeout: TIMEOUT_MS });
        for (const t of r.tools) out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        cursor = r.nextCursor;
      } while (cursor);
      return out;
    });
  },
  async callTool(entry, tool, args) {
    return withClient(entry, (c) => c.callTool({ name: tool, arguments: args }, undefined, { timeout: TIMEOUT_MS }));
  },
};
