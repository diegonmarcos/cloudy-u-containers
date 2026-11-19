// Tester (#1811): the /mail/http-to-smtp bridge picks its store per request.
//
// Usage (registered in ../build.json#tests, run by per-service-tests.yml):
//   node test-mail-targets.ts
//
//   A  pickTarget: no header -> primary (maddy:25, unchanged for older callers);
//      a resolved target -> its host/port; declared-but-unresolved -> 503;
//      unknown -> 400; case and whitespace tolerant; array header -> first.
//   B  the route's declared list equals build.json#mail.targets (one SoT).
//   C  compose.nix RENDERED by nix-instantiate resolves every target from the
//      cloud-data services table (service + port slug -> ip + port), and leaves
//      out a target whose port slug is absent instead of failing the render.
//   D  maddy-direct and stalwart are DIFFERENT stores, and maddy-direct is not
//      the mirroring maddy:25 (the duplicate guard behind the fan-out).
// Missing nix-instantiate FAILS: this tester never skips.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DECLARED_TARGETS, pickTarget } from "./code/shared/mail-target.ts";

let failed = 0;
const t = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}\n     ${(e as Error).message.split("\n").join("\n     ")}`); }
};

const build = JSON.parse(readFileSync(new URL("../build.json", import.meta.url), "utf8"));
const mail = {
  primary: { host: "10.0.0.3", port: 25 },
  targets: { "maddy-direct": { host: "10.0.0.3", port: 2526 }, stalwart: { host: "10.0.0.3", port: 2025 } },
  heloDomain: "x", defaultUser: "x",
};

t("A1 no header -> primary maddy:25", () => {
  assert.deepEqual(pickTarget(undefined, mail, DECLARED_TARGETS), { ok: true, name: "maddy", host: "10.0.0.3", port: 25 });
  assert.deepEqual(pickTarget("", mail, DECLARED_TARGETS), { ok: true, name: "maddy", host: "10.0.0.3", port: 25 });
});
t("A2 resolved targets -> their own host:port", () => {
  assert.deepEqual(pickTarget("maddy-direct", mail, DECLARED_TARGETS), { ok: true, name: "maddy-direct", host: "10.0.0.3", port: 2526 });
  assert.deepEqual(pickTarget(" Stalwart ", mail, DECLARED_TARGETS), { ok: true, name: "stalwart", host: "10.0.0.3", port: 2025 });
  assert.deepEqual(pickTarget(["stalwart", "maddy"], mail, DECLARED_TARGETS), { ok: true, name: "stalwart", host: "10.0.0.3", port: 2025 });
});
t("A3 declared but not resolved -> 503, unknown -> 400", () => {
  const noStalwart = { ...mail, targets: { "maddy-direct": mail.targets["maddy-direct"] } };
  const r1 = pickTarget("stalwart", noStalwart, DECLARED_TARGETS);
  assert.equal(r1.ok, false); assert.equal((r1 as { code: number }).code, 503);
  const r2 = pickTarget("gmail", mail, DECLARED_TARGETS);
  assert.equal(r2.ok, false); assert.equal((r2 as { code: number }).code, 400);
});
t("B route's declared targets == build.json#mail.targets", () => {
  assert.deepEqual([...DECLARED_TARGETS].sort(), Object.keys(build.mail.targets).sort());
});

const need = (bin: string, args: string[]) => { try { execFileSync(bin, args, { stdio: "ignore" }); return true; } catch { return false; } };
const haveNix = need("nix-instantiate", ["--version"]);
t("C0 nix-instantiate is available (this tester EVALUATES compose.nix)", () => assert.ok(haveNix, "nix-instantiate not on PATH"));
if (haveNix) {
  const render = (dropStalwartPort: boolean) => JSON.parse(execFileSync("nix-instantiate", [
    "--eval", "--strict", "--json", "--expr", `
      let
        b = builtins.fromJSON (builtins.readFile ../build.json);
        stub = { ip = "10.0.0.99"; ports.app = 1; };
        backendSvcs = builtins.listToAttrs (map (k: { name = b.backends.\${k}.service; value = stub; })
          (builtins.attrNames b.backends));
        services = backendSvcs // {
          "c3-public-api" = stub;
          maddy = { ip = "10.0.0.3"; extra_ports = { "25".service = "smtp_mx"; "2526".service = "smtp_mx_direct"; }; };
          stalwart = { ip = "10.0.0.5"; extra_ports = ${dropStalwartPort ? `{ "2443".service = "jmap_tls"; }` : `{ "2025".service = "smtp_shadow"; "2443".service = "jmap_tls"; }`}; };
        };
      in (import ./compose.nix { buildJson = b; container = { inherit services; }; }).services`,
  ], { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" }));
  const env = (svcs: Record<string, { environment: Record<string, string> }>) => svcs["c3-public-api"].environment;
  t("C1 rendered MAIL_TARGETS_JSON resolves each target from cloud-data", () => {
    const tg = JSON.parse(env(render(false)).MAIL_TARGETS_JSON);
    assert.deepEqual(tg, {
      maddy: { host: "10.0.0.3", port: 25 },
      "maddy-direct": { host: "10.0.0.3", port: 2526 },
      stalwart: { host: "10.0.0.5", port: 2025 },
    });
  });
  t("C2 a target whose port slug is absent is left out (render does not fail)", () => {
    const tg = JSON.parse(env(render(true)).MAIL_TARGETS_JSON);
    assert.ok(!("stalwart" in tg)); assert.ok("maddy-direct" in tg);
  });
  t("D maddy-direct and stalwart are different stores; maddy-direct is not maddy:25", () => {
    const tg = JSON.parse(env(render(false)).MAIL_TARGETS_JSON);
    assert.notDeepEqual(tg["maddy-direct"], tg.stalwart);
    assert.notEqual(tg["maddy-direct"].port, tg.maddy.port);
    assert.equal(build.mail.targets["maddy-direct"].via, "smtp_mx_direct");
  });
}

console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
