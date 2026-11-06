// Guard: the security-testing allowlist enforces owner-only scope (default-deny).
// Proves in-allowlist targets pass and out-of-allowlist targets are refused.
// Run: node _shared/test-security-testing-allowlist.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkTarget, targetHost } from "./security-testing-allowlist.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const allow = JSON.parse(readFileSync(join(here, "security-testing-allowlist.json"), "utf8"));

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); fail = 1; } else console.log("ok  :", msg); };

// ── In-allowlist (owner's own services) MUST pass ──
for (const t of [
  "https://photos.diegonmarcos.com/api/v1/status",
  "diegonmarcos.com",
  "https://scrappers-api.mesh.diegonmarcos.com/health",
  "http://10.0.0.6:3000",
  "http://127.0.0.1:8080",
  "82.70.229.129",
  "https://mail.diegonmarcos.com",
]) {
  const r = checkTarget(t, allow);
  ok(r.allowed, `ALLOW ${t} -> ${r.reason}`);
}

// ── Out-of-allowlist (anything not the owner's) MUST be refused ──
for (const t of [
  "https://example.com",
  "http://google.com/search",
  "https://diegonmarcos.com.evil.net",   // suffix-spoof must NOT match
  "https://notdiegonmarcos.com",
  "8.8.8.8",
  "http://172.16.0.1",                    // private but not a fleet CIDR
  "https://github.com/steel-dev",
]) {
  const r = checkTarget(t, allow);
  ok(!r.allowed, `REFUSE ${t} -> ${r.reason}`);
}

// host extraction sanity
ok(targetHost("https://a.b.com:8443/x") === "a.b.com", "targetHost strips scheme/port/path");
ok(targetHost("[fd0c:1d00::6]:3000") === "fd0c:1d00::6", "targetHost parses bracketed ipv6");

if (fail) { console.error("\nsecurity-testing-allowlist: RED"); process.exit(1); }
console.log("\nsecurity-testing-allowlist: all green");
