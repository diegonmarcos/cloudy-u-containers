import nodemailer from "nodemailer";
import { getServer, getAccount } from "./config.js";

export function getTransport(server: string, account: string): nodemailer.Transporter {
  const srv = getServer(server);
  const creds = getAccount(server, account);

  return nodemailer.createTransport({
    // Connect by IP when smtpHost is set (bypasses nodemailer's dns.resolve(),
    // which ignores /etc/hosts); otherwise fall back to the hostname.
    host: srv.smtpHost ?? srv.host,
    port: srv.smtp,
    secure: true,
    auth: { user: creds.user, pass: creds.password },
    // Keep TLS SNI + cert verification on the public hostname — the cert is
    // issued for `host`, not the WG IP we connect to.
    ...(srv.smtpHost ? { tls: { servername: srv.host } } : {}),
  });
}
