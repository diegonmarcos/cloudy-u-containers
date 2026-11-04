/**
 * Vaultwarden read-only client for the personal-data MCP.
 *
 * Connects to the self-hosted Vaultwarden server over the WireGuard mesh,
 * logs in, pulls the encrypted vault (/api/sync), and decrypts ONLY item
 * metadata (names + which items carry a TOTP). Passwords, TOTP seeds and
 * other secret values are never decrypted or returned.
 *
 * Crypto mirrors the reference client at
 *   ~/git/cloud-vault/A0_keys/providers/vaultwarden/setup.ts
 * (PBKDF2 master key → HKDF-Expand stretch → AES-256-CBC + HMAC-SHA256).
 *
 * NO secrets live in this file. Connection details + master password are
 * read at runtime from the PRIVATE vault repo:
 *   $VAULT_PATH/A0_keys/providers/vaultwarden/credentials.json
 * The cloud repo is public; only the *path* is referenced here.
 */
import * as crypto from "node:crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { getVaultPath } from "./config.js";

// ── Credentials (from the private vault repo, never hardcoded) ──────────
export interface VaultwardenCredentials {
  server: string;        // e.g. http://10.0.0.1:8880 (WG) or https://vault.diegonmarcos.com
  email: string;
  password: string;
  kdfIterations: number; // PBKDF2 iteration count the account was created with
}

export function getCredentialsPath(): string {
  return join(getVaultPath(), "A0_keys", "providers", "vaultwarden", "credentials.json");
}

export class VaultwardenNotConfiguredError extends Error {
  constructor(public readonly path: string) {
    super(`Vaultwarden credentials not found at ${path}`);
    this.name = "VaultwardenNotConfiguredError";
  }
}

function loadCredentials(): VaultwardenCredentials {
  const path = getCredentialsPath();
  if (!existsSync(path)) throw new VaultwardenNotConfiguredError(path);
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<VaultwardenCredentials>;
  if (!raw.server || !raw.email || !raw.password) {
    throw new Error(`credentials.json at ${path} is missing required fields (server, email, password)`);
  }
  return {
    server: raw.server,
    email: raw.email,
    password: raw.password,
    kdfIterations: raw.kdfIterations ?? 600000,
  };
}

// ── Bitwarden crypto (decrypt path only) ────────────────────────────────
function makeMasterKey(password: string, email: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, email.toLowerCase(), iterations, 32, "sha256");
}

function makeMasterPasswordHash(masterKey: Buffer, password: string): string {
  return crypto.pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64");
}

// HKDF-Expand only (Bitwarden uses the master key directly as the PRK).
function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const infoBuffer = Buffer.from(info, "utf-8");
  let prev = Buffer.alloc(0);
  const result: Buffer[] = [];
  let i = 1;
  while (Buffer.concat(result).length < length) {
    prev = crypto.createHmac("sha256", prk)
      .update(Buffer.concat([prev, infoBuffer, Buffer.from([i])]))
      .digest();
    result.push(prev);
    i++;
  }
  return Buffer.concat(result).subarray(0, length);
}

function stretchKey(key: Buffer): { encKey: Buffer; macKey: Buffer } {
  return { encKey: hkdfExpand(key, "enc", 32), macKey: hkdfExpand(key, "mac", 32) };
}

function decryptBuf(cipherString: string, encKey: Buffer, macKey: Buffer): Buffer {
  const [, rest] = cipherString.split(".");
  const [ivB64, ctB64, macB64] = rest.split("|");
  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const mac = Buffer.from(macB64, "base64");
  const computedMac = crypto.createHmac("sha256", macKey).update(Buffer.concat([iv, ct])).digest();
  if (!crypto.timingSafeEqual(mac, computedMac)) throw new Error("HMAC mismatch decrypting EncString");
  const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function decryptStr(cipherString: string | null | undefined, encKey: Buffer, macKey: Buffer): string {
  if (!cipherString) return "";
  return decryptBuf(cipherString, encKey, macKey).toString("utf-8");
}

// ── HTTP ────────────────────────────────────────────────────────────────
async function api(
  server: string,
  endpoint: string,
  opts: { method?: string; token?: string; form?: Record<string, string> } = {}
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const resp = await fetch(`${server}${endpoint}`, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
  const text = await resp.text();
  let data: unknown;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: resp.status, data };
}

async function login(creds: VaultwardenCredentials): Promise<string> {
  const masterKey = makeMasterKey(creds.password, creds.email, creds.kdfIterations);
  const masterPasswordHash = makeMasterPasswordHash(masterKey, creds.password);
  const { status, data } = await api(creds.server, "/identity/connect/token", {
    form: {
      grant_type: "password",
      username: creds.email,
      password: masterPasswordHash,
      scope: "api offline_access",
      client_id: "cli",
      deviceType: "8",
      deviceIdentifier: "c3-personal-data-mcp",
      deviceName: "personal-data-mcp",
    },
  });
  if (status !== 200) {
    throw new Error(`Vaultwarden login failed (${status}): ${JSON.stringify(data)}`);
  }
  return (data as { access_token: string }).access_token;
}

// ── Public surface: decrypted metadata only ─────────────────────────────
export interface VaultItem {
  name: string;
  type: number;     // 1=login, 2=note, 3=card, 4=identity
  hasTotp: boolean;
}

const ITEM_TYPE_LABEL: Record<number, string> = {
  1: "Login",
  2: "Secure Note",
  3: "Card",
  4: "Identity",
};

export function itemTypeLabel(type: number): string {
  return ITEM_TYPE_LABEL[type] ?? `Type ${type}`;
}

// ── Raw vault cache (process lifetime, short TTL) ────────────────────────
// Holds the synced ciphers + derived user key. Avoids re-running the
// 600k-iteration PBKDF2 + a network round trip on every call.
interface RawCipher {
  type: number;
  name: string;
  key?: string | null;                          // per-item key (Bitwarden "cipher key encryption")
  login?: { totp?: string | null } | null;
}
interface RawVault { ciphers: RawCipher[]; userEncKey: Buffer; userMacKey: Buffer; }

let cache: { vault: RawVault; at: number } | null = null;
const CACHE_TTL_MS = 60_000;

async function loadVault(force = false): Promise<RawVault> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.vault;

  const creds = loadCredentials();
  const token = await login(creds);

  const { status, data } = await api(creds.server, "/api/sync", { token });
  if (status !== 200) throw new Error(`Vaultwarden sync failed (${status}): ${JSON.stringify(data)}`);

  const sync = data as { profile: { key: string }; ciphers?: RawCipher[] };

  // Decrypt the user's symmetric key, then derive the user enc/mac keys.
  const masterKey = makeMasterKey(creds.password, creds.email, creds.kdfIterations);
  const { encKey: mEncKey, macKey: mMacKey } = stretchKey(masterKey);
  const userKey = decryptBuf(sync.profile.key, mEncKey, mMacKey);

  const vault: RawVault = {
    ciphers: sync.ciphers ?? [],
    userEncKey: userKey.subarray(0, 32),
    userMacKey: userKey.subarray(32),
  };
  cache = { vault, at: Date.now() };
  return vault;
}

// Resolve the enc/mac keys for a cipher. Items created under "cipher key
// encryption" carry their own per-item key (an EncString wrapped by the user
// key); their fields are encrypted with that per-item key, not the user key.
function cipherKeys(c: RawCipher, v: RawVault): { encKey: Buffer; macKey: Buffer } {
  if (!c.key) return { encKey: v.userEncKey, macKey: v.userMacKey };
  const itemKey = decryptBuf(c.key, v.userEncKey, v.userMacKey);
  return { encKey: itemKey.subarray(0, 32), macKey: itemKey.subarray(32) };
}

export async function getVaultItems(force = false): Promise<VaultItem[]> {
  const v = await loadVault(force);
  return v.ciphers.map((c) => {
    try {
      const { encKey, macKey } = cipherKeys(c, v);
      const name = decryptStr(c.name, encKey, macKey) || "(unnamed)";
      return { name, type: c.type, hasTotp: c.type === 1 && !!c.login?.totp };
    } catch {
      // Never let one undecryptable item break the whole summary.
      return { name: "(undecryptable)", type: c.type, hasTotp: c.type === 1 && !!c.login?.totp };
    }
  });
}

// ── TOTP (per-item, current code only — never the seed) ──────────────────
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32 in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

interface TotpParams { secret: string; algorithm: string; digits: number; period: number; }

// A Bitwarden totp field is either a raw base32 secret or an otpauth:// URI.
function parseTotp(field: string): TotpParams {
  const f = field.trim();
  if (/^otpauth:\/\//i.test(f)) {
    const p = new URL(f).searchParams;
    const secret = p.get("secret");
    if (!secret) throw new Error("otpauth URI has no secret");
    return {
      secret,
      algorithm: (p.get("algorithm") || "SHA1").toUpperCase(),
      digits: Number(p.get("digits") || 6),
      period: Number(p.get("period") || 30),
    };
  }
  return { secret: f, algorithm: "SHA1", digits: 6, period: 30 };
}

const HMAC_ALG: Record<string, string> = { SHA1: "sha1", SHA256: "sha256", SHA512: "sha512" };

// RFC 6238 TOTP.
function computeTotp(p: TotpParams, epochSeconds: number): string {
  const alg = HMAC_ALG[p.algorithm];
  if (!alg) throw new Error(`unsupported TOTP algorithm: ${p.algorithm}`);
  const counter = Math.floor(epochSeconds / p.period);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(alg, base32Decode(p.secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (bin % 10 ** p.digits).toString().padStart(p.digits, "0");
}

export interface TotpResult { service: string; code: string; secondsRemaining: number; }

// Find ONE TOTP item by name (case-insensitive; exact preferred, else substring)
// and return its CURRENT code. Never returns or logs the seed. Throws if the
// match is missing or ambiguous.
export async function getTotpCode(service: string): Promise<TotpResult> {
  const v = await loadVault();
  const want = service.trim().toLowerCase();

  const candidates = v.ciphers
    .filter((c) => c.type === 1 && c.login?.totp)
    .map((c) => {
      const { encKey, macKey } = cipherKeys(c, v);
      try { return { name: decryptStr(c.name, encKey, macKey), cipher: c, encKey, macKey }; }
      catch { return null; }
    })
    .filter((m): m is NonNullable<typeof m> => m !== null && !!m.name);

  const exact = candidates.filter((m) => m.name.toLowerCase() === want);
  const matches = exact.length ? exact : candidates.filter((m) => m.name.toLowerCase().includes(want));

  if (matches.length === 0) {
    throw new Error(`No TOTP item matches "${service}". Use vault_2fa_status to list configured items.`);
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m.name).sort((a, b) => a.localeCompare(b)).join(", ");
    throw new Error(`"${service}" is ambiguous — matches: ${names}. Use the exact name.`);
  }

  const m = matches[0];
  const params = parseTotp(decryptStr(m.cipher.login!.totp!, m.encKey, m.macKey));
  const now = Math.floor(Date.now() / 1000);
  return {
    service: m.name,
    code: computeTotp(params, now),
    secondsRemaining: params.period - (now % params.period),
  };
}
