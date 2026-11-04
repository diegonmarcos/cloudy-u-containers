import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join } from "path";

export const HOME = homedir();
// GIT_ROOT is the env var compose.nix actually sets on this container
// (buildJson.runtime.octocode.repos_path, e.g. "/repos" in prod — see
// src/compose.nix). GIT_BASE is kept as a secondary override name for
// back-compat with any caller that still sets it explicitly. Preferring
// GIT_ROOT fixes a latent mismatch: before this, GIT_BASE always fell
// through to `${HOME}/git`, which is NOT where the octocode repos volume
// is mounted, so every REPOS-derived path below silently pointed at a
// directory that doesn't exist in the container.
export const GIT_BASE = process.env.GIT_ROOT ?? process.env.GIT_BASE ?? join(HOME, "git");

// Android/Termux detection — WireGuard is managed by the Android WG app,
// so mesh IPs work. Key paths differ from desktop NixOS.
export const IS_ANDROID = process.env.ANDROID_DATA !== undefined
  || HOME.includes("com.termux");

// Server mode = Docker container on VM (repos are disposable clones).
// Client mode = local machine (Termux/desktop) where repos are working copies.
// In client mode, NEVER run destructive git ops — the user's working copy IS truth.
export const IS_SERVER = existsSync("/.dockerenv")
  || process.env.CONTAINER === "true"
  || process.env.MCP_SERVER_MODE === "true";
export const IS_CLIENT = !IS_SERVER;

// SSH identity key — find first available key across environments:
//   Docker container: ~/.ssh/vault_id_rsa (mounted from VM)
//   Android/Termux:   ~/.ssh/id_rsa (symlinked from vault)
//   Desktop NixOS:    cloud-vault/A0_keys/ssh/id_rsa
export const SSH_IDENTITY = [
  join(HOME, ".ssh/vault_id_rsa"),
  join(HOME, ".ssh/id_rsa"),
  join(HOME, ".ssh/id_ed25519"),
  join(GIT_BASE, "cloud-vault/A0_keys/ssh/id_rsa"),
].find((p) => existsSync(p)) ?? join(HOME, ".ssh/id_rsa");
// 2026-08-21: was join(GIT_BASE, "cloud/a_solutions") — "cloud" is the
// PRE-RENAME repo dirname. The checkout under GIT_BASE is named "cloud-infra"
// (see .runtime.octocode.index_repos / repo_map below); the stale segment
// made every path derived from SOLUTIONS_DIR (BUILD_SCRIPT, the cloud-data
// dev-fallback candidates, getOwnBuildPath) resolve to a directory that does
// not exist in the container.
export const SOLUTIONS_DIR = join(GIT_BASE, "cloud-infra", "a_solutions");

// CLOUD_DATA_DIR / CLOUD_DATA_REPO declared early so resolveCloudDataPath can
// reference them. Used as a legacy fallback path (the c3_git_repos volume clone).
export const CLOUD_DATA_DIR = join(GIT_BASE, "cloud-data");
export const CLOUD_DATA_REPO = "git@github.com:diegonmarcos/cloud-data.git";

// Cloud-data file resolution.
//
// 2026-04-27 migrated: cloud-data-{topology,configs,deps}.json → _cloud-data-consolidated.json[.{configs,deps}]
// All three deprecated split files are now slices of `_cloud-data-consolidated.json`:
//   - topology shape  → consolidated top-level (consolidated IS a superset of topology)
//   - configs slice   → consolidated.configs
//   - deps slice      → consolidated.deps
// Back-compat: getConfigPath / CONFIGS_PATH / DEPS_PATH all resolve to the
// consolidated file. Use getConfigsSlice() / getDepsSlice() / getTopologySlice()
// to pull the relevant nested key.
//
// 2026-04-27: priority puts IN-IMAGE bundled copies first — every container with
// `build.include_cloud_data: true` gets 1_cicd/dist/*.json copied into its
// image at /app/<filename>. Falls back to dev repo dist/, c3_git_repos clone,
// and cloud repo root for backwards compatibility.
// 2026-04-27 migrated: ENV var (CONFIG_JSON_PATH / CONFIG_PATH) overrides apply
// when the caller asks for the consolidated file (the new topology source) OR the
// legacy topology filename (back-compat for any external caller).
function resolveCloudDataPath(filename: string): string {
  const isTopology = filename === "_cloud-data-consolidated.json" || filename === "cloud-data-topology.json";
  if (isTopology && process.env.CONFIG_JSON_PATH) return process.env.CONFIG_JSON_PATH;
  if (isTopology && process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  const candidates = [
    `/app/${filename}`,                                            // bundled in-image (preferred)
    join(SOLUTIONS_DIR, "..", "1_cloud-configs", "dist", filename),      // dev: cloud repo dist/
    join(CLOUD_DATA_DIR, filename),                                // legacy: c3_git_repos clone
    join(SOLUTIONS_DIR, "..", filename),                           // legacy: cloud repo root
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]; // best-guess for error paths
}

// 2026-04-27 migrated: cloud-data-topology.json → _cloud-data-consolidated.json
// Topology readers can keep reading `.services` / `.vms` etc. unchanged because
// consolidated is a superset of the old topology shape.
function resolveConfigPath(): string {
  if (process.env.CONFIG_JSON_PATH) return process.env.CONFIG_JSON_PATH;
  if (process.env.CONFIG_PATH) return process.env.CONFIG_PATH;
  const candidates = [
    `/app/_cloud-data-consolidated.json`,
    join(SOLUTIONS_DIR, "..", "1_cloud-configs", "dist", "_cloud-data-consolidated.json"),
    join(CLOUD_DATA_DIR, "_cloud-data-consolidated.json"),
    join(SOLUTIONS_DIR, "..", "_cloud-data-consolidated.json"),
    `/app/cloud-data-topology.json`,                                                          // 2026-04-27 migrated: legacy fallback
    join(SOLUTIONS_DIR, "..", "1_cloud-configs", "dist", "cloud-data-topology.json"),               // 2026-04-27 migrated: legacy fallback
    join(CLOUD_DATA_DIR, "cloud-data-topology.json"),                                          // 2026-04-27 migrated: legacy fallback
    join(SOLUTIONS_DIR, "..", "cloud-data-topology.json"),                                     // 2026-04-27 migrated: legacy fallback
    join(SOLUTIONS_DIR, "..", "config.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return join(SOLUTIONS_DIR, "..", "1_cloud-configs", "dist", "_cloud-data-consolidated.json");
}

export { resolveConfigPath as getConfigPath, resolveCloudDataPath };
// Lazy getters so the path is re-resolved on each read (handles late-arriving
// cloud-data clones from syncRepos and the bundled in-image path equally).
// 2026-04-27 migrated: getConfigsPath/getDepsPath now point at the consolidated
// file instead of the deprecated split files. Use getConfigsSlice/getDepsSlice
// helpers below to extract the actual configs/deps payload.
export const getConsolidatedPath = () => resolveCloudDataPath("_cloud-data-consolidated.json");
export const getConfigsPath = () => getConsolidatedPath();
export const getDepsPath = () => getConsolidatedPath();
export const getOwnBuildPath = () => resolveCloudDataPath("build-c3-infra-api.json");
// Back-compat exports — call sites can still treat these as path strings.
// 2026-04-27 migrated: now resolve to _cloud-data-consolidated.json. Existing
// call sites that JSON.parse(readFileSync(CONFIGS_PATH))/(DEPS_PATH) and read a
// nested key MUST be updated to use the slice helpers below; call sites that
// only check `existsSync(path)` keep working.
export const CONFIGS_PATH = getConfigsPath();
export const DEPS_PATH = getDepsPath();

// ── Slice helpers — read consolidated and return the relevant nested key.
// 2026-04-27 migrated: replaces JSON.parse(readFileSync(CONFIGS_PATH/DEPS_PATH)).
function readConsolidated(): any {
  const path = getConsolidatedPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
export const getTopologySlice = (): any => readConsolidated() ?? {};
export const getConfigsSlice = (): any => readConsolidated()?.configs ?? null;
export const getDepsSlice = (): any => readConsolidated()?.deps ?? null;
export const FRONT_DEPS_PATH = join(GIT_BASE, "front", "front-deps.json");
export const FRONT_TOPOLOGY_PATH = join(GIT_BASE, "front", "front-topology.json");
export const BUILD_SCRIPT = join(SOLUTIONS_DIR, "build.sh");
export const SSH_CONFIG_PATH = join(HOME, ".ssh/config");
export const SOPS_AGE_KEY_FILE = join(HOME, ".config/sops/age/keys.txt");
export const AUTHELIA_TOKEN_PATH = join(HOME, ".config/authelia/tokens.json");
// C3 API endpoints — resolved from cloud-data at import time
// Lazy: read once, cache. Falls back to hardcoded if topology unavailable.
function resolveC3Api(): { mesh: string; public: string } {
  try {
    const topo = JSON.parse(readFileSync(resolveConfigPath(), "utf-8"));
    const c3Svc = topo.services?.["c3-infra-api"] ?? topo.services?.["cloud-infra-mcp"];
    const c3Vm = c3Svc?.vm;
    const wgIp = c3Vm ? topo.vms?.[c3Vm]?.wg_ip : null;
    const port = c3Svc?.port;
    const domain = topo.owner?.domain ?? "diegonmarcos.com";
    return {
      mesh: wgIp && port ? `http://${wgIp}:${port}` : "http://10.0.0.6:8081",
      public: `https://api.${domain}/c3-api`,
    };
  } catch {
    return { mesh: "http://10.0.0.6:8081", public: "https://api.diegonmarcos.com/c3-api" };
  }
}
const _c3Api = resolveC3Api();
export const C3_API_MESH = _c3Api.mesh;
export const C3_API_PUBLIC = _c3Api.public;

export const FRONT_DIR = join(GIT_BASE, "front");
export const FRONT_BUILD_SCRIPT = join(FRONT_DIR, "build.sh");

// (CLOUD_DATA_DIR + CLOUD_DATA_REPO declared earlier in the file.)

// ── Octocode repo map — data-driven from THIS solution's own build.json ────
// 2026-08-21: replaces a hand-maintained REPOS map that still held PRE-RENAME
// names (cloud, unix, tools) long after the cloud-* rename. octocode returns
// EMPTY results for an unknown project key — no error — so the drift
// silently served nothing for every renamed repo. .runtime.octocode
// .index_repos is the single source of truth for which repos are indexed
// (their checkout dirname under GIT_BASE IS the local_name, one-to-one —
// confirmed by reindex.sh's `d="$REPOS_ROOT/$repo"` loop); .repo_map is
// local_name -> GitHub remote name (not needed for path resolution here,
// but exposed for callers that want it, e.g. display/validation).
//
// Resolution order mirrors config.ts's established getCloudDataPath pattern:
//   1. /app/build.json                    — bundled in-image, if ever shipped
//   2. GIT_BASE/cloud-infra/a_solutions/user-ai_cloud-cgc-pub-mcp/build.json
//                                          — the repos volume already holds a
//      full cloud-infra checkout (cloud-infra is itself in index_repos), so
//      this reads the live file with zero extra Dockerfile plumbing
//   3. local dev — relative to this module's own position in the source tree
const OWN_SOLUTION_REL = join("a_solutions", "user-ai_cloud-cgc-pub-mcp");
function resolveOwnBuildJsonPath(): string {
  const candidates = [
    "/app/build.json",
    join(GIT_BASE, "cloud-infra", OWN_SOLUTION_REL, "build.json"),
    join(import.meta.dirname ?? ".", "..", "..", "..", "..", "build.json"), // shared/libs -> code -> src -> solution root
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[1];
}

interface OctocodeRepoConfig { index_repos: string[]; repo_map: Record<string, string> }
let _octRepoConfig: OctocodeRepoConfig | null = null;

export function getOctocodeRepoConfig(): OctocodeRepoConfig {
  if (_octRepoConfig) return _octRepoConfig;
  const path = resolveOwnBuildJsonPath();
  try {
    const bj = JSON.parse(readFileSync(path, "utf-8"));
    const oct = bj?.runtime?.octocode ?? {};
    const index_repos: string[] = Array.isArray(oct.index_repos) ? oct.index_repos : [];
    const repo_map: Record<string, string> = oct.repo_map && typeof oct.repo_map === "object" ? oct.repo_map : {};
    if (!index_repos.length) throw new Error("empty .runtime.octocode.index_repos");
    _octRepoConfig = { index_repos, repo_map };
  } catch (e) {
    // Fail LOUD to stderr and degrade to empty rather than reaching for a
    // fresh hardcoded list — a hardcoded fallback is exactly what went stale
    // (silently) before. An empty map makes repo-scoped tools clearly refuse
    // every input instead of quietly resolving to the wrong directory.
    process.stderr.write(`[cloud-cgc-pub-mcp] WARNING: octocode repo config unavailable (${path}): ${(e as Error).message}\n`);
    _octRepoConfig = { index_repos: [], repo_map: {} };
  }
  return _octRepoConfig;
}

/** local_name -> absolute checkout dir, scoped to indexed repos only (matches octocode's $REPOS_ROOT/$repo layout). */
export function getOctocodeRepos(): Record<string, string> {
  return Object.fromEntries(getOctocodeRepoConfig().index_repos.map((r) => [r, join(GIT_BASE, r)]));
}

export const REPOS: Record<string, string> = {
  ...getOctocodeRepos(),
  // Not part of .runtime.octocode.index_repos — deliberately excluded from
  // octocode indexing (see build.json .runtime.octocode.sync_exclude:
  // "credential store, secrets would be embedded in the GraphRAG DB") — but
  // still a legitimate browse target for the plain filesystem tools below.
  "cloud-vault": join(GIT_BASE, "cloud-vault"),
};

// The container source tree has TWO declared locations, and code that names
// only one of them has now gone stale twice.
//
// cloud-infra/0_git/src/gitmodules (2026-09-06) declares both: the tree "was
// split out to diegonmarcos/cloudy-u-containers on 2026-08-27 ... checked out
// by CI at the path `a_solutions` with actions/checkout ... and cloned
// standalone into ~/git/cloud-u-containers for local work".
//
// CI keeps the a_solutions path, so SOLUTIONS_DIR stays FIRST and CI resolution
// is unchanged. Inside this server's container it is the pre-split husk: the
// sparse checkout in syncRepos() below asks only for
// `a_solutions/*/build.json` and `a_solutions/*/src/flake.nix` — it never
// fetched `src/secrets.yaml`, and since the split it matches almost nothing at
// all. The standalone clone is the one that actually holds the files, and it
// is itself declared, in .runtime.octocode.index_repos.
//
// Naming only the first root is what let devops.build.secrets_status report
// "no secrets.yaml" for all 76 services while every one of those files was
// present and sops-encrypted on disk.
const CONTAINERS_REPO = "cloud-u-containers";

/** Roots that may hold the container source tree, in declaration order. */
export function getSolutionRoots(): string[] {
  const roots = [SOLUTIONS_DIR];
  const standaloneCheckout = REPOS[CONTAINERS_REPO];
  if (standaloneCheckout) roots.push(standaloneCheckout);
  // REPOS is derived from this service's OWN .runtime.octocode.index_repos,
  // which infra-api_cloud-infra-mcp does not declare, so in the deployed
  // container REPOS holds no cloud-u-containers entry at all — even though
  // the octocode_repos volume carries the full checkout at GIT_BASE. Without
  // this probe, getServiceDir()/getSecretsStatus() fell back to the
  // pre-split a_solutions path and sec.secrets_status reported "directory
  // not found" for every service whose source now lives in cloud-u-containers
  // (e.g. infra-obs_matomo). Probe the conventional standalone path directly.
  const baseCheckout = join(GIT_BASE, CONTAINERS_REPO);
  if (baseCheckout !== standaloneCheckout && existsSync(baseCheckout)) {
    roots.push(baseCheckout);
  }
  return roots;
}

// ── Repository content roots for the a-knowledge tools (Ticket #402) ───────
// The a-knowledge tools (docs.ts, specs.ts, configs.ts, context.ts) used to
// resolve repository content on the config module's repo-root helper, which
// resolves to dirname($CONFIG_PATH) = .runtime.data_path — in production the
// EMPTY ./data deploy bind. Every path joined onto it (a_solutions/*,
// README.md, front-deps.json) landed nowhere and the tools answered "not
// found" with a cheerful success instead of failing. The image has no such
// root; it has the octocode repos volume at $GIT_ROOT with one checkout per
// .runtime.octocode.index_repos entry. a_solutions IS the cloud-u-containers
// checkout, so the two helpers below resolve repository content the way
// codegraph.ts already does: anchor on $GIT_ROOT and join the repo name.

/** The container source tree root. CI checks a cloud-infra checkout's
 *  a_solutions/; the standalone (production) layout is the cloud-u-containers
 *  checkout in the octocode repos volume. First existing root wins; absent
 *  any, THROW rather than silently point at a phantom path — a knowledge tool
 *  that cannot read its subject must fail loudly, not report a clean negative. */
export function getContainersRoot(): string {
  for (const root of getSolutionRoots()) {
    if (existsSync(root)) return root;
  }
  throw new Error(
    `[cloud-cgc-pub-mcp] no container source tree found — expected 'a_solutions' under a cloud-infra checkout or a 'cloud-u-containers' checkout under '$GIT_BASE'. Point GIT_ROOT at the octocode repos volume.`
  );
}

/** Absolute checkout dir of an indexed repo by its local_name (the layout of
 *  the octocode repos volume: $GIT_ROOT/<local_name>). Throws for a repo that
 *  is absent from .runtime.octocode.index_repos — same loudness principle. */
export function getRepoDir(localName: string): string {
  const dir = REPOS[localName];
  if (!dir) {
    throw new Error(
      `[cloud-cgc-pub-mcp] repo '${localName}' is not in .runtime.octocode.index_repos; cannot resolve its checkout under '$GIT_BASE'.`
    );
  }
  return dir;
}

// ── Repo sync ────────────────────────────────────────────────────────
let _lastSync = 0;
const SYNC_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Sync repos to latest remote state.
 *
 * SERVER mode (Docker): `git fetch + reset --hard` — repos are disposable clones.
 * CLIENT mode (local):  no-op — the user's working copy is the source of truth.
 *                       Never run destructive git commands on working repos.
 */
/** Git SSH command — disable host key checking for non-interactive use */
const GIT_SSH = `GIT_SSH_COMMAND="ssh -i ${SSH_IDENTITY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"`;

export function syncRepos(force = false): void {
  if (process.env.REPO_SYNC === "off") return;
  if (IS_CLIENT) return; // Never touch the user's working repos

  const now = Date.now();
  if (!force && now - _lastSync < SYNC_TTL) return;
  _lastSync = now;

  for (const [name, dir] of Object.entries(REPOS)) {
    try {
      if (!existsSync(join(dir, ".git"))) {
        // Auto-clone missing repos (e.g. cloud-data on first run)
        const repoUrl = REPO_URLS[name];
        if (!repoUrl) continue;
        // Sparse checkout for large repos — only get build.json + config files
        execSync(`${GIT_SSH} git clone --depth 1 --filter=blob:none --sparse ${repoUrl} ${dir} && cd ${dir} && git sparse-checkout set a_solutions/*/build.json a_solutions/*/src/flake.nix config.json 1_cloud-configs/dist`, {
          timeout: 60000,
          stdio: "ignore",
        });
      } else {
        execSync(`${GIT_SSH} git fetch --all -q && git reset --hard origin/main -q`, {
          cwd: dir,
          timeout: 15000,
          stdio: "ignore",
        });
      }
    } catch {
      // Non-fatal — use stale data
    }
  }
}

/** Git remote URLs for auto-cloning in server mode */
const REPO_URLS: Record<string, string> = {
  "cloud-data": CLOUD_DATA_REPO,
  "cloud-infra": "git@github.com:diegonmarcos/cloudy-t-infra.git", // 2026-08-21: key was "cloud" (pre-rename)
};
