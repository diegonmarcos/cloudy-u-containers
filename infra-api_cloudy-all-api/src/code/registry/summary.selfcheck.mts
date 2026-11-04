/**
 * Self-check for summary.ts — run it, do not read it and hope.
 *
 *   npx tsx summary.selfcheck.mts
 *
 * Pins the crash that made `registry.services_list` unusable: an MCP-only
 * service has no `api` block, and the projection used to dereference it
 * unconditionally. One such peer threw for the entire list.
 */
import assert from "node:assert/strict";
import type { ServiceDefinition } from "./types.js";
import { summarizeServices } from "./summary.js";

let passed = 0;
function check(description: string, body: () => void): void {
  body();
  passed += 1;
  console.log(`  ok ${passed} — ${description}`);
}

const mcpOnly: ServiceDefinition = {
  name: "cloud-infra-mcp",
  displayName: "Cloud Infra MCP",
  description: "infra tools over MCP",
  vm: "oci-apps",
  wgIp: "10.0.0.6",
  port: 3100,
  baseUrl: "http://10.0.0.6:3100",
  mcp: { transport: "streamable-http", toolsCount: 127, resourcesCount: 0, promptsCount: 0, description: "" },
};

const apiOnly: ServiceDefinition = {
  name: "matomo",
  displayName: "Matomo Reporting API",
  description: "analytics",
  vm: "oci-apps",
  wgIp: "10.0.0.6",
  port: 8080,
  baseUrl: "http://10.0.0.6:8080",
  api: { type: "custom-rest", specUrl: "https://example.invalid/?module=API", endpointCount: 12, description: "" },
};

check("an MCP-only service summarises instead of throwing", () => {
  const [summary] = summarizeServices([mcpOnly]);
  assert.equal(summary.name, "cloud-infra-mcp");
  assert.equal(summary.apiType, null);
  assert.equal(summary.endpointCount, 0);
  assert.equal(summary.hasSpec, false);
});

check("an MCP-only service still reports its MCP capability", () => {
  const [summary] = summarizeServices([mcpOnly]);
  assert.equal(summary.mcpTransport, "streamable-http");
  assert.equal(summary.toolsCount, 127);
});

check("an API-only service keeps its API detail", () => {
  const [summary] = summarizeServices([apiOnly]);
  assert.equal(summary.apiType, "custom-rest");
  assert.equal(summary.endpointCount, 12);
  assert.equal(summary.hasSpec, true);
  assert.equal(summary.mcpTransport, null);
});

check("one MCP-only peer does not take the whole list down", () => {
  // The deployed peer map holds 26 API-only and 10 MCP-only services. Before
  // the fix the first MCP-only entry threw and all 36 were lost.
  const mixed = [apiOnly, mcpOnly, apiOnly];
  const summaries = summarizeServices(mixed);
  assert.equal(summaries.length, 3, "every service must survive the projection");
  assert.deepEqual(
    summaries.map((s) => s.name),
    ["matomo", "cloud-infra-mcp", "matomo"]
  );
});

console.log(`summary selfcheck: ${passed} assertions passed`);
