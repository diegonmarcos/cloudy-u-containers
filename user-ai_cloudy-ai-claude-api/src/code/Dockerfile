# claude-api-superset — polyglot image (Rust + Python + Node + claude CLI).
#
# Build context (assembled by engine.nix from flake nativeBuild.extraFiles):
#   ./vendor/headroom/   vendored Apache-2.0 Headroom source (maturin/pyo3 + Python)
#   ./py/                compress_service.py (FastAPI sidecar)
#   ./server.mjs         Node front (OpenAI/Ollama/Anthropic → claude CLI)
#   ./package.json
#   ./start.sh           process supervisor
#
# Built on the arm64 cloud-builder-x (oci-apps) — no QEMU. Stage 1 compiles the
# Headroom Rust core via maturin into a wheel; stage 2 is a slim Python+Node
# runtime. Adapted from upstream's own multi-stage Dockerfile (rustls, no openssl).

ARG PYTHON_VERSION=3.13

# ─── Stage 1: build the Headroom wheel (Rust core via maturin) ───────────────
FROM python:${PYTHON_VERSION}-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential g++ curl ca-certificates patchelf git \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir uv

# Rust toolchain (pinned to match the upstream rust-toolchain.toml = 1.95.0).
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:${PATH}
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.95.0

WORKDIR /build
# Headroom (Apache-2.0, https://github.com/chopratejas/headroom) is NOT vendored in this repo: it is
# fetched here at a pinned upstream commit. The full 40-hex commit id is the hash pin (a git commit id
# covers the whole tree) and the build fails loud if the checkout does not resolve to exactly it.
# Upstream version 0.26.0. To bump: change HEADROOM_COMMIT, rebuild.
ARG HEADROOM_COMMIT=9f7f3adfea03710d5e67c4c630b3c8061ff6d161
RUN git init -q /build-src \
    && git -C /build-src fetch -q --depth 1 https://github.com/chopratejas/headroom.git "${HEADROOM_COMMIT}" \
    && git -C /build-src checkout -q FETCH_HEAD \
    && test "$(git -C /build-src rev-parse HEAD)" = "${HEADROOM_COMMIT}" \
    && cp -a /build-src/. /build/ && rm -rf /build/.git /build-src

# Build + install the wheel with the proxy (FastAPI/uvicorn — used by the sidecar)
# and code (AST CodeCompressor) extras. ML extras are intentionally omitted on arm64.
RUN uv pip install --system ".[proxy,code]"

# Fail-loud smoke check: the Rust core must import before we ship.
RUN cd /tmp && python -c "from headroom._core import SmartCrusher; from headroom import compress; print('headroom core OK')"

# ─── Stage 2: runtime (Python + Node + claude CLI) ───────────────────────────
FROM python:${PYTHON_VERSION}-slim AS runtime

ARG NODE_MAJOR=22
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/home/appuser

# The claude CLI itself is NOT installed by a line in this file: it arrives from
# _shared/agent-toolbelt.json#npm_globals through the @AGENT_TOOLBELT_NPM@
# placeholder, the same single declaration start.sh re-installs from on every
# boot. A hand-typed `npm install -g @anthropic-ai/claude-code` here is how the
# CLI went stale in the first place — whatever version the last build fetched got
# frozen into a cached layer, and the agents ended up refusing model ids that
# build.json declares. Edit that JSON, never this line.
#
# Node (for server.mjs + the claude CLI) + curl (start.sh readiness probe) +
# jq (the c-* PreToolUse guard hooks parse the hook JSON with jq).
# bsdutils/util-linux provide `script`, which login.mjs uses to allocate a pty
# for `claude setup-token` (it refuses to run without a tty). Both are normally
# present in the slim base as Essential packages — named explicitly so an image
# rebuild can never silently drop the interactive-login path.
# git is REQUIRED at runtime, not just in the builder stage: start.sh clones the
# agent workspaces and the agents themselves commit and push. It was previously
# installed only in the builder, so the runtime had no git at all.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates jq bsdutils util-linux git \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && @AGENT_TOOLBELT_NPM@ \
    && rm -rf /var/lib/apt/lists/*

# Agent toolbelt (#366, extended to full coverage by #509). This is the image
# every dispatched agent actually runs in: `claude -p` executes here, and those
# agents are told to search the shared six-repository checkout, edit it, commit,
# push, and then prove their own CI went green — which needs a process/network/
# editor toolbelt, not just gh/yq/ripgrep. The package list and the gh/yq
# install are NOT hand-typed here: both placeholders are substituted by
# _shared/engine.nix from the single fleet-wide declaration in
# _shared/agent-toolbelt.json (the same one hermes-agent and my-ai-api consume),
# so this Dockerfile cannot drift from theirs. Edit that JSON, never this line.
#
# jq and git are already installed in the apt line above; the toolbelt's own
# fail-loud `command -v` probe (baked into @AGENT_TOOLBELT_EXTRA_RUN@) still
# checks them, so a regression there is caught here too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends @AGENT_TOOLBELT_APT@ \
    && rm -rf /var/lib/apt/lists/*
RUN @AGENT_TOOLBELT_EXTRA_RUN@

# Python runtime: the installed site-packages (headroom + _core.so + deps) and
# the `headroom` console script, copied from the builder.
# NOTE: CPython's lib dir is major.minor (python3.13) regardless of the patch
# release — and the cloud-builder injects PYTHON_VERSION as the full patch
# (e.g. 3.13.14), so ${PYTHON_VERSION} must NOT be used in this path. Pin
# major.minor to match the `python:3.13-slim` base tag above.
COPY --from=builder /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=builder /usr/local/bin/headroom /usr/local/bin/headroom

# App code.
WORKDIR /app
COPY server.mjs claude-resume.mjs login.mjs sessions-store.mjs package.json /app/
COPY py/ /app/py/
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
# Claude parity config (hooks + ponytail + skills + CLAUDE.md + MCP template).
# Baked under /app (NOT ~/.claude): the claude_home volume mounts over the whole
# home and only seeds once, so start.sh re-syncs from here on every boot.
COPY claude-config /app/claude-config
# #764 shared Jev gate — claude-config/settings.json runs it as a PermissionRequest hook.
COPY jev-gate/ /app/jev-gate/

# Non-root appuser; HOME holds the persisted Claude login + ~/.headroom ledger
# (mounted as the claude_home named volume at runtime).
# /home/appuser/git is the mount point for the shared cloud-git-gh volume —
# the one working tree every agent in this container uses, the same one Gitea
# exposes at /data/git-gh. It must exist HERE, in the image, and already be
# owned by appuser: Docker seeds a fresh named volume from the image content
# at the mount path, and a path the image does not have gets a root-owned
# empty directory instead. appuser cannot clone into that, and the failure
# surfaces as a permission error at the first `git clone` rather than as
# anything pointing at this line.
RUN useradd -r -m -u 10001 appuser \
    && mkdir -p /home/appuser/.claude /home/appuser/.headroom /home/appuser/git \
                /home/appuser/.npm-global/bin \
    && chown -R appuser:appuser /home/appuser /app

# The boot-time claude CLI refresh (start.sh) runs as appuser, and the build-time
# install above lives under root-owned /usr/lib/node_modules — an unprivileged
# `npm install -g` into that tree fails. So global installs are redirected into an
# appuser-owned prefix INSIDE the persisted home volume, and its bin comes FIRST
# on PATH so the refreshed CLI wins over the one the image baked. The baked copy
# stays as the floor: if the refresh cannot reach the registry, `claude` still
# resolves (to the older version, loudly reported) instead of vanishing.
# Set AFTER the build-time install on purpose — moving this ENV above that RUN
# would put the floor inside the volume, where a pre-existing volume hides it.
ENV NPM_CONFIG_PREFIX=/home/appuser/.npm-global \
    PATH=/home/appuser/.npm-global/bin:${PATH}
USER appuser

EXPOSE 3117 11436 8788 8789
CMD ["/app/start.sh"]
