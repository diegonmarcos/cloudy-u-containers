// Contract test for the #1875 shadow hook: only read-only commands replay, a divergence is
// reported, errors never throw, and with no URL nothing is sent. Mutation checks at the end.
import assert from "node:assert/strict";
import { isShadowSafe, shadowDiff, shadowSsh, shadowStats, type ShadowResult } from "./code/shared/libs/execd-shadow.ts";

const ok = (stdout = ""): ShadowResult => ({ stdout, stderr: "", exitCode: 0, ok: true, timedOut: false });

for (const c of ["echo ok", "docker ps", "docker ps -a", 'docker ps --format "{{.Names}}"', "docker info", "docker inspect caddy", "uptime", "hostname"]) {
  assert.ok(isShadowSafe(c), `should replay: ${c}`);
}
for (const c of ["docker restart caddy", "docker stop x", "docker ps; docker rm x", "docker ps && id", "echo ok; id", "docker exec c sh -c 'x'",
  "docker inspect a b", "docker inspect `id`", "rm -rf /", "docker compose up -d", "docker ps | sh", 'docker ps --format "$(id)"', "sudo reboot"]) {
  assert.ok(!isShadowSafe(c), `must NOT replay: ${c}`);
}

assert.deepEqual(shadowDiff("echo ok", ok("ok\n"), ok("ok\n")), []);
assert.deepEqual(shadowDiff("docker ps", ok("a"), ok("b")), [], "volatile stdout is not compared");
assert.ok(shadowDiff("echo ok", ok("ok\n"), ok("no\n")).includes("stdout differs"));
assert.ok(shadowDiff("echo ok", ok(), { ...ok(), ok: false, exitCode: 255 }).length >= 2);

const logs: string[] = [];
const calls: string[] = [];
const fakeFetch = (res: ShadowResult | Error | number) => async (url: string, init: { body: string }) => {
  calls.push(url + " " + init.body);
  if (res instanceof Error) throw res;
  if (typeof res === "number") return { ok: false, status: res, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => res };
};
const opts = (f: ReturnType<typeof fakeFetch>) => ({ url: "http://127.0.0.1:4187", token: "t", fetch: f as never, log: (l: string) => logs.push(l) });

await shadowSsh("oci-apps", "echo ok", 1000, ok("ok\n"), opts(fakeFetch(ok("ok\n"))));
assert.match(logs.at(-1)!, /MATCH oci-apps/);
await shadowSsh("oci-apps", "echo ok", 1000, ok("ok\n"), opts(fakeFetch(ok("DIFFERENT"))));
assert.match(logs.at(-1)!, /MISMATCH.*stdout differs/);
await shadowSsh("oci-apps", "echo ok", 1000, ok("ok\n"), opts(fakeFetch(new Error("ECONNREFUSED"))));
assert.match(logs.at(-1)!, /ERROR.*ECONNREFUSED/);
await shadowSsh("oci-apps", "echo ok", 1000, ok("ok\n"), opts(fakeFetch(503)));
assert.match(logs.at(-1)!, /ERROR.*HTTP 503/);
const n = calls.length;
await shadowSsh("oci-apps", "docker restart caddy", 1000, ok(), opts(fakeFetch(ok())));
assert.equal(calls.length, n, "a mutating command must never be replayed");
delete process.env.C3_EXECD_URL;
await shadowSsh("oci-apps", "echo ok", 1000, ok("ok\n"), { fetch: fakeFetch(ok("ok\n")) as never, log: (l) => logs.push(l) });
assert.equal(calls.length, n, "no URL, no replay");
assert.deepEqual(shadowStats, { replayed: 4, match: 1, mismatch: 1, error: 2 });
assert.match(calls[0], /\/v1\/ssh \{"alias":"oci-apps","command":"echo ok","timeout_ms":1000\}/);

// Mutation proof: a gate that admits mutating commands is caught by the lists above.
const mutantSafe = (c: string) => /^docker /.test(c);
assert.ok(mutantSafe("docker restart caddy") && !isShadowSafe("docker restart caddy"), "the real gate must differ from the loose mutant");
console.log("execd-shadow: all assertions passed");
