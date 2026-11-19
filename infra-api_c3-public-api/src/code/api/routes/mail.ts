// POST /mail/http-to-smtp — Bearer-gated.
//
// Replicates the EXACT request contract of the legacy Rust binary at
// a_solutions/aa-sui_tools-http-to-smtp-proxy-api/src/code/main.rs so the
// Cloudflare email-forwarder Worker can be repointed at this listener with
// zero code change.
//
// Wire format (from Rust binary):
//   - Method: POST /
//   - Body  : raw RFC 5322 message bytes (NOT JSON). Optionally wrapped
//             in `{ "raw": "<base64>" }` if Content-Type is application/json
//             — CF Workers historically posted both shapes.
//   - Headers honoured:
//       cf-connecting-ip      — client IP (kept for logs only here; Caddy
//                               already validates upstream via Bearer)
//       x-original-to         — envelope RCPT TO (prefer over header To:)
//       x-api-key             — Bearer is enforced upstream; ignored here
//   - Response: { status, from, to } on 200; { status:"error", error } on
//               4xx/5xx.
//
// Delivery:
//   - SMTP plain (port 25) to maddy on wg0 — MX-style relay. Maddy's own
//     dual-write relays every local delivery to stalwart:2025, so JMAP
//     clients see the same mail — do NOT add a second stalwart leg here
//     (it would duplicate every message; no dedup exists in Stalwart).
//   - #1811 parallel fan-out: with `X-Mail-Target: maddy-direct` the message
//     goes to maddy's :2526 listener (stores in maddy, NO Stalwart mirror) and
//     with `X-Mail-Target: stalwart` to Stalwart's SMTP ingest :2025. The CF
//     Worker calls both in parallel next to its Gmail import, so all three
//     stores receive the message at the same time. No header keeps the
//     behaviour above (maddy:25 with the mirror) for every other caller.
//
// We do NOT replicate the Rust DNSBL / SPF / rDNS checks here — those were
// always WARN-only on the proxy hop (the connecting IP is Cloudflare, not
// the real sender) and Maddy + Stalwart handle real alignment downstream.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "../../shared/config.js";
import { authPlugin } from "../plugins/auth.js";
import { DECLARED_TARGETS, pickTarget } from "../../shared/mail-target.js";
import { createDeliveryLedger, ledgerKey } from "../../shared/delivery-ledger.js";

const jsonWrapperSchema = z.object({
  raw: z.string().min(1),
});

function extractHeader(body: Buffer, name: string): string | null {
  const text = body.toString("utf8");
  const headerEnd = (() => {
    const a = text.indexOf("\r\n\r\n");
    if (a >= 0) return a;
    return text.indexOf("\n\n");
  })();
  const section = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const target = name.toLowerCase() + ":";
  const lines = section.split(/\r?\n/);
  let found = false;
  let value = "";
  for (const line of lines) {
    if (found) {
      if (line.startsWith(" ") || line.startsWith("\t")) {
        value += " " + line.trim();
      } else {
        break;
      }
    } else if (line.toLowerCase().startsWith(target)) {
      value = line.slice(name.length + 1).trim();
      found = true;
    }
  }
  return found ? value : null;
}

function extractAddress(body: Buffer, name: string): string | null {
  const raw = extractHeader(body, name);
  if (!raw) return null;
  const start = raw.lastIndexOf("<");
  const end = raw.lastIndexOf(">");
  if (start >= 0 && end > start) {
    return raw.slice(start + 1, end);
  }
  return raw;
}

function decodeBody(req: FastifyRequest): Buffer {
  const body = req.body;
  // JSON wrapper { raw: "<base64>" } — CF Worker sometimes wraps for transit.
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    const parsed = jsonWrapperSchema.safeParse(body);
    if (parsed.success) {
      return Buffer.from(parsed.data.raw, "base64");
    }
    throw new Error("Invalid JSON body: expected { raw: <base64> }");
  }
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  throw new Error("Missing or unsupported body");
}

export async function registerMail(app: FastifyInstance, cfg: AppConfig) {
  // #1819: one SMTP session per (target, Message-ID, rcpt), however often the
  // Worker retries; see shared/delivery-ledger.ts.
  const ledger = createDeliveryLedger(cfg.limits.dedupe_ttl_ms);
  await app.register(async (scope) => {
    // Bearer gate scoped to /mail/* only.
    await scope.register(authPlugin);

    scope.post("/http-to-smtp", async (req: FastifyRequest, reply: FastifyReply) => {
      const reqId = Math.floor(Math.random() * 0xffff_ffff);
      const clientIp =
        (req.headers["cf-connecting-ip"] as string | undefined) ??
        (typeof req.headers["x-forwarded-for"] === "string"
          ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
          : undefined) ??
        req.ip ??
        "unknown";

      req.log.info({ req: reqId, client_ip: clientIp, bytes: req.headers["content-length"] }, "request.start");

      let raw: Buffer;
      try {
        raw = decodeBody(req);
      } catch (e) {
        req.log.warn({ req: reqId, err: (e as Error).message }, "request.bad_body");
        return reply.code(400).send({ status: "error", error: (e as Error).message });
      }

      const mailFrom = extractAddress(raw, "From") ?? "cloudflare@localhost";
      const originalTo = req.headers["x-original-to"];
      const mailTo =
        (typeof originalTo === "string" ? originalTo : null) ??
        extractAddress(raw, "To") ??
        cfg.mail.defaultUser;
      const msgId = extractHeader(raw, "Message-ID") ?? "?";

      req.log.info({ req: reqId, from: mailFrom, to: mailTo, msg_id: msgId, client_ip: clientIp }, "request.parsed");

      const pick = pickTarget(req.headers["x-mail-target"], cfg.mail, DECLARED_TARGETS);
      if (!pick.ok) {
        req.log.warn({ req: reqId, msg_id: msgId, err: pick.error }, "request.bad_target");
        return reply.code(pick.code).send({ status: "error", error: pick.error });
      }

      // ── Delivery (plain SMTP over WG to the picked store) ──
      // Named targets are always plaintext over WG (WG encrypts; maddy's own
      // stalwart_relay to :2025 uses `starttls no` for the same reason, and
      // Stalwart's cert does not validate against the WG IP).
      // The SMTP session runs on smtp_timeout_ms (long: a slow store still
      // gets the message); the HTTP answer waits at most request_timeout_ms.
      const send = async () => {
        const primary = nodemailer.createTransport({
          host: pick.host,
          port: pick.port,
          secure: false,
          ignoreTLS: pick.port === 25 || req.headers["x-mail-target"] !== undefined, // pure plaintext for MX-style hop
          requireTLS: false,
          name: cfg.mail.heloDomain,
          connectionTimeout: cfg.limits.smtp_timeout_ms,
          greetingTimeout: cfg.limits.smtp_timeout_ms,
          socketTimeout: cfg.limits.smtp_timeout_ms,
        });
        try {
          await primary.sendMail({
            envelope: { from: mailFrom, to: [mailTo] },
            raw, // nodemailer accepts a Buffer for raw RFC 5322 messages
          });
          req.log.info({ req: reqId, msg_id: msgId, from: mailFrom, to: mailTo, target: pick.name }, "smtp.delivered");
        } catch (err) {
          req.log.error({ req: reqId, err: (err as Error).message, msg_id: msgId, target: pick.name }, "smtp.delivery_failed");
          throw err;
        } finally {
          primary.close();
        }
      };

      const r = await ledger.deliver(ledgerKey(pick.name, msgId, mailTo), send, cfg.limits.request_timeout_ms);
      if (r.state === "pending") {
        req.log.warn({ req: reqId, msg_id: msgId, target: pick.name, joined: r.joined }, "smtp.pending");
        return reply.code(504).send({ status: "pending", error: "delivery still in progress; retry joins it", target: pick.name });
      }
      if (r.state === "failed") {
        return reply.code(500).send({ status: "error", error: r.error });
      }
      if (r.deduped) req.log.info({ req: reqId, msg_id: msgId, target: pick.name }, "smtp.deduped");
      return reply.code(200).send({ status: "delivered", from: mailFrom, to: mailTo, target: pick.name, deduped: r.deduped });
    });
  }, { prefix: "/mail" });
}
