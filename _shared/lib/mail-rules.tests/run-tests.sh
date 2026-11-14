#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║ derive-mail-rules.ts test runner — golden-file + sanity checks.  ║
# ║                                                                  ║
# ║ Modes:                                                           ║
# ║   ./run-tests.sh           — diff against golden/ (CI mode)     ║
# ║   ./run-tests.sh --update  — regenerate golden/ (after intent)  ║
# ║                                                                  ║
# ║ Inputs: Stalwart's canonical rule files (authoritative source).  ║
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CANON_DIR="$HERE/../../../user-comm_tools-stalwart/src"
GENERAL="$CANON_DIR/mail-rules-general.json"
PROFILE="$CANON_DIR/mail-rules-profile-diego.json"
GOLDEN_DIR="$HERE/golden"
DERIVER="$HERE/../derive-mail-rules.ts"

UPDATE=0
[[ "${1:-}" == "--update" ]] && UPDATE=1

[[ -f "$GENERAL" ]] || { echo "missing: $GENERAL" >&2; exit 1; }
[[ -f "$PROFILE" ]] || { echo "missing: $PROFILE" >&2; exit 1; }
command -v node             >/dev/null || { echo "node required"            >&2; exit 1; }
command -v jq              >/dev/null || { echo "jq required"              >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The emitter writes both artifacts itself. This used to be
# `nix-instantiate --eval --strict --json | jq -r .sieve`, which is also why
# the old sieve golden carried a trailing blank line the real file never had:
# jq -r appends a newline to a string that already ended in one.
#
# Plain `node`, not `tsx`: the CI runner (.github/workflows/per-service-tests.yml)
# sets up Node 24 and nothing else, and Node's own native TS type-stripping is
# what the sibling per-service testers already rely on ("declared `node
# <file>.ts` cmd needs no flag") -- tsx was never installed there, so a `tsx`
# requirement here meant this suite could only ever fail closed if it were
# ever wired into CI. derive-mail-rules.ts had to drop __dirname/require.main
# (ESM-only under native type-stripping) to make this work; see its own diff.
node "$DERIVER" --emit "$TMP"

mkdir -p "$GOLDEN_DIR"

diff_file() {
  local name="$1" new="$2" golden="$GOLDEN_DIR/$1"
  if (( UPDATE )); then
    cp "$new" "$golden"
    echo "updated: $name"
    return 0
  fi
  if [[ ! -f "$golden" ]]; then
    echo "FAIL: golden/$name missing. Run with --update to capture baseline." >&2
    return 1
  fi
  if ! diff -u "$golden" "$new"; then
    echo "FAIL: $name drift vs golden." >&2
    return 1
  fi
  echo "ok: $name"
}

FAIL=0
diff_file stalwart.sieve "$TMP/stalwart.sieve" || FAIL=1
diff_file maddy.json     "$TMP/maddy.json"     || FAIL=1

# ── Structural assertions (not golden — always enforced) ───────────

assert() { local msg="$1"; shift; if "$@"; then echo "ok: $msg"; else echo "FAIL: $msg" >&2; FAIL=1; fi; }

# Sender-axis rules only (no `axis` key): the G0 _ AUTH rules carry axis "auth" and are asserted on their own below.
MADDY_RULE_COUNT="$(jq '[.rules[] | select(.axis == null)] | length' "$TMP/maddy.json")"

# The artifacts are COMMITTED, so nothing forces a regenerate when someone
# edits a canonical. Without this, a rule change lands in git while the sieve
# and both mail-rules.json files still describe the previous one -- and the
# only symptom is mail filed by rules that are no longer in the repo.
artifacts_current() { node "$DERIVER" --check >/dev/null 2>&1; }
assert "committed artifacts match the canonicals (else: node _shared/lib/derive-mail-rules.ts)" \
  artifacts_current

assert "no duplicate rule ids in general+profile" \
  test "$(jq -r '.rules[].id' "$GENERAL" "$PROFILE" | sort | uniq -d | wc -l)" = 0

# Stale since the unified-inbox/sender-view redesign (toMaddyJson's own
# comment: "Deliberately NOT derived from inbox_copy.enabled"). maddy.json's
# `rules` are the F* SENDER-AXIS VIEWS, not the canonical rules[] filtered by
# engines.maddy -- that link broke when Maddy stopped routing per-rule and
# started doing unified-inbox + one COPY per matched sender view. Verified
# against baseline (HEAD before #502): this was already wrong, 12 actual vs
# 56 expected under the old formula, for the same reason. The invariant that
# is still true: one maddy rule per declared sender-axis view.
SENDER_VIEW_COUNT="$(jq '[.filters.views[] | select(.axis=="sender")] | length' "$GENERAL")"
assert "maddy rule count = number of declared sender-axis (F*) views ($SENDER_VIEW_COUNT)" \
  test "$MADDY_RULE_COUNT" = "$SENDER_VIEW_COUNT"

assert "every maddy rule has resolved folder or flags (not both empty)" \
  test "$(jq '[.rules[] | select((.folder == null or .folder == "") and ((.flags // []) | length == 0))] | length' "$TMP/maddy.json")" = 0

# Same stale premise as above, fixed the same way: a maddy rule's folder is a
# sender-view display name (Fa.../Fl.../Fz...), never a general.folders entry
# -- those are two different namespaces by design (numeric routes vs. F*
# sender classification) and always were.
assert "every maddy route's folder is a declared sender-axis view" \
  test "$(jq --slurpfile g "$GENERAL" '
    ([$g[0].filters.views[] | select(.axis=="sender") | .folder]) as $declared
    | [.rules[] | select(.folder != null and .axis == null) | .folder] | unique
    | map(. as $f | select($declared | index($f) | not))
    | length
  ' "$TMP/maddy.json")" = 0

# G0 _ AUTH: the three auth rules exist, are derived from the declared pattern set, and the pattern parity
# test (auth_patterns_parity.py) holds them to it, including the exclusivity of Ga / Gb / Gc.
assert "maddy carries exactly three auth-axis rules: Ga, Gb, Gc" \
  test "$(jq -r '[.rules[] | select(.axis == "auth") | .folder[0:2]] | join(",")' "$TMP/maddy.json")" = "Ga,Gb,Gc"
assert "G0 _ AUTH parity: rules == declared patterns, classes exclusive" \
  python3 "$HERE/auth_patterns_parity.py" "$TMP/maddy.json"

# ── Server axis => JMAP folders + JMAP filter views ───────────────
# G0 _ AUTH first shipped to the Maddy sorter only: the server copied mail into
# Ga/Gb/Gc, but the Stalwart jmap-sorter -- the engine that creates the JMAP
# mailboxes and keeps filter-view membership on new mail -- never heard of it,
# so no JMAP client (Cloud Mail, webmail) had the folders. Every folder an
# engine files into must therefore exist in the Stalwart artifact as a filter
# view nested under a declared X0 section header, with the SAME predicate.
NO_JMAP_VIEW="$(jq -rn --slurpfile m "$TMP/maddy.json" --slurpfile r "$TMP/stalwart-rules.json" '
  $r[0] as $s
  | ($s.filters.views | map({key: .folder, value: .}) | from_entries) as $views
  | [ $m[0].rules[]
      | . as $rule
      | select( ($views[$rule.folder] == null)
             or (($s.filters.section_headers | index($s.folder_parents[$rule.folder] // "")) == null)
             or ($rule.axis != null and $views[$rule.folder].predicate != $rule.when) )
      | $rule.folder ]
  | unique | join(", ")
')"
assert "every server-filed axis folder is a JMAP filter view under its X0 header, same predicate (missing: ${NO_JMAP_VIEW:-none})" \
  test -z "$NO_JMAP_VIEW"

AXIS_DECL_GAPS="$(jq -rn --slurpfile g "$GENERAL" --slurpfile r "$TMP/stalwart-rules.json" '
  [ ($g[0].filters.axes_from_patterns // [])[]
    | . as $a
    | select( (($a.engines // []) | index("maddy") | not)
           or (($a.engines // []) | index("stalwart") | not)
           or (($r[0].filters.section_headers | index($a.header)) == null)
           or ([$r[0].filters.views[] | select(.axis == $a.axis)] | length) == 0 )
    | $a.header ]
  | join(", ")
')"
assert "every axes_from_patterns axis names both engines and has JMAP folders + views (gaps: ${AXIS_DECL_GAPS:-none})" \
  test -z "$AXIS_DECL_GAPS"

# The compiler itself must refuse a one-engine axis, not just this suite.
refuses_one_engine_axis() {
  ! node --input-type=module -e '
    const m = await import(process.argv[1]);
    m.expandPatternAxes({ views: [], section_headers: [], axes_from_patterns: [
      { axis: "auth", header: "G0 _ AUTH", patterns: "_shared/mail-auth-patterns.json", engines: ["maddy"] } ] });
  ' "$DERIVER" >/dev/null 2>&1
}
assert "derive-mail-rules.ts refuses an axis declared for the Maddy engine only" refuses_one_engine_axis

AUTH_LANDINGS="$(node --input-type=module -e '
import fs from "node:fs";
const views = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filters.views.filter((v) => v.axis === "auth");
const ev = (p, s) => {
  if ("any_of" in p) return p.any_of.some((c) => ev(c, s));
  if ("all_of" in p) return p.all_of.every((c) => ev(c, s));
  if ("not" in p) return !ev(p.not, s);
  return s !== null && p.values.some((v) => s.toLowerCase().includes(v.toLowerCase()));
};
const fx = [["Your Verification Code is ready", "Ga"], ["Please verify your email", "Gb"],
            ["Reset your password: your code inside", "Ga"], ["Weekly newsletter", "Gc"], [null, "Gc"]];
const bad = [];
for (const [s, want] of fx) {
  const hits = views.filter((v) => ev(v.predicate, s)).map((v) => v.folder.slice(0, 2));
  if (hits.length !== 1 || hits[0] !== want) bad.push(`${s}=[${hits.join("|")}]`);
}
if (views.length !== 3) bad.push(`views=${views.length}`);
console.log(bad.join(" "));
' "$TMP/stalwart-rules.json")"
assert "each fixture Subject lands in exactly one G0 _ AUTH JMAP view, the right one (bad: ${AUTH_LANDINGS:-none})" \
  test -z "$AUTH_LANDINGS"

# A+B architectural contract:
# • Maddy = A only (INBOX copy + one of 7 category folders, NO tags).
# • Stalwart = A + B (routes + tag system via IMAP keywords).
# Any rule that gives Maddy a flag breaks the contract. Enforce here, not
# only in prose, so future edits can't silently reintroduce tag-emission.
assert "A+B contract: no Maddy rule emits flags" \
  test "$(jq '[.rules[] | select((.flags // []) | length > 0)] | length' "$TMP/maddy.json")" = 0

assert "A+B contract: no Maddy rule is flags-only (tag-like leak)" \
  test "$(jq '[.rules[] | select(.folder == null or .folder == "")] | length' "$TMP/maddy.json")" = 0

assert "A+B contract: every canonical tag|meta rule drops in Maddy" \
  test "$(jq -s '
    [ (.[0].rules + .[1].rules)[]
      | select((.kind == "tag" or .kind == "meta") and .engines.maddy != "drop") ]
    | length
  ' "$GENERAL" "$PROFILE")" = 0

assert "A+B contract: every canonical route rule is route_only or full in Maddy with no flags leak" \
  test "$(jq -s '
    [ (.[0].rules + .[1].rules)[]
      | select(.kind == "route" and .engines.maddy == "full") ]
    | length
  ' "$GENERAL" "$PROFILE")" = 0

assert "sieve starts with require" \
  grep -q '^require \[' "$TMP/stalwart.sieve"

# Derive the fallback folder from the data, not a literal: hardcoding the
# display name silently rotted through the Aa->91 folder rename. Read from the
# EMITTED rules, and as a full path — the fallback folder is nested under its
# section header, so the bare display name is no longer what Sieve addresses.
FALLBACK_FOLDER="$(jq -rn --slurpfile r "$TMP/stalwart-rules.json" '
  def fullpath($p; $n): if $p[$n] then fullpath($p; $p[$n]) + "/" + $n else $n end;
  $r[0] as $rules
  | fullpath($rules.folder_parents; $rules.routing_default)
')"
assert "sieve has fallback fileinto to routing_default ($FALLBACK_FOLDER)" \
  grep -qF "fileinto :copy :create \"$FALLBACK_FOLDER\"" "$TMP/stalwart.sieve"

# Spec: each routed leaf folder = 2-char prefix + TWO spaces + non-space.
# Each folders_ui entry = 2-char prefix + ONE space + non-space. Validates
# the exact naming the user specified — any future edit that collapses
# spaces or adds them fails the suite.
assert "folders spacing: every leaf matches '^AZ  X…'" \
  test "$(jq '[.folders | to_entries[] | select(.value | test("^[0-9A-Za-z]{2}    [^ ]") | not)] | length' "$GENERAL")" = 0

assert "folders_ui spacing: every parent matches '^AZ X…'" \
  test "$(jq '[.folders_ui[] | select(test("^[0-9A-Za-z]{2} [^ ]") | not)] | length' "$GENERAL")" = 0

assert "folders_ui: exactly 4 parent UI entries (10 ADMIN, 20 INFORMS, 40 C3, 90 OTHERS; 50/60/70 retired 2026-11-14)" \
  test "$(jq '.folders_ui | length' "$GENERAL")" = 4

# Folder taxonomy and rule set are two sources of truth that can drift apart
# silently (14/23 were declared with zero routing rules for a while and
# nothing caught it). Fail the build if any declared folder — other than the
# fallback (routing_default) and the manual archive destination — has no
# rule targeting it anywhere in general+profile.
UNREACHABLE_FOLDERS="$(jq -nr --slurpfile g "$GENERAL" --slurpfile p "$PROFILE" '
  ($g[0].folders | to_entries) as $folders
  | (($g[0].rules + $p[0].rules) | map(select(.kind=="route") | .actions.copy_to) | unique) as $targeted
  | [ $folders[]
      | select(.key != $g[0].routing_default and .key != "archive")
      | .key as $k
      | select(($targeted | index($k)) | not)
      | $k ]
  | join(", ")
')"
assert "every non-fallback, non-archive folder is targeted by at least one route rule (unreachable: ${UNREACHABLE_FOLDERS:-none})" \
  test -z "$UNREACHABLE_FOLDERS"

# The assertion's own name was the spec; the body never read inbox_copy.enabled
# and just demanded the flag unconditionally. That was always wrong for THIS
# account's actual, deliberate setting -- inbox_copy.enabled is false (its own
# doc: shared-keywords JMAP objects mean addflag \Seen here marks every
# category copy read too, defeating unread counts everywhere) -- so verified
# against baseline this failed on HEAD as well, for the same reason. Branch on
# the real value instead of asserting one side of it as a constant.
INBOX_COPY_ENABLED="$(jq -r '.inbox_copy.enabled // false' "$GENERAL")"
if [[ "$INBOX_COPY_ENABLED" == "true" ]]; then
  assert "sieve has inbox-read addflag on routes (inbox_copy.enabled=true)" \
    test "$(grep -c 'addflag "\\\\Seen"' "$TMP/stalwart.sieve")" -gt 0
else
  assert "sieve has NO inbox-read addflag on routes (inbox_copy.enabled=false: category copies stay unread)" \
    test "$(grep -c 'addflag "\\\\Seen"' "$TMP/stalwart.sieve")" = 0
fi

# ── Folder tree / Sieve path agreement ────────────────────────────
# In IMAP a mailbox's hierarchy IS its name, so the moment a folder is nested
# every Sieve `fileinto` naming it by the old flat path goes stale. It still
# COMPILES -- and because the routes carry `:create`, delivery then makes a
# second, top-level folder of that name and files the mail there instead.
# These assertions are the only thing standing between "folder nested" and
# "mail silently filed somewhere he will not look".

RULES_JSON="$TMP/stalwart-rules.json"

# Fail closed: an empty tree must abort, not quietly pass every check below.
assert "folder_parents is non-empty (tree resolved)" \
  test "$(jq '.folder_parents | length' "$RULES_JSON")" -gt 0

# Full path of a folder, walking folder_parents to the root.
JQ_PATHS='
  def fullpath($p; $n): if $p[$n] then fullpath($p; $p[$n]) + "/" + $n else $n end;
  . as $r | $r.folder_parents as $p
'

# Every fileinto target must equal the full path its own leaf resolves to.
# Catches both directions: a flat path left behind after nesting, and a path
# that nests a folder the tree says is at ROOT.
STALE_PATHS="$(jq -rn --slurpfile r "$RULES_JSON" --rawfile sieve "$TMP/stalwart.sieve" '
  def fullpath($p; $n): if $p[$n] then fullpath($p; $p[$n]) + "/" + $n else $n end;
  $r[0].folder_parents as $p
  | [ $sieve
      | [scan("fileinto :copy :create \"([^\"]*)\"")]
      | flatten | unique | .[]
      | . as $target
      | ($target | split("/") | last) as $leaf
      | select(fullpath($p; $leaf) != $target)
      | "\($target)  (should be: \(fullpath($p; $leaf)))" ]
  | join("; ")
')"
assert "every sieve fileinto path matches the folder tree (stale: ${STALE_PATHS:-none})" \
  test -z "$STALE_PATHS"

# A parent that is not itself a declared mailbox would be created implicitly by
# Sieve's :create and then reaped by cleanup_stale as an undeclared folder.
UNDECLARED_PARENTS="$(jq -r '
  ( (.folders_ui // []) + ((.filters.section_headers) // [])
    + ((.folders // {}) | to_entries | map(.value))
    + ((.folder_groups // []) | map(.name))
    + ((.folder_groups // []) | map((.children // {}) | to_entries | map(.value)) | flatten)
    + (((.filters.views) // []) | map(.folder)) ) as $declared
  | [ (.folder_parents // {}) | to_entries[] | .value
      | select(. as $v | $declared | index($v) | not) ]
  | unique | join(", ")
' "$RULES_JSON")"
assert "every folder_parents parent is itself a declared mailbox (undeclared: ${UNDECLARED_PARENTS:-none})" \
  test -z "$UNDECLARED_PARENTS"

# The owner's rule, asserted against the data rather than a hardcoded list:
# a folder whose prefix class has a declared "X0" header must be nested under
# exactly that header. Derived from the headers actually present, so adding a
# G0 section next year extends the check for free.
MISNESTED="$(jq -r '
  ((.folders_ui // []) + ((.filters.section_headers) // [])) as $headers
  | ($headers | map({key: .[0:1], value: .}) | from_entries) as $byclass
  | (.folder_parents // {}) as $parents
  | [ ((.folders // {}) | to_entries | map(.value))
      + ((.folder_groups // []) | map(.name))
      + (((.filters.views) // []) | map(.folder)) | .[]
      | . as $f
      | select($headers | index($f) | not)
      | select($byclass[$f[0:1]] != null)
      | select($parents[$f] != $byclass[$f[0:1]]) ]
  | join(", ")
' "$RULES_JSON")"
assert "every prefixed folder nests under its own X0 header (misnested: ${MISNESTED:-none})" \
  test -z "$MISNESTED"

# The sorter's routing list is addressed by LEAF NAME (routing.rs looks each
# folder up in `name_to_id`, keyed by JMAP `mailbox.name`). A path there
# resolves to nothing, `routing_ids` comes back empty, and the backfill logs
# "no target folder exists yet" and re-routes nothing — with every container
# still reporting healthy. Sieve is the one that wants paths.
ROUTING_PATHS="$(jq -r '
  ( ((.folders // {}) | to_entries | map(.value))
    + ((.folder_groups // []) | map((.children // {}) | to_entries | map(.value)) | flatten) ) as $leaves
  | [ (.routing // [])[] | .folder
      | select((. | contains("/")) or (. as $f | $leaves | index($f) | not)) ]
  | unique | join(", ")
' "$RULES_JSON")"
assert "every routing folder is a declared leaf name, not a path (bad: ${ROUTING_PATHS:-none})" \
  test -z "$ROUTING_PATHS"

# Nesting must never rename. The Rust sorter's `name_to_id` and the app both
# address mailboxes by leaf name, so two DISTINCT mailboxes sharing one leaf
# name make the lookup ambiguous and one of them silently wins.
#
# A view may deliberately point at a routing folder -- `junkMirror` aims the Ec
# view at `93 Junk` so the additive view engine and the exclusive route engine
# report the same set -- so views are counted only where they name a mailbox no
# routing folder already declares. Everything else must be pairwise distinct.
DUP_LEAVES="$(jq -r '
  ((.folders // {}) | to_entries | map(.value)) as $routing
  | ( $routing
      + ((.folder_groups // []) | map(.name))
      + ((.folder_groups // []) | map((.children // {}) | to_entries | map(.value)) | flatten)
      + (.folders_ui // []) + ((.filters.section_headers) // [])
      + (((.filters.views) // []) | map(.folder)
         | map(select(. as $v | $routing | index($v) | not))) )
  | group_by(.) | map(select(length > 1) | .[0]) | unique | join(", ")
' "$RULES_JSON")"
assert "no two managed mailboxes share a leaf name (dupes: ${DUP_LEAVES:-none})" \
  test -z "$DUP_LEAVES"

# ── Ticket #502: declared restructure, proven against the TREE not just names
#
# The vacuity trap the ticket itself calls out: "folder X exists" passes on a
# flat tree with a merely-prefixed name. Every check below reads
# folder_parents (the REAL resolved tree, walked to root) rather than
# string-matching a display name, and the de-dup check diffs actual predicate
# VALUES rather than trusting a comment that says they were removed.

assert "10 _ ADMIN and 20 _ INFORMS are UNCHANGED (#502's destructive half — deleting them — is not authorised)" \
  test "$(jq -r '(.folders_ui | index("10 _ ADMIN") != null) and (.folders_ui | index("20 _ INFORMS") != null)' "$GENERAL")" = true

assert "'house' (24 House) is retired from the numeric folders map, not left as a second copy of Fl" \
  test "$(jq '.folders | has("house")' "$GENERAL")" = false

DEDUP_OVERLAP="$(jq -rn --slurpfile r "$RULES_JSON" '
  ($r[0].filters.views | map(select(.folder | startswith("Fi")))[0].predicate.values // []) as $fi
  | ($r[0].filters.views | map(select(.folder | startswith("Fl")))[0].predicate.values // []) as $fl
  | ($fi + $fl | group_by(.) | map(select(length > 1) | .[0]))
  | join(", ")
')"
assert "Fl House and Fi Utilities share no domain (de-dup actually removed the duplicate: ${DEDUP_OVERLAP:-none overlap})" \
  test -z "$DEDUP_OVERLAP"

FL_PARENT="$(jq -r '
  (.filters.views[] | select(.folder | startswith("Fl")) | .folder) as $fl
  | .folder_parents[$fl] // "MISSING"
' "$RULES_JSON")"
assert "Fl House's resolved PARENT (folder_parents, not its name) is the F0 sender header (got: $FL_PARENT)" \
  test "$FL_PARENT" = "F0 _ SENDER"

ALERTS_MATCH="$(jq -n --slurpfile r "$RULES_JSON" '
  ($r[0].filters.views | map(select(.folder == "01_Alerts"))[0].predicate // "MISSING_ALERTS") as $a
  | ($r[0].filters.views | map(select(.folder == "01_No-Alerts"))[0].predicate.not // "MISSING_NOALERTS") as $na
  | $a == $na
')"
assert "01_Alerts and 01_No-Alerts split the inbox axis as exact complements" \
  test "$ALERTS_MATCH" = true

# Structural identity above proves "complement"; it cannot prove the RIGHT
# mail is on each side. Feed fixture messages through the derived view
# predicates with the sorter's own semantics (crate/src/filters.rs
# email_matches: header_contains = case-insensitive substring, from_domain =
# exact lowercase, from_domain_suffix = ends_with) and count landings.
# Every fixture must hit exactly ONE inbox view and exactly ONE F0 folder --
# a message filed into both, or neither, is the failure.
VIEW_LANDINGS="$(node --input-type=module -e '
import fs from "node:fs";
const views = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).filters.views;
const ev = (p, m) => {
  if ("any_of" in p) return p.any_of.some((c) => ev(c, m));
  if ("all_of" in p) return p.all_of.every((c) => ev(c, m));
  if ("not" in p) return !ev(p.not, m);
  const d = m.from.split("@")[1].toLowerCase();
  if (p.type === "from_domain") return p.values.some((v) => d === v.toLowerCase());
  if (p.type === "from_domain_suffix") return p.values.some((v) => d.endsWith(v.toLowerCase()));
  if (p.type === "header_contains") { const h = (m.headers[p.header] ?? null); return h !== null && p.values.some((v) => h.toLowerCase().includes(v.toLowerCase())); }
  return false;
};
const fx = [
  ["wg-gesucht",  "inbox", "01_Alerts",   { from: "x@wg-gesucht.de", headers: { Subject: "Neue Anzeige" } }],
  ["immoscout24", "inbox", "01_Alerts",   { from: "x@nachrichten.immobilienscout24.de", headers: { Subject: "Suchauftrag" } }],
  ["ci-failure",  "inbox", "01_Alerts",   { from: "notifications@github.com", headers: { Subject: "[o/r] Run failed: ci - main" } }],
  ["github-pr",   "inbox", "01_No-Alerts", { from: "notifications@github.com", headers: { Subject: "[o/r] PR opened" } }],
  ["normal",      "inbox", "01_No-Alerts", { from: "friend@example.org", headers: { Subject: "hi" } }],
  ["linkedin",    "sender", null,                  { from: "x@linkedin.com", headers: { Subject: "new message" } }],
  ["travel-sale", "sender", null,                  { from: "x@booking.com", headers: { Subject: "Flash sale" } }],
];
const out = [];
for (const [name, axis, want, m] of fx) {
  for (const ax of ["inbox", "sender"]) {
    const hits = views.filter((v) => v.axis === ax && ev(v.predicate, m)).map((v) => v.folder);
    const ok = hits.length === 1 && (ax !== axis || want === null || hits[0] === want);
    if (!ok) out.push(`${name}/${ax}=[${hits.join("|")}]`);
  }
}
console.log(out.join(" "));
' "$RULES_JSON")"
assert "each fixture lands in exactly one inbox view (wg-gesucht/immoscout24/CI-failure -> Alerts, rest -> noAlerts) and exactly one F0 folder (bad: ${VIEW_LANDINGS:-none})" \
  test -z "$VIEW_LANDINGS"

# '/' is the IMAP/Sieve hierarchy separator: a name carrying one is split into
# extra levels at delivery (41 CI/CD -> 41 CI > CD), which the sorter then
# reaps as stale every poll.
SLASH_NAMES="$(jq -r '
  [ (.folders // {} | to_entries | map(.value)[]),
    (.folder_groups // [] | .[] | .name, (.children // {} | to_entries | map(.value)[])),
    (.folders_ui // [])[], (.filters.section_headers // [])[], (.filters.views // [] | .[].folder) ]
  | map(select(contains("/"))) | unique | join(", ")
' "$RULES_JSON")"
assert "no declared folder name contains '/' (got: ${SLASH_NAMES:-none})" \
  test -z "$SLASH_NAMES"

assert "40 _ C3 replaces 30 _ CLOUD in folders_ui" \
  test "$(jq -r '(.folders_ui | index("40 _ C3") != null) and (.folders_ui | index("30 _ CLOUD") == null)' "$GENERAL")" = true

C3_PARENTS="$(jq -r '
  [.folder_groups[] | select(.name | test("CI & CD|Reports|VPS")) | .name] as $names
  | ($names | length) as $n
  | [$names[] as $g | .folder_parents[$g] // "MISSING"] | unique
  | if length == 1 and $n == 3 then .[0] else ("MISMATCH:" + (. | tostring)) end
' "$RULES_JSON")"
assert "CI & CD, Reports and VPS (all three) resolve to one real parent, 40 _ C3 (got: $C3_PARENTS)" \
  test "$C3_PARENTS" = "40 _ C3"

assert "the stale 50 _ BURO, 60 _ MY-PM and 70 _ SOCIALS containers are no longer declared (retired 2026-11-14, were empty)" \
  test "$(jq -r '
    ["50 _ BURO","60 _ MY-PM","70 _ SOCIALS"] as $gone
    | ([.folders_ui[]] | map(. as $f | $gone | index($f)) | map(select(. != null)) | length == 0)
  ' "$GENERAL")" = true

assert "root_folders declares A.___ and the inbox views are renamed 01_Alerts / 01_No-Alerts with renames from the old names" \
  test "$(jq -r '(.root_folders | index("A.___") != null) and (.folder_renames.map["01 Inbox - Alerts"] == "01_Alerts") and (.folder_renames.map["01 Inbox - noAlerts"] == "01_No-Alerts")' "$GENERAL")" = true

# ── Priority axis: the star, and the complement that must track it ─
# `Ea Important` and `Eb Normal` are hand-tiled -- Normal is NOT(Important)
# AND NOT(Junk) -- and they used to be two pasted copies of one flag list.
# Adding a flag to Important alone would then put the message in BOTH
# folders. Nothing below restates a flag: the first check asks the DERIVED
# artifact whether the app's star keyword reaches the axis at all, the second
# asks the CANONICAL whether every tree Normal negates is verbatim another
# priority view's predicate. Break either copy and this fails.

STAR_VIEWS="$(jq -r --arg star '$flagged' '
  [ .filters.views[]
    | select(.axis == "priority")
    | select([.predicate | .. | objects | select(.type? == "has_flag") | .flag] | index($star))
    | .folder ]
  | join(", ")
' "$RULES_JSON")"
assert "the app's star keyword reaches the priority axis (views: ${STAR_VIEWS:-NONE})" \
  test -n "$STAR_VIEWS"

# Fail closed: no complement view found at all must abort, not pass quietly.
COMPLEMENT_N="$(jq '
  [ .filters.views[]
    | select(.axis == "priority")
    | select(.predicate | has("all_of") and ([.all_of[] | has("not")] | all)) ]
  | length
' "$GENERAL")"
assert "exactly one priority view is the NOT-of-the-others complement (found: $COMPLEMENT_N)" \
  test "$COMPLEMENT_N" = 1

UNPAIRED="$(jq -r '
  [ .filters.views[] | select(.axis == "priority") ] as $p
  | ($p | map(select(.predicate | has("all_of") and ([.all_of[] | has("not")] | all)))[0]) as $c
  | [ $c.predicate.all_of[].not
      | . as $negated
      | select([ $p[] | select(.folder != $c.folder) | .predicate ] | index($negated) | not)
      | @json ]
  | join("; ")
' "$GENERAL")"
assert "every tree the complement view negates is verbatim another priority view (orphaned: ${UNPAIRED:-none})" \
  test -z "$UNPAIRED"

# ── End-to-end mail-filter.sh fixtures ────────────────────────────
# Runs the Maddy filter against each fixture case and asserts the
# emitted folder + flags match the declarative expectation.
MADDY_SRC="$HERE/../../../aa-sui_tools-maddy/src"
FILTER="$MADDY_SRC/mail-filter.sh"
FIXTURES="$HERE/fixtures/filter-cases.json"

if [[ -f "$FILTER" && -f "$FIXTURES" ]]; then
  CASES_N="$(jq '.cases | length' "$FIXTURES")"
  for i in $(seq 0 $((CASES_N - 1))); do
    label="$(jq -r ".cases[$i].label"    "$FIXTURES")"
    from="$(jq -r ".cases[$i].from"       "$FIXTURES")"
    subj="$(jq -r ".cases[$i].subject"    "$FIXTURES")"
    want_folder="$(jq -r ".cases[$i].expect_folder" "$FIXTURES")"
    want_flags_json="$(jq   -c ".cases[$i].expect_flags_include" "$FIXTURES")"

    extra_headers="$(jq -r ".cases[$i].extra_headers // empty" "$FIXTURES")"
    email="$(
      printf 'From: %s\nTo: me@diegonmarcos.com\nSubject: %s\n' "$from" "$subj"
      [[ -n "$extra_headers" ]] && printf '%s\n' "$extra_headers"
      printf '\nbody\n'
    )"
    out="$(printf '%s' "$email" | RULES_PATH="$TMP/maddy.json" "$FILTER" \
             me@diegonmarcos.com "$from" me@diegonmarcos.com "$subj" || true)"
    got_folder="$(printf '%s\n' "$out" | head -1)"
    got_flags_json="$(printf '%s\n' "$out" | tail -n +2 | jq -R . | jq -s .)"

    missing="$(jq --argjson w "$want_flags_json" --argjson g "$got_flags_json" \
      -n '[$w[] | select( . as $x | $g | index($x) | not )]')"
    missing_n="$(printf '%s' "$missing" | jq 'length')"

    if [[ "$got_folder" == "$want_folder" && "$missing_n" == "0" ]]; then
      echo "ok: filter: $label"
    else
      echo "FAIL: filter: $label" >&2
      echo "  want folder: $want_folder  got: $got_folder" >&2
      echo "  missing flags: $missing" >&2
      FAIL=1
    fi
  done
else
  echo "skip: mail-filter.sh end-to-end (filter or fixtures missing)"
fi

(( FAIL == 0 )) || exit 1
echo ""
echo "all mail-rules tests passed"
