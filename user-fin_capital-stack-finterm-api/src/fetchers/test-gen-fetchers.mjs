#!/usr/bin/env node
// test-gen-fetchers.mjs — the FinTerm job generator and its Rust counterpart, statically (#1351). No network, no cargo.
//   F1 the committed fetchers.json is a fresh render of the declarations (drift)
//   F2 every job's connector is one finterm/normalise.rs implements, and the two connector lists are the same set
//   F3 no provider address is typed in the Rust (finterm/*.rs): every endpoint comes from fetchers.json
//   F6 every symbol an APK table reads on the store route (/v1/history) is resolved to a store series or declared unavailable with a reason
//   F5 every universe.json format is one finterm/store.rs parses, and the two format lists are the same set
//   F4 the generator refuses a contradiction: a keyed source as a job, a rate budget exceeded, a /v1 path outside v1, an unknown source
// then plants a mutation per rule and requires RED for each.
//   node test-gen-fetchers.mjs --android <cloudy-u-android checkout>
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildFetchers, CONTAINER_CONNECTORS, STORE_FORMATS, OUT, APP } from './gen-fetchers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = join(HERE, '..', 'code', 'crates', 'server', 'src', 'finterm');
const a = process.argv.slice(2);
const li = a.indexOf('--android');
const local = li >= 0 ? resolve(a[li + 1]) : process.env.CLOUD_U_ANDROID || '';
const read = (n) => local ? readFileSync(join(local, APP, 'data', n), 'utf8')
  : execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/diegonmarcos/cloudy-u-android/contents/${APP}/data/${n}?ref=main`]).toString('utf8');
const decl = () => ({ sources: JSON.parse(read('sources.json')), dashboards: JSON.parse(read('dashboards.json')), centralBanks: JSON.parse(read('central-banks.json')), universe: JSON.parse(read('universe.json')), declarationSha: 'x' });

let fails = 0;
const ok = (m) => console.log('  PASS: ' + m);
const bad = (m) => { console.log('  FAIL: ' + m); fails++; };

function check({ d = decl(), committed = readFileSync(OUT, 'utf8'), rust = Object.fromEntries(readdirSync(RS).map((f) => [f, readFileSync(join(RS, f), 'utf8')])), sha } = {}) {
  const errs = [];
  let doc;
  try { doc = buildFetchers(d); } catch (e) { return ['F4 ' + e.message]; }
  const cm = JSON.parse(committed);
  const fresh = { ...doc, declaration_sha: sha ?? cm.declaration_sha };
  if (JSON.stringify(fresh) !== JSON.stringify(cm)) errs.push('F1 fetchers.json differs from a fresh render');
  const rsList = [...(rust['normalise.rs'].match(/pub const CONNECTORS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
  const set = (x) => JSON.stringify([...new Set(x)].sort());
  if (set(rsList) !== set(CONTAINER_CONNECTORS)) errs.push('F2 normalise.rs CONNECTORS differ from gen-fetchers CONTAINER_CONNECTORS');
  for (const j of cm.jobs) if (!rsList.includes(j.connector)) errs.push(`F2 job ${j.id} connector ${j.connector} has no Rust parser`);
  for (const c of rsList) if (!new RegExp(`"${c}" =>`).test(rust['normalise.rs'])) errs.push(`F2 normalise::parse has no arm for ${c}`);
  const stList = [...(rust['store.rs']?.match(/pub const STORE_FORMATS: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/"(\w+)"/g)].map((m) => m[1]);
  if (set(stList) !== set(STORE_FORMATS)) errs.push('F5 store.rs STORE_FORMATS differ from gen-fetchers STORE_FORMATS');
  for (const c of stList) if (!new RegExp(`"${c}" =>`).test(rust['store.rs'])) errs.push(`F5 store::parse has no arm for ${c}`);
  for (const [f, t] of Object.entries(rust)) {
    const code = t.replace(/(?<!:)\/\/.*$/gm, '');
    for (const m of code.matchAll(/https?:\/\/[A-Za-z0-9.-]+\.[a-z]{2,}[^\s"']*/g)) if (!/^https:\/\/(h|h\.test)\b/.test(m[0]) && !m[0].includes('github.com/diegonmarcos')) errs.push(`F3 ${f} types the address ${m[0]}`);
  }
  return errs;
}

console.log('[capital-stack-finterminal-api] FinTerm fetch jobs');
const real = check();
real.length ? (bad('the real tree is red'), real.forEach((e) => console.log('    ' + e))) : ok('F1-F4 hold on the real tree');

function mutant(name, args, needle) {
  const errs = check(args);
  if (!errs.length) bad(`mutant '${name}' stayed green`);
  else if (errs.some((e) => e.includes(needle))) ok(`mutant '${name}' is red (${needle})`);
  else bad(`mutant '${name}' is red for the wrong reason: ${errs.join('; ')}`);
}
const clone = () => JSON.parse(JSON.stringify(decl()));
const rust = () => Object.fromEntries(readdirSync(RS).map((f) => [f, readFileSync(join(RS, f), 'utf8')]));
{ const c = JSON.parse(readFileSync(OUT, 'utf8')); c.jobs[0].ttl_s = 1; mutant('a committed job is edited by hand', { committed: JSON.stringify(c) }, 'F1'); }
{ const d = clone(); d.dashboards.dashboards.find((x) => x.id === 'crypto').panels[0].fetch.each.push('LTC-USD'); mutant('the declaration moves, the file does not', { d }, 'F1'); }
{ const r = rust(); r['normalise.rs'] = r['normalise.rs'].replace('"polymarket_events", ', ''); mutant('a connector loses its Rust parser', { rust: r }, 'F2'); }
{ const r = rust(); r['normalise.rs'] = r['normalise.rs'].replace('"bls_series" => bls(&json()),', ''); mutant('a parse arm is dropped', { rust: r }, 'F2 normalise::parse has no arm for bls_series'); }
{ const r = rust(); r['routes.rs'] += '\nconst X: &str = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";\n'; mutant('an address is typed in Rust', { rust: r }, 'F3'); }
{ const d = clone(); const s = d.sources.sources.find((x) => x.id === 'cboe'); s.auth = { type: 'free_key', key_in: { where: 'query', name: 'k' } }; mutant('a keyed source becomes a job', { d }, 'is keyed'); }
{ const d = clone(); d.sources.sources.find((x) => x.id === 'bls').schedule.ttl_s = 600; mutant('the BLS budget is exceeded', { d }, 'exceed bls'); }
{ const d = clone(); d.sources.sources.find((x) => x.id === 'cboe').rate_limit.per_min = 3; mutant('a per-minute budget is exceeded', { d }, '/min'); }
{ const d = clone(); d.dashboards.dashboards.find((x) => x.id === 'crypto').panels[0].fetch.primary.api = '/api/v1/quotes'; mutant('a /v1 path outside v1', { d }, 'is not under'); }
{ const d = clone(); d.dashboards.dashboards.find((x) => x.id === 'crypto').panels[0].source = 'nope'; mutant('an unknown source', { d }, 'unknown source nope'); }
{ const r = rust(); r['store.rs'] = r['store.rs'].replace('"valet" => ', '"valet_gone" => '); mutant('a store parse arm is dropped', { rust: r }, 'F5 store::parse has no arm for valet'); }
{ const d = clone(); d.universe.history.resolve['^NDX'].source = 'stooq'; mutant('a symbol names an undeclared source', { d }, 'unknown source stooq'); }
{ const d = clone(); d.dashboards.dashboards.find((x) => x.id === 'commodities').panels.find((p) => p.fetch?.primary?.api === '/v1/history').fetch.each.push('ZZ=F'); mutant('an APK table reads a symbol the store does not cover', { d }, 'neither resolves nor declares unavailable'); }
{ const d = clone(); delete d.universe.history.unavailable['KC=F']; mutant('an uncovered future loses its reason', { d }, 'KC=F'); }
{ const d = clone(); d.universe.curves.feeds[0].map.SR_10Y = 'curve:ZZ:10Y'; mutant('a curve cell outside the matrix', { d }, 'not a declared country x tenor'); }
{ const d = clone(); d.universe.history.years = 5; mutant('history shorter than 10 years', { d }, 'fewer than 10 years'); }
{ const d = clone(); d.universe.sources.boe.endpoint = 'http://insecure.example'; mutant('a plain-http store source', { d }, 'no https endpoint'); }
// #1416 the free stack
const fsrc = (d, id) => d.universe.free_stack.sources.find((s) => s.id === id);
{ const d = clone(); fsrc(d, 'sec_edgar').per_min = 1200; mutant('SEC paced over 10 a second', { d }, 'per_min budget in 1..600'); }
{ const d = clone(); fsrc(d, 'yahoo').flag.default = true; mutant('Yahoo on by default', { d }, 'flag must default off'); }
{ const d = clone(); fsrc(d, 'yahoo').flag.after = ['fred', 'cboe', 'coinbase']; mutant('Yahoo not the last fallback', { d }, 'after cboe,fred,coinbase'); }
{ const d = clone(); delete fsrc(d, 'fmp').key; mutant('FMP without its key', { d }, 'fmp must declare its key'); }
{ const d = clone(); delete fsrc(d, 'fmp').key.reason; mutant('a key without its needs-key reason', { d }, 'key needs env, slot, header and reason'); }
{ const d = clone(); fsrc(d, 'openfigi').format = 'figi_xml'; mutant('a free-stack format the store cannot parse', { d }, 'format figi_xml has no store parser'); }
{ const d = clone(); d.universe.free_stack.contact = 'https://example.org/me'; mutant('no contact address for the User-Agent', { d }, 'free_stack.contact is not a contact address'); }
console.log(fails ? `${fails} FAILED` : 'ALL GREEN');
process.exit(fails ? 1 : 0);
