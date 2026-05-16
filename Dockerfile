# syntax=docker/dockerfile:1.7
# =============================================================================
# WaveKit Multi-Stage Dockerfile
#
# Architecture: 20 named, narrow-purpose stages. Each decoder builds on
# `base-build` (thin toolchain image) and installs only its own apt deps with
# `--mount=type=cache,target=/var/cache/apt,sharing=locked`. Upstream sources
# are pinned to SHAs via top-of-file `ARG <NAME>_REF` declarations so a bump
# to one decoder does not invalidate any other.
#
# Final targets:
#   - final         : full single-host image (SDR++ + decoders + API)
#   - final-core    : API + decoders, SDR++ externalized (no sdrpp residue)
#   - final-sdrpp   : SDR++ server only (IQ/audio provider)
#   - final-demod   : interactive utility container for offline test work
# =============================================================================

# ============================================================================
# Pinned upstream refs (SHA or tag). Bumping any of these invalidates ONLY
# the corresponding decoder build stage.
# ============================================================================
ARG S6_OVERLAY_VERSION=3.1.6.2
ARG SDRPP_REF=052167962dbf9adc2a02825f2f428e7613255d50
ARG MBELIB_REF=9a04ed5c78176a9965f3d43f7aa1b1f5330e771f
ARG DSDFME_REF=ed1d1d630ce79db890bbf4b890317341bc5aa580
ARG MULTIMON_NG_REF=a2f7f872bd54b51e7fc6cdbafdf1c4872a52246d
ARG RTL_433_REF=19f788d0d67720ac23556b5bcdbad63a005637f2
ARG ACARSDEC_REF=206f733027131d514454c4208d3acc986c9f9a28
ARG AIS_CATCHER_REF=ac4d59be4a8d3960815157acc6a5f65560172006
ARG DIREWOLF_REF=a231971a652bfb574a4bae9a5d875fbce53d2267
ARG LIBACARS_REF=9af09a0121d4ec577339cbd4c7420d7519da48fa
ARG DUMPVDL2_REF=3f583da4957d6c74668eb174e6ecd8c1435fb25b
ARG READSB_REF=b499ecbd18dc4a2ec6098c31de31508017fa6190
ARG SOAPY_RTLTCP_REF=75a53aa251b1ef63850abea81b7617ef6978a15e
ARG CSDR_REF=1f15b8c5177cb348602da19e82bf0d62426ab8eb
ARG GR_LORA_SDR_REF=862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9

# ============================================================================
# Stage: base-build
# Purpose: Thin toolchain image shared by every *-build stage. No
#          decoder-specific or signal-processing apt deps.
# ============================================================================
FROM debian:bookworm-slim AS base-build

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        cmake \
        git \
        pkg-config \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ============================================================================
# Stage: runtime-base
# Purpose: Minimal runtime (no build tools) + s6-overlay supervisor. All
#          shared dynamic libs the decoders link against at runtime.
# ============================================================================
FROM debian:bookworm-slim AS runtime-base

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
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
        libswresample4 \
        libpulse0 \
        libsamplerate0 \
        # Runtime SDR libraries
        librtlsdr0 \
        libhackrf0 \
        libairspy0 \
        libairspyhf1 \
        libsoapysdr0.8 \
        libusb-1.0-0 \
        udev \
        # dsd-fme runtime
        libitpp8v5 \
        libfftw3-single3 \
        libfftw3-double3 \
        # direwolf runtime
        libasound2 \
        libgps28 \
        libhamlib4 \
        # dumpvdl2 runtime
        libglib2.0-0 \
        libsqlite3-0 \
        libzmq5 \
        # readsb runtime
        libncurses6 \
        zlib1g \
        libzstd1 \
        libcjson1 \
        # Runtime utilities
        ca-certificates \
        curl \
        xz-utils \
        sox \
        libsox-fmt-all \
        netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Install s6-overlay (PID 1 init system + service supervisor).
# Use TARGETARCH (per sdr-host pattern) so cross-arch builds get the right
# binaries; BUILDPLATFORM would point at the build host, not the target.
ARG S6_OVERLAY_VERSION
ARG TARGETARCH

RUN case "${TARGETARCH}" in \
        "amd64") S6_ARCH="x86_64" ;; \
        "arm64") S6_ARCH="aarch64" ;; \
        *) echo "Unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
        | tar -xJ -C / && \
    curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${S6_ARCH}.tar.xz" \
        | tar -xJ -C /

# Prepare s6-overlay runtime dirs
RUN mkdir -p /run/service /etc/s6-overlay/s6-rc.d /etc/s6-overlay/scripts && \
    chmod 755 /run/service

# ============================================================================
# Stage: sdrpp-build
# Purpose: Build SDR++ server (pinned by SDRPP_REF)
# ============================================================================
FROM base-build AS sdrpp-build

ARG SDRPP_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libfftw3-dev \
        libsndfile1-dev \
        libopus-dev \
        libopusfile-dev \
        libvorbis-dev \
        libogg-dev \
        libflac-dev \
        libpulse-dev \
        librtlsdr-dev \
        libhackrf-dev \
        libairspy-dev \
        libairspyhf-dev \
        libbladerf-dev \
        libsoapysdr-dev \
        libusb-1.0-0-dev \
        libudev-dev \
        libglfw3-dev \
        libglew-dev \
        libvolk2-dev \
        librtaudio-dev \
        libiio-dev \
        libad9361-dev \
        libcjson-dev \
        zlib1g-dev \
        libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/AlexandreRouma/SDRPlusPlus.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${SDRPP_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release \
        -DUSE_INTERNAL_GLFW=ON \
        -DUSE_BUNDLE_GLFW=ON \
        -DOPT_BUILD_M17_DECODER=OFF \
        .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: dsd-fme-build
# Purpose: Build mbelib (MBELIB_REF), then dsd-fme (DSDFME_REF). DMR, P25,
#          YSF, D-Star and friends.
# ============================================================================
FROM base-build AS dsd-fme-build

ARG MBELIB_REF
ARG DSDFME_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libitpp-dev \
        libfftw3-dev \
        libsoapysdr-dev \
        libpulse-dev \
        libncurses-dev \
        libsndfile1-dev \
        libusb-1.0-0-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/szechyjs/mbelib.git mbelib && \
    cd mbelib && \
    git fetch --depth 1 origin "${MBELIB_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install && \
    ldconfig

RUN git clone --no-checkout https://github.com/lwvmobile/dsd-fme.git dsd-fme && \
    cd dsd-fme && \
    git fetch --depth 1 origin "${DSDFME_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: multimon-ng-build
# Purpose: Build multimon-ng (MULTIMON_NG_REF). POCSAG, FLEX, EAS, DTMF, etc.
# ============================================================================
FROM base-build AS multimon-ng-build

ARG MULTIMON_NG_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libpulse-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/EliasOenal/multimon-ng.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${MULTIMON_NG_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: rtl433-build
# Purpose: Build rtl_433 (RTL_433_REF). ISM sensors, weather stations, etc.
# ============================================================================
FROM base-build AS rtl433-build

ARG RTL_433_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        librtlsdr-dev \
        libsoapysdr-dev \
        libusb-1.0-0-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/merbanan/rtl_433.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${RTL_433_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: acarsdec-build
# Purpose: Build acarsdec (ACARSDEC_REF). ACARS aircraft data link.
# ============================================================================
FROM base-build AS acarsdec-build

ARG ACARSDEC_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        librtlsdr-dev \
        libsoapysdr-dev \
        libusb-1.0-0-dev \
        libsndfile1-dev \
        libzmq3-dev \
        libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/f00b4r0/acarsdec.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${ACARSDEC_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: ais-catcher-build
# Purpose: Build AIS-catcher (AIS_CATCHER_REF). Maritime AIS transponders.
# ============================================================================
FROM base-build AS ais-catcher-build

ARG AIS_CATCHER_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        librtlsdr-dev \
        libairspy-dev \
        libairspyhf-dev \
        libhackrf-dev \
        libsoapysdr-dev \
        libusb-1.0-0-dev \
        libsqlite3-dev \
        libcurl4-openssl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/jvde-github/AIS-catcher.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${AIS_CATCHER_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    cp AIS-catcher /usr/local/bin/

# ============================================================================
# Stage: direwolf-build
# Purpose: Build direwolf (DIREWOLF_REF). APRS amateur radio packets.
# ============================================================================
FROM base-build AS direwolf-build

ARG DIREWOLF_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libasound2-dev \
        libgps-dev \
        libhamlib-dev \
        libudev-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/wb2osz/direwolf.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${DIREWOLF_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: dumpvdl2-build
# Purpose: Build libacars (LIBACARS_REF), then dumpvdl2 (DUMPVDL2_REF).
#          VDL Mode 2 aviation data link.
# ============================================================================
FROM base-build AS dumpvdl2-build

ARG LIBACARS_REF
ARG DUMPVDL2_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libfftw3-dev \
        libsqlite3-dev \
        libzmq3-dev \
        libglib2.0-dev \
        librtlsdr-dev \
        libsoapysdr-dev \
        libusb-1.0-0-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/szpajder/libacars.git libacars && \
    cd libacars && \
    git fetch --depth 1 origin "${LIBACARS_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install && \
    ldconfig

RUN git clone --no-checkout https://github.com/szpajder/dumpvdl2.git dumpvdl2 && \
    cd dumpvdl2 && \
    git fetch --depth 1 origin "${DUMPVDL2_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: readsb-build
# Purpose: Build readsb (READSB_REF). ADS-B aircraft transponders.
# ============================================================================
FROM base-build AS readsb-build

ARG READSB_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        librtlsdr-dev \
        libusb-1.0-0-dev \
        libncurses-dev \
        zlib1g-dev \
        libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/wiedehopf/readsb.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${READSB_REF}" && \
    git checkout --detach FETCH_HEAD && \
    make -j2 RTLSDR=yes OPTIMIZE="-O1" && \
    cp readsb /usr/local/bin/

# ============================================================================
# Stage: soapy-rtltcp-build
# Purpose: Build SoapyRTLTCP module (SOAPY_RTLTCP_REF) for rtl_tcp network
#          SDR support consumed by acarsdec, dumpvdl2.
# ============================================================================
FROM base-build AS soapy-rtltcp-build

ARG SOAPY_RTLTCP_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libsoapysdr-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/pothosware/SoapyRTLTCP.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${SOAPY_RTLTCP_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: csdr-build
# Purpose: Build csdr command-line SDR tools (CSDR_REF) for FM demodulation.
# ============================================================================
FROM base-build AS csdr-build

ARG CSDR_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libsamplerate-dev \
        libfftw3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/jketterl/csdr.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${CSDR_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install

# ============================================================================
# Stage: lora-build
# Purpose: Build gr-lora_sdr decoder blocks (GR_LORA_SDR_REF). LoRa /
#          Meshtastic packet decoding for the python helper.
# ============================================================================
FROM base-build AS lora-build

ARG GR_LORA_SDR_REF

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        gnuradio \
        gnuradio-dev \
        python3-dev \
        python3-numpy \
        pybind11-dev \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --no-checkout https://github.com/tapparelj/gr-lora_sdr.git repo && \
    cd repo && \
    git fetch --depth 1 origin "${GR_LORA_SDR_REF}" && \
    git checkout --detach FETCH_HEAD && \
    mkdir build && cd build && \
    cmake -DCMAKE_BUILD_TYPE=Release .. && \
    make -j"$(nproc)" && \
    make install && \
    ldconfig && \
    lora_py_dir="$(find /usr/local/lib -path '*/gnuradio/lora_sdr' -type d -print -quit)" && \
    test -n "${lora_py_dir}" && \
    lora_lib_src="$(find /usr/local/lib -maxdepth 3 -name 'libgnuradio-lora_sdr*' -printf '%h\n' -quit)" && \
    test -n "${lora_lib_src}" && \
    mkdir -p /usr/local/share/wavekit-lora/lib && \
    cp -a "${lora_py_dir}" /usr/local/share/wavekit-lora/lora_sdr && \
    cp -a "${lora_lib_src}"/libgnuradio-lora_sdr* /usr/local/share/wavekit-lora/lib/

# ============================================================================
# Stage: node-build
# Purpose: Compile the WaveKit TypeScript app. Single pnpm install honoring
#          the project's .npmrc node-linker=isolated. No double install.
# ============================================================================
FROM node:22-bookworm-slim AS node-build

WORKDIR /app

# Corepack pins pnpm to the version in package.json's `packageManager` field.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Copy workspace manifests first so the install layer caches independently
# from source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json .npmrc ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/api-types/package.json packages/api-types/tsconfig.json ./packages/api-types/
COPY cli/package.json cli/tsconfig.json ./cli/
COPY packages/sdr-host/package.json packages/sdr-host/tsconfig.json ./packages/sdr-host/

# Override .npmrc's enable-global-virtual-store=true: keep the virtual store
# at node_modules/.pnpm/ so symlinks survive the cache-mount unmount.
RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod=false \
        --config.enable-global-virtual-store=false

# Now copy sources. Edits here invalidate from this layer down — but
# decoder *-build stages are unaffected.
COPY . .

RUN --mount=type=cache,target=/root/.cache/turbo,sharing=locked \
    --mount=type=cache,target=/app/node_modules/.cache,sharing=locked \
    pnpm run typecheck

RUN --mount=type=cache,target=/root/.cache/turbo,sharing=locked \
    --mount=type=cache,target=/app/node_modules/.cache,sharing=locked \
    pnpm run build

RUN --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    CI=true pnpm prune --prod \
        --config.enable-global-virtual-store=false

RUN ls -la dist/ && head -1 dist/index.js

# ============================================================================
# Stage: final-base
# Purpose: Common ancestor of `final` and `final-core`. Holds every artifact
#          shared by both: python runtime, every decoder binary + library,
#          csdr, soapy-rtltcp, lora artifacts, the node runtime + app dist,
#          shipped scripts, canonical s6 overlay (sdrpp-free), config file.
# ============================================================================
FROM runtime-base AS final-base

LABEL maintainer="WaveKit Contributors"
LABEL description="WaveKit common runtime (API + decoders, no SDR++)"
LABEL version="1.0.0"

ENV WAVEKIT_HOME=/app \
    WAVEKIT_CONFIG_PATH=/app/config \
    WAVEKIT_LOG_LEVEL=info \
    NODE_ENV=production \
    PATH=/usr/local/bin:/usr/local/sbin:${PATH}

RUN mkdir -p /app /var/log/wavekit /var/run/wavekit && \
    chmod 755 /app /var/log/wavekit /var/run/wavekit

# Python runtime shared by the lora helper and any future python tooling.
# python3-cryptography is required by lora_meshtastic_decode.py (imports
# `from cryptography.hazmat.primitives.ciphers import ...`).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        gnuradio \
        python3-numpy \
        python3-protobuf \
        python3-cryptography \
    && rm -rf /var/lib/apt/lists/*

# Decoder binaries + their runtime libs from the *-build stages.
COPY --from=dsd-fme-build /usr/local/bin/dsd* /usr/local/bin/
COPY --from=dsd-fme-build /usr/local/lib/libmbe* /usr/local/lib/
COPY --from=multimon-ng-build /usr/local/bin/multimon-ng /usr/local/bin/
COPY --from=rtl433-build /usr/local/bin/rtl_433 /usr/local/bin/
COPY --from=acarsdec-build /usr/local/bin/acarsdec /usr/local/bin/
COPY --from=ais-catcher-build /usr/local/bin/AIS-catcher /usr/local/bin/
COPY --from=direwolf-build /usr/local/bin/direwolf /usr/local/bin/
COPY --from=direwolf-build /usr/local/bin/decode_aprs /usr/local/bin/
COPY --from=direwolf-build /usr/local/bin/gen_packets /usr/local/bin/
COPY --from=dumpvdl2-build /usr/local/bin/dumpvdl2 /usr/local/bin/
COPY --from=dumpvdl2-build /usr/local/lib/libacars* /usr/local/lib/
COPY --from=readsb-build /usr/local/bin/readsb /usr/local/bin/

# csdr + libcsdr (FM demodulation for audio-from-IQ decoder paths)
COPY --from=csdr-build /usr/local/bin/csdr /usr/local/bin/
COPY --from=csdr-build /usr/local/lib/libcsdr* /usr/local/lib/

# SoapyRTLTCP module so acarsdec / dumpvdl2 can stream from rtl_tcp
COPY --from=soapy-rtltcp-build /usr/local/lib/SoapySDR/modules0.8/librtltcpSupport.so /usr/local/lib/SoapySDR/modules0.8/

# gr-lora_sdr blocks. Python module lands in Debian's gnuradio namespace
# dir so `from gnuradio import lora_sdr` resolves regardless of arch.
COPY --from=lora-build /usr/local/share/wavekit-lora/lib/libgnuradio-lora_sdr* /usr/local/lib/
COPY --from=lora-build /usr/local/share/wavekit-lora/lora_sdr /usr/lib/python3/dist-packages/gnuradio/lora_sdr

# Lora helper script + protobuf module
COPY docker/scripts/lora_meshtastic_decode.py /usr/local/bin/
COPY docker/scripts/meshtastic_proto /usr/local/lib/wavekit/meshtastic_proto
RUN chmod 755 /usr/local/bin/lora_meshtastic_decode.py

# Refresh dynamic linker cache after all the lib drops
RUN ldconfig

# Decoder smoke-verify. We check the binaries are on PATH and runnable;
# we tolerate non-zero exit on the ones that emit a banner+usage when given
# any flag (dsd-fme, acarsdec, AIS-catcher, direwolf do this).
RUN echo "Verifying decoder installations..." && \
    command -v dsd-fme && \
    command -v multimon-ng && \
    rtl_433 -V && \
    command -v acarsdec && \
    command -v AIS-catcher && \
    command -v direwolf && \
    dumpvdl2 --version && \
    readsb --version && \
    csdr --help > /dev/null 2>&1 && \
    python3 -c "from gnuradio import lora_sdr; print(lora_sdr.__file__)" && \
    python3 /usr/local/bin/lora_meshtastic_decode.py --help > /dev/null && \
    echo "All 9 decoders + csdr verified successfully"

# Node runtime + app dist + workspace packages + config
COPY --from=node-build /usr/local/bin/node /usr/local/bin/
COPY --from=node-build /app/dist /app/dist
COPY --from=node-build /app/node_modules /app/node_modules
COPY --from=node-build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=node-build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=node-build /app/packages/api-types/package.json /app/packages/api-types/package.json
COPY --from=node-build /app/packages/api-types/dist /app/packages/api-types/dist
COPY --from=node-build /app/config /app/config
COPY --from=node-build /app/package.json /app/

# Shipped helper scripts (sdrpp-specific scripts deferred to `final`)
COPY docker/scripts/init-system.sh /usr/local/bin/
COPY docker/scripts/start-api.sh /usr/local/bin/
COPY docker/scripts/finish-api.sh /usr/local/bin/
RUN chmod 755 \
    /usr/local/bin/init-system.sh \
    /usr/local/bin/start-api.sh \
    /usr/local/bin/finish-api.sh

# Canonical s6 overlay (sdrpp-free). `final` additionally copies the sdrpp
# overlay on top of this; `final-core` ships exactly this tree.
COPY docker/overlay/s6-overlay/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

# Healthcheck wrapper
COPY docker/scripts/healthcheck.sh /etc/s6-overlay/scripts/healthcheck.sh
RUN chmod 755 /etc/s6-overlay/scripts/healthcheck.sh

# direwolf config
COPY docker/config/direwolf.conf /etc/direwolf.conf

EXPOSE 9000 8080 4713

VOLUME ["/var/log/wavekit", "/var/run/wavekit"]

WORKDIR /app

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD s6-svstat -u /run/service/wavekit-api > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/init"]

# ============================================================================
# Stage: final
# Purpose: Full single-host image. `final-base` plus SDR++ binaries plus the
#          sdrpp-server s6 overlay (additive — does not modify the canonical
#          tree, both unions cleanly).
# ============================================================================
FROM final-base AS final

LABEL mode="full"
LABEL description="WaveKit full single-host image (SDR++ + decoders + API)"

# SDR++-only runtime libs. Kept out of `runtime-base` so `final-core`
# doesn't carry them.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libglfw3 \
        libvolk2.5 \
        libglvnd0 \
        libopengl0 \
    && rm -rf /var/lib/apt/lists/*

# SDR++ binary, plugins, and shared core. Current upstream installs to
# /usr/bin and /usr/lib (not /usr/local/...). Keep the paths as-installed
# so `sdrpp`'s plugin discovery (compiled-in path) still finds the .so files.
COPY --from=sdrpp-build /usr/bin/sdrpp /usr/bin/sdrpp
COPY --from=sdrpp-build /usr/lib/libsdrpp_core.so /usr/lib/libsdrpp_core.so
COPY --from=sdrpp-build /usr/lib/sdrpp /usr/lib/sdrpp
RUN ldconfig

# sdrpp lifecycle scripts
COPY docker/scripts/start-sdrpp.sh /usr/local/bin/
COPY docker/scripts/finish-sdrpp.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/start-sdrpp.sh /usr/local/bin/finish-sdrpp.sh

# Additive sdrpp overlay. Unions sdrpp-server service + its `contents.d`
# registration files into the canonical tree without touching anything else.
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d /etc/s6-overlay/s6-rc.d
RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

EXPOSE 5259 7355

VOLUME ["/recordings"]

# ============================================================================
# Stage: final-core
# Purpose: Lightweight API + decoders (SDR++ externalized). Existence of the
#          stage is the contract — no additional content. Property 8 / 9
#          tests run against this image.
# ============================================================================
FROM final-base AS final-core

LABEL mode="core"
LABEL description="WaveKit API + decoders (SDR++ externalized)"

# ============================================================================
# Stage: final-sdrpp
# Purpose: SDR++ server only (IQ/audio provider for distributed deployments).
# ============================================================================
FROM runtime-base AS final-sdrpp

LABEL maintainer="WaveKit Contributors"
LABEL description="SDR++ server only (IQ/audio provider)"
LABEL mode="sdrpp-only"

ENV SDR_HOME=/sdr \
    LOG_LEVEL=info

RUN mkdir -p /sdr /var/log/sdrpp /var/log/wavekit && \
    chmod 755 /sdr /var/log/sdrpp /var/log/wavekit

# SDR++-only runtime libs (kept out of runtime-base so final-core stays slim).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        libglfw3 \
        libvolk2.5 \
        libglvnd0 \
        libopengl0 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=sdrpp-build /usr/bin/sdrpp /usr/bin/sdrpp
COPY --from=sdrpp-build /usr/lib/libsdrpp_core.so /usr/lib/libsdrpp_core.so
COPY --from=sdrpp-build /usr/lib/sdrpp /usr/lib/sdrpp
RUN ldconfig

COPY docker/scripts/start-sdrpp.sh /usr/local/bin/
COPY docker/scripts/finish-sdrpp.sh /usr/local/bin/
RUN chmod 755 /usr/local/bin/start-sdrpp.sh /usr/local/bin/finish-sdrpp.sh

# s6 tree for final-sdrpp: the canonical structural files (services + user
# bundle types) plus the sdrpp-server service from the sibling overlay. We
# do NOT bring in wavekit-init or wavekit-api — this image only runs sdrpp.
# COPY-by-path keeps the partition additive (Requirement 3.10) without
# pulling in unrelated services.
COPY docker/overlay/s6-overlay/s6-rc.d/services/type /etc/s6-overlay/s6-rc.d/services/type
COPY docker/overlay/s6-overlay/s6-rc.d/user/type /etc/s6-overlay/s6-rc.d/user/type
COPY docker/overlay/s6-overlay/s6-rc.d/user/contents.d/services /etc/s6-overlay/s6-rc.d/user/contents.d/services
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d/sdrpp-server/type /etc/s6-overlay/s6-rc.d/sdrpp-server/type
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d/sdrpp-server/run /etc/s6-overlay/s6-rc.d/sdrpp-server/run
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d/sdrpp-server/finish /etc/s6-overlay/s6-rc.d/sdrpp-server/finish
# sdrpp-server's `dependencies.d/wavekit-init` is INTENTIONALLY omitted —
# this image runs only sdrpp-server. Picking files individually keeps the
# tree partition additive (Requirement 3.10).
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d/services/contents.d/sdrpp-server /etc/s6-overlay/s6-rc.d/services/contents.d/sdrpp-server
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d/user/contents.d/sdrpp-server /etc/s6-overlay/s6-rc.d/user/contents.d/sdrpp-server
RUN chmod -R 755 /etc/s6-overlay/s6-rc.d

EXPOSE 5259

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD s6-svstat -u /run/service/sdrpp-server > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/init"]

# ============================================================================
# Stage: final-demod
# Purpose: Interactive utility container for offline decoder testing. Mirrors
#          the binaries shipped in `final` (so test results match production)
#          but ships no service tree — drop into a shell, prod the decoders
#          directly.
# ============================================================================
FROM runtime-base AS final-demod

LABEL maintainer="WaveKit Contributors"
LABEL description="WaveKit interactive demod test environment"
LABEL mode="demod-test"

# Interactive tooling layered on top of runtime-base. sox/libsox-fmt-all and
# netcat-openbsd are already in runtime-base; the rest are demod-only extras.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        vim \
        ffmpeg \
        gnuradio \
        gr-osmosdr \
        python3 \
        python3-pip \
        python3-numpy \
        python3-scipy \
        python3-matplotlib \
        rtl-sdr \
    && rm -rf /var/lib/apt/lists/*

# Decoder binaries that the test loop wants on the PATH. Versions are
# locked-stepped to production by sourcing from the same *-build stages.
COPY --from=dsd-fme-build /usr/local/bin/dsd* /usr/local/bin/
COPY --from=dsd-fme-build /usr/local/lib/libmbe* /usr/local/lib/
COPY --from=multimon-ng-build /usr/local/bin/multimon-ng /usr/local/bin/
COPY --from=csdr-build /usr/local/bin/csdr /usr/local/bin/
COPY --from=csdr-build /usr/local/lib/libcsdr* /usr/local/lib/

RUN ldconfig

WORKDIR /workspace
RUN mkdir -p /data/debug_audio /scripts /output

# No s6, no ENTRYPOINT — `docker compose run --rm demod-test` drops into bash.
CMD ["/bin/bash"]
