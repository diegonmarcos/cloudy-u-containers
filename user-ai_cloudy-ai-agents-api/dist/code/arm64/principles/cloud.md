# Cloud Infrastructure Principles

Core operating rules for this infrastructure. Follow these when suggesting or performing any infrastructure work.

---

## Declarative-Only — No Imperative Commands

**NEVER** use ad-hoc SSH commands to fix things on VMs (sysctl, sed, echo >, docker exec, etc.)
**NEVER** run `docker exec` on VMs — not even for debugging. Use `docker logs` for read-only inspection only.
**NEVER** edit files directly on VMs — no sed, echo >, cat >, or any file modification via SSH.
**SSH is READ-ONLY** — only allowed: `docker ps`, `docker logs`, `cat`, `ls`, `grep` for inspection.
**ALWAYS fix issues in source** (nix flakes in `~/git/cloud-infra/a_solutions/*/src/flake.nix`).
**ALWAYS deploy via `build.sh ship`** or push to main for GHA auto-deploy.

Quick fixes made directly on VMs get overwritten on next deploy and create phantom regressions.

---

## Deployment

- Every service has `build.sh` symlink → `_engine.sh` + `build.json`
- Deploy a single service: `gh workflow run ship.yml -f services=<name> -f vm=<vm>`
- Never deploy everything at once unless explicitly needed — use scoped `-f services=X`
- The ship engine runs from `dist/` (compiled), not `src/`. Edit `src/`, then build.
- Check deploy success with `ssh <vm> "docker ps | grep <service>"` — never trust the GHA green check alone.

---

## Secret Management

- Secrets live in `src/secrets.yaml` (sops-encrypted), never in code or env files committed to git
- The cloud repo is PUBLIC — never expose secrets in commits, diffs, or logs
- Decrypt with sops; the container injects secrets at ship time

---

## Networking

- All internal services communicate over WireGuard (wg0, 10.0.0.x)
- DNS: Hickory on 10.0.0.1 (wg0 only) — do NOT use 10.1.0.1 (no DNS on wg-public)
- Public edge: oci-analytics only. All other VMs are WG-only.
- Docker's nftables handles wg0 DNAT — no extra rules needed

---

## VM Fleet

- gcp-proxy: WireGuard hub only (no public SSH/HTTPS/SMTP)
- oci-apps: arm64, primary app host — most containers live here
- oci-analytics: public edge, x86_64, c3-public-api
- oci-mail: mail stack (Stalwart), x86_64
- gcp-gpu-embed: on-demand GPU embedding runner (bearer-auth HTTPS endpoint, not a mesh spoke)
- oci-apps-1: DECOMMISSIONED 2026-02-28

---

## Shell Rules (Termux/Nix)

- NEVER `cd` before destructive ops — use absolute paths or `git -C /path`
- NEVER use `which` — use `command -v` (POSIX)
- All nix-profile tools are on PATH (`~/.nix-profile/bin`)
