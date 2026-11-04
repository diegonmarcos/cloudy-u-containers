#!/usr/bin/env bash
# ============================================================================
# b-context-inject-prompt.sh — TIER B: UserPromptSubmit context injector
#
# Fires on EVERY user prompt. Emits FIRE rules + Stack Philosophy + checklist
# + forbidden patterns to stdout — Claude Code captures as additionalContext.
# Deliberate per-prompt repetition pressure to prevent mid-session drift.
#
# Source: ~/git/cloud-u-linux/da_my-ai/data/claude
# Provenance: this is a DELIBERATE FORK for the container, not a copy awaiting
#   re-sync. The machines stopped running these scripts — the same behaviour is
#   now cloud-marketplace plugins in the SoT above, registered as a real plugin
#   marketplace rather than settings.json hooks, which is what removed the
#   double injection. This service has no working checkout to read the SoT from
#   and no home-manager to deploy it, so it copies and diverges by design.
#   The header used to name .../src/modules/dotfiles/claude/, a directory that
#   no longer exists anywhere; nothing noticed for months, which is what
#   test-claude-sot.sh's provenance check now prevents.
# Deployed: ~/.claude/hooks/b-context-inject-prompt.sh (copied by start.sh from /app/claude-config)
# Wired in: settings.json → hooks.UserPromptSubmit[0].hooks[0].command
# ============================================================================

cat <<'GUARD'
## CORE PRINCIPLES (non-negotiable — reinforced at EVERY tier of hook injection)

1. **FULLY DECLARATIVE** — every change goes through source files in git; never imperative ad-hoc one-liners.
2. **FULLY DATA-DRIVEN** — data lives in `build.json` / `9_others/*.json`; never hardcoded inline in scripts.
3. **FULLY REPRODUCIBLE** — same input → same output, every time, every machine, every clean build.
4. **IMPERATIVE SOLUTIONS FORBIDDEN** — no `ssh vm 'echo > x'`, no `sed -i` on VMs, no `nix-env -i`, no ad-hoc patches.
5. **FOUND A BUG IN AN ENGINE → FIX IT.** NO HACKS ALLOWED. No workarounds, no temporary bypasses, no "for now" patches.
6. **FOUND A NON-DATA-DRIVEN INLINED HARDCODED SOLUTION → FIX IT.** Move the data to JSON; refactor the script to read it. Never extend a hardcoded list — replace it.
7A. **USE SOPS.** Secrets live in `src/secrets.yaml` (sops+age). Decrypt only into `dist/.secrets` (gitignored). Path: `build.sh secrets`. Never inline credentials in source/scripts/env.
7B. **PREVENT EXPOSURE.** Never `git add` `.env` / `.key` / `.pem` / `.age` / `*secret*` / `dist/.secrets`. `secrets.yaml` may be committed only when it carries the sops marker (`^sops:` block / `ENC[AES256_GCM` values) — content-checked, not filename-trusted. Never `git add -f`. Vault carve-out: raw key material that *is* the credential (age keys, `~/git/cloud-vault/A0_keys/...`).
8. **ASK, DON'T ASSUME.** If intent, architecture, or requirements are unclear, ASK before writing a line. No silent guesses about scope, placement, or wiring — clarify first, code second. Silent guesses become silent commits become silent regressions.

## FIRE RULES (non-negotiable)
1. NO INLINE COMMANDS FULL OF ARGS. NO HACKS EVER. Always fix the engine (`build.sh` / `_engine.sh` / flake) — never bypass it with a one-liner.
2. **INTERVAL CONFIDENCE LEVEL**: By default the model MUST answer at 97.5% confidence. ≤ 2.5% may be extrapolation; ≥ 97.5% MUST be sourced from EVIDENCE (file reads, command output, MCP tool results, fetched docs). NEVER answer with 0 evidences fetched — if no evidence has been gathered yet, fetch it first.
3. NO IMPERATIVE SOLUTION if it is not already DECLARED. An "easy fix" is not a fix — it is a new potential BUG. Declarative always.
4. DATA-DRIVEN ONLY. Never hardcode data in scripts. Use `build.json` or auxiliary `.json` files (in `9_others/`) as the source of truth.
5. A TASK IS NOT DONE UNTIL IT HAS A TESTER. After every solution, design the test that proves it — no task is complete without a test.
6. **NEVER GUESS THE CODE / INFRA ARCHITECTURE — QUERY THE CODE-GRAPH MCP.** Before reasoning about how the code/build/runner/topology works, query it. Reading 5 files and guessing the 6th is the bug — be SURE, THEN act. The servers, the exact way to name their tools, and what to do when you cannot reach them are in **MCP SERVERS** at the end of this block. Follow it literally: MCP tool names are not guessable, and guessing them is what used to end with agents curling the endpoint and mistaking its handshake error for a dead server.

## Stack Philosophy
0. IMPERATIVE SOLUTIONS ARE FORBIDDEN
1. FULLY DECLARATIVE ENVIRONMENT
2. BUILD AND CI/CD ONLY DONE BY UNIVERSAL ENGINES
3. MCP TOOLS USE IS MANDATORY
4. WHEN DETECTED A BUG IN AN ENGINE THE ISSUE MUST BE FIXED IMMEDIATELY NOT BE BYPASSED BY TEMPORARY WORKAROUNDS EVER!

## MANDATORY PRE-ACTION CHECKLIST

Before EVERY modification:
1. **SOURCE CHECK**: Am I editing SOURCE (git `src/`) or DEPLOYED output (VM, dist/, ~/.claude/)?
2. **PIPELINE CHECK**: Am I using `build.sh` or bypassing it?
3. **SECRETS CHECK**: Am I creating secrets via sops pipeline or manually?
4. **SHELL CHECK**: `command -v` not `which`. Nix source not `sed` on VM.

## FORBIDDEN PATTERNS

| NEVER | ALWAYS |
|-------|--------|
| `ssh vm 'echo > .secrets'` | `src/secrets.yaml` + sops + `build.sh ship` |
| `nix-env -i pkg` | Add to flake + rebuild |
| `sed` on VM `/etc/` files | Edit nix source + deploy |
| `docker compose up` on VM | `build.sh compose` |
| `which cmd` | `command -v cmd` |
| Edit `dist/` files | Edit `src/` + `build.sh build` |
| Edit `~/.claude/CLAUDE.md` | Edit source in `~/git/cloud-infra-desktop/` flakes |
| `cd dir && git mv dir/...` | `git -C /abs/path mv ...` (absolute paths) |
| `git add -f` / `git add --force` | plain `git add` — NEVER bypass gitignore. `-f` force-stages secrets, decrypted keys, sensitive/ — gitignore exists for a reason. |

## DEAD SHELL RECOVERY

If Bash fails on everything (even `echo test`), the CWD was deleted by git mv/rm.
**Fix**: Use `Write` tool to create a dummy file at the dead path → restores CWD → Bash works again.
Then clean up with `git checkout HEAD -- path/` or continue with absolute paths.
GUARD

# ── MCP SERVERS (data-driven) ────────────────────────────────────────────────
# The server list is NOT restated here: mcp.tpl.json is what render-mcp.mjs
# actually writes into ~/.claude.json at boot, so reading it is the only way this
# block cannot drift out of date. Keys only — the values carry the bearer token
# and must never reach a model's context.
#
# mcp.tpl.json is itself GENERATED (cloud-u-linux gen-mcp-tpl.sh, from
# cloud-infra's derived server list), so the names printed here are the fleet's
# canonical ones. When it was hand-written this block faithfully printed seven
# invented keys, which is worse than printing nothing: the list looked
# authoritative and no `mcp__` name built from it matched anything elsewhere.
#
# WHY this block exists at all: agents were told to call `octocode_search` /
# `c3_*`, which are not tool names on any server here. Finding no such tool, an
# agent would curl https://mcp.diegonmarcos.com/... directly, get back
# HTTP 400 "Bad Request: Server not initialized" — the streamable-HTTP MCP
# transport refusing a request that skipped `initialize` — read that as "the
# code graph is down", and silently fall back to grepping. The tool was never
# down. Nobody saw an error, so nobody noticed the graph had stopped being
# consulted at all.
MCP_TPL="${MCP_TPL:-/app/claude-config/mcp.tpl.json}"
if [ -r "$MCP_TPL" ] && command -v jq >/dev/null 2>&1; then
  printf '\n## MCP SERVERS\n\nWired into this container (source: %s):\n' "$MCP_TPL"
  jq -r '.mcpServers | keys[] | "- " + .' "$MCP_TPL"
  cat <<'MCPGUARD'

Their tools are DEFERRED — they are NOT in your initial tool list, and their
absence there means nothing about whether the server is up. Discover them, never
guess:

  ToolSearch("select:mcp__<server>__<tool>")  when you already know the exact name
  ToolSearch("<keywords>")                    when you do not

Every name has the form `mcp__<server>__<tool>`, where `<server>` is one of the
keys listed above and `<tool>` is the server's own tool name with dots replaced
by underscores (`cgc.octocode.search` becomes `cgc_octocode_search`). A bare
`octocode_search`, `knowledge_spec` or `c3_*` is NOT a tool and never was.

DO NOT curl these URLs as a fallback. They are streamable-HTTP MCP endpoints: any
request that arrives without a prior `initialize` on the same `Mcp-Session-Id`
gets HTTP 400 `{"code":-32000,"message":"Bad Request: Server not initialized"}`.
That 400 means YOU skipped the handshake. It does not mean the server is down.

If ToolSearch genuinely cannot reach a server listed above, SAY SO IN YOUR REPORT
and mark every architectural claim you made without it as unverified. Never
silently fall back to grep: a wrong answer from grep looks exactly like a right
one, and a dependency that degrades quietly costs more than one that fails loudly.
MCPGUARD
else
  printf '\n## MCP SERVERS\n\nCould not read %s — the MCP server list is UNKNOWN.\n' "$MCP_TPL"
  printf 'Treat the code-graph MCP as unavailable, say so in your report, and mark\n'
  printf 'every architectural claim you make without it as unverified.\n'
fi
