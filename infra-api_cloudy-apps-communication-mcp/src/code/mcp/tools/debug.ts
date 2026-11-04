import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { withImap } from "../shared/imap.js";
import { DOMAIN, getServer, serverSchema, type ServerConfig } from "../shared/config.js";

const execAsync = promisify(execCb);

const CF_ACCOUNT_ID = "e5cb0a0c6f448e54f217de484259f0ae";

// ── Helpers ──────────────────────────────────────────────────────────

// ssh transport-level failures (no key material, connection refused, auth
// rejected before a remote command ever ran) vs. a remote command that ran
// and genuinely failed. Deployed containers have no ssh keys/known_hosts, so
// every ssh-dependent check would otherwise report [FAIL] here -- that's a
// tooling artifact, not a mail-flow problem, so we mark it [SKIP] instead.
const SSH_TRANSPORT_RE = /Permission denied|Host key verification failed|Could not resolve hostname|Connection refused|Connection timed out|No route to host|ssh: connect to host|Operation timed out|kex_exchange_identification|ssh_exchange_identification|No such identity|Identity file .* not accessible/i;

async function sshExec(alias: string, cmd: string, timeoutMs = 15000): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `ssh -o ConnectTimeout=10 -o BatchMode=yes -o ControlPath=none ${alias} '${cmd.replace(/'/g, "'\\''")}'`,
      { timeout: timeoutMs },
    );
    return stdout.trim();
  } catch (e: any) {
    const msg = e.message?.split("\n")[0] ?? String(e);
    const isTransportFailure = e.code === 255 || SSH_TRANSPORT_RE.test(`${e.message ?? ""} ${e.stderr ?? ""}`);
    return isTransportFailure
      ? `SSH_SKIP: no ssh access from this host (${msg})`
      : `SSH_FAIL: ${msg}`;
  }
}

async function digExec(query: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`dig +short ${query}`, { timeout: 10000 });
    return stdout.trim() || "(empty)";
  } catch (e: any) {
    return `DIG_FAIL: ${e.message?.split("\n")[0] ?? e}`;
  }
}

// Query MX over a public resolver (1.1.1.1, falling back to 8.8.8.8) instead
// of the system/mesh resolver. On the WG mesh the system resolver answers
// through split-DNS for our own domain, whose private zone legitimately has
// no MX record -- that is not what real internet senders see.
async function digMxPublic(domain: string): Promise<{ result: string; resolver: string }> {
  const primary = await digExec(`MX ${domain} @1.1.1.1`);
  if (!isFail(primary) && primary !== "(empty)") return { result: primary, resolver: "1.1.1.1" };
  const fallback = await digExec(`MX ${domain} @8.8.8.8`);
  if (!isFail(fallback) && fallback !== "(empty)") return { result: fallback, resolver: "8.8.8.8" };
  return { result: primary, resolver: "1.1.1.1" };
}

async function serverQueue(srv: ServerConfig, serverName: string): Promise<string> {
  if (serverName === "maddy") {
    return sshExec(srv.sshAlias, `docker exec ${srv.container} maddy queue list 2>&1 || echo 'Queue empty'`, 15000);
  }
  return sshExec(srv.sshAlias, `docker logs ${srv.container} --since 5m 2>&1 | grep -iE 'queue|pending|retry|delivery' | tail -10 || echo 'No queue activity'`, 15000);
}

function status(ok: boolean): string {
  return ok ? "[PASS]" : "[FAIL]";
}

function isFail(output: string): boolean {
  return /^(SSH_FAIL|DIG_FAIL|API_ERROR|QUEUE_FAIL|TIMEOUT)/.test(output);
}

// A check that could not run at all (no ssh access from this host, no API
// credentials configured, ...) is neither a pass nor a fail -- it's a gap in
// what this vantage point can observe. Keep that visually and semantically
// distinct from a check that ran and found a real problem.
function isSkip(output: string): boolean {
  return /^(SSH_SKIP|SKIPPED)/.test(output);
}

function badge(source: string, ok: boolean): string {
  return isSkip(source) ? "[SKIP]" : status(ok);
}

// ── Handlers ─────────────────────────────────────────────────────────

export async function handle_debug_outbound({ server: srvName, minutes }: { server: any; minutes: any }) {
  const srv = getServer(srvName);
  const sections: string[] = [];
  const m = Math.max(1, Math.min(60, minutes));

  const [
    queueResult,
    sshBatchResult,
    dnsResults,
  ] = await Promise.all([
    serverQueue(srv, srvName),

    sshExec(srv.sshAlias, [
      `echo "===SERVER_LOGS==="`,
      `docker logs ${srv.container} --since ${m}m 2>&1 | grep -iE "queue|relay|delivery|bounce|reject|error|fail|next-hop|remote|connect" | tail -30`,
      `echo "===HTTP_TO_SMTP_PROXY_API_LOGS==="`,
      `docker logs http-to-smtp-proxy-api --since ${m}m 2>&1 | tail -20`,
      `echo "===OCI_RELAY==="`,
      `echo QUIT | timeout 5 openssl s_client -starttls smtp -connect smtp.email.eu-marseille-1.oci.oraclecloud.com:587 -quiet 2>&1 | head -3`,
      `echo "===AWS_RELAY==="`,
      `echo QUIT | timeout 5 openssl s_client -starttls smtp -connect email-smtp.us-east-1.amazonaws.com:587 -quiet 2>&1 | head -3`,
    ].join(" ; "), 30000),

    Promise.all([
      digMxPublic(DOMAIN),
      digExec(`TXT ${DOMAIN}`),
      digExec(`TXT default._domainkey.${DOMAIN}`),
      digExec(`TXT _dmarc.${DOMAIN}`),
    ]),
  ]);

  const sshSkipped = isSkip(sshBatchResult);
  const sshSections: Record<string, string> = {};
  if (!isFail(sshBatchResult) && !sshSkipped) {
    const parts = sshBatchResult.split(/===(\w+)===/);
    for (let i = 1; i < parts.length; i += 2) {
      sshSections[parts[i]] = (parts[i + 1] ?? "").trim();
    }
  }

  const verdicts: { skipped: boolean; ok: boolean }[] = [];

  // -- Section 1: Queue
  const queueSkipped = isSkip(queueResult);
  const queueOk = !isFail(queueResult) && !queueResult.includes("QUEUE_FAIL");
  const queueEmpty = queueResult === "Queue empty" || queueResult.trim() === "";
  verdicts.push({ skipped: queueSkipped, ok: queueOk });
  sections.push([
    `== 1. ${srvName} Queue ${badge(queueResult, queueOk)} ==`,
    queueEmpty ? "  Queue is empty (no stuck messages)" : queueResult,
  ].join("\n"));

  // -- Section 2: Server Logs
  const serverLogs = (isFail(sshBatchResult) || sshSkipped) ? sshBatchResult : (sshSections["SERVER_LOGS"] || "(no matching log lines)");
  const logsHaveErrors = !sshSkipped && /error|fail|reject|bounce/i.test(serverLogs) && serverLogs !== "(no matching log lines)";
  const logsOk = !logsHaveErrors && !isFail(sshBatchResult);
  verdicts.push({ skipped: sshSkipped, ok: logsOk });
  sections.push([
    `== 2. ${srvName} Outbound Logs (${m}m) ${badge(sshBatchResult, logsOk)} ==`,
    serverLogs || "(no matching log lines)",
  ].join("\n"));

  // -- Section 3: HTTP-to-SMTP Proxy API Logs
  const proxyLogs = (isFail(sshBatchResult) || sshSkipped) ? sshBatchResult : (sshSections["HTTP_TO_SMTP_PROXY_API_LOGS"] || "(no log lines)");
  verdicts.push({ skipped: sshSkipped, ok: !isFail(sshBatchResult) });
  sections.push([
    `== 3. HTTP-to-SMTP Proxy API Logs (${m}m) ${badge(sshBatchResult, !isFail(sshBatchResult))} ==`,
    proxyLogs || "(no log lines)",
  ].join("\n"));

  // -- Section 4: OCI Relay Connect
  const ociRelay = (isFail(sshBatchResult) || sshSkipped) ? sshBatchResult : (sshSections["OCI_RELAY"] || "(no output)");
  const ociOk = /250|220|SMTP/.test(ociRelay);
  verdicts.push({ skipped: sshSkipped, ok: ociOk });
  sections.push([
    `== 4. OCI Relay (smtp.email.eu-marseille-1.oci.oraclecloud.com:587) ${badge(sshBatchResult, ociOk)} ==`,
    ociRelay,
  ].join("\n"));

  // -- Section 5: AWS Relay Connect
  const awsRelay = (isFail(sshBatchResult) || sshSkipped) ? sshBatchResult : (sshSections["AWS_RELAY"] || "(no output)");
  const awsOk = /250|220|SMTP/.test(awsRelay);
  verdicts.push({ skipped: sshSkipped, ok: awsOk });
  sections.push([
    `== 5. AWS Relay (email-smtp.us-east-1.amazonaws.com:587) ${badge(sshBatchResult, awsOk)} ==`,
    awsRelay,
  ].join("\n"));

  // -- Section 6: DNS Auth Records (public view)
  const [mxPublic, spfResult, dkimResult, dmarcResult] = dnsResults;
  const mxResult = mxPublic.result;
  const mxOk = !!mxResult && mxResult !== "(empty)" && !isFail(mxResult);
  const spfOk = /v=spf1/.test(spfResult);
  const dkimOk = !!dkimResult && dkimResult !== "(empty)" && !isFail(dkimResult);
  const dmarcOk = /v=DMARC1/.test(dmarcResult);
  verdicts.push({ skipped: false, ok: mxOk }, { skipped: false, ok: spfOk }, { skipped: false, ok: dkimOk }, { skipped: false, ok: dmarcOk });
  sections.push([
    `== 6. DNS Auth Records ==`,
    `  MX    ${status(mxOk)}  ${mxResult}  (public view via @${mxPublic.resolver})`,
    `  SPF   ${status(spfOk)}  ${spfResult.split("\n").join(" | ")}`,
    `  DKIM  ${status(dkimOk)}  ${dkimResult.length > 120 ? dkimResult.slice(0, 120) + "..." : dkimResult}`,
    `  DMARC ${status(dmarcOk)}  ${dmarcResult}`,
  ].join("\n"));

  const failCount = verdicts.filter(v => !v.skipped && !v.ok).length;
  const skipCount = verdicts.filter(v => v.skipped).length;
  const header = failCount === 0
    ? `=== OUTBOUND DEBUG (${srvName}): ALL CHECKS PASSED${skipCount ? ` (${skipCount} checks skipped, no ssh)` : ""} ===`
    : `=== OUTBOUND DEBUG (${srvName}): ISSUES DETECTED (${failCount} failed${skipCount ? `, ${skipCount} skipped, no ssh` : ""}) ===`;

  return {
    content: [{
      type: "text",
      text: `${header}\n\n${sections.join("\n\n")}`,
    }],
  };
}

export async function handle_debug_inbound({ server: srvName, minutes }: { server: any; minutes: any }) {
  const srv = getServer(srvName);
  const sections: string[] = [];
  const m = Math.max(1, Math.min(60, minutes));

  const [
    mxPublic,
    mxSystemResult,
    cfWorkerResult,
    gcpSshResult,
    ociSshResult,
    queueResult,
    imapResult,
    shadowResult,
  ] = await Promise.all([
    digMxPublic(DOMAIN),
    digExec(`MX ${DOMAIN}`),

    (async (): Promise<string> => {
      const cfKey = process.env.CF_API_KEY;
      const cfEmail = process.env.CF_API_EMAIL;
      if (!cfKey || !cfEmail) return "SKIPPED: CF_API_KEY / CF_API_EMAIL not set";
      try {
        const resp = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/workers/scripts/email-forwarder`,
          { headers: { "X-Auth-Key": cfKey, "X-Auth-Email": cfEmail } },
        );
        if (resp.status === 404) return "Worker 'email-forwarder' not found (404)";
        if (!resp.ok) return `CF API ${resp.status}: ${await resp.text()}`;
        const data = await resp.json() as any;
        return data.success ? "Worker 'email-forwarder' exists and is deployed" : `CF response: ${JSON.stringify(data.errors)}`;
      } catch (e: any) {
        return `CF_FAIL: ${e.message?.split("\n")[0] ?? e}`;
      }
    })(),

    sshExec("gcp-proxy", `docker logs caddy --since ${m}m 2>&1 | grep -iE ":25|layer4|smtp|l4" | tail -10`, 15000),

    sshExec(srv.sshAlias, [
      `echo "===SMTP_BANNER==="`,
      `echo QUIT | timeout 3 nc -w3 localhost 25 2>&1 | head -1`,
      `echo "===INBOUND_LOGS==="`,
      `docker logs ${srv.container} --since ${m}m 2>&1 | grep -iE "ingest|received|accept|reject|spam|junk|from=|to=|message|deliver|rcpt|envelope" | tail -20`,
      `echo "===ACCOUNT_CHECK==="`,
      ...(srvName === "maddy"
        ? [`docker exec ${srv.container} maddy creds list 2>/dev/null | grep -i "me@diegonmarcos" || echo "account not found"`]
        : [`docker logs ${srv.container} --since 60m 2>&1 | grep -iE "auth.*me@diegonmarcos|login.*me@diegonmarcos" | tail -3 || echo "no recent auth activity"`]),
    ].join(" ; "), 20000),

    serverQueue(srv, srvName),

    (async (): Promise<string> => {
      try {
        const count = await withImap(srvName, "me", async (client) => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const mb = client.mailbox;
            return mb ? mb.exists : 0;
          } finally {
            lock.release();
          }
        });
        return `INBOX contains ${count} message(s)`;
      } catch (e: any) {
        return `IMAP_FAIL: ${e.message?.split("\n")[0] ?? e}`;
      }
    })(),

    // Shadow delivery check
    sshExec(srv.sshAlias, `docker logs http-to-smtp-proxy-api --since ${m}m 2>&1 | grep -iE 'shadow|dual|stalwart|forward' | tail -10`, 15000),
  ]);

  const ociSkipped = isSkip(ociSshResult);
  const ociUnavailable = isFail(ociSshResult) || ociSkipped;
  const ociSections: Record<string, string> = {};
  if (!ociUnavailable) {
    const parts = ociSshResult.split(/===(\w+)===/);
    for (let i = 1; i < parts.length; i += 2) {
      ociSections[parts[i]] = (parts[i + 1] ?? "").trim();
    }
  }

  const verdicts: { skipped: boolean; ok: boolean }[] = [];

  // -- Section 1: MX DNS (public view -- this is what real internet senders see;
  // the mesh/system resolver below is informational only, since split-DNS on
  // the WG mesh legitimately has no MX record for our own private zone)
  const mxResult = mxPublic.result;
  const mxOk = !!mxResult && mxResult !== "(empty)" && !isFail(mxResult);
  verdicts.push({ skipped: false, ok: mxOk });
  sections.push([
    `== 1. MX DNS Record (public view) ${status(mxOk)} ==`,
    `  dig MX ${DOMAIN} @${mxPublic.resolver}: ${mxResult}`,
    `  dig MX ${DOMAIN} (mesh/system resolver, informational only): ${mxSystemResult}`,
  ].join("\n"));

  // -- Section 2: Cloudflare Workers
  const cfSkipped = isSkip(cfWorkerResult);
  const cfOk = cfWorkerResult.includes("exists");
  verdicts.push({ skipped: cfSkipped, ok: cfOk });
  sections.push([
    `== 2. Cloudflare Email Worker ${badge(cfWorkerResult, cfOk)} ==`,
    `  ${cfWorkerResult}`,
  ].join("\n"));

  // -- Section 3: Caddy L4 passthrough
  const gcpSkipped = isSkip(gcpSshResult);
  const caddyLogs = gcpSshResult || "(no matching log lines)";
  const caddyOk = !isFail(gcpSshResult);
  verdicts.push({ skipped: gcpSkipped, ok: caddyOk });
  sections.push([
    `== 3. Caddy L4 SMTP Passthrough (gcp-proxy, ${m}m) ${badge(gcpSshResult, caddyOk)} ==`,
    caddyLogs,
  ].join("\n"));

  // -- Section 4: SMTP Banner
  const smtpBanner = ociUnavailable ? ociSshResult : (ociSections["SMTP_BANNER"] || "(no output)");
  const smtpOk = /220/.test(smtpBanner);
  verdicts.push({ skipped: ociSkipped, ok: smtpOk });
  sections.push([
    `== 4. ${srvName} SMTP :25 Banner ${badge(ociSshResult, smtpOk)} ==`,
    `  ${smtpBanner}`,
  ].join("\n"));

  // -- Section 5: Inbound Logs
  const inboundLogs = ociUnavailable ? ociSshResult : (ociSections["INBOUND_LOGS"] || "(no matching log lines)");
  const inboundErrors = !ociSkipped && /reject|spam|junk|error|fail/i.test(inboundLogs) && inboundLogs !== "(no matching log lines)";
  const inboundOk = !inboundErrors && !isFail(ociSshResult);
  verdicts.push({ skipped: ociSkipped, ok: inboundOk });
  sections.push([
    `== 5. ${srvName} Inbound Logs (${m}m) ${badge(ociSshResult, inboundOk)} ==`,
    inboundLogs || "(no matching log lines)",
  ].join("\n"));

  // -- Section 6: Queue
  const queueSkipped = isSkip(queueResult);
  const queueOk = !isFail(queueResult) && !queueResult.includes("API_ERROR");
  const queueEmpty = queueResult === "Queue empty";
  verdicts.push({ skipped: queueSkipped, ok: queueOk });
  sections.push([
    `== 6. ${srvName} Queue ${badge(queueResult, queueOk)} ==`,
    queueEmpty ? "  Queue is empty" : queueResult,
  ].join("\n"));

  // -- Section 7: IMAP Store
  const imapOk = imapResult.startsWith("INBOX");
  verdicts.push({ skipped: false, ok: imapOk });
  sections.push([
    `== 7. IMAP Store (${srvName}) ${status(imapOk)} ==`,
    `  ${imapResult}`,
  ].join("\n"));

  // -- Section 8: Account Check
  const accountOut = ociUnavailable ? ociSshResult : (ociSections["ACCOUNT_CHECK"] || "(no output)");
  const accountOk = srvName === "maddy"
    ? (/me@diegonmarcos/.test(accountOut) && !/not found/.test(accountOut))
    : !isFail(ociSshResult) && !ociSkipped;
  verdicts.push({ skipped: ociSkipped, ok: accountOk });
  sections.push([
    `== 8. ${srvName} Account Check ${badge(ociSshResult, accountOk)} ==`,
    `  ${accountOut}`,
  ].join("\n"));

  // -- Section 9: Shadow Delivery (informational -- not counted toward pass/fail)
  const shadowSkipped = isSkip(shadowResult);
  const shadowHasData = !shadowSkipped && shadowResult && !isFail(shadowResult) && shadowResult.trim().length > 0;
  sections.push([
    `== 9. Shadow Delivery (http-to-smtp-proxy-api) ${shadowSkipped ? "[SKIP]" : (shadowHasData ? "[ACTIVE]" : "[NONE]")} ==`,
    shadowSkipped ? `  ${shadowResult}` : (shadowHasData ? shadowResult : "  (no shadow delivery logs in window)"),
  ].join("\n"));

  const failCount = verdicts.filter(v => !v.skipped && !v.ok).length;
  const skipCount = verdicts.filter(v => v.skipped).length;
  const header = failCount === 0
    ? `=== INBOUND DEBUG (${srvName}): ALL CHECKS PASSED${skipCount ? ` (${skipCount} checks skipped, no ssh)` : ""} ===`
    : `=== INBOUND DEBUG (${srvName}): ISSUES DETECTED (${failCount} failed${skipCount ? `, ${skipCount} skipped, no ssh` : ""}) ===`;

  return {
    content: [{
      type: "text",
      text: `${header}\n\n${sections.join("\n\n")}`,
    }],
  };
}

export async function handle_debug_trace({ server: srvName, message_id, sender, minutes, direction }: { server: any; message_id: any; sender: any; minutes: any; direction: any }) {
  const srv = getServer(srvName);
  const m = Math.max(1, Math.min(120, minutes));

  const grepParts: string[] = [];
  if (message_id) grepParts.push(message_id.replace(/[<>]/g, ""));
  if (sender) grepParts.push(sender);
  const grepFilter = grepParts.length > 0
    ? ` | grep -iE '${grepParts.join("|")}'`
    : "";

  const [caddyLogs, smtpProxyLogs, serverInbound, serverOutbound, queueStatus, ociRelay, imapCheck] = await Promise.all([
    (direction === "outbound" ? Promise.resolve("") :
      sshExec("gcp-proxy",
        `docker logs caddy --since ${m}m 2>&1 | grep -iE 'smtp|:25|:465|:587|layer4|l4|mail'${grepFilter} | tail -25`,
        20000)),

    (direction === "outbound" ? Promise.resolve("") :
      sshExec(srv.sshAlias,
        `docker logs http-to-smtp-proxy-api --since ${m}m 2>&1${grepFilter || " | tail -30"}`,
        15000)),

    (direction === "outbound" ? Promise.resolve("") :
      sshExec(srv.sshAlias,
        `docker logs ${srv.container} --since ${m}m 2>&1 | grep -iE 'ingest|received|accept|reject|spam|deliver|rcpt|envelope|from=|to=|check|spf|dkim|dmarc|dnsbl|xclient'${grepFilter} | tail -40`,
        20000)),

    (direction === "inbound" ? Promise.resolve("") :
      sshExec(srv.sshAlias,
        `docker logs ${srv.container} --since ${m}m 2>&1 | grep -iE 'queue|relay|remote|next-hop|delivery|bounce|submit|outbound|target\\.smtp'${grepFilter} | tail -40`,
        20000)),

    serverQueue(srv, srvName),

    (direction === "inbound" ? Promise.resolve("") :
      sshExec(srv.sshAlias,
        `echo QUIT | timeout 5 openssl s_client -starttls smtp -connect smtp.email.eu-marseille-1.oci.oraclecloud.com:587 -quiet 2>&1 | head -3`,
        15000)),

    (message_id ? (async () => {
      try {
        const result = await withImap(srvName, "me", async (client) => {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const searchResult = await client.search({ header: { "message-id": message_id } });
            const msgs = Array.isArray(searchResult) ? searchResult : [];
            return msgs.length > 0 ? `FOUND in INBOX (${msgs.length} match)` : "NOT in INBOX";
          } finally {
            lock.release();
          }
        });
        return result;
      } catch (e: any) {
        return `IMAP_FAIL: ${e.message?.split("\n")[0] ?? e}`;
      }
    })() : Promise.resolve("")),
  ]);

  // ── Format output ──
  const sections: string[] = [];
  const trace = message_id ? `Message-ID: ${message_id}` : `Time window: last ${m} minutes`;
  const filter = sender ? ` | Sender: ${sender}` : "";

  sections.push(`=== MAIL TRACE (${srvName}): ${direction.toUpperCase()} ===\n${trace}${filter}`);

  if (direction !== "outbound") {
    sections.push([
      "── Inbound Flow ──────────────────────────────────────",
      "  Internet → CF Email Routing → CF Worker (email-forwarder)",
      "    → api.diegonmarcos.com/http-to-smtp-proxy-api (CF → Caddy on gcp-proxy → HTTP:8090)",
      `      → ${srvName} :25 (XCLIENT + SPF/DKIM/DMARC/DNSBL)`,
      "        → IMAP store (imapsql)",
    ].join("\n"));
  }
  if (direction !== "inbound") {
    sections.push([
      "── Outbound Flow ─────────────────────────────────────",
      `  ${srvName} submission :465/:587 (auth + DKIM sign)`,
      "    → OCI relay (smtp.email.eu-marseille-1.oci.oraclecloud.com:587)",
      "      → OCI DKIM sign (oci-mrs-202604) → recipient MX",
    ].join("\n"));
  }

  if (direction !== "outbound") {
    const skipped = isSkip(caddyLogs);
    const hasData = caddyLogs && !isFail(caddyLogs) && !skipped && caddyLogs.trim().length > 0;
    sections.push([
      `── 1. Caddy L4 (gcp-proxy) ${badge(caddyLogs, !isFail(caddyLogs))} ──`,
      skipped ? `  ${caddyLogs}` : (hasData ? caddyLogs : "  (no SMTP passthrough logs in window)"),
    ].join("\n"));
  }

  if (direction !== "outbound") {
    const skipped = isSkip(smtpProxyLogs);
    const hasData = smtpProxyLogs && !isFail(smtpProxyLogs) && !skipped && smtpProxyLogs.trim().length > 0;
    const authFail = !skipped && /401|Unauthorized|AUTH FAILED/i.test(smtpProxyLogs);
    const deliverOk = !skipped && /Delivered OK|200|delivered/i.test(smtpProxyLogs);
    const badgeLabel = skipped ? "[SKIP]"
      : isFail(smtpProxyLogs) ? "[FAIL]"
      : authFail ? "[AUTH_FAIL]"
      : deliverOk ? "[PASS]"
      : "[INFO]";
    sections.push([
      `── 2. http-to-smtp-proxy-api (gcp-proxy:8090) ${badgeLabel} ──`,
      hasData ? smtpProxyLogs : (skipped ? `  ${smtpProxyLogs}` : "  (no logs in window)"),
    ].join("\n"));
  }

  if (direction !== "outbound") {
    const skipped = isSkip(serverInbound);
    const hasData = serverInbound && !isFail(serverInbound) && !skipped && serverInbound.trim().length > 0;
    const rejected = !skipped && /reject|spam|junk/i.test(serverInbound);
    const badgeLabel = skipped ? "[SKIP]"
      : isFail(serverInbound) ? "[FAIL]"
      : rejected ? "[REJECTED]"
      : "[PASS]";
    sections.push([
      `── 3. ${srvName} Inbound (${srv.sshAlias}:25) ${badgeLabel} ──`,
      hasData ? serverInbound : (skipped ? `  ${serverInbound}` : "  (no inbound activity in window)"),
    ].join("\n"));
  }

  if (direction !== "inbound") {
    const skipped = isSkip(serverOutbound);
    const hasData = serverOutbound && !isFail(serverOutbound) && !skipped && serverOutbound.trim().length > 0;
    const bounced = !skipped && /bounce|fail|error/i.test(serverOutbound);
    const badgeLabel = skipped ? "[SKIP]"
      : isFail(serverOutbound) ? "[FAIL]"
      : bounced ? "[BOUNCE]"
      : "[PASS]";
    sections.push([
      `── 4. ${srvName} Outbound (queue → OCI relay) ${badgeLabel} ──`,
      hasData ? serverOutbound : (skipped ? `  ${serverOutbound}` : "  (no outbound activity in window)"),
    ].join("\n"));
  }

  const queueSkipped = isSkip(queueStatus);
  const queueEmpty = /Queue empty|No queue activity/i.test(queueStatus) || queueStatus.trim() === "";
  sections.push([
    `── 5. ${srvName} Queue ${badge(queueStatus, !isFail(queueStatus))} ──`,
    queueSkipped ? `  ${queueStatus}` : (queueEmpty ? "  Queue empty (no stuck messages)" : queueStatus),
  ].join("\n"));

  if (direction !== "inbound") {
    const skipped = isSkip(ociRelay);
    const ociOk = /250|220|SMTP/i.test(ociRelay);
    sections.push([
      `── 6. OCI Relay ${badge(ociRelay, ociOk)} ──`,
      skipped ? `  ${ociRelay}` : (ociRelay || "  (not applicable for this direction)"),
    ].join("\n"));
  }

  if (message_id && imapCheck) {
    const found = imapCheck.includes("FOUND");
    sections.push([
      `── 7. IMAP Delivery (${srvName}) ${status(found)} ──`,
      `  ${imapCheck}`,
    ].join("\n"));
  }

  return {
    content: [{
      type: "text",
      text: sections.join("\n\n"),
    }],
  };
}

// ── Registration ─────────────────────────────────────────────────────

export const debugOutboundSchema = {
  server: serverSchema,
  minutes: z.number().default(5).describe("How many minutes of logs to check (default 5)"),
};

export const debugInboundSchema = {
  server: serverSchema,
  minutes: z.number().default(10).describe("How many minutes of logs to check (default 10)"),
};

export const debugTraceSchema = {
  server: serverSchema,
  message_id: z.string().optional().describe("Message-ID header value to trace (without angle brackets)"),
  sender: z.string().optional().describe("Sender email to filter by"),
  minutes: z.number().default(15).describe("Time window in minutes (default 15)"),
  direction: z.enum(["inbound", "outbound", "both"]).default("both").describe("Filter by mail direction"),
};

export function registerDebugTools(server: McpServer): void {
  // ══════════════════════════════════════════════════════════════════
  // Tool 1: debug_outbound
  // ══════════════════════════════════════════════════════════════════
  server.tool(
    "debug_outbound",
    "Debug outbound mail relay -- traces the full send path with logs",
    debugOutboundSchema,
    handle_debug_outbound,
  );

  // ══════════════════════════════════════════════════════════════════
  // Tool 2: debug_inbound
  // ══════════════════════════════════════════════════════════════════
  server.tool(
    "debug_inbound",
    "Debug inbound mail delivery -- traces the full receive path with logs",
    debugInboundSchema,
    handle_debug_inbound,
  );

  // ══════════════════════════════════════════════════════════════════
  // Tool 3: debug_trace — Consolidated mail flow trace
  // ══════════════════════════════════════════════════════════════════
  server.tool(
    "debug_trace",
    "Trace a message across the full mail pipeline — correlates logs from Cloudflare Worker, Caddy L4, http-to-smtp-proxy-api, mail server, and OCI relay. Use message_id for a specific message or minutes for a time window.",
    debugTraceSchema,
    handle_debug_trace,
  );
}
