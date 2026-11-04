#!/usr/bin/env tsx
// count-since.ts — read-only: of the Gmail messages received since a given
// timestamp, count how many are ABSENT from maddy and how many are absent from
// Stalwart. Cross-store reconciliation helper for the mail health check
// (1_cicd/src/ops/cloud-health-mail-full.sh) — NOT an MCP tool, not wired into
// the MCP server. Sibling of gws_missing_backfill.py: one-off operator/CI
// script, run by hand or via `docker exec` the same way.
//
// Why this exists: the 7-phase cloud-mail-health-full Rust derive is a
// liveness/e2e PROBE (send a test message, check it round-trips) — it does
// NOT compare store contents, so a store silently falling behind (e.g.
// maddy's dual-write to Stalwart failing) goes undetected.
//
// Why membership and not counts: this script used to count what each store
// received since --since, and the caller compared those totals with Gmail's.
// A store stamps a message with ITS arrival time; Gmail keeps the original.
// So every re-injection lands inside the store's window and outside Gmail's:
// on 2026-09-14 the health_mail-reconcile DAG re-injected 146 messages Gmail
// had received 09-05..09-10, and for a whole day the check failed on
// "gmail=32 maddy=178 stalwart=181" — not one message lost, not one
// duplicated. A count cannot tell a missing message from an extra one either,
// so a real loss hidden behind a re-injection would have passed. "Is each of
// Gmail's messages in the store?" is the question the check exists to ask.
//
// Usage:
//   python count_recent.py --since 2026-08-21T00:00:00Z --message-ids \
//     | tsx count-since.ts --since 2026-08-21T00:00:00Z
// stdin: one Gmail Message-ID per line.
// Prints: {"gmail":<N>,"maddy_missing":<M>,"stalwart_missing":<S>}
// (gmail is the number of distinct Message-IDs read; either missing count is
// -1 on error, with the reason on stderr — the caller decides how to treat a -1).
//
// Credentials: reused exactly as cloud-mail-mcp's own tools read them — see
// ../../shared/config.ts getAccount(). Set MADDY_ME_USER/MADDY_ME_PASSWORD
// (or MAIL_USER/MAIL_PASSWORD, the maddy/me back-compat fallback) and
// STALWART_ME_USER/STALWART_ME_PASSWORD in the environment this runs in —
// same env vars the cloud-mail-mcp container already has via its .secrets file
// (see ../../../compose.nix), so this is meant to run via `docker exec -i
// cloud-mail-mcp ...` on oci-apps, not standalone.

import { readFileSync } from "node:fs";
import { withImap } from "../../shared/imap.js";
import { getServer, getAccount } from "../../shared/config.js";

// A store can hold a message from slightly before Gmail's timestamp, and a
// re-injected one from long after it, so the stores are not windowed to
// --since: every Message-ID a store received from three days earlier onwards
// counts as present.
const LOOKBACK_MILLISECONDS = 3 * 86400000;

// Angle brackets belong to the header on the wire: imapflow keeps them, JMAP
// strips them. Case-folded so Gmail and both stores compare alike.
function normalizeMessageId(value: string | undefined | null): string {
  return (value || "").trim().replace(/^</, "").replace(/>$/, "").toLowerCase();
}

function authHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

async function maddyMessageIds(from: Date): Promise<Set<string>> {
  return withImap("maddy", "me", async (client) => {
    // Three traps here:
    //
    //  1. withImap connects but never SELECTs a mailbox, and imapflow's
    //     search() returns `undefined` (not []) with none selected. Treating
    //     that as "no mail" reported every Gmail message as missing. An absent
    //     result set is a throw, which main() converts to the -1 sentinel.
    //  2. Sieve sorts incoming mail out of INBOX into the F* folders, so a
    //     single mailbox misses about half of it. Walk every selectable one.
    //  3. IMAP SEARCH SINCE is date-granularity, and maddy's imapsql treats it
    //     as INTERNALDATE > <the whole day>. The three-day lookback absorbs it.
    const ids = new Set<string>();
    for (const box of await client.list()) {
      if (box.flags?.has("\\Noselect")) continue;
      const lock = await client.getMailboxLock(box.path);
      try {
        const uids = await client.search({ since: from }, { uid: true });
        if (!Array.isArray(uids)) {
          throw new Error(`IMAP SEARCH returned no result set for ${box.path} (mailbox not selected?)`);
        }
        if (uids.length === 0) continue;
        for await (const message of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
          const id = normalizeMessageId(message.envelope?.messageId);
          if (id) ids.add(id);
        }
      } finally {
        lock.release();
      }
    }
    return ids;
  });
}

async function stalwartMessageIds(from: Date): Promise<Set<string>> {
  const srv = getServer("stalwart");
  const creds = getAccount("stalwart", "me");
  if (!srv.jmap) throw new Error("STALWART_JMAP_URL not configured");
  const auth = authHeader(creds.user, creds.password);

  // Session discovery — same direct-session-resource pattern as jmap.ts
  // (avoids depending on the /.well-known/jmap redirect).
  const sessionUrl = new URL("/jmap/session", srv.jmap).toString();
  const sres = await fetch(sessionUrl, { headers: { Authorization: auth } });
  if (!sres.ok) throw new Error(`JMAP session ${sres.status}: ${await sres.text()}`);
  const session = (await sres.json()) as { apiUrl: string; primaryAccounts: Record<string, string> };
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error("JMAP: no primary mail account in session");
  // Rebase advertised apiUrl PATH onto the configured origin (public edge vs
  // WG-direct backend port) — same rebase jmap.ts does before POSTing.
  const base = new URL(srv.jmap);
  const adv = new URL(session.apiUrl, base);
  const apiUrl = base.origin + adv.pathname + adv.search;

  // Paged so one response stays bounded however much mail the lookback holds.
  // Sorted oldest-first so mail arriving mid-scan appends to the end instead
  // of shifting a page boundary over a message that would then go unread.
  const pageSize = 250;
  const ids = new Set<string>();
  for (let position = 0; ; ) {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify({
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [
          ["Email/query", {
            accountId,
            filter: { after: from.toISOString() },
            sort: [{ property: "receivedAt", isAscending: true }],
            position,
            limit: pageSize,
          }, "q"],
          ["Email/get", {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["messageId"],
          }, "g"],
        ],
      }),
    });
    if (!res.ok) throw new Error(`JMAP Email/query ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { methodResponses?: [string, Record<string, unknown>, string][] };
    const query = body.methodResponses?.[0]?.[1] as { ids?: string[] } | undefined;
    const emails = body.methodResponses?.[1]?.[1] as { list?: { messageId?: string[] | null }[] } | undefined;
    // A page that did not answer must not end the scan quietly: everything
    // after it would be reported missing. Throw so the caller gets -1.
    if (!Array.isArray(query?.ids) || !Array.isArray(emails?.list)) {
      throw new Error(`JMAP Email/query page returned no ids/list: ${JSON.stringify(body).slice(0, 300)}`);
    }
    for (const email of emails.list) {
      for (const id of email.messageId || []) ids.add(normalizeMessageId(id));
    }
    position += query.ids.length;
    if (query.ids.length < pageSize) break;
  }
  return ids;
}

async function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--since");
  const sinceArg = idx >= 0 ? args[idx + 1] : undefined;
  if (!sinceArg) {
    process.stderr.write("usage: <Gmail Message-IDs on stdin> | count-since.ts --since <ISO8601>\n");
    process.exit(2);
  }
  const sinceDate = new Date(sinceArg);
  if (Number.isNaN(sinceDate.getTime())) {
    process.stderr.write(`invalid --since date: ${sinceArg}\n`);
    process.exit(2);
  }

  const gmailIds = [...new Set(readFileSync(0, "utf8").split("\n").map(normalizeMessageId).filter(Boolean))];
  const from = new Date(sinceDate.getTime() - LOOKBACK_MILLISECONDS);

  const countMissing = (store: string, load: Promise<Set<string>>) =>
    load
      .then((present) => gmailIds.filter((id) => !present.has(id)).length)
      .catch((e) => {
        process.stderr.write(`${store} Message-ID read failed: ${e instanceof Error ? e.message : e}\n`);
        return -1;
      });

  const [maddyMissing, stalwartMissing] = await Promise.all([
    countMissing("maddy", maddyMessageIds(from)),
    countMissing("stalwart", stalwartMessageIds(from)),
  ]);

  process.stdout.write(
    JSON.stringify({ gmail: gmailIds.length, maddy_missing: maddyMissing, stalwart_missing: stalwartMissing }) + "\n",
  );
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : e}\n`);
  process.exit(1);
});
