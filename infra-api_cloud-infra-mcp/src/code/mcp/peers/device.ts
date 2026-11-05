/**
 * Transport to the phone's on-device debug API.
 *
 * #ipc (cloud-u-android a0_docs/eng-specs/fleet-ipc.md) ONE DOOR PER PHONE: the
 * SuperApp's DevControlServer on 127.0.0.1:38080 is the only fleet app that
 * listens. It lists what is behind it at /api/fleet/apps and forwards
 * /app/<pkg>/api/<op> to that app over Android IPC (signature-checked, waking
 * the app), with the one fleet token. Older phones still run builds where
 * every app bound its own loopback port in 38090..38389: when the gateway does
 * not answer /api/fleet/apps, scan() sweeps those ports as before, and each
 * App says which way it is reached (`gateway`).
 *
 * Those sockets bind 127.0.0.1, so nothing off-device can reach them — a
 * container on oci-apps never could. We go in the way a human already does:
 * `ssh <phone>` (our Cloud Terminal (nix) sshd on :8024; <phone>-termux = the
 * termux build on :8023; each phone's mesh address comes from its wg client row,
 * see build.json ssh.phones) and curl from inside. Aliases come from build.json
 * ssh.extra_hosts; mesh only, there is no public route to the phone.
 *
 * The primitive is "run this shell script over there", not "fetch this URL",
 * because the port scan is 60 probes. One remote loop is one round trip;
 * 60 ssh invocations is a minute of handshakes.
 */
import { spawn } from "node:child_process";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The phones, in default dial order (build.json ssh.phones, ordered by
 * SUPERAPP_PHONES in compose.nix). Each alias X is dialled through the doors
 * X, X-v6, X-termux, X-termux-v6 (build.json ssh.extra_hosts is exactly that
 * expansion; test/test-superapp-hosts.sh holds the two together).
 * `local` = run here (the on-device Claude, where 127.0.0.1 already IS the phone).
 * SUPERAPP_HOSTS (a flat alias list, one phone) is still honoured for old envs.
 */
export const PHONES: string[] = (process.env.SUPERAPP_PHONES ?? process.env.SUPERAPP_HOSTS?.split(",")[0] ?? "phone2,phone1")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

/** Friendly ids accepted for `phone` besides the alias (build.json ssh.phones[].id). */
const PHONE_IDS: Record<string, string> = {
  "samsung-s21plus": "phone1", s21: "phone1", "s21plus": "phone1", termux: "phone1",
  "samsung-a37": "phone2", a37: "phone2",
};

export function phoneAlias(q: string): string {
  const k = q.trim().toLowerCase();
  const a = PHONES.includes(k) ? k : PHONE_IDS[k];
  if (!a || !PHONES.includes(a)) throw new Error(`unknown phone "${q}" — declared: ${PHONES.join(", ")}`);
  return a;
}

export function doorsOf(alias: string): string[] {
  if (alias === "local") return ["local"];
  return [alias, `${alias}-v6`, `${alias}-termux`, `${alias}-termux-v6`];
}

/** Per call: the phone asked for (null = any), and the phone that answered. */
type Ctx = { want: string | null; answered: string | null };
const ctx = new AsyncLocalStorage<Ctx>();

/** Run fn against one phone (or, with null, whichever answers first) and
 *  return its result together with the phone that answered. */
export async function onPhone<T>(phone: string | null | undefined, fn: () => Promise<T>): Promise<{ phone: string | null; value: T }> {
  const c: Ctx = { want: phone ? phoneAlias(phone) : null, answered: null };
  const value = await ctx.run(c, fn);
  return { phone: c.answered, value };
}

/** The phone this call is bound to: the one asked for, else the one that
 *  already answered in this call, else null (not decided yet). */
export function currentPhone(): string | null {
  const c = ctx.getStore();
  return c?.want ?? c?.answered ?? null;
}

/** Bind the rest of this call to one phone (the cached app list belongs to it). */
export function pinPhone(phone: string): void {
  const c = ctx.getStore();
  if (c) c.answered = phone;
}

/** Most recent successful contact per phone (ms); drives the default order. */
const lastSeen = new Map<string, number>();

export function dialOrder(want: string | null): string[] {
  if (want) return [want];
  return [...PHONES].sort((a, b) => (lastSeen.get(b) ?? 0) - (lastSeen.get(a) ?? 0));
}

const SSH_TIMEOUT_MS = Number(process.env.SUPERAPP_SSH_TIMEOUT_MS ?? 30_000);

/** Set from SuperApp → Configs → About. Absent is not fatal: /api/system/ping
 *  is open, so discovery still works and only the data routes answer 401. */
/**
 * An unexpanded ${VAR} counts as absent.
 *
 * ~/.mcp.json is rendered from a template whose placeholders the mcpSecrets
 * activation fills from sops. A key that is missing there is left VERBATIM —
 * so this arrives as the literal string "${SUPERAPP_FLEET_TOKEN}",
 * which is truthy, passes any `unset` check, and gets sent as a Bearer token
 * the phone rejects. Every data route then answers 401 with nothing anywhere
 * saying why. Treat it as the miss it is.
 */
export function fleetToken(): string {
  const raw = process.env.SUPERAPP_FLEET_TOKEN ?? "";
  return /^\$\{[A-Za-z_][A-Za-z0-9_-]*\}$/.test(raw.trim()) ? "" : raw;
}

const TOKEN = fleetToken();

export const PORT_DEVCONTROL = 38080;
/** The pre-gateway per-app range (cloud-u-android 1_cicd/src/data/debug-ports.json), swept only
 *  when the gateway does not answer: a phone whose SuperApp predates it. */
export const PORT_FIRST = 38090;
export const PORT_LAST = 38389;

const goodDoor = new Map<string, string>();

/** Single-quote for /bin/sh. Everything that reaches the remote shell goes
 *  through here — app names, paths and the fleet token all arrive from the
 *  model, and the script is the trust boundary. */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function exec(cmd: string, args: string[], stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${SSH_TIMEOUT_MS}ms`));
    }, SSH_TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err.trim() || out.trim()}`));
    });
    p.stdin.end(stdin);
  });
}

/**
 * Run a POSIX sh script on the phone and return its stdout.
 *
 * The script rides stdin rather than argv so the fleet token never appears in
 * the phone's process table.
 */
export async function run(script: string): Promise<string> {
  const c = ctx.getStore();
  const phones = c?.answered ? [c.answered] : dialOrder(c?.want ?? null);
  const errors: string[] = [];
  for (const phone of phones) {
    const doors = doorsOf(phone);
    const good = goodDoor.get(phone);
    const order = good ? [good, ...doors.filter((h) => h !== good)] : doors;
    for (const host of order) {
      try {
        const out = host === "local"
          ? await exec("sh", ["-s"], script)
          : await exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "sh", "-s"], script);
        goodDoor.set(phone, host);
        lastSeen.set(phone, Date.now());
        if (c) c.answered = phone;
        return out;
      } catch (e) {
        errors.push(`${host}: ${(e as Error).message}`);
        if (goodDoor.get(phone) === host) goodDoor.delete(phone);
      }
    }
  }
  throw new Error(`no route to ${phones.length === 1 ? `phone ${phones[0]}` : `any phone (${phones.join(", ")})`} — ${errors.join(" | ")}`);
}

export type App = {
  /** applicationId, or "" for the old DevControlServer, whose ping predates
   *  the package suffix. */
  pkg: string;
  port: number;
  /** #ipc reached through the SuperApp gateway (port = PORT_DEVCONTROL), not its own port. */
  gateway?: boolean;
};

/** The gateway's member list: one App per fleet member behind the door. Null when the
 *  gateway does not answer (no SuperApp, or one from before the gateway). */
export function parseGatewayApps(body: string): App[] | null {
  try {
    const o = JSON.parse(body);
    if (!o || !Array.isArray(o.apps)) return null;
    return o.apps
      .filter((a: { pkg?: unknown }) => typeof a.pkg === "string" && a.pkg)
      .map((a: { pkg: string }) => ({ pkg: a.pkg, port: PORT_DEVCONTROL, gateway: true }));
  } catch {
    return null;
  }
}

/** /app/<pkg>/api/<path> on the gateway, or /api/<path> on the app's own legacy port. */
export function urlOf(a: App, path: string, qs = ""): string {
  const p = path.replace(/^\/+/, "");
  const base = a.gateway ? `http://127.0.0.1:${PORT_DEVCONTROL}/app/${a.pkg}/api/${p}` : `http://127.0.0.1:${a.port}/api/${p}`;
  return base + (qs ? `?${qs}` : "");
}

/**
 * One sweep of the port range. /api/system/ping is deliberately the OPEN
 * route in AppDebugServer precisely so this works before any token exists —
 * it answers `pong <applicationId>`.
 */
export async function scan(): Promise<App[]> {
  const viaGateway = parseGatewayApps(await get(PORT_DEVCONTROL, "fleet/apps", {}, 8).catch(() => ""));
  if (viaGateway && viaGateway.length) return viaGateway;
  const script = `
for p in ${PORT_DEVCONTROL} $(seq ${PORT_FIRST} ${PORT_LAST}); do
  r=$(curl -s -m 1 "http://127.0.0.1:$p/api/system/ping" 2>/dev/null) || continue
  [ -n "$r" ] && echo "$p $r"
done
exit 0
`;
  const out = await run(script);
  const apps: App[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+pong\s*(\S*)/);
    if (m) apps.push({ port: Number(m[1]), pkg: m[2] ?? "" });
  }
  return apps;
}

/** GET /api/<path> on one port (the gateway's own routes, or a pre-gateway app's). */
export async function get(
  port: number,
  path: string,
  query: Record<string, string> = {},
  timeoutSec = 20,
): Promise<string> {
  return fetchUrl(urlOf({ pkg: "", port }, path, qs(query)), timeoutSec);
}

/** #ipc one app's route, through the gateway when that is how it was found. */
export async function call(
  a: App,
  path: string,
  query: Record<string, string> = {},
  timeoutSec = 20,
): Promise<string> {
  return fetchUrl(urlOf(a, path, qs(query)), timeoutSec);
}

function qs(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * curl one loopback URL on the phone. `path` and every query value are escaped
 * into the script; the caller has already validated `path` against the
 * route-shape allowlist in tools.ts.
 */
async function fetchUrl(url: string, timeoutSec: number): Promise<string> {
  const auth = TOKEN ? `-H "Authorization: Bearer $T" ` : "";
  const script = `
T=${sq(TOKEN)}
curl -s -m ${timeoutSec} ${auth}${sq(url)}
exit 0
`;
  return run(script);
}
