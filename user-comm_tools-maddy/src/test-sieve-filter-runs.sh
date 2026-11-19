#!/usr/bin/env bash
# Test: maddy's delivery-time filter and the post-hoc sorter parse and run.
#
# maddy runs mail-sieve-subset-delivery-time.sh (imap_filter command) on
# every incoming message. Its rule program is jq inside a single-quoted
# shell string, so any apostrophe in that program (a comment included) ends
# the string early. The comment added with the G0 auth axis ("the Rust
# sorter's second axis") did that: `sh` then failed with "line 292: syntax
# error", every delivery logged "IMAP filter failed (exit status 2)", and
# no message got its rule flags (2026-11-19, oci-mail).
#
# Checks, under dash (busybox-like POSIX sh, closest to the container) and
# bash:
#   1. both scripts parse (sh -n);
#   2. the delivery-time filter, fed the golden maddy rules
#      (_shared/lib/mail-rules.tests/golden/maddy.json) and a real message,
#      exits 0 and prints a destination folder on line 1;
#   3. no apostrophe inside the filter's single-quoted jq program, except
#      the '' (close-reopen) form the program already uses.
#
# Run: bash src/test-sieve-filter-runs.sh   (exit 0 = pass)
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
DT="$HERE/mail-sieve-subset-delivery-time.sh"
PH="$HERE/mail-sieve-subset-post-hoc.sh"
RULES="$REPO/_shared/lib/mail-rules.tests/golden/maddy.json"
fail=0
ok()  { echo "ok:   $*"; }
bad() { echo "FAIL: $*"; fail=1; }

for f in "$DT" "$PH" "$RULES"; do [ -f "$f" ] || { echo "FAIL: missing $f"; exit 1; }; done
command -v jq >/dev/null || { echo "FAIL: jq is required"; exit 1; }

shells="bash"; command -v dash >/dev/null && shells="dash bash"
for sh in $shells; do
  for f in "$DT" "$PH"; do
    if err=$($sh -n "$f" 2>&1); then ok "$sh -n $(basename "$f")"
    else bad "$sh -n $(basename "$f"): $err"; fi
  done
  msg='From: GitHub <notifications@github.com>\r\nTo: me@example.test\r\nSubject: [repo] Run failed: CI\r\nList-Id: <repo.github.com>\r\n\r\nbody\r\n'
  out=$(printf "$msg" | RULES_PATH="$RULES" $sh "$DT" me@example.test notifications@github.com me@example.test x 2>&1); rc=$?
  first=$(printf '%s\n' "$out" | head -n 1)
  if [ "$rc" -eq 0 ] && [ -n "$first" ] && ! printf '%s' "$out" | grep -qi 'error'; then
    ok "$sh: filter exits 0 and routes to '$first'"
  else
    bad "$sh: filter rc=$rc output: $(printf '%s' "$out" | head -n 3 | tr '\n' ' ')"
  fi
done

# The jq program is the single-quoted argument after `--slurpfile rf "$RULES"`.
prog=$(awk '/--slurpfile rf "\$RULES" '\''/{f=1; next} f && /^'\''\)"$/{exit} f' "$DT")
if [ -z "$prog" ]; then
  bad "could not locate the jq program in $(basename "$DT")"
elif printf '%s\n' "$prog" | sed "s/''//g" | grep -n "'" >/dev/null; then
  bad "bare apostrophe inside the single-quoted jq program: $(printf '%s\n' "$prog" | sed "s/''//g" | grep -n "'" | head -n 2 | tr '\n' ' ')"
else
  ok "no bare apostrophe inside the single-quoted jq program ($(printf '%s\n' "$prog" | wc -l) lines)"
fi

[ "$fail" -eq 0 ] && echo "PASS" || echo "FAILED"
exit "$fail"
