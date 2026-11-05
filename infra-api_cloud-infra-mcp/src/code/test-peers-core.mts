// peers-control (#1495, merged from cloudy-android-mcp): the pure rules and the phone transport helpers. No network, no SDK, no phone.
// Run: node --experimental-strip-types test-peers-core.mts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PHONES, PORT_DEVCONTROL, dialOrder, doorsOf, onPhone, parseGatewayApps, phoneAlias, run, sq, urlOf } from "./mcp/peers/device.ts";
import * as core from "./mcp/peers/core.ts";

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => { await fn(); n++; console.log(`ok - ${name}`); };

await t("sq neutralises every metacharacter payload through a real shell", () => {
  assert.equal(sq("plain"), "'plain'");
  for (const evil of ["$(id)", "`id`", "; id", "a'b", "\n id \n", "'; rm -rf /; '", "$HOME", "a'; rm -rf /; echo '"]) {
    assert.equal(execFileSync("sh", ["-c", `printf %s ${sq(evil)}`], { encoding: "utf8" }), evil);
  }
});

await t("ROUTE_RE accepts real routes, rejects traversal, metacharacters and URLs", () => {
  for (const good of ["news/latest", "/fleet/peers", "docs", "system/info", "a_b-c/d"]) assert.ok(core.ROUTE_RE.test(good), good);
  for (const bad of ["../../etc/passwd", "news;id", "news latest", "http://x/y", "a/../b", "news?n=1", ""]) assert.equal(core.ROUTE_RE.test(bad), false, bad);
});

await t("the shell tool: allowlisted verbs only, no compound syntax, unless dangerously_raw", () => {
  core.checkShell("pm grant com.x android.permission.READ_LOGS");
  core.checkShell("/system/bin/getprop ro.build.version.sdk");
  assert.throws(() => core.checkShell("rm -rf /sdcard"), /not in the shell allowlist/);
  assert.throws(() => core.checkShell("ls /sdcard; id"), /compound/);
  assert.throws(() => core.checkShell("cat $(id)"), /compound/);
  assert.throws(() => core.checkShell("ls | wc"), /compound/);
  core.checkShell("rm -rf /sdcard/x", true);
});

await t("input events: each gesture accepts only its own argument shape", () => {
  assert.ok(core.inputArgsOk("tap", "100 200") && core.inputArgsOk("swipe", "1 2 3 4 300") && core.inputArgsOk("keyevent", "KEYCODE_HOME") && core.inputArgsOk("text", "hello world"));
  assert.equal(core.inputArgsOk("tap", "1; id"), false);
  assert.equal(core.inputArgsOk("keyevent", "home"), false);
  assert.equal(core.inputArgsOk("text", "a$(id)"), false);
});

await t("logcat_full: whole device or one uid, a plain-text filter only", () => {
  assert.equal(core.logcatFullCmd(500), "logcat -d -t 500");
  assert.match(core.logcatFullCmd(50, "com.x.y"), /--uid=\$u$/);
  assert.match(core.logcatFullCmd(50, undefined, "ERR"), /\| grep -F "ERR"$/);
  assert.throws(() => core.logcatFullCmd(50, undefined, "a;b"), /plain text only/);
});

const fleet = [
  { port: 38080, pkg: "" },
  { port: 38090, pkg: "com.diegonmarcos.superapp" },
  { port: 38091, pkg: "com.diegonmarcos.comms.mail" },
  { port: 38092, pkg: "com.diegonmarcos.superapp" },
];

await t("the gateway port agrees between device.ts and core.ts", () => assert.equal(core.PORT_DEVCONTROL, PORT_DEVCONTROL));

await t("app resolution: port, pkg, substring, lowest port of a pkg, ambiguity and misses", () => {
  assert.equal(core.label(fleet[0]), "devcontrol");
  assert.equal(core.resolveApp(fleet, "38091").pkg, "com.diegonmarcos.comms.mail");
  assert.equal(core.resolveApp(fleet, "mail").port, 38091);
  assert.equal(core.resolveApp(fleet, "superapp").port, 38090);
  assert.equal(core.resolveApp(fleet, "cloud-mail", (q) => (q === "cloud-mail" ? "com.diegonmarcos.comms.mail" : null)).port, 38091);
  assert.throws(() => core.resolveApp(fleet, "com"), /be specific/);
  assert.throws(() => core.resolveApp(fleet, "nope"), /no app matches/);
  assert.throws(() => core.resolveApp(fleet, "39000"), /nothing on port/);
  assert.throws(() => core.resolveApp([], "mail"), /no app is serving/);
});

await t("the gateway roster becomes one App per member; apps are asked at /app/<pkg>/api/<op>", () => {
  const gw = parseGatewayApps(JSON.stringify({ apps: [{ id: "mail", pkg: "com.diegonmarcos.comms.mail", door: true }, { id: "x" }] }));
  assert.deepEqual(gw, [{ pkg: "com.diegonmarcos.comms.mail", port: PORT_DEVCONTROL, gateway: true }]);
  assert.equal(parseGatewayApps("not found"), null);
  assert.equal(urlOf(gw![0], "system/info", "n=1"), `http://127.0.0.1:${PORT_DEVCONTROL}/app/com.diegonmarcos.comms.mail/api/system/info?n=1`);
  assert.equal(urlOf({ pkg: "com.x", port: 38154 }, "/docs"), "http://127.0.0.1:38154/api/docs");
});

await t("every result is stamped with the phone that answered", () => {
  assert.equal(core.stamp("phone2", { content: [{ type: "text", text: "x" }] }).content[0].text, "[phone: phone2]\nx");
});

await t("two phones: alias or id, four doors each, declared dial order, an explicit phone never falls through", async () => {
  if (PHONES.join(",") !== "phone2,phone1") return; // the compose.nix value; another SUPERAPP_PHONES is a deliberate override
  assert.equal(phoneAlias("samsung-a37"), "phone2");
  assert.equal(phoneAlias("A37"), "phone2");
  assert.throws(() => phoneAlias("phone3"), /unknown phone/);
  assert.deepEqual(doorsOf("phone2"), ["phone2", "phone2-v6", "phone2-termux", "phone2-termux-v6"]);
  assert.deepEqual(dialOrder(null), ["phone2", "phone1"]);
  assert.deepEqual(dialOrder("phone1"), ["phone1"]);
  await assert.rejects(onPhone("phone1", () => run("true")), /no route to phone phone1/);
});

console.log(`${n} passed`);
