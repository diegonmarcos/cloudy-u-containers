// telegram.mjs — Telegram bot transport: offset-based long-poll.
// Re-ship 2026-08-09: the 33f746d ship jammed on the old wall-clock watchdog;
// this re-triggers the group-reply fix onto the idle-based one (8525be4).
//
// One instance per bot token (see bots.json — each roster entry gets its own
// startTelegram() call from gateway.mjs). Zero npm dependencies: Node 22
// global fetch.
//
// Group/mention gate: Telegram's default bot Privacy Mode already hides most
// ordinary group messages from bots at the API level — only /commands,
// @mentions, and replies to the bot are delivered to getUpdates in the first
// place. The gate below mostly mirrors what Telegram already enforces; it
// exists so this code never assumes it is seeing every group message, and so
// a group admin who later disables Privacy Mode doesn't turn this bot into a
// reply-to-everything group member.
// ship-cover 2026-08-09T18:40Z — batched trigger; see commit message.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { handleCommand, COMMANDS } from "./commands.mjs";
import { routeToGoose } from "./route.mjs";

// Telegram caps a single message at 4096 chars and rejects the whole send
// (ok:false) if you exceed it — a long model reply would otherwise vanish
// silently. Split on that boundary and send the parts in order.
export const TELEGRAM_MAX_MESSAGE = 4096;

// ── Delivery core (one per message, fail-LOUD) ─────────────────────────────
// Sends `text` to `chat_id` in chunks of at most TELEGRAM_MAX_MESSAGE. The
// tests (test-my-ai-gateway-fail-loud.mjs) prove against THIS function so the
// anti-silence contract is exercised directly, not only through the poll loop.
//
// The contract (ticket #545): a delivery failure must reach the user, never
// leave them in silence. A bot that can answer must say it answered; a bot
// that cannot must say it failed. So `delivered:false` is returned (the caller
// must not log a success marker in that case) AND a visible
// "[gateway: delivery failed] ..." notice is posted to the chat. tgPost
// resolves with Telegram's JSON even on a 4xx, and a transport error rejects —
// both are folded into `ok:false` here so neither path can fall through to a
// caller that believes it delivered.
export const deliverChatReply = async ({
  doSend,
  chat_id,
  text,
  message_thread_id,
  logLabel = "telegram",
  maxLength = TELEGRAM_MAX_MESSAGE,
} = {}) => {
  const body = text ?? "";
  const chunks = [];
  for (let i = 0; i < String(body).length; i += maxLength) chunks.push(String(body).slice(i, i + maxLength));
  if (chunks.length === 0) chunks.push("[gateway: empty reply]");
  let delivered = true;
  let lastFailure = null;
  for (const chunk of chunks) {
    // Build the send and swallow transport errors INTO ok:false — a rejected
    // fetch is the same "the user did not receive it" fact as an ok:false, so
    // it must drive the same delivered:false + notice path, never an uncaught
    // throw that leaves the caller thinking the send is pending.
    const attempt = async (thread) => {
      try {
        return await doSend("sendMessage", {
          chat_id,
          text: chunk,
          ...(thread !== undefined ? { message_thread_id: thread } : {}),
        });
      } catch (err) {
        return { ok: false, description: String(err?.message || err) };
      }
    };
    let res = await attempt(message_thread_id);
    if (res?.ok === false && message_thread_id !== undefined) {
      // On a thread-scoped failure, retry once unthreaded so the answer still
      // lands in the chat rather than being lost.
      console.error(`[gateway] ${logLabel}: sendMessage(thread=${message_thread_id}) failed: ${res.description} — retrying unthreaded`);
      res = await attempt(undefined);
    }
    if (res?.ok !== true) {
      delivered = false;
      lastFailure = res?.description || res?.error_code || `HTTP ${res?.status ?? "unknown"}`;
      console.error(`[gateway] ${logLabel}: sendMessage to ${chat_id} failed: ${lastFailure}`);
    }
  }
  if (!delivered) {
    // The user must SEE the bot failed — silence is the bug this module exists
    // to remove. Best-effort; if even the notice fails, log it and move on.
    try {
      const notice = await doSend("sendMessage", {
        chat_id,
        text: `[gateway: delivery failed] ${lastFailure}. Please try again, or open a support channel.`,
        ...(message_thread_id !== undefined ? { message_thread_id } : {}),
      });
      if (notice?.ok !== true) {
        console.error(`[gateway] ${logLabel}: even the delivery-failure notice to ${chat_id} was not accepted: ${notice?.description ?? JSON.stringify(notice)}`);
      }
    } catch (noticeErr) {
      console.error(`[gateway] ${logLabel}: even the delivery-failure notice to ${chat_id} failed: ${noticeErr.message}`);
    }
  }
  return { delivered };
};

// ── File delivery (#559) ────────────────────────────────────────────────────
// Until now the bots could TALK about a file but never hand one over: every
// send in this fleet went through tgPost, which is application/json, and
// Telegram's sendDocument accepts multipart/form-data ONLY. That is a missing
// capability, not a failing call — which is why it read as the bot being
// unhelpful rather than as an error, and why "just retry" never worked.
//
// Node 22 has global FormData/Blob/fetch, so this needs no dependency.
//
// Telegram refuses a bot upload over 50 MB outright. Checking the size here
// turns an opaque API rejection into a sentence the user can act on.
export const TELEGRAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

// Sends one file, mirroring deliverChatReply's contract: the transport is
// INJECTED (doUpload) so tests prove this function directly rather than only
// through the poll loop, and a failure returns delivered:false WITH a reason
// the caller must surface. It deliberately does NOT post its own failure
// notice — the caller already owns a working text channel (sendMessage), and a
// second notice path here would be a second place for the anti-silence
// contract to drift.
export const deliverDocument = async ({
  doUpload,
  chat_id,
  filename,
  bytes,
  caption,
  message_thread_id,
  logLabel = "telegram",
  maxBytes = TELEGRAM_MAX_DOCUMENT_BYTES,
} = {}) => {
  const size = bytes?.byteLength ?? bytes?.length ?? 0;
  // An empty upload is accepted by nothing and explains nothing; say so before
  // spending a round trip on it.
  if (!size) return { delivered: false, reason: `"${filename}" is empty — nothing to send` };
  if (size > maxBytes) {
    return {
      delivered: false,
      reason: `"${filename}" is ${size} bytes; Telegram refuses a bot upload over ${maxBytes} bytes`,
    };
  }

  const attempt = async (thread) => {
    try {
      return await doUpload("sendDocument", { chat_id, filename, bytes, caption, message_thread_id: thread });
    } catch (err) {
      // A rejected fetch is the same "the user did not receive it" fact as an
      // ok:false, so it must drive the same path — never an uncaught throw
      // that leaves the caller believing the send is pending.
      return { ok: false, description: String(err?.message || err) };
    }
  };

  let res = await attempt(message_thread_id);
  if (res?.ok === false && message_thread_id !== undefined) {
    // Same thread trap as sendMessage: a stale/invalid message_thread_id makes
    // Telegram reject the whole send. Retry once unthreaded so the file still
    // lands in the chat rather than being lost.
    console.error(`[gateway] ${logLabel}: sendDocument(thread=${message_thread_id}) failed: ${res.description} — retrying unthreaded`);
    res = await attempt(undefined);
  }
  if (res?.ok === true) return { delivered: true };

  const reason = res?.description || res?.error_code || `HTTP ${res?.status ?? "unknown"}`;
  console.error(`[gateway] ${logLabel}: sendDocument("${filename}") to ${chat_id} failed: ${reason}`);
  return { delivered: false, reason };
};

export const startTelegram = ({
  tokenEnvVar = "TELEGRAM_BOT_TOKEN",
  chatKeyPrefix = "telegram",
  logLabel = "telegram",
  defaultAgent = "goose",
  requireMention = true,
} = {}) => {
  const token = process.env[tokenEnvVar];
  if (!token) { console.log(`[gateway] ${logLabel}: ${tokenEnvVar} not set — skipping`); return; }
  console.log(`[gateway] ${logLabel}: starting long-poll (default agent: ${defaultAgent})`);

  const allowFrom = (process.env.TELEGRAM_ALLOW_FROM || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  // Fail-closed: this is a private bot, not a public one — an empty allowlist
  // must mean "nobody", not "everybody". Warn loudly once at startup so a
  // missing/misconfigured TELEGRAM_ALLOW_FROM is visible in logs instead of
  // silently exposing the bot to any Telegram user who finds it (in a DM, or
  // worse, any member of a group it gets added to). The same list is used
  // for both DMs and groups — there is no separate group allowlist.
  if (allowFrom.length === 0) {
    console.warn(`[gateway] ${logLabel}: TELEGRAM_ALLOW_FROM empty — refusing all traffic (fail-closed)`);
  }

  const tgApi = (method, params = {}) => {
    const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    return fetch(url.toString()).then((r) => r.json());
  };

  const tgPost = (method, body) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  // File uploads cannot go through tgPost: sendDocument is multipart/form-data
  // only, and posting it as JSON is silently rejected. Node 22's global
  // FormData/Blob give us the encoder for free.
  const tgUpload = (method, { chat_id, filename, bytes, caption, message_thread_id }) => {
    const form = new FormData();
    form.set("chat_id", String(chat_id));
    if (caption !== undefined) form.set("caption", caption);
    if (message_thread_id !== undefined) form.set("message_thread_id", String(message_thread_id));
    // The filename is the third argument — without it Telegram names the file
    // "blob" and Diego gets an extensionless download he cannot open.
    form.set("document", new Blob([bytes]), filename);
    // No content-type header on purpose: fetch must set it itself so the
    // multipart boundary matches the body it generated.
    return fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form })
      .then((r) => r.json());
  };

  // message_thread_id threads the reply back into the forum topic the message
  // was asked in; omitted entirely for non-topic chats.
  //
  // The delivery logic lives in the exported deliverChatReply core so tests can
  // prove the anti-silence contract directly. This wrapper threads the real
  // tgPost in and returns whether every chunk was actually accepted.
  const sendMessage = (chat_id, text, message_thread_id) =>
    deliverChatReply({
      doSend: tgPost,
      chat_id,
      text,
      message_thread_id,
      logLabel,
    });

  tgPost("setMyCommands", { commands: COMMANDS }).catch((err) =>
    console.error(`[gateway] ${logLabel}: setMyCommands failed:`, err.message));

  // Resolved once at startup via getMe; used by the group @mention gate
  // below. If it fails, botUsername stays null and the gate fails OPEN in
  // groups (see isAddressedInGroup) so a getMe hiccup never makes the bot
  // go silently mute in a group it's already in.
  let botUsername = null;
  const resolveBotUsername = async () => {
    try {
      const data = await tgApi("getMe");
      if (data.ok && data.result?.username) {
        botUsername = data.result.username;
      } else {
        console.warn(`[gateway] ${logLabel}: getMe returned no username — group mention gate disabled (fail-open)`);
      }
    } catch (err) {
      console.warn(`[gateway] ${logLabel}: getMe failed (${err.message}) — group mention gate disabled (fail-open)`);
    }
  };

  // Is this group message addressed to the bot? Slash commands and replies
  // to the bot always count; a bare @mention counts only if we know our own
  // username (see resolveBotUsername's fail-open note).
  const isAddressedInGroup = (msg, text) => {
    if (text.startsWith("/")) return true;
    if (msg.reply_to_message?.from?.is_bot === true) return true;
    if (botUsername === null) return true;
    return text.toLowerCase().includes(`@${botUsername.toLowerCase()}`);
  };

  // Strip a leading "@botusername" mention so the model doesn't see the
  // mention noise. Only applied to non-command group text.
  const stripLeadingMention = (text) => {
    if (!botUsername) return text;
    const token = `@${botUsername.toLowerCase()}`;
    return text.toLowerCase().startsWith(token) ? text.slice(token.length).trim() : text;
  };

  let offset = 0;

  // Forum topic names, learned from service messages and topic-root replies as
  // they're seen — Telegram never hands us the name any other way. Keyed by
  // "chatId:threadId" so topics with the same name in different chats don't
  // collide.
  const topicNames = new Map(); // "chatId:threadId" -> forum topic name, learned from service messages

  // Per-conversation turn queues. Agent turns used to be awaited INSIDE the
  // getUpdates loop, so one long turn (group agent orchestration runs 5-10
  // min) froze every other chat and topic on this bot until it finished —
  // measured 2026-09-19: a group turn blocked the DM for its whole life.
  // Chaining on a per-conversation promise keeps strict order within a chat
  // while different chats/topics run concurrently and the poll loop never
  // stalls. Entries are overwritten per turn, keys are the handful of chats
  // this private bot serves — no cleanup needed.
  const turnQueues = new Map(); // conversationKey -> tail promise

  // Registry of chats this bot has seen traffic from, keyed by chat.id —
  // Telegram offers no "list all my chats" API, so this is the only way the
  // bot can answer "what groups/topics am I in". Both maps are deliberately
  // in-memory: they repopulate from traffic after a restart, and are empty
  // until then. Persist to the data volume if durability is ever needed.
  const chatRegistry = new Map(); // chat.id -> { title, type }

  // Runs a tgPost and formats the result as a one-line ok-or-description
  // reply — used by the group/topic management commands below.
  const postAndReport = async (method, body, okText) => {
    const res = await tgPost(method, body);
    return res.ok ? okText(res.result) : (res.description || `${method} failed`);
  };

  const poll = async () => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const data = await tgApi("getUpdates", { timeout: 50, offset });
        if (!data.ok) {
          console.error(`[gateway] ${logLabel}: getUpdates not ok:`, JSON.stringify(data));
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        for (const update of data.result || []) {
          offset = update.update_id + 1;
          try {
            const msg = update.message;
            // Forum service messages (forum_topic_created/edited/closed/...)
            // have no .text and are skipped below, but forum_topic_created
            // and forum_topic_edited are our only source for the topic's
            // display name — learn it here before that skip fires.
            if (msg && msg.message_thread_id !== undefined) {
              const learnedName = msg.forum_topic_created?.name ?? msg.forum_topic_edited?.name;
              if (learnedName) {
                topicNames.set(`${msg.chat.id}:${msg.message_thread_id}`, learnedName);
              }
            }
            // Learn this chat into the registry from every processed update,
            // including service messages with no .text — that's the only
            // signal available for "what chats/topics is this bot in".
            if (msg?.chat) {
              const title = msg.chat.title ?? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ");
              chatRegistry.set(msg.chat.id, { title, type: msg.chat.type });
            }
            if (!msg?.text) continue;
            const from_id = String(msg.from?.id ?? "");
            if (allowFrom.length === 0 || !allowFrom.includes(from_id)) {
              console.log(`[gateway] ${logLabel}: denied from ${from_id}`);
              continue;
            }
            // Group mention gate: in a group/supergroup, only answer messages
            // addressed to the bot (command, @mention, or reply-to-bot) —
            // otherwise every group message would get a reply. DMs are
            // always answered. Silent continue (no log spam) when ungated.
            const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
            if (isGroup && requireMention && !isAddressedInGroup(msg, msg.text)) continue;
            const text = isGroup && !msg.text.startsWith("/") ? stripLeadingMention(msg.text) : msg.text;
            // Only a real forum-topic message carries a thread we can reply
            // into. Telegram also sets message_thread_id on ordinary
            // supergroup replies (thread = the reply chain), and echoing that
            // id back to sendMessage in a non-forum chat makes Telegram
            // reject the send with "message thread not found" — which is
            // exactly how a group reply disappears with the bot none the
            // wiser. is_topic_message is the field that means "forum topic".
            const threadId = msg.is_topic_message === true ? msg.message_thread_id : undefined;
            // Telegram also attaches the topic-root's forum_topic_created
            // service payload onto reply_to_message for messages sent inside
            // a topic — a second, more reliable source for the topic name.
            const rootName = msg.reply_to_message?.forum_topic_created?.name;
            if (rootName && threadId !== undefined) {
              topicNames.set(`${msg.chat.id}:${threadId}`, rootName);
            }
            // Fold the topic into the session key so each forum topic gets its
            // own conversation instead of sharing the chat's single "General"
            // session. Chats without topics are unaffected (key unchanged), so
            // existing sessions keep their key.
            const conversationKey = threadId !== undefined
              ? `${chatKeyPrefix}:${msg.chat.id}:${threadId}`
              : `${chatKeyPrefix}:${msg.chat.id}`;
            // Tell the model where it's speaking — the group and, if known,
            // the forum topic — so it doesn't have to guess from bare text.
            // Direct messages get no context; there's nothing to disambiguate.
            let platformContext;
            if (isGroup) {
              const topicName = threadId !== undefined ? topicNames.get(`${msg.chat.id}:${threadId}`) : undefined;
              platformContext = `Telegram context: you are replying inside the group "${msg.chat.title}"`;
              if (topicName) {
                platformContext += `, forum topic "${topicName}"`;
              } else if (threadId !== undefined) {
                platformContext += `, topic id ${threadId}`;
              }
            }
            let reply;
            if (text.startsWith("/")) {
              const [cmdRaw, ...argParts] = text.trim().split(/\s+/);
              const cmd = cmdRaw.slice(1).split("@")[0].toLowerCase();
              const arg = argParts.join(" ");
              // Group/topic visibility and management commands need tgPost and
              // the raw message envelope (chat id, thread id) — commands.mjs
              // has neither, so they're handled here instead of dispatched
              // into the generic handleCommand switch.
              if (cmd === "chats") {
                const lines = ["Chats seen since last restart (in-memory):"];
                for (const [chatId, info] of chatRegistry) {
                  lines.push(`${chatId}  ${info.type}  ${info.title}`);
                  const prefix = `${chatId}:`;
                  for (const [key, name] of topicNames) {
                    if (key.startsWith(prefix)) lines.push(`  topic ${key.slice(prefix.length)}: ${name}`);
                  }
                }
                reply = lines.length > 1 ? lines.join("\n") : lines[0] + "\n(none yet)";
              } else if (cmd === "topics") {
                const prefix = `${msg.chat.id}:`;
                const lines = [];
                for (const [key, name] of topicNames) {
                  if (key.startsWith(prefix)) lines.push(`topic ${key.slice(prefix.length)}: ${name}`);
                }
                reply = lines.length ? lines.join("\n") : "no topics seen yet in this chat";
              } else if (cmd === "chatinfo") {
                const chatRes = await tgPost("getChat", { chat_id: msg.chat.id });
                if (!chatRes.ok) {
                  reply = chatRes.description || "getChat failed";
                } else {
                  const c = chatRes.result;
                  const countRes = await tgPost("getChatMemberCount", { chat_id: msg.chat.id });
                  const lines = [`id: ${c.id}`, `type: ${c.type}`, `title: ${c.title ?? "(none)"}`];
                  if (c.description) lines.push(`description: ${c.description}`);
                  lines.push(`members: ${countRes.ok ? countRes.result : "(unavailable)"}`);
                  reply = lines.join("\n");
                }
              } else if (cmd === "sendfile") {
                // #559: the only way a file reaches the chat. Handled here
                // rather than in commands.mjs for the same reason the topic
                // commands are — commands.mjs has no transport and no message
                // envelope, and giving it one would be a second delivery path.
                //
                // Authorization is already settled above: allowFrom is
                // fail-closed and this line is unreachable for anyone not on
                // it, so there is no extra gate to add here. That allowlist IS
                // the trust boundary for reading a path off this host.
                const target = arg.trim();
                if (!target) {
                  reply = "usage: /sendfile <path>";
                } else {
                  let bytes = null;
                  try {
                    bytes = await readFile(target);
                  } catch (err) {
                    // Name the file and the errno: "cannot read" with neither
                    // is the unhelpful silence this ticket exists to remove.
                    reply = `cannot read ${target}: ${err.code || err.message}`;
                  }
                  if (bytes) {
                    const { delivered, reason } = await deliverDocument({
                      doUpload: tgUpload,
                      chat_id: msg.chat.id,
                      filename: basename(target),
                      bytes,
                      message_thread_id: threadId,
                      logLabel,
                    });
                    // Either way a sentence goes back through the text channel
                    // below, so a failed upload can never read as silence.
                    reply = delivered
                      ? `sent ${basename(target)} (${bytes.length} bytes)`
                      : `[gateway: file not sent] ${reason}`;
                  }
                }
              } else if (cmd === "newtopic") {
                if (!arg.trim()) {
                  reply = "usage: /newtopic <name>";
                } else if (!isGroup) {
                  reply = "/newtopic only works in a group chat";
                } else {
                  reply = await postAndReport("createForumTopic", { chat_id: msg.chat.id, name: arg.trim() }, (result) => {
                    topicNames.set(`${msg.chat.id}:${result.message_thread_id}`, arg.trim());
                    return `created topic "${arg.trim()}" (id ${result.message_thread_id})`;
                  });
                  if (reply && !reply.startsWith("created topic")) {
                    reply += `\nthe bot needs admin with "Manage topics" in this group`;
                  }
                }
              } else if (cmd === "renametopic") {
                if (threadId === undefined) {
                  reply = "/renametopic only works inside a forum topic";
                } else if (!arg.trim()) {
                  reply = "usage: /renametopic <name>";
                } else {
                  reply = await postAndReport("editForumTopic", { chat_id: msg.chat.id, message_thread_id: threadId, name: arg.trim() }, () => {
                    topicNames.set(`${msg.chat.id}:${threadId}`, arg.trim());
                    return `renamed topic to "${arg.trim()}"`;
                  });
                }
              } else if (cmd === "closetopic") {
                reply = threadId === undefined
                  ? "/closetopic only works inside a forum topic"
                  : await postAndReport("closeForumTopic", { chat_id: msg.chat.id, message_thread_id: threadId }, () => "topic closed");
              } else if (cmd === "reopentopic") {
                reply = threadId === undefined
                  ? "/reopentopic only works inside a forum topic"
                  : await postAndReport("reopenForumTopic", { chat_id: msg.chat.id, message_thread_id: threadId }, () => "topic reopened");
              } else {
                reply = await handleCommand(cmd, arg, conversationKey, { fromId: from_id, allowFrom }, defaultAgent);
              }
            } else {
              // Agent turn — do NOT await in the poll loop (see turnQueues).
              // The queued task owns its own delivery and error notice; the
              // shared delivery tail below serves only slash commands.
              const prev = turnQueues.get(conversationKey) ?? Promise.resolve();
              turnQueues.set(conversationKey, prev.then(async () => {
                try {
                  const turnReply = await routeToGoose(text, conversationKey, defaultAgent, platformContext);
                  const { delivered } = await sendMessage(msg.chat.id, turnReply, threadId);
                  if (delivered) {
                    console.log(`[gateway] ${logLabel}: delivered "message" reply to ${from_id} chat=${msg.chat.id}${threadId !== undefined ? ` topic=${threadId}` : ""}`);
                  } else {
                    console.error(`[gateway] ${logLabel}: reply NOT delivered to ${from_id} chat=${msg.chat.id}${threadId !== undefined ? ` topic=${threadId}` : ""} — a failure notice was sent instead of silence`);
                  }
                } catch (turnErr) {
                  console.error(`[gateway] ${logLabel}: error processing turn:`, turnErr.message);
                  try {
                    await sendMessage(msg.chat.id, `[gateway: error] ${turnErr.message}`, threadId);
                  } catch (notifyErr) {
                    console.error(`[gateway] ${logLabel}: could not even send the error notice to ${msg.chat.id}:`, notifyErr.message);
                  }
                }
              }));
              continue;
            }
            // Deliver the reply and only then decide whether to claim success.
            // deliverChatReply returns delivered:false (and posts a visible
            // "[gateway: delivery failed]" notice to the chat) whenever Telegram
            // would not accept the message, so this success marker can only fire
            // when the user actually received a reply. Ticket #545: the old
            // unconditional "handled ..." log fired after a send that may have
            // failed silently — a green that verified nothing.
            const { delivered } = await sendMessage(msg.chat.id, reply, threadId);
            if (delivered) {
              console.log(`[gateway] ${logLabel}: delivered "${text.startsWith("/") ? text.split(/\s+/)[0] : "message"}" reply to ${from_id} chat=${msg.chat.id}${threadId !== undefined ? ` topic=${threadId}` : ""}`);
            } else {
              // deliverChatReply already posted the failure notice to the chat and
              // logged the reason; this line records the true outcome of the turn.
              console.error(`[gateway] ${logLabel}: reply NOT delivered to ${from_id} chat=${msg.chat.id}${threadId !== undefined ? ` topic=${threadId}` : ""} — a failure notice was sent instead of silence`);
            }
          } catch (innerErr) {
            // A failure that reaches the user is a working bot; a swallowed one is
            // the bug #545 exists to remove. Log it AND tell the user in the chat —
            // never go quiet on a handler error.
            console.error(`[gateway] ${logLabel}: error processing update:`, innerErr.message);
            try {
              await sendMessage(msg.chat.id, `[gateway: error] ${innerErr.message}`, threadId);
            } catch (notifyErr) {
              console.error(`[gateway] ${logLabel}: could not even send the error notice to ${msg.chat.id}:`, notifyErr.message);
            }
          }
        }
      } catch (loopErr) {
        console.error(`[gateway] ${logLabel}: network error:`, loopErr.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };

  const init = async () => {
    await resolveBotUsername();
    await poll();
  };
  init().catch((err) => console.error(`[gateway] ${logLabel}: poll died:`, err.message));
};
