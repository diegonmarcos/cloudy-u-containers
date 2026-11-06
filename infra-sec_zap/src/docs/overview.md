# OWASP ZAP (infra-sec_zap)

Owner-authorized ethical-hacking / security scanner (daemon), for the owner's
OWN fleet services only. Apache-2.0 (github.com/zaproxy/zaproxy).

## Posture
- Image pinned by digest: `ghcr.io/zaproxy/zaproxy@sha256:9624669db72f54d86c4b46a7064518bd9bf79d8c61a4c31befa9923489f328af` (tag `stable`, multi-arch amd64+arm64). Wrapped into `ghcr.io/diegonmarcos/zap-binaries`.
- Headless daemon bound to the oci-apps WireGuard IP `10.0.0.6:8086` ONLY — the public IP is never bound. No Caddy edge route, no public DNS (private/mesh only).
- Native API-key auth: every call requires `api.key=$ZAP_API_KEY`. **Fail closed** — if `ZAP_API_KEY` is unset the container refuses to start.
- `api.addrs` is restricted to `10.0.0.*` (regex) so only mesh callers may use the API.
- The declared target allowlist is enforced as ZAP context/scope by the c3 MCP `zap_*` tools (they set the include-in-context regex from `_shared/security-testing-allowlist.json`) AND re-checked in the MCP layer before every spider/scan; out-of-scope targets are refused and logged.
- Steel can route its traffic through this ZAP as an HTTP proxy for passive scanning.

## Vault secret (owner-created)
- `cloud-me-pvt-vault` → `Linux-Containers/infra-sec_zap/src/secrets.yaml`, key `ZAP_API_KEY` (a long random key). Decrypted to `dist/.secrets` by the ship secrets step.

## Resources
mem 2G / cpus 1.5 (JVM). VM: oci-apps.

## Mesh address
`zap.mesh.diegonmarcos.com` → 10.0.0.6 (Hickory), API on port 8086.
