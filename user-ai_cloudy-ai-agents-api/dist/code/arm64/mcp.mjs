// mcp.mjs — MCP tool-runner with INDEX/SEARCH token discipline.
//
// Instead of dumping every MCP server's full tool schema catalog into every
// model call (expensive, and most tools are irrelevant to any given turn),
// the model only ever sees two meta-tools: tool_search (find candidate tools
// by keyword) and tool_call (invoke one by name). The real catalog is built
// lazily, once, from the 6 HTTP MCP servers behind mcp.diegonmarcos.com and
// cached in-process.
//
// Env:
//   MCP_ENABLED        — "0" disables outright (default on)
//   MCP_BEARER_TOKEN   — shared bearer JWT for all 6 servers; empty = disabled

export const MCP_ENABLED = (process.env.MCP_ENABLED ?? "1") !== "0";
const MCP_BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || "";

export const MCP_SERVERS = [
  { key: "cloud-infra",      url: "https://mcp.diegonmarcos.com/c3-infra-mcp/mcp" },
  { key: "cloud-cgc-pub-mcp", url: "https://mcp.diegonmarcos.com/cloud-cgc-pub-mcp/mcp" },
  { key: "cloud-services",   url: "https://mcp.diegonmarcos.com/c3-services-mcp/mcp" },
  { key: "cloud-mail-mcp",         url: "https://mcp.diegonmarcos.com/mail-mcp/mcp" },
  { key: "google-workspace", url: "https://mcp.diegonmarcos.com/g-workspace/mcp" },
  { key: "google-personal",  url: "https://mcp.diegonmarcos.com/g-personal/mcp" },
];

if (MCP_ENABLED && !MCP_BEARER_TOKEN) console.error("[my-ai-api] mcp: MCP_BEARER_TOKEN unset — MCP tools disabled");

export const mcpEnabled = () => MCP_ENABLED && !!MCP_BEARER_TOKEN;

// ── session ids per server (lazy, cached) ────────────────────────────────
const sessionIds = new Map(); // key -> Mcp-Session-Id

// Parse either application/json or text/event-stream (SSE `data: {...}` lines).
const parseMcpResponse = async (r) => {
  const ct = r.headers.get("content-type") || "";
  const body = await r.text();
  if (ct.includes("text/event-stream")) {
    let last = null;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t.startsWith("data:")) {
        const jsonStr = t.slice(5).trim();
        if (jsonStr) { try { last = JSON.parse(jsonStr); } catch {} }
      }
    }
    return last;
  }
  try { return JSON.parse(body); } catch { return null; }
};

const rawMcpPost = async (server, body, extraHeaders = {}) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "authorization": `Bearer ${MCP_BEARER_TOKEN}`,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    const sid = r.headers.get("mcp-session-id");
    if (sid) sessionIds.set(server.key, sid);
    return r;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`mcp ${server.key} timeout`);
    throw e;
  }
};

let nextId = 1;

// Ensure the initialize/notifications/initialized handshake has happened for
// this server (once, cached via sessionIds having a value).
const ensureSession = async (server) => {
  if (sessionIds.has(server.key)) return;
  const r = await rawMcpPost(server, {
    jsonrpc: "2.0", id: nextId++, method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "my-ai-api", version: "1.0.0" },
    },
  });
  if (!r.ok) throw new Error(`mcp ${server.key} initialize ${r.status}`);
  await parseMcpResponse(r);
  if (!sessionIds.has(server.key)) throw new Error(`mcp ${server.key}: no Mcp-Session-Id returned`);
  const sid = sessionIds.get(server.key);
  // notifications/initialized — no response body expected, fire and ignore.
  await rawMcpPost(server, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid }).catch(() => {});
};

// Minimal Streamable-HTTP JSON-RPC client. Skips (never throws to caller) a
// failing server.
export const mcpRequest = async (server, method, params = {}) => {
  await ensureSession(server);
  const sid = sessionIds.get(server.key);
  const r = await rawMcpPost(
    server,
    { jsonrpc: "2.0", id: nextId++, method, params },
    sid ? { "mcp-session-id": sid } : {}
  );
  if (!r.ok) throw new Error(`mcp ${server.key} ${method} ${r.status}`);
  const j = await parseMcpResponse(r);
  if (j?.error) throw new Error(`mcp ${server.key} ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j?.result;
};

// ── catalog (built once, lazily) ─────────────────────────────────────────
let catalog = null; // [{server, name, description, inputSchema}]
let catalogPromise = null;

const buildIndexOnce = async () => {
  const out = [];
  for (const server of MCP_SERVERS) {
    try {
      const result = await mcpRequest(server, "tools/list", {});
      const tools = result?.tools || [];
      for (const tool of tools) {
        out.push({
          server: server.key,
          name: tool.name,
          description: tool.description || "",
          inputSchema: tool.inputSchema || {},
        });
      }
      console.log(`[my-ai-api] mcp: ${server.key} — ${tools.length} tools`);
    } catch (e) {
      console.error(`[my-ai-api] mcp: ${server.key} skipped (${e.message})`);
    }
  }
  return out;
};

export const buildIndex = async () => {
  if (catalog) return catalog;
  if (!catalogPromise) catalogPromise = buildIndexOnce().then((c) => (catalog = c));
  return catalogPromise;
};

export const getServerCounts = async () => {
  if (!mcpEnabled()) return null;
  const cat = await buildIndex();
  const counts = new Map();
  for (const s of MCP_SERVERS) counts.set(s.key, 0);
  for (const t of cat) counts.set(t.server, (counts.get(t.server) || 0) + 1);
  return [...counts.entries()].map(([server, count]) => ({ server, count }));
};

// ── ranking: simple token-overlap score of query vs (name+" "+description) ──
const tokenize = (s) => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];

const scoreTool = (queryTokens, tool) => {
  const haystack = tokenize(`${tool.name} ${tool.description}`);
  const hset = new Set(haystack);
  let score = 0;
  for (const qt of queryTokens) if (hset.has(qt)) score++;
  return score;
};

export const searchTools = async (query, limit = 15) => {
  if (!mcpEnabled()) return [];
  const cat = await buildIndex();
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return cat.slice(0, limit).map((t) => ({ name: t.name, description: t.description }));
  return cat
    .map((t) => ({ t, score: scoreTool(qTokens, t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => ({ name: x.t.name, description: x.t.description }));
};

// ── meta-tools (OpenAI function-tool shape) ──────────────────────────────
export const metaTools = () => [
  {
    type: "function",
    function: {
      name: "tool_search",
      description: "Search the catalog of available MCP tools by keyword. Returns matching tool names + descriptions (no schemas). Call this before tool_call to discover the right tool name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "keywords describing the tool you need" },
          limit: { type: "integer", description: "max results (default 15)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tool_call",
      description: "Call a specific MCP tool by name (as returned by tool_search) with arguments matching its inputSchema.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "exact tool name from tool_search" },
          arguments: { type: "object", description: "arguments object for the tool" },
        },
        required: ["name"],
      },
    },
  },
];

// Extract a plain-string result from an MCP tools/call response's content array.
const stringifyContent = (content) => {
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => {
      if (part?.type === "text") return part.text ?? "";
      return JSON.stringify(part);
    })
    .join("\n");
};

const callTool = async (name, args) => {
  const cat = await buildIndex();
  const entry = cat.find((t) => t.name === name);
  if (!entry) throw new Error(`unknown tool: ${name}`);
  const server = MCP_SERVERS.find((s) => s.key === entry.server);
  const result = await mcpRequest(server, "tools/call", { name, arguments: args || {} });
  if (result?.isError) throw new Error(stringifyContent(result.content) || "tool call failed");
  return stringifyContent(result?.content);
};

// ── dispatch one OpenAI-style tool_call object ({id, function:{name,arguments}}) ──
export const handleToolCall = async (toolCall) => {
  const fnName = toolCall?.function?.name;
  let args = {};
  try { args = JSON.parse(toolCall?.function?.arguments || "{}"); } catch { /* leave {} */ }
  try {
    if (fnName === "tool_search") {
      const results = await searchTools(args.query, args.limit || 15);
      return JSON.stringify(results);
    }
    if (fnName === "tool_call") {
      return await callTool(args.name, args.arguments);
    }
    return `error: unknown meta-tool ${fnName}`;
  } catch (e) {
    return `error: ${e.message || e}`;
  }
};

// ── agentic loop: callModel(messages, tools) -> assistant message ────────
export const runAgenticLoop = async ({ callModel, messages, maxIters = 8 }) => {
  let iters = 0;
  let message = await callModel(messages, metaTools());
  while (message?.tool_calls?.length && iters < maxIters) {
    messages.push(message);
    for (const toolCall of message.tool_calls) {
      const resultString = await handleToolCall(toolCall);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultString });
    }
    iters++;
    message = await callModel(messages, metaTools());
  }
  return message?.content ?? "";
};
