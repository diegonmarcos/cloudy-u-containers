// Tester: #542 — the bots are split from the agent runtime BY LIFETIME.
//
// my-ai-api is an agent runtime: every deploy recreates it, killing in-flight
// goose runs. The telegram bots are a service that must survive deploys. They
// shared one container until 2026-09-20, when an evicted deploy left my-ai-api
// in `created` and took BOTH bots down for ~30 minutes.
//
// The subtle trap this guards: both containers load the SAME sops .secrets, so
// TELEGRAM_BOT_TOKEN is set in both. start.sh's original condition would then
// launch a gateway in each — two long-polls on one bot, which Telegram rejects
// with 409 Conflict. The explicit GATEWAY_ENABLED=false opt-out is the fix, and
// its absence is invisible until the bot starts dropping messages.
//
// Usage: node test-bots-lifetime-split.mjs   (cwd = <repo>/user-ai_my-ai-api/src/code)
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const check = (n, c, d = "") => c
  ? (pass++, console.log(`PASS ${n}`))
  : (fail++, console.error(`FAIL ${n}${d ? ` — ${d}` : ""}`));

const compose = readFileSync("../compose.nix", "utf8");
const start = readFileSync("start.sh", "utf8");
const code = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

// ── The opt-out exists and is honoured ──────────────────────────────────────
check("G1 start.sh honours GATEWAY_ENABLED=false",
  /\$\{GATEWAY_ENABLED:-auto\}"?\s*=\s*"false"/.test(start),
  "no explicit opt-out — the shared .secrets token would start a 2nd gateway");

// Order matters: the opt-out must be checked BEFORE the token condition, or the
// token wins and the agent container launches a competing long-poll anyway.
check("G2 the opt-out is tested BEFORE the token check",
  start.indexOf("GATEWAY_ENABLED") < start.indexOf("TELEGRAM_BOT_TOKEN"),
  "token check runs first — opt-out would never be reached");

check("G3 the agent runtime declares GATEWAY_ENABLED = false",
  /GATEWAY_ENABLED\s*=\s*"false"/.test(code(compose)),
  "my-ai-api would still run a gateway alongside the split-out one");

// ── The bots container exists and is a bots container, not a second API ─────
check("B1 cloud-agi-bots is declared",
  /cloud-agi-bots\s*=\s*\{/.test(compose), "no split-out bots service");

// `command` is passed to the image's start.sh ENTRYPOINT as arguments and
// ignored; the container would boot a SECOND full API racing for port 3217.
check("B2 it overrides entrypoint (not command) to run gateway.mjs",
  /cloud-agi-bots[\s\S]{0,900}?entrypoint\s*=\s*\[\s*"node"\s*"\/app\/gateway\.mjs"\s*\]/.test(compose),
  "a `command` override is swallowed by start.sh — it would run the whole API");

check("B3 it publishes no ports",
  !/cloud-agi-bots[\s\S]{0,900}?\bports\s*=/.test(compose),
  "the gateway only makes outbound calls; a bind would collide with my-ai-api");

// A bots service that dies on deploy defeats the whole split.
check("B4 it restarts unless-stopped (survives deploys and reboots)",
  /cloud-agi-bots[\s\S]{0,900}?restart\s*=\s*"unless-stopped"/.test(compose),
  "restart:no would reproduce exactly the outage this split fixes");

// ── Exactly one launcher ────────────────────────────────────────────────────
{
  const launches = [...code(start).matchAll(/node \/app\/gateway\.mjs/g)].length;
  check("X1 start.sh launches the gateway from exactly one place", launches === 1,
    `${launches} launch sites — a second one reintroduces the double long-poll`);
}

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
