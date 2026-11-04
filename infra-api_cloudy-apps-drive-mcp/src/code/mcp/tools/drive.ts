// drive.ts — the one tool.
//
// `drive` takes a method name and a params bag and walks the routing table in
// build.json to decide where the call goes. Adding a capability is a JSON edit;
// this file only knows how to READ the table, never what is in it.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { driveConfig, resolveService } from "../resolve.js";
import { send, fillPath } from "../request.js";
import { s3Call } from "../backends/s3.js";
import { convertCall } from "../backends/convert.js";

type Json = Record<string, any>;

const cfg = driveConfig();
const METHODS: Json = cfg.methods ?? {};
const BACKENDS: Json = cfg.backends ?? {};

const reply = (v: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

function authHeaders(backend: Json, resolvedAuth: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (backend.api_key_env && process.env[backend.api_key_env]) {
    h["X-API-Key"] = process.env[backend.api_key_env]!;
    return h;
  }
  const token = backend.token_env ? process.env[backend.token_env] : undefined;
  if (!token) return h;
  h["Authorization"] = resolvedAuth === "token" ? `token ${token}` : `Bearer ${token}`;
  return h;
}

async function callHttp(spec: Json, backend: Json, params: Json): Promise<Json> {
  const r = resolveService(backend.service, {
    urlEnv: backend.url_env,
    basePath: backend.base_path,
  });
  // env-only backends (s3, sync) legitimately omit `service` — resolve via
  // url_env instead — so don't report a bare `undefined` here.
  if ("error" in r) return { error: r.error, backend: backend.service ?? "(env-configured)" };

  const { path, rest, missing } = fillPath(String(spec.path ?? ""), params);
  if (missing.length) return { error: `missing required params: ${missing.join(", ")}` };

  const method = String(spec.http ?? "GET").toUpperCase();
  let url = `${r.base}${r.basePath}${path}`;
  let body: string | undefined;

  if (method === "GET" || method === "DELETE") {
    const qs = new URLSearchParams(
      Object.entries(rest).filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  } else if (Object.keys(rest).length) {
    body = JSON.stringify(rest);
  }

  const headers = authHeaders(backend, r.auth);
  if (body) headers["Content-Type"] = "application/json";

  const res = await send(method, url, body, headers);
  return res.ok
    ? res.data
    : { error: res.error ?? `HTTP ${res.status}`, status: res.status, body: res.data };
}

export function registerDriveTool(server: McpServer): void {
  const names = Object.keys(METHODS).sort();

  server.tool(
    "drive",
    `Every storage unit behind one call: repos, files, photos, scrapes, sync, S3 and conversion. ` +
      `Call with method="help" to list methods and their params. Methods: ${names.join(", ")}`,
    {
      method: z.string().describe(`One of: ${names.join(", ")} — or "help".`),
      params: z.record(z.any()).optional().describe("Method arguments; {placeholders} in the route are filled from here, the rest become query string or JSON body."),
    },
    async ({ method, params }) => {
      const p: Json = params ?? {};

      if (method === "help" || !method) {
        return reply({
          methods: Object.fromEntries(
            names.map((n) => {
              const m = METHODS[n];
              const route = m.path ?? m.op ?? "";
              const needs = String(m.path ?? "").match(/\{(\w+)\}/g)?.map((s: string) => s.slice(1, -1)) ?? [];
              return [n, { backend: m.backend, route, requires: needs, destructive: !!m.destructive }];
            }),
          ),
          backends: Object.fromEntries(
            Object.entries(BACKENDS).map(([k, b]: [string, any]) => [
              k, { kind: b.kind, service: b.service ?? null },
            ]),
          ),
        });
      }

      const spec = METHODS[method];
      if (!spec) return reply({ error: `unknown method '${method}'`, known: names });

      const backend = BACKENDS[spec.backend];
      if (!backend) return reply({ error: `method '${method}' names backend '${spec.backend}', which is not declared` });

      try {
        switch (backend.kind) {
          case "http":  return reply(await callHttp(spec, backend, p));
          case "s3":    return reply(await s3Call(backend, String(spec.op), p));
          case "local": return reply(await convertCall(String(spec.op), p));
          default:      return reply({ error: `backend '${spec.backend}' has unknown kind '${backend.kind}'` });
        }
      } catch (e) {
        return reply({ error: String(e), method });
      }
    },
  );
}
