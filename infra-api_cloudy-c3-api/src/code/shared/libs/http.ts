import { exec } from "./exec.js";
import { C3_API_MESH, C3_API_PUBLIC, AUTHELIA_TOKEN_PATH } from "./paths.js";
import { readFileSync } from "fs";

export interface HttpResult {
  ok: boolean;
  status: number;
  data: unknown;
  raw: string;
  error?: string;
}

function httpRequest(
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
  const tokenUrl = process.env.AUTHELIA_TOKEN_URL;
  if (!clientId || !tokenUrl) return null;

  // Read client secret from env or credentials dir file
  let clientSecret = process.env.AUTHELIA_OIDC_CLIENT_SECRET;
  if (!clientSecret) {
    const credsDir = process.env.AUTHELIA_OIDC_CREDENTIALS_DIR;
    if (credsDir) {
      try {
        const envFile = readFileSync(`${credsDir}/${clientId}.env`, "utf-8");
        const match = envFile.match(/^CLIENT_SECRET=(.+)$/m);
        if (match) clientSecret = match[1].trim();
      } catch {}
    }
  }
  if (!clientSecret) return null;

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const result = exec("curl", [
      "-s", "--max-time", "10", "-X", "POST", tokenUrl,
      "-H", `Authorization: Basic ${credentials}`,
      "-d", "grant_type=client_credentials&scope=authelia.bearer.authz",
    ], { timeout: 15_000 });

    if (!result.ok) {
      console.error(`[OIDC] Token fetch failed: ${result.stderr || "curl error"}`);
      return null;
    }

    const parsed = JSON.parse(result.stdout);
    const token = parsed.access_token || null;
    if (token) {
      console.log(`[OIDC] Token acquired via client_credentials (${token.length} chars)`);
    } else {
      console.error(`[OIDC] No access_token in response: ${result.stdout.slice(0, 200)}`);
    }
    return token;
  } catch (e) {
    console.error(`[OIDC] Token fetch error: ${e}`);
    return null;
  }
}

export function getBearerToken(): string | null {
  // 1. Return cached OIDC token
  if (_oidcTokenCache) return _oidcTokenCache;

  // 2. Try OIDC client_credentials flow
  const oidcToken = fetchOidcToken();
  if (oidcToken) {
    _oidcTokenCache = oidcToken;
    return oidcToken;
  }

  // 3. Legacy: static token from env var
  const envToken = process.env.AUTHELIA_BEARER_TOKEN;
  if (envToken) return envToken;

  // 4. Local dev: token from file
  try {
    const tokens = JSON.parse(readFileSync(AUTHELIA_TOKEN_PATH, "utf-8"));
    return tokens.access_token || null;
  } catch {
    return null;
  }
}

export function c3ApiGet(endpoint: string, timeout?: number): HttpResult {
  // Try WireGuard mesh first
  const meshResult = httpRequest("GET", `${C3_API_MESH}${endpoint}`, undefined, timeout);

  if (meshResult.ok || meshResult.status !== 0) {
    return meshResult;
  }

  // Mesh failed (status 0 = connection failed), try public with bearer token
  const token = getBearerToken();
  if (token) {
    return httpRequest(
      "GET",
      `${C3_API_PUBLIC}${endpoint}`,
      undefined,
      timeout,
      { Authorization: `Bearer ${token}` }
    );
  }

  // No token available, return mesh failure
  return meshResult;
}

export function c3ApiPost(endpoint: string, body?: string, timeout?: number): HttpResult {
  // Try WireGuard mesh first
  const meshResult = httpRequest("POST", `${C3_API_MESH}${endpoint}`, body, timeout);

  if (meshResult.ok || meshResult.status !== 0) {
    return meshResult;
  }

  // Mesh failed, try public with bearer token
  const token = getBearerToken();
  if (token) {
    return httpRequest(
      "POST",
      `${C3_API_PUBLIC}${endpoint}`,
      body,
      timeout,
      { Authorization: `Bearer ${token}` }
    );
  }

  return meshResult;
}

export function httpGet(url: string, timeout?: number): HttpResult {
  return httpRequest("GET", url, undefined, timeout);
}

export function rawHttpRequest(
  method: string,
  url: string,
  body?: string,
  timeout?: number,
  extraHeaders?: Record<string, string>
): HttpResult {
  return httpRequest(method, url, body, timeout, extraHeaders);
}
