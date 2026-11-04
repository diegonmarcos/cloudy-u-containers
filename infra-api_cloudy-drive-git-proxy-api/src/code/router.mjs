// router.mjs — builds the dispatch table FROM the declared contract.
//
// The drift this removes is #371's shape: a route the client dials that the
// service never served (or the reverse). Rather than test two lists for
// equality, the table is derived from build.json's runtime.endpoints and
// buildTable THROWS when the two sides disagree in either direction — a
// declared endpoint with no handler, or a handler for something undeclared.
// The service then cannot start in a drifted state, and the tester asserts the
// throw rather than hoping a grep noticed.
//
// Pure: one import of localPath, no I/O.

import { localPath } from './contract.mjs';

/** `/repos/:owner/:repo/tarball` -> /^\/repos\/([^/]+)\/([^/]+)\/tarball$/ */
export function toRegex(local) {
  const src = local
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '([^/]+)' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${src}$`);
}

export function paramNames(local) {
  return local.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
}

/**
 * @param {object} runtime  build.json's `runtime` block (via contract.loadRuntime)
 * @param {Record<string, Function>} handlers  keyed by DECLARED path ("/git/repos")
 */
export function buildTable(runtime, handlers) {
  const declared = runtime.endpoints.map((e) => e.path);

  for (const key of Object.keys(handlers)) {
    if (!declared.includes(key)) {
      throw new Error(
        `router: handler for "${key}" is not declared in build.json runtime.endpoints — ` +
        'a served route nobody declared is invisible to every client (#371)',
      );
    }
  }

  return runtime.endpoints.map((e) => {
    const handler = handlers[e.path];
    if (!handler) {
      throw new Error(
        `router: build.json declares "${e.method} ${e.path}" but no handler is registered — ` +
        'a declared route that 404s is worse than an undeclared one (#371)',
      );
    }
    const local = localPath(e.path, runtime.base_path);
    return {
      method: e.method,
      declared: e.path,
      local,
      auth: e.auth,
      re: toRegex(local),
      params: paramNames(local),
      handler,
    };
  });
}

/**
 * @returns {{route: object, params: object}|null} null = no such path,
 *   {route: null, allowed: [...]} = path exists but not for this method.
 */
export function match(table, method, path) {
  const byPath = table.filter((r) => r.re.test(path));
  if (byPath.length === 0) return null;
  const exact = byPath.find((r) => r.method === method);
  if (!exact) return { route: null, allowed: byPath.map((r) => r.method) };
  const m = exact.re.exec(path);
  const params = {};
  exact.params.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
  return { route: exact, params };
}
