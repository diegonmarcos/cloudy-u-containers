// #1579: devops.telegram.* reads Bot A's inbound traffic from the c3bot-relay (Bot A is in webhook mode, getUpdates is refused).
// No network: the relay /poll endpoint is a stub. Run: node --experimental-strip-types test-telegram-relay.mts
import assert from "node:assert/strict";
import { createRelayFeeder, relayConfig } from "./mcp/tools/telegram-relay.ts";
import { readFileSync } from "node:fs";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log(`ok - ${name}`); };

const stub = (replies: unknown[], seen: { url: string; auth: string }[] = []) =>
  (async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers.authorization });
    const body = replies.shift() ?? { ok: true, cursor: 0, head: 0, events: [] };
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
const ev = (seq: number, text: string) => ({ seq, type: "telegram.message", update: { update_id: 5000 + seq, message: { text } } });

await t("relayConfig is off without the relay bearer and defaults to the mesh address", () => {
  assert.equal(relayConfig({}), null);
  assert.equal(relayConfig({ C3BOT_RELAY_TOKEN: "  " }), null);
  const c = relayConfig({ C3BOT_RELAY_TOKEN: "tok" })!;
  assert.match(c.base, /^http:\/\/c3bot-relay.*\.mesh\.diegonmarcos\.com$/);
  assert.equal(relayConfig({ C3BOT_RELAY_TOKEN_MCP: "viaConsumer" })!.token, "viaConsumer"); // the CI consumer-fragment key name
  assert.equal(relayConfig({ C3BOT_RELAY_TOKEN: "tok", C3BOT_RELAY_URL: "http://x:1/c3bot-relay/" })!.base, "http://x:1/c3bot-relay");
});

await t("pollOnce sends the bearer, hands every update on with a monotonic relay-derived update_id, advances the cursor", async () => {
  const got: { update_id: number }[] = []; const seen: { url: string; auth: string }[] = [];
  const f = createRelayFeeder({ base: "http://r", token: "tok", onUpdate: (u) => got.push(u as never), waitSeconds: 1,
    fetchImpl: stub([{ ok: true, cursor: 2, head: 2, events: [ev(1, "a"), ev(2, "b")] }, { ok: true, cursor: 2, head: 2, events: [] }], seen) });
  assert.equal(await f.pollOnce(), 2);
  assert.deepEqual(got.map((u) => u.update_id), [1, 2]);
  assert.equal(f.cursor, 2);
  await f.pollOnce();
  assert.match(seen[0].url, /\/poll\?after=0&wait=1$/);
  assert.match(seen[1].url, /after=2/);
  assert.equal(seen[0].auth, "Bearer tok");
});

await t("events without an update (telegram.sent echoes) are skipped but still advance the cursor", async () => {
  const got: unknown[] = [];
  const f = createRelayFeeder({ base: "http://r", token: "t", onUpdate: (u) => got.push(u),
    fetchImpl: stub([{ ok: true, cursor: 3, head: 3, events: [{ seq: 3, type: "telegram.sent" }] }]) });
  assert.equal(await f.pollOnce(), 0);
  assert.equal(got.length, 0);
  assert.equal(f.cursor, 3);
});

await t("a relay restart (head below cursor) keeps update_ids increasing so ask() watermarks stay valid", async () => {
  const got: { update_id: number }[] = [];
  const f = createRelayFeeder({ base: "http://r", token: "t", onUpdate: (u) => got.push(u as never),
    fetchImpl: stub([
      { ok: true, cursor: 7, head: 7, events: [ev(7, "old")] },
      { ok: true, cursor: 7, head: 1, events: [] },              // relay restarted: head 1 < cursor 7
      { ok: true, cursor: 1, head: 1, events: [ev(1, "new")] },
    ]) });
  await f.pollOnce(); await f.pollOnce(); await f.pollOnce();
  assert.deepEqual(got.map((u) => u.update_id), [7, 8]);
});

await t("a non-200 from the relay throws (the loop backs off) instead of looping hot", async () => {
  const f = createRelayFeeder({ base: "http://r", token: "t", onUpdate: () => {}, fetchImpl: (async () => ({ ok: false, status: 401, json: async () => ({}) })) as never });
  await assert.rejects(f.pollOnce(), /relay \/poll HTTP 401/);
});

await t("telegram.ts wires the relay feed and keeps sends on Bot A (static check)", () => {
  const src = readFileSync(new URL("./mcp/tools/telegram.ts", import.meta.url), "utf8");
  assert.match(src, /relay \? relayLoop\(relay\) : pollLoop\(\)/);
  assert.match(src, /apiUrl\("sendMessage"\)|tgPost\("sendMessage"/);
  assert.ok(!/relay[^\n]*sendMessage/.test(src.replace(/\/\/[^\n]*/g, "")), "sends must not go through the relay");
});

console.log(`${n} tests passed`);
