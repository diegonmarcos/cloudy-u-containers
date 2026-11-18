// #1802 delivery status — fixtures only, no network. Run: node --test delivery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "./ledger.ts";
import { parseMtaHookBody, parseWebhookBody, quoteBigInts, queueIdHex, normMessageId } from "./stalwart-wire.ts";
import { parseDsn } from "./dsn.ts";
import { senderValid } from "./sender-valid.ts";
import { stalwartDirectory } from "./adapters.ts";
import { fixture, recordedRegistry, recordedTxt } from "./fakes.test-helpers.ts";

const Q = "40400000000002b"; // 289356276058554411 (> 2^53) in Stalwart's hex form
const MSGID = "<CAF00d1e.4711@phone.example.org>";
const RELAY = "smtp.email.eu-marseille-1.oci.oraclecloud.com";

function ledger(path: string | null = null): Ledger {
  return new Ledger({ path, relayHosts: [RELAY, "10.0.0.3"], localDomains: ["example.org"], retentionDays: 90 });
}
function loaded(path: string | null = null): Ledger {
  const l = ledger(path);
  l.ingestHook(parseMtaHookBody(fixture("mta-hook-submission.json")), "2026-11-18T10:00:00.500Z");
  l.ingestEvents(parseWebhookBody(fixture("webhook-relay-batch.json")));
  return l;
}

test("u64 spanId/queueId survive JSON parsing and map to Stalwart's hex queue id", () => {
  const raw = fixture("webhook-relay-batch.json");
  assert.notEqual(BigInt(JSON.parse(raw).events[0].data.queueId).toString(16), Q, "plain JSON.parse must lose precision (proves the fixture exercises the bug)");
  const evs = parseWebhookBody(raw);
  assert.equal(queueIdHex(evs[0].data.queueId), Q);
  assert.equal(quoteBigInts('{"queueId": 18446744073709551615}'), '{"queueId":"18446744073709551615"}');
});

test("Message-ID normalisation accepts bracketed, bare and URL-encoded forms", () => {
  for (const v of [MSGID, "CAF00d1e.4711@phone.example.org", encodeURIComponent(MSGID)]) assert.equal(normMessageId(v), MSGID);
});

test("submitted + received come from the MTA hook and the queue event", () => {
  const l = loaded();
  assert.deepEqual(l.resolve(MSGID).queueIds, [Q]);
  assert.deepEqual(l.resolve(Q).queueIds, [Q]);
  const sub = l.submittedStage(Q);
  assert.equal(sub.state, "ok");
  assert.equal(sub.at, "2026-11-18T10:00:00.500Z");
  const rec = l.receivedStage(Q);
  assert.equal(rec.state, "ok");
  assert.equal(rec.queueId, Q);
  assert.equal(rec.at, "2026-11-18T10:00:01Z");
});

test("per-recipient: relay 250 is pending (not delivered), 5xx is failed, local recipient ok on completion", () => {
  const l = loaded();
  const d = l.deliveredStage(Q);
  const by = Object.fromEntries(d.recipients.map((r) => [r.rcpt, r]));
  assert.equal(by["alice@remote.example"].state, "pending");
  assert.equal(by["alice@remote.example"].hop, "relay");
  assert.match(by["alice@remote.example"].reason, /accepted by relay/);
  assert.equal(by["bob@remote.example"].state, "failed");
  assert.match(by["bob@remote.example"].reason, /5\.1\.1/);
  assert.equal(by["carol@example.org"].state, "ok");
  assert.equal(by["carol@example.org"].hop, "local");
  assert.equal(d.state, "failed");
  assert.deepEqual(l.lastBounce("bob@remote.example")?.reason.includes("5.1.1"), true);
});

test("a DSN that references the original Message-ID settles the relayed recipient", () => {
  const h = parseMtaHookBody(fixture("mta-hook-dsn.json"));
  const dsn = parseDsn(h.headers, h.body);
  assert.ok(dsn);
  assert.equal(dsn.originalMessageId, MSGID);
  assert.equal(dsn.recipients[0].rcpt, "alice@remote.example");
  assert.equal(dsn.recipients[0].action, "failed");
  assert.equal(dsn.recipients[0].status, "5.2.2");
  const l = loaded();
  assert.equal(l.ingestHook(h, "2026-11-18T10:00:07Z"), "dsn");
  const alice = l.recipients(Q).find((r) => r.rcpt === "alice@remote.example");
  assert.equal(alice?.state, "failed");
  assert.equal(alice?.hop, "dsn");
  assert.match(String(alice?.reason), /Mailbox full/);
});

test("deferral (4xx) stays pending; non-DSN null-sender mail is ignored", () => {
  const l = ledger();
  l.ingestEvents(parseWebhookBody(JSON.stringify({ events: [
    { createdAt: "2026-11-18T11:00:00Z", type: "queue.authenticated-message-queued", data: { spanId: 1, queueId: 255, from: "sender@example.org", to: ["x@remote.example"] } },
    { createdAt: "2026-11-18T11:00:01Z", type: "delivery.attempt-start", data: { spanId: 2, queueId: 255, to: ["x@remote.example"] } },
    { createdAt: "2026-11-18T11:00:02Z", type: "delivery.rcpt-to-rejected", data: { spanId: 2, hostname: "mx.remote.example", to: "x@remote.example", code: 451, details: "4.7.1 greylisted" } },
  ] })));
  assert.equal(l.recipients("ff")[0].state, "pending");
  assert.equal(l.deliveredStage("ff").state, "pending");
  const notDsn = parseMtaHookBody(JSON.stringify({ context: { stage: "data" }, envelope: { from: { address: "" }, to: [] }, message: { headers: [["Content-Type", "text/plain"]], contents: "hi", size: 2 } }));
  assert.equal(l.ingestHook(notDsn), "ignored");
});

test("sender_valid: From authorised, DKIM signer active under the default rule, DMARC aligned", async () => {
  const l = loaded();
  const sv = await senderValid(l, Q, stalwartDirectory(recordedRegistry()), recordedTxt());
  assert.equal(sv.state, "ok", sv.reason);
  assert.equal(sv.checks.from_authorized.state, "ok");
  assert.equal(sv.checks.dkim.state, "ok");
  assert.deepEqual(sv.checks.dkim.selectors, ["rsa-2026"]);
  assert.equal(sv.checks.dkim.evidence, "signer_config");
  assert.equal(sv.checks.dmarc.state, "ok");
  assert.equal(sv.checks.spf.state, "ok");
});

test("sender_valid: header From outside the account fails; no DKIM key fails; unreadable directory is pending", async () => {
  const l = ledger();
  const hook = JSON.parse(fixture("mta-hook-submission.json"));
  hook.message.headers[0][1] = " CEO <ceo@other.example>";
  l.ingestHook(parseMtaHookBody(JSON.stringify(hook)));
  l.ingestEvents(parseWebhookBody(fixture("webhook-relay-batch.json")));
  const sv = await senderValid(l, Q, stalwartDirectory(recordedRegistry()), recordedTxt());
  assert.equal(sv.checks.from_authorized.state, "failed");
  assert.equal(sv.state, "failed");

  const l2 = loaded();
  const noKeys = await senderValid(l2, Q, stalwartDirectory(recordedRegistry({ DkimSignature: [] })), recordedTxt());
  assert.equal(noKeys.checks.dkim.state, "failed");
  assert.equal(noKeys.checks.dmarc.state, "failed");

  const blind = await senderValid(loaded(), Q, stalwartDirectory(recordedRegistry({ SenderAuth: null })), recordedTxt());
  assert.equal(blind.checks.dkim.state, "pending");
  assert.equal(blind.state, "pending");
});

test("alias addresses of the account are authorised senders", async () => {
  const l = ledger();
  const hook = JSON.parse(fixture("mta-hook-submission.json"));
  hook.message.headers[0][1] = " Hello <hello@example.org>";
  l.ingestHook(parseMtaHookBody(JSON.stringify(hook)));
  l.ingestEvents(parseWebhookBody(fixture("webhook-relay-batch.json")));
  const sv = await senderValid(l, Q, stalwartDirectory(recordedRegistry()), recordedTxt());
  assert.equal(sv.checks.from_authorized.state, "ok", String(sv.checks.from_authorized.reason));
});

test("JSONL persistence replays to the same status after a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const path = join(dir, "delivery-ledger.jsonl");
  const a = loaded(path);
  const before = JSON.stringify(a.deliveredStage(Q));
  assert.ok(readFileSync(path, "utf8").trim().split("\n").length >= 6);
  const b = ledger(path);
  assert.equal(JSON.stringify(b.deliveredStage(Q)), before);
  assert.deepEqual(b.resolve(MSGID).queueIds, [Q]);
});
