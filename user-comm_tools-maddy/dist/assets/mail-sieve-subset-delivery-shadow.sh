#!/bin/sh
# mail-sieve-subset-delivery-shadow.sh -- the imap_filter command of Maddy (maddy.conf.tpl) for the #1883 migration of
# the per-message classifier from jq+awk shell to the Rust `maddy-sorter deliver`.
#
# Same contract as mail-sieve-subset-delivery-time.sh (stdin RFC 822, argv {account_name} {sender} {rcpt_to} {subject},
# stdout folder + flags, exit status). Which engine ANSWERS is DELIVER_ENGINE (compose environment):
#
#   shadow (default)  the shell script answers, the Rust engine runs on the same message and is only COMPARED: one
#                     `[deliver-shadow] ok` or `[deliver-shadow] MISMATCH ...` line per message in `docker logs maddy`.
#                     Whatever the Rust side does (crash, hang past 10 s, missing binary) cannot change the answer.
#   rust              the Rust engine answers; if it exits non-zero the shell script answers instead (rollback path
#                     kept per message, and the shell script stays in the image for a one-line switch back).
#   shell             the shell script only, exactly the pre-migration behaviour.
#
# Mail delivery must never break: the message is spooled to a temp file first so both engines read identical bytes,
# and if even that spool fails the shell script is exec'd directly on stdin.
REF=/usr/local/bin/mail-sieve-subset-delivery-time
NEW=/usr/local/bin/maddy-sorter
ENGINE="${DELIVER_ENGINE:-shadow}"

[ "$ENGINE" = "shell" ] && exec "$REF" "$@"

TMP="$(mktemp 2>/dev/null)" || exec "$REF" "$@"
trap 'rm -f "$TMP"' EXIT
cat > "$TMP"

run_new() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 10 "$NEW" deliver "$@" < "$TMP"
  else
    "$NEW" deliver "$@" < "$TMP"
  fi
}

if [ "$ENGINE" = "rust" ] && [ -x "$NEW" ]; then
  NOUT="$(run_new "$@" 2>/dev/null)"
  NRC=$?
  if [ "$NRC" = 0 ]; then
    printf '%s' "$NOUT"
    exit 0
  fi
  printf '[deliver] rust engine failed rc=%s, falling back to the shell script\n' "$NRC" >&2
fi

OUT="$("$REF" "$@" < "$TMP")"
RC=$?

if [ "$ENGINE" = "shadow" ] && [ -x "$NEW" ]; then
  NOUT="$(run_new "$@" 2>/dev/null)"
  NRC=$?
  if [ "$NRC" = "$RC" ] && [ "$NOUT" = "$OUT" ]; then
    printf '[deliver-shadow] ok\n' >&2
  else
    printf '[deliver-shadow] MISMATCH shell_rc=%s rust_rc=%s shell_out=%s rust_out=%s\n' "$RC" "$NRC" "$(printf '%s' "$OUT" | tr '\n' '|')" "$(printf '%s' "$NOUT" | tr '\n' '|')" >&2
  fi
fi

printf '%s' "$OUT"
exit "$RC"
