/**
 * peers-control: the phone tools of cloudy-c3-mcp (#1495), merged from cloudy-android-mcp (cloud-superapp-mcp), registered as
 * `peers.<method>` into the ONE c3 registry (legacy name `superapp_<method>`, served by the `superapp` alias dispatcher).
 *
 * Deliberately NOT one tool per app, and not tools generated from each app's /api/docs: an MCP tool is {name, schema, call}, and a
 * fixed set that takes `app` as an argument survives a phone that is asleep. peers.call is the escape hatch that keeps this file
 * from ever needing to know about a new app route; peers.docs is how it stays discoverable. The privileged plane (shell, logcat_full,
 * grant, force_stop, input, screencap, adb_*) wraps the SuperApp's adb/exec door (uid 2000: Shizuku, embedded adb or the
 * bootstrapped shell server) with typed arguments and a verb allowlist.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { App, PHONES, PORT_DEVCONTROL, call, currentPhone, dialOrder, get, onPhone, pinPhone, scan } from "../peers/device.js";
import { loadModules, type AppModule } from "../peers/registry.js";
import { PKG_RE, ROUTE_RE, checkShell, inputArgsOk, label, logcatFullCmd, resolveApp, stamp } from "../peers/core.js";

/** Last sweep per phone alias. */
const cache = new Map<string, App[]>();
let modules: AppModule[] = [];
let modulesLoaded: Promise<void> | null = null;

/** The app modules (peers/modules/<id>/), loaded once on first use: the registry is built synchronously. */
async function ensureModules(): Promise<void> {
  modulesLoaded ??= loadModules().then((m) => { modules = m; });
  await modulesLoaded;
}

/** mcps-apps/<id>/ → applicationId. Lets a human say "cloud-mail" where the
 *  device only knows com.diegonmarcos.comms.mail, and it works from the
 *  module list alone — no round trip to a phone that may be asleep. */
function aliasToPkg(q: string): string | null {
  const m = modules.find((x) => x.id.toLowerCase() === q.toLowerCase());
  return m && m.pkg ? m.pkg : null;
}

async function apps(refresh = false): Promise<App[]> {
  await ensureModules();
  // Unbound call: reuse the sweep of the phone that answered most recently,
  // and bind the call to that phone so the app list and the route agree.
  let phone = currentPhone();
  if (!phone && !refresh) {
    const recent = dialOrder(null).find((p) => cache.has(p));
    if (recent) { pinPhone(recent); phone = recent; }
  }
  if (!refresh && phone && cache.has(phone)) return cache.get(phone)!;
  const list = await scan();
  const answered = currentPhone();
  if (answered) cache.set(answered, list);
  return list;
}

export { ROUTE_RE, label };

/** An app of the phone by port, applicationId or any unambiguous substring, with the module aliases (peers/modules) applied. */
export function resolve(list: App[], query: string): App {
  return resolveApp(list, query, aliasToPkg);
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s || "(empty response)" }] });

const PHONE_ARG = z
  .string()
  .optional()
  .describe(`Which phone to dial: ${PHONES.join(", ")} (alias, or its id e.g. samsung-a37). Omit for the phone seen online most recently.`);

type Out = { content: { type: "text"; text: string }[] };

/** server.tool with a `phone` argument added, the handler run bound to that
 *  phone, and the answering phone stamped on the result. With `fanOut`, an
 *  omitted phone means EVERY declared phone, each reported separately. */
function phoneTool(server: McpServer) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (name: string, desc: string, shape: Record<string, z.ZodTypeAny>, handler: (a: any) => Promise<Out>, fanOut = false) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server.tool(name, desc, { ...shape, phone: PHONE_ARG }, (async (args: any) => {
      const { phone, ...rest } = args ?? {};
      if (!phone && fanOut) {
        const parts = await Promise.all(PHONES.map(async (p) => {
          try { const r = await onPhone(p, () => handler(rest)); return stamp(r.phone ?? p, r.value).content[0].text; }
          catch (e) { return `[phone: ${p}]\nunreachable: ${(e as Error).message}`; }
        }));
        return text(parts.join("\n\n"));
      }
      const r = await onPhone(phone ?? null, () => handler(rest));
      return stamp(r.phone, r.value);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
}

export function registerPeersControlTools(server: McpServer): void {
  const tool = phoneTool(server);

  tool(
    "peers.apps",
    "List every constellation app behind each phone's debug API: through the SuperApp gateway (one port, every member reached over Android IPC, woken on demand) or, on an older phone, each app's own loopback port. applicationId, door, label, version and device. Without `phone` it lists EVERY declared phone, each under its own [phone: …] header. Start here — the other tools take one of these as `app`.",
    {
      refresh: z.boolean().optional().describe("Re-scan the port range instead of using the cached sweep"),
    },
    async ({ refresh }) => {
      const list = await apps(refresh ?? false);
      if (!list.length) return text("no app is serving the debug API right now");
      const rows = await Promise.all(
        list.map(async (a) => {
          const info = await call(a, "system/info", {}, 8).catch(() => "");
          return { port: a.gateway ? `gateway :${a.port}` : a.port, name: label(a), info: info.trim() || "(needs SUPERAPP_FLEET_TOKEN)" };
        }),
      );
      return text(rows.map((r) => `${r.name} @ ${r.port}\n  ${r.info}`).join("\n\n"));
    },
    true,
  );

  tool(
    "peers.logcat",
    "Read one app's OWN logcat. Android filters logcat by uid, so this is the only way to see a constellation app's logs — no other process, ssh session included, can read them.",
    {
      app: z.string().describe("applicationId, a substring of it, or a port from peers.apps"),
      lines: z.number().int().min(1).max(20000).optional().describe("Lines to return (default 300, max 20000)"),
    },
    async ({ app, lines }) => {
      const a = resolve(await apps(), app);
      const q: Record<string, string> = lines ? { n: String(lines) } : {};
      return text(await call(a, "diagnostics/logcat", q, 30));
    },
  );

  tool(
    "peers.crashes",
    "Stored crash reports for one app, newest first, as written by AppCrashLogger.",
    { app: z.string().describe("applicationId, a substring of it, or a port") },
    async ({ app }) => text(await call(resolve(await apps(), app), "diagnostics/crashes")),
  );

  tool(
    "peers.docs",
    "One app's route catalog: the universal endpoints plus any group the app registered with AppDebugServer.route(). Read this before peers.call to learn what that app actually serves.",
    { app: z.string().describe("applicationId, a substring of it, or a port") },
    async ({ app }) => text(await call(resolve(await apps(), app), "docs")),
  );

  tool(
    "peers.wake",
    "Start another constellation member's process through its content provider. No activity is launched, so Android's background-start restrictions do not apply — use it to bring an app up before reading its logs.",
    {
      app: z.string().describe("The app to ask (any live member will do)"),
      target: z.string().describe("applicationId of the member to wake, e.g. com.diegonmarcos.comms.mail"),
    },
    async ({ app, target }) => {
      if (!/^[A-Za-z0-9_.]+$/.test(target)) throw new Error(`not an applicationId: ${target}`);
      return text(await call(resolve(await apps(), app), "fleet/wake", { pkg: target }));
    },
  );

  tool(
    "peers.call",
    "Call any route on one app's debug API, including app-specific groups registered via AppDebugServer.route(). This is what makes a new app route usable with no change to this MCP — list them with peers.docs first.",
    {
      app: z.string().describe("applicationId, a substring of it, or a port"),
      path: z.string().describe("Route under /api/, e.g. 'news/latest' or 'fleet/peers'"),
      params: z.record(z.string(), z.string()).optional().describe("Query parameters"),
    },
    async ({ app, path, params }) => {
      if (!ROUTE_RE.test(path)) {
        throw new Error(`bad route "${path}" — expected /api/<group>/<op>, letters, digits, _ and - only`);
      }
      return text(await call(resolve(await apps(), app), path, params ?? {}, 30));
    },
  );

  // ── Privileged plane — the superapp's adb/exec shell door (uid 2000) ──────
  //
  // One privileged door for the whole constellation, by design: the superapp's
  // DevControlServer exposes `adb/exec` ("full adb-equivalent power") through
  // whichever channel is armed — the Shizuku app, the embedded adb client, or
  // the self-bootstrapped shell-domain server. These tools wrap it with typed
  // arguments and a verb allowlist, so per-app FULL logcat, permission grants,
  // force-stops, input injection and screenshots are single calls instead of
  // hand-built shell strings. If every call fails with a channel error, run
  // peers.adb_status — the door needs its once-per-boot bootstrap.

    /** applicationId for a query, without requiring the app to be alive —
   *  privileged ops are most needed exactly when the target is down. */
  async function pkgOf(query: string): Promise<string> {
  await ensureModules();
    const alias = aliasToPkg(query.trim());
    if (alias) return alias;
    if (PKG_RE.test(query) && query.includes(".")) return query;
    const a = resolve(await apps(), query);
    if (!a.pkg) throw new Error(`cannot resolve "${query}" to an applicationId`);
    return a.pkg;
  }

  // Self-healing exec: Shizuku is only ONE of the three channels. After a
  // one-time Wireless-Debugging pairing (peers.adb_pair), the embedded adb
  // client can re-arm itself every boot via mDNS autoconnect — no Shizuku app
  // involved, ever. When exec reports a dead channel, try that re-arm once
  // and retry, so the privileged plane heals itself instead of failing until
  // a human remembers the bootstrap.
  const CHANNEL_DOWN_RE = /no (?:active )?(?:channel|shell)|not connected|channel unavailable|unauthorized channel|SHELL server/i;
  async function adbExec(cmd: string, timeoutSec = 30): Promise<string> {
    const first = await get(PORT_DEVCONTROL, "adb/exec", { cmd }, timeoutSec);
    if (!CHANNEL_DOWN_RE.test(first)) return first;
    await get(PORT_DEVCONTROL, "adb/autoconnect", {}, 30).catch(() => "");
    return get(PORT_DEVCONTROL, "adb/exec", { cmd }, timeoutSec);
  }

  // What the un-flagged shell tool may run. Read/diagnose/manage verbs only —
  // raw `sh -c` power (rm, dd, reboot, redirects, pipelines) needs the
  // explicit dangerously_raw flag so a confused caller cannot wreck a device
  // as casually as it reads a log.
  const SHELL_ALLOW = new Set([
    "logcat", "pm", "am", "cmd", "dumpsys", "settings", "getprop", "setprop",
    "input", "screencap", "appops", "svc", "pidof", "ps", "top", "ls", "cat",
    "stat", "du", "df", "id", "uptime", "uname", "date", "wm", "ip", "netstat",
    "getenforce", "monkey",
  ]);

  tool(
    "peers.shell",
    "Run one command at SHELL privilege (uid 2000) on the phone through the superapp's adb/exec door — the Shizuku-class escape hatch. Allowlisted verbs only (logcat/pm/am/cmd/dumpsys/settings/input/…); compound shell syntax or other verbs need dangerously_raw:true. Returns raw stdout.",
    {
      cmd: z.string().min(1).max(2000).describe("The command, e.g. 'pm grant com.example android.permission.READ_LOGS'"),
      timeout: z.number().int().min(5).max(120).optional().describe("Seconds (default 30)"),
      dangerously_raw: z.boolean().optional().describe("Bypass the verb allowlist and compound-syntax guard. Only with clear user intent."),
    },
    async ({ cmd, timeout, dangerously_raw }) => {
      checkShell(cmd, dangerously_raw);
      return text(await adbExec(cmd, timeout ?? 30));
    },
  );

  tool(
    "peers.logcat_full",
    "SYSTEM logcat via the shell door — the whole device, or one app's slice by uid (works even for apps that serve no debug API, and reads what peers.logcat cannot: other uids). This is the full-Shizuku view of the log.",
    {
      app: z.string().optional().describe("Limit to this app's uid (applicationId, alias, or substring). Omit for the whole system log."),
      lines: z.number().int().min(1).max(20000).optional().describe("Lines (default 500)"),
      filter: z.string().max(80).optional().describe("Only lines containing this string (plain grep -F)"),
    },
    async ({ app, lines, filter }) => {
      const cmd = logcatFullCmd(lines ?? 500, app ? await pkgOf(app) : undefined, filter);
      return text(await adbExec(cmd, 60));
    },
  );

  tool(
    "peers.grant",
    "Grant or revoke an Android permission on any app at shell privilege — including development permissions normal apps cannot hold (e.g. android.permission.READ_LOGS).",
    {
      app: z.string().describe("applicationId, alias, or substring"),
      permission: z.string().regex(/^[A-Za-z0-9_.]+$/).describe("e.g. android.permission.READ_LOGS"),
      revoke: z.boolean().optional().describe("Revoke instead of grant"),
    },
    async ({ app, permission, revoke }) => {
      const pkg = await pkgOf(app);
      const out = await adbExec(`pm ${revoke ? "revoke" : "grant"} ${pkg} ${permission}`);
      return text(out.trim() || `${revoke ? "revoked" : "granted"} ${permission} on ${pkg}`);
    },
  );

  tool(
    "peers.force_stop",
    "Force-stop an app (am force-stop at shell privilege). Its process dies and its scheduled jobs pause until something starts it again — pair with peers.wake to bounce an app cleanly.",
    { app: z.string().describe("applicationId, alias, or substring") },
    async ({ app }) => {
      const pkg = await pkgOf(app);
      const out = await adbExec(`am force-stop ${pkg}`);
      return text(out.trim() || `force-stopped ${pkg}`);
    },
  );

  tool(
    "peers.input",
    "Inject an input event at shell privilege: tap, swipe, keyevent or text. This is what pull-to-refresh-over-ssh needs and app-level APIs can never do.",
    {
      gesture: z.enum(["tap", "swipe", "keyevent", "text"]),
      args: z.string().max(120).describe("tap: 'x y' · swipe: 'x1 y1 x2 y2 [ms]' · keyevent: 'KEYCODE_HOME' · text: the string"),
    },
    async ({ gesture, args }) => {
      if (!inputArgsOk(gesture, args)) throw new Error(`args do not look like ${gesture} arguments`);
      const out = await adbExec(`input ${gesture} ${args}`, 20);
      return text(out.trim() || `sent ${gesture} ${args}`);
    },
  );

  tool(
    "peers.screencap",
    "Screenshot the device at shell privilege. Saves to /sdcard/Download/ and returns the path (pull it over ssh/scp).",
    {},
    async () => {
      const out = await adbExec(
        `f=/sdcard/Download/screencap-$(date +%Y%m%d-%H%M%S).png; screencap -p "$f" && echo "$f"`, 30);
      return text(out.trim());
    },
  );

  tool(
    "peers.adb_pair",
    "ONE-TIME setup that makes the privileged plane Shizuku-INDEPENDENT forever: pair the superapp's embedded adb client with Android's Wireless Debugging. On the phone open Developer options → Wireless debugging → 'Pair device with pairing code' and pass the shown ip/port/code. Pairing persists; every later boot re-arms itself via peers.adb_autoconnect (the privileged tools even do it implicitly).",
    {
      host: z.string().describe("IP shown in the pairing dialog (the phone's own wifi IP, its wifi IP, not a mesh address)"),
      port: z.number().int().describe("The PAIRING port from the dialog (not the connect port)"),
      code: z.string().regex(/^\d{6}$/).describe("The 6-digit pairing code"),
    },
    async ({ host, port, code }) =>
      text(await get(PORT_DEVCONTROL, "adb/pair", { host, port: String(port), code }, 45)),
  );

  tool(
    "peers.adb_autoconnect",
    "Re-arm the embedded adb channel via mDNS discovery of the local Wireless-Debugging daemon. Needs a past peers.adb_pair and Wireless debugging ON — then this replaces the Shizuku app entirely. The privileged tools call it implicitly when the channel looks down; use it directly to re-arm after a reboot.",
    {},
    async () => text(await get(PORT_DEVCONTROL, "adb/autoconnect", {}, 45)),
  );

  tool(
    "peers.adb_status",
    "Health of the privileged channel behind peers.shell (Shizuku / embedded adb / bootstrapped shell server), plus — when it is down — the once-per-boot bootstrap command to re-arm it.",
    {},
    async () => {
      const status = await get(PORT_DEVCONTROL, "adb/status", {}, 15);
      let hint = "";
      try {
        hint = "\n\nbootstrap (run once per boot if the channel is down):\n" +
          (await get(PORT_DEVCONTROL, "adb/server-command", {}, 10));
      } catch { /* status alone is fine */ }
      return text(status + hint);
    },
    true,
  );
}
