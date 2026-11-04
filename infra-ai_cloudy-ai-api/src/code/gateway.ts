// gateway.ts — routing table and path rewriting for cloudy-ai-api. No dependencies
// and no parameter properties: runs under Node's built-in type stripping.
//
// Public shape:   /ai/<name>/<rest>  ->  <backend of name>/<rest>
// Legacy aliases: the old API names keep working for one release and are
// rewritten to the same backend:  /tokens-api/<rest>, /embeddings-api/...,
// /my-ai-api/..., /claude-superset-api/..., /session-memory/...

export interface Backend { name: string; url: string; legacy: string[] }

// Default: all five backends on the same host as the gateway (oci-apps, network_mode
// host), bound on loopback/mesh. ROUTES (JSON array of Backend) replaces this.
export const DEFAULT_BACKENDS: Backend[] = [
  { name: "tokens", url: "http://127.0.0.1:4184", legacy: ["tokens-api"] },
  { name: "embeddings", url: "http://127.0.0.1:7997", legacy: ["embeddings-api"] },
  { name: "agents", url: "http://127.0.0.1:3217", legacy: ["my-ai-api"] },
  { name: "claude", url: "http://127.0.0.1:3117", legacy: ["claude-superset-api", "my-ai_claude-api"] },
  { name: "memory", url: "http://127.0.0.1:3108", legacy: ["session-memory"] },
];

export function loadBackends(env: Record<string, string | undefined> = process.env): Backend[] {
  const raw = env.ROUTES;
  if (!raw) return DEFAULT_BACKENDS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((b) => !b || typeof b.name !== "string" || !/^[a-z0-9-]+$/.test(b.name) || typeof b.url !== "string")) {
    throw new Error("ROUTES must be a JSON array of {name, url, legacy?[]}");
  }
  return parsed.map((b) => ({ name: b.name, url: b.url, legacy: Array.isArray(b.legacy) ? b.legacy : [] }));
}

export interface Match { backend: Backend; target: string; legacy: boolean }

/** Resolve a request path+query to a backend URL, or null (404). */
export function matchRoute(backends: Backend[], pathAndQuery: string): Match | null {
  const q = pathAndQuery.indexOf("?");
  const path = q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
  const query = q < 0 ? "" : pathAndQuery.slice(q);
  if (path.includes("..") || path.includes("//") || path.includes("\\")) return null;
  const seg = path.split("/");           // ["", "ai", name, ...rest]
  let name: string | undefined, rest: string[], legacy = false;
  if (seg[1] === "ai" && seg[2]) { name = seg[2]; rest = seg.slice(3); }
  else if (seg[1]) { name = seg[1]; rest = seg.slice(2); legacy = true; }
  else return null;
  const backend = legacy
    ? backends.find((b) => b.legacy.includes(name!))
    : backends.find((b) => b.name === name);
  if (!backend) return null;
  const base = backend.url.replace(/\/+$/, "");
  return { backend, target: `${base}/${rest.join("/")}${query}`, legacy };
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

/** Request headers to forward: hop-by-hop dropped, Authorization passed through untouched. */
export function forwardHeaders(h: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}
