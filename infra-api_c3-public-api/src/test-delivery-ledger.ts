// Tester (#1819): one SMTP delivery per message however often the Worker retries.
//
// Usage (registered in ../build.json#tests, run by per-service-tests.yml):
//   node test-delivery-ledger.ts
//
//   L1 a fast send answers delivered, once.
//   L2 a slow send answers pending; a retry with the same key JOINS it (no
//      second send) and answers delivered once it lands.
//   L3 a retry after success answers delivered (deduped) without sending.
//   L4 a failed send is forgotten: the next retry really sends again.
//   L5 no Message-ID -> no key -> every call sends (old shape kept).
//   L6 the key separates target and recipient; it is case-blind on rcpt.
//   L7 TTL: a delivered entry older than ttl is pruned, a pending one never.
//   L8 the route uses the ledger, smtp_timeout_ms for the session and
//      request_timeout_ms for the answer, and build.json declares both keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDeliveryLedger, ledgerKey } from "./code/shared/delivery-ledger.ts";

let failed = 0;
const tests: Array<[string, () => Promise<void> | void]> = [];
const t = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

t("L1 fast send -> delivered, one send", async () => {
  const l = createDeliveryLedger(60_000);
  let n = 0;
  const r = await l.deliver("k", async () => { n++; }, 200);
  assert.deepEqual(r, { state: "delivered", deduped: false });
  assert.equal(n, 1);
});

t("L2 slow send -> pending; retry joins, no second send", async () => {
  const l = createDeliveryLedger(60_000);
  let n = 0;
  const send = async () => { n++; await sleep(150); };
  const r1 = await l.deliver("k", send, 30);
  assert.deepEqual(r1, { state: "pending", joined: false });
  const r2 = await l.deliver("k", send, 30);
  assert.deepEqual(r2, { state: "pending", joined: true });
  const r3 = await l.deliver("k", send, 500);
  assert.deepEqual(r3, { state: "delivered", deduped: true });
  assert.equal(n, 1, "the retries must not open new sessions");
});

t("L3 retry after success -> deduped, no send", async () => {
  const l = createDeliveryLedger(60_000);
  let n = 0;
  await l.deliver("k", async () => { n++; }, 200);
  const r = await l.deliver("k", async () => { n++; }, 200);
  assert.deepEqual(r, { state: "delivered", deduped: true });
  assert.equal(n, 1);
});

t("L4 failure is forgotten -> next retry sends again", async () => {
  const l = createDeliveryLedger(60_000);
  let n = 0;
  const r1 = await l.deliver("k", async () => { n++; throw new Error("Timeout"); }, 200);
  assert.deepEqual(r1, { state: "failed", error: "Timeout" });
  const r2 = await l.deliver("k", async () => { n++; }, 200);
  assert.deepEqual(r2, { state: "delivered", deduped: false });
  assert.equal(n, 2);
});

t("L4b a slow session that fails is reported failed to the joined retry", async () => {
  const l = createDeliveryLedger(60_000);
  const send = async () => { await sleep(80); throw new Error("Greeting never received"); };
  assert.equal((await l.deliver("k", send, 10)).state, "pending");
  assert.deepEqual(await l.deliver("k", send, 500), { state: "failed", error: "Greeting never received" });
  assert.equal(l.size(), 0);
});

t("L5 no Message-ID -> no key -> every call sends", async () => {
  assert.equal(ledgerKey("maddy", "?", "a@b"), null);
  assert.equal(ledgerKey("maddy", "", "a@b"), null);
  assert.equal(ledgerKey("maddy", undefined, "a@b"), null);
  const l = createDeliveryLedger(60_000);
  let n = 0;
  await l.deliver(null, async () => { n++; }, 200);
  await l.deliver(null, async () => { n++; }, 200);
  assert.equal(n, 2);
  assert.equal(l.size(), 0);
});

t("L6 key separates target and rcpt; rcpt case-blind", () => {
  const a = ledgerKey("maddy", "<x@y>", "Me@D.com");
  assert.equal(a, ledgerKey("maddy", " <x@y> ", "me@d.com"));
  assert.notEqual(a, ledgerKey("stalwart", "<x@y>", "me@d.com"));
  assert.notEqual(a, ledgerKey("maddy", "<x@y>", "other@d.com"));
});

t("L7 TTL prunes delivered entries, never a pending one", async () => {
  let clock = 0;
  const l = createDeliveryLedger(1000, () => clock);
  await l.deliver("done", async () => {}, 200);
  void l.deliver("slow", () => sleep(200), 5);
  await sleep(10);
  clock = 5000;
  let n = 0;
  const r = await l.deliver("done", async () => { n++; }, 200);
  assert.deepEqual(r, { state: "delivered", deduped: false });
  assert.equal(n, 1, "an expired entry sends again");
  assert.equal((await l.deliver("slow", async () => { n++; }, 5)).state, "pending");
  assert.equal(n, 1, "a pending entry is never pruned");
  await sleep(250);
});

t("L8 route + build.json wiring", () => {
  const route = readFileSync(new URL("./code/api/routes/mail.ts", import.meta.url), "utf8");
  assert.match(route, /createDeliveryLedger\(cfg\.limits\.dedupe_ttl_ms\)/);
  assert.match(route, /ledger\.deliver\(ledgerKey\(pick\.name, msgId, mailTo\), send, cfg\.limits\.request_timeout_ms\)/);
  for (const k of ["connectionTimeout", "greetingTimeout", "socketTimeout"]) {
    assert.match(route, new RegExp(`${k}: cfg\\.limits\\.smtp_timeout_ms`), `${k} must use smtp_timeout_ms`);
  }
  assert.doesNotMatch(route, /Timeout: cfg\.limits\.request_timeout_ms/, "the session must not die at the answer deadline");
  assert.match(route, /code\(504\)/);
  const build = JSON.parse(readFileSync(new URL("../build.json", import.meta.url), "utf8"));
  assert.ok(build.limits.smtp_timeout_ms > build.limits.request_timeout_ms, "session timeout must exceed the answer deadline");
  assert.ok(build.limits.dedupe_ttl_ms >= 10 * 60_000);
  const cfg = readFileSync(new URL("./code/shared/config.ts", import.meta.url), "utf8");
  assert.match(cfg, /smtp_timeout_ms \?\?=/);
  assert.match(cfg, /dedupe_ttl_ms \?\?=/);
});

for (const [name, fn] of tests) {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
}
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("all delivery-ledger checks green");
