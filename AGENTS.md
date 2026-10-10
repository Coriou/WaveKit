# AGENTS.md

The one instruction file for every coding agent and human contributor in this repository
(Codex, Claude Code, Grok, omp and others read it natively). Keep it short and true:
`tests/unit/repo/agent-instructions.test.ts` fails when a command, path or convention here
drifts from the code. Detail lives in the linked docs; read them only when your task needs them.

## Start of every task

1. **Private memory, if present.** `.agents/memory/MEMORY.md` links to the team's local
   shared memory (one fact per file; follow only the links you need). If `.agents/memory`
   is missing in this worktree, run `node scripts/agents-setup.mjs` once (idempotent; it
   finds the shared directory or tells you how to configure it). Treat memories as
   background that was true when written; verify names they mention. `.agents/` is
   git-ignored and this repository is public: never copy memory, handoff or lane-status
   content into tracked files, commits or PR text.
2. **Your brief.** An orchestrator usually dispatches you with a brief; its explicit
   constraints override defaults here.
3. **Task context.** For spec-driven work, read [`docs/specs/README.md`](docs/specs/README.md)
   and the feature's spec. For architecture, decoders or the API, see
   [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DECODER-GUIDE.md`](docs/DECODER-GUIDE.md),
   [`docs/API.md`](docs/API.md); Docker in [`docs/DOCKER-SETUP.md`](docs/DOCKER-SETUP.md).

## What this is

WaveKit is a TypeScript SDR stream-processing framework. One Node.js process pulls IQ/audio
from rtl_tcp or SDR++ sources, fans it out to decoder adapters (ADS-B, AIS, ACARS, VDL2,
DMR/P25/YSF, POCSAG/FLEX, APRS, ISM, Meshtastic LoRa), and serves Fastify REST, WebSocket,
a raw audio TCP port and an optional RTL-TCP relay. The Ink/React terminal dashboard in
`cli/` is the main UI; the core ships as a Docker image with s6-overlay supervising the
decoder binaries. A local USB dongle and a Raspberry Pi receiver are equally supported.

## Layout

pnpm workspaces + Turborepo. The root `package.json` is both the workspace root and the
`wavekit` app (entry `src/index.ts`, bundled by esbuild to `dist/index.js`).

- `src/`: core app. `src/core/` stream pipeline, tuner, channelizer, activity; `src/decoders/`
  adapters and lifecycle; `src/api/` routes and WebSocket; `src/access/` access policy;
  `src/config.ts` Zod config schemas.
- `cli/`: `@wavekit/cli` dashboard (tsc build, own vitest suite).
- `packages/shared` (logger, errors) and `packages/api-types` (shared DTOs): built with tsc.
- `packages/sdr-host`: Raspberry Pi dongle host (rtlmux fanout + status API), own Dockerfile.
- `packages/brand`: brand assets; read `packages/brand/AGENTS.md` before changing it.
- `native/wavekit-chan`: Rust channelizer crate (`make chan-build`, `make chan-test`).
- `config/`: YAML configs (`default.yaml` canonical). `docker/`: overlay, bake file, scripts.

A new `packages/*` manifest must also be copied in the root `Dockerfile` node-build stage.

## Commands

Node 20+ (`.nvmrc` pins the dev version), pnpm 10 (`packageManager`). `pnpm install` at root.

```bash
pnpm run build         # shared + api-types via tsc, then esbuild bundle of src/
pnpm run typecheck     # turbo typecheck of workspaces, then root tsc --noEmit
pnpm run lint          # eslint .
pnpm test              # turbo test of workspaces, then root vitest run
pnpm exec vitest run tests/unit/path/to/file.test.ts   # one file
pnpm exec vitest run -t "test name"                    # by name
pnpm run dev           # esbuild watch + node --watch dist/index.js (no Docker)
make dev-local         # run natively without a Pi, dongle, Docker or decoders
make dev-dashboard     # interactive CLI dashboard
make dev-stack         # docker compose dev profile (sdrpp-server + wavekit-api)
make docker-build      # buildx bake of the default image group
make fixtures-download # small test fixtures
```

Root vitest only collects `tests/**/*.test.ts`. Monorepo scripts use `--filter=!wavekit`
to skip the root package, then run the root step explicitly.

## Architecture essentials

`SourceManager` (TCP client, exponential backoff) feeds `FanoutManager` (multiplexing,
backpressure), which feeds decoder adapters managed by `DecoderManager` (lifecycle, health,
restart); REST, WebSocket and audio output sit on top. `LiveDemodulator`, the tuner and the
optional channelizer tap the same source stream.

Decoder adapters extend one of the bases in `src/decoders/` (`base-decoder.ts`,
`audio-demod-decoder.ts`, `iq-decimate-decoder.ts`, `network-producer-decoder.ts`,
`external-sdr-decoder.ts`); built-ins are registered in `src/index.ts`. Read the base you
extend for its required hooks before adding one.

Config: YAML validated by `ConfigSchema` in `src/config.ts` at startup. Env overrides use
the `WAVEKIT_` prefix with `__` for nesting (`WAVEKIT_TUNER_RELAY__ENABLED=true`) and
`_<index>_` for arrays (`WAVEKIT_SOURCES_0_HOST=...`). Shared API DTOs live in
`packages/api-types` so the CLI can import them.

## Code conventions

Enforced by tooling (tsc, eslint, prettier):

- Strict TS: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`.
- ESM only; relative imports include the `.js` extension.
- `import type` for type-only imports (`@typescript-eslint/consistent-type-imports`).
- No floating or misused promises (`@typescript-eslint/no-floating-promises`,
  `@typescript-eslint/no-misused-promises`); discard deliberately with `void` and handle rejection.
- Tabs, no semicolons, double quotes, `x => ...` for single-parameter arrows.

Policy (reviewed, not tool-enforced):

- No `any`.
- No `console.log` in production code; use component loggers:
  `const log = createComponentLogger(parentLogger, "Name")` from `src/utils/logger.js`.
- Throw the classes exported by `src/utils/errors.ts` (`WaveKitError`,
  `SourceConnectionError`, `DecoderSpawnError`, `ConfigValidationError`), not bare `Error`.
- Streams: attach `error` handlers, prefer `pipeline()` from `stream/promises`,
  `.destroy()` on shutdown.
- Validate external data with Zod at the boundary (config, API requests, parsed decoder output).

## Testing

- Vitest with globals. Mock child processes and network in unit tests; decoder output
  samples live in `tests/mocks/fixtures/`, IQ corpora in `fixtures/`.
- Property tests use `fast-check` with at least `numRuns: 100`. A property from a spec
  carries its trace comment:

  ```ts
  // Feature: <feature>, Property N: <name>
  // Validates: Requirements X.Y, X.Z
  ```

## Shared checkout and safety

Several agents work in this repository at once.

- Commit only your own paths: `git commit -m "..." -- <path>...`. Never `git add -A`,
  never a bare `git stash` (tag it), never commit unrelated changes. Do not push unless
  your brief says so.
- Prefer your own git worktree for multi-file work; never build Docker images from the
  shared checkout.
- Never run Prettier on `docs/CLI-COORDINATION.md` (append-only, hand-formatted).
- Do not deploy to, retune or reboot the Raspberry Pi receiver, and do not stop the
  running `wavekit-app` container, unless your brief says so.

## Before reporting done

Run the touched test files, `pnpm run typecheck` and `pnpm run lint` (the full suite when
runtime code changes broadly). Report exact base/head and commits, check results with any
failure output, and open gaps. Never claim a check you skipped.
