/**
 * Single tool registry -> grouped dispatcher tools.
 *
 * The register*Tools() functions keep calling `server.tool(name, desc, shape, handler)`
 * exactly as before; they are handed a ToolRegistry instead of the real McpServer, which
 * records each definition. From that ONE registry we derive:
 *   - 7 dispatcher tools  infra_devops / infra_obs / infra_sec / infra_finops / infra_health / infra_notify / infra_plugin
 *     each {method: enum, params: object}
 *   - infra_help({method})  full description + JSON schema of one method
 *   - (#1495) the tool TREE: one dispatcher c3_<section> per top section of the Cloud-C3 app's hierarchy + c3_tree + c3_help (registerTree);
 *     the legacy dispatchers above stay as aliases
 *   - (#1495) `superapp` + `superapp_help`, the cloudy-android-mcp alias dispatcher, only on the alias endpoint (registerSuperappAlias)
 *   - (MCP_LEGACY_TOOLS=1 only) the old per-tool registrations, unchanged
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { arrange, dispatcherOf, leaves, loadHierarchy, type Hier } from "./tree.js";

export interface ToolDef {
  name: string; // original dotted name, e.g. "devops.ssh.check"
  description: string;
  shape: ZodRawShape | undefined;
  handler: (...a: any[]) => any;
}

export class ToolRegistry {
  readonly defs = new Map<string, ToolDef>();
  tool(name: string, ...rest: any[]): void {
    const handler = rest.pop();
    let description = "";
    let shape: ZodRawShape | undefined;
    if (typeof rest[0] === "string") description = rest.shift();
    if (rest[0] && typeof rest[0] === "object") shape = rest.shift();
    if (this.defs.has(name)) throw new Error(`duplicate tool: ${name}`);
    this.defs.set(name, { name, description, shape, handler });
  }
}

export const GROUPS = ["devops", "obs", "sec", "finops", "health", "notify", "plugin", "peers"] as const;
export type Group = (typeof GROUPS)[number];

export interface Method { group: Group; method: string; def: ToolDef }

/** "devops.ssh.check" -> {devops, ssh_check}; "obs.finops.vps" -> {finops, vps}; "obs.db.prune" -> {obs, db_prune}. */
export function classify(name: string): { group: Group; method: string } {
  const p = name.split(".");
  const j = (a: string[]) => a.join("_");
  if (p[0] === "devops") return { group: "devops", method: j(p.slice(1)) };
  if (p[0] === "peers") return { group: "peers", method: j(p.slice(1)) }; // peers-control (#1495, merged from cloudy-android-mcp)
  if (p[0] === "plugin") return { group: "plugin", method: j(p.slice(1)) };
  if (p[0] === "sec") return { group: "sec", method: j(p.slice(1)) };
  if (p[0] === "obs") {
    if (p[1] === "finops") return { group: "finops", method: j(p.slice(2)) };
    if (p[1] === "health") return { group: "health", method: j(p.slice(2)) };
    if (p[1] === "notify") return { group: "notify", method: j(p.slice(2)) };
    if (p[1] === "debug") return { group: "obs", method: j(p.slice(2)) };
    if (p[1] === "db") return { group: "obs", method: j(p.slice(1)) };
  }
  throw new Error(`unclassifiable tool name: ${name}`);
}

export function methodsOf(reg: ToolRegistry): Method[] {
  const out: Method[] = [];
  const seen = new Set<string>();
  for (const def of reg.defs.values()) {
    const c = classify(def.name);
    const key = `${c.group}.${c.method}`;
    if (seen.has(key)) throw new Error(`method collision: ${key}`);
    seen.add(key);
    out.push({ ...c, def });
  }
  return out;
}

/** <= 4 words of the first clause of the existing description (trailing stopwords trimmed). */
export function summary(desc: string): string {
  const first = desc.split(/\s[—–-]\s|\.\s|\s\(|\n/)[0].trim();
  const w = first.split(/\s+/).slice(0, 4);
  while (w.length > 1 && /^(the|a|an|to|of|for|on|via|and|or|in|from|with|by|is|that|as|if)$/i.test(w[w.length - 1])) w.pop();
  return w.join(" ").replace(/[,;:]+$/, "");
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const });

export function validateParams(m: Method, params: unknown): { ok: true; value: any } | { ok: false; error: string } {
  const schema = z.object(m.def.shape ?? {}).strict();
  const r = schema.safeParse(params ?? {});
  if (r.success) return { ok: true, value: r.data };
  const issues = r.error.issues.map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`).join("; ");
  return {
    ok: false,
    error: `Invalid params for infra_${m.group}.${m.method}: ${issues}. Call infra_help {method:"${m.group}.${m.method}"} for the schema.`,
  };
}

export function jsonSchemaOf(def: ToolDef): unknown {
  return zodToJsonSchema(z.object(def.shape ?? {}).strict(), { $refStrategy: "none" });
}

export function registerGrouped(server: McpServer, reg: ToolRegistry): Method[] {
  const all = methodsOf(reg);
  const byKey = new Map(all.map((m) => [`${m.group}.${m.method}`, m]));

  for (const g of GROUPS) {
    const ms = all.filter((m) => m.group === g);
    if (!ms.length) continue;
    const lines = ms.map((m) => `${m.method}: ${summary(m.def.description)}`);
    const desc = `${g}; params: see infra_help\n${lines.join("\n")}`;
    const names = ms.map((m) => m.method) as [string, ...string[]];
    server.tool(
      `infra_${g}`,
      desc,
      { method: z.enum(names), params: z.record(z.unknown()).optional() },
      async (args: { method: string; params?: Record<string, unknown> }, extra: unknown) => {
        const m = byKey.get(`${g}.${args.method}`);
        if (!m) return errText(`Unknown method ${args.method} in infra_${g}`);
        const v = validateParams(m, args.params);
        if (!v.ok) return errText(v.error);
        return m.def.shape ? m.def.handler(v.value, extra) : m.def.handler(extra);
      },
    );
  }

  server.tool(
    "infra_help",
    "Full doc+schema of one method, e.g. devops.ssh_check",
    { method: z.string() },
    async ({ method }: { method: string }) => {
      const bare = method.replace(/^infra_/, "");
      let m = byKey.get(bare);
      if (!m) {
        const hits = all.filter((x) => x.method === bare);
        if (hits.length === 1) m = hits[0];
      }
      if (!m) {
        const near = all.filter((x) => x.method.includes(bare) || bare.includes(x.method)).slice(0, 10)
          .map((x) => `${x.group}.${x.method}`);
        return errText(`Unknown method "${method}". ${near.length ? "Did you mean: " + near.join(", ") : "Groups: " + GROUPS.join(", ")}`);
      }
      return text(JSON.stringify({
        tool: `infra_${m.group}`,
        method: m.method,
        legacy_name: m.def.name,
        description: m.def.description,
        params_schema: jsonSchemaOf(m.def),
      }, null, 2));
    },
  );
  return all;
}

/** MCP_LEGACY_TOOLS=1: also expose the old per-tool names, handlers untouched. */
export function registerLegacy(server: McpServer, reg: ToolRegistry): void {
  for (const d of reg.defs.values()) {
    const s: any = server;
    if (d.shape) s.tool(d.name, d.description, d.shape, d.handler);
    else s.tool(d.name, d.description, d.handler);
  }
}

// ── #1495 the tool tree ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One dispatcher c3_<section> per top section of the hierarchy that owns tools, plus c3_tree (browse) and c3_help (schema of one method).
 * Methods are free strings validated here, not enums: the list lives behind c3_tree, so the tool list stays small (the legacy infra_*
 * dispatchers already carry the per-method summaries).
 */
export function registerTree(server: McpServer, reg: ToolRegistry, h: Hier = loadHierarchy()): { tools: ReturnType<typeof arrange>["tools"]; unowned: string[] } {
  const { tools, unowned } = arrange(h, [...reg.defs.keys()]);
  const bySection = new Map<string, typeof tools>();
  for (const t of tools) bySection.set(t.section, [...(bySection.get(t.section) ?? []), t]);
  const byKey = new Map(tools.map((t) => [`${t.section}:${t.method}`, t]));
  const label = (id: string) => h.sections.find((x) => x.id === id)?.label ?? id;

  for (const [section, ts] of bySection) {
    const pages = [...new Set(ts.map((t) => t.path.split("/").slice(1).join("/") || section))].join(" ");
    server.tool(
      dispatcherOf(section),
      `${label(section)} tools of the Cloud-C3 hierarchy; method "<group>.<page>.<tool>", list with c3_tree {section:"${section}"}; pages: ${pages}`,
      { method: z.string(), params: z.record(z.unknown()).optional() },
      async (args: { method: string; params?: Record<string, unknown> }, extra: unknown) => {
        const t = byKey.get(`${section}:${args.method}`);
        if (!t) {
          const near = ts.filter((x) => x.method.includes(args.method) || args.method.includes(x.method)).slice(0, 8).map((x) => x.method);
          return errText(`Unknown method ${args.method} in ${dispatcherOf(section)}. ${near.length ? "Did you mean: " + near.join(", ") : `List them with c3_tree {section:"${section}"}`}`);
        }
        const def = reg.defs.get(t.name)!;
        const r = z.object(def.shape ?? {}).strict().safeParse(args.params ?? {});
        if (!r.success) {
          const issues = r.error.issues.map((i) => `${i.path.join(".") || "(params)"}: ${i.message}`).join("; ");
          return errText(`Invalid params for ${dispatcherOf(section)}.${t.method}: ${issues}. Call c3_help {method:"${section}:${t.method}"} for the schema.`);
        }
        return def.shape ? def.handler(r.data, extra) : def.handler(extra);
      },
    );
  }

  server.tool(
    "c3_tree",
    "Browse the tool tree (the Cloud-C3 app's hierarchy): no params = the sections; {section} = its pages with their methods; {node:'ops/orch/flow'} = one page with its tools and API route patterns",
    { section: z.string().optional(), node: z.string().optional() },
    async ({ section, node }: { section?: string; node?: string }) => {
      const ls = leaves(h);
      if (node) {
        const l = ls.get(node);
        if (!l) return errText(`Unknown node ${node}. Leaves: ${[...ls.keys()].slice(0, 12).join(", ")} ...`);
        const base = l.same_as ? ls.get(l.same_as) : undefined;
        return text(JSON.stringify({
          node: l.path, label: l.label, same_as: l.same_as, api: l.api,
          tools: tools.filter((t) => t.path === (base?.path ?? l.path)).map((t) => ({ method: t.method, dispatcher: dispatcherOf(t.section), legacy: t.name })),
        }, null, 2));
      }
      if (section) {
        return text(JSON.stringify({
          section, dispatcher: dispatcherOf(section),
          methods: tools.filter((t) => t.section === section).map((t) => ({ method: t.method, legacy: t.name, summary: summary(reg.defs.get(t.name)!.description) })),
        }, null, 2));
      }
      return text(JSON.stringify(h.sections.map((s) => ({ id: s.id, label: s.label, dispatcher: bySection.has(s.id) ? dispatcherOf(s.id) : null, tools: (bySection.get(s.id) ?? []).length })), null, 2));
    },
  );

  server.tool(
    "c3_help",
    "Full doc+schema of one tree method, e.g. ops:orch.flow.devops_workflows_gha_trigger (section:method) or a legacy name",
    { method: z.string() },
    async ({ method }: { method: string }) => {
      const t = byKey.get(method) ?? tools.find((x) => x.name === method || x.method === method);
      if (!t) return errText(`Unknown method "${method}". Browse with c3_tree.`);
      const def = reg.defs.get(t.name)!;
      return text(JSON.stringify({ tool: dispatcherOf(t.section), method: t.method, legacy_name: t.name, description: def.description, params_schema: jsonSchemaOf(def) }, null, 2));
    },
  );
  return { tools, unowned };
}

// ── #1495 the cloudy-android-mcp alias ──────────────────────────────────────────────────────────────────────────────

/**
 * The `superapp` + `superapp_help` dispatchers of the retired cloudy-android-mcp (cloud-superapp-mcp), served by the alias endpoint
 * (/mcp-android) for ONE release, so a client still configured under the old name keeps its tool names. Methods = the peers-control group.
 */
export function registerSuperappAlias(server: McpServer, reg: ToolRegistry): Method[] {
  const ms = methodsOf(reg).filter((m) => m.group === "peers");
  const by = new Map(ms.map((m) => [m.method, m]));
  const names = ms.map((m) => m.method) as [string, ...string[]];
  server.tool(
    "superapp",
    `Android constellation debug API + shell door (alias of cloudy-c3-mcp peers-control); params: see superapp_help\n${ms.map((m) => `${m.method}: ${summary(m.def.description)}`).join("\n")}`,
    { method: z.enum(names), params: z.record(z.unknown()).optional() },
    async (args: { method: string; params?: Record<string, unknown> }, extra: unknown) => {
      const m = by.get(args.method);
      if (!m) return errText(`Unknown method ${args.method} in superapp`);
      const v = validateParams(m, args.params);
      if (!v.ok) return errText(v.error);
      return m.def.shape ? m.def.handler(v.value, extra) : m.def.handler(extra);
    },
  );
  server.tool("superapp_help", "Full doc+schema of one method, e.g. logcat_full", { method: z.string() }, async ({ method }: { method: string }) => {
    const m = by.get(method.replace(/^superapp[_.]/, "").replace(/^peers[_.]/, ""));
    if (!m) return errText(`Unknown method "${method}". Methods: ${names.join(", ")}`);
    return text(JSON.stringify({ tool: "superapp", method: m.method, legacy_name: `superapp_${m.method}`, description: m.def.description, params_schema: jsonSchemaOf(m.def) }, null, 2));
  });
  return ms;
}
