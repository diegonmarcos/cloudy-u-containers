import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { InfraConfig, ServiceConfig } from "./types.js";
import { getConfigPath, SOLUTIONS_DIR, getSolutionRoots, syncRepos } from "./paths.js";

let _config: InfraConfig | null = null;
let _configTimestamp = 0;
const CONFIG_TTL = 5 * 60 * 1000; // 5 minutes

// SSH alias fallback — only used if _cloud-data-consolidated.json VMs lack ssh_alias.
// 2026-04-27 migrated: cloud-data-topology.json -> _cloud-data-consolidated.json (top-level — superset)
// Data-driven: populated from getConfig().vms at runtime. Empty = no fallback needed.
const VM_SSH_ALIASES_FALLBACK: Record<string, string> = {};

export function getConfig(): InfraConfig {
  const now = Date.now();
  if (!_config || now - _configTimestamp > CONFIG_TTL) {
    syncRepos();
    const fileConfig = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as InfraConfig;
    const discovered = discoverServicesFromDisk(fileConfig);
    // Merge: build.json (discovered) is source of truth, config.json is fallback only
    const merged = { ...fileConfig.services };
    for (const [name, svc] of Object.entries(discovered)) {
      merged[name] = svc;
    }
    fileConfig.services = merged;
    _config = fileConfig;
    _configTimestamp = now;
  }
  return _config;
}

export function reloadConfig(): InfraConfig {
  _config = null;
  _configTimestamp = 0;
  return getConfig();
}

export function getDriftReport(): { onDiskOnly: string[]; configOnly: string[] } {
  const fileConfig = JSON.parse(readFileSync(getConfigPath(), "utf-8")) as InfraConfig;
  const discovered = discoverServicesFromDisk(fileConfig);
  const configNames = new Set(Object.keys(fileConfig.services));
  const diskNames = new Set(Object.keys(discovered));

  return {
    onDiskOnly: [...diskNames].filter((n) => !configNames.has(n)).sort(),
    configOnly: [...configNames].filter((n) => {
      // The folder is DECLARED, per service, at services[*].folder — all 76 of
      // them. This used to rebuild the folder name from a category→prefix table
      // instead, and that table was pre-rename: it produced aa-sui_/bc-obs_/
      // ba-clo_ names while the tree moved to infra-api_/infra-obs_/user-comm_.
      // So the existsSync missed for almost every service and the drift report
      // announced 69 of 76 services as present in config but absent from disk.
      // A drift report that cries wolf about 90% of the fleet is worse than
      // none — it trains everyone to ignore the one entry that is real.
      const svc = fileConfig.services[n];
      const folder = svc.folder ?? svc.flake ?? n;
      return !existsSync(join(SOLUTIONS_DIR, folder));
    }).sort(),
  };
}

function discoverServicesFromDisk(fileConfig: InfraConfig): Record<string, ServiceConfig> {
  const discovered: Record<string, ServiceConfig> = {};

  // Build alias→vmId map from config VMs for host resolution
  const aliasToVm: Record<string, string> = {};
  for (const [vmId, vm] of Object.entries(fileConfig.vms)) {
    if (vm.ssh_alias) aliasToVm[vm.ssh_alias] = vmId;
  }
  // Include hardcoded fallbacks
  for (const [vmId, alias] of Object.entries(VM_SSH_ALIASES_FALLBACK)) {
    if (!aliasToVm[alias]) aliasToVm[alias] = vmId;
  }

  let dirs: string[];
  try {
    dirs = readdirSync(SOLUTIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "z_archive")
      .map((d) => d.name);
  } catch {
    return discovered;
  }

  for (const dirName of dirs) {
    const buildJsonPath = join(SOLUTIONS_DIR, dirName, "build.json");
    if (!existsSync(buildJsonPath)) continue;

    interface BuildJsonShape {
      name?: string;
      description?: string;
      deploy?: { host?: string };
      containers?: Record<string, { container_name?: string } | undefined>;
      container_names?: string[];
    }
    let buildJson: BuildJsonShape;
    try {
      buildJson = JSON.parse(readFileSync(buildJsonPath, "utf-8"));
    } catch {
      continue;
    }

    const name = buildJson.name;
    if (!name) continue;

    // The category is declared by the service itself. This used to reverse-map
    // the directory prefix first and only fall back to build.json; the prefix
    // table it mapped through was pre-rename, so it matched 2 of 81 directories
    // and the fallback was doing the work. For the one directory it did still
    // match (bc-obs_alerts-api) the table and the build.json agree on "tools",
    // so reading the declaration directly changes no category here.
    const category = ((buildJson as any).category as ServiceConfig["category"]) ?? "tools";

    // Map deploy.host alias → VM ID
    const host = buildJson.deploy?.host ?? "local";
    const vmId = aliasToVm[host] ?? host;

    // Collect every declared container_name. Priority:
    //   1. top-level "container_names": [...]  (explicit override, may include glob patterns)
    //   2. "containers.<role>.container_name"  (the standard per-container declaration)
    // If neither exists, fall back to the service name itself (legacy single-container services).
    // Data-driven: compose services with multiple containers (e.g. photoprism_app,
    // photoprism_mariadb, photoprism_rclone) will all be listed here, so the drift
    // checker can consider the service "deployed" if ANY of them are running.
    let containers: string[] = [];
    if (Array.isArray(buildJson.container_names)) {
      containers = buildJson.container_names.filter((c): c is string => typeof c === "string");
    } else if (buildJson.containers && typeof buildJson.containers === "object") {
      containers = Object.values(buildJson.containers)
        .map((c) => (c && typeof c === "object" ? c.container_name : undefined))
        .filter((n): n is string => typeof n === "string" && n.length > 0);
    }
    if (containers.length === 0) containers = [name];

    discovered[name] = {
      category,
      vm: vmId,
      folder: dirName,
      description: buildJson.description ?? "",
      discovered: true,
      containers,
    };
  }

  return discovered;
}

export function getServiceFolder(name: string): string {
  const config = getConfig();
  const svc = config.services[name];
  if (!svc) throw new Error(`Unknown service: ${name}`);
  // The declaration first. Between it and the scan below there used to be a
  // third step that invented a folder name from a category→prefix table, and
  // the table was pre-rename. Inventing a name is the #371/#378 failure mode:
  // a guess that does not match resolves to nothing, and a guess that DOES
  // match resolves confidently to the wrong tree — ab-mic_vaultwarden is still
  // on disk next to the live user-vault_vaultwarden. The scan that follows
  // finds the folder by reading each build.json's own name, which cannot be
  // stale, so the guess was never the thing making this work.
  if (svc.folder) return svc.folder;
  try {
    const dirs = readdirSync(SOLUTIONS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const dir of dirs) {
      const bjPath = join(SOLUTIONS_DIR, dir, "build.json");
      if (!existsSync(bjPath)) continue;
      try {
        const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
        if (bj.name === name) return dir;
      } catch { continue; }
    }
  } catch { /* fall through */ }
  return constructed;
}

// Deploy layout v2 (cloud-ship-container-engine.sh) writes the compose file to
// <remote_base>/<service>/compose/docker-compose.yml; layout v1 kept it at the
// service root. The ship engine still supports BOTH, so every remote `docker
// compose` here must too. Until 2026-08-23 these call sites cd'd to the service
// root unconditionally — which meant that once the fleet moved to v2, every
// compose verb on this server (service.start/stop/restart, docker.compose_up,
// docker.compose_up_all, build.backup) failed with "no configuration file
// provided: not found". Precedence mirrors the engine: compose/ first, root as
// fallback.
//
// It must be `-f compose/docker-compose.yml --project-directory .` from the
// SERVICE ROOT, never a plain `cd .../compose`. cd'ing INTO compose/ makes it
// the project directory, and compose resolves `env_file: [".secrets"]` plus the
// `./.secrets.d` / `./.secrets.json` bind mounts against the project directory —
// while the ship engine scp's all three to the service ROOT
// (cloud-ship-container-step-deploy-rsync.sh) and runs compose with
// `--project-directory .` there. So from 2026-08-23 every compose verb on this
// server died with "env file /opt/containers/<svc>/compose/.secrets not found"
// (stalwart on oci-mail, 2026-09-04, ~50 min mail outage). Callers must pass
// $COMPOSE_ARGS to every `docker compose` invocation.
export function composeCd(remotePath: string): string {
  return `cd ${remotePath} && if [ -f compose/docker-compose.yml ]; then COMPOSE_ARGS="-f compose/docker-compose.yml --project-directory ."; else COMPOSE_ARGS=; fi`;
}

export function getServiceDir(name: string): string {
  const folder = getServiceFolder(name);
  for (const root of getSolutionRoots()) {
    const dir = join(root, folder);
    if (existsSync(dir)) return dir;
  }
  // Nothing on disk under any declared root. Return the primary path so the
  // caller's error message names a real, checkable location — and so callers
  // can tell "not found" apart from "found", which is the whole point: a tool
  // that cannot read its subject must say so, not report a clean negative.
  return join(SOLUTIONS_DIR, folder);
}

/** True when no declared solution root holds a source tree at all. */
export function isSolutionTreeMissing(): boolean {
  return !getSolutionRoots().some((root) => existsSync(root));
}

// Normalise a service's declared container names to a string[].
//
// 2026-09-04: `svc.containers` has TWO shapes depending on which loader
// populated config.services:
//   - discoverServices() (build.json scan) already normalises to string[]
//   - _cloud-data-consolidated.json keeps the RAW build.json shape, an OBJECT
//     keyed by role: { app: { container_name: "..." }, db: { ... } }
// Every consumer assumed the array form, so against consolidated data
// `Array.isArray(...)` was false and `svc.containers.includes(...)` /
// `push(...svc.containers)` either silently matched nothing or threw
// TypeError. That is what made health.drift report EVERY service as both
// "missing" and "extra": declaredNames came back empty, so nothing matched a
// running container, and every running container then looked undeclared.
//
// Priority mirrors discoverServices():
//   1. container_names[] explicit override (may contain glob patterns)
//   2. containers as object → each role's container_name
//   3. containers already a string[]
//   4. legacy compose.containers[]
//   5. fall back to the service name itself
// Empty arrays are treated as ABSENT, not as "no containers" — `?? [name]`
// does not fire on [], which is the second half of the same bug.
export function serviceContainerNames(svc: unknown, serviceName: string): string[] {
  const s = (svc ?? {}) as Record<string, any>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

  const override = strings(s.container_names);
  if (override.length > 0) return override;

  const c = s.containers;
  if (Array.isArray(c)) {
    const arr = strings(c);
    if (arr.length > 0) return arr;
  } else if (c && typeof c === "object") {
    const fromRoles = Object.values(c as Record<string, any>)
      .map((r) => (r && typeof r === "object" ? r.container_name : undefined))
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    if (fromRoles.length > 0) return fromRoles;
  }

  const legacy = strings(s.compose?.containers);
  if (legacy.length > 0) return legacy;

  return [serviceName];
}

function buildAliasMap(): { vmToAlias: Record<string, string>; aliasToVm: Record<string, string> } {
  const config = getConfig();
  const vmToAlias: Record<string, string> = { ...VM_SSH_ALIASES_FALLBACK };
  const aliasToVm: Record<string, string> = {};

  // Prefer ssh_alias from _cloud-data-consolidated.json when present
  for (const [vmId, vm] of Object.entries(config.vms)) {
    if (vm.ssh_alias) {
      vmToAlias[vmId] = vm.ssh_alias;
    }
  }

  // Build reverse map
  for (const [vmId, alias] of Object.entries(vmToAlias)) {
    aliasToVm[alias] = vmId;
  }

  return { vmToAlias, aliasToVm };
}

export function getVmSshAlias(vmId: string): string {
  const { vmToAlias } = buildAliasMap();
  return vmToAlias[vmId] ?? vmId;
}

export function resolveVmId(nameOrAlias: string): string {
  const { aliasToVm } = buildAliasMap();
  if (aliasToVm[nameOrAlias]) return aliasToVm[nameOrAlias];
  const config = getConfig();
  if (config.vms[nameOrAlias]) return nameOrAlias;
  const { vmToAlias } = buildAliasMap();
  throw new Error(
    `Unknown VM: ${nameOrAlias}. Valid: ${Object.keys(config.vms).join(", ")} or aliases: ${Object.values(vmToAlias).join(", ")}`
  );
}

export function getServicesForVm(vmId: string): [string, ServiceConfig][] {
  const config = getConfig();
  return Object.entries(config.services).filter(
    ([, svc]) => svc.vm === vmId || svc.vm === "all"
  );
}
