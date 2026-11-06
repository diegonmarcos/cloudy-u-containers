// The read side of the fleet data route (#1547): GET /fleet-data/manifest and GET /fleet-data/<tier>/<dataset> serve the PERSONAL (tier 1) and
// FLEET/INFRA (tier 2) datasets of the Cloud apps' fleet data framework. The source is the PRIVATE repo cloud-me-pvt-configs (folder fleet-data/),
// read over git+SSH with a per-repo READ-ONLY deploy key (FLEET_DATA_SSH_KEY_B64 — a base64 OpenSSH private key, written 0600 to a scratch dir,
// never logged, never served); nothing here ever comes from a public repo and no HTTPS/PAT credential is held. A shallow single-branch checkout is
// refreshed at most once per TTL; a dataset body is served only when the file parses and carries an integer schemaVersion (a half-written file is
// never served); the answer's ETag is the checkout's commit sha and If-None-Match is honoured; a stale checkout survives a short source outage.
// Transport (git/ssh, child_process) is isolated in a FleetRepo so the tester can run the policy with node alone and no network.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const FLEET_SSH_URL = process.env.FLEET_DATA_SSH_URL ?? "git@github.com:diegonmarcos/cloud-me-pvt-configs.git";
export const FLEET_BRANCH = process.env.FLEET_DATA_BRANCH ?? "main";
export const FLEET_SUBDIR = process.env.FLEET_DATA_SUBDIR ?? "fleet-data";
// The source is always the private repo; retained so the tester can assert it is never a public one.
export const PVT_SOURCE = FLEET_SSH_URL;
// Pinned github.com host key (same value the cloud-me-api read path pins): StrictHostKeyChecking=yes verifies against this, not TOFU.
export const KNOWN_HOSTS =
  process.env.FLEET_DATA_KNOWN_HOSTS ??
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
export const TTL_MS = 60_000;

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

/** `a`, `fleet/probes`, `app/<package>/<dataset>`: lower-case segments, no empty one, no dot-dot. */
export function isDatasetPath(path: string): boolean {
  if (!path || path.includes("..")) return false;
  const parts = path.split("/");
  if (parts[0] === "app") return parts.length >= 3 && PACKAGE.test(parts[1]) && parts.slice(2).every((s) => SEGMENT.test(s));
  return parts.every((s) => SEGMENT.test(s));
}

export function isTier(t: string): t is "1" | "2" { return t === "1" || t === "2"; }

export interface Answer { status: number; body?: string; etag?: string; error?: string }

/** The git/ssh transport, abstracted so the tester injects a fake with no network. */
export interface FleetRepo {
  /** Refresh the checkout at most once per TTL and return the HEAD commit sha; a stale checkout's sha while the source is down; null if unreachable with no prior checkout. */
  head(now: number): Promise<string | null>;
  /** Read <subdir>/<file>.json from the current checkout; null when the file is absent. */
  readDataset(file: string): string | null;
}

export function etagOf(body: string): string { return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`; }

/** The body is a JSON object with an integer schemaVersion >= 1 (the clients refuse anything else). */
export function validBody(body: string): boolean {
  try { const o = JSON.parse(body); return o !== null && typeof o === "object" && !Array.isArray(o) && Number.isInteger(o.schemaVersion) && o.schemaVersion >= 1; } catch { return false; }
}

/** Build the git/ssh-backed repo from the deploy key in the environment; null when the key is absent (the route then answers 503). */
function makeGitRepo(keyB64: string): FleetRepo {
  const base = join(tmpdir(), "fleet-data");
  const keyDir = join(base, "ssh");
  const dir = join(base, "repo");
  mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  mkdirSync(base, { recursive: true });
  const knownHostsPath = join(keyDir, "known_hosts");
  writeFileSync(knownHostsPath, `${KNOWN_HOSTS}\n`, { mode: 0o600 });
  const keyPath = join(keyDir, "id");
  const pem = Buffer.from(keyB64, "base64").toString("utf8");
  writeFileSync(keyPath, pem.endsWith("\n") ? pem : `${pem}\n`, { mode: 0o600 });
  const sshCmd = ["ssh", "-F", "/dev/null", "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`].join(" ");
  const env = { PATH: process.env.PATH, HOME: keyDir, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCmd };
  const git = (args: string[], cwd: string) => new Promise<string>((res, rej) =>
    execFile("git", args, { cwd, env, timeout: 20_000, maxBuffer: 1 << 20 }, (e, out, err) =>
      e ? rej(Object.assign(e as Error, { stderr: String(err || "") })) : res(String(out))));
  let lastSyncAt = 0;
  let lastCommit: string | null = null;
  return {
    async head(now: number): Promise<string | null> {
      if (lastCommit && now - lastSyncAt < TTL_MS) return lastCommit;
      try {
        if (!existsSync(join(dir, ".git"))) {
          rmSync(dir, { recursive: true, force: true });
          await git(["clone", "--quiet", "--depth", "1", "--single-branch", "--branch", FLEET_BRANCH, FLEET_SSH_URL, dir], base);
        } else {
          await git(["fetch", "--quiet", "--depth", "1", "origin", FLEET_BRANCH], dir);
          await git(["reset", "--quiet", "--hard", "FETCH_HEAD"], dir);
        }
        lastCommit = (await git(["rev-parse", "HEAD"], dir)).trim();
        lastSyncAt = now;
        return lastCommit;
      } catch {
        // Keep serving the last good checkout while the source is down; the error is never surfaced to a client.
        return lastCommit;
      }
    },
    readDataset(file: string): string | null {
      let root: string;
      try { root = realpathSync(dir); } catch { return null; }
      const abs = resolve(root, FLEET_SUBDIR, `${file}.json`);
      if (abs !== root && !abs.startsWith(root + sep)) return null;
      try { if (!statSync(abs).isFile()) return null; return readFileSync(abs, "utf8"); } catch { return null; }
    },
  };
}

let defaultRepo: FleetRepo | null | undefined;
function getDefaultRepo(env: NodeJS.ProcessEnv): FleetRepo | null {
  if (defaultRepo !== undefined) return defaultRepo;
  const b64 = (env.FLEET_DATA_SSH_KEY_B64 || "").trim();
  defaultRepo = b64 ? makeGitRepo(b64) : null;
  return defaultRepo;
}

/** `file` is `manifest` or `<tier>/<dataset path>`; the private repo path is <subdir>/<file>.json. */
export async function readFleetData(file: string, ifNoneMatch: string | undefined, repoArg?: FleetRepo | null, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<Answer> {
  const ok = file === "manifest" || (isTier(file.split("/")[0]) && isDatasetPath(file.split("/").slice(1).join("/")));
  if (!ok) return { status: 400, error: "bad dataset name" };
  const repo = repoArg !== undefined ? repoArg : getDefaultRepo(env);
  if (!repo) return { status: 503, error: "private source not configured" };
  const commit = await repo.head(now);
  if (!commit) return { status: 502, error: "private source unavailable" };
  const etag = `"${commit}"`;
  if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, etag };
  const body = repo.readDataset(file);
  if (body === null) return { status: 404, error: "no such dataset" };
  if (!validBody(body)) return { status: 502, error: "private source unavailable" };
  return { status: 200, body, etag };
}

export function clearFleetDataCache() { defaultRepo = undefined; }
