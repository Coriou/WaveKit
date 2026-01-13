# =============================================================================
# wavekit-sdr-host Dockerfile
# Multi-stage build for RTL-SDR dongle hosting with rtlmux fanout
# Platforms: linux/amd64, linux/arm64
# =============================================================================

# Stage: rtlmux-build
FROM debian:bookworm-slim AS rtlmux-build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential git ca-certificates libevent-dev gengetopt \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Build slepp/rtlmux from GitLab (canonical source)
RUN git clone --depth 1 https://gitlab.com/slepp/rtlmux.git && \
    cd rtlmux && \
    make -j$(nproc) && \
    cp rtlmux /usr/local/bin/

# Stage: rtlsdr-build
FROM debian:bookworm-slim AS rtlsdr-build

ARG RTLSDR_VERSION=v2.0.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git pkg-config libusb-1.0-0-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

RUN git clone --depth 1 --branch ${RTLSDR_VERSION} https://github.com/osmocom/rtl-sdr.git && \
    cd rtl-sdr && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release \
      -DDETACH_KERNEL_DRIVER=ON \
      -DINSTALL_UDEV_RULES=OFF \
      -DBUILD_TESTING=OFF \
      .. && \
    make -j$(nproc) && \
    make install

# Stage: node-build
FROM node:22-bookworm-slim AS node-build

# Install pnpm v10
RUN npm install -g pnpm@10

WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json .npmrc ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api-types/package.json packages/api-types/tsconfig.json ./packages/api-types/
COPY packages/sdr-host/package.json packages/sdr-host/tsconfig.json packages/sdr-host/tsconfig.build.json ./packages/sdr-host/
COPY packages/shared/src ./packages/shared/src
COPY packages/api-types/src ./packages/api-types/src
COPY packages/sdr-host/src ./packages/sdr-host/src

# Install dependencies and build
RUN pnpm install --frozen-lockfile --prod=false && \
    pnpm --filter @wavekit/shared build && \
    pnpm --filter @wavekit/api-types build && \
    pnpm --filter @wavekit/sdr-host build && \
    CI=true pnpm prune --prod

# Stage: runtime
FROM debian:bookworm-slim AS runtime

LABEL maintainer="WaveKit Contributors"
LABEL description="RTL-SDR dongle host with rtlmux fanout and status API"
LABEL version="1.0.0"

# Runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-2.1-7 \
    libevent-pthreads-2.1-7 \
    libusb-1.0-0 \
    usbutils \
    curl \
    ca-certificates \
    xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay (same version as main WaveKit)
ARG S6_OVERLAY_VERSION=3.1.6.2
ARG TARGETARCH

RUN case "${TARGETARCH}" in \
      "amd64") S6_ARCH="x86_64" ;; \
      "arm64") S6_ARCH="aarch64" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    curl -fsSL https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz | tar -xJ -C / && \
    curl -fsSL https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz | tar -xJ -C /

# Prepare s6-overlay directories
RUN mkdir -p /run/service && chmod 755 /run/service

# Copy binaries
COPY --from=rtlmux-build /usr/local/bin/rtlmux /usr/local/bin/
COPY --from=rtlsdr-build /usr/local/bin/rtl_* /usr/local/bin/
COPY --from=rtlsdr-build /usr/local/lib/librtlsdr* /usr/local/lib/
RUN echo "/usr/local/lib" > /etc/ld.so.conf.d/rtl-sdr.conf && ldconfig

# Copy Node.js runtime and application
COPY --from=node-build /usr/local/bin/node /usr/local/bin/
COPY --from=node-build /app/packages/sdr-host/dist /app/dist
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=node-build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=node-build /app/packages/api-types/package.json /app/packages/api-types/package.json
COPY --from=node-build /app/packages/api-types/dist /app/packages/api-types/dist

# Copy s6-overlay service definitions
COPY packages/sdr-host/docker/overlay/s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

WORKDIR /app

# Environment defaults
ENV SDR_HOST_LOGGING__LEVEL=info \
    SDR_HOST_RTLMUX__PORT=5555 \
    SDR_HOST_API__PORT=8080

# Expose ports
# 5555: rtlmux IQ stream
# 5556: rtlmux stats HTTP
# 8080: Status API
EXPOSE 5555 5556 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["/init"]
