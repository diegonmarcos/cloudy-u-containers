// Run: node --test mcp/gate.test.ts   (the imports in gate.ts are type-only free)
import { test } from "node:test";
import assert from "node:assert/strict";
import { inCidr, vaultAllowed } from "./gate.ts";

const mesh = (h = {}) => ({ remoteAddress: "10.0.0.6", headers: h });

test("direct mesh hit gets the vault tool", () => assert.equal(vaultAllowed(mesh(), {}), true));
test("loopback and ipv4-mapped mesh addresses are allowed", () => {
  assert.equal(vaultAllowed({ remoteAddress: "127.0.0.1", headers: {} }, {}), true);
  assert.equal(vaultAllowed({ remoteAddress: "::ffff:10.0.0.2", headers: {} }, {}), true);
});
test("outside the mesh CIDR is refused", () => {
  for (const a of ["203.0.113.9", "10.0.1.5", "192.168.1.1", "", undefined]) assert.equal(vaultAllowed({ remoteAddress: a, headers: {} }, {}), false, String(a));
});
test("any proxy marker or bearer closes the gate even from a mesh address (public door via Caddy)", () => {
  for (const h of ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "via", "cf-connecting-ip", "authorization"]) {
    assert.equal(vaultAllowed(mesh({ [h]: "x" }), {}), false, h);
  }
});
test("kill switch and CIDR override", () => {
  assert.equal(vaultAllowed(mesh(), { VAULT_TOOLS: "0" }), false);
  assert.equal(vaultAllowed({ remoteAddress: "172.16.4.4", headers: {} }, { VAULT_MESH_CIDR: "172.16.0.0/16, 10.0.0.0/24" }), true);
});
test("inCidr edge cases", () => {
  assert.equal(inCidr("10.0.0.255", "10.0.0.0/24"), true);
  assert.equal(inCidr("10.0.0.1", "10.0.0.1"), true);
  assert.equal(inCidr("1.2.3.4", "0.0.0.0/0"), true);
  assert.equal(inCidr("1.2.3.4", "bad/24"), false);
  assert.equal(inCidr("999.1.1.1", "10.0.0.0/24"), false);
});
