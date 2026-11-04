#!/usr/bin/env bash
# start.sh — supervise the two superset processes in one container:
#   1. compress_service  (Python/FastAPI · vendored Headroom)  — must come up first
#   2. server.mjs        (Node front · OpenAI/Ollama/Anthropic → claude CLI)
#
# tini (compose init:true) is PID1 and reaps the short-lived `claude -p` children.
# This script is the foreground process: if EITHER service dies, kill the other
# and exit non-zero so the container stops (no auto-restart — recovery is a ship).
set -euo pipefail

HEADROOM_PORT="${HEADROOM_PORT:-8787}"

# Claude parity config: re-sync hooks/skills/CLAUDE.md/ponytail from the image and
# render the HTTP MCP servers on every boot. The claude_home volume mounts over the
# whole home and seeds from the image only once, so baked ~/.claude files would never
# update — syncing here makes redeploys propagate. Never touches ~/.claude.json's login.
CLAUDE_DIR="${HOME}/.claude"
mkdir -p "${CLAUDE_DIR}/skills"
cp -rf /app/claude-config/CLAUDE.md /app/claude-config/settings.json \
       /app/claude-config/hooks /app/claude-config/ponytail "${CLAUDE_DIR}/"
cp -rf /app/claude-config/skills/. "${CLAUDE_DIR}/skills/"
chmod +x "${CLAUDE_DIR}"/hooks/*.sh 2>/dev/null || true
if [ -n "${AUTHELIA_OIDC_TOKEN_CLAUDE_ADMIN:-}" ]; then
  node /app/claude-config/render-mcp.mjs || echo "[start] WARN: MCP render failed; continuing" >&2
else
  echo "[start] AUTHELIA_OIDC_TOKEN_CLAUDE_ADMIN unset; skipping MCP servers" >&2
fi

# ── claude CLI refresh ───────────────────────────────────────────────────
# ONE declaration: _shared/agent-toolbelt.json#npm_globals, handed to this
# container by _shared/engine.nix as AGENT_NPM_GLOBALS (package -> channel +
# min_version). Nothing here names a package or a version: a literal would be a
# second, quietly older declaration of which CLI the agents run, which is exactly
# the defect — the image install pins whatever the last build fetched and a cached
# layer froze it, so `claude -p` started answering "Update to 2.1.255+/2.1.280+ to
# use newer models" for models build.json declares, with nothing saying the CLI
# was the problem.
#
# Runs on EVERY boot, so a `--force-recreate` deploy is enough to pick up a new
# CLI — no image rebuild. Idempotent: npm re-resolves the dist-tag and does
# nothing when the installed version already matches. Writes into
# $NPM_CONFIG_PREFIX (appuser-owned, inside the persisted home volume).
#
# NEVER fatal, NEVER silent: an old CLI still answers, and killing PID1 over a
# registry hiccup would be the worse outage — but every outcome prints, and a
# version below the declared floor prints ERROR rather than serving models the
# declaration claims exist.
refresh_npm_globals() {
  local plan pkg channel floor have prefix
  prefix="${NPM_CONFIG_PREFIX:-}"
  if [ -z "${AGENT_NPM_GLOBALS:-}" ]; then
    echo "[claude-cli] ERROR: AGENT_NPM_GLOBALS undeclared — NOT refreshed; running whatever the image baked ($(claude --version 2>/dev/null || echo 'no claude'))" >&2
    return 0
  fi
  if ! plan="$(printf '%s' "${AGENT_NPM_GLOBALS}" | python3 -c '
import json, sys
for pkg, spec in json.loads(sys.stdin.read()).items():
    print("\t".join([pkg, spec.get("channel") or "latest", spec.get("min_version") or ""]))
' 2>&1)"; then
    echo "[claude-cli] ERROR: AGENT_NPM_GLOBALS unreadable (${plan}) — NOT refreshed" >&2
    return 0
  fi

  printf '%s\n' "${plan}" | while IFS="$(printf '\t')" read -r pkg channel floor; do
    [ -n "${pkg}" ] || continue
    echo "[claude-cli] installing ${pkg}@${channel} into ${prefix:-npm default prefix}"
    # Bounded: this is on the boot path, so a registry that accepts the
    # connection and then stalls must not keep the container from ever starting.
    if ! timeout 300 npm install -g --no-fund --no-audit "${pkg}@${channel}"; then
      echo "[claude-cli] ERROR: ${pkg}@${channel} install FAILED — continuing on the baked version" >&2
    fi
    have="$(node -p "require('${prefix}/lib/node_modules/${pkg}/package.json').version" 2>/dev/null || true)"
    if [ -z "${have}" ]; then
      echo "[claude-cli] ERROR: ${pkg} version unreadable after install — declared floor ${floor:-none} UNVERIFIED" >&2
    elif [ -n "${floor}" ] \
      && [ "$(printf '%s\n%s\n' "${floor}" "${have}" | sort -V | head -n1)" != "${floor}" ]; then
      echo "[claude-cli] ERROR: ${pkg} ${have} is BELOW the declared floor ${floor} — the declared models will be REJECTED" >&2
    else
      echo "[claude-cli] ${pkg} ${have} (floor ${floor:-none}) OK"
    fi
  done
}
refresh_npm_globals

# ── Git identity + agent workspace ───────────────────────────────────────
# The token is delivered by the .secrets env_file (sops -> GH_TOKEN), never
# baked into the image. It is handed to git by a credential helper that reads
# $GH_TOKEN at call time, so the token never lands in .git/config or on the
# persistent volume.
# NEVER let workspace setup kill the container: this script runs under
# `set -e`, so an unguarded `git` call in an image without git exits PID1 and
# the service dies on boot. That is exactly what happened on the first deploy
# of this block (git was installed in the builder stage only), so every command
# here is guarded and non-fatal.
if command -v git >/dev/null 2>&1; then
  git config --global user.name  "Diego" || true
  git config --global user.email "me@diegonmarcos.com" || true
  git config --global credential.helper \
    '!f() { echo username=x-access-token; echo "password=${GH_TOKEN}"; }; f' || true
  git config --global --add safe.directory '*' || true
  # cloud-infra's .gitmodules pins git@github.com: (SSH) for a_solutions and
  # I_cloud. This container has no SSH key, so --recurse-submodules fails
  # SILENTLY: the clone reports success and a_solutions is left EMPTY, which
  # dangles every src/build-*.json symlink and makes the tree look corrupt.
  # Rewriting SSH->HTTPS routes submodules through the same credential helper.
  git config --global url."https://github.com/".insteadOf "git@github.com:" || true
else
  echo "[start] WARN: git not installed; skipping git identity + repo bootstrap" >&2
fi

# Repos live in the persistent home volume, so clones survive redeploys.
#
# ORIGIN IS GITHUB, NOT GITEA — deliberate, do not "optimise" this to gitea:
#   The gitea repos at http://10.0.0.6:3002 are PULL-ONLY MIRRORS, resynced
#   from GitHub hourly. A push to a mirror is ACCEPTED and then DESTROYED on
#   the next sync. Pointing origin at gitea would hand agents a remote that
#   silently eats their work. So: READ-LOCAL / WRITE-UPSTREAM — origin is
#   always GitHub (pushable), and gitea is added as a separate `gitea` remote
#   for fast mesh-local fetches when you explicitly want them.
#   cloud-infra must clone from GitHub regardless: its .gitmodules pins
#   https://github.com/... URLs, so --recurse-submodules leaves the mesh anyway.
#   Ten gitea mirrors are EMPTY (private repos, no GITHUB_MIRROR_TOKEN) —
#   cloud-data, cloud-data-lfs, cloud-me-pvt-my-ai, cloud-notes, dev,
#   front-galaxy-gaia, front-unity, lecole42, cloud-mykonsole-dtk, cloud-vault.
#   Those can ONLY come from GitHub.
# #557: the repo list is DECLARED in build.json (runtime.repos) and arrives as
# JSON in BRIDGE_BOOTSTRAP_REPOS. It used to be a hardcoded shell loop naming
# four repos while the tree actually held seven — three had been cloned by hand
# and would have disappeared on the next volume recreate, and the whole `front`
# family was missing so every agent asked about it was working blind.
#
# These clones run as appuser (uid 10001) because that is who this container is
# (Dockerfile: USER appuser). That matters: gitea used to hold a read-write
# mount on this same volume and ran its supervision tree as root, which left 260
# root-owned paths no agent could write (#558). Cloning from HERE is what keeps
# the tree owned by the uid that has to work in it.
bootstrap_repos() {
  mkdir -p "${HOME}/git"
  cd "${HOME}/git" || return 0

  # Flatten the declaration to TSV so the loop below stays a shell loop:
  #   repo <TAB> dir <TAB> submodules(1|0) <TAB> renamed_from (space-separated)
  # No field may be empty: tab is IFS whitespace, so `read` collapses an empty
  # field and shifts every later one left.
  local plan
  if ! plan="$(printf '%s' "${BRIDGE_BOOTSTRAP_REPOS:-}" | python3 -c '
import json, os, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit("BRIDGE_BOOTSTRAP_REPOS is empty")
for e in json.loads(raw):
    print("\t".join([e["repo"], e.get("dir") or e["repo"], "1" if e.get("submodules") else "0", " ".join(e.get("renamed_from") or [])]))
' 2>&1)"; then
    # Absence must be LOUD. A silent skip here leaves every agent with an empty
    # ~/git and nothing anywhere says why.
    echo "[bootstrap] ERROR: cannot read BRIDGE_BOOTSTRAP_REPOS (${plan}) — NO repos bootstrapped" >&2
    return 0
  fi
  if [ -z "${plan}" ]; then
    echo "[bootstrap] ERROR: BRIDGE_BOOTSTRAP_REPOS declared zero repos — NO repos bootstrapped" >&2
    return 0
  fi

  printf '%s\n' "${plan}" | while IFS="$(printf '\t')" read -r repo dir subs olds; do
    [ -n "${repo}" ] || continue
    # An upstream RENAME (`renamed_from`, e.g. ffront -> front): the checkout under
    # the old name is MOVED to the declared dir and its remotes repointed, so the
    # tree never holds a stale old-name clone beside a fresh one. Only when the new
    # dir is absent — an existing checkout is never overwritten.
    for old in ${olds}; do
      if [ ! -e "${dir}" ] && [ -d "${old}/.git" ]; then
        if mv "${old}" "${dir}"; then
          git -C "${dir}" remote set-url origin "https://github.com/diegonmarcos/${repo}.git"
          git -C "${dir}" remote set-url gitea "http://10.0.0.6:3002/diego/${repo}.git" 2>/dev/null || true
          echo "[bootstrap] renamed ${old} -> ${dir} (upstream rename) and repointed its remotes" >&2
        else
          echo "[bootstrap] WARN: could not move ${old} -> ${dir}" >&2
        fi
      elif [ -d "${old}/.git" ]; then
        echo "[bootstrap] WARN: both ${old} and ${dir} exist; leaving the old-name checkout for a human" >&2
      fi
    done
    if [ -d "${dir}/.git" ]; then
      echo "[bootstrap] ${dir} already present; leaving it alone" >&2
      continue
    fi
    echo "[bootstrap] cloning ${repo} -> ${dir} from GitHub" >&2
    # cloud-infra without --recurse-submodules leaves a_solutions empty and the
    # tree structurally broken (the build-*.json symlinks all dangle).
    extra=""
    [ "${subs}" = 1 ] && extra="--recurse-submodules"
    # shellcheck disable=SC2086
    if git clone ${extra} "https://github.com/diegonmarcos/${repo}.git" "${dir}"; then
      # Belt and braces: --recurse-submodules can fail without failing the
      # clone, leaving a_solutions empty. Re-run it explicitly and say so.
      if [ "${subs}" = 1 ]; then
        git -C "${dir}" submodule update --init --recursive \
          || echo "[bootstrap] WARN: ${dir} submodule init failed; a_solutions may be empty" >&2
      fi
      git -C "${dir}" remote add gitea "http://10.0.0.6:3002/diego/${repo}.git" 2>/dev/null || true
      # Belt and braces: even if someone runs `git push gitea`, refuse it.
      git -C "${dir}" remote set-url --push gitea DISABLED_pull_only_mirror
    else
      echo "[bootstrap] WARN: ${repo} clone failed; continuing" >&2
    fi
  done
  echo "[bootstrap] done" >&2
}

if [ -n "${GH_TOKEN:-}" ] && command -v git >/dev/null 2>&1; then
  # Detached from the job table on purpose: the supervisor below uses `wait -n`,
  # and an un-disowned background job completing would satisfy that wait and
  # take the whole container down.
  bootstrap_repos &
  disown $! 2>/dev/null || true
else
  echo "[start] GH_TOKEN unset; skipping repo bootstrap (agents will have no repos)" >&2
fi

term() { echo "[start] shutting down"; kill "${PIDS[@]}" 2>/dev/null || true; }
trap term TERM INT

PIDS=()

echo "[start] launching compress_service on :${HEADROOM_PORT}"
python3 /app/py/compress_service.py &
PIDS+=("$!")

# Wait until the compressor answers /readyz (model/pipeline import can take a few s).
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${HEADROOM_PORT}/readyz" >/dev/null 2>&1; then
    echo "[start] compress_service ready (${i}s)"
    break
  fi
  if ! kill -0 "${PIDS[0]}" 2>/dev/null; then
    echo "[start] compress_service died during startup" >&2; exit 1
  fi
  sleep 1
done

# Headroom proxy face (optional): the interactive ANTHROPIC_BASE_URL target.
# Compresses then forwards to Anthropic with the CLIENT's own creds (transparent),
# so a local `claude` keeps full multi-turn/tool behaviour. WG-bound (never 0.0.0.0).
if [ "${HEADROOM_PROXY_ENABLED:-1}" = "1" ]; then
  PROXY_PORT="${HEADROOM_PROXY_PORT:-8789}"
  PROXY_BIND="${HEADROOM_PROXY_BIND:-127.0.0.1}"
  PROXY_BACKEND="${HEADROOM_PROXY_BACKEND:-anthropic}"
  echo "[start] launching headroom proxy on ${PROXY_BIND}:${PROXY_PORT} (backend=${PROXY_BACKEND})"
  headroom proxy --host "$PROXY_BIND" --port "$PROXY_PORT" --backend "$PROXY_BACKEND" &
  PIDS+=("$!")
fi

echo "[start] launching node front"
node /app/server.mjs &
PIDS+=("$!")

# Supervise: first process to exit takes the container down with it.
# Wait on the SERVICE pids explicitly — a bare `wait -n` returns for any
# background job, so an unrelated helper finishing would stop the container.
wait -n "${PIDS[@]}"
code=$?
echo "[start] a process exited (code=${code}); stopping siblings"
term
exit "${code:-1}"
