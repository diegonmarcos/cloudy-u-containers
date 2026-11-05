/**
 * The cloudy-c3-mcp tool tree (#1495): the tools of the registry arranged as the Cloud-C3 app's hierarchy, read from the ONE declared
 * hierarchy (shared/c3-hierarchy.json, generated in cloudy-u-android ac_cloud-c3/data by gen_c3_hierarchy.py from the app's build.json
 * plus the declared node -> route/tool mapping; vendored byte-equal with cloudy-c3-api, pinned by sha256 in test-c3-tree.mjs).
 *
 * Canonical tool = one dispatcher per top section, `c3_<section>`, method `<group>.<page>.<legacy name, dots as underscores>`
 * (a section with no groups, Home, has `<legacy name>` alone). The legacy dispatchers (infra_devops, ...) and the legacy per-tool
 * names stay as aliases, so no client breaks. Pure and import-free: the dependency-free tester runs it.
 */
import { readFileSync } from "node:fs";

export interface HNode { id: string; label: string; children?: HNode[]; api?: string[]; mcp?: string[]; same_as?: string }
export interface Hier { version: number; sections: HNode[]; containers: Record<string, any> }
export interface Leaf { path: string; label: string; api: string[]; mcp: string[]; same_as?: string }

export const HIERARCHY_URL = new URL("../shared/c3-hierarchy.json", import.meta.url);

export function loadHierarchy(url: URL = HIERARCHY_URL): Hier {
  return JSON.parse(readFileSync(url, "utf8")) as Hier;
}

/** Every leaf of the tree by its path (`ops/orch/flow`, `home`). */
export function leaves(h: Hier): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (nodes: HNode[], pre: string) => {
    for (const n of nodes) {
      const path = pre + n.id;
      if (n.children?.length) walk(n.children, path + "/");
      else out.set(path, { path, label: n.label, api: n.api ?? [], mcp: n.mcp ?? [], same_as: n.same_as });
    }
  };
  walk(h.sections, "");
  return out;
}

/** A tool pattern: the exact legacy dotted name, or a prefix ending in `*`. */
export function toolMatches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** The leaf that owns a legacy tool name: the most specific pattern wins (exact beats a prefix, a longer prefix beats a shorter). */
export function ownerOfTool(h: Hier, name: string): string | null {
  let best: { path: string; score: number } | null = null;
  for (const l of leaves(h).values()) {
    for (const p of l.mcp) {
      if (!toolMatches(p, name)) continue;
      const score = p.endsWith("*") ? p.length - 1 : Number.MAX_SAFE_INTEGER;
      if (!best || score > best.score) best = { path: l.path, score };
    }
  }
  return best?.path ?? null;
}

/** The method id of a legacy tool name under a leaf: `<group>.<page>.<name_with_underscores>`. */
export function treeMethod(path: string, name: string): string {
  const rest = path.split("/").slice(1);
  return [...rest, name.replaceAll(".", "_")].join(".");
}

export interface TreeTool { section: string; path: string; method: string; name: string }

/** Every owned tool of `names`, with its dispatcher section and method id; `unowned` lists the names no node owns. */
export function arrange(h: Hier, names: string[]): { tools: TreeTool[]; unowned: string[] } {
  const tools: TreeTool[] = [];
  const unowned: string[] = [];
  for (const name of names) {
    const path = ownerOfTool(h, name);
    if (!path) { unowned.push(name); continue; }
    tools.push({ section: path.split("/")[0], path, method: treeMethod(path, name), name });
  }
  return { tools, unowned };
}

/** The section dispatcher tool name. */
export const dispatcherOf = (section: string) => `c3_${section}`;
