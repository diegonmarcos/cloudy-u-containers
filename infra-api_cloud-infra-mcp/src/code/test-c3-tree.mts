// Hierarchy parity guard for cloudy-c3-mcp (#1495): every registered tool is owned by exactly one node of the ONE declared hierarchy
// (shared/c3-hierarchy.json, generated from the Cloud-C3 app's build.json in cloudy-u-android and shared byte-equal with cloudy-c3-api),
// no mapping pattern is dead, tree method ids are unique, the peers-control group is complete. No network, no SDK.
// Run: node --experimental-strip-types test-c3-tree.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { arrange, dispatcherOf, leaves, loadHierarchy, ownerOfTool, toolMatches, treeMethod } from "./mcp/tree.ts";

let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`ok - ${name}`); };

/** The pin: change it together with ac_cloud-c3/data/c3_hierarchy.json (the app's generator), in the same release. */
const HIERARCHY_SHA256 = "cf6a9dbb0727b2be4e7a99c2b7e37e4c037f48191136c0e698c22aa75aa9221b";

/** The tool names of every register*Tools in mcp/tools (meta.ts is the retired stdio server's, not in the registry). */
function toolNames(): string[] {
  const dir = new URL("./mcp/tools/", import.meta.url);
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && x !== "meta.ts")) {
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const m of src.matchAll(/\btool\(\s*["'`]([A-Za-z0-9_.\-]+)["'`]/g)) out.push(m[1]);
  }
  return out;
}

const h = loadHierarchy();
const names = toolNames();
const L = leaves(h);

t("the hierarchy file is the pinned one (same bytes as cloudy-c3-api, generated in cloudy-u-android)", () => {
  assert.equal(createHash("sha256").update(readFileSync(new URL("./shared/c3-hierarchy.json", import.meta.url))).digest("hex"), HIERARCHY_SHA256);
});

t("the sections are the Cloud-C3 app's, in the app's order", () => {
  assert.deepEqual(h.sections.map((s) => s.id), ["infra", "containers", "home", "ops", "observ", "configs"]);
  assert.deepEqual(h.sections[0].children!.map((g) => g.id), ["bare", "apis", "personal", "domains_row"]);
  assert.deepEqual(h.sections[3].children!.map((g) => g.id), ["net", "mail", "orch", "ops_health", "obs"]);
  assert.deepEqual(h.containers.filters.map((f: any) => f.id), ["mcp", "api", "apps", "db", "repo"]);
});

t("the registry is non-trivial and its names are unique", () => {
  assert.ok(names.length >= 180, `only ${names.length} tools found`);
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
});

t("every tool is owned by exactly one node (no unowned tool)", () => {
  const { unowned } = arrange(h, names);
  assert.deepEqual(unowned, []);
});

t("no mapping pattern is dead: each one matches a registered tool", () => {
  for (const l of L.values()) for (const p of l.mcp) assert.ok(names.some((x) => toolMatches(p, x)), `${l.path}: pattern ${p} matches no tool`);
});

t("an exact pattern beats a prefix, a longer prefix beats a shorter", () => {
  assert.equal(ownerOfTool(h, "obs.finops.cloud_summary"), "home");
  assert.equal(ownerOfTool(h, "obs.finops.oci_costs"), "infra/bare/providers");
  assert.equal(ownerOfTool(h, "obs.health.mail_up"), "ops/mail/map");
  assert.equal(ownerOfTool(h, "obs.health.drift"), "ops/orch/orchestration");
  assert.equal(ownerOfTool(h, "obs.health.cloud"), "observ/health");
  assert.equal(ownerOfTool(h, "obs.health.tier2"), "ops/ops_health/uptime");
  assert.equal(ownerOfTool(h, "devops.workflows.dagu_trigger"), "observ/dagu");
  assert.equal(ownerOfTool(h, "devops.workflows.gha_trigger"), "ops/orch/flow");
  assert.equal(ownerOfTool(h, "devops.build.secrets_status"), "ops/net/security");
  assert.equal(ownerOfTool(h, "devops.build.ship"), "ops/orch/release");
  assert.equal(ownerOfTool(h, "devops.docker.volume_ls"), "infra/bare/storage");
  assert.equal(ownerOfTool(h, "devops.docker.ps"), "containers/all/table");
  assert.equal(ownerOfTool(h, "obs.debug.docker_logs_search"), "ops/obs/logs");
  assert.equal(ownerOfTool(h, "obs.debug.phone_logs"), "infra/personal/control");
  assert.equal(ownerOfTool(h, "no.such.tool"), null);
});

t("tree method ids are unique per section and round-trip the legacy name", () => {
  const { tools } = arrange(h, names);
  const seen = new Set<string>();
  for (const x of tools) {
    const k = `${x.section}:${x.method}`;
    assert.ok(!seen.has(k), `collision ${k}`);
    seen.add(k);
    assert.equal(x.method.endsWith(x.name.replaceAll(".", "_")), true);
  }
  assert.equal(treeMethod("ops/orch/flow", "devops.workflows.gha_trigger"), "orch.flow.devops_workflows_gha_trigger");
  assert.equal(treeMethod("home", "obs.finops.cloud_summary"), "obs_finops_cloud_summary");
  assert.equal(dispatcherOf("ops"), "c3_ops");
});

t("peers-control: the merged cloudy-android-mcp tools are all in the registry and in Infra > Personal > Control", () => {
  const peers = names.filter((x) => x.startsWith("peers.")).map((x) => x.slice(6)).sort();
  assert.deepEqual(peers, ["adb_autoconnect", "adb_pair", "adb_status", "apps", "call", "crashes", "docs", "force_stop", "grant", "input", "logcat", "logcat_full", "screencap", "shell", "wake"]);
  for (const p of peers) assert.equal(ownerOfTool(h, `peers.${p}`), "infra/personal/control");
  for (const p of ["phone_public", "phone_mesh", "phone_logs"]) assert.equal(ownerOfTool(h, `obs.debug.${p}`), "infra/personal/control");
});

t("every node a tool lives on is a real leaf of the tree, scoped containers pages inherit", () => {
  for (const l of L.values()) if (l.same_as) assert.ok(L.has(l.same_as), `${l.path} -> ${l.same_as}`);
  const { tools } = arrange(h, names);
  for (const x of tools) assert.ok(L.has(x.path) && !L.get(x.path)!.same_as, x.path);
});

console.log(`${n} passed`);
