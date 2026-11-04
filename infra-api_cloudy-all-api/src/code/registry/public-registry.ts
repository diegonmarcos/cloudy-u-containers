/**
 * Public MCP Registry client — queries registry.modelcontextprotocol.io
 * for discovering MCP servers not available in Diego's private infrastructure.
 *
 * Fallback layer: local registry (definitions.ts) is always checked first.
 */
import { rawHttpRequest } from "../shared/http.js";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0.1";

export interface PublicMcpServer {
  name: string;
  description: string;
  version?: string;
  source?: {
    type: string;
    owner?: string;
    repo?: string;
    url?: string;
  };
  tools?: Array<{
    name: string;
    description?: string;
  }>;
}

export interface PublicSearchResult {
  servers: PublicMcpServer[];
  total: number;
  query: string;
}

/**
 * Search the public MCP registry for servers matching a query.
 */
export function searchPublicRegistry(query: string, limit = 10): PublicSearchResult {
  const url = `${REGISTRY_BASE}/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
  const result = rawHttpRequest("GET", url, undefined, 15_000);

  if (!result.ok || !result.data) {
    return { servers: [], total: 0, query };
  }

  const data = result.data as { servers?: unknown[]; items?: unknown[]; nextCursor?: string };
  const raw = (data.servers ?? data.items ?? (Array.isArray(result.data) ? result.data : [])) as PublicMcpServer[];

  const servers = raw.map((s) => ({
    name: s.name ?? "unknown",
    description: s.description ?? "",
    version: s.version,
    source: s.source,
    tools: s.tools?.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  }));

  return { servers, total: servers.length, query };
}

/**
 * Get details for a specific server from the public registry.
 */
export function getPublicServer(serverName: string, version = "latest"): PublicMcpServer | null {
  const encoded = encodeURIComponent(serverName);
  const url = `${REGISTRY_BASE}/servers/${encoded}/versions/${version}`;
  const result = rawHttpRequest("GET", url, undefined, 15_000);

  if (!result.ok || !result.data) return null;

  const s = result.data as PublicMcpServer;
  return {
    name: s.name ?? serverName,
    description: s.description ?? "",
    version: s.version,
    source: s.source,
    tools: s.tools,
  };
}
