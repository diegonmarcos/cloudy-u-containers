import type { ProfileConnectCfg } from "./profile-connect.js";

// Runtime config for c3-public-api.
// Nothing is hardcoded: every URL, port, and limit comes from build.json
// -> 1_cloud-configs/dist/build-c3-public-api.json -> compose.nix env vars.
//
// Two delivery layers:
//   1. Analytics passthrough — BACKENDS_JSON (matomo/umami/openobserve).
//      Same shape as c3-analytics-api. Public, rate-limited.
//   2. Mail bridge — SMTP_HOST/SMTP_PORT.
//      Bearer-gated upstream by Caddy (introspect-proxy validates the JWT).

export interface BackendCfg {
  url: string;
  service: string;
  methods: string[];
  auth_header_env: string | null;
}

export interface Limits {
  max_body_bytes: number;
  max_ingest_lines: number;
  rate_per_ip_per_min: number;
  rate_per_sid_per_min: number;
  request_timeout_ms: number;
  smtp_timeout_ms: number;
  dedupe_ttl_ms: number;
}

import type { MailTarget } from "./mail-target.js";
export type { MailTarget };

export interface MailCfg {
  primary: MailTarget;
  /** #1811 named delivery targets (X-Mail-Target), from build.json#mail.targets. */
  targets: Record<string, MailTarget>;
  heloDomain: string;
  defaultUser: string;
}

export interface AppConfig {
  profileConnect: ProfileConnectCfg;
  host: string;
  port: number;
  basePath: string;
  backends: Record<string, BackendCfg>;
  limits: Limits;
  mail: MailCfg;
  resolvedAuthHeaders: Record<string, string | undefined>;
}

function readJson<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`${name} env var is not valid JSON: ${(e as Error).message}`);
  }
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} env var is not a number: ${raw}`);
  }
  return n;
}

export function loadConfig(): AppConfig {
  const backends = readJson<Record<string, BackendCfg>>("BACKENDS_JSON", {});
  const limits = readJson<Limits>("LIMITS_JSON", {
    max_body_bytes: 104857600,
    max_ingest_lines: 5000,
    rate_per_ip_per_min: 60,
    rate_per_sid_per_min: 1000,
    request_timeout_ms: 5000,
    smtp_timeout_ms: 120000,
    dedupe_ttl_ms: 1800000,
  });
  // #1819: older LIMITS_JSON without the two new keys keeps working.
  limits.smtp_timeout_ms ??= Math.max(limits.request_timeout_ms, 120000);
  limits.dedupe_ttl_ms ??= 1800000;

  const resolvedAuthHeaders: Record<string, string | undefined> = {};
  for (const [slug, cfg] of Object.entries(backends)) {
    if (cfg.auth_header_env) {
      resolvedAuthHeaders[slug] = process.env[cfg.auth_header_env];
    }
  }

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = readInt("SMTP_PORT", 25);

  const mail: MailCfg = {
    primary: {
      host: smtpHost ?? "",
      port: smtpPort,
    },
    targets: readJson<Record<string, MailTarget>>("MAIL_TARGETS_JSON", {}),
    heloDomain: process.env.SMTP_HELO_DOMAIN ?? "c3-public-api.local",
    defaultUser: process.env.SMTP_USER ?? "cloudflare@localhost",
  };

  // Profile ▸ Connect — every value comes from build.json#profile_connect via
  // compose.nix. An unset value is reported by missingParts() as a named 503,
  // never defaulted to something that would look configured.
  const profileConnect: ProfileConnectCfg = {
    mailTo: process.env.PROFILE_CONNECT_MAIL_TO ?? "",
    mailFrom: process.env.PROFILE_CONNECT_MAIL_FROM ?? "",
    codeTtlS: readInt("PROFILE_CONNECT_CODE_TTL_S", 600),
    resendCooldownS: readInt("PROFILE_CONNECT_RESEND_COOLDOWN_S", 60),
    maxAttempts: readInt("PROFILE_CONNECT_MAX_ATTEMPTS", 5),
    bundleDir: process.env.PROFILE_CONNECT_BUNDLE_DIR ?? "",
    bundleFile: process.env.PROFILE_CONNECT_BUNDLE_FILE ?? "profile-secrets.json",
    schemaFile: process.env.PROFILE_CONNECT_SCHEMA_FILE ?? "schema.json",
  };

  return {
    profileConnect,
    host: process.env.HOST ?? "0.0.0.0",
    port: readInt("PORT", 8087),
    basePath: process.env.BASE_PATH ?? "/c3-public-api",
    backends,
    limits,
    mail,
    resolvedAuthHeaders,
  };
}
