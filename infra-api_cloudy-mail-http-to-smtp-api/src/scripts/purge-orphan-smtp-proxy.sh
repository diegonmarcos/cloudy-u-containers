#!/usr/bin/env bash
# Declarative purge of the legacy `smtp-proxy` container on oci-mail.
#
# Context: http-to-smtp-proxy-api was renamed from smtp-proxy and relocated
# from oci-mail to gcp-proxy as part of the public-surface collapse
# (2026-05-08). The old container kept running on oci-mail because the
# rename did not include a decommission step — production mail was still
# being routed to oci-mail's :8080 by stale CF Worker URL until 2026-05-09.
#
# This script is the declarative one-shot decommission: it is invoked by
# `build.sh purge_orphan_oci_mail` (lifecycle.purge_orphan_oci_mail in
# build.json) and is idempotent — re-running after the container is gone
# is a no-op.
set -euo pipefail

echo "[purge-orphan-smtp-proxy] removing orphan container"
docker rm -f smtp-proxy 2>/dev/null || true

echo "[purge-orphan-smtp-proxy] removing orphan image"
docker rmi -f ghcr.io/diegonmarcos/smtp-proxy:latest 2>/dev/null || true

echo "[purge-orphan-smtp-proxy] removing /opt/containers/smtp-proxy"
sudo rm -rf /opt/containers/smtp-proxy

echo "[purge-orphan-smtp-proxy] done"
