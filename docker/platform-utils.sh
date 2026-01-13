#!/bin/bash
# Platform detection and multi-arch build helper
# Automatically selects correct architecture for builds

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER="${BUILDER:-wavekit-builder}"

detect_platform() {
    local kernel=$(uname -s)
    local machine=$(uname -m)
    
    case "${kernel}/${machine}" in
        Linux/x86_64)
            echo "linux/amd64"
            ;;
        Linux/aarch64)
            echo "linux/arm64"
            ;;
        Linux/armv7l)
            echo "linux/arm/v7"
            ;;
        Darwin/x86_64)
            echo "linux/amd64"  # Docker Desktop
            ;;
        Darwin/arm64)
            echo "linux/arm64"  # Apple Silicon
            ;;
        *)
            echo "linux/amd64"  # Fallback
            ;;
    esac
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

# Multi-platform build
build_multiarch() {
    local tag=$1
    local platforms="${2:-linux/amd64,linux/arm64,linux/arm/v7}"
    
    echo "Building for platforms: $platforms"
    
    ensure_builder

    DOCKER_BUILDKIT=1 docker buildx build \
        --builder "$BUILDER" \
        --platform "$platforms" \
        --tag "wavekit:${tag}" \
        --push \
        .
}

# Export functions
export -f detect_platform
export -f build_multiarch
