import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { mkdir, chmod, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// ── /fleet/profile — one install, one document ──────────────────────────────
//
// The fleet operator's out-of-band contact channel: when the update chain
// breaks, this is the only way to reach a user. Contract (authoritative):
// cloud-u-android/aa_cloud-superapp/docs/profile-sync-contract.md
//
// DELIBERATELY NOT /public/events/:app. That ingest is unauthenticated, appends
// to <app>-events.jsonl, and FANS OUT TO NTFY — routing a profile through it
// would push names, emails and phone numbers into push notifications. This
// route is record-oriented instead: one install is one file, so erasure is an
// unlink rather than a log rewrite.
//
// TWO INDEPENDENT AUTH LAYERS, both required:
//  1. Reaching the route at all — plugins/auth.ts admits mesh requests, and
//     api.diegonmarcos.com is mesh-only (no public certificate is served for
//     that name at the edge). Every fleet device is a WireGuard member, so
//     mesh membership is the network authentication boundary. This path is
//     NOT in build.json proxy.primary.public_paths and must never be added
//     there — that would punch a PII write endpoint through the Authelia gate.
//  2. Touching a specific record — the per-install secret below. Mesh
//     membership alone must not let one device read or erase another's
//     profile, so every read/replace/delete of an EXISTING record verifies it.
//
// PII HYGIENE: never log a profile field. Every log line here carries the
// install id, a byte count and a status — nothing from `profile`.

const PROFILES_DIR = process.env.FLEET_PROFILES_DIR ?? "/app/data/fleet-profiles";
const MAX_BODY_BYTES = 64 * 1024; // contract: 413 over 64 KB

// Contract suggests 10/min per install id, mirroring publicLogs' per-app limiter.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function withinRateLimit(installId: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(installId);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(installId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

/**
 * The install id becomes a FILENAME, so this is a path-traversal boundary, not
 * a formatting nicety. Allowlist only — a rejected id is a 400, never a
 * sanitised-and-accepted one, because silently rewriting an identifier would
 * let two distinct devices collide on one record.
 */
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Client generates 32 hex chars; bounded generously but never empty. */
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;

interface StoredRecord {
  salt: string;
  secret_hash: string;
  created_at: string;
  updated_at: string;
  document: unknown;
}

function hashSecret(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, (err, derived) => (err ? reject(err) : resolve(derived)));
  });
}

/** Constant-time compare that cannot throw on a length mismatch. */
function secretMatches(expectedHex: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedHex, "hex");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function recordPath(installId: string): string {
  return join(PROFILES_DIR, `${installId}.json`);
}

async function readRecord(installId: string): Promise<StoredRecord | null> {
  try {
    return JSON.parse(await readFile(recordPath(installId), "utf8")) as StoredRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Docker pre-creates a volume mountpoint as 0755 before the process starts, so
 * mkdir's `mode` is a no-op on the very path that matters here. chmod
 * unconditionally instead: the file mode 0600 already protects the contents,
 * but a listable directory leaks the set of install ids, and those are
 * per-person identifiers. Done once, not per write.
 */
let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  dirReady ??= (async () => {
    await mkdir(PROFILES_DIR, { recursive: true, mode: 0o700 });
    await chmod(PROFILES_DIR, 0o700);
  })().catch((err) => {
    dirReady = null; // let a transient failure be retried on the next write
    throw err;
  });
  return dirReady;
}

/**
 * Write via temp file + rename so a crash mid-write cannot leave a truncated
 * record — a half-written profile would be an unreadable contact channel,
 * which is the one thing this route exists to prevent.
 */
async function writeRecord(installId: string, record: StoredRecord): Promise<void> {
  await ensureDir();
  const target = recordPath(installId);
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

type Identity = { installId: string; secret: string };

/** Headers only — identity never travels in the path or query string, so it
 *  stays out of Caddy/Fastify access logs and a deletion request stays
 *  honourable. Do not add an :installId path parameter later. */
function readIdentity(req: FastifyRequest): Identity | null {
  const installId = String(req.headers["x-install-id"] ?? "");
  const auth = String(req.headers["authorization"] ?? "");
  const secret = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!INSTALL_ID_RE.test(installId) || !SECRET_RE.test(secret)) return null;
  return { installId, secret };
}

async function verify(record: StoredRecord, secret: string): Promise<boolean> {
  return secretMatches(record.secret_hash, await hashSecret(secret, Buffer.from(record.salt, "hex")));
}

function isNonBlankString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Revalidate name/email server-side. The client gates these too, but a
 * client-side gate is a UX affordance, not a security control.
 */
function validateDocument(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const doc = body as Record<string, unknown>;
  const profile = doc.profile;
  if (typeof profile !== "object" || profile === null) return "missing 'profile' object";
  const p = profile as Record<string, unknown>;
  if (!isNonBlankString(p.name)) return "profile.name is required";
  if (!isNonBlankString(p.email)) return "profile.email is required";
  const email = p.email.trim();
  // Contract: "must contain @ and a dot". Deliberately not a full RFC 5322
  // parser — over-strict validation here locks a real person out of the only
  // channel that can reach them.
  const at = email.indexOf("@");
  if (at <= 0 || email.indexOf(".", at) < 0 || /\s/.test(email)) return "profile.email is invalid";
  return null;
}

export async function registerFleetProfileRoutes(app: FastifyInstance) {
  // Route-level cap so an oversized body is refused by Fastify as 413 rather
  // than buffered to the 1 MB global default.
  const opts = { bodyLimit: MAX_BODY_BYTES };

  /** Shared preamble: identity, rate limit, and lookup of any existing record. */
  async function begin(req: FastifyRequest, reply: FastifyReply) {
    const identity = readIdentity(req);
    if (!identity) {
      reply.code(400).send({ error: "missing or malformed X-Install-Id / Authorization: Bearer" });
      return null;
    }
    if (!withinRateLimit(identity.installId)) {
      reply.code(429).send({ error: `rate limit exceeded (${RATE_LIMIT_MAX}/min per install)` });
      return null;
    }
    return { identity, record: await readRecord(identity.installId) };
  }

  // ── POST — create or replace ────────────────────────────────────────────
  // Full-state replace keyed on the install id, so a device re-POSTing updates
  // its own record in place and never creates a second one. Keyed on the
  // install id and NOT on email: an email is a field a user can edit, and
  // rekeying on it would orphan the old record on every correction.
  app.post("/fleet/profile", opts, async (req, reply) => {
    const ctx = await begin(req, reply);
    // begin() already sent the error response; hand the reply back so the
    // async handler does not resolve to undefined (FST_ERR_PROMISE_NOT_FULFILLED).
    if (!ctx) return reply;
    const { identity, record } = ctx;

    // Trust on first use: the first POST for an unknown install id registers
    // it. Every later request must present the same secret.
    if (record && !(await verify(record, identity.secret))) {
      req.log.warn({ installId: identity.installId }, "fleet profile: secret mismatch on POST");
      return reply.code(403).send({ error: "forbidden" });
    }

    const invalid = validateDocument(req.body);
    if (invalid) return reply.code(400).send({ error: invalid });

    const now = new Date().toISOString();
    const salt = record ? Buffer.from(record.salt, "hex") : randomBytes(16);
    const secretHash = record
      ? record.secret_hash
      : (await hashSecret(identity.secret, salt)).toString("hex");

    await writeRecord(identity.installId, {
      salt: salt.toString("hex"),
      secret_hash: secretHash,
      created_at: record?.created_at ?? now,
      updated_at: now,
      document: req.body,
    });

    const bytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
    req.log.info(
      { installId: identity.installId, bytes, registered: !record },
      "fleet profile stored",
    );
    return { ok: true };
  });

  // ── GET — restore ───────────────────────────────────────────────────────
  // 404 on a fresh install is the normal case, not an error; the client treats
  // it as "nothing to restore".
  app.get("/fleet/profile", async (req, reply) => {
    const ctx = await begin(req, reply);
    // begin() already sent the error response; hand the reply back so the
    // async handler does not resolve to undefined (FST_ERR_PROMISE_NOT_FULFILLED).
    if (!ctx) return reply;
    const { identity, record } = ctx;

    if (!record) return reply.code(404).send({ error: "no profile for this install" });
    if (!(await verify(record, identity.secret))) {
      req.log.warn({ installId: identity.installId }, "fleet profile: secret mismatch on GET");
      return reply.code(403).send({ error: "forbidden" });
    }
    req.log.info({ installId: identity.installId }, "fleet profile read");
    return record.document;
  });

  // ── DELETE — erasure ────────────────────────────────────────────────────
  // Idempotent: already-gone returns 200, because a retried erasure must not
  // look like a failure to a user who is trying to remove their data.
  app.delete("/fleet/profile", async (req, reply) => {
    const ctx = await begin(req, reply);
    // begin() already sent the error response; hand the reply back so the
    // async handler does not resolve to undefined (FST_ERR_PROMISE_NOT_FULFILLED).
    if (!ctx) return reply;
    const { identity, record } = ctx;

    if (!record) return { ok: true };
    if (!(await verify(record, identity.secret))) {
      req.log.warn({ installId: identity.installId }, "fleet profile: secret mismatch on DELETE");
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      await unlink(recordPath(identity.installId));
    } catch (err) {
      // Lost a race with a concurrent delete — the record is gone either way,
      // which is exactly what was asked for.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    req.log.info({ installId: identity.installId }, "fleet profile erased");
    return { ok: true };
  });
}
