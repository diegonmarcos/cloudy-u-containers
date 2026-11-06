# Steel Browser (infra-sec_steel-browser)

Owner-authorized ethical-hacking / security-testing headless browser, for the
owner's OWN fleet services only. Apache-2.0 (github.com/steel-dev/steel-browser).

## Posture
- Image pinned by digest: `ghcr.io/steel-dev/steel-browser@sha256:c94f9ef7f18cf0a2c3c44e5b754119099488f62b4dea411e37459d6281c19799` (multi-arch amd64+arm64; upstream publishes no versioned ghcr tag, so the digest is the pin). The fleet engine wraps it into `ghcr.io/diegonmarcos/steel-browser-binaries`.
- Private only. Steel ("app") runs on a private docker bridge with NO published port and its DevTools port (9223) is never published. It is reachable ONLY through the bearer-auth Caddy sidecar ("auth"), which publishes exclusively on the oci-apps WireGuard IP `10.0.0.6:3000`. No Caddy edge route, no public DNS (wg_only by omission of any proxy block).
- Token auth: `Authorization: Bearer $STEEL_API_KEY`. **Fail closed** — if `STEEL_API_KEY` is unset the sidecar refuses to start, so Steel is never reachable without the vault secret.
- NO residential/mobile proxy pools and NO third-party CAPTCHA-solver integrations are configured (those opt-in features stay off).
- Target allowlist is enforced in the c3 MCP tool layer (`_shared/security-testing-allowlist.*`); Steel performs no filtering itself, hence it must never be exposed outside the authed path.
- Steel can optionally route through ZAP (`http://10.0.0.6:8086`) as upstream proxy for passive scanning.

## Vault secret (owner-created)
- `cloud-me-pvt-vault` → `Linux-Containers/infra-sec_steel-browser/src/secrets.yaml`, key `STEEL_API_KEY` (a long random bearer). sops age recipient is already in `.sops.yaml`; the ship secrets step decrypts it to `dist/.secrets`.

## Resources
mem 2G / cpus 1.5 (Chromium); auth sidecar 64M / 0.5. VM: oci-apps.

## Mesh address
`steel-browser.mesh.diegonmarcos.com` → 10.0.0.6 (Hickory), port 3000 (through auth).
