// #1803 recipient check — SMTP transcripts + DNS answers from ./fixtures, no network.
// Run: node --test recipients.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RecipientChecker, RateLimiter, checkSyntax, type CheckerConfig } from "./recipients.ts";
import { Ledger } from "./ledger.ts";
import { parseWebhookBody } from "./stalwart-wire.ts";
import { parseSize } from "./smtp-probe.ts";
import { fixture, recordedConnector, recordedMx } from "./fakes.test-helpers.ts";

const CFG: CheckerConfig = {
  helo: "probe.example.org", mailFrom: "", probePort: 25, probeTimeoutMs: 1000, maxMxTried: 2,
  probeOverrides: { "example.org": { host: "10.0.0.3", port: 2025 } },
  cacheTtlMs: 3600_000, cacheTtlUnknownMs: 600_000, maxAddressesPerRequest: 50,
  rateLimit: { addresses: 5, perMs: 60_000 },
  random: () => "probe",
};

function checker(sent: string[], ledger: Ledger | null = null, now = () => 1_000_000) {
  return new RecipientChecker(CFG, recordedMx(), recordedConnector(sent), ledger, now);
}

test("syntax", () => {
  assert.equal(checkSyntax("a.b+tag@example.org").ok, true);
  assert.equal(checkSyntax("\"quoted local\"@example.org").ok, true);
  assert.equal(checkSyntax("josé@bücher.example").normalized, "josé@xn--bcher-kva.example");
  for (const bad of ["", "no-at", "a..b@example.org", ".a@example.org", "a@-bad.example", "a@[192.0.2.1]", "a@localhost", `${"x".repeat(65)}@example.org`]) {
    assert.equal(checkSyntax(bad).ok, false, bad);
  }
});

test("existing mailbox at a real MX: ok, SIZE read from EHLO, and the probe never sends DATA", async () => {
  const sent: string[] = [];
  const r = await checker(sent).check("alice@remote.example");
  assert.equal(r.verdict, "ok", r.reason);
  assert.equal(r.checks.mailbox.state, "exists");
  assert.equal(r.checks.size_limit.bytes, 52428800);
  assert.deepEqual(r.checks.domain_mx.hosts, ["mx1.remote.example", "mx2.remote.example"]);
  assert.ok(sent.some((l) => l.endsWith("RCPT TO:<probe@remote.example>")), "catch-all control probe sent");
  assert.ok(!sent.some((l) => /\bDATA\b/i.test(l)), "no DATA");
  assert.deepEqual(sent.map((l) => l.split("> ")[1].split(/[ :]/)[0]), ["EHLO", "MAIL", "RCPT", "RCPT", "RSET", "QUIT"]);
});

test("unknown user is fail", async () => {
  const r = await checker([]).check("nobody@remote.example");
  assert.equal(r.verdict, "fail");
  assert.equal(r.checks.mailbox.state, "does_not_exist");
});

test("catch-all is accepts_all / risky, never ok", async () => {
  const r = await checker([]).check("anyone@catchall.example");
  assert.equal(r.checks.mailbox.state, "accepts_all");
  assert.equal(r.verdict, "risky");
  assert.equal(r.checks.size_limit.bytes, 10240000);
});

test("greylisting is unknown", async () => {
  const r = await checker([]).check("bob@grey.example");
  assert.equal(r.checks.mailbox.state, "unknown");
  assert.equal(r.verdict, "unknown");
  assert.match(r.reason, /greylist/i);
});

test("null MX and NXDOMAIN fail; no MX falls back to A; nothing at all fails", async () => {
  const c = checker([]);
  const nul = await c.check("a@nullmx.example");
  assert.equal(nul.verdict, "fail");
  assert.equal(nul.checks.domain_mx.null_mx, true);
  assert.equal((await c.check("a@nosuchdomain.example")).verdict, "fail");
  const imp = await c.check("a@implicit.example");
  assert.equal(imp.checks.domain_mx.state, "ok");
  assert.equal(imp.checks.domain_mx.implicit, true);
  assert.equal((await c.check("a@noemail.example")).verdict, "fail");
});

test("port 25 unreachable from the server (provider block) is unknown, not ok", async () => {
  const r = await checker([]).check("x@blocked.example");
  assert.equal(r.verdict, "unknown");
  assert.match(r.checks.mailbox.reason, /cannot reach mx\.blocked\.example:25/);
  assert.equal(r.checks.size_limit.bytes, null);
});

test("local domain is probed at the fleet's own Stalwart (override), role/past-bounce hints make it risky", async () => {
  const sent: string[] = [];
  const ok = await checker(sent).check("sender@example.org");
  assert.equal(ok.verdict, "ok");
  assert.ok(sent[0].startsWith("10.0.0.3> "));
  const missing = await checker([]).check("ghost@example.org");
  assert.equal(missing.verdict, "fail");

  const l = new Ledger({ path: null, relayHosts: ["smtp.email.eu-marseille-1.oci.oraclecloud.com"], localDomains: ["example.org"], retentionDays: 90 });
  l.ingestEvents(parseWebhookBody(fixture("webhook-relay-batch.json")));
  const b = await checker([], l).check("bob@remote.example");
  assert.equal(b.checks.past_bounce.state, "bounced");
  assert.match(String(b.checks.past_bounce.reason), /5\.1\.1/);
  const role = await checker([]).check("postmaster@remote.example");
  assert.equal(role.checks.role, true);
});

test("disposable hint", async () => {
  const r = await checker([]).check("x@mailinator.com");
  assert.equal(r.checks.disposable, true);
  assert.notEqual(r.verdict, "ok");
});

test("results are cached for the TTL, then re-probed", async () => {
  let t = 1_000_000;
  const sent: string[] = [];
  const c = checker(sent, null, () => t);
  await c.check("alice@remote.example");
  const n = sent.length;
  const again = await c.check("ALICE@remote.example");
  assert.equal(again.cached, true);
  assert.equal(sent.length, n, "no second probe inside the TTL");
  t += CFG.cacheTtlMs + 1;
  assert.equal((await c.check("alice@remote.example")).cached, false);
  assert.ok(sent.length > n);
});

test("rate limiter is per caller and windowed", () => {
  let t = 0;
  const rl = new RateLimiter(5, 60_000, () => t);
  assert.equal(rl.take("10.0.0.9", 5), 0);
  assert.ok(rl.take("10.0.0.9", 1) > 0);
  assert.equal(rl.take("10.0.0.10", 1), 0);
  t = 60_001;
  assert.equal(rl.take("10.0.0.9", 1), 0);
});

test("EHLO SIZE parsing", () => {
  assert.equal(parseSize("250-mx\n250-SIZE 1000\n250 HELP"), 1000);
  assert.equal(parseSize("250-mx\n250 SIZE"), 0);
  assert.equal(parseSize("250 mx"), null);
});
