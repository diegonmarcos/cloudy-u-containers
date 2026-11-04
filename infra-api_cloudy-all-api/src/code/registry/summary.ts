/**
 * The one-line-per-service view used by the `registry.services_list` tool.
 *
 * It lives here, exported and tested, because the projection it performs is
 * where the tool crashed. `ServiceDefinition.api` is OPTIONAL — a peer may
 * declare an `api` block, an `mcp` block, or both, and `definitions.ts` only
 * sets `def.api` when `has_api` is true. The caller read `s.api.type` straight
 * through, so the first MCP-only peer in the list threw
 * `Cannot read properties of undefined (reading 'type')` and took the WHOLE
 * list down with it — 36 services reported as one error.
 *
 * Ten of the thirty-six services in the deployed peer map are MCP-only, so the
 * tool could never return anything else. It also made the registry look broken
 * when it was not: this error is only reachable once the registry has loaded
 * something, an empty one would have returned a clean `{"services":[]}`.
 */
import type { ServiceDefinition } from "./types.js";

export interface ServiceSummary {
  name: string;
  displayName: string;
  description: string;
  vm: string;
  apiType: string | null;
  endpointCount: number;
  hasSpec: boolean;
  mcpTransport: string | null;
  toolsCount: number;
}

/** Summarise every service, whether it declares an API, an MCP, or both. */
export function summarizeServices(definitions: ServiceDefinition[]): ServiceSummary[] {
  return definitions.map((service) => ({
    name: service.name,
    displayName: service.displayName,
    description: service.description,
    vm: service.vm,
    apiType: service.api?.type ?? null,
    endpointCount: service.api?.endpointCount ?? 0,
    hasSpec: Boolean(service.api?.specUrl),
    mcpTransport: service.mcp?.transport ?? null,
    toolsCount: service.mcp?.toolsCount ?? 0,
  }));
}
