// cloudy-c3-mcp: the phone's Cloud-Webserver API page as three obs.debug methods (#1490):
//   obs.debug.phone_public   public endpoints        -> GET /endpoints/public
//   obs.debug.phone_mesh     mesh endpoints          -> GET /endpoints/mesh
//   obs.debug.phone_logs     apps logs, `<app>`      -> GET /ipc/<app>/logs  (the Cloud-Webserver mesh gateway, #1580)
// All three go over the mesh with the fleet bearer (phone-api-core.ts); nothing is reached publicly.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LOG_METHODS, logsPath, phoneGet } from "./phone-api-core.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (t: string) => ({ content: [{ type: "text" as const, text: `Error: ${t}` }], isError: true as const });

export function registerPhoneApiTools(server: McpServer, env: NodeJS.ProcessEnv = process.env) {
  const get = async (path: string) => {
    const r = await phoneGet(path, env);
    return r.ok ? text(r.value) : errText(r.error);
  };

  server.tool(
    "obs.debug.phone_public",
    "Phone public endpoints: the public URLs of the fleet services, from the Cloud-Webserver API page, over the mesh",
    {},
    async () => get("/endpoints/public"),
  );

  server.tool(
    "obs.debug.phone_mesh",
    "Phone mesh endpoints: the phone's mesh listener, its per-app log routes and the fleet services on the mesh, over the mesh",
    {},
    async () => get("/endpoints/mesh"),
  );

  server.tool(
    "obs.debug.phone_logs",
    "Phone apps logs: one fleet app's recent logcat and crash ring (its <package>.logexport IPC export), served by the phone's single mesh gateway /ipc/<app>/logs",
    {
      app: z.string().describe("Fleet app id (e.g. calc) or package, as in the phone's fleet manifest"),
      n: z.number().optional().describe("Logcat lines, 1-2000 (default 300)"),
      errors: z.boolean().optional().describe("Errors and fatals only"),
      crashes: z.number().optional().describe("Crash reports to include, 0-20 (default 5)"),
      method: z.enum(LOG_METHODS).optional().describe("export (default: logcat + crashes) | logs | crashes | meta"),
    },
    async (p: { app: string; n?: number; errors?: boolean; crashes?: number; method?: (typeof LOG_METHODS)[number] }) => {
      const path = logsPath(p);
      return path.ok ? get(path.value) : errText(path.error);
    },
  );
}
