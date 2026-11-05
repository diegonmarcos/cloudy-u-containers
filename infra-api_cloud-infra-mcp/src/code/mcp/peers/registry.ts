/**
 * What an app module is, and how they are found.
 *
 * ONE server, one process. A module is a description of an app, not a server
 * of its own — see the header of tools.ts for why twenty apps do not get
 * twenty processes, and why the tool list must not be generated from the
 * devices at connect time.
 *
 * Adding an app: drop a folder under mcps-apps/<id>/ with an index.ts that
 * default-exports an AppModule. Nothing else changes — [loadModules] reads the
 * directory, so there is no barrel file to forget to update.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdirSync } from "node:fs";
import type { RouteSpec } from "./contract.js";

export type AppModule = {
  /** Constellation app id, matching ui.external_apps[].id in the superapp's
   *  build.json — the name a human uses, not the applicationId. */
  id: string;
  /** applicationId it serves the debug API under. "" when it has no APK of
   *  its own yet; discovery still finds it by port. */
  pkg: string;
  label: string;
  /**
   * Routes this app adds BEYOND the contract, via AppDebugServer.route() in
   * its Kotlin. Documentation only — superapp_call reaches them whether or
   * not they are listed here, and superapp_docs asks the device, which is
   * always the truth. Listing them here is what makes them discoverable when
   * the phone is unreachable, which is exactly when you are guessing.
   */
  routes?: RouteSpec[];
  /**
   * Optional bespoke tools for this app. Left unused on purpose: a tool per
   * app per route is how a six-tool server becomes a hundred-tool server that
   * no model can choose within. Add one only when an app needs ergonomics
   * superapp_call genuinely cannot express.
   */
  tools?: (server: McpServer) => void;
};

/** Every module under mcps-apps/, in directory order. */
export function loadModules(): Promise<AppModule[]> {
  const dir = new URL("./modules/", import.meta.url);
  const names = readdirSync(dir).filter((n) => !n.startsWith("."));
  return Promise.all(
    names.sort().map(async (n) => {
      const m = await import(new URL(`${n}/index.ts`, dir).href);
      return m.default as AppModule;
    }),
  );
}
