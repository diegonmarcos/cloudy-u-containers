#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main(): Promise<void> {
  const http = await import("./http.ts");
  if (process.argv.includes("--http")) {
    await http.startMcpHttpServer(parseInt(process.env.MCP_HTTP_PORT || process.env.PORT || "3112", 10));
    return;
  }
  await http.createMcpServer().connect(new StdioServerTransport());
}

main().catch((err) => { process.stderr.write(`[cloudy-all-mcp] Fatal: ${err}\n`); process.exit(1); });
