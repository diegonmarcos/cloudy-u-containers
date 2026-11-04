// Tester: what the Telegram user SEES when the claude OAuth credential dies.
//
// Diego's complaint, verbatim: "the error with weboauth should have proper
// error handling to return me the workflow to authenticate it!!!!" — what he
// got instead was route.mjs's raw passthrough:
//   [gateway error 502] {"error":{"message":"claude-cli 502: {\"error\":...
//
// Two rules this pins:
//   1. The auth-required reply is the ACTIONABLE /login → /code workflow, and
//      contains no nested JSON. A JSON blob is not error handling.
//   2. The workflow wording is declared ONCE (route.mjs::oauthLoginWorkflow).
//      The /login command and the automatic recovery both read it, so they can
//      never drift again — they already had.
//
// Usage: node test-bot-auth-required-workflow.mjs
//        (cwd = <repo>/user-ai_my-ai-api/src/code)
import { readFileSync } from "node:fs";
import { oauthLoginWorkflow, authRequiredReply } from "./bots/route.mjs";

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS  ${n}`))
  : (fail++, console.error(`FAIL  ${n}${d ? `  <- ${d}` : ""}`));

const URL = "https://claude.ai/oauth/authorize?code=true&client_id=abc";
const reply = authRequiredReply({ url: URL });

// ── A the user gets the workflow, not a JSON blob ────────────────────────────
check("A1 the reply carries the clickable authorize URL", reply.includes(URL));
check("A2 the reply tells the user to send the code back as /code",
  /\/code <the-code>/.test(reply),
  "no actionable next step — the user cannot finish the handshake");
check("A3 the reply names /login as the way to retry",
  reply.includes("/login"),
  "the user has no way to restart the workflow when the link expires");
check("A4 the reply contains NO nested JSON error blob",
  !reply.includes('{"error"') && !reply.includes('\\"error\\"') && !reply.includes("[gateway error"),
  "raw upstream JSON is exactly the defect being fixed");

// The failure branch must still be words, never JSON, and still point at /login.
const failed = authRequiredReply({ error: "setup-token produced no url" });
check("A5 the auto-login failure branch is words and still offers /login",
  failed.includes("/login") && !failed.includes('{"error"') && !failed.includes("[gateway error"),
  "the degraded path falls back to an opaque blob");

// ── B one wording, two callers ───────────────────────────────────────────────
check("B1 oauthLoginWorkflow is the formatter both callers use",
  typeof oauthLoginWorkflow === "function" && reply.includes(oauthLoginWorkflow(URL)),
  "authRequiredReply does not build its text from the shared formatter");

const commands = readFileSync("./bots/commands.mjs", "utf8");
const route = readFileSync("./bots/route.mjs", "utf8");

check("B2 /login reads the shared wording",
  /import\s*\{[^}]*\boauthLoginWorkflow\b[^}]*\}\s*from\s*"\.\/route\.mjs"/.test(commands)
  && /return oauthLoginWorkflow\(/.test(commands),
  "commands.mjs words the instructions itself — a second copy that will drift");

// The literal instruction sentence may appear EXACTLY once across the two
// modules: inside the formatter. A second occurrence is a duplicated copy.
const SENTENCE = "send the code back as";
const occurrences = (commands + route).split(SENTENCE).length - 1;
check("B3 the instruction sentence exists exactly once", occurrences === 1,
  `found ${occurrences} copies — the single source of truth is broken`);

// ── C the recovery actually triggers on the declared 401 contract ────────────
check("C1 routeToGoose treats upstream 401 as auth-required",
  /res\.status === 401/.test(route),
  "the claude-api's declared 401 auth contract is ignored");
check("C2 the auth branch returns authRequiredReply, not the gateway passthrough",
  /return authRequiredReply\(/.test(route),
  "the auth case can still fall through to `[gateway error ...]`");

// ── D src == dist, or the fix ships nothing (#539) ──────────────────────────
for (const rel of ["bots/route.mjs", "bots/commands.mjs"]) {
  check(`D ${rel} is byte-identical src == dist`,
    readFileSync(`./${rel}`, "utf8") === readFileSync(`../../dist/code/arm64/${rel}`, "utf8"),
    "/app runs the dist copy — a src-only fix is inert");
}

console.log(fail === 0 ? `ALL GREEN (${pass} checks)` : `${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
