#!/bin/sh
# C3-MCP entrypoint: fix SSH keys, start MCP HTTP server
set -e

# Fix SSH key/config permissions — mount is :ro with VM user's UID,
# SSH requires files owned by running user. Copy to writable location.
if [ -d /root/.ssh ]; then
  SSH_DIR=/tmp/.ssh-fixed
  mkdir -p "$SSH_DIR"
  cp /root/.ssh/* "$SSH_DIR/" 2>/dev/null || true
  chown -R root:root "$SSH_DIR"
  chmod 700 "$SSH_DIR"
  chmod 600 "$SSH_DIR"/* 2>/dev/null || true
  # Override HOME so SSH finds the fixed keys
  export HOME=/tmp/c3-home
  mkdir -p "$HOME"
  ln -sfn "$SSH_DIR" "$HOME/.ssh"
  echo "c3-mcp-entrypoint: SSH keys copied to $SSH_DIR (fixed permissions)"
fi

export PATH="/app/node_modules/.bin:/usr/local/nix-bin:$PATH"
# #1641: V8 is told its budget (3G cgroup ceiling in build.json containers.app.resources):
# a heap capped at half of it leaves room for the ssh/git/curl/oci/wrangler children this
# server fans out, so a leak surfaces as a V8 heap error instead of a cgroup OOM-kill.
export NODE_OPTIONS="--unhandled-rejections=throw --max-old-space-size=1536"

# Materialise OCI config + PEM from sops-passed env vars (declarative,
# data-flows entirely through src/secrets.yaml -> .secrets env file).
# Skip silently if OCI_TENANCY is unset — keeps service usable in
# environments without OCI creds.
if [ -n "$OCI_TENANCY" ] && [ -n "$OCI_API_KEY_PEM_B64" ]; then
  # Use /root/.oci (CLI default) — OCI CLI 3.x doesn't honour
  # OCI_CLI_CONFIG_FILE consistently, so writing to the default path
  # avoids needing --config-file on every invocation.
  OCI_DIR=/root/.oci
  mkdir -p "$OCI_DIR"
  chmod 700 "$OCI_DIR"
  echo "$OCI_API_KEY_PEM_B64" | base64 -d > "$OCI_DIR/oci_api_key.pem"
  chmod 600 "$OCI_DIR/oci_api_key.pem"
  cat > "$OCI_DIR/config" <<EOF
[DEFAULT]
user=$OCI_USER
fingerprint=$OCI_FINGERPRINT
tenancy=$OCI_TENANCY
region=$OCI_REGION
key_file=$OCI_DIR/oci_api_key.pem
EOF
  chmod 600 "$OCI_DIR/config"
  export OCI_COMPARTMENT_ID="$OCI_TENANCY"
  echo "c3-mcp-entrypoint: OCI config materialised at $OCI_DIR"
fi

# AWS env vars are read natively by aws CLI — no file materialisation
# needed. Just confirm presence for diagnostics.
if [ -n "$AWS_ACCESS_KEY_ID" ]; then
  echo "c3-mcp-entrypoint: AWS env vars present (region=$AWS_DEFAULT_REGION)"
fi

echo "c3-mcp-entrypoint: starting tsx mcp/http.ts (NODE_OPTIONS=$NODE_OPTIONS)"
exec tsx mcp/http.ts
