#!/bin/bash
# Push WaveKit images to GHCR via docker buildx bake.
# Delegates the entire build matrix to docker/bake.hcl; this script only
# wires up env-var overrides (registry owner, tag, group, platforms) and
# flips CACHE_FROM_ONLY=false so the push populates mode=max cache.
#
# Usage:
#   ./docker/push.sh [tag] [group]
#
# Environment overrides:
#   WAVEKIT_GH_OWNER  GHCR org/user (default: coriou)
#   PLATFORMS         comma-separated buildx platforms (default: linux/amd64,linux/arm64)

set -euo pipefail

OWNER="${WAVEKIT_GH_OWNER:-coriou}"
REGISTRY="ghcr.io/${OWNER}/wavekit"
TAG="${1:-latest}"
GROUP="${2:-default}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[push] registry=${REGISTRY} tag=${TAG} group=${GROUP} platforms=${PLATFORMS}"

export REGISTRY TAG
export CACHE_FROM_ONLY=false

exec docker buildx bake \
    --file "${SCRIPT_DIR}/bake.hcl" \
    --set "*.platform=${PLATFORMS}" \
    --push \
    "${GROUP}"
