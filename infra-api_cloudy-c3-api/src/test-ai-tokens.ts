// #1543 Claude tokens per UTC day x model: schema, per-field max merge per host, hosts summed, families from the runtime catalogue.
// Usage: node test-ai-tokens.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTokens, emptyTokStore, familyOf, loadCatalogue, loadTokStore, saveTokStore, tokensView, validateTokensBody, MAX_ROWS } from "./code/shared/libs/ai-tokens.ts";

const NOW = Math.floor(Date.UTC(2026, 10, 6, 12) / 1000); // 2026-11-06T12:00Z
const row = (date: string, model: string, n: number, cost = n / 1000) => ({ date, model, input: n, output: 2 * n, cache_write: 3 * n, cache_read: 4 * n, cost });
const ok = (b: unknown) => { const r = validateTokensBody(b, NOW); assert.ok(r.ok, JSON.stringify(r)); return r.ok ? r.sample : (null as never); };
const bad = (b: unknown, re: RegExp) => { const r = validateTokensBody(b, NOW); assert.ok(!r.ok, "should be rejected: " + JSON.stringify(b)); assert.match(JSON.stringify(r.ok ? [] : r.errors), re); };

// ── catalogue: the four Claude 5 models, read at runtime ──
const cat = loadCatalogue();
assert.deepEqual(cat.families.map((f) => f.label), ["Haiku", "Sonnet", "Opus", "Fable"]);
for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) assert.ok(cat.models.some((m) => m.id === id), id);
assert.equal(familyOf("claude-fable-5-1", cat), "fable"); assert.equal(familyOf("claude-opus-4-8", cat), "opus");
assert.equal(familyOf("claude-sonnet-5-5-20261001", cat), "sonnet"); assert.equal(familyOf("<synthetic>", cat), "other");

// ── schema ──
ok({ source: "statusline", host: "laptop", days: [row("2026-11-05", "claude-opus-5-5", 10)] });
bad(null, /JSON object/); bad({ source: "s", days: [] }, /1\.\.400/); bad({ source: "s" }, /days/);
bad({ source: "s", days: Array(MAX_ROWS + 1).fill(row("2026-11-05", "m", 1)) }, /1\.\.400/);
bad({ source: "s", days: [row("2026-02-30", "m", 1)] }, /YYYY-MM-DD/);
bad({ source: "s", days: [row("2026-11-05", "x\"y", 1)] }, /model/);
bad({ source: "s", days: [{ ...row("2026-11-05", "m", 1), input: -1 }] }, /token count/);
bad({ source: "s", days: [{ ...row("2026-11-05", "m", 1), output: 1.5 }] }, /token count/);
bad({ source: "s", days: [{ ...row("2026-11-05", "m", 1), cost: "1" }] }, /USD/);
bad({ source: "s", host: "a b", days: [row("2026-11-05", "m", 1)] }, /host/);
assert.equal(ok({ source: "s", days: [row("2026-11-05", "m", 1)] }).host, "unknown");

// ── merge: same host keeps the per-field max (a restarted daemon under-reports), hosts are summed ──
let st = emptyTokStore();
st = applyTokens(st, ok({ source: "s", host: "laptop", days: [row("2026-11-05", "claude-opus-5-5", 100), row("2026-11-06", "claude-haiku-5-5", 10)] }), NOW);
st = applyTokens(st, ok({ source: "s", host: "laptop", days: [row("2026-11-05", "claude-opus-5-5", 40)] }), NOW);           // restart: lower, ignored
st = applyTokens(st, ok({ source: "s", host: "laptop", days: [row("2026-11-06", "claude-haiku-5-5", 25)] }), NOW);          // grew today
st = applyTokens(st, ok({ source: "s", host: "termux", days: [row("2026-11-05", "claude-opus-5-5", 1), row("2026-11-05", "claude-fable-5-1", 5)] }), NOW);
st = applyTokens(st, ok({ source: "s", host: "old", days: [row("2025-01-01", "claude-opus-4-1", 7)] }), NOW);              // older than KEEP_DAYS: pruned
const v = tokensView(st, NOW)!;
assert.deepEqual(v.days.map((d) => d.period), ["2026-11-06", "2026-11-05"], "newest first, the pruned year absent");
const d5 = v.days[1];
assert.equal(d5.input, 106); assert.equal(d5.output, 212); assert.equal(d5.cache_write, 318); assert.equal(d5.cache_read, 424);
assert.equal(d5.total, 106 * 10); assert.equal(d5.cost_usd, 0.106);
assert.deepEqual(d5.models.map((m) => [m.label, m.input]), [["Opus", 101], ["Fable", 5]], "family rows in catalogue order");
assert.equal(v.days[0].input, 25, "today's growth replaced the earlier reading");
assert.deepEqual(v.months.map((m) => [m.period, m.input]), [["2026-11", 131]]);
assert.deepEqual(v.families.map((f) => f.id), ["haiku", "sonnet", "opus", "fable"]);
assert.equal(tokensView(emptyTokStore(), NOW), null);

// ── store round trip ──
const dir = mkdtempSync(join(tmpdir(), "ai-tokens-"));
try { saveTokStore(dir, st); assert.deepEqual(loadTokStore(dir), st); assert.deepEqual(loadTokStore(join(dir, "none")), emptyTokStore()); }
finally { rmSync(dir, { recursive: true, force: true }); }
console.log("PASS");
