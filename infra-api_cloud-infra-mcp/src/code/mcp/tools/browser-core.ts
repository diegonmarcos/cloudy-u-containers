// browser.* pure core (#1498, #1540): backend routing, secrets by env name, the request shape, bot-wall detection, the cloudflare backend and
// the auto fallback. No relative imports (one file), so the dependency-free tester (node --experimental-strip-types test-browser-tools.mjs) runs it.
import { readFileSync, writeFileSync } from "node:fs";
export type Backend = "phone" | "container" | "cloudflare" | "auto";

export const DEFAULT_CONTAINER_URL = "http://10.0.0.6:3118";

export interface Target { url: string; bearer: string }

/** Where a call goes. Throws a clear message when the backend is not configured. */
export function target(backend: "phone" | "container", kind: "command" | "run", env: Record<string, string | undefined> = process.env): Target {
  if (backend === "phone") {
    const base = (env.C3_PHONE_MESH_URL ?? "").replace(/\/+$/, "");
    const bearer = env.C3_PHONE_FLEET_TOKEN ?? "";
    if (!base || !bearer) throw new Error("phone backend not configured (C3_PHONE_MESH_URL, C3_PHONE_FLEET_TOKEN)");
    return { url: `${base}/browser/${kind}`, bearer };
  }
  // Default = the container's mesh listener (build.json cloudy-browser-headless: ports.app 3118 on oci-apps, WG IP 10.0.0.6; this MCP
  // runs on the same host). C3_BROWSER_URL overrides it (for example the public Caddy path with a bearer). Not a secret.
  const base = (env.C3_BROWSER_URL || DEFAULT_CONTAINER_URL).replace(/\/+$/, "");
  const bearer = env.C3_BROWSER_TOKEN ?? "";
  if (!base || !bearer) throw new Error("container backend not configured (C3_BROWSER_TOKEN)");
  return { url: `${base}/${kind}`, bearer };
}

export async function call(backend: "phone" | "container", kind: "command" | "run", body: unknown, f: typeof fetch = fetch, env = process.env): Promise<unknown> {
  const t = target(backend, kind, env);
  const r = await f(t.url, { method: "POST", headers: { authorization: `Bearer ${t.bearer}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: { code: "internal", message: `HTTP ${r.status}` } }; }
}

/** browser.read: open + readable in one call, the default tool agents use to get a page as data. */
export async function readUrl(args: any, f: typeof fetch = fetch, env = process.env): Promise<any> {
  const { backend, url, profile, format, maxChars, cursor, session, agent, timeoutMs } = args;
  const common2 = { ...(agent ? { agent } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  // A continuation (cursor + session) re-reads the already open page; a fresh read opens the URL first.
  const steps: any[] = cursor && session
    ? [{ cmd: "readable", session, format, maxChars, cursor, ...common2 }]
    : [{ cmd: "open", url, ...(profile ? { profile } : {}), ...(session ? { session } : {}), ...common2 }, { cmd: "readable", format, maxChars, ...common2 }];
  const r: any = await call(backend, "run", { ...(session ? { session } : {}), steps }, f, env);
  const last = r?.steps?.[r.steps.length - 1];
  if (r?.ok === false || !last?.ok) return { ok: false, error: last?.error ?? r?.error ?? { code: "internal", message: "read failed" } };
  const x = last.result ?? {};
  return { ok: true, session: r.session, url: x.url, title: x.title, format: x.format, content: x.content, truncated: !!x.truncated, ...(x.next ? { next: x.next } : {}) };
}


// ───────────────────────── bot-wall detection ─────────────────────────
export interface WallSignals {
  status?: number;                    // HTTP status of the main navigation, when known
  cfMitigated?: string;               // value of the cf-mitigated response header, when present
  headers?: Record<string, string>;   // lower-cased response headers, optional
  url?: string;                       // final URL after redirects
  title?: string;
  text?: string;                      // visible text (any length; only the head is inspected)
  bodyLen?: number;                   // length of the visible text, when `text` is a cut
  marker?: boolean;                   // the HTML carries cf-challenge / cf-turnstile / challenge-platform
}

/** Strong titles: a page that is itself the challenge. */
export const TITLE_RE = /just a moment|performing security verification|attention required|access denied|verify you are human|are you a robot|captcha|security check|checking your browser/i;
/** Weaker body markers: only trusted when the page is short (a real article may mention a captcha). */
export const TEXT_RE = /performing security verification|verify you are human|verifying you are human|checking (if the site connection is secure|your browser)|enable javascript and cookies to continue|captcha|access denied|attention required|just a moment/i;
export const CHALLENGE_URL_RE = /\/cdn-cgi\/challenge-platform|challenge_redirect|[?&]__cf_chl_/i;
export const SHORT_BODY = 2500;
const WALL_STATUS = new Set([403, 429, 503]);

/** The reason string when the signals describe a bot wall, else null. */
export function detectBotWall(s: WallSignals): string | null {
  const mitigated = s.cfMitigated ?? s.headers?.["cf-mitigated"];
  if (mitigated) return `cf-mitigated:${mitigated}`;
  const len = s.bodyLen ?? (s.text ?? "").trim().length;
  const head = (s.text ?? "").slice(0, 4000);
  const status = s.status ?? 0;
  const titleHit = !!s.title && TITLE_RE.test(s.title);
  const textHit = TEXT_RE.test(head);
  if (s.url && CHALLENGE_URL_RE.test(s.url)) return len < 50 ? "challenge_redirect+empty_body" : "challenge_redirect";
  if (titleHit && (len < SHORT_BODY || WALL_STATUS.has(status) || /just a moment|security verification|attention required/i.test(s.title ?? ""))) return `challenge_title:${(s.title ?? "").slice(0, 60)}`;
  if (WALL_STATUS.has(status) && (s.marker || textHit || titleHit)) return `http_${status}+challenge`;
  if (len < 50 && s.marker) return "empty_body+challenge_marker";
  if (s.marker && textHit && len < SHORT_BODY) return "challenge_marker+text";
  if (textHit && len < SHORT_BODY && /verify you are human|performing security verification|just a moment|checking (if the site connection is secure|your browser)/i.test(head)) return "challenge_text";
  return null;
}

/** The in-page probe step (an `eval` js) whose result feeds detectBotWall. Works in the container and in the phone WebView. */
export const PROBE_JS = "({title:document.title,text:(document.body?document.body.innerText:'').slice(0,4000),bodyLen:(document.body?document.body.innerText:'').trim().length,marker:/cf-challenge|cf-turnstile|challenge-platform|challenge_redirect/.test(document.documentElement.outerHTML),url:location.href})";

// ───────────────────────── state: domain memory, daily cap, usage ─────────────────────────

export interface BrowserConfig {
  domainTtlMs: number;      // how long "needs cloudflare" is remembered per host
  cfDailyCap: number;       // max cloudflare calls per UTC day
  cfDailyUsdCap: number;    // max estimated cloudflare spend per UTC day (browser hours at the paid rate, upper bound)
  cfUsdPerHour: number;     // Browser Run price per browser hour beyond the free allowance
}
/** Declared defaults (build.json env_config browser_cf_daily_cap feeds C3_BROWSER_CF_DAILY_CAP). */
export const DEFAULT_CONFIG: BrowserConfig = { domainTtlMs: 24 * 3600_000, cfDailyCap: 200, cfDailyUsdCap: 1.0, cfUsdPerHour: 0.09 };

export function configFromEnv(env: Record<string, string | undefined> = process.env): BrowserConfig {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? n : d; };
  return {
    domainTtlMs: num(env.C3_BROWSER_DOMAIN_TTL_H, DEFAULT_CONFIG.domainTtlMs / 3600_000) * 3600_000,
    cfDailyCap: Math.floor(num(env.C3_BROWSER_CF_DAILY_CAP, DEFAULT_CONFIG.cfDailyCap)),
    cfDailyUsdCap: num(env.C3_BROWSER_CF_DAILY_USD_CAP, DEFAULT_CONFIG.cfDailyUsdCap),
    cfUsdPerHour: DEFAULT_CONFIG.cfUsdPerHour,
  };
}

export interface UsageEntry { ts: number; op: string; host: string; backend: string; status: number; ms: number; usd: number; reason?: string }
interface Persisted { domains: Record<string, number>; day: string; calls: number; usd: number }

export class BrowserState {
  domains = new Map<string, number>();
  day = "";
  calls = 0;
  usd = 0;
  log: UsageEntry[] = [];
  cfg: BrowserConfig;
  now: () => number;
  file?: string;
  constructor(cfg: BrowserConfig = DEFAULT_CONFIG, now: () => number = Date.now, file?: string) {
    this.cfg = cfg; this.now = now; this.file = file;
    if (file) this.load();
  }
  private today() { return new Date(this.now()).toISOString().slice(0, 10); }
  private roll() { const d = this.today(); if (d !== this.day) { this.day = d; this.calls = 0; this.usd = 0; } }
  needsCloudflare(host: string): boolean {
    const exp = this.domains.get(host);
    if (exp === undefined) return false;
    if (exp <= this.now()) { this.domains.delete(host); return false; }
    return true;
  }
  markNeedsCloudflare(host: string) { if (host) { this.domains.set(host, this.now() + this.cfg.domainTtlMs); this.save(); } }
  forget(host: string) { this.domains.delete(host); this.save(); }
  /** null when a cloudflare call may go out, else the reason it may not. */
  capReason(): string | null {
    this.roll();
    if (this.calls >= this.cfg.cfDailyCap) return `daily cloudflare cap reached (${this.calls}/${this.cfg.cfDailyCap} calls)`;
    if (this.usd >= this.cfg.cfDailyUsdCap) return `daily cloudflare spend cap reached (~$${this.usd.toFixed(4)}/$${this.cfg.cfDailyUsdCap})`;
    return null;
  }
  /** Record one cloudflare call: the cost estimate uses X-Browser-Ms-Used at the paid hourly rate (an upper bound; the free allowance is not subtracted). */
  record(e: Omit<UsageEntry, "ts" | "usd"> & { usd?: number }): UsageEntry {
    this.roll();
    const usd = e.usd ?? (e.backend === "cloudflare" ? (e.ms / 3600_000) * this.cfg.cfUsdPerHour : 0);
    const entry: UsageEntry = { ...e, ts: this.now(), usd };
    if (e.backend === "cloudflare") { this.calls++; this.usd += usd; }
    this.log.push(entry); if (this.log.length > 500) this.log.shift();
    this.save();
    return entry;
  }
  usage() { this.roll(); return { day: this.day, cloudflare_calls: this.calls, cloudflare_usd_est: Number(this.usd.toFixed(6)), cap_calls: this.cfg.cfDailyCap, cap_usd: this.cfg.cfDailyUsdCap, domains: [...this.domains.entries()].filter(([, e]) => e > this.now()).map(([h, e]) => ({ host: h, until: new Date(e).toISOString() })) }; }
  private load() {
    try {
      const p: Persisted = JSON.parse(readFileSync(this.file as string, "utf8"));
      for (const [h, e] of Object.entries(p.domains ?? {})) if (e > this.now()) this.domains.set(h, e);
      if (p.day === this.today()) { this.day = p.day; this.calls = p.calls | 0; this.usd = Number(p.usd) || 0; }
    } catch { /* first run or unreadable: start empty */ }
  }
  private save() {
    if (!this.file) return;
    try { writeFileSync(this.file, JSON.stringify({ domains: Object.fromEntries(this.domains), day: this.day, calls: this.calls, usd: this.usd } satisfies Persisted)); } catch { /* read-only fs: memory only */ }
  }
}

// ───────────────────────── gateway: backend auto, cloudflare backend, fallback on a bot wall ─────────────────────────
// One call = url + options. backend "auto" (default): container first; on a bot wall the SAME call goes to Cloudflare Browser Run
// (Cloudflare's own sanctioned rendering service, which identifies itself as a bot). Nothing here solves CAPTCHAs, spoofs a fingerprint
// or rotates a proxy; when Cloudflare is refused too the challenge result is returned honestly (bot_wall: true).
export type GwBackend = "auto" | "container" | "phone" | "cloudflare";
export type GwOp = "read" | "content" | "screenshot" | "pdf" | "links" | "scrape" | "json" | "snapshot" | "ocr";
export const GW_OPS: GwOp[] = ["read", "content", "screenshot", "pdf", "links", "scrape", "json", "snapshot", "ocr"];

/** Per-backend support of each op ("no" entries answer with error.code unsupported; the phone has no PDF engine). */
export const SUPPORT: Record<GwOp, Record<"container" | "phone" | "cloudflare", boolean>> = {
  read: { container: true, phone: true, cloudflare: true },
  content: { container: true, phone: true, cloudflare: true },
  screenshot: { container: true, phone: true, cloudflare: true },
  pdf: { container: true, phone: false, cloudflare: true },
  links: { container: true, phone: true, cloudflare: true },
  scrape: { container: true, phone: true, cloudflare: true },
  json: { container: true, phone: true, cloudflare: true },
  snapshot: { container: true, phone: true, cloudflare: true },
  // ocr: container only (Tesseract in cloudy-browser-headless); the phone engine and Browser Run have no OCR
  ocr: { container: true, phone: false, cloudflare: false },
};

export const CF_API = "https://api.cloudflare.com/client/v4";
/** The REST path segment. Cloudflare renamed Browser Rendering to Browser Run; both paths serve the same endpoints. */
export const CF_PATH_DEFAULT = "browser-rendering";

export interface CfConf { account: string; token: string; base: string; seg: string }
/** Names only: CF_BROWSER_ACCOUNT_ID|CF_ACCOUNT_ID and CF_BROWSER_API_TOKEN|CF_API_TOKEN. Null when not configured. */
export function cfConf(env: Record<string, string | undefined> = process.env): CfConf | null {
  const account = env.CF_BROWSER_ACCOUNT_ID || env.CF_ACCOUNT_ID || "";
  const token = env.CF_BROWSER_API_TOKEN || env.CF_API_TOKEN || "";
  if (!account || !token) return null;
  return { account, token, base: (env.C3_CF_API_BASE || CF_API).replace(/\/+$/, ""), seg: env.C3_CF_BROWSER_PATH || CF_PATH_DEFAULT };
}

let discoveredAccount: string | undefined;
/** cfConf, and when only the token is configured, the account id is read once from GET /accounts (an id, not a secret; first account of the token). */
export async function cfConfResolve(env: Record<string, string | undefined> = process.env, f: typeof fetch = fetch): Promise<CfConf | null> {
  const c = cfConf(env);
  if (c) return c;
  const token = env.CF_BROWSER_API_TOKEN || env.CF_API_TOKEN || "";
  if (!token) return null;
  if (!discoveredAccount) {
    try {
      const base = (env.C3_CF_API_BASE || CF_API).replace(/\/+$/, "");
      const r = await f(`${base}/accounts?per_page=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => ({}));
      discoveredAccount = j?.result?.[0]?.id;
    } catch { /* not discoverable */ }
  }
  return discoveredAccount ? { account: discoveredAccount, token, base: (env.C3_CF_API_BASE || CF_API).replace(/\/+$/, ""), seg: env.C3_CF_BROWSER_PATH || CF_PATH_DEFAULT } : null;
}

export const hostOf = (url: string): string => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ ok: false, error: { code, message }, ...extra });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CfRaw { status: number; ms: number; json?: any; bytes?: Uint8Array; mime?: string; text?: string }

/** One Cloudflare Browser Run REST call; retries once on 429 (free plan: 1 request per 10 s). Secrets only in the Authorization header. */
export async function cfRequest(endpoint: string, body: unknown, conf: CfConf, f: typeof fetch = fetch, binary = false, wait: (ms: number) => Promise<void> = sleep): Promise<CfRaw> {
  const url = `${conf.base}/accounts/${conf.account}/${conf.seg}/${endpoint}`;
  for (let attempt = 0; ; attempt++) {
    const r = await f(url, { method: "POST", headers: { authorization: `Bearer ${conf.token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
    const ms = Number(r.headers?.get?.("x-browser-ms-used") ?? 0) || 0;
    if (r.status === 429 && attempt === 0) { const ra = Number(r.headers?.get?.("retry-after") ?? 11); await wait(Math.min(Math.max(ra, 1), 15) * 1000); continue; }
    const ct = r.headers?.get?.("content-type") ?? "";
    if (r.ok && binary && !ct.includes("json")) return { status: r.status, ms, bytes: new Uint8Array(await r.arrayBuffer()), mime: ct.split(";")[0] };
    const text = await r.text();
    let json: any; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, ms, json, text };
  }
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cfErr = (r: CfRaw) => {
  const e = r.json?.errors?.[0];
  return err(r.status === 429 ? "limit" : r.status === 401 || r.status === 403 ? "unauthorized" : "internal", `cloudflare HTTP ${r.status}${e ? `: ${String(e.message ?? e.code).slice(0, 200)}` : ""}`);
};

/** Request body of each op for the Cloudflare REST API (url and per-op options). Exported for the mapping tests. */
export function cfRequestFor(op: GwOp, a: any): { endpoint: string; body: any; binary: boolean } {
  const base: any = { url: a.url };
  if (a.waitUntil) base.gotoOptions = { waitUntil: a.waitUntil };
  switch (op) {
    case "read": return { endpoint: "markdown", body: base, binary: false };
    case "content": return { endpoint: "content", body: base, binary: false };
    case "screenshot": {
      const o: any = {};
      if (a.fullPage !== undefined) o.fullPage = !!a.fullPage;
      if (a.format) o.type = a.format;
      if (a.quality !== undefined) o.quality = a.quality;
      return { endpoint: "screenshot", body: { ...base, ...(Object.keys(o).length ? { screenshotOptions: o } : {}), ...(a.selector ? { selector: a.selector } : {}) }, binary: true };
    }
    case "pdf": {
      const o: any = {};
      if (a.pdfFormat) o.format = a.pdfFormat;
      if (a.landscape !== undefined) o.landscape = !!a.landscape;
      if (a.printBackground !== undefined) o.printBackground = !!a.printBackground;
      return { endpoint: "pdf", body: { ...base, ...(Object.keys(o).length ? { pdfOptions: o } : {}) }, binary: true };
    }
    case "links": return { endpoint: "links", body: { ...base, ...(a.visibleOnly ? { visibleLinksOnly: true } : {}), ...(a.sameOrigin ? { excludeExternalLinks: true } : {}) }, binary: false };
    case "scrape": return { endpoint: "scrape", body: { ...base, elements: (a.elements ?? []).map((e: any) => ({ selector: e.selector })) }, binary: false };
    case "json": return { endpoint: "json", body: { ...base, ...(a.prompt ? { prompt: a.prompt } : {}), ...(a.schema ? { response_format: { type: "json_schema", json_schema: a.schema } } : {}) }, binary: false };
    case "ocr": throw new Error("ocr has no Cloudflare endpoint");
    case "snapshot": return { endpoint: "snapshot", body: { ...base, ...(a.fullPage !== undefined || a.format || a.quality !== undefined ? { screenshotOptions: { ...(a.fullPage !== undefined ? { fullPage: !!a.fullPage } : {}), ...(a.format ? { type: a.format } : {}), ...(a.quality !== undefined ? { quality: a.quality } : {}) } } : {}) }, binary: false };
  }
}

/** Response of the Cloudflare REST API to the normalised result of the op (the same shapes the session backends return). */
export function cfNormalize(op: GwOp, a: any, r: CfRaw): any {
  if (r.status < 200 || r.status >= 300 || r.json?.success === false) return cfErr(r);
  if (r.bytes) return { ok: true, result: { mime: r.mime || (op === "pdf" ? "application/pdf" : "image/png"), base64: b64(r.bytes), bytes: r.bytes.length } };
  const res = r.json?.result;
  switch (op) {
    case "read": {
      const md = String(res ?? "");
      const fmt = a.format ?? "markdown";
      const max = a.maxChars ?? 20000;
      const off = a.cursor ? Number(a.cursor) : 0;
      let content = md;
      if (fmt === "json") content = JSON.stringify({ meta: { url: a.url, source: "cloudflare" }, markdown: md });
      else if (fmt === "xml") content = `<doc><meta u="${esc(a.url)}" src="cloudflare"/><md>${esc(md)}</md></doc>`;
      const slice = content.slice(off, off + max);
      const truncated = off + max < content.length;
      return { ok: true, result: { url: a.url, format: fmt, content: slice, truncated, ...(truncated ? { next: String(off + max) } : {}), chars: content.length } };
    }
    case "content": return { ok: true, result: { url: a.url, html: String(res ?? "") } };
    case "links": {
      const list: string[] = Array.isArray(res) ? res : [];
      return { ok: true, result: { count: list.length, links: list.map((href) => ({ href })) } };
    }
    case "scrape": {
      const lim = a.limit ?? 100;
      const results = (Array.isArray(res) ? res : []).map((g: any, i: number) => {
        const want: string[] | undefined = a.elements?.[i]?.attrs;
        const items = (g.results ?? []).slice(0, lim).map((n: any) => {
          const attrs: Record<string, string> = {};
          for (const at of n.attributes ?? []) if (!want || want.includes(at.name)) attrs[at.name] = at.value;
          return { text: n.text ?? "", html: n.html ?? "", attrs, visible: (n.width ?? 0) > 0 && (n.height ?? 0) > 0 };
        });
        return { selector: g.selector, count: (g.results ?? []).length, items };
      });
      return { ok: true, result: { results } };
    }
    case "json": return { ok: true, result: { data: res ?? null } };
    case "snapshot": return { ok: true, result: { url: a.url, html: String(res?.content ?? ""), screenshot: { mime: a.format === "jpeg" ? "image/jpeg" : "image/png", base64: String(res?.screenshot ?? "") } } };
    default: return err("internal", `no mapping for ${op}`);
  }
}

/** The text a bot-wall check may look at in a normalised result (cloudflare results carry no probe). */
export function wallSignalsOf(op: GwOp, res: any, url: string): WallSignals {
  const text = op === "read" ? String(res?.content ?? "") : op === "content" ? String(res?.html ?? "").replace(/<[^>]+>/g, " ") : op === "snapshot" ? String(res?.html ?? "").replace(/<[^>]+>/g, " ") : "";
  const html = op === "content" ? String(res?.html ?? "") : op === "snapshot" ? String(res?.html ?? "") : "";
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? /^title:\s*"?(.+?)"?$/im.exec(text)?.[1];
  return { url, title, text, bodyLen: text.trim().length, marker: /cf-challenge|cf-turnstile|challenge-platform|challenge_redirect/.test(html || text) };
}

export interface GwDeps { f?: typeof fetch; env?: Record<string, string | undefined>; state?: BrowserState; wait?: (ms: number) => Promise<void> }
let sharedState: BrowserState | undefined;
export function defaultState(env: Record<string, string | undefined> = process.env): BrowserState {
  return (sharedState ||= new BrowserState(configFromEnv(env), Date.now, env.C3_BROWSER_STATE_FILE || "/tmp/c3-browser-state.json"));
}

/** Default per-call budget of browser.ocr (OCR is CPU work: seconds per image); the container stops starting new images at 85% of it. */
export const OCR_TIMEOUT_MS = 90_000;

/** One op through the session backends (container | phone): open (+probe) + the command, in a single run. */
export async function viaSession(backend: "container" | "phone", op: GwOp, a: any, d: GwDeps): Promise<{ res: any; signals: WallSignals; error?: any; session?: string }> {
  const f = d.f ?? fetch; const env = d.env ?? process.env;
  const common = { ...(a.agent ? { agent: a.agent } : {}), ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}) };
  const open = { cmd: "open", url: a.url, ...(a.profile ? { profile: a.profile } : {}), ...(a.session ? { session: a.session } : {}), ...common };
  const probe = { cmd: "eval", js: PROBE_JS, ...common };
  let last: any;
  switch (op) {
    case "read": last = { cmd: "readable", format: a.format, maxChars: a.maxChars, ...common }; break;
    case "json": last = { cmd: "readable", format: "markdown", maxChars: 60000, ...common }; break;
    case "content": last = { cmd: "content", ...common }; break;
    case "screenshot": last = { cmd: "screenshot", ...(a.fullPage !== undefined ? { fullPage: a.fullPage } : {}), ...(a.selector ? { selector: a.selector } : {}), ...(a.format ? { format: a.format } : {}), ...(a.quality !== undefined ? { quality: a.quality } : {}), ...common }; break;
    case "pdf": last = { cmd: "pdf", ...(a.pdfFormat ? { format: a.pdfFormat } : {}), ...(a.landscape !== undefined ? { landscape: a.landscape } : {}), ...(a.printBackground !== undefined ? { printBackground: a.printBackground } : {}), ...common }; break;
    case "links": last = { cmd: "links", ...(a.visibleOnly ? { visibleOnly: true } : {}), ...(a.sameOrigin ? { sameOrigin: true } : {}), ...common }; break;
    case "scrape": last = { cmd: "scrape", elements: a.elements, ...(a.limit ? { limit: a.limit } : {}), ...common }; break;
    case "ocr": last = { cmd: "ocr", ...(a.engine ? { engine: a.engine } : {}), ...(a.minWidth !== undefined ? { minWidth: a.minWidth } : {}), ...(a.minHeight !== undefined ? { minHeight: a.minHeight } : {}), ...(a.includeScreenshot !== undefined ? { includeScreenshot: a.includeScreenshot } : {}), ...(a.fullPage !== undefined ? { fullPage: a.fullPage } : {}), ...(a.lang ? { lang: a.lang } : {}), ...(a.maxImages !== undefined ? { maxImages: a.maxImages } : {}), ...(a.escalateBelow !== undefined ? { escalateBelow: a.escalateBelow } : {}), timeoutMs: a.timeoutMs ?? OCR_TIMEOUT_MS, ...(a.agent ? { agent: a.agent } : {}) }; break;
    case "snapshot": last = { cmd: "snapshot", ...(a.fullPage !== undefined ? { fullPage: a.fullPage } : {}), ...(a.format ? { format: a.format } : {}), ...(a.quality !== undefined ? { quality: a.quality } : {}), ...common }; break;
  }
  const r: any = await call(backend, "run", { ...(a.session ? { session: a.session } : {}), stopOnError: false, steps: [open, probe, last] }, f, env as any);
  const steps: any[] = r?.steps ?? [];
  const o = steps[0]?.result ?? {};
  const p = steps[1]?.ok ? steps[1].result ?? {} : {};
  const signals: WallSignals = { status: o.status, cfMitigated: o.cfMitigated, url: p.url ?? o.url, title: p.title ?? o.title, text: p.text, bodyLen: p.bodyLen, marker: p.marker };
  // a failed probe is not fatal; a failed open or command is (the open's signals are kept so a wall can still be seen)
  const failed = !steps[0]?.ok ? steps[0] ?? { error: r?.error } : steps[2] && !steps[2].ok ? steps[2] : !steps.length ? { error: r?.error } : undefined;
  if (failed) return { res: err(failed.error?.code ?? "internal", failed.error?.message ?? "browser call failed"), signals, error: failed.error, session: r?.session };
  const x = steps[2]?.result ?? {};
  switch (op) {
    case "read": return { res: { ok: true, result: { url: x.url, title: x.title, format: x.format, content: x.content, truncated: !!x.truncated, ...(x.next ? { next: x.next } : {}) } }, signals, session: r.session };
    case "json": return { res: { ok: true, result: { url: x.url, title: x.title, markdown: String(x.content ?? "") } }, signals, session: r.session };
    case "content": return { res: { ok: true, result: { url: o.url, title: o.title, html: String(x ?? "") } }, signals, session: r.session };
    default: return { res: { ok: true, result: x }, signals, session: r.session };
  }
}

/** json op for the session backends: our own model through OpenRouter (key by env NAME OPENROUTER_API_KEY, model C3_BROWSER_JSON_MODEL). */
export const JSON_MODEL_DEFAULT = "meta-llama/llama-3.3-70b-instruct";
export async function extractJsonViaOpenRouter(markdown: string, a: any, f: typeof fetch = fetch, env: Record<string, string | undefined> = process.env): Promise<any> {
  const key = env.OPENROUTER_API_KEY ?? "";
  if (!key) return err("not_configured", "browser.json on container/phone needs OPENROUTER_API_KEY in the MCP secrets (private store); or use backend cloudflare");
  const sys = "Extract data from the page text. Answer with ONE JSON value only, no prose, no code fences." + (a.schema ? " It must validate against the given JSON schema." : "");
  const user = `${a.prompt ? `Task: ${a.prompt}\n` : ""}${a.schema ? `JSON schema: ${JSON.stringify(a.schema)}\n` : ""}Page (${a.url}):\n${markdown.slice(0, 60000)}`;
  const body: any = { model: env.C3_BROWSER_JSON_MODEL || JSON_MODEL_DEFAULT, messages: [{ role: "system", content: sys }, { role: "user", content: user }], temperature: 0, response_format: a.schema ? { type: "json_schema", json_schema: { name: "extraction", schema: a.schema } } : { type: "json_object" } };
  const r = await f("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(110_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) return err("internal", `openrouter HTTP ${r.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 160)}` : ""}`);
  const txt = String(j?.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return { ok: true, result: { data: JSON.parse(txt), model: body.model } }; } catch { return err("internal", "model did not return valid JSON"); }
}

/** Minimal JSON-schema validation of an extraction (type, required, properties, items, enum): enough to catch a wrong shape. */
export function validateAgainstSchema(v: any, s: any, path = "$"): string[] {
  if (!s || typeof s !== "object") return [];
  const errs: string[] = [];
  const t = s.type;
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  const okType = (x: string) => x === kind || (x === "integer" && kind === "number" && Number.isInteger(v)) || (x === "number" && kind === "number");
  if (t && !(Array.isArray(t) ? t.some(okType) : okType(t))) errs.push(`${path}: expected ${Array.isArray(t) ? t.join("|") : t}, got ${kind}`);
  if (s.enum && !s.enum.some((e: any) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path}: not in enum`);
  if (kind === "object") {
    for (const k of s.required ?? []) if (!(k in v)) errs.push(`${path}.${k}: required`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) if (k in v) errs.push(...validateAgainstSchema(v[k], sub, `${path}.${k}`));
  }
  if (kind === "array" && s.items) v.forEach((x: any, i: number) => errs.push(...validateAgainstSchema(x, s.items, `${path}[${i}]`)));
  return errs;
}

/** Final shape: result fields at top level plus backend_used and fallback_reason (null when no fallback). */
const shape = (res: any, backend_used: string, fallback_reason: string | null, extra: Record<string, unknown> = {}) =>
  res?.ok === false ? { ok: false, error: res.error, backend_used, fallback_reason, ...extra } : { ok: true, ...res.result, backend_used, fallback_reason, ...extra };

async function viaCloudflare(op: GwOp, a: any, d: GwDeps, state: BrowserState, reason: string | null): Promise<any> {
  const conf = await cfConfResolve(d.env ?? process.env, d.f ?? fetch);
  if (!conf) return err("not_configured", "cloudflare backend not configured (names: CF_BROWSER_API_TOKEN or CF_API_TOKEN with the Browser Run - Edit permission; CF_BROWSER_ACCOUNT_ID or CF_ACCOUNT_ID, else the token's first account)");
  const cap = state.capReason();
  if (cap) return err("limit", cap);
  const { endpoint, body, binary } = cfRequestFor(op, a);
  const raw = await cfRequest(endpoint, body, conf, d.f ?? fetch, binary, d.wait);
  const entry = state.record({ op, host: hostOf(a.url), backend: "cloudflare", status: raw.status, ms: raw.ms, ...(reason ? { reason } : {}) });
  console.error(JSON.stringify({ browser_usage: { op, host: entry.host, backend: "cloudflare", status: entry.status, ms: entry.ms, usd_est: Number(entry.usd.toFixed(6)), day_calls: state.calls, day_usd_est: Number(state.usd.toFixed(6)), ...(reason ? { fallback_reason: reason } : {}) } }));
  return cfNormalize(op, a, raw);
}

/**
 * The browser.* url entry point. backend auto: container -> (bot wall) -> cloudflare, with a per-domain 24 h memory.
 * Explicit backends never fall back; a detected wall is reported as bot_wall.
 */
export async function gateway(op: GwOp, a: any, d: GwDeps = {}): Promise<any> {
  const state = d.state ?? defaultState(d.env ?? process.env);
  const backend: GwBackend = a.backend ?? "auto";
  const host = hostOf(a.url ?? "");
  if (!a.url) return err("bad_request", "url required");
  if (!/^https?:\/\//i.test(a.url)) return err("bad_request", "url must be http(s)");
  if (backend === "phone" && !SUPPORT[op].phone) return err("unsupported", `${op} is not supported by the phone backend; use container, cloudflare or auto`, { backend_used: "phone", fallback_reason: null });
  // When the caller did not pass a.session, the gateway opened a fresh one for this single call: close it afterwards
  // (unless a read was truncated, so the caller's cursor can continue it) to avoid leaking sessions up to the container's cap.
  const closeIfOwned = async (b: "container" | "phone", session: string | undefined) => {
    if (session && !a.session) { try { await call(b, "command", { cmd: "close", session }, d.f ?? fetch, d.env ?? process.env as any); } catch { /* best effort */ } }
  };
  const runSession = async (b: "container" | "phone") => {
    const s = await viaSession(b, op, a, d);
    let res = s.res;
    if (res.ok && op === "json") {
      const md = await extractJsonViaOpenRouter(res.result.markdown, a, d.f ?? fetch, d.env ?? process.env);
      res = md;
      if (res.ok && a.schema) { const bad = validateAgainstSchema(res.result.data, a.schema); if (bad.length) res = { ...res, result: { ...res.result, schema_errors: bad } }; }
    }
    const keepOpen = op === "read" && res?.ok && res.result?.truncated;
    if (!keepOpen) { await closeIfOwned(b, s.session); return { ...s, res, session: a.session ? s.session : undefined }; }
    return { ...s, res };
  };
  const cfShape = (res: any, reason: string | null) => {
    const sh = shape(res, "cloudflare", reason);
    if (res?.ok !== false && op !== "json") {
      const w = detectBotWall(wallSignalsOf(op, res.result, a.url));
      if (w) return { ...sh, bot_wall: true, bot_wall_reason: w, note: "Cloudflare Browser Run was refused as well; the challenge result is returned as is" };
    }
    return sh;
  };
  if (backend === "cloudflare") {
    if (!SUPPORT[op].cloudflare) return err("unsupported", `${op} not supported on cloudflare`);
    return cfShape(await viaCloudflare(op, a, d, state, null), null);
  }
  if (backend === "container" || backend === "phone") {
    const s = await runSession(backend);
    const wall = detectBotWall(s.signals);
    return shape(s.res, backend, null, { ...(s.session ? { session: s.session } : {}), ...(wall ? { bot_wall: true, bot_wall_reason: wall } : {}) });
  }
  // auto
  if (SUPPORT[op].cloudflare && host && state.needsCloudflare(host) && await cfConfResolve(d.env ?? process.env, d.f ?? fetch)) {
    const why = "domain_memory: needs cloudflare";
    const res = await viaCloudflare(op, a, d, state, why);
    if (!(res?.ok === false && (res.error.code === "limit" || res.error.code === "not_configured"))) return cfShape(res, why);
  }
  const s = await runSession("container");
  const wall = detectBotWall(s.signals);
  if (!wall) return shape(s.res, "container", null, s.session ? { session: s.session } : {});
  // bot wall: hand the same call to Cloudflare Browser Run (never solve, spoof or rotate)
  if (!SUPPORT[op].cloudflare) return shape(s.res, "container", null, { bot_wall: true, bot_wall_reason: wall, fallback_skipped: `${op} is not available on cloudflare`, ...(s.session ? { session: s.session } : {}) });
  const reason = `bot_wall: ${wall}`;
  const conf = await cfConfResolve(d.env ?? process.env, d.f ?? fetch);
  if (!conf) return shape(s.res, "container", reason, { bot_wall: true, bot_wall_reason: wall, fallback_skipped: "cloudflare backend not configured" });
  const cap = state.capReason();
  if (cap) return shape(s.res, "container", reason, { bot_wall: true, bot_wall_reason: wall, fallback_skipped: cap });
  state.markNeedsCloudflare(host);
  const cfRes = await viaCloudflare(op, a, d, state, reason);
  if (cfRes?.ok === false) { state.forget(host); return shape(s.res, "container", reason, { bot_wall: true, bot_wall_reason: wall, fallback_skipped: `cloudflare failed: ${cfRes.error?.message ?? ""}` }); }
  return cfShape(cfRes, reason);
}
