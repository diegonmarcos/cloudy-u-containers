// Reference driver for the Go authz parity harness: feeds the decision corpus through the REAL Node
// authz.mjs / upstream.mjs (both identical copies are exercised) and prints one JSON result list.
// usage: node driver.mjs <cases.json> <path-to-authz.mjs> <path-to-upstream.mjs>
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , casesPath, authzPath, upstreamPath] = process.argv;
const { decideAuth, decideSession, scopesOf } = await import(pathToFileURL(authzPath).href);
const { isDirectMesh } = await import(pathToFileURL(upstreamPath).href);
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));

function norm(d) {
  return d.ok
    ? { ok: true, user: d.user ?? null }
    : { ok: false, status: d.status, code: d.body.code, error: d.body.error };
}

const out = { bearer: [], session: [], scopes: [], mesh: [] };
for (const c of cases.bearer) {
  const verify = async () => {
    if (c.verify === 'accept') return c.claims;
    if (c.verify === 'jwks_down') { const e = new Error('down'); e.code = 'jwks_unavailable'; throw e; }
    throw new Error('bad signature');
  };
  out.bearer.push(norm(await decideAuth(c.header === null ? undefined : c.header, verify, c.scope)));
}
for (const c of cases.session) {
  const verify = async () => {
    if (c.verify === 'accept') return c.user;
    if (c.verify === 'down') { const e = new Error('down'); e.code = 'session_unavailable'; throw e; }
    throw new Error('401');
  };
  out.session.push(norm(await decideSession(c.cookie === null ? undefined : c.cookie, verify, c.users)));
}
for (const c of cases.scopes) out.scopes.push(scopesOf(c));
for (const c of cases.mesh) out.mesh.push(isDirectMesh(c.addr, c.headers, c.cidrs));
process.stdout.write(JSON.stringify(out));
