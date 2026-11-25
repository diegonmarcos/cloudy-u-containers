#!/bin/sh
# #1898: the gcp-proxy hub has 944 MB. Every container deployed there must carry a memory limit in
# its RENDERED compose (dist), the auth plane (caddy, authelia, introspect-proxy, mcp-oauth) must
# have memswap_limit == the memory limit (no swap: a swapped-out gate refaults at HDD speed and
# stalls the edge), caddy and the ws tunnel must carry oom_score_adj -900, and the postlite-*
# sidecars must be capped at >= 64 MB. Mutation-proven (a limit removed from any dist makes it red).
# Usage: sh _shared/test/gcp-proxy-memory-guard.sh [repo-root]
set -eu
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
python3 - "$ROOT" <<'PY'
import sys, os, json, glob, re
import yaml
root = sys.argv[1]
fail = 0
def ck(n, ok, d=""):
    global fail
    print(("  ok   " if ok else "  FAIL ") + n + ("" if ok else "  (" + d + ")"))
    if not ok: fail += 1
def mb(v):
    if v is None: return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([kKmMgG]?)[bB]?", str(v).strip())
    if not m: return None
    n = float(m.group(1)); u = m.group(2).lower()
    return n * {"": 1/1048576, "k": 1/1024, "m": 1, "g": 1024}[u]
def limit(svc):
    l = (((svc.get("deploy") or {}).get("resources") or {}).get("limits") or {}).get("memory")
    return l if l is not None else svc.get("mem_limit")
services = {}   # container_name -> (dir, svc)
dirs = []
for b in sorted(glob.glob(os.path.join(root, "*/build.json"))):
    try: j = json.load(open(b))
    except Exception: continue
    if (j.get("deploy") or {}).get("host") != "gcp-proxy": continue
    d = os.path.dirname(b); dirs.append(os.path.basename(d))
    for f in glob.glob(os.path.join(d, "dist", "**", "docker-compose.yml"), recursive=True):
        y = yaml.safe_load(open(f)) or {}
        for k, s in (y.get("services") or {}).items():
            services[s.get("container_name", k)] = (os.path.basename(d), s)
ck("discovery: gcp-proxy services found", len(dirs) >= 8 and len(services) >= 10, f"{len(dirs)} dirs, {len(services)} containers")
for name, (d, s) in sorted(services.items()):
    ck(f"{d}/{name} declares a memory limit", limit(s) is not None)
for n in ("postlite-npm", "postlite-ntfy", "postlite-vaultwarden", "postlite-authelia"):
    s = services.get(n)
    ck(f"{n} present in the rendered hub compose", s is not None)
    if s: ck(f"{n} memory limit >= 64M", (mb(limit(s[1])) or 0) >= 64, str(limit(s[1])))
for n in ("caddy", "authelia", "introspect-proxy", "mcp-oauth"):
    s = services.get(n)
    ck(f"{n} present in the rendered hub compose", s is not None)
    if s:
        m, w = limit(s[1]), s[1].get("memswap_limit")
        ck(f"{n} memswap_limit == memory limit", m is not None and mb(w) == mb(m), f"mem={m} memswap={w}")
for n in ("caddy", "wireguard-mesh-ws-tunnel"):
    s = services.get(n)
    ck(f"{n} oom_score_adj -900", s is not None and s[1].get("oom_score_adj") == -900, str(s and s[1].get("oom_score_adj")))
print("FAIL" if fail else "PASS")
sys.exit(1 if fail else 0)
PY
