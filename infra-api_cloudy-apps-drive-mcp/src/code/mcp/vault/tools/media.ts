/**
 * Media tools — photos metadata, git repos index.
 * Photos accessed via PhotoPrism API. Repos via local git metadata.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, existsSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { getGitRoot } from "../config.js";

export function registerMediaTools(server: McpServer) {

  // ── Photos Status ─────────────────────────────────────────────────
  server.tool(
    "media_photos",
    "Check PhotoPrism access status. Photos are accessed via the cloud-services MCP (service_api_call to PhotoPrism) or directly via bearer token.",
    {},
    async () => ({
      content: [{
        type: "text" as const,
        text: `# Photos

Photos are managed via **PhotoPrism** at photos.diegonmarcos.com (wake-on-demand).

## Access methods:
1. **cloud-services MCP**: Use \`service_api_call\` with service "photoprism"
2. **Direct API**: \`GET https://photos.diegonmarcos.com/api/v1/photos\` with bearer token

## Common operations:
- Browse: \`/api/v1/photos?count=20&offset=0\`
- Search: \`/api/v1/photos?q=landscape\`
- Albums: \`/api/v1/albums\``,
      }],
    })
  );

  // ── Git Repos Index ───────────────────────────────────────────────
  server.tool(
    "media_git_repos",
    "List all git repositories with basic metadata (last commit, branch, description).",
    {},
    async () => {
      const gitRoot = getGitRoot();
      if (!existsSync(gitRoot)) {
        return { content: [{ type: "text" as const, text: "Git root not found" }] };
      }

      const repos = readdirSync(gitRoot, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(gitRoot, e.name, ".git")))
        .map(e => {
          const repoPath = join(gitRoot, e.name);
          let description = "";
          const readmePath = join(repoPath, "README.md");
          if (existsSync(readmePath)) {
            const firstLine = readFileSync(readmePath, "utf-8").split("\n").find(l => l.trim());
            description = firstLine?.replace(/^#+\s*/, "").trim() ?? "";
          }
          return `- **${e.name}/** — ${description || "(no README)"}`;
        })
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: `# Git Repositories\n\n${repos || "No repos found."}`,
        }],
      };
    }
  );
}
