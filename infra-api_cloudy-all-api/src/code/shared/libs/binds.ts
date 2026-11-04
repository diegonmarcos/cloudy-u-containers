// binds.ts — shared bind-host helper for HTTP listeners.
//
// CONTRACT
//   Reads MCP_HTTP_HOST (or a custom env var name) and returns the host string
//   to pass to `httpServer.listen(port, host, ...)`.
//
//   Defensive default: 127.0.0.1 (loopback). NEVER 0.0.0.0 — a misconfigured
//   deploy must not silently expose the service on every interface.
//
//   In production, compose.nix derives the host from cloud-data (WG IP) and
//   passes it through `environment.MCP_HTTP_HOST` (or the override env name).
//
// USAGE
//   import { bindHost } from "../shared/libs/binds.js";   // or "./binds.js"
//   httpServer.listen(port, bindHost(), () => { ... });
//
// OVERRIDE ENV NAME (rare):
//   bindHost("FASTIFY_HOST")      // for non-MCP services that already use a
//                                 // different convention.
export function bindHost(envName: string = "MCP_HTTP_HOST"): string {
  const v = process.env[envName];
  return v && v.trim() !== "" ? v : "127.0.0.1";
}
