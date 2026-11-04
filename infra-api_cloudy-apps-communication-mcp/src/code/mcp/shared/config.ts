import { z } from "zod";

export interface ServerConfig {
  host: string;
  // Optional IP to connect SMTP to, bypassing DNS. nodemailer resolves `host`
  // via dns.resolve() (querying the configured resolver — Hickory at 10.0.0.1,
  // which wildcard-returns the public edge), ignoring /etc/hosts, so the
  // compose `extra_hosts` pin cannot take effect. Connecting by IP avoids
  // resolution entirely; TLS SNI/cert verification still uses `host`.
  smtpHost?: string;
  imap: number;
  smtp: number;
  jmap?: string;
  adminUrl?: string;
  sshAlias: string;
  container: string;
  // Skip TLS cert-hostname verification for this server's IMAP connection.
  // Set for servers reached over the trusted WG mesh that present a cert not
  // matching the connect hostname — e.g. Stalwart, which serves a self-signed
  // apex cert on its internal listener (its JMAP-store cert isn't selected for
  // SNI in v0.16), so `jmap.diegonmarcos.com` never validates. The connection
  // is already inside the encrypted WG tunnel, so hostname verification here is
  // belt-and-suspenders; disabling it for the internal endpoint is safe.
  tlsInsecure?: boolean;
}

export interface AccountCredentials {
  user: string;
  password: string;
}

export const DOMAIN = "diegonmarcos.com";

const SERVERS: Record<string, ServerConfig> = {
  maddy: {
    host: process.env.MADDY_HOST ?? "mail.diegonmarcos.com",
    smtpHost: process.env.MADDY_SMTP_IP,
    imap: parseInt(process.env.MADDY_IMAP_PORT ?? "993"),
    smtp: parseInt(process.env.MADDY_SMTP_PORT ?? "465"),
    sshAlias: "oci-mail",
    container: "maddy",
  },
  stalwart: {
    host: process.env.STALWART_HOST ?? "jmap.diegonmarcos.com",
    smtpHost: process.env.STALWART_SMTP_IP,
    imap: parseInt(process.env.STALWART_IMAP_PORT ?? "2993"),
    smtp: parseInt(process.env.STALWART_SMTP_PORT ?? "2465"),
    jmap: process.env.STALWART_JMAP_URL ?? "https://jmap.diegonmarcos.com:2443",
    adminUrl: process.env.STALWART_ADMIN_URL,
    sshAlias: "oci-mail",
    container: "stalwart",
    // Internal WG endpoint serving a self-signed apex cert — env-overridable.
    tlsInsecure: (process.env.STALWART_TLS_INSECURE ?? "true") === "true",
  },
};

export function getServer(name: string): ServerConfig {
  const srv = SERVERS[name];
  if (!srv) throw new Error(`Unknown server: ${name}. Available: ${Object.keys(SERVERS).join(", ")}`);
  return srv;
}

export function getAccount(server: string, account: string): AccountCredentials {
  const prefix = server.toUpperCase();
  const suffix = account.toUpperCase();

  const user = process.env[`${prefix}_${suffix}_USER`];
  const password = process.env[`${prefix}_${suffix}_PASSWORD`];
  if (user && password) return { user, password };

  // Backward compat: maddy + me falls back to MAIL_USER/MAIL_PASSWORD
  if (server === "maddy" && account === "me") {
    const fallbackUser = process.env.MAIL_USER;
    const fallbackPass = process.env.MAIL_PASSWORD;
    if (fallbackUser && fallbackPass) return { user: fallbackUser, password: fallbackPass };
  }

  throw new Error(`No credentials for ${server}/${account}. Set ${prefix}_${suffix}_USER and ${prefix}_${suffix}_PASSWORD`);
}

export function listServers(): string[] {
  return Object.keys(SERVERS);
}

export function listConfiguredAccounts(server: string): string[] {
  const prefix = server.toUpperCase();
  const accounts: string[] = [];
  for (const suffix of ["ME", "NOREPLY", "ADMIN"]) {
    if (process.env[`${prefix}_${suffix}_USER`]) accounts.push(suffix.toLowerCase());
  }
  if (server === "maddy" && accounts.length === 0 && process.env.MAIL_USER) {
    accounts.push("me");
  }
  return accounts;
}

export const serverSchema = z.enum(["maddy", "stalwart"]).default("maddy").describe("Mail server");
export const accountSchema = z.enum(["me", "noreply", "admin"]).default("me").describe("Account");
