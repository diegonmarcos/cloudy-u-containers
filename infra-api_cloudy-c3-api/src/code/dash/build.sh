#!/bin/sh
# Build dash: copy src/ → dist/
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$DIR/src/"* "$DIR/dist/"
echo "dash: built to dist/"
