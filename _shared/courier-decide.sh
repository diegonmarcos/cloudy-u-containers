#!/usr/bin/env bash
# courier-decide.sh — what the containers-push courier (.github/workflows/dispatch-cloud-infra.yml)
# does with one event. Pure decision: reads git, prints key=value lines, dispatches nothing.
#
#   usage: courier-decide.sh <event> <before> <after> [repo-dir]
#   prints: action=ship|render  services=<space-separated>  before=<sha>  after=<sha>
#
# Why: Ship's build refuses a commit whose committed <svc>/dist/ differs from a fresh render of the
# service (step_verify_committed_dist). A push that changes a service's render inputs (anything in the
# service directory except dist/, e.g. src/ or build.json) is followed by a render-dist commit, so
# dispatching Ship at the pushed sha is red by construction (2026-11-18: stalwart, mail-puller, dagu,
# maddy). Such a push is handed to render-dist instead (action=render); render-dist re-enters the
# courier by workflow_dispatch at the commit whose dist matches src, and that event ships.
#
#   workflow_dispatch          -> ship <before>..<after>  (render-dist hand-back; after = render commit
#                                                           or the source commit when dist was fresh)
#   push, no render inputs     -> ship <before>..<after>  (dist-only, _shared/, docs, ... — as before)
#   push, render inputs of S   -> render S                (no Ship dispatch from this event)
#   push, range not diffable   -> ship                    (new branch / purged before: old behaviour)
set -euo pipefail

event=${1:?event}; before=${2:-}; after=${3:?after}; repo=${4:-.}

emit() { printf 'action=%s\nservices=%s\nbefore=%s\nafter=%s\n' "$1" "$2" "$before" "$after"; }

if [ "$event" != "push" ]; then emit ship ""; exit 0; fi

case "$before" in ''|*[!0]*) ;; *) emit ship ""; exit 0;; esac   # all-zero before: branch creation
git -C "$repo" cat-file -e "${before}^{commit}" 2>/dev/null || { emit ship ""; exit 0; }
git -C "$repo" cat-file -e "${after}^{commit}" 2>/dev/null || { emit ship ""; exit 0; }

services=""
while IFS= read -r p; do
  case "$p" in */*) ;; *) continue;; esac
  top=${p%%/*}; rest=${p#*/}
  case "$rest" in dist/*) continue;; esac
  printf '%s' "$top" | grep -Eq '^[a-z0-9][a-z0-9_-]{1,80}$' || continue
  git -C "$repo" cat-file -e "$after:$top/build.json" 2>/dev/null || continue
  git -C "$repo" cat-file -e "$after:$top/build.sh" 2>/dev/null || continue
  case " $services " in *" $top "*) ;; *) services="${services:+$services }$top";; esac
done < <(git -C "$repo" diff --no-renames --name-only "$before" "$after")

if [ -n "$services" ]; then emit render "$services"; else emit ship ""; fi
