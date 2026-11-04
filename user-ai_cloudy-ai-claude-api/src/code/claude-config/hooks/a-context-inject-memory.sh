#!/usr/bin/env bash
# ============================================================================
# a-context-inject-memory.sh — TIER A: SessionStart context injector
#
# Fires once per Claude Code session. Emits the mandatory pre-action checklist
# + forbidden-pattern table to stdout — Claude Code captures it as
# additionalContext, persisting in the conversation prompt for the whole
# session.
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
# Deployed: ~/.claude/hooks/a-context-inject-memory.sh (copied by start.sh from /app/claude-config)
# Wired in: settings.json → hooks.SessionStart[0].hooks[0].command
#
# Tier model:
#   a) SessionStart       → CLAUDE.md + a-context-inject-memory.sh
#   b) UserPromptSubmit   → b-context-inject-prompt.sh
#   c) PreToolUse(Bash)   → c-pretool-guard-blockers.sh (deny patterns)
#                         + c-pretool-guard-warning.sh (advisory patterns)
# ============================================================================

# ── TIER A.1: the agentic memory system (#556) ──────────────────────────────
# This script has been called "inject-memory" since it was written and injected
# no memory whatsoever — only the checklist below. Meanwhile a real store sat
# mounted in the shared tree at AGENT_MEMORY_DIR: a MEMORY.md index over ~169
# entries. Every agent that ever ran here started with zero recall, and nothing
# said so, because the hook's own name made it look handled.
#
# ONLY the index is injected. Entries under memory-entries/<repo>/<child>/ are read on
# demand with the Read tool, never preloaded — a layout where the entry
# directory auto-loads has already turned a 4.5k-token preload into 87k once.
#
# Absence is LOUD. If the store is unreachable the agent is told, in the same
# breath, that it is running WITHOUT memory. A hook that silently emits nothing
# is indistinguishable from a hook whose memory happens to be empty, and that
# is the failure this whole tier exists to prevent.
_mem_dir="${AGENT_MEMORY_DIR:-}"
_mem_index="${AGENT_MEMORY_INDEX:-memory/MEMORY.md}"
_mem_entries="${AGENT_MEMORY_ENTRIES:-memory-entries}"
_mem_types="${AGENT_MEMORY_TYPES:-feedback project reference user}"

if [ -z "${_mem_dir}" ]; then
  echo "## MEMORY: UNAVAILABLE"
  echo
  echo "AGENT_MEMORY_DIR is not set, so no memory index could be loaded. You are"
  echo "running WITHOUT recall of previous sessions. Say so if asked what you"
  echo "remember — do not answer from the conversation alone as though it were memory."
elif [ ! -r "${_mem_dir}/${_mem_index}" ]; then
  echo "## MEMORY: UNREACHABLE"
  echo
  echo "The memory index ${_mem_dir}/${_mem_index} could not be read, so you are"
  echo "running WITHOUT recall of previous sessions. The shared git tree may not be"
  echo "mounted, or the clone has not happened yet. Say so if asked what you remember."
else
  echo "## MEMORY INDEX (loaded from ${_mem_dir}/${_mem_index})"
  echo
  echo "This is an INDEX, not the memory itself. Scan it, then Read"
  echo "\`${_mem_dir}/${_mem_entries}/<repo>/<child>/<type>_<name>.md\` only when an entry is"
  echo "relevant to the task in front of you. Never bulk-read the entries."
  echo "Pointers below are relative to the index's own directory, so"
  echo "\`../${_mem_entries}/<repo>/<child>/<type>_<name>.md\` means"
  echo "\`${_mem_dir}/${_mem_entries}/<repo>/<child>/<type>_<name>.md\`."
  echo
  cat "${_mem_dir}/${_mem_index}"
  echo
  echo "### WRITING A NEW MEMORY"
  echo
  echo "1. Write the entry to \`${_mem_dir}/${_mem_entries}/<repo>/<child>/<type>_<name>.md\`"
  echo "   <repo> is a repo under ~/git, <child> a container / apk / project in it"
  echo "   (\`_repo\` = the whole repo), <type> one of: ${_mem_types} — a file-name"
  echo "   PREFIX, never a directory. A new <repo> or <child> must first be declared in the"
  echo "   memory repo's 4___ASSETS___/4.2.Config/layout.json \"memory\" AND created on disk."
  echo "2. Add ONE line to \`${_mem_dir}/${_mem_index}\`:"
  echo "   \`- [Title](../${_mem_entries}/<repo>/<child>/<type>_<name>.md) — hook\` (relative to the index)"
  echo "3. NEVER put entry content in the index — it is paid for on every session."
  echo "   NEVER put any other file or subdirectory beside the index: everything"
  echo "   under a subdirectory there is auto-loaded (~4.5k -> ~87k tokens, measured)."
  echo "4. Check for an existing entry covering the same fact and UPDATE it rather"
  echo "   than creating a near-duplicate."
  echo
  echo "Entries recalled this way reflect what was true when written. If one names a"
  echo "file, flag or container, VERIFY it still exists before acting on it."
fi
echo

cat <<'CHECKLIST'
## CORE PRINCIPLES (non-negotiable — reinforced at EVERY tier of hook injection)

1. **FULLY DECLARATIVE** — every change goes through source files in git; never imperative ad-hoc one-liners.
2. **FULLY DATA-DRIVEN** — data lives in `build.json` / `9_others/*.json`; never hardcoded inline in scripts.
3. **FULLY REPRODUCIBLE** — same input → same output, every time, every machine, every clean build.
4. **IMPERATIVE SOLUTIONS FORBIDDEN** — no `ssh vm 'echo > x'`, no `sed -i` on VMs, no `nix-env -i`, no ad-hoc patches.
5. **FOUND A BUG IN AN ENGINE → FIX IT.** NO HACKS ALLOWED. No workarounds, no temporary bypasses, no "for now" patches. The engine is the contract; bugs in it are root-cause material.
6. **FOUND A NON-DATA-DRIVEN INLINED HARDCODED SOLUTION → FIX IT.** Move the data to JSON, refactor the script to read it. Never extend a hardcoded list — replace it.
7A. **USE SOPS.** Secrets live in `src/secrets.yaml` (sops+age). Decrypt only into `dist/.secrets` (gitignored). Path: `build.sh secrets`. Never inline credentials in source/scripts/env.
7B. **PREVENT EXPOSURE.** Never `git add` `.env` / `.key` / `.pem` / `.age` / `*secret*` / `dist/.secrets`. `secrets.yaml` may be committed only when it carries the sops marker (`^sops:` block / `ENC[AES256_GCM` values) — content-checked, not filename-trusted. Never `git add -f`. Vault carve-out: raw key material that *is* the credential (age keys, `~/git/cloud-vault/A0_keys/...`).
8. **ASK, DON'T ASSUME.** If intent, architecture, or requirements are unclear, ASK before writing a line. No silent guesses about scope, placement, or wiring — clarify first, code second. Silent guesses become silent commits become silent regressions.

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
CHECKLIST
