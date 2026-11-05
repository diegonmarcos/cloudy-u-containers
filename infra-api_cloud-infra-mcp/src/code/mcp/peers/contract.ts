/**
 * The routes EVERY constellation app serves.
 *
 * This is the TypeScript side of a contract whose implementation is Kotlin:
 * ab_cloud-libs-shared/libs/devtools/AppDebugServer.kt serves these on the
 * phone, and every app that links libs:core gets them for free. Nothing here
 * runs on the device — this file exists so the MCP and the HTTP face agree on
 * what an app is guaranteed to answer, without either of them hardcoding it.
 *
 * Keep it in step with AppDebugServer's own /api/docs catalog. It is a mirror,
 * and a mirror that drifts is worse than no mirror: prefer superapp_docs
 * (which asks the device) whenever the two could disagree.
 */

export type RouteSpec = {
  /** First path segment under /api/ — the AppDebugServer.route() group. */
  group: string;
  op: string;
  params?: string;
  description: string;
  /** false = served without a fleet token. Only system/ping is. */
  auth?: boolean;
};

export const path = (r: RouteSpec): string => `${r.group}/${r.op}`;

/** Served by AppDebugServer itself, in every app, always. */
export const CONTRACT: RouteSpec[] = [
  { group: "system", op: "ping", auth: false,
    description: "liveness + applicationId — the one open route, so discovery works before a token exists" },
  { group: "system", op: "info",
    description: "applicationId, label, version, bound port, device" },
  { group: "diagnostics", op: "logcat", params: "n=lines (default 300, max 20000)",
    description: "this app's OWN logcat — Android filters by uid, so no other process can read it" },
  { group: "diagnostics", op: "crashes",
    description: "stored crash reports, newest first, as written by AppCrashLogger" },
  { group: "fleet", op: "peers",
    description: "installed mesh members" },
  { group: "fleet", op: "wake", params: "pkg=<applicationId>",
    description: "start another member's process via its content provider — no activity, so background-start rules do not apply" },
];

/** The device's own catalog, which also lists whatever the app registered
 *  through AppDebugServer.route(). Ask this rather than trusting CONTRACT
 *  when it matters. */
export const DOCS_ROUTE = "docs";
