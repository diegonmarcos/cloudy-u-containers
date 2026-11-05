// Hierarchy parity guard for cloudy-c3-api (#1495): every route is owned by exactly one node of the ONE declared hierarchy
// (code/shared/c3-hierarchy.json, generated from the Cloud-C3 app's build.json in cloudy-u-android and shared byte-equal with cloudy-c3-mcp),
// no mapping pattern is dead, a tree path serves the same route as its legacy path, legacy paths are untouched, the Containers
// project tabs and Filters scope the services list. No network, no server.
// Usage: node test-hierarchy.ts   (exit 0 = PASS)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { canonicalPath, filterServices, kindOf, leaves, loadHierarchy, ownerOfRoute, projectOf, rewriteTreeUrl, routeMatches } from "./code/api/hierarchy.ts";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok - ${name}`); };

/** The pin: change it together with ac_cloud-c3/data/c3_hierarchy.json (the app's generator) and cloudy-c3-mcp's test-c3-tree.mts. */
const HIERARCHY_SHA256 = "a2080c1558398f1790814376c6ada958432239d388dd7510e39f47c7c9935ed0";

/** Every registered route path of routes/*.ts, `/:kind(apk|containers)/...` expanded, template parts as a parameter. */
function routes(): string[] {
  const dir = new URL("./code/api/routes/", import.meta.url);
  const out = new Set<string>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/\b(?:app|fastify)\.(?:get|post|put|delete|patch)(?:<[^()]*>)?\(\s*["'`](\/[^"'`]*)["'`]/g)) {
      const raw = m[1].replace(/\$\{[^}]*\}/g, ":p");
      const k = raw.match(/^\/:kind\(([^)]+)\)(.*)$/);
      if (k) for (const kind of k[1].split("|")) out.add(`/${kind}${k[2]}`);
      else out.add(raw);
    }
  }
  return [...out];
}

const h = loadHierarchy();
const L = leaves(h);
const all = routes();

t("the hierarchy file is the pinned one (same bytes as cloudy-c3-mcp, generated in cloudy-u-android)", () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL("./code/shared/c3-hierarchy.json", import.meta.url))).digest("hex"), HIERARCHY_SHA256);
});

t("the route list is non-trivial", () => assert.ok(all.length >= 130, `only ${all.length} routes found`));

t("every route is owned by exactly one node of the tree (no unowned route)", () => {
  const unowned = all.filter((r) => ownerOfRoute(h, r) === null);
  assert.deepEqual(unowned, []);
});

t("no mapping pattern is dead: each one matches a registered route", () => {
  for (const l of L.values()) for (const p of l.api) assert.ok(all.some((r) => routeMatches(p, r)), `${l.path}: pattern ${p} matches no route`);
});

t("no two nodes own the same pattern, and a scoped project page owns nothing of its own", () => {
  const seen = new Map<string, string>();
  for (const l of L.values()) {
    for (const p of l.api) { assert.ok(!seen.has(p), `${p}: ${l.path} and ${seen.get(p)}`); seen.set(p, l.path); }
    if (l.same_as) assert.equal(l.api.length, 0, l.path);
  }
});

t("every legacy route path is untouched by the rewrite (the old paths stay)", () => {
  for (const r of all) {
    const url = r.replace(/:[A-Za-z]+/g, "x").replace(/\*/g, "x");
    assert.equal(rewriteTreeUrl(h, url, L), url, r);
    assert.equal(rewriteTreeUrl(h, `${url}?a=1&b=2`, L), `${url}?a=1&b=2`, r);
  }
});

t("every route is also served under its tree path: tree -> legacy round-trips for every route", () => {
  for (const r of all) {
    const url = r.replace(/:[A-Za-z]+/g, "x").replace(/\*/g, "x");
    const tree = canonicalPath(h, url)!;
    assert.ok(tree, r);
    assert.equal(rewriteTreeUrl(h, tree, L), url, `${tree} -> ${url}`);
    assert.equal(rewriteTreeUrl(h, `${tree}?n=5`, L), `${url}?n=5`);
  }
});

t("the tree of the owner: Infra, Containers, Ops, and the other top sections, with example canonical paths", () => {
  assert.equal(canonicalPath(h, "/workflows/gha"), "/ops/orch/flow/workflows/gha");
  assert.equal(canonicalPath(h, "/workflows/dagu"), "/observ/dagu/workflows/dagu");
  assert.equal(canonicalPath(h, "/cloud/oci/costs"), "/infra/bare/providers/cloud/oci/costs");
  assert.equal(canonicalPath(h, "/ai/usage"), "/infra/apis/api_ai/ai/usage");
  assert.equal(canonicalPath(h, "/security/scan"), "/ops/net/security/security/scan");
  assert.equal(canonicalPath(h, "/security/wireguard"), "/ops/net/wg/security/wireguard");
  assert.equal(canonicalPath(h, "/services"), "/containers/all/table/services");
  assert.equal(canonicalPath(h, "/alerts/rules"), "/ops/obs/alerts/alerts/rules");
  assert.equal(canonicalPath(h, "/health/status"), "/observ/health/health/status");
  assert.equal(canonicalPath(h, "/health/tier1"), "/observ/health/health/tier1");
  assert.equal(canonicalPath(h, "/health/db"), "/ops/ops_health/uptime/health/db");
  assert.equal(canonicalPath(h, "/fleet/profile"), "/configs/general/fleet/profile");
  assert.equal(canonicalPath(h, "/cloud/summary"), "/home/cloud/summary");
});

t("a tree path the page does not own is not rewritten (404, not another page's route)", () => {
  assert.equal(rewriteTreeUrl(h, "/ops/obs/logs/services", L), "/ops/obs/logs/services");
  assert.equal(rewriteTreeUrl(h, "/ops/orch/flow", L), "/ops/orch/flow");
  assert.equal(rewriteTreeUrl(h, "/nope/x/y/services", L), "/nope/x/y/services");
});

t("Containers: a project tab is the same data scoped by project; the Filters row is the kind query", () => {
  assert.equal(rewriteTreeUrl(h, "/containers/all/table/services", L), "/services");
  assert.equal(rewriteTreeUrl(h, "/containers/cloudy/table/services", L), "/services?project=cloudy");
  assert.equal(rewriteTreeUrl(h, "/containers/capital/topology/cloud-data/topology?kind=api", L), "/cloud-data/topology?kind=api&project=capital");
  assert.equal(rewriteTreeUrl(h, "/containers/cloudy/table/ai/usage", L), "/containers/cloudy/table/ai/usage", "another page's route is not served here");
  assert.equal(rewriteTreeUrl(h, "/containers/foo/logs", L), "/containers/foo/logs", "the legacy /containers/:name/logs is not a tree path");
});

t("Containers filters and projects: kind by name rule then category, project by override, folder or name prefix, else the default", () => {
  const c = h.containers;
  assert.deepEqual(c.filters.map((f) => f.id), ["mcp", "api", "apps", "db", "repo"]);
  assert.deepEqual(c.projects.map((p) => p.id), ["cloudy", "cloud_me", "cg", "capital", "hardtech", "others"]);
  assert.equal(kindOf(c, "cloudy-c3-mcp"), "mcp");
  assert.equal(kindOf(c, "cloudy-c3-api"), "api");
  assert.equal(kindOf(c, "some-postgres"), "db");
  assert.equal(kindOf(c, "caddy", "Ops-API-MCP-x"), "mcp");
  assert.equal(kindOf(c, "caddy"), "apps");
  assert.equal(projectOf(c, "x", "infra-api_cloudy-c3-api"), "cloudy");
  assert.equal(projectOf(c, "capital-stack-x"), "capital");
  assert.equal(projectOf(c, "x", "user-fin_x"), "capital");
  assert.equal(projectOf(c, "unknown-thing", "zzz"), c.default_project);
  const list = [{ name: "cloudy-c3-mcp" }, { name: "cloudy-c3-api" }, { name: "capital-stack-finterm-api" }];
  const folder = (n: string) => (n.startsWith("cloudy") ? "infra-api_" + n : "user-fin_" + n);
  assert.deepEqual(filterServices(c, list, { kind: "mcp" }, folder).map((x) => x.name), ["cloudy-c3-mcp"]);
  assert.deepEqual(filterServices(c, list, { project: "capital" }, folder).map((x) => x.name), ["capital-stack-finterm-api"]);
  assert.deepEqual(filterServices(c, list, { project: "cloudy", kind: "api" }, folder).map((x) => x.name), ["cloudy-c3-api"]);
  assert.equal(filterServices(c, list, { project: "all", kind: "all" }, folder).length, 3);
});

t("the sections are the Cloud-C3 app's, in the app's order", () => {
  assert.deepEqual(h.sections.map((s) => s.id), ["infra", "containers", "home", "ops", "observ", "configs"]);
  assert.deepEqual(h.sections[0].children!.map((g) => g.id), ["bare", "apis", "personal", "domains_row"]);
  assert.deepEqual(h.sections[3].children!.map((g) => g.id), ["net", "mail", "orch", "ops_health", "obs"]);
});

console.log(`${n} passed`);
