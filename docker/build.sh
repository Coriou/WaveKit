#!/bin/bash
# Build script for WaveKit Docker images
# Features: Multi-platform support, BuildKit caching, layer optimization
# Usage: ./docker/build.sh [mode] [tag]
# Modes: full (default), core, sdrpp

set -e

MODE="${1:-full}"
TAG="${2:-latest}"
REGISTRY="${REGISTRY:-}"
BUILDKIT="${BUILDKIT:-1}"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[build]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[warn]${NC} $1"
}

error() {
    echo -e "${RED}[error]${NC} $1"
    exit 1
}

# Validate mode
case "$MODE" in
    full|core|sdrpp)
        log "Building mode: $MODE"
        ;;
    *)
        error "Invalid mode: $MODE. Must be: full, core, or sdrpp"
        ;;
esac

# Set target
TARGET="final"
[ "$MODE" = "core" ] && TARGET="final-core"
[ "$MODE" = "sdrpp" ] && TARGET="final-sdrpp"

# Image name
IMAGE="${REGISTRY}wavekit:${TAG}-${MODE}"
[ "$MODE" = "full" ] && IMAGE="${REGISTRY}wavekit:${TAG}"

log "Image: $IMAGE"
log "Target: $TARGET"

# Enable BuildKit
export DOCKER_BUILDKIT=$BUILDKIT

# Build command
BUILD_ARGS=(
    "--target=$TARGET"
    "--tag=$IMAGE"
    "--progress=plain"
)

# Multi-platform if specified
if [ -n "$PLATFORMS" ]; then
    log "Building for platforms: $PLATFORMS"
    BUILD_ARGS+=("--platform=$PLATFORMS")
    BUILD_ARGS+=("--push")
else
    log "Building for local platform"
fi

# Build
log "Starting build..."
docker build "${BUILD_ARGS[@]}" -f Dockerfile .

log "✅ Build complete: $IMAGE"
log "Size: $(docker image inspect $IMAGE --format='{{.Size}}' | numfmt --to=iec)"
