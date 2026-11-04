/**
 * Vault tools — READ-ONLY access to credential metadata.
 * NEVER exposes actual passwords, tokens, or secret values.
 * Only shows structure, existence, and metadata.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { getVaultPath } from "../config.js";
import {
  getVaultItems,
  getTotpCode,
  itemTypeLabel,
  getCredentialsPath,
  VaultwardenNotConfiguredError,
} from "../vaultwarden.js";

function listDirSafe(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path);
}

export function registerVaultTools(server: McpServer) {

  // ── Vault Structure ───────────────────────────────────────────────
  server.tool(
    "vault_structure",
    "Get the vault directory structure — shows what credential categories exist without exposing any secrets.",
    {},
    async () => {
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
    }
  );

  // ── Providers Overview ────────────────────────────────────────────
  server.tool(
    "vault_providers",
    "List all credential providers (SSH, OAuth, cloud CLIs) — shows provider names and file counts, no secrets.",
    {},
    async () => {
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
    }
  );

  // ── SSH Keys Inventory ────────────────────────────────────────────
  server.tool(
    "vault_ssh_keys",
    "List SSH key files — shows key names and types (public only), never private key content.",
    {},
    async () => {
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
    }
  );

  // ── Passwords Summary ─────────────────────────────────────────────
  server.tool(
    "vault_passwords_summary",
    "Get a summary of stored passwords from Vaultwarden — service names grouped by item type only, NEVER actual passwords.",
    {},
    async () => {
      let items;
      try {
        items = await getVaultItems();
      } catch (e) {
        return { content: [{ type: "text" as const, text: vaultwardenError(e) }] };
      }

      // Group decrypted item names by type (Login / Note / Card / Identity).
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
    }
  );

  // ── 2FA Status ────────────────────────────────────────────────────
  server.tool(
    "vault_2fa_status",
    "List services with 2FA (TOTP) configured in Vaultwarden — names only, no TOTP seeds or recovery codes.",
    {},
    async () => {
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
    }
  );

  // ── TOTP Code (per-item, current code only) ────────────────────────
  server.tool(
    "vault_totp_code",
    "Get the CURRENT one-time TOTP code for a SINGLE vault item by name. Returns only the live code + seconds remaining — never the TOTP seed/secret.",
    { service: z.string().describe("Service/item name as listed by vault_2fa_status (case-insensitive; exact match preferred)") },
    async ({ service }) => {
      try {
        const r = await getTotpCode(service);
        return {
          content: [{
            type: "text" as const,
            text: `# ${r.service}\n\n**${r.code}**  — valid ${r.secondsRemaining}s\n\n_Seed is never exposed._`,
          }],
        };
      } catch (e) {
        // Config-missing gets the full setup hint; match/sync errors are already user-readable.
        const text = e instanceof VaultwardenNotConfiguredError
          ? vaultwardenError(e)
          : (e instanceof Error ? e.message : String(e));
        return { content: [{ type: "text" as const, text }] };
      }
    }
  );
}

/** Render a vault/Vaultwarden error as an operator-readable message (never throws to the SDK). */
function vaultwardenError(e: unknown): string {
  if (e instanceof VaultwardenNotConfiguredError) {
    return [
      "Vaultwarden is not configured for this MCP.",
      "",
      `Create credentials at: ${e.path}`,
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
