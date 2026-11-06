// #1543 Claude token usage per UTC day x model, for the SuperIntel Cost page (Daily / Monthly tables) and the SuperApp badge.
//  - Posted by ai-usage-post.sh `tokens` (cloudy-u-linux da_my-ai) from the `my-ai usage --daemon` snapshot: its `daily`
//    rows carry the transcript usage fields (input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens)
//    summed per message.model and UTC day, plus the cost priced on the host.
//  - Each host posts its own full window. A restarted daemon skips transcripts untouched for 24 h, so a later post can
//    under-report older days: the merge keeps the per-field MAX per (host, day, model), never a sum of posts. Hosts are summed.
//  - The model catalogue (claude-models.json) is read at runtime and served with the view.
// Erasable TypeScript only: the tests run this file with plain `node`.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Tok { input: number; output: number; cache_write: number; cache_read: number; cost: number }
export interface TokRow extends Tok { date: string; model: string }
export interface TokSample { source: string; host: string; observed_at: number; days: TokRow[] }
export interface TokStore { hosts: Record<string, { updated_at: number; rows: Record<string, Tok> }> }
export interface Family { id: string; label: string; match: string }
export interface Catalogue { families: Family[]; models: { id: string; family: string; label: string; price?: Record<string, number> }[] }

export const MAX_ROWS = 400;
export const KEEP_DAYS = 400;
export const MAX_HOSTS = 16;
export const VIEW_DAYS = 31;
const FIELDS = ["input", "output", "cache_write", "cache_read"] as const;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const validDate = (d: unknown): d is string => {
  if (typeof d !== "string") return false;
  const m = DATE.exec(d); if (!m) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};
const isCount = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e13;

/** Validate a POST /ai/usage/claude/tokens body. Unknown keys are ignored; any bad row rejects the body. */
export function validateTokensBody(body: unknown, now: number): { ok: true; sample: TokSample } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const o = body as Record<string, unknown>;
  const source = typeof o.source === "string" && /^[a-z0-9._-]{1,32}$/i.test(o.source) ? o.source : undefined;
  if (!source) errors.push("source is required (1..32 chars of [a-z0-9._-])");
  const host = o.host === undefined ? "unknown" : (typeof o.host === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(o.host) ? o.host : undefined);
  if (!host) errors.push("host must be 1..40 chars of [A-Za-z0-9._-]");
  let observed = now;
  if (o.observed_at !== undefined) {
    const t = o.observed_at;
    if (typeof t !== "number" || !Number.isInteger(t) || t > now + 300 || t < now - 86_400) errors.push("observed_at must be epoch seconds within the last day");
    else observed = t;
  }
  const days: TokRow[] = [];
  if (!Array.isArray(o.days) || o.days.length === 0 || o.days.length > MAX_ROWS) errors.push(`days must be an array of 1..${MAX_ROWS} rows`);
  else o.days.forEach((r, i) => {
    const x = r as Record<string, unknown>;
    if (typeof r !== "object" || r === null || Array.isArray(r)) { errors.push(`days[${i}] must be an object`); return; }
    if (!validDate(x.date)) errors.push(`days[${i}].date must be YYYY-MM-DD`);
    if (typeof x.model !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(x.model)) errors.push(`days[${i}].model must be a model id`);
    for (const k of FIELDS) if (!isCount(x[k] ?? 0)) errors.push(`days[${i}].${k} must be a token count`);
    const c = x.cost ?? 0;
    if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1e6) errors.push(`days[${i}].cost must be USD 0..1e6`);
    if (!errors.length) days.push({ date: x.date as string, model: x.model as string, input: (x.input ?? 0) as number, output: (x.output ?? 0) as number,
      cache_write: (x.cache_write ?? 0) as number, cache_read: (x.cache_read ?? 0) as number, cost: c as number });
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, sample: { source: source as string, host: host as string, observed_at: observed, days } };
}

export function emptyTokStore(): TokStore { return { hosts: {} }; }

const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
const minusDays = (sec: number, n: number) => dayOf(sec - n * 86_400);

/** Fold one host's post in: per (day, model) every field keeps the max seen; old days and surplus hosts are pruned. */
export function applyTokens(store: TokStore, s: TokSample, now: number): TokStore {
  const hosts: TokStore["hosts"] = {};
  for (const [h, v] of Object.entries(store.hosts ?? {})) hosts[h] = { updated_at: v.updated_at, rows: { ...v.rows } };
  const cur = hosts[s.host] ?? { updated_at: 0, rows: {} };
  for (const r of s.days) {
    const k = `${r.date}|${r.model}`, p = cur.rows[k];
    cur.rows[k] = p ? { input: Math.max(p.input, r.input), output: Math.max(p.output, r.output), cache_write: Math.max(p.cache_write, r.cache_write),
      cache_read: Math.max(p.cache_read, r.cache_read), cost: Math.max(p.cost, r.cost) }
      : { input: r.input, output: r.output, cache_write: r.cache_write, cache_read: r.cache_read, cost: r.cost };
  }
  cur.updated_at = Math.max(cur.updated_at, s.observed_at);
  hosts[s.host] = cur;
  const oldest = minusDays(now, KEEP_DAYS);
  for (const v of Object.values(hosts)) for (const k of Object.keys(v.rows)) if (k.slice(0, 10) < oldest) delete v.rows[k];
  const keep = Object.entries(hosts).sort((a, b) => b[1].updated_at - a[1].updated_at).slice(0, MAX_HOSTS);
  return { hosts: Object.fromEntries(keep) };
}

export function loadTokStore(dir: string): TokStore {
  try { const o = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8")); return o && typeof o.hosts === "object" ? o : emptyTokStore(); } catch { return emptyTokStore(); }
}
export function saveTokStore(dir: string, st: TokStore): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, "tokens.json.tmp");
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, join(dir, "tokens.json"));
}

let catCache: Catalogue | null = null;
/** The runtime catalogue (claude-models.json next to this file); an unreadable file yields an empty one, never a crash. */
export function loadCatalogue(path: string = new URL("./claude-models.json", import.meta.url).pathname): Catalogue {
  if (catCache) return catCache;
  try { const o = JSON.parse(readFileSync(path, "utf8")); catCache = { families: o.families ?? [], models: o.models ?? [] }; }
  catch { catCache = { families: [], models: [] }; }
  return catCache;
}

export function familyOf(model: string, cat: Catalogue): string {
  const exact = cat.models.find((m) => m.id === model);
  if (exact) return exact.family;
  return cat.families.find((f) => model.startsWith(f.match))?.id ?? "other";
}

const zero = (): Tok => ({ input: 0, output: 0, cache_write: 0, cache_read: 0, cost: 0 });
const add = (a: Tok, b: Tok) => { a.input += b.input; a.output += b.output; a.cache_write += b.cache_write; a.cache_read += b.cache_read; a.cost += b.cost; };
const out = (t: Tok) => ({ input: t.input, output: t.output, cache_write: t.cache_write, cache_read: t.cache_read,
  total: t.input + t.output + t.cache_write + t.cache_read, cost_usd: Math.round(t.cost * 1e4) / 1e4 });

/** Periods (day or month) newest first, each with its total and per-family child rows in catalogue order. */
function periods(byKey: Map<string, Map<string, Tok>>, cat: Catalogue) {
  const order = [...cat.families.map((f) => f.id), "other"];
  const label = (id: string) => cat.families.find((f) => f.id === id)?.label ?? "Other";
  return [...byKey.keys()].sort().reverse().map((k) => {
    const fam = byKey.get(k)!; const tot = zero();
    for (const t of fam.values()) add(tot, t);
    const models = order.filter((id) => fam.has(id)).map((id) => ({ family: id, label: label(id), ...out(fam.get(id)!) }));
    return { period: k, ...out(tot), models };
  });
}

/** The public view: hosts summed, grouped by family; days = the last VIEW_DAYS UTC days, months = every month kept. */
export function tokensView(st: TokStore, now: number, cat: Catalogue = loadCatalogue()) {
  const hosts = Object.entries(st.hosts ?? {});
  if (!hosts.length) return null;
  const days = new Map<string, Map<string, Tok>>(), months = new Map<string, Map<string, Tok>>();
  const firstDay = minusDays(now, VIEW_DAYS - 1);
  const put = (m: Map<string, Map<string, Tok>>, k: string, f: string, t: Tok) => {
    if (!m.has(k)) m.set(k, new Map()); const g = m.get(k)!; if (!g.has(f)) g.set(f, zero()); add(g.get(f)!, t);
  };
  for (const [, v] of hosts) for (const [k, t] of Object.entries(v.rows)) {
    const date = k.slice(0, 10), fam = familyOf(k.slice(11), cat);
    if (date >= firstDay) put(days, date, fam, t);
    put(months, date.slice(0, 7), fam, t);
  }
  const updated = Math.max(...hosts.map(([, v]) => v.updated_at));
  return { updated_at: updated, age_s: Math.max(0, now - updated), basis: "UTC days; per host the max reported per day and model, hosts summed",
    hosts: hosts.map(([h, v]) => ({ host: h, updated_at: v.updated_at })),
    families: cat.families.map(({ id, label }) => ({ id, label })), models: cat.models,
    days: periods(days, cat), months: periods(months, cat) };
}
