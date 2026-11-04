// catalog.ts — the fleet servers the router fronts. Ports are the deployed ones
// (build.json ports.app); hosts are the mesh DNS names, with the public bearer
// route as fallback (same order as .claude/mcp-connect.mjs: mesh first).
// ROUTER_SERVERS (JSON array of ServerEntry) replaces the default wholesale.
import type { ServerEntry } from "./router.ts";

const mesh = (host: string, port: number) => `http://${host}.mesh.diegonmarcos.com:${port}/mcp`;
const pub = (path: string) => `https://c3-pvt.diegonmarcos.com/${path}/mcp`;

export const SELF = "cloudy-all-mcp";

export const DEFAULT_CATALOG: ServerEntry[] = [
  { name: "cloudy-c3-mcp", aliases: ["cloud-infra-mcp", "c3-infra-mcp"], description: "c3 fleet control plane: devops, VMs, workflows, DNS, secrets", urls: [mesh("cloudy-c3-mcp", 3100), pub("cloudy-c3-mcp")] },
  { name: "cloudy-android-mcp", aliases: ["cloud-superapp-mcp"], description: "Android super-app and device tools", urls: [mesh("cloudy-android-mcp", 3110), pub("cloudy-android-mcp")] },
  { name: "cloudy-apps-communication-mcp", aliases: ["cloud-mail-mcp", "cloud-mattermost-mcp"], description: "Mail (IMAP/SMTP/Stalwart/Resend) and Mattermost: tools `mail` and `mattermost`", urls: [mesh("cloudy-apps-communication-mcp", 3103), pub("cloudy-apps-communication-mcp")] },
  { name: "cloudy-apps-drive-mcp", aliases: ["cloud-drive-mcp", "cloud-vault-mcp"], description: "Drive (repos, files, photos, S3, convert) and, on a direct mesh hit only, the cloud_vault personal data tool", urls: [mesh("cloudy-apps-drive-mcp", 3109), pub("cloudy-apps-drive-mcp")] },
  { name: "cloudy-cgc-pub-mcp", aliases: ["cloud-cgc-pub-mcp"], description: "Public code graph (CGC)", urls: [mesh("cloudy-cgc-pub-mcp", 3105), pub("cloudy-cgc-pub-mcp")] },
  { name: "cloud-me-cgc-pvt-mcp", aliases: ["cloud-cgc-pvt-mcp"], description: "Private code graph (cloud-me), mesh only", urls: [mesh("cloud-me-cgc-pvt-mcp", 3107)] },
  { name: "google-workspace-mcp", description: "Google Workspace (Drive, Docs, Sheets, Calendar, Gmail)", urls: [mesh("g-workspace-mcp", 3104)] },
  { name: "google-personal-mcp", description: "Personal Google account", urls: [mesh("g-personal-mcp", 3106)] },
  // Not in the final layout table: the ~130 legacy service tools (gitea, ntfy, umami, ...) of the
  // old cloud-services-mcp. Served by the old container while it runs as the alias.
  { name: "services", aliases: ["cloud-services-mcp"], description: "Legacy per-service tools (gitea, ntfy, umami, grist, ...), served by the old cloud-services-mcp container until re-homed", urls: [mesh("c3-services-mcp", 3101)] },
];

export function loadCatalog(env: Record<string, string | undefined> = process.env): ServerEntry[] {
  const raw = env.ROUTER_SERVERS;
  if (!raw) return DEFAULT_CATALOG;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((e) => !e || typeof e.name !== "string" || !Array.isArray(e.urls))) {
    throw new Error("ROUTER_SERVERS must be a JSON array of {name, description, urls[], aliases?[]}");
  }
  return parsed;
}
