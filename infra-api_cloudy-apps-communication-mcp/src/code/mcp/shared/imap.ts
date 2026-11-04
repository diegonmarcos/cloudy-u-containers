import { ImapFlow } from "imapflow";
import { getServer, getAccount } from "./config.js";

export async function withImap<T>(
  server: string,
  account: string,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const srv = getServer(server);
  const creds = getAccount(server, account);

  const client = new ImapFlow({
    host: srv.host,
    port: srv.imap,
    secure: true,
    // Internal WG endpoints (e.g. Stalwart) present a self-signed cert that
    // doesn't match the connect hostname; the WG tunnel already encrypts the
    // link, so skip cert-hostname verification for those flagged servers.
    ...(srv.tlsInsecure ? { tls: { rejectUnauthorized: false } } : {}),
    auth: { user: creds.user, pass: creds.password },
    logger: false,
    // Without these, an unreachable IMAP host hangs on the OS TCP timeout
    // (minutes) and the caller just sees the tool never return. A stalled
    // reconciliation that never reports is worse than one that fails loudly.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 60000,
  });

  await client.connect();
  try {
    return await fn(client);
  } finally {
    // logout() must never mask the real error: if fn() threw, a logout that
    // also throws would replace the useful exception with a teardown one.
    // ponytail: no reconnect/retry here — the caller retries the tool call.
    await client.logout().catch(() => {});
  }
}
