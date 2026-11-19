#!/bin/sh
# ╔══════════════════════════════════════════════════════════════════╗
# ║ mail-sieve-subset-delivery-time.sh                               ║
# ║   Maddy per-message delivery-time classifier (Sieve subset).     ║
# ║                                                                  ║
# ║ Wired via maddy.conf.tpl.tpl:                                    ║
# ║   imap_filter {                                                  ║
# ║     command /usr/local/bin/mail-sieve-subset-delivery-time       ║
# ║             {account_name} {sender} {rcpt_to} {subject}          ║
# ║   }                                                              ║
# ║                                                                  ║
# ║ Contract (per Maddy's imap.filter.command protocol):             ║
# ║   stdin        = RFC822 message bytes                            ║
# ║   argv         = {account_name} {sender} {rcpt_to} {subject}     ║
# ║   stdout line 1 = destination folder (empty → INBOX)             ║
# ║   stdout 2+    = IMAP flags to add to that delivery              ║
# ║   stderr       = log lines (visible in `docker logs maddy`)      ║
# ║                                                                  ║
# ║ Sieve-subset rationale:                                          ║
# ║   - Maddy has no native Sieve. imap_filter { command } is its    ║
# ║     official extension hook (see maddy.email/reference/storage/  ║
# ║     imap-filters/). This script implements ~30% of RFC 5228      ║
# ║     covering all predicates the canonical mail-rules.json uses.  ║
# ║   - Same rules are RENDERED to a real Sieve script for Stalwart  ║
# ║     via _shared/lib/derive-mail-rules.ts → toSieve. Single SoT.        ║
# ║                                                                  ║
# ║ Rules input (derived JSON, schema v2):                           ║
# ║   {                                                              ║
# ║     schema_version: 2,                                           ║
# ║     account: "…",                                                ║
# ║     routing_default: "📦 Others",                                ║
# ║     inbox_copy_flags: ["\\Seen"],   (informational)              ║
# ║     rules: [                                                     ║
# ║       { id, priority, when, folder?, flags? }                    ║
# ║     ]                                                            ║
# ║   }                                                              ║
# ║                                                                  ║
# ║ Supported `when` predicate types:                                ║
# ║   from_domain, from_domain_suffix, from_address,                 ║
# ║   to_contains, reply_to_contains,                                ║
# ║   header_contains, header_regex, header_exists,                  ║
# ║   subject_contains, list_id_contains,                            ║
# ║   has_cc, has_bcc, list_header, self_sent,                       ║
# ║   any_of, all_of, not                                            ║
# ║                                                                  ║
# ║ NOT supported (declared `drop` for maddy in canonical):          ║
# ║   size_over, size_under, content_type, body_contains             ║
# ║   (busybox sh can't MIME-parse cheaply — Stalwart's Sieve does)  ║
# ║                                                                  ║
# ║ Semantics:                                                       ║
# ║   - All matching rules contribute flags (union).                 ║
# ║   - First matching rule with a `folder` wins routing.            ║
# ║   - No matching folder → routing_default → INBOX.                ║
# ║                                                                  ║
# ║ Performance audit (vs prior mail-filter.sh):                     ║
# ║   - ONE jq invocation per message (was 2). Saves ~10ms cold.     ║
# ║   - schema_version pinned: refuses to run if != 2.               ║
# ║   - Unknown predicate type: stderr warn + treats as no-match     ║
# ║     (was: silently false → could lose mail).                     ║
# ║   - RFC 2047 encoded-word decoding for Subject (=?utf-8?B?...?=) ║
# ║   - MAIL_SIEVE_DEBUG=1 → emits decision trace to stderr.         ║
# ╚══════════════════════════════════════════════════════════════════╝
set -eu

RULES="${RULES_PATH:-/data/mail-rules.json}"
DEBUG="${MAIL_SIEVE_DEBUG:-0}"

ACCOUNT_NAME="${1:-}"
SENDER="${2:-}"
RCPT_TO="${3:-}"
# ARG_SUBJECT="${4:-}"   # not used — we parse the real Subject from stdin

log() { [ "$DEBUG" = "1" ] && printf '[mail-sieve] %s\n' "$*" >&2 || true; }
err() { printf '[mail-sieve] ERROR: %s\n' "$*" >&2; }

# Schema version pin — fail loud if rules format changed.
SCHEMA_VER="$(jq -r '.schema_version // 0' "$RULES" 2>/dev/null || echo 0)"
if [ "$SCHEMA_VER" != "2" ]; then
  err "rules schema_version='$SCHEMA_VER', expected 2 — refusing to run"
  exit 0   # exit 0 → Maddy keeps default INBOX delivery, no mail loss
fi

# Capture headers (first block, up to the blank line separating body).
HEADERS="$(awk 'BEGIN{RS="";ORS=""} NR==1{print;exit}')"

# RFC 2047 encoded-word decoder (best-effort).
# Decodes =?charset?B?base64?= and =?charset?Q?quoted-printable?= forms.
#
# IMPORTANT: this runs inside the maddy alpine container, which ships
# BUSYBOX awk — NOT gawk. busybox awk has NO `strtonum()`. Calling it
# aborts the awk process with "Call to undefined function" → `set -e`
# kills the whole filter → maddy logs `imap_filter failed: exit status 2`
# → message lands in INBOX. ALL real mail with RFC 2047 subjects (every
# GitHub notification, every CI mail, anything non-ASCII) hit this path.
#
# Fix: avoid strtonum entirely. We:
#   - decode quoted-printable bytes with a hand-rolled hex2num lookup
#     (busybox awk has only index/substr — no number-base parsers)
#   - wrap the awk + base64 invocations in `|| true` so any unexpected
#     decode failure degrades gracefully (raw subject passes through),
#     never aborting the filter
#
# Both decode paths handle errors silently: if base64 fails, the raw
# (encoded) subject is still usable for `subject_contains` predicates
# matching ASCII keywords. The previous behavior was strictly worse —
# total filter failure for the entire message.
decode_2047() {
  printf '%s' "$1" | awk '
    function hex2num(s,    n, i, c, lookup) {
      # busybox awk has no strtonum() — build a portable hex parser.
      lookup = "0123456789ABCDEF"
      s = toupper(s)
      n = 0
      for (i = 1; i <= length(s); i++) {
        c = index(lookup, substr(s, i, 1)) - 1
        if (c < 0) return 0   # unparseable → byte 0 (best-effort)
        n = n * 16 + c
      }
      return n
    }
    function b64dec(s,    cmd, r) {
      cmd = "printf %s \"" s "\" | base64 -d 2>/dev/null"
      r = ""
      cmd | getline r
      close(cmd)
      return r
    }
    function qpdec(s,    out) {
      gsub(/_/, " ", s)
      while (match(s, /=[0-9A-Fa-f][0-9A-Fa-f]/)) {
        out = out substr(s, 1, RSTART-1) sprintf("%c", hex2num(substr(s, RSTART+1, 2)))
        s = substr(s, RSTART+RLENGTH)
      }
      return out s
    }
    {
      while (match($0, /=\?[^?]+\?[BbQq]\?[^?]*\?=/)) {
        head = substr($0, 1, RSTART-1)
        word = substr($0, RSTART, RLENGTH)
        rest = substr($0, RSTART+RLENGTH)
        n = split(word, parts, "?")  # =?cs?enc?data?=  → 5 parts
        enc = tolower(parts[3])
        data = parts[4]
        decoded = (enc == "b") ? b64dec(data) : (enc == "q") ? qpdec(data) : data
        $0 = head decoded rest
      }
      print
    }
  ' || printf '%s' "$1"
}

# Case-insensitive header extraction. Handles folded continuation lines.
get_header() {
  printf '%s\n' "$HEADERS" | awk -v n="$1" '
    BEGIN { name = tolower(n); ln = length(name) + 1 }
    /^[ \t]/ { if (capture) { sub(/^[ \t]+/, " "); val = val $0 } ; next }
    {
      capture = 0
      low = tolower($0)
      if (substr(low, 1, ln) == name ":") {
        val = substr($0, ln + 1)
        sub(/^[ \t]+/, "", val)
        capture = 1
      }
    }
    END { print val }
  '
}

addr_from_header() {
  hdr="$1"
  [ -z "$hdr" ] && hdr="$SENDER"
  printf '%s\n' "$hdr" | awk '
    {
      if (match($0, /<[^>]+>/)) { print substr($0, RSTART+1, RLENGTH-2); exit }
      for (i=1; i<=NF; i++) if ($i ~ /@/) { gsub(/[<>,;"]/, "", $i); print $i; exit }
    }
  '
}

FROM_HDR="$(get_header From)"
TO_HDR="$(get_header To)"
CC_HDR="$(get_header Cc)"
BCC_HDR="$(get_header Bcc)"
REPLYTO_HDR="$(get_header Reply-To)"
SUBJECT_HDR="$(decode_2047 "$(get_header Subject)")"
LISTID_HDR="$(get_header List-Id)"

FROM_ADDR="$(addr_from_header "$FROM_HDR")"
FROM_DOMAIN="$(printf '%s' "${FROM_ADDR##*@}" | tr '[:upper:]' '[:lower:]')"

log "from=$FROM_ADDR domain=$FROM_DOMAIN subject=$SUBJECT_HDR"

# ── Single-pass jq evaluator ─────────────────────────────────────
# Replaces the previous two-jq-invocation approach (build ctx, then evaluate).
# One process, one parse of /data/mail-rules.json, one evaluation pass.
# Unknown predicate types log to stderr via debug attr (consumed by caller).
OUT="$(jq -n -r \
  --arg acct       "$ACCOUNT_NAME" \
  --arg sender     "$SENDER" \
  --arg rcpt       "$RCPT_TO" \
  --arg from_dom   "$FROM_DOMAIN" \
  --arg from_addr  "$FROM_ADDR" \
  --arg to         "$TO_HDR" \
  --arg cc         "$CC_HDR" \
  --arg bcc        "$BCC_HDR" \
  --arg reply_to   "$REPLYTO_HDR" \
  --arg subject    "$SUBJECT_HDR" \
  --arg list_id    "$LISTID_HDR" \
  --arg headers    "$HEADERS" \
  --slurpfile rf "$RULES" '
  # ── ctx ────────────────────────────────────────────────────────
  {
    account:      $acct,
    sender:       $sender,
    rcpt_to:      $rcpt,
    from_domain:  ($from_dom // "" | ascii_downcase),
    from_address: ($from_addr // "" | ascii_downcase),
    to_hdr:       $to,
    cc_hdr:       $cc,
    bcc_hdr:      $bcc,
    reply_to_hdr: $reply_to,
    subject_hdr:  $subject,
    list_id_hdr:  $list_id,
    headers:      $headers
  } as $ctx

  # ── helpers ────────────────────────────────────────────────────
  # NB: jq function definitions terminate with `;`, NOT `|` —
  #     `def NAME: BODY | def NEXT` is parsed as a single body that
  #     never finds a terminator and fails to compile at EOF.
  | def lc($s): ($s // "") | ascii_downcase;

    def get_hdr($name):
      ($ctx.headers // "")
      | split("\n")
      | map(select(test("^" + $name + ":"; "i")))
      | if length == 0 then ""
        else .[0] | sub("^[^:]+:\\s*"; "") end;

    def header_contains($name; $vals):
      lc(get_hdr($name)) as $lv
      | any($vals[]; lc(.) as $needle | $lv | contains($needle));

    # Atom predicates. UNKNOWN type → emit debug marker AND treat as no-match.
    def atom_match:
      . as $p
      | ($p.type // "") as $t
      |  if   $t == "from_domain"         then any($p.values[]; lc(.) == $ctx.from_domain)
         elif $t == "from_domain_suffix"  then any($p.values[]; lc(.) as $s | $ctx.from_domain | endswith($s))
         elif $t == "from_address"        then any($p.values[]; lc(.) == $ctx.from_address)
         elif $t == "to_contains"         then any($p.values[]; lc(.) as $s | lc($ctx.to_hdr) | contains($s))
         elif $t == "reply_to_contains"   then any($p.values[]; lc(.) as $s | lc($ctx.reply_to_hdr) | contains($s))
         elif $t == "subject_contains"    then any($p.values[]; lc(.) as $s | lc($ctx.subject_hdr) | contains($s))
         elif $t == "list_id_contains"    then any($p.values[]; lc(.) as $s | lc($ctx.list_id_hdr) | contains($s))
         elif $t == "header_contains"     then header_contains($p.header; $p.values)
         elif $t == "header_exists"       then (get_hdr($p.header) | length > 0)
         elif $t == "header_regex"        then (get_hdr($p.header) | test($p.regex))
         elif $t == "has_cc"              then ($ctx.cc_hdr  | length > 0)
         elif $t == "has_bcc"             then ($ctx.bcc_hdr | length > 0)
         elif $t == "list_header"         then ($ctx.list_id_hdr | length > 0)
         elif $t == "self_sent"           then (lc($ctx.from_address) == lc($ctx.account))
         else (
           "UNKNOWN_PRED: " + $t | debug
           | false
         )
         end;

    def match_when:
      . as $w
      |  if   $w | has("any_of") then any($w.any_of[]; match_when)
         elif $w | has("all_of") then all($w.all_of[]; match_when)
         elif $w | has("not")    then ($w["not"] | match_when | not)
         else atom_match
         end;

  # Output is data-driven via mail-rules.json#delivery_strategy:
  #
  #   "unified-inbox" (default for maddy live delivery):
  #       always emit "INBOX" + inbox_copy_flags (e.g. \Seen) + rule_flags.
  #       INBOX is the chronological archive; per-rule copies into
  #       category folders are produced post-delivery by
  #       mail-sieve-subset-post-hoc.sh apply-rules (COPY not MOVE).
  #
  #   "split" (legacy / used by apply-rules to get the routing decision):
  #       emit the matched rule''s folder (or routing_default) + rule_flags.
  #
  # Env override: MAIL_SIEVE_STRATEGY=split|unified-inbox wins over the
  # JSON-declared default — used by apply-rules to ask "which folder
  # WOULD this go to?" without flipping the global strategy.
  # Sender-axis rules only: the G0 _ AUTH rules (axis "auth") belong to the second axis of the Rust sorter (no apostrophe: this comment sits inside the single-quoted jq program).
  (($rf[0].rules // []) | map(select((.axis // "sender") == "sender"))) as $rules
  | ($rules | map(select(.when | match_when))) as $matched
  | ($matched | map(select(.folder != null and .folder != "")) | .[0].folder // "") as $folder
  | ($matched | map(.flags // []) | add // []) as $rule_flags
  | ($rf[0].routing_default // "") as $default
  | ($rf[0].delivery_strategy // "unified-inbox") as $json_strategy
  | (env.MAIL_SIEVE_STRATEGY // $json_strategy) as $strategy
  | ($rf[0].inbox_copy_flags // ["\\Seen"]) as $inbox_flags
  | (if $strategy == "split"
     then ((if $folder == "" then $default else $folder end))
     else "INBOX"
     end) as $dest
  | (if $strategy == "split"
     then $rule_flags
     else ($inbox_flags + $rule_flags)
     end) as $out_flags
  | ($dest + "\n" + (($out_flags | unique) | join("\n")))
')"

printf '%s' "$OUT"
log "decision: $(printf '%s' "$OUT" | head -1)"
