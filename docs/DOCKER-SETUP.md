# Docker Setup

Canonical reference for WaveKit's containerized build and runtime workflow.
For native (non-Docker) iteration see the "Native dev loop" section below
and `CLAUDE.md`.

## TL;DR

- `pnpm dev` — headline iteration loop. Native esbuild watch + node --watch
  against `src/index.ts`. No Docker required.
- `make dev-stack` — full container stack (sdrpp-server + wavekit-api on the
  `dev` profile). Use when verifying decoder pipelines end-to-end.
- `make docker-build` — produce the three default images via `docker buildx
  bake --file docker/bake.hcl default`.

Everything else in this document is reference. 95% of work needs only the
three commands above.

## Native dev loop

`pnpm dev` runs `concurrently` against two parallel watchers:

- `dev:build` — esbuild rebuilds `dist/index.js` on every `src/**/*.ts`
  change (~150 ms).
- `dev:run` — `node --watch dist/index.js` restarts the process on every
  rebuild (~300 ms).

Total edit-to-restart latency on a current laptop is under 2 seconds. The
Docker daemon does not need to be running. This is the default iteration
loop for any change to TypeScript code, including decoder integration logic
under `src/decoders/`.

Prerequisite: an SDR source reachable from the host. Configure via
`config/<active>.yaml` (`default.yaml`, `dev_test.yaml`, etc.) or via
`WAVEKIT_SOURCES_*` env vars. `pnpm dev` does NOT start an SDR source — it
expects rtl_tcp or SDR++ to already be listening, locally or remotely.

## Container integration via compose profiles

One file: `compose.yaml` at the repo root. Four profiles, mutually
exclusive.

| Profile             | Services                                  | Purpose                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| `dev`               | `sdrpp-server` + `wavekit-api`            | Local full-stack integration testing              |
| `prod-single-host`  | `wavekit-full`                            | Single-container production (e.g. Raspberry Pi)   |
| `prod-distributed`  | `wavekit-sdrpp-prod` + `wavekit-core-prod`| Two-host production: dedicated SDR host + core    |
| `demod-test`        | `demod-test`                              | Interactive shell with decoder + audio tooling    |

### dev profile

The Makefile wraps the common lifecycle:

```bash
make dev-stack         # docker compose --profile dev up --build
make dev-stack-down    # docker compose --profile dev down
make dev-stack-logs    # docker compose --profile dev logs -f
make dev-shell         # docker compose --profile dev exec wavekit-api /bin/bash
make dev-status        # docker compose --profile dev ps + curl /health
```

The dev profile builds `wavekit:dev-sdrpp` (target `final-sdrpp`) and
`wavekit:dev-core` (target `final-core`) locally with `cache_from` pointing
at the GHCR registry cache (see below). Ports exposed on the host: `9000`
(API), `8080` (audio TCP), `8081` (live demod HTTP), `4713` (WebSocket
WAS-style), `5259` (SDR++ binary protocol).

### prod profiles

Both prod profiles pull pre-built images from GHCR rather than building
locally:

```bash
docker compose --profile prod-single-host up -d
docker compose --profile prod-distributed up -d
```

`prod-single-host` runs the `final` image with SDR++ + API in one container.
`prod-distributed` runs `final-sdrpp` and `final-core` as separate services
on the same compose network, with `wavekit-core-prod` connecting to
`tcp://wavekit-sdrpp-prod:5259`.

### demod-test profile

See "Demod test environment" below.

## Build pipeline

`make docker-build` invokes `docker buildx bake --file docker/bake.hcl
default`. The `default` group builds three images:

- `final` — full image. SDR++ + every decoder + API. Tag:
  `ghcr.io/coriou/wavekit:latest`.
- `final-core` — every decoder + API, no SDR++. Tag:
  `ghcr.io/coriou/wavekit:latest-core`.
- `final-sdrpp` — SDR++ server only. Tag:
  `ghcr.io/coriou/wavekit:latest-sdrpp`.

A fourth image, `final-demod`, lives in the separate `demod` bake group
and is opt-in via `docker buildx bake --file docker/bake.hcl demod`.

Multi-arch is the default. `bake.hcl`'s `_base` target sets `platforms =
["linux/amd64", "linux/arm64"]`. `linux/arm/v7` is NOT supported. Override
for a single-arch local build:

```bash
docker buildx bake --file docker/bake.hcl default --set "*.platform=linux/amd64"
```

`make docker-push` invokes `docker/push.sh`, which calls bake with
`--push` and `CACHE_FROM_ONLY=false` (so cache layers are written, not
just read). GHCR is the only push target. The owner defaults to `coriou`
and is overridable via `WAVEKIT_GH_OWNER`. Push requires `docker login
ghcr.io` first.

`make docker-init` bootstraps the buildx builder and the wavekit Docker
network/volume. Idempotent; run once after cloning.

## GHCR registry cache

Every Dockerfile stage has a corresponding cache ref under
`ghcr.io/coriou/wavekit:cache-<stage>`. The full list is in
`docker/bake.hcl` and `design.md §4.1`. Highlights:

- `cache-base-build`, `cache-runtime-base` — toolchain commons.
- `cache-<decoder>-build` — one ref per decoder (`readsb-build`,
  `dsd-fme-build`, `ais-catcher-build`, etc.).
- `cache-node-build`, `cache-final-base`, `cache-final`, `cache-final-core`,
  `cache-final-sdrpp`, `cache-final-demod`.

Cache behaviour:

- **Local `make docker-build`**: `cache-from` only. Hits pull from GHCR
  (anonymous reads work on public images — no `docker login` required).
  Misses fall through to local layer cache, then to a clean rebuild. No
  cache is written.
- **CI on PR**: same as local. PRs from forks (no `secrets.GITHUB_TOKEN`)
  still build correctly because `cache-from` against an unauthenticated
  registry returns "no cache" rather than an auth error.
- **CI on push to main**: `cache-from` + `cache-to,mode=max`. Every
  intermediate layer is written back to GHCR so the next cold build picks
  up full hits.

Cold-cache first builds without any GHCR data take 20-30 min. Warm builds
after the cache is populated take 2-5 min. A second consecutive
`make docker-build` with no source changes completes in under 30 seconds —
every step `CACHED`.

## Demod test environment

`make demod-test` launches an interactive shell in the `final-demod` image:

```bash
make demod-test
# == docker compose --profile demod-test run --rm demod-test
```

The image is built from target `final-demod` and contains: `dsd-fme`,
`multimon-ng`, `csdr`, `rtl_test`/`rtl_fm`/`rtl_sdr`/`rtl_tcp` (Debian
package), `sox`, `ffmpeg`, plus Python tooling (`numpy`, `scipy`,
`matplotlib`) for offline sample inspection. No s6, no API — this is
interactive utility tooling, not a supervised service.

Volume mounts:

- `./debug_audio` → `/data/debug_audio` — sample fixtures and recorded
  audio.
- `./scripts` → `/scripts` — host-side decoder test scripts.
- `./output` → `/output` — decoder output destination.

Working directory inside the container is `/workspace`.

## First-run log noise is expected

When the `final` image boots, `wavekit-api` may print one or two
`SourceConnectionError` lines before `sdrpp-server` binds its 5259 port.
This is intentional, not a regression.

The s6-overlay hard dependency `wavekit-api → sdrpp-server` was removed
in the Phase A/B refactor (see `design.md §5`). `SourceManager`'s
exponential backoff is now the single authoritative source-availability
mechanism, matching the contract already used for transient SDR
disconnects mid-run. Reconnect lines in the first ~10 seconds post-boot
are normal and should not trigger alerts.

If a log dashboard alerts on `SourceConnectionError`, raise the
threshold to ignore the first 10 seconds after `wavekit-api` start.

## Troubleshooting

### Port conflicts

The dev profile binds host ports 5259, 9000, 8080, 8081, 4713. If any is
in use (`lsof -nP -iTCP:9000 -sTCP:LISTEN`), free it or edit
`compose.yaml`'s port mapping.

### buildx builder missing

`docker buildx bake` requires a docker-container driver builder. The
first-time setup:

```bash
make docker-init
```

Symptom of skipping this: `ERROR: failed to solve: failed to read
dockerfile: ... unsupported feature: cache export`. Run `make docker-init`,
then retry.

### Compose silently ignores cache_from

Docker Desktop versions older than 4.30 (or `docker-compose` CLI older
than v2.27) silently ignore typed `cache_from: type=registry,ref=...`
entries in `compose.yaml`. The build still succeeds but cold builds are
slow because no registry cache is read. Upgrade Docker Desktop, or use
`docker buildx bake` directly (which honours the cache regardless of
compose version).

### Cold cache pulls are slow

If GHCR pulls dominate cold build wall time, opt out of cache-from with
the `CACHE_FROM_ONLY` variable:

```bash
docker buildx bake --file docker/bake.hcl default --set "*.cache-from="
```

This is a fallback, not a recommendation — the registry cache normally
saves more time than it costs.

### Pi-side sdr-host has a separate compose

`packages/sdr-host/docker-compose.yml` deploys to the Raspberry Pi hosting
the SDR dongle. It is NOT part of the root `compose.yaml` and uses its own
`Dockerfile` plus the `make sdr-host-*` Makefile targets. See `packages/
sdr-host/scripts/` for deployment helpers. Out of scope for this document.

## Service architecture

Brief; full deep-dive in `docs/ARCHITECTURE.md`. Inside every `final` /
`final-core` / `final-sdrpp` image, `/init` (s6-overlay) is PID 1 and
supervises:

- `wavekit-init` (oneshot) — system setup.
- `wavekit-api` (longrun) — the Node app. Depends on `wavekit-init`.
- `sdrpp-server` (longrun, `final` only) — SDR++ in server mode on 5259.
  Depends on `wavekit-init`.

The `final-core` image does NOT contain `sdrpp-server`. Verification:

```bash
docker run --rm wavekit:dev-core find /etc/s6-overlay -iname '*sdrpp*'
# expected: (empty)
docker run --rm wavekit:dev-core ls /etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/
# expected: wavekit-init
```

The `final` image contains exactly one `sdrpp-server`:

```bash
docker run --rm wavekit:dev find /etc/s6-overlay -name 'sdrpp-server' -type d
# expected: /etc/s6-overlay/s6-rc.d/sdrpp-server
```

## Environment variables

Common runtime env vars consumed by the wavekit-api container:

| Variable                         | Default | Purpose                                |
| -------------------------------- | ------- | -------------------------------------- |
| `WAVEKIT_LOG_LEVEL`              | info    | debug / info / warn / error            |
| `WAVEKIT_SOURCES_0_HOST`         | -       | First SDR source hostname              |
| `WAVEKIT_SOURCES_0_PORT`         | -       | First SDR source port                  |
| `WAVEKIT_TUNER_RELAY__ENABLED`   | false   | Expose RTL-TCP relay                   |
| `SDR_SOURCE`                     | -       | Convenience: `tcp://host:port` URL     |
| `NODE_ENV`                       | -       | `development` or `production`          |

YAML config under `config/` is the canonical source of truth; env vars
override per-key via the `WAVEKIT_` prefix with `__` as nested separator
(see `CLAUDE.md` "Config" section).

## Health checks

The `wavekit-api` HTTP health endpoint is `/health`. Compose healthchecks
probe it on the container-internal port; the host-mapped port is `9000`
in the dev profile.

```bash
curl http://localhost:9000/health
# {"status":"ok","timestamp":"..."}
```

`sdrpp-server` does not expose HTTP. Its healthcheck probes TCP 5259
directly via `bash -c '</dev/tcp/localhost/5259'`.
