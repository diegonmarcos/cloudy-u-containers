// Tester: init-mirrors.sh converges PRIVATE mirrors to non-empty, or fails.
//
// 13 private gitea mirrors were empty for their whole life (anonymous clone of
// a private upstream, mirror_updated=0001-01-01) while every ship's post-hook
// said `mirrors_exists=34 mirrors_degraded=0` and exited 0: an existing mirror
// was never looked at again. And the vault, renamed on GitHub from cloud-vault
// to cloud-me-pvt-vault, sat in the derived mirror set because the exclusion only
// knew the old name — one token away from being copied into gitea.
//
// This renders templates/init-mirrors.sh.tpl exactly as _shared/engine.nix
// does (plain @VAR@ substitution, vars computed from build.json the way
// flake.nix computes them) and runs it against a stub gitea: a fake `curl` and
// `docker` on PATH, repo state kept as files. No nix, no network.
//
// Guards (each mutation-proven when written):
//   G1 existing private EMPTY mirror + token  -> deleted, re-migrated WITH auth_token, exit 0
//   G2 existing private EMPTY mirror, no token -> exit 1 (was: EXISTS, exit 0)
//   G3 authenticated migrate that comes back empty -> exit 1 (was: OK)
//   G4 an excluded name still in the derived set is deleted and never migrated
//   G5 a populated mirror is left alone (no DELETE, no migrate)
//   G6 secrets.yaml declares GITHUB_MIRROR_TOKEN (G2 would fail every ship otherwise)
//   G7 every name in build.json exclude gets a remove_excluded call
//   G8 live admin password != declared -> change-password as `git`, then exit 0 with live == declared
//   G9 change-password that does not take effect -> exit 1 (was: never checked)
//   G10 live == declared -> no change-password call (idempotent)
//   G11 the declared password never reaches curl argv nor the script's output
//   G12 admin create failing for any reason but "already exists" -> exit 1 (was: swallowed)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const build = JSON.parse(readFileSync(join(here, "../build.json"), "utf8"));
const tpl = readFileSync(join(here, "templates/init-mirrors.sh.tpl"), "utf8");
const exclude: string[] = build.gitea.mirror_policy.exclude ?? [];

let passed = 0, failed = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  — ${detail}`}`);
  ok ? passed++ : failed++;
};

for (const tool of ["bash", "jq"]) {
  const r = spawnSync("sh", ["-c", `command -v ${tool}`]);
  if (r.status !== 0) { console.log(`FAIL  ${tool} is required`); process.exit(1); }
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`; // lib.escapeShellArg
type Mirror = { name: string; upstream: string; private: boolean };

function render(mirrors: Mirror[]): string {
  const vars: Record<string, string> = {
    PORT_HTTP: String(build.ports.app),
    CONTAINER_NAME: build.containers.app.container_name,
    ORG: build.gitea.org,
    MIRROR_INTERVAL: build.gitea.mirror_interval,
    EXCLUDE_NAMES: exclude.join(" "),
    EXCLUDE_BLOCK: exclude.map((n) => `remove_excluded ${q(n)}`).join("\n"),
    MIRROR_BLOCK: mirrors.map((m) => `converge_mirror ${q(m.name)} ${q(m.upstream)} ${m.private}`).join("\n"),
  };
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) out = out.split(`@${k}@`).join(v);
  return out;
}

// Stub gitea. state/<repo>.json = the repo as GET returns it. Every mutating
// call is appended to calls.log. MIGRATE_EMPTY=1 makes a migrate return empty.
// The admin password lives in state/.live-pw; GET /user answers 200 only for a
// `-K -` config carrying it. argv of every curl call goes to curl-argv.log.
const CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STATE/../curl-argv.log"
method=GET; data=""; url=""; fmt=""; cfg=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) data="$2"; shift 2 ;;
    -K) [ "$2" = - ] && cfg=$(cat); shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H|-u|-o) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
path="\${url#*/api/v1}"
# Real gate behaviour: until gitea has its socket, EVERY call is a 502. The
# socket "appears" once /api/healthz has been polled HEALTH_DOWN_N times.
n=$(cat "$STATE/.health-n" 2>/dev/null || echo 0)
down=0; [ "\${HEALTH_NEVER:-0}" = 1 ] && down=1; [ "$n" -lt "\${HEALTH_DOWN_N:-0}" ] && [ "\${HEALTH_DOWN_N:-0}" != 0 ] && down=1
case "$method $path" in
  "GET "*"/api/healthz")
    echo $((n+1)) > "$STATE/.health-n"; echo healthz >> "$STATE/../health-calls.log"
    code=200; [ "$down" = 1 ] && code=502
    [ -n "$fmt" ] && printf '%s' "$code"; [ "$code" = 200 ] && exit 0; exit 22 ;;
esac
if [ "$down" = 1 ]; then [ -n "$fmt" ] && printf '502'; exit 22; fi
case "$method $path" in
  "GET /user")
    code=401; [ "$cfg" = "user = \\"diego:$(cat "$STATE/.live-pw")\\"" ] && code=200
    [ -n "$fmt" ] && printf '%s' "$code"; [ "$code" = 200 ] || exit 22 ;;
  "POST /users/"*"/tokens") echo '{"sha1":"stub-admin-token"}' ;;
  "GET /users/"*) echo '{}' ;;
  "GET /repos/"*)
    f="$STATE/\${path##*/}.json"; [ -f "$f" ] || exit 22; cat "$f" ;;
  "DELETE /repos/"*)
    f="$STATE/\${path##*/}.json"; [ -f "$f" ] || exit 22
    echo "DELETE \${path##*/}" >> "$CALLS"; rm -f "$f" ;;
  "POST /repos/migrate")
    name=$(printf '%s' "$data" | jq -r .repo_name)
    auth=$(printf '%s' "$data" | jq -r 'if .auth_token then "auth" else "anon" end')
    echo "MIGRATE $name $auth" >> "$CALLS"
    empty=true; [ "$auth" = auth ] && [ "\${MIGRATE_EMPTY:-0}" != 1 ] && empty=false
    printf '{"name":"%s","empty":%s,"private":%s,"mirror":true}' "$name" "$empty" \\
      "$(printf '%s' "$data" | jq .private)" | tee "$STATE/$name.json" ;;
  *) exit 22 ;;
esac
`;

// Stub `docker exec`: gitea's CLI refuses root, so a call without `-u git`
// fails as the real one does. `-e NAME` forwards NAME from the caller's env (as
// docker does: the value is never on docker's argv). A command is either the
// image's `gitea` binary directly or `sh -c SCRIPT argv0 args...`, run for real
// so the in-container expansion of the password is exercised. The fake `gitea`
// logs its own argv (inside-container argv, password redacted) to gitea.log;
// change-password writes state/.live-pw unless CHPW_NOOP=1; `create` reports
// the existing admin.
const DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$STATE/../docker.log"
[ "$1 $2 $3" = "exec -u git" ] || { echo "Gitea is not supposed to be run as root" >&2; exit 1; }
shift 3
while [ "$1" = -e ]; do shift 2; done
shift   # container name
if [ "$1 $2" = "sh -c" ]; then exec sh -c "$3" "\${@:4}"; fi
exec gitea "$@"
`;
const GITEA = `#!/usr/bin/env bash
# fake gitea binary: argv of the in-container process, password redacted
printf '%s\\n' "$*" | sed "s|$(cat "$STATE/../declared-pw")|<PW>|g" >> "$STATE/../gitea.log"
[ "$1 $2" = "admin user" ] || exit 0
case "$3" in
  create)
    [ "\${CREATE_FAIL:-0}" = 1 ] && { echo "database is locked" >&2; exit 1; }
    echo "user already exists [name: diego]" >&2; exit 1 ;;
  change-password)
    pw=""; for a in "$@"; do case "$a" in --password=*) pw="\${a#--password=}" ;; esac; done
    [ "\${CHPW_NOOP:-0}" = 1 ] || printf '%s' "$pw" > "$STATE/.live-pw" ;;
esac
`;
const DECLARED_PW = "Decl4redPw-sentinel";
type Run = { code: number; gitea: string[]; health: string[]; src: string; out: string; calls: string[]; docker: string[]; curlArgv: string[]; livePw: string };
function run(mirrors: Mirror[], existing: Record<string, object>, env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "init-mirrors-"));
  const bin = join(dir, "bin"), state = join(dir, "state"), configs = join(dir, "configs");
  for (const d of [bin, state, configs]) mkdirSync(d);
  writeFileSync(join(bin, "curl"), CURL); chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(bin, "docker"), DOCKER); chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(join(bin, "gitea"), GITEA); chmodSync(join(bin, "gitea"), 0o755);
  writeFileSync(join(dir, "declared-pw"), DECLARED_PW);
  writeFileSync(join(state, ".live-pw"), env.LIVE_PW ?? DECLARED_PW);
  for (const [n, meta] of Object.entries(existing)) writeFileSync(join(state, `${n}.json`), JSON.stringify(meta));
  writeFileSync(join(dir, ".secrets"), `GITEA_ADMIN_USER=diego\nGITEA_ADMIN_PASSWORD=${DECLARED_PW}\nGITEA_ADMIN_EMAIL=x@y\n`);
  const script = join(configs, "init-mirrors.sh");
  writeFileSync(script, render(mirrors)); chmodSync(script, 0o755);
  const calls = join(dir, "calls.log"); writeFileSync(calls, "");
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, STATE: state, CALLS: calls,
           INIT_MIRRORS_READY_STEP: "0", INIT_MIRRORS_READY_TRIES: "8", ...env },
  });
  const lines = (f: string) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
  return { gitea: lines(join(dir, "gitea.log")), health: lines(join(dir, "health-calls.log")), src: readFileSync(script, "utf8"),
           code: r.status ?? -1, out: r.stdout + r.stderr, calls: lines(calls),
           docker: lines(join(dir, "docker.log")), curlArgv: lines(join(dir, "curl-argv.log")),
           livePw: readFileSync(join(state, ".live-pw"), "utf8") };
}

const up = (n: string) => `https://github.com/diegonmarcos/${n}.git`;
const priv = (n: string): Mirror => ({ name: n, upstream: up(n), private: true });
const pub = (n: string): Mirror => ({ name: n, upstream: up(n), private: false });
const emptyPriv = { empty: true, private: true, mirror: true, size: 0 };
const TOKEN = { GITHUB_MIRROR_TOKEN: "stub-github-token" };

// G1
{
  const r = run([priv("cloud-data")], { "cloud-data": emptyPriv }, TOKEN);
  t("G1 empty private mirror + token: exit 0", r.code === 0, r.out.slice(-400));
  t("G1 ... deleted then migrated with auth_token",
    r.calls.join("|") === "DELETE cloud-data|MIGRATE cloud-data auth", r.calls.join("|"));
}
// G2
{
  // A populated sibling, so "converged nothing" cannot be what turns it red.
  const r = run([priv("cloud-data"), pub("back-api")],
    { "cloud-data": emptyPriv, "back-api": { empty: false, private: false } }, {});
  t("G2 empty private mirror, no token: exit 1", r.code === 1, `code=${r.code}`);
  t("G2 ... and it is the degraded verdict that fails it",
    /FAILED: 1 private mirror\(s\) empty for want of GITHUB_MIRROR_TOKEN/.test(r.out), r.out.slice(-300));
}
// G3
{
  const r = run([priv("cloud-notes")], {}, { ...TOKEN, MIGRATE_EMPTY: "1" });
  t("G3 authenticated migrate that stays empty: exit 1", r.code === 1, `code=${r.code}`);
}
// G4 — every excluded name, present in gitea AND still in the derived set
{
  const existing = Object.fromEntries(exclude.map((n) => [n, emptyPriv]));
  const r = run([...exclude.map(priv), pub("back-api")], existing, TOKEN);
  const migrated = r.calls.filter((c) => c.startsWith("MIGRATE ")).map((c) => c.split(" ")[1]);
  t("G4 excluded names are never migrated", exclude.every((n) => !migrated.includes(n)), r.calls.join("|"));
  t("G4 ... and are deleted", exclude.every((n) => r.calls.includes(`DELETE ${n}`)), r.calls.join("|"));
  t("G4 ... and the run still converges", r.code === 0, r.out.slice(-300));
}
// G5
{
  const r = run([priv("dev"), pub("back-api")],
    { dev: { empty: false, private: true }, "back-api": { empty: false, private: false } }, TOKEN);
  t("G5 populated mirrors untouched", r.code === 0 && r.calls.length === 0, r.calls.join("|"));
}
// G6
{
  // #1064: the sops file lives only in the private vault (overlaid at ship time); a public checkout has none, so this check passes there
  const secPath = join(here, "secrets.yaml");
  const sec = existsSync(secPath) ? readFileSync(secPath, "utf8") : null;
  t("G6 secrets.yaml declares GITHUB_MIRROR_TOKEN (sops), when the vault overlay is present",
    sec === null || /^GITHUB_MIRROR_TOKEN: ENC\[AES256_GCM,/m.test(sec));
}
// G7
{
  const s = render([]);
  t("G7 every exclude entry renders a remove_excluded call",
    exclude.length > 0 && exclude.every((n) => s.includes(`remove_excluded ${q(n)}`)));
}

// G8
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { LIVE_PW: "leaked-old" });
  const chpw = r.docker.filter((c) => c.includes(" change-password "));
  t("G8 drifted admin password: change-password applied", chpw.length === 1, r.docker.join("|"));
  t("G8 ... as git, with must-change-password off",
    chpw.length === 1 && chpw[0].startsWith("exec -u git ")
      && r.gitea.some((g) => g.startsWith("admin user change-password ") && g.includes("--must-change-password=false")),
    chpw.join("|") + " // " + r.gitea.join("|"));
  t("G8 ... and live == declared, exit 0", r.livePw === DECLARED_PW && r.code === 0, `code=${r.code} ${r.out.slice(-300)}`);
}
// G9
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { LIVE_PW: "leaked-old", CHPW_NOOP: "1" });
  t("G9 change-password that does not take effect: exit 1", r.code === 1, `code=${r.code}`);
  t("G9 ... with the declared-still-rejected verdict", /still rejected after change-password/.test(r.out), r.out.slice(-300));
}
// G10
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, {});
  t("G10 live == declared: no change-password call",
    r.code === 0 && !r.docker.some((c) => c.includes(" change-password ")), r.docker.join("|"));
}
// G11 — includes a run that mints the API token with the password
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { LIVE_PW: "leaked-old" });
  t("G11 the token POST ran (covers the password-bearing path)",
    r.curlArgv.some((a) => a.includes("/tokens")), r.curlArgv.join("|"));
  t("G11 password absent from curl argv", !r.curlArgv.some((a) => a.includes(DECLARED_PW)),
    r.curlArgv.filter((a) => a.includes(DECLARED_PW)).join("|").replaceAll(DECLARED_PW, "<PW>"));
  t("G11 password absent from hook output", !r.out.includes(DECLARED_PW));
}

// G12
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { CREATE_FAIL: "1" });
  t("G12 admin create failing for another reason: exit 1", r.code === 1 && /admin user create/.test(r.out), `code=${r.code}`);
}

// G13 — the password is never on ANY argv: not curl's, not docker's, and the
// rendered script holds no `--password <$var>` (the ship gate's argv-pass rule)
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { LIVE_PW: "leaked-old" });
  t("G13 password absent from docker argv", !r.docker.some((c) => c.includes(DECLARED_PW)),
    r.docker.join("|").replaceAll(DECLARED_PW, "<PW>"));
  t("G13 ... docker forwards it by name (-e GITEA_ADMIN_PASSWORD)",
    r.docker.some((c) => c.includes(" -e GITEA_ADMIN_PASSWORD ")), r.docker.join("|"));
  t("G13 ... and it still reaches the in-container CLI (live == declared)", r.livePw === DECLARED_PW && r.code === 0);
  const offenders = r.src.split("\n").filter((l) => !/^\s*#/.test(l))
    .filter((l) => /(--password|--token|--secret|--api-key)\s+["']?\$/.test(l) && !l.includes("GITEA_OIDC_CLIENT_SECRET"));
  t("G13 rendered script has no argv-pass offender (ship gate rule)", offenders.length === 0, offenders.join("|"));
}
// G14 — gitea-gate answers 502 until gitea has its socket: the hook waits for it
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { LIVE_PW: "leaked-old", HEALTH_DOWN_N: "3" });
  t("G14 gate 502 at hook start: waits on /api/healthz (not /api/v1), then converges, exit 0",
    r.code === 0 && r.health.length === 4 && r.livePw === DECLARED_PW, `code=${r.code} polls=${r.health.length} ${r.out.slice(-300)}`);
  t("G14 ... and no admin call is made before the gate is ready",
    !/still rejected|HTTP 502/.test(r.out), r.out.slice(-300));
}
// G15 — gitea never becomes ready: fail with that reason, not a bogus password verdict
{
  const r = run([pub("back-api")], { "back-api": { empty: false, private: false } }, { HEALTH_NEVER: "1" });
  t("G15 gate 502 forever: exit 1 naming readiness", r.code === 1 && /gitea not ready via the gate/.test(r.out), `code=${r.code} ${r.out.slice(-300)}`);
  t("G15 ... without trying change-password", !r.docker.some((c) => c.includes(" change-password ")), r.docker.join("|"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
