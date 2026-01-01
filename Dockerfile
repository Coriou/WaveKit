# =============================================================================
# WaveKit Multi-Stage Dockerfile
#
# Architecture: Production-ready SDR stream processing framework with s6-overlay
# Process Management: Full process supervision with auto-restart & dependency handling
# Optimization: BuildKit-compatible, multi-platform (amd64/arm64), layer caching
#
# Deployment modes:
#   - full:   Everything (SDR++, WaveKit API, all decoders) - for single-host setups
#   - core:   Just API + decoders (SDR++ externalized) - for distributed setups  
#   - sdrpp:  Just SDR++ server (IQ/audio provider) - for dedicated SDR host
#
# Usage:
#   docker build -t wavekit:latest -f Dockerfile .
#   docker run --rm -it wavekit:latest
# =============================================================================

# ============================================================================
# Stage: base-deps
# Purpose: Common system dependencies for all build stages
# Size: ~150MB (reduced with only-production install)
# ============================================================================
FROM debian:bookworm-slim AS base-deps

# Use buildkit cache for package lists
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # Build toolchain
    build-essential \
    cmake \
    git \
    pkg-config \
    # Audio & signal processing
    libfftw3-dev \
    libsndfile1-dev \
    libopus-dev \
    libopusfile-dev \
    libvorbis-dev \
    libogg-dev \
    libflac-dev \
    libavformat-dev \
    libavcodec-dev \
    libswresample-dev \
    # SDR libraries
    librtlsdr-dev \
    libhackrf-dev \
    libairspy-dev \
    libairspyhf-dev \
    libbladerf-dev \
    libusb-1.0-0-dev \
    libudev-dev \
    # utilities
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# Stage: runtime-base
# Purpose: Minimal runtime dependencies (no build tools)
# Size: ~80MB
# ============================================================================
FROM debian:bookworm-slim AS runtime-base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    # Runtime audio libraries
    libsndfile1 \
    libopus0 \
    libopusfile0 \
    libvorbis0a \
    libogg0 \
    libflac12 \
    libavformat59 \
    libavcodec59 \
    libswresample3 \
    # Runtime SDR libraries  
    librtlsdr0 \
    libhackrf0 \
    libairspy0 \
    libairspyhf0 \
    libusb-1.0-0 \
    udev \
    # Runtime utilities
    ca-certificates \
    curl \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay (PID 1 init system + service supervisor)
ARG S6_OVERLAY_VERSION=3.1.6.2
ARG S6_RO_PLATFORM=x86_64
ARG BUILDPLATFORM

# Auto-detect platform for s6-overlay
RUN if [ "${BUILDPLATFORM}" = "linux/arm64" ]; then \
    S6_RO_PLATFORM=aarch64; \
    elif [ "${BUILDPLATFORM}" = "linux/arm/v7" ]; then \
    S6_RO_PLATFORM=armhf; \
    fi && \
    curl -fsSL https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz | tar -xJ -C / && \
    curl -fsSL https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_RO_PLATFORM}.tar.xz | tar -xJ -C /

# Prepare s6-overlay environment
RUN mkdir -p /run/service && \
    chmod 755 /run/service && \
    mkdir -p /etc/s6-overlay/s6-rc.d

ENTRYPOINT ["/init"]

# ============================================================================
# Stage: sdrpp-build
# Purpose: Build SDR++ server
# Size: ~800MB (not in final image)
# ============================================================================
FROM base-deps AS sdrpp-build

WORKDIR /build

# Build SDR++
RUN git clone --depth 1 --branch nightly https://github.com/AlexandreRouworx/SDRPlusPlus.git && \
    cd SDRPlusPlus && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release \
    -DUSE_INTERNAL_GLFW=ON \
    -DUSE_BUNDLE_GLFW=ON \
    -DOPT_BUILD_M17_DECODER=OFF \
    .. && \
    make -j$(nproc) && \
    make install

# ============================================================================
# Stage: dsd-fme-build
# Purpose: Build dsd-fme decoder (DMR, P25, YSF, D-Star, etc.)
# Size: ~300MB (not in final image)
# ============================================================================
FROM base-deps AS dsd-fme-build

WORKDIR /build

RUN git clone --depth 1 https://github.com/lwvmobile/dsd-fme.git && \
    cd dsd-fme && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc) && \
    make install

# ============================================================================
# Stage: multimon-ng-build
# Purpose: Build multimon-ng decoder (POCSAG, FLEX, EAS, DTMF, etc.)
# Size: ~200MB (not in final image)
# ============================================================================
FROM base-deps AS multimon-ng-build

WORKDIR /build

RUN git clone --depth 1 https://github.com/EliasOeworsl/multimon-ng.git && \
    cd multimon-ng && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc) && \
    make install

# ============================================================================
# Stage: rtl433-build
# Purpose: Build rtl_433 decoder (ISM sensors, weather stations, etc.)
# Size: ~250MB (not in final image)
# ============================================================================
FROM base-deps AS rtl433-build

WORKDIR /build

RUN git clone --depth 1 https://github.com/merbanan/rtl_433.git && \
    cd rtl_433 && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j$(nproc) && \
    make install

# ============================================================================
# Stage: node-build
# Purpose: Build WaveKit TypeScript application
# Size: ~450MB (not in final image)
# ============================================================================
FROM node:22-bookworm-slim AS node-build

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Run type checking
RUN npm run typecheck

# Build application
RUN npm run build-file -- ./src/index.ts

# Verify built output
RUN ls -la dist/ && file dist/index.js

# ============================================================================
# Stage: final (full mode)
# Purpose: Complete runtime with all components
# Size: ~1.2GB
# ============================================================================
FROM runtime-base AS final

# Metadata
LABEL maintainer="WaveKit Contributors"
LABEL description="SDR stream processing framework with integrated decoders"
LABEL version="1.0.0"

# Environment setup
ENV WAVEKIT_HOME=/app \
    WAVEKIT_CONFIG_PATH=/app/config \
    WAVEKIT_LOG_LEVEL=info \
    NODE_ENV=production \
    PATH=/usr/local/bin:/usr/local/sbin:${PATH}

# Create application directory structure
RUN mkdir -p /app /var/log/wavekit /var/run/wavekit && \
    chmod 755 /app /var/log/wavekit /var/run/wavekit

# Copy SDR++ from build stage
COPY --from=sdrpp-build /usr/local/bin/sdrpp* /usr/local/bin/
COPY --from=sdrpp-build /usr/local/lib/libsdrpp* /usr/local/lib/
RUN ldconfig

# Copy decoders from build stages
COPY --from=dsd-fme-build /usr/local/bin/dsd* /usr/local/bin/
COPY --from=multimon-ng-build /usr/local/bin/multimon-ng /usr/local/bin/
COPY --from=rtl433-build /usr/local/bin/rtl_433 /usr/local/bin/

# Verify decoder installations
RUN dsd-fme --version && multimon-ng -h > /dev/null 2>&1 && rtl_433 -V

# Copy Node.js application
COPY --from=node-build /app/dist /app/dist
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/config /app/config
COPY --from=node-build /app/package*.json /app/

# Copy s6-overlay service definitions
COPY docker/overlay/s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d

# Make service scripts executable
RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

# Create health check endpoint wrapper
RUN mkdir -p /etc/s6-overlay/scripts
COPY docker/scripts/healthcheck.sh /etc/s6-overlay/scripts/
RUN chmod 755 /etc/s6-overlay/scripts/healthcheck.sh

# Expose ports
EXPOSE 9000 \
    8080 \
    5259 \
    7355 \
    4713

# Volume mounts
VOLUME ["/var/log/wavekit", "/var/run/wavekit", "/recordings"]

# Health check using s6-svstat
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD s6-svstat -u /run/service/wavekit-api > /dev/null 2>&1 || exit 1

# Start with s6-init (PID 1)
CMD ["/init"]

# ============================================================================
# Stage: final-core (core mode - no SDR++)
# Purpose: Lightweight API + decoders (SDR++ externalized)
# Size: ~550MB
# ============================================================================
FROM runtime-base AS final-core

LABEL maintainer="WaveKit Contributors"
LABEL description="WaveKit API + decoders (SDR++ externalized)"
LABEL mode="core"

ENV WAVEKIT_HOME=/app \
    WAVEKIT_CONFIG_PATH=/app/config \
    WAVEKIT_LOG_LEVEL=info \
    NODE_ENV=production \
    PATH=/usr/local/bin:/usr/local/sbin:${PATH}

RUN mkdir -p /app /var/log/wavekit /var/run/wavekit && \
    chmod 755 /app /var/log/wavekit /var/run/wavekit

# Copy decoders only (no SDR++)
COPY --from=dsd-fme-build /usr/local/bin/dsd* /usr/local/bin/
COPY --from=multimon-ng-build /usr/local/bin/multimon-ng /usr/local/bin/
COPY --from=rtl433-build /usr/local/bin/rtl_433 /usr/local/bin/

# Copy Node.js application
COPY --from=node-build /app/dist /app/dist
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/config /app/config
COPY --from=node-build /app/package*.json /app/

# Copy s6-overlay service definitions (without sdrpp)
COPY docker/overlay/s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN rm -rf /etc/s6-overlay/s6-rc.d/sdrpp-server

COPY docker/scripts/healthcheck.sh /etc/s6-overlay/scripts/
RUN chmod 755 /etc/s6-overlay/scripts/healthcheck.sh

EXPOSE 9000 8080 4713

VOLUME ["/var/log/wavekit", "/var/run/wavekit"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD s6-svstat -u /run/service/wavekit-api > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/init"]

# ============================================================================
# Stage: final-sdrpp (sdrpp-only mode)
# Purpose: Just SDR++ server for dedicated SDR host
# Size: ~450MB
# ============================================================================
FROM runtime-base AS final-sdrpp

LABEL maintainer="WaveKit Contributors"
LABEL description="SDR++ server only (IQ/audio provider)"
LABEL mode="sdrpp-only"

ENV SDR_HOME=/sdr \
    LOG_LEVEL=info

RUN mkdir -p /sdr /var/log/sdrpp && \
    chmod 755 /sdr /var/log/sdrpp

# Copy only SDR++
COPY --from=sdrpp-build /usr/local/bin/sdrpp* /usr/local/bin/
COPY --from=sdrpp-build /usr/local/lib/libsdrpp* /usr/local/lib/
RUN ldconfig

# Basic service setup for SDR++
COPY docker/overlay/s6-overlay/s6-rc.d/base /etc/s6-overlay/s6-rc.d/base
COPY docker/overlay/s6-overlay/s6-rc.d/sdrpp-server /etc/s6-overlay/s6-rc.d/sdrpp-server

RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

EXPOSE 5259

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD s6-svstat -u /run/service/sdrpp-server > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/init"]

# ============================================================================
# Default target (full mode)
# ============================================================================
FROM final AS default
