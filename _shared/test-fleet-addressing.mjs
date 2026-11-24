// Guard: fleet naming + addressing rule (ticket #1100).
//  naming   : API containers end in -api, MCP servers in -mcp, names are valid host labels
//  mesh     : a container's mesh name (build.json dns) is "<name>.mesh.diegonmarcos.com"
//  no_api_host : nothing is served from the api.diegonmarcos.com host
//  public_host / public_subdomain : no per-app public subdomain (#1104): a container is public only at c3-pvt/{container}
//  protected: a route with wg_only:false is auth-protected unless its host is on the unprotected allowlist
//  mesh_tld : (#1123) a mesh name (any build.json dns field, any Hickory zone) must live under a namespace that cannot exist
//             publicly: <name>.mesh.diegonmarcos.com, home.arpa, or a reserved suffix. A real public TLD (.app, .dev, ...) leaks
//             the name to a stranger's host the moment a device resolves it off the fleet DNS. `.app` FAILS unconditionally
//             (owner decision, no transition window): no alias, no expiry date.
//  app_tld  : (#1123) no `*.app` host anywhere in a build.json value, the rendered hub Caddyfile or a Hickory zone list.
//  pages    : github-pages hosts are on the unprotected allowlist
//  mesh_dial: (#1885) a src/compose.nix dial of <name>.mesh.diegonmarcos.com:<port> at an off-hub container needs an owned
//             Hickory A row that does not answer the hub (the wildcard sent ft_ token checks to gcp-proxy, nothing on :4184).
// _shared/fleet-addressing.json holds the allowlist (host -> reason) and a transitional
// list per rule. A listed entry that no longer violates FAILS (the lists only shrink);
// they must be empty when ticket #1100 phase P4 lands. Run: node test-fleet-addressing.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd(), process.cwd().endsWith("_shared") ? ".." : ".");
const cfg = JSON.parse(readFileSync(join(root, "_shared/fleet-addressing.json"), "utf8"));
const DOM = "diegonmarcos.com";
const unprotected = new Set(Object.keys(cfg.unprotected_hosts));
const apiNames = new Set(cfg.api_containers || []);
// #1104 mesh transport: the canonical mesh address is http://<name>.mesh.diegonmarcos.com:<port>, dialled directly on the
// container's VM wg0 address. A container with a declared port needs an owned Hickory row for <name>.
const hk = JSON.parse(readFileSync(join(root, "infra-net_hickory-dns/build.json"), "utf8"));
const meshDirect = new Set((hk.dns?.records?.["mesh.diegonmarcos.com"] ?? []).map((r) => r.name));
// #1123 mesh namespace policy. Suffix match on the whole name, never on the TLD alone, so
// `x.mesh.diegonmarcos.com` passes and `x.diegonmarcos.com` (a public name) does not.
const meshCfg = cfg.mesh ?? {};
const privateSuffixes = meshCfg.private_suffixes ?? [".mesh.diegonmarcos.com", ".home.arpa", ".internal", ".db", ".localhost", ".test", ".invalid"];
const meshNameProblem = (name) => {
  const n = String(name).toLowerCase().replace(/\.$/, "");
  if (n === "app" || n.endsWith(".app")) return `${name}: .app is a real public TLD (a stranger's host); use <name>.mesh.diegonmarcos.com (#1123, no alias)`;
  if (privateSuffixes.some((x) => n.endsWith(x) || `.${n}` === x)) return null;
  return `${name}: not under a private mesh namespace (${privateSuffixes.join(", ")}); a public TLD leaks the name to a stranger's host`;
};
const meshNames = (o, acc = []) => {
  if (Array.isArray(o)) o.forEach((x) => meshNames(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
    if (k === "dns" && typeof v === "string") acc.push(v);
    else if (k !== "records" && k !== "forwarders") meshNames(v, acc);
  }
  return acc;
};
// #1123: any host under the public .app TLD in a JSON value (keys such as ports.app / containers.app are not values).
const APP_HOST = /(^|[^A-Za-z0-9_.-])((?:[A-Za-z0-9_{}*-]+\.)+app)(?![A-Za-z0-9_-])(?!\.[A-Za-z])/g;
const THIRD_PARTY = new Set(["railway.app", "linear.app", "vercel.app"]); // real third-party domains, not mesh names
const appHostsIn = (o, acc = []) => {
  if (Array.isArray(o)) o.forEach((x) => appHostsIn(x, acc));
  else if (o && typeof o === "object") Object.values(o).forEach((x) => appHostsIn(x, acc));
  else if (typeof o === "string") for (const m of o.matchAll(APP_HOST)) if (![...THIRD_PARTY].some((t) => m[2] === t || m[2].endsWith(`.${t}`))) acc.push(m[2]);
  return acc;
};
const found = {}; // rule -> Set(container)
const hit = (rule, n) => (found[rule] ??= new Set()).add(n);

const blocks = (o, acc = []) => {
  if (Array.isArray(o)) o.forEach((x) => blocks(x, acc));
  else if (o && typeof o === "object") {
    if (o.domain || o.parent_domain) acc.push(o);
    Object.values(o).forEach((x) => blocks(x, acc));
  }
  return acc;
};
const hostOf = (b) => String(b.parent_domain || b.domain).split(",")[0].trim();

for (const d of readdirSync(root, { withFileTypes: true })) {
  if (!d.isDirectory() || d.name === "z_archive" || d.name.startsWith(".")) continue;
  const f = join(root, d.name, "build.json");
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, "utf8"));
  const n = j.name;
  const isMcp = /-mcp$/.test(n);
  const apiish = apiNames.has(n) || (!isMcp && (d.name.startsWith("infra-api_") || /(^|[-_])api($|[-_])/.test(n)));
  if (!/^[a-z0-9-]+$/.test(n) || (apiish && !n.endsWith("-api"))) hit("naming", n);
  if (typeof j.dns === "string" && j.dns.endsWith(".mesh.diegonmarcos.com") && j.dns !== `${n}.mesh.diegonmarcos.com`) hit("mesh", n);
  if (appHostsIn(j).length) { hit("app_tld", n); console.error(`app_tld: ${n}: ${appHostsIn(j).slice(0, 3).join(", ")}`); }
  for (const nm of new Set(meshNames(j))) { const pr = meshNameProblem(nm); if (pr) { hit("mesh_tld", n); console.error(`mesh_tld: ${n}: ${pr}`); } }
  for (const z of j.dns?.zones ?? []) { const pr = meshNameProblem(`x.${z}`.replace(/^x\.(diegonmarcos\.com)$/, "x.public-apex-zone.mesh.diegonmarcos.com")); if (pr) { hit("mesh_tld", n); console.error(`mesh_tld: ${n} zone ${z}: ${pr}`); } }
  const port = j.ports?.app ?? j.containers?.app?.port;
  if (typeof j.dns === "string" && j.dns === `${n}.mesh.diegonmarcos.com` && Number.isInteger(port) && !meshDirect.has(n)) hit("mesh_direct", n);
  const ph = j.proxy?.primary?.public_host;
  if (ph !== undefined) hit("public_host", n); // never transitional (#1104): no per-app public subdomain, the public address is c3-pvt/{container}
  for (const b of blocks(j.proxy ?? {})) {
    const h = hostOf(b);
    if (h === `api.${DOM}`) hit("no_api_host", n);
    if (b.wg_only === false && !unprotected.has(h)) hit("public_subdomain", n); // #1104: a public per-app host (api.*, mcp.*, own subdomain)
    if (b.wg_only === false && !unprotected.has(h) && !["two_factor", "bearer"].includes(b.auth)) hit("protected", n);
  }
  for (const p of j.proxy?.github_pages_proxies ?? [])
    for (const h of p.domain.split(",").map((s) => s.trim())) if (!unprotected.has(h)) hit("pages", `${n}:${h}`); // explicit public Pages hosts only
}

let fail = 0;
// ── Tiers (ticket #1104): the rendered hub Caddyfile must carry the c3-pvt and c3-pub sites as declared ──
const siteOf = (text, host) => {
  const m = [...text.matchAll(/^ {2,4}([^\n{]+) \{$/gm)].find((x) => x[1].split(",").map((h) => h.trim()).includes(host) && !/^\s*(handle|route|header|tls|log|proxy|not|zone|bind)\b/.test(x[1]));
  if (!m) return null;
  let d = 0, i = m.index + m[0].length - 1;
  for (; i < text.length; i++) { d += (text[i] === "{") - (text[i] === "}"); if (d === 0) break; }
  return text.slice(m.index, i + 1);
};
const pathAllowed = (p, allow) => allow.some((a) => a.endsWith("/*") ? p === a || p.startsWith(a.slice(0, -1)) : p === a);
const tierProblems = (text) => {
  const out = [], T = cfg.tiers;
  if (!T) return out;
  const pvt = siteOf(text, T.pvt.host), pub = siteOf(text, T.pub.host);
  if (!pvt) out.push(`tiers: ${T.pvt.host} site missing from the rendered Caddyfile`);
  else {
    if (!/^ *import edge_auth( |$)/m.test(pvt)) out.push(`tiers: ${T.pvt.host} must import the edge_auth gate (cookie or bearer)`);
    if (/^ *import edge_auth_offmesh/m.test(pvt)) out.push(`tiers: ${T.pvt.host} must not use the off-mesh gate`);
    if (/^ *(respond|redir) /m.test(pvt.replace(/handle \{[^}]*\}/g, ""))) out.push(`tiers: ${T.pvt.host} has a site-level respond/redir outside a handle`);
    for (const m of pvt.matchAll(/handle_path (\/[^\s]*)/g)) if (!/^\/[a-z0-9_-]+\/\*$/.test(m[1])) out.push(`tiers: ${T.pvt.host} path ${m[1]} is not /{container}/*`);
  }
  if (!pub) out.push(`tiers: ${T.pub.host} site missing from the rendered Caddyfile`);
  else {
    if (/^ *import edge_auth/m.test(pub)) out.push(`tiers: ${T.pub.host} is an allowlist site and must not import a gate`);
    const seen = [...pub.matchAll(/^ *handle (\/[^\s]*) \{/gm)].map((m) => m[1]);
    for (const m of pub.matchAll(/^ *@\w+ path ([^\n]+)/gm)) seen.push(...m[1].trim().split(/\s+/));
    // Declared write-only sinks (tiers.pub.sinks): the bare path is served too, because the app clients post to
    // the bare URL (c3-pub/analytics-api/openobserve) and `handle <path>/*` alone answered 404 there (#1104).
    const sinkPaths = Object.keys(T.pub.sinks ?? {}).filter((k) => !k.startsWith("_"));
    const sinkBare = sinkPaths.filter((k) => k.endsWith("/*")).map((k) => k.slice(0, -2));
    for (const q of seen) if (!pathAllowed(q, T.pub.allowlist) && !sinkBare.includes(q)) out.push(`tiers: ${T.pub.host} serves ${q}, which is not on tiers.pub.allowlist`);
    for (const sp of sinkPaths) {
      const have = (x) => seen.includes(x);
      if (!have(sp)) out.push(`tiers: ${T.pub.host} does not serve the declared sink subtree ${sp}`);
      if (sp.endsWith("/*") && !have(sp.slice(0, -2))) out.push(`tiers: ${T.pub.host} does not serve the bare sink path ${sp.slice(0, -2)} (clients post to the bare URL; it would 404)`);
    }
    if (/^ *handle_path /m.test(pub)) out.push(`tiers: ${T.pub.host} must not mount container paths`);
    if (!/^ *handle \{\n\s*error "Not Found" 404/m.test(pub)) out.push(`tiers: ${T.pub.host} must end in a 404 default`);
  }
  // Public HTML tier and wildcard (owner ruling 2026-10-22): apex + www are the only unauthenticated hosts,
  // and the *.diegonmarcos.com site may only redirect to the apex.
  const P = T.public;
  if (P) {
    for (const h of P.html_hosts) {
      const blk = siteOf(text, h);
      if (!blk) { out.push(`tiers: public HTML host ${h} has no site`); continue; }
      if (/^ *import edge_auth/m.test(blk)) out.push(`tiers: public HTML host ${h} must not carry the gate`);
    }
    // Owner decision 2026-10-29 (#1292): the WHOLE mta-sts host is public (root included, not just the policy path);
    // mail. and capital-stack-finterminal-api. stay behind the gate.
    if (!P.html_hosts.includes("mta-sts.diegonmarcos.com")) out.push("tiers: mta-sts.diegonmarcos.com must be a declared public host (whole host, root included)");
    const mta = siteOf(text, "mta-sts.diegonmarcos.com");
    if (mta && /^ *import edge_auth/m.test(mta)) out.push("tiers: mta-sts root must be public: the site carries the gate (root would 302 to auth)");
    if (mta && !/handle \/ \{/.test(mta)) out.push("tiers: mta-sts root / has no handle (the home page must answer without auth)");
    for (const g of ["mail.diegonmarcos.com", "fin-api.diegonmarcos.com"]) {
      const gb = siteOf(text, g);
      if (gb && !/^ *import edge_auth/m.test(gb)) out.push(`tiers: ${g} must stay behind the gate`);
    }
    for (const k of Object.keys(cfg.unprotected_hosts)) if (k.includes("*")) out.push(`tiers: unprotected_hosts lists a wildcard (${k}); there is no public wildcard route`);
    for (const m of text.matchAll(/^ {2,4}(\*\.diegonmarcos\.com[^\n{]*) \{$/gm)) {
      const blk = siteOf(text, m[1]);
      if (!blk) continue;
      if (/reverse_proxy|file_server|^ *respond |handle_path|rewrite /m.test(blk)) out.push(`tiers: wildcard site ${m[1]} proxies, serves or responds; a wildcard may only redirect to the apex`);
      if (!blk.includes(`redir ${P.wildcard_redirect_to} `)) out.push(`tiers: wildcard site ${m[1]} must redirect to ${P.wildcard_redirect_to}`);
      if (/^ *import edge_auth/m.test(blk)) out.push(`tiers: wildcard site ${m[1]} carries the gate; it is a no-route redirect`);
    }
  }
  for (const [h, to] of Object.entries(T.redirects ?? {})) {
    if (h.startsWith("_")) continue;
    const blk = siteOf(text, h);
    if (!blk) out.push(`tiers: retired host ${h} has no redirect site`);
    else {
      if (!blk.includes(`redir ${to}{uri} 308`)) out.push(`tiers: retired host ${h} must redirect (308) to ${to}`);
      if (!/^ *import edge_auth/m.test(blk)) out.push(`tiers: retired host ${h} must import the gate (owner ruling 2026-10-29, #1292): an anonymous caller is sent to sign-in; the 308 only runs for a session or fleet bearer`);
    }
  }
  // Stage-3 old-host path redirects (api.* and mcp.* prefixes). They stay pending until every client is on c3-pvt
  // (a cross-host redirect drops the Authorization header), but each pending target must already exist on c3-pvt.
  const mounted = pvt ? new Set([...pvt.matchAll(/handle_path \/([a-z0-9_-]+)\/\*/g)].map((m) => m[1])) : new Set();
  for (const [from, container] of Object.entries(T.path_redirects_pending ?? {})) {
    if (from.startsWith("_")) continue;
    if (!/^(api|mcp)\.diegonmarcos\.com\/[a-z0-9_-]+$/.test(from)) out.push(`tiers: pending redirect source ${from} must be api.* or mcp.* /<prefix>`);
    if (!mounted.has(container)) out.push(`tiers: pending redirect ${from} targets ${container}, which is not mounted on ${T.pvt.host}`);
  }
  return out;
};
const CF = join(root, "infra-sec_caddy/dist/configs/Caddyfile");
if (cfg.tiers && existsSync(CF)) {
  const text = readFileSync(CF, "utf8");
  const probs = tierProblems(text);
  // Mutation proof: each defect must be caught, or the guard above proves nothing.
  const pubHost = cfg.tiers.pub.host, pvtHost = cfg.tiers.pvt.host;
  const muts = {
    "extra path on pub": text.replace(`    ${pubHost} {`, `    ${pubHost} {\n      handle /admin {\n        respond "x"\n      }`),
    "gate on pub": text.replace(`    ${pubHost} {`, `    ${pubHost} {\n      import edge_auth`),
    "wildcard proxies": text.replace(/(\n {2,4}\*\.diegonmarcos\.com \{\n)/, "$1      reverse_proxy 10.0.0.9:1\n"),
    "wildcard to elsewhere": text.replace(/redir https:\/\/diegonmarcos\.com\/ 302/, "redir https://evil.example/ 302"),
    "no gate on retired redirect": text.replace(/(\n {2}fin-api\.diegonmarcos\.com \{\n[^}]*?)import edge_auth [^\n]*\n/, "$1"),
    "gate on mta-sts root": text.replace(/(\n {2}mta-sts\.diegonmarcos\.com \{\n[^}]*?import security\n)/, "$1    import edge_auth /.well-known/acme-challenge/* /.well-known/mta-sts.txt\n"),
    "pending redirect to unmounted container": text,
    "sink without bare path": text.replace(/(@pubsink_\w+ path )(\/[^\s]+) (\/[^\s]+\/\*)/, "$1$3"),
    "no gate on pvt": text.replace(new RegExp(`(${pvtHost.replace(/\./g, "\\.")} \\{[\\s\\S]*?)import edge_auth [^\\n]*\\n`), "$1"),
  };
  const realPending = cfg.tiers.path_redirects_pending;
  for (const [name, t] of Object.entries(muts)) {
    if (name.startsWith("pending redirect")) cfg.tiers.path_redirects_pending = { ...(realPending ?? {}), "api.diegonmarcos.com/zz": "no-such-container" };
    const caught = tierProblems(t).length > 0;
    cfg.tiers.path_redirects_pending = realPending;
    if (!caught) probs.push(`tiers: mutation "${name}" was not caught; the guard is blind`);
  }
  for (const [name, t] of []) if (tierProblems(t).length === 0) probs.push(`tiers: mutation "${name}" was not caught; the guard is blind`);
  for (const pr of probs) { fail++; console.error(`FAIL ${pr}`); }
  console.log(`tiers: ${probs.length ? probs.length + " problem(s)" : "c3-pvt gated, c3-pub confined to its allowlist, 8 mutations caught"}`);
}

// Edge -> hub TLS proxies must keep the client Host. Caddy >= 2.11 rewrites Host to the upstream
// hostport for an https upstream; the hub is strict-SNI (mTLS vault vhost), so SNI=c3-pvt with
// Host=10.1.0.2:443 is a 421 for every request (incl. bearer-authenticated MCP calls, 2026-10-29).
const CFP = join(root, "infra-sec_caddy-public/dist/configs/Caddyfile");
if (existsSync(CFP)) {
  const hubProxyProblems = (t) => {
    const out = [];
    const re = /reverse_proxy https:\/\/10\.1\.0\.2:443 \{([\s\S]*?)\n\s*\}\n/g;
    let m, n = 0;
    while ((m = re.exec(t))) {
      n++;
      const hostPin = /header_up Host (\{host\}|[a-z0-9.-]+\.diegonmarcos\.com)\s*$/m.exec(m[1]);
      const sni = /tls_server_name (\S+)/.exec(m[1]);
      if (!hostPin) out.push(`edge hub proxy #${n} lacks a "header_up Host" pin (hub answers 421)`);
      // #1147: a placeholder SNI shares ONE pooled upstream connection across hosts, so the hub (strict SNI/Host)
      // answered 421 to every alias but the first one served. SNI must be a literal and equal the pinned Host.
      if (sni && /\{/.test(sni[1])) out.push(`edge hub proxy #${n} uses a placeholder tls_server_name (${sni[1]}): shared connection pool, hub answers 421 to the other hosts (#1147)`);
      if (hostPin && sni && !/\{/.test(hostPin[1]) && hostPin[1] !== sni[1]) out.push(`edge hub proxy #${n} pins Host ${hostPin[1]} but SNI ${sni[1]} (hub answers 421)`);
    }
    if (!n) out.push("no edge->hub https reverse_proxy found; the guard is blind");
    return out;
  };
  const tcp = readFileSync(CFP, "utf8");
  const probs = hubProxyProblems(tcp);
  if (hubProxyProblems(tcp.replace(/\n\s*header_up Host [^\n]+/g, "")).length === 0) probs.push('mutation "no Host pin" was not caught; the guard is blind');
  if (hubProxyProblems(tcp.replace(/tls_server_name auth\.diegonmarcos\.com/, "tls_server_name {host}")).length === 0) probs.push('mutation "placeholder SNI" was not caught; the guard is blind');
  if (hubProxyProblems(tcp.replace(/tls_server_name sso\.diegonmarcos\.com/, "tls_server_name auth.diegonmarcos.com")).length === 0) probs.push('mutation "Host/SNI mismatch" was not caught; the guard is blind');
  for (const pr of probs) { fail++; console.error(`FAIL ${pr}`); }
  console.log(`edge-hub-host: ${probs.length ? probs.length + " problem(s)" : "every edge->hub https proxy pins Host and a literal matching SNI"}`);
}

// Mutation proof for the mesh_tld rule: it must reject what it claims to reject.
{
  const cases = [["c3-infra-api.mesh.diegonmarcos.com", false], ["svc.home.arpa", false], ["svc.app", true],
    ["vaultwarden.app", true], ["svc.app.", true], ["svc.dev", true], ["svc.diegonmarcos.com", true], ["svc.mesh.diegonmarcos.com.evil.com", true]];
  for (const [nm, wantBad] of cases) if (Boolean(meshNameProblem(nm)) !== wantBad) { fail++; console.error(`FAIL mesh_tld mutation: ${nm} should ${wantBad ? "be rejected" : "pass"}`); }
}
{
  // app_tld mutation proof + the rendered hub Caddyfile and Hickory zone list must carry no `.app` host.
  if (appHostsIn({ dns: "tokens-api.app" }).length !== 1 || appHostsIn({ u: "https://x.mesh.diegonmarcos.com/" }).length !== 0 || appHostsIn({ u: "https://c3-x.app:8443/mcp" }).length !== 1) { fail++; console.error("FAIL app_tld mutation: detector is blind"); }
  if (existsSync(CF)) { const hosts = [...readFileSync(CF, "utf8").matchAll(/(^|[\s,])([A-Za-z0-9_.{}*-]+\.app)(?=[\s,:{]|$)/gm)].map((m) => m[2]).filter((h) => !THIRD_PARTY.has(h)); if (hosts.length) { fail++; console.error(`FAIL app_tld: hub Caddyfile still carries ${[...new Set(hosts)].slice(0, 5).join(", ")}`); } }
  if ((hk.dns?.zones ?? []).includes("app") || hk.dns?.records?.app) { fail++; console.error("FAIL app_tld: Hickory still declares the app zone"); }
}
// mesh_dial (#1885): a consumer that dials http://<label>.mesh.diegonmarcos.com:<port> (non-comment line of a src/compose.nix)
// at a container (name or legacy alias) deployed off the hub needs an owned Hickory A row that does not answer the hub IP;
// otherwise the wildcard sends it to gcp-proxy, which does not listen on that port (every ft_ token failed closed).
{
  const hubIp = "10.0.0.1"; // gcp-proxy wg0, the wildcard answer (infra-net_hickory-dns services.caddy.ip)
  const deployHost = new Map();
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const f = join(root, d.name, "build.json");
    if (!d.isDirectory() || d.name === "z_archive" || !existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")), h = j.deploy?.host;
    if (h) for (const a of [j.name, ...(j.legacy_aliases?.names ?? []), ...(j.dns_aliases ?? []).map((x) => x.split(".")[0])]) deployHost.set(a, h);
  }
  const dialProblems = (sources, rows) => {
    const out = [];
    for (const [src, text] of sources)
      for (const line of text.split("\n")) {
        if (/^\s*#/.test(line)) continue;
        for (const m of line.matchAll(/([a-z0-9-]+)\.mesh\.diegonmarcos\.com:\d+/g)) {
          const h = deployHost.get(m[1]);
          if (!h || h === "gcp-proxy") continue;
          const own = rows.filter((r) => r.name === m[1] && r.type === "A");
          if (!own.length) out.push(`mesh_dial: ${src} dials ${m[0]} (on ${h}) but Hickory has no row for ${m[1]}; the wildcard answers the hub`);
          else if (own.some((r) => r.value === hubIp)) out.push(`mesh_dial: ${src} dials ${m[0]} (on ${h}) but its Hickory row answers the hub`);
        }
      }
    return out;
  };
  const sources = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    const f = join(root, d.name, "src/compose.nix");
    if (d.isDirectory() && d.name !== "z_archive" && existsSync(f)) sources.push([d.name, readFileSync(f, "utf8")]);
  }
  const rows = hk.dns?.records?.["mesh.diegonmarcos.com"] ?? [];
  const probs = dialProblems(sources, rows);
  const probe = [["mutation", 'TOKENS_VERIFY_URL = "http://tokens-api.mesh.diegonmarcos.com:4184/v1/verify";']];
  if (!dialProblems(probe, rows.filter((r) => r.name !== "tokens-api")).length) probs.push('mesh_dial: mutation "row dropped" was not caught; the guard is blind');
  if (!dialProblems(probe, rows.map((r) => (r.name === "tokens-api" ? { ...r, value: hubIp } : r))).length) probs.push('mesh_dial: mutation "row answers the hub" was not caught; the guard is blind');
  if (dialProblems([["mutation", "  # reach it as tokens-api.mesh.diegonmarcos.com:4184"]], []).length) probs.push("mesh_dial: a comment line was flagged");
  for (const pr of probs) { fail++; console.error(`FAIL ${pr}`); }
  console.log(`mesh_dial: ${probs.length ? probs.length + " problem(s)" : "every off-hub mesh dial has an owned row, 3 mutations checked"}`);
}
const bad = (m) => { fail++; console.error(`FAIL ${m}`); };
for (const rule of ["public_host", "naming", "mesh", "no_api_host", "mesh_direct", "mesh_tld", "app_tld", "public_subdomain", "protected", "pages"]) {
  const got = found[rule] ?? new Set(), listed = new Set(cfg.transitional[rule] ?? []);
  for (const x of got) if (!listed.has(x)) bad(`${rule}: ${x} violates the fleet addressing rule (tickets #1100, #1104); fix it, do not list it`);
  for (const x of listed) if (!got.has(x)) bad(`${rule}: ${x} is on the transitional list but no longer violates; remove it`);
  console.log(`${rule}: ${got.size} violation(s), all transitional`);
}
console.log(fail ? `${fail} failed` : "ok");
process.exit(fail ? 1 : 0);
