import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getTransport } from "../shared/smtp.js";
import { sendViaJmap } from "../shared/jmap.js";
import { withImap } from "../shared/imap.js";
import { getAccount, serverSchema, accountSchema } from "../shared/config.js";
import { simpleParser, type AddressObject } from "mailparser";

function addrText(addr: AddressObject | AddressObject[] | undefined): string {
  if (!addr) return "(unknown)";
  if (Array.isArray(addr)) return addr.map((a) => a.text).join(", ");
  return addr.text;
}

export async function handle_mail_send({ server: srv, account, to, subject, body, cc, bcc, html, transport }: { server: any; account: any; to: any; subject: any; body: any; cc: any; bcc: any; html: any; transport: any }) {
  if (transport === "jmap") {
    const id = await sendViaJmap(account, { to, subject, body, cc, bcc, html });
    return { content: [{ type: "text", text: `Sent via Stalwart JMAP. Email ID: ${id}` }] };
  }
  const tx = getTransport(srv, account);
  const creds = getAccount(srv, account);
  const info = await tx.sendMail({
    from: creds.user,
    to,
    subject,
    text: body,
    html: html ?? undefined,
    cc: cc ?? undefined,
    bcc: bcc ?? undefined,
  });
  return { content: [{ type: "text", text: `Sent. Message-ID: ${info.messageId}` }] };
}

export async function handle_mail_reply({ server: srv, account, folder, uid, body, replyAll }: { server: any; account: any; folder: any; uid: any; body: any; replyAll: any }) {
  const original = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg) throw new Error(`Message UID ${uid} not found`);
      return await simpleParser(msg.source!);
    } finally {
      lock.release();
    }
  });

  const replyTo = addrText(original.from);
  const ccAddresses = replyAll
    ? [
        ...(original.to ? [addrText(original.to)] : []),
        ...(original.cc ? [addrText(original.cc)] : []),
      ]
        .join(", ")
    : undefined;

  const quotedBody = (original.text ?? "")
    .split("\n")
    .map((line: string) => `> ${line}`)
    .join("\n");

  const subject = original.subject?.startsWith("Re:") ? original.subject : `Re: ${original.subject ?? ""}`;

  const transport = getTransport(srv, account);
  const creds = getAccount(srv, account);
  const info = await transport.sendMail({
    from: creds.user,
    to: replyTo,
    cc: ccAddresses ?? undefined,
    subject,
    text: `${body}\n\n${quotedBody}`,
    references: original.references
      ? (Array.isArray(original.references) ? original.references.join(" ") : original.references)
      : original.messageId ?? undefined,
    inReplyTo: original.messageId ?? undefined,
  });
  return { content: [{ type: "text", text: `Reply sent to ${replyTo}. Message-ID: ${info.messageId}` }] };
}

export async function handle_mail_forward({ server: srv, account, folder, uid, to, body }: { server: any; account: any; folder: any; uid: any; to: any; body: any }) {
  const original = await withImap(srv, account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(`${uid}`, { source: true }, { uid: true });
      if (!msg) throw new Error(`Message UID ${uid} not found`);
      return await simpleParser(msg.source!);
    } finally {
      lock.release();
    }
  });

  const fwdHeader = [
    "---------- Forwarded message ----------",
    `From: ${addrText(original.from)}`,
    `Date: ${original.date?.toISOString() ?? "?"}`,
    `Subject: ${original.subject ?? "(no subject)"}`,
    `To: ${addrText(original.to)}`,
    "",
  ].join("\n");

  const subject = original.subject?.startsWith("Fwd:") ? original.subject : `Fwd: ${original.subject ?? ""}`;

  const attachments = original.attachments?.map((att: any) => ({
    filename: att.filename ?? "attachment",
    content: att.content,
    contentType: att.contentType,
  }));

  const transport = getTransport(srv, account);
  const creds = getAccount(srv, account);
  const info = await transport.sendMail({
    from: creds.user,
    to,
    subject,
    text: `${body}\n\n${fwdHeader}${original.text ?? ""}`,
    attachments: attachments ?? [],
  });
  return { content: [{ type: "text", text: `Forwarded to ${to}. Message-ID: ${info.messageId}` }] };
}

export const mailSendSchema = {
  server: serverSchema,
  account: accountSchema,
  to: z.string().describe("Recipient address(es), comma-separated"),
  subject: z.string().describe("Email subject"),
  body: z.string().describe("Email body (plain text)"),
  cc: z.string().optional().describe("CC address(es), comma-separated"),
  bcc: z.string().optional().describe("BCC address(es), comma-separated"),
  html: z.string().optional().describe("HTML body (overrides plain text body for HTML part)"),
  transport: z.enum(["smtp", "jmap"]).default("smtp").describe("Send transport. 'jmap' submits via Stalwart JMAP (HTTP); 'smtp' uses nodemailer (Maddy/Stalwart submission port)"),
};

export const mailReplySchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("Folder containing the original message"),
  uid: z.number().describe("UID of the message to reply to"),
  body: z.string().describe("Reply body text"),
  replyAll: z.boolean().default(false).describe("Reply to all recipients"),
};

export const mailForwardSchema = {
  server: serverSchema,
  account: accountSchema,
  folder: z.string().default("INBOX").describe("Folder containing the original message"),
  uid: z.number().describe("UID of the message to forward"),
  to: z.string().describe("Forward recipient(s), comma-separated"),
  body: z.string().default("").describe("Optional message to prepend before forwarded content"),
};

export function registerComposeTools(server: McpServer): void {
  // ── mail_send ──────────────────────────────────────────────────
  server.tool("mail_send", "Send a new email", mailSendSchema, handle_mail_send);

  // ── mail_reply ─────────────────────────────────────────────────
  server.tool(
    "mail_reply",
    "Reply to a message (quotes original, preserves thread headers)",
    mailReplySchema,
    handle_mail_reply
  );

  // ── mail_forward ───────────────────────────────────────────────
  server.tool(
    "mail_forward",
    "Forward a message with its attachments",
    mailForwardSchema,
    handle_mail_forward
  );
}
