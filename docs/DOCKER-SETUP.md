# Docker Setup

Canonical reference for WaveKit's containerized build and runtime workflow.
For native (non-Docker) iteration see the "Native dev loop" section below
and `AGENTS.md`.

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

One file: `compose.yaml` at the repo root. Five profiles, mutually
exclusive. `protected` is the opt-in TLS reference deployment.

| Profile             | Services                                  | Purpose                                           |
| ------------------- | ----------------------------------------- | ------------------------------------------------- |
| `dev`               | `sdrpp-server` + `wavekit-api`            | Local full-stack integration testing              |
| `prod-single-host`  | `wavekit-full`                            | Single-container production (e.g. Raspberry Pi)   |
| `prod-distributed`  | `wavekit-sdrpp-prod` + `wavekit-core-prod`| Two-host production: dedicated SDR host + core    |
| `demod-test`        | `demod-test`                              | Interactive shell with decoder + audio tooling    |
| `protected`         | `wavekit-protected` + `wavekit-protected-caddy` | Opt-in protected mode behind Caddy TLS ([reference](#protected-reference-profile)) |

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
| `WAVEKIT_REGION`                 | guessed | Band plan region (EU, US, CA, AU, NZ, JP, CN) |
| `WAVEKIT_STATE_DIR`              | data    | Runtime state directory (`/app/data` in compose) |
| `WAVEKIT_ACTIVITY__ENABLED`      | false   | Persistent activity store (Node 24 and SQLite FTS5) |

YAML config under `config/` is the canonical source of truth; env vars
override per-key via the `WAVEKIT_` prefix with `__` as nested separator
(see `AGENTS.md` "Architecture essentials").

### State volume

`config/` is mounted read-only. Runtime state that core writes itself (API
band overrides from `PUT /api/decoders/:id/band`, file
`decoder-band-overrides.json`) lives in `WAVEKIT_STATE_DIR`; the `app` and
`dev` profiles mount `./data:/app/data` and set `WAVEKIT_STATE_DIR=/app/data`
so overrides survive a container restart (`data/` is git-ignored). If the
directory is missing or not writable (read-only mount, permissions), core keeps
running: overrides apply in memory only, a warning is logged and
`GET /api/decoders/:id/band` reports `persisted: false`. When
`activity.enabled` is true, the same directory holds `activity/activity.db`.
Activity stays off unless that flag is set. Opening the store needs Node 24
with SQLite FTS5; a failed open leaves the API up and the activity routes
answer 503. This batch does not re-verify the image's Node base for that
builtin. Inside a container without `TZ` or a locale, the region guess falls
back to `EU`; set `WAVEKIT_REGION` (or `region:` in YAML) elsewhere.

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

## Protected runtime deployment

Protected runtime mounting is opt-in; [the API reference](API.md#protected-runtime-opt-in)
shows the exact public configuration. The runtime opens HTTP API/analog/digital
listeners only on explicitly configured loopback addresses. It provides no TLS
listener. `exposure: tls-termination` asserts that a trusted TLS terminator shares
the backend network namespace; the terminator must preserve the configured public
Host authority. Forwarded headers do not select trusted scheme or listener role.
Do not widen backend bindings to make a separate proxy container reach them.
External browser/API/audio origins must share one hostname and HTTPS scheme,
with distinct origins for the three listeners.

Private state uses `WAVEKIT_ACCESS_PRIVATE_DIRECTORY`, an absolute path in a private
volume, separately from public YAML. Provision before starting the core. Runtime
loads existing state and requires its single-host/PID-namespace writer ownership
contract; deployment must ensure no unrelated namespace or process can write that
volume. A missing, corrupt or busy authority fails before listeners open. Protect
the directory and credential files with the existing provisioning permissions;
never put credentials or private paths in browser bootstrap/config payloads.

The credential-free shell probe supports the same explicit nested overrides as
runtime configuration:

```text
WAVEKIT_ACCESS__MODE=protected
WAVEKIT_ACCESS__HEALTH_PROBE__TARGET=http://127.0.0.1:9000
WAVEKIT_ACCESS__HEALTH_PROBE__HOST=receiver.example:9443
```

The target is the actual loopback HTTP backend origin (IPv4 or bracketed IPv6),
with no path, query, userinfo or fragment. For backend port 80, use the bare
canonical origin
(`http://127.0.0.1` or `http://[::1]`); runtime rejects an explicit `:80`.
The script appends `/health`, and sends the configured Host header. Runtime validates this Host in its API authority list
alongside the public API authority. Supply these overrides explicitly to the
probe environment even when the rest of the protected configuration comes from
YAML; the shell probe does not read YAML. Missing protected probe overrides and
malformed targets fail without calling curl. Legacy probe arguments remain
unchanged. Each deployment/compose healthcheck must be checked against its actual
backend binding and approved Host rather than assuming a localhost default.

Protected mode disables raw audio TCP and RTL-TCP relay startup. This does not
establish container/network exposure acceptance: inspect published ports, proxy
Host preservation, direct backend reachability and private-volume writer scope
in the real deployment. The opt-in reference profile below publishes three TLS
ports and leaves the raw audio and relay ports unpublished. Its checklist is a
static audit; a running stack is still required before exposure is accepted.

Shutdown seals admissions, closes owned streams, waits for actual startup and
accepted persistence/transport cleanup, then releases private access ownership.
An incomplete protected shutdown retains ownership until process termination;
a referenced ten-second watchdog exits with failure. A timeout is not proof that
filesystem I/O completed. Remembered browser sessions survive successful restart.

Local process and transport tests do not certify TLS, cookie behavior in real
browsers, container isolation, receiver RF operation or CLI/web coexistence.
Trusted shell delivery of the internal bootstrap, credentialed analog/digital
playback, revocation/recovery and the connected spectrum → tune → identify →
inspect → listen milestone require external acceptance before protected mode is
advertised as client-ready.

### Protected reference profile

Opt-in Compose profile `protected`. It is separate from the dev and prod
profiles above: `docker compose --profile protected` starts only this pair.
Static files are [compose.yaml](../compose.yaml) (`wavekit-protected` and
`wavekit-protected-caddy`), [docker/caddy/Caddyfile](../docker/caddy/Caddyfile),
[docker/caddy/export-trust.sh](../docker/caddy/export-trust.sh) and
[docker/caddy/protected-runtime.yaml](../docker/caddy/protected-runtime.yaml).

```bash
docker compose -f compose.yaml --profile protected config
```

That command parses the profile. It does not build, pull or start containers.

`WAVEKIT_PUBLIC_HOST` is one DNS hostname, with no scheme and no port. The
default is `receiver.example`. Compose substitutes it into the access
environment, the Caddyfile and the container hosts entry. The runtime file
holds the same public mapping as the
[API opt-in example](API.md#protected-runtime-opt-in), with
`listenerScheme: https` and `exposure: tls-termination`. Its host arrays are
the slots those environment overrides update; leave the arrays in place when
you change the hostname.

| Public origin | Published TLS | Loopback upstream |
| --- | --- | --- |
| API and WebSocket `https://<host>:9443` | `9443` | `127.0.0.1:9000` |
| Analog audio `https://<host>:9444` | `9444` | `127.0.0.1:8081` |
| Digital audio `https://<host>:9445` | `9445` | `127.0.0.1:8082` |

Caddy uses `network_mode: service:wavekit-protected`, so the three TLS ports
are published on `wavekit-protected`. Caddy binds `0.0.0.0` in that namespace,
terminates TLS with its local CA (`tls internal`) and proxies each site to the
loopback upstream. Each site sets `Host` from the incoming host and port
(`{http.request.hostport}`). WebSocket upgrades pass through `reverse_proxy`.
The core image is the existing `final-core` build (`WAVEKIT_APP_IMAGE`,
default `wavekit:local-core`). The sidecar image is `caddy:2`.

Behind this proxy, per-address limits collapse to one shared loopback bucket.
Caddy dials `127.0.0.1` in the shared network namespace, and the core ignores
forwarded headers, so every LAN client shares that bucket.
A trusted-proxy address source is a task 14 question. This profile does not
add one.

The core healthcheck runs the image copy of `docker/scripts/healthcheck.sh`
(`/etc/s6-overlay/scripts/healthcheck.sh`) with the probe environment from
this section. For the default host that is:

```text
WAVEKIT_ACCESS__MODE=protected
WAVEKIT_ACCESS__HEALTH_PROBE__TARGET=http://127.0.0.1:9000
WAVEKIT_ACCESS__HEALTH_PROBE__HOST=receiver.example:9443
```

`WAVEKIT_ACCESS__HEALTH_PROBE__HOST` follows `WAVEKIT_PUBLIC_HOST` and port
`9443`. The probe target stays the loopback API origin.

The reference configures no receiver and no decoders. The API binds
`127.0.0.1:9000` at startup. Analog HTTP binds `127.0.0.1:8081` when live
demod is enabled and a source is configured. Digital HTTP binds
`127.0.0.1:8082` when a dsd-fme decoder streams voice. The TLS sites are
published either way. Protected mode does not start raw audio TCP (configured
port `8080`) or the RTL-TCP relay, and neither port is published.

Private access state is the named volume `wavekit-protected-access`, mounted
only on `wavekit-protected` at `/var/lib/wavekit/access`
(`WAVEKIT_ACCESS_PRIVATE_DIRECTORY`). Caddy does not mount it. The Caddy data
volume `wavekit-protected-caddy` is mounted only on the sidecar, writable, at
`/data`. Treat that volume as CA key material: Caddy's local CA keeps
`root.key` and `intermediate.key` there beside `root.crt`. The core does not
mount it, and no private key is placed on a core-visible path.

The sidecar entrypoint `docker/caddy/export-trust.sh` runs Caddy and copies
only `root.crt` into the named volume `wavekit-protected-trust` (sidecar path
`/trust/root.crt`). The core mounts that volume read-only at `/caddy-trust`.
Runtime state (`WAVEKIT_STATE_DIR`) uses `wavekit-protected-state`, mounted at
`/app/data`.

Provision the private volume while the core is stopped, before the first
start. The one-off replaces the image entrypoint so s6 does not start, and
`--no-deps` leaves Caddy stopped. `chmod 700` matches the provisioning
permission check on a fresh volume mount:

```bash
docker compose -f compose.yaml --profile protected run --rm --no-deps \
  --entrypoint sh wavekit-protected -c \
  'chmod 700 /var/lib/wavekit/access && exec node /app/dist/access-command.js setup --private-directory /var/lib/wavekit/access --ownership single-host-pid-namespace --api-origin "https://${WAVEKIT_PUBLIC_HOST}:9443" --allow-origin "https://${WAVEKIT_PUBLIC_HOST}:9443" --external-audio-origin "https://${WAVEKIT_PUBLIC_HOST}:9444" --external-audio-origin "https://${WAVEKIT_PUBLIC_HOST}:9445"'
```

Setup prints a public access plan. It does not print the machine credential.
Run setup again only while the core is stopped.

Starting the profile, installing the CA and pairing in a browser are
deployment acceptance (task 14). The operator commands are:

```bash
docker compose -f compose.yaml --profile protected up -d
```

Recreate the core and the sidecar together after replacing the core
container, so Caddy stays attached to the core network namespace.

After the sidecar has created the local CA, read the public root from the
trust volume. That file is the certificate only:

```bash
docker compose -f compose.yaml --profile protected exec wavekit-protected \
  cat /caddy-trust/root.crt > wavekit-caddy-root.crt
```

Install that file as a trusted root on each LAN client. macOS system
keychain:

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain wavekit-caddy-root.crt
```

Debian and Ubuntu: copy it to
`/usr/local/share/ca-certificates/wavekit-caddy-root.crt` and run
`sudo update-ca-certificates`. Windows: import it into Trusted Root
Certification Authorities. Firefox uses its own store and needs a separate
import. Point client DNS, or the client hosts file, at the Docker host for
`WAVEKIT_PUBLIC_HOST`. The container hosts entry maps that name to
`127.0.0.1` so in-container pairing reaches Caddy. LAN clients use the Docker
host's address, not the container loopback.

The browser shell's canonical API origin is `https://<host>:9443`. It takes
WebSocket and audio origins from `GET /api/access/bootstrap` on that origin.

Issue a pairing code while the core is running and `/caddy-trust/root.crt`
exists. If it is missing, check `docker compose logs wavekit-protected-caddy`;
the sidecar logs when it publishes the file or cannot write it. The code is
one-time, for the browser shell, and is not a reusable API credential. The
machine credential stays in the private volume; these commands pass it to the
API and do not print it:

```bash
docker compose -f compose.yaml --profile protected exec \
  -e NODE_EXTRA_CA_CERTS=/caddy-trust/root.crt \
  wavekit-protected \
  sh -c 'exec node /app/dist/access-command.js pair --private-directory /var/lib/wavekit/access --api-origin "https://${WAVEKIT_PUBLIC_HOST}:9443"'
```

The same exec and CA file list, revoke, or revoke every remembered browser.
`revoke-all` requires `--yes`:

```bash
docker compose -f compose.yaml --profile protected exec \
  -e NODE_EXTRA_CA_CERTS=/caddy-trust/root.crt \
  wavekit-protected \
  sh -c 'exec node /app/dist/access-command.js devices list --private-directory /var/lib/wavekit/access --api-origin "https://${WAVEKIT_PUBLIC_HOST}:9443"'

docker compose -f compose.yaml --profile protected exec \
  -e NODE_EXTRA_CA_CERTS=/caddy-trust/root.crt \
  wavekit-protected \
  sh -c 'exec node /app/dist/access-command.js devices revoke DEVICE_ID --private-directory /var/lib/wavekit/access --api-origin "https://${WAVEKIT_PUBLIC_HOST}:9443"'

docker compose -f compose.yaml --profile protected exec \
  -e NODE_EXTRA_CA_CERTS=/caddy-trust/root.crt \
  wavekit-protected \
  sh -c 'exec node /app/dist/access-command.js devices revoke-all --yes --private-directory /var/lib/wavekit/access --api-origin "https://${WAVEKIT_PUBLIC_HOST}:9443"'
```

Rotate the machine credential while the core is stopped, with the same
one-off shape as setup. By default, rotation removes remembered browser
sessions and the command says they were removed. `--keep-sessions` keeps
them; the command then says they were kept and to review `devices list`
after the core is started again. Restart the core before using the new
credential.

```bash
docker compose -f compose.yaml --profile protected run --rm --no-deps \
  --entrypoint sh wavekit-protected -c \
  'exec node /app/dist/access-command.js rotate-credential --private-directory /var/lib/wavekit/access'

docker compose -f compose.yaml --profile protected run --rm --no-deps \
  --entrypoint sh wavekit-protected -c \
  'exec node /app/dist/access-command.js rotate-credential --private-directory /var/lib/wavekit/access --keep-sessions'
```

Exposure audit checklist for this profile. The static items are visible in
`docker compose -f compose.yaml --profile protected config` and the files
linked above. Live reachability stays with deployment acceptance.

1. Published ports on `wavekit-protected` are `9443`, `9444` and `9445`.
   Container ports `8080` (raw audio TCP), `9000`, `8081`, `8082`, relay
   `1234` and `4713`, and SDR++ `5259` are not published. The sidecar
   publishes no ports of its own.
2. Direct backend. `WAVEKIT_API__HOST` and both audio `bindHost` values are
   `127.0.0.1`. The backend ports are unpublished, so the Docker host cannot
   open them. The loopback bind keeps other compose services from opening
   them too. Caddy dials them on loopback inside the shared network namespace.
3. Host preservation. Each Caddy site contains
   `header_up Host {http.request.hostport}` and `tls internal`. The Caddyfile
   has no `trusted_proxies` entry. Forwarded headers do not select the scheme
   or the listener role. Per-address limits are one shared loopback bucket,
   because every client is seen as `127.0.0.1`.
   A trusted-proxy address source is a task 14 question. This profile does
   not add one.
4. Private-volume writers. `wavekit-protected-access` is mounted only by
   `wavekit-protected`, at the absolute `WAVEKIT_ACCESS_PRIVATE_DIRECTORY`.
   The sidecar does not mount it. Setup is a one-off of that same service
   while the core is stopped. Keep the volume off host bind mounts and off
   any other service.
5. CA key material. `wavekit-protected-caddy` is mounted only by the sidecar
   at `/data`. The core mounts `wavekit-protected-trust` read-only at
   `/caddy-trust`, which receives `root.crt` and no private key.
