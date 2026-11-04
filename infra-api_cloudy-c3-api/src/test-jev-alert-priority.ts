// #882 S3 guard: "Jev has no opinion" == today's alert priority ("high"). jevAlertPriority returns null for
// every failure mode, so poller.ts's `?? "high"` keeps the hard-coded priority; a confident in-set pick
// re-ranks, never below "default". Also checks the poller still carries the fallback.
// Usage: node test-jev-alert-priority.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { jevAlertLabel, jevAlertOutcome, jevAlertPriority } from "./code/shared/libs/jev.ts";

const st = { rule: "cpu", target: "oci-apps", metric: "cpu", op: "gt", threshold: 90, value: 97 };
const json = (b: unknown, ok = true) => (async () => ({ ok, json: async () => b })) as unknown as typeof fetch;
const pick = (p: string, confident = true) => json({ ok: true, results: { priority: { type: "choice", pick: p, p: 0.9, confident } } });
const env = { JEV_TIMEOUT_MS: "200" };

const none: Array<[string, typeof fetch]> = [
  ["sidecar down", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch],
  ["no_key", json({ ok: false, reason: "no_key" })],
  ["gate_closed", json({ ok: false, reason: "gate_closed" })],
  ["HTTP 502", json({}, false)],
  ["malformed", json("<html>")],
  ["not confident", pick("urgent", false)],
  ["priority not offered (min)", pick("min")],
  ["priority not offered (low)", pick("low")],
  ["hangs past the timeout", ((_u: string, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort"))))) as unknown as typeof fetch],
];
for (const [label, f] of none) assert.equal((await jevAlertPriority(st, f, env)).priority, null, label + " -> no opinion");
assert.equal((await jevAlertPriority(st, pick("urgent"), { ...env, JEV_ALERTS: "0" })).priority, null, "JEV_ALERTS=0 -> no opinion");
assert.equal((await jevAlertPriority(st, pick("urgent"), env)).priority, "urgent", "a confident urgent re-ranks");
assert.equal((await jevAlertPriority(st, pick("default"), env)).priority, "default", "a confident default re-ranks");

// a held (observe-only) answer has no opinion but still carries its call id, so the outcome can be recorded
const held = await jevAlertPriority(st, json({ ok: false, reason: "gate_closed", call: "c0ffee" }), env);
assert.deepEqual(held, { priority: null, call: "c0ffee" }, "gate_closed keeps the call id");

// outcomes: the open duration is the label; no call / disabled / a failing sidecar never throws or posts
assert.deepEqual([jevAlertLabel(60_000), jevAlertLabel(3_600_000), jevAlertLabel(5 * 3_600_000)], ["default", "high", "urgent"]);
const posted: any[] = [];
const rec = (async (u: string, init: any) => { posted.push([u, JSON.parse(init.body)]); return { ok: true }; }) as unknown as typeof fetch;
await jevAlertOutcome("c0ffee", 60_000, rec, env);
assert.deepEqual(posted, [["http://10.0.0.6:3110/outcome/alert_priority", { call: "c0ffee", label: { priority: "default" } }]]);
await jevAlertOutcome(null, 1, rec, env); await jevAlertOutcome("x", 1, rec, { ...env, JEV_ALERTS: "0" });
assert.equal(posted.length, 1, "no call id or disabled -> nothing posted");
await jevAlertOutcome("x", 1, (async () => { throw new Error("down"); }) as unknown as typeof fetch, env);

const poller = readFileSync(new URL("./code/shared/libs/poller.ts", import.meta.url), "utf8");
assert.match(poller, /priority: jev\.priority \?\? "high"/, 'poller keeps "high" as the fallback');
console.log("PASS");
