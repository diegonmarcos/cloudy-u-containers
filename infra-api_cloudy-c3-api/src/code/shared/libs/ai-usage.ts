// AI usage for the Cloud SuperApp Notify > Resources card (ticket #1151).
//  - Claude: pushed by Claude Code (statusLine poster on laptop/Termux; StopFailure hook in cloud sessions) to
//    POST /ai/usage/claude. Hooks do NOT carry rate_limits (only the statusLine JSON does), so cloud sessions can
//    only report "rate limited now"; the percentages come from the statusLine path.
//  - OpenRouter: fetched here with a management key (GET /credits and GET /activity need one). Slot: env
//    OPENROUTER_MANAGEMENT_KEY (falls back to OPENROUTER_API_KEY), sops-encrypted in the c3-infra-api secrets.
// Erasable TypeScript only: the tests run this file with plain `node`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Window { used_percentage: number; resets_at: number }
export interface ClaudeSample { source: string; host?: string; session_id?: string; model?: string;
  five_hour?: Window; seven_day?: Window; rate_limited?: boolean; observed_at: number }
export interface ClaudeHistoryPoint { ts: number; five_hour: number | null; seven_day: number | null }
export interface ClaudeStore { latest: ClaudeSample | null; five_hour: (Window & { observed_at: number }) | null;
  seven_day: (Window & { observed_at: number }) | null; rate_limited_at: number | null; history: ClaudeHistoryPoint[] }

export const HISTORY_MAX = 48;
export const HISTORY_MIN_GAP_S = 300;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;

function parseWindow(name: string, v: unknown, errors: string[]): Window | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) { errors.push(`${name} must be an object`); return undefined; }
  const o = v as Record<string, unknown>;
  const p = o.used_percentage, r = o.resets_at;
  if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) errors.push(`${name}.used_percentage must be a number 0..100`);
  if (typeof r !== "number" || !Number.isInteger(r) || r < 1_000_000_000 || r > 4_000_000_000) errors.push(`${name}.resets_at must be epoch seconds`);
  return errors.length ? undefined : { used_percentage: p as number, resets_at: r as number };
}

/** Validate a POST /ai/usage/claude body. Never trusts shape; unknown keys are ignored, bad known keys are errors. */
export function validateClaudeBody(body: unknown, now: number): { ok: true; sample: ClaudeSample } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const o = body as Record<string, unknown>;
  const source = str(o.source, 32);
  if (!source || !/^[a-z0-9._-]+$/i.test(source)) errors.push("source is required (1..32 chars of [a-z0-9._-])");
  for (const k of ["host", "session_id", "model"]) if (o[k] !== undefined && !str(o[k], 96)) errors.push(`${k} must be a string up to 96 chars`);
  if (o.rate_limited !== undefined && typeof o.rate_limited !== "boolean") errors.push("rate_limited must be a boolean");
  const five = parseWindow("five_hour", o.five_hour, errors);
  const seven = parseWindow("seven_day", o.seven_day, errors);
  if (!five && !seven && o.rate_limited !== true && !errors.length) errors.push("need five_hour, seven_day or rate_limited=true");
  let observed = now;
  if (o.observed_at !== undefined) {
    const t = o.observed_at;
    if (typeof t !== "number" || !Number.isInteger(t) || t > now + 300 || t < now - 86_400) errors.push("observed_at must be epoch seconds within the last day");
    else observed = t;
  }
  if (errors.length) return { ok: false, errors };
  const sample: ClaudeSample = { source: source as string, observed_at: observed };
  for (const k of ["host", "session_id", "model"] as const) if (typeof o[k] === "string") sample[k] = o[k] as string;
  if (five) sample.five_hour = five;
  if (seven) sample.seven_day = seven;
  if (o.rate_limited === true) sample.rate_limited = true;
  return { ok: true, sample };
}

export function emptyStore(): ClaudeStore {
  return { latest: null, five_hour: null, seven_day: null, rate_limited_at: null, history: [] };
}

/** Fold one sample in: newest observation wins per window; history keeps a point per 5 min or on change. */
export function applySample(store: ClaudeStore, s: ClaudeSample): ClaudeStore {
  const n: ClaudeStore = { ...store, history: store.history.slice() };
  n.latest = s;
  if (s.five_hour && (!n.five_hour || s.observed_at >= n.five_hour.observed_at)) n.five_hour = { ...s.five_hour, observed_at: s.observed_at };
  if (s.seven_day && (!n.seven_day || s.observed_at >= n.seven_day.observed_at)) n.seven_day = { ...s.seven_day, observed_at: s.observed_at };
  if (s.rate_limited) n.rate_limited_at = s.observed_at;
  if (s.five_hour || s.seven_day) {
    const pt: ClaudeHistoryPoint = { ts: s.observed_at, five_hour: n.five_hour?.used_percentage ?? null, seven_day: n.seven_day?.used_percentage ?? null };
    const last = n.history[n.history.length - 1];
    const changed = !last || last.five_hour !== pt.five_hour || last.seven_day !== pt.seven_day;
    if (!last || (changed && pt.ts - last.ts >= 60) || pt.ts - last.ts >= HISTORY_MIN_GAP_S) n.history.push(pt);
    if (n.history.length > HISTORY_MAX) n.history = n.history.slice(-HISTORY_MAX);
  }
  return n;
}

export function loadStore(dir: string): ClaudeStore {
  try { return { ...emptyStore(), ...JSON.parse(readFileSync(join(dir, "claude.json"), "utf8")) }; } catch { return emptyStore(); }
}
export function saveStore(dir: string, st: ClaudeStore): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "claude.json.tmp");
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, join(dir, "claude.json"));
}

/** Public view: a window whose reset time has passed is dropped (its percentage no longer applies). */
export function claudeView(st: ClaudeStore, now: number) {
  if (!st.latest) return null;
  const win = (w: ClaudeStore["five_hour"]) => (w && w.resets_at > now ? { used_percentage: w.used_percentage, resets_at: w.resets_at, observed_at: w.observed_at } : null);
  const newest = Math.max(st.five_hour?.observed_at ?? 0, st.seven_day?.observed_at ?? 0, st.rate_limited_at ?? 0, st.latest.observed_at);
  return { updated_at: newest, age_s: Math.max(0, now - newest), source: st.latest.source, host: st.latest.host ?? null,
    five_hour: win(st.five_hour), seven_day: win(st.seven_day), rate_limited_at: st.rate_limited_at, history: st.history };
}

// ── OpenRouter ──────────────────────────────────────────────────────────────
export interface OrActivityRow { date: string; usage: number; prompt_tokens: number; completion_tokens: number }
export interface OrWindow { usd: number; tokens: number }
export interface OrSummary { balance_usd: number; total_credits_usd: number; total_usage_usd: number;
  last_24h: OrWindow; last_7d: OrWindow; month: OrWindow; through_date: string | null; basis: string }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Parse /credits + /activity. /activity is DAILY and covers completed UTC days only, so "24h" is the latest completed day. */
export function parseOpenRouter(credits: unknown, activity: unknown, nowMs: number): OrSummary {
  const c = (credits as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
  if (!c || typeof c.total_credits !== "number" || typeof c.total_usage !== "number") throw new Error("openrouter credits: unexpected shape");
  const rowsRaw = (activity as { data?: unknown } | null)?.data;
  if (!Array.isArray(rowsRaw)) throw new Error("openrouter activity: unexpected shape");
  const rows: OrActivityRow[] = rowsRaw.filter((r) => r && typeof r.date === "string").map((r) => ({
    date: String(r.date).slice(0, 10), usage: num(r.usage) + num(r.byok_usage_inference),
    prompt_tokens: num(r.prompt_tokens), completion_tokens: num(r.completion_tokens) }));
  const today = iso(nowMs);
  const done = rows.filter((r) => r.date < today);
  const days = Array.from(new Set(done.map((r) => r.date))).sort();
  const through = days.length ? days[days.length - 1] : null;
  const sum = (pred: (d: string) => boolean): OrWindow => {
    let usd = 0, tokens = 0;
    for (const r of done) if (pred(r.date)) { usd += r.usage; tokens += r.prompt_tokens + r.completion_tokens; }
    return { usd: Math.round(usd * 1e6) / 1e6, tokens };
  };
  const d7 = iso(nowMs - 7 * 86_400_000), month = today.slice(0, 7);
  return { balance_usd: Math.round((c.total_credits - c.total_usage) * 1e6) / 1e6, total_credits_usd: c.total_credits, total_usage_usd: c.total_usage,
    last_24h: sum((d) => d === (iso(nowMs - 86_400_000))), last_7d: sum((d) => d >= d7), month: sum((d) => d.startsWith(month)),
    through_date: through, basis: "activity is daily, completed UTC days only: last_24h = yesterday, last_7d = previous 7 days, month = days so far excluding today" };
}

export const OR_TTL_MS = 5 * 60_000;
let orCache: { at: number; value: unknown } | null = null;
export function resetOpenRouterCache(): void { orCache = null; }

export async function getOpenRouter(env: Record<string, string | undefined>, fetchFn: typeof fetch, nowMs: number) {
  const key = env.OPENROUTER_MANAGEMENT_KEY || env.OPENROUTER_API_KEY;
  if (!key) return { configured: false, error: "OPENROUTER_MANAGEMENT_KEY not set (owner must add it to the c3-infra-api secrets)" };
  if (orCache && nowMs - orCache.at < OR_TTL_MS) return orCache.value;
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  const get = async (p: string) => {
    const r = await fetchFn(`https://openrouter.ai/api/v1${p}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`openrouter ${p} HTTP ${r.status}`);
    return r.json();
  };
  try {
    const [credits, activity] = await Promise.all([get("/credits"), get("/activity")]);
    const value = { configured: true, fetched_at: Math.floor(nowMs / 1000), ...parseOpenRouter(credits, activity, nowMs) };
    orCache = { at: nowMs, value };
    return value;
  } catch (e) {
    const prev = orCache?.value as Record<string, unknown> | undefined;
    return { ...(prev ?? { configured: true }), error: (e as Error).message, stale: !!prev };
  }
}
