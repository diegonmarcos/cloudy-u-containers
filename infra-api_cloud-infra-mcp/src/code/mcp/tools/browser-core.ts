// browser.* pure core (#1498): backend routing, secrets by env name, the request shape and browser.read. No imports, so the
// dependency-free tester (node --experimental-strip-types test-browser-tools.mjs) runs it.
export type Backend = "phone" | "container";

export const DEFAULT_CONTAINER_URL = "http://10.0.0.6:3118";

export interface Target { url: string; bearer: string }

/** Where a call goes. Throws a clear message when the backend is not configured. */
export function target(backend: Backend, kind: "command" | "run", env: Record<string, string | undefined> = process.env): Target {
  if (backend === "phone") {
    const base = (env.C3_PHONE_MESH_URL ?? "").replace(/\/+$/, "");
    const bearer = env.C3_PHONE_FLEET_TOKEN ?? "";
    if (!base || !bearer) throw new Error("phone backend not configured (C3_PHONE_MESH_URL, C3_PHONE_FLEET_TOKEN)");
    return { url: `${base}/browser/${kind}`, bearer };
  }
  // Default = the container's mesh listener (build.json cloudy-browser-headless: ports.app 3118 on oci-apps, WG IP 10.0.0.6; this MCP
  // runs on the same host). C3_BROWSER_URL overrides it (for example the public Caddy path with a bearer). Not a secret.
  const base = (env.C3_BROWSER_URL || DEFAULT_CONTAINER_URL).replace(/\/+$/, "");
  const bearer = env.C3_BROWSER_TOKEN ?? "";
  if (!base || !bearer) throw new Error("container backend not configured (C3_BROWSER_TOKEN)");
  return { url: `${base}/${kind}`, bearer };
}

export async function call(backend: Backend, kind: "command" | "run", body: unknown, f: typeof fetch = fetch, env = process.env): Promise<unknown> {
  const t = target(backend, kind, env);
  const r = await f(t.url, { method: "POST", headers: { authorization: `Bearer ${t.bearer}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(130_000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: { code: "internal", message: `HTTP ${r.status}` } }; }
}

/** browser.read: open + readable in one call, the default tool agents use to get a page as data. */
export async function readUrl(args: any, f: typeof fetch = fetch, env = process.env): Promise<any> {
  const { backend, url, profile, format, maxChars, cursor, session, agent, timeoutMs } = args;
  const common2 = { ...(agent ? { agent } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  // A continuation (cursor + session) re-reads the already open page; a fresh read opens the URL first.
  const steps: any[] = cursor && session
    ? [{ cmd: "readable", session, format, maxChars, cursor, ...common2 }]
    : [{ cmd: "open", url, ...(profile ? { profile } : {}), ...(session ? { session } : {}), ...common2 }, { cmd: "readable", format, maxChars, ...common2 }];
  const r: any = await call(backend, "run", { ...(session ? { session } : {}), steps }, f, env);
  const last = r?.steps?.[r.steps.length - 1];
  if (r?.ok === false || !last?.ok) return { ok: false, error: last?.error ?? r?.error ?? { code: "internal", message: "read failed" } };
  const x = last.result ?? {};
  return { ok: true, session: r.session, url: x.url, title: x.title, format: x.format, content: x.content, truncated: !!x.truncated, ...(x.next ? { next: x.next } : {}) };
}

