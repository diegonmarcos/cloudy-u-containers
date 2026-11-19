// Tester (#1821): Stalwart lives on oci-apps, and nothing still addresses it on oci-mail.
// Why: Stalwart (RocksDB, ~1.1 GB) was moved off oci-mail (E2.1.Micro, 954 MB, steal 50-78%) to oci-apps
// (A1 arm64). Its addressing is hard-coded in several declarations (port binds, the L4 SNI upstreams, the
// maddy relay target, Caddy's JMAP upstream, hickory records, the Dagu reconcile, the auth-broker SMTP
// target). One missed consumer keeps writing to / reading from the old, stopped box.
//
// Two phases, switched by user-comm_tools-stalwart/build.json build.ship_hold:
//   hold present  -> only the Stalwart declaration is checked (A*). The consumers are still re-pointed
//                    AFTER the data copy, so their checks (C*) are reported as SKIP, never as a pass.
//   hold removed  -> the consumer checks (C*) are enforced too.
// Usage: node _shared/test-stalwart-host.mjs   (cwd: any; resolves the repo root from this file)
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "oci-apps";
export const WG0 = "10.0.0.6";
export const WG_PUBLIC = "10.1.0.4";
export const OLD_WG0 = "10.0.0.3";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0, skip = 0;
const check = (n, c, d = "") => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.error(`FAIL ${n}${d ? ` - ${d}` : ""}`));
const skipped = (n, why) => { skip++; console.log(`SKIP ${n} (${why})`); };
const read = (rel) => { try { return readFileSync(join(ROOT, rel), "utf8"); } catch { return ""; } };
const json = (rel) => { try { return JSON.parse(read(rel)); } catch { return null; } };

export function stalwartFacts(b) {
  const app = b?.containers?.app ?? {};
  const l4 = b?.proxy?.primary?.l4_ports ?? [];
  return {
    host: b?.deploy?.host,
    arch: b?.docker?.arch,
    hold: b?.build?.ship_hold || "",
    binds: [...new Set((app.extra_ports ?? []).flatMap((p) => (Array.isArray(p.bind) ? p.bind : [p.bind])))].sort(),
    smtpShadow: (app.extra_ports ?? []).find((p) => p.service === "smtp_shadow")?.port,
    jmapTls: (app.extra_ports ?? []).find((p) => p.service === "jmap_tls")?.port,
    l4: Object.fromEntries(l4.map((r) => [r.sni, r.upstream])),
  };
}

const sb = json("user-comm_tools-stalwart/build.json");
const f = stalwartFacts(sb);

// ── A: the Stalwart declaration itself ──────────────────────────────────────
check("A1 stalwart deploys on oci-apps", f.host === HOST, `deploy.host=${f.host}`);
check("A2 sorter image is built for arm64 (oci-apps is Ampere A1)", f.arch === "arm64", `docker.arch=${f.arch}`);
check("A3 every published port binds the oci-apps wg0 / wg-public addresses only", JSON.stringify(f.binds) === JSON.stringify([WG0, WG_PUBLIC].sort()), `binds=${f.binds.join(",")}`);
check("A4 imap SNI route upstream is oci-apps:2993", f.l4["imap.diegonmarcos.com"] === `${HOST}:2993`, f.l4["imap.diegonmarcos.com"]);
check("A5 smtps SNI route upstream is oci-apps:2465", f.l4["smtps.diegonmarcos.com"] === `${HOST}:2465`, f.l4["smtps.diegonmarcos.com"]);
check("A6 the upstream image is a pinned multi-arch tag", /^stalwartlabs\/stalwart:v\d+\.\d+\.\d+$/.test(sb?.containers?.app?.image ?? ""), sb?.containers?.app?.image);
const wp = json("infra-net_wireguard-public/build.json");
const apps = (wp?.wireguard_public?.peers ?? wp?.wireguard_public?.nodes ?? wp?.wireguard_public?.members ?? []).find?.((n) => n.name === HOST);
check("A7 the wg-public bind is the address wireguard-public declares for oci-apps", !apps || apps.wg_ip === WG_PUBLIC, `declared=${apps?.wg_ip}`);
check("A8 A3 can fail: an oci-mail bind is rejected", JSON.stringify([OLD_WG0, "10.1.0.3"]) !== JSON.stringify([WG0, WG_PUBLIC].sort()));

const nix = read("user-comm_tools-stalwart/src/compose.nix");
const sub = /ipam\.config\s*=\s*\[\s*\{\s*subnet\s*=\s*"(172\.(\d+)\.\d+\.\d+)\/(\d+)"/.exec(nix);
check("A9 the stalwart bridge subnet is pinned inside 172.16.0.0/12 (oci-apps firewall forwards/masquerades only that range)", !!sub && +sub[2] >= 16 && +sub[2] <= 31, sub ? sub[1] : "no pinned subnet");

// ── C: the consumers (enforced once the hold is gone) ──────────────────────
const phase = f.hold ? "hold" : "cutover";
const consumer = (name, fn) => (phase === "hold" ? skipped(name, "build.ship_hold still set: consumers are re-pointed after the data copy") : fn());

consumer("C1 caddy JMAP upstreams are oci-apps:2443 (no oci-mail)", () => {
  const caddy = json("infra-sec_caddy/build.json");
  const wk = caddy?.proxy?.well_known ?? [];
  const jmap = wk.filter((w) => /jmap|mails\./.test(w.target_domain ?? "") && w.upstream);
  check("C1a caddy declares JMAP upstreams", jmap.length >= 4, `n=${jmap.length}`);
  check("C1b every one is oci-apps:2443", jmap.every((w) => w.upstream === `${WG0}:${f.jmapTls}`), jmap.map((w) => w.upstream).join(","));
});
consumer("C2 maddy relays to Stalwart on oci-apps:2025", () => {
  const m = json("user-comm_tools-maddy/build.json");
  const r = m?.stalwart_relay;
  check("C2a maddy build.json declares stalwart_relay", !!r, "missing");
  check("C2b it is the oci-apps wg0 address and Stalwart's smtp_shadow port", r?.host === WG0 && r?.port === f.smtpShadow, JSON.stringify(r));
  check("C2c the maddy template has no hard-coded Stalwart address", !/tcp:\/\/10\.0\.0\.3:2025/.test(read("user-comm_tools-maddy/src/templates/maddy.conf.tpl.tpl")));
});
consumer("C3 hickory stalwart records point at oci-apps", () => {
  const recs = json("infra-net_hickory-dns/build.json")?.dns?.records ?? {};
  const all = Object.values(recs).flat().filter((r) => /(^|\.)stalwart$/.test(r.name));
  check("C3a hickory has stalwart records", all.length >= 4, `n=${all.length}`);
  check("C3b A records are 10.0.0.6 and AAAA fd0c:1d00::6", all.every((r) => (r.type === "A" ? r.value === WG0 : r.value === "fd0c:1d00::6")), all.map((r) => `${r.name}/${r.type}=${r.value}`).join(" "));
});
consumer("C4 auth-broker submits to Stalwart on oci-apps", () => {
  const a = json("infra-sec_auth-broker/build.json");
  const smtp = JSON.stringify(a).match(/"smtp":\{[^}]*\}/)?.[0] ?? "";
  check("C4 auth-broker smtp host is oci-apps wg0", smtp.includes(`"host":"${WG0}"`) && smtp.includes('"port":2465'), smtp);
});
consumer("C5 comm-mcp reaches Stalwart on oci-apps", () => {
  const b = json("infra-api_cloudy-apps-communication-mcp/build.json");
  check("C5a recipient-probe override for diegonmarcos.com is oci-apps:2025", b?.delivery_api?.probe?.overrides?.["diegonmarcos.com"] === `${WG0}:${f.smtpShadow}`, b?.delivery_api?.probe?.overrides?.["diegonmarcos.com"]);
  const nix = read("infra-api_cloudy-apps-communication-mcp/src/compose.nix");
  check("C5b compose.nix pins the Stalwart host to the Stalwart address, not the maddy one", /"\$\{mh\.stalwart\}:\$\{stalwartIp\}"/.test(nix) && /STALWART_SMTP_IP\s*=\s*stalwartIp/.test(nix));
});
consumer("C6 dagu reconcile and TLS sync address Stalwart on oci-apps", () => {
  const rec = read("infra-obs_dagu/src/dags/health_mail-reconcile.yaml");
  check("C6a reconcile-stalwart reads JMAP on oci-apps:2443", /BASE = "https:\/\/10\.0\.0\.6:2443"/.test(rec) && !/10\.0\.0\.3:2443/.test(rec));
  check("C6b reconcile-stalwart probe SMTP is oci-apps:2025", /SMTP_HOST, SMTP_PORT, RCPT = "10\.0\.0\.6", 2025/.test(rec));
  const tls = read("infra-obs_dagu/src/dags/ops_maddy-tls-sync.yaml");
  check("C6c the TLS sync also installs the wildcard on oci-apps", /ubuntu@10\.0\.0\.6/.test(tls));
});
consumer("C7 no JSON/nix declaration still names Stalwart's old address", () => {
  const stalwartOnOld = [
    ["user-comm_tools-stalwart/build.json", /"upstream":\s*"oci-mail:/],
    ["infra-sec_caddy/build.json", /10\.0\.0\.3:24(43|65|93)/],
  ].filter(([p, re]) => re.test(read(p))).map(([p]) => p);
  check("C7 none", stalwartOnOld.length === 0, stalwartOnOld.join(", "));
});

console.log(`${pass} passed, ${fail} failed, ${skip} skipped (phase=${phase})`);
process.exit(fail ? 1 : 0);
