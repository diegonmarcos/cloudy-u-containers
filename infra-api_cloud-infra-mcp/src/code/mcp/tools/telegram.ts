// ── devops.telegram.* — dedicated operator channel ──
// Talks to Diego over Telegram via the dedicated @Cloud_bot_C3_Infra_bot.
// Token arrives via sops secrets.yaml → .secrets env_file → process.env.C3_TELEGRAM_BOT_TOKEN.
// This bot token is dedicated to this service — no other consumer polls it,
// so the single background long-poller below is safe. Chat id is data-driven
// via env (C3_TELEGRAM_CHAT_ID), not hardcoded, so it can be overridden per
// environment.
//
// Feature parity note: this mirrors a_solutions/user-ai_cloudy-ai-agents-api/src/code/bots/telegram.mjs,
// the working long-poll gateway implementation. Group visibility, forum
// topics, DM topics (Bot API 9.4), and topic management all follow the same
// semantics and traps documented there — see the comments below for the
// Telegram-API-specific reasoning copied from that file.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DEFAULT_CHAT_ID = "6431508617";

function chatId(): string {
  return process.env.C3_TELEGRAM_CHAT_ID ?? DEFAULT_CHAT_ID;
}

function botToken(): string | undefined {
  return process.env.C3_TELEGRAM_BOT_TOKEN;
}

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${botToken()}/${method}`;
}

// Inbound authorization allowlist: only messages whose from.id is in this
// list are learned into the inbox — everyone else's traffic still updates
// chatRegistry/topicNames (that's harmless metadata about where the bot
// lives) but is never surfaced back through ask() or any other tool.
// Defaults to the operator chat id; override with a comma-separated list to
// allow additional operators.
function allowedFromIds(): number[] {
  const raw = process.env.C3_TELEGRAM_ALLOWED_FROM;
  const source = raw && raw.trim().length > 0 ? raw : chatId();
  return source
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isFinite(value));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface TelegramApiResult {
  ok: boolean;
  result?: unknown;
  description?: string;
}

async function tgPost(method: string, body: Record<string, unknown>): Promise<TelegramApiResult> {
  const response = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await response.json()) as TelegramApiResult;
}

// #559: sendDocument is multipart/form-data ONLY — tgPost above is JSON and
// cannot carry a file, which is why no tool in this fleet could put a file in
// the chat. That was a missing capability, not a failing call, so it read as
// the bot being unhelpful rather than as an error. Node 22's global
// FormData/Blob provide the encoder with no dependency.
//
// No Content-Type header on purpose: fetch must set it itself so the multipart
// boundary matches the body it generated.
async function tgUpload(
  method: string,
  fields: { chat_id: string; filename: string; bytes: Uint8Array; caption?: string; thread_id?: number }
): Promise<TelegramApiResult> {
  const form = new FormData();
  form.set("chat_id", fields.chat_id);
  if (fields.caption !== undefined) form.set("caption", fields.caption);
  if (fields.thread_id !== undefined) form.set("message_thread_id", String(fields.thread_id));
  // The filename is the third argument — without it Telegram names the upload
  // "blob" and the operator gets an extensionless download they cannot open.
  form.set("document", new Blob([fields.bytes]), fields.filename);
  const response = await fetch(apiUrl(method), {
    method: "POST",
    body: form,
    // Uploads are slower than a text send; the 15s tgPost budget would abort
    // a perfectly healthy multi-megabyte transfer.
    signal: AbortSignal.timeout(120_000),
  });
  return (await response.json()) as TelegramApiResult;
}

// Telegram refuses a bot upload over 50 MB outright. Checking first turns an
// opaque API rejection into a sentence the operator can act on.
const TELEGRAM_DOCUMENT_LIMIT = 50 * 1024 * 1024;

// Telegram caps a single message at 4096 chars and rejects the whole send
// (ok:false) if you exceed it — a long reply would otherwise vanish
// silently. Split on that boundary and send the parts in order.
const TELEGRAM_MESSAGE_LIMIT = 4096;

// On a thread-scoped failure, retry once unthreaded so the answer still
// lands in the chat rather than being lost — echoing a stale/invalid
// message_thread_id back to sendMessage makes Telegram reject the send with
// "message thread not found", which is exactly how a group reply disappears
// otherwise.
async function sendChunkedMessage(
  targetChatId: string,
  text: string,
  threadId?: number
): Promise<TelegramApiResult> {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  if (chunks.length === 0) chunks.push("[cloud-infra-mcp: empty message]");

  let lastResult: TelegramApiResult = { ok: true };
  for (const chunk of chunks) {
    const body: Record<string, unknown> = { chat_id: targetChatId, text: chunk };
    if (threadId !== undefined) body.message_thread_id = threadId;

    let result = await tgPost("sendMessage", body);
    if (!result.ok && threadId !== undefined) {
      result = await tgPost("sendMessage", { chat_id: targetChatId, text: chunk });
    }
    lastResult = result;
  }
  return lastResult;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  from?: { id: number; is_bot?: boolean };
  date: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: { name: string };
  forum_topic_edited?: { name: string };
  reply_to_message?: { forum_topic_created?: { name: string } };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface InboxEntry {
  updateId: number;
  chatId: number;
  threadId?: number;
  fromId: number;
  text: string;
  date: number;
}

const INBOX_CAPACITY = 200;

// Registry of chats this bot has seen traffic from, keyed by chat.id —
// Telegram offers no "list all my chats" API, so this is the only way the
// bot can answer "what groups/topics am I in". Deliberately in-memory: it
// repopulates from traffic after a restart, and is empty until then.
const chatRegistry = new Map<number, { title: string; type: string }>();

// Forum topic names, learned from service messages and topic-root replies as
// they're seen — Telegram never hands us the name any other way. Keyed by
// "chatId:threadId" so topics with the same name in different chats don't
// collide.
const topicNames = new Map<string, string>();

// Bounded inbox of authorized inbound text messages, oldest dropped first.
// devops.telegram.ask polls this instead of calling getUpdates itself, so
// that exactly one consumer ever holds Telegram's long-poll connection (see
// the module-level poller below for why a second consumer is a 409 trap).
const inbox: InboxEntry[] = [];

function appendInbox(entry: InboxEntry): void {
  inbox.push(entry);
  if (inbox.length > INBOX_CAPACITY) inbox.shift();
}

// Only a real forum-topic message carries a thread we can reply into in a
// GROUP. Telegram also sets message_thread_id on ordinary supergroup replies
// (thread = the reply chain), and echoing that id back to sendMessage in a
// non-forum chat makes Telegram reject the send — exactly how a group reply
// disappears with the bot none the wiser. is_topic_message is the field that
// actually means "forum topic". PRIVATE chats have no such ambiguity — DM
// topics (Bot API 9.4) set message_thread_id directly with no is_topic_message
// gate, so accept it whenever present there.
function resolveThreadId(message: TelegramMessage, isGroup: boolean): number | undefined {
  if (isGroup) {
    return message.is_topic_message === true ? message.message_thread_id : undefined;
  }
  return message.message_thread_id;
}

function processUpdate(update: TelegramUpdate): void {
  const message = update.message;
  if (!message) return;

  // Forum service messages (forum_topic_created/edited/closed/...) have no
  // .text and are learned here before any text-based skip below fires —
  // forum_topic_created and forum_topic_edited are the only source for the
  // topic's display name.
  if (message.message_thread_id !== undefined) {
    const learnedName = message.forum_topic_created?.name ?? message.forum_topic_edited?.name;
    if (learnedName) {
      topicNames.set(`${message.chat.id}:${message.message_thread_id}`, learnedName);
    }
  }

  // Learn this chat into the registry from every processed update, including
  // service messages with no .text — that's the only signal available for
  // "what chats/topics is this bot in".
  if (message.chat) {
    const title =
      message.chat.title ?? [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ");
    chatRegistry.set(message.chat.id, { title, type: message.chat.type });
  }

  if (!message.text) return;

  const fromId = message.from?.id;
  if (fromId === undefined || !allowedFromIds().includes(fromId)) return;

  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
  const threadId = resolveThreadId(message, isGroup);

  // Telegram also attaches the topic-root's forum_topic_created service
  // payload onto reply_to_message for messages sent inside a topic — a
  // second, more reliable source for the topic name.
  const rootName = message.reply_to_message?.forum_topic_created?.name;
  if (rootName && threadId !== undefined) {
    topicNames.set(`${message.chat.id}:${threadId}`, rootName);
  }

  appendInbox({
    updateId: update.update_id,
    chatId: message.chat.id,
    threadId,
    fromId,
    text: message.text,
    date: message.date,
  });
}

let updateOffset = 0;
let pollerStarted = false;

// Single background long-poll loop, owning getUpdates exclusively. Two
// concurrent getUpdates consumers on one bot token make Telegram return 409
// Conflict, and without a persistent consumer no chat/topic state can ever
// be learned — so this starts lazily on the first tool invocation (not at
// module import, to avoid polling in processes that never use these tools)
// and then never exits: any error just backs off and retries.
async function pollLoop(): Promise<void> {
  for (;;) {
    try {
      const token = botToken();
      if (!token) {
        // No token configured — nothing to poll until the process restarts
        // with one, so back off long instead of hot-looping.
        await sleep(30_000);
        continue;
      }
      const response = await fetch(apiUrl("getUpdates"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset: updateOffset, timeout: 25 }),
        signal: AbortSignal.timeout(35_000),
      });
      const data = (await response.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
      if (!data.ok) {
        console.error(`[cloud-infra-mcp] telegram poller: getUpdates not ok: ${data.description ?? "unknown"}`);
        await sleep(5_000);
        continue;
      }
      for (const update of data.result ?? []) {
        updateOffset = update.update_id + 1;
        try {
          processUpdate(update);
        } catch (innerError) {
          console.error(
            `[cloud-infra-mcp] telegram poller: error processing update:`,
            innerError instanceof Error ? innerError.message : String(innerError)
          );
        }
      }
    } catch (error) {
      console.error(
        `[cloud-infra-mcp] telegram poller: network error, retrying:`,
        error instanceof Error ? error.message : String(error)
      );
      await sleep(5_000);
    }
  }
}

function ensurePollerStarted(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  pollLoop().catch((error) =>
    console.error(`[cloud-infra-mcp] telegram poller: died unexpectedly:`, error instanceof Error ? error.message : String(error))
  );
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function missingTokenResult() {
  return textResult("C3_TELEGRAM_BOT_TOKEN is not set", true);
}

// chatRegistry/topicNames only reflect what the background poller has SEEN
// since this process started — the Bot API has no "list all my chats" or
// "list all topics" method, so there is no way to enumerate what the bot
// hasn't observed yet.
const SEEN_SINCE_START_NOTE =
  "Only reflects chats/topics the poller has observed since this process started — Telegram's Bot API has no \"list all\" method for either.";

export function registerTelegramTools(server: McpServer) {
  server.tool(
    "devops.telegram.send",
    "Send a message to the operator (Diego) over the dedicated @Cloud_bot_C3_Infra_bot Telegram channel. Defaults to the configured operator chat; pass chat_id/thread_id to target a different group or forum topic.",
    {
      text: z.string().describe("Message text to send"),
      chat_id: z.string().optional().describe("Target chat id (default: C3_TELEGRAM_CHAT_ID)"),
      thread_id: z.number().int().optional().describe("Forum topic (message_thread_id) to send into, if any"),
    },
    async ({ text, chat_id, thread_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      const targetChatId = chat_id ?? chatId();
      try {
        const result = await sendChunkedMessage(targetChatId, text, thread_id);
        return result.ok
          ? textResult("Sent")
          : textResult(`Telegram error: ${result.description ?? "unknown error"}`, true);
      } catch (e) {
        return textResult(`Telegram send failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.send_file",
    "Send a FILE from this host to the operator (Diego) over the dedicated @Cloud_bot_C3_Infra_bot Telegram channel. Use this whenever you have produced a report, export, log or build artifact the operator should actually receive — a path in a text message is not a delivery. Defaults to the configured operator chat; pass chat_id/thread_id to target a different group or forum topic.",
    {
      path: z.string().describe("Absolute path of the file to send, as visible to this container"),
      caption: z.string().optional().describe("Optional caption shown under the file"),
      filename: z.string().optional().describe("Override the name shown in Telegram (default: the path's basename)"),
      chat_id: z.string().optional().describe("Target chat id (default: C3_TELEGRAM_CHAT_ID)"),
      thread_id: z.number().int().optional().describe("Forum topic (message_thread_id) to send into, if any"),
    },
    async ({ path, caption, filename, chat_id, thread_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      const targetChatId = chat_id ?? chatId();
      let bytes: Uint8Array;
      try {
        bytes = await readFile(path);
      } catch (e) {
        // Name the path AND the errno. "Could not send the file" with neither
        // is the unhelpful silence this tool exists to remove.
        return textResult(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`, true);
      }

      if (bytes.byteLength === 0) {
        return textResult(`${path} is empty — nothing to send`, true);
      }
      if (bytes.byteLength > TELEGRAM_DOCUMENT_LIMIT) {
        return textResult(
          `${path} is ${bytes.byteLength} bytes; Telegram refuses a bot upload over ${TELEGRAM_DOCUMENT_LIMIT} bytes`,
          true
        );
      }

      const name = filename ?? basename(path);
      try {
        let result = await tgUpload("sendDocument", {
          chat_id: targetChatId,
          filename: name,
          bytes,
          caption,
          thread_id,
        });
        if (!result.ok && thread_id !== undefined) {
          // Same thread trap as sendMessage: a stale/invalid message_thread_id
          // makes Telegram reject the whole send. Retry once unthreaded so the
          // file still lands in the chat rather than being lost.
          result = await tgUpload("sendDocument", { chat_id: targetChatId, filename: name, bytes, caption });
        }
        return result.ok
          ? textResult(`Sent ${name} (${bytes.byteLength} bytes)`)
          : textResult(`Telegram error: ${result.description ?? "sendDocument failed"}`, true);
      } catch (e) {
        return textResult(`Telegram send_file failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.ask",
    "Send a question to the operator (Diego) over the dedicated @Cloud_bot_C3_Infra_bot Telegram channel, then wait for a reply. Waits on the shared background poller's inbox rather than calling getUpdates itself, so it can run alongside other Telegram tools without a 409 Conflict.",
    {
      question: z.string().describe("Question text to send"),
      timeout_seconds: z
        .number()
        .int()
        .positive()
        .max(600)
        .optional()
        .describe("Max time to wait for a reply (default 120, max 600)"),
      chat_id: z.string().optional().describe("Target chat id (default: C3_TELEGRAM_CHAT_ID)"),
      thread_id: z.number().int().optional().describe("Forum topic (message_thread_id) to ask into, and require the reply to come from"),
    },
    async ({ question, timeout_seconds, chat_id, thread_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      const targetChatId = chat_id ?? chatId();
      const waitSeconds = timeout_seconds ?? 120;
      const deadlineMs = Date.now() + waitSeconds * 1000;

      try {
        const sent = await sendChunkedMessage(targetChatId, question, thread_id);
        if (!sent.ok) {
          return textResult(`Telegram error: ${sent.description ?? "unknown error"}`, true);
        }

        // Skip stale traffic: only entries with an updateId greater than this
        // watermark count as "the reply". This must be the highest updateId
        // currently in the inbox, NOT a positional index — appendInbox shifts
        // the oldest entry out once the inbox hits INBOX_CAPACITY, so once
        // the inbox is full, inbox.length is pinned at capacity forever and a
        // positional watermark would make this loop scan zero entries for
        // the rest of the process's life.
        const watermark = inbox.reduce((max, entry) => Math.max(max, entry.updateId), 0);

        while (Date.now() < deadlineMs) {
          for (const entry of inbox) {
            if (entry.updateId <= watermark) continue;
            if (String(entry.chatId) !== targetChatId) continue;
            if (thread_id !== undefined && entry.threadId !== thread_id) continue;
            return textResult(JSON.stringify({ replied: true, text: entry.text }));
          }
          await sleep(500);
        }

        return textResult(JSON.stringify({ replied: false, note: `timeout after ${waitSeconds}s` }));
      } catch (e) {
        return textResult(`Telegram ask failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.chats",
    `List every chat the bot has seen traffic from, with their known forum topics. ${SEEN_SINCE_START_NOTE}`,
    {},
    async () => {
      ensurePollerStarted();
      const lines: string[] = [];
      for (const [chatIdNumber, info] of chatRegistry) {
        lines.push(`${chatIdNumber}  ${info.type}  ${info.title}`);
        const prefix = `${chatIdNumber}:`;
        for (const [key, name] of topicNames) {
          if (key.startsWith(prefix)) lines.push(`  topic ${key.slice(prefix.length)}: ${name}`);
        }
      }
      return textResult(lines.length ? lines.join("\n") : "no chats seen yet");
    }
  );

  server.tool(
    "devops.telegram.topics",
    `List forum topics learned so far for a given chat. ${SEEN_SINCE_START_NOTE}`,
    {
      chat_id: z.string().describe("Chat id to list topics for"),
    },
    async ({ chat_id }) => {
      ensurePollerStarted();
      const prefix = `${chat_id}:`;
      const lines: string[] = [];
      for (const [key, name] of topicNames) {
        if (key.startsWith(prefix)) lines.push(`topic ${key.slice(prefix.length)}: ${name}`);
      }
      return textResult(lines.length ? lines.join("\n") : "no topics seen yet in this chat");
    }
  );

  server.tool(
    "devops.telegram.chat_info",
    "Fetch live chat details (getChat) and member count (getChatMemberCount) from the Telegram API for a chat.",
    {
      chat_id: z.string().optional().describe("Chat id to look up (default: C3_TELEGRAM_CHAT_ID)"),
    },
    async ({ chat_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      const targetChatId = chat_id ?? chatId();
      try {
        const chatResult = await tgPost("getChat", { chat_id: targetChatId });
        if (!chatResult.ok) {
          return textResult(`Telegram error: ${chatResult.description ?? "getChat failed"}`, true);
        }
        const chat = chatResult.result as {
          id: number;
          type: string;
          title?: string;
          description?: string;
          first_name?: string;
          last_name?: string;
        };
        const memberCountResult = await tgPost("getChatMemberCount", { chat_id: targetChatId });
        const lines = [`id: ${chat.id}`, `type: ${chat.type}`, `title: ${chat.title ?? "(none)"}`];
        if (chat.description) lines.push(`description: ${chat.description}`);
        lines.push(`members: ${memberCountResult.ok ? String(memberCountResult.result) : "(unavailable)"}`);
        return textResult(lines.join("\n"));
      } catch (e) {
        return textResult(`Telegram chat_info failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.topic_create",
    "Create a new forum topic in a group (createForumTopic). The bot needs admin with \"Manage topics\" in that group.",
    {
      chat_id: z.string().describe("Group chat id to create the topic in"),
      name: z.string().describe("Topic name"),
    },
    async ({ chat_id, name }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      try {
        const result = await tgPost("createForumTopic", { chat_id, name });
        if (!result.ok) {
          return textResult(`Telegram error: ${result.description ?? "createForumTopic failed"}`, true);
        }
        const created = result.result as { message_thread_id: number };
        topicNames.set(`${chat_id}:${created.message_thread_id}`, name);
        return textResult(JSON.stringify({ message_thread_id: created.message_thread_id }));
      } catch (e) {
        return textResult(`Telegram topic_create failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.topic_rename",
    "Rename an existing forum topic (editForumTopic).",
    {
      chat_id: z.string().describe("Group chat id the topic belongs to"),
      thread_id: z.number().int().describe("Forum topic (message_thread_id) to rename"),
      name: z.string().describe("New topic name"),
    },
    async ({ chat_id, thread_id, name }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      try {
        const result = await tgPost("editForumTopic", { chat_id, message_thread_id: thread_id, name });
        if (!result.ok) {
          return textResult(`Telegram error: ${result.description ?? "editForumTopic failed"}`, true);
        }
        topicNames.set(`${chat_id}:${thread_id}`, name);
        return textResult(`renamed topic to "${name}"`);
      } catch (e) {
        return textResult(`Telegram topic_rename failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.topic_close",
    "Close a forum topic (closeForumTopic).",
    {
      chat_id: z.string().describe("Group chat id the topic belongs to"),
      thread_id: z.number().int().describe("Forum topic (message_thread_id) to close"),
    },
    async ({ chat_id, thread_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      try {
        const result = await tgPost("closeForumTopic", { chat_id, message_thread_id: thread_id });
        return result.ok
          ? textResult("topic closed")
          : textResult(`Telegram error: ${result.description ?? "closeForumTopic failed"}`, true);
      } catch (e) {
        return textResult(`Telegram topic_close failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );

  server.tool(
    "devops.telegram.topic_reopen",
    "Reopen a closed forum topic (reopenForumTopic).",
    {
      chat_id: z.string().describe("Group chat id the topic belongs to"),
      thread_id: z.number().int().describe("Forum topic (message_thread_id) to reopen"),
    },
    async ({ chat_id, thread_id }) => {
      ensurePollerStarted();
      if (!botToken()) return missingTokenResult();

      try {
        const result = await tgPost("reopenForumTopic", { chat_id, message_thread_id: thread_id });
        return result.ok
          ? textResult("topic reopened")
          : textResult(`Telegram error: ${result.description ?? "reopenForumTopic failed"}`, true);
      } catch (e) {
        return textResult(`Telegram topic_reopen failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
