// Run: node --test fetch-connect-retry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchConnectRetry, isConnectPhaseError } from "./fetch-connect-retry.ts";

const fail = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
const ok = () => new Response("{}", { status: 200 });
const quiet = <T>(fn: () => Promise<T>) => {
  const orig = console.error; console.error = () => {};
  return fn().finally(() => { console.error = orig; });
};

test("cold connect timeout is retried and the warm attempt succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; if (calls === 1) throw fail("UND_ERR_CONNECT_TIMEOUT"); return ok(); };
  const r = await quiet(() => fetchConnectRetry("https://jmap.example.test:2443/jmap/session", {}, { delayMs: 1, fetchImpl }));
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
});

test("a failure after connect (reset) is never retried: the write may have landed", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw fail("ECONNRESET"); };
  await assert.rejects(fetchConnectRetry("https://x.test/", { method: "POST" }, { delayMs: 1, fetchImpl }));
  assert.equal(calls, 1);
});

test("gives up after the attempt budget", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw fail("ECONNREFUSED"); };
  await quiet(() => assert.rejects(fetchConnectRetry("https://x.test/", {}, { attempts: 3, delayMs: 1, fetchImpl })));
  assert.equal(calls, 3);
});

test("classifier: connect-phase codes only", () => {
  assert.equal(isConnectPhaseError(fail("UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(isConnectPhaseError(fail("UND_ERR_SOCKET")), false);
  assert.equal(isConnectPhaseError(fail("ECONNRESET")), false);
  assert.equal(isConnectPhaseError(new Error("plain")), false);
});

test("every Stalwart JMAP fetch in round-trip, count-since and jmap goes through the retry", () => {
  for (const f of ["../tools/others/round-trip.ts", "../tools/others/count-since.ts", "./jmap.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const bare = src.split("\n").filter((l) => /\bawait fetch\(/.test(l) && !l.trim().startsWith("//"));
    assert.deepEqual(bare, [], `${f} still has a bare await fetch(`);
    assert.match(src, /fetchConnectRetry\(/, `${f} does not use fetchConnectRetry`);
  }
});
