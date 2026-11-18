// REST contract (DELIVERY-API.md) over a loopback server with fixture-backed deps.
// No outbound network: Stalwart, DNS and SMTP are the fixture doubles.
// Run: node --test rest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Ledger } from "./ledger.ts";
import { RecipientChecker } from "./recipients.ts";
import { handleRest, type RestDeps } from "./rest.ts";
import { stalwartDirectory } from "./adapters.ts";
import { fixture, recordedConnector, recordedMx, recordedRegistry, recordedTxt } from "./fakes.test-helpers.ts";

const MSGID = "<CAF00d1e.4711@phone.example.org>";

function deps(ingestAllowed: string[]): RestDeps {
  const ledger = new Ledger({ path: null, relayHosts: ["smtp.email.eu-marseille-1.oci.oraclecloud.com"], localDomains: ["example.org"], retentionDays: 90 });
  const checker = new RecipientChecker({
    helo: "probe.example.org", mailFrom: "", probePort: 25, probeTimeoutMs: 1000, maxMxTried: 2, probeOverrides: {},
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

test("recipients/check: results, per-request cap, per-caller 429 with Retry-After", async () => {
  const { base, srv } = await serve(deps([]));
  try {
    const r = await post(`${base}/v1/recipients/check`, { addresses: ["alice@remote.example", "a@nullmx.example"] }, { "X-Forwarded-For": "10.0.0.50" });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j.results.map((x: any) => x.verdict), ["ok", "fail"]);
    const cap = await post(`${base}/v1/recipients/check`, { addresses: ["a@x.example", "b@x.example", "c@x.example", "d@x.example"] });
    assert.equal((await cap.json()).code, "too_many_addresses");
    const more = await post(`${base}/v1/recipients/check`, { addresses: ["b@grey.example", "c@grey.example", "d@grey.example"] }, { "X-Forwarded-For": "10.0.0.50" });
    assert.equal(more.status, 429);
    assert.ok(Number(more.headers.get("retry-after")) > 0);
    assert.equal((await more.json()).code, "rate_limited");
    const other = await post(`${base}/v1/recipients/check`, { addresses: ["b@grey.example"] }, { "X-Forwarded-For": "10.0.0.51" });
    assert.equal(other.status, 200);
  } finally { srv.close(); }
});
