/**
 * Identity tools — CV, ID documents, notes.
 * READ-ONLY. Sensitive fields (ID numbers, etc.) are redacted in output.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { getVaultPath } from "../config.js";

export function registerIdentityTools(server: McpServer) {

  // ── ID Documents Index ────────────────────────────────────────────
  server.tool(
    "identity_documents",
    "List identity documents stored — document types and names only, no sensitive content (ID numbers are redacted).",
    {},
    async () => {
      const idDir = join(getVaultPath(), "C0_ID");
      if (!existsSync(idDir)) {
        return { content: [{ type: "text" as const, text: "ID documents directory not found" }] };
      }

      const items = readdirSync(idDir)
        .filter(f => !f.startsWith("."))
        .map(f => `- ${f}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `# Identity Documents\n\n${items || "No documents found."}\n\n_Sensitive ID numbers are NEVER exposed in tool output._`,
        }],
      };
    }
  );

  // ── Secure Notes Index ────────────────────────────────────────────
  server.tool(
    "identity_notes",
    "List secure notes — note titles/filenames only.",
    {},
    async () => {
      const notesDir = join(getVaultPath(), "C2_Notes");
      if (!existsSync(notesDir)) {
        return { content: [{ type: "text" as const, text: "Notes directory not found" }] };
      }

      const items = readdirSync(notesDir)
        .filter(f => !f.startsWith("."))
        .map(f => `- ${f}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `# Secure Notes\n\n${items || "No notes found."}`,
        }],
      };
    }
  );

  // ── Read Secure Note ──────────────────────────────────────────────
  server.tool(
    "identity_read_note",
    "Read a specific secure note by filename. Returns the note content.",
    { filename: z.string().describe("Note filename (e.g. 'travel_plans.md')") },
    async ({ filename }) => {
      const notePath = join(getVaultPath(), "C2_Notes", filename);
      if (!existsSync(notePath)) {
        return { content: [{ type: "text" as const, text: `Note "${filename}" not found.` }] };
      }
      // Prevent path traversal
      if (filename.includes("..") || filename.includes("/")) {
        return { content: [{ type: "text" as const, text: "Invalid filename." }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: readFileSync(notePath, "utf-8"),
        }],
      };
    }
  );
}
