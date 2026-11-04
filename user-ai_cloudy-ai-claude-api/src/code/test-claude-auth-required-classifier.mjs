// Tester: the OAuth-expired family must classify as AUTH-REQUIRED, not 502.
//
// The defect, verbatim from Diego's Telegram window:
//   [gateway error 502] {"error":{"message":"claude-cli 502: {\"error\":
//   {\"message\":\"claude -p exit 1: Failed to authenticate: OAuth session
//   expired and could not be refreshed · api_error\",\"type\":
//   \"superset_claude_error\"...
//
// The mechanism for the good answer already existed — server.mjs returns 401
// with type "superset_claude_auth_required" so the bot auto-sends the OAuth
// login link. It never fired, because both classifiers tested inline string
// lists and NEITHER list contained the refresh-failure family. A credential
// that expired therefore looked like a random upstream fault.
//
// The fix is one declared list (AUTH_REQUIRED_SIGNATURES in login.mjs, next to
// the OAuth handshake that cures it) read by every classification site. This
// tester pins both halves: the list recognises the real string, and server.mjs
// actually reads the list instead of re-testing strings inline.
//
// Usage: node test-claude-auth-required-classifier.mjs
//        (cwd = <repo>/user-ai_my-ai_claude-api/src/code)
import { readFileSync } from "node:fs";
import { AUTH_REQUIRED_SIGNATURES, isAuthRequired } from "./login.mjs";

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS  ${n}`))
  : (fail++, console.error(`FAIL  ${n}${d ? `  <- ${d}` : ""}`));

// ── A1 the exact string from Diego's paste classifies as auth-required ───────
const REAL = "claude -p exit 1: Failed to authenticate: OAuth session expired and could not be refreshed · api_error";
check("A1 the reported error classifies as auth-required",
  isAuthRequired(REAL),
  "the OAuth-expired/refresh-failed family still falls through to a generic 502");

// The families that were already handled must not regress out of the list.
for (const [name, sample] of [
  ["never logged in", "Not logged in · Please run /login"],
  ["revoked token", "OAuth token has been revoked"],
  ["expired token", "token has expired"],
  ["refresh token", "refresh token is no longer valid"],
  ["bad key", "invalid_api_key"],
  ["raw 401", "request failed with status 401"],
  ["our own wording", "claude-cli auth required — run 'claude setup-token'"],
]) {
  check(`A2 ${name} classifies as auth-required`, isAuthRequired(sample), sample);
}

// ── A3 a generic failure must STILL be a 502, not a false login prompt ──────
// A classifier that says yes to everything is as useless as one that says no:
// it would answer every crash with "go re-authenticate".
for (const sample of [
  "claude -p exit 1: killed by signal SIGKILL",
  "bad claude json: Unexpected end of JSON input",
  "claude -p timed out after 840s",
  "ENOSPC: no space left on device",
]) {
  check(`A3 generic failure stays non-auth: ${sample.slice(0, 32)}`,
    !isAuthRequired(sample),
    "a generic upstream fault would be mis-answered with the login workflow");
}

check("A4 empty/absent input is not auth-required",
  !isAuthRequired("") && !isAuthRequired(null) && !isAuthRequired(undefined));

// ── B the list is a LIST, declared once ─────────────────────────────────────
check("B1 AUTH_REQUIRED_SIGNATURES is a non-empty array of regexes",
  Array.isArray(AUTH_REQUIRED_SIGNATURES) && AUTH_REQUIRED_SIGNATURES.length > 0
    && AUTH_REQUIRED_SIGNATURES.every((r) => r instanceof RegExp),
  "the signatures must be one declared list, not scattered string tests");

const server = readFileSync("./server.mjs", "utf8");

check("B2 server.mjs imports the shared classifier",
  /import\s*\{[^}]*\bisAuthRequired\b[^}]*\}\s*from\s*"\.\/login\.mjs"/.test(server),
  "server.mjs does not read the one declared list");

// Both classification sites (the spawn-failure path and the response path) must
// call it. Two call sites, zero inline re-tests.
const calls = (server.match(/isAuthRequired\s*\(/g) || []).length;
check("B3 both classification sites call it", calls >= 2,
  `only ${calls} call site(s) — one of the two paths still classifies inline`);

check("B4 no inline auth string test survives in server.mjs",
  !/\/[^\n]*not logged in[^\n]*\/i\s*\.test/.test(server)
  && !/\/auth required\/i\s*\.test/.test(server),
  "an inline signature test remains — it will drift from the declared list");

// The auth verdict must be 401 + the distinct type the bot keys on.
check("B5 the auth verdict is 401 superset_claude_auth_required",
  /send\(401,\s*\{\s*error:\s*\{\s*message,\s*type:\s*"superset_claude_auth_required"/.test(server),
  "the contract the telegram bot detects is gone");

console.log(fail === 0 ? `ALL GREEN (${pass} checks)` : `${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
