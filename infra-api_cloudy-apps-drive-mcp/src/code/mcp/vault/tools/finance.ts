/**
 * Finance tools — payment cards metadata, financial data.
 * READ-ONLY. Card numbers and sensitive data are NEVER exposed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { getVaultPath } from "../config.js";

export function registerFinanceTools(server: McpServer) {

  // ── Payment Cards Summary ─────────────────────────────────────────
  server.tool(
    "finance_cards",
    "List payment cards — card names/labels only. Card numbers, CVVs, and expiry dates are NEVER exposed.",
    {},
    async () => {
      const cardsDir = join(getVaultPath(), "C1_Payment");
      if (!existsSync(cardsDir)) {
        return { content: [{ type: "text" as const, text: "Payment directory not found" }] };
      }

      const items = readdirSync(cardsDir)
        .filter(f => !f.startsWith("."))
        .map(f => `- ${basename(f).replace(/\.(txt|json|yaml)$/, "").replace(/_/g, " ")}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `# Payment Cards\n\n${items || "No cards found."}\n\n_Card numbers, CVVs, and expiry dates are NEVER exposed._`,
        }],
      };
    }
  );

  // ── WiFi Configs ──────────────────────────────────────────────────
  server.tool(
    "finance_wifi",
    "List saved WiFi network names — SSIDs only, no passwords.",
    {},
    async () => {
      const wifiDir = join(getVaultPath(), "B2_Wifi");
      if (!existsSync(wifiDir)) {
        return { content: [{ type: "text" as const, text: "WiFi directory not found" }] };
      }

      const items = readdirSync(wifiDir)
        .filter(f => !f.startsWith("."))
        .map(f => `- ${basename(f).replace(/\.(nmconnection|conf|txt)$/, "")}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `# Saved WiFi Networks\n\n${items || "No networks found."}\n\n_WiFi passwords are NEVER exposed._`,
        }],
      };
    }
  );
}
