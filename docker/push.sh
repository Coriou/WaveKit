#!/bin/bash
# Push script for WaveKit Docker images
# Handles multi-platform builds and registry management
# Usage: ./docker/push.sh [tag] [registries...]

set -e

TAG="${1:-latest}"
REGISTRIES=("${@:2}")

# Default registries
if [ ${#REGISTRIES[@]} -eq 0 ]; then
    REGISTRIES=("docker.io" "ghcr.io")
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[push]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[warn]${NC} $1"
}

error() {
    echo -e "${RED}[error]${NC} $1"
    exit 1
}

# Modes to build
MODES=("full" "core" "sdrpp")

log "Pushing WaveKit images (tag: $TAG)"
log "Registries: ${REGISTRIES[*]}"

for MODE in "${MODES[@]}"; do
    log ""
    log "Building and pushing mode: $MODE"
    
    for REGISTRY in "${REGISTRIES[@]}"; do
        IMAGE_NAME="${REGISTRY}/wavekit"
        
        if [ "$MODE" = "full" ]; then
            IMAGE="${IMAGE_NAME}:${TAG}"
            IMAGE_LATEST="${IMAGE_NAME}:latest"
        else
            IMAGE="${IMAGE_NAME}:${TAG}-${MODE}"
            IMAGE_LATEST="${IMAGE_NAME}:latest-${MODE}"
        fi
        
        log "Pushing: $IMAGE"
        
        DOCKER_BUILDKIT=1 docker build \
            --target="final-${MODE#full}" \
            --tag="$IMAGE" \
            --tag="$IMAGE_LATEST" \
            --platform=linux/amd64,linux/arm64,linux/arm/v7 \
            --push \
            -f Dockerfile .
        
        log "✅ Pushed: $IMAGE"
    done
done

log ""
log "✅ All images pushed successfully"
