import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withImap } from "../shared/imap.js";
import { serverSchema, accountSchema } from "../shared/config.js";
import { simpleParser, type AddressObject } from "mailparser";

function addrText(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return "(unknown)";
  if (Array.isArray(addr)) return addr.map((a) => a.text).join(", ");
  return addr.text;
}

export async function handle_mail_list_folders({ server: srv, account }: { server: any; account: any }) {
  const result = await withImap(srv, account, async (client) => {
    const folderList = await client.list();
    const folders = folderList.map((f: any) => f.path);
    const details: string[] = [];
    for (const path of folders) {
      try {
        const status = await client.status(path, { messages: true, unseen: true });
        details.push(`${path}: ${status.messages ?? 0} messages, ${status.unseen ?? 0} unseen`);
      } catch (e: any) {
        // Surface WHY. A bare "(status unavailable)" reads as an empty folder,
        // which is indistinguishable from mail that never arrived — the exact
        // failure this tool exists to catch.
        details.push(`${path}: (status unavailable: ${e?.message ?? String(e)})`);
      }
    }
    return details.join("\n");
  });
  return { content: [{ type: "text", text: result || "(no folders)" }] };
}

export async function handle_mail_list_messages({ server: srv, account, folder, limit, page }: { server: any; account: any; folder: any; limit: any; page: any }) {
  const result = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const status = await client.status(folder, { messages: true });
      const total = status.messages ?? 0;
      if (total === 0) return "(no messages)";

      const offset = (page - 1) * limit;
      const start = Math.max(1, total - offset - limit + 1);
      const end = Math.max(1, total - offset);

      const lines: string[] = [`Folder: ${folder} (${total} total, page ${page})\n`];
      for await (const msg of client.fetch(`${start}:${end}`, {
        uid: true,
        flags: true,
        envelope: true,
      })) {
        const env = msg.envelope;
        const from = env?.from?.[0]
          ? `${env.from[0].name || ""} <${env.from[0].address}>`.trim()
          : "(unknown)";
        const date = env?.date ? new Date(env.date).toISOString().slice(0, 16) : "?";
        const flags = msg.flags ? [...msg.flags].join(",") : "";
        const seen = flags.includes("\\Seen") ? " " : "●";
        lines.push(`${seen} UID:${msg.uid} [${date}] From: ${from}`);
        lines.push(`  Subject: ${env?.subject ?? "(no subject)"}`);
        if (flags) lines.push(`  Flags: ${flags}`);
      }
      return lines.join("\n");
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: result }] };
}

export async function handle_mail_read({ server: srv, account, folder, uid }: { server: any; account: any; folder: any; uid: any }) {
  const result = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg) return `Message UID ${uid} not found in ${folder}`;

      const parsed = await simpleParser(msg.source!);
      const lines: string[] = [];
      lines.push(`From: ${addrText(parsed.from)}`);
      lines.push(`To: ${addrText(parsed.to)}`);
      if (parsed.cc) lines.push(`Cc: ${addrText(parsed.cc)}`);
      lines.push(`Date: ${parsed.date?.toISOString() ?? "?"}`);
      lines.push(`Subject: ${parsed.subject ?? "(no subject)"}`);
      lines.push(`Message-ID: ${parsed.messageId ?? ""}`);
      lines.push("");

      if (parsed.text) {
        lines.push("=== Body (text) ===");
        lines.push(parsed.text.slice(0, 8000));
      } else if (parsed.html) {
        lines.push("=== Body (HTML — text unavailable) ===");
        lines.push(parsed.html.replace(/<[^>]+>/g, "").slice(0, 8000));
      }

      if (parsed.attachments?.length) {
        lines.push("");
        lines.push("=== Attachments ===");
        parsed.attachments.forEach((att: any, i: number) => {
          lines.push(`  [${i}] ${att.filename ?? "unnamed"} (${att.contentType}, ${att.size ?? 0} bytes, part: ${att.partId ?? i})`);
        });
      }

      return lines.join("\n");
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: result }] };
}

export async function handle_mail_search({ server: srv, account, folder, query, from, subject, since, unseen, limit }: { server: any; account: any; folder: any; query: any; from: any; subject: any; since: any; unseen: any; limit: any }) {
  const result = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const criteria: Record<string, unknown> = {};
      // `query` is the obvious name for a search tool and callers reach for it
      // first. It had no schema entry, so zod's default strip-unknown-keys
      // silently dropped it and left `criteria` empty — see the guard below.
      // imapflow exposes no IMAP SEARCH TEXT, so OR the header/body keys it
      // does have to cover the same ground.
      if (query) criteria.or = [{ subject: query }, { body: query }, { from: query }];
      if (from) criteria.from = from;
      if (subject) criteria.subject = subject;
      if (since) criteria.since = new Date(since);
      if (unseen) criteria.seen = false;

      // An empty criteria object is IMAP SEARCH ALL: it matches every message
      // in the folder, and the code below then prints the newest `limit` of
      // them under a "Found N messages" header. That is indistinguishable from
      // a successful search, so a dropped or unsupported filter returns
      // confidently wrong results rather than an error. Refuse instead.
      if (!Object.keys(criteria).length) {
        throw new Error(
          "mail_search: no usable search criteria — pass at least one of query, from, subject, since or unseen. " +
          "(Searching with no filter would return the whole folder; use mail_list_messages to browse unfiltered.)"
        );
      }

      const searchResult = await client.search(criteria, { uid: true });
      const uids = Array.isArray(searchResult) ? searchResult : [];
      if (!uids.length) return "(no matches)";

      const topUids = uids.slice(-limit);
      const lines: string[] = [`Found ${uids.length} messages (showing last ${topUids.length}):\n`];

      for await (const msg of client.fetch(topUids.join(","), {
        uid: true,
        flags: true,
        envelope: true,
      }, { uid: true })) {
        const env = msg.envelope;
        const from_ = env?.from?.[0]
          ? `${env.from[0].name || ""} <${env.from[0].address}>`.trim()
          : "(unknown)";
        const date = env?.date ? new Date(env.date).toISOString().slice(0, 16) : "?";
        const seen = msg.flags?.has("\\Seen") ? " " : "●";
        lines.push(`${seen} UID:${msg.uid} [${date}] ${from_}`);
        lines.push(`  Subject: ${env?.subject ?? "(no subject)"}`);
      }
      return lines.join("\n");
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: result }] };
}

export async function handle_mail_flag({ server: srv, account, folder, uid, flag, set }: { server: any; account: any; folder: any; uid: any; flag: any; set: any }) {
  await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const imapFlag = `\\${flag}`;
      if (set) {
        await client.messageFlagsAdd(`${uid}`, [imapFlag], { uid: true });
      } else {
        await client.messageFlagsRemove(`${uid}`, [imapFlag], { uid: true });
      }
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: `Flag \\${flag} ${set ? "set" : "unset"} on UID ${uid} in ${folder}` }] };
}

export async function handle_mail_move({ server: srv, account, folder, uid, destination }: { server: any; account: any; folder: any; uid: any; destination: any }) {
  await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(`${uid}`, destination, { uid: true });
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: `Moved UID ${uid} from ${folder} to ${destination}` }] };
}

export async function handle_mail_delete({ server: srv, account, folder, uid }: { server: any; account: any; folder: any; uid: any }) {
  await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(`${uid}`, "Trash", { uid: true });
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: `Moved UID ${uid} to Trash` }] };
}

export async function handle_mail_download_attachment({ server: srv, account, folder, uid, filename }: { server: any; account: any; folder: any; uid: any; filename: any }) {
  const result = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg) return `Message UID ${uid} not found`;

      const parsed = await simpleParser(msg.source!);
      const att = parsed.attachments?.find(
        (a: any) => a.filename === filename
      );
      if (!att) {
        const names = parsed.attachments?.map((a: any) => a.filename).join(", ") ?? "none";
        return `Attachment "${filename}" not found. Available: ${names}`;
      }

      return `Filename: ${att.filename}\nContent-Type: ${att.contentType}\nSize: ${att.size} bytes\n\nBase64:\n${att.content.toString("base64")}`;
    } finally {
      lock.release();
    }
  });
  return { content: [{ type: "text", text: result }] };
}

export async function handle_mail_create_folder({ server: srv, account, name }: { server: any; account: any; name: any }) {
  await withImap(srv, account, async (client) => {
    await client.mailboxCreate(name);
  });
  return { content: [{ type: "text", text: `Folder "${name}" created` }] };
}

export async function handle_mail_delete_folder({ server: srv, account, name }: { server: any; account: any; name: any }) {
  await withImap(srv, account, async (client) => {
    await client.mailboxDelete(name);
  });
  return { content: [{ type: "text", text: `Folder "${name}" deleted` }] };
}

// ── Schemas (also used by the grouped `mail` dispatcher in meta.ts, so
// its per-method validation — and defaults — stay identical to these) ──
export const mailListFoldersSchema = {
  server: serverSchema,
  account: accountSchema,
};

export const mailListMessagesSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("IMAP folder name"),
  limit: z.number().min(1).max(100).default(20).describe("Number of messages to return"),
  page: z.number().min(1).default(1).describe("Page number (1-based)"),
};

export const mailReadSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("IMAP folder name"),
  uid: z.number().describe("Message UID"),
};

export const mailSearchSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("IMAP folder name"),
  query: z.string().optional().describe("Free-text search — matches subject OR body OR sender"),
  from: z.string().optional().describe("Filter by sender address"),
  subject: z.string().optional().describe("Filter by subject substring"),
  since: z.string().optional().describe("Filter messages since date (YYYY-MM-DD)"),
  unseen: z.boolean().optional().describe("Only unseen messages"),
  limit: z.number().min(1).max(50).default(20).describe("Max results"),
};

export const mailFlagSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("IMAP folder name"),
  uid: z.number().describe("Message UID"),
  flag: z.enum(["Seen", "Flagged", "Answered", "Deleted"]).describe("Flag name"),
  set: z.boolean().default(true).describe("true to add, false to remove"),
};

export const mailMoveSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("Source folder"),
  uid: z.number().describe("Message UID"),
  destination: z.string().describe("Destination folder name"),
};

export const mailDeleteSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("Source folder"),
  uid: z.number().describe("Message UID"),
};

export const mailDownloadAttachmentSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("IMAP folder name"),
  uid: z.number().describe("Message UID"),
  filename: z.string().describe("Attachment filename to download"),
};

export const mailCreateFolderSchema = {
  server: serverSchema,
  account: accountSchema,
  name: z.string().describe("Folder name to create"),
};

export const mailDeleteFolderSchema = {
  server: serverSchema,
  account: accountSchema,
  name: z.string().describe("Folder name to delete"),
};

export function registerInboxTools(server: McpServer): void {
  // ── mail_list_folders ──────────────────────────────────────────
  server.tool(
    "mail_list_folders",
    "List all IMAP folders with message counts",
    mailListFoldersSchema,
    handle_mail_list_folders
  );

  // ── mail_list_messages ─────────────────────────────────────────
  server.tool(
    "mail_list_messages",
    "List messages in a folder (subject, from, date, flags, uid)",
    mailListMessagesSchema,
    handle_mail_list_messages
  );

  // ── mail_read ──────────────────────────────────────────────────
  server.tool(
    "mail_read",
    "Read a full message (body text/html, headers, attachment list)",
    mailReadSchema,
    handle_mail_read
  );

  // ── mail_search ────────────────────────────────────────────────
  server.tool(
    "mail_search",
    "Search messages by criteria (from, subject, date, unseen)",
    mailSearchSchema,
    handle_mail_search
  );

  // ── mail_flag ──────────────────────────────────────────────────
  server.tool(
    "mail_flag",
    "Set or unset a flag on a message (Seen, Flagged, Answered)",
    mailFlagSchema,
    handle_mail_flag
  );

  // ── mail_move ──────────────────────────────────────────────────
  server.tool(
    "mail_move",
    "Move a message to another folder",
    mailMoveSchema,
    handle_mail_move
  );

  // ── mail_delete ────────────────────────────────────────────────
  server.tool(
    "mail_delete",
    "Delete a message (moves to Trash folder)",
    mailDeleteSchema,
    handle_mail_delete
  );

  // ── mail_download_attachment ───────────────────────────────────
  server.tool(
    "mail_download_attachment",
    "Get attachment content as base64",
    mailDownloadAttachmentSchema,
    handle_mail_download_attachment
  );

  // ── mail_create_folder ─────────────────────────────────────────
  server.tool(
    "mail_create_folder",
    "Create a new IMAP folder",
    mailCreateFolderSchema,
    handle_mail_create_folder
  );

  // ── mail_delete_folder ─────────────────────────────────────────
  server.tool(
    "mail_delete_folder",
    "Delete an IMAP folder",
    mailDeleteFolderSchema,
    handle_mail_delete_folder
  );
}
