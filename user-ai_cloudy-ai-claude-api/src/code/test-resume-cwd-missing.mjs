// #1855 F2 tester: a resume into a cwd that does not exist must not fail as "spawn claude ENOENT".
// ensureResumeCwd (claude-resume.mjs) creates the directory; server.mjs routes the resume cwd through it.
// Mutations: M1 the helper returns without creating the dir -> RED; M2 server.mjs spawns with the raw
// RESUME_SESSION_CWD -> RED.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureResumeCwd } from "./claude-resume.mjs";

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-cwd-"));
const dir = path.join(root, "git", "_work", "orchestrator");
ok(!fs.existsSync(dir), "the resume cwd starts absent");
ok(ensureResumeCwd(dir) === dir, "ensureResumeCwd returns the same address");
ok(fs.statSync(dir).isDirectory(), "ensureResumeCwd created the directory");
const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { cwd: dir });
ok(!r.error && r.status === 0, "a child spawns in the created cwd (no ENOENT)");
ok(ensureResumeCwd(dir) === dir && fs.statSync(dir).isDirectory(), "idempotent on an existing directory");

const here = path.dirname(new URL(import.meta.url).pathname);
const server = fs.readFileSync(path.join(here, "server.mjs"), "utf8");
ok(/cwd:\s*resumeId && RESUME_SESSION_CWD \? ensureResumeCwd\(RESUME_SESSION_CWD\)/.test(server), "server.mjs spawns the resume through ensureResumeCwd");
ok(!/cwd:\s*resumeId && RESUME_SESSION_CWD \? RESUME_SESSION_CWD/.test(server), "server.mjs never spawns into the raw resume cwd");

fs.rmSync(root, { recursive: true, force: true });
if (fail) { console.error(`${fail} failure(s)`); process.exit(1); }
console.log("all green");
