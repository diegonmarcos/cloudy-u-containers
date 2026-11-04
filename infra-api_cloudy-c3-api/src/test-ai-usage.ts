// #1151 AI usage: schema validation, auth required, store/history, stale-window drop, OpenRouter parsing (fixtures) and cache.
// Usage: node test-ai-usage.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySample, claudeView, emptyStore, getOpenRouter, loadStore, parseOpenRouter, resetOpenRouterCache, saveStore, validateClaudeBody, HISTORY_MAX } from "./code/shared/libs/ai-usage.ts";
import { isAllowed } from "./code/shared/libs/auth-decision.ts";

const NOW = 1_790_000_000; // 2026-09-21T... epoch s
const ok = (b: unknown) => { const r = validateClaudeBody(b, NOW); assert.ok(r.ok, JSON.stringify(r)); return r.ok ? r.sample : (null as never); };
const bad = (b: unknown, re: RegExp) => { const r = validateClaudeBody(b, NOW); assert.ok(!r.ok, "should be rejected"); assert.match(JSON.stringify(r.ok ? [] : r.errors), re); };

// ── schema ──
const w5 = { used_percentage: 23.5, resets_at: NOW + 3600 }, w7 = { used_percentage: 41.2, resets_at: NOW + 86400 };
ok({ source: "statusline", five_hour: w5, seven_day: w7, host: "laptop" });
ok({ source: "cloud-hook", rate_limited: true });
bad(null, /JSON object/); bad([], /JSON object/); bad({}, /source/);
bad({ source: "x y" }, /source/); bad({ source: "s" }, /need five_hour/);
bad({ source: "s", five_hour: { used_percentage: 101, resets_at: NOW + 1 } }, /0\.\.100/);
bad({ source: "s", five_hour: { used_percentage: "5", resets_at: NOW + 1 } }, /0\.\.100/);
bad({ source: "s", seven_day: { used_percentage: 5, resets_at: 12 } }, /epoch seconds/);
bad({ source: "s", five_hour: "no" }, /object/); bad({ source: "s", rate_limited: "yes" }, /boolean/);
bad({ source: "s", five_hour: w5, observed_at: NOW + 99999 }, /observed_at/);
bad({ source: "s", five_hour: w5, host: "x".repeat(200) }, /host/);
assert.equal(ok({ source: "s", five_hour: w5, extra: "dropped" }).hasOwnProperty("extra"), false, "unknown keys are not stored");

// ── store, history bound, stale window ──
let st = emptyStore();
st = applySample(st, ok({ source: "statusline", five_hour: w5, seven_day: w7 }));
st = applySample(st, ok({ source: "cloud-hook", rate_limited: true }));
assert.equal(st.five_hour?.used_percentage, 23.5, "a rate_limited-only sample keeps the percentages");
assert.equal(st.rate_limited_at, NOW);
for (let i = 1; i <= 200; i++) st = applySample(st, ok({ source: "s", five_hour: { used_percentage: i % 100, resets_at: NOW + 3600 }, observed_at: NOW - 80_000 + i * 400 }));
assert.ok(st.history.length <= HISTORY_MAX, "history is bounded");
const older = applySample(st, ok({ source: "s", five_hour: { used_percentage: 1, resets_at: NOW + 3600 }, observed_at: NOW - 86_000 }));
assert.equal(older.five_hour?.observed_at, st.five_hour?.observed_at, "an older sample never replaces a newer window");
const v = claudeView(st, NOW)!;
assert.equal(v.seven_day?.used_percentage, 41.2);
assert.equal(claudeView(st, NOW + 7200)!.five_hour, null, "a window past its reset is dropped");
assert.equal(claudeView(emptyStore(), NOW), null);
const dir = mkdtempSync(join(tmpdir(), "aiu-"));
saveStore(dir, st); assert.equal(loadStore(dir).seven_day?.used_percentage, 41.2); rmSync(join(dir, "claude.json")); rmSync(dir, { recursive: true });
assert.deepEqual(loadStore(join(dir, "missing")), emptyStore(), "a missing store is empty, not an error");

// ── auth required ──
const pub = "203.0.113.9";
assert.equal(isAllowed("/ai/usage", pub, {}), false, "GET /ai/usage unauthenticated off-mesh -> 401");
assert.equal(isAllowed("/ai/usage/claude", pub, {}), false, "POST /ai/usage/claude unauthenticated off-mesh -> 401");
assert.equal(isAllowed("/ai/usage/claude", pub, { "x-auth-user": "ft_token" }), true, "bearer verified by Caddy passes");
assert.equal(isAllowed("/ai/usage", "10.0.0.5", {}), true, "mesh passes");
assert.equal(isAllowed("/health", pub, {}), true);
const authSrc = readFileSync(new URL("./code/api/plugins/auth.ts", import.meta.url), "utf8");
assert.match(authSrc, /isAllowed\(req\.url, req\.ip, req\.headers\)/, "the auth plugin uses the tested decision");
const app = readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8");
assert.match(app, /registerAiUsageRoutes\)/, "the AI routes are registered");
const route = readFileSync(new URL("./code/api/routes/aiUsage.ts", import.meta.url), "utf8");
assert.match(route, /"\/ai\/usage\/claude"/); assert.match(route, /"\/ai\/usage"/);

// ── OpenRouter fixtures: /credits and /activity (daily rows, completed UTC days) ──
const NOWMS = Date.parse("2026-10-24T12:00:00Z");
const credits = { data: { total_credits: 50, total_usage: 12.345678 } };
const row = (date: string, usage: number, p: number, c: number) => ({ date, model: "m", model_permaslug: "m", endpoint_id: "e", provider_name: "p", usage, byok_usage_inference: 0, requests: 1, prompt_tokens: p, completion_tokens: c, reasoning_tokens: 0, cached_tokens: 0 });
const activity = { data: [
  row("2026-10-23", 1.5, 1_000_000, 500_000), row("2026-10-23", 0.5, 500_000, 0), // yesterday: two models
  row("2026-10-20", 2, 2_000_000, 0), row("2026-10-17", 3, 1_000_000, 1_000_000), // 7d edge: 17 is inside (>= 10-17)
  row("2026-10-10", 4, 4_000_000, 0), row("2026-09-30", 9, 9_000_000, 0), // October vs September
  row("2026-10-24", 99, 99_000_000, 0), // today partial: excluded
] };
const s = parseOpenRouter(credits, activity, NOWMS);
assert.equal(s.balance_usd, 37.654322);
assert.deepEqual(s.last_24h, { usd: 2, tokens: 2_000_000 });
assert.deepEqual(s.last_7d, { usd: 7, tokens: 6_000_000 });
assert.deepEqual(s.month, { usd: 11, tokens: 10_000_000 });
assert.equal(s.through_date, "2026-10-23");
assert.throws(() => parseOpenRouter({ data: {} }, activity, NOWMS), /credits/);
assert.throws(() => parseOpenRouter(credits, { data: "x" }, NOWMS), /activity/);
assert.deepEqual(parseOpenRouter(credits, { data: [] }, NOWMS).last_24h, { usd: 0, tokens: 0 });

// ── fetch, cache, no key, failure ──
resetOpenRouterCache();
assert.equal((await getOpenRouter({}, (async () => { throw new Error("must not fetch"); }) as any, NOWMS) as any).configured, false, "no key -> declared slot, not a failure");
let calls = 0; const seen: string[] = [];
const f = (async (u: string, init: any) => { calls++; seen.push(u + "|" + (init.headers.Authorization ? "auth" : "noauth")); return { ok: true, json: async () => (u.endsWith("/credits") ? credits : activity) }; }) as any;
const a = await getOpenRouter({ OPENROUTER_MANAGEMENT_KEY: "k" }, f, NOWMS) as any;
assert.equal(a.configured, true); assert.equal(a.balance_usd, 37.654322); assert.equal(calls, 2);
assert.deepEqual(seen.sort(), ["https://openrouter.ai/api/v1/activity|auth", "https://openrouter.ai/api/v1/credits|auth"]);
await getOpenRouter({ OPENROUTER_MANAGEMENT_KEY: "k" }, f, NOWMS + 4 * 60_000); assert.equal(calls, 2, "cached for 5 minutes");
await getOpenRouter({ OPENROUTER_MANAGEMENT_KEY: "k" }, f, NOWMS + 6 * 60_000); assert.equal(calls, 4, "refetched after the TTL");
const down = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
const e = await getOpenRouter({ OPENROUTER_MANAGEMENT_KEY: "k" }, down, NOWMS + 20 * 60_000) as any;
assert.match(e.error, /503/); assert.equal(e.stale, true); assert.equal(e.balance_usd, 37.654322, "a failure serves the last good data, flagged stale");
assert.ok(!JSON.stringify(e).includes('"k"'), "the key never appears in a response");
console.log("PASS");
