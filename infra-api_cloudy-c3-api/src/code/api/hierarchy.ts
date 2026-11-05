/**
 * The cloudy-c3-api route tree (#1495): every route is served at its legacy path (unchanged, an alias forever for one release) AND under
 * its place in the Cloud-C3 app's hierarchy, `/<section>/<group>/<page>/<legacy path>`, e.g. GET /ops/orch/flow/workflows/gha ==
 * GET /workflows/gha. The tree is the ONE declared hierarchy (shared/c3-hierarchy.json, generated in cloudy-u-android ac_cloud-c3/data by
 * gen_c3_hierarchy.py from the app's build.json plus the declared node -> route/tool mapping; shared byte-equal with cloudy-c3-mcp, pinned
 * by sha256 in test-hierarchy.ts). A tree path is rewritten to the legacy path BEFORE routing (Fastify rewriteUrl), so auth, schemas and
 * handlers see the legacy route; a tree path whose remainder the page does not own is not rewritten and stays a 404.
 * Containers pages scope the same data by project (/containers/<project>/table/services?kind=mcp: the Filters row), see filterServices.
 * Pure and dependency-free: the tester runs it with node alone.
 */
import { readFileSync } from "node:fs";

export interface HNode { id: string; label: string; children?: HNode[]; api?: string[]; mcp?: string[]; same_as?: string }
export interface Hier { version: number; sections: HNode[]; containers: ContainersDecl }
export interface Kind { id: string; label: string; name_suffix: string[]; name_contains: string[]; category_prefix: string[] }
export interface Project { id: string; label: string; folder_prefix: string[]; name_prefix: string[] }
export interface ContainersDecl { default_project: string; projects: Project[]; name_overrides: Record<string, string>; default_kind: string; filters: Kind[] }
export interface Leaf { path: string; label: string; api: string[]; same_as?: string }

export const HIERARCHY_URL = new URL("../shared/c3-hierarchy.json", import.meta.url);

export function loadHierarchy(url: URL = HIERARCHY_URL): Hier {
  return JSON.parse(readFileSync(url, "utf8")) as Hier;
}

export function leaves(h: Hier): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  const walk = (nodes: HNode[], pre: string) => {
    for (const n of nodes) {
      const path = pre + n.id;
      if (n.children?.length) walk(n.children, path + "/");
      else out.set(path, { path, label: n.label, api: n.api ?? [], same_as: n.same_as });
    }
  };
  walk(h.sections, "");
  return out;
}

const segs = (p: string) => p.split("/").filter(Boolean);

/** A route pattern: `:x` is one segment, a trailing `*` is one or more segments, anything else is literal. */
export function routeMatches(pattern: string, path: string): boolean {
  const a = segs(pattern);
  const b = segs(path);
  if (a[a.length - 1] === "*") return b.length >= a.length && a.slice(0, -1).every((x, i) => x.startsWith(":") || x === b[i]);
  return a.length === b.length && a.every((x, i) => x.startsWith(":") || x === b[i]);
}

/** More literal segments first, an exact pattern before a wildcard one. */
function score(pattern: string): number {
  const a = segs(pattern);
  return a.filter((x) => !x.startsWith(":") && x !== "*").length * 2 + (pattern.endsWith("*") ? 0 : 1);
}

/** The leaf that owns a legacy route path: the most specific matching pattern. */
export function ownerOfRoute(h: Hier, path: string): string | null {
  let best: { path: string; s: number } | null = null;
  for (const l of leaves(h).values()) {
    for (const p of l.api) {
      if (routeMatches(p, path) && (!best || score(p) > best.s)) best = { path: l.path, s: score(p) };
    }
  }
  return best?.path ?? null;
}

/** The canonical (tree) path of a legacy route path, or null when no node owns it. */
export function canonicalPath(h: Hier, legacy: string): string | null {
  const o = ownerOfRoute(h, legacy);
  return o ? `/${o}${legacy.startsWith("/") ? "" : "/"}${legacy}` : null;
}

export interface Rewrite { url: string; scope?: { project: string } }

/**
 * Rewrite a tree URL to its legacy URL (query kept). A URL that is not under a tree prefix, or whose remainder the page does not own,
 * is returned unchanged. A Containers project page other than the base adds `project=<id>` to the query.
 */
export function rewriteTreeUrl(h: Hier, url: string, ls: Map<string, Leaf> = leaves(h)): string {
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const query = q < 0 ? "" : url.slice(q);
  const s = segs(path);
  if (!s.length) return url;
  // the longest tree prefix first: a leaf is 1 (home), 2 or 3 segments
  for (const n of [3, 2, 1]) {
    if (s.length <= n) continue;
    const prefix = s.slice(0, n).join("/");
    const leaf = ls.get(prefix);
    if (!leaf) continue;
    const legacy = "/" + s.slice(n).join("/");
    const owner = ownerOfRoute(h, legacy);
    const base = leaf.same_as ?? leaf.path;
    if (owner !== base) return url;
    const scoped = leaf.same_as && s[0] === "containers" ? `${query ? query + "&" : "?"}project=${encodeURIComponent(s[1])}` : query;
    return legacy + scoped;
  }
  return url;
}

// ── Containers: the project tabs and the Filters row ──────────────────────────────────────────────────────────────

/** The kind (Filters row) of a container: the first filter whose name rule matches, else the first whose category prefix matches, else the default. */
export function kindOf(c: ContainersDecl, name: string, category = ""): string {
  const byName = c.filters.find((f) => f.name_suffix.some((x) => name.endsWith(x)) || f.name_contains.some((x) => name.includes(x)));
  if (byName) return byName.id;
  const byCat = c.filters.find((f) => category && f.category_prefix.some((x) => category.startsWith(x)));
  return byCat?.id ?? c.default_kind;
}

/** The project (tab) of a container: its explicit override, else the first project whose folder or name prefix matches, else the default. */
export function projectOf(c: ContainersDecl, name: string, folder = ""): string {
  const o = c.name_overrides[name];
  if (o) return o;
  const p = c.projects.find((x) => x.folder_prefix.some((f) => folder.startsWith(f)) || x.name_prefix.some((f) => name.startsWith(f)));
  return p?.id ?? c.default_project;
}

/** `?project=<id>&kind=<id>` on a list of services; `all` or no value keeps everything. */
export function filterServices<T extends { name: string; category?: string }>(
  c: ContainersDecl, list: T[], q: { project?: string; kind?: string }, folderOf: (name: string) => string = () => "",
): T[] {
  return list.filter((x) =>
    (!q.project || q.project === "all" || projectOf(c, x.name, folderOf(x.name)) === q.project)
    && (!q.kind || q.kind === "all" || kindOf(c, x.name, x.category) === q.kind));
}
