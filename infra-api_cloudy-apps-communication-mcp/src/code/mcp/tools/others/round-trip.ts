#!/usr/bin/env tsx
// round-trip.ts — send one uniquely identified message into the mail system,
// assert it lands in BOTH stores (maddy's imapsql and Stalwart, the store the
// user's app reads), then remove it again. The send/receive test for the mail
// health check (1_cicd/src/ops/cloud-health-mail-full.sh) — NOT an MCP tool,
// not wired into the MCP server. Sibling of count-since.ts.
//
// Why this exists: nothing tested that mail can actually be delivered. Phase 6
// of the cloud-mail-health-full report is disabled unless RESEND_API_KEY
// reaches the reports container, which no caller passes, and even enabled its
// "arrival" check greps maddy's log for ANY accepted message in the last
// minute — any unrelated inbound mail passes it.
//
// The path under test: authenticated submission (:465, as the noreply account)
// -> maddy local_routing -> maddy imapsql + stalwart_queue -> Stalwart. The
// envelope sender is deliberately on a non-local, reserved domain (.invalid,
// RFC 2606): maddy's submission endpoint sends mail FROM a local sender to
// remote_queue, i.e. out through the public MX, where the email-forwarder
// Worker would import the test message into the Gmail primary every run with
// no way to remove it (gmail.readonly). A non-local sender takes
// default_source -> local_routing, the same pipeline the Worker's port-25
// delivery and mail-puller's re-injections converge on. What this does NOT
// cover is the Cloudflare -> Worker -> http-to-smtp-proxy-api hop itself.
//
// maddy is read over IMAP, Stalwart over JMAP: Stalwart's IMAP SEARCH HEADER
// Message-ID matches nothing (verified live — the message was in 11 Stalwart
// mailboxes and the header search returned 0 in every one), so an IMAP poll
// there reports a delivered message as lost. JMAP also destroys the Email once
// instead of once per mailbox the sorter filed it into.
//
// Removal is by test DOMAIN, not only this run's Message-ID: a run that missed
// its deadline leaves a copy that arrives later, and the next run sweeps it.
// Nothing else is ever sent from round-trip.invalid.
//
// Usage:
//   tsx round-trip.ts
// Prints one line: {"sent":<bool>,"maddy":{"received":<bool>,"seconds":<n>,"removed":<n>},
//   "stalwart":{...}}  — pass/fail, seconds and counts only, never content.
// Exit 0 only when both stores received the message.
//
// Credentials: MADDY_NOREPLY_* (send), MADDY_ME_* and STALWART_ME_* (receive),
// read through ../../shared/config.ts exactly like the MCP tools — the env the
// cloud-mail-mcp container already has from sops. Run via `docker exec
// cloud-mail-mcp ...` on oci-apps.

import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import { getTransport } from "../../shared/smtp.js";
import { withImap } from "../../shared/imap.js";
import { getServer, getAccount, DOMAIN } from "../../shared/config.js";

const DEADLINE_MILLISECONDS = 180_000;
const POLL_MILLISECONDS = 15_000;
const SWEEP_LOOKBACK_MILLISECONDS = 7 * 86_400_000;
const POLL_LOOKBACK_MILLISECONDS = 2 * 86_400_000;
// Stalwart stamps receivedAt with its own clock; start the poll window a few
// minutes before the send so clock skew between the VMs cannot hide the message.
const CLOCK_SKEW_MILLISECONDS = 300_000;
const TEST_DOMAIN = "round-trip.invalid";

interface StoreResult {
  received: boolean;
  seconds: number;
  removed: number;
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const bare = (messageId: string) => messageId.trim().replace(/^<|>$/g, "");
const isTestMessage = (messageId: string) => bare(messageId).endsWith(`@${TEST_DOMAIN}`);

// Polls until `find` reports this run's message or the deadline passes, then
// removes every test message the last lookup saw. `find` returns the test
// messages present; `remove` deletes them and returns how many went.
async function awaitAndRemove<T extends { messageId: string }>(
  messageId: string,
  sentAt: number,
  find: () => Promise<T[]>,
  remove: (found: T[]) => Promise<number>,
): Promise<StoreResult> {
  for (;;) {
    const found = await find();
    const received = found.some((message) => message.messageId === messageId);
    if (received || Date.now() - sentAt >= DEADLINE_MILLISECONDS) {
      const seconds = Math.round((Date.now() - sentAt) / 1000);
      return { received, seconds, removed: found.length ? await remove(found) : 0 };
    }
    await sleep(POLL_MILLISECONDS);
  }
}

// Folder rules move mail at delivery time, so the message can be in any
// mailbox: every selectable one is walked and the fetched envelope decides.
// The search is SINCE only. A HEADER Message-ID search makes maddy scan every
// message body: on the 11.7k-message INBOX it ran past withImap's 60s
// socketTimeout, imapflow emitted an unhandled 'error' and node died with a
// stack trace (#581) — the probe never reached a verdict. SINCE alone answers
// in seconds; the poll uses a two-day window (SINCE is date-granular, and the
// extra day absorbs a send near midnight), the removal sweep the full lookback.
async function maddyTestMessages(client: ImapFlow, lookbackMilliseconds: number): Promise<{ path: string; uid: number; messageId: string }[]> {
  const since = new Date(Date.now() - lookbackMilliseconds);
  const found: { path: string; uid: number; messageId: string }[] = [];
  for (const box of await client.list()) {
    if (box.flags?.has("\\Noselect")) continue;
    const lock = await client.getMailboxLock(box.path);
    try {
      const uids = await client.search({ since }, { uid: true });
      // A closed connection makes imapflow answer `false`, not throw: reading
      // that as "no mail" would report a dead read as "not received".
      if (!Array.isArray(uids)) throw new Error(`IMAP SEARCH returned no result set for ${box.path}`);
      if (uids.length === 0) continue;
      for await (const message of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        const id = message.envelope?.messageId;
        if (id && isTestMessage(id)) found.push({ path: box.path, uid: message.uid, messageId: bare(id) });
      }
    } finally {
      lock.release();
    }
  }
  return found;
}

function maddyRoundTrip(messageId: string, sentAt: number): Promise<StoreResult> {
  return withImap("maddy", "me", (client) =>
    awaitAndRemove(messageId, sentAt, () => maddyTestMessages(client, POLL_LOOKBACK_MILLISECONDS), async () => {
      // Sweep the full lookback so copies earlier failed runs left are taken too.
      const leftovers = await maddyTestMessages(client, SWEEP_LOOKBACK_MILLISECONDS);
      let removed = 0;
      for (const path of new Set(leftovers.map((message) => message.path))) {
        const uids = leftovers.filter((message) => message.path === path).map((message) => message.uid);
        const lock = await client.getMailboxLock(path);
        try {
          if (await client.messageDelete(uids, { uid: true })) removed += uids.length;
        } finally {
          lock.release();
        }
      }
      return removed;
    }),
  );
}

async function stalwartRoundTrip(messageId: string, sentAt: number): Promise<StoreResult> {
  const server = getServer("stalwart");
  const credentials = getAccount("stalwart", "me");
  if (!server.jmap) throw new Error("STALWART_JMAP_URL not configured");
  const authorization = "Basic " + Buffer.from(`${credentials.user}:${credentials.password}`).toString("base64");

  // Session discovery and apiUrl rebase — same as count-since.ts and jmap.ts.
  const sessionResponse = await fetch(new URL("/jmap/session", server.jmap).toString(), { headers: { Authorization: authorization } });
  if (!sessionResponse.ok) throw new Error(`JMAP session ${sessionResponse.status}`);
  const session = (await sessionResponse.json()) as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error("JMAP: no primary mail account in session");
  const base = new URL(server.jmap);
  const advertised = new URL(session.apiUrl, base);
  const apiUrl = base.origin + advertised.pathname + advertised.search;

  const call = async (methodCalls: unknown[]) => {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"], methodCalls }),
    });
    if (!response.ok) throw new Error(`JMAP ${response.status}`);
    return ((await response.json()) as { methodResponses?: [string, any, string][] }).methodResponses ?? [];
  };

  // Paged oldest-first, like count-since.ts. A page that does not answer throws
  // rather than ending the scan, so a broken read never looks like "not arrived".
  const testEmails = async (after: Date) => {
    const pageSize = 250;
    const found: { id: string; messageId: string }[] = [];
    for (let position = 0; ; ) {
      const [query, emails] = await call([
        ["Email/query", { accountId, filter: { after: after.toISOString() }, sort: [{ property: "receivedAt", isAscending: true }], position, limit: pageSize }, "q"],
        ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: ["id", "messageId"] }, "g"],
      ]);
      const ids = query?.[1]?.ids;
      const list = emails?.[1]?.list;
      if (!Array.isArray(ids) || !Array.isArray(list)) throw new Error("JMAP Email/query page returned no ids/list");
      for (const email of list as { id: string; messageId?: string[] | null }[]) {
        const id = (email.messageId ?? []).find(isTestMessage);
        if (id) found.push({ id: email.id, messageId: bare(id) });
      }
      position += ids.length;
      if (ids.length < pageSize) return found;
    }
  };

  return awaitAndRemove(
    messageId,
    sentAt,
    () => testEmails(new Date(sentAt - CLOCK_SKEW_MILLISECONDS)),
    // The poll window only covers this run; the sweep reaches back far enough
    // to also take copies earlier failed runs left behind.
    async () => {
      const leftovers = await testEmails(new Date(Date.now() - SWEEP_LOOKBACK_MILLISECONDS));
      if (!leftovers.length) return 0;
      const [destroyed] = await call([["Email/set", { accountId, destroy: leftovers.map((email) => email.id) }, "d"]]);
      return Array.isArray(destroyed?.[1]?.destroyed) ? destroyed[1].destroyed.length : 0;
    },
  );
}

async function main() {
  const messageId = `round-trip-${randomUUID()}@${TEST_DOMAIN}`;
  const sender = `mail-round-trip@${TEST_DOMAIN}`;
  const recipientUser = getAccount("maddy", "me").user;
  const recipient = recipientUser.includes("@") ? recipientUser : `${recipientUser}@${DOMAIN}`;
  const unreceived: StoreResult = { received: false, seconds: 0, removed: 0 };

  const sentAt = Date.now();
  try {
    await getTransport("maddy", "noreply").sendMail({
      envelope: { from: sender, to: recipient },
      from: sender,
      to: recipient,
      messageId: `<${messageId}>`,
      subject: "mail round-trip test",
      text: "Automated send/receive test from the mail health check. Removed automatically once both stores have it.",
    });
  } catch (e) {
    process.stderr.write(`send failed: ${e instanceof Error ? e.message : e}\n`);
    process.stdout.write(JSON.stringify({ sent: false, maddy: unreceived, stalwart: unreceived }) + "\n");
    process.exit(1);
  }

  const settle = (server: string, check: Promise<StoreResult>) =>
    check.catch((e) => {
      process.stderr.write(`${server} receive check failed: ${e instanceof Error ? e.message : e}\n`);
      return unreceived;
    });
  const [maddy, stalwart] = await Promise.all([
    settle("maddy", maddyRoundTrip(messageId, sentAt)),
    settle("stalwart", stalwartRoundTrip(messageId, sentAt)),
  ]);

  process.stdout.write(JSON.stringify({ sent: true, maddy, stalwart }) + "\n");
  process.exit(maddy.received && stalwart.received ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
