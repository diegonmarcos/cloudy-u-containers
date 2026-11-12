// test-cloud-me-api.mjs — contract, file gate, auth and end-to-end proof for
// cloud-me-api (#1079). No network and no npm: real git on local bare repos,
// stub JWKS/Authelia servers, the real index.mjs as a child process.
//
//   node test-cloud-me-api.mjs
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntime } from './code/contract.mjs';
import { buildTable } from './code/router.mjs';
import { cleanPath, makeGate, redactSecrets } from './code/store.mjs';
import { decideAuth, decideSession } from './code/authz.mjs';
import { normalize as acNormalize, empty as acEmpty, PAGES as AC_PAGES, MAX_PER_PAGE as AC_MAX } from './code/autocomplete.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build.json');
let pass = 0; let failN = 0;
const ok = (c, m) => { if (c) { pass++; } else { failN++; console.error(`FAIL ${m}`); } };
const throws = (fn, re, m) => { try { fn(); ok(false, `${m} (did not throw)`); } catch (e) { ok(re.test(String(e.message)), `${m} (got: ${e.message})`); } };
const raw = JSON.parse(readFileSync(BUILD, 'utf8'));
const DENY = new RegExp(raw.runtime.files.deny_content, 'im');
const clone = () => JSON.parse(JSON.stringify(raw));

// ── 1. contract ────────────────────────────────────────────────────────────
const RT = loadRuntime(BUILD);
ok(RT.repos.list.length >= 1, 'declares repos');
ok(RT.endpoints.filter((e) => e.auth === 'none').map((e) => e.path).join() === '/me/health', 'only /me/health is unauthenticated');
ok(!RT.repos.list.some((r) => /vault/i.test(r.name + r.ssh)), 'a vault repo is never declared');
ok(raw.dns === 'cloud-me-api.mesh.diegonmarcos.com' && !raw.domain && !raw.proxy && !raw.containers.app.proxy && raw.containers.app.public === true, 'mesh address only: dns cloud-me-api.mesh.diegonmarcos.com (container public:true = a mesh .app route), no public domain or edge proxy route');
ok(!JSON.stringify(raw).includes('wg_only'), 'WG-only is the fleet default, never overridden here');
for (const [n, d] of Object.entries(raw.runtime.datasets)) if (!n.startsWith('_')) ok(d.builtin && existsSync(join(HERE, 'code', d.builtin)), `dataset ${n} is a builtin file that exists`);
try { execFileSync(process.execPath, [join(HERE, 'gen-c3-datasets.mjs'), '--check'], { stdio: 'pipe' }); ok(true, ''); } catch (e) { ok(false, `datasets are stale: ${e.stderr}`); }
{ const d = clone(); delete d.runtime.files; // the filter's own regexes legitimately name key markers
  ok(!JSON.stringify(d).match(/BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20}|github_pat_/), 'no secret material in build.json'); }

const mutate = (fn) => { const d = clone(); fn(d); const p = join(tmp(), 'b.json'); writeFileSync(p, JSON.stringify(d)); return p; };
let TMP; const tmp = () => (TMP ||= mkdtempSync(join(tmpdir(), 'cme-test-')));
throws(() => loadRuntime(mutate((d) => d.runtime.repos.list.push({ name: 'cloud-me_vault', ssh: 'git@github.com:diegonmarcos/cloud-me_vault.git', branch: 'main', key_env: 'CME_KEY_VAULT_B64' }))), /vault/, 'vault repo rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.endpoints[2].auth = 'none'; })), /only .* may be unauthenticated/, 'open /me/repos rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.repos.list[0].ssh = 'https://github.com/diegonmarcos/cloud-me-containers.git'; })), /deploy-key transport only/, 'token-over-https transport rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.datasets['x-repo'] = { repo: 'nope', path: 'a.json' }; })), /not declared/, 'dataset on undeclared repo rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.cors.origins.push('https://*.example.com'); })), /cors/, 'wildcard CORS origin rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.files.deny_content = '['; })), /./, 'bad filter regex stops the service');
throws(() => buildTable(RT, {}), /no handler/, 'declared route without handler throws');
throws(() => buildTable(RT, Object.fromEntries([...RT.endpoints.map((e) => [e.path, () => {}]), ['/me/extra', () => {}]])), /not declared/, 'undeclared handler throws');

// #1103 the Autocomplete route: declared, authenticated, on a declared repo, with its own normaliser
ok(RT.endpoints.some((e) => e.method === 'GET' && e.path === '/me/autocomplete' && e.auth === 'authelia'), '/me/autocomplete is declared and authenticated');
ok(RT.autocomplete?.repo === 'cloud-me_configs' && RT.autocomplete.path === 'autocomplete.json', 'the personal file is declared (repo and path)');
throws(() => loadRuntime(mutate((d) => { d.runtime.autocomplete.repo = 'nope'; })), /autocomplete: repo/, 'autocomplete file on an undeclared repo rejected');
throws(() => loadRuntime(mutate((d) => { d.runtime.autocomplete.path = 'a.yaml'; })), /autocomplete: path/, 'autocomplete file must be JSON');
throws(() => loadRuntime(mutate((d) => { delete d.runtime.autocomplete; })), /names no file/, 'a declared /autocomplete route without its file is rejected');
{ const n = acNormalize(JSON.stringify({ ids: [{ label: ' DNI ', value: 'X1' }, { label: 'blank', value: '  ' }, { label: 'n', value: 5 }, 7],
    secrets: [{ label: 'wifi', value: 'pw' }], passwords: [{ label: 'x', value: 'y' }], urls: 'nope' }));
  ok(n.v === 1 && AC_PAGES.every((p) => Array.isArray(n[p])) && Object.keys(n).length === 1 + AC_PAGES.length, 'normalize keeps exactly the four pages');
  ok(n.ids.length === 1 && n.ids[0].label === 'DNI' && n.ids[0].value === 'X1' && n.urls.length === 0 && n.secrets[0].value === 'pw', 'normalize drops blanks, non-strings and unknown pages, trims labels');
  const big = acNormalize(JSON.stringify({ ids: Array.from({ length: AC_MAX + 50 }, (_, i) => ({ label: `l${i}`, value: `v${i}` })) }));
  ok(big.ids.length === AC_MAX, 'normalize caps a page');
  ok(acNormalize('nonsense') === null && acNormalize('[1]') === null && acNormalize('null') === null, 'normalize refuses a non-object document');
  ok(JSON.stringify(acEmpty()) === JSON.stringify({ v: 1, ids: [], addresses: [], urls: [], secrets: [] }), 'the empty document has the four empty pages'); }

// ── 2. file gate ───────────────────────────────────────────────────────────
for (const bad of ['', '/etc/passwd', '../x.json', 'a/../../x.json', 'a\\b.json', 'a/b/', '.', 'a\0b.json', 'x'.repeat(301)]) {
  throws(() => cleanPath(bad), /path/, `cleanPath refuses ${JSON.stringify(bad).slice(0, 30)}`);
}
ok(cleanPath('c3/c3-mail.json') === 'c3/c3-mail.json', 'cleanPath keeps a clean path');
const gate = makeGate(RT.files);
const refuse = (fn) => { try { fn(); return null; } catch (e) { return e.code; } };
for (const p of ['tokens.json', 'a/secrets.yaml', 'a/.env.json', 'vault/x.json', '.git/config.txt', 'x/id_rsa.txt', 'a/credentials.json', 'k/prod.pem.txt', 'x.sh', 'x.png', 'a/secret-thing.json', 'a/private.md']) {
  ok(refuse(() => gate.checkPath(p)) === 'path_denied', `gate denies path ${p}`);
}
for (const p of ['c3/c3-mail.json', 'A_CONFIGS-USER/a0/build.json', 'README.md', 'x/y/service.yaml']) {
  ok(refuse(() => gate.checkPath(p)) === null, `gate allows path ${p}`);
}
const GHP = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
// Fixtures are assembled at runtime: a literal "password: ..." line in this file
// would (rightly) trip the repo's leak scan, and the scan is never weakened.
const J = (...p) => p.join('');
for (const [label, body] of [
  ['private key', J('-----BEGIN ', 'OPENSSH PRIVATE KEY-----\nabc\n')], ['rsa key', J('-----BEGIN ', 'RSA PRIVATE KEY-----')],
  ['gh token', `{"x":"${GHP}"}`], ['fine-grained pat', J('github', '_pat_', 'A'.repeat(30))],
  ['aws id', J('AK', 'IA', 'A'.repeat(16))], ['age key', J('AGE-SECRET', '-KEY-1ABC')],
  ['json password', J('{"db":{"pass', 'word":"', 'hunter2hunter2"}}')], ['json api_key', J('{"api', '_key": "', 'abcdef123456"}')],
  ['yaml token', J('github_', 'token: ', 'abcdefgh12345\n')], ['env style', J('SERVICE_', 'SECRET=', 'abcdefgh12345\n')],
  ['sops blob', J('k: ENC[', 'AES256_GCM,data:abc]')],
]) ok(refuse(() => gate.checkContent(body)) === 'secret_filtered', `gate filters content: ${label}`);
for (const body of ['{"domain":"example.org","relays":["mx1"],"spam":{"enabled":true}}', '# readme\nnothing here', J('token', '_url: ""\n'), J('{"pass', 'word":""}')]) {
  ok(refuse(() => gate.checkContent(body)) === null, `gate passes benign content ${body.slice(0, 24)}`);
}
ok(refuse(() => gate.checkSize(RT.files.max_bytes + 1)) === 'too_large', 'gate refuses oversize');
ok(redactSecrets('a SECRETVALUE1 b', ['SECRETVALUE1']) === 'a [REDACTED] b', 'redactSecrets replaces');
ok(redactSecrets('a abc b', ['abc']) === 'a abc b', 'redactSecrets ignores values under 8 chars');

// ── 3. authz decision ──────────────────────────────────────────────────────
ok((await decideAuth(undefined, async () => ({}), 's')).status === 401, 'no header -> 401');
ok((await decideAuth('Basic x', async () => ({}), 's')).status === 401, 'wrong scheme -> 401');
ok((await decideAuth('Bearer a.b.c', async () => ({ scp: ['x'] }), 's')).status === 403, 'missing scope -> 403');
ok((await decideAuth('Bearer a.b.c', async () => { const e = new Error('x'); e.code = 'jwks_unavailable'; throw e; }, 's')).status === 503, 'jwks outage -> 503');
ok((await decideSession('c=1', async () => 'other@x', ['me@x'])).status === 403, 'undeclared session user -> 403');

// ── 4. end to end: the real index.mjs, real git, stub auth ────────────────
const T = tmp();
const sh = (args, cwd) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
const REMOTES = join(T, 'remotes'); mkdirSync(REMOTES);
function mkRepo(name, files, links = {}) {
  const work = join(T, `work-${name}`); mkdirSync(work);
  sh(['init', '-q', '-b', 'main'], work);
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(work, p)), { recursive: true }); writeFileSync(join(work, p), c); }
  for (const [p, target] of Object.entries(links)) symlinkSync(target, join(work, p));
  sh(['add', '-A'], work); sh(['commit', '-q', '-m', 'seed'], work);
  sh(['clone', '-q', '--bare', work, join(REMOTES, name)], T);
}
const KEYVAL = 'PLANTEDKEYVALUE-0123456789abcdef';
mkRepo('cloud-me-containers', {
  'c3/c3-mail.json': JSON.stringify({ domain: 'live.example', relays: ['mx9'] }),
  'c3/c3-mcp-apis.json': JSON.stringify({ leaked: GHP }),
  'tokens.json': '{"a":1}',
  'notes/readme.md': `hello ${KEYVAL} world\n`,
  'notes/creds.yaml': J('pass', 'word: ', 'abcdefgh1234\n'),
}, { 'notes/escape.md': '/etc/hostname' });
const PERSONAL = { ids: [{ label: 'National ID', value: 'X0000000T' }], addresses: [{ label: 'Home', value: '1 Example Street, Sampletown' }],
  urls: [{ label: 'Site', value: 'https://example.org' }], secrets: [{ label: 'Wi-Fi', value: J('fake-', 'passphrase-1234') }, { label: 'blank', value: '' }],
  passwords: [{ label: 'dropped', value: 'zzzzzzzz' }] };
mkRepo('cloud-me_configs', { 'x/build.json': '{"ok":true}', 'autocomplete.json': JSON.stringify(PERSONAL) });
mkRepo('cloud-me_cgc', { 'README.md': '# cgc\n' });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };
const b64u = (b) => Buffer.from(b).toString('base64url');
const jwt = (claims, kid = 'k1') => {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid })); const p = b64u(JSON.stringify(claims));
  return `${h}.${p}.${b64u(createSign('RSA-SHA256').update(`${h}.${p}`).sign(privateKey))}`;
};
const now = Math.floor(Date.now() / 1000);
const good = jwt({ iss: RT.authelia.issuer, exp: now + 600, scp: [RT.authelia.required_scope] });
const noScope = jwt({ iss: RT.authelia.issuer, exp: now + 600, scp: ['other'] });
const expired = jwt({ iss: RT.authelia.issuer, exp: now - 10, scp: [RT.authelia.required_scope] });
const wrongIss = jwt({ iss: 'https://evil.example', exp: now + 600, scp: [RT.authelia.required_scope] });

const stub = createServer((req, res) => {
  if (req.url === '/jwks.json') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [jwk] })); }
  if (req.url.startsWith('/auth-request')) {
    const c = req.headers.cookie || '';
    if (c.includes('authelia_session=me')) { res.writeHead(200, { 'remote-user': 'me@diegonmarcos.com' }); return res.end(); }
    if (c.includes('authelia_session=other')) { res.writeHead(200, { 'remote-user': 'other@x.com' }); return res.end(); }
    res.writeHead(401); return res.end();
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const SP = stub.address().port;
// A port the kernel just handed out and released: a random pick in 20000-40000 collided with the
// ephemeral range (EADDRINUSE on a busy runner).
const PORT = await new Promise((r, j) => { const s = createServer(); s.on('error', j); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// The e2e server keeps the repo-backed dataset path covered (leak filter, absent file) under the
// old names and serves the REAL builtin datasets next to them as real-<name>.
const E2E_BUILD = join(T, 'e2e-build.json');
{ const d = JSON.parse(JSON.stringify(raw)); const ds = d.runtime.datasets;
  for (const k of Object.keys(ds)) if (ds[k].builtin) { ds['real-' + k.slice(3)] = ds[k]; ds[k] = { repo: 'cloud-me-containers', path: `c3/${k}.json` }; }
  writeFileSync(E2E_BUILD, JSON.stringify(d)); }
const child = spawn(process.execPath, [join(HERE, 'code', 'index.mjs')], {
  env: {
    PATH: process.env.PATH, BUILD_JSON_PATH: E2E_BUILD, PORT: String(PORT), BIND_HOST: '127.0.0.1',
    JWKS_URL: `http://127.0.0.1:${SP}/jwks.json`, AUTHELIA_VERIFY_URL: `http://127.0.0.1:${SP}/auth-request`,
    CME_DATA_DIR: join(T, 'data'), CME_KEY_DIR: join(T, 'keys'), CME_URL_OVERRIDE_DIR: REMOTES,
    CME_KEY_CONTAINERS_B64: Buffer.from(KEYVAL).toString('base64'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
const get = async (path, headers = {}, method = 'GET') => {
  const r = await fetch(base + path, { method, headers, redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, h: r.headers };
};
const bearer = (t) => ({ authorization: `Bearer ${t}` });
let up = false;
for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(`${base}/health`)).status === 200; } catch { await new Promise((r) => setTimeout(r, 100)); } }
ok(up, `server comes up\n${log}`);
let synced = false;
for (let i = 0; i < 100 && !synced; i++) {
  const r = await get('/repos', bearer(good));
  synced = r.json?.repos?.length === 3 && r.json.repos.every((x) => x.ok);
  if (!synced) await new Promise((r2) => setTimeout(r2, 100));
}
ok(synced, `all repos sync over git\n${log}`);

try {
  ok((await get('/health')).json?.service === 'cloud-me-api', 'health is open');
  const h = await get('/health'); ok(!/repo|commit|diegonmarcos/i.test(h.text), 'health reveals nothing about the repos');
  for (const p of ['/endpoints', '/repos', '/config/c3-mail', '/repos/cloud-me-containers/file?path=README.md']) {
    ok((await get(p)).status === 401, `no credential -> 401 on ${p}`);
  }
  ok((await get('/config/c3-mail', bearer('garbage'))).status === 401, 'garbage bearer -> 401');
  ok((await get('/config/c3-mail', bearer(expired))).status === 401, 'expired bearer -> 401');
  ok((await get('/config/c3-mail', bearer(wrongIss))).status === 401, 'wrong issuer -> 401');
  ok((await get('/config/c3-mail', bearer(noScope))).status === 403, 'missing scope -> 403');
  ok((await get('/config/c3-mail', { authorization: 'Bearer ' + good, cookie: 'authelia_session=me' })).status === 200, 'bearer wins when both present');
  ok((await get('/config/c3-mail', { authorization: 'Bearer garbage', cookie: 'authelia_session=me' })).status === 401, 'bad bearer is never retried as a cookie');

  const ok1 = await get('/config/c3-mail', bearer(good));
  ok(ok1.status === 200 && ok1.json?.domain === 'live.example', 'dataset served to a valid bearer');
  ok(/^[0-9a-f]{12}$/.test(ok1.h.get('x-source-commit') || ''), 'dataset carries the source commit');
  ok((await get('/config/c3-mail', { cookie: 'authelia_session=me' })).status === 200, 'dataset served to the declared Authelia session');
  ok((await get('/config/c3-mail', { cookie: 'authelia_session=other' })).status === 403, 'other session user -> 403');
  ok((await get('/config/c3-mail', { cookie: 'authelia_session=dead' })).status === 401, 'dead session -> 401');
  ok((await get('/config/nope', bearer(good))).status === 404, 'unknown dataset -> 404');
  ok((await get('/config/_doc', bearer(good))).status === 404, 'dataset _doc key is not a dataset');
  const leak = await get('/config/c3-mcp-apis', bearer(good));
  ok(leak.status === 403 && leak.json?.code === 'secret_filtered' && !leak.text.includes(GHP), 'dataset holding a token is refused, never sent');
  const miss = await get('/config/c3-dns-routing', bearer(good));
  ok(miss.status === 404 && miss.json?.code === 'not_found', 'declared dataset whose file is absent -> 404 not_found');

  // real fleet config, generated from build.json (gen-c3-datasets.mjs): served as-is, never a placeholder
  const real = {};
  for (const n of ['mail', 'security-network', 'dns-routing', 'observability', 'mcp-apis']) {
    const r = await get(`/config/real-${n}`, bearer(good)); real[n] = r;
    ok(r.status === 200 && r.json?.dataset === `c3-${n}` && r.json.count >= 5 && r.json.services.every((x) => x.service && x.description), `real dataset c3-${n} served with real services`);
    ok(r.h.get('x-source-commit') === 'builtin', `c3-${n} is builtin`);
    ok(!/example\.org|\bmx[12]\b|live\.example/i.test(r.text), `c3-${n} holds no placeholder values`);
    ok(!DENY.test(r.text) && !r.text.includes(GHP), `c3-${n} has no secret-looking content`);
  }
  ok(real['dns-routing'].json.route_table.length > 20 && real['dns-routing'].json.mesh_names.some((m) => m.dns === 'cloud-me-api.mesh.diegonmarcos.com'), 'dns-routing lists the route table and the cloud-me-api mesh name');
  ok(!real['dns-routing'].json.route_table.some((r) => r.service === 'infra-api_cloud-me-api'), 'cloud-me-api has no public route in the table');
  ok(real['security-network'].json.public_services.length > 0 && !real['security-network'].json.public_services.some((x) => /NOT allowlisted/.test(x.exposure)), 'security-network: every public service is allowlisted or pending review');
  ok(real['mcp-apis'].json.services.some((x) => x.mcp?.transport) && real['mail'].json.services.some((x) => x.dns === 'stalwart.mesh.diegonmarcos.com'), 'mcp-apis and mail carry real service data');

  const F = (p, repo = 'cloud-me-containers') => get(`/repos/${repo}/file?path=${encodeURIComponent(p)}`, bearer(good));
  ok((await F('x.json', 'cloud-me_vault')).json?.code === 'repo_not_declared', 'vault repo -> repo_not_declared');
  ok((await F('x.json', 'unknown')).status === 403, 'unknown repo -> 403');
  ok((await F('../etc/hostname')).status === 400, 'traversal -> 400');
  ok((await F('/etc/hostname')).status === 400, 'absolute path -> 400');
  ok((await get('/repos/cloud-me-containers/file', bearer(good))).status === 400, 'missing path -> 400');
  ok((await F('tokens.json')).json?.code === 'path_denied', 'tokens.json -> path_denied');
  ok((await F('.git/config')).status === 403, '.git -> 403');
  ok((await F('notes/creds.yaml')).json?.code === 'path_denied', 'creds file -> path_denied');
  ok((await F('notes/escape.md')).status === 403 || (await F('notes/escape.md')).status === 404, 'symlink out of the repo is not followed');
  const esc = await F('notes/escape.md'); ok(!esc.text.includes(readFileSync('/etc/hostname', 'utf8').trim() || 'zzzz-none'), 'symlink target content never served');
  const rd = await F('notes/readme.md');
  ok(rd.status === 200 && rd.text.includes('[REDACTED]') && !rd.text.includes(KEYVAL), 'a held key value is redacted from file output');
  ok((await F('c3/c3-mail.json')).status === 200, 'allowed file served');
  ok((await F('x/build.json', 'cloud-me_configs')).status === 200, 'second repo served');
  ok((await F('nonexistent.md')).status === 404, 'missing file -> 404');

  const ep = await get('/endpoints', bearer(good));
  ok(ep.status === 200 && !/git@github|CME_KEY_|ssh-ed25519|"deny_content"|"deny_path"|"key_env"/.test(ep.text), 'endpoints discloses no transport or filter detail');
  const rp = await get('/repos', bearer(good));
  ok(!/git@github|CME_KEY|\/data|keys/.test(rp.text), 'repos discloses no transport or path');
  ok((await get('/nope', bearer(good))).status === 404, 'unknown route -> 404 JSON');
  ok((await get('/config/c3-mail', bearer(good), 'POST')).status === 405, 'POST -> 405 (read-only)');
  ok((await get('/config/c3-mail', bearer(good), 'PUT')).status === 405, 'PUT -> 405');

  // #1103 /autocomplete: authenticated, the four pages only, personal values served, and ONLY here
  ok((await get('/autocomplete')).status === 401, 'autocomplete: no credential -> 401');
  ok((await get('/autocomplete', bearer(noScope))).status === 403, 'autocomplete: missing scope -> 403');
  const acr = await get('/autocomplete', bearer(good));
  ok(acr.status === 200 && acr.json?.v === 1 && acr.json.ids[0].value === 'X0000000T' && acr.json.addresses.length === 1 && acr.json.urls.length === 1, 'autocomplete: rows served to a valid bearer');
  ok(acr.json.secrets.length === 1 && acr.json.secrets[0].value.includes('passphrase') && acr.json.passwords === undefined, 'autocomplete: secrets page served, blanks and unknown pages dropped');
  ok(acr.h.get('cache-control') === 'no-store' && /^[0-9a-f]{12}$/.test(acr.h.get('x-source-commit') || ''), 'autocomplete: no-store and the source commit');
  ok((await get('/autocomplete', { cookie: 'authelia_session=me' })).status === 200, 'autocomplete: served to the declared Authelia session');
  ok((await get('/autocomplete', { cookie: 'authelia_session=other' })).status === 403, 'autocomplete: other session user -> 403');
  ok((await get('/autocomplete', bearer(good), 'POST')).status === 405, 'autocomplete: POST -> 405');
  ok((await F('autocomplete.json', 'cloud-me_configs')).json?.code === 'path_denied', 'autocomplete: the file is not reachable through the generic file route');
  ok(!(await get('/endpoints', bearer(good))).text.includes('fake-'), 'autocomplete: no row value in the contract');

  // the same routes under the base path, as the mesh site and c3-pvt/cloud-me-api (#1104) pass them through
  ok((await get('/me/autocomplete', bearer(good))).json?.ids?.[0]?.value === 'X0000000T', 'autocomplete: also served under /me (mesh and private tier paths)');
  ok((await get('/me/autocomplete')).status === 401 && (await get('/me/health')).status === 200, 'autocomplete: /me/... keeps the same auth, /me/health is open');
  ok((await get('/me/config/c3-mail', bearer(good))).status === 200, 'existing routes also answer under /me');

  // CORS
  const pf = (origin) => get('/config/c3-mail', { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }, 'OPTIONS');
  const a = await pf('https://c3-mail.diegonmarcos.com');
  ok(a.status === 204 && a.h.get('access-control-allow-origin') === 'https://c3-mail.diegonmarcos.com', 'preflight echoes a declared-suffix origin');
  ok(/authorization/i.test(a.h.get('access-control-allow-headers') || '') && a.h.get('access-control-allow-credentials') === null, 'preflight allows Authorization, never credentials');
  ok((await pf('https://diegonmarcos.github.io')).status === 204, 'preflight allows the declared exact origin');
  for (const evil of ['https://evil.example', 'https://evil-diegonmarcos.com', 'https://x.diegonmarcos.com.evil.io', 'http://c3-mail.diegonmarcos.com', 'null']) {
    ok((await pf(evil)).status === 403, `preflight refuses ${evil}`);
  }
  const g = await get('/config/c3-mail', { ...bearer(good), origin: 'https://evil.example' });
  ok(g.status === 200 && g.h.get('access-control-allow-origin') === null, 'a non-declared origin gets no ACAO (browser blocks the read)');
  const g2 = await get('/config/c3-mail', { ...bearer(good), origin: 'https://c3-mail.diegonmarcos.com' });
  ok(g2.h.get('access-control-allow-origin') === 'https://c3-mail.diegonmarcos.com', 'GET echoes a declared origin');
  const g3 = await get('/config/c3-mail', { origin: 'https://c3-mail.diegonmarcos.com' });
  ok(g3.status === 401 && g3.h.get('access-control-allow-origin') === 'https://c3-mail.diegonmarcos.com', 'the 401 is readable by the declared origin (page can fall back to mock)');

  // nothing ever echoed a held secret
  ok(!log.includes(KEYVAL), 'server log never prints a held key');
} finally {
  child.kill('SIGTERM'); stub.close();
}
rmSync(T, { recursive: true, force: true });
console.log(`${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
