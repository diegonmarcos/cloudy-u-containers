#!/usr/bin/env bash
# start.sh — supervise the my-ai-api processes in one container:
#   1. compress_service  (Python/FastAPI · vendored Headroom)  — best-effort sidecar
#   2. goosed            (goose serve ACP agent, optional)     — best-effort sidecar
#   3. gateway.mjs       (Telegram + Mattermost → goose bridge, optional) — best-effort
#   4. server.mjs        (Node front · core HTTP API :3217)    — lifecycle process
#
# Slimmer than claude-superset-api's start.sh: NO headroom transparent-proxy face
# (no `headroom proxy --backend anthropic` — we route OpenRouter, and the Node
# front forwards directly), NO claude-config sync (the agent is goose, which
# runs on the client, not in this container). The Headroom compression hop
# (compress_service.py) is kept — that is the tokens-optimization plugin.
#
# tini (compose init:true) is PID1 and reaps short-lived fetch children. This
# script execs server.mjs as the final foreground process: the container lives
# and dies only with the core API on :3217. The three sidecars are best-effort
# background jobs — their failure is logged but never takes the container down.
set -euo pipefail

# respawn — run a long-lived service and restart it whenever it exits, so a
# crash never leaves a daemon dead inside a live container (ticket #545: the
# container stays green while the bot is silently down). $1 is a label for the
# log line; the rest is the command to supervise. The caller backgrounds this
# function. Backs off on a rapid crash-loop (2s..30s) so a genuinely broken
# binary cannot spin CPU, but never gives up: the container's lifecycle process
# (server.mjs, exec'd below) decides when the container itself dies, so a
# sidecar exit is a fault to recover from, not a request to stop.
respawn() {
    local label="$1"; shift
    local attempt=1
    local delay=2
    while true; do
        if "$@"; then
            echo "[respawn] ${label}: exited (status 0) — restarting (attempt ${attempt})" >&2
        else
            local rc=$?
            echo "[respawn] ${label}: exited with status ${rc} — restarting (attempt ${attempt})" >&2
        fi
        attempt=$(( attempt + 1 ))
        [ "$attempt" -gt 15 ] && delay=30
        sleep "$delay"
    done
}

HEADROOM_PORT="${HEADROOM_PORT:-8890}"
GOOSE_PORT="${GOOSE_PORT:-3227}"

# Goose reads $XDG_CONFIG_HOME/goose/config.yaml. The Dockerfile bakes the config
# at /app/.config/goose/config.yaml and sets XDG_CONFIG_HOME=/app/.config (outside
# the /home/appuser volume, so it refreshes every deploy). Honour those; only fall
# back if unset.
export HOME="${HOME:-/home/appuser}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/app/.config}"

# ── #556: point goose at the agentic memory system ──────────────────────────
# goose has no session hook and no CLAUDE.md. Its one declarative context
# surface is a .goosehints file (goose 1.44 CONTEXT_FILE_NAMES), read from
# $XDG_CONFIG_HOME/goose/ globally and from the session cwd locally.
#
# It is WRITTEN here rather than baked beside config.yaml in the Dockerfile
# on purpose: baking it would retype the store's path into a source file, and
# a second copy of that path is exactly how cloud-agi-claude ended up with
# AGENT_MEMORY_DIR while goose and hermes had nothing. The text comes from
# AGENT_MEMORY_BRIEFING, which _shared/engine.nix derives from the same
# binding as the git-tree mount the store lives under.
#
# Absence is LOUD, as in claude's hook: a hints file that silently does not
# exist is indistinguishable from an agent whose memory happens to be empty,
# and the agent then answers from the conversation as though it had recall.
_goose_hints="${XDG_CONFIG_HOME}/goose/.goosehints"
if [ -n "${AGENT_MEMORY_BRIEFING:-}" ]; then
  mkdir -p "${XDG_CONFIG_HOME}/goose"
  printf '%s\n' "${AGENT_MEMORY_BRIEFING}" > "${_goose_hints}"
  echo "[start] goose memory hints written to ${_goose_hints} (${AGENT_MEMORY_DIR:-?})"
else
  echo "[start] WARNING: AGENT_MEMORY_BRIEFING is unset — goose will run WITHOUT recall of previous sessions. _shared/engine.nix publishes it to every container with agent.git_tree; if it is missing here, that merge did not reach this service." >&2
fi

# ── #764: Jev pre-flight gate as a goose PreToolUse plugin ───────────────────
# goose 1.44 loads hooks from every subdirectory of ~/.agents/plugins/ (no
# config.yaml key; enabled by default). HOME is the my_ai_home volume, so the
# image cannot place it there — it is re-copied from the baked /app/jev-gate on
# every boot, the same reason claude-api re-syncs its claude-config. The plugin
# IS the shared gate directory: hooks/hooks.json runs jev_gate.py beside it.
# Fail-safe: if the copy fails goose simply runs without the gate.
mkdir -p "${HOME}/.agents/plugins" \
  && rm -rf "${HOME}/.agents/plugins/jev-gate" \
  && cp -r /app/jev-gate "${HOME}/.agents/plugins/jev-gate" \
  && echo "[start] jev-gate goose plugin installed at ${HOME}/.agents/plugins/jev-gate" \
  || echo "[start] WARNING: jev-gate goose plugin not installed — goose runs ungated" >&2
# #765: the gate's UserPromptSubmit hook (goose-prompt) writes the code-graph
# context Jev routed the prompt to into this file, and goose's tom extension
# (declared in configs/goose-config.yaml) injects it into the turn. Exported
# before goosed starts so the daemon and the hooks it spawns share the path.
export GOOSE_MOIM_MESSAGE_FILE="${HOME}/.local/state/jev-gate/goose-context.md"

# Sidecar: compress_service (Headroom tokens-optimization plugin, :HEADROOM_PORT).
# Best-effort — if it exits for any reason, log and continue.
echo "[start] launching compress_service on :${HEADROOM_PORT}"
( python3 /app/py/compress_service.py || echo "[compress_service] exited — sidecar down, container continues" ) &

# Wait until the compressor answers /readyz (model/pipeline import can take a few s).
# If it never comes up, log a warning but do not abort — server.mjs still starts.
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${HEADROOM_PORT}/readyz" >/dev/null 2>&1; then
    echo "[start] compress_service ready (${i}s)"
    break
  fi
  if [ "${i}" -eq 60 ]; then
    echo "[start] compress_service did not become ready in 60s — continuing without it" >&2
  fi
  sleep 1
done

# Sidecar: goosed (ACP remote-agent server).
# Only launch if the secret key is set. Wrapped so that if `goose serve` is an
# unsupported subcommand in this build, the container is not affected.
#
# A goose session starts in the daemon's working directory. The shared git tree
# is mounted at this container's own $HOME/git — the same rule every agent
# container follows, declared as agent.git_tree_mount in build.json — while the
# image WORKDIR is /app. Started from /app, goose sees no repository at all and
# reports the checkout as missing, which is exactly what it was doing. So the
# daemon runs from the tree, and if the tree is not mounted goose does not start
# at all: an agent server with no repositories looks alive and answers every
# question about the code wrongly, which is worse than being plainly absent.
if [ -n "${GOOSE_SERVER__SECRET_KEY:-}" ]; then
  goose_working_directory="${HOME}/git"
  if [ -d "${goose_working_directory}" ]; then
    echo "[goosed] serving on :${GOOSE_PORT} (ACP, X-Secret-Key) from ${goose_working_directory}"
    ( cd "${goose_working_directory}" \
        && goose serve --platform desktop --host 0.0.0.0 --port "${GOOSE_PORT}" \
        || echo "[goosed] serve unavailable — remote agent disabled, container continues" ) &
  else
    echo "[goosed] ERROR: ${goose_working_directory} does not exist — the shared git tree is not mounted, so goose would answer with no repositories. Not starting it." >&2
  fi
else
  echo "[goosed] no secret key — skipping"
fi

# Sidecar: gateway.mjs (messaging bridge).
# Only launch if at least one messaging platform is configured. Supervised by
# respawn (ticket #545): a dead gateway must restart, never leave a green
# container with a bot that answers nothing.
# GATEWAY_ENABLED=false is the #542 split: the bots now run in their own
# container (cloud-agi-bots) with their own lifetime, so this one must NOT
# start a second copy. An explicit opt-out is required rather than relying on
# the token check below — both containers load the SAME sops .secrets, so
# TELEGRAM_BOT_TOKEN is set in both and the condition alone would launch two
# gateways long-polling one bot, which Telegram answers with 409 Conflict.
if [ "${GATEWAY_ENABLED:-auto}" = "false" ]; then
  echo "[start] gateway: disabled by declaration — runs in its own container (#542)"
elif [ -n "${TELEGRAM_BOT_TOKEN:-}" ] || [ "${MATTERMOST_ENABLED:-}" = "true" ]; then
  echo "[start] launching gateway (messaging bridge, supervised)"
  ( respawn gateway node /app/gateway.mjs ) &
else
  echo "[start] gateway: no messaging configured — skipping"
fi

# Core API: server.mjs is the sole lifecycle process.
# exec replaces this shell; the container exits only when server.mjs exits.
echo "[start] launching server.mjs (core API :3217)"
exec node /app/server.mjs
