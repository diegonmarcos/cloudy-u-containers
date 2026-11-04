// gateway.mjs — messaging gateway entry point: Telegram + Mattermost → my-ai-api (via local /v1).
//
// redeploy 2026-07-31: force goose-hermes-parity image (ffb3a8450) into the
// running container — the fix (drop hanging spawnSync /usr/local/bin/goose,
// forward goose over HTTP like hermes) was committed but never rolled out, so
// Telegram→goose still 502'd with `spawnSync ... ETIMEDOUT` on the stale image.
// Zero npm dependencies: uses Node 22 global fetch + global WebSocket.
// Reads env at startup; each platform starts independently (both can run together).
//
// Per-bot code lives under ./bots/ (telegram.mjs, mattermost.mjs, commands.mjs,
// route.mjs). The Telegram bot roster is data-driven — see ./bots.json;
// adding a bot is a JSON edit, no code change.
//
// Env vars:
//   TELEGRAM_BOT_TOKEN          — if set, Telegram long-poll starts (default agent: goose)
//   TELEGRAM_CLAUDE_BOT_TOKEN   — if set, second Telegram long-poll starts (default agent: claude)
//   TELEGRAM_ALLOW_FROM         — comma-separated numeric chat/user ids (empty = deny all, fail-closed)
//   MATTERMOST_ENABLED          — "true" to enable Mattermost WS bridge
//   MATTERMOST_URL              — e.g. http://10.0.0.6:8065
//   MATTERMOST_TOKEN            — bot user token (from .secrets env_file)
//   MYAI_LOCAL_URL              — default "http://127.0.0.1:3217"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTelegram } from "./bots/telegram.mjs";
import { startMattermost } from "./bots/mattermost.mjs";
import { MYAI_LOCAL_URL } from "./bots/route.mjs";

const bots = JSON.parse(readFileSync(join(import.meta.dirname, "bots.json"), "utf8"));

console.log("[gateway] starting — MYAI_LOCAL_URL:", MYAI_LOCAL_URL);
for (const entry of bots.telegram || []) {
  startTelegram({
    tokenEnvVar: entry.token_env,
    chatKeyPrefix: entry.key_prefix,
    logLabel: entry.key_prefix,
    defaultAgent: entry.default_agent,
    requireMention: entry.require_mention,
  });
}
startMattermost();
