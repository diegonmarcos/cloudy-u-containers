#!/usr/bin/env bash
#
# cloud-u-containers per-service tester runner (ticket #486)
#
# Reads the `tests` key of every build.json in this repo and runs each tester it
# declares. The `tests` key (registered by #476, now validated by
# build.schema.json) maps a tester name to a run spec:
#
#     "tests": {
#       "<name>": { "cmd": "<shell command>", "cwd": "<dir, optional>" }
#     }
#
# `cwd` is relative to the directory that CONTAINS the build.json (e.g. "src"
# for a tester living under <svc>/src). When omitted, the tester runs from the
# build.json's own directory.
#
# Discovery: every REAL build.json under this repo. Each service has a real
# <category>_<repo>/<svc>/build.json and a `src/build.json` that is a SYMLINK to
# it, so `find -type f` visits every service exactly once — the src symlink is
# naturally skipped and no tester is double-counted.
#
# THE ONE RULE THIS RUNNER EXISTS TO ENFORCE (ticket #486): a run that executed
# ZERO testers must NOT look like a run where everything passed. So it always
# prints how many testers it DISCOVERED and how many it EXECUTED, and it FAILS
# hard in either of two cases:
#
#   1. it discovers no testers at all  -> a broken discovery step / empty
#      registry, never a clean repo. Today the true answer is 1 (the #476
#      drift-multi-container tester), so a 0 means the globbing is wrong.
#   2. it discovers testers but executes none -> a wiring bug.
#
# Any individual tester that exits non-zero also fails the run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

DISCOVERED=0
EXECUTED=0
FAILED=0
declare -a RESULTS=()

# Collect every REAL build.json (skip .git and the src/ symlink aliases).
mapfile -t BUILD_JSONS < <(
    find . -name build.json -not -path './.git/*' -type f -print | sort
)

for bj in "${BUILD_JSONS[@]}"; do
    [ -n "$bj" ] || continue

    # A `tests` key that is not a (possibly empty) object is a malformed
    # declaration. Skip-check: jq -e treats a non-object as false, and an
    # object (even {}) as true. A service whose tests is a bogus scalar simply
    # contributes nothing; if it was the ONLY declaration, the zero floor below
    # turns red exactly as intended.
    if ! jq -e '.tests | type == "object"' "$bj" >/dev/null 2>&1; then
        continue
    fi

    svc="$(dirname "$bj")"
    svcname="$(jq -r '.name // "(unnamed)"' "$bj")"

    # Read each declared tester as key<TAB>cmd<TAB>cwd (in jq -r string form).
    while IFS=$'\t' read -r tname cmd cwd; do
        DISCOVERED=$((DISCOVERED + 1))

        tdir="$svc"
        if [ -n "$cwd" ] && [ "$cwd" != "null" ]; then
            tdir="$svc/$cwd"
        fi

        echo "── [${svcname}] tester \"${tname}\":  (cd ${tdir} && ${cmd})"
        if ( cd "$tdir" && eval "$cmd" ); then
            EXECUTED=$((EXECUTED + 1))
            echo "   PASS: ${svcname}/${tname}"
            RESULTS+=("PASS  ${svcname}/${tname}")
        else
            st=$?
            FAILED=$((FAILED + 1))
            echo "   FAIL: ${svcname}/${tname} (exit ${st})"
            RESULTS+=("FAIL  ${svcname}/${tname} (exit ${st})")
        fi
    done < <(jq -r '.tests | to_entries[] | [.key, (.value.cmd // ""), (.value.cwd // "")] | @tsv' "$bj")
done

echo
echo "===================== TESTER RUN SUMMARY ====================="
echo "testers DISCOVERED : ${DISCOVERED}"
echo "testers EXECUTED   : ${EXECUTED}"
echo "testers FAILED     : ${FAILED}"
echo "=============================================================="
for r in "${RESULTS[@]:-}"; do
    echo "  ${r}"
done

# The floor — see the header comment. Zero discovered is the exact defect this
# runner is paid to remove, so make it unmissable, in the log AND the summary.
if [ "${DISCOVERED}" -eq 0 ]; then
    echo "::error::DISCOVERED 0 testers — no build.json declares a 'tests' key. This is a broken discovery step or an empty tester registry, NOT a clean repo. Expected >= 1 (today infra-api_cloudy-c3-api registers the drift-multi-container tester). Treating this as green would be the courier lie ticket #486 exists to kill." >&2
    exit 1
fi
if [ "${EXECUTED}" -eq 0 ]; then
    echo "::error::DISCOVERED ${DISCOVERED} tester(s) but EXECUTED 0 — a discovery/run wiring bug. A green run must actually execute what it discovers." >&2
    exit 1
fi
if [ "${FAILED}" -gt 0 ]; then
    echo "::error::${FAILED} of ${DISCOVERED} discovered tester(s) FAILED." >&2
    exit 1
fi

echo "All ${DISCOVERED} discovered testers executed and passed (${EXECUTED} executed)."
