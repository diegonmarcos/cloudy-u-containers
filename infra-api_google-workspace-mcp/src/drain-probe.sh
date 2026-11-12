#!/bin/sh
# Which long jobs are alive in THIS google-workspace-mcp container (#1659): the one answer the
# ship engine asks before it recreates the container (build.json deploy.drain, run by
# cloud-ship-container-step-deploy-drain.sh / the drain waiter on the VM).
#
# A recreate SIGKILLs everything in the container. Two kinds of work live here for hours:
#   - an unzip-to-Drive job (start_drive_unzip): a thread of the server. It registers itself in
#     $TMP/unzip-<id>/ACTIVE ("<server pid> <server start time>") for as long as it runs.
#   - a script someone runs with `docker exec` (the Takeout and repository backups of 2026-11-11
#     were two python processes beside the server): any python process that is not the server.
# The engine pipes this file into the container (`docker exec -i C sh -s -- <mode>`), so the copy
# that runs is the one at the shipped sha, and it also works on a container whose image predates it.
#
# Usage: drain-probe.sh [list | hold <until-epoch> | release]
#   list     print one line per live job; nothing at all means drained.
#   hold     close admission until <until-epoch> (start_drive_unzip refuses new jobs while it
#            holds), THEN list. Marker first, list second: the server registers a job first and
#            checks the hold second, so a job racing a drain is listed here or refused there.
#   release  reopen admission now.
#
# env WORKSPACE_MCP_TMP_DIR (default /tmp/workspace-mcp); PROBE_PROC (default /proc) exists only
# so the tester can plant processes.
set -u
TMP=${WORKSPACE_MCP_TMP_DIR:-/tmp/workspace-mcp}
PROC=${PROBE_PROC:-/proc}
HOLD=$TMP/.deploy-hold
case "${1:-list}" in
  release) rm -f "$HOLD"; exit 0 ;;
  hold)    mkdir -p "$TMP" && echo "${2:?hold needs an until-epoch}" > "$HOLD.tmp" && mv "$HOLD.tmp" "$HOLD" || exit 2 ;;
  list)    ;;
  *)       echo "drain-probe.sh: unknown mode: $1" >&2; exit 64 ;;
esac
cmd() { tr '\0' ' ' 2>/dev/null < "$PROC/$1/cmdline"; }
# start time of a pid: field 22 of stat, counted after the ") " that ends the command name
started() { sed 's/.*) //' "$PROC/$1/stat" 2>/dev/null | cut -d' ' -f20; }

# 1. unzip jobs registered by the running server
for f in "$TMP"/unzip-*/ACTIVE; do
  [ -f "$f" ] || continue
  set -- $(cat "$f" 2>/dev/null)
  [ $# -eq 2 ] || continue
  # live only while that pid is still the same server process: a killed server leaves the file
  # behind, and a recycled pid must not read as a job.
  [ -d "$PROC/$1" ] && [ "$(started "$1")" = "$2" ] || continue
  d=${f%/ACTIVE}
  echo "unzip-job id=${d##*/unzip-} server_pid=$1"
done

# 2. python processes beside the server (scripts run with docker exec)
for p in "$PROC"/[0-9]*; do
  c=$(cmd "${p##*/}")
  case "$c" in *python*) ;; *) continue ;; esac
  case "$c" in *" main.py "*|*" main.py"|"uv run "*|*"/uv run "*) continue ;; esac
  echo "process pid=${p##*/} cmd=$(printf '%s' "$c" | cut -c1-120)"
done
exit 0
