/**
 * MCP Proxy — connects as MCP CLIENT to child MCP servers and re-exposes
 * their tools under this hub server. Mirrors the bounded-LRU pattern from
 * bc-obs_c3-services-mcp/src/code/mcp/tools/proxy-mcp.ts (no shared symlink
 * yet — duplicated to keep cloudy-apps-communication-mcp's container build context self-contained
 * for the docker/build-push-action layer cache).
 *
 * Data flow (no hardcoded URLs):
 *   build.json .proxied_mcps.children[]  → flake.nix resolves via
 *   cloud-data {ip,ports}                → PROXIED_MCPS env var (JSON)
 *   → this module parses it at import time.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const log = (msg: string) => process.stderr.write(`[cloudy-apps-communication-mcp:proxy] ${msg}\n`);

interface ChildMcp { name: string; url: string; }
interface RetryCfg { initial_ms: number; max_ms: number; max_retry_state_entries: number; }
interface ProxiedMcpsCfg { children: ChildMcp[]; retry: RetryCfg; }

const DEFAULT_CFG: ProxiedMcpsCfg = {
  children: [],
  retry: { initial_ms: 10_000, max_ms: 120_000, max_retry_state_entries: 16 },
};

function loadConfig(): ProxiedMcpsCfg {
  const raw = process.env.PROXIED_MCPS;
  if (!raw) { log("PROXIED_MCPS env var not set — no child MCPs will be proxied"); return DEFAULT_CFG; }
  try {
    const parsed = JSON.parse(raw) as Partial<ProxiedMcpsCfg>;
    return {
      children: parsed.children ?? [],
      retry: {
        initial_ms: parsed.retry?.initial_ms ?? DEFAULT_CFG.retry.initial_ms,
        max_ms: parsed.retry?.max_ms ?? DEFAULT_CFG.retry.max_ms,
        max_retry_state_entries: parsed.retry?.max_retry_state_entries ?? DEFAULT_CFG.retry.max_retry_state_entries,
      },
    };
  } catch (err) { log(`PROXIED_MCPS JSON parse failed: ${err} — defaults`); return DEFAULT_CFG; }
}

const CFG: ProxiedMcpsCfg = loadConfig();
const CHILDREN: ChildMcp[] = CFG.children;

log(`config: children=[${CHILDREN.map((c) => c.name).join(",")}] retry(initial=${CFG.retry.initial_ms}ms,max=${CFG.retry.max_ms}ms,cap=${CFG.retry.max_retry_state_entries})`);

interface RetryEntry { nextAttempt: number; intervalMs: number; }
const retryState = new Map<string, RetryEntry>();

function touchRetryEntry(name: string, entry: RetryEntry): void {
  if (retryState.has(name)) retryState.delete(name);
  retryState.set(name, entry);
  while (retryState.size > CFG.retry.max_retry_state_entries) {
    const oldestKey = retryState.keys().next().value;
    if (oldestKey === undefined) break;
    retryState.delete(oldestKey);
    log(`retry-state LRU evicted ${oldestKey} (cap=${CFG.retry.max_retry_state_entries})`);
  }
}

export const connectedChildren = new Set<string>();
let retryTimer: ReturnType<typeof setInterval> | null = null;
let activeServer: McpServer | null = null;

export async function registerProxiedMcpTools(server: McpServer): Promise<void> {
  activeServer = server;
  for (const child of CHILDREN) {
    try { await connectChild(server, child); }
    catch (err) { log(`${child.name}: failed to connect (${err}) — will retry in background`); }
  }
}

export function startProxyRetryLoop(server: McpServer): void {
  activeServer = server;
  for (const c of CHILDREN) {
    if (!retryState.has(c.name)) touchRetryEntry(c.name, { nextAttempt: 0, intervalMs: CFG.retry.initial_ms });
  }
  if (retryTimer !== null) return;
  retryTimer = setInterval(async () => {
    const srv = activeServer;
    if (!srv) return;
    const now = Date.now();
    const pending = CHILDREN.filter((c) => !connectedChildren.has(c.name));
    if (pending.length === 0) return;
    for (const child of pending) {
      const state = retryState.get(child.name);
      if (!state || now < state.nextAttempt) continue;
      try {
        await connectChild(srv, child);
        log(`${child.name}: late-connected — sending tools/list_changed`);
        srv.sendToolListChanged();
        touchRetryEntry(child.name, { nextAttempt: 0, intervalMs: CFG.retry.initial_ms });
      } catch {
        const nextInterval = Math.min(state.intervalMs * 2, CFG.retry.max_ms);
        touchRetryEntry(child.name, { nextAttempt: now + state.intervalMs, intervalMs: nextInterval });
      }
    }
  }, CFG.retry.initial_ms);
}

// The MCP SDK's StreamableHTTPClientTransport has no built-in timeout on its
// underlying fetch(), so a child that's unreachable at the network level
// (dropped SYN, not refused) hangs on Node's default undici connect timeout
// — MEASURED 10s per attempt against a firewall-dropped destination, and
// registerProxiedMcpTools() is called fresh for every new client session
// (createMcpServer() in http.ts), so this is squarely in the request path
// even though the outer call is "fire and forget" from http.ts's point of
// view: a caller that awaits registerProxiedMcpTools() (there isn't one
// today, but a future refactor could easily add one without noticing this)
// or any code path that ends up serialised behind it inherits the hang.
// Bounding it here is strictly defensive — it cannot make a working child
// connect any slower, only caps how long a BROKEN one can block.
const CHILD_CONNECT_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function connectChild(server: McpServer, child: ChildMcp): Promise<void> {
  if (connectedChildren.has(child.name)) return;
  const transport = new StreamableHTTPClientTransport(new URL(child.url));
  const client = new Client({ name: "cloudy-apps-communication-mcp-proxy", version: "1.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), CHILD_CONNECT_TIMEOUT_MS, `${child.name}: connect`);
  }
  catch (err) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw err;
  }
  const { tools } = await withTimeout(client.listTools(), CHILD_CONNECT_TIMEOUT_MS, `${child.name}: listTools`);
  log(`${child.name}: discovered ${tools.length} tools at ${child.url}`);
  for (const tool of tools) {
    const zodShape = jsonSchemaToZod(tool.inputSchema);
    server.tool(
      tool.name,
      tool.description ?? `[${child.name}] ${tool.name}`,
      zodShape,
      async (args) => {
        const result = await client.callTool({ name: tool.name, arguments: args });
        return result as { content: Array<{ type: "text"; text: string }> };
      },
    );
  }
  connectedChildren.add(child.name);
  log(`${child.name}: registered ${tools.length} proxied tools`);
}

function jsonSchemaToZod(inputSchema?: { properties?: Record<string, any>; required?: string[] }): Record<string, z.ZodTypeAny> {
  const props = (inputSchema?.properties ?? {}) as Record<string, any>;
  const required = new Set(inputSchema?.required ?? []);
  const zodShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case "number": case "integer": field = z.number(); break;
      case "boolean": field = z.boolean(); break;
      case "array": field = z.array(z.any()); break;
      default: field = z.string(); break;
    }
    if (prop.description) field = field.describe(prop.description);
    if (!required.has(key)) field = field.optional();
    zodShape[key] = field;
  }
  return zodShape;
}
