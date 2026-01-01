#!/bin/bash
# Initialize Docker development environment
# Run this once to set up buildx and caching

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}[init]${NC} $1"
}

log "Initializing WaveKit Docker environment..."

# Check Docker installation
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker not found${NC}"
    exit 1
fi

log "Docker version: $(docker --version)"

# Create buildx builder
log "Setting up Docker buildx builder..."
if ! docker buildx inspect wavekit-builder &> /dev/null; then
    docker buildx create --name wavekit-builder --config docker/buildkit.toml
    log "Created new buildx builder: wavekit-builder"
else
    log "Buildx builder 'wavekit-builder' already exists"
fi

docker buildx use wavekit-builder
log "Using buildx builder: wavekit-builder"

# Create build cache directory
log "Creating build cache directory..."
mkdir -p /tmp/docker-cache
chmod 777 /tmp/docker-cache

# Enable experimental features
log "Enabling Docker experimental features..."
export DOCKER_BUILDKIT=1
export BUILDKIT_PROGRESS=plain

# Create Docker networks
log "Creating Docker networks..."
docker network create wavekit 2>/dev/null || log "Network 'wavekit' already exists"

# Create volumes
log "Creating Docker volumes..."
docker volume create wavekit-config 2>/dev/null || log "Volume 'wavekit-config' already exists"
docker volume create wavekit-logs 2>/dev/null || log "Volume 'wavekit-logs' already exists"
docker volume create recordings 2>/dev/null || log "Volume 'recordings' already exists"

log ""
log "✅ Environment initialized successfully!"
log ""
log "Next steps:"
log "  1. Build images:   make docker-build"
log "  2. Start dev env:  make docker-dev"
log "  3. View logs:      make docker-logs"
