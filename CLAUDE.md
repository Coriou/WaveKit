# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

WaveKit is a TypeScript SDR (Software Defined Radio) stream-processing framework. A single Node.js process pulls IQ/audio from rtl_tcp/SDR++ sources, fans the stream out to 8 parallel decoder processes (ADS-B, AIS, ACARS, VDL2, DMR/P25, POCSAG, APRS, ISM), and exposes everything over Fastify REST + WebSocket + a raw audio TCP port + an optional RTL-TCP relay.

The primary user-facing UI is the Ink/React terminal dashboard in `cli/`; the core ships as a Docker image with s6-overlay supervising the decoder binaries.

## Monorepo layout

pnpm workspaces + Turborepo. The root `package.json` *is* the main app — it's both the workspace root and the `wavekit` package whose entry point is `src/index.ts`.

- `src/` — core app (root package). Built via esbuild to `dist/index.js`.
- `cli/` — `@wavekit/cli`, Ink/React terminal dashboard.
- `packages/shared` — `@wavekit/shared`, logger + errors. **Built with tsc** (not esbuild), produces `.d.ts`.
- `packages/api-types` — `@wavekit/api-types`, shared API DTOs. Built with tsc.
- `packages/sdr-host` — `@wavekit/sdr-host`, separate service that runs on the Raspberry Pi to host the dongle (rtlmux fanout + status API). Its own Dockerfile and deploy scripts under `packages/sdr-host/scripts/`.

Because `src/` is the root package, monorepo commands need `--filter=!wavekit` to skip the root and then run the root step explicitly. See the `build`, `typecheck`, `test` scripts in `package.json` for the pattern.

## Commands

### Setup
Node 20+ (`.nvmrc` pins v25.2.1) and pnpm 10 (`packageManager: pnpm@10.28.0`). Run `pnpm install` from the root.

### Day-to-day dev (Docker)
The headline iteration loop is `pnpm dev` (esbuild watch + `node --watch` in parallel against `src/index.ts`) — no Docker round-trip per edit. When you need the full container stack for end-to-end decoder testing, `make dev-stack` brings up the `dev` profile of the single root `compose.yaml` (sdrpp-server + wavekit-api, built via `docker buildx bake`). Counterpart lifecycle targets: `make dev-stack-down`, `make dev-stack-logs`, `make dev-shell`, `make dev-status`. Image production goes through `make docker-build` (bakes the `default` group: `final`, `final-core`, `final-sdrpp`). See `docs/DOCKER-SETUP.md` for the full reference — compose profiles, GHCR registry cache behaviour, the `demod-test` environment, and expected first-run log noise.

### Build / typecheck / lint / test

```bash
pnpm run build         # builds @wavekit/shared + @wavekit/api-types via tsc, then bundles src/ via esbuild
pnpm run typecheck     # turbo: typechecks workspaces, then `tsc --noEmit` on root
pnpm run lint          # eslint .
pnpm run format        # prettier --write .
pnpm test              # turbo test on workspaces, then `vitest run` on root
pnpm run test:watch    # vitest watch mode (root tests only)
pnpm run test:coverage # vitest run --coverage (v8 provider)

# Run a single vitest file or pattern:
pnpm exec vitest run tests/unit/path/to/file.test.ts
pnpm exec vitest run -t "matches test name"
```

Vitest only picks up `tests/**/*.test.ts` from the root (see `vitest.config.ts`); workspace packages run their own (currently empty) vitest configs via `--passWithNoTests`.

### Local hot reload (no Docker)
`pnpm run dev` runs esbuild watch + `node --watch dist/index.js` in parallel. Useful for iterating on non-decoder code paths, but you still need an SDR source reachable.

## Architecture essentials

Full deep-dive in `docs/ARCHITECTURE.md` and `docs/DECODER-GUIDE.md`. The pieces you need before touching `src/`:

**Stream pipeline** — `SourceManager` (TCP client to rtl_tcp/SDR++ with exponential backoff) → `FanoutManager` (multiplexes the byte stream to N consumers, tracks backpressure) → decoders (`src/decoders/`) → `DecoderManager` (lifecycle, health, restart) → REST/WebSocket/AudioOutput. `LiveDemodulator` and `TunerController`/`TunerRelay` tap the same source stream.

**Three decoder patterns** (`src/decoders/`):
1. **Pure consumer** (`base-decoder.ts`) — gets audio piped to stdin (dsd-fme, multimon-ng, rtl_433).
2. **Network producer** (`network-producer-decoder.ts`) — long-running service we connect to over the network (readsb, ais-catcher, direwolf).
3. **External SDR** (`external-sdr-decoder.ts`) — owns its own SDR connection (acarsdec, dumpvdl2).

Adding a decoder: subclass the right base, implement `getCommand()` / `getArgs()` / `parseOutput()`, register in `src/decoders/registry.ts`, extend the Zod schema in `src/config.ts`. Full walkthrough in `docs/DECODER-GUIDE.md`.

**Config** — YAML in `config/` (`default.yaml` is canonical, `dev_*.yaml` are dev presets) validated by Zod schemas in `src/config.ts` at startup. Env overrides use `WAVEKIT_` prefix with `__` for nested keys (e.g. `WAVEKIT_TUNER_RELAY__ENABLED=true`, `WAVEKIT_SOURCES_0_HOST=...` for array indices).

**API surface** — Fastify routes under `src/api/routes/`, WebSocket channels under `src/api/websocket/`. Shared DTOs live in `packages/api-types/` so the CLI can import them. Channels: `decoders`, `sources`, `metrics`, `health`, `fanout`, `live-audio`, `resources`, `tuner`. Full reference in `docs/API.md`.

## Code conventions (enforced)

- **Strict TS**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `isolatedModules`. No `any`.
- **ESM only** (`"type": "module"`). Relative imports must include `.js` extension (TS file resolves to compiled .js).
- **Type imports** must use `import type` — ESLint enforces `@typescript-eslint/consistent-type-imports`.
- **No floating promises** — ESLint errors on `@typescript-eslint/no-floating-promises` and `no-misused-promises`. Use `void` to explicitly discard.
- **Tabs**, **no semicolons**, single-arg arrow fns without parens (`x => ...`). Prettier + EditorConfig.
- **Never `console.log`** in production code. Use component loggers:
  ```ts
  import { createComponentLogger } from "./utils/logger.js"
  const log = createComponentLogger(parentLogger, "ComponentName")
  log.info({ host, port }, "Connected")
  ```
- **Errors**: throw the custom classes from `src/utils/errors.ts` (`WaveKitError`, `SourceConnectionError`, `DecoderSpawnError`, `ConfigValidationError`). Don't throw bare `Error` from feature code.
- **Streams**: always attach `error` handlers, use `pipeline()` from `stream/promises` for piping, `.destroy()` on shutdown.
- **External data**: validate with Zod at the boundary (config, API requests, decoder output you parse).

## Testing

- Vitest with `globals: true` (so `describe`/`it`/`expect` are global).
- Property-based tests with `fast-check` — minimum 100 iterations (`numRuns: 100`).
- When implementing a property test that maps to a design-doc property, include the reference comment:
  ```ts
  // Feature: <feature>, Property N: <name>
  // Validates: Requirements X.Y, X.Z
  ```
- Mock child processes and network for unit tests. Fixtures (sample decoder output, IQ recordings) live in `tests/mocks/fixtures/` and `fixtures/`. Run `make fixtures-download` to fetch the test IQ corpus.

## Spec-driven workflow (Kiro)

Features under active design live in `.kiro/specs/<feature-name>/` with three files:
- `requirements.md` — user stories + acceptance criteria
- `design.md` — architecture, interfaces, **correctness properties** (these become property tests)
- `tasks.md` — implementation checklist with `_Requirements: X.Y_` traceability

When working a task list: do tasks in order (they're dependency-sequenced), check them off (`- [x]`) as you complete them, stop at checkpoint tasks to verify tests pass, reference requirement numbers in commits. Specs may use `#[[file:<path>]]` to reference other files — follow them. The `.kiro/steering/` directory holds product/structure/tech context that supplements this file.
