#!/bin/sh
# Authelia init — minimal, declarative, no secret-shell-mangling.
#
# The engine produces dist/.secrets.d/<KEY> (mode 0600) and auto-mounts it
# at /run/secrets/ via _shared/engine.nix. The {{ secret "/run/secrets/X" }}
# template directive in configuration.yml reads each value at startup.
# No eval/printf/sed loop needed — every secret is already a file in the
# container at the canonical path before authelia starts.
#
# Two artefacts still need rendering at boot (multi-line, env-derived):
#   /tmp/users_database.yml    — user list with hashed password from $env
#   /tmp/jwks-overlay.yml      — wraps the PEM private key from /run/secrets/
set -e

echo "[init] Generating users database..."
cat > /tmp/users_database.yml <<USERDB
---
users:
  me@@BASE_DOMAIN@:
    displayname: "Diego"
    password: "$AUTHELIA_USER_DIEGO_HASH"
    email: me@@BASE_DOMAIN@
    groups:
      - admins
      - users
USERDB

echo "[init] Generating JWKS overlay..."
cat > /tmp/jwks-overlay.yml <<'JWKSEOF'
identity_providers:
  oidc:
    jwks:
      - key_id: main
        algorithm: RS256
        use: sig
        key: |
JWKSEOF
# Indent each line of the PEM by 14 spaces so it nests under `key: |`.
# Source: /run/secrets/AUTHELIA_OIDC_JWKS_KEY (engine-mounted, mode 0600).
awk '{ print "              " $0 }' /run/secrets/AUTHELIA_OIDC_JWKS_KEY >> /tmp/jwks-overlay.yml

# ── Declarative 2FA factors — re-asserted on every boot ────────────────
# Lost-DB tolerance: if /data/db.sqlite3 is wiped (volume reset), the user
# would otherwise lose all 2FA factors and need UI re-registration. We
# instead source factor seeds from sops secrets and re-import them
# idempotently here. Once init succeeds, the user can authenticate with
# their Aegis app (TOTP) immediately, no UI dance required.
#
# Source-of-truth: vault/aegis-export-plain-*.json → injected into
# bb-sec_authelia/src/secrets.yaml::AUTHELIA_USER_ME_TOTP_SECRET.
TOTP_SEED_FILE=/run/secrets/AUTHELIA_USER_ME_TOTP_SECRET
if [ -s "$TOTP_SEED_FILE" ]; then
  echo "[init] Re-asserting TOTP factor for me@@BASE_DOMAIN@..."
  TOTP_SECRET=$(cat "$TOTP_SEED_FILE")
  # --force: overwrite any existing row → idempotent
  # #1884 its stdout is the otpauth:// URI with the seed: never let it reach the container log.
  # algorithm/digits/period match the Aegis export (SHA1/6/30 = RFC6238 default)
  authelia storage user totp generate "me@@BASE_DOMAIN@" \
    --secret "$TOTP_SECRET" \
    --algorithm SHA1 --digits 6 --period 30 \
    --force \
    --config /config/configuration.yml >/dev/null 2>&1 \
    && echo "[init]   TOTP imported OK" \
    || echo "[init]   WARNING: TOTP import failed (non-fatal)"
  unset TOTP_SECRET
fi

echo "[init] Starting Authelia..."
exec authelia \
  --config /config/configuration.yml \
  --config /tmp/jwks-overlay.yml \
  --config.experimental.filters template
