// Test: drift detection now treats multi-container compose services (photoprism,
// crawlee-cloud, etherpad, hedgedoc, grist) as "deployed" when ANY of their declared
// container_name entries are running. Also validates glob-pattern matching
// (e.g. "photoprism_*") works.
//
// Usage: node test-drift-multi-container.ts
// Expected: exits 0 with PASS, non-zero on failure.

import assert from "node:assert/strict";

// The five functions under test live in code/shared/libs/health-match.ts —
// the SAME module the runtime's healthDrift() now uses (ticket #476). It has
// zero imports, so loading it needs no runtime (config, SSH, docker,
// filesystem). The old inline port is gone: a copy is what let this test
// drift from production in the first place.
import { hasGlob, globToRegex, isDeployed, isRunning, runningNames } from "./code/shared/libs/health-match.ts";

// ── Fixtures: declared container_names from build.json, deployed from docker ps
const cases: Array<{
    label: string;
    declared: string[];
    deployed: string[];
    expect: boolean;
}> = [
    // Previously reported as MISSING — these must now be OK.
    { label: "etherpad (multi-container)", declared: ["etherpad_app", "etherpad_postgres"], deployed: ["etherpad_app", "etherpad_postgres", "unrelated"], expect: true },
    { label: "grist (single but role-named)", declared: ["grist_app"], deployed: ["grist_app"], expect: true },
    { label: "hedgedoc", declared: ["hedgedoc_app", "hedgedoc_postgres"], deployed: ["hedgedoc_app", "hedgedoc_postgres"], expect: true },
    { label: "photoprism (3 roles)", declared: ["photoprism_app", "photoprism_mariadb", "photoprism_rclone"], deployed: ["photoprism_app", "photoprism_mariadb", "photoprism_rclone"], expect: true },
    // Partial deployment still counts as deployed (1 of N up).
    { label: "photoprism partial (only app up)", declared: ["photoprism_app", "photoprism_mariadb", "photoprism_rclone"], deployed: ["photoprism_app"], expect: true },
    // Service truly missing — zero matches.
    { label: "missing service", declared: ["etherpad_app", "etherpad_postgres"], deployed: ["something_else", "other"], expect: false },
    // Glob pattern — accepts ANY photoprism_* container.
    { label: "glob photoprism_*", declared: ["photoprism_*"], deployed: ["photoprism_app", "photoprism_mariadb"], expect: true },
    { label: "glob no match", declared: ["photoprism_*"], deployed: ["umami", "authelia"], expect: false },
    { label: "glob question mark", declared: ["redis?"], deployed: ["redis1"], expect: true },
    { label: "glob question mark no match", declared: ["redis?"], deployed: ["redis10"], expect: false },
    // Legacy single-container service where name matches exactly.
    { label: "legacy exact", declared: ["authelia"], deployed: ["authelia", "caddy"], expect: true },
    // Empty deployed — VM unreachable simulation.
    { label: "no deployed", declared: ["etherpad_app"], deployed: [], expect: false },
];

// ── Liveness cases (ticket #395) ──
// umami: all three declared containers were Exited yet drift said
// deployed=true status=ok. With the liveness filter they must be RED.
const livenessCases: Array<{
    label: string;
    declared: string[];
    deployed: Array<{ name: string; status?: string }>;
    expect: boolean;
}> = [
    // The ticket's exact scenario: nothing running, three Exited containers.
    { label: "umami all Exited", declared: ["umami", "umami-db", "umami-setup"], deployed: [
        { name: "umami", status: "Exited (143) 49 seconds ago" },
        { name: "umami-db", status: "Exited (0) 17 seconds ago" },
        { name: "umami-setup", status: "Exited (1) 8 hours ago" },
    ], expect: false },
    { label: "umami only setup Exited (init job)", declared: ["umami", "umami-db", "umami-setup"], deployed: [
        { name: "umami", status: "Up 8 hours (healthy)" },
        { name: "umami-db", status: "Up 8 hours (healthy)" },
        { name: "umami-setup", status: "Exited (1) 8 hours ago" },
    ], expect: true },
    { label: "umami app Up, db Exited", declared: ["umami", "umami-db", "umami-setup"], deployed: [
        { name: "umami", status: "Up 2 minutes (health: starting)" },
        { name: "umami-db", status: "Exited (0) 1 minute ago" },
        { name: "umami-setup", status: "Exited (1) 8 hours ago" },
    ], expect: true },
    // Long uptime format ("Up 6 weeks") and other non-running states.
    { label: "caddy-public Up 6 weeks", declared: ["caddy-public"], deployed: [
        { name: "caddy-public", status: "Up 6 weeks" },
    ], expect: true },
    { label: "Created is not running", declared: ["alerts-api"], deployed: [
        { name: "alerts-api", status: "Created" },
    ], expect: false },
    { label: "Dead is not running", declared: ["alerts-api"], deployed: [
        { name: "alerts-api", status: "Dead" },
    ], expect: false },
    { label: "Paused is not running", declared: ["alerts-api"], deployed: [
        { name: "alerts-api", status: "Paused" },
    ], expect: false },
    { label: "Restarting is not running", declared: ["alerts-api"], deployed: [
        { name: "alerts-api", status: "Restarting (1) 2 seconds ago" },
    ], expect: false },
    { label: "empty status is not running", declared: ["alerts-api"], deployed: [
        { name: "alerts-api", status: "" },
    ], expect: false },
];

let failed = 0;
let passed = 0;
for (const c of cases) {
    const got = isDeployed(c.declared, c.deployed);
    if (got !== c.expect) {
        console.log(`FAIL: ${c.label} — expected ${c.expect}, got ${got}`);
        failed++;
    } else {
        console.log(`  OK: ${c.label}`);
        passed++;
    }
}

// Liveness cases: mirror what healthDrift does — filter docker ps -a output
// down to running containers FIRST, then apply the same existence matcher.
for (const c of livenessCases) {
    const got = isDeployed(c.declared, runningNames(c.deployed));
    if (got !== c.expect) {
        console.log(`FAIL: ${c.label} — expected ${c.expect}, got ${got}`);
        failed++;
    } else {
        console.log(`  OK: ${c.label}`);
        passed++;
    }
}

// Also confirm the data flow from build.json → declared_names using a real
// fixture from disk. discoverServicesFromDisk should surface "containers" now.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Portable fixture lookup. This tester sits at
//   <repo>/infra-api_c3-infra-api/src/test-drift-multi-container.ts
// so two dirname() hops from import.meta.dirname reach the repo root — no
// hardcoded checkout paths (ticket #476/#479), resolves on the standalone
// clone and the cloud-infra a_solutions checkout alike.
function findPhotoprismBuildJson(): string {
    const repoRoot = join(dirname(import.meta.dirname), "..");
    const p = join(repoRoot, "user-media_photoprism", "build.json");
    try { readFileSync(p, "utf-8"); return p; } catch {
        throw new Error(`photoprism build.json not found at ${p}`);
    }
}
const photoprism = JSON.parse(readFileSync(findPhotoprismBuildJson(), "utf-8"));
const ppContainers = Object.values((photoprism.containers ?? {}) as Record<string, { container_name?: string }>)
    .map((c) => c.container_name)
    .filter((n): n is string => typeof n === "string" && n.length > 0);

assert.deepEqual(ppContainers.sort(), ["photoprism_app", "photoprism_mariadb", "photoprism_rclone"].sort(),
    "photoprism build.json should yield 3 container_name entries");
console.log("  OK: photoprism build.json yields [" + ppContainers.join(", ") + "]");

if (failed > 0) {
    console.log(`\nFAIL: ${failed}/${passed + failed} cases failed`);
    process.exit(1);
}
console.log(`\nPASS: ${passed}/${passed + failed} drift matching + liveness cases pass`);
