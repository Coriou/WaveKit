#!/bin/bash
# Push script for WaveKit Docker images
# Handles multi-platform builds and registry management
# Usage: ./docker/push.sh [tag] [registries...]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER="${BUILDER:-wavekit-builder}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64,linux/arm/v7}"

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

ensure_builder() {
    local driver
    if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
        docker buildx create --name "$BUILDER" --driver docker-container --config "${SCRIPT_DIR}/buildkit.toml" --use >/dev/null
    else
        driver="$(docker buildx inspect "$BUILDER" | awk -F': ' '/Driver:/ {print $2}')"
        if [ "$driver" = "docker" ]; then
            docker buildx rm "$BUILDER" >/dev/null
            docker buildx create --name "$BUILDER" --driver docker-container --config "${SCRIPT_DIR}/buildkit.toml" --use >/dev/null
        else
            docker buildx use "$BUILDER" >/dev/null
        fi
    fi
    docker buildx inspect "$BUILDER" --bootstrap >/dev/null
}

# Modes to build
MODES=("full" "core" "sdrpp")

log "Pushing WaveKit images (tag: $TAG)"
log "Registries: ${REGISTRIES[*]}"
log "Platforms: ${PLATFORMS}"

ensure_builder

for MODE in "${MODES[@]}"; do
    log ""
    log "Building and pushing mode: $MODE"
    TARGET="final"
    [ "$MODE" = "core" ] && TARGET="final-core"
    [ "$MODE" = "sdrpp" ] && TARGET="final-sdrpp"
    
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
        
        DOCKER_BUILDKIT=1 docker buildx build \
            --builder "$BUILDER" \
            --target="$TARGET" \
            --tag="$IMAGE" \
            --tag="$IMAGE_LATEST" \
            --platform="$PLATFORMS" \
            --push \
            -f Dockerfile .
        
        log "✅ Pushed: $IMAGE"
    done
done

log ""
log "✅ All images pushed successfully"
