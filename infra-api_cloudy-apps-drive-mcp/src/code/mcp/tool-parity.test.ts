// Tool parity (#1450): every tool name the old cloud-drive-mcp and cloud-vault-mcp exposed must still exist
// in this merged server, either under the same name or through ALIASES.
// Run: node --test mcp/tool-parity.test.ts   (static source scan; needs no node_modules, starts no server)
//
// Two levels, because each old server exposed ONE meta-tool and did its work through methods:
//   tools    drive (always) and cloud_vault (old: a mesh-only server; new: gated per request by gate.ts)
//   methods  drive: the keys of build.json drive.methods; cloud_vault: the METHODS enum in vault/tools/meta.ts
// OLD is a frozen copy of what the old servers exposed. While the old folders are still in the repo, a test
// re-reads them and fails if OLD is out of date; after cutover, when they are removed, it is skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));          // <svc>/src/code/mcp
const SVC  = join(HERE, "..", "..", "..");
const REPO = join(SVC, "..");
const read = (p: string) => readFileSync(p, "utf-8");

// Renamed tool or method -> its new name. Empty: the merge renamed nothing.
const ALIASES: { tools: Record<string, string>; methods: Record<string, Record<string, string>> } = {
  tools: {},
  methods: {},
};

const OLD = {
  tools: ["drive", "cloud_vault"],
  methods: {
    drive: [
      "convert.formats", "convert.run", "file.delete", "file.info", "file.ls", "file.mkdir", "file.move",
      "file.shares", "file.usage", "photo.albums", "photo.labels", "photo.search", "repo.detail", "repo.issues",
      "repo.list", "repo.orgs", "repo.releases", "s3.delete", "s3.get", "s3.list", "s3.put", "scrape.run",
      "scrape.targets", "sync.devices", "sync.folders", "sync.status",
    ],
    cloud_vault: [
      "comms_email_status", "comms_notes", "comms_whatsapp", "finance_cards", "finance_wifi", "health_data",
      "identity_documents", "identity_notes", "identity_read_note", "media_git_repos", "media_photos",
      "vault_2fa_status", "vault_passwords_summary", "vault_providers", "vault_ssh_keys", "vault_structure",
      "vault_totp_code",
    ],
  } as Record<string, string[]>,
};

// ── static extraction ─────────────────────────────────────────────────────
const toolsIn = (src: string) => [...src.matchAll(/\bserver\.tool\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
function constArray(src: string, name: string): string[] {
  const decl = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  assert.ok(decl, `const ${name} not found`);
  return [...decl[1].matchAll(/["']([A-Za-z0-9_.]+)["']/g)].map((m) => m[1]);
}
/** register* functions an entry file imports, with the tools each one registers. */
function registrations(entry: string): { local: string; tools: string[] }[] {
  const src = read(entry);
  const out: { local: string; tools: string[] }[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)\.js["']/g)) {
    for (const spec of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!/^register/.test(orig)) continue;
      const mod = read(join(dirname(entry), m[2] + ".ts"));
      const fn = mod.slice(mod.search(new RegExp(`export\\s+function\\s+${orig}\\b`)));
      out.push({ local, tools: toolsIn(fn.slice(0, fn.search(/\n\}/) + 2)) });
    }
  }
  return out;
}
const covers = (o: string, have: Set<string>, alias: Record<string, string>) =>
  have.has(o) || (alias[o] !== undefined && have.has(alias[o]));

// ── the merged server ─────────────────────────────────────────────────────
const HTTP = join(HERE, "http.ts");

test("createMcpServer registers drive always and cloud_vault only behind the gate", () => {
  const src = read(HTTP);
  const body = src.slice(src.search(/export function createMcpServer/));
  const fn = body.slice(0, body.search(/\n\}/) + 2);
  const always = new Set<string>(), gated = new Set<string>();
  for (const r of registrations(HTTP)) {
    if (new RegExp(`if\\s*\\(\\s*withVault\\s*\\)\\s*${r.local}\\(\\s*server\\s*\\)`).test(fn)) r.tools.forEach((t) => gated.add(t));
    else if (new RegExp(`\\b${r.local}\\(\\s*server\\s*\\)`).test(fn)) r.tools.forEach((t) => always.add(t));
  }
  const have = new Set([...always, ...gated]);
  for (const t of OLD.tools) assert.ok(covers(t, have, ALIASES.tools), `${t} not exposed (always=${[...always]}, gated=${[...gated]})`);
  assert.deepEqual([...always], ["drive"], "only drive is served on every request");
  assert.deepEqual([...gated], ["cloud_vault"], "cloud_vault is registered only when vaultAllowed()");
  assert.match(src, /createMcpServer\(withVault\)/);
  assert.match(src, /vaultAllowed\(\{\s*remoteAddress:\s*req\.socket\.remoteAddress/);
});

test("every old drive method exists in the merged drive routing table", () => {
  const have = new Set(Object.keys(JSON.parse(read(join(SVC, "build.json"))).drive.methods));
  const missing = OLD.methods.drive.filter((m) => !covers(m, have, ALIASES.methods.drive ?? {}));
  assert.deepEqual(missing, []);
});

test("every old cloud_vault method exists in the merged cloud_vault tool", () => {
  const src = read(join(HERE, "vault", "tools", "meta.ts"));
  assert.match(src, /server\.tool\(\s*["']cloud_vault["'][\s\S]*?method:\s*z\.enum\(METHODS\)/);
  const have = new Set(constArray(src, "METHODS"));
  const missing = OLD.methods.cloud_vault.filter((m) => !covers(m, have, ALIASES.methods.cloud_vault ?? {}));
  assert.deepEqual(missing, []);
});

test("the vault tools get the vault tree and config they read (compose.nix)", () => {
  const compose = read(join(SVC, "src", "compose.nix"));
  assert.match(compose, /"\/home\/ubuntu\/git\/vault:\/vault:ro"/);
  assert.match(compose, /VAULT_PATH\s*=\s*"\/vault"/);
  assert.match(compose, /CONFIG_PATH\s*=\s*"\/app\/_cloud-data-consolidated\.json"/);
});

// ── OLD must match the old sources while they exist ─────────────────────
test("frozen OLD drive list matches cloud-drive-mcp", (t) => {
  const old = join(REPO, "infra-api_cloud-drive-mcp");
  if (!existsSync(old)) { t.skip("old service folder removed after cutover; OLD is the record"); return; }
  assert.deepEqual(registrations(join(old, "src", "code", "mcp", "http.ts")).flatMap((r) => r.tools), ["drive"]);
  assert.deepEqual(Object.keys(JSON.parse(read(join(old, "build.json"))).drive.methods).sort(), [...OLD.methods.drive].sort());
});

test("frozen OLD cloud_vault list matches cloud-vault-mcp", (t) => {
  const old = join(REPO, "infra-api_cloud-vault-mcp");
  if (!existsSync(old)) { t.skip("old service folder removed after cutover; OLD is the record"); return; }
  assert.deepEqual(registrations(join(old, "src", "code", "http.ts")).flatMap((r) => r.tools), ["cloud_vault"]);
  assert.deepEqual(constArray(read(join(old, "src", "code", "tools", "meta.ts")), "METHODS").sort(), [...OLD.methods.cloud_vault].sort());
});
