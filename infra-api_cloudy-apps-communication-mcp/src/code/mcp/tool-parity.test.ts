// Tool parity (#1450): every tool name the old cloud-mail-mcp and cloud-mattermost-mcp exposed must still
// exist in this merged server, either under the same name or through ALIASES.
// Run: node --test mcp/tool-parity.test.ts   (static source scan; needs no node_modules, starts no server)
//
// Two levels are checked, because each old server exposed ONE meta-tool and did its work through methods:
//   tools    the names a client sees in tools/list   (mail, mattermost; proxied google-personal-mcp tools on top)
//   methods  the `method` enum inside each meta-tool (28 mail methods, 10 mattermost methods)
// OLD is a frozen copy of what the old servers exposed. While the old folders are still in the repo, a test
// re-reads them and fails if OLD is out of date. After cutover, when they are removed, that test is skipped
// and OLD stays the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));          // <svc>/src/code/mcp
const REPO = join(HERE, "..", "..", "..", "..");
const read = (p: string) => readFileSync(p, "utf-8");

// Renamed tool or method -> its new name. Empty: the merge renamed nothing.
const ALIASES: { tools: Record<string, string>; methods: Record<string, Record<string, string>> } = {
  tools: {},
  methods: {},
};

const OLD = {
  tools: ["mail", "mattermost"],
  methods: {
    mail: [
      "debug_inbound", "debug_outbound", "debug_trace", "mail_admin_domains", "mail_admin_users",
      "mail_create_folder", "mail_delete", "mail_delete_folder", "mail_download_attachment", "mail_flag",
      "mail_forward", "mail_list_folders", "mail_list_messages", "mail_move", "mail_read", "mail_reply",
      "mail_search", "mail_send", "resend_api_keys", "resend_domain_dns", "resend_domains",
      "resend_domain_verify", "resend_get", "resend_list", "resend_send", "stalwart_admin_accounts",
      "stalwart_admin_domains", "stalwart_admin_settings",
    ],
    mattermost: [
      "read", "post", "reply", "channels", "channels_grouped", "react", "user_search", "create_group_dm",
      "add_to_channel", "categories",
    ],
  } as Record<string, string[]>,
};

// ── static extraction ─────────────────────────────────────────────────────
function strings(body: string): string[] {
  return [...body.matchAll(/["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
}
/** Tool names registered with server.tool("<name>", ...) in one source file. */
function toolsIn(src: string): string[] {
  return [...src.matchAll(/\bserver\.tool\(\s*["']([A-Za-z0-9_]+)["']/g)].map((m) => m[1]);
}
/** The method enum of meta-tool `tool` in `src`: z.enum([...]) inline, or z.enum(CONST) -> const CONST = [...]. */
function methodsOf(src: string, tool: string): string[] {
  const at = src.search(new RegExp(`server\\.tool\\(\\s*["']${tool}["']`));
  assert.ok(at >= 0, `server.tool("${tool}") not found`);
  const rest = src.slice(at);
  const inline = rest.match(/method:\s*z\.enum\(\s*\[([\s\S]*?)\]\s*\)/);
  const byName = rest.match(/method:\s*z\.enum\(\s*([A-Z_][A-Z0-9_]*)\s*\)/);
  if (byName && (!inline || rest.indexOf(byName[0]) < rest.indexOf(inline[0]))) {
    const decl = src.match(new RegExp(`const\\s+${byName[1]}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    assert.ok(decl, `const ${byName[1]} not found`);
    return strings(decl[1]);
  }
  assert.ok(inline, `no method enum for ${tool}`);
  return strings(inline[1]);
}
/** Tools a server entry file (http.ts / index.ts) actually registers: follow register*(server) calls to their modules. */
function exposedBy(entry: string): string[] {
  const src = read(entry);
  const out: string[] = [];
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)\.js["']/g)) {
    for (const spec of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [orig, local = orig] = spec.split(/\s+as\s+/).map((s) => s.trim());
      if (!/^register/.test(orig) || orig === "registerProxiedMcpTools") continue;
      if (!new RegExp(`\\b${local}\\(\\s*server\\s*\\)`).test(src)) continue;
      const mod = read(join(dirname(entry), m[2] + ".ts"));
      const fn = mod.slice(mod.search(new RegExp(`export\\s+function\\s+${orig}\\b`)));
      out.push(...toolsIn(fn.slice(0, fn.search(/\n\}/) + 2)));
    }
  }
  return [...new Set(out)].sort();
}
function covers(oldName: string, have: Set<string>, alias: Record<string, string>): boolean {
  return have.has(oldName) || (alias[oldName] !== undefined && have.has(alias[oldName]));
}

// ── the merged server ─────────────────────────────────────────────────────
const NEW_ENTRIES = [join(HERE, "http.ts"), join(HERE, "index.ts")];
const NEW_FILES = { mail: join(HERE, "tools", "meta.ts"), mattermost: join(HERE, "mattermost", "meta.ts") } as Record<string, string>;

for (const entry of NEW_ENTRIES) {
  test(`every old tool name is exposed by ${entry.split("/").pop()}`, () => {
    const have = new Set(exposedBy(entry));
    for (const t of OLD.tools) assert.ok(covers(t, have, ALIASES.tools), `${t} missing from ${entry} (exposes: ${[...have]})`);
  });
}

for (const [tool, oldMethods] of Object.entries(OLD.methods)) {
  test(`every old ${tool} method exists in the merged ${tool} tool`, () => {
    const have = new Set(methodsOf(read(NEW_FILES[ALIASES.tools[tool] ?? tool]), ALIASES.tools[tool] ?? tool));
    const alias = ALIASES.methods[tool] ?? {};
    const missing = oldMethods.filter((m) => !covers(m, have, alias));
    assert.deepEqual(missing, [], `${tool}: methods missing in the merged server`);
  });
}

test("proxied google-personal-mcp tools still attach (same proxy module, PROXIED_MCPS set by compose.nix)", () => {
  for (const entry of NEW_ENTRIES) assert.match(read(entry), /registerProxiedMcpTools\(server\)/, entry);
  assert.ok(existsSync(join(HERE, "shared", "proxy-mcp.ts")));
  const compose = read(join(HERE, "..", "..", "compose.nix"));
  assert.match(compose, /PROXIED_MCPS\s*=/);
  const bj = JSON.parse(read(join(HERE, "..", "..", "..", "build.json")));
  assert.deepEqual(bj.proxied_mcps.children.map((c: { name: string }) => c.name), ["google-personal-mcp"]);
});

test("no alias points at a name the merged server does not have", () => {
  const have = new Set(NEW_ENTRIES.flatMap(exposedBy));
  for (const [o, n] of Object.entries(ALIASES.tools)) assert.ok(have.has(n), `tool alias ${o} -> ${n}`);
});

// ── OLD must match the old sources while they exist ─────────────────────
const OLD_SRC = {
  mail: { entry: join(REPO, "infra-api_cloud-mail-mcp", "src", "code", "mcp", "http.ts"), meta: join(REPO, "infra-api_cloud-mail-mcp", "src", "code", "mcp", "tools", "meta.ts") },
  mattermost: { entry: join(REPO, "infra-api_cloud-mattermost-mcp", "src", "code", "http.ts"), meta: join(REPO, "infra-api_cloud-mattermost-mcp", "src", "code", "meta.ts") },
};
for (const [tool, p] of Object.entries(OLD_SRC)) {
  test(`frozen OLD list matches the old ${tool} server source`, (t) => {
    if (!existsSync(p.entry)) { t.skip("old service folder removed after cutover; OLD is the record"); return; }
    assert.deepEqual(exposedBy(p.entry), [tool]);
    assert.deepEqual(methodsOf(read(p.meta), tool).sort(), [...OLD.methods[tool]].sort());
  });
}
