// upstream.mjs — the ONLY place the GitHub credential is allowed to appear,
// plus the redactor every outbound body is passed through.
//
// Pure: no imports, no I/O. index.mjs does the fetching; this module only
// builds URLs/headers and scrubs strings, which is what makes
// ../test-contract-and-authz.mjs able to assert the leak properties without a
// network, a token, or an npm install.

// Placeholder written into any string where a secret was found. Distinct and
// greppable so a leak that DID get redacted is still visible in a log.
export const REDACTED = '[redacted]';

/**
 * Outbound headers for api.github.com. This is the one function in the service
 * that embeds the token, and it is only ever used on a REQUEST we send.
 */
export function upstreamHeaders(token) {
  if (!token) throw new Error('upstreamHeaders: no GITHUB_TOKEN configured');
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'git-proxy-api',
  };
}

/**
 * Outbound headers for GitHub's smart-HTTP git endpoint (clone/fetch only).
 * GitHub takes a token as the Basic password there. Only the git protocol
 * headers are carried over from the caller — never its Cookie or its fleet
 * bearer, which are ours to verify and nobody's to forward.
 */
export const GIT_PASS_HEADERS = ['content-type', 'accept', 'git-protocol', 'content-encoding', 'user-agent'];
export function gitUpstreamHeaders(token, reqHeaders = {}) {
  if (!token) throw new Error('gitUpstreamHeaders: no GITHUB_TOKEN configured');
  const out = {};
  for (const h of GIT_PASS_HEADERS) if (reqHeaders[h]) out[h] = reqHeaders[h];
  out['user-agent'] ??= 'git-proxy-api';
  out['accept-encoding'] = 'identity';
  out.authorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return out;
}

/** https://github.com/<owner>/<repo>.git/<suffix> — suffix is fixed by the route, never the caller. */
export function gitUrl(gitBase, owner, repo, suffix) {
  const seg = [owner, repo].map((s) => encodeURIComponent(s)).join('/');
  return `${gitBase}/${seg}.git/${suffix}`;
}

/**
 * Remove every configured secret from a string before it can reach a client.
 *
 * Applied to EVERY response body this service emits, not just the ones that
 * look risky. An upstream error message, a stack trace, a URL echoed back in a
 * 502 — any of them can carry a token, and the honest way to be sure is to
 * scrub unconditionally rather than to reason case by case about which path is
 * safe. Longest secret first so a token that contains another secret as a
 * substring cannot leave a readable tail behind.
 */
export function redactSecrets(value, secrets) {
  let out = typeof value === 'string' ? value : JSON.stringify(value);
  const list = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 8);
  for (const s of [...list].sort((a, b) => b.length - a.length)) {
    out = out.split(s).join(REDACTED);
  }
  return out;
}

export function reposUrl(apiBase, page) {
  const p = Number.isInteger(page) && page > 0 ? page : 1;
  return `${apiBase}/user/repos?per_page=100&page=${p}&affiliation=owner,collaborator,organization_member`;
}

export function tarballUrl(apiBase, owner, repo, ref) {
  const seg = [owner, repo].map((s) => encodeURIComponent(s)).join('/');
  // No ref => GitHub uses the repo's default branch, which is exactly the
  // "just give me the repo" case and saves a round trip to look it up.
  return ref
    ? `${apiBase}/repos/${seg}/tarball/${encodeURIComponent(ref)}`
    : `${apiBase}/repos/${seg}/tarball`;
}

/** Project an upstream repo object down to the fields a client needs.
 *
 * A projection, not a passthrough: whatever GitHub adds to its schema later
 * cannot appear in our response, so no upstream field can become a leak. */
export function projectRepo(r) {
  return {
    full_name: r.full_name,
    owner: r.owner?.login,
    name: r.name,
    private: !!r.private,
    default_branch: r.default_branch,
    updated_at: r.updated_at,
    size_kb: r.size,
  };
}

// Owner/repo path segments, validated against GitHub's own naming rules. A
// request for `../../secrets` must be a 400 from us, never a URL we construct
// and dial.
const NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

export function validName(s) {
  return typeof s === 'string' && NAME_RE.test(s) && s !== '.' && s !== '..';
}

// A git ref may contain slashes (feature/x) but never `..`, a leading dash, or
// the traversal shapes that would let a caller rewrite the upstream path.
export function validRef(s) {
  if (s === undefined || s === null || s === '') return true;
  if (typeof s !== 'string' || s.length > 255) return false;
  if (s.includes('..') || s.startsWith('-') || s.startsWith('/')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s);
}

// ── Read-only feeds: recent commits / workflow runs of a DECLARED repo ─────
// The allow-list is runtime.feeds.repos in build.json; these helpers only
// consult what they are handed.

/** GitHub names are case-insensitive, so the allow-list is too. */
export function repoDeclared(repos, owner, repo) {
  const want = `${owner}/${repo}`.toLowerCase();
  return (repos || []).some((r) => typeof r === 'string' && r.toLowerCase() === want);
}

/** `per_page` from the query, clamped to 1..max; default 5 (what the Store asks for). */
export function clampPerPage(raw, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return Math.min(5, max);
  return Math.min(Math.max(n, 1), max);
}

export const FEED_KINDS = {
  commits: { path: 'commits', list: (body) => body, project: projectCommit },
  runs: { path: 'actions/runs', list: (body) => body?.workflow_runs, project: projectRun },
};

export function feedUrl(apiBase, owner, repo, kind, perPage) {
  const seg = [owner, repo].map((s) => encodeURIComponent(s)).join('/');
  return `${apiBase}/repos/${seg}/${FEED_KINDS[kind].path}?per_page=${perPage}`;
}

export function projectCommit(c) {
  return {
    sha: c.sha,
    message: c.commit?.message,
    author: c.commit?.author?.name,
    date: c.commit?.author?.date,
    html_url: c.html_url,
  };
}

export function projectRun(r) {
  return {
    name: r.name,
    display_title: r.display_title,
    status: r.status,
    conclusion: r.conclusion,
    created_at: r.created_at,
    html_url: r.html_url,
    path: r.path,
  };
}

// ── Release assets (#837 mesh mirror leg for fleet APKs) ────────────────────
// The phone's Store downloads fleet APKs from github.com release assets; when
// public DNS is gone (#831) it has no leg left. This route streams the same
// asset from GitHub server-side, so the phone only needs the mesh.

/** GET /repos/:o/:r/releases/tags/:tag — the release whose assets we resolve by name. */
export function releaseByTagUrl(apiBase, owner, repo, tag) {
  const seg = [owner, repo].map((s) => encodeURIComponent(s)).join('/');
  return `${apiBase}/repos/${seg}/releases/tags/${encodeURIComponent(tag)}`;
}

/** The asset download URL (Accept: application/octet-stream -> 302 to the CDN). */
export function releaseAssetUrl(apiBase, owner, repo, id) {
  const seg = [owner, repo].map((s) => encodeURIComponent(s)).join('/');
  return `${apiBase}/repos/${seg}/releases/assets/${encodeURIComponent(String(id))}`;
}

/** A tag is one path segment here: a ref that never contains a slash. */
export function validTag(s) {
  return typeof s === 'string' && s !== '' && !s.includes('/') && validRef(s);
}

/** Only the transfer headers a resumable download needs travel back. */
export const ASSET_PASS_HEADERS = ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];

/** A Range header we forward: bytes=a-b / bytes=a- / bytes=-n, single range only. */
export function validRange(h) {
  return typeof h === 'string' && /^bytes=(\d+-\d*|-\d+)$/.test(h.trim());
}

// ── Mesh-only access (#837) ──────────────────────────────────────────────────
// A route declared auth "mesh" is served WITHOUT an Authelia credential only
// when the request came straight over wg0: the source address is inside
// runtime.mesh.cidrs AND no reverse proxy touched it (Caddy always sets
// X-Forwarded-For / X-Forwarded-Host). Anything that arrived through the
// public edge is judged exactly like an `authelia` route, so off-mesh access
// is unchanged: the edge forward_auth still gates it and so do we.

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

function ipv6ToBig(ip) {
  let s = ip.toLowerCase().split('%')[0];
  if (s.includes('.')) return null; // v4-mapped handled by the caller
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const parts = [...head, ...Array(Math.max(fill, 0)).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return parts.reduce((acc, x) => (acc << 16n) + BigInt(parseInt(x, 16)), 0n);
}

export function inCidr(addr, cidr) {
  if (typeof addr !== 'string' || typeof cidr !== 'string') return false;
  let a = addr.trim();
  const m4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m4) a = m4[1];
  const [net, bitsRaw] = cidr.trim().split('/');
  if (net.includes(':') !== a.includes(':')) return false;
  if (a.includes(':')) {
    const bits = Number(bitsRaw ?? 128);
    const x = ipv6ToBig(a); const n = ipv6ToBig(net);
    if (x === null || n === null || !(bits >= 0 && bits <= 128)) return false;
    const sh = BigInt(128 - bits);
    return (x >> sh) === (n >> sh);
  }
  const bits = Number(bitsRaw ?? 32);
  const x = ipv4ToInt(a); const n = ipv4ToInt(net);
  if (x === null || n === null || !(bits >= 0 && bits <= 32)) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return ((x & mask) >>> 0) === ((n & mask) >>> 0);
}

/** True when the request is a direct wg0 dial, never one relayed by a proxy. */
export function isDirectMesh(remoteAddr, headers, cidrs) {
  const h = headers || {};
  if (h['x-forwarded-for'] || h['x-forwarded-host'] || h['x-real-ip'] || h.forwarded || h.via) return false;
  return (cidrs || []).some((c) => inCidr(remoteAddr, c));
}
