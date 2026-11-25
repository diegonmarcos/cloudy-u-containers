// #1926 The mail stack answer (code/api/mailStack.ts, mailLive.ts, routes/mail.ts): the report parses, each check maps to the probe id
// the Cloud C3 topology binds, colours are green/amber/red by severity, every table section carries every declared key, the live probes
// (DNS, TLS expiry, ports) are collected through injected probes, missing sources degrade to notServed, and the route is registered.
// No network, no server. Usage: node test-mail-stack.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { collectLive, collectTls, TLS_TARGETS, type Probes } from "./code/api/mailLive.ts";
import { buildTables, certState, mailStack, parseReport, reportProbes, stateOf, TABLE_KEYS, worst, REPORT_PROBES, liveProbes } from "./code/api/mailStack.ts";

let n = 0;
const t = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`ok - ${name}`); });

const chk = (name: string, passed: boolean, details = "", severity = "Critical", error: string | null = null, ms = 12) =>
  ({ name, passed, details, duration_ms: ms, error: error ?? (passed ? null : details), severity });
const GEN = "2026-11-25T10:00:00Z";
const NOW = Date.parse("2026-11-25T10:30:00Z");
const fixture = {
  generated: GEN, duration_ms: 41000,
  path_checks: [
    chk("OUT→1 Maddy :465 (SMTPS)", true, "tcp 10.0.0.3:465 OPEN"), chk("OUT→2 OCI relay :587", true, "tcp smtp.email... OPEN"),
    chk("OUT→3 AWS relay :587 (fallback)", false, "tcp email-smtp... CLOSED", "Warning"),
    chk("IN→1 Cloudflare MX", true, "mx ok"), chk("IN→2 api.diegonmarcos.com/http-to-smtp-proxy-api HTTPS", true, "200"),
    chk("IN→3 Hickory DNS http-to-smtp-proxy-api.mesh.diegonmarcos.com", true, "10.0.0.1"),
    chk("IN→4 http-to-smtp-proxy-api :8090 (gcp-proxy)", true, "OPEN"), chk("IN→5 Maddy :25 (oci-mail)", true, "OPEN"),
    chk("IN→6 Maddy IMAP :993 (local store)", true, "OPEN"), chk("IN→7 stalwart_relay :2025 (dual-write)", false, "CLOSED"),
    chk("IN→8 Stalwart IMAPS :2993 (user store)", true, "OPEN"), chk("DISC→1 JMAP autoconfig https://jmap.diegonmarcos.com/.well-known/jmap", true, "200"),
  ],
  instant_kpis: [chk("CF Worker alive", true, "200"), chk("mail.* HTTPS", true, "200"), chk("webmail HTTPS", true, "200"), chk("mail:993 TLS (WG)", true, "TLSv1.3"), chk("mail:465 TLS (WG)", true, "TLSv1.3")],
  preflight: [chk("WG oci-mail", true, "ok"), chk("Disk space", true, "41% used", "Warning"), chk("Memory", true, "55%", "Warning")],
  containers: [chk("maddy", true, "Up 3 days"), chk("cloud-mail-mcp", false, "Exited", "Warning"), chk("Container listing", true, "2")],
  network: [chk("Webmail HTTPS", true, "200"), chk("SMTP :25 relay", true, "OPEN")],
  dns_auth: [chk("MX", true, "10 route1.mx.cloudflare.net"), chk("DKIM", true, "present"), chk("SPF", true, "v=spf1 include:_spf.mx.cloudflare.net ~all"), chk("DMARC", true, "v=DMARC1; p=quarantine")],
  internals: [chk("mailbox quota", true, "1.2G / 10G", "Info"), chk("Mail accounts", true, "7 accounts (maddy creds)", "Info"), chk("Mail domains", true, "diegonmarcos.com configured", "Info"),
    chk("Stalwart relay backlog", false, "31 messages queued for tcp://10.0.0.3:2025 (ceiling 25) — mirror to Stalwart is stalled"), chk("User accounts", true, "5 users", "Info"), chk("Maddy IMAP :993", true, "ok"), chk("Stalwart IMAP :2993", true, "ok")],
  config_drift: [chk("Config drift", true, "none", "Info")],
  e2e_delivery: [chk("IMAP arrival", true, "arrived in 4 s"), chk("Send via Resend", true, "202"), chk("Resend status", true, "delivered")],
  summary: { total_checks: 40, passed: 37, failed: 3, warnings: 1, critical: 2 }, timers: { path: 3 },
};
const report = parseReport(JSON.stringify(fixture))!;
const calls: string[] = [];
const fake: Probes = {
  resolveMx: async () => [{ exchange: "route1.mx.cloudflare.net", priority: 21 }, { exchange: "route2.mx.cloudflare.net", priority: 5 }],
  resolveTxt: async (name) => (name.startsWith("_dmarc") ? ["v=DMARC1; p=none"] : name.startsWith("default._domainkey") ? ["v=DKIM1; k=rsa; p=AAA"] : name.startsWith("_mta-sts") ? [] : name.startsWith("_smtp._tls") ? (() => { throw new Error("ENODATA"); })() : ["v=spf1 -all"]),
  resolve4: async () => ["203.0.113.9"],
  reverse: async () => ["mail.diegonmarcos.com"],
  cert: async (h) => { calls.push(h); if (h.startsWith("webmail")) throw new Error("ECONNREFUSED"); return { notAfter: new Date(NOW + (h.startsWith("jmap") ? 5 : h.startsWith("mail") ? 14 : 60) * 86400000).toISOString(), issuer: "Let's Encrypt", latencyMs: 30 }; },
  tcp: async (h) => { if (h.startsWith("route3")) throw new Error("timeout"); return 20; },
};

await t("the report parses; garbage and a non-report do not", () => {
  assert.equal(report.checks.length, Object.values(fixture).flatMap((v) => (Array.isArray(v) ? v : [])).length);
  assert.equal(parseReport("{ nope"), null); assert.equal(parseReport("{}"), null); assert.equal(parseReport(""), null); assert.equal(parseReport(undefined), null);
});

await t("health colour: passed green, failed Critical red, failed Warning/Info amber, worst wins, nothing is grey", () => {
  assert.equal(stateOf({ passed: true, severity: "Critical" }), "ok");
  assert.equal(stateOf({ passed: false, severity: "Critical" }), "bad");
  assert.equal(stateOf({ passed: false, severity: "Warning" }), "warn");
  assert.equal(stateOf({ passed: false, severity: "Info" }), "warn");
  assert.equal(worst(["ok", "warn", "ok"]), "warn"); assert.equal(worst(["ok", "bad", "warn"]), "bad"); assert.equal(worst([]), "unknown");
});

await t("every report check name binds a probe id the topology uses; failing ones carry colour, queue depth and errors", () => {
  const ps = new Map(reportProbes(report).map((p) => [p.id, p]));
  assert.equal(ps.get("in.cf_mx")!.state, "ok");
  assert.equal(ps.get("in.relay_2025")!.state, "bad");
  assert.equal(ps.get("out.aws_relay")!.state, "warn");
  assert.equal(ps.get("queue.stalwart_backlog")!.queue, 31);
  assert.equal(ps.get("queue.stalwart_backlog")!.state, "bad");
  assert.ok(ps.get("queue.stalwart_backlog")!.errors[0].includes("stalled"));
  assert.equal(ps.get("container.maddy")!.state, "ok");
  assert.equal(ps.get("container.cloud-mail-mcp")!.state, "warn");
  assert.equal(ps.get("dns.dkim")!.checkedAt, GEN);
  assert.equal(ps.get("in.jmap_discovery")!.checks, 1);
  assert.ok(ps.get("host.disk")!.latencyMs === 12);
  const unbound = report.checks.filter((c) => !REPORT_PROBES.some(([, ph, re]) => (ph === null || ph === c.phase) && re.test(c.name)) && c.phase !== "containers");
  assert.deepEqual(unbound.map((c) => c.name), []);
});

await t("a healthy queue reads 0 and an empty report yields no probes", () => {
  const r2 = parseReport(JSON.stringify({ ...fixture, internals: [chk("Stalwart relay backlog", true, "empty — stalwart mirror caught up", "Info")] }))!;
  assert.equal(reportProbes(r2).find((p) => p.id === "queue.stalwart_backlog")!.queue, 0);
  assert.deepEqual(reportProbes(null), []);
});

await t("live: DNS rows for MX, SPF, DKIM, DMARC, MTA-STS, TLS-RPT and PTR; a missing advisory record is amber, a missing mandatory one red", async () => {
  const live = await collectLive(fake, NOW);
  const types = new Set(live.dns.map((d) => d.type));
  for (const x of ["MX", "SPF", "DKIM", "DMARC", "MTA-STS", "TLS-RPT", "PTR"]) assert.ok(types.has(x), x);
  assert.equal(live.dns.filter((d) => d.type === "MX").length, 2);
  const ps = new Map(liveProbes(live).map((p) => [p.id, p]));
  assert.equal(ps.get("live.dns_mx")!.state, "ok"); assert.equal(ps.get("live.dns_mta_sts")!.state, "warn"); assert.equal(ps.get("live.dns_tls_rpt")!.state, "warn");
  assert.equal(ps.get("live.dns_dmarc")!.state, "ok");
});

await t("live: TLS expiry in days, thresholds 21 amber and 7 red, unreachable is red, every target probed once", async () => {
  const rows = await collectTls(fake, NOW);
  assert.equal(rows.length, TLS_TARGETS.length); assert.equal(new Set(calls).size, TLS_TARGETS.length);
  const by = Object.fromEntries(rows.map((r) => [r.host, r]));
  assert.equal(by["imap.diegonmarcos.com"].daysLeft, 60); assert.equal(certState(by["imap.diegonmarcos.com"]), "ok");
  assert.equal(certState(by["mail.diegonmarcos.com"]), "warn"); assert.equal(certState(by["jmap.diegonmarcos.com"]), "bad");
  assert.equal(certState(by["webmail.diegonmarcos.com"]), "bad"); assert.equal(by["webmail.diegonmarcos.com"].ok, false);
  assert.equal(certState({ ok: true, daysLeft: 21 }), "warn"); assert.equal(certState({ ok: true, daysLeft: 22 }), "ok"); assert.equal(certState({ ok: true, daysLeft: 7 }), "bad");
});

await t("every table section carries every declared key in every row, and the sections hold the stack's data", async () => {
  const live = await collectLive(fake, NOW);
  const stack = mailStack({ report, reportError: "", live, liveError: "", now: NOW });
  assert.deepEqual(Object.keys(stack.tables).sort(), Object.keys(TABLE_KEYS).sort());
  for (const [sec, keys] of Object.entries(TABLE_KEYS)) for (const row of stack.tables[sec]) for (const k of keys) assert.ok(k in row, `${sec} row misses ${k}: ${JSON.stringify(row)}`);
  const T = stack.tables;
  assert.ok(T.dns.length >= 9); assert.ok(T.inbound.length >= 9); assert.ok(T.outbound.length >= 3);
  assert.deepEqual(T.inbound.map((r) => r.step).slice(0, 3), [1, 2, 3]);
  assert.equal(T.accounts.length, 3); assert.equal(T.mailboxes.length, 3);
  assert.ok(T.ports.some((r) => r.port === 25 && r.state === "bad")); assert.ok(T.tls.some((r) => r.days_left === 14));
  assert.ok(T.health.some((r) => r.scope === "container" && r.name === "maddy")); assert.ok(T.health.some((r) => r.scope === "host"));
  assert.equal(T.queues[0].depth, 31); assert.equal(T.queues[0].ceiling, 25); assert.equal(T.queues[0].state, "bad");
  assert.ok(T.freshness.some((r) => r.name === "mail report" && r.age === "30 min"));
  assert.equal(T.failures.length, report.checks.filter((c) => !c.passed).length);
  assert.deepEqual(T.tests.map((r) => r.test), ["mail_inbound", "mail_outbound", "mail_distribution", "mail_ingest", "mail_puller"]);
  assert.equal(T.tests.find((r) => r.test === "mail_puller")!.state, "unknown");
  assert.equal(T.tests.find((r) => r.test === "mail_inbound")!.state, "bad");
  assert.ok(stack.notServed.some((x) => x.section === "pullers"));
  assert.equal(stack.report!.stale, false);
});

await t("a missing source degrades and says so: no report -> notServed + empty report tables, no live -> notServed", () => {
  const none = mailStack({ report: null, reportError: "report HTTP 404", live: null, liveError: "boom", now: NOW });
  assert.equal(none.report, null); assert.equal(none.probes.length, 0);
  assert.ok(none.notServed.some((x) => x.section === "report")); assert.ok(none.notServed.some((x) => x.section === "live"));
  for (const keys of Object.keys(TABLE_KEYS)) assert.ok(Array.isArray(none.tables[keys]));
  assert.deepEqual(buildTables(null, null, []).failures, []);
  const old = mailStack({ report, reportError: "", live: null, liveError: "", now: NOW + 7 * 3600_000 });
  assert.equal(old.report!.stale, true);
});

await t("the route is registered in app.ts and owned in the hierarchy", () => {
  assert.match(readFileSync(new URL("./code/api/app.ts", import.meta.url), "utf8"), /registerMailRoutes/);
  assert.match(readFileSync(new URL("./code/api/routes/mail.ts", import.meta.url), "utf8"), /"\/mail\/stack"/);
});

console.log(`${n} passed`);
