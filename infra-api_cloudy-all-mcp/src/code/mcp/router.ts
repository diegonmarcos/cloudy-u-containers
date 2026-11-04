// router.ts — the whole router contract, with no SDK import so it is unit-testable.
//
// Three operations (exposed as MCP tools by tools/router-tools.ts):
//   listServers()                 -> the fleet servers, names + one-line purpose
//   listTools(server)             -> that server's tool list (name, description, inputSchema)
//   call(server, tool, args)      -> run one tool on that server
// Not every tool is inlined: a client pays for 3 tool schemas, not ~250.
//
// Old names (cloud-mail-mcp, cloud-infra-mcp, ...) resolve through `aliases`
// for one release after the rebrand (#1450).

export interface ServerEntry {
  name: string;
  aliases?: string[];
  description: string;
  /** Candidate endpoints in order: mesh first, public (bearer) second. */
  urls: string[];
}

export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface Backend {
  listTools(entry: ServerEntry): Promise<ToolInfo[]>;
  callTool(entry: ServerEntry, tool: string, args: Record<string, unknown>): Promise<unknown>;
}

export type RouterError = { isError: true; content: Array<{ type: "text"; text: string }> };

export interface RouterOptions {
  /** Tool-list cache lifetime. Default 60 s; 0 disables the cache. */
  ttlMs?: number;
  now?: () => number;
  /** This router's own name: never routed to (no recursion). */
  selfName?: string;
}

export const fail = (text: string): RouterError => ({ isError: true, content: [{ type: "text", text }] });

export class Router {
  private byKey = new Map<string, ServerEntry>();
  private cache = new Map<string, { at: number; tools: ToolInfo[] }>();
  private ttl: number;
  private now: () => number;
  private backend: Backend;

  // No parameter properties: the file must run under Node's type stripping (tests).
  constructor(entries: ServerEntry[], backend: Backend, opts: RouterOptions = {}) {
    this.backend = backend;
    this.ttl = opts.ttlMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    for (const e of entries) {
      if (e.name === opts.selfName) continue;
      for (const k of [e.name, ...(e.aliases ?? [])]) {
        const key = k.toLowerCase();
        const prev = this.byKey.get(key);
        if (prev && prev !== e) throw new Error(`router: name '${k}' is claimed by both '${prev.name}' and '${e.name}'`);
        this.byKey.set(key, e);
      }
    }
  }

  listServers(): Array<{ name: string; aliases: string[]; description: string }> {
    return [...new Set(this.byKey.values())]
      .map((e) => ({ name: e.name, aliases: e.aliases ?? [], description: e.description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  resolve(server: unknown): ServerEntry | RouterError {
    if (typeof server !== "string" || !server.trim()) return fail("server is required (see list_servers)");
    const e = this.byKey.get(server.trim().toLowerCase());
    if (e) return e;
    return fail(`unknown server '${server}'. Known: ${this.listServers().map((s) => s.name).join(", ")}`);
  }

  async listTools(server: unknown): Promise<{ server: string; tools: ToolInfo[] } | RouterError> {
    const e = this.resolve(server);
    if ("isError" in e) return e;
    try {
      return { server: e.name, tools: await this.tools(e, false) };
    } catch (err) {
      return fail(`${e.name}: list_tools failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  async call(server: unknown, tool: unknown, args: unknown): Promise<unknown> {
    const e = this.resolve(server);
    if ("isError" in e) return e;
    if (typeof tool !== "string" || !tool.trim()) return fail("tool is required (see list_tools)");
    if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
      return fail("args must be an object");
    }
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      let tools = await this.tools(e, false);
      if (!tools.some((t) => t.name === tool)) tools = await this.tools(e, true); // maybe a stale cache
      if (!tools.some((t) => t.name === tool)) {
        const near = tools.map((t) => t.name).filter((n) => n.includes(tool) || tool.includes(n)).slice(0, 8);
        return fail(`${e.name} has no tool '${tool}'.${near.length ? ` Similar: ${near.join(", ")}.` : ""} Use list_tools.`);
      }
      return await this.backend.callTool(e, tool, a);
    } catch (err) {
      return fail(`${e.name}.${tool} failed: ${String(err instanceof Error ? err.message : err)}`);
    }
  }

  private async tools(e: ServerEntry, force: boolean): Promise<ToolInfo[]> {
    const hit = this.cache.get(e.name);
    if (!force && hit && this.ttl > 0 && this.now() - hit.at < this.ttl) return hit.tools;
    const tools = await this.backend.listTools(e);
    this.cache.set(e.name, { at: this.now(), tools });
    return tools;
  }
}
