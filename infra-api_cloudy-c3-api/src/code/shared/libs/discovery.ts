import { getConfig, getVmSshAlias } from "./config.js";
import { rawHttpRequest, getBearerToken } from "./http.js";

interface ServiceInfo {
  name: string;
  domain?: string;
  vm: string;
  alias?: string;
  category: string;
  hasSpec?: boolean;
  specUrl?: string;
}

interface SpecCache {
  data: unknown;
  fetchedAt: number;
}

const specCache = new Map<string, SpecCache>();
const SPEC_TTL = 5 * 60 * 1000; // 5 minutes

// Service domains — data-driven from cloud-data topology
// Reads service.domain from getConfig().services at call time
function getServiceDomains(): Record<string, string> {
  const config = getConfig();
  const domains: Record<string, string> = {};
  for (const [name, svc] of Object.entries(config.services)) {
    if (svc.domain) {
      // Strip path suffix from domain (e.g. "api.diegonmarcos.com/c3-api" → "api.diegonmarcos.com")
      domains[name] = svc.domain.split("/")[0];
    }
  }
  return domains;
}

// Base path prefix for services behind path-based routing on a shared domain
const SERVICE_BASE_PATHS: Record<string, string> = {
  "c3-api": "/c3-api",
  crawlee: "/crawlee",
};

// Known spec paths per service
const SPEC_PATHS: Record<string, string> = {
  matomo: "/index.php?module=API&method=API.getReportMetadata&format=json",
  vaultwarden: "/api/config",
  ntfy: "/docs",
  photoprism: "/api/v1/config",
  nocodb: "/api/v1/meta/tables",
  syncthing: "/rest/system/config",
  authelia: "/api/configuration",
  "c3-api": "/c3-api/docs",
};

export function listServices(): ServiceInfo[] {
  const config = getConfig();
  const services: ServiceInfo[] = [];

  for (const [name, svc] of Object.entries(config.services)) {
    const alias = svc.vm === "local" || svc.vm === "all"
      ? svc.vm
      : getVmSshAlias(svc.vm);

    const domain = getServiceDomains()[name];
    const hasSpec = name in SPEC_PATHS;

    services.push({
      name,
      domain,
      vm: svc.vm,
      alias,
      category: svc.category,
      hasSpec,
      specUrl: hasSpec && domain ? `https://${domain}${SPEC_PATHS[name]}` : undefined,
    });
  }

  return services;
}

export function getService(serviceName: string): ServiceInfo | null {
  const config = getConfig();
  const svc = config.services[serviceName];
  if (!svc) return null;

  const alias = svc.vm === "local" || svc.vm === "all"
    ? svc.vm
    : getVmSshAlias(svc.vm);

  const domain = getServiceDomains()[serviceName];
  const hasSpec = serviceName in SPEC_PATHS;

  return {
    name: serviceName,
    domain,
    vm: svc.vm,
    alias,
    category: svc.category,
    hasSpec,
    specUrl: hasSpec && domain ? `https://${domain}${SPEC_PATHS[serviceName]}` : undefined,
  };
}

export function probeSpec(serviceName: string): { ok: boolean; spec: unknown; error?: string } {
  // Check cache
  const cached = specCache.get(serviceName);
  if (cached && Date.now() - cached.fetchedAt < SPEC_TTL) {
    return { ok: true, spec: cached.data };
  }

  const domain = getServiceDomains()[serviceName];
  if (!domain) {
    return { ok: false, spec: null, error: `No domain configured for service: ${serviceName}` };
  }

  const specPath = SPEC_PATHS[serviceName];
  if (!specPath) {
    return { ok: false, spec: null, error: `No spec path known for service: ${serviceName}` };
  }

  const url = `https://${domain}${specPath}`;
  const token = getBearerToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const result = rawHttpRequest("GET", url, undefined, 15_000, Object.keys(headers).length ? headers : undefined);

  if (!result.ok) {
    return { ok: false, spec: null, error: `HTTP ${result.status}: ${result.error}` };
  }

  // Cache the result
  specCache.set(serviceName, { data: result.data, fetchedAt: Date.now() });

  return { ok: true, spec: result.data };
}

export function getAllSpecs(): { ok: boolean; specs: Record<string, unknown>; errors: Record<string, string> } {
  const specs: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const serviceName of Object.keys(SPEC_PATHS)) {
    if (!getServiceDomains()[serviceName]) continue;

    const result = probeSpec(serviceName);
    if (result.ok) {
      specs[serviceName] = result.spec;
    } else {
      errors[serviceName] = result.error ?? "unknown error";
    }
  }

  return { ok: true, specs, errors };
}

// ── New: Service version detection ───────────────────────────────────────

const VERSION_PATHS: Record<string, { url: string; extract: (data: unknown) => string }> = {
  matomo: {
    url: "/index.php?module=API&method=API.getMatomoVersion&format=json",
    extract: (d) => (d as Record<string, unknown>)?.value as string ?? "unknown",
  },
  vaultwarden: {
    url: "/api/config",
    extract: (d) => (d as Record<string, unknown>)?.version as string ?? "unknown",
  },
  photoprism: {
    url: "/api/v1/status",
    extract: (d) => (d as Record<string, unknown>)?.version as string ?? "unknown",
  },
  syncthing: {
    url: "/rest/system/version",
    extract: (d) => (d as Record<string, unknown>)?.version as string ?? "unknown",
  },
  ntfy: {
    url: "/v1/health",
    extract: (d) => (d as Record<string, unknown>)?.healthy ? "healthy" : "unknown",
  },
};

export interface ServiceVersion {
  service: string;
  version: string;
  ok: boolean;
  error?: string;
}

export function serviceVersion(serviceName: string): ServiceVersion {
  const versionInfo = VERSION_PATHS[serviceName];
  const domain = getServiceDomains()[serviceName];

  if (!versionInfo || !domain) {
    return { service: serviceName, version: "unknown", ok: false, error: "No version endpoint known" };
  }

  const url = `https://${domain}${versionInfo.url}`;
  const token = getBearerToken();
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const result = rawHttpRequest("GET", url, undefined, 10_000, Object.keys(headers).length ? headers : undefined);

  if (!result.ok) {
    return { service: serviceName, version: "unknown", ok: false, error: `HTTP ${result.status}` };
  }

  try {
    const version = versionInfo.extract(result.data);
    return { service: serviceName, version, ok: true };
  } catch {
    return { service: serviceName, version: "unknown", ok: false, error: "Failed to parse version" };
  }
}

export function allServiceVersions(): ServiceVersion[] {
  return Object.keys(VERSION_PATHS)
    .filter((name) => getServiceDomains()[name])
    .map((name) => serviceVersion(name));
}

/** Expose getServiceDomains and SERVICE_BASE_PATHS for other modules */
export { getServiceDomains, SERVICE_BASE_PATHS };
