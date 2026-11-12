// Tester: gitea reverse-proxy authentication, rendered by the real generators
// and exercised in a real Caddy (the version gitea-gate pins).
//
// What it guards (each one mutation-proven when it was written):
//   1. an identity the edge validated but that has no row is REFUSED (403) on
//      both branches — never anonymous, never a default user;
//   2. trusted_proxies stays the measured edge address; a CIDR / * fails the build;
//   3. auto-registration stays off (an unmapped name must not create an account);
//   4. the user header is stripped at the edge before forward_auth, and the
//      gate drops it from every peer that is not the edge for this vhost.
//
// Needs `nix` (renders gate.nix, compose.nix, caddyfile.nix + identity.nix) and
// network on first run (nixpkgs lib at the caddy flake's locked rev, Caddy
// release). Missing tools FAIL the run; nothing is skipped quietly.
// Local overrides: NIX_BIN, NIX_STORE, NIXPKGS_LIB, CADDY_BIN.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir, arch } from "node:os";
import { join } from "node:path";
import http from "node:http";

const here = new URL(".", import.meta.url).pathname;
const caddySrc = join(here, "../../infra-sec_caddy/src");
const build = JSON.parse(readFileSync(join(here, "../build.json"), "utf8"));
const identity = build.proxy.primary.identity;
const domain: string = build.proxy.primary.domain;
const work = mkdtempSync(join(tmpdir(), "rpa-"));

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? passed++ : failed++;
};

// ── tools ─────────────────────────────────────────────────────────────────
const NIX = process.env.NIX_BIN ?? "nix";
const nixArgs = [...(process.env.NIX_STORE ? ["--store", process.env.NIX_STORE] : []),
  "--extra-experimental-features", "nix-command flakes"];
const nixEval = (expr: string, json = false): string =>
  execFileSync(NIX, [...nixArgs, "eval", "--impure", json ? "--json" : "--raw", "--expr", expr],
    { encoding: "utf8", cwd: here, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
const nixThrows = (expr: string): boolean => { try { nixEval(expr); return false; } catch { return true; } };

const lockedRev = JSON.parse(readFileSync(join(caddySrc, "flake.lock"), "utf8")).nodes.nixpkgs.locked.rev;
const libExpr = process.env.NIXPKGS_LIB
  ? `import ${process.env.NIXPKGS_LIB}`
  : `import "\${builtins.fetchTarball "https://github.com/NixOS/nixpkgs/archive/${lockedRev}.tar.gz"}/lib"`;
const buildExpr = `(builtins.fromJSON (builtins.readFile ${join(here, "../build.json")}))`;

const caddyVersion = String(build.gitea.gate.image).match(/^caddy:(\d+\.\d+\.\d+)/)?.[1];
function caddyBin(): string {
  if (process.env.CADDY_BIN) return process.env.CADDY_BIN;
  const a = arch() === "arm64" ? "arm64" : "amd64";
  execFileSync("sh", ["-c", `curl -fsSL https://github.com/caddyserver/caddy/releases/download/v${caddyVersion}/caddy_${caddyVersion}_linux_${a}.tar.gz | tar xz -C ${work} caddy`]);
  chmodSync(join(work, "caddy"), 0o755);
  return join(work, "caddy");
}

// ── tiny servers ──────────────────────────────────────────────────────────
type Seen = { user: string | null; realIp: string | null; authz: string | null };
const echo = (h: http.IncomingHttpHeaders): Seen => ({
  user: (h[identity.header.toLowerCase()] as string) ?? null,
  realIp: (h["x-real-ip"] as string) ?? null,
  authz: (h["authorization"] as string) ?? null,
});
const listen = (s: http.Server, where: number | string) =>
  new Promise<void>((r) => (typeof where === "number" ? s.listen(where, "127.0.0.1", () => r()) : s.listen(where, () => r())));
const port = (s: http.Server) => (s.address() as { port: number }).port;

function req(p: number, path: string, headers: Record<string, string>, localAddress = "127.0.0.1"):
  Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port: p, path, headers, localAddress }, (resp) => {
      let body = ""; resp.on("data", (c) => (body += c)); resp.on("end", () => res({ status: resp.statusCode ?? 0, body }));
    });
    r.on("error", rej); r.end();
  });
}
async function startCaddy(config: string, p: number) {
  const file = join(work, `Caddyfile.${p}`);
  writeFileSync(file, config);
  execFileSync(caddy, ["validate", "--config", file, "--adapter", "caddyfile"], { stdio: "pipe" });
  const proc = spawn(caddy, ["run", "--config", file, "--adapter", "caddyfile"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try { await req(p, "/", {}); return proc; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  proc.kill(); throw new Error(`caddy did not listen on ${p}`);
}
const freePort = async () => { const s = http.createServer(); await listen(s, 0); const p = port(s); s.close(); return p; };

let caddy = "";
const procs: ReturnType<typeof spawn>[] = [];
const servers: http.Server[] = [];
try {
  caddy = caddyBin();
  t(`caddy ${caddyVersion} available`, execFileSync(caddy, ["version"], { encoding: "utf8" }).startsWith(`v${caddyVersion}`));

  // ── 2 + 3: declarations the gitea container actually gets ──────────────
  t("trusted_proxies is exactly the measured edge (10.0.0.1)",
    JSON.stringify(build.gitea.gate.trusted_proxies) === JSON.stringify(["10.0.0.1"]),
    JSON.stringify(build.gitea.gate.trusted_proxies));
  const widened = (list: string) =>
    `let b = ${buildExpr}; in import ./gate.nix (b // { gitea = b.gitea // { gate = b.gitea.gate // { trusted_proxies = ${list}; }; }; })`;
  t("gate.nix refuses a CIDR in trusted_proxies (build fails)", nixThrows(widened(`[ "10.0.0.0/24" ]`)));
  t("gate.nix refuses * in trusted_proxies (build fails)", nixThrows(widened(`[ "*" ]`)));
  t("gate.nix refuses an empty trusted_proxies (build fails)", nixThrows(widened(`[ ]`)));

  const compose = JSON.parse(nixEval(`import ./compose.nix { buildJson = ${buildExpr}; container = {}; }`, true));
  const env = compose.services.gitea.environment;
  t("gitea: reverse-proxy auto-registration is OFF", env.GITEA__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION === "false");
  t("gitea: reverse-proxy auth on for web and API",
    env.GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION === "true" && env.GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION_API === "true");
  t("gitea: user header is the declared one", env.GITEA__security__REVERSE_PROXY_AUTHENTICATION_USER === identity.header);
  t("gitea: HTTP only on the gate's unix socket",
    env.GITEA__server__PROTOCOL === "http+unix" && env.GITEA__server__HTTP_ADDR === build.gitea.gate.socket);
  t("gitea: trusts only the gate (unix peer = 127.0.0.1) for client IP", env.GITEA__security__REVERSE_PROXY_TRUSTED_PROXIES === "127.0.0.1/32");
  t("gitea: ROOT_URL projection pinned (PUBLIC_URL_DETECTION=never)", env.GITEA__server__PUBLIC_URL_DETECTION === "never");
  const sockVol = (v: string) => v.startsWith("gitea_http:");
  t("socket volume is mounted by gitea and gitea-gate only",
    Object.entries(compose.services).filter(([, s]: [string, any]) => (s.volumes ?? []).some(sockVol)).map(([n]) => n).sort().join(",") === "gitea,gitea-gate");

  // ── 4 (gitea side): the gate in a real Caddy ───────────────────────────
  const gatePort = await freePort();
  const sock = join(work, "gitea.sock");
  const giteaStub = http.createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify(echo(q.headers))); });
  servers.push(giteaStub); await listen(giteaStub, sock);
  const gateCfg = nixEval(`let b = ${buildExpr}; in import ./gate.nix (b // {
    ports = b.ports // { app = ${gatePort}; };
    gitea = b.gitea // { gate = b.gitea.gate // { trusted_proxies = [ "127.0.0.2" ]; socket = "${sock}"; }; };
  })`);
  procs.push(await startCaddy(gateCfg, gatePort));
  const spoof = { [identity.header]: "diego", "X-Real-IP": "6.6.6.6" };
  const gate = async (from: string, host: string) => JSON.parse((await req(gatePort, "/api/v1/user", { Host: host, ...spoof }, from)).body) as Seen;
  let seen = await gate("127.0.0.1", domain);
  t("gate: non-edge peer, right Host -> user header and X-Real-IP dropped", seen.user === null && seen.realIp === null, JSON.stringify(seen));
  seen = await gate("127.0.0.2", "gitea.mesh.diegonmarcos.com");
  t("gate: edge peer via the .app catalog Host -> dropped", seen.user === null && seen.realIp === null, JSON.stringify(seen));
  seen = await gate("127.0.0.2", domain);
  t("gate: edge peer for the vhost -> forwarded", seen.user === "diego" && seen.realIp === "6.6.6.6", JSON.stringify(seen));

  // ── 1 + 4 (edge side): the hub's real git vhost in a real Caddy ─────────
  const [bearerId, mappedUser] = Object.entries(identity.bearer as Record<string, string>)[0];
  const [sessionId, sessionUser] = Object.entries(identity.session as Record<string, string>)[0];
  const introspect = http.createServer((q, s) => {
    const a = q.headers.authorization ?? "";
    if (a === "Bearer mapped") s.setHeader("X-Auth-User", bearerId);
    else if (a === "Bearer unmapped") s.setHeader("X-Auth-User", "not-a-mapped-client");
    else if (a !== "Bearer noclient") { s.statusCode = 401; return s.end("Invalid token"); }
    s.end("OK");
  });
  const authelia = http.createServer((q, s) => {
    const c = q.headers.cookie ?? "";
    if (c === "s=owner") s.setHeader("Remote-User", sessionId);
    else if (c === "s=guest") s.setHeader("Remote-User", "guest@example.invalid");
    else { s.statusCode = 302; s.setHeader("Location", "https://auth.example.invalid/"); return s.end(); }
    s.end("OK");
  });
  const upstream = http.createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify(echo(q.headers))); });
  for (const s of [introspect, authelia, upstream]) { servers.push(s); await listen(s, 0); }

  const fixture = JSON.parse(readFileSync(join(here, "test-reverse-proxy-auth.fixture.json"), "utf8"));
  fixture.auth_upstreams.introspect_proxy = `127.0.0.1:${port(introspect)}`;
  // The edge auth policy has ONE declaration (infra-sec_caddy/build.json
  // caddy_config.edge_auth); the renderer refuses to render without it, so the
  // fixture takes it from there instead of keeping a second copy that rots.
  fixture.edge_auth = JSON.parse(readFileSync(join(caddySrc, "../build.json"), "utf8")).caddy_config.edge_auth;
  // The renderer fails closed when the fleet-addressing c3-pub sinks name a c3-pvt container that has no
  // route (caddyfile.nix mkPubSink). The fixture used to hold only the gitea route, so adding a sink in
  // fleet-addressing.json (9ddf950, c3-public-api) made every render here throw. Declare a stub route for
  // each sink container, read from the same file the renderer reads, instead of keeping a second list.
  const sinkContainers = new Set<string>(Object.values(
    JSON.parse(readFileSync(join(here, "../../_shared/fleet-addressing.json"), "utf8")).tiers?.pub?.sinks ?? {})
    .filter((x: any) => x && typeof x === "object" && x.container).map((x: any) => x.container));
  // Same fail-closed rule for the c3-pvt path aliases (caddyfile.nix c3PvtAliases, e.g. /ai -> cloudy-ai-api, #1450):
  // each alias container needs a route, so stub one per alias, read from the renderer's own declaration.
  const aliasDecl = /c3PvtAliases\s*=\s*\[([\s\S]*?)\];/.exec(readFileSync(join(caddySrc, "caddyfile.nix"), "utf8"));
  for (const m of (aliasDecl?.[1] ?? "").matchAll(/container\s*=\s*"([^"]+)"/g)) sinkContainers.add(m[1]);
  fixture.routes = [{ domain, upstream: `127.0.0.1:${port(upstream)}`,
    strip_authorization: build.proxy.primary.strip_authorization, identity },
    ...[...sinkContainers].map((container, i) => ({ domain: `sink${i}.example.invalid`, container, upstream: "127.0.0.1:9" }))];
  const fixtureFile = join(work, "routes.json");
  writeFileSync(fixtureFile, JSON.stringify(fixture));
  const hub = nixEval(`import ${caddySrc}/caddyfile.nix { lib = ${libExpr}; caddyRoutes = builtins.fromJSON (builtins.readFile ${fixtureFile}); }`);
  // The block that opens at `head` (e.g. `\n  git.example {` or `\n  (edge_auth) {`), brace-matched.
  const blockAt = (head: string): string => {
    const start = hub.indexOf(head);
    if (start < 0) return "";
    let depth = 0, end = start + 1;
    for (let i = start + 1; i < hub.length; i++) {
      if (hub[i] === "{") depth++;
      if (hub[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    return hub.slice(start, end);
  };
  const vhost = blockAt(`\n  ${domain} {`);
  // The shared edge auth gate is a snippet the vhost IMPORTS (edge_auth, since the
  // one-shared-gate change), so the harness must carry the real snippet or it would
  // be testing a Caddyfile the hub no longer renders. Take every snippet the vhost
  // imports, transitively, from the rendered hub; the stubs below cover the rest.
  const stubbed = new Set(["security", "request_limits"]);
  const snippets: string[] = [], imported = new Set<string>();
  const want = [vhost];
  while (want.length) {
    for (const m of want.pop()!.matchAll(/^\s*import\s+([A-Za-z0-9_]+)/gm)) {
      const name = m[1];
      if (stubbed.has(name) || imported.has(name)) continue;
      imported.add(name);
      const b = blockAt(`\n  (${name}) {`);
      if (b) { snippets.push(b); want.push(b); }
    }
  }
  // A snippet may `invoke` a named route (&(name) { ... }, the shared error pages of (edge_errors)): the
  // harness must carry it too, or caddy refuses the config ("cannot invoke named route ... not defined").
  for (const b of [...snippets]) {
    for (const m of b.matchAll(/^\s*invoke\s+([A-Za-z0-9_]+)/gm)) {
      const r = blockAt(`\n  &(${m[1]}) {`);
      if (r && !snippets.includes(r)) snippets.push(r);
    }
  }
  t("hub: the vhost's gate snippet (edge_auth) is rendered by the hub", snippets.some((b) => b.includes("(edge_auth)")));
  t("hub: user header stripped at site level, before any handle / forward_auth",
    new RegExp(`request_header -${identity.header}\\n`).test(vhost) &&
    vhost.indexOf(`request_header -${identity.header}`) < vhost.indexOf("forward_auth"));
  const hubPort = await freePort();
  const harness = `{\n  admin off\n  auto_https off\n  order respond before handle\n  order error before handle\n}\n(security) {\n}\n(request_limits) {\n}\n` +
    (snippets.join("\n") + "\n" + vhost.replace(`${domain} {`, `http://${domain}:${hubPort} {`)
      .replace(/^\s*bind .*$/m, "  bind 127.0.0.1"))
      .replaceAll("172.18.0.3:9091", `127.0.0.1:${port(authelia)}`);
  procs.push(await startCaddy(harness, hubPort));
  const hubReq = (h: Record<string, string>) => req(hubPort, "/api/v1/user", { Host: domain, ...h });
  const ok = async (name: string, h: Record<string, string>, want: string) => {
    const r = await hubReq(h); let s: Seen | null = null; try { s = JSON.parse(r.body); } catch { /* not the upstream */ }
    t(name, r.status === 200 && s?.user === want && s?.authz === null, `${r.status} ${r.body.slice(0, 120)}`);
  };
  const refused = async (name: string, h: Record<string, string>, code = 403) => {
    const r = await hubReq(h);
    t(name, r.status === code && !r.body.includes('"user"'), `${r.status} ${r.body.slice(0, 120)}`);
  };
  await ok("hub: mapped bearer -> upstream user, bearer withheld", { Authorization: "Bearer mapped" }, mappedUser);
  await ok("hub: mapped bearer + forged user header -> forged value replaced", { Authorization: "Bearer mapped", [identity.header]: "root" }, mappedUser);
  await refused("hub: UNMAPPED bearer -> 403, not anonymous", { Authorization: "Bearer unmapped" });
  await refused("hub: unmapped bearer + forged user header -> 403", { Authorization: "Bearer unmapped", [identity.header]: mappedUser });
  await refused("hub: bearer with no client_id + forged X-Auth-User -> 403", { Authorization: "Bearer noclient", "X-Auth-User": bearerId });
  await ok("hub: mapped Authelia session -> upstream user", { Cookie: "s=owner" }, sessionUser);
  await ok("hub: mapped session + forged user header -> forged value replaced", { Cookie: "s=owner", [identity.header]: "root" }, sessionUser);
  await refused("hub: UNMAPPED Authelia user -> 403", { Cookie: "s=guest" });
  await refused("hub: session forging Remote-User -> still its own identity", { Cookie: "s=guest", "Remote-User": sessionId });
  await refused("hub: anonymous (forged header, no credential) -> portal redirect", { [identity.header]: mappedUser }, 302);

  t("identity.nix refuses a `default` row (Caddy map fallback = a default user)",
    nixThrows(`(import ${caddySrc}/identity.nix { identity = { header = "X"; bearer = { default = "diego"; }; }; }).bearer`));
} catch (e) {
  t("tester ran to completion", false, String((e as Error).message ?? e).slice(0, 400));
} finally {
  for (const p of procs) p.kill();
  for (const s of servers) s.close();
}

console.log(`${passed} passed, ${failed} failed`);
if (failed || passed < 20) { console.error(failed ? `${failed} check(s) failed` : `only ${passed} checks ran`); process.exit(1); }
process.exit(0);
