#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const http = await import("./http.js");
  if (process.argv.includes("--http")) {
    await http.startMcpHttpServer(parseInt(process.env.MCP_HTTP_PORT || process.env.PORT || "3109", 10));
    return;
  }
  // stdio is a local process of the owner: both tools.
  await http.createMcpServer(true).connect(new StdioServerTransport());
}

main().catch((err) => { process.stderr.write(`[cloudy-apps-drive-mcp] Fatal: ${err}\n`); process.exit(1); });
