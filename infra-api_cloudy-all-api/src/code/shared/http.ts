import { spawnSync } from "child_process";

interface ExecResult { ok: boolean; stdout: string; stderr: string }

function exec(cmd: string, args: string[], opts?: { timeout?: number }): ExecResult {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: opts?.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export interface HttpResult {
  ok: boolean;
  status: number;
  data: unknown;
  raw: string;
  error?: string;
}

export function rawHttpRequest(
  method: string,
  url: string,
  body?: string,
  timeout?: number,
  extraHeaders?: Record<string, string>
): HttpResult {
  const args = [
    "-s", "-S",
    "-X", method,
    "-H", "Content-Type: application/json",
    "-w", "\n__HTTP_STATUS__%{http_code}",
  ];

  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      args.push("-H", `${key}: ${value}`);
    }
  }

  if (body && (method === "POST" || method === "PUT" || method === "PATCH")) {
    args.push("-d", body);
  }

  args.push(url);

  const result = exec("curl", args, { timeout: timeout ?? 30_000 });

  const output = result.stdout;
  const statusMatch = output.match(/__HTTP_STATUS__(\d+)$/);
  const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : 0;
  const raw = output.replace(/__HTTP_STATUS__\d+$/, "").trim();

  if (!result.ok && httpStatus === 0) {
    return {
      ok: false,
      status: 0,
      data: null,
      raw: "",
      error: result.stderr || "curl failed",
    };
  }

  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // keep as string
  }

  return {
    ok: httpStatus >= 200 && httpStatus < 400,
    status: httpStatus,
    data,
    raw,
    error: httpStatus >= 400 ? `HTTP ${httpStatus}` : undefined,
  };
}

// Module-level OIDC token cache
let _oidcTokenCache: string | null = null;

function fetchOidcToken(): string | null {
  const clientId = process.env.AUTHELIA_OIDC_CLIENT_ID;
  const clientSecret = process.env.AUTHELIA_OIDC_CLIENT_SECRET;
  const tokenUrl = process.env.AUTHELIA_TOKEN_URL;

  if (!clientId || !clientSecret || !tokenUrl) return null;

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const result = exec("curl", [
      "-s", "--max-time", "10", "-X", "POST", tokenUrl,
      "-H", `Authorization: Basic ${credentials}`,
      "-d", "grant_type=client_credentials&scope=authelia.bearer.authz",
    ], { timeout: 15_000 });

    if (!result.ok) return null;

    const parsed = JSON.parse(result.stdout);
    return parsed.access_token || null;
  } catch {
    return null;
  }
}

export function getBearerToken(): string | null {
  if (_oidcTokenCache) return _oidcTokenCache;

  const oidcToken = fetchOidcToken();
  if (oidcToken) {
    _oidcTokenCache = oidcToken;
    return oidcToken;
  }

  return process.env.AUTHELIA_BEARER_TOKEN ?? null;
}

/** Make a request to a service via its WireGuard mesh address */
export function serviceRequest(
  method: string,
  url: string,
  body?: string,
  timeout?: number,
  extraHeaders?: Record<string, string>
): HttpResult {
  return rawHttpRequest(method, url, body, timeout, extraHeaders);
}
