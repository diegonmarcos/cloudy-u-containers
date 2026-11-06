// ── Security-testing tools: Steel Browser + OWASP ZAP ──────────────────────
// Owner-authorized ethical-hacking / security testing of the owner's OWN fleet
// services only. Every target-taking tool resolves the request host and
// REFUSES + logs it unless it matches the declared allowlist
// (_shared/security-testing-allowlist.json, mirrored here). ZAP tools also push
// the same allowlist into ZAP as context/scope before scanning. Default-deny.
//
// Enforcement is identical to _shared/security-testing-allowlist.mjs (the guard
// that proves in/out-of-allowlist behaviour); keep the two in sync.
import { rawHttpRequest } from "../../shared/libs/http.js";
import { getConfig } from "../../shared/libs/config.js";

// Backends reached over the oci-apps WireGuard address (mesh-only, private).
const STEEL_BASE = process.env.STEEL_BASE_URL ?? "http://10.0.0.6:3000";
const ZAP_BASE = process.env.ZAP_BASE_URL ?? "http://10.0.0.6:8086";
const steelKey = () => process.env.STEEL_API_KEY ?? "";
const zapKey = () => process.env.ZAP_API_KEY ?? "";

// ── Allowlist (DATA, derived from fleet topology) ──────────────────────────
export interface AllowRules {
  domain_suffixes: string[];
  mesh_suffixes: string[];
  cidrs: string[];
  exact_ips: string[];
}
const BASE_DOMAIN = "diegonmarcos.com";
const STATIC_RULES: AllowRules = {
  domain_suffixes: [BASE_DOMAIN, "." + BASE_DOMAIN],
  mesh_suffixes: [".mesh." + BASE_DOMAIN, ".home.arpa", ".internal"],
  cidrs: ["127.0.0.0/8", "::1/128", "10.0.0.0/24", "10.1.0.0/24", "fd0c:1d00::/64", "fd0c:1d01::/64"],
  exact_ips: [],
};

/** Fleet VM public IPs come from the live topology config (never hand-listed). */
function allowlist(): AllowRules {
  const ips = new Set<string>();
  try {
    const cfg: any = getConfig();
    for (const v of Object.values(cfg.vms ?? {}) as any[]) {
      const ip = v.public_ip ?? v.ip;
      if (typeof ip === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ips.add(ip);
    }
  } catch { /* fall back to domain/mesh/cidr only */ }
  return { ...STATIC_RULES, exact_ips: [...ips].sort() };
}

function v4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}
function v4InCidr(ip: string, cidr: string): boolean {
  const [net, b] = cidr.split("/"); const bits = Number(b);
  const a = v4ToInt(ip), n = v4ToInt(net);
  if (a === null || n === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
}
function v6InCidr(ip: string, cidr: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^\[|\]$/g, "");
  const [net, b] = cidr.split("/"); const bits = Number(b);
  const expand = (x: string): number[] | null => {
    x = norm(x); if (!x.includes(":")) return null;
    const [head, tail = ""] = x.split("::");
    const h = head ? head.split(":") : []; const t = tail ? tail.split(":") : [];
    const fill = 8 - (h.length + t.length); if (fill < 0) return null;
    const full = [...h, ...Array(fill).fill("0"), ...t].map((y) => parseInt(y || "0", 16));
    return full.length === 8 ? full : null;
  };
  const a = expand(ip), n = expand(net); if (!a || !n) return false;
  let rem = bits;
  for (let i = 0; i < 8 && rem > 0; i++) {
    const take = Math.min(16, rem);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (n[i] & mask)) return false;
    rem -= take;
  }
  return true;
}

export function targetHost(target: string): string {
  let t = String(target || "").trim(); if (!t) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { try { return new URL(t).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return ""; } }
  const m6 = t.match(/^\[([^\]]+)\](?::\d+)?$/); if (m6) return m6[1].toLowerCase();
  t = t.replace(/\/.*$/, "");
  if ((t.match(/:/g) || []).length === 1) t = t.split(":")[0];
  return t.toLowerCase();
}

export function checkTarget(target: string, rules: AllowRules = allowlist()): { allowed: boolean; host: string; reason: string } {
  const host = targetHost(target);
  if (!host) return { allowed: false, host: "", reason: "empty or unparseable target" };
  const isV4 = v4ToInt(host) !== null;
  const isV6 = !isV4 && host.includes(":");
  if (isV4 || isV6) {
    for (const ip of rules.exact_ips) if (ip.toLowerCase() === host) return { allowed: true, host, reason: `exact fleet IP ${ip}` };
    for (const c of rules.cidrs) if ((c.includes(":") ? v6InCidr(host, c) : v4InCidr(host, c))) return { allowed: true, host, reason: `in fleet CIDR ${c}` };
    return { allowed: false, host, reason: `IP ${host} is not a fleet IP/CIDR (default-deny)` };
  }
  for (const suf of rules.mesh_suffixes) if (host === suf.replace(/^\./, "") || host.endsWith(suf)) return { allowed: true, host, reason: `fleet mesh name (${suf})` };
  for (const suf of rules.domain_suffixes) { const bare = suf.replace(/^\./, ""); if (host === bare || host.endsWith("." + bare)) return { allowed: true, host, reason: `owner domain (${bare})` }; }
  return { allowed: false, host, reason: `host ${host} is not an owner domain/mesh name (default-deny)` };
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const });
const jsonText = (label: string, data: unknown) => text(`${label}\n\n${typeof data === "string" ? data : JSON.stringify(data, null, 2)}`);

/** Refuse+log an out-of-allowlist target. The refusal is the security control. */
function refuse(tool: string, target: string, c: { host: string; reason: string }) {
  process.stderr.write(`[security-testing] REFUSED ${tool} target=${JSON.stringify(target)} host=${c.host}: ${c.reason}\n`);
  return errText(`REFUSED: target "${target}" (host ${c.host || "?"}) is NOT on the security-testing allowlist — ${c.reason}. Only the owner's own fleet (*.${BASE_DOMAIN}, mesh names, fleet CIDRs/IPs) may be targeted.`);
}

function requireKey(which: "steel" | "zap") {
  const k = which === "steel" ? steelKey() : zapKey();
  if (!k) return `${which === "steel" ? "STEEL_API_KEY" : "ZAP_API_KEY"} is not set in this MCP environment — add it to the cloud-infra-mcp vault secrets so the tool can authenticate to ${which}.`;
  return null;
}

function steelCall(path: string, method: string, body?: unknown) {
  return rawHttpRequest(method, `${STEEL_BASE}${path}`, body === undefined ? undefined : JSON.stringify(body), 60_000, { Authorization: `Bearer ${steelKey()}` });
}
function zapCall(apiPath: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ apikey: zapKey(), ...params }).toString();
  return rawHttpRequest("GET", `${ZAP_BASE}${apiPath}?${qs}`, undefined, 120_000);
}

// Method names handled in the sec group (registered from meta.ts).
export const STEEL_ZAP_METHODS = [
  "steel_health", "steel_session_create", "steel_navigate", "steel_screenshot", "steel_scrape",
  "zap_health", "zap_context_sync", "zap_spider", "zap_ajax_spider", "zap_active_scan", "zap_alerts", "zap_report",
] as const;

export async function handleSteelZap(method: string, p: any) {
  switch (method) {
    // ── Steel ──
    case "steel_health": {
      const r = rawHttpRequest("GET", `${STEEL_BASE}/healthz`, undefined, 10_000);
      return jsonText("Steel auth-proxy health", { ok: r.ok, status: r.status, note: r.ok ? "bearer proxy up" : "unreachable (container down or STEEL_API_KEY unset → fail-closed)" });
    }
    case "steel_session_create": {
      const e = requireKey("steel"); if (e) return errText(e);
      const r = steelCall("/v1/sessions", "POST", p.options ?? {});
      return jsonText("Steel session", r.data);
    }
    case "steel_navigate": {
      const e = requireKey("steel"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = steelCall("/v1/scrape", "POST", { url: p.url, format: ["html"], ...(p.sessionId ? { sessionId: p.sessionId } : {}) });
      return jsonText(`Steel navigate ${p.url} (${c.reason})`, r.data);
    }
    case "steel_screenshot": {
      const e = requireKey("steel"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = steelCall("/v1/screenshot", "POST", { url: p.url, fullPage: p.fullPage ?? true });
      return jsonText(`Steel screenshot ${p.url} (${c.reason})`, { status: r.status, bytes: r.raw.length });
    }
    case "steel_scrape": {
      const e = requireKey("steel"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = steelCall("/v1/scrape", "POST", { url: p.url, format: p.format ?? ["markdown", "html"] });
      return jsonText(`Steel scrape ${p.url} (${c.reason})`, r.data);
    }
    // ── ZAP ──
    case "zap_health": {
      const e = requireKey("zap"); if (e) return errText(e);
      const r = zapCall("/JSON/core/view/version/", {});
      return jsonText("ZAP version/health", { ok: r.ok, status: r.status, data: r.data });
    }
    case "zap_context_sync": {
      const e = requireKey("zap"); if (e) return errText(e);
      const ctx = p.contextName ?? "owner-fleet";
      const rules = allowlist();
      zapCall("/JSON/context/action/newContext/", { contextName: ctx });
      const added: string[] = [];
      for (const suf of [...rules.domain_suffixes, ...rules.mesh_suffixes]) {
        const bare = suf.replace(/^\./, "");
        const regex = `https?://([^/]+\\.)?${bare.replace(/\./g, "\\.")}(:\\d+)?/.*`;
        zapCall("/JSON/context/action/includeInContext/", { contextName: ctx, regex });
        added.push(regex);
      }
      for (const ip of rules.exact_ips) { const regex = `https?://${ip.replace(/\./g, "\\.")}(:\\d+)?/.*`; zapCall("/JSON/context/action/includeInContext/", { contextName: ctx, regex }); added.push(regex); }
      return jsonText(`ZAP context "${ctx}" synced to allowlist`, { includeRegex: added });
    }
    case "zap_spider": {
      const e = requireKey("zap"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = zapCall("/JSON/spider/action/scan/", { url: p.url, recurse: String(p.recurse ?? true) });
      return jsonText(`ZAP spider ${p.url} (${c.reason})`, r.data);
    }
    case "zap_ajax_spider": {
      const e = requireKey("zap"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = zapCall("/JSON/ajaxSpider/action/scan/", { url: p.url, inScope: "true" });
      return jsonText(`ZAP AJAX spider ${p.url} (${c.reason})`, r.data);
    }
    case "zap_active_scan": {
      const e = requireKey("zap"); if (e) return errText(e);
      if (!p.url) return errText("url is required");
      const c = checkTarget(p.url); if (!c.allowed) return refuse(method, p.url, c);
      const r = zapCall("/JSON/ascan/action/scan/", { url: p.url, recurse: String(p.recurse ?? true), inScopeOnly: "true" });
      return jsonText(`ZAP active scan ${p.url} (${c.reason})`, r.data);
    }
    case "zap_alerts": {
      const e = requireKey("zap"); if (e) return errText(e);
      const params: Record<string, string> = {};
      if (p.baseurl) { const c = checkTarget(p.baseurl); if (!c.allowed) return refuse(method, p.baseurl, c); params.baseurl = p.baseurl; }
      const r = zapCall("/JSON/core/view/alerts/", params);
      return jsonText("ZAP alerts", r.data);
    }
    case "zap_report": {
      const e = requireKey("zap"); if (e) return errText(e);
      const r = zapCall("/OTHER/core/other/htmlreport/", {});
      return jsonText("ZAP HTML report", { status: r.status, bytes: r.raw.length, note: "HTML report body returned in raw" });
    }
    default:
      return errText(`Unknown security-testing method: ${method}`);
  }
}
