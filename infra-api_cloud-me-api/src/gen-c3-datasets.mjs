// gen-c3-datasets.mjs — builds the five c3-* datasets served at /me/config/<name>
// from the fleet's own source of truth (this repo's */build.json, the fleet
// public-route allowlist). Declarative and deterministic: no timestamps, no
// network, sorted keys. Only an explicit field allow-list is projected, so
// secrets, env files and `secrets:` blocks can never reach a dataset; the output
// is then scanned with runtime.files.deny_content and generation FAILS on a hit.
//
//   node gen-c3-datasets.mjs          write code/data/*.json
//   node gen-c3-datasets.mjs --check  exit 1 if code/data is stale (used by the test)
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(HERE, 'code', 'data');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const DENY = new RegExp(readJson(join(HERE, '..', 'build.json')).runtime.files.deny_content, 'im');

export const GROUPS = {
  'c3-mail': ['user-comm_tools-stalwart', 'user-comm_tools-maddy', 'user-comm_cloud-webmail', 'user-comm_mail-puller',
    'infra-api_cloud-mail-mcp', 'infra-api_cloudy-mail-http-to-smtp-api', 'infra-sec_caddy-l4-image'],
  'c3-dns-routing': ['infra-net_hickory-dns', 'infra-net_unbound-dns64', 'infra-net_cloudflared', 'infra-cloud_cloudflare-worker',
    'infra-sec_caddy', 'infra-sec_caddy-public'],
  'c3-security-network': ['infra-sec_authelia', 'infra-sec_crowdsec', 'infra-sec_introspect-proxy', 'infra-sec_mcp-oauth', 'infra-sec_cloudy-ai-tokens-api',
    'infra-sec_caddy', 'infra-sec_caddy-public', 'infra-net_wireguard-mesh', 'infra-net_wireguard-mesh-ws-tunnel', 'infra-net_wireguard-public'],
  'c3-observability': null, // every infra-obs_* plus bc-obs_*
  'c3-mcp-apis': null,      // every infra-api_* plus user-*mcp*/api services
};

const dirs = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_')
  && d.name !== 'z_archive' && existsSync(join(ROOT, d.name, 'build.json'))).map((d) => d.name).sort();
const builds = Object.fromEntries(dirs.map((d) => [d, readJson(join(ROOT, d, 'build.json'))]));
const allow = readJson(join(ROOT, '_shared', 'public-route-allowlist.json'));

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const routes = (b) => {
  const out = [];
  for (const [k, p] of Object.entries(b.proxy || {})) {
    if (!p || typeof p !== 'object' || Array.isArray(p) || !(p.domain || p.parent_domain)) continue;
    out.push({ block: k, host: p.domain || p.parent_domain, ...pick(p, ['type', 'base_path', 'auth', 'public_paths', 'streaming']), wg_only: p.wg_only ?? true });
  }
  return out;
};
const project = (dir, b) => {
  const r = routes(b);
  const public_ = r.some((x) => x.wg_only === false);
  return {
    service: dir, name: b.name, description: b.description, category: b.category, enabled: b.enabled !== false,
    host: b.deploy?.host, dns: typeof b.dns === 'string' ? b.dns : undefined, domain: b.domain, ports: b.ports,
    containers: Object.entries(b.containers || {}).map(([k, c]) => ({ key: k, container_name: c.container_name, dns: c.dns, port: c.port, protocol: c.protocol, mesh_route: c.public !== false })),
    routes: r,
    exposure: public_ ? (allow.allowed[dir] ? 'public (allowlisted)' : allow.pending_owner_review[dir] ? 'public (pending owner review)' : 'public (NOT allowlisted)') : 'wg-only (mesh)',
    health: b.health?.path, monitoring: b.monitoring,
    api: b.api ? pick(b.api, ['type', 'base_path', 'endpoint_count', 'display_name', 'auth']) : undefined,
    mcp: b.mcp ? pick(b.mcp, ['transport', 'endpoint_path', 'tools_count', 'resources_count', 'prompts_count', 'display_name', 'auth']) : undefined,
    endpoints: b.runtime?.endpoints?.map((e) => pick(e, ['method', 'path', 'auth'])),
  };
};
const svc = (dir) => builds[dir] ? project(dir, builds[dir]) : null;
const clean = (v) => JSON.parse(JSON.stringify(v)); // drops undefined
const hub = builds['infra-sec_caddy']?.caddy_config || {};
const meta = (g) => ({ _generated_from: 'cloud-u-containers */build.json + _shared/public-route-allowlist.json (gen-c3-datasets.mjs); no secrets by construction', dataset: g });

export function build() {
  const all = dirs.map(svc);
  const outs = {};
  for (const g of Object.keys(GROUPS)) {
    let list;
    if (g === 'c3-observability') list = dirs.filter((d) => d.startsWith('infra-obs_') || d.startsWith('bc-obs_'));
    else if (g === 'c3-mcp-apis') list = dirs.filter((d) => d.startsWith('infra-api_') || /^user-.*(mcp|api)/.test(d));
    else list = GROUPS[g];
    outs[g] = { ...meta(g), count: 0, services: list.map(svc).filter(Boolean) };
    outs[g].count = outs[g].services.length;
  }
  // dataset-specific detail, all derived from declared config
  const hk = builds['infra-net_hickory-dns']?.dns;
  outs['c3-dns-routing'].hickory = hk && typeof hk === 'object' ? pick(hk, ['zones', 'forwarders']) : undefined;
  outs['c3-dns-routing'].rule = 'Cloudflare and Hickory are wildcard-only; Caddy is the single SoT for routing and exposure; every route is WG-only unless on the public allowlist.';
  outs['c3-dns-routing'].route_table = all.flatMap((s) => s.routes.map((r) => ({ service: s.service, mesh_name: s.dns, ...r })))
    .sort((a, b) => (a.host + (a.base_path || '') + a.service).localeCompare(b.host + (b.base_path || '') + b.service));
  outs['c3-dns-routing'].mesh_names = all.filter((s) => s.dns).map((s) => ({ service: s.service, dns: s.dns })).sort((a, b) => a.dns.localeCompare(b.dns));
  outs['c3-mail'].mta_sts = hub.mta_sts;
  outs['c3-mail'].wkd = hub.wkd;
  outs['c3-security-network'].public_allowlist = allow;
  outs['c3-security-network'].public_services = all.filter((s) => s.exposure.startsWith('public')).map((s) => ({ service: s.service, exposure: s.exposure }));
  outs['c3-security-network'].edge_auth_policy = hub.edge_auth ? pick(hub.edge_auth, ['public_open', 'technical', 'private', 'default_tier']) : undefined;
  const files = {};
  for (const [g, v] of Object.entries(outs)) {
    const text = JSON.stringify(clean(v), null, 2) + '\n';
    const hit = text.match(DENY);
    if (hit) throw new Error(`${g}: secret-looking content refused (${hit[0].slice(0, 12)}...)`);
    files[`${g}.json`] = text;
  }
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = build();
  if (process.argv.includes('--check')) {
    const stale = Object.entries(files).filter(([n, t]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== t).map(([n]) => n);
    if (stale.length) { console.error(`stale datasets (run node gen-c3-datasets.mjs): ${stale.join(', ')}`); process.exit(1); }
    console.log('datasets fresh');
  } else {
    mkdirSync(OUT, { recursive: true });
    for (const [n, t] of Object.entries(files)) { writeFileSync(join(OUT, n), t); console.log(`${n} ${t.length}b`); }
  }
}
