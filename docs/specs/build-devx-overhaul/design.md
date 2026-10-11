# Build & DX Overhaul — Design

## 1. Current State Diagnosis

The current build system exhibits 14 distinct anti-patterns. This section
enumerates each, names the mechanism in the new design that retires it, and
identifies the affected file(s).

| #  | Anti-pattern                                                                                                                                                                          | New mechanism that retires it                                                                                                                                                                                                                                       | Affected files                                          |
|----|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------|
| 1  | Double pnpm install in `node-build` (lines 426–438): isolated linker, then reconfigure to hoisted, then re-install                                                                    | Single `pnpm install --frozen-lockfile --prod=false` with project default linker (`isolated` per `.npmrc`). The hoisted reconfigure block is deleted.                                                                                                               | `Dockerfile`, `.npmrc` (no change; already isolated)    |
| 2  | `final-core` copies entire s6 tree then `rm -rf`'s `sdrpp-server` paths (lines 674–680)                                                                                               | s6 tree partition: canonical `docker/overlay/s6-overlay/` excludes sdrpp-server entirely. `final` adds it from `docker/overlay/s6-overlay-sdrpp/`. `wavekit-api → sdrpp-server` hard dep is removed from the canonical tree (semantic change documented in §5).     | `Dockerfile`, `docker/overlay/s6-overlay/`              |
| 3  | `base-deps` god-layer installs build deps for all 11 decoders in one RUN                                                                                                              | Thin `base-build` stage with only toolchain commons. Each `*-build` stage installs its own deps with `--mount=type=cache,target=/var/cache/apt,sharing=locked`.                                                                                                     | `Dockerfile`                                            |
| 4  | Unpinned `git clone --depth 1` against branch tips for 10 of 11 decoders                                                                                                              | Every decoder build stage declares `ARG <DECODER>_REF=<sha>` at top of Dockerfile and checks out the pinned ref via `git fetch --depth 1 origin "${REF}" && git checkout --detach FETCH_HEAD`. Lora's existing pattern (line 282) is the template.                  | `Dockerfile`                                            |
| 5  | No `TARGETPLATFORM`/`TARGETARCH` awareness; arm64 multi-arch builds run under QEMU end-to-end                                                                                         | Every stage that does arch-conditional work declares `ARG TARGETARCH` per sdr-host's pattern. `runtime-base` switches s6 platform detection from `BUILDPLATFORM` (wrong) to `TARGETARCH`. `final-core`'s hardcoded `x86_64-linux-gnu` ncurses path is removed (§6). | `Dockerfile`                                            |
| 6  | `docker/build.sh` invokes plain `docker build`, bypassing buildx, multi-arch, registry cache, and provenance                                                                          | `make docker-build` invokes `docker buildx bake` against `docker/bake.hcl`. `docker/build.sh` is replaced or rewritten as a thin wrapper that calls `buildx bake`. No script under `docker/` invokes plain `docker build`.                                          | `docker/build.sh`, `docker/bake.hcl` (new), `Makefile`  |
| 7  | Two parallel dev flows: `make dev-up` (Makefile-native, plain `docker run`) and `make docker-dev` (compose)                                                                           | Single compose with `dev` profile. Native TypeScript loop becomes `pnpm dev` (no Docker). `make dev-stack` aliases `docker compose --profile dev up --build`. `make dev-up`/`dev-start`/`dev-stop`/`dev-restart` and `make docker-dev` are deleted.                 | `Makefile`, `compose.yaml`                              |
| 8  | `docker-compose.dev.yml` defines `nginx-reverse-proxy` and `codercom/code-server` services that nobody uses                                                                           | Both services are deleted; not reintroduced in `compose.yaml`.                                                                                                                                                                                                      | `compose.yaml`                                          |
| 9  | `docker-compose.demod-test.yml` + `docker/Dockerfile.demod-test` rebuild dsd-fme/multimon-ng/csdr/rtl-sdr from scratch (~600MB duplication)                                           | New `final-demod` stage in the main Dockerfile COPIES binaries from existing `*-build` stages. Compose service `demod-test` lives under the `demod-test` profile.                                                                                                   | `Dockerfile`, `compose.yaml`, deletion: `docker/Dockerfile.demod-test`, `docker-compose.demod-test.yml` |
| 10 | CI never exercises Docker (current `.github/workflows/ci.yml` is 26 lines of pnpm lint/typecheck/build)                                                                               | New `docker-build` CI job depends on the existing pnpm job, sets up QEMU + buildx, runs `docker buildx bake --target ci-core` on PR (no push), on main builds `default` group with `--push` and `--cache-to mode=max`.                                              | `.github/workflows/ci.yml`                              |
| 11 | tsconfig drift: root `tsconfig.json` has `composite: false` and excludes `cli`/`packages`; `tsconfig.base.json` has `composite: true`                                                | Out-of-scope (CLAUDE.md "Don't propose unrelated refactoring"). Noted in `tasks.md` as a follow-up.                                                                                                                                                                 | n/a                                                     |
| 12 | `.dockerignore` lists build caches near the bottom; effectiveness unverified                                                                                                          | Audit step in `tasks.md` verifies `.turbo/`, `.pnpm-store/`, `.docker-cache/` are effectively excluded from context. The `.docker-cache` entry stays as defensive.                                                                                                  | `.dockerignore`                                         |
| 13 | `./.docker-cache` local cache directory is per-machine, unshared                                                                                                                      | Replaced by GHCR registry cache (§4). `docker/init.sh` no longer creates `.docker-cache`. Compose `cache_from`/`cache_to` references rewritten to `type=registry`.                                                                                                  | `docker/init.sh`, `compose.yaml`, all old compose files (deleted) |
| 14 | `runtime-base` apt cache mount caches `/var/lib/apt` (rebased by subsequent `rm -rf`)                                                                                                 | Apt cache mounts SHALL only target `/var/cache/apt`. The `/var/lib/apt` cache mount is dropped. `rm -rf /var/lib/apt/lists/*` stays.                                                                                                                                | `Dockerfile`                                            |

## 2. Target Dockerfile Structure

### 2.1 Stage Inventory

20 named stages in a single Dockerfile.

**Toolchain & runtime bases (2):**

- `base-build` (from `debian:bookworm-slim`): build-essential, cmake, git,
  pkg-config, ca-certificates, curl. Nothing decoder-specific.
- `runtime-base` (from `debian:bookworm-slim`): minimal runtime libs +
  s6-overlay v3.1.6.2 installed via `TARGETARCH`-conditioned curl. Includes
  the audio/SDR runtime libs the decoders dynamically link against. **No
  cache mount on `/var/lib/apt`.**

**Decoder/binary builders (12):**

Each builds on `base-build`, declares the apt deps it needs in its own
`RUN apt-get install` (with `/var/cache/apt` cache mount), and uses a pinned
`ARG <NAME>_REF` for the upstream checkout.

- `sdrpp-build` — REF: `SDRPP_REF` (current code clones nightly branch;
  pin to a tested SHA at refactor time).
- `dsd-fme-build` — builds `mbelib` first (pinned `MBELIB_REF`), then dsd-fme
  (pinned `DSDFME_REF`).
- `multimon-ng-build` — REF: `MULTIMON_NG_REF`.
- `rtl433-build` — REF: `RTL_433_REF`.
- `acarsdec-build` — REF: `ACARSDEC_REF`.
- `ais-catcher-build` — REF: `AIS_CATCHER_REF`.
- `direwolf-build` — REF: `DIREWOLF_REF`.
- `dumpvdl2-build` — builds `libacars` first (pinned `LIBACARS_REF`), then
  dumpvdl2 (pinned `DUMPVDL2_REF`).
- `readsb-build` — REF: `READSB_REF`.
- `soapy-rtltcp-build` — REF: `SOAPY_RTLTCP_REF`.
- `csdr-build` — REF: `CSDR_REF`.
- `lora-build` — REF: `GR_LORA_SDR_REF` (already pinned; pattern source).

**Application builder (1):**

- `node-build` (from `node:22-bookworm-slim`): Corepack-prepared pnpm
  10.28.0. Copies workspace manifests + lockfile, runs `pnpm install
  --frozen-lockfile --prod=false` exactly once, copies sources, runs
  `pnpm typecheck` and `pnpm build`, runs `pnpm prune --prod`. Uses Turbo
  cache mount + `node_modules/.cache` cache mount. No linker reconfiguration.

**Final composites (5):**

- `final-base` (from `runtime-base`): python3 + gnuradio + python3-numpy +
  python3-protobuf (drop python3-cryptography if unused) + decoders + csdr
  + soapy-rtltcp + lora artifacts + node runtime + app dist + scripts +
  canonical s6 overlay (`docker/overlay/s6-overlay/`, which contains
  wavekit-init + wavekit-api + base + services-without-sdrpp + user-without-sdrpp).
  HEALTHCHECK on `wavekit-api`. `ENTRYPOINT ["/init"]`.
- `final` (from `final-base`): adds SDR++ binaries from `sdrpp-build` +
  `docker/overlay/s6-overlay-sdrpp/` (sdrpp-server service dir + the two
  `contents.d/sdrpp-server` registration files). EXPOSE adds 5259/7355.
  LABEL mode=full.
- `final-core` (from `final-base`): adds nothing. LABEL mode=core. This is a
  one-line stage.
- `final-sdrpp` (from `runtime-base`): SDR++ binaries + a minimal s6 overlay
  with just the sdrpp-server service. Existing target, gets the `TARGETARCH`
  s6 fix.
- `final-demod` (from `runtime-base` plus minimal apt: sox, ffmpeg,
  netcat-openbsd, vim, python3 + numpy via apt): COPIES dsd-fme + multimon-ng
  + csdr + rtl-sdr binaries from the existing `*-build` stages. `WORKDIR
  /workspace`. `CMD ["/bin/bash"]`. Replaces `docker/Dockerfile.demod-test`.

### 2.2 Stage Dependency Graph

```
debian:bookworm-slim
   |
   |-- base-build ----+
   |                  +-- sdrpp-build ---------------\
   |                  +-- dsd-fme-build --------------\
   |                  +-- multimon-ng-build -----------\
   |                  +-- rtl433-build -----------------\
   |                  +-- acarsdec-build ----------------\
   |                  +-- ais-catcher-build --------------\
   |                  +-- direwolf-build ------------------\
   |                  +-- dumpvdl2-build -------------------\
   |                  +-- readsb-build ----------------------\
   |                  +-- soapy-rtltcp-build ------------------>--+
   |                  +-- csdr-build --------------------------/  |
   |                  +-- lora-build -------------------------/   |
   |                                                              |
   |-- runtime-base ----------- final-base <---------- node-build |
                                  |  ^                            |
                                  |  +-(COPY --from for all)------+
                                  |
                                  +-- final            (adds SDR++ + sdrpp overlay)
                                  +-- final-core       (no additions)
                                  +-- final-demod      (from runtime-base; COPIES tools)
                                  +-- final-sdrpp      (from runtime-base; SDR++ only)
```

### 2.3 Pinned ARG Block

Top of Dockerfile contains a single ARG block. Each ref is a 40-char SHA OR
a tag. Renovate/Dependabot can bump these.

Implementation captures HEAD of each repo's main/master at refactor time
(see task B.1.1) and pins to that SHA. Bumps thereafter go through PR
review. The schema is:

```dockerfile
# Upstream refs (SHA or tag) for reproducible decoder builds.
# Initial SHAs captured during implementation per tasks.md §B.1.1.
ARG S6_OVERLAY_VERSION=3.1.6.2
ARG SDRPP_REF=<40-char sha, captured at impl-time>
ARG MBELIB_REF=<40-char sha, captured at impl-time>
ARG DSDFME_REF=<40-char sha, captured at impl-time>
ARG MULTIMON_NG_REF=<40-char sha, captured at impl-time>
ARG RTL_433_REF=<40-char sha, captured at impl-time>
ARG ACARSDEC_REF=<40-char sha, captured at impl-time>
ARG AIS_CATCHER_REF=<40-char sha, captured at impl-time>
ARG DIREWOLF_REF=<40-char sha, captured at impl-time>
ARG LIBACARS_REF=<40-char sha, captured at impl-time>
ARG DUMPVDL2_REF=<40-char sha, captured at impl-time>
ARG READSB_REF=<40-char sha, captured at impl-time>
ARG SOAPY_RTLTCP_REF=<40-char sha, captured at impl-time>
ARG CSDR_REF=<40-char sha, captured at impl-time>
ARG GR_LORA_SDR_REF=862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9
```

## 3. Compose Topology

One file: `compose.yaml` at the repo root.

```yaml
name: wavekit

x-cache-refs: &cache-refs
  base-build: type=registry,ref=ghcr.io/coriou/wavekit:cache-base-build
  # (one entry per cached stage; HCL-equivalent in bake.hcl)

services:

  # ---------- dev profile ----------
  sdrpp-server:
    profiles: ["dev"]
    image: wavekit:dev-sdrpp
    build:
      context: .
      target: final-sdrpp
      cache_from:
        - type=registry,ref=ghcr.io/coriou/wavekit:cache-final-sdrpp
      # cache_to omitted for local builds; only CI on main writes cache
    container_name: wavekit-sdrpp
    ports: ["5259:5259"]
    networks: [wavekit]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:5259/"]
      interval: 10s; timeout: 5s; retries: 3; start_period: 20s

  wavekit-api:
    profiles: ["dev"]
    image: wavekit:dev-core
    build:
      context: .
      target: final-core
      cache_from:
        - type=registry,ref=ghcr.io/coriou/wavekit:cache-final-core
        - type=registry,ref=ghcr.io/coriou/wavekit:cache-final-base
        - type=registry,ref=ghcr.io/coriou/wavekit:cache-node-build
    container_name: wavekit-api
    depends_on:
      sdrpp-server: { condition: service_healthy }
    environment:
      WAVEKIT_LOG_LEVEL: debug
      NODE_ENV: development
      SDR_SOURCE: "tcp://sdrpp-server:5259"
    ports:
      - "9000:9000"
      - "8080:8080"
      - "8081:8081"
      - "4713:4713"
    networks: [wavekit]
    volumes:
      - ./config:/app/config:ro
      - ./logs:/var/log/wavekit
      - ./decoded_calls:/app/decoded_calls
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:9000/health"]
      interval: 10s; timeout: 5s; retries: 3; start_period: 30s
    cap_add: [SYS_NICE, NET_RAW]

  # ---------- prod-single-host profile ----------
  wavekit-full:
    profiles: ["prod-single-host"]
    image: ghcr.io/coriou/wavekit:latest
    container_name: wavekit
    restart: unless-stopped
    environment:
      WAVEKIT_LOG_LEVEL: info
      RTL_TCP_HOST: ${RTL_TCP_HOST:-127.0.0.1}
      RTL_TCP_PORT: ${RTL_TCP_PORT:-1234}
    ports: ["9000:9000", "8080:8080", "5259:5259", "4713:4713"]
    networks: [wavekit]
    volumes:
      - wavekit-config:/app/config
      - wavekit-logs:/var/log/wavekit
      - recordings:/recordings
    healthcheck: { test: ["CMD","curl","-fsS","http://localhost:9000/health"], interval: 30s, ... }
    deploy:
      resources:
        limits: { cpus: "2", memory: 1G }
    cap_add: [SYS_NICE, NET_RAW]
    security_opt: ["no-new-privileges:true"]

  # ---------- prod-distributed profile ----------
  wavekit-sdrpp-prod:
    profiles: ["prod-distributed"]
    image: ghcr.io/coriou/wavekit:latest-sdrpp
    # ...
  wavekit-core-prod:
    profiles: ["prod-distributed"]
    image: ghcr.io/coriou/wavekit:latest-core
    depends_on: [wavekit-sdrpp-prod]
    environment:
      SDR_SOURCE: "tcp://wavekit-sdrpp-prod:5259"
    # ...

  # ---------- demod-test profile ----------
  demod-test:
    profiles: ["demod-test"]
    image: wavekit:dev-demod
    build:
      context: .
      target: final-demod
      cache_from:
        - type=registry,ref=ghcr.io/coriou/wavekit:cache-final-demod
    volumes:
      - ./debug_audio:/data/debug_audio
      - ./scripts:/scripts
      - ./output:/output
    working_dir: /workspace
    stdin_open: true
    tty: true

networks:
  wavekit:
    driver: bridge

volumes:
  wavekit-config:
  wavekit-logs:
  recordings:
```

**Files deleted as part of this refactor**:

- `docker-compose.dev.yml`
- `docker-compose.prod.yml`
- `docker-compose.override.yml`
- `docker-compose.demod-test.yml`
- `docker/Dockerfile.demod-test`

**Files unchanged**: `packages/sdr-host/docker-compose.yml` (different
deployment target — runs on the Pi).

## 4. Build Cache Strategy

### 4.1 Registry refs (canonical list)

One BuildKit cache ref per stage. Naming: `cache-<stage-name>` exactly as the
stage appears in `FROM ... AS <name>`.

```
ghcr.io/coriou/wavekit:cache-base-build
ghcr.io/coriou/wavekit:cache-runtime-base
ghcr.io/coriou/wavekit:cache-sdrpp-build
ghcr.io/coriou/wavekit:cache-dsd-fme-build
ghcr.io/coriou/wavekit:cache-multimon-ng-build
ghcr.io/coriou/wavekit:cache-rtl433-build
ghcr.io/coriou/wavekit:cache-acarsdec-build
ghcr.io/coriou/wavekit:cache-ais-catcher-build
ghcr.io/coriou/wavekit:cache-direwolf-build
ghcr.io/coriou/wavekit:cache-dumpvdl2-build
ghcr.io/coriou/wavekit:cache-readsb-build
ghcr.io/coriou/wavekit:cache-soapy-rtltcp-build
ghcr.io/coriou/wavekit:cache-csdr-build
ghcr.io/coriou/wavekit:cache-lora-build
ghcr.io/coriou/wavekit:cache-node-build
ghcr.io/coriou/wavekit:cache-final-base
ghcr.io/coriou/wavekit:cache-final
ghcr.io/coriou/wavekit:cache-final-core
ghcr.io/coriou/wavekit:cache-final-sdrpp
ghcr.io/coriou/wavekit:cache-final-demod
```

### 4.2 Cache behaviour

- **Local builds** (`make docker-build`): `--cache-from=type=registry,
  ref=<each cache ref>` is passed via bake. No `--cache-to`. Cache misses
  fall through to local layer cache then to a clean rebuild.
- **CI on PR**: `--cache-from` only. No login, no push, no `--cache-to`.
- **CI on main push**: `--cache-from` AND `--cache-to=type=registry,
  ref=<ref>,mode=max`. `mode=max` caches every intermediate layer, not just
  the final manifest, so future cold builds get full hits.
- **Multi-arch**: bake builds `linux/amd64` and `linux/arm64` simultaneously
  via the docker-container buildx driver. Each cache ref stores both arches.

### 4.3 docker/bake.hcl shape

```hcl
variable "REGISTRY" { default = "ghcr.io/coriou/wavekit" }
variable "TAG"      { default = "latest" }
variable "CACHE_FROM_ONLY" { default = "true" }  # CI overrides to false on main

# Per-stage cache spec (HCL function reused across targets)
function "cache" {
  params = [stage]
  result = [
    "type=registry,ref=${REGISTRY}:cache-${stage}",
  ]
}

target "_base" {
  context = "."
  dockerfile = "Dockerfile"
  platforms = ["linux/amd64", "linux/arm64"]
  # cache_from set per-target below
}

target "final" {
  inherits = ["_base"]
  target = "final"
  tags = ["${REGISTRY}:${TAG}"]
  cache-from = concat(
    cache("final"), cache("final-base"), cache("node-build"),
    cache("sdrpp-build"), cache("dsd-fme-build"), cache("multimon-ng-build"),
    cache("rtl433-build"), cache("acarsdec-build"), cache("ais-catcher-build"),
    cache("direwolf-build"), cache("dumpvdl2-build"), cache("readsb-build"),
    cache("soapy-rtltcp-build"), cache("csdr-build"), cache("lora-build"),
    cache("base-build"), cache("runtime-base"),
  )
  cache-to = CACHE_FROM_ONLY == "true" ? [] : [
    "type=registry,ref=${REGISTRY}:cache-final,mode=max",
  ]
}

target "final-core" {
  inherits = ["_base"]
  target = "final-core"
  tags = ["${REGISTRY}:${TAG}-core"]
  cache-from = [ /* same upstream chain minus sdrpp-build */ ]
  cache-to = CACHE_FROM_ONLY == "true" ? [] : [
    "type=registry,ref=${REGISTRY}:cache-final-core,mode=max",
  ]
}

target "final-sdrpp" { ... }
target "final-demod" { ... }

# CI helper: only final-core for PR sanity
target "ci-core" {
  inherits = ["final-core"]
}

group "default" {
  targets = ["final", "final-core", "final-sdrpp"]
}

group "demod" {
  targets = ["final-demod"]
}
```

## 5. s6 Service Contract Change

### 5.1 What changes

The canonical s6 tree (`docker/overlay/s6-overlay/s6-rc.d/`) currently
contains:

```
base/
sdrpp-server/
sdrpp-server/dependencies.d/wavekit-init
wavekit-init/
wavekit-api/
wavekit-api/dependencies.d/sdrpp-server   <-- HARD s6 DEP, removed
wavekit-api/dependencies.d/wavekit-init
user/contents.d/sdrpp-server               <-- moved to sdrpp overlay
user/contents.d/wavekit-api
user/contents.d/wavekit-init
user/contents.d/services
services/contents.d/sdrpp-server           <-- moved to sdrpp overlay
services/contents.d/wavekit-api
services/contents.d/wavekit-init
```

After refactor, the canonical tree (used by `final-base`, shipped in
`final-core`) becomes:

```
docker/overlay/s6-overlay/s6-rc.d/
├── base/
├── wavekit-init/
├── wavekit-api/
│   └── dependencies.d/wavekit-init        <-- sdrpp-server entry GONE
├── user/contents.d/wavekit-api
├── user/contents.d/wavekit-init
├── user/contents.d/services
└── services/contents.d/wavekit-api
    services/contents.d/wavekit-init
```

A new sibling overlay (used by `final`) contains the sdrpp-server-only bits:

```
docker/overlay/s6-overlay-sdrpp/s6-rc.d/
├── sdrpp-server/
│   ├── type, run, finish
│   └── dependencies.d/wavekit-init
├── user/contents.d/sdrpp-server
└── services/contents.d/sdrpp-server
```

`final` does:

```dockerfile
COPY docker/overlay/s6-overlay-sdrpp/s6-rc.d /etc/s6-overlay/s6-rc.d
```

This COPY is **additive** — paths under `user/contents.d/` and
`services/contents.d/` are files (one per registered service), so two
separate trees union cleanly without conflict.

### 5.2 Runtime contract

The current hard dep `wavekit-api → sdrpp-server` is over-tight. In `final`
mode it adds nothing the runtime contract doesn't already cover; in
`final-core` mode it has to be deleted post-hoc, which is the anti-pattern
we're retiring.

Loosening to a soft start-order:

- **Presence-based supervision**: a service is supervised iff its directory
  exists under `/etc/s6-overlay/s6-rc.d/` AND it's registered in
  `services/contents.d/`. `final-base` ships only wavekit-init and
  wavekit-api. `final` additionally ships sdrpp-server.
- **No hard s6 dep**: wavekit-api waits ONLY for wavekit-init. SDR-source
  reachability is handled by the application layer.
- **App-layer guarantee**: `SourceManager` (CLAUDE.md, "Stream pipeline"
  section) already handles SDR source unavailability via exponential backoff
  on `SourceConnectionError`. The application's reconnect contract is the
  authoritative source-availability mechanism. The s6 hard dep duplicates
  this guarantee at a layer that has to be hacked out for non-sdrpp deployment
  modes.
- **Boot-order observation**: in `final` mode, both wavekit-api and
  sdrpp-server become RUNNING under s6 once wavekit-init is up. If
  sdrpp-server takes longer to bind its port than wavekit-api takes to dial
  it, the api retries until success — same code path that handles a remote
  sdrpp going away mid-run.

### 5.3 Acceptance test (verifiable post-build)

```bash
docker run --rm wavekit:latest-core ls /etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/
# Expected output: wavekit-init   (only)

docker run --rm wavekit:latest-core find /etc/s6-overlay -name 'sdrpp-server*' -o -path '*/sdrpp-server*'
# Expected output: (empty)

docker run --rm wavekit:latest find /etc/s6-overlay -name 'sdrpp-server'
# Expected: /etc/s6-overlay/s6-rc.d/sdrpp-server (one match)
```

## 6. Migration Plan

### 6.1 Files DELETED

- `/Users/ben/Projects/wavekit/docker-compose.dev.yml`
- `/Users/ben/Projects/wavekit/docker-compose.prod.yml`
- `/Users/ben/Projects/wavekit/docker-compose.override.yml`
- `/Users/ben/Projects/wavekit/docker-compose.demod-test.yml`
- `/Users/ben/Projects/wavekit/docker/Dockerfile.demod-test`
- `/Users/ben/Projects/wavekit/docker/README.md` (optional: reduce to a
  one-line pointer instead of full deletion)
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/sdrpp-server`
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay/s6-rc.d/sdrpp-server/` (entire dir; moved)
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay/s6-rc.d/services/contents.d/sdrpp-server` (moved)
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay/s6-rc.d/user/contents.d/sdrpp-server` (moved)

### 6.2 Files ADDED

- `/Users/ben/Projects/wavekit/compose.yaml` (canonical compose with profiles)
- `/Users/ben/Projects/wavekit/docker/bake.hcl` (declarative build matrix)
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay-sdrpp/s6-rc.d/sdrpp-server/` (mirrors the deleted canonical-tree entry; same contents)
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay-sdrpp/s6-rc.d/services/contents.d/sdrpp-server`
- `/Users/ben/Projects/wavekit/docker/overlay/s6-overlay-sdrpp/s6-rc.d/user/contents.d/sdrpp-server`

### 6.3 Files EDITED

- `/Users/ben/Projects/wavekit/Dockerfile` — top-to-bottom refactor per §2
- `/Users/ben/Projects/wavekit/Makefile` — per §7
- `/Users/ben/Projects/wavekit/.github/workflows/ci.yml` — per §8
- `/Users/ben/Projects/wavekit/.dockerignore` — verify, no functional change
- `/Users/ben/Projects/wavekit/docker/build.sh` — rewrite as thin
  `buildx bake` wrapper OR delete (Makefile calls bake directly)
- `/Users/ben/Projects/wavekit/docker/push.sh` — drop docker.io path; GHCR-only
- `/Users/ben/Projects/wavekit/docker/init.sh` — drop `.docker-cache` mkdir;
  keep buildx-builder setup
- `/Users/ben/Projects/wavekit/docker/platform-utils.sh` — delete `build_multiarch` (replaced by bake); keep `detect_platform` if used elsewhere, else delete the file
- `/Users/ben/Projects/wavekit/packages/sdr-host/Dockerfile` — line 47 Corepack fix (Requirement 9.1)
- `/Users/ben/Projects/wavekit/docs/DOCKER-SETUP.md` — rewrite for new workflow
- `/Users/ben/Projects/wavekit/CLAUDE.md` — condense "Day-to-day dev (Docker)" section

## 7. Makefile Target Inventory

### 7.1 New canonical targets (post-refactor)

```
help                    # default; lists targets

# Native dev loop (no Docker)
dev                     # alias to `pnpm dev`
dev-dashboard           # alias to `pnpm dev:dashboard` (already exists; renames)
dev-dashboard-build     # unchanged
dev-configs             # unchanged

# Container integration (full stack)
dev-stack               # docker compose --profile dev up --build
dev-stack-down          # docker compose --profile dev down
dev-stack-logs          # docker compose --profile dev logs -f
dev-shell               # docker compose --profile dev exec wavekit-api /bin/bash
dev-status              # docker compose --profile dev ps + curl /health

# Build / push
docker-init             # idempotent buildx builder + buildkit.toml install
docker-build            # docker buildx bake --file docker/bake.hcl default
docker-push             # docker buildx bake --file docker/bake.hcl default --push (CACHE_FROM_ONLY=false)
docker-clean            # docker compose --profile prod-distributed down -v; remove volumes
docker-prune            # docker system prune helper

# Demod tooling
demod-test              # docker compose --profile demod-test run --rm demod-test

# Pi-hosted SDR (unchanged, separate concern)
sdr-host-build          # unchanged
sdr-host-build-multi    # unchanged
sdr-host-install        # unchanged
sdr-host-init           # unchanged
sdr-host-up             # unchanged
sdr-host-update         # unchanged
sdr-host-down           # unchanged
sdr-host-restart        # unchanged
sdr-host-logs           # unchanged
sdr-host-status         # unchanged
sdr-host-health         # unchanged
sdr-host-compose-update # unchanged
sdr-host-clean          # unchanged

# Fixtures (unchanged)
fixtures-download
fixtures-download-all
fixtures-convert
fixtures-test
fixtures-test-local
```

### 7.2 Deletions

```
docker-build (old per-mode)   docker-build-full   docker-build-core   docker-build-sdrpp
docker-dev   docker-prod      docker-compose-up   docker-compose-down   docker-compose-logs
docker-run-core               docker-test         docker-test-coverage  docker-lint
demo                          install-buildx      docker-logs-api       docker-logs-sdrpp
docker-logs-decoders          docker-info         docker-inspect        docker-history
dev-up   dev-build   dev-start   dev-stop   dev-restart
dev-logs   dev-logs-raw   dev-audio   dev-debug-audio
```

`docker-logs` and `docker-shell` get renamed to `dev-stack-logs` and
`dev-shell` (still work; behaviour matches name).

## 8. CI Workflow Shape

`.github/workflows/ci.yml` after refactor:

```yaml
name: CI

on: [push, pull_request]

jobs:
  lint-typecheck-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Enable Corepack
        run: corepack enable
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Lint
        run: pnpm run lint
      - name: Typecheck
        run: pnpm run typecheck
      - name: Build
        run: pnpm run build
      - name: Test
        run: pnpm test

  docker-build:
    needs: lint-typecheck-test
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
        with:
          driver: docker-container
      - name: Log in to GHCR (main only)
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Build (PR — cache-from only)
        if: github.event_name == 'pull_request'
        uses: docker/bake-action@v5
        with:
          files: docker/bake.hcl
          targets: ci-core
          set: |
            *.platform=linux/amd64,linux/arm64
            *.cache-to=
      - name: Build & push (main)
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: docker/bake-action@v5
        with:
          files: docker/bake.hcl
          targets: default
          push: true
          set: |
            *.platform=linux/amd64,linux/arm64
            CACHE_FROM_ONLY=false
```

PR cycle: ~15-25 min for cold cache, ~2-5 min with cache hits.

Main push cycle: ~25-40 min cold, similar warm.

## 9. DevX Flows

### 9.1 `pnpm dev` — native TypeScript loop

```
contributor edits src/foo.ts
   ↓
esbuild watcher rebuilds dist/index.js (~150 ms)
   ↓
node --watch detects file change, restarts (~300 ms)
   ↓
fastify listens on :9000
```

`pnpm dev` is defined in `package.json` (already exists, see line 23). The
script is `concurrently --raw "pnpm:dev:*"` which runs `dev:build`
(esbuild watch) and `dev:run` (node --watch) in parallel.

Prerequisites: contributor has an SDR source reachable (rtl_tcp running on
local machine, or sdrpp on a remote Pi, or `tcp://localhost:1234`). The
config file selects which.

### 9.2 `make dev-stack` — full container stack

```
make dev-stack
   ↓
docker buildx bake (via compose) builds final-core + final-sdrpp
   (cache-from GHCR registry; first build pulls cached layers)
   ↓
compose starts sdrpp-server, then wavekit-api (depends_on healthy)
   ↓
contributor curl localhost:9000/health
```

`make dev-stack` is the right tool for: end-to-end decoder testing,
verifying the s6 service tree, validating multi-arch behaviour, and
exercising the runtime image as it ships.

## 10. Correctness Properties

These are the invariants that must hold post-refactor. Each maps to either
an automated test in CI or a manual verification step in `tasks.md`'s
Non-negotiables.

### Property 1: Decoder-isolated cache invalidation

**Statement**: Editing the upstream ref or apt deps of one decoder build
stage SHALL NOT invalidate any other decoder build stage's cache.

**Validates**: Requirements 3.1, 3.2.

**Verification**: After warm build, bump `READSB_REF` to a different SHA and
re-run `make docker-build`. Observe via `--progress=plain` that only the
`readsb-build` stage re-executes; `dsd-fme-build`, `multimon-ng-build`, etc.
report `CACHED`.

### Property 2: Per-decoder apt deps live in their decoder's stage

**Statement**: No apt package outside the toolchain commons (`base-build`)
SHALL be installed in `base-build`. Decoder-specific apt deps SHALL only
appear in the corresponding `<decoder>-build` stage.

**Validates**: Requirements 3.1, 3.2.

**Verification**: `grep -E '^\s*lib(itpp|fftw3|asound2|sqlite3|zmq3|opus|vorbis|flac|av(format|codec)|hackrf|airspy|bladerf|samplerate|gps|hamlib)' Dockerfile` SHALL return matches only in `<decoder>-build` stages, not in `base-build` or `runtime-base`. (Runtime equivalents like `libitpp8v5` ARE expected in `runtime-base`.)

### Property 3: TypeScript edit does not trigger decoder rebuilds

**Statement**: After a warm build, editing any file under `src/` and
re-running `make docker-build` SHALL re-execute only `node-build`,
`final-base`, and the affected `final-*` stages; every decoder build stage
SHALL report `CACHED`.

**Validates**: Requirements 3.1, 3.2, 3.7, 4.1.

**Verification**: Touch `src/decoders/registry.ts`, run `make docker-build`,
inspect `--progress=plain` output.

### Property 4: Warm-cache no-op build

**Statement**: A second consecutive `make docker-build` invocation with no
source changes SHALL report `CACHED` for every step and produce no new
intermediate images.

**Validates**: Requirements 4.1, 4.2.

**Verification**: `time make docker-build` twice in a row. Second invocation
SHALL complete in under 30 seconds and write zero MB of new image layers.

### Property 5: Cold-cache pull from GHCR matches warm local build

**Statement**: A `docker system prune -af && make docker-build` invocation
on a freshly-pruned machine that has `docker login ghcr.io` SHALL complete
without re-executing any decoder build stage (all stages SHALL be pulled as
cache).

**Validates**: Requirements 4.1, 4.2, 4.3.

**Verification**: Prune, build, observe `--progress=plain`: every
`*-build` stage SHALL report `CACHED [linux/amd64]` (or `[linux/arm64]`) with
a "transferring cache" line, not "Running".

### Property 6: Cold-cache without auth still succeeds

**Statement**: On a fresh machine WITHOUT `docker login ghcr.io`,
`make docker-build` SHALL succeed (slowly) by falling through to local
rebuilds.

**Validates**: Requirement 4.3.

**Verification**: `docker logout ghcr.io`, prune, build, observe no auth
error in output; build completes.

### Property 7: No `pnpm dev` Docker dependency

**Statement**: `pnpm dev` SHALL succeed on a machine where the Docker
daemon is stopped (`sudo systemctl stop docker` on Linux,
`OrbStack/Docker.app` quit on macOS).

**Validates**: Requirements 1.1, 1.2.

**Verification**: Stop Docker, run `pnpm dev`, observe esbuild and node
both running, observe `curl http://localhost:9000/health` returns 200 (with
SDR source mocked or pre-running).

### Property 8: final-core image contains no sdrpp residue

**Statement**: `docker run --rm wavekit:latest-core find /etc/s6-overlay
-iname '*sdrpp*'` SHALL produce empty output. `docker run --rm
wavekit:latest-core ls /usr/local/bin/ | grep -i sdrpp` SHALL produce empty
output.

**Validates**: Requirements 3.9, 3.10, 3.11.

**Verification**: `docker run --rm wavekit:latest-core sh -c 'find
/etc/s6-overlay -iname "*sdrpp*" ; ls /usr/local/bin/ | grep -i sdrpp'`
prints nothing.

### Property 9: wavekit-api dependency graph is minimal in final-core

**Statement**: `docker run --rm wavekit:latest-core ls
/etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/` SHALL output exactly
one line: `wavekit-init`.

**Validates**: Requirements 3.10, 3.11, §5 contract.

**Verification**: Command above. Output `wavekit-init` and nothing else.

### Property 10: Multi-arch images land in registry on main push

**Statement**: After a push to `main`, `docker manifest inspect
ghcr.io/coriou/wavekit:latest-core` SHALL list manifests for both
`linux/amd64` and `linux/arm64`.

**Validates**: Requirements 5.4, 7.4.

**Verification**: Command above. Both arches appear.

### Property 11: No plain `docker build` in scripts

**Statement**: `grep -rn 'docker build' docker/ Makefile` (excluding
`docker buildx build`) SHALL produce zero matches.

**Validates**: Requirement 5.1.

**Verification**: `grep -rn '\bdocker build\b' docker/ Makefile | grep -v
buildx` returns no results.

### Property 12: Single canonical compose file

**Statement**: `ls /Users/ben/Projects/wavekit/docker-compose*.yml
/Users/ben/Projects/wavekit/compose*.yaml 2>/dev/null` SHALL list exactly
one file: `compose.yaml`.

**Validates**: Requirement 2.6.

**Verification**: Command above. One file listed (the
`packages/sdr-host/docker-compose.yml` is correctly under `packages/` and
doesn't match the glob at repo root).

## 11. Risk & Rollback

### 11.1 Risks

| Risk                                                                                                                                              | Likelihood | Mitigation                                                                                                                                                                                                                                |
|---------------------------------------------------------------------------------------------------------------------------------------------------|------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Pinned decoder SHAs lock us to old/buggy versions                                                                                                 | Medium     | Initial pin captures the SHA currently in production. Renovate/Dependabot configured for the bake.hcl/ARG block to surface bumps as PRs.                                                                                                  |
| `isolated` linker breaks an obscure decoder integration that worked under `hoisted`                                                               | Low        | Project `.npmrc` has been `node-linker=isolated` since 2024. Local builds already use it. The Dockerfile's `hoisted` override was the divergence, not the default.                                                                        |
| Removing the s6 hard dep `wavekit-api → sdrpp-server` causes wavekit-api to start before sdrpp is listening, producing log noise on first connect | Low        | Application already handles this via `SourceManager` exponential backoff (CLAUDE.md §"Stream pipeline"). Log noise is acceptable; behaviour was already this way whenever sdrpp restarted mid-run.                                        |
| GHCR cache pulls dominate cold-build wall time more than expected                                                                                 | Low        | `mode=max` cache write on main keeps even intermediate layers. If pulls are slow, contributors can opt out via `make docker-build CACHE_FROM_ONLY=true` (becomes a no-op cache-from) — the bake.hcl variable is already there.            |
| `final-demod` interactive shell drifts from the standalone test environment                                                                       | Low        | `final-demod` builds from the same `*-build` stages used by `final` and `final-core` — by construction, the binary versions match production. Drift is impossible without explicit edit.                                                  |
| Renovate-style PRs to bump every decoder SHA all at once become noisy                                                                             | Low        | Group all decoder refs into a single Renovate `packageRule` (out-of-scope but trivial follow-up).                                                                                                                                         |

### 11.2 Rollback

Each change is git-revertable. The migration is structured so that the
Dockerfile refactor, the compose collapse, the Makefile cleanup, and the CI
workflow rewrite are separable commits. If `dev-stack` regresses, revert the
compose commit and the old four-file setup returns.

The s6 service contract change (removing the `sdrpp-server` hard dep) is
the only semantic change with non-trivial rollback: reverting requires
either restoring the dependency file in the canonical tree (breaks
final-core build cleanliness) OR keeping the partition and restoring the
file only in `s6-overlay-sdrpp/`'s sister overlay (preserves both modes;
this is the preferred rollback path if it ever becomes necessary).
