// JMAP submission client for Stalwart (RFC 8620 core + RFC 8621 mail).
//
// Sending over JMAP instead of SMTP: discover the session, resolve the Drafts
// + Sent mailboxes and the submission identity, create the message in Drafts,
// then EmailSubmission/set with onSuccessUpdateEmail to deliver it and move it
// to Sent (clearing $draft). All HTTP — fetch()/undici resolves the host via
// dns.lookup, which honors the container's /etc/hosts extra_hosts pin
// (jmap.diegonmarcos.com -> oci-mail WG IP), so no SMTP/nodemailer DNS quirk.
import { getServer, getAccount } from "./config.js";

export interface JmapSendMsg {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  html?: string;
}

interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

const CAPS = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:submission",
];

function authHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

// fetch() throws an opaque "fetch failed" TypeError on transport errors
// (TLS, ECONNREFUSED, DNS); the real reason lives in err.cause. Surface it.
export async function doFetch(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    const c: any = (e as any)?.cause;
    const detail = c ? ` (cause: ${c.code ?? c.reason ?? c.message ?? JSON.stringify(c)})` : "";
    throw new Error(`${what} (${url}): ${(e as Error).message}${detail}`);
  }
}

function addrList(s?: string): { email: string }[] | undefined {
  if (!s) return undefined;
  const list = s.split(",").map((e) => ({ email: e.trim() })).filter((a) => a.email);
  return list.length ? list : undefined;
}

async function jmapPost(apiUrl: string, auth: string, methodCalls: unknown[]): Promise<any> {
  const res = await doFetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({ using: CAPS, methodCalls }),
  }, "JMAP POST");
  if (!res.ok) throw new Error(`JMAP POST ${res.status}: ${await res.text()}`);
  return res.json();
}

// Sends via Stalwart JMAP. `account` selects the credentials (e.g. "me").
// Returns the created Email id (or "(submitted)" if the server omits it).
export async function sendViaJmap(account: string, msg: JmapSendMsg): Promise<string> {
  const srv = getServer("stalwart");
  const creds = getAccount("stalwart", account);
  if (!srv.jmap) throw new Error("STALWART_JMAP_URL not configured");
  const auth = authHeader(creds.user, creds.password);

  // 1. Session discovery. Stalwart's /.well-known/jmap is a 307 redirect to
  //    /jmap/session; hit the session resource directly to avoid depending on
  //    redirect-following (and any auth-header stripping across the hop).
  const sessionUrl = new URL("/jmap/session", srv.jmap).toString();
  const sres = await doFetch(sessionUrl, { headers: { Authorization: auth } }, "JMAP session");
  if (!sres.ok) throw new Error(`JMAP session ${sres.status}: ${await sres.text()}`);
  const session = (await sres.json()) as JmapSession;
  const accountId = session.primaryAccounts?.["urn:ietf:params:jmap:mail"];
  if (!accountId) throw new Error("JMAP: no primary mail account in session");
  // Stalwart advertises its PUBLIC apiUrl (port 443 via the Caddy edge), but we
  // connect WG-direct to oci-mail where Stalwart serves on :2443. Rebase the
  // advertised apiUrl PATH onto the configured STALWART_JMAP_URL origin so the
  // POST hits the reachable backend port, not the public edge (→ ECONNREFUSED).
  const base = new URL(srv.jmap);
  const adv = new URL(session.apiUrl, base);
  const apiUrl = base.origin + adv.pathname + adv.search;

  // 2. Resolve Drafts + Sent mailboxes and the submission identity.
  const lookup = await jmapPost(apiUrl, auth, [
    ["Mailbox/get", { accountId, properties: ["id", "role"] }, "m"],
    ["Identity/get", { accountId }, "i"],
  ]);
  const mailboxes = (lookup.methodResponses?.[0]?.[1]?.list ?? []) as { id: string; role: string | null }[];
  const draftsId = mailboxes.find((b) => b.role === "drafts")?.id;
  const sentId = mailboxes.find((b) => b.role === "sent")?.id;
  if (!draftsId || !sentId) throw new Error(`JMAP: missing mailbox (drafts=${draftsId}, sent=${sentId})`);
  const identities = (lookup.methodResponses?.[1]?.[1]?.list ?? []) as { id: string; email: string }[];
  const identity = identities.find((i) => i.email.toLowerCase() === creds.user.toLowerCase()) ?? identities[0];
  if (!identity) throw new Error(`JMAP: no submission identity for ${creds.user}`);

  // 3. Create the draft, submit it, and move it to Sent on success.
  const to = addrList(msg.to);
  if (!to) throw new Error("JMAP: no recipients");
  const cc = addrList(msg.cc);
  const bcc = addrList(msg.bcc);
  const rcptTo = [...to, ...(cc ?? []), ...(bcc ?? [])];

  const bodyValues: Record<string, { value: string }> = { text: { value: msg.body } };
  let bodyStructure: Record<string, unknown>;
  if (msg.html) {
    bodyValues.html = { value: msg.html };
    bodyStructure = {
      type: "multipart/alternative",
      subParts: [
        { type: "text/plain", partId: "text" },
        { type: "text/html", partId: "html" },
      ],
    };
  } else {
    bodyStructure = { type: "text/plain", partId: "text" };
  }

  const email: Record<string, unknown> = {
    mailboxIds: { [draftsId]: true },
    keywords: { $draft: true, $seen: true },
    from: [{ email: creds.user }],
    to,
    subject: msg.subject,
    bodyValues,
    bodyStructure,
  };
  if (cc) email.cc = cc;
  if (bcc) email.bcc = bcc;

  const result = await jmapPost(apiUrl, auth, [
    ["Email/set", { accountId, create: { draft: email } }, "c1"],
    ["EmailSubmission/set", {
      accountId,
      onSuccessUpdateEmail: {
        "#sub": {
          [`mailboxIds/${draftsId}`]: null,
          [`mailboxIds/${sentId}`]: true,
          "keywords/$draft": null,
        },
      },
      create: {
        sub: {
          emailId: "#draft",
          identityId: identity.id,
          envelope: { mailFrom: { email: creds.user }, rcptTo },
        },
      },
    }, "c2"],
  ]);

  const emailResp = result.methodResponses?.[0]?.[1] ?? {};
  const subResp = result.methodResponses?.[1]?.[1] ?? {};
  if (emailResp.notCreated?.draft) throw new Error(`Email/set failed: ${JSON.stringify(emailResp.notCreated.draft)}`);
  if (subResp.notCreated?.sub) throw new Error(`EmailSubmission/set failed: ${JSON.stringify(subResp.notCreated.sub)}`);
  return emailResp.created?.draft?.id ?? "(submitted)";
}
