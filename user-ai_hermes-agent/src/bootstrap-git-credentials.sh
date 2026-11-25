#!/bin/sh
# Give git and gh a credential source that survives hermes's environment seal.
#
# local_env_policy.py strips GH_TOKEN from every subprocess hermes spawns
# (Tier-1 secret, GHSA-rhgp-j443-p4rf). Any tool shell hermes opens therefore
# has an unauthenticated gh and a credential helper that expands to an empty
# password, so it can neither push nor watch its own CI run to green — the two
# things the dispatch preamble requires of it.
#
# Both tools also read credentials from disk. This script runs in the docker-exec
# shell, which still holds the token, and writes those files once. The seal is
# untouched: nothing is put back into hermes's environment.
set -eu
# #359: the fine-grained GH_FLEET_TOKEN wins; the classic GH_TOKEN is only the fallback until the
# owner has minted it and removed GH_TOKEN from this container's sops secrets (#439).
GH_TOKEN="${GH_FLEET_TOKEN:-${GH_TOKEN:-}}"
: "${GH_TOKEN:?GH_FLEET_TOKEN/GH_TOKEN absent — run this from the exec shell, not a hermes tool shell}"

mkdir -p "$HOME/.config/gh"
# Both spellings on purpose: gh < 2.40 reads the flat host keys, gh >= 2.40 reads
# the per-user block and ignores the flat oauth_token for API calls. The two
# containers ship different gh builds, so emitting only one spelling leaves
# `gh auth status` claiming success while `gh run list` still asks you to log in.
printf 'github.com:\n    oauth_token: %s\n    user: diegonmarcos\n    git_protocol: https\n    users:\n        diegonmarcos:\n            oauth_token: %s\n' \
  "$GH_TOKEN" "$GH_TOKEN" > "$HOME/.config/gh/hosts.yml"
chmod 0600 "$HOME/.config/gh/hosts.yml"

# Then let gh rewrite the file in whatever spelling this build actually wants.
# It refuses to store anything while GH_TOKEN is set in its own environment
# ("the value of the GH_TOKEN environment variable is being used"), so hand it
# the token on stdin from a shell where the variable is already gone.
_t="$GH_TOKEN"
env -u GH_TOKEN -u GITHUB_TOKEN gh auth login --with-token <<EOF || true
$_t
EOF

printf 'https://x-access-token:%s@github.com\n' "$GH_TOKEN" > "$HOME/.git-credentials"
chmod 0600 "$HOME/.git-credentials"
git config --global credential.helper store

echo "credentials provisioned for $(whoami) at $HOME"
