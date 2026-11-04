#!/usr/bin/env bash
# ============================================================================
# c-pretool-guard-warning.sh — TIER C: PreToolUse(Bash) ADVISORY warnings
#
# Fires BEFORE every Bash tool call. Pattern-matches the command against
# antipatterns that are sometimes legitimate (debugging, ad-hoc) but usually
# indicate a deviation from the declarative stack. Emits a non-blocking
# stderr warning and exits 0 — Claude Code shows the warning in the
# transcript but proceeds with the tool call.
#
# Companion script: c-pretool-guard-blockers.sh (same matcher; deny tier).
# Order in settings.json: blockers FIRST (may exit 2), warnings SECOND.
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
# Deployed: ~/.claude/hooks/c-pretool-guard-warning.sh (copied by start.sh from /app/claude-config)
#
# Input:  JSON on stdin { "tool_name": "Bash", "tool_input": { "command": "..." } }
# Output: warning text on stderr, exit 0 (never denies, never asks)
# ============================================================================

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$CMD" ] || exit 0

warn() {
    local reason="$1"
    local alt="$2"
    echo "⚠️  pretool-guard WARNING (non-blocking): ${reason}. Better: ${alt}" >&2
    exit 0
}

# ════════════════════════════════════════════════════════════════════════════
# TIER 0: ALWAYS ALLOW — read-only / introspection commands
# Skip every check below for safe commands Claude Code uses internally.
# ════════════════════════════════════════════════════════════════════════════

if echo "$CMD" | grep -qE '^npm\s+(root|config|prefix|ls|list|ll|la|view|info|show|search|help|explain|doctor|audit|outdated|fund|pack|ping|whoami|token|profile|access|bugs|repo|completion|explore|-v|--version|-h|--help)(\s|$)'; then
    exit 0
fi

if echo "$CMD" | grep -qE '^nix\s+(eval|show-derivation|path-info|log|why-depends|store|hash|doctor|registry|--version|--help|-h)(\s|$)'; then
    exit 0
fi
if echo "$CMD" | grep -qE '^nix\s+flake\s+(show|check|info|metadata)(\s|$)'; then
    exit 0
fi
if echo "$CMD" | grep -qE '^nix\s+profile\s+list(\s|$)'; then
    exit 0
fi

if echo "$CMD" | grep -qE '^docker\s+(ps|images|logs|inspect|top|stats|diff|port|version|info|events|history|search|-v|--version|-h|--help)(\s|$)'; then
    exit 0
fi
if echo "$CMD" | grep -qE '^docker\s+(network|volume)\s+(ls|inspect)(\s|$)'; then
    exit 0
fi

if echo "$CMD" | grep -qE '^pip3?\s+(list|show|freeze|check|config|--version|-V|--help|-h)(\s|$)'; then
    exit 0
fi

# ════════════════════════════════════════════════════════════════════════════
# ADVISORY — every match calls warn() (stderr + exit 0). Never blocks.
# Hard-deny patterns moved to c-pretool-guard-blockers.sh.
# ════════════════════════════════════════════════════════════════════════════

# ── Bulk-delete (rsync) ──
if echo "$CMD" | grep -qiE 'rsync\s+.*--delete'; then
    warn "rsync --delete removes remote files not in source" "build.sh deploy"
fi

# ── Package managers: ALWAYS use build.sh deps/build ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npm\s+install(\s|$)'; then
    warn "npm install bypasses declarative build system" "build.sh deps (or build.sh build)"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npm\s+ci(\s|$)'; then
    warn "npm ci bypasses declarative build system" "build.sh deps"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npm\s+run(\s|$)'; then
    warn "npm run bypasses declarative build system" "build.sh build (or build.sh dev)"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npm\s+start(\s|$)'; then
    warn "npm start bypasses declarative build system" "build.sh dev"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npm\s+test(\s|$)'; then
    warn "npm test bypasses declarative build system" "build.sh test"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*npx\s'; then
    warn "npx bypasses declarative build system" "build.sh build (esbuild/tsc/etc are run by the engine)"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*yarn(\s|$)'; then
    warn "yarn bypasses declarative build system" "build.sh deps/build"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*pnpm(\s|$)'; then
    warn "pnpm bypasses declarative build system" "build.sh deps/build"
fi

# ── Nix: ALWAYS use build.sh ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*nix\s+build(\s|$)'; then
    warn "raw nix build bypasses the engine" "build.sh build"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*nix\s+run(\s|$)'; then
    warn "raw nix run bypasses the engine" "build.sh build"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*nixos-rebuild(\s|$)'; then
    warn "raw nixos-rebuild bypasses the engine" "build.sh switch"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*home-manager\s+(switch|build)(\s|$)'; then
    warn "raw home-manager switch/build bypasses the engine" "build.sh switch"
fi

# ── System package managers (not in this stack) ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*apt(-get)?\s+install(\s|$)'; then
    warn "apt install is imperative — Nix flake declarative only" "add to flake.nix"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*brew\s+install(\s|$)'; then
    warn "brew install is imperative" "add to flake.nix"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*pip3?\s+install(\s|$)'; then
    warn "pip install is imperative" "add to flake.nix or use nix-shell"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*conda\s+install(\s|$)'; then
    warn "conda install is imperative" "add to flake.nix"
fi

# ── Docker: ALWAYS use build.sh compose/ship ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*docker\s+compose\s+up(\s|$)'; then
    warn "docker compose up bypasses declarative deploy" "build.sh compose (or build.sh ship)"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*docker-compose\s+up(\s|$)'; then
    warn "docker-compose up bypasses declarative deploy" "build.sh compose"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*docker\s+compose\s+down(\s|$)'; then
    warn "docker compose down bypasses declarative deploy" "build.sh compose"
fi
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*docker\s+exec(\s|$)'; then
    warn "docker exec is imperative — never modify running containers" "docker logs for read-only inspection"
fi

# ── Shell antipatterns ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*which\s'; then
    warn "'which' doesn't exist on Termux/Nix" "command -v"
fi
if echo "$CMD" | grep -qE 'cd\s+[^\s;]+\s*&&\s*git\s+mv'; then
    warn "'cd dir && git mv' kills the shell if CWD is moved" "git -C /absolute/path mv ..."
fi
if echo "$CMD" | grep -qE 'cd\s+[^\s;]+\s*&&\s*rm\s+-rf'; then
    warn "'cd dir && rm -rf' kills the shell if CWD is deleted" "rm -rf /absolute/path (use absolute paths)"
fi

# ── SSH imperatives (advisory — never blocked) ──
if echo "$CMD" | grep -qE 'ssh\s+\S+\s+.*\b(echo|sed|tee|cat|printf)\s.*>>?'; then
    warn "SSH write-redirect on a VM is imperative — declarative stack expects edit-source + build.sh ship" \
         "edit source in git repo (src/) + build.sh ship"
fi
if echo "$CMD" | grep -qE 'ssh\s+\S+\s+.*\bsysctl\s+-w'; then
    warn "SSH sysctl -w is imperative" "add to nix config + build.sh ship"
fi
if echo "$CMD" | grep -qE 'ssh\s+\S+\s+.*\bdocker\s+exec'; then
    warn "docker exec on remote VMs is forbidden" "docker logs via SSH for read-only inspection"
fi

# ── 7: SECRETS — advisory layer (block tier covers git add + imperative writes) ──

# Manual sops decrypt (any form) bypasses the engine
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*sops\s+(-d|--decrypt)\b'; then
    warn "manual sops decrypt bypasses the engine" "build.sh secrets"
fi

# In-place sops decrypt leaves secrets.yaml PLAINTEXT in working tree
if echo "$CMD" | grep -qE '\bsops\s+(-d|--decrypt)\s+(\S+\s+)*-i\b|\bsops\s+-d\s+-i\b|\bsops\s+-i\s+-d\b'; then
    warn "sops -d -i leaves secrets.yaml plaintext on disk — easy accidental git add" \
         "decrypt to stdout (sops -d file | …) or use build.sh secrets"
fi

# SSH write-redirect into a VM secret file
if echo "$CMD" | grep -qE 'ssh\s+\S+.*\.(secrets|env)\b.*>'; then
    warn "SSH write-redirect into a VM secret file bypasses sops" \
         "src/secrets.yaml on host + build.sh ship"
fi

# docker -e with literal long credential value
if echo "$CMD" | grep -qE 'docker\s+(run|exec)\s+.*-e\s+[A-Z_]+=[A-Za-z0-9+/=._-]{16,}'; then
    warn "docker -e with literal credential value — leaks via shell history + ps" \
         "--env-file dist/.secrets (or compose env_file:)"
fi

# curl with literal Bearer/Basic/long auth header
if echo "$CMD" | grep -qE 'curl\s+.*-H\s+["'\''](Authorization|X-API-Key|X-Auth-Token):\s*(Bearer\s+)?[A-Za-z0-9+/=._-]{16,}'; then
    warn "curl with literal token in Authorization header — leaks via history + transcript" \
         'use $TOKEN sourced from dist/.secrets'
fi

# export FOO=<long literal> looks like a hardcoded credential
if echo "$CMD" | grep -qE '(^|\s|;|&&)\s*export\s+[A-Z][A-Z0-9_]*=[A-Za-z0-9+/=._-]{20,}'; then
    warn "export with long literal value looks like a hardcoded credential" \
         "source dist/.secrets instead"
fi

# cat / less / bat on a known secret file leaks to transcript
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*(cat|less|bat|head|tail)\s+[^|;]*(\.secrets\b|/\.env\b|\.key\b|\.pem\b|\.age\b)'; then
    warn "printing secret file to terminal leaks credentials into transcript/cache" \
         'sops --extract for one key, or pipe into a process: source dist/.secrets'
fi

# ════════════════════════════════════════════════════════════════════════════
# DEFAULT: ALLOW — command passed all advisory checks
# ════════════════════════════════════════════════════════════════════════════
exit 0
