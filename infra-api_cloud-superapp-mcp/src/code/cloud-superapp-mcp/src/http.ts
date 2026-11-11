import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAll } from "../../lib-mcp/src/tools.js";
import { loadModules } from "../../lib-mcp/src/registry.js";

// The address the persistent session dials: the one the listener binds (see startMcpHttpServer).
const SELF_HOST = !process.env.MCP_HTTP_HOST || process.env.MCP_HTTP_HOST === "0.0.0.0" ? "127.0.0.1" : process.env.MCP_HTTP_HOST;

const log = (msg: string) => process.stderr.write(`[cloud-superapp-mcp-http] ${msg}\n`);
const SESSION_ID = "cloud-superapp-mcp-session";

async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: "cloud-superapp-mcp", version: "1.0.0" });
  const modules = await loadModules();
  registerAll(server, modules);
  return server;
}

let session: { transport: StreamableHTTPServerTransport; server: McpServer } | null = null;

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/mcp") { res.writeHead(404); res.end(JSON.stringify({ error: "Not Found" })); return; }
  if (req.method === "DELETE") { res.writeHead(200); res.end(); return; }
  if (!session) { res.writeHead(503); res.end(JSON.stringify({ error: "Initializing" })); return; }

  const clientSessionId = req.headers["mcp-session-id"] as string | undefined;

  if (req.method === "POST" && !clientSessionId) {
    log("New client initialize — recreating session");
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => SESSION_ID });
    const server = await createMcpServer();
    await server.connect(transport);
    session = { transport, server };
    await session.transport.handleRequest(req, res);
  } else if (clientSessionId === SESSION_ID) {
    await session.transport.handleRequest(req, res);
  } else if (clientSessionId && clientSessionId !== SESSION_ID) {
    log(`Session swap: ${clientSessionId} → ${SESSION_ID}`);
    req.headers["mcp-session-id"] = SESSION_ID;
    await session.transport.handleRequest(req, res);
  } else {
    res.writeHead(400); res.end(JSON.stringify({ error: "Bad Request" }));
  }
}

async function initSession(port: number): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => SESSION_ID });
  const server = await createMcpServer();
  await server.connect(transport);
  session = { transport, server };

  await new Promise<void>((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "self", version: "1.0" } } });
    const req = httpRequest({ hostname: SELF_HOST, port, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.on("data", () => {}); res.on("end", () => {
        const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
        const nr = httpRequest({ hostname: SELF_HOST, port, path: "/mcp", method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
            "Mcp-Session-Id": SESSION_ID, "Content-Length": Buffer.byteLength(notif) } });
        nr.write(notif); nr.end();
        nr.on("response", (r) => { r.on("data", () => {}); r.on("end", () => resolve()); });
        nr.on("error", () => resolve());
      });
    });
    req.on("error", () => resolve());
    req.write(body); req.end();
  });
  log(`Persistent session ready: ${SESSION_ID}`);
}

export function startMcpHttpServer(port: number = 3113): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = createServer(async (req, res) => {
      try { await handleMcpRequest(req, res); }
      catch (err) { log(`Error: ${err}`); if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: "Internal Server Error" })); } }
    });
    // #1659: bind the address compose.nix declares (MCP_HTTP_HOST = the VM's WG IP). Under host
    // networking a 0.0.0.0 listener sits on every interface and collides with any other host
    // listener on the same port number, whatever address that one binds.
    const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
    httpServer.on("error", (err) => { log(`FATAL listen ${host}:${port}: ${err}`); process.exit(1); });
    httpServer.listen(port, host, async () => {
      log(`MCP Streamable HTTP server listening on ${host}:${port}`);
      await initSession(port);
      resolve();
    });
  });
}
