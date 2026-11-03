#!/usr/bin/env bash

# Create directory tree in persistent volume
mkdir -p /persist/.config /persist/.local/share /persist/.antigravity /persist/.agy /persist/.claude /persist/workspace /persist/git 2>/dev/null || true

# Symlink persistent paths into home
ln -sfn /persist/.config /root/.config 2>/dev/null || true
ln -sfn /persist/.local/share /root/.local/share 2>/dev/null || true
ln -sfn /persist/.antigravity /root/.antigravity 2>/dev/null || true
ln -sfn /persist/.agy /root/.agy 2>/dev/null || true
ln -sfn /persist/.claude /root/.claude 2>/dev/null || true
ln -sfn /persist/git /root/git 2>/dev/null || true

# Direct 1-to-1 sync mappings
ln -sfn /persist/workspace /root/shared-container 2>/dev/null || true
ln -sfn /persist/workspace /root/workspace 2>/dev/null || true

# Clone git repositories into persistent storage
cd /persist/git

if [ -d /seed_git/_git-repos-master ] && [ ! -d "/persist/git/_git-repos-master" ]; then
  cp -r /seed_git/_git-repos-master /persist/git/
fi

for REPO in cloud-infra ops-Tooling ml-MachineLearning; do
  if [ ! -d "/persist/git/$REPO" ]; then
    git clone "https://github.com/diegonmarcos/${REPO}.git" 2>/dev/null || true
  fi
done

# Save authorized email
touch /tmp/allowed_emails.txt
if [ -n "$ALLOWED_EMAIL" ]; then
  echo "$ALLOWED_EMAIL" > /tmp/allowed_emails.txt
fi

# Land user directly into the synced shared-container directory
cd /persist/workspace 2>/dev/null || cd /root

# Start web terminal
echo "Starting ttyd on 127.0.0.1:7681..."
ttyd -p 7681 -i 127.0.0.1 -I /usr/local/share/ttyd/index.html -W bash &

# Bind OAuth2 proxy to dynamic Cloud Run port
PORT_TO_USE="${PORT:-8080}"
echo "Starting oauth2-proxy on 0.0.0.0:${PORT_TO_USE}..."
exec oauth2-proxy \
  --http-address="0.0.0.0:${PORT_TO_USE}" \
  --upstream="http://127.0.0.1:7681" \
  --provider="google" \
  --client-id="${OAUTH_CLIENT_ID}" \
  --client-secret="${OAUTH_CLIENT_SECRET}" \
  --cookie-secret="${COOKIE_SECRET}" \
  --cookie-secure=true \
  --cookie-expire="168h" \
  --authenticated-emails-file="/tmp/allowed_emails.txt" \
  --email-domain="*" \
  --proxy-websockets=true \
  --reverse-proxy=true
