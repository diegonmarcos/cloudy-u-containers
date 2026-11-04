#!/usr/bin/env bash
# fincept-rs — universal build engine.
# Data-driven: reads build.json (project config) + modules.json (crate registry).
# No hardcoded paths, versions, or module lists — edit JSON, not this script.
#
# Actions: build | test | lint | fmt | clean | secrets | ship | coverage | registry | help

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG="${SCRIPT_DIR}/build.json"
REGISTRY="${SCRIPT_DIR}/modules.json"

for req in jq cargo; do
    command -v "$req" >/dev/null 2>&1 || { echo "ERROR: $req not found (command -v $req)" >&2; exit 1; }
done
[[ -f "$CONFIG"   ]] || { echo "ERROR: missing $CONFIG"   >&2; exit 1; }
[[ -f "$REGISTRY" ]] || { echo "ERROR: missing $REGISTRY" >&2; exit 1; }

# ── Config helpers ────────────────────────────────────────────────────────────
cfg()      { jq -r "$1" "$CONFIG"; }
registry() { jq -r "$1" "$REGISTRY"; }

NAME="$(cfg .name)"
BIN_NAME="$(cfg .binary.name)"
BIN_CRATE="$(cfg .binary.crate)"
PROFILE="$(cfg .build.profile)"
STRIP="$(cfg .build.strip)"

# ── Logging ───────────────────────────────────────────────────────────────────
log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$NAME" "$*"; }
ok()   { printf '\033[1;32m[%s]\033[0m ✔ %s\n' "$NAME" "$*"; }
err()  { printf '\033[1;31m[%s]\033[0m ✘ %s\n' "$NAME" "$*" >&2; }

# ── Derived: active crate list from modules.json ──────────────────────────────
# Only crates with status=="active" are wired into the workspace. "planned"
# crates are registry-only (CI coverage gate ignores them until activated).
active_crates() {
    jq -r '[
        .connectors[], .brokers[], .analytics[], .ml[],
        .agents[], .infrastructure[]
    ] | map(select(.status=="active")) | .[].crate' "$REGISTRY" | sort -u
}

planned_crates() {
    jq -r '[
        .connectors[], .brokers[], .analytics[], .ml[],
        .agents[], .infrastructure[]
    ] | map(select(.status=="planned")) | .[].crate' "$REGISTRY" | sort -u
}

# ── Sync workspace members from modules.json ──────────────────────────────────
# Derives [workspace].members from active_crates. Edits Cargo.toml in place
# between sentinel markers so humans can keep static members above the marker.
sync_workspace() {
    local marker_start='# AUTO-GENERATED: modules.json members below'
    local marker_end='# AUTO-GENERATED: end'
    local cargo="${SCRIPT_DIR}/Cargo.toml"
    [[ -f "$cargo" ]] || { err "Cargo.toml missing"; return 1; }

    if ! grep -qF "$marker_start" "$cargo"; then
        log "sync-workspace: marker not found — skipping (static members only)"
        return 0
    fi

    local tmp; tmp="$(mktemp)"
    awk -v s="$marker_start" -v e="$marker_end" '
        $0 ~ s { print; in_block=1; next }
        $0 ~ e { in_block=0; print; next }
        !in_block { print }
    ' "$cargo" > "$tmp"

    # Collect static members declared outside the marker block so we never
    # emit duplicates from modules.json.
    local static_members
    static_members="$(awk -v s="$marker_start" -v e="$marker_end" '
        /^members = \[/ { in_list=1; next }
        in_list && /^\]/ { exit }
        in_list && $0 ~ s { in_block=1; next }
        in_list && $0 ~ e { in_block=0; next }
        in_list && !in_block {
            line=$0
            gsub(/^[[:space:]]*"|",?[[:space:]]*$|,[[:space:]]*$/, "", line)
            gsub(/^"/, "", line); gsub(/"$/, "", line)
            if (line != "" && line !~ /^#/) print line
        }
    ' "$tmp")"

    {
        awk -v s="$marker_start" '$0 ~ s { print; exit } { print }' "$tmp"
        while IFS= read -r c; do
            local path
            case "$c" in
                data-*)       path="crates/data/$c" ;;
                brokers-*)    path="crates/brokers/$c" ;;
                analytics-*)  path="crates/analytics/$c" ;;
                ml-*)         path="crates/ml/$c" ;;
                agents-*)     path="crates/agents/$c" ;;
                ui-*)         path="crates/ui/$c" ;;
                *)            path="crates/$c" ;;
            esac
            # Skip if already listed as a static member
            if grep -Fxq "$path" <<<"$static_members"; then continue; fi
            echo "    \"$path\","
        done < <(active_crates)
        awk -v e="$marker_end" 'found { print; next } $0 ~ e { found=1; print }' "$tmp"
    } > "$cargo.new"
    mv "$cargo.new" "$cargo"
    rm -f "$tmp"
    ok "sync-workspace: wrote $(active_crates | wc -l) active crate(s) to Cargo.toml"
}

# ── Actions ───────────────────────────────────────────────────────────────────
action_build() {
    sync_workspace
    log "build: cargo build --workspace --profile=$PROFILE"
    if [[ "$PROFILE" == "release" ]]; then
        cargo build --workspace --release
    else
        cargo build --workspace --profile "$PROFILE"
    fi
    ok "build"
}

action_test() {
    sync_workspace
    log "test: cargo test --workspace"
    cargo test --workspace --all-features
    action_coverage
    ok "test"
}

action_fmt() {
    log "fmt: cargo fmt --all"
    cargo fmt --all
    ok "fmt"
}

action_lint() {
    sync_workspace
    log "lint: cargo fmt --check + cargo clippy"
    cargo fmt --all -- --check
    cargo clippy --workspace --all-features --all-targets -- -D warnings
    ok "lint"
}

action_clean() {
    log "clean: cargo clean + rm dist/"
    cargo clean
    rm -rf "${SCRIPT_DIR}/dist" "${SCRIPT_DIR}/target/fincept-dist"
    ok "clean"
}

action_secrets() {
    local src dest
    src="${SCRIPT_DIR}/$(cfg .secrets.src)"
    dest="${SCRIPT_DIR}/$(cfg .secrets.dist)"
    if [[ ! -f "$src" ]]; then
        log "secrets: no source at $src — skipping"
        return 0
    fi
    command -v sops >/dev/null || { err "sops not found"; return 1; }
    mkdir -p "$(dirname "$dest")"
    log "secrets: sops -d $src → $dest"
    sops -d "$src" > "$dest"
    chmod 600 "$dest"
    ok "secrets"
}

action_ship() {
    local os target format
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    case "$os" in
        linux)   target="linux"   ;;
        darwin)  target="macos"   ;;
        mingw*|msys*|cygwin*) target="windows" ;;
        *)       err "unsupported OS: $os"; return 1 ;;
    esac
    local enabled
    enabled="$(cfg ".packaging.$target.enabled")"
    [[ "$enabled" == "true" ]] || { err "packaging disabled for $target in build.json"; return 1; }
    format="$(cfg ".packaging.$target.format")"

    action_build

    # Find the release binary. Cargo respects `CARGO_TARGET_DIR`; if unset,
    # fall back to the workspace-local `target/`. Never hardcode either —
    # dev machines and CI runners both work.
    local target_dir="${CARGO_TARGET_DIR:-${SCRIPT_DIR}/target}"
    local bin_path="${target_dir}/release/${BIN_NAME}"
    [[ "$target" == "windows" ]] && bin_path="${bin_path}.exe"
    if [[ ! -f "$bin_path" ]]; then
        err "ship: binary not at $bin_path (CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<unset>})"
        return 1
    fi

    [[ "$STRIP" == "true" ]] && strip "$bin_path" 2>/dev/null || true
    mkdir -p "${SCRIPT_DIR}/dist"
    cp "$bin_path" "${SCRIPT_DIR}/dist/$BIN_NAME-$target"

    # Run the per-OS packaging recipe if the tool is on PATH. Missing tool
    # is a soft-skip — CI jobs pre-install the tool; dev machines may not.
    local packaging_file="${SCRIPT_DIR}/packaging/packaging.json"
    if [[ -f "$packaging_file" ]]; then
        local tool recipe out
        tool="$(jq -r ".targets.$target.tool // empty" "$packaging_file")"
        recipe="$(jq -r ".targets.$target.recipe // empty" "$packaging_file")"
        out="$(jq -r ".targets.$target.output // empty" "$packaging_file")"
        if [[ -n "$tool" ]] && command -v "$tool" >/dev/null 2>&1; then
            log "ship: running $tool (format=$format, recipe=$recipe)"
            run_packaging_tool "$target" "$tool" "$recipe" "$out"
        else
            log "ship: $tool not on PATH — staged binary at dist/, skip installer (CI will package)"
        fi
    fi
    ok "ship: dist/$BIN_NAME-$target ready (format=$format)"
}

# Dispatches to the right packaging command per target. Pure shell — no
# embedded installer logic lives here, it's all in the recipe files.
run_packaging_tool() {
    local target="$1" tool="$2" recipe="$3" out="$4"
    case "$target" in
        linux)
            # appimage-builder uses the recipe at `recipe` path.
            "$tool" --recipe "$recipe" --skip-tests || {
                err "appimage-builder failed"; return 1;
            }
            ;;
        macos)
            # cargo-bundle reads [package.metadata.bundle] from Cargo.toml;
            # recipe is the manifest template used by CI to inject it.
            "$tool" bundle --release || {
                err "cargo-bundle failed"; return 1;
            }
            ;;
        windows)
            "$tool" "$recipe" || {
                err "makensis failed"; return 1;
            }
            ;;
    esac
    [[ -f "$out" ]] && log "ship: produced $out"
}

# Coverage gate enforces registry ↔ filesystem ↔ spec consistency:
#
#   1. Every active crate declared in modules.json has a matching directory.
#   2. For connector entries with kind=="generic", the id must have a
#      matching entry in connector-specs.json (otherwise the generic
#      connector has nothing to drive it).
#   3. Every id in connector-specs.json must appear in modules.json as a
#      connector with kind=="generic" (otherwise the spec is orphaned).
action_coverage() {
    log "coverage: verifying modules.json vs filesystem"
    local enforce
    enforce="$(cfg .test.coverage_gate.enforce_modules_json)"
    [[ "$enforce" == "true" ]] || { log "coverage: disabled"; return 0; }

    local missing=0

    # (1) Active crate directories must exist.
    while IFS= read -r c; do
        local path
        case "$c" in
            data-*)       path="crates/data/$c" ;;
            brokers-*)    path="crates/brokers/$c" ;;
            analytics-*)  path="crates/analytics/$c" ;;
            ml-*)         path="crates/ml/$c" ;;
            agents-*)     path="crates/agents/$c" ;;
            ui-*)         path="crates/ui/$c" ;;
            *)            path="crates/$c" ;;
        esac
        if [[ ! -d "$SCRIPT_DIR/$path" ]]; then
            err "coverage: active crate '$c' declared in modules.json but $path is missing"
            missing=$((missing + 1))
        fi
    done < <(active_crates)

    # (2) and (3): spec registry consistency. Runs once per (group, specs_file)
    # pair so the same rules apply uniformly to connectors AND brokers (Phase 7+).
    check_spec_consistency() {
        local group="$1" specs_file="$2" label="$3"
        [[ -f "$specs_file" ]] || return 0

        local -a declared_generic_ids=()
        mapfile -t declared_generic_ids < <(
            jq -r ".${group}[] | select((.kind // \"custom\") == \"generic\" and .status == \"active\") | .id" "$REGISTRY"
        )
        local -a spec_ids=()
        mapfile -t spec_ids < <(jq -r '.specs[].id' "$specs_file")

        for id in "${declared_generic_ids[@]}"; do
            [[ -z "$id" ]] && continue
            if ! printf '%s\n' "${spec_ids[@]}" | grep -Fxq "$id"; then
                err "coverage: generic $label '$id' active in modules.json but missing from $(basename "$specs_file")"
                missing=$((missing + 1))
            fi
        done

        local -a any_generic_ids=()
        mapfile -t any_generic_ids < <(
            jq -r ".${group}[] | select((.kind // \"custom\") == \"generic\") | .id" "$REGISTRY"
        )
        for id in "${spec_ids[@]}"; do
            [[ -z "$id" ]] && continue
            if ! printf '%s\n' "${any_generic_ids[@]}" | grep -Fxq "$id"; then
                err "coverage: spec '$id' present in $(basename "$specs_file") but missing from modules.json ($label)"
                missing=$((missing + 1))
            fi
        done
    }

    check_spec_consistency "connectors" "${SCRIPT_DIR}/connector-specs.json" "connector"
    check_spec_consistency "brokers"    "${SCRIPT_DIR}/broker-specs.json"    "broker"

    if (( missing > 0 )); then
        err "coverage: $missing active crate(s) missing"
        return 1
    fi
    ok "coverage: all active crates present ($(active_crates | wc -l) crate(s))"
}

action_registry() {
    local total_active total_planned
    total_active="$(active_crates | wc -l)"
    total_planned="$(planned_crates | wc -l)"
    log "registry: $total_active active, $total_planned planned"
    printf '\n  Active crates:\n'
    active_crates | sed 's/^/    - /'
    printf '\n  By group (planned + active):\n'
    for g in connectors brokers analytics ml agents infrastructure; do
        local n
        n="$(jq -r ".$g | length" "$REGISTRY")"
        printf '    %-16s %d\n' "$g" "$n"
    done
    printf '\n  Phase: %s / %s (see %s)\n' \
        "$(cfg .phase.current)" "$(cfg .phase.target)" "$(cfg .phase.tracker)"
}

action_help() {
    cat <<EOF
Usage: ./build.sh <action>

Actions:
  build         cargo build --workspace (reads profile from build.json)
  test          cargo test --workspace + coverage gate
  fmt           cargo fmt --all
  lint          cargo fmt --check + clippy -D warnings
  clean         cargo clean + rm dist/
  secrets       sops -d src/secrets.yaml → dist/.secrets
  ship          build + strip + copy to dist/ (packaging TBD Phase 10)
  coverage      enforce modules.json ↔ filesystem consistency
  registry      print crate registry summary
  help          this message

Config sources of truth:
  build.json      project-level config (binary name, packaging targets, secrets)
  modules.json    crate registry (connectors, brokers, analytics, agents, infra)
EOF
}

# ── Dispatch ──────────────────────────────────────────────────────────────────
case "${1:-help}" in
    build)    action_build ;;
    test)     action_test ;;
    fmt)      action_fmt ;;
    lint)     action_lint ;;
    clean)    action_clean ;;
    secrets)  action_secrets ;;
    ship)     action_ship ;;
    coverage) action_coverage ;;
    registry) action_registry ;;
    help|-h|--help) action_help ;;
    *)        err "unknown action: $1"; action_help; exit 2 ;;
esac
