/**
 * Health tools — health tracking data.
 * Currently a placeholder — data source not yet connected.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerHealthTools(server: McpServer) {

  // ── Health Data (TBD) ─────────────────────────────────────────────
  server.tool(
    "health_data",
    "Access health tracking data — data source not yet connected.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: "# Health Data\n\nData source not yet connected.\n\nPlanned: Import health tracker exports (steps, heart rate, sleep, workouts) for search and analysis.",
      }],
    })
  );
}
