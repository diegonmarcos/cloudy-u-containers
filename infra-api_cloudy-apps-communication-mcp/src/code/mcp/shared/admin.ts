import { exec as execCb } from "child_process";
import { promisify } from "util";
import { getServer } from "./config.js";
import { doFetch } from "./jmap.js";

const execAsync = promisify(execCb);

// All connection detail (hostname 10.0.0.3 over the WG mesh, user, identity
// file) lives in the ssh config that ssh-keys.nix writes to
// /opt/ssh-keys/<container>/, bind-mounted read-only at /root/.ssh by
// compose.nix. Without that mount the alias is not just keyless, it is
// unknown, and ssh fails with "Could not resolve hostname oci-mail" — which
// reads like a DNS/mesh outage instead of a missing config file.
//
// That mount is read-only, so the config's `StrictHostKeyChecking accept-new`
// accepts the host key but cannot append it and warns on every single
// connection; the warning lands on stderr and gets spliced into MCP tool
// output. Pinning UserKnownHostsFile to /dev/null with LogLevel=ERROR drops
// that noise while keeping real failures (auth, timeout). Same options as
// cloud-infra-mcp's shared/libs/ssh.ts.
const SSH_OPTS = [
  "-o BatchMode=yes",
  "-o UserKnownHostsFile=/dev/null",
  "-o LogLevel=ERROR",
  "-o ConnectTimeout=10",
].join(" ");

async function sshDockerExec(sshAlias: string, container: string, cmd: string): Promise<string> {
  const { stdout } = await execAsync(
    `ssh ${SSH_OPTS} ${sshAlias} 'docker exec ${container} ${cmd}'`,
    { timeout: 15000 },
  );
  return stdout.trim();
}

// Stalwart v0.16.5 has NO REST management API. Verified against the running
// build on 10.0.0.3:2443: /api/account/status answers (401 anon, 200 with a
// valid user) but /api/principal and /api/settings/list are 404 for BOTH
// anonymous and authenticated requests — the /admin/ bundle it ships is a
// self-service account portal, not the classic management console. There is
// no config key, listener or role that turns those routes on; they are not
// compiled into this build.
//
// The management surface that DOES exist is JMAP: POST /jmap/ with the
// `urn:stalwart:jmap` capability and `x:<Type>/get|set` methods. Confirmed
// live: x:Account, x:Domain, x:Tenant, x:AllowedIp, x:MtaRoute,
// x:MtaInboundThrottle all answer; x:Principal returns `unknownMethod`. This
// is the same channel the service's own configs/activate.sh already uses for
// allowed-ip and throttle upserts.
//
// Admin-ness is a property of the account object, not of a separate principal:
// `roles: {"@type": "Admin"}`. me@diegonmarcos.com carries it; the previously
// configured admin@diegonmarcos.com does not exist in Stalwart's store at all
// (it is a maddy-only account), which is why it 401'd.
export async function stalwartRegistryGet(type: string): Promise<any[]> {
  // The registry lives on the JMAP origin; compose.nix pins STALWART_ADMIN_URL
  // to it. Fall back to the JMAP URL so a stdio/dev run without that env var
  // still targets a reachable port instead of defaulting to :443, where
  // oci-mail listens on nothing.
  const srv = getServer("stalwart");
  const baseUrl = srv.adminUrl ?? srv.jmap;
  const user = process.env.STALWART_ADMIN_USER;
  const pass = process.env.STALWART_ADMIN_PASSWORD;
  if (!baseUrl || !user || !pass) throw new Error("STALWART_ADMIN_URL/USER/PASSWORD not set");
  const auth = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  // Bare fetch() throws an opaque "fetch failed" TypeError for every transport
  // error — ECONNREFUSED, TLS, DNS all look identical. doFetch surfaces
  // err.cause; keep it so the next transport break names itself.
  const sessionUrl = new URL("/jmap/session", baseUrl).toString();
  const sres = await doFetch(sessionUrl, { headers: { Authorization: auth } }, "Stalwart admin session");
  if (!sres.ok) {
    const hint = sres.status === 401
      ? " — STALWART_ADMIN_USER must be an account that exists in Stalwart's own store with roles.@type = Admin"
      : "";
    throw new Error(`Stalwart admin session ${sres.status} for ${sessionUrl}${hint}: ${await sres.text()}`);
  }
  const session = await sres.json();
  // Absence of urn:stalwart:jmap in primaryAccounts is exactly how a non-admin
  // account presents — it authenticates fine and then sees no registry.
  const accountId = session?.primaryAccounts?.["urn:stalwart:jmap"];
  if (!accountId) {
    throw new Error(
      `Stalwart account ${user} has no urn:stalwart:jmap primary account — it is not an admin (roles.@type must be Admin)`,
    );
  }

  const apiUrl = session?.apiUrl ?? new URL("/jmap/", baseUrl).toString();
  const res = await doFetch(apiUrl, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
      methodCalls: [[`x:${type}/get`, { accountId, ids: null }, "0"]],
    }),
  }, "Stalwart admin registry");
  if (!res.ok) throw new Error(`Stalwart admin registry ${res.status} for ${apiUrl}: ${await res.text()}`);
  const body = await res.json();
  const [name, payload] = body?.methodResponses?.[0] ?? [];
  // An unknown x: type comes back as a normal 200 with an "error" response —
  // report it instead of rendering an empty list as an answer.
  if (name === "error") throw new Error(`Stalwart x:${type}/get failed: ${JSON.stringify(payload)}`);
  return payload?.list ?? [];
}

export async function listAccounts(server: string): Promise<string[]> {
  const srv = getServer(server);
  if (server === "maddy") {
    const out = await sshDockerExec(srv.sshAlias, srv.container, "maddy creds list");
    return out.split("\n").filter(Boolean);
  }
  if (server === "stalwart") {
    const items = await stalwartRegistryGet("Account");
    return items.map((a: any) => a.emailAddress ?? a.name);
  }
  throw new Error(`listAccounts not supported for ${server}`);
}

export async function listDomains(server: string): Promise<string[]> {
  if (server === "maddy") return ["diegonmarcos.com"];
  if (server === "stalwart") {
    const items = await stalwartRegistryGet("Domain");
    return items.map((d: any) => d.name);
  }
  throw new Error(`listDomains not supported for ${server}`);
}
