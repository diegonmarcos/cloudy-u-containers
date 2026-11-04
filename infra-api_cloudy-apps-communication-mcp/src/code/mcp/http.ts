import { createServer, IncomingMessage, ServerResponse, request as httpRequest } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerMetaTool } from "./tools/meta.js";
import { registerMattermostTool } from "./mattermost/meta.js";
import { registerProxiedMcpTools, startProxyRetryLoop } from "./shared/proxy-mcp.js";

const log = (msg: string) => process.stderr.write(`[cloudy-apps-communication-mcp-http] ${msg}\n`);
const SESSION_ID = "cloudy-apps-communication-mcp-session";

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "cloudy-apps-communication-mcp", version: "2.0.0" });
  registerMetaTool(server);
  registerMattermostTool(server);
  // Best-effort attach to proxied MCPs (google-personal-mcp et al). Failed
  // children are picked up by the background retry loop started below.
  registerProxiedMcpTools(server).catch((e) => log(`proxy attach failed: ${e}`));
  startProxyRetryLoop(server);
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
    const server = createMcpServer();
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
  const server = createMcpServer();
  await server.connect(transport);
  session = { transport, server };

  await new Promise<void>((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "self", version: "1.0" } } });
    const req = httpRequest({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      res.on("data", () => {}); res.on("end", () => {
        const notif = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
        const nr = httpRequest({ hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
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

export function startMcpHttpServer(port: number = 3103): Promise<void> {
  return new Promise((resolve) => {
    const httpServer = createServer(async (req, res) => {
      try { await handleMcpRequest(req, res); }
      catch (err) { log(`Error: ${err}`); if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: "Internal Server Error" })); } }
    });
    // Bind host is configurable, defaulting to 0.0.0.0 for backward
    // compatibility. Under network_mode:host (which this service now uses —
    // see compose.nix) 0.0.0.0 would publish on EVERY host interface, so the
    // compose file pins MCP_HTTP_HOST to the WG mesh IP, matching the
    // sibling MCPs (google-personal-mcp, google-workspace-mcp). The VM
    // firewall's INPUT policy is DROP anyway, so this is defence in depth
    // rather than the only guard.
    const bindHost = process.env.MCP_HTTP_HOST || "0.0.0.0";
    httpServer.listen(port, bindHost, async () => {
      log(`MCP Streamable HTTP server listening on ${bindHost}:${port}`);
      await initSession(port);
      resolve();
    });
  });
}
