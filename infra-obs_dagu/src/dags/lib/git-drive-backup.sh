#!/bin/bash
# git-drive-backup.sh (#1920): runs ON oci-apps. For every repo in $REPOS (space separated names of
# diegonmarcos/<repo>): shallow-clone main with the fleet's GitHub deploy key (same path as ops_git-sync),
# build <repo>.zip with git archive, export the tree, upload both to the owner's Drive through the
# google-workspace-mcp image (service-account key mounted read-only, never printed), then delete the temp
# files. ONE repo at a time so the disk (oci-apps ~94%) never holds more than one repo.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
W="${GDB_WORK:-/var/tmp/git-drive-backup/work}"
GIT_IMAGE="${GIT_IMAGE:-alpine/git:latest}"
GWS_IMAGE="${GWS_IMAGE:-ghcr.io/diegonmarcos/google-workspace-mcp-binaries:latest}"
KEY_FILE="${GDB_KEY_FILE:-/opt/containers/google-workspace-mcp/.secrets.d/GOOGLE_SERVICE_ACCOUNT_KEY}"
SSH_DIR="${GDB_SSH_DIR:-/opt/ssh-keys/dagu}"
MIN_FREE_MB="${GDB_MIN_FREE_MB:-700}"
mkdir -p "$W/manifest"; chmod 777 "$W" "$W/manifest"; FAIL=0; N=0
if [ -z "${REPOS:-}" ]; then  # SoT list: 0_registry/repos-github.json in the index repo, every owner repo
  REPOS=$(docker run --rm -v "$SSH_DIR:/ssh:ro" --entrypoint sh "$GIT_IMAGE" -c '
    export GIT_SSH_COMMAND="ssh -i /ssh/vault_id_rsa -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
    umask 0; export GIT_LFS_SKIP_SMUDGE=1; git clone -q --depth 1 git@github.com:diegonmarcos/_git-repos-master.git /t && grep -o "\"url\": *\"https://github.com/diegonmarcos/[^\"]*" /t/0_registry/repos-github.json | sed "s|.*/||"' | tr '\n' ' ')
  [ -n "$REPOS" ] || { echo "FAIL: cannot read SoT repo list"; exit 1; }
fi
for repo in $REPOS; do
  free=$(df -Pm "$W" | awk 'NR==2{print $4}')
  if [ "$free" -lt "$MIN_FREE_MB" ]; then echo "STOP: only ${free}MB free"; FAIL=1; break; fi
  rm -rf "$W/src" "$W/tree" "$W/zips"; mkdir -p "$W/src" "$W/tree" "$W/zips"
  docker run --rm -v "$W:/w" -v "$SSH_DIR:/ssh:ro" --entrypoint sh "$GIT_IMAGE" -c '
    export GIT_SSH_COMMAND="ssh -i /ssh/vault_id_rsa -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
    umask 0; export GIT_LFS_SKIP_SMUDGE=1; git clone -q --depth 1 --single-branch git@github.com:diegonmarcos/'"$repo"'.git /w/src/r || exit 11
    cd /w/src/r && git rev-parse HEAD > /w/sha && git archive --format=zip -o /w/zips/'"$repo"'.zip HEAD &&
    mkdir -p /w/tree/x && git archive --format=tar HEAD | tar -x -C /w/tree/x 2>/dev/null; true
    rm -rf /w/src/r; chmod -R a+rwX /w' || { echo "FAIL clone $repo"; FAIL=1; continue; }
  [ -s "$W/zips/$repo.zip" ] || { echo "FAIL zip $repo"; FAIL=1; continue; }
  docker run --rm -v "$W:/w" -v "$D:/job:ro" -v "$KEY_FILE:/run/secrets/GOOGLE_SERVICE_ACCOUNT_KEY:ro" \
    --entrypoint /app/.venv/bin/python "$GWS_IMAGE" -W ignore /job/git-drive-backup.py repo \
    "$repo" "/w/zips/$repo.zip" /w/tree/x "$(cat "$W/sha")" "/w/manifest/$repo.json" || { echo "FAIL upload $repo"; FAIL=1; }
  N=$((N+1))
done
docker run --rm -v "$W:/w" --entrypoint sh "$GIT_IMAGE" -c "rm -rf /w/src /w/tree /w/zips"
docker run --rm -v "$W:/w" -v "$D:/job:ro" -v "$KEY_FILE:/run/secrets/GOOGLE_SERVICE_ACCOUNT_KEY:ro" \
  --entrypoint /app/.venv/bin/python "$GWS_IMAGE" -W ignore /job/git-drive-backup.py manifest /w/manifest /w/manifest.json || FAIL=1
echo "done repos=$N fail=$FAIL"; exit $FAIL
