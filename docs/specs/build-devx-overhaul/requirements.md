# Build & DX Overhaul — Requirements

## Overview

WaveKit ships a 737-line Dockerfile, four parallel docker-compose files, two
divergent dev flows in the Makefile, and a CI workflow that never exercises
Docker. The result: cold builds take long enough that contributors avoid them,
warm builds re-execute work that should be cached, the dev compose silently
mounts host `dist/` over the container's built artifacts, and a touch to any
decoder's apt deps invalidates the entire 11-decoder build cascade.

This spec replaces that build system with one Dockerfile of named, narrow
stages; one compose file with profiles; a GHCR-backed BuildKit registry cache;
a native `pnpm dev` headline loop; and CI that builds at least the `core` image
target on every PR.

Stack, supervision, package manager, and decoder set are unchanged. See
**Out-of-Scope** below for what is explicitly NOT being touched.

## User Stories & Acceptance Criteria

### 1. Native TypeScript iteration loop

**As a** WaveKit contributor working on non-decoder TypeScript code,
**I want** a single command that runs the app with hot reload on my host,
**so that** I don't pay the Docker round-trip on every edit.

- **1.1** WHEN a developer runs `pnpm dev` from the repo root THE system SHALL
  run esbuild in watch mode against `src/index.ts` and `node --watch` against
  the resulting `dist/index.js` in parallel, without invoking Docker.
- **1.2** WHEN a developer runs `pnpm dev` THE system SHALL NOT require any
  running Docker daemon, Docker socket, or Docker CLI.
- **1.3** WHEN a TypeScript file under `src/` changes THE running app SHALL
  restart within the time of one esbuild rebuild plus one Node restart (target:
  under 2 seconds on a current laptop) without any manual intervention.
- **1.4** WHEN a developer runs `pnpm dev` THE app SHALL connect to whatever
  SDR source is configured by `config/<active>.yaml` or `WAVEKIT_SOURCES_*` env
  vars; no SDR source is started by `pnpm dev` itself.
- **1.5** WHEN documenting the dev workflow `CLAUDE.md` and
  `docs/DOCKER-SETUP.md` SHALL present `pnpm dev` as the default iteration
  loop and `make dev-stack` as the integration-testing fallback.

### 2. Full-stack integration testing via compose profiles

**As a** WaveKit contributor testing decoder pipelines end-to-end,
**I want** one command that brings up the full container stack against a
mock or external SDR source,
**so that** I don't need to remember which of four compose files to use.

- **2.1** WHEN a developer runs `docker compose --profile dev up` THE system
  SHALL start the `sdrpp-server` service (target `final-sdrpp`) and the
  `wavekit-api` service (target `final-core`) with `wavekit-api` connecting
  to `sdrpp-server:5259`.
- **2.2** WHEN a developer runs `docker compose --profile prod-single-host
  up -d` THE system SHALL start the `wavekit-full` service (image
  `wavekit:latest`, target `final`) with no build step.
- **2.3** WHEN a developer runs `docker compose --profile prod-distributed
  up -d` THE system SHALL start `wavekit-sdrpp` and `wavekit-core` as separate
  services on the same network, with `wavekit-core` configured to connect to
  `wavekit-sdrpp:5259`.
- **2.4** WHEN a developer runs `docker compose --profile demod-test run
  --rm demod-test` THE system SHALL start an interactive container built from
  target `final-demod` containing dsd-fme, multimon-ng, csdr, and rtl-sdr
  binaries with `/workspace`, `/data/debug_audio`, and `/output` mounted.
- **2.5** WHEN a service in any profile has a `build:` block THE block SHALL
  declare `cache_from` and `cache_to` pointing at the GHCR registry cache
  per Section 4.
- **2.6** The repository SHALL contain exactly one root-level compose file
  named `compose.yaml`. `docker-compose.dev.yml`,
  `docker-compose.prod.yml`, `docker-compose.override.yml`, and
  `docker-compose.demod-test.yml` SHALL be deleted.
- **2.7** The `compose.yaml` SHALL NOT define an `nginx-reverse-proxy` service.
  The `compose.yaml` SHALL NOT define a `vscode-server` (codercom/code-server)
  service.
- **2.8** The `packages/sdr-host/docker-compose.yml` SHALL remain in place
  unchanged; it deploys to a different host (the Pi running the SDR dongle)
  and is not part of the root compose.

### 3. Dockerfile structure — narrow stages, pinned refs, fixed anti-patterns

**As a** WaveKit contributor changing a single decoder's behaviour,
**I want** my change to invalidate only that decoder's cache layers,
**so that** I don't wait for 10 unrelated decoders to rebuild.

- **3.1** The Dockerfile SHALL define a thin `base-build` stage containing
  exactly: `build-essential`, `cmake`, `git`, `pkg-config`, `ca-certificates`,
  `curl`. No decoder-specific or signal-processing-specific apt packages.
- **3.2** Each of the 11 decoder/binary build stages (`sdrpp-build`,
  `dsd-fme-build`, `multimon-ng-build`, `rtl433-build`, `acarsdec-build`,
  `ais-catcher-build`, `direwolf-build`, `dumpvdl2-build`, `readsb-build`,
  `soapy-rtltcp-build`, `csdr-build`, `lora-build`) SHALL install ONLY its own
  minimal apt dependencies in its own `RUN apt-get install` invocation,
  protected by `--mount=type=cache,target=/var/cache/apt,sharing=locked`.
- **3.3** Every decoder build stage SHALL pin its upstream source to a SHA or
  tag via a top-of-file `ARG <DECODER>_REF=<sha-or-tag>` declaration, and SHALL
  check out that ref via `git fetch --depth 1 origin "${REF}" && git checkout
  --detach FETCH_HEAD`. The existing `GR_LORA_SDR_REF` pattern is the model.
- **3.4** Every stage that performs platform-specific actions SHALL declare
  `ARG TARGETARCH` and gate platform-specific steps on its value (mapping
  `amd64`→`x86_64`, `arm64`→`aarch64`). The `packages/sdr-host/Dockerfile`
  pattern (lines 87–96) is the model.
- **3.5** The `runtime-base` stage SHALL select the s6-overlay archive via
  `TARGETARCH`, NOT `BUILDPLATFORM`. Multi-arch builds of the arm64 variant
  SHALL produce an image with the aarch64 s6 binaries.
- **3.6** The `node-build` stage SHALL invoke `pnpm install
  --frozen-lockfile --prod=false` exactly once. The stage SHALL NOT call
  `pnpm config set node-linker hoisted`. The project's `.npmrc`
  `node-linker=isolated` setting SHALL be the single source of truth for
  package layout.
- **3.7** The Dockerfile SHALL define a `final-base` stage that contains the
  runtime base + all decoders + node + the application + every artifact and
  s6 service definition shared by `final` and `final-core`.
- **3.8** The Dockerfile SHALL define `final` as `FROM final-base` plus SDR++
  binaries from `sdrpp-build` plus the `sdrpp-server` s6 service overlay from
  `docker/overlay/s6-overlay-sdrpp/`.
- **3.9** The Dockerfile SHALL define `final-core` as `FROM final-base` with
  NO additional contents.
- **3.10** No stage in the Dockerfile SHALL contain a `rm -rf` or `rm -f`
  targeting any path under `/etc/s6-overlay/`. The mode partition SHALL be
  achieved by additive COPY only.
- **3.11** WHEN building target `final-core` the resulting image SHALL contain
  `/etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/` referencing ONLY
  `wavekit-init`, AND SHALL NOT contain any path matching
  `/etc/s6-overlay/s6-rc.d/sdrpp-server*`, AND SHALL NOT contain
  `/etc/s6-overlay/s6-rc.d/services/contents.d/sdrpp-server`, AND SHALL NOT
  contain `/etc/s6-overlay/s6-rc.d/user/contents.d/sdrpp-server`.
- **3.12** The Dockerfile SHALL define a `final-demod` stage that COPIES
  dsd-fme, multimon-ng, csdr, and rtl-sdr binaries plus their `libmbe*`,
  `libcsdr*`, and `librtlsdr*` runtime libraries from the existing `*-build`
  stages, declares `WORKDIR /workspace`, and uses `CMD ["/bin/bash"]`.
- **3.13** The hardcoded path `/usr/lib/x86_64-linux-gnu/libncurses*` in
  `final-core` SHALL be removed or replaced with a `TARGETARCH`-conditional
  path. If verification during implementation shows the copy is unnecessary
  (ncurses is satisfied by the `libncurses6` runtime apt install), the COPY
  SHALL be deleted entirely.
- **3.14** The `final` and `final-core` stages SHALL share their python
  runtime install (`python3`, `gnuradio`, `python3-numpy`,
  `python3-protobuf`, `python3-cryptography`) via `final-base` so it appears
  in one place, not two.
- **3.15** The `lora_meshtastic_decode.py` script and `meshtastic_proto/`
  package SHALL be copied once in `final-base`, not separately in `final` and
  `final-core`.

### 4. GHCR-backed BuildKit registry cache

**As a** WaveKit contributor who has just cloned the repo,
**I want** my first local Docker build to pull cache from GHCR,
**so that** my cold build behaves like a warm one without waiting for upstream
decoders to compile.

- **4.1** Every stage that builds upstream decoders or compiles the node app
  SHALL be cached at `ghcr.io/coriou/wavekit:cache-<stage-name>` (one ref per
  stage), populated by `--cache-to=type=registry,ref=<ref>,mode=max` on main
  branch CI pushes.
- **4.2** WHEN a contributor runs `make docker-build` after
  `docker login ghcr.io` THE build SHALL pass `--cache-from=type=registry,
  ref=<ref>` for each cached stage; cache misses SHALL fall back to local
  layer cache and then to a clean build without erroring.
- **4.3** WHEN a contributor runs `make docker-build` WITHOUT having logged in
  to GHCR THE build SHALL still succeed; `--cache-from` against an
  unauthenticated registry returns "no cache" rather than an auth error.
- **4.4** The cache ref naming SHALL match `cache-<stage-name>` with one
  hyphenated lowercase identifier per stage, listed canonically in `design.md`.
- **4.5** The local-directory cache (`./.docker-cache` referenced by
  `cache_from`/`cache_to` in the old dev/prod compose files and created by
  `docker/init.sh`) SHALL be removed from `docker/init.sh`, removed from
  `compose.yaml`, and the `.docker-cache` line in `.dockerignore` SHALL be
  retained only as a defensive ignore for any locally-leftover directory.

### 5. Buildx-first build pipeline

**As a** WaveKit maintainer pushing a release,
**I want** every image build to go through buildx with multi-arch and
provenance support,
**so that** my multi-arch tags and registry cache work uniformly across local,
CI, and release contexts.

- **5.1** No script under `docker/` SHALL invoke `docker build`. Every image
  build SHALL invoke `docker buildx build` or `docker buildx bake`.
- **5.2** The Makefile target `docker-build` SHALL invoke `docker buildx bake`
  against `docker/bake.hcl`.
- **5.3** `docker/bake.hcl` SHALL define one target per final image
  (`final`, `final-core`, `final-sdrpp`, `final-demod`), one group `default`
  bundling `final`/`final-core`/`final-sdrpp`, and shared cache configuration
  via HCL variables.
- **5.4** Multi-arch SHALL target `linux/amd64` and `linux/arm64` exclusively.
  `linux/arm/v7` SHALL NOT appear in any build invocation, bake target,
  `docker/push.sh`, `docker/platform-utils.sh`, or compose file.
- **5.5** The `docker/push.sh` script's docker.io path SHALL be removed.
  GHCR (`ghcr.io/<owner>/wavekit`) SHALL be the only registry the script
  pushes to. The owner SHALL be derivable from `WAVEKIT_GH_OWNER` env var
  with a `coriou` fallback, matching the `packages/sdr-host/scripts/
  build-publish.sh` pattern.
- **5.6** The `docker/platform-utils.sh` `build_multiarch` function SHALL be
  deleted (replaced by bake) OR consolidated into `docker/build.sh`/`push.sh`
  such that no defined-but-unused helper remains.

### 6. Minimal Makefile

**As a** WaveKit contributor scanning the Makefile,
**I want** under 20 targets organised by lifecycle (dev, build, push, ops),
**so that** I can find the command I need in seconds.

- **6.1** The Makefile SHALL define these targets and ONLY these targets in
  addition to `help`, `fixtures-*`, and the existing `sdr-host-*` group:
  `dev`, `dev-stack`, `dev-stack-down`, `dev-stack-logs`, `dev-dashboard`,
  `dev-dashboard-build`, `dev-configs`, `dev-shell`, `dev-status`,
  `docker-build`, `docker-push`, `docker-init`, `docker-clean`,
  `docker-prune`, `demod-test`.
- **6.2** The Makefile SHALL NOT define `docker-dev`, `docker-prod`,
  `docker-compose-up`, `docker-compose-down`, `docker-compose-logs`,
  `docker-build-full`, `docker-build-core`, `docker-build-sdrpp`,
  `docker-run-core`, `docker-test`, `docker-test-coverage`, `docker-lint`,
  `demo`, `install-buildx`, `dev-up`, `dev-build`, `dev-start`, `dev-stop`,
  `dev-restart`, `dev-logs`, `dev-logs-raw`, `dev-audio`, `dev-debug-audio`.
- **6.3** Newly-introduced Makefile output SHALL NOT contain emoji and SHALL
  NOT use ANSI colour escapes for decorative purposes (status prefixes like
  `[wavekit]` are fine). Existing emoji and colour in retained targets MAY
  remain to avoid drive-by churn.

### 7. CI exercises Docker builds

**As a** WaveKit maintainer reviewing a PR,
**I want** CI to fail if the Dockerfile is broken,
**so that** Docker regressions are caught before merge.

- **7.1** `.github/workflows/ci.yml` SHALL define a `lint-typecheck-test` job
  running `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm test` on
  ubuntu-latest with Node 22 (via `actions/setup-node@v4`) and pnpm
  installed via Corepack from the `packageManager` field in `package.json`.
- **7.2** `.github/workflows/ci.yml` SHALL define a `docker-build` job that
  depends on `lint-typecheck-test`, sets up QEMU and buildx
  (docker-container driver), and runs `docker buildx bake` against target
  `final-core` for platforms `linux/amd64,linux/arm64`.
- **7.3** WHEN the workflow runs on `pull_request` THE `docker-build` job
  SHALL use `--cache-from=type=registry,ref=ghcr.io/coriou/wavekit:cache-*`
  WITHOUT logging into GHCR, WITHOUT pushing the image, and WITHOUT
  updating any cache ref.
- **7.4** WHEN the workflow runs on `push` to `main` THE `docker-build` job
  SHALL log in to GHCR using `${{ secrets.GITHUB_TOKEN }}`, build the
  `default` bake group (`final`, `final-core`, `final-sdrpp`), push each
  image to `ghcr.io/coriou/wavekit:latest{,-core,-sdrpp}`, and update each
  stage's `cache-<stage>` ref with `mode=max`.
- **7.5** The Node version used in CI SHALL be `22` (matching the
  `node-build` stage in the Dockerfile). The legacy `node-version: "20"`
  SHALL be removed.

### 8. Documentation consolidation

**As a** WaveKit contributor reading docs,
**I want** one canonical Docker reference,
**so that** I don't have to reconcile two sources.

- **8.1** `docs/DOCKER-SETUP.md` SHALL be the canonical Docker reference.
  Its content SHALL be updated to reflect the new compose profiles, the new
  Makefile targets, the native `pnpm dev` flow, and the GHCR cache.
- **8.2** `docker/README.md` SHALL be either deleted OR reduced to a one-line
  pointer at `docs/DOCKER-SETUP.md` (no separately-maintained content).
- **8.3** `CLAUDE.md`'s "Day-to-day dev (Docker)" section SHALL be condensed
  to one paragraph: `pnpm dev` for typescript-only iteration; `make
  dev-stack` for full-stack integration; link to `docs/DOCKER-SETUP.md` for
  details.

### 9. sdr-host package alignment

**As a** WaveKit maintainer keeping the two Dockerfiles in sync,
**I want** the sdr-host package to use the same pnpm-via-Corepack pattern as
the main image,
**so that** a single decision propagates everywhere.

- **9.1** `packages/sdr-host/Dockerfile` line 47 (`RUN npm install -g
  pnpm@10`) SHALL be replaced with the Corepack pattern used in the main
  Dockerfile: `RUN corepack enable && corepack prepare pnpm@10.28.0
  --activate`.
- **9.2** The pnpm version pinned in `packages/sdr-host/Dockerfile` SHALL
  match the `packageManager` field in `package.json` exactly.

### 10. Image-size trim (modest, opportunistic)

**As a** WaveKit user pulling images on a Raspberry Pi,
**I want** the runtime image trimmed of unused packages and duplicated
layers,
**so that** the image is 10–20% smaller without architectural changes.

- **10.1** apt installs in every stage SHALL conclude with `rm -rf
  /var/lib/apt/lists/*` (already the case; this is restated as a contract).
- **10.2** The duplicate `libsox-fmt-all` line in `runtime-base` (current
  Dockerfile lines 137–138) SHALL be deduplicated.
- **10.3** The `python3-cryptography` apt package in the python install
  SHALL be verified against the actual import surface of
  `lora_meshtastic_decode.py`. If unused, it SHALL be removed.
- **10.4** Any `tini` apt install SHALL be removed if `tini` is unused at
  runtime (s6-overlay's `/init` is PID 1). If `tini` is referenced anywhere
  under `docker/scripts/` or `docker/overlay/`, it stays.
- **10.5** Out-of-scope for size reduction: switching to alpine, switching
  to distroless, splitting decoders into sidecars, removing any decoder.

### 11. `.dockerignore` hygiene

**As a** WaveKit contributor running `docker buildx bake`,
**I want** the build context to exclude everything that doesn't ship in the
image,
**so that** context transfer is fast and cache invalidation is precise.

- **11.1** `.dockerignore` SHALL exclude `.turbo/`, `.pnpm-store/`, and
  `.docker-cache/` (already present; restated as contract).
- **11.2** `.dockerignore` SHALL exclude `dist/` (already present; restated
  as contract). The Dockerfile builds its own dist.
- **11.3** `.dockerignore` SHALL exclude `.kiro/`, `wip/`, `tests/`, and
  fixture artifacts (already present; restated).
- **11.4** `.dockerignore` SHALL be verified to NOT exclude `docker/`,
  `config/`, `tsconfig.json`, `pnpm-lock.yaml`, or any other path the
  Dockerfile needs at build time.

## Out-of-Scope

The following are explicitly NOT in this spec. Any of these surfacing in a
PR raised against this spec is grounds for rejection.

- Switching the runtime or build base from `debian:bookworm-slim` to alpine,
  distroless, ubi-micro, or any other base.
- Splitting any decoder into its own sidecar container or process.
- Rewriting any decoder integration in `src/decoders/`.
- Removing any of the 9 user-facing decoders (dsd-fme, multimon-ng, rtl_433,
  acarsdec, AIS-catcher, direwolf, dumpvdl2, readsb, lora-meshtastic) or
  the 2 supporting tools (soapy-rtltcp, csdr).
- Replacing s6-overlay with tini-only, runit, supervisord, or any other init
  system.
- Restructuring the root-as-`wavekit`-package monorepo layout.
- Replacing pnpm, Turborepo, Fastify, Pino, Zod, or YAML as listed in
  `CLAUDE.md`.
- Adding Redis, a message queue, a database, or any new persistent service.
- Building for `linux/arm/v7` or any platform beyond `linux/amd64` and
  `linux/arm64`.
- Wrapping `docker compose` in a `wavekit` CLI tool.
- Rewriting the cli (`cli/` package) or its build pipeline.
- Touching `tsconfig.json` composite/declaration settings beyond noting the
  existing drift between root and base configs. tsconfig alignment is
  out-of-scope unless it blocks a specific Dockerfile change.

## Glossary

- **Stage**: a `FROM ... AS <name>` block in a Dockerfile.
- **Profile**: a Compose v2 `profiles:` selector on a service.
- **Target**: the `--target` flag value passed to `docker buildx build`.
- **Cache ref**: a registry image reference used solely to store BuildKit
  cache, e.g. `ghcr.io/coriou/wavekit:cache-readsb-build`.
- **Bake group**: a named bundle of bake targets built together.
