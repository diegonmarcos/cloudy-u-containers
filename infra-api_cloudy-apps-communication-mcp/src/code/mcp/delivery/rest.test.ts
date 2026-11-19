// REST contract (DELIVERY-API.md) over a loopback server with fixture-backed deps.
// No outbound network: Stalwart, DNS and SMTP are the fixture doubles.
// Run: node --test rest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Ledger } from "./ledger.ts";
import { RecipientChecker } from "./recipients.ts";
import { handleRest, sourceAllowed, type RestDeps } from "./rest.ts";
import { stalwartDirectory } from "./adapters.ts";
import { fixture, recordedConnector, recordedMx, recordedRegistry, recordedTxt } from "./fakes.test-helpers.ts";

const MSGID = "<CAF00d1e.4711@phone.example.org>";

function deps(ingestAllowed: string[]): RestDeps {
  const ledger = new Ledger({ path: null, relayHosts: ["smtp.email.eu-marseille-1.oci.oraclecloud.com"], localDomains: ["example.org"], retentionDays: 90 });
  const checker = new RecipientChecker({
    helo: "probe.example.org", mailFrom: "", probePort: 25, probeConnectTimeoutMs: 300, probeDialogueBudgetMs: 600, requestBudgetMs: 2000, maxMxTried: 2, probeOverrides: {},
    cacheTtlMs: 60_000, cacheTtlUnknownMs: 60_000, maxAddressesPerRequest: 3, rateLimit: { addresses: 4, perMs: 60_000 }, random: () => "probe",
  }, recordedMx(), recordedConnector([]), ledger);
  return { ledger, checker, directory: stalwartDirectory(recordedRegistry()), txt: recordedTxt(), ingestAllowed };
}

async function serve(d: RestDeps): Promise<{ base: string; srv: Server }> {
  const srv = createServer(async (req, res) => { if (!(await handleRest(req, res, d))) { res.writeHead(418); res.end("mcp"); } });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, srv };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("ingest -> GET status -> batch, with the documented shapes", async () => {
  const { base, srv } = await serve(deps(["127.0.0.1"]));
  try {
    const hook = await post(`${base}/v1/internal/stalwart/mta-hook`, fixture("mta-hook-submission.json"));
    assert.deepEqual(await hook.json(), { action: "accept" });
    const ev = await post(`${base}/v1/internal/stalwart/events`, fixture("webhook-relay-batch.json"));
    assert.deepEqual(await ev.json(), { received: 6, recorded: 5 });
    await new Promise((r) => setImmediate(r));

    const one = await fetch(`${base}/v1/sent/${encodeURIComponent(MSGID)}/status`);
    assert.equal(one.status, 200);
    const j = await one.json();
    assert.equal(j.found, true);
    assert.equal(j.messageId, MSGID);
    assert.equal(j.queueId, "40400000000002b");
    for (const k of ["submitted", "received", "sender_valid", "delivered"]) assert.ok(["ok", "pending", "failed"].includes(j.stages[k].state), k);
    assert.equal(j.stages.sender_valid.state, "ok");
    assert.equal(j.stages.delivered.recipients.length, 3);

    const byQueue = await fetch(`${base}/v1/sent/40400000000002b/status`);
    assert.equal((await byQueue.json()).messageId, MSGID);

    const batch = await post(`${base}/v1/sent/status`, { ids: [MSGID, "<missing@example.org>"] });
    const b = await batch.json();
    assert.equal(b.results.length, 2);
    assert.equal(b.results[0].found, true);
    assert.equal(b.results[1].found, false);

    const miss = await fetch(`${base}/v1/sent/${encodeURIComponent("<missing@example.org>")}/status`);
    assert.equal(miss.status, 404);
    const mj = await miss.json();
    assert.equal(mj.code, "not_found");
    assert.equal(typeof mj.error, "string");

    const bad = await post(`${base}/v1/sent/status`, { ids: "nope" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "invalid_request");
    const badJson = await post(`${base}/v1/sent/status`, "{not json");
    assert.equal((await badJson.json()).code, "invalid_json");

    const health = await (await fetch(`${base}/v1/delivery/health`)).json();
    assert.equal(health.ledger.submissions, 1);

    const mcp = await fetch(`${base}/mcp`);
    assert.equal(mcp.status, 418, "non-/v1 paths fall through to the MCP transport");
  } finally { srv.close(); }
});

test("ingest refuses any source but the mail server", async () => {
  const { base, srv } = await serve(deps(["10.0.0.3", "10.1.0.3"]));
  try {
    const r = await post(`${base}/v1/internal/stalwart/events`, fixture("webhook-relay-batch.json"));
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, "forbidden");
  } finally { srv.close(); }
});

test("ingest allow-list: exact addresses and IPv4 CIDRs (#1821: Stalwart on the local docker bridge)", () => {
  const allowed = ["10.0.0.3", "10.1.0.3", "172.16.0.0/12"];
  assert.equal(sourceAllowed(allowed, "10.0.0.3"), true);
  assert.equal(sourceAllowed(allowed, "172.18.0.2"), true, "inside 172.16.0.0/12");
  assert.equal(sourceAllowed(allowed, "172.31.255.254"), true, "last address of the /12");
  assert.equal(sourceAllowed(allowed, "172.32.0.1"), false, "just outside the /12");
  assert.equal(sourceAllowed(allowed, "10.0.0.50"), false, "another mesh peer is not the mail server");
  assert.equal(sourceAllowed(allowed, ""), false);
  assert.equal(sourceAllowed(["bad/99", "10.0.0.0/x"], "10.0.0.1"), false, "malformed entries match nothing");
  assert.equal(sourceAllowed([], "10.0.0.3"), false);
});

test("recipients/check: results, per-request cap, per-caller 429 with Retry-After", async () => {
  const { base, srv } = await serve(deps([]));
  try {
    const r = await post(`${base}/v1/recipients/check`, { addresses: ["alice@remote.example", "a@nullmx.example"] }, { "X-Forwarded-For": "10.0.0.50" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.results.map((x: any) => x.verdict), ["ok", "will_fail"]);
    const ok = j.results[0];
    assert.deepEqual(ok.checks.map((c: any) => c.check), ["syntax", "domain", "mailbox", "past_bounce", "disposable_role", "size_limit"]);
    assert.ok(ok.checks.every((c: any) => ["pass", "warn", "fail", "unknown"].includes(c.outcome)));
    assert.equal(ok.check_details.mailbox.state, "exists");
    const cap = await post(`${base}/v1/recipients/check`, { addresses: ["a@x.example", "b@x.example", "c@x.example", "d@x.example"] });
    assert.equal((await cap.json()).code, "too_many_addresses");
    const more = await post(`${base}/v1/recipients/check`, { addresses: ["b@grey.example", "c@grey.example", "d@grey.example"] }, { "X-Forwarded-For": "10.0.0.50" });
    assert.equal(more.status, 429);
    assert.ok(Number(more.headers.get("retry-after")) > 0);
    assert.equal((await more.json()).code, "rate_limited");
    const other = await post(`${base}/v1/recipients/check`, { addresses: ["b@grey.example"] }, { "X-Forwarded-For": "10.0.0.51" });
    assert.equal(other.status, 200);
    const badSize = await post(`${base}/v1/recipients/check`, { addresses: ["a@x.example"], message_size_bytes: "big" }, { "X-Forwarded-For": "10.0.0.52" });
    assert.equal((await badSize.json()).code, "invalid_request");
  } finally { srv.close(); }
});

test("client shapes: submission / sender / recipients, keyed by account + Message-ID", async () => {
  const { base, srv } = await serve(deps(["127.0.0.1"]));
  try {
    await post(`${base}/v1/internal/stalwart/mta-hook`, fixture("mta-hook-submission.json"));
    await post(`${base}/v1/internal/stalwart/events`, fixture("webhook-relay-batch.json"));
    // Raw text, as Stalwart sends it: a bare u64 queueId (a JS number literal would already be rounded).
    await post(`${base}/v1/internal/stalwart/events`, '{"events":[' +
      '{"createdAt":"2026-11-18T10:10:00Z","type":"delivery.attempt-start","data":{"spanId":77,"queueId":289356276058554411,"to":["alice@remote.example"]}},' +
      '{"createdAt":"2026-11-18T10:10:01Z","type":"delivery.connect-error","data":{"spanId":77,"hostname":"smtp.email.eu-marseille-1.oci.oraclecloud.com","details":"timed out"}}]}');
    await new Promise((r) => setImmediate(r));
    const j = await (await fetch(`${base}/v1/sent/${encodeURIComponent(MSGID)}/status?account=sender@example.org`)).json();
    assert.deepEqual(j.submission, { accepted: true, at: "2026-11-18T10:00:01Z", smtp_code: 250, message_id: MSGID, text: "250 2.0.0 Message queued with id 40400000000002b" });
    assert.equal(j.sender.may_use_from, true);
    assert.equal(j.sender.dkim_signed, true);
    assert.equal(j.sender.dkim_selector, "rsa-2026");
    assert.equal(j.sender.spf_aligned, true);
    assert.equal(j.sender.dmarc_aligned, true);
    const by = Object.fromEntries(j.recipients.map((r: any) => [r.address, r]));
    assert.equal(by["alice@remote.example"].state, "deferred");
    assert.equal(by["bob@remote.example"].state, "bounced");
    assert.equal(by["bob@remote.example"].smtp_code, 550);
    assert.equal(by["bob@remote.example"].remote_mx, "smtp.email.eu-marseille-1.oci.oraclecloud.com");
    assert.equal(by["carol@example.org"].state, "delivered");
    const other = await fetch(`${base}/v1/sent/${encodeURIComponent(MSGID)}/status?account=someone@example.org`);
    assert.equal(other.status, 404, "another account's Message-ID is not found");
    const batch = await (await post(`${base}/v1/sent/status`, { account: "sender", ids: [MSGID, "<none@example.org>"] })).json();
    assert.equal(batch.results[0].found, true);
    assert.deepEqual([batch.results[1].submission, batch.results[1].sender, batch.results[1].recipients], [null, null, null]);
  } finally { srv.close(); }
});

test("size_limit: message_size_bytes over the EHLO SIZE makes the verdict will_fail", async () => {
  const { base, srv } = await serve(deps([]));
  try {
    const j = await (await post(`${base}/v1/recipients/check`, { addresses: ["alice@remote.example"], message_size_bytes: 60_000_000 })).json();
    const r = j.results[0];
    assert.equal(r.verdict, "will_fail");
    assert.equal(r.checks.find((c: any) => c.check === "size_limit").outcome, "fail");
    const ok = await (await post(`${base}/v1/recipients/check`, { addresses: ["anyone@catchall.example"], message_size_bytes: 1000 })).json();
    const m = ok.results[0].checks.find((c: any) => c.check === "mailbox");
    assert.equal(m.outcome, "warn");
    assert.equal(m.accepts_all, true);
    assert.equal(ok.results[0].verdict, "risky");
  } finally { srv.close(); }
});

test("request budget: a batch whose probes hang still answers inside the budget, unfinished checks unknown", async () => {
  const d = deps([]);
  const hang = new RecipientChecker({ ...d.checker.cfg, requestBudgetMs: 400, probeConnectTimeoutMs: 5000, probeDialogueBudgetMs: 5000, maxAddressesPerRequest: 10, rateLimit: { addresses: 100, perMs: 60_000 } },
    recordedMx(), () => new Promise(() => {}), d.ledger);
  const { base, srv } = await serve({ ...d, checker: hang });
  try {
    const t0 = Date.now();
    const r = await post(`${base}/v1/recipients/check`, { addresses: ["alice@remote.example", "bob@grey.example", "a@nullmx.example", "not-an-address"] });
    const dt = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.ok(dt < 1500, `answered in ${dt}ms`);
    const j = await r.json();
    const v = Object.fromEntries(j.results.map((x: any) => [x.address, x]));
    assert.equal(v["alice@remote.example"].verdict, "unknown");
    assert.match(v["alice@remote.example"].reason, /budget/);
    assert.equal(v["a@nullmx.example"].verdict, "will_fail", "checks that finish in time keep their real answer");
    assert.equal(v["not-an-address"].verdict, "will_fail");
  } finally { srv.close(); }
});
