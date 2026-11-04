// #882 S9 guard: "Jev has no opinion" == today's model (DEFAULT_MODEL). jevTier() is pulled out of the REAL
// server.mjs and must return null for every failure/doubt, so `payload.model || jevTier || DEFAULT_MODEL`
// keeps DEFAULT_MODEL; an explicit model never reaches it. Usage: node test-my-ai-jev-tier.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
const body = src.slice(src.indexOf("// jev:begin"), src.indexOf("// jev:end"));
const { jevTier, jevPonytail } = new Function(`${body}; return { jevTier, jevPonytail };`)();

const tiers = JSON.stringify({ fast: "m/fast", strong: "m/strong" });
const env = { BRIDGE_TIER_MODELS: tiers, JEV_TIMEOUT_MS: "200" };
const msgs = [{ role: "user", content: "hi" }];
const j = (b, ok = true) => async () => ({ ok, json: async () => b });
const pick = (p, confident = true) => j({ ok: true, results: { tier: { type: "choice", pick: p, p: 0.9, confident } } });

const none = {
  "no tiers declared": [{}, pick("fast")],
  "one tier only": [{ BRIDGE_TIER_MODELS: '{"fast":"m"}' }, pick("fast")],
  "bad tiers json": [{ BRIDGE_TIER_MODELS: "{" }, pick("fast")],
  "sidecar down": [env, async () => { throw new Error("ECONNREFUSED"); }],
  no_key: [env, j({ ok: false, reason: "no_key" })],
  gate_closed: [env, j({ ok: false, reason: "gate_closed" })],
  "HTTP 502": [env, j({}, false)],
  malformed: [env, j("<html>")],
  "not confident": [env, pick("strong", false)],
  "unmapped tier": [env, pick("medium")],
  "JEV_ROUTER=0": [{ ...env, JEV_ROUTER: "0" }, pick("fast")],
  "hangs": [env, (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort"))))],
};
for (const [label, [e, f]] of Object.entries(none)) assert.equal(await jevTier(msgs, {}, e, f), null, label + " -> DEFAULT_MODEL");
assert.equal(await jevTier(msgs, { "x-jev": "off" }, env, pick("fast")), null, "x-jev: off wins");
assert.equal(await jevTier(msgs, {}, env, pick("fast")), "m/fast", "a confident tier picks its model");

// the call sites: an explicit model is never overridden, and the fallback is DEFAULT_MODEL
assert.equal((src.match(/payload\.model \|\| \(await jevTier\([^\n]*\)\) \|\| DEFAULT_MODEL/g) || []).length, 2, "both entry points keep payload.model first and DEFAULT_MODEL last");

// #882 S9 Ponytail: the profile when no header names one. No opinion keeps PONYTAIL_DEFAULT; "off" is never offered.
const pp = (p, conf = true) => j({ ok: true, call: "c", results: { profile: { type: "choice", pick: p, p: 0.9, confident: conf } } });
const ppNone = {
  "sidecar down": async () => { throw new Error("ECONNREFUSED"); },
  no_key: j({ ok: false, reason: "no_key" }), gate_closed: j({ ok: false, reason: "gate_closed", call: "c" }),
  "HTTP 502": j({}, false), malformed: j("<html>"), "not confident": pp("ultra", false),
  "off is never accepted": pp("off"), "unknown profile": pp("turbo"),
};
for (const [label, f] of Object.entries(ppNone)) assert.equal(await jevPonytail(msgs, {}, env, f), null, "ponytail " + label + " -> PONYTAIL_DEFAULT");
assert.equal(await jevPonytail(msgs, { "x-ponytail-mode": "lite" }, env, pp("ultra")), null, "an explicit header wins");
assert.equal(await jevPonytail(msgs, { "x-jev": "off" }, env, pp("ultra")), null, "x-jev: off wins");
assert.equal(await jevPonytail(msgs, {}, { ...env, JEV_ROUTER: "0" }, pp("ultra")), null, "JEV_ROUTER=0 wins");
assert.equal(await jevPonytail(msgs, {}, env, pp("ultra")), "ultra", "a confident offered profile is returned");
assert.match(src, /getPonytailProfile\(headers, await jevPonytail\(rtkd, headers\)\)/, "the pipeline asks before it compresses");
assert.match(src, /\(headers\?\.\["x-ponytail-mode"\] \|\| ""\) \|\| advised \|\| PONYTAIL_DEFAULT/, "header first, advice second, default last");
console.log("PASS");
