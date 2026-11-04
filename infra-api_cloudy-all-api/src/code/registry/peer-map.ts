/**
 * Where this container's derived peer map lives.
 *
 * The ship engine writes `1_cloud-configs/dist/build-<name>.json`, where
 * `<name>` is the `name` field of the container's OWN `build.json`, and the
 * image carries that file at `/app/build-<name>.json`.
 *
 * Both consumers of this module used to restate that filename as the literal
 * "build-c3-services-api.json". When the container was renamed to
 * cloud-services-mcp its image began carrying `build-cloud-services-mcp.json`,
 * the literal stopped matching, and the loaders fell straight through to their
 * "no file found" branch. The result was not a loud failure: the registry held
 * ZERO services, `getBaseUrl()` returned null for everything, and every tool
 * silently used its hardcoded fallback address instead of the declared one —
 * which is how `infra.matomo.*` kept dialling 10.0.0.4 while the declaration
 * said 10.0.0.6.
 *
 * So: read the name from the declaration, never restate it here. A future
 * rename then costs nothing.
 *
 * Deriving the name is only half of it — the OTHER half is deriving it from the
 * RIGHT declaration. This module physically lives in
 * `infra-api_c3-services-api/src/code/registry/` and is symlinked into sibling
 * containers, so its own location names the container it was written for, not
 * the container that is running. `import.meta.dirname` reports the resolved
 * real path (Node follows symlinks unless `--preserve-symlinks` is set), so
 * walking up from THIS FILE always lands in the pre-rename c3-services-api tree
 * and re-derives the OLD name — quietly, and for every container that borrows
 * the module. `fs.realpathSync` does not help: the path is already resolved,
 * and resolving harder only arrives at the wrong tree more confidently.
 *
 * The container's identity comes from the PROGRAM BEING RUN, so the development
 * root is derived by walking up from the entry point. A shared library file
 * cannot know which container it was linked into; the entry point always does.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The deployed image root. Checked first; in a container it always matches. */
const DEPLOYED_ROOT = "/app";

/**
 * Nearest ancestor of `startDirectory` that holds a `build.json`, or null.
 * Exported so the self-check can exercise it against a fabricated container
 * layout instead of whatever tree the test runner happens to live in.
 */
export function findDeclarationRoot(startDirectory: string): string | null {
  let directory = resolve(startDirectory);
  for (;;) {
    if (existsSync(join(directory, "build.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * The development tree of the running program — NOT of this file. See the
 * header: deriving it from this module's location re-derives the old name.
 */
function developmentRoot(): string | null {
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;
  return findDeclarationRoot(dirname(resolve(entryPoint)));
}

/** Roots that may hold this container's `build.json`, most specific first. */
export function declarationRoots(): string[] {
  const developmentTree = developmentRoot();
  return developmentTree === null ? [DEPLOYED_ROOT] : [DEPLOYED_ROOT, developmentTree];
}

/**
 * Candidate paths for the peer map, most specific first.
 *
 * Throws when no root yields a readable declaration. That is deliberate: the
 * only alternative is to invent a filename from whichever directory we happened
 * to land in, and a guessed filename that does not match produces an EMPTY
 * registry that raises nothing — indistinguishable from a working one, which is
 * precisely how this defect hid for weeks. A container that cannot identify
 * itself must stop, not serve every tool a silent hardcoded fallback.
 */
export function peerMapCandidates(): string[] {
  const roots = declarationRoots();
  const candidates: string[] = [];
  for (const root of roots) {
    const ownDeclaration = join(root, "build.json");
    if (!existsSync(ownDeclaration)) continue;
    try {
      const { name } = JSON.parse(readFileSync(ownDeclaration, "utf-8")) as { name?: string };
      if (name) candidates.push(join(root, `build-${name}.json`));
    } catch {
      // A build.json we cannot parse tells us nothing about the peer map's
      // name. Try the next root rather than guessing a filename.
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      `peer map name is underivable: no build.json with a "name" was readable in any of ` +
        `${roots.join(", ")}. Refusing to guess a filename — a guessed name yields an empty ` +
        `registry that reports no error, which is the failure this module exists to prevent.`
    );
  }
  return candidates;
}

/**
 * Human-readable account of where we looked, for error messages. A loader that
 * cannot find its peer map must say which paths it tried — "empty registry"
 * on its own is exactly the confident-but-wrong report this fix exists to stop.
 */
export function describeCandidates(candidates: string[]): string {
  return `tried: ${candidates.join(", ")}`;
}
