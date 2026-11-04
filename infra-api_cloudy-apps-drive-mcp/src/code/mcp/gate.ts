// gate.ts — who may see the vault tool (cloud_vault) on the merged server.
//
// cloud-vault-mcp was mesh-only with NO public door (not routed on the edge at
// all). Merged into cloudy-apps-drive-mcp, whose drive tool IS routed publicly
// behind the bearer, the vault tool is exposed only on a direct mesh hit:
//   - the TCP peer is inside the mesh CIDR (default 10.0.0.0/24) or loopback, AND
//   - the request carries no proxy marker (Caddy adds X-Forwarded-*; the public
//     door always carries Authorization).
// Anything else gets the drive tool only, and a vault call is refused as an
// unknown tool. No code path enables it from the request body.
// No SDK import and no parameter properties: unit-testable under Node's type stripping.

export interface GateReq {
  remoteAddress?: string;
  headers: Record<string, string | string[] | undefined>;
}

const PROXY_MARKERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded", "via", "cf-connecting-ip", "authorization"];

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  const a = ipv4ToInt(ip), b = ipv4ToInt(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

export function vaultAllowed(req: GateReq, env: Record<string, string | undefined> = process.env): boolean {
  if (env.VAULT_TOOLS === "0") return false; // kill switch
  for (const h of PROXY_MARKERS) if (req.headers[h] !== undefined) return false;
  const addr = (req.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (addr === "127.0.0.1" || addr === "::1") return true;
  return (env.VAULT_MESH_CIDR || "10.0.0.0/24").split(",").some((c) => inCidr(addr, c.trim()));
}
