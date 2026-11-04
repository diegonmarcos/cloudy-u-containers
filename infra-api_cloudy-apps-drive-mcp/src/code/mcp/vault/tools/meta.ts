/**
 * Meta-tool — single entry point that dispatches to all 17 personal-data handlers.
 * Replaces individual tool registrations with one `cloud_vault` tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { getVaultPath, getGitRoot } from "../config.js";
import {
  getVaultItems,
  getTotpCode,
  itemTypeLabel,
  getCredentialsPath,
  VaultwardenNotConfiguredError,
} from "../vaultwarden.js";

// ── helpers (inlined from original files) ────────────────────────────────────

function listDirSafe(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path);
}

function vaultwardenError(e: unknown): string {
  if (e instanceof VaultwardenNotConfiguredError) {
    return [
      "Vaultwarden is not configured for this MCP.",
      "",
      `Create credentials at: ${(e as VaultwardenNotConfiguredError).path}`,
      "",
      "```json",
      JSON.stringify({
        server: "http://10.0.0.1:8880",
        email: "me@diegonmarcos.com",
        password: "<master-password>",
        kdfIterations: 600000,
      }, null, 2),
      "```",
    ].join("\n");
  }
  const msg = e instanceof Error ? e.message : String(e);
  return `Failed to read Vaultwarden: ${msg}\n\nServer must be reachable (WireGuard up) and credentials at ${getCredentialsPath()} must be valid.`;
}

// ── method enum ───────────────────────────────────────────────────────────────

const METHODS = [
  "comms_email_status",
  "comms_notes",
  "comms_whatsapp",
  "finance_cards",
  "finance_wifi",
  "health_data",
  "identity_documents",
  "identity_notes",
  "identity_read_note",
  "media_git_repos",
  "media_photos",
  "vault_2fa_status",
  "vault_passwords_summary",
  "vault_providers",
  "vault_ssh_keys",
  "vault_structure",
  "vault_totp_code",
] as const;

type Method = typeof METHODS[number];

// ── handler map ───────────────────────────────────────────────────────────────

type HandlerResult = { content: Array<{ type: "text"; text: string }> };

const handlers: Record<Method, (params: Record<string, unknown>) => Promise<HandlerResult>> = {

  // comms
  comms_email_status: async () => ({
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
  }),

  comms_whatsapp: async () => ({
    content: [{
      type: "text" as const,
      text: "# WhatsApp\n\nData source not yet connected.\n\nPlanned: Read WhatsApp chat exports/backups for search and retrieval.",
    }],
  }),

  comms_notes: async () => ({
    content: [{
      type: "text" as const,
      text: "# Notes\n\nData source not yet connected.\n\nPlanned: Read notes from Cloud Notes (drive-notes.diegonmarcos.com) via API or local export.",
    }],
  }),

  // finance
  finance_cards: async () => {
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
  },

  finance_wifi: async () => {
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
  },

  // health
  health_data: async () => ({
    content: [{
      type: "text" as const,
      text: "# Health Data\n\nData source not yet connected.\n\nPlanned: Import health tracker exports (steps, heart rate, sleep, workouts) for search and analysis.",
    }],
  }),

  // identity
  identity_documents: async () => {
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
  },

  identity_notes: async () => {
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
  },

  identity_read_note: async (params) => {
    const filename = (params as any).filename as string;
    if (!filename) {
      return { content: [{ type: "text" as const, text: 'Missing required param: filename' }] };
    }
    if (filename.includes("..") || filename.includes("/")) {
      return { content: [{ type: "text" as const, text: "Invalid filename." }] };
    }
    const notePath = join(getVaultPath(), "C2_Notes", filename);
    if (!existsSync(notePath)) {
      return { content: [{ type: "text" as const, text: `Note "${filename}" not found.` }] };
    }
    return {
      content: [{
        type: "text" as const,
        text: readFileSync(notePath, "utf-8"),
      }],
    };
  },

  // media
  media_photos: async () => ({
    content: [{
      type: "text" as const,
      text: `# Photos

Photos are managed via **PhotoPrism** at photos.diegonmarcos.com (wake-on-demand).

## Access methods:
1. **cloud-services MCP**: Use \`service_api_call\` with service "photoprism"
2. **Direct API**: \`GET https://photos.diegonmarcos.com/api/v1/photos\` with bearer token

## Common operations:
- Browse: \`/api/v1/photos?count=20&offset=0\`
- Search: \`/api/v1/photos?q=landscape\`
- Albums: \`/api/v1/albums\``,
    }],
  }),

  media_git_repos: async () => {
    const gitRoot = getGitRoot();
    if (!existsSync(gitRoot)) {
      return { content: [{ type: "text" as const, text: "Git root not found" }] };
    }
    const repos = readdirSync(gitRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(gitRoot, e.name, ".git")))
      .map(e => {
        const repoPath = join(gitRoot, e.name);
        let description = "";
        const readmePath = join(repoPath, "README.md");
        if (existsSync(readmePath)) {
          const firstLine = readFileSync(readmePath, "utf-8").split("\n").find(l => l.trim());
          description = firstLine?.replace(/^#+\s*/, "").trim() ?? "";
        }
        return `- **${e.name}/** — ${description || "(no README)"}`;
      })
      .join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `# Git Repositories\n\n${repos || "No repos found."}`,
      }],
    };
  },

  // vault
  vault_structure: async () => {
    const vault = getVaultPath();
    if (!existsSync(vault)) {
      return { content: [{ type: "text" as const, text: "Vault path not found" }] };
    }
    const entries = readdirSync(vault, { withFileTypes: true });
    const structure = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => {
        const items = listDirSafe(join(vault, e.name));
        return `- **${e.name}/** (${items.length} items)`;
      })
      .join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `# Vault Structure\n\n${structure}`,
      }],
    };
  },

  vault_providers: async () => {
    const providersDir = join(getVaultPath(), "A0_keys", "providers");
    if (!existsSync(providersDir)) {
      return { content: [{ type: "text" as const, text: "Providers directory not found" }] };
    }
    const providers = readdirSync(providersDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const items = listDirSafe(join(providersDir, e.name));
        const fileList = items.map(f => {
          const stat = statSync(join(providersDir, e.name, f));
          return `  - ${f} (${stat.isDirectory() ? "dir" : `${stat.size}B`})`;
        }).join("\n");
        return `### ${e.name}\n${fileList || "  (empty)"}`;
      })
      .join("\n\n");
    return {
      content: [{
        type: "text" as const,
        text: `# Credential Providers\n\n${providers}`,
      }],
    };
  },

  vault_ssh_keys: async () => {
    const sshDir = join(getVaultPath(), "A0_keys", "ssh");
    if (!existsSync(sshDir)) {
      return { content: [{ type: "text" as const, text: "SSH directory not found" }] };
    }
    const files = readdirSync(sshDir)
      .filter(f => !f.startsWith("."))
      .map(f => {
        const isPublic = f.endsWith(".pub");
        const stat = statSync(join(sshDir, f));
        return `- ${f} (${isPublic ? "public" : "private"}, ${stat.size}B)`;
      })
      .join("\n");
    return {
      content: [{
        type: "text" as const,
        text: `# SSH Keys\n\n${files || "No keys found."}`,
      }],
    };
  },

  vault_passwords_summary: async () => {
    let items;
    try {
      items = await getVaultItems();
    } catch (e) {
      return { content: [{ type: "text" as const, text: vaultwardenError(e) }] };
    }
    const byType = new Map<number, string[]>();
    for (const it of items) {
      if (!byType.has(it.type)) byType.set(it.type, []);
      byType.get(it.type)!.push(it.name);
    }
    const sections = [...byType.entries()]
      .sort(([a], [b]) => a - b)
      .map(([type, names]) => {
        const list = names.sort((a, b) => a.localeCompare(b)).map(n => `- ${n}`).join("\n");
        return `## ${itemTypeLabel(type)} (${names.length})\n${list}`;
      })
      .join("\n\n");
    return {
      content: [{
        type: "text" as const,
        text: `# Stored Passwords — Vaultwarden (${items.length} entries)\n\n${sections}\n\n_Actual passwords are NEVER exposed._`,
      }],
    };
  },

  vault_2fa_status: async () => {
    let items;
    try {
      items = await getVaultItems();
    } catch (e) {
      return { content: [{ type: "text" as const, text: vaultwardenError(e) }] };
    }
    const withTotp = items.filter(it => it.hasTotp).map(it => it.name).sort((a, b) => a.localeCompare(b));
    const entries = withTotp.length
      ? withTotp.map(n => `- ${n}`).join("\n")
      : "_No items with TOTP found._";
    return {
      content: [{
        type: "text" as const,
        text: `# 2FA Configured Services (${withTotp.length})\n\n${entries}\n\n_TOTP seeds and recovery codes are NEVER exposed._`,
      }],
    };
  },

  vault_totp_code: async (params) => {
    const service = (params as any).service as string;
    if (!service) {
      return { content: [{ type: "text" as const, text: 'Missing required param: service' }] };
    }
    try {
      const r = await getTotpCode(service);
      return {
        content: [{
          type: "text" as const,
          text: `# ${r.service}\n\n**${r.code}**  — valid ${r.secondsRemaining}s\n\n_Seed is never exposed._`,
        }],
      };
    } catch (e) {
      const text = e instanceof VaultwardenNotConfiguredError
        ? vaultwardenError(e)
        : (e instanceof Error ? e.message : String(e));
      return { content: [{ type: "text" as const, text }] };
    }
  },
};

// ── registration ──────────────────────────────────────────────────────────────

export function registerMetaTool(server: McpServer) {
  server.tool(
    "cloud_vault",
    "Unified access to the cloud-vault personal data store. Pass `method` to select the operation and optional `params` for methods that require arguments (identity_read_note needs `filename`, vault_totp_code needs `service`).",
    {
      method: z.enum(METHODS).describe("Operation to perform"),
      params: z.record(z.unknown()).optional().describe("Optional parameters for the selected method"),
    },
    async ({ method, params }) => {
      const handler = handlers[method];
      return handler((params ?? {}) as Record<string, unknown>);
    }
  );
}
