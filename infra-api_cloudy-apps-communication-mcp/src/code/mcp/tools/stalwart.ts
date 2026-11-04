import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stalwartRegistryGet } from "../shared/admin.js";

export async function handle_stalwart_admin_accounts({ name }: { name: any }) {
  const items = await stalwartRegistryGet("Account");
  if (name) {
    const one = items.find((a: any) => a.name === name || a.emailAddress === name);
    if (!one) return { content: [{ type: "text", text: `(no account ${name})` }] };
    return { content: [{ type: "text", text: JSON.stringify(one, null, 2) }] };
  }
  if (!items.length) return { content: [{ type: "text", text: "(no accounts)" }] };
  const lines = items.map((a: any) => `${a.emailAddress ?? a.name} (${a["@type"] ?? "?"}, role ${a.roles?.["@type"] ?? "?"})`);
  return { content: [{ type: "text", text: `${items.length} accounts:\n${lines.join("\n")}` }] };
}

export async function handle_stalwart_admin_domains(_params: Record<string, unknown>) {
  const items = await stalwartRegistryGet("Domain");
  if (!items.length) return { content: [{ type: "text", text: "(no domains)" }] };
  const lines = items.map((d: any) => d.name);
  return { content: [{ type: "text", text: `${items.length} domains:\n${lines.join("\n")}` }] };
}

// v0.16.5 exposes no settings registry over JMAP — x:Setting, x:Settings and
// x:Config all return `unknownMethod`, and the old REST /api/settings/list is
// 404 on this build (see shared/admin.ts). Settings are per-object types
// (x:AllowedIp, x:MtaRoute, x:MtaInboundThrottle, ...), so `prefix` selects
// the registry type instead of a dotted config key.
export async function handle_stalwart_admin_settings({ prefix }: { prefix: any }) {
  if (!prefix) {
    return { content: [{ type: "text", text:
      "Stalwart v0.16.5 has no flat settings API. Pass prefix=<registry type>, e.g. AllowedIp, MtaRoute, MtaInboundThrottle, Tenant, Domain, Account." }] };
  }
  const items = await stalwartRegistryGet(String(prefix));
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

export const stalwartAdminAccountsSchema = {
  name: z.string().optional().describe("Account name to inspect (omit to list all)"),
};

export const stalwartAdminDomainsSchema = {};

export const stalwartAdminSettingsSchema = {
  prefix: z.string().default("").describe("Registry object type (e.g. 'AllowedIp', 'MtaRoute', 'MtaInboundThrottle', 'Tenant'); omit to list the known types"),
};

export function registerStalwartTools(server: McpServer): void {
  // ── stalwart_admin_accounts ──────────────────────────────────
  server.tool(
    "stalwart_admin_accounts",
    "List or inspect Stalwart accounts via admin API",
    stalwartAdminAccountsSchema,
    handle_stalwart_admin_accounts
  );

  // ── stalwart_admin_domains ───────────────────────────────────
  server.tool(
    "stalwart_admin_domains",
    "List domains configured in Stalwart via admin API",
    stalwartAdminDomainsSchema,
    handle_stalwart_admin_domains
  );

  // ── stalwart_admin_settings ──────────────────────────────────
  server.tool(
    "stalwart_admin_settings",
    "Get Stalwart server settings via admin API",
    stalwartAdminSettingsSchema,
    handle_stalwart_admin_settings
  );
}
