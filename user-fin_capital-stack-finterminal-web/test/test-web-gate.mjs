#!/usr/bin/env node
// test-web-gate.mjs — capital-stack-finterminal-web stays behind the c3-pvt gate (#1351, design 3.5), statically.
//   G1 no per-app public host: build.json declares no domain and no proxy domain; the container's only public address is the
//      c3-pvt route c3-pvt.diegonmarcos.com/<container> (the shared gate), so fleet-addressing.json names it in no redirect or pub sink
//   G2 the mesh name is in the mesh namespace (<container>.mesh.diegonmarcos.com) and the page base path is the c3-pvt route
//   G3 compose binds the WG IP only (never 0.0.0.0 or all interfaces), read-only, no secret, no volume
//   G4 the API it reads same-origin is a declared container of this repo
//   G5 the image ships the real FinTerm web build: a pinned cloudy-h-webapps-mob commit's FinTerm output, rebased to the base path, its API
//      base the same-origin c3-pvt route of the API container (never the mesh name, never a public host), and no placeholder page
// then plants a mutation per rule and requires RED for each.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const load = () => ({
  b: JSON.parse(readFileSync(join(APP, 'build.json'), 'utf8')),
  compose: readFileSync(join(APP, 'src', 'compose.nix'), 'utf8'),
  fa: JSON.parse(readFileSync(join(ROOT, '_shared', 'fleet-addressing.json'), 'utf8')),
});

function check({ b, compose, fa }) {
  const e = [];
  const name = b.name;
  if (b.domain || b.proxy?.primary?.domain || b.containers?.app?.proxy?.domain) e.push('G1 a per-app public host is declared');
  const fajson = JSON.stringify({ redirects: fa.tiers?.redirects ?? {}, pub: fa.tiers?.pub ?? {}, unprotected: fa.unprotected_hosts ?? [] });
  if (fajson.includes(name)) e.push('G1 fleet-addressing.json routes the web container outside the c3-pvt gate');
  if (b.dns !== `${name}.mesh.diegonmarcos.com` || b.containers?.app?.dns !== b.dns) e.push('G2 the mesh name is not <container>.mesh.diegonmarcos.com');
  if (b.finterm?.base_path !== `/${name}`) e.push('G2 the page base path is not the c3-pvt route /' + name);
  if (!/ports = \[ "\$\{self\.ip\}:/.test(compose) || /0\.0\.0\.0/.test(compose) || /network_mode\s*=\s*"host"/.test(compose)) e.push('G3 compose does not bind the WG IP only');
  if (!/read_only = true;/.test(compose) || b.containers?.app?.read_only !== true) e.push('G3 the container is not read-only');
  if (b.containers?.app?.env_file || (b.containers?.app?.volumes ?? []).length) e.push('G3 the static web container carries a secret or a volume');
  const api = b.finterm?.api_container;
  const apiDir = api && ['user-fin_', 'user-prod_', 'infra-api_'].map((p) => join(ROOT, p + api)).find((d) => existsSync(join(d, 'build.json')));
  if (!apiDir || JSON.parse(readFileSync(join(apiDir, 'build.json'), 'utf8')).name !== api) e.push('G4 the API container ' + api + ' is not declared in this repo');
  const run = (b.docker?.runtime_extra_run ?? []).join('\n');
  if (!/^[0-9a-f]{40}$/.test(b.finterm?.webapps_ref ?? '') || !run.includes(`cloudy-h-webapps-mob/tar.gz/${b.finterm?.webapps_ref}`)) e.push('G5 the FinTerm web build is not a pinned cloudy-h-webapps-mob commit');
  if (!run.includes('sites/cloudy-webapps/dist/capital-stack-finterminal/') || !run.includes('sites/cloudy-webapps/dist/_app/')) e.push('G5 the image does not ship the FinTerm pages and their _app bundle');
  if (!run.includes(`s#/cloud-webapps#${b.finterm?.base_path}#g`)) e.push('G5 the pages are not rebased to the base path');
  if (!run.includes(`s#https://${api}.mesh.diegonmarcos.com#/${api}#g`)) e.push('G5 the API base is not the same-origin route of the API container');
  if (/Gated FinTerm web\. Data:/.test(run)) e.push('G5 the placeholder page is still shipped');
  return e;
}

let fails = 0;
const ok = (m) => console.log('  PASS: ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fails++; };
console.log('[capital-stack-finterminal-web] behind the c3-pvt gate');
const real = check(load());
real.length ? (bad('the real tree is red'), real.forEach((x) => console.log('    ' + x))) : ok('G1-G5 hold on the real tree');
const mutant = (n, f, needle) => { const d = load(); f(d); const e = check(d); !e.length ? bad(`mutant '${n}' stayed green`) : e.some((x) => x.startsWith(needle)) ? ok(`mutant '${n}' is red (${needle})`) : bad(`mutant '${n}' red for the wrong reason: ${e.join('; ')}`); };
mutant('a public subdomain', (d) => { d.b.domain = 'finterm.diegonmarcos.com'; }, 'G1');
mutant('a redirect around the gate', (d) => { d.fa.tiers.redirects['finterm.diegonmarcos.com'] = 'https://x/capital-stack-finterminal-web'; }, 'G1');
mutant('a mesh name on a public TLD', (d) => { d.b.dns = 'capital-stack-finterminal-web.diegonmarcos.com'; }, 'G2');
mutant('a base path that is not the route', (d) => { d.b.finterm.base_path = '/finterm'; }, 'G2');
mutant('bound on every interface', (d) => { d.compose = d.compose.replace('"${self.ip}:', '"0.0.0.0:'); }, 'G3');
mutant('host network', (d) => { d.compose = d.compose.replace('read_only = true;', 'read_only = true; network_mode = "host";'); }, 'G3');
mutant('writable', (d) => { d.compose = d.compose.replace('read_only = true;', ''); }, 'G3');
mutant('a secret in the static container', (d) => { d.b.containers.app.env_file = true; }, 'G3');
mutant('an undeclared API', (d) => { d.b.finterm.api_container = 'nope-api'; }, 'G4');
mutant('an unpinned web build', (d) => { d.b.finterm.webapps_ref = 'main'; }, 'G5');
mutant('the API read on the mesh name', (d) => { d.b.docker.runtime_extra_run = d.b.docker.runtime_extra_run.map((x) => x.replace('#/capital-stack-finterm-api#g', '#https://capital-stack-finterm-api.mesh.diegonmarcos.com#g')); }, 'G5');
mutant('the placeholder is back', (d) => { d.b.docker.runtime_extra_run.push("printf '<p>Gated FinTerm web. Data: /x</p>' > /usr/share/nginx/html/index.html"); }, 'G5');
console.log(fails ? `${fails} FAILED` : 'ALL GREEN');
process.exit(fails ? 1 : 0);
