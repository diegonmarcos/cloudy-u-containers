export type ApiType = "openapi" | "custom-rest" | "custom-protocol" | "no-api";
export type McpTransport = "stdio" | "sse" | "http" | "streamable-http";

export interface ApiCapability {
  type: ApiType;
  specUrl?: string;
  specPath?: string;
  basePath?: string;
  endpointCount: number;
  description: string;
  auth?: string;
}

export interface McpCapability {
  transport: McpTransport;
  endpointPath?: string;
  toolsCount: number;
  resourcesCount: number;
  promptsCount: number;
  description: string;
  auth?: string;
  sdk?: string;
}

export interface ServiceDefinition {
  name: string;
  displayName: string;
  description: string;
  vm: string;
  wgIp: string;
  port: number;
  domain?: string;
  baseUrl: string;
  api?: ApiCapability;
  mcp?: McpCapability;
}
