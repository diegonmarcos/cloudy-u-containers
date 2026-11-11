// Tester (#1659): two host-network services on the same VM cannot declare the same port.
// THE DEFECT: jev-sidecar and cloud-superapp-mcp both declared 3110 on oci-apps. Both run with
// network_mode host, so whichever started second died with EADDRINUSE and, with restart "no",
// stayed down (cloud-superapp-mcp, three days). A published-port or bridge-network container has
// its own network namespace and may reuse a port number; a host-network one may not.
// Rule: per deploy.host, every port a host-network service declares (build.json ports.* and
// containers.*.port) is declared by exactly one service directory. A directory with no src/ and no
// dist/ is a declaration stub (not rendered, not deployed) and is not counted.
// Usage: node _shared/test-host-port-unique.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const check = (n, c, d = "") => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.error(`FAIL ${n}${d ? ` - ${d}` : ""}`));

const read = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const isHostNet = (dir) =>
  /network_mode\s*=\s*"host"/.test(read(join(ROOT, dir, "src/compose.nix"))) ||
  /"?network_mode"?\s*:\s*"?host"?/.test(read(join(ROOT, dir, "dist/compose/docker-compose.yml")));

export function load() {
  const out = [];
  for (const dir of readdirSync(ROOT).sort()) {
    if (dir.startsWith(".") || dir.startsWith("z_") || dir.startsWith("_")) continue;
    const bj = join(ROOT, dir, "build.json");
    if (!existsSync(bj)) continue;
    if (!existsSync(join(ROOT, dir, "src")) && !existsSync(join(ROOT, dir, "dist"))) continue;
    let b; try { b = JSON.parse(readFileSync(bj, "utf8")); } catch { continue; }
    const ports = new Set();
    for (const v of Object.values(b.ports || {})) if (Number.isInteger(v)) ports.add(v);
    for (const c of Object.values(b.containers || {})) if (c && Number.isInteger(c.port)) ports.add(c.port);
    out.push({ dir, host: b.deploy?.host ?? null, hostNet: isHostNet(dir), ports: [...ports] });
  }
  return out;
}

export function duplicates(services) {
  const seen = new Map();
  for (const s of services) {
    if (!s.hostNet || !s.host || s.host === "local") continue;
    for (const p of s.ports) {
      const k = `${s.host}:${p}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(s.dir);
    }
  }
  return [...seen].filter(([, d]) => d.size > 1).map(([k, d]) => `${k} <- ${[...d].join(", ")}`);
}

// Known duplicates, each with the reason it is not fixed here. An entry that stops being a
// duplicate must be removed (P5), so this list can only shrink.
const KNOWN = {
  "oci-apps:8086": "infra-obs_dbgate + infra-sec_zap: both are on-demand tools that are normally stopped (zap is started per scan, dbgate was Exited on 2026-11-11); they cannot run at the same time. Found by this guard in #1659, left for a ticket of its own because moving either port also moves its Caddy route.",
};

const services = load();
check("P0 discovery found host-network services", services.filter(s => s.hostNet).length >= 5, `found ${services.filter(s => s.hostNet).length}`);
const allDup = duplicates(services);
const dup = allDup.filter(d => !(d.split(" <- ")[0] in KNOWN));
check("P1 no host port is declared by two host-network services on one VM", dup.length === 0, dup.join(" | "));
const stale = Object.keys(KNOWN).filter(k => !allDup.some(d => d.startsWith(`${k} <- `)));
check("P5 every KNOWN entry is still a real duplicate (remove it once fixed)", stale.length === 0, stale.join(", "));
// The guard must be able to fail: re-create the incident.
const jev = services.find(s => s.dir === "infra-ai_jev-sidecar");
const sup = services.find(s => s.dir === "infra-api_cloud-superapp-mcp");
check("P2 both incident services are seen as host-network on the same VM", !!jev && !!sup && jev.hostNet && sup.hostNet && jev.host === sup.host);
if (jev && sup) {
  const mutated = services.map(s => s === sup ? { ...s, ports: [...jev.ports] } : s);
  check("P3 the 3110 incident (same port twice) is detected", duplicates(mutated).some(d => d.includes("infra-ai_jev-sidecar") && d.includes("infra-api_cloud-superapp-mcp")));
  const bridged = services.map(s => s === sup ? { ...s, ports: [...jev.ports], hostNet: false } : s);
  check("P4 a non-host-network container may reuse a port number", !duplicates(bridged).some(d => d.includes("infra-api_cloud-superapp-mcp")));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
