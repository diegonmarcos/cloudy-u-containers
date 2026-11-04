import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  handle_mail_list_folders,
  handle_mail_list_messages,
  handle_mail_read,
  handle_mail_search,
  handle_mail_flag,
  handle_mail_move,
  handle_mail_delete,
  handle_mail_download_attachment,
  handle_mail_create_folder,
  handle_mail_delete_folder,
  mailListFoldersSchema,
  mailListMessagesSchema,
  mailReadSchema,
  mailSearchSchema,
  mailFlagSchema,
  mailMoveSchema,
  mailDeleteSchema,
  mailDownloadAttachmentSchema,
  mailCreateFolderSchema,
  mailDeleteFolderSchema,
} from "./inbox.js";
import {
  handle_mail_send,
  handle_mail_reply,
  handle_mail_forward,
  mailSendSchema,
  mailReplySchema,
  mailForwardSchema,
} from "./compose.js";
import {
  handle_mail_admin_users,
  handle_mail_admin_domains,
  mailAdminUsersSchema,
  mailAdminDomainsSchema,
} from "./admin.js";
import {
  handle_resend_send,
  handle_resend_get,
  handle_resend_list,
  handle_resend_domains,
  handle_resend_domain_verify,
  handle_resend_domain_dns,
  handle_resend_api_keys,
  resendSendSchema,
  resendGetSchema,
  resendListSchema,
  resendDomainsSchema,
  resendDomainVerifySchema,
  resendDomainDnsSchema,
  resendApiKeysSchema,
} from "./resend.js";
import {
  handle_debug_outbound,
  handle_debug_inbound,
  handle_debug_trace,
  debugOutboundSchema,
  debugInboundSchema,
  debugTraceSchema,
} from "./debug.js";
import {
  handle_stalwart_admin_accounts,
  handle_stalwart_admin_domains,
  handle_stalwart_admin_settings,
  stalwartAdminAccountsSchema,
  stalwartAdminDomainsSchema,
  stalwartAdminSettingsSchema,
} from "./stalwart.js";

const DISPATCH: Record<string, (params: any) => Promise<any>> = {
  mail_list_folders: handle_mail_list_folders,
  mail_list_messages: handle_mail_list_messages,
  mail_read: handle_mail_read,
  mail_search: handle_mail_search,
  mail_flag: handle_mail_flag,
  mail_move: handle_mail_move,
  mail_delete: handle_mail_delete,
  mail_download_attachment: handle_mail_download_attachment,
  mail_create_folder: handle_mail_create_folder,
  mail_delete_folder: handle_mail_delete_folder,
  mail_send: handle_mail_send,
  mail_reply: handle_mail_reply,
  mail_forward: handle_mail_forward,
  mail_admin_users: handle_mail_admin_users,
  mail_admin_domains: handle_mail_admin_domains,
  resend_send: handle_resend_send,
  resend_get: handle_resend_get,
  resend_list: handle_resend_list,
  resend_domains: handle_resend_domains,
  resend_domain_verify: handle_resend_domain_verify,
  resend_domain_dns: handle_resend_domain_dns,
  resend_api_keys: handle_resend_api_keys,
  debug_outbound: handle_debug_outbound,
  debug_inbound: handle_debug_inbound,
  debug_trace: handle_debug_trace,
  stalwart_admin_accounts: handle_stalwart_admin_accounts,
  stalwart_admin_domains: handle_stalwart_admin_domains,
  stalwart_admin_settings: handle_stalwart_admin_settings,
};

// Same shape objects passed to each individual `server.tool()` registration
// below — reused here so the grouped `mail` tool applies IDENTICAL zod
// parsing (defaults, coercions, validation) as calling the method directly
// would. This is what fixes params like `server`/`account` silently arriving
// `undefined` instead of defaulting when the grouped tool is used.
const SCHEMAS: Record<string, z.ZodObject<any>> = {
  mail_list_folders: z.object(mailListFoldersSchema),
  mail_list_messages: z.object(mailListMessagesSchema),
  mail_read: z.object(mailReadSchema),
  mail_search: z.object(mailSearchSchema),
  mail_flag: z.object(mailFlagSchema),
  mail_move: z.object(mailMoveSchema),
  mail_delete: z.object(mailDeleteSchema),
  mail_download_attachment: z.object(mailDownloadAttachmentSchema),
  mail_create_folder: z.object(mailCreateFolderSchema),
  mail_delete_folder: z.object(mailDeleteFolderSchema),
  mail_send: z.object(mailSendSchema),
  mail_reply: z.object(mailReplySchema),
  mail_forward: z.object(mailForwardSchema),
  mail_admin_users: z.object(mailAdminUsersSchema),
  mail_admin_domains: z.object(mailAdminDomainsSchema),
  resend_send: z.object(resendSendSchema),
  resend_get: z.object(resendGetSchema),
  resend_list: z.object(resendListSchema),
  resend_domains: z.object(resendDomainsSchema),
  resend_domain_verify: z.object(resendDomainVerifySchema),
  resend_domain_dns: z.object(resendDomainDnsSchema),
  resend_api_keys: z.object(resendApiKeysSchema),
  debug_outbound: z.object(debugOutboundSchema),
  debug_inbound: z.object(debugInboundSchema),
  debug_trace: z.object(debugTraceSchema),
  stalwart_admin_accounts: z.object(stalwartAdminAccountsSchema),
  stalwart_admin_domains: z.object(stalwartAdminDomainsSchema),
  stalwart_admin_settings: z.object(stalwartAdminSettingsSchema),
};

// Parse `params` through `method`'s own zod schema so the grouped dispatcher
// applies the same defaults/coercions/validation as calling the method
// directly, and produces a descriptive error naming the method and the
// offending field instead of an opaque failure deep inside the handler.
export function parseMethodParams(method: string, params: unknown): any {
  const schema = SCHEMAS[method];
  if (!schema) throw new Error(`Unknown method: ${method}`);
  const result = schema.safeParse(params ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    const detail = issue.message.replace(/^Invalid input: /, "");
    throw new Error(`${method}: invalid params: ${path ? `'${path}' ` : ""}${detail}`);
  }
  return result.data;
}

export function registerMetaTool(server: McpServer): void {
  server.tool(
    "mail",
    "Unified mail tool — set method to one of: debug_inbound, debug_outbound, debug_trace, mail_admin_domains, mail_admin_users, mail_create_folder, mail_delete, mail_delete_folder, mail_download_attachment, mail_flag, mail_forward, mail_list_folders, mail_list_messages, mail_move, mail_read, mail_reply, mail_search, mail_send, resend_api_keys, resend_domain_dns, resend_domains, resend_domain_verify, resend_get, resend_list, resend_send, stalwart_admin_accounts, stalwart_admin_domains, stalwart_admin_settings",
    {
      method: z.enum([
        "debug_inbound",
        "debug_outbound",
        "debug_trace",
        "mail_admin_domains",
        "mail_admin_users",
        "mail_create_folder",
        "mail_delete",
        "mail_delete_folder",
        "mail_download_attachment",
        "mail_flag",
        "mail_forward",
        "mail_list_folders",
        "mail_list_messages",
        "mail_move",
        "mail_read",
        "mail_reply",
        "mail_search",
        "mail_send",
        "resend_api_keys",
        "resend_domain_dns",
        "resend_domains",
        "resend_domain_verify",
        "resend_get",
        "resend_list",
        "resend_send",
        "stalwart_admin_accounts",
        "stalwart_admin_domains",
        "stalwart_admin_settings",
      ]),
      params: z.record(z.unknown()).optional(),
    },
    async ({ method, params }) => {
      const handler = DISPATCH[method];
      if (!handler) throw new Error(`Unknown method: ${method}`);
      return handler(parseMethodParams(method, params));
    }
  );
}
