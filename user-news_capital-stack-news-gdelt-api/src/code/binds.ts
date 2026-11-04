// binds.ts — local bind-host helper (mirrors shared util in
// bc-obs_c3-infra-api/src/code/shared/libs/binds.ts; copied because this
// service has no symlinked shared/).
//
// Defensive default: 127.0.0.1 (loopback). NEVER 0.0.0.0 — a misconfigured
// deploy must not silently expose the service on every interface.
//
// In production, compose.nix derives the host from cloud-data (WG IP) and
// passes it through `environment.MCP_HTTP_HOST`.
export function bindHost(envName: string = "MCP_HTTP_HOST"): string {
  const v = process.env[envName];
  return v && v.trim() !== "" ? v : "127.0.0.1";
}
