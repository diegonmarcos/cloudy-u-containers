// Stateless Streamable HTTP, one server per request, so the tool list can depend
// on the caller: `drive` always; `cloud_vault` only when gate.vaultAllowed().
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerDriveTool } from "./tools/drive.js";
import { registerMetaTool as registerVaultTool } from "./vault/tools/meta.js";
import { vaultAllowed } from "./gate.js";

const log = (msg: string) => process.stderr.write(`[cloudy-apps-drive-mcp-http] ${msg}\n`);

export function createMcpServer(withVault: boolean): McpServer {
  const server = new McpServer({ name: "cloudy-apps-drive-mcp", version: "2.0.0" });
  registerDriveTool(server);
  if (withVault) registerVaultTool(server);
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/health") { res.writeHead(200); res.end("ok"); return; }
  if (url.pathname !== "/mcp") { res.writeHead(404); res.end(JSON.stringify({ error: "Not Found" })); return; }
  const withVault = vaultAllowed({ remoteAddress: req.socket.remoteAddress, headers: req.headers });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer(withVault);
  res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

export function startMcpHttpServer(port: number = 3109): Promise<void> {
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
