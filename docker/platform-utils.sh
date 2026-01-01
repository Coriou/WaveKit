#!/bin/bash
# Platform detection and multi-arch build helper
# Automatically selects correct architecture for builds

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

# Multi-platform build
build_multiarch() {
    local tag=$1
    local platforms="${2:-linux/amd64,linux/arm64,linux/arm/v7}"
    
    echo "Building for platforms: $platforms"
    
    DOCKER_BUILDKIT=1 docker buildx build \
        --platform "$platforms" \
        --tag "wavekit:${tag}" \
        --push \
        .
}

# Export functions
export -f detect_platform
export -f build_multiarch
