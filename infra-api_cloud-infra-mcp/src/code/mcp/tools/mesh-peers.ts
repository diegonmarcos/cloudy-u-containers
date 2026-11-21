// #1835 peers.mesh_health / peers.mesh_tools / peers.mesh_call: the two routes (sshd, MCP/API over the mesh) to every declared mesh peer.
// The existing phone SSH-door transport (peers/device.ts) is untouched; this is the second, first-class route beside it.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { type Deps, callPeer, findPeer, fleetBearer, health, parsePeers, peerTools } from "../peers/mesh-route.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const errText = (t: string) => ({ content: [{ type: "text" as const, text: `Error: ${t}` }], isError: true as const });

export const meshPeers = () => parsePeers(JSON.parse(readFileSync(new URL("../peers/mesh-peers.json", import.meta.url), "utf8")));

function sshRun(host: string, script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // the script (carrying the bearer) rides stdin, never argv
    const p = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "sh", "-s"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("ssh timed out")); }, 30_000);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (c) => { clearTimeout(timer); c === 0 ? resolve(out) : reject(new Error(`ssh exited ${c}: ${(err.trim() || out.trim()).slice(0, 200)}`)); });
    p.stdin.end(script);
  });
}

export const realDeps = (env: NodeJS.ProcessEnv = process.env): Deps => ({
  token: fleetBearer(env),
  http: (url, init) => fetch(url, init as RequestInit),
  ssh: sshRun,
  now: () => Date.now(),
});

export function registerMeshPeerTools(server: McpServer, deps: () => Deps = () => realDeps()) {
  server.tool("peers.mesh_health", "Every declared mesh peer (from the WireGuard membership) with sshd up, MCP up, API up, tool count and the last answer per route; peers that do not answer are shown, never dropped", {},
    async () => text(JSON.stringify(await health(meshPeers(), deps()), null, 1)));

  server.tool("peers.mesh_tools", "The tools one mesh peer serves on its own MCP endpoint (Cloud C3 Webserver mesh listener, mesh address only, fleet bearer)",
    { peer: z.string().describe("peer id (see peers.mesh_health) or its mesh address") },
    async (p: { peer: string }) => { try { return text(JSON.stringify(await peerTools(findPeer(meshPeers(), p.peer), deps()), null, 1)); } catch (e) { return errText((e as Error).message); } });

  server.tool("peers.mesh_call", "Run one of a mesh peer's tools: MCP first, the peer's API second, sshd last; the answer names the route that served it",
    { peer: z.string(), tool: z.string().describe("e.g. endpoints_mesh, endpoints_public, ipc_index, app_logs"), args: z.record(z.unknown()).optional(), route: z.enum(["mcp", "api", "sshd"]).optional().describe("force one route (default: try all in order)") },
    async (p: { peer: string; tool: string; args?: Record<string, unknown>; route?: "mcp" | "api" | "sshd" }) => {
      try {
        const r = await callPeer(findPeer(meshPeers(), p.peer), p.tool, p.args ?? {}, deps(), p.route);
        return text(`[peer: ${r.peer}] [route: ${r.route}] [tried: ${r.tried.map((t) => `${t.route}=${t.ok ? "ok" : "fail"}`).join(", ")}]\n${r.text}`);
      } catch (e) { return errText((e as Error).message); }
    });
}
