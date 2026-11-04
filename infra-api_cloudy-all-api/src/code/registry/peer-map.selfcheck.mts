/**
 * Self-check for peer-map.ts — run it, do not read it and hope.
 *
 *   npx tsx peer-map.selfcheck.mts
 *
 * (`node --experimental-strip-types` cannot run this: the module under test
 * imports with `.js` specifiers, and the loader dies on resolution BEFORE the
 * first assertion — exiting non-zero while printing nothing that looks like a
 * failed assertion. Use tsx, and read the assertion count it prints.)
 *
 * Exits non-zero on the first failed assertion. No framework, no fixtures
 * directory: it builds throwaway container layouts under the OS temp dir.
 *
 * Two defects are pinned here, both of the same shape — a lookup that resolves
 * to a stale name and returns an empty result without raising:
 *
 *   1. The peer map filename must follow the container's declared `name`, so
 *      renaming a container cannot silently leave the registry empty.
 *   2. The name must come from the declaration of the container BEING RUN. This
 *      module is symlinked into sibling containers; deriving the root from its
 *      own (symlink-resolved) location lands in the pre-rename tree and
 *      re-derives the OLD name. Assertions 5-7 reproduce that exact layout.
 *
 * And the failure mode itself: a container that cannot identify itself must
 * RAISE, never hand back an empty candidate list that reads like success.
 */
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import assert from "node:assert/strict";

const moduleSource = join(import.meta.dirname, "peer-map.ts");
let passed = 0;
function check(description: string, body: () => void): void {
  body();
  passed += 1;
  console.log(`  ok ${passed} — ${description}`);
}

// ---------------------------------------------------------------------------
// Part 1 — findDeclarationRoot, against a fabricated TWO-container layout that
// reproduces the real symlink: cloud-services-mcp borrows the registry module
// that physically lives in the pre-rename c3-services-api tree.
// ---------------------------------------------------------------------------
const fleet = mkdtempSync(join(tmpdir(), "peer-map-fleet-"));
const oldTree = join(fleet, "infra-api_c3-services-api", "src");
const newTree = join(fleet, "infra-api_cloud-services-mcp", "src");

mkdirSync(join(oldTree, "code", "registry"), { recursive: true });
mkdirSync(join(newTree, "code", "mcp"), { recursive: true });
writeFileSync(join(oldTree, "build.json"), JSON.stringify({ name: "c3-services-api" }));
writeFileSync(join(newTree, "build.json"), JSON.stringify({ name: "cloud-services-mcp" }));
cpSync(moduleSource, join(oldTree, "code", "registry", "peer-map.ts"));
// The real tree's link: <new>/src/code/registry -> <old>/src/code/registry
symlinkSync(join(oldTree, "code", "registry"), join(newTree, "code", "registry"));

const { findDeclarationRoot, peerMapCandidates, describeCandidates } = await import(moduleSource);

check("the entry point's tree is the declaration root", () => {
  const entryPoint = join(newTree, "code", "mcp", "http.ts");
  assert.equal(findDeclarationRoot(dirname(entryPoint)), realpathSync(newTree));
});

check("walking up from the SYMLINKED module lands in the pre-rename tree (the #378 defect)", () => {
  // Not an endorsement — this pins the wrong answer so the fix cannot regress
  // into it unnoticed. import.meta.dirname reports exactly this resolved path.
  const asResolvedByNode = realpathSync(join(newTree, "code", "registry"));
  assert.equal(findDeclarationRoot(asResolvedByNode), realpathSync(oldTree));
});

check("those two roots are genuinely different trees", () => {
  const fromEntry = findDeclarationRoot(join(newTree, "code", "mcp"));
  const fromModule = findDeclarationRoot(realpathSync(join(newTree, "code", "registry")));
  assert.notEqual(fromEntry, fromModule);
});

check("a root with no build.json above it yields null, never a guess", () => {
  const orphan = mkdtempSync(join(tmpdir(), "peer-map-orphan-"));
  assert.equal(findDeclarationRoot(orphan), null);
  rmSync(orphan, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Part 2 — end to end, as production runs it: a child process whose ENTRY POINT
// sits in one tree while the registry module it imports lives in the other.
// This is the assertion that goes red if the fallback re-derives the old name.
// ---------------------------------------------------------------------------
function candidatesFromEntryPoint(entryPoint: string): { status: number; output: string } {
  mkdirSync(dirname(entryPoint), { recursive: true });
  writeFileSync(
    entryPoint,
    `import { peerMapCandidates } from "../registry/peer-map.js";\n` +
      `console.log(JSON.stringify(peerMapCandidates()));\n`
  );
  try {
    const output = execFileSync("npx", ["tsx", entryPoint], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, output };
  } catch (e: any) {
    return { status: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

check("a container running its OWN entry point derives its OWN peer map name", () => {
  const run = candidatesFromEntryPoint(join(newTree, "code", "mcp", "http.ts"));
  assert.equal(run.status, 0, `expected a clean run, got:\n${run.output}`);
  assert.match(run.output, /build-cloud-services-mcp\.json/);
  assert.doesNotMatch(
    run.output,
    /build-c3-services-api\.json/,
    "the symlinked module must not re-derive the pre-rename name"
  );
});

check("the pre-rename container still derives ITS name — the fix is not a new literal", () => {
  const run = candidatesFromEntryPoint(join(oldTree, "code", "api", "server.ts"));
  assert.equal(run.status, 0, `expected a clean run, got:\n${run.output}`);
  assert.match(run.output, /build-c3-services-api\.json/);
});

check("no derivable declaration RAISES — it never returns a quiet empty list", () => {
  const nowhere = mkdtempSync(join(tmpdir(), "peer-map-nowhere-"));
  mkdirSync(join(nowhere, "registry"), { recursive: true });
  cpSync(moduleSource, join(nowhere, "registry", "peer-map.ts"));
  // Entry point with no build.json in any ancestor, and (on a build host) no
  // /app/build.json either — the shipped image always has one, so this case can
  // only arise where the container genuinely cannot identify itself.
  const run = candidatesFromEntryPoint(join(nowhere, "mcp", "http.ts"));
  assert.notEqual(run.status, 0, `expected a non-zero exit, got:\n${run.output}`);
  assert.match(run.output, /peer map name is underivable/);
  assert.doesNotMatch(run.output, /^\[\]$/m, "an empty list is exactly the silent answer being forbidden");
  rmSync(nowhere, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Part 3 — describeCandidates still reports where a present-but-unreadable peer
// map was looked for. "empty registry" alone is the report this fix outlaws.
// ---------------------------------------------------------------------------
check("describeCandidates names the paths tried", () => {
  assert.equal(describeCandidates(["/app/build-x.json"]), "tried: /app/build-x.json");
});

check("peerMapCandidates is callable in this tree and names this container", () => {
  // process.argv[1] here is this self-check, inside the c3-services-api tree.
  assert.match(peerMapCandidates().join(","), /build-c3-services-api\.json/);
});

rmSync(fleet, { recursive: true, force: true });
console.log(`peer-map selfcheck: ${passed} assertions passed`);
