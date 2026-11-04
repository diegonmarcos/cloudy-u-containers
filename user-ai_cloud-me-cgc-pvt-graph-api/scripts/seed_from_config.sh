#!/usr/bin/env bash
# seed_from_config.sh - Populate SurrealDB KG from cloud-data-topology.json
# Usage: ./seed_from_config.sh [surreal_url] [topology_json_path]
#
# Reads cloud-data-topology.json and generates SurrealQL to create:
#   - VM nodes (from vms section)
#   - Service nodes (from services section)
#   - hosted_on edges (service -> vm)
#
# Requires: curl, python3 (or node), surreal CLI (optional)
set -euo pipefail

SURREAL_URL="${1:-http://localhost:8001}"
# cloud-data-topology.json resolution (2026-04-27):
#   1. /app/cloud-data-topology.json                                  — bundled in-image
#   2. ${CONFIG_JSON} (env or $2)                                     — explicit override / legacy
#   3. /opt/containers/kg-graph/cloud-data-topology.json              — legacy compose-mounted
#   4. <repoRoot>/1_cicd/dist/cloud-data-topology.json             — dev: cloud repo dist/
#   5. <script_dir>/../cloud-data-topology.json                       — legacy: kg-graph dir
_resolve_topology() {
    # 2026-04-28 migrated: prefer _cloud-data-consolidated.json (master file —
    # consolidated.services + consolidated.vms are a superset of cloud-data-topology.json
    # so existing downstream jq filters keep working unchanged). Falls back to legacy
    # cloud-data-topology.json paths in z_archive / clone for soft transition.
    local override="${1:-${CONFIG_JSON:-}}"
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    local candidates=(
        "/app/_cloud-data-consolidated.json"
        "${override}"
        "/opt/containers/kg-graph/_cloud-data-consolidated.json"
        "${script_dir}/../../../1_cloud-configs/dist/_cloud-data-consolidated.json"
        "${script_dir}/../_cloud-data-consolidated.json"
        # Legacy fallbacks (deprecated cloud-data-topology.json — soft transition)
        "/app/cloud-data-topology.json"
        "/opt/containers/kg-graph/cloud-data-topology.json"
        "${script_dir}/../../../1_cicd/dist/z_archive/cloud-data-topology.json"
        "${script_dir}/../../../1_cicd/dist/cloud-data-topology.json"
        "${script_dir}/../cloud-data-topology.json"
    )
    for p in "${candidates[@]}"; do
        [ -n "$p" ] && [ -f "$p" ] && { echo "$p"; return 0; }
    done
    # Best-guess fallback for error messages
    echo "/app/_cloud-data-consolidated.json"
}
CONFIG_JSON="$(_resolve_topology "${2:-}")"
SURREAL_NS="infra"
SURREAL_DB="production"

# Read password from .secrets or env
if [ -f /opt/containers/kg-graph/.secrets ]; then
    source /opt/containers/kg-graph/.secrets
fi
SURREAL_PASS="${SURREAL_PASS:-${SURREAL_ROOT_PASSWORD:-root}}"  # SURREAL_PASS = rotated root (2026-10-10)

log() { echo "[seed] $*"; }

# WG IPs, arch, cpu, ram and service domains used to be restated here as bash
# associative arrays "hardcoded from cloud architecture" — in a script named
# seed_from_config.sh. Nothing ever read them: the generator below is python and
# carried its OWN copy of the same tables, so these five were dead weight that
# still read like the source of truth. Deleted rather than corrected; the live
# copies are derived from the topology declaration inside the generator.

surreal_query() {
    curl -sf "${SURREAL_URL}/sql" \
        -H "Accept: application/json" \
        -H "surreal-ns: ${SURREAL_NS}" \
        -H "surreal-db: ${SURREAL_DB}" \
        -u "root:${SURREAL_PASS}" \
        --data-raw "$1" || { echo "FAILED: $1" >&2; return 1; }
}

# ---- Load schema ----
# Was `WARNING: schema.surql not found, skipping schema load` + carry on. The
# schema is shipped alongside this script, so its absence is a deploy fault,
# not a configuration choice — and seeding into an unschema'd database is not a
# lesser success, it is a different outcome silently reported as the intended
# one. Same class of bug as a mail account that never got created while the
# ship reported green.
log "Loading schema..."
if [ -f /opt/containers/kg-graph/schema.surql ]; then
    SCHEMA=$(cat /opt/containers/kg-graph/schema.surql)
    surreal_query "$SCHEMA" > /dev/null
    log "Schema loaded."
else
    log "ERROR: /opt/containers/kg-graph/schema.surql not found — refusing to seed into an unschema'd database."
    exit 1
fi

# ---- Parse cloud-data-topology.json and generate seed data ----
log "Parsing cloud-data-topology.json (resolved: $CONFIG_JSON)..."

if ! [ -f "$CONFIG_JSON" ]; then
    log "ERROR: cloud-data-topology.json not found (resolved path: $CONFIG_JSON)"
    exit 1
fi

# Export so the heredoc python3 block picks up the resolved path
export CONFIG_JSON

# ── Per-item outcome accounting ───────────────────────────────────────
# The generator below `continue`s past VMs with no fixed IP and past services
# pinned to "all"/"local". Those are legitimate filters, but they were also
# indistinguishable from a topology file whose every entry got skipped: the
# script would emit zero statements, seed nothing and exit 0. Counts are
# written to a FILE because the generator's stdout is captured into $SEED_SQL —
# anything it prints there becomes SurrealQL — and because a counter
# incremented inside the command-substitution subshell would be discarded on
# exit anyway.
SEED_COUNTS=$(mktemp /tmp/.kg-seed-counts.XXXXXX)
trap 'rm -f "$SEED_COUNTS"' EXIT
export SEED_COUNTS

# Generate SurrealQL using python3
SEED_SQL=$(python3 << 'PYEOF'
import json, sys, os

config_path = os.environ.get("CONFIG_JSON", "/app/cloud-data-topology.json")
with open(config_path) as f:
    config = json.load(f)

# Mesh address, arch and size are all DECLARED, per VM, in the topology file
# this script has already opened: vms[*].wg_ip and vms[*].specs.{arch,cpu,ram_gb}.
# They were restated here as literals under the comment "hardcoded from cloud
# architecture", and they had drifted in both directions:
#
#   - the table listed oci-A1-f_1 (10.0.0.2) and oci-A1-p_0 (10.0.0.7). Both are
#     real VMs that were DECOMMISSIONED, not typos: their declarations survive in
#     cloud-infra under b_infra/z_archive/vm_oci-A1-f_1/ (OCI Paid Flex 1, WG
#     10.0.0.2) and b_infra/z_archive/vm_oci-A1-p_0/ (OCI Paid Flex 2, hostname
#     oci-apps-2, WG 10.0.0.7). The declared mesh is four VMs.
#   - it also had oci-A1-f_0 at 3 CPU / 16 GB and gcp-E2-f_0 at 1 CPU, while the
#     declaration says 4 / 24 and 2. Seeding a knowledge graph from those numbers
#     put wrong hardware facts into the database that answers questions about it.
#
# Deriving costs four lines and cannot drift. A VM with no wg_ip (the on-demand
# GPU hosts) is simply not in the mesh, which is what the declaration says.
vms = config["vms"]
wg_ips  = {k: v["wg_ip"] for k, v in vms.items() if v.get("wg_ip")}
vm_arch = {k: (v.get("specs") or {}).get("arch") or "" for k, v in vms.items()}
vm_cpu  = {k: (v.get("specs") or {}).get("cpu") or 0 for k, v in vms.items()}
vm_ram  = {k: (v.get("specs") or {}).get("ram_gb") or 0 for k, v in vms.items()}
svc_domains = {
    "authelia": "auth.diegonmarcos.com",
    "vaultwarden": "vault.diegonmarcos.com",
    "ntfy": "rss.diegonmarcos.com",
    "mailu": "mail.diegonmarcos.com",
    "syncthing": "sync.diegonmarcos.com",
    "radicale": "cal.diegonmarcos.com",
    "matomo": "analytics.diegonmarcos.com",
    "photoprism": "photos.diegonmarcos.com",
    "nocodb": "db.diegonmarcos.com",
    "code-server": "ide.diegonmarcos.com",
    "cloud_notes": "drive-notes.diegonmarcos.com",
    "grist": "sheets.diegonmarcos.com",
    "revealmd": "slides.diegonmarcos.com",
    "npm": "proxy.diegonmarcos.com",
    "flask-api": "api.diegonmarcos.com",
    "hickory-dns": "dns.internal",
}

stmts = []
# Outcome tallies. Written to $SEED_COUNTS at the end for the shell to assert
# on; never to stdout, which is captured verbatim as SurrealQL.
counts = {"vms": 0, "vms_skipped": 0, "services": 0, "services_skipped": 0,
          "hosted_on": 0, "hosted_on_skipped": 0}
skips = []
created_vms = []

# --- VM nodes ---
for vm_id, vm in config["vms"].items():
    if vm.get("ip", "TBD") == "TBD":
        # Skip vast.ai (no fixed IP) — a declared filter, now a counted one.
        counts["vms_skipped"] += 1
        skips.append(f"vm {vm_id}: no fixed ip")
        continue
    provider = "gcp" if vm_id.startswith("gcp") else "oci"
    alias = vm.get("ssh_alias", vm_id)
    esc_desc = vm.get("description", "").replace("'", "\\'")
    wg = wg_ips.get(vm_id, "")
    arch = vm_arch.get(vm_id, "")
    cpu = vm_cpu.get(vm_id, 0)
    ram = vm_ram.get(vm_id, 0)

    stmts.append(f"""CREATE vm:{vm_id.replace('-','_')} CONTENT {{
    name: '{vm_id}',
    alias: '{alias}',
    ip: '{vm["ip"]}',
    wg_ip: {f"'{wg}'" if wg else "NONE"},
    user: '{vm["user"]}',
    provider: '{provider}',
    arch: {f"'{arch}'" if arch else "NONE"},
    cpu_count: {cpu if cpu else "NONE"},
    ram_gb: {ram if ram else "NONE"},
    disk_gb: NONE,
    description: '{esc_desc}',
    status: 'unknown',
    embedding: NONE,
    updated_at: time::now()
}};""")
    counts["vms"] += 1
    created_vms.append(vm_id)

# --- Service nodes ---
for svc_name, svc in config["services"].items():
    if svc.get("vm") == "all" or svc.get("vm") == "local":
        # Skip wireguard (all) and terraform (local).
        counts["services_skipped"] += 1
        skips.append(f"service {svc_name}: vm={svc.get('vm')}")
        continue
    esc_desc = svc.get("description", "").replace("'", "\\'")
    domain = svc_domains.get(svc_name, "")
    safe_id = svc_name.replace("-", "_")

    stmts.append(f"""CREATE service:{safe_id} CONTENT {{
    name: '{svc_name}',
    category: '{svc["category"]}',
    description: '{esc_desc}',
    domain: {f"'{domain}'" if domain else "NONE"},
    port: NONE,
    availability: 'unknown',
    status: 'unknown',
    embedding: NONE,
    updated_at: time::now()
}};""")
    counts["services"] += 1

# --- hosted_on edges (service -> vm) ---
for svc_name, svc in config["services"].items():
    vm_id = svc.get("vm", "")
    if vm_id in ("all", "local", "") or vm_id not in config["vms"]:
        # An unresolvable vm reference is NOT the same thing as the declared
        # all/local filter — a service pointing at a VM that is not in the
        # topology is a data fault, so name it rather than dropping the edge.
        counts["hosted_on_skipped"] += 1
        if vm_id not in ("all", "local", ""):
            skips.append(f"hosted_on {svc_name}: vm '{vm_id}' not in topology")
        continue
    if config["vms"][vm_id].get("ip", "TBD") == "TBD":
        counts["hosted_on_skipped"] += 1
        skips.append(f"hosted_on {svc_name}: vm {vm_id} has no fixed ip")
        continue
    safe_svc = svc_name.replace("-", "_")
    safe_vm = vm_id.replace("-", "_")
    stmts.append(f"RELATE service:{safe_svc}->hosted_on->vm:{safe_vm};")
    counts["hosted_on"] += 1

# --- connected_to edges (WireGuard mesh: all VMs connected to each other) ---
# Only VMs that actually got a node above. Keying this off wg_ips alone is how
# the two decommissioned ids did real damage: they were never CREATEd as vm:
# nodes, so every mesh edge naming them RELATEd to a node that does not exist —
# 15 edges emitted for 6 phantom-inflated VMs where the declared mesh has 4 and
# needs 6. Deriving wg_ips fixes those two, but a VM that is declared, has a
# wg_ip and is skipped for having no fixed IP would reintroduce it, so the edge
# generator now follows what was created rather than what was declared.
wg_vms = [k.replace("-","_") for k in created_vms if k in wg_ips]
for i, v1 in enumerate(wg_vms):
    for v2 in wg_vms[i+1:]:
        stmts.append(f"RELATE vm:{v1}->connected_to->vm:{v2};")

# --- Known dependency edges ---
# Authelia depends on redis (internal)
stmts.append("RELATE service:authelia->depends_on->service:redis SET type = 'runtime';")
# All proxied services depend on npm (reverse proxy)
proxied = ["authelia", "vaultwarden", "ntfy", "matomo", "photoprism",
           "nocodb", "code_server", "cloud_notes", "grist",
           "revealmd", "syncthing", "radicale", "flask_api", "mailu"]
for svc in proxied:
    stmts.append(f"RELATE service:{svc}->proxied_by->service:npm;")
# Authelia-protected services
auth_protected = ["vaultwarden", "photoprism", "nocodb", "code_server",
                  "cloud_notes", "grist", "revealmd", "flask_api"]
for svc in auth_protected:
    stmts.append(f"RELATE service:{svc}->authenticated_by->service:authelia;")
# Backup dependencies
stmts.append("RELATE service:backup_borg->depends_on->service:photoprism SET type = 'data';")
stmts.append("RELATE service:backup_bup->depends_on->service:nocodb SET type = 'data';")
stmts.append("RELATE service:backup_bup->depends_on->service:matomo SET type = 'data';")

with open(os.environ["SEED_COUNTS"], "w") as f:
    f.write(" ".join(f"{k}={v}" for k, v in counts.items()) + "\n")
    for s in skips:
        f.write("skip " + s + "\n")

print("\n".join(stmts))
PYEOF
)

log "Generated $(echo "$SEED_SQL" | wc -l) SurrealQL statements."
grep '^skip ' "$SEED_COUNTS" | sed 's|^|[seed]   |' || true

# ---- Execute seed ----
log "Seeding database..."
surreal_query "$SEED_SQL" > /dev/null
log "Seed complete."

# ---- Verify ----
log "Verifying..."
RESULT=$(surreal_query "SELECT count() FROM vm GROUP ALL; SELECT count() FROM service GROUP ALL; SELECT count() FROM hosted_on GROUP ALL; SELECT count() FROM connected_to GROUP ALL; SELECT count() FROM proxied_by GROUP ALL; SELECT count() FROM authenticated_by GROUP ALL; SELECT count() FROM depends_on GROUP ALL;")
echo "$RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
labels = ['VMs', 'Services', 'hosted_on', 'connected_to', 'proxied_by', 'authenticated_by', 'depends_on']
for i, label in enumerate(labels):
    count = data[i]['result'][0]['count'] if data[i]['result'] else 0
    print(f'  {label}: {count}')
" 2>/dev/null || echo "$RESULT"

# ---- Verdict ----
# One machine-readable line, then the exit code. A seed that skipped every VM
# or every service produced zero statements, seeded nothing and still exited 0
# — "the script ran" is not the same as "the graph was populated".
SEED_SUMMARY=$(head -1 "$SEED_COUNTS")
echo "[seed] SUMMARY revision=${SHIP_REVISION:-unknown} config=$CONFIG_JSON $SEED_SUMMARY"
_field() { echo "$SEED_SUMMARY" | tr ' ' '\n' | awk -F= -v k="$1" '$1==k { print $2; exit }'; }
SEEDED_VMS=$(_field vms); SEEDED_SVCS=$(_field services)
if [ "${SEEDED_VMS:-0}" -eq 0 ] || [ "${SEEDED_SVCS:-0}" -eq 0 ]; then
    log "FAILED: seeded ${SEEDED_VMS:-0} vm(s) and ${SEEDED_SVCS:-0} service(s) from $CONFIG_JSON — this run populated nothing."
    exit 1
fi

log "Done. KG seeded from cloud-data-topology.json."
