#!/usr/bin/env node
// Tester for git-proxy-api (#647). Registered in build.json::tests, executed by
// .github/workflows/per-service-tests.yml -> .github/scripts/run-service-tests.sh
// on every push to main. An unrun tester is worth nothing (#368/#453/#486).
//
// It proves three things, and each one is written so that BREAKING the property
// turns it red — a green here that could not go red would be exactly the defect
// the fleet keeps rediscovering.
//
//   A. REFUSAL. An unauthenticated request is refused, asserted on the STATUS
//      *and* the BODY. Not a 200 with an error body (#568) and not a hang.
//   B. NO LEAK. The GitHub credential never appears in any response — checked
//      against a live server whose stubbed upstream deliberately echoes the
//      token back in an error body, which is the hardest case.
//   C. NO DRIFT. The served route table and build.json's declared contract are
//      the same set, in both directions (#371).
//   F. FEEDS. commits/runs refuse any repo not in runtime.feeds.repos without
//      dialling GitHub, are served from a TTL cache shared by concurrent
//      callers, never cache a failure, and never turn one into an empty 200.
//
// Zero dependencies and zero secrets: node:crypto mints a throwaway RSA keypair,
// this file serves its own JWKS and its own fake api.github.com, and the real
// index.mjs is booted as a child process against them. Nothing outside this
// service's own source can fail it (#254).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createSign, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideAuth, decideSession, scopesOf } from './code/authz.mjs';
import { loadRuntime, localPath } from './code/contract.mjs';
import { buildTable, match, toRegex } from './code/router.mjs';
import {
  redactSecrets, upstreamHeaders, reposUrl, tarballUrl, projectRepo, validName, validRef, REDACTED,
  gitUpstreamHeaders, gitUrl,
  repoDeclared, clampPerPage, feedUrl, projectCommit, projectRun,
  inCidr, isDirectMesh, validTag, validRange, releaseByTagUrl, releaseAssetUrl,
} from './code/upstream.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD_JSON = join(HERE, '..', 'build.json');
const RT = loadRuntime(BUILD_JSON);

// The sentinel stands in for the real GITHUB_TOKEN everywhere below. Shaped like
// a GitHub PAT so a substring match cannot pass by accident.
const FAKE_TOKEN = 'ghp_TESTSENTINEL0000000000000000000000';
const KID = 'test-kid';

let failures = 0;
let checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (cond) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n         ${detail}` : ''}`);
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

// ══ A. Refusal, as a pure decision — STATUS and BODY both asserted ═════════
async function testRefusal() {
  console.log('\nA. an unauthenticated request is REFUSED (status AND body)');

  const goodClaims = { iss: RT.authelia.issuer, scp: [RT.authelia.required_scope], sub: 'diego' };
  const accept = async () => goodClaims;
  const reject = async () => { throw new Error('bad signature'); };
  const jwksDown = async () => { const e = new Error('down'); e.code = 'jwks_unavailable'; throw e; };
  const SCOPE = RT.authelia.required_scope;

  const cases = [
    [undefined, accept, 401, 'missing_authorization'],
    ['', accept, 401, 'missing_authorization'],
    ['token abc', accept, 401, 'bad_scheme'],
    ['bearer abc', accept, 401, 'bad_scheme'],   // case-sensitive scheme
    ['Basic abc', accept, 401, 'bad_scheme'],
    ['Bearer ', accept, 401, 'empty_token'],
    ['Bearer aa bb', accept, 401, 'malformed_token'],
    ['Bearer abc', reject, 401, 'invalid_token'],
    ['Bearer abc', jwksDown, 503, 'jwks_unavailable'],
    ['Bearer abc', async () => ({ ...goodClaims, scp: ['some.other.scope'] }), 403, 'insufficient_scope'],
  ];

  for (const [header, verify, wantStatus, wantCode] of cases) {
    const d = await decideAuth(header, verify, SCOPE);
    const label = `${JSON.stringify(header)} -> ${wantStatus} ${wantCode}`;
    if (d.ok) { ok(false, label, 'decision was ok:true — the request was ACCEPTED'); continue; }
    ok(d.status === wantStatus && d.body.code === wantCode, label,
      `got ${d.status} ${d.body.code}`);
    // The #568 property, stated explicitly: a refusal is never 2xx, and it
    // always carries a machine-readable code the caller can branch on.
    ok(d.status >= 400, `${label}: status is NOT 2xx`, `got ${d.status}`);
    ok(typeof d.body.error === 'string' && d.body.error.length > 0,
      `${label}: body carries a human-readable error`);
  }

  const good = await decideAuth('Bearer abc', accept, SCOPE);
  ok(good.ok === true, 'a valid token with the required scope is ACCEPTED');

  eq(scopesOf({ scp: ['a', 'b'] }), ['a', 'b'], 'scopesOf reads the scp array');
  eq(scopesOf({ scp: 'a b' }), ['a', 'b'], 'scopesOf tolerates the scp string form');
  eq(scopesOf({ scope: 'a b' }), ['a', 'b'], 'scopesOf tolerates the scope string form');
  eq(scopesOf(null), [], 'scopesOf(null) is empty, never permissive');

  console.log('\nA2. an Authelia SESSION is judged by Authelia, then by the declared user list');
  const USERS = RT.authelia.session.users;
  const owner = async () => USERS[0];
  const stranger = async () => 'guest@example.invalid';
  const dead = async () => { throw new Error('401'); };
  const down = async () => { const e = new Error('down'); e.code = 'session_unavailable'; throw e; };
  for (const [cookie, verify, wantStatus, wantCode] of [
    [undefined, owner, 401, 'missing_authorization'],
    ['', owner, 401, 'missing_authorization'],
    ['authelia_session=x', dead, 401, 'invalid_session'],
    ['authelia_session=x', down, 503, 'session_unavailable'],
    ['authelia_session=x', stranger, 403, 'user_not_allowed'],
  ]) {
    const d = await decideSession(cookie, verify, USERS);
    ok(!d.ok && d.status === wantStatus && d.body.code === wantCode,
      `session ${JSON.stringify(cookie)} -> ${wantStatus} ${wantCode}`, `got ${JSON.stringify(d)}`);
  }
  const s = await decideSession('authelia_session=x', owner, USERS);
  ok(s.ok === true && s.user === USERS[0], 'a live session of a declared user is ACCEPTED');
  ok(!(await decideSession('authelia_session=x', owner, [])).ok, 'an empty user list admits NOBODY');
}

// ══ B. The GitHub token cannot reach a response ════════════════════════════
function testRedactionUnit() {
  console.log('\nB1. redactSecrets removes the credential from every body shape');

  const shapes = [
    FAKE_TOKEN,
    `Bearer ${FAKE_TOKEN}`,
    { error: `upstream said: Authorization: Bearer ${FAKE_TOKEN}`, code: 'upstream_error' },
    { nested: { deep: [FAKE_TOKEN] } },
    { url: `https://x:${FAKE_TOKEN}@github.com/a/b.git` },
  ];
  for (const s of shapes) {
    const out = redactSecrets(s, [FAKE_TOKEN]);
    ok(!out.includes(FAKE_TOKEN), `redacted: ${JSON.stringify(s).slice(0, 60)}`, `leaked in ${out}`);
    ok(out.includes(REDACTED), 'the redaction is visible, not silently dropped');
  }
  ok(!redactSecrets({ a: 1 }, [FAKE_TOKEN]).includes(REDACTED),
    'a clean body is left alone');
  // A short "secret" must not be redacted — it would turn every response into
  // placeholder soup and hide real content.
  ok(redactSecrets('abcdef', ['abc']) === 'abcdef',
    'secrets under 8 chars are ignored rather than mangling the body');

  console.log('\nB2. the credential is used ONLY as an outbound request header');
  const h = upstreamHeaders(FAKE_TOKEN);
  ok(h.authorization === `Bearer ${FAKE_TOKEN}`, 'upstreamHeaders carries the token');
  const g = gitUpstreamHeaders(FAKE_TOKEN, {
    authorization: 'Bearer fleet-jwt', cookie: 'authelia_session=s', 'git-protocol': 'version=2',
    'content-type': 'application/x-git-upload-pack-request', 'x-forwarded-for': '1.2.3.4',
  });
  ok(g.authorization === `Basic ${Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')}`,
    'gitUpstreamHeaders sends the token to GitHub as the Basic password');
  ok(!('cookie' in g) && !JSON.stringify(g).includes('fleet-jwt') && !('x-forwarded-for' in g),
    "gitUpstreamHeaders never forwards the caller's cookie, fleet bearer or other headers");
  ok(g['git-protocol'] === 'version=2' && g['content-type'] === 'application/x-git-upload-pack-request',
    'gitUpstreamHeaders keeps the git protocol headers');
  eq(gitUrl('https://github.com', 'o', 'r', 'info/refs?service=git-upload-pack'),
    'https://github.com/o/r.git/info/refs?service=git-upload-pack', 'gitUrl builds the smart-HTTP URL');
  for (const [name, fn] of [
    ['reposUrl', () => reposUrl('https://api.github.com', 1)],
    ['tarballUrl', () => tarballUrl('https://api.github.com', 'o', 'r', 'main')],
    ['projectRepo', () => JSON.stringify(projectRepo({ full_name: 'o/r', owner: { login: 'o' }, name: 'r', private: true, default_branch: 'main', updated_at: 'x', size: 1, token: FAKE_TOKEN }))],
  ]) {
    ok(!String(fn()).includes(FAKE_TOKEN), `${name} never embeds the token`);
  }
  // projectRepo is a projection, not a passthrough: an upstream field we never
  // asked for cannot ride along into our response.
  ok(projectRepo({ full_name: 'o/r', token: FAKE_TOKEN }).token === undefined,
    'projectRepo drops unknown upstream fields');

  console.log('\nB3. sendJson is the ONLY body writer, so redaction cannot be skipped');
  const src = readFileSync(join(HERE, 'code', 'index.mjs'), 'utf8');
  // Every JSON body goes through sendJson (which redacts). The only raw writes
  // permitted are the tarball stream's own pipe/writeHead and the destroy on an
  // already-committed response. A new `res.end(...)` or `res.write(...)` added
  // elsewhere would bypass redaction — so the count is pinned.
  const rawEnds = [...src.matchAll(/\bres\.end\s*\(/g)].length;
  const rawWrites = [...src.matchAll(/\bres\.write\s*\(/g)].length;
  ok(rawEnds === 1, 'exactly one res.end( in index.mjs (the one inside sendJson)', `found ${rawEnds}`);
  ok(rawWrites === 0, 'no bare res.write( in index.mjs — bodies go through sendJson', `found ${rawWrites}`);
  ok(/function sendJson\([^)]*\)\s*\{\s*const body = redactSecrets\(/.test(src),
    'sendJson redacts before it writes anything');
  ok(!/sendJson\([^)]*GITHUB_TOKEN/.test(src) && !/sendError\([^)]*GITHUB_TOKEN/.test(src),
    'no response call site passes GITHUB_TOKEN');
}

// ══ C. Served routes and declared contract are the same set ════════════════
function testContract() {
  console.log('\nC. the served route table matches build.json runtime.endpoints');

  const raw = JSON.parse(readFileSync(BUILD_JSON, 'utf8'));
  eq(raw.api.endpoint_count, RT.endpoints.length,
    'api.endpoint_count agrees with runtime.endpoints length');
  eq(raw.api.base_path, RT.base_path, 'api.base_path agrees with runtime.base_path');
  eq(raw.proxy.primary.base_path, RT.base_path,
    'proxy.primary.base_path agrees with runtime.base_path — the #371 class: a client dialling a prefix the service never deployed');
  eq(raw.containers.app.proxy.base_path, RT.base_path,
    'containers.app.proxy.base_path agrees too (it is the copy the deriver reads)');
  eq(raw.ports.app, raw.containers.app.port, 'ports.app agrees with containers.app.port');

  // Exactly one endpoint is unauthenticated, it is /git/health, and it is the
  // one declared in proxy public_paths. A future endpoint accidentally declared
  // auth:"none" turns this red.
  const open = RT.endpoints.filter((e) => e.auth === 'none').map((e) => e.path);
  eq(open, ['/git/health'], 'exactly one endpoint is pre-auth, and it is /git/health');
  eq(raw.proxy.primary.public_paths, open,
    'proxy public_paths is exactly the set of auth:none endpoints');
  eq(raw.containers.app.proxy.public_paths, open, 'the container proxy copy agrees');
  // #837 exactly one endpoint is `mesh` (credential-free ONLY on a direct wg0
  // dial), it is the release-asset mirror, and it is NOT a public_path, so the
  // edge's forward_auth still gates it off-mesh.
  const mesh = RT.endpoints.filter((e) => e.auth === 'mesh').map((e) => e.path);
  eq(mesh, ['/git/releases/:owner/:repo/:tag/assets/:name'], 'exactly one endpoint is auth:mesh, the release-asset mirror');
  ok(!raw.proxy.primary.public_paths.some((p) => p.startsWith('/git/releases')), 'the mesh route is not an edge public_path');
  eq(RT.mesh?.cidrs, ['10.0.0.0/24', 'fd0c:1d00::/64'], 'runtime.mesh.cidrs mirrors the Caddy wg_cidrs (both families)');
  for (const e of RT.endpoints.filter((x) => x.auth !== 'none' && x.auth !== 'mesh')) {
    ok(e.auth === 'authelia', `${e.path} requires authelia (bearer or session)`, `declares ${e.auth}`);
  }
  eq(raw.health.path, '/git/health', 'health.path is the pre-auth route');
  eq(raw.containers.app.healthcheck, localPath('/git/health', RT.base_path),
    'containers.app.healthcheck is the PREFIX-STRIPPED path the container actually serves');

  // buildTable is the drift gate: it throws in either direction. Prove both.
  const stub = {};
  for (const e of RT.endpoints) stub[e.path] = () => {};
  const table = buildTable(RT, stub);
  eq(table.length, RT.endpoints.length, 'buildTable accepts a complete handler set');

  const missing = { ...stub };
  delete missing[RT.endpoints[0].path];
  ok(threw(() => buildTable(RT, missing)),
    'buildTable THROWS on a declared endpoint with no handler');

  ok(threw(() => buildTable(RT, { ...stub, '/git/secret-backdoor': () => {} })),
    'buildTable THROWS on a handler that build.json does not declare');

  // Route matching, including the param route and the negative cases.
  for (const e of RT.endpoints) {
    const local = localPath(e.path, RT.base_path);
    const probe = local.replace(/:[^/]+/g, 'x');
    const hit = match(table, e.method, probe);
    ok(hit && hit.route && hit.route.declared === e.path,
      `${e.method} ${probe} resolves to ${e.path}`);
  }
  ok(match(table, 'GET', '/nope') === null, 'an unknown path does not match (-> 404, never 200)');
  ok(match(table, 'GET', '/repos/a/b/tarball/extra') === null, 'a deeper path does not match');
  ok(match(table, 'POST', '/clone/a/b/git-receive-pack') === null, 'there is no receive-pack route — the clone path cannot push');
  const wrongMethod = match(table, 'POST', '/repos');
  ok(wrongMethod && wrongMethod.route === null && wrongMethod.allowed.includes('GET'),
    'a known path with the wrong method reports 405, not 404 and not 200');
  const params = match(table, 'GET', '/repos/diegonmarcos/cloudy-t-infra/tarball');
  eq(params.params, { owner: 'diegonmarcos', repo: 'cloudy-t-infra' }, 'path params are extracted');
  ok(toRegex('/repos/:o/:r/tarball').source.includes('([^/]+)'), 'toRegex builds a capturing group per param');

  console.log('\nC2. path/ref validation refuses traversal rather than dialling it');
  for (const bad of ['..', '.', '../etc', 'a/b', '', '-x', 'a'.repeat(101)]) {
    ok(!validName(bad), `validName rejects ${JSON.stringify(bad)}`);
  }
  for (const good of ['cloud-infra', 'a.b_c-d', 'X1']) ok(validName(good), `validName accepts ${good}`);
  for (const bad of ['../x', 'a..b', '-x', '/x', 'a'.repeat(256)]) ok(!validRef(bad), `validRef rejects ${JSON.stringify(bad)}`);
  for (const good of [undefined, '', 'main', 'feature/x', 'v1.2.3']) ok(validRef(good), `validRef accepts ${JSON.stringify(good)}`);
}

function threw(fn) { try { fn(); return false; } catch { return true; } }

// ══ F. The commits/runs feeds: allow-list is data, projection is a whitelist ═
function testFeedsUnit() {
  console.log('\nF. feeds: allow-list, per_page bounds, projection, contract validation');
  const list = RT.feeds.repos;
  ok(repoDeclared(list, 'diegonmarcos', 'cloudy-t-infra'), 'a declared repo is allowed');
  ok(repoDeclared(list, 'DiegoNMarcos', 'Cloudy-T-Infra'), 'the allow-list is case-insensitive, like GitHub');
  ok(!repoDeclared(list, 'diegonmarcos', 'cloudy-t-infra-x'), 'a repo that merely PREFIXES a declared one is refused');
  ok(!repoDeclared(list, 'torvalds', 'linux'), 'an undeclared repo is refused');
  ok(!repoDeclared(list, 'diegonmarcos', 'cloud-vault'), 'the private vault repo is not a feed');

  const max = RT.feeds.max_per_page;
  for (const [raw, want] of [[undefined, 5], ['abc', 5], ['3', 3], ['0', 1], ['-4', 1], ['999', max]]) {
    eq(clampPerPage(raw, max), want, `clampPerPage(${JSON.stringify(raw)}) -> ${want}`);
  }
  // #674: the Store's COMMITS feed asks for up to 50 (a data value app-side);
  // a smaller cap would silently truncate it.
  ok(max >= 50, `feeds.max_per_page (${max}) serves the Store's per_page=50`);
  eq(clampPerPage('50', max), 50, 'per_page=50 is honoured, not clamped');
  eq(feedUrl('https://x', 'o', 'r', 'commits', 20), 'https://x/repos/o/r/commits?per_page=20', 'commits URL');
  eq(feedUrl('https://x', 'o', 'r', 'runs', 20), 'https://x/repos/o/r/actions/runs?per_page=20', 'runs URL');
  ok(!('smuggled' in projectCommit({ sha: 'a', commit: {}, smuggled: 1 })), 'projectCommit drops unknown fields');
  ok(!('smuggled' in projectRun({ name: 'a', smuggled: 1 })), 'projectRun drops unknown fields');

  // loadRuntime must REFUSE a contract whose feeds block is missing/malformed,
  // so the service cannot start and 500 on the first feed request instead.
  const raw = JSON.parse(readFileSync(BUILD_JSON, 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'gpa-'));
  const withFeeds = (feeds) => {
    const f = join(dir, `b${checks}.json`);
    writeFileSync(f, JSON.stringify({ ...raw, runtime: { ...raw.runtime, feeds } }));
    return () => loadRuntime(f);
  };
  ok(!threw(withFeeds(raw.runtime.feeds)), 'loadRuntime accepts the declared feeds block');
  ok(threw(withFeeds(undefined)), 'loadRuntime THROWS when runtime.feeds is missing');
  ok(threw(withFeeds({ ...raw.runtime.feeds, repos: [] })), 'loadRuntime THROWS on an empty allow-list');
  ok(threw(withFeeds({ ...raw.runtime.feeds, repos: ['no-slash'] })), 'loadRuntime THROWS on a malformed repo entry');
  ok(threw(withFeeds({ ...raw.runtime.feeds, cache_ttl_s: 0 })), 'loadRuntime THROWS on a zero cache TTL');
  ok(threw(withFeeds({ ...raw.runtime.feeds, max_per_page: 101 })), 'loadRuntime THROWS on max_per_page > 100');
  const withRt = (patch) => {
    const f = join(dir, `s${checks}.json`);
    writeFileSync(f, JSON.stringify({ ...raw, runtime: patch(structuredClone(raw.runtime)) }));
    return () => loadRuntime(f);
  };
  ok(threw(withRt((rt) => { delete rt.authelia.session; return rt; })), 'loadRuntime THROWS when authelia.session is missing');
  ok(threw(withRt((rt) => { rt.authelia.session.users = []; return rt; })), 'loadRuntime THROWS on an empty session user list');
  ok(threw(withRt((rt) => { rt.upstream.git_base = 'http://github.com'; return rt; })), 'loadRuntime THROWS on a non-https git_base');
}

// ══ G. #837 release-asset mirror: mesh gate + validation (pure) ═══════════
function testReleaseUnit() {
  console.log('\nG. release assets: mesh gate and validation');
  const C = RT.mesh.cidrs;
  ok(isDirectMesh('10.0.0.7', {}, C), 'a wg0 IPv4 peer dialling directly is the mesh');
  ok(isDirectMesh('::ffff:10.0.0.7', {}, C), 'the v4-mapped form of a wg0 peer is the mesh');
  ok(isDirectMesh('fd0c:1d00::5', {}, C), 'a wg0 IPv6 peer is the mesh');
  ok(!isDirectMesh('10.0.1.7', {}, C), '10.0.1.x is outside 10.0.0.0/24');
  ok(!isDirectMesh('fd0c:1d01::5', {}, C), 'fd0c:1d01:: is outside fd0c:1d00::/64');
  ok(!isDirectMesh('203.0.113.9', {}, C), 'a public address is not the mesh');
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'via']) {
    ok(!isDirectMesh('10.0.0.1', { [h]: '1.2.3.4' }, C), `a request relayed by a proxy (${h}) is never the mesh, even from a wg0 hop`);
  }
  ok(!isDirectMesh('10.0.0.7', {}, []), 'no declared cidrs means nothing is the mesh');
  ok(!inCidr('garbage', '10.0.0.0/24') && !inCidr('10.0.0.1', 'nonsense'), 'malformed addresses never match');
  ok(validTag('latest') && validTag('v1.2.3'), 'plain tags are valid');
  ok(!validTag('') && !validTag('a/b') && !validTag('..') && !validTag('-x'), 'empty, slashed, traversal and dash tags are refused');
  ok(validRange('bytes=0-') && validRange('bytes=100-199') && validRange('bytes=-500'), 'single byte ranges are accepted');
  ok(!validRange('bytes=0-1,5-9') && !validRange('items=0-1') && !validRange('bytes=x-'), 'multi-range and non-byte ranges are refused');
  eq(releaseByTagUrl('https://api.github.com', 'o', 'r', 'latest'), 'https://api.github.com/repos/o/r/releases/tags/latest', 'release-by-tag URL');
  eq(releaseAssetUrl('https://api.github.com', 'o', 'r', 42), 'https://api.github.com/repos/o/r/releases/assets/42', 'release-asset URL');
}

// ══ D. End-to-end against the REAL server, stubbed dependencies ════════════
// The pure checks above can only prove what the functions do. This boots the
// actual index.mjs and drives it over HTTP, because "the service refuses" and
// "the token does not leak" are properties of the wired-up program.
async function testLive() {
  console.log('\nD. end-to-end: the real index.mjs over HTTP');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });

  // A second, unrelated keypair. Nothing publishes it in the JWKS, so anything
  // it signs must be refused — without this case, DELETING the signature check
  // entirely leaves the tester green (it did, on the first mutation run), which
  // is the hollow-green shape exactly.
  const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  function mintJwt(claims, signWith = privateKey, alg = 'RS256') {
    const h = b64u(JSON.stringify({ alg, typ: 'JWT', kid: KID }));
    const p = b64u(JSON.stringify(claims));
    const sig = createSign('RSA-SHA256').update(`${h}.${p}`).end().sign(signWith);
    return `${h}.${p}.${b64u(sig)}`;
  }
  // An unsigned "alg: none" token — the classic JWT bypass.
  function mintUnsigned(claims) {
    return `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }))}.${b64u(JSON.stringify(claims))}.`;
  }

  // Stub Authelia JWKS + stub api.github.com in one listener.
  // The JWKS publishes TWO keys and the impostor's comes FIRST, so a verifier
  // that grabbed keys[0] instead of matching on `kid` would fail every genuine
  // token. Without the second key, deleting the kid lookup left this tester
  // green — a single-key fixture cannot tell key SELECTION from key TRUST.
  const impostorPub = JSON.parse(JSON.stringify(
    generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }),
  ));
  const upstreamHits = {};
  const sessionHits = [];
  const gitHits = [];
  const gitBodies = [];
  const GIT_ADVERT = '001e# service=git-upload-pack\n0000advert-sentinel';
  // #837 the asset bytes, on a separate origin like GitHub's object store, so
  // the tester can see whether our credential followed the redirect.
  const ASSET = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const SIDECARS = { 12: 'a'.repeat(64) + '  App.apk\n', 13: 'sha=deadbeef run=1\n' };
  const assetHits = [];
  const cdnHits = [];
  const cdn = createServer((req, res) => {
    const id = req.url.split('/').pop();
    cdnHits.push({ id, authz: req.headers.authorization || '', range: req.headers.range || '' });
    if (id !== '11') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(SIDECARS[id] || ''); }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': ASSET.length, 'accept-ranges': 'bytes', etag: '"e1"' });
      return res.end(ASSET);
    }
    const start = m[1] === '' ? ASSET.length - Number(m[2]) : Number(m[1]);
    const end = m[1] === '' || m[2] === '' ? ASSET.length - 1 : Math.min(Number(m[2]), ASSET.length - 1);
    if (start >= ASSET.length) {
      res.writeHead(416, { 'content-range': `bytes */${ASSET.length}` }); return res.end();
    }
    res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${ASSET.length}`, 'accept-ranges': 'bytes', etag: '"e1"' });
    return res.end(ASSET.subarray(start, end + 1));
  });
  await new Promise((r) => cdn.listen(0, '127.0.0.1', r));
  const cdnBase = `http://localhost:${cdn.address().port}`;
  const upstream = createServer((req, res) => {
    const bare = req.url.split('?')[0];
    upstreamHits[bare] = (upstreamHits[bare] || 0) + 1;
    if (bare === '/repos/diegonmarcos/cloudy-t-infra/commits') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(Array.from({ length: 7 }, (_, i) => ({
        sha: `sha${i}`, html_url: `https://github.com/c/${i}`,
        commit: { message: `msg ${i}`, author: { name: 'diego', date: '2026-09-29T00:00:00Z' } },
        smuggled: FAKE_TOKEN,
      }))));
    }
    if (bare === '/repos/diegonmarcos/cloudy-t-infra/actions/runs') {
      // Slow on purpose, so concurrent callers genuinely overlap the miss.
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ total_count: 1, workflow_runs: [{
          name: 'ship', display_title: 't', status: 'completed', conclusion: 'success',
          created_at: '2026-09-29T00:00:00Z', html_url: 'https://github.com/r/1',
          path: '.github/workflows/ship.yml', smuggled: FAKE_TOKEN,
        }] }));
      }, 150);
    }
    // #837 release metadata + asset redirect to a CDN on ANOTHER origin.
    if (bare === '/repos/diegonmarcos/cloudy-u-android/releases/tags/latest') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'latest', assets: [
        { id: 11, name: 'App.apk', size: ASSET.length },
        { id: 12, name: 'App.apk.sha256', size: 80 },
        { id: 13, name: 'App.apk.source', size: 40 },
        { id: 14, name: 'Gone.apk', size: 1 },
      ] }));
    }
    const am = /^\/repos\/diegonmarcos\/cloudy-u-android\/releases\/assets\/(\d+)$/.exec(bare);
    if (am) {
      assetHits.push({ id: am[1], accept: req.headers.accept, range: req.headers.range || '' });
      if (am[1] === '14') { res.writeHead(404); return res.end('{}'); }
      res.writeHead(302, { location: `${cdnBase}/blob/${am[1]}` });
      return res.end();
    }
    if (bare === '/repos/diegonmarcos/cloudy-u-android/releases/tags/nope') { res.writeHead(404); return res.end('{}'); }
    if (bare === '/repos/diegonmarcos/cloudy-u-linux/commits') {
      // Upstream fails and quotes our credential back — must not be cached, must not leak.
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(`upstream exploded with ${req.headers.authorization}`);
    }
    if (bare === '/api/authz/auth-request') {
      sessionHits.push({ url: req.headers['x-original-url'], method: req.headers['x-original-method'] });
      const c = req.headers.cookie || '';
      if (c === 'authelia_session=owner') { res.writeHead(200, { 'remote-user': RT.authelia.session.users[0] }); return res.end(); }
      if (c === 'authelia_session=guest') { res.writeHead(200, { 'remote-user': 'guest@example.invalid' }); return res.end(); }
      res.writeHead(401); return res.end('Unauthorized');
    }
    if (bare.startsWith('/diegonmarcos/cloudy-t-infra.git/')) {
      gitHits.push({ path: req.url, method: req.method, authz: req.headers.authorization || '', cookie: req.headers.cookie || '' });
      if (bare.endsWith('/info/refs')) {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
        return res.end(GIT_ADVERT);
      }
      let body = ''; req.on('data', (d) => { body += d; });
      return req.on('end', () => {
        gitBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
        res.end(`PACK-for:${body}`);
      });
    }
    if (req.url === '/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ keys: [
        { ...impostorPub, kid: 'some-other-kid', alg: 'RS256', use: 'sig' },
        { ...jwk, kid: KID, alg: 'RS256', use: 'sig' },
      ] }));
    }
    if (req.url.startsWith('/user/repos')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{
        full_name: 'diegonmarcos/cloudy-t-infra', owner: { login: 'diegonmarcos' },
        name: 'cloudy-t-infra', private: true, default_branch: 'main',
        updated_at: '2026-09-29T00:00:00Z', size: 42,
        // A hostile upstream field: if anything passed the body through instead
        // of projecting it, this would surface in our response.
        smuggled: FAKE_TOKEN,
      }]));
    }
    if (req.url.includes('/tarball')) {
      // The hardest leak case: the upstream fails AND quotes our credential
      // back at us. Our 502 must not carry it.
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end(`upstream exploded with ${req.headers.authorization}`);
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;

  const port = 18000 + (Math.abs(hash(randomUUID())) % 2000);
  const child = spawn(process.execPath, [join(HERE, 'code', 'index.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      GITHUB_TOKEN: FAKE_TOKEN,
      GITHUB_API_BASE: upstreamBase,
      GITHUB_GIT_BASE: upstreamBase,
      AUTHELIA_VERIFY_URL: `${upstreamBase}/api/authz/auth-request`,
      JWKS_URL: `${upstreamBase}/jwks.json`,
      ISSUER: 'https://auth.diegonmarcos.com',
      UPSTREAM_TIMEOUT_MS: '5000',
      BUILD_JSON_PATH: BUILD_JSON,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(async () => (await fetch(`${base}/health`)).ok, 8000);
  } catch {
    ok(false, 'the server started', childLog.slice(0, 800));
    child.kill('SIGKILL'); upstream.close();
    return;
  }

  const good = mintJwt({
    iss: 'https://auth.diegonmarcos.com', sub: 'diego', client_id: 'cli',
    scp: [RT.authelia.required_scope],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  });
  const expired = mintJwt({
    iss: 'https://auth.diegonmarcos.com', sub: 'diego', scp: [RT.authelia.required_scope],
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  const wrongIssuer = mintJwt({
    iss: 'https://evil.example.com', sub: 'diego', scp: [RT.authelia.required_scope],
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  const noScope = mintJwt({
    iss: 'https://auth.diegonmarcos.com', sub: 'diego', scp: ['nope'],
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  // Structurally perfect, correct kid, correct claims — signed by a key the
  // JWKS has never heard of. The ONLY thing that can reject this is the
  // signature verification itself.
  const validClaims = {
    iss: 'https://auth.diegonmarcos.com', sub: 'diego', client_id: 'cli',
    scp: [RT.authelia.required_scope],
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  };
  const forged = mintJwt(validClaims, impostor);
  const unsigned = mintUnsigned(validClaims);
  const tampered = (() => {
    // Take a genuinely signed token and swap its payload for the same claims
    // with an escalated scope, keeping the original signature.
    const [h, , s] = good0().split('.');
    return `${h}.${b64u(JSON.stringify({ ...validClaims, scp: [RT.authelia.required_scope, 'admin'] }))}.${s}`;
  })();
  function good0() { return mintJwt(validClaims); }

  const seen = [];
  async function req(path, token) {
    const r = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const text = await r.text();
    seen.push({ path, status: r.status, text });
    return { status: r.status, text, json: safeJson(text) };
  }

  // Pre-auth route.
  const health = await req('/health');
  ok(health.status === 200 && health.json?.status === 'ok', 'GET /health is 200 without a token');
  ok(!health.text.includes('github') && !health.text.toLowerCase().includes('token'),
    '/health says nothing about GitHub or credentials');

  // Refusals — status AND body, on the live wire.
  for (const [label, tok, wantStatus, wantCode] of [
    ['no token', undefined, 401, 'missing_authorization'],
    ['garbage token', 'not-a-jwt', 401, 'invalid_token'],
    ['expired token', expired, 401, 'invalid_token'],
    ['wrong issuer', wrongIssuer, 401, 'invalid_token'],
    ['token signed by an impostor key', forged, 401, 'invalid_token'],
    ['unsigned alg:none token', unsigned, 401, 'invalid_token'],
    ['tampered payload, original signature', tampered, 401, 'invalid_token'],
    ['missing scope', noScope, 403, 'insufficient_scope'],
  ]) {
    for (const path of ['/repos', '/endpoints', '/repos/diegonmarcos/cloudy-t-infra/tarball',
      '/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack',
      '/repos/diegonmarcos/cloudy-t-infra/commits', '/repos/diegonmarcos/cloudy-t-infra/runs']) {
      const r = await req(path, tok);
      ok(r.status === wantStatus && r.json?.code === wantCode,
        `${path} with ${label} -> ${wantStatus} ${wantCode}`, `got ${r.status} ${r.text.slice(0, 120)}`);
    }
  }

  // Unmatched route: 404 with a JSON error body, never a 200 banner (#568).
  const bogus = await req('/definitely-not-a-route', good);
  ok(bogus.status === 404 && bogus.json?.code === 'no_such_route',
    'an unmatched route is 404 with a JSON error code, not a 200 banner (#568)',
    `got ${bogus.status} ${bogus.text.slice(0, 120)}`);
  const bogusNoAuth = await req('/definitely-not-a-route');
  ok(bogusNoAuth.status === 404, 'an unmatched route 404s before it can 401 — still not 200');

  // Authenticated happy paths.
  const eps = await req('/endpoints', good);
  ok(eps.status === 200 && eps.json?.endpoints?.length === RT.endpoints.length,
    'GET /endpoints serves the declared contract verbatim');
  eq(eps.json?.endpoints?.map((e) => e.path).sort(), RT.endpoints.map((e) => e.path).sort(),
    '/endpoints is byte-equal to build.json runtime.endpoints — one declaration, no drift');

  const repos = await req('/repos', good);
  ok(repos.status === 200 && repos.json?.count === 1, 'GET /repos returns the projected list',
    `got ${repos.status} ${repos.text.slice(0, 200)}`);
  ok(!('smuggled' in (repos.json?.repos?.[0] || {})),
    'an unknown upstream field is dropped, not passed through');

  // The hard leak case: upstream fails quoting our Authorization header.
  const tar = await req('/repos/diegonmarcos/cloudy-t-infra/tarball?ref=main', good);
  ok(tar.status === 502 && tar.json?.code === 'upstream_error',
    'an upstream failure is a 502 with a JSON code, not a 200', `got ${tar.status}`);

  // Traversal and validation on the live wire.
  const badRef = await req('/repos/diegonmarcos/cloudy-t-infra/tarball?ref=..%2F..%2Fetc', good);
  ok(badRef.status === 400 && badRef.json?.code === 'bad_ref', 'a traversal ref is a 400',
    `got ${badRef.status} ${badRef.text.slice(0, 120)}`);
  for (const [label, path] of [
    ['a leading-dash owner', '/repos/-flag/cloud-infra/tarball'],
    ['an encoded-traversal owner', '/repos/..%2F..%2Fetc/cloud-infra/tarball'],
    ['an encoded-traversal repo', '/repos/diegonmarcos/..%2Fsecrets/tarball'],
    ['an owner with a slash', '/repos/a%2Fb/cloud-infra/tarball'],
    // A bare "." or ".." segment is deliberately NOT tested: the URL layer
    // normalises "/./" and "/../" out of the path before it is ever sent, so
    // that case cannot reach the service and asserting on it would only pin
    // Node's URL behaviour. validName still rejects both (unit cases above).
  ]) {
    const r = await req(path, good);
    ok(r.status === 400 && r.json?.code === 'bad_repo', `${label} is a 400 bad_repo`,
      `got ${r.status} ${r.text.slice(0, 120)}`);
  }

  // ── Feeds (commits / runs) ──
  const refusedUpstream = upstreamHits['/repos/diegonmarcos/cloudy-t-infra/commits'] || 0;
  eq(refusedUpstream, 0, 'the refused (unauthenticated) feed requests dialled GitHub ZERO times');

  const c1 = await req('/repos/diegonmarcos/cloudy-t-infra/commits?per_page=2', good);
  ok(c1.status === 200 && c1.json?.commits?.length === 2 && c1.json.commits[0].sha === 'sha0',
    'GET commits returns the projected list, sliced to per_page', `got ${c1.status} ${c1.text.slice(0, 200)}`);
  ok(c1.json?.commits && !('smuggled' in c1.json.commits[0]), 'an unknown upstream commit field is dropped');
  ok(typeof c1.json?.cached_at === 'string', 'the response says when it was fetched (cached_at)');
  const c2 = await req('/repos/DiegoNMarcos/Cloudy-T-Infra/commits?per_page=50', good);
  ok(c2.status === 200 && c2.json?.commits?.length === 7, 'per_page above max still returns what upstream had');
  eq(upstreamHits['/repos/diegonmarcos/cloudy-t-infra/commits'], 1,
    'a second request (different case, different per_page) is served from CACHE — one upstream call');

  const runs = await Promise.all(Array.from({ length: 5 }, () => req('/repos/diegonmarcos/cloudy-t-infra/runs', good)));
  ok(runs.every((r) => r.status === 200 && r.json?.runs?.[0]?.conclusion === 'success'),
    'GET runs returns the projected run with its conclusion', `got ${runs[0].status} ${runs[0].text.slice(0, 200)}`);
  ok(!('smuggled' in (runs[0].json?.runs?.[0] || {})), 'an unknown upstream run field is dropped');
  eq(upstreamHits['/repos/diegonmarcos/cloudy-t-infra/actions/runs'], 1,
    'five CONCURRENT misses share ONE upstream call');

  const undeclared = await req('/repos/torvalds/linux/commits', good);
  ok(undeclared.status === 403 && undeclared.json?.code === 'repo_not_declared',
    'an undeclared repo is a 403 repo_not_declared', `got ${undeclared.status} ${undeclared.text.slice(0, 120)}`);
  eq(upstreamHits['/repos/torvalds/linux/commits'], undefined, 'and GitHub was never dialled for it');
  const badFeed = await req('/repos/-x/cloud-infra/runs', good);
  ok(badFeed.status === 400 && badFeed.json?.code === 'bad_repo', 'a malformed owner on a feed is 400 bad_repo');

  const f1 = await req('/repos/diegonmarcos/cloudy-u-linux/commits', good);
  ok(f1.status === 502 && f1.json?.code === 'upstream_error',
    'an upstream feed failure is a 502 upstream_error — never a 200 with an empty list', `got ${f1.status} ${f1.text.slice(0, 120)}`);
  await req('/repos/diegonmarcos/cloudy-u-linux/commits', good);
  eq(upstreamHits['/repos/diegonmarcos/cloudy-u-linux/commits'], 2, 'a FAILED upstream answer is not cached — the next call retries');
  const nf = await req('/repos/diegonmarcos/front-data/runs', good);
  ok(nf.status === 404 && nf.json?.code === 'not_found', 'an upstream 404 on a declared repo is forwarded as 404 not_found',
    `got ${nf.status} ${nf.text.slice(0, 120)}`);

  // ── Session (cookie) path ──
  async function reqH(path, headers, init = {}) {
    const r = await fetch(`${base}${path}`, { headers, ...init });
    const text = await r.text();
    seen.push({ path, status: r.status, text, ctype: r.headers.get('content-type') });
    return { status: r.status, text, json: safeJson(text), ctype: r.headers.get('content-type') };
  }
  const sOwner = await reqH('/repos', { cookie: 'authelia_session=owner' });
  ok(sOwner.status === 200 && sOwner.json?.count === 1, "the phone's Authelia session lists repos (no bearer anywhere)",
    `got ${sOwner.status} ${sOwner.text.slice(0, 160)}`);
  ok(sessionHits.at(-1)?.url === `${RT.authelia.session.public_url}${RT.base_path}/repos` && sessionHits.at(-1)?.method === 'GET',
    'Authelia was asked about THIS route (X-Original-URL/Method), not the portal', JSON.stringify(sessionHits.at(-1)));
  const sGuest = await reqH('/repos', { cookie: 'authelia_session=guest' });
  ok(sGuest.status === 403 && sGuest.json?.code === 'user_not_allowed', 'a live session of an UNDECLARED user is 403',
    `got ${sGuest.status} ${sGuest.text.slice(0, 120)}`);
  const sDead = await reqH('/repos', { cookie: 'authelia_session=expired' });
  ok(sDead.status === 401 && sDead.json?.code === 'invalid_session', 'a session Authelia refuses is 401 invalid_session',
    `got ${sDead.status} ${sDead.text.slice(0, 120)}`);
  const sBearerWins = await reqH('/repos', { cookie: 'authelia_session=owner', authorization: 'Bearer not-a-jwt' });
  ok(sBearerWins.status === 401 && sBearerWins.json?.code === 'invalid_token',
    'a bad bearer is refused even next to a good cookie — never retried as a session', `got ${sBearerWins.status}`);

  // ── Clone over smart HTTP: the token goes to GitHub and nowhere else ──
  const before = gitHits.length;
  const adv = await reqH('/clone/diegonmarcos/cloudy-t-infra.git/info/refs?service=git-upload-pack',
    { authorization: `Bearer ${good}`, 'git-protocol': 'version=2' });
  ok(adv.status === 200 && adv.text === GIT_ADVERT && adv.ctype === 'application/x-git-upload-pack-advertisement',
    'info/refs streams GitHub\'s advertisement through byte-exact', `got ${adv.status} ${adv.ctype} ${adv.text.slice(0, 80)}`);
  const hitA = gitHits[before];
  ok(hitA?.authz === `Basic ${Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64')}`,
    'GitHub received the server credential as Basic', `got ${hitA?.authz}`);
  ok(hitA && !hitA.authz.includes(good) && hitA.cookie === '', "GitHub never saw the caller's fleet bearer or cookie");
  const advS = await reqH('/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack', { cookie: 'authelia_session=owner' });
  ok(advS.status === 200 && advS.text === GIT_ADVERT, 'the phone\'s session can clone too (no .git suffix works)', `got ${advS.status}`);
  ok(gitHits.at(-1)?.cookie === '', 'and its cookie did not travel to GitHub');
  const pack = await reqH('/clone/diegonmarcos/cloudy-t-infra/git-upload-pack',
    { authorization: `Bearer ${good}`, 'content-type': 'application/x-git-upload-pack-request' },
    { method: 'POST', body: '0032want deadbeef\n00000009done\n' });
  ok(pack.status === 200 && pack.text === 'PACK-for:0032want deadbeef\n00000009done\n'
    && gitBodies.at(-1) === '0032want deadbeef\n00000009done\n',
    'git-upload-pack streams the negotiation up and the pack down', `got ${pack.status} ${pack.text.slice(0, 80)}`);
  const hitsBeforePush = gitHits.length;
  const push = await reqH('/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-receive-pack', { authorization: `Bearer ${good}` });
  ok(push.status === 403 && push.json?.code === 'service_not_allowed', 'service=git-receive-pack is 403 — nothing can push',
    `got ${push.status} ${push.text.slice(0, 120)}`);
  const pushPost = await reqH('/clone/diegonmarcos/cloudy-t-infra/git-receive-pack', { authorization: `Bearer ${good}` }, { method: 'POST', body: 'x' });
  ok(pushPost.status === 404 && pushPost.json?.code === 'no_such_route', 'POST git-receive-pack has no route (404)', `got ${pushPost.status}`);
  eq(gitHits.length, hitsBeforePush, 'and GitHub was never dialled for a push');
  const nf2 = await reqH('/clone/diegonmarcos/no-such-repo/info/refs?service=git-upload-pack', { authorization: `Bearer ${good}` });
  ok(nf2.status === 404 && nf2.json?.code === 'not_found', 'an unknown repo clones to 404 not_found', `got ${nf2.status}`);
  const badClone = await reqH('/clone/-x/cloud-infra/info/refs?service=git-upload-pack', { authorization: `Bearer ${good}` });
  ok(badClone.status === 400 && badClone.json?.code === 'bad_repo', 'a malformed owner on the clone route is 400 bad_repo');
  const anonClone = await reqH('/clone/diegonmarcos/cloudy-t-infra/info/refs?service=git-upload-pack', {});
  ok(anonClone.status === 401, 'an anonymous clone is refused 401', `got ${anonClone.status}`);

  // ── #837 release assets ──
  const REL = '/releases/diegonmarcos/cloudy-u-android/latest/assets';
  async function bin(path, headers = {}, b = base) {
    const r = await fetch(`${b}${path}`, { headers });
    const buf = Buffer.from(await r.arrayBuffer());
    seen.push({ path, status: r.status, text: buf.toString('latin1') });
    return { status: r.status, buf, h: r.headers, json: safeJson(buf.toString('utf8')) };
  }
  const offMesh = await bin(`${REL}/App.apk`);
  ok(offMesh.status === 401 && offMesh.json?.code === 'missing_authorization',
    'off the mesh (this server has no mesh cidrs) the asset route is Authelia-gated like any other', `got ${offMesh.status}`);
  eq(assetHits.length, 0, 'and the refused request dialled GitHub zero times');
  const authed = await bin(`${REL}/App.apk`, { authorization: `Bearer ${good}` });
  ok(authed.status === 200 && authed.buf.equals(ASSET), 'with a fleet bearer the asset streams byte-exact', `got ${authed.status} ${authed.buf.length}`);
  ok(cdnHits.at(-1)?.authz === '', 'the GitHub credential did NOT follow the redirect to the object store');
  ok(assetHits.at(-1)?.accept === 'application/octet-stream', 'the asset was asked for as octet-stream');

  // A second server that counts 127.0.0.0/8 as "the mesh" (MESH_CIDRS is the
  // tester-only override; production reads runtime.mesh.cidrs).
  const meshPort = port + 2;
  const meshChild = spawn(process.execPath, [join(HERE, 'code', 'index.mjs')], {
    env: { ...process.env, PORT: String(meshPort), BIND_HOST: '127.0.0.1', GITHUB_TOKEN: FAKE_TOKEN,
      GITHUB_API_BASE: upstreamBase, GITHUB_GIT_BASE: upstreamBase, JWKS_URL: `${upstreamBase}/jwks.json`,
      AUTHELIA_VERIFY_URL: `${upstreamBase}/api/authz/auth-request`, ISSUER: 'https://auth.diegonmarcos.com',
      UPSTREAM_TIMEOUT_MS: '5000', BUILD_JSON_PATH: BUILD_JSON, MESH_CIDRS: '127.0.0.0/8' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  meshChild.stdout.on('data', (d) => { childLog += d; });
  meshChild.stderr.on('data', (d) => { childLog += d; });
  const mbase = `http://127.0.0.1:${meshPort}`;
  try {
    await waitFor(async () => (await fetch(`${mbase}/health`)).ok, 8000);
    const full = await bin(`${REL}/App.apk`, {}, mbase);
    ok(full.status === 200 && full.buf.equals(ASSET), 'a direct mesh dial with NO credential streams the asset byte-exact',
      `got ${full.status} ${full.buf.length} ${full.buf.toString().slice(0, 120)}`);
    eq(full.h.get('content-length'), String(ASSET.length), 'Content-Length passes through');
    eq(full.h.get('accept-ranges'), 'bytes', 'Accept-Ranges: bytes is advertised');
    eq(full.h.get('etag'), '"e1"', 'ETag passes through');
    const part = await bin(`${REL}/App.apk`, { range: 'bytes=100-199' }, mbase);
    ok(part.status === 206 && part.buf.equals(ASSET.subarray(100, 200)), 'Range bytes=100-199 is a 206 with exactly those bytes',
      `got ${part.status} ${part.buf.length}`);
    eq(part.h.get('content-range'), `bytes 100-199/${ASSET.length}`, 'Content-Range passes through');
    eq(cdnHits.at(-1)?.range, 'bytes=100-199', 'the Range reached the object store');
    const resume = await bin(`${REL}/App.apk`, { range: 'bytes=900-' }, mbase);
    ok(resume.status === 206 && resume.buf.equals(ASSET.subarray(900)), 'an open-ended resume range returns the tail');
    const past = await bin(`${REL}/App.apk`, { range: 'bytes=5000-' }, mbase);
    ok(past.status === 416 && past.json?.code === 'range_not_satisfiable', 'a range past the end is 416 range_not_satisfiable',
      `got ${past.status} ${past.buf.toString().slice(0, 120)}`);
    eq(past.h.get('content-range'), `bytes */${ASSET.length}`, 'and says the real length');
    const multi = await bin(`${REL}/App.apk`, { range: 'bytes=0-1,5-9' }, mbase);
    ok(multi.status === 400 && multi.json?.code === 'bad_range', 'a multi-range is 400 bad_range');
    const sha = await bin(`${REL}/App.apk.sha256`, {}, mbase);
    ok(sha.status === 200 && sha.buf.toString() === SIDECARS[12], 'the .sha256 sidecar passes through verbatim');
    const src = await bin(`${REL}/App.apk.source`, {}, mbase);
    ok(src.status === 200 && src.buf.toString() === SIDECARS[13], 'the .source sidecar passes through verbatim');
    const relayed = await bin(`${REL}/App.apk`, { 'x-forwarded-for': '203.0.113.9' }, mbase);
    ok(relayed.status === 401, 'a request relayed by the public edge (X-Forwarded-For) still needs Authelia, even from a mesh hop',
      `got ${relayed.status}`);
    const before837 = assetHits.length;
    const undecl = await bin('/releases/torvalds/linux/latest/assets/x.apk', {}, mbase);
    ok(undecl.status === 403 && undecl.json?.code === 'repo_not_declared', 'an undeclared repo is 403 repo_not_declared');
    eq(assetHits.length, before837, 'and GitHub was never dialled for it');
    const noAsset = await bin(`${REL}/Missing.apk`, {}, mbase);
    ok(noAsset.status === 404 && noAsset.json?.code === 'not_found', 'an asset not on the release is 404 not_found');
    const gone = await bin(`${REL}/Gone.apk`, {}, mbase);
    ok(gone.status === 404 && gone.json?.code === 'not_found', 'an asset GitHub 404s is forwarded as 404 not_found');
    const noRel = await bin('/releases/diegonmarcos/cloudy-u-android/nope/assets/App.apk', {}, mbase);
    ok(noRel.status === 404 && noRel.json?.code === 'not_found', 'an unknown release tag is 404 not_found');
    const badName = await bin(`${REL}/..%2Fsecrets`, {}, mbase);
    ok(badName.status === 400 && badName.json?.code === 'bad_asset', 'a traversal asset name is 400 bad_asset');
    const badOwner = await bin('/releases/-x/cloudy-u-android/latest/assets/App.apk', {}, mbase);
    ok(badOwner.status === 400 && badOwner.json?.code === 'bad_repo', 'a malformed owner is 400 bad_repo');
    const otherMesh = await bin('/repos', {}, mbase);
    ok(otherMesh.status === 401, 'the mesh exemption is ONLY the asset route: /repos on the mesh still 401s');
    ok(cdnHits.every((h) => h.authz === ''), 'the credential never reached the object store on any request');
  } catch (e) {
    ok(false, 'the mesh server ran the release checks', `${e.message} ${childLog.slice(-600)}`);
  } finally {
    meshChild.kill('SIGTERM');
    cdn.close();
  }

  // Wrong method on a real path must be 405 — not 404, and above all not 200.
  for (const [method, path] of [['POST', '/repos'], ['DELETE', '/endpoints'], ['PUT', '/health'],
    ['POST', '/repos/diegonmarcos/cloudy-t-infra/runs']]) {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${good}` } });
    const text = await r.text();
    seen.push({ path: `${method} ${path}`, status: r.status, text });
    ok(r.status === 405 && safeJson(text)?.code === 'method_not_allowed',
      `${method} ${path} -> 405 method_not_allowed`, `got ${r.status} ${text.slice(0, 120)}`);
    ok(r.headers.get('allow') === 'GET', `${method} ${path} advertises Allow: GET`,
      `got ${r.headers.get('allow')}`);
  }

  // THE headline assertion: across every response this run produced — bodies
  // and headers, success and failure — the credential appears nowhere.
  const basicForm = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64');
  ok(!JSON.stringify(seen).includes(basicForm), 'the Basic-encoded credential appears in no response either');
  const everything = JSON.stringify(seen);
  ok(!everything.includes(FAKE_TOKEN),
    `the GitHub credential appears in NONE of the ${seen.length} responses collected`,
    firstLeak(seen));
  // And it did not escape through the logs either.
  ok(!childLog.includes(FAKE_TOKEN), 'the credential is not printed to stdout/stderr either');

  child.kill('SIGTERM');

  // E. Without a credential the process must REFUSE TO START, so the
  // deploy-liveness gate catches it (#560) instead of every user getting a 502.
  // A service that comes up and fails every request is the failure mode that
  // looks green from the outside.
  const noTok = spawn(process.execPath, [join(HERE, 'code', 'index.mjs')], {
    env: { ...process.env, PORT: String(port + 1), BIND_HOST: '127.0.0.1',
           GITHUB_TOKEN: '', BUILD_JSON_PATH: BUILD_JSON },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let noTokErr = '';
  noTok.stderr.on('data', (d) => { noTokErr += d; });
  const code = await new Promise((r) => {
    noTok.on('exit', r);
    setTimeout(() => { noTok.kill('SIGKILL'); r('still-running'); }, 5000);
  });
  ok(code === 1, 'with no GITHUB_TOKEN the process EXITS 1 instead of serving',
    `exit was ${code}`);
  ok(/GITHUB_TOKEN is not set/.test(noTokErr), 'and it says why, on stderr',
    noTokErr.slice(0, 200));

  upstream.close();
  await new Promise((r) => setTimeout(r, 100));
}

function firstLeak(seen) {
  const hit = seen.find((s) => s.text.includes(FAKE_TOKEN));
  return hit ? `LEAKED in ${hit.path} (${hit.status}): ${hit.text.slice(0, 200)}` : '';
}
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch { /* not up yet */ }
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 120));
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log('git-proxy-api tester (#647) — refusal, no-leak, no-drift');
await testRefusal();
testRedactionUnit();
testContract();
testFeedsUnit();
testReleaseUnit();
await testLive();

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`::error::git-proxy-api tester: ${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log('git-proxy-api: refusal, no-leak and no-drift all hold.');
