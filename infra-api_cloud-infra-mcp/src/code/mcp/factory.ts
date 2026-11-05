/** Builds the tool registry and the MCP server (no side effects on import). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolRegistry, registerGrouped, registerLegacy } from "./registry.js";

// A) Observability
import { registerHealthCloudTools } from "./tools/health_cloud.js";
import { registerHealthMailTools } from "./tools/health_mail.js";
import { registerObservabilityReadTools } from "./tools/observability-read.js";
import { registerFinOpsTools } from "./tools/finops.js";
import { registerFinOpsCloudTools } from "./tools/finops-cloud.js";
import { registerObservabilityExecTools } from "./tools/observability.js";
import { registerPhoneApiTools } from "./tools/phone-api.js";
// B) DevOps
import { registerWorkflowTools } from "./tools/workflows.js";
import { registerVpsOpsTools } from "./tools/vps-ops.js";
import { registerCloudflareTools } from "./tools/cloudflare.js";
import { registerDeliveryTools } from "./tools/delivery.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerVmFilesTools } from "./tools/vm-files.js";
import { registerMailOpsTools } from "./tools/mail-ops.js";
import { registerFrontendExecTools } from "./tools/frontend.js";
import { registerTelegramTools } from "./tools/telegram.js";
// C) Security
import { registerSecurityExecTools } from "./tools/security.js";
import { registerPluginTools } from "./tools/plugin.js";
// Resources
import { registerResources } from "./resources/index.js";

/** The ONE registry every tool is declared into. */
export function buildRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  const s = reg as unknown as McpServer; // register*Tools only call .tool()
  registerHealthCloudTools(s);
  registerHealthMailTools(s);
  registerObservabilityReadTools(s);
  registerFinOpsTools(s);
  registerFinOpsCloudTools(s);
  registerObservabilityExecTools(s);
  registerPhoneApiTools(s); // #1490 the phone's Cloud-Webserver mesh endpoint: public, mesh, apps logs
  registerWorkflowTools(s);
  registerVpsOpsTools(s);
  registerCloudflareTools(s);
  registerDeliveryTools(s);
  registerOperationsTools(s);
  registerVmFilesTools(s);
  registerMailOpsTools(s);
  registerFrontendExecTools(s);
  registerTelegramTools(s);
  registerSecurityExecTools(s);
  registerPluginTools(s);
  return reg;
}

export function createMcpServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const server = new McpServer({ name: "cloud-infra", version: "6.0.0" });
  const reg = buildRegistry();
  registerGrouped(server, reg);
  // Deprecated: old per-tool names, default OFF, remove after 2026-11-22 (30 days).
  if (env.MCP_LEGACY_TOOLS === "1") registerLegacy(server, reg);
  registerResources(server);
  return server;
}
