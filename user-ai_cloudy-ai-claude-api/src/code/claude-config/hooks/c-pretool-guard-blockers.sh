#!/usr/bin/env bash
# ============================================================================
# c-pretool-guard-blockers.sh — TIER C: PreToolUse(Bash) HARD BLOCKERS
#
# Fires BEFORE every Bash tool call. Inspects the command and EXIT 2's on
# patterns that have NO legitimate use in this declarative stack — making
# the tool call deny outright. stderr message goes to the model so it can
# adjust strategy.
#
# Companion script: c-pretool-guard-warning.sh (same matcher, advisory tier).
# Order in settings.json: blockers FIRST, warnings SECOND.
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
# Deployed: ~/.claude/hooks/c-pretool-guard-blockers.sh (copied by start.sh from /app/claude-config)
#
# Input:  JSON on stdin { "tool_name": "Bash", "tool_input": { "command": "..." } }
# Output: deny reason on stderr, exit 2 → tool call denied + model sees stderr
# ============================================================================

set -euo pipefail

INPUT=$(cat)

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$TOOL_NAME" = "Bash" ] || exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -n "$CMD" ] || exit 0

# ── Helper: hard-deny the tool call ────────────────────────────────────────
# exit 2 → Claude Code blocks the tool call and forwards stderr to the model.
deny() {
    local reason="$1"
    local alt="$2"
    echo "🛑 BLOCKED by c-pretool-guard-blockers.sh: ${reason}" >&2
    echo "   Use instead: ${alt}" >&2
    exit 2
}

# ════════════════════════════════════════════════════════════════════════════
# DENY LIST — patterns with NO legitimate use in this declarative stack
# ════════════════════════════════════════════════════════════════════════════

# ── Secret-leak vector: git add -f / --force bypasses gitignore ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*git\s+(-[Cc]\s+\S+\s+)?add\s+(-f\b|--force\b)'; then
    deny "git add -f/--force bypasses gitignore — can stage decrypted secrets, private keys, sensitive/" \
         "plain 'git add <path>'; if gitignore blocks a file, FIX gitignore — never force"
fi

# ── Volume wipe: docker compose down -v / --volumes ──
if echo "$CMD" | grep -qiE 'docker(-compose|\s+compose)\s+down\s+.*(-v\b|--volumes\b)'; then
    deny "docker compose down -v wipes ALL named volumes (databases, state) — irreversible" \
         "docker compose down (without -v) or build.sh compose"
fi

# ── Volume rm/prune: irreversible per-volume deletion ──
if echo "$CMD" | grep -qiE 'docker\s+volume\s+(rm|prune)\b'; then
    deny "docker volume rm/prune permanently deletes named volumes — irreversible" \
         "manual cleanup only after explicit user confirmation; inspect with 'docker volume ls' first"
fi

# ── docker system prune --volumes: same blast radius as volume prune ──
if echo "$CMD" | grep -qiE 'docker\s+system\s+prune\s+.*--volumes\b'; then
    deny "docker system prune --volumes wipes everything including databases" \
         "targeted cleanup; inspect with 'docker system df' first"
fi

# ── nix-env -i / -iA: imperative install pollutes user profile ──
if echo "$CMD" | grep -qE '(^|\s|;|&&|\|)\s*nix-env\s+(-i|--install|-iA)\b'; then
    deny "nix-env -i is imperative package management — pollutes the user profile and breaks declarative reproducibility" \
         "add the package to flake.nix (home.packages or environment.systemPackages) + build.sh switch"
fi

# ── QEMU / emulated cross-arch build: FORBIDDEN, never an option ──
# arm64 images build NATIVELY on the declared oci-apps runner (cloud-builder-x);
# amd64 on GHA. Source of truth: build-workflows.json .runners[$arch]
# (amd64={type:local}, arm64={type:ssh,host:oci-apps}). Per-arch images are
# merged with `docker manifest create`. Emulated multi-arch builds are slow,
# non-reproducible, and banned outright.
#   - A single-platform `--platform linux/$ARCH` is ALLOWED — the engine uses it
#     as a label on a NATIVE build (the binary is the host's arch regardless).
#   - A MULTI-platform list (`--platform linux/amd64,linux/arm64`) or any
#     qemu/binfmt registration is emulation → DENY.
if echo "$CMD" | grep -qiE '(--platform[[:space:]=]+[^[:space:]|;&]*linux/[a-z0-9]+,)|setup-qemu|tonistiigi/binfmt|multiarch/qemu|qemu-user-static|register[^|;&]*binfmt'; then
    deny "QEMU / emulated multi-arch build is FORBIDDEN — never an option in this declarative stack" \
         "build each arch on its DECLARED native runner (amd64=GHA local, arm64=ssh oci-apps cloud-builder-x) per build-workflows.json .runners, then 'docker manifest create' to merge the single-arch tags"
fi

# ── 7A: imperative plaintext write into .secrets / .env / secrets.yaml ──
# Anchor on command boundary (^|;|&||) so the verb must START a pipeline
# segment — prevents false-positives on quoted phrases in commit messages.
# Targets exact secret files only (.env, .secrets, secrets.yaml/.yml) —
# NOT engine hash artefacts (.secrets-hash, .secrets-hash-new) which
# legitimately get written by build.sh.
#
# Two write idioms:
#   7A.1: echo/printf with > redirect into a secret file
#   7A.2: tee with a secret file as argument (tee writes by argument)
if echo "$CMD" | grep -qE '(^|[;&|])\s*(echo|printf)\b[^|;]*>>?\s*[^|;]*((^|/)\.env([[:space:];|&]|$)|(^|/)\.secrets([[:space:];|&]|$)|secrets\.ya?ml([[:space:];|&]|$))'; then
    deny "imperative write (echo/printf >) to .secrets/.env/secrets.yaml bypasses sops" \
         "edit src/secrets.yaml + build.sh secrets"
fi
if echo "$CMD" | grep -qE '(^|[;&|])\s*tee\b[^|;]*\s+[^|;]*((^|/)\.env([[:space:];|&]|$)|(^|/)\.secrets([[:space:];|&]|$)|secrets\.ya?ml([[:space:];|&]|$))'; then
    deny "tee writing to .secrets/.env/secrets.yaml bypasses sops" \
         "edit src/secrets.yaml + build.sh secrets"
fi

# ── 7B: git add of secret-shaped paths ──
# Anchor on command boundary so `git add` must be the actual subcommand —
# `git commit -m "...git add..."` (literal phrase in message) won't trip.
# Targets:
#   - file extensions: .env, .key, .pem, .age, .p12, .pfx (whole token)
#   - literal .secrets file (NOT .secrets-hash / .secrets-hash-new — those
#     are SHA records written by the build engine, safe to commit)
#   - secrets.yaml / secrets.yml (gated on sops marker — see carve-out b)
# Carve-outs:
#   (a) inside ~/git/cloud-vault/  (private repo, sops-encrypted at rest)
#   (b) secrets.yaml that contains the sops marker (^sops: or ENC[AES256_GCM)
if echo "$CMD" | grep -qE '(^|[;&|])\s*git\s+(-[Cc]\s+\S+\s+)?add\b[^;|&]*(\.(env|key|pem|age|p12|pfx)([[:space:];|&]|$)|(^|/)\.secrets([[:space:];|&]|$)|secrets\.ya?ml([[:space:];|&]|$))'; then
    case "$PWD" in "$HOME"/git/cloud-vault*) exit 0 ;; esac
    # Iterate ALL secret-shape tokens in the command. Per-token rules:
    #   - deletion (file not on disk) → safe (git tracks removal of prior content)
    #   - secrets.yaml + sops marker → safe
    #   - anything else (.env/.key/.pem/.age/.p12/.pfx/.secrets/plaintext yaml) → deny
    all_safe=1
    unsafe=""
    tokens=$(echo "$CMD" | grep -oE '[^[:space:]]+\.(env|key|pem|age|p12|pfx)\b|[^[:space:]]*(^|/)\.secrets\b|[^[:space:]]*secrets\.ya?ml\b' 2>/dev/null || true)
    for tok in $tokens; do
        [ ! -e "$tok" ] && continue   # deletion → safe
        case "$tok" in
            *secrets.yaml|*secrets.yml)
                if grep -qE '^sops:|ENC\[AES256_GCM' "$tok" 2>/dev/null; then
                    continue   # encrypted → safe
                fi
                ;;
        esac
        all_safe=0
        unsafe="$tok"
        break
    done
    if [ "$all_safe" -eq 1 ]; then
        exit 0
    fi
    deny "git add of secret-shaped path '$unsafe' — public-repo exposure risk" \
         "sops-encrypt secrets.yaml first; raw key material lives only in ~/git/cloud-vault"
fi

# Note: SSH write-redirect (ssh <host> '... echo/sed/tee/cat ... >') was
# previously a hard block. Demoted to advisory in c-pretool-guard-warning.sh
# 2026-05-07 — sometimes legitimate (one-shot debug, capturing remote output
# locally), so warn-only is the right tier.

# ── Default: allow (no blocker pattern matched) ──
exit 0
