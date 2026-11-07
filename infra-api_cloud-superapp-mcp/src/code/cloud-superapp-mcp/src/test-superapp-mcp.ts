/**
 * Self-check: `npx tsx test-superapp-mcp.ts`
 *
 * Covers the two things that fail silently and expensively — the shell
 * escaping (the model supplies `app`, `path` and every query value, and they
 * all end up inside a script piped to `ssh ... sh -s`) and the app resolver's
 * ambiguity rules. The live half runs only when the phone answers, so this
 * passes on a laptop with the phone off, in CI, and on a plane.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { PHONES, PORT_DEVCONTROL, PORT_LAST, dialOrder, doorsOf, onPhone, parseGatewayApps, phoneAlias, run, scan, sq, urlOf } from "../../lib-mcp/src/device.js";
import { ROUTE_RE, label, resolve, stamp } from "../../lib-mcp/src/tools.js";

let n = 0;
const ok = (what: string) => {
  n++;
  process.stdout.write(`  ok ${what}\n`);
};

// ── shell escaping ───────────────────────────────────────────────────────────
assert.equal(sq("plain"), "'plain'");
ok("sq wraps a plain word");

// The injection that matters: close the quote, run something, reopen.
assert.equal(sq("a'; rm -rf /; echo '"), `'a'\\''; rm -rf /; echo '\\'''`);
ok("sq neutralises a quote-break injection");

// The property that actually matters, checked against a real shell rather
// than by eyeballing the quoting: whatever goes in comes back out verbatim,
// having executed nothing. `a'b` legitimately contains quotes once escaped —
// an earlier version of this test asserted "no inner quote" and was simply
// wrong about POSIX.
for (const evil of ["$(id)", "`id`", "; id", "a'b", "\n id \n", "'; rm -rf /; '", "$HOME"]) {
  const back = execFileSync("sh", ["-c", `printf %s ${sq(evil)}`], { encoding: "utf8" });
  assert.equal(back, evil, `sq did not round-trip ${JSON.stringify(evil)}`);
}
ok("sq round-trips every metacharacter payload through a real shell");

// ── route allowlist ──────────────────────────────────────────────────────────
for (const good of ["news/latest", "/fleet/peers", "docs", "system/info", "a_b-c/d"]) {
  assert.ok(ROUTE_RE.test(good), `should accept ${good}`);
}
ok("ROUTE_RE accepts real routes");

for (const bad of ["../../etc/passwd", "news;id", "news latest", "http://x/y", "a/../b", "news?n=1", ""]) {
  assert.equal(ROUTE_RE.test(bad), false, `should reject ${bad}`);
}
ok("ROUTE_RE rejects traversal, metacharacters and URLs");

// ── app resolution ───────────────────────────────────────────────────────────
const fleet = [
  { port: PORT_DEVCONTROL, pkg: "" },
  { port: 38090, pkg: "com.diegonmarcos.superapp" },
  { port: 38091, pkg: "com.diegonmarcos.comms.mail" },
  { port: 38092, pkg: "com.diegonmarcos.superapp" },
];

assert.equal(label(fleet[0]), "devcontrol");
ok("the tokenless 38080 ping is labelled devcontrol");

assert.equal(resolve(fleet, "38091").pkg, "com.diegonmarcos.comms.mail");
ok("a bare port resolves");

assert.equal(resolve(fleet, "mail").port, 38091);
ok("a substring resolves");

// One pkg, two processes (an engine gets its own server) — take the lowest
// port rather than refusing, or every superapp query becomes an error.
assert.equal(resolve(fleet, "com.diegonmarcos.superapp").port, 38090);
assert.equal(resolve(fleet, "superapp").port, 38090);
ok("a pkg on two ports resolves to the lowest, not an error");

assert.throws(() => resolve(fleet, "com"), /be specific/);
ok("a substring spanning two different pkgs is refused");

assert.throws(() => resolve(fleet, "nope"), /no app matches/);
assert.throws(() => resolve(fleet, "39000"), /nothing on port/);
assert.throws(() => resolve([], "mail"), /no app is serving/);
ok("misses name what is actually live");

// ── #ipc the gateway: one door per phone ─────────────────────────────────────
const gw = parseGatewayApps(JSON.stringify({ apps: [{ id: "mail", pkg: "com.diegonmarcos.comms.mail", door: true }, { id: "x" }] }));
assert.deepEqual(gw, [{ pkg: "com.diegonmarcos.comms.mail", port: PORT_DEVCONTROL, gateway: true }]);
ok("the gateway's /api/fleet/apps becomes one App per member, all on the gateway port");
assert.equal(parseGatewayApps("not found — see /api/docs\n"), null);
assert.equal(parseGatewayApps(""), null);
ok("a phone with no gateway (old SuperApp, or none) falls back to the port sweep");
assert.equal(urlOf(gw![0], "system/info", "n=1"), `http://127.0.0.1:${PORT_DEVCONTROL}/app/com.diegonmarcos.comms.mail/api/system/info?n=1`);
assert.equal(urlOf({ pkg: "com.x", port: 38154 }, "/docs"), "http://127.0.0.1:38154/api/docs");
ok("a gateway app is asked at /app/<pkg>/api/<op>; a pre-gateway app on its own port");
assert.equal(resolve(gw!, "mail").pkg, "com.diegonmarcos.comms.mail");
ok("gateway apps resolve by name like port-swept ones");

// ── two phones ───────────────────────────────────────────────────────────────
// Run with SUPERAPP_PHONES=samsung-a37,samsung-s21-plus (the compose.nix value).
if (PHONES.join(",") === "samsung-a37,samsung-s21-plus") {
  assert.equal(phoneAlias("samsung-s21-plus"), "samsung-s21-plus");
  assert.equal(phoneAlias("samsung-a37"), "samsung-a37");
  assert.equal(phoneAlias("A37"), "samsung-a37");
  assert.equal(phoneAlias("samsung-s21plus"), "samsung-s21-plus");
  assert.throws(() => phoneAlias("phone3"), /unknown phone/);
  ok("a phone is chosen by alias or id; an undeclared one is refused");

  assert.deepEqual(doorsOf("samsung-a37"), ["samsung-a37", "samsung-a37-v6", "samsung-a37-termux", "samsung-a37-termux-v6"]);
  ok("each phone is dialled through its four declared doors");

  assert.deepEqual(dialOrder(null), ["samsung-a37", "samsung-s21-plus"]);
  assert.deepEqual(dialOrder("samsung-s21-plus"), ["samsung-s21-plus"]);
  ok("no phone given: declared order until one answers; a phone given: only that one");

  // An explicit phone never falls through to the other one.
  await assert.rejects(onPhone("samsung-s21-plus", () => run("true")), /no route to phone samsung-s21-plus/);
  ok("an unreachable chosen phone fails as itself, not via the other phone");
}
assert.equal(stamp("samsung-a37", { content: [{ type: "text", text: "x" }] }).content[0].text, "[phone: samsung-a37]\nx");
ok("every result is stamped with the phone that answered");

// ── live, only if the phone answers ──────────────────────────────────────────
const reachable = await run("echo up").then((s) => s.trim() === "up").catch(() => false);
if (!reachable) {
  process.stdout.write(`\n${n} checks passed (live half skipped — phone unreachable)\n`);
} else {
  ok("phone reachable");
  const live = await scan();
  assert.ok(live.length > 0, "no app answered /api/system/ping");
  ok(`scan found ${live.length}: ${live.map((a) => `${label(a)}@${a.port}`).join(", ")}`);
  assert.ok(live.every((a) => a.port >= PORT_DEVCONTROL && a.port <= PORT_LAST));
  ok("every discovered port is in range");
  process.stdout.write(`\n${n} checks passed (live)\n`);
}
