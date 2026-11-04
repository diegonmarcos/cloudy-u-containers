# Plan: goose backend parity with hermes (kill the hanging binary spawn)

## Symptom
Live error surfaced to the my-ai client / Telegram:
```
[gateway error 502] {"error":{"message":"goose spawn error: spawnSync /usr/local/bin/goose ETIMEDOUT","type":"my_ai_openrouter_error"}}
```

## Root cause (verified)
Two components in `user-ai_my-ai-api`:

1. **`src/code/gateway.mjs`** — the Telegram/Mattermost gateway. Already fixed in
   commit `ffb3a8450`: `routeToGoose` now POSTs to the front `/v1/chat/completions`
   with no `X-Agent-Mode` header. ✅ (this is the "hermes pattern")

2. **`src/code/server.mjs`** — the OpenAI-compatible front (`my_ai_openrouter`).
   **Still broken.** `getAgentMode()` returns `"goose"` when a request carries
   `X-Agent-Mode: goose` OR `model` is `goose` / `goose/*` / `goose:*`. The dispatch
   then calls `callGoose()` → `spawnSync(GOOSE_BIN /usr/local/bin/goose, ["run","--text",…])`
   → the binary hangs → `ETIMEDOUT` → error bubbles up as `my_ai_openrouter_error`.

Hermes works because its mode routes to `callOpenRouter({ messages, model: HERMES_MODEL, extra })`
(server.mjs) — a plain HTTP forward, no binary. Goose must do the identical thing.

## Fix — make goose mode mirror hermes exactly (`src/code/server.mjs`)

1. Add a model const next to `HERMES_MODEL` (~line 50):
   ```js
   const GOOSE_MODEL = process.env.GOOSE_MODEL || DEFAULT_MODEL;
   ```
   `DEFAULT_MODEL` is already `process.env.BRIDGE_DEFAULT_MODEL` = build.json `runtime.model`,
   so this stays data-driven (same as hermes's env-defaulted const).

2. In the dispatch `switch`/`if` block (~line 320), change the goose branch from:
   ```js
   case "goose": return callGoose({ messages });   // or the if-equivalent
   ```
   to mirror hermes:
   ```js
   case "goose": return callOpenRouter({ messages, model: GOOSE_MODEL, extra });
   ```
   (Match hermes's exact call shape — pass `extra` through like hermes does.)

3. **Delete the dead binary machinery** (no other caller — grep to confirm):
   - the entire `callGoose` function (the `// ── Backend: goose binary ──` block)
   - `const GOOSE_BIN = …` (line 47)
   - `const GOOSE_TIMEOUT = …` (line 48)
   - `import { spawnSync } from "node:child_process";` (line 23) — **only if** `spawnSync`
     is used nowhere else in the file (verify with `grep -n spawnSync server.mjs` first;
     if other uses remain, keep the import).

4. Leave the startup log line's `agents=…+goose+hermes` as-is — goose is still a valid mode,
   it just forwards now.

## Do NOT touch
- `gateway.mjs` (already correct).
- `getAgentMode()` — goose detection stays; we only change what the goose branch *does*.
- `compose.nix` `GOOSE_PORT` — harmless leftover; out of scope (optional cleanup only if trivial).
- build.json — no change required (GOOSE_MODEL defaults to runtime.model). Add
  `runtime.goose_model` + a `GOOSE_MODEL` compose env ONLY if you want an explicit override;
  not required for the fix.

## Build + deploy
The deployed image is stale (that's why the live error persists even though the gateway
commit landed). After editing source:
```
cd /home/diego/git/cloud-infra/a_solutions/user-ai_my-ai-api
./build.sh build      # regenerate dist/ from src/
```
Then ship with an actual image rebuild (arm64, oci-apps) — do NOT just `compose up`
(reuses cached image). Use the service's normal ship path:
```
./build.sh ship
```
(If `ship` reuses the cached image, that's the same REMOTE_BUILD rebuild bug tracked in
Phase 6 — flag it, don't hack around it.)

## Verification (the tester — task is not done without it)
1. **Front, goose via header** (from a WG host or on oci-apps):
   ```
   curl -s http://<my-ai-api-wg-ip>:<api-port>/v1/chat/completions \
     -H 'content-type: application/json' -H 'x-agent-mode: goose' \
     -d '{"model":"goose","messages":[{"role":"user","content":"say hi in 3 words"}]}'
   ```
   Expect: HTTP 200 with a normal completion, **no** `spawnSync … ETIMEDOUT`.
2. **Front, goose via model id**: same call without the header, `"model":"goose"` → 200.
3. **Telegram**: send the goose bot a message → it replies (same as hermes).
4. Regression: hermes still replies (`"model":"hermes"` → 200).

## Commit
Single commit on `main`, push (GHA redeploys on push to `a_solutions/*/src/`):
```
fix(my-ai-api): goose front backend forwards to OpenRouter (hermes parity), drop hanging binary spawn
```
