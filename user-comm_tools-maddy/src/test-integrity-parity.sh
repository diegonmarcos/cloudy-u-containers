#!/bin/bash
# #1883: `maddy-sorter integrity-check` must print the same report as `mail-sieve-subset-post-hoc integrity-check`
# (sqlite3 CLI + sort/comm/awk), on databases with orphans, dangling blobs, bad refs and awkward key names.
# usage: test-integrity-parity.sh <path-to-maddy-sorter>   (needs sqlite3, sh, sort, comm on the PATH)
set -euo pipefail
BIN="${1:?usage: $0 <maddy-sorter>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v sqlite3 >/dev/null || { echo "harness cannot run: sqlite3 missing"; exit 2; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail=0
mk() { # name: build one scenario db + blob dir
  local d="$T/$1"; mkdir -p "$d/blobs"
  sqlite3 "$d/imapsql.db" "CREATE TABLE msgs (id INTEGER PRIMARY KEY, extBodyKey TEXT); CREATE TABLE extKeys (id TEXT PRIMARY KEY, refs INTEGER);"
  echo "$d"
}
d="$(mk clean)"
sqlite3 "$d/imapsql.db" "INSERT INTO extKeys VALUES ('a',1),('b',2); INSERT INTO msgs(extBodyKey) VALUES ('a'),('b'),('b');"
touch "$d/blobs/a" "$d/blobs/b"
d="$(mk broken)"
sqlite3 "$d/imapsql.db" "INSERT INTO extKeys VALUES ('k1',1),('k2',5),('k3',0),('it''s',1),('with space',2),('only-db',1);
 INSERT INTO msgs(extBodyKey) VALUES ('k1'),('k2'),('k2'),('only-db'),('only-db'),('ghost'),(NULL),('it''s'),('with space');"
touch "$d/blobs/k1" "$d/blobs/k2" "$d/blobs/k3" "$d/blobs/it's" "$d/blobs/with space" "$d/blobs/dangling1" "$d/blobs/dangling2" "$d/blobs/.hidden"
d="$(mk empty)"
for s in clean broken empty; do
  d="$T/$s"
  ref="$(IMAPSQL_DB="$d/imapsql.db" BLOB_DIR="$d/blobs" sh "$HERE/mail-sieve-subset-post-hoc.sh" integrity-check 2>&1 >/dev/null)"
  new="$(IMAPSQL_DB="$d/imapsql.db" BLOB_DIR="$d/blobs" "$BIN" integrity-check 2>&1 >/dev/null)"
  if [ "$ref" != "$new" ]; then
    echo "DIFF scenario=$s"; diff <(printf '%s\n' "$ref") <(printf '%s\n' "$new") || true; fail=1
  else
    echo "ok scenario=$s ($(printf '%s\n' "$ref" | wc -l) lines)"
  fi
done
# the rust side must not have written anything (read-only open): the db file is byte-identical
sum_before="$(sha256sum "$T/broken/imapsql.db" | cut -d' ' -f1)"
IMAPSQL_DB="$T/broken/imapsql.db" BLOB_DIR="$T/broken/blobs" "$BIN" integrity-check >/dev/null 2>&1
[ "$sum_before" = "$(sha256sum "$T/broken/imapsql.db" | cut -d' ' -f1)" ] || { echo "DIFF: integrity-check modified the database"; fail=1; }
# missing inputs
IMAPSQL_DB="$T/none.db" BLOB_DIR="$T/broken/blobs" "$BIN" integrity-check 2>&1 | grep -q "imapsql DB not found" || { echo "DIFF: missing DB message"; fail=1; }
exit "$fail"
