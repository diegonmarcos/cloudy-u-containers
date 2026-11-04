import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listAccounts, listDomains } from "../shared/admin.js";
import { serverSchema } from "../shared/config.js";

export async function handle_mail_admin_users({ server: srv }: { server: any }) {
  const accounts = await listAccounts(srv);
  const output = accounts.length ? accounts.join("\n") : "(no accounts)";
  return { content: [{ type: "text", text: output }] };
}

export async function handle_mail_admin_domains({ server: srv }: { server: any }) {
  const domains = await listDomains(srv);
  return { content: [{ type: "text", text: domains.length ? domains.join("\n") : "(no domains)" }] };
}

export const mailAdminUsersSchema = {
  server: serverSchema,
};

export const mailAdminDomainsSchema = {
  server: serverSchema,
};

export function registerAdminTools(server: McpServer): void {
  server.tool(
    "mail_admin_users",
    "List mailbox users on a mail server",
    mailAdminUsersSchema,
    handle_mail_admin_users
  );

  server.tool(
    "mail_admin_domains",
    "List mail domains on a server",
    mailAdminDomainsSchema,
    handle_mail_admin_domains
  );
}
