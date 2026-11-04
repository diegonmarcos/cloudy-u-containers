// Stateless Streamable HTTP: a fresh server + transport per request (the router
// holds no session state, so the singleton-session workaround of the sibling
// MCPs is not needed).
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "./router.ts";
import { SELF, loadCatalog } from "./catalog.ts";
import { clientBackend } from "./client-backend.ts";
import { registerRouterTools } from "./tools/router-tools.ts";

const log = (m: string) => process.stderr.write(`[cloudy-all-mcp] ${m}\n`);
export const router = new Router(loadCatalog(), clientBackend, { selfName: SELF });

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: SELF, version: "1.0.0" });
  registerRouterTools(server, router);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (url.pathname !== "/mcp") { res.writeHead(404); res.end(JSON.stringify({ error: "Not Found" })); return; }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer();
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startMcpHttpServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      handle(req, res).catch((err) => {
        log(`Error: ${err}`);
        if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: "Internal Server Error" })); }
      });
    });
    s.listen(port, process.env.MCP_HTTP_HOST || "0.0.0.0", () => { log(`listening on :${port}`); resolve(); });
  });
}
