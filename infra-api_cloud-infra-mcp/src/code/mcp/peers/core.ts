/**
 * peers-control: the pure rules of the phone tools (no imports, so the dependency-free tester runs them).
 * Moved from cloudy-android-mcp (cloud-superapp-mcp) when it was merged into cloudy-c3-mcp (#1495).
 */

/** /api/<group>/<op>. No dots, no %, no scheme: a route name, not a URL. The value comes from the model, and device.ts escapes it into a shell script. */
export const ROUTE_RE = /^\/?[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\/?$/;

export const PKG_RE = /^[A-Za-z0-9_.]+$/;

/**
 * What the un-flagged shell tool may run. Read/diagnose/manage verbs only: raw `sh -c` power (rm, dd, reboot, redirects, pipelines)
 * needs the explicit dangerously_raw flag so a confused caller cannot wreck a device as casually as it reads a log.
 */
export const SHELL_ALLOW = new Set([
  "logcat", "pm", "am", "cmd", "dumpsys", "settings", "getprop", "setprop",
  "input", "screencap", "appops", "svc", "pidof", "ps", "top", "ls", "cat",
  "stat", "du", "df", "id", "uptime", "uname", "date", "wm", "ip", "netstat",
  "getenforce", "monkey",
]);

/** Throws unless `cmd` may run without dangerously_raw: its verb is allowlisted and it has no compound shell syntax. */
export function checkShell(cmd: string, dangerouslyRaw = false): void {
  if (dangerouslyRaw) return;
  const verb = cmd.trim().split(/\s+/)[0]?.split("/").pop() ?? "";
  if (!SHELL_ALLOW.has(verb)) throw new Error(`verb "${verb}" is not in the shell allowlist; pass dangerously_raw:true if this is deliberate`);
  if (/[;&|<>`]|\$\(/.test(cmd)) throw new Error("compound shell syntax needs dangerously_raw:true");
}

export type Gesture = "tap" | "swipe" | "keyevent" | "text";

/** The arguments of an input event must look like its gesture's arguments. */
export function inputArgsOk(gesture: Gesture, args: string): boolean {
  return gesture === "keyevent" ? /^[A-Z0-9_]+$/.test(args)
    : gesture === "text" ? /^[\w .,:/@-]+$/.test(args)
    : /^[0-9 ]+$/.test(args);
}

/** The filter of logcat_full is plain text only. */
export const FILTER_RE = /^[\w .,:/@()\[\]-]+$/;

/** The shell command of the system logcat, whole device or one app's slice by uid. */
export function logcatFullCmd(n: number, pkg?: string, filter?: string): string {
  let cmd = pkg
    ? `u=$(cmd package list packages -U ${pkg} | head -1 | sed 's/.*uid://'); logcat -d -t ${n} --uid=$u`
    : `logcat -d -t ${n}`;
  if (filter) {
    if (!FILTER_RE.test(filter)) throw new Error("filter: plain text only");
    cmd += ` | grep -F ${JSON.stringify(filter)}`;
  }
  return cmd;
}

/** The SuperApp gateway port of a phone (device.ts PORT_DEVCONTROL; test-peers-core.mts asserts the two agree). */
export const PORT_DEVCONTROL = 38080;

export type AppRef = { pkg: string; port: number; gateway?: boolean };

export function label(a: AppRef): string {
  return a.pkg || (a.port === PORT_DEVCONTROL ? "devcontrol" : "unknown");
}

/**
 * Accepts a port, a full applicationId, or any unambiguous substring of one.
 * Substrings matter because the useful name is the tail: "mail" reads better
 * than "com.diegonmarcos.comms.mail". A pkg can hold more than one port — the
 * engines run in their own processes and each gets a server — so an exact pkg
 * match takes the lowest port rather than refusing.
 */
export function resolveApp<T extends AppRef>(list: T[], query: string, aliasToPkg: (q: string) => string | null = () => null): T {
  if (list.length === 0) {
    throw new Error(
      "no app is serving the debug API — the phone is reachable but nothing answered " +
        "/api/system/ping. Is a constellation app running?",
    );
  }
  const q = aliasToPkg(query.trim()) ?? query.trim();

  if (/^\d+$/.test(q)) {
    const byPort = list.find((a: T) => a.port === Number(q));
    if (byPort) return byPort;
    throw new Error(`nothing on port ${q}. Live: ${list.map((a: T) => `${label(a)}@${a.port}`).join(", ")}`);
  }

  const exact = list.filter((a: T) => a.pkg === q || label(a) === q);
  if (exact.length) return exact.sort((a: T, b: T) => a.port - b.port)[0];

  const partial = list.filter((a: T) => label(a).toLowerCase().includes(q.toLowerCase()));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    const sameP = partial.every((a: T) => a.pkg === partial[0].pkg);
    if (sameP) return partial.sort((a: T, b: T) => a.port - b.port)[0];
    throw new Error(`"${q}" matches ${partial.map((a: T) => `${label(a)}@${a.port}`).join(", ")} — be specific`);
  }
  throw new Error(`no app matches "${q}". Live: ${list.map((a: T) => `${label(a)}@${a.port}`).join(", ")}`);
}


type Out = { content: { type: "text"; text: string }[] };

/** Every result says which phone answered. */
export function stamp(phone: string | null, r: Out): Out {
  return { content: r.content.map((c, i) => (i === 0 ? { ...c, text: `[phone: ${phone ?? "none"}]\n${c.text}` } : c)) };
}
