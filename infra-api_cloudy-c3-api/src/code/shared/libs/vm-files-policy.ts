/**
 * Path policy for the VM/container file tools (devops.vm.read_file,
 * devops.vm.read_tree, devops.vm.write_file). Pure — no SSH, no fs, no
 * imports — so test-vm-files-policy.mjs exercises the REAL decision.
 *
 * Reads: any absolute path EXCEPT the secret deny-list below. The check runs
 * on the path the caller gave AND on the remote `realpath -e` of it, so a
 * symlink into /run/secrets is refused the same as the literal path.
 *
 * Writes: ONLY under a declared work root (WRITE_ROOTS). Everything else is
 * refused before any SSH happens.
 */

// ── Size caps ──
export const READ_FILE_DEFAULT_BYTES = 64 * 1024;
export const READ_FILE_MAX_BYTES = 512 * 1024;
export const READ_TREE_DEFAULT_BYTES = 1024 * 1024;
export const READ_TREE_MAX_BYTES = 4 * 1024 * 1024;
// The content travels base64 inside ONE ssh argv element, and Linux caps a
// single argument at 128 KiB (MAX_ARG_STRLEN). 64 KiB raw -> ~88 KiB base64.
export const WRITE_FILE_MAX_BYTES = 64 * 1024;

// ── Secret deny-list (reads) ──
// Each entry is tested against the normalized absolute path.
export const READ_DENY: { re: RegExp; why: string }[] = [
  { re: /^\/run\/secrets(\/|$)/, why: "/run/secrets (docker secrets)" },
  { re: /\/secrets(\/|$)/, why: "a secrets/ directory" },
  { re: /\.secrets(\.[^/]*)?$/, why: "a *.secrets file" },
  { re: /(^|\/)\.ssh(\/|$)/, why: "an ~/.ssh directory" },
  { re: /(^|\/)\.gnupg(\/|$)/, why: "a GnuPG keyring" },
  { re: /(^|\/)sops(\/|$)/, why: "sops key material" },
  { re: /(^|\/)age\/keys\.txt$/, why: "an age/sops key file" },
  { re: /(^|\/)\.sops\.ya?ml$/, why: "sops config" },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)[^/]*$/, why: "an SSH private key" },
  { re: /\.(pem|key|p12|pfx|age|kdbx)$/, why: "a key/cert container" },
  { re: /(^|\/)\.env(\.[^/]*)?$/, why: "a .env file" },
  { re: /^\/etc\/(g?shadow|sudoers)(-|\/|$)/, why: "system credential files" },
  { re: /^\/proc(\/|$)/, why: "/proc (environ/mem leak secrets)" },
  { re: /^\/sys(\/|$)/, why: "/sys" },
  { re: /^\/dev(\/|$)/, why: "/dev" },
];

// tar --exclude patterns mirroring READ_DENY for read_tree (patterns with no
// slash match any path component's basename).
export const TREE_EXCLUDES = [
  "secrets", "*.secrets", "*.secrets.*", ".ssh", ".gnupg", "sops", ".sops.yaml",
  ".sops.yml", "keys.txt", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
  "*.pem", "*.key", "*.p12", "*.pfx", "*.age", "*.kdbx", ".env", ".env.*",
  "shadow", "gshadow", "sudoers",
];

// Roots a whole-tree read may NOT start at (too broad / pseudo-fs).
const TREE_ROOT_DENY = new Set(["/", "/run", "/proc", "/sys", "/dev", "/root", "/home", "/etc"]);

// ── Declared write roots ──
export type WriteRoot = { vm: string; container: string; root: string; user: string; why: string };
export const WRITE_ROOTS: WriteRoot[] = [
  {
    vm: "oci-apps",
    container: "cloud-agi-claude",
    root: "/home/appuser/git/_dispatch",
    user: "appuser",
    why: "agent dispatch dir (briefs, run scripts) in the shared agent git tree",
  },
];

/** posix normalize of an ABSOLUTE path; null if not absolute or contains NUL/newline. */
export function normalizeAbs(p: string): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || /[\0\n\r]/.test(p)) return null;
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return "/" + out.join("/");
}

/** Reason the path may not be read, or null when allowed. */
export function readDenied(p: string): string | null {
  const n = normalizeAbs(p);
  if (n === null) return "path must be absolute (no NUL/newline)";
  for (const d of READ_DENY) if (d.re.test(n)) return `refused: ${d.why}`;
  return null;
}

/** Reason the directory may not be read as a tree, or null when allowed. */
export function treeDenied(p: string): string | null {
  const r = readDenied(p);
  if (r) return r;
  const n = normalizeAbs(p)!;
  if (TREE_ROOT_DENY.has(n)) return `refused: ${n} is too broad for read_tree — pick a subdirectory`;
  return null;
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root + "/");
}

/** The declared root that admits this write, or a refusal reason. */
export function writeTarget(
  vmId: string, container: string, p: string,
): { ok: true; root: WriteRoot; path: string } | { ok: false; why: string } {
  const n = normalizeAbs(p);
  if (n === null) return { ok: false, why: "path must be absolute (no NUL/newline)" };
  const root = WRITE_ROOTS.find((r) => r.vm === vmId && r.container === container && under(n, r.root));
  if (!root) {
    const list = WRITE_ROOTS.map((r) => `${r.container}@${r.vm}:${r.root}`).join(", ");
    return { ok: false, why: `refused: not under a declared write root (${list})` };
  }
  if (n === root.root) return { ok: false, why: "refused: path is the root directory itself, give a file path" };
  if (readDenied(n)) return { ok: false, why: `refused: ${readDenied(n)}` };
  return { ok: true, root, path: n };
}

/** true if the remote-resolved path is still inside the root (symlink escape check). */
export function resolvedInside(resolved: string, root: string): boolean {
  const n = normalizeAbs(resolved);
  return n !== null && under(n, root);
}

/** Bytes look like text: no NUL and valid UTF-8. */
export function looksText(buf: Uint8Array): boolean {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return true; } catch { return false; }
}

/** Env var names whose VALUES are safe to show in env_tz output. Everything else is name-only. */
const SAFE_ENV = /^(TZ|LANG|LANGUAGE|LC_[A-Z]+|PATH|HOME|USER|HOSTNAME|NODE_ENV|NODE_VERSION|PYTHON_VERSION|TERM|SHELL|PWD|PORT|HOST|LOG_LEVEL|DEBUG|NODE_OPTIONS|NPM_CONFIG_[A-Z_]+|YARN_VERSION|GOSU_VERSION|PUID|PGID|UMASK)$/;
const SENSITIVE_NAME = /(PASS|SECRET|TOKEN|KEY|CRED|AUTH|COOKIE|SESSION|PRIVATE|DSN|DATABASE_URL|_URL$)/i;
export function envLine(e: string): string {
  const i = e.indexOf("=");
  const name = i < 0 ? e : e.slice(0, i);
  if (SAFE_ENV.test(name) && !SENSITIVE_NAME.test(name)) return e;
  return `${name}=***`;
}

/** Single-quote for a POSIX shell. */
export function shq(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}
