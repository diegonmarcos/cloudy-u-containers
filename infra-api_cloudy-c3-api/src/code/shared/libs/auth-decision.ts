// Pure auth decision shared by plugins/auth.ts and the tests (no fastify import, so `node` can run it).
// Public: health/docs/public logs. Trusted: the WireGuard mesh and Docker bridge. Otherwise Caddy must have
// authenticated the caller (introspect-proxy sets X-Auth-User for a bearer, Authelia sets Remote-User for a cookie).

const PUBLIC_PATHS = new Set(["/health", "/docs", "/docs/", "/docs/json", "/docs/yaml"]);

export function isPublicPath(url: string): boolean {
  if (url.startsWith("/docs")) return true;
  if (url.startsWith("/public/")) return true;
  return PUBLIC_PATHS.has(url);
}

export function isMeshIp(ip: string): boolean {
  // 10.0.0.x = WireGuard mesh, 172.x = Docker bridge (host/other VMs via WG)
  return ip.startsWith("10.0.0.") || ip.startsWith("172.") || ip === "127.0.0.1" || ip === "::1";
}

export function isCaddyAuthenticated(headers: Record<string, unknown>): boolean {
  return !!(headers["x-auth-user"] || headers["remote-user"]);
}

export function isAllowed(url: string, ip: string, headers: Record<string, unknown>): boolean {
  return isPublicPath(url) || isMeshIp(ip) || isCaddyAuthenticated(headers);
}
