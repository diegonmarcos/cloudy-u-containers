// #1926 The mail stack as ONE structured answer for Cloud C3 > Ops > Mail (Tables and the two topology maps).
//
// Two sources, both read-only, both optional:
//   1. the published report cloud_mail_full.json (cloud-mail-health-full: checks per phase, produced by the reports image);
//   2. live probes this API runs itself (DNS records, TLS certificate expiry, MX reachability) in mailLive.ts.
// Everything below is PURE (no network): the route injects the two sources, the test injects fixtures. A field a source
// cannot provide is listed in `notServed` with the reason, never invented and never silently empty, so the app can say
// "not served" instead of showing a blank that reads as healthy.
//
// Probe ids are the contract with the app's declared topology (ac_cloud-c3/data/mail_stack.json binds each node to probe ids).

export type State = "ok" | "warn" | "bad" | "unknown";

export interface Check {
  phase: string;
  name: string;
  passed: boolean;
  details: string;
  duration_ms: number;
  error: string | null;
  severity: "Critical" | "Warning" | "Info";
}

export interface Report {
  generated: string;
  duration_ms: number;
  summary: { total_checks: number; passed: number; failed: number; warnings: number; critical: number };
  timers: Record<string, number>;
  checks: Check[];
}

export interface Probe {
  id: string;
  state: State;
  detail: string;
  latencyMs: number | null;
  checkedAt: string | null;
  queue: number | null;
  errors: string[];
  checks: number;
  source: "report" | "live";
}

export const PHASES = [
  "path_checks", "instant_kpis", "preflight", "containers", "network", "dns_auth", "internals", "config_drift", "e2e_delivery",
] as const;

/** The report's JSON, tolerant of missing phases. Null when it is not a mail report at all. */
export function parseReport(text: string | null | undefined): Report | null {
  if (!text) return null;
  let o: any;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || typeof o.generated !== "string") return null;
  const checks: Check[] = [];
  for (const phase of PHASES) {
    for (const c of Array.isArray(o[phase]) ? o[phase] : []) {
      if (!c || typeof c.name !== "string") continue;
      checks.push({
        phase, name: c.name, passed: c.passed === true, details: String(c.details ?? ""), duration_ms: Number(c.duration_ms) || 0,
        error: c.error == null ? null : String(c.error),
        severity: c.severity === "Critical" || c.severity === "Warning" ? c.severity : "Info",
      });
    }
  }
  const s = o.summary ?? {};
  return {
    generated: o.generated, duration_ms: Number(o.duration_ms) || 0,
    summary: { total_checks: Number(s.total_checks) || checks.length, passed: Number(s.passed) || 0, failed: Number(s.failed) || 0, warnings: Number(s.warnings) || 0, critical: Number(s.critical) || 0 },
    timers: o.timers && typeof o.timers === "object" ? o.timers : {}, checks,
  };
}

/** green / amber / red: passed is ok; a failed Critical is bad; a failed Warning or Info is warn. */
export function stateOf(c: Pick<Check, "passed" | "severity">): State {
  if (c.passed) return "ok";
  return c.severity === "Critical" ? "bad" : "warn";
}

const RANK: Record<State, number> = { unknown: 0, ok: 1, warn: 2, bad: 3 };
export function worst(states: State[]): State {
  return states.reduce<State>((a, b) => (RANK[b] > RANK[a] ? b : a), "unknown");
}

/** [probe id, phase (null = any), name matcher]. The report's check names are the ones in cloud-mail-health-full phases.rs. */
export const REPORT_PROBES: ReadonlyArray<readonly [string, string | null, RegExp]> = [
  ["in.cf_mx", null, /^IN→1 /],
  ["in.proxy_https", null, /^IN→2 /],
  ["in.proxy_dns", null, /^IN→3 /],
  ["in.proxy_port", null, /^IN→4 /],
  ["in.maddy_smtp", null, /^IN→5 /],
  ["in.maddy_imap", null, /^IN→6 /],
  ["in.relay_2025", null, /^IN→7 /],
  ["in.stalwart_imap", null, /^IN→8 /],
  ["in.jmap_discovery", null, /^DISC→/],
  ["out.maddy_submission", null, /^OUT→1 /],
  ["out.oci_relay", null, /^OUT→2 /],
  ["out.aws_relay", null, /^OUT→3 /],
  ["edge.cf_worker", null, /^CF Worker/],
  ["edge.google_oauth", null, /^Google OAuth/],
  ["edge.gha_health", null, /^GHA health$/],
  ["web.mail_https", null, /^mail\.\* HTTPS$/],
  ["web.webmail_https", null, /^webmail https$/i],
  ["web.webmail_internal", null, /^webmail internal$/i],
  ["web.webmail_route", null, /^mail\.\*\/webmail\/ route$|^webmail\.\* redirect$/],
  ["web.auth_https", null, /^auth https$/i],
  ["web.authelia", null, /^Authelia health$/],
  ["web.oidc_webmail", null, /^OIDC bearer -> webmail$/],
  ["web.mail_admin", null, /^Mail Admin via Bearer$/],
  ["web.mcp", null, /^MCP endpoint$|^cloud-mail-mcp/],
  ["tls.imap_wg", null, /^mail:993 TLS/],
  ["tls.smtps_wg", null, /^mail:465 TLS/],
  ["tls.wg_direct", null, /^TLS WG direct$/],
  ["l4.imap_993", null, /^mail:993 \(IMAP\)$/],
  ["l4.smtps_465", null, /^mail:465 \(SMTPS\)$/],
  ["l4.caddy", null, /^Caddy L4 -> /],
  ["l4.caddy_gcp", null, /^Caddy \(gcp-proxy\)$/],
  ["l4.smtp_25", null, /^SMTP :25 relay$/],
  ["l4.hickory", null, /^Hickory DNS$/],
  ["direct.imap_wg", null, /^IMAP direct \(WG\)$/],
  ["direct.smtp_wg", null, /^SMTP direct \(WG\)$/],
  ["dns.mx", "dns_auth", /^MX$/],
  ["dns.dkim", "dns_auth", /^DKIM$/],
  ["dns.spf", "dns_auth", /^SPF$/],
  ["dns.dmarc", "dns_auth", /^DMARC$/],
  ["dns.mx_record", "instant_kpis", /^MX record$/],
  ["dns.dkim_record", "instant_kpis", /^DKIM record$/],
  ["queue.stalwart_backlog", null, /^Stalwart relay backlog$/],
  ["store.maddy_imap", "internals", /^Maddy IMAP :993$/],
  ["store.stalwart_imap", "internals", /^Stalwart IMAP :2993$/],
  ["store.quota", null, /^mailbox quota$/],
  ["store.accounts", null, /^Mail accounts$/],
  ["store.domains", null, /^Mail domains$/],
  ["store.users", null, /^User accounts$/],
  ["host.disk", null, /^Disk space$/],
  ["host.memory", null, /^Memory$/],
  ["host.load", null, /^Load$/],
  ["host.ports", null, /^All ports bound$/],
  ["host.containers", null, /^Container listing$/],
  ["drift.config", "config_drift", /./],
  ["send.resend", null, /^Resend|^Send via Resend$/],
  ["deliver.imap_arrival", null, /^IMAP arrival$/],
  ["deliver.proxy_logs", null, /^http-to-smtp-proxy-api logs$/],
  ["vm.oci_mail", null, /^WG oci-mail$|^SSH batch oci-mail$|^Cloud API oci-mail$/],
  ["vm.oci_apps", null, /^WG oci-apps$|^SSH batch oci-apps$|^Cloud API oci-apps$/],
  ["vm.gcp_proxy", null, /^WG gcp-proxy$|^SSH batch gcp-proxy$|^Cloud API gcp-proxy$/],
];

function probeFrom(id: string, cs: Check[], generated: string | null): Probe {
  const state = worst(cs.map(stateOf));
  const latency = cs.reduce((m, c) => Math.max(m, c.duration_ms), 0);
  const qm = id === "queue.stalwart_backlog" ? cs[0].details.match(/^(\d+) (?:in flight|messages queued)/) : null;
  return {
    id, state, source: "report", checkedAt: generated, checks: cs.length,
    detail: cs.map((c) => (cs.length > 1 ? `${c.name}: ${c.details}` : c.details)).join("; ").slice(0, 600),
    latencyMs: latency > 0 ? latency : null,
    queue: qm ? Number(qm[1]) : id === "queue.stalwart_backlog" && /^empty/.test(cs[0].details) ? 0 : null,
    errors: cs.filter((c) => !c.passed).map((c) => `${c.name}: ${c.error ?? c.details}`.slice(0, 300)),
  };
}

/** Container-phase checks get one probe each (`container.<name>`), so a new container shows up without an edit here. */
export function reportProbes(r: Report | null): Probe[] {
  if (!r) return [];
  const out: Probe[] = [];
  for (const [id, phase, re] of REPORT_PROBES) {
    const cs = r.checks.filter((c) => (phase === null || c.phase === phase) && re.test(c.name));
    if (cs.length) out.push(probeFrom(id, cs, r.generated));
  }
  const byName = new Map<string, Check[]>();
  for (const c of r.checks.filter((x) => x.phase === "containers" && x.name !== "Container listing")) {
    byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  }
  for (const [name, cs] of byName) out.push(probeFrom(`container.${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}`, cs, r.generated));
  return out;
}

// ── live facts (mailLive.ts fills these; tests pass fixtures) ──────────────────────────────────────────────────

export interface DnsRow { domain: string; type: string; selector: string; name: string; value: string; ok: boolean; note: string }
export interface TlsRow { host: string; port: number; role: string; ok: boolean; notAfter: string | null; daysLeft: number | null; issuer: string; latencyMs: number | null; error: string }
export interface PortRow { host: string; port: number; role: string; ok: boolean; latencyMs: number | null; error: string }
export interface Live { checkedAt: string; dns: DnsRow[]; tls: TlsRow[]; ports: PortRow[] }

export const CERT_WARN_DAYS = 21;
export const CERT_BAD_DAYS = 7;

export function certState(t: Pick<TlsRow, "ok" | "daysLeft">): State {
  if (!t.ok || t.daysLeft === null) return "bad";
  if (t.daysLeft <= CERT_BAD_DAYS) return "bad";
  if (t.daysLeft <= CERT_WARN_DAYS) return "warn";
  return "ok";
}

export function liveProbes(l: Live | null): Probe[] {
  if (!l) return [];
  const mk = (id: string, state: State, detail: string, latencyMs: number | null, errors: string[], n: number): Probe =>
    ({ id, state, detail: detail.slice(0, 600), latencyMs, checkedAt: l.checkedAt, queue: null, errors, checks: n, source: "live" });
  const out: Probe[] = [];
  const dnsBy = (t: string) => l.dns.filter((d) => d.type === t);
  for (const [id, t] of [["live.dns_mx", "MX"], ["live.dns_spf", "SPF"], ["live.dns_dkim", "DKIM"], ["live.dns_dmarc", "DMARC"], ["live.dns_mta_sts", "MTA-STS"], ["live.dns_tls_rpt", "TLS-RPT"], ["live.dns_ptr", "PTR"]] as const) {
    const rows = dnsBy(t);
    if (!rows.length) continue;
    // MTA-STS / TLS-RPT / PTR are advisory: a missing record is amber, not red.
    const advisory = t === "MTA-STS" || t === "TLS-RPT" || t === "PTR";
    const st = worst(rows.map((r) => (r.ok ? "ok" : advisory ? "warn" : "bad")));
    out.push(mk(id, st, rows.map((r) => `${r.name} ${r.ok ? "ok" : r.note || "missing"}`).join("; "), null, rows.filter((r) => !r.ok).map((r) => `${r.name}: ${r.note || "missing"}`), rows.length));
  }
  for (const t of l.tls) {
    out.push(mk(`live.tls.${t.host}`, certState(t), t.ok ? `valid until ${t.notAfter} (${t.daysLeft} days)` : t.error, t.latencyMs, t.ok ? [] : [t.error], 1));
  }
  for (const p of l.ports) {
    out.push(mk(`live.port.${p.host}.${p.port}`, p.ok ? "ok" : "bad", p.ok ? "open" : p.error || "closed", p.latencyMs, p.ok ? [] : [`${p.host}:${p.port} ${p.error || "closed"}`], 1));
  }
  return out;
}

// ── tables ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Row = Record<string, string | number | boolean | null>;

/** The sections and the keys each row carries. The app declares the same ids and keys (data/mail_stack.json) and its test fails on drift. */
export const TABLE_KEYS: Readonly<Record<string, readonly string[]>> = {
  dns: ["domain", "type", "selector", "name", "value", "state", "note", "checked_at"],
  inbound: ["hop", "step", "name", "state", "detail", "latency_ms", "checked_at"],
  outbound: ["hop", "step", "name", "state", "detail", "latency_ms", "checked_at"],
  accounts: ["kind", "name", "value", "state", "detail"],
  mailboxes: ["name", "value", "state", "detail"],
  ports: ["host", "port", "role", "state", "latency_ms", "detail"],
  tls: ["host", "port", "role", "state", "not_after", "days_left", "issuer", "latency_ms", "detail"],
  health: ["scope", "name", "state", "detail", "latency_ms", "checked_at"],
  queues: ["name", "depth", "ceiling", "state", "detail"],
  freshness: ["name", "state", "age", "detail", "checked_at"],
  pullers: ["source", "state", "detail", "last_check"],
  failures: ["phase", "name", "severity", "error", "detail", "checked_at"],
  tests: ["test", "state", "passed", "failed", "detail", "checked_at"],
};

const checkRow = (c: Check, gen: string) => ({ name: c.name, state: stateOf(c), detail: c.details, latency_ms: c.duration_ms || null, checked_at: gen });

const INBOUND_ORDER = /^(IN→|DISC→)/;
const OUTBOUND_ORDER = /^(OUT→|Resend|Send via Resend|CF Worker)/;
const hopOf = (name: string): { hop: string; step: number } => {
  const m = name.match(/^(IN|OUT)→(\d+)/);
  if (m) return { hop: m[1] === "IN" ? "inbound" : "outbound", step: Number(m[2]) };
  if (name.startsWith("DISC→")) return { hop: "inbound", step: 20 + Number(name.match(/^DISC→(\d+)/)?.[1] ?? 0) };
  return { hop: "outbound", step: 90 };
};

/** The ceiling the report's backlog check enforces (cloud-mail-health-full constants.rs STALWART_QUEUE_MAX_DEPTH). */
export const STALWART_QUEUE_CEILING = 25;

export function buildTables(r: Report | null, l: Live | null, probes: Probe[], now: number = Date.now()): Record<string, Row[]> {
  const gen = r?.generated ?? "";
  const cs = r?.checks ?? [];
  const t: Record<string, Row[]> = {};
  t.dns = (l?.dns ?? []).map((d) => ({ domain: d.domain, type: d.type, selector: d.selector, name: d.name, value: d.value, state: d.ok ? "ok" : (d.type === "MTA-STS" || d.type === "TLS-RPT" || d.type === "PTR") ? "warn" : "bad", note: d.note, checked_at: l!.checkedAt }));
  for (const c of cs.filter((x) => x.phase === "dns_auth")) {
    t.dns.push({ domain: "", type: c.name, selector: c.name === "DKIM" ? "default" : "", name: "report: " + c.name, value: c.details, state: stateOf(c), note: "from the published mail report", checked_at: gen });
  }
  const hopRows = (re: RegExp, dir: string): Row[] =>
    cs.filter((c) => re.test(c.name) && hopOf(c.name).hop === dir).map((c) => ({ ...checkRow(c, gen), hop: dir, step: hopOf(c.name).step }))
      .sort((a, b) => Number(a.step) - Number(b.step));
  t.inbound = hopRows(INBOUND_ORDER, "inbound");
  t.outbound = hopRows(OUTBOUND_ORDER, "outbound");
  const acct = (kind: string, name: string): Row[] => {
    const c = cs.find((x) => x.name === name);
    return c ? [{ kind, name, value: c.details, state: stateOf(c), detail: c.error ?? "" }] : [];
  };
  t.accounts = [...acct("maddy accounts", "Mail accounts"), ...acct("users", "User accounts"), ...acct("domains", "Mail domains")];
  t.mailboxes = cs.filter((c) => /^mailbox quota$|^Maddy IMAP|^Stalwart IMAP/.test(c.name)).map((c) => ({ name: c.name, value: c.details, state: stateOf(c), detail: c.error ?? "" }));
  const portRows: Row[] = (l?.ports ?? []).map((p) => ({ host: p.host, port: p.port, role: p.role, state: p.ok ? "ok" : "bad", latency_ms: p.latencyMs, detail: p.ok ? "open" : p.error || "closed" }));
  for (const c of cs.filter((x) => /:(\d{2,5})\b|^All ports bound$/.test(x.name) && x.phase !== "dns_auth")) {
    const m = c.name.match(/:(\d{2,5})\b/);
    portRows.push({ host: "report", port: m ? Number(m[1]) : null, role: c.name, state: stateOf(c), latency_ms: c.duration_ms || null, detail: c.details });
  }
  t.ports = portRows;
  t.tls = (l?.tls ?? []).map((x) => ({ host: x.host, port: x.port, role: x.role, state: certState(x), not_after: x.notAfter, days_left: x.daysLeft, issuer: x.issuer, latency_ms: x.latencyMs, detail: x.ok ? "" : x.error }));
  for (const c of cs.filter((x) => /TLS/.test(x.name))) {
    t.tls.push({ host: "report", port: Number(c.name.match(/:(\d+)/)?.[1] ?? 0) || null, role: c.name, state: stateOf(c), not_after: null, days_left: null, issuer: "", latency_ms: c.duration_ms || null, detail: c.details });
  }
  const scopeOf = (c: Check) => (c.phase === "containers" ? "container" : /^(WG|SSH batch|Cloud API) /.test(c.name) ? "vm" : /^(Disk space|Memory|Load)$/.test(c.name) ? "host" : "");
  t.health = cs.filter((c) => scopeOf(c)).map((c) => ({ scope: scopeOf(c), ...checkRow(c, gen) }));
  const q = cs.find((c) => c.name === "Stalwart relay backlog");
  const qp = probes.find((p) => p.id === "queue.stalwart_backlog");
  t.queues = q ? [{ name: "maddy to Stalwart dual-write (/data/queue-stalwart)", depth: qp?.queue ?? null, ceiling: STALWART_QUEUE_CEILING, state: stateOf(q), detail: q.details }] : [];
  const fresh = cs.filter((c) => c.name === "IMAP arrival" || /^http-to-smtp-proxy-api logs$/.test(c.name));
  t.freshness = [
    ...(r ? [{ name: "mail report", state: "ok", age: ageText(gen, now), detail: `generated ${gen}, ${r.duration_ms} ms`, checked_at: gen }] : []),
    ...fresh.map((c) => ({ name: c.name, state: stateOf(c), age: c.details, detail: c.error ?? c.details, checked_at: gen })),
    ...cs.filter((c) => /^Resend status$|^Send via Resend$/.test(c.name)).map((c) => ({ name: c.name, state: stateOf(c), age: "", detail: c.details, checked_at: gen })),
  ];
  t.pullers = [];
  t.failures = cs.filter((c) => !c.passed).map((c) => ({ phase: c.phase, name: c.name, severity: c.severity, error: c.error ?? "", detail: c.details, checked_at: gen }));
  const testSets: Array<[string, (c: Check) => boolean]> = [
    ["mail_inbound", (c) => /^(IN→|DISC→)/.test(c.name) || c.phase === "e2e_delivery" && /IMAP arrival/.test(c.name)],
    ["mail_outbound", (c) => /^(OUT→|Resend|Send via Resend|CF Worker)/.test(c.name)],
    ["mail_distribution", (c) => c.phase === "network" || c.phase === "instant_kpis"],
    ["mail_ingest", (c) => c.phase === "internals" || c.phase === "e2e_delivery"],
    ["mail_puller", (c) => /puller/i.test(c.name)],
  ];
  t.tests = testSets.map(([test, f]) => {
    const set = cs.filter(f);
    const failed = set.filter((c) => !c.passed).length;
    return { test, state: !set.length ? "unknown" : worst(set.map(stateOf)), passed: set.length - failed, failed, detail: set.length ? "" : "no check of this set in the report", checked_at: gen };
  });
  return t;
}

export function ageText(generated: string, now: number = Date.now()): string {
  const ms = now - Date.parse(generated);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.round(ms / 60000);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

/** Fields no source serves yet; the app prints these as "not served" rather than as an empty healthy-looking table. */
export function notServed(r: Report | null, l: Live | null): Array<{ section: string; field: string; reason: string }> {
  const out: Array<{ section: string; field: string; reason: string }> = [];
  if (!r) out.push({ section: "report", field: "all", reason: "the published report cloud_mail_full.json could not be read" });
  if (!l) out.push({ section: "live", field: "dns, tls, ports", reason: "live probes did not run" });
  out.push({ section: "pullers", field: "per-source rows", reason: "mail-puller has no status endpoint yet; its sources are not served" });
  out.push({ section: "mailboxes", field: "per-mailbox size and quota", reason: "the report carries one quota line, not a per-mailbox table" });
  return out;
}

export interface StackInputs { report: Report | null; reportError: string; live: Live | null; liveError: string; now?: number }

export function mailStack(i: StackInputs) {
  const probes = [...reportProbes(i.report), ...liveProbes(i.live)];
  const stale = i.report ? Date.parse(i.report.generated) < (i.now ?? Date.now()) - 6 * 3600_000 : null;
  return {
    generatedAt: new Date(i.now ?? Date.now()).toISOString(),
    report: i.report ? { generated: i.report.generated, ageText: ageText(i.report.generated, i.now), stale, durationMs: i.report.duration_ms, summary: i.report.summary, timers: i.report.timers } : null,
    reportError: i.reportError,
    liveError: i.liveError,
    probes,
    tables: buildTables(i.report, i.live, probes, i.now ?? Date.now()),
    notServed: notServed(i.report, i.live),
  };
}
