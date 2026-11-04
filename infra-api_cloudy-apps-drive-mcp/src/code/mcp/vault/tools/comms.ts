/**
 * Comms tools — email, messaging, notes.
 * Email access proxies through mailu-mcp or direct IMAP.
 * WhatsApp and Cloud Notes are TBD placeholders.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerCommsTools(server: McpServer) {

  // ── Email Status ──────────────────────────────────────────────────
  server.tool(
    "comms_email_status",
    "Check email access status. Email is accessed via the mailu-mcp server — use mailu-mcp tools (mail_list_messages, mail_read, mail_search) for actual email operations.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: `# Email Access

Email is managed via the **mailu-mcp** MCP server (separate connection).

## Available mailu-mcp tools:
- \`mail_list_messages\` — list messages in a folder
- \`mail_read\` — read a specific message
- \`mail_search\` — search messages
- \`mail_send\` — send email
- \`mail_reply\` — reply to a message
- \`mail_forward\` — forward a message
- \`mail_list_folders\` — list mailbox folders

Use those tools directly for email operations.`,
      }],
    })
  );

  // ── WhatsApp (TBD) ───────────────────────────────────────────────
  server.tool(
    "comms_whatsapp",
    "Access WhatsApp messages — data source not yet connected.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: "# WhatsApp\n\nData source not yet connected.\n\nPlanned: Read WhatsApp chat exports/backups for search and retrieval.",
      }],
    })
  );

  // ── Notes / Cloud Notes (TBD) ─────────────────────────────────────────
  server.tool(
    "comms_notes",
    "Access notes from cloud-notes/HedgeDoc — data source not yet connected.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: "# Notes\n\nData source not yet connected.\n\nPlanned: Read notes from Cloud Notes (drive-notes.diegonmarcos.com) via API or local export.",
      }],
    })
  );
}
