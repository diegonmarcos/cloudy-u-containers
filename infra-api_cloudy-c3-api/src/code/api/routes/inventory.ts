// ── Inventory Routes — "What exists" ──
// Service catalog, topology, config, and discovery

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { FastifyInstance } from "fastify";
import { listServices, getService, probeSpec, getAllSpecs } from "../../shared/libs/discovery.js";
import { getDriftReport, getConfig, getServiceFolder } from "../../shared/libs/config.js";
import { getConfigFile } from "../../shared/libs/files.js";
// 2026-04-27 migrated: cloud-data-{topology,configs,deps}.json -> _cloud-data-consolidated.json[.{configs,deps}]
// getConfigPath() now resolves to _cloud-data-consolidated.json (topology shape is a subset).
// CONFIGS_PATH / DEPS_PATH also point to the consolidated file; use the slice helpers
// (getConfigsSlice / getDepsSlice / getTopologySlice) to extract the relevant nested key.
import {
  getConfigPath,
  getConsolidatedPath,
  getConfigsSlice,
  getDepsSlice,
  FRONT_DEPS_PATH,
  FRONT_TOPOLOGY_PATH,
  SOLUTIONS_DIR,
} from "../../shared/libs/paths.js";

// ── Cloud-data output validator ──
// Ensures API never returns empty/broken data that would overwrite good files.
// Defense in depth: API validates on write, Dagu validates on read.
function validateCloudData(endpoint: string, data: Record<string, unknown>): Record<string, unknown> {
  // Must have _generated timestamp
  if (!data._generated) {
    data._generated = new Date().toISOString();
  }

  // Count actual data keys (exclude meta fields)
  const metaKeys = new Set(["_generated", "_source", "_meta"]);
  const dataKeys = Object.keys(data).filter(k => !metaKeys.has(k));

  // Must have at least 1 data key
  if (dataKeys.length === 0) {
    throw new Error(`cloud-data/${endpoint}: empty response — no data keys`);
  }

  // Check that at least 1 data key has non-empty content
  const hasContent = dataKeys.some(k => {
    const v = data[k];
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object" && v !== null) return Object.keys(v).length > 0;
    return v !== null && v !== undefined && v !== "";
  });

  if (!hasContent) {
    throw new Error(`cloud-data/${endpoint}: all data keys are empty — refusing to serve`);
  }

  return data;
}

export async function registerInventoryRoutes(app: FastifyInstance) {
  // ── Global guard for all /cloud-data/* endpoints ──
  // Prevents serving empty/broken data that would overwrite good files downstream.
  app.addHook("onSend", async (request, reply, payload) => {
    if (!request.url.startsWith("/cloud-data/")) return payload;
    if (reply.statusCode >= 400) return payload;

    try {
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      validateCloudData(request.url, data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      app.log.error(`cloud-data validation failed: ${msg}`);
      reply.code(500);
      return JSON.stringify({ error: "Validation failed", detail: msg, url: request.url });
    }
    return payload;
  });
  // ── Services (from services.ts) ──

  app.get("/services", { schema: { tags: ["Inventory"] } }, async () => {
    return listServices();
  });

  app.get<{ Params: { service: string } }>(
    "/services/:service",
    { schema: { tags: ["Inventory"], params: { type: "object" as const, properties: { service: { type: "string" as const } }, required: ["service"] } } },
    async (req, reply) => {
      const info = getService(req.params.service);
      if (!info) {
        reply.code(404).send({ error: `Unknown service: ${req.params.service}` });
        return;
      }
      return info;
    },
  );

  app.get<{ Params: { service: string } }>(
    "/services/:service/spec",
    { schema: { tags: ["Inventory"], params: { type: "object" as const, properties: { service: { type: "string" as const } }, required: ["service"] } } },
    async (req, reply) => {
      const result = probeSpec(req.params.service);
      if (!result.ok) {
        reply.code(404).send({ error: result.error });
        return;
      }
      return result.spec;
    },
  );

  app.get("/services/all/specs", { schema: { tags: ["Inventory"] } }, async () => {
    return getAllSpecs();
  });

  // ── Topology (serves _cloud-data-consolidated.json directly — superset of legacy topology shape) ──
  // 2026-04-27 migrated: cloud-data-topology.json -> _cloud-data-consolidated.json (top-level)
  // Consolidated is a superset of topology, so clients reading .services/.vms keep working.

  app.get("/cloud-data/topology", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    return JSON.parse(readFileSync(getConfigPath(), "utf-8"));
  });

  app.get("/cloud-data/topology/drift", { schema: { tags: ["Inventory"] } }, async () => {
    const drift = getDriftReport();
    const parts: string[] = [];
    if (drift.onDiskOnly.length > 0) parts.push(`${drift.onDiskOnly.length} on disk only: ${drift.onDiskOnly.join(", ")}`);
    if (drift.configOnly.length > 0) parts.push(`${drift.configOnly.length} in config only: ${drift.configOnly.join(", ")}`);
    if (parts.length === 0) parts.push("No drift detected.");
    return { onDiskOnly: drift.onDiskOnly, configOnly: drift.configOnly, summary: parts.join(" | ") };
  });

  // ── Configs (serves _cloud-data-consolidated.json[.configs] slice) ──
  // 2026-04-27 migrated: cloud-data-configs.json -> _cloud-data-consolidated.json.configs

  app.get("/cloud-data/configs", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConsolidatedPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const configs = getConfigsSlice();
    if (configs == null) { reply.code(404).send({ error: ".configs slice not present in _cloud-data-consolidated.json" }); return; }
    return configs;
  });

  // ── Deps (serves _cloud-data-consolidated.json[.deps] slice — consolidated node packages grouped by language) ──
  // 2026-04-27 migrated: cloud-data-deps.json -> _cloud-data-consolidated.json.deps

  app.get("/cloud-data/deps", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConsolidatedPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet. Run: build.sh config" }); return; }
    const deps = getDepsSlice();
    if (deps == null) { reply.code(404).send({ error: ".deps slice not present in _cloud-data-consolidated.json" }); return; }
    return deps;
  });

  app.get("/cloud-data/deps/node", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConsolidatedPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const deps = getDepsSlice();
    return deps?.node ?? {};
  });

  app.get("/cloud-data/deps/node/merged", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConsolidatedPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const deps = getDepsSlice();
    return deps?.node?.merged ?? {};
  });

  app.get("/cloud-data/deps/front", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(FRONT_DEPS_PATH)) { reply.code(404).send({ error: "front-deps.json not generated yet. Run: front/build.sh deps or cloud build.sh config" }); return; }
    return JSON.parse(readFileSync(FRONT_DEPS_PATH, "utf-8"));
  });

  // ── Front-end apps (GitHub Pages projects tracked in front-topology.json, not in a_solutions) ──

  app.get<{ Querystring: { category?: string } }>(
    "/cloud-data/front-apps",
    { schema: { tags: ["Inventory"], querystring: { type: "object" as const, properties: { category: { type: "string" as const } } } } },
    async (req, reply) => {
      if (!existsSync(FRONT_TOPOLOGY_PATH)) { reply.code(404).send({ error: "front-topology.json not generated yet. Run: front/build.sh topology or cloud build.sh config" }); return; }
      const data = JSON.parse(readFileSync(FRONT_TOPOLOGY_PATH, "utf-8"));
      let projects = data.projects ?? [];
      if (req.query.category) {
        projects = projects.filter((p: { category?: string }) => p.category === req.query.category);
      }
      return { _meta: data._meta, projects };
    },
  );

  // ── DNS Registry (container name → WG IP, for Hickory DNS auto-generation) ──

  app.get("/cloud-data/dns-services", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
    const services: Record<string, { ip: string; desc: string }> = {};
    const vms: Record<string, string> = {};

    // Use getConfig() which merges build.json discovery + config.json fallback
    const config = getConfig();
    const solutionsDir = SOLUTIONS_DIR;

    for (const [svcName, svc] of Object.entries(config.services)) {
      const vm = topo.vms?.[svc.vm];
      if (!vm?.wg_ip) continue;
      const ip: string = vm.wg_ip;
      const desc: string = svc.description ?? svcName;

      // Register service name
      services[svcName] = { ip, desc };

      // Extract .app DNS names from build.json proxy config
      const folder = svc.folder ?? getServiceFolder(svcName);
      const bjPath = join(solutionsDir, folder, "build.json");
      if (existsSync(bjPath)) {
        try {
          const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
          // Register dns field as zone name (source of truth for Hickory DNS)
          if (bj.dns) {
            const dnsName = bj.dns.replace(/\.mesh\.diegonmarcos\.com$/, "");
            if (dnsName && dnsName !== svcName) {
              services[dnsName] = { ip, desc };
            }
          }
          const upstreams: string[] = [];
          if (bj.proxy?.upstream) upstreams.push(bj.proxy.upstream);
          for (const l4 of (bj.proxy?.l4_ports ?? [])) {
            if (l4.upstream) upstreams.push(l4.upstream);
          }
          for (const u of upstreams) {
            const m = u.match(/^(?:https?:\/\/)?([a-z0-9-]+)\.mesh\.diegonmarcos\.com/);
            if (m && m[1]) services[m[1]] = { ip, desc };
          }
        } catch { /* skip */ }
      }
    }

    // PTR reverse map: last WG octet → VM alias (for Hickory vms attrset)
    for (const [, vm] of Object.entries(topo.vms ?? {})) {
      const v = vm as any;
      if (!v.wg_ip) continue;
      const lastOctet = v.wg_ip.split(".").pop();
      if (lastOctet) vms[lastOctet] = v.ssh_alias ?? "";
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/dns-services",
      suffix: "app",
      services,
      vms,
    };
  });

  // ── Caddy Routes (derived from build.json proxy fields → build-proxy-caddy-routes.json) ──
  // Output format matches what the Caddy flake.nix expects:
  //   routes[]           — subdomain routes (1 domain = 1 upstream)
  //   path_routes[]      — grouped by parent_domain, each with paths[]
  //   mcp_routes[]       — grouped by parent_domain, each with endpoints[]
  //   github_pages_proxies[] — static site proxies to GitHub Pages
  //   l4_routes[]        — TCP passthrough (mail ports etc.)
  //   special{}          — ntfy (3-tier auth), analytics (matomo+umami), proxy_dashboard

  app.get("/cloud-data/caddy-routes", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    const config = getConfig();
    const solutionsDir = SOLUTIONS_DIR;

    const routes: any[] = [];
    const l4_routes: any[] = [];
    const special: Record<string, any> = {};

    // Intermediate collectors for grouping
    const flatPathRoutes: any[] = [];
    const flatMcpRoutes: any[] = [];
    const analyticsUpstreams: Record<string, any> = {};

    // Read Caddy build.json for non-service routes (github pages, proxy dashboard, parent domain metadata)
    // The folder is declared; it used to be the literal "bb-sec_caddy", which is
    // pre-rename and no longer on disk — caddy is declared at infra-sec_caddy.
    // The existsSync below then quietly yielded an empty proxy object, so this
    // route dropped every non-service Caddy route and still answered 200.
    const caddyBjPath = join(solutionsDir, config.services["caddy"]?.folder ?? getServiceFolder("caddy"), "build.json");
    let caddyProxy: any = {};
    if (existsSync(caddyBjPath)) {
      try {
        const caddyBj = JSON.parse(readFileSync(caddyBjPath, "utf-8"));
        caddyProxy = caddyBj.proxy ?? {};
      } catch {}
    }
    const parentDomainMeta: Record<string, any> = caddyProxy.parent_domain_meta ?? {};

    for (const [svcName, svc] of Object.entries(config.services ?? {})) {
      const s = svc as any;
      // Enrich with build.json proxy config
      const folder = s.folder ?? getServiceFolder(svcName);
      const bjPath = join(solutionsDir, folder, "build.json");
      let bj: any = null;
      if (existsSync(bjPath)) {
        try { bj = JSON.parse(readFileSync(bjPath, "utf-8")); } catch {}
      }
      if (!s.proxy && bj?.proxy) s.proxy = bj.proxy;
      if (bj?.domain && !s.domain) s.domain = bj.domain;

      // Normalize new build.json schema (proxy.primary) → old flat proxy format
      let proxy = s.proxy;
      if (proxy?.primary && !proxy.upstream) {
        const dns = bj?.dns ?? `${svcName}.mesh.diegonmarcos.com`;
        const port = bj?.ports?.app;
        const p = proxy.primary;
        proxy = {
          ...proxy,
          ...p,
          upstream: port ? `${dns}:${port}` : undefined,
          domain: p.domain ?? s.domain,
          type: p.type ?? "subdomain",
        };
      }
      if (!proxy || proxy.type === "special") continue;

      const domain = proxy.domain ?? s.domain;
      // Map auth: "bypass" → "none" for Caddy (bypass means no forward_auth)
      const auth = proxy.auth === "bypass" ? "none" : (proxy.auth ?? "two_factor");

      // Build public_paths from proxy.paths with auth: "public"
      const publicPaths: string[] = [];
      if (proxy.paths) {
        for (const [pathKey, pathVal] of Object.entries(proxy.paths ?? {})) {
          if ((pathVal as any).auth === "public") {
            const fullPath = proxy.base_path ? `${proxy.base_path}${pathKey}` : pathKey;
            publicPaths.push(fullPath);
          }
        }
      }

      // L4 TCP passthrough (mail ports)
      if (proxy.l4_ports) {
        for (const l4 of proxy.l4_ports) {
          l4_routes.push({
            port: l4.port,
            upstream: l4.upstream,
            comment: l4.comment ? `${l4.comment} -- TLS passthrough to ${svcName}` : `${svcName} L4`,
          });
        }
      }

      // Route type classification
      const type = proxy.type ?? "subdomain";

      // Skip matomo/umami from normal classification — handled by special.analytics
      if (svcName === "matomo" || svcName === "umami") {
        analyticsUpstreams[svcName] = { proxy, domain };
        // Still process additional_routes
        if (proxy.additional_routes) {
          for (const ar of proxy.additional_routes) {
            const arType = ar.type ?? "subdomain";
            if (arType === "path" && ar.streaming) {
              flatMcpRoutes.push({ base_path: ar.base_path, upstream: ar.upstream, parent_domain: ar.parent_domain });
            } else if (arType === "path") {
              flatPathRoutes.push({ base_path: ar.base_path, upstream: ar.upstream, parent_domain: ar.parent_domain });
            }
          }
        }
        continue;
      }

      if (type === "path" && proxy.streaming) {
        // MCP streaming endpoints — collected for grouping
        flatMcpRoutes.push({
          base_path: proxy.base_path,
          upstream: proxy.upstream,
          parent_domain: proxy.parent_domain,
        });
      } else if (type === "path") {
        // Path-based routes — collected for grouping by parent_domain
        const pathEntry: any = {
          base_path: proxy.base_path,
          upstream: proxy.upstream,
          parent_domain: proxy.parent_domain,
        };
        if (proxy.redirect_bare) pathEntry.redirect_bare = true;
        if (publicPaths.length > 0) pathEntry.public_paths = publicPaths;
        if (s.description) pathEntry.comment = s.description;
        flatPathRoutes.push(pathEntry);
      } else if (proxy.auth === "ntfy-3tier") {
        // ntfy special 3-tier auth
        special.ntfy = {
          domain,
          upstream: proxy.upstream,
          comment: `ntfy notifications -- 3-tier auth: JWT bearer, tk_ bearer, cookie`,
        };
      } else {
        // Standard subdomain route
        const route: any = { domain, upstream: proxy.upstream };
        if (auth === "none") route.auth = "none";
        if (proxy.landing_page) route.landing_page = proxy.landing_page;
        if (proxy.tls_skip_verify) route.tls_skip_verify = true;
        if (proxy.max_upload) route.max_upload = proxy.max_upload;
        if (proxy.timeout) route.timeout = proxy.timeout;
        if (proxy.bypass_paths) route.bypass_paths = proxy.bypass_paths;
        route.comment = s.description ?? svcName;
        routes.push(route);
      }

      // Process additional_routes (services with multiple proxy endpoints, e.g. API + MCP)
      if (proxy.additional_routes) {
        for (const ar of proxy.additional_routes) {
          const arType = ar.type ?? "subdomain";
          if (arType === "path" && ar.streaming) {
            flatMcpRoutes.push({
              base_path: ar.base_path,
              upstream: ar.upstream,
              parent_domain: ar.parent_domain,
            });
          } else if (arType === "path") {
            flatPathRoutes.push({
              base_path: ar.base_path,
              upstream: ar.upstream,
              parent_domain: ar.parent_domain,
              ...(ar.comment ? { comment: ar.comment } : {}),
            });
          }
        }
      }

    }

    // ── Build special.analytics (matomo + umami combined) ──
    if (analyticsUpstreams.matomo) {
      const matomo = analyticsUpstreams.matomo;
      const umami = analyticsUpstreams.umami;
      const matomoPublicPaths: string[] = [];
      if (matomo.proxy.paths) {
        for (const [pathKey, pathVal] of Object.entries(matomo.proxy.paths ?? {})) {
          if ((pathVal as any).auth === "public") matomoPublicPaths.push(pathKey);
        }
      }
      const umamiPublicPaths: string[] = [];
      if (umami?.proxy?.paths) {
        for (const [pathKey, pathVal] of Object.entries(umami.proxy.paths ?? {})) {
          if ((pathVal as any).auth === "public") umamiPublicPaths.push(`/umami${pathKey}`);
        }
      }
      special.analytics = {
        domain: matomo.domain,
        comment: "Matomo (public tracking + protected admin)" + (umami ? " + Umami (path-based)" : ""),
        matomo_upstream: matomo.proxy.upstream,
        ...(umami ? { umami_upstream: umami.proxy.upstream } : {}),
        public_tracking_paths: matomoPublicPaths,
        ...(umamiPublicPaths.length > 0 ? { umami_public_paths: umamiPublicPaths } : {}),
      };
    }

    // ── Build special.proxy_dashboard from caddy build.json ──
    if (caddyProxy.proxy_dashboard) {
      special.proxy_dashboard = caddyProxy.proxy_dashboard;
    }

    // ── Group path_routes by parent_domain ──
    const pathGroups: Record<string, any[]> = {};
    for (const pr of flatPathRoutes) {
      const pd = pr.parent_domain;
      if (!pathGroups[pd]) pathGroups[pd] = [];
      const { parent_domain, ...rest } = pr;
      pathGroups[pd].push(rest);
    }
    // Add extra_paths from caddy build.json parent_domain_meta
    for (const [pd, meta] of Object.entries(parentDomainMeta)) {
      if (meta.extra_paths) {
        if (!pathGroups[pd]) pathGroups[pd] = [];
        pathGroups[pd].unshift(...meta.extra_paths);
      }
    }
    const path_routes = Object.entries(pathGroups).map(([pd, paths]) => {
      const meta = parentDomainMeta[pd] ?? {};
      const group: any = { parent_domain: pd, paths };
      if (meta.comment) group.comment = meta.comment;
      if (meta.landing_page) group.landing_page = meta.landing_page;
      if (meta.fallback) group.fallback = meta.fallback;
      return group;
    });

    // ── Group mcp_routes by parent_domain ──
    const mcpGroups: Record<string, any[]> = {};
    for (const mr of flatMcpRoutes) {
      const pd = mr.parent_domain;
      if (!mcpGroups[pd]) mcpGroups[pd] = [];
      mcpGroups[pd].push({ base_path: mr.base_path, upstream: mr.upstream });
    }
    const mcp_routes = Object.entries(mcpGroups).map(([pd, endpoints]) => {
      const meta = parentDomainMeta[pd] ?? {};
      const group: any = { parent_domain: pd, endpoints };
      if (meta.comment) group.comment = meta.comment;
      if (meta.fallback_message) group.fallback_message = meta.fallback_message;
      return group;
    });

    // ── GitHub Pages proxies from caddy build.json ──
    const github_pages_proxies = (caddyProxy.github_pages_proxies ?? []).map((gp: any) => ({
      domain: gp.domain,
      github_path: gp.github_path,
      ...(gp.wkd ? { wkd: true } : {}),
      ...(gp.comment ? { comment: gp.comment } : {}),
    }));

    return {
      _meta: { description: "Caddy route definitions -- consumed by flake.nix to generate Caddyfile", format_version: 1 },
      _generated: new Date().toISOString(),
      _source: "build.json proxy fields via /cloud-data/caddy-routes",
      l4_routes,
      routes,
      path_routes,
      github_pages_proxies,
      mcp_routes,
      special,
    };
  });

  // ── Authelia ACL (derived from topology proxy.auth fields → authelia-acl.json) ──

  app.get("/cloud-data/authelia-acl", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const rules: any[] = [];

    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const proxy = s.proxy;
      if (!proxy || !s.domain) continue;

      const domain = s.domain;
      const auth = proxy.auth ?? "two_factor";
      if (auth === "ntfy-3tier") continue; // ntfy has custom auth, not Authelia-managed

      const rule: any = { domain, policy: auth, service: svcName };

      // Path-specific overrides (e.g. /api/* bypass, /admin two_factor)
      if (proxy.paths) {
        const bypass_resources: string[] = [];
        const two_factor_resources: string[] = [];
        for (const [path, override] of Object.entries(proxy.paths)) {
          const o = override as any;
          const pathAuth = o.auth ?? "two_factor";
          const regex = "^" + path.replace(/\*/g, ".*");
          if (pathAuth === "bypass" || pathAuth === "public") bypass_resources.push(regex);
          else if (pathAuth === "two_factor") two_factor_resources.push(regex);
        }
        if (bypass_resources.length > 0) rule.resources_bypass = bypass_resources;
        if (two_factor_resources.length > 0) rule.resources_two_factor = two_factor_resources;
      }

      rules.push(rule);
    }

    // Default catch-all
    rules.push({ domain: "*.diegonmarcos.com", policy: "two_factor", service: "_default" });

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/authelia-acl",
      rules,
    };
  });

  // ── Monitoring Targets (derived from topology health/monitoring fields) ──

  app.get("/cloud-data/monitoring-targets", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const endpoint_checks: any[] = [];
    const dns_checks: string[] = [];
    const tls_checks: string[] = [];
    const vms: any[] = [];

    // VM-level checks
    for (const [, vm] of Object.entries(topo.vms ?? {})) {
      const v = vm as any;
      if (!v.wg_ip) continue;
      vms.push({ ip: v.wg_ip, name: v.ssh_alias ?? "", user: v.user ?? "diego" });
    }

    // Service-level checks
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const domain = s.domain;
      if (!domain) continue;

      const monitoring = s.monitoring ?? {};
      const health = s.health ?? {};

      if (monitoring.endpoint_check !== false && health.path) {
        endpoint_checks.push({
          url: `https://${domain}${health.path}`,
          name: s.description ?? svcName,
          expected_status: health.expected_status ?? 200,
        });
      }

      if (monitoring.dns_check) dns_checks.push(domain);
      if (monitoring.tls_check) tls_checks.push(domain);
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/monitoring-targets",
      endpoint_checks,
      dns_checks,
      tls_checks,
      vms,
    };
  });

  // ── Firewall Rules (Terraform + OS firewalls + declared_ports) ──

  app.get("/cloud-data/firewall-rules", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const vms: Record<string, { ingress: any[]; source: string[] }> = {};

    // 1. Terraform firewall rules (cloud provider security lists)
    for (const fw of (topo.firewalls ?? [])) {
      for (const rule of (fw.rules ?? [])) {
        // Map firewall to VMs by provider
        const provider = fw.provider;
        for (const [, vm] of Object.entries(topo.vms ?? {})) {
          const v = vm as any;
          const alias = v.ssh_alias;
          if (!alias) continue;
          const isGcp = provider === "gcloud" && v.method === "gcloud";
          const isOci = provider === "oci" && v.method === "key" && alias.startsWith("oci");
          if (!isGcp && !isOci) continue;
          if (!vms[alias]) vms[alias] = { ingress: [], source: [] };
          if (!vms[alias].source.includes("terraform")) vms[alias].source.push("terraform");
          vms[alias].ingress.push({
            port: rule.port,
            proto: rule.protocol ?? "tcp",
            source: rule.source ?? "0.0.0.0/0",
            description: rule.description ?? "",
            origin: `terraform/${provider}`,
          });
        }
      }
    }

    // 2. OS-level firewall rules (iptables from home-manager)
    for (const osFw of (topo.os_firewalls ?? [])) {
      const alias = osFw.vm;
      if (!alias) continue;
      if (!vms[alias]) vms[alias] = { ingress: [], source: [] };
      if (!vms[alias].source.includes("os")) vms[alias].source.push("os");
      for (const rule of (osFw.rules ?? [])) {
        vms[alias].ingress.push({
          port: rule.port,
          proto: rule.proto ?? "tcp",
          description: rule.comment ?? "",
          origin: "os/iptables",
        });
      }
    }

    // 3. Service declared_ports (from build.json)
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const vm = topo.vms?.[s.vm];
      if (!vm?.ssh_alias) continue;
      const alias = vm.ssh_alias;
      if (!vms[alias]) vms[alias] = { ingress: [], source: [] };

      const declaredPorts = s.declared_ports ?? {};
      for (const [, portCfg] of Object.entries(declaredPorts)) {
        const p = portCfg as any;
        if (p.public) {
          if (!vms[alias].source.includes("build.json")) vms[alias].source.push("build.json");
          vms[alias].ingress.push({
            port: p.host ?? p.container,
            proto: p.proto ?? "tcp",
            service: svcName,
            origin: "build.json",
          });
        }
      }
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/firewall-rules",
      vms,
    };
  });

  // ── Backup Targets (services with backup.enabled) ──

  app.get("/cloud-data/backup-targets", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const targets: any[] = [];

    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const backup = s.backup;
      if (!backup?.enabled) continue;

      const vm = topo.vms?.[s.vm];
      targets.push({
        service: svcName,
        vm: vm?.ssh_alias ?? s.vm,
        volumes: backup.volumes ?? [],
        schedule: backup.schedule ?? "0 3 * * *",
        retention: backup.retention ?? "30d",
      });
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/backup-targets",
      targets,
    };
  });

  // ── WireGuard Peers (derived from topology VMs with wg_ip) ──

  app.get("/cloud-data/wireguard-peers", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const peers: any[] = [];
    for (const [vmId, vm] of Object.entries(topo.vms ?? {})) {
      const v = vm as any;
      if (!v.wg_ip) continue;
      peers.push({
        vm_id: vmId,
        name: v.ssh_alias ?? vmId,
        wg_ip: v.wg_ip,
        public_ip: v.ip ?? "",
        user: v.user ?? "diego",
      });
    }

    // WireGuard mesh config from topology
    const wg = topo.wireguard ?? topo.native?.wireguard ?? {};

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/wireguard-peers",
      hub: wg.hub ?? null,
      peers: wg.peers ?? peers,
      mesh_peers: peers,
    };
  });

  // ── ntfy ACL (derived from topology notifications fields) ──

  app.get("/cloud-data/ntfy-acl", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const topics: Record<string, { publishers: string[]; desc: string }> = {};

    // System topics (always present)
    for (const t of ["syslog", "github-releases", "alerts", "health", "backups"]) {
      topics[t] = { publishers: ["system"], desc: `System topic: ${t}` };
    }

    // Service-declared topics
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const topic = s.notifications?.topic;
      if (!topic) continue;
      if (!topics[topic]) topics[topic] = { publishers: [], desc: "" };
      topics[topic].publishers.push(svcName);
      if (!topics[topic].desc) topics[topic].desc = `Topic for ${svcName}`;
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/ntfy-acl",
      topics,
    };
  });

  // ── Cloudflare DNS (Terraform records + service-derived CNAMEs) ──

  app.get("/cloud-data/cloudflare-dns", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const records: any[] = [];
    const seenNames = new Set<string>();

    // 1. Terraform-parsed records (A, MX, TXT, CNAME — the real DNS state)
    for (const rec of (topo.dns?.cloudflare ?? [])) {
      const key = `${rec.type}:${rec.name}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      records.push({
        name: rec.name,
        type: rec.type,
        content: rec.content,
        ...(rec.proxied != null ? { proxied: rec.proxied } : {}),
        ...(rec.ttl != null ? { ttl: rec.ttl } : {}),
        ...(rec.priority != null ? { priority: rec.priority } : {}),
        ...(rec.comment ? { comment: rec.comment } : {}),
        origin: "terraform",
      });
    }

    // 2. Service-derived CNAMEs (from build.json domains — may overlap with Terraform)
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      let domain = s.domain;
      if (!domain) continue;

      domain = domain.split("/")[0];
      const proxyDomain = s.proxy?.parent_domain ?? domain;
      const finalDomain = proxyDomain !== domain ? proxyDomain : domain;
      const key = `CNAME:${finalDomain}`;
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      records.push({ name: finalDomain, type: "CNAME", content: "diegonmarcos.com", proxied: true, service: svcName, origin: "build.json" });
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/cloudflare-dns",
      zone: "diegonmarcos.com",
      records,
    };
  });

  // ── Matomo Sites (services with domains that have analytics tracking) ──

  app.get("/cloud-data/matomo-sites", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const sites: any[] = [];
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      if (!s.domain) continue;
      const domain = s.domain.split("/")[0];
      sites.push({
        name: s.description ?? svcName,
        url: `https://${domain}`,
        service: svcName,
      });
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/matomo-sites",
      sites,
    };
  });

  // ── Container Resources (derived from topology — mem/cpu per service) ──

  app.get("/cloud-data/container-resources", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const services: Record<string, any> = {};
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const vm = topo.vms?.[s.vm];
      if (!vm) continue;
      services[svcName] = {
        vm: vm.ssh_alias ?? s.vm,
        vm_ram_gb: vm.specs?.ram_gb ?? null,
        vm_cpu: vm.specs?.cpu ?? null,
        containers: s.containers ?? [],
        resources: s.resources ?? null,
      };
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/container-resources",
      services,
    };
  });

  // ── Log Routing (derived from topology — container → log config) ──

  app.get("/cloud-data/log-routing", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    if (!existsSync(getConfigPath())) { reply.code(404).send({ error: "_cloud-data-consolidated.json not generated yet" }); return; }
    const topo = JSON.parse(readFileSync(getConfigPath(), "utf-8"));

    const routes: Record<string, any[]> = {};
    for (const [svcName, svc] of Object.entries(topo.services ?? {})) {
      const s = svc as any;
      const vm = topo.vms?.[s.vm];
      if (!vm?.ssh_alias) continue;
      const alias = vm.ssh_alias;
      if (!routes[alias]) routes[alias] = [];
      for (const container of (s.containers ?? [])) {
        routes[alias].push({
          container,
          service: svcName,
          log_level: s.log_level ?? "info",
        });
      }
    }

    return {
      _generated: new Date().toISOString(),
      _source: "_cloud-data-consolidated.json via /cloud-data/log-routing",
      vms: routes,
    };
  });

  // ── GHA Workflow Config (VM SSH secrets + service→VM mapping for workflow generation) ──

  app.get("/cloud-data/gha-config", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    const config = getConfig();

    const vms: Record<string, any> = {};
    for (const [vmId, vm] of Object.entries(config.vms)) {
      const v = vm as any;
      if (!v.ssh_alias || !v.gha) continue;
      const gha = v.gha;
      vms[v.ssh_alias] = {
        ssh_secret: gha.ssh_secret,
        ...(gha.host_literal ? { host: v.ip, user: v.user } : {}),
        ...(gha.host_secret ? { host_secret: gha.host_secret, user_secret: gha.user_secret } : {}),
      };
    }

    const services: Record<string, any> = {};
    for (const [name, svc] of Object.entries(config.services)) {
      const s = svc as any;
      const folder = s.folder;
      if (!folder) continue;

      const bjPath = join(SOLUTIONS_DIR, folder, "build.json");
      if (!existsSync(bjPath)) continue;
      try {
        const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
        const host = bj.deploy?.host;
        if (!host || host === "local" || host === "all") continue;
        if (bj.frozen) continue; // Skip frozen services
        services[name] = {
          dir: folder,
          vm: host,
          has_docker: !!bj.docker,
        };
      } catch { continue; }
    }

    return {
      _generated: new Date().toISOString(),
      _source: "config.json + build.json via /cloud-data/gha-config",
      vms,
      services,
    };
  });

  // ── Home Manager Config (all data needed by home-manager nix modules) ──

  app.get("/cloud-data/home-manager", { schema: { tags: ["Inventory"] } }, async (_req, reply) => {
    const config = getConfig();
    const rawConfig = config as any;
    const native = rawConfig.native ?? {};
    const wgConfig = native.wireguard ?? {};

    const vms: Record<string, any> = {};
    for (const [vmId, vm] of Object.entries(config.vms)) {
      const v = vm as any;
      if (!v.ssh_alias) continue;
      vms[v.ssh_alias] = {
        vm_id: vmId, ip: v.ip, wg_ip: v.wg_ip,
        wg_public_key: v.wg_public_key ?? null,
        wg_port: v.wg_port ?? 51820, wg_role: v.wg_role ?? "spoke",
        user: v.user, home: v.home ?? (v.user === "root" ? "/root" : `/home/${v.user}`),
        rescue_port: v.rescue_port ?? 2200,
        specs: v.specs ?? {}, public_ports: v.public_ports ?? [],
        idle_shutdown: v.idle_shutdown ?? null,
        containers: v.containers ?? [], method: v.method, gha: v.gha ?? null,
      };
    }

    // Build WG key lookup from HM build.json files (authoritative key source)
    const hmKeysByAlias: Record<string, string> = {};
    const hmDir = join(process.env.GIT_BASE ?? "", "cloud", "b_infra", "home-manager");
    for (const alias of Object.keys(vms)) {
      try {
        const bjPath = join(hmDir, alias, "build.json");
        const bj = JSON.parse(readFileSync(bjPath, "utf-8"));
        if (bj.wg_public_key) hmKeysByAlias[alias] = bj.wg_public_key;
      } catch { /* build.json not accessible — expected on VMs */ }
    }

    // Fallback: read existing WG public keys from _cloud-data-consolidated.json
    // 2026-04-27 migrated: cloud-data-home-manager.json -> _cloud-data-consolidated.json (native.wireguard.peers / wireguard.peers)
    try {
      const consolidatedPath = getConsolidatedPath();
      if (existsSync(consolidatedPath)) {
        const existing = JSON.parse(readFileSync(consolidatedPath, "utf-8"));
        const peers = existing.native?.wireguard?.peers ?? existing.wireguard?.peers ?? existing._home_manager?.wireguard?.peers ?? [];
        for (const p of peers) {
          if (p.name && p.wg_public_key && !hmKeysByAlias[p.name]) hmKeysByAlias[p.name] = p.wg_public_key;
        }
      }
    } catch { /* not available */ }

    // Build peers from VMs that have wg_ip, enriched with keys
    const peers = Object.entries(vms)
      .filter(([_, v]: any) => v.wg_ip)
      .map(([alias, v]: any) => ({
        name: alias, wg_ip: v.wg_ip, public_ip: v.ip,
        wg_public_key: v.wg_public_key ?? hmKeysByAlias[alias] ?? null,
        wg_port: v.wg_port, role: v.wg_role, endpoint: v.ip,
      }));

    const sshEntries = Object.entries(vms).map(([alias, v]: any) => ({
      host: alias, hostname: v.wg_ip ?? v.ip, user: v.user,
      identity_file: v.method === "gcloud" ? "~/.ssh/google_compute_engine" : "~/.ssh/vault_id_rsa",
      port: 22,
    }));

    return {
      _generated: new Date().toISOString(),
      _source: "config.json via /cloud-data/home-manager",
      owner: rawConfig.owner ?? {},
      home_manager: rawConfig.home_manager ?? { state_version: "24.11" },
      vms,
      wireguard: {
        subnet: wgConfig.subnet ?? "10.0.0.0/24", port: wgConfig.port ?? 51820,
        hub: wgConfig.wg_hub ?? null, peers, clients: wgConfig.clients ?? {},
      },
      dns: native.dns ?? { primary: "10.0.0.1", fallback: "1.1.1.1" },
      docker: native.docker ?? { subnet: "172.16.0.0/12", iptables: false },
      monitoring: native.monitoring ?? { ntfy_base: "https://rss.diegonmarcos.com" },
      ssh_config: sshEntries,
    };
  });

  // ── Files: config (from files.ts) ──

  app.get<{ Params: { service: string } }>(
    "/files/config/:service",
    { schema: { tags: ["Inventory"], params: { type: "object" as const, properties: { service: { type: "string" as const } }, required: ["service"] } } },
    async (req) => {
      return { content: getConfigFile(req.params.service) };
    },
  );

  app.get<{ Params: { service: string; file: string } }>(
    "/files/config/:service/:file",
    { schema: { tags: ["Inventory"], params: { type: "object" as const, properties: { service: { type: "string" as const }, file: { type: "string" as const } }, required: ["service", "file"] } } },
    async (req) => {
      return { content: getConfigFile(req.params.service, req.params.file) };
    },
  );
}
// rebuild 1774202309
