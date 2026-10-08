# WaveKit CLI Dashboard Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Ink dashboard in `cli/` with the five-view, chain-strip instrument panel from the spec. It keeps API, IQ, process, decode, current-drop and lifetime evidence apart, renders unknown as `?`, fits every size from 60×16 to 200×50, and confirms every write except audio start/stop.

**Architecture:** A pure data layer (`cli/source/data/`) turns REST polls and WS frames into typed `Inbound` items. A 200 ms flush folds them into one immutable `AppState` and commits it to a single store. A pure presentation layer (`cli/source/ui/`, `cli/source/view-models/`) fits everything into `Line[]` (span arrays) for a given `(cols, rows)`. Thin Ink components render those lines and one root `useInput` dispatches through a data-driven keymap. Pure code is tested by root vitest with fast-check. Ink rendering is tested by the CLI package's own vitest through a fake-stdout harness and the mock core.

**Tech Stack:** TypeScript 5.9 (strict, ESM, nodenext), Ink 5.2.1, React 18.3.1, ws 8, vitest 3.2.4, fast-check 4 (root devDependency), Node 25.2.1 (`.nvmrc`), pnpm 10 + turbo 2.7.

**Spec:** `docs/superpowers/specs/2026-10-08-cli-dashboard-overhaul-design.md`. Executors read the spec section a task cites before starting it. The spec's mockups (§6) are the reference for golden snapshots.

## Global Constraints

Every task's requirements implicitly include this section.

- **Ownership:** edit only `cli/**`, `tests/unit/cli/**`, `docs/CLI.md` (new) and `docs/CLI-COORDINATION.md`. Read-only: `packages/api-types`, `packages/shared`, `src/**`, root `package.json`, root `tsconfig*.json`, `vitest.config.ts`, `eslint.config.js`, `pnpm-lock.yaml`, `turbo.json`. Contract changes are requested in `docs/CLI-COORDINATION.md`, never made.
- **Dependencies:** no new npm dependencies. Runtime is Ink 5.2.1 + React 18 + ws only. No `ink-testing-library`, no zod. Guards are hand-written and render tests use the fake-stdout harness from Task 4. `fast-check` is already a root devDependency and is used only in root tests.
- **Test split:** root vitest collects only `tests/**/*.test.ts` and must never import `.tsx` (root tsconfig has no `jsx`). Root tests import only `cli/source/{data,ui,view-models}/**`, `cli/source/{args,terminal}.ts` and `cli/source/test/{scenarios,fixtures,scenario-types}.ts`. All of these are pure `.ts`. Ink render tests live in `cli/source/**/*.test.tsx` and run only through `pnpm --filter @wavekit/cli test`.
- **Import rule:** `cli/source/data/`, `cli/source/ui/` and `cli/source/view-models/` never import `ink`, `react`, any `.tsx`, or `cli/source/views/types.ts`. They compile under the root strict flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`), so index records with brackets (`env["WAVEKIT_API_URL"]`) and never assign `undefined` to an optional property. Use conditional spreads instead (`...(x !== undefined ? { x } : {})`).
- **Property tests:** fast-check with `{ numRuns: 100 }`. Each property test has the header
  `// Feature: cli-dashboard-overhaul, Property N: <name>` followed by `// Validates: <spec section>`.
- **Code style:** strict TS, ESM with `.js` relative imports, `import type` for types, no `any`, no floating or misused promises (discard with `void`), tabs, no semicolons, single-arg arrows without parens (`x => x`). TS parameter properties, enums and namespaces are not allowed (the mock server runs under Node type stripping).
- **Formatting:** the code in this plan is not pre-formatted. Before every commit, run `pnpm exec prettier --write <the files you are staging>`. The phase gate runs `prettier --check`.
- **No console:** `console.*` never appears in production CLI code (it corrupts Ink). Help text and fatal errors go through `process.stdout.write` / `process.stderr.write` in `cli/source/cli.tsx` only.
- **Truth rules (spec §2):** API connectivity, IQ freshness, decoder process health, successful decodes, current drops and historical counters stay distinct. Unknown is `?` and never `0`, `none` or empty. Not applicable is `—`. The CLI never prints verdicts (`OK`, `healthy`, `stable`, …). Drop copy never assigns blame.
- **Live core:** never restart or deploy services, never POST/PATCH to a live core, never run `make app-up`. Write actions are exercised only against the mock core (`cli/source/test/mock-api/server.ts`). A read-only attach (GET + WS subscribe, no write keys) to a live core is allowed for visual comparison.
- **Fixtures:** committed fixtures use documentation addresses (`192.0.2.x`) or loopback (`127.0.0.1`) only. No LAN addresses, hostnames or credentials.
- **Git:** stage explicit CLI paths only. Never `git add -A`, `git add .`, `git stash` or `git reset`. Never stage `docs/HANDOFF-2026-10-08.md`, `docs/REVIEW-2026-10-08.md` or `docs/ROADMAP.md` (it contains other teams' hunks). Every commit message ends with the line
  `Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6`
- **Parallelism:** three implementers (A, B, C) with disjoint file ownership per phase (spec §14). Each task names its owner and owned files. An implementer touches only files listed in its own task's **Files** block.
- **Phase gate:** a phase starts only when the previous phase is merged and these all pass:
  ```bash
  pnpm --filter @wavekit/api-types build
  pnpm run typecheck
  pnpm test
  pnpm --filter @wavekit/cli test
  pnpm --filter @wavekit/cli build
  pnpm run lint
  pnpm exec prettier --check cli tests/unit/cli
  ```

## Review Focus

These are inputs the spec implies but its own examples do not cover. Each line has a test in the named task.

1. **A different service answers on a discovery port** (e.g. a dev server on `127.0.0.1:3000` returns `200 text/html`). Discovery must not adopt it. The candidate is skipped and listed in `tried`. Test in Task 7.
2. **The terminal resizes while the confirm bar or the filter input is open.** It may shrink below 60×16 and grow again. Expected: the too-small line, no write sent, and the confirm or draft still present after growing back. Test in Task 37.
3. **Server clock ahead of the local clock** (`lastOutputAt`, fanout `timestamp` or alert times in the future). Ages read `<1s`, never negative. Drop now still computes from server-time deltas. Tests in Tasks 10, 11 and 17.
4. **Hostile or huge payloads** (100 KB strings, deeply nested JSON, ESC/C1 controls, emoji, `\r`). Summaries are clipped and sanitised, the detail JSON is bounded, and nothing can move the cursor. Tests in Tasks 26 and 40.
5. **Two sources** with decoders split between them, one streaming and one stale. The strip shows `iq × 1/2 streaming` (worst glyph), and each decoder's window uses its own source. Tests in Tasks 5, 13 and 35.

## Resolved assumptions and spec deltas

The spec settled the design. The pre-plan research found these wire facts and tooling constraints. The plan follows them and they override any conflicting example in the spec:

1. **Mock server location (tooling).** `eslint.config.js` is read-only, and its `parserOptions.project` lists only `./tsconfig.json`, `./cli/tsconfig.json` and `./packages/*/tsconfig.json`. A `.ts` file under `cli/tools/` would therefore fail `pnpm run lint` with "file not found in any project". So the mock server lives at **`cli/source/test/mock-api/server.ts`**, which is covered by `cli/tsconfig.json`, excluded from the build, and runnable with `node cli/source/test/mock-api/server.ts`. It is a single self-contained file because `cli/tsconfig.json` does not allow `.ts` import specifiers. Scenario JSON stays in `cli/tools/mock-api/scenarios/` and the tmux script in `cli/tools/validate/matrix.sh` (neither is linted). There is **no** `cli/tools/tsconfig.json`, and the CLI vitest config is **`cli/vitest.config.mjs`** (plain JS, linted by ESLint's default espree parser). Both deviate from spec §11.
2. **`decoder:health`** arrives on the `health` channel as `{decoderId, health}`, and `previousHealth` is never sent. The reducer records `previousHealth` itself from the value it is replacing.
3. **`aircraft:lost`** carries `{icao, aircraft}`, not the `AircraftLostEvent` shape in api-types. The guard follows the broadcaster.
4. **Live-audio `gain`** is a linear multiplier, rendered unitless (`gain 10`). **Presets** carry only `{bandwidth, deEmphasis?, deEmphasisTau?}`, so the preset PATCH body is `{modulation: <preset name>, bandwidth, deEmphasis?, deEmphasisTau?}`.
5. **`/health`** always returns `{status:"ok"}`, with 200 or 503. Discovery accepts any response whose JSON body has `status === "ok"`. A 503 still means core answered.
6. **Extra WS events** handled: `source:caps-changed`, `live-audio:status`, `live-audio:config`, `unsubscribed`, server `error`. The `subscribed` ack is `{type:"subscribed", data:{channels}}` with no `channel` field and triggers the `ws:open` inbound.
7. **Sample rates.** The server range-checks only (225 001–3 200 000 S/s). The CLI cycles its own RTL-SDR list `250000, 1024000, 1536000, 1792000, 1920000, 2048000, 2160000, 2400000, 2560000, 2880000, 3200000`. Tuner commands go out in the order frequency, sample rate, gain mode, gain, ppm, rtl agc, bias-t, direct sampling, offset tuning. Gain mode is sent before gain so that a switch to manual followed by a gain change is accepted. This refines spec §6.4's "field order".
8. **`dataRate`** (REST sources and WS `metrics`) is KiB/s and is multiplied by 1024 before formatting. WS `metrics` arrive every 5 s. `fanout:backpressure`/`fanout:drain` use `branchId`. `/api/aircraft.timestamp` is Unix ms.
9. **Server verdict words are quoted.** The CORE row renders `reports "degraded"`. SDR-host warnings and errors, alert messages and `last error` values are rendered inside straight double quotes. The banned-word check (`findBanned`, Task 3) ignores double-quoted substrings, so `reports "healthy"` from a server is shown verbatim without the CLI asserting it. Scenario payloads are curated to contain no banned words.
10. **Drops glyph.** The strip's drops lane renders `drops !34% now` (attention role) whenever any decoder branch is in backpressure, following §4.1's bullet text over the mockup.
11. **Audio start/stop is a write without confirm (T9).** P20 is therefore tested as: `confirm-yes` actions come only from `y` in confirm mode, `audio-toggle` comes only from `a` in the System list mode, and no other key in any mode resolves to either.
12. **Fixture numbers.** The live scenario uses the mockup's per-branch drop percentages. The aggregate is computed as ΣΔdropped/ΣΔoffered = **21 %**, not the mockup's 34 %. Goldens use the computed value.
13. **Boundary.** A lane is old iff `age > 15 000 ms` (P17). The migrated `source-activity` cases move their stale probe from `+15 000` to `+15 001`.
14. **AppState extras.** Beyond spec §10.5's list, `AppState` carries `metrics`, `session` (per-decoder histories), `fanoutHistory`, `branchEvents`, `tunerLastCommand`, `presets` and `effects`. Effects are polls the runtime runs after a commit, which keeps the reducer pure.
15. **Ownership refinements (still disjoint).** In phase 1, C owns `cli/source/test/scenarios.ts` (JSON loading) and A owns `cli/source/test/fixtures.ts` (`scenarioState`), because the latter needs A's reducer. In phase 2, B delivers `view-models/{decoder-rows,message-rows}.ts` first, because A's Overview reuses them. A adds `view-models/chrome.ts` (strip, banner and footer inputs) and `cli/source/terminal.ts` is C's.
16. **`localhost` and port 4713.** An explicit `localhost` URL is rewritten to `127.0.0.1`. An explicit URL on port 4713 exits 2 with `port 4713 is the RTL-TCP relay, not the WaveKit API`.
17. **Glyph mode.** `WAVEKIT_ASCII=1`, or a locale variable (`LC_ALL`, then `LC_CTYPE`, then `LANG`) that is set and does not mention UTF-8, selects ASCII glyphs. If none of those variables is set, UTF-8 is used. The mode is module state set once in `cli.tsx` before render. The ASCII ellipsis is `...` (3 columns) and `truncate` accounts for its width.
18. **Small refinements that keep spec intent.**
    - `tooSmallText` falls back to shorter one-line variants (`wavekit: 50×12 too small (min 60×16)`), because the full sentence is 52 columns and cannot fit a 50-column terminal on one line.
    - The Decoders view uses the pref widths of the decoder, process, decodes, IQ in and drop columns as their minimums, so nominal MHz is the first column to drop at 120 columns (§5.3, §6.2).
    - The frame budgets take the content height: `overviewBudget(cols, content, roomy, n)` and `listBudget(...)` replace the single `frameBudget(view, cols, rows, state)`.
    - Ages under 10 minutes keep their seconds (`last command 6m 32s ago`), as §8 specifies, where the mockups abbreviate.
    - Sub-second server durations in the decoder detail use tenths (`in backpressure 0.2s`). Sample ages use `formatSampleAge` (`4 ms`, `200 ms`).
19. **Ink specifics folded in.** Render tests use `debug: true` and read the last write. The app subscribes to `stdout` `'resize'` itself, because Ink ignores resize under `CI=true`. The frame height is `rows − 1`. One root `useInput` treats `key.backspace || key.delete` as backspace. Tests write one key per stdin chunk and wait one tick after `render()` before pressing.

## File structure

```
cli/
  package.json                      MODIFY scripts (Task 1)
  turbo.json                        NEW package-level turbo inputs (Task 1)
  tsconfig.build.json               NEW build config, tsbuildinfo in dist (Task 1)
  vitest.config.mjs                 NEW cli render-test config (Task 1)
  source/
    cli.tsx                         REWRITE entry: args, alt screen, runtime, render (Tasks 31, 37)
    app.tsx                         REWRITE root shell + view registry (Task 37)
    args.ts                         NEW flags, aliases, help text (Task 30)
    terminal.ts                     NEW alt-screen enter/restore, OSC 52 (Task 31)
    data/                           pure, no ink/react
      types.ts store.ts             (Task 2)
      freshness.ts memo.ts          (Task 5)
      guards.ts                     (Task 6)
      config.ts                     (Task 7)
      api-client.ts                 (Task 8)
      ws-client.ts                  (Task 9)
      rates.ts                      (Task 10)
      decoder-state.ts              (Task 11)
      ring-buffer.ts                (Task 12)
      nominal-bands.ts window.ts    (Task 13)
      reducers.ts                   (Task 14)
      runtime.ts                    (Task 15)
    ui/                             pure, no ink/react
      line.ts actions.ts ui-state.ts            (Task 2)
      theme.ts text.ts copy-rules.ts            (Task 3)
      format.ts (17) fit.ts (18) columns.ts (19) frame.ts (20) strip.ts (21) banner.ts (22)
      keymap.ts (23) ui-reducer.ts (24) filter.ts (25) messages/*.ts (26) tuner-edit.ts (32)
    view-models/                    pure
      decoder-rows.ts message-rows.ts (Task 34)  chrome.ts help.ts (Task 35)
      overview.ts (Task 38)  decoders.ts (Task 39)  messages.ts (Task 40)
      receiver.ts (Task 41)  system.ts (Task 42)
    hooks/ use-store.ts (15) use-terminal-size.ts use-keys.ts (36)
    components/ lines.tsx (27) chain-strip.tsx switcher.tsx footer.tsx banner.tsx confirm-bar.tsx
                help-overlay.tsx too-small.tsx error-boundary.tsx (36) input-line.tsx (40)
    views/ types.ts (2) overview.tsx (38) decoders.tsx (39) messages.tsx (40) receiver.tsx (41)
           system.tsx (42) registry.ts matrix.test.tsx (43)
    test/ harness.ts harness.test.tsx (4) scenario-types.ts (2) scenarios.ts (28)
          fixtures.ts (16) mock-api/server.ts (29) app-harness.tsx (37)
  tools/
    mock-api/scenarios/*.json       sanitised scenarios (Task 28)
    validate/matrix.sh              tmux matrix, resize, perf (Task 33)
tests/unit/cli/*.test.ts            root pure-logic + property tests (per task)
docs/CLI.md                         NEW user doc (Task 46)
docs/CLI-COORDINATION.md            status line + observed mismatches (Task 46)
```

Removed in Task 44: `cli/source/components/{backpressure-panel,dashboard,decoded-message,decoder-list,decoder-output,header,help-bar,live-audio-panel,resource-panel,source-status,tab-bar,terminal-link,tuner-panel}.tsx`, `components/index.ts`, `hooks/use-websocket.ts`, `hooks/index.ts`, `utils/{args,format,index,source-activity}.ts`, `types.ts`, `tests/unit/cli/source-activity.test.ts`. (`components/error-boundary.tsx` and `hooks/use-terminal-size.ts` are rewritten in place by Task 36.)

## Task index and ownership

| Phase | Task | Owner | Deliverable |
|---|---|---|---|
| 0 | 1 | A | Build/test scaffolding, stale-dist fix |
| 0 | 2 | A | Shared contracts: data/types, store, ui/line, actions, ui-state, views/types, scenario-types |
| 0 | 3 | A | theme, text (P7), copy-rules |
| 0 | 4 | A | Ink render harness + smoke test |
| 1 | 5–16 | A | freshness/memo, guards, config, api-client, ws-client, rates, decoder-state, ring-buffer, window, reducers, runtime + use-store, fixtures |
| 1 | 17–27 | B | format, fit, columns, frame, strip, banner, keymap, ui-reducer, filter, messages formatters, lines.tsx |
| 1 | 28–33 | C | scenarios, mock server, args, terminal + cli.tsx, tuner-edit, matrix.sh |
| 2 | 34 | B (first) | decoder-rows + message-rows view-models |
| 2 | 35–38 | A | chrome/help VMs, hooks + chrome components, app shell, Overview |
| 2 | 39–40 | B | Decoders view, Messages view |
| 2 | 41–42 | C | Receiver view, System view |
| 3 | 43–44 | A | view registry + cli.tsx switch + P22 matrix test; removals, migrations, guards corpus, final gates; every phase-3 fix in view-models, ui, views and components |
| 3 | 45 | C | tmux validation + performance runs (reports view failures to A) |
| 3 | 46 | B | docs/CLI.md, coordination status, copy audit (reports copy hits to A) |

Cross-owner order inside a phase. "After Task N" means after Task N is merged into the shared branch and pulled.

Phase 1:
- Task 16 (A) starts after Task 28 (C), which provides `cli/source/test/scenarios.ts` and the scenario JSON.
- Task 21 (B) starts after Task 5 (A), because `tests/unit/cli/strip.test.ts` imports `apiView` and `iqView` from `cli/source/data/freshness.ts`.
- Task 26 (B) starts after Task 6 (A), because `cli/source/ui/messages/*.ts` import `isObj`, `isStr`, `isNum` and `Obj` from `cli/source/data/guards.ts`.
- Task 31 (C) starts after Task 7 (A), because `cli/source/cli.tsx` imports `resolveExplicit` and `CliUsageError` from `cli/source/data/config.ts`.
- A therefore does Tasks 5, 6, 7 first, in that order, and merges each one as soon as it is green. B's Tasks 17–20 and 22–25 and C's Tasks 28–30 and 32 have no cross-owner input, so B and C do those first. If a dependency is not merged yet when its consumer would start, the consumer moves on to its next independent task (C: Task 32 before Task 31; Task 33 always follows Task 31, because it drives the built `cli/dist/cli.js`).

Phase 2:
- Task 38 (A, Overview) starts after Task 34 (B).
- In Tasks 39–42, the pure view-model steps start at once. The Ink render-test steps start after Task 37 (A: `app.tsx` and `test/app-harness.tsx`).

Phase 3 (order 43 → (44, 46) → 45):
- Tasks 44 (A) and 46 (B) start after Task 43 (A). Task 46 Step 1 runs `views/matrix.test.tsx`, which Task 43 creates, and its copy-audit grep runs after Task 44 has deleted the legacy components, which still contain banned literals.
- Task 45 (C) starts after Tasks 44 and 46. It drives `cli/dist/cli.js`, which shows the new UI only after Task 43 rewrites `cli.tsx`. It appends to the `docs/CLI.md` that Task 46 creates, and C owns only its `## Validation` section.
- Phase 3 fix ownership: A owns every fix under `cli/source/**`, including view-models, ui, views, components, data, `app.tsx` and `cli.tsx`. B and C never edit files there in phase 3. They report each failure to A (task, scenario, view, size, offending line or capture path). A fixes it in a follow-up commit, and the reporter reruns its check. The only exceptions are the conditional files named in Task 45's **Files** block. A has finished Tasks 43–44 by then and does not touch those files while Task 45 runs.

Nothing that imports a module from another owner's same-phase task may start before that task is merged. An implementer who finds an unlisted cross-owner import stops and reports it. It never creates or stubs a file another owner lists. Everything else within a phase runs in parallel. The App takes its view registry as a prop. `views/registry.ts` and the switch of `cli.tsx` to the new shell land in Task 43, once all five views exist.

---

## Phase 0 — contracts and scaffolding (A alone)

### Task 1: Build and test scaffolding

**Owner:** A · **Spec:** §11 (cli/ layout), §14 phase 0, research findings on turbo/tsc/vitest

**Files:**
- Modify: `cli/package.json` (scripts block only)
- Create: `cli/tsconfig.build.json`
- Create: `cli/vitest.config.mjs`
- Create: `cli/turbo.json`

**Interfaces:**
- Produces: `pnpm --filter @wavekit/cli build`, which compiles `source/**` except tests into `cli/dist` with the tsbuildinfo in `dist`. `pnpm --filter @wavekit/cli test`, which runs `cli/source/**/*.test.tsx` with `TZ=UTC`. Turbo hashes CLI sources.

**Why:** the current `cli` tasks hash only `package.json`/`tsconfig.json`, so turbo replays a stale `dist`. The tsbuildinfo lives in `node_modules/.cache`, so `rm -rf dist` does not force a rebuild. And `vitest run` inside `cli/` walks up to the root config (`tests/**/*.test.ts`).

- [ ] **Step 1: Reproduce the stale-dist fault**

```bash
cd /Users/ben/Projects/wavekit
pnpm --filter @wavekit/cli build
rm -rf cli/dist
pnpm --filter @wavekit/cli build
ls cli/dist/cli.js
```
Expected: `ls: cli/dist/cli.js: No such file or directory`, or an incomplete `dist`. This is the bug.

- [ ] **Step 2: Write `cli/tsconfig.build.json`**

`exclude` is restated in full, because an extending config replaces `exclude` rather than merging it.

```json
{
	"extends": "./tsconfig.json",
	"compilerOptions": {
		"tsBuildInfoFile": "./dist/.tsbuildinfo"
	},
	"include": ["source/**/*"],
	"exclude": [
		"node_modules",
		"dist",
		"source/**/*.test.tsx",
		"source/**/*.test.ts",
		"source/test/**"
	]
}
```

- [ ] **Step 3: Write `cli/vitest.config.mjs`**

```js
import { defineConfig } from "vitest/config"

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		include: ["source/**/*.test.tsx"],
		environment: "node",
		env: { TZ: "UTC", FORCE_COLOR: "0" },
		testTimeout: 20000,
	},
})
```

- [ ] **Step 4: Write `cli/turbo.json`**

```json
{
	"$schema": "https://turbo.build/schema.json",
	"extends": ["//"],
	"tasks": {
		"build": {
			"inputs": [
				"source/**",
				"!source/**/*.test.tsx",
				"!source/test/**",
				"tsconfig.json",
				"tsconfig.build.json",
				"package.json"
			]
		},
		"typecheck": {
			"inputs": ["source/**", "tsconfig.json", "package.json"]
		},
		"test": {
			"dependsOn": ["^build"],
			"inputs": [
				"source/**",
				"tools/mock-api/scenarios/**",
				"vitest.config.mjs",
				"tsconfig.json",
				"package.json"
			]
		},
		"lint": {
			"inputs": [
				"source/**",
				"vitest.config.mjs",
				"$TURBO_ROOT$/eslint.config.js"
			]
		}
	}
}
```

- [ ] **Step 5: Update the `scripts` block of `cli/package.json`**

Replace the whole `"scripts"` object with the block below and leave every other key untouched. `--passWithNoTests` stays until Task 4 adds the first render test.

```json
	"scripts": {
		"build": "pnpm --filter @wavekit/api-types build && pnpm -w exec tsc -p cli/tsconfig.build.json",
		"dev": "pnpm -w exec tsc -p cli/tsconfig.build.json --watch",
		"lint": "eslint -c ../eslint.config.js .",
		"mock": "node ./source/test/mock-api/server.ts",
		"start": "node ./dist/cli.js",
		"test": "vitest run --passWithNoTests",
		"typecheck": "pnpm -w exec tsc -p cli/tsconfig.json --noEmit"
	},
```

- [ ] **Step 6: Verify the stale-dist fix and turbo hashing**

```bash
cd /Users/ben/Projects/wavekit
rm -rf cli/dist
pnpm --filter @wavekit/cli build && ls cli/dist/cli.js cli/dist/.tsbuildinfo
pnpm exec turbo run build --filter=@wavekit/cli --dry=json | grep -c '"source/'
pnpm --filter @wavekit/cli test
```
Expected: both files are listed. The grep count is greater than 0, meaning CLI sources are now hash inputs. The CLI vitest run prints `No test files found` and exits 0. Also check that the `RUN` line shows root `/Users/ben/Projects/wavekit/cli` and no longer prints `include: tests/**/*.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add cli/package.json cli/tsconfig.build.json cli/vitest.config.mjs cli/turbo.json
git commit -m "build(cli): build via tsconfig.build.json, own vitest config, turbo inputs

Fixes stale dist (tsbuildinfo now lives in dist) and turbo replaying CLI
outputs after source-only edits.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 2: Shared contracts

**Owner:** A · **Spec:** §10.5 (AppState, Lane, Inbound), §11 (Span/Line/roles), §7 (actions, modes), §14 (view registry)

**Files:**
- Create: `cli/source/data/types.ts`
- Create: `cli/source/data/store.ts`
- Create: `cli/source/ui/line.ts`
- Create: `cli/source/ui/actions.ts`
- Create: `cli/source/ui/ui-state.ts`
- Create: `cli/source/views/types.ts`
- Create: `cli/source/test/scenario-types.ts`
- Test: `tests/unit/cli/store.test.ts`

**Interfaces:**
- Produces: every type below, verbatim. Later tasks import these names and must not redefine them.

- [ ] **Step 1: Write the failing store test**

`tests/unit/cli/store.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createStore } from "../../../cli/source/data/store.js"

describe("createStore", () => {
	it("notifies subscribers once per changed set and skips identical values", () => {
		const store = createStore({ n: 1 })
		const listener = vi.fn()
		const off = store.subscribe(listener)
		const next = { n: 2 }
		store.set(next)
		store.set(next)
		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.get()).toBe(next)
		expect(store.commits()).toBe(1)
		off()
		store.set({ n: 3 })
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/store.test.ts`
Expected: FAIL, `Failed to resolve import "../../../cli/source/data/store.js"`.

- [ ] **Step 3: Write `cli/source/data/store.ts`**

```ts
export interface Store<T> {
	get(): T
	set(next: T): void
	subscribe(listener: () => void): () => void
	/** Number of committed (changed) sets; used by tests to assert ≤ 1 commit per tick. */
	commits(): number
}

export function createStore<T>(initial: T): Store<T> {
	let current = initial
	let count = 0
	const listeners = new Set<() => void>()
	return {
		get: () => current,
		set: next => {
			if (Object.is(next, current)) return
			current = next
			count++
			for (const listener of [...listeners]) listener()
		},
		subscribe: listener => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		commits: () => count,
	}
}
```

- [ ] **Step 4: Write `cli/source/data/types.ts`**

```ts
import type {
	AircraftState,
	AircraftTrackerStats,
	DecoderCaps,
	DecoderHealth,
	DecoderOutput,
	DecoderStatus,
	ExtendedSourceStatus,
	FanoutSnapshot,
	LiveAudioConfig,
	LiveAudioStatus,
	ResourceAlert,
	ResourceSnapshot,
	SdrHostSampling,
	SdrHostStatus,
	SourceCaps,
	TunerControlMode,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"

// ---------- DTO views (what guards produce) ----------

export type DecoderRow = DecoderStatus & { caps?: DecoderCaps }

export interface CoreComponent {
	name: string
	status: string
	message?: string
}

export interface CoreStatus {
	status: string
	uptime: number
	version: string
	components: CoreComponent[]
}

export interface AudioPreset {
	bandwidth: number
	deEmphasis?: boolean
	deEmphasisTau?: 50 | 75
}
export type PresetMap = Record<string, AudioPreset>

export interface AircraftSnapshot {
	aircraft: AircraftState[]
	stats: AircraftTrackerStats
	timestamp: number
}

/** SdrHostStatus plus the optional Pi sampling slot (request 6), validated by readHostSampling. */
export type SdrHostView = SdrHostStatus & { sampling?: SdrHostSampling }
export interface ResourceView extends Omit<ResourceSnapshot, "sdrHosts"> {
	sdrHosts: SdrHostView[]
}

// ---------- endpoints ----------

export type Endpoint =
	| "decoders"
	| "sources"
	| "tuner"
	| "relay"
	| "fanout"
	| "resources"
	| "audio"
	| "status"
	| "presets"
	| "aircraft"

export const ENDPOINT_PATHS: Readonly<Record<Endpoint, string>> = {
	decoders: "/api/decoders",
	sources: "/api/sources",
	tuner: "/api/tuner",
	relay: "/api/tuner-relay",
	fanout: "/api/telemetry/fanout",
	resources: "/api/resources",
	audio: "/api/live-audio/status",
	status: "/api/status",
	presets: "/api/live-audio/presets",
	aircraft: "/api/aircraft",
}

/** Polled every 5 s (spec §10.2). */
export const POLL_ENDPOINTS: readonly Endpoint[] = [
	"decoders",
	"sources",
	"tuner",
	"relay",
	"fanout",
	"resources",
	"audio",
	"status",
]
/** Fetched at start and after every reconnect. */
export const RESYNC_ENDPOINTS: readonly Endpoint[] = ["presets", "aircraft"]

export interface RestValues {
	decoders: DecoderRow[]
	sources: ExtendedSourceStatus[]
	tuner: TunerState[]
	relay: TunerRelayStatus
	fanout: FanoutSnapshot
	resources: ResourceView
	audio: LiveAudioStatus
	status: CoreStatus
	presets: PresetMap
	aircraft: AircraftSnapshot
}

// ---------- lanes ----------

export type LaneErrorKind = "timeout" | "network" | "http" | "invalid"
export interface LaneError {
	kind: LaneErrorKind
	status?: number
	message: string
	at: number
}
export type LaneOrigin = "rest" | "ws"
export interface Lane<T> {
	value: T | undefined
	receivedAt: number | null
	origin: LaneOrigin
	error?: LaneError
}

export type FetchOutcome<T> =
	| { ok: true; value: T; rejected: number }
	| { ok: false; error: LaneError }

// ---------- WS events (output of parseServerMessage) ----------

export type WsEvent =
	| { type: "subscribed"; channels: string[] }
	| { type: "unsubscribed"; channels: string[] }
	| { type: "server-error"; message: string }
	| { type: "decoder:output"; decoderId: string; output: DecoderOutput }
	| { type: "decoder:started"; decoderId: string }
	| { type: "decoder:stopped"; decoderId: string }
	| { type: "decoder:error"; decoderId: string; error: string }
	| { type: "decoder:health"; decoderId: string; health: DecoderHealth }
	| { type: "source:connected"; sourceId: string }
	| { type: "source:disconnected"; sourceId: string; error?: string }
	| { type: "source:error"; sourceId: string; error: string }
	| { type: "source:caps-changed"; sourceId: string; caps: SourceCaps }
	| { type: "metrics"; sourceId: string; bytesReceived: number; dataRate: number }
	| { type: "fanout:snapshot"; snapshot: FanoutSnapshot }
	| {
			type: "fanout:backpressure"
			branchId: string
			bufferedBytes: number
			timestamp: string
	  }
	| { type: "fanout:drain"; branchId: string; durationMs: number; timestamp: string }
	| { type: "live-audio:status"; status: LiveAudioStatus }
	| { type: "live-audio:config"; config: LiveAudioConfig }
	| { type: "live-audio:started" }
	| { type: "live-audio:stopped" }
	| { type: "live-audio:error"; message: string }
	| { type: "resources:snapshot"; snapshot: ResourceView }
	| { type: "resources:alert"; alert: ResourceAlert }
	| { type: "tuner:state-changed"; sourceId: string; state: TunerState }
	| { type: "tuner:command-sent"; sourceId: string; command: string; value: unknown }
	| { type: "tuner:control-mode-changed"; sourceId: string; mode: TunerControlMode }
	| { type: "tuner:error"; sourceId: string; error: string }
	| { type: "aircraft:new"; aircraft: AircraftState }
	| { type: "aircraft:update"; aircraft: AircraftState }
	| { type: "aircraft:lost"; icao: string }
	| { type: "aircraft:stats"; stats: AircraftTrackerStats }

// ---------- writes ----------

export type DecoderOp = "start" | "stop" | "restart"
export type TunerSetting =
	| "frequency"
	| "gain"
	| "gain-mode"
	| "sample-rate"
	| "ppm"
	| "agc"
	| "bias-tee"
	| "offset-tuning"
	| "direct-sampling"
	| "tuner-gain-index"
	| "control-mode"
export interface TunerCommand {
	setting: TunerSetting
	body: Record<string, number | boolean | string>
	/** Field name shown in result lines, e.g. "frequency". */
	label: string
}
export type WriteIntent =
	| { kind: "decoder"; op: DecoderOp; decoderId: string }
	| { kind: "tuner"; sourceId: string; commands: TunerCommand[] }
	| { kind: "audio"; op: "start" | "stop" }
	| { kind: "preset"; name: string; patch: Partial<LiveAudioConfig> }

export function actionKey(intent: WriteIntent): string {
	switch (intent.kind) {
		case "decoder":
			return `decoder:${intent.decoderId}`
		case "tuner":
			return `tuner:${intent.sourceId}`
		case "audio":
			return "audio"
		case "preset":
			return "preset"
	}
}

export interface ActionResult {
	ok: boolean
	status: number | null
	code?: string
	message: string
}
export interface CommandOutcome {
	label: string
	/** null = not sent (an earlier command failed). */
	result: ActionResult | null
	at: number | null
}
export interface ActionRecord {
	key: string
	intent: WriteIntent
	sentAt: number
	state: "sent" | "ok" | "failed"
	outcomes: CommandOutcome[]
	doneAt: number | null
	/** decoder:started / decoder:stopped observed after the send. */
	confirmedAt: number | null
}

// ---------- messages ----------

export interface MessageSegment {
	text: string
	/** 0 = most important; dropped last by fitGroups. */
	priority: number
	role?: "value" | "attention" | "label"
}
export type MessageCategory = "aircraft" | "voice" | "pager" | "data" | "other"
export interface FormattedMessage {
	/** Type column, e.g. "DMR", "POCSAG", "ADS-B". */
	protocol: string
	category: MessageCategory
	segments: MessageSegment[]
	/** Free text body (pager text, ACARS text); cut at the row end, never dropped. */
	text?: string
	fields: Array<{ label: string; value: string; attention?: boolean }>
	emergency: boolean
	/** Lower-case, sanitised, bounded text used by the filter. */
	searchText: string
}
export interface MessageEntry {
	seq: number
	decoderId: string
	type: string
	receivedAt: number
	output: DecoderOutput
	formatted: FormattedMessage
}
export interface Gap {
	afterSeq: number
	from: number
	to: number | null
}
export interface MessageRing {
	capacity: number
	floor: number
	/** Oldest → newest. Mutated in place by ring-buffer.ts. */
	entries: MessageEntry[]
	gaps: Gap[]
	nextSeq: number
	perDecoder: Record<string, number>
	/** Messages ever ingested this session. */
	total: number
}
export type AircraftLookup = (icao: string) => AircraftState | undefined

// ---------- histories ----------

export interface CounterSample {
	t: number
	v: number
}
export interface FanoutBranchSample {
	decoderId?: string
	offered?: number
	dropped: number
	backpressure: boolean
}
export interface FanoutSample {
	/** Server timestamp (ms) of the snapshot. */
	t: number
	branches: Record<string, FanoutBranchSample>
}
export interface DecoderSession {
	lastWsOutputAt: number | null
	lastError: { message: string; at: number } | null
	previousHealth: DecoderHealth | null
	/** eventsOut samples, trailing 60 s (decode rate). */
	events: CounterSample[]
	/** restartCount samples, trailing 5 min (crash-loop). */
	restarts: CounterSample[]
	/** minute index (floor(t/60000)) → decodes observed in that minute. */
	spark: Record<string, number>
	firstObservedAt: number
}
export interface MetricBeat {
	bytesReceived: number
	/** KiB/s as reported by core. */
	dataRateKiB: number
	at: number
}
export interface BranchTransition {
	active: boolean
	at: number
	bufferedBytes?: number
}
export interface AlertEntry {
	key: string
	alert: ResourceAlert
	count: number
	firstAt: number
	lastAt: number
}
export interface AircraftEntry {
	state: AircraftState
	/** Local receipt time, used for the 300 s prune. */
	at: number
}

// ---------- connection ----------

export interface DiscoveryState {
	mode: "explicit" | "probing" | "found" | "failed"
	tried: string[]
}
export interface ConnState {
	target: { base: string | null; ws: string | null }
	discovery: DiscoveryState
	ws: {
		state: "idle" | "connecting" | "open" | "closed"
		since: number | null
		code: number | null
		reason: string | null
		nextRetryAt: number | null
		attempt: number
	}
	rest: {
		/** Last time any polled endpoint answered OK. */
		lastOkAt: number | null
		lastCycleAt: number | null
		nextAt: number | null
		failing: Endpoint[]
		firstFailAt: number | null
		lastError: LaneError | null
	}
	invalidFrames: number
	rejectedItems: number
	lastEventAt: number | null
}

export interface Effects {
	polls: Endpoint[]
}

export interface AppState {
	conn: ConnState
	sources: Lane<ExtendedSourceStatus[]>
	metrics: Record<string, MetricBeat>
	decoders: Lane<DecoderRow[]>
	session: Record<string, DecoderSession>
	tuner: Lane<TunerState[]>
	tunerLastCommand: Record<string, { command: string; value: unknown; at: number }>
	relay: Lane<TunerRelayStatus>
	fanout: Lane<FanoutSnapshot>
	fanoutHistory: FanoutSample[]
	branchEvents: Record<string, BranchTransition>
	resources: Lane<ResourceView>
	alerts: AlertEntry[]
	audio: Lane<LiveAudioStatus>
	presets: Lane<PresetMap>
	status: Lane<CoreStatus>
	messages: { version: number; ring: MessageRing }
	aircraft: {
		version: number
		map: Map<string, AircraftEntry>
		stats: Lane<AircraftTrackerStats>
	}
	actions: { byKey: Record<string, ActionRecord>; stoppedByCli: string[] }
	effects: Effects
	now: number
}

// ---------- inbound ----------

export type RestInbound = {
	[E in Endpoint]: {
		kind: "rest"
		endpoint: E
		outcome: FetchOutcome<RestValues[E]>
		at: number
	}
}[Endpoint]

export type Inbound =
	| RestInbound
	| { kind: "rest:cycle"; at: number; nextAt: number }
	| { kind: "ws"; event: WsEvent; at: number }
	| { kind: "ws:connecting"; at: number; attempt: number }
	| { kind: "ws:open"; at: number }
	| { kind: "ws:close"; at: number; code: number; reason: string; nextRetryAt: number | null }
	| { kind: "ws:invalid"; at: number }
	| {
			kind: "target"
			at: number
			base: string | null
			ws: string | null
			discovery: DiscoveryState
	  }
	| { kind: "action:sent"; at: number; key: string; intent: WriteIntent }
	| { kind: "action:result"; at: number; key: string; outcomes: CommandOutcome[] }

// ---------- derived evidence shared by data/ and ui/ ----------

export type GlyphRole = "live" | "neutral" | "fault" | "unknown"

export type ApiView =
	| { kind: "connecting" }
	| { kind: "ok"; restAgeMs: number }
	| { kind: "split"; ws: boolean; rest: boolean; restAgeMs: number | null }
	| { kind: "down"; sinceMs: number | null }

export interface IqView {
	glyph: GlyphRole
	/** "streaming", "connected · no samples", "no samples", "paused", "ended", "disconnected", "connected", "receiving", "unknown", or "<n>/<m> streaming". */
	word: string
	/** For "no samples": server-relative sample age. */
	ageMs: number | null
	rateBytesPerSec: number | null
}
```

- [ ] **Step 5: Write `cli/source/ui/line.ts`**

```ts
export type Role =
	| "label"
	| "value"
	| "live"
	| "neutral"
	| "fault"
	| "attention"
	| "unknown"
	| "old"
	| "accent"
	| "selected"
	| "edit"

export interface Span {
	text: string
	role: Role
	/** Strip values, section titles and the selected row name are bold (spec §8). */
	bold?: boolean
}
export type Line = Span[]

/** A fitGroups group. Variants are ordered MINIMAL → RICH (every variant array in this codebase uses that order). */
export interface Group {
	variants: Line[]
	priority: number
}

/** A table cell. Variants are ordered MINIMAL → RICH; the richest variant that fits is used. */
export interface Cell {
	variants: Line[]
}

export type HeightClass = "roomy" | "compact"
export type WidthClass = "narrow" | "standard" | "wide" | "ultra"

export function sp(text: string, role: Role = "value", bold = false): Span {
	return bold ? { text, role, bold } : { text, role }
}

export function cell(...variants: Line[]): Cell {
	return { variants }
}

/** A one-span cell with identical minimal and rich text. */
export function textCell(text: string, role: Role = "value"): Cell {
	return { variants: [[sp(text, role)]] }
}
```

- [ ] **Step 6: Write `cli/source/ui/actions.ts`**

```ts
import type { DecoderOp } from "../data/types.js"

export type ViewId = "overview" | "decoders" | "messages" | "receiver" | "system"
export const VIEW_ORDER: readonly ViewId[] = [
	"overview",
	"decoders",
	"messages",
	"receiver",
	"system",
]
export const VIEW_TITLES: Readonly<Record<ViewId, string>> = {
	overview: "Overview",
	decoders: "Decoders",
	messages: "Messages",
	receiver: "Receiver",
	system: "System",
}

export type EditKey =
	| "left"
	| "right"
	| "up"
	| "down"
	| "tab"
	| "space"
	| "backspace"
	| "0"
	| "1"
	| "2"
	| "3"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "9"

export type Action =
	| { type: "view"; view: ViewId }
	| { type: "view-step"; delta: 1 | -1 }
	| { type: "help-open" }
	| { type: "help-close" }
	| { type: "quit" }
	| { type: "reconnect" }
	| { type: "move"; delta: 1 | -1 }
	| { type: "page"; delta: 1 | -1 }
	| { type: "top" }
	| { type: "newest" }
	| { type: "open" }
	| { type: "escape" }
	| { type: "detail-scroll"; delta: 1 | -1 }
	| { type: "filter-open" }
	| { type: "filter-type"; text: string }
	| { type: "filter-backspace" }
	| { type: "filter-apply" }
	| { type: "filter-cancel" }
	| { type: "pause-toggle" }
	| { type: "preset-cycle" }
	| { type: "copy-json" }
	| { type: "decoder-op"; op: DecoderOp }
	| { type: "edit-open" }
	| { type: "edit-key"; key: EditKey }
	| { type: "edit-review" }
	| { type: "edit-discard" }
	| { type: "control-toggle" }
	| { type: "audio-toggle" }
	| { type: "preset-open" }
	| { type: "preset-next" }
	| { type: "confirm-yes" }
	| { type: "confirm-no" }
	| { type: "notice"; text: string }

/** The only actions that cause network writes (spec T9, P20). */
export function isWrite(action: Action): boolean {
	return action.type === "confirm-yes" || action.type === "audio-toggle"
}

/** Per-view facts the keymap's `when` predicates read (filled by each view's keyInfo). */
export interface ViewKeyCtx {
	hasSelection: boolean
	decoderRunning: boolean | null
	control: "internal" | "external" | null
	audioRunning: boolean | null
	paused: boolean
}

export const EMPTY_VIEW_CTX: ViewKeyCtx = {
	hasSelection: false,
	decoderRunning: null,
	control: null,
	audioRunning: null,
	paused: false,
}
```

- [ ] **Step 7: Write `cli/source/ui/ui-state.ts`**

```ts
import type { WriteIntent } from "../data/types.js"
import { VIEW_ORDER, type ViewId } from "./actions.js"

export type PresetName = "all" | "aircraft" | "voice" | "pager" | "data"
export const PRESET_ORDER: readonly PresetName[] = [
	"all",
	"aircraft",
	"voice",
	"pager",
	"data",
]

export type EditField =
	| "frequency"
	| "sampleRate"
	| "gain"
	| "ppm"
	| "gainMode"
	| "agc"
	| "biasTee"
	| "directSampling"
	| "offsetTuning"

export interface TunerDraft {
	frequency: number
	sampleRate: number
	/** 0.1 dB units, 0–500. */
	gainTenthsDb: number
	ppm: number
	gainMode: "manual" | "agc"
	agc: boolean
	biasTee: boolean
	directSampling: "off" | "i" | "q"
	offsetTuning: boolean
}
export interface TunerEditState {
	sourceId: string
	original: TunerDraft
	draft: TunerDraft
	field: EditField
	/** Frequency cursor: power of ten under the cursor (0 = 1 Hz digit). */
	digit: number
}

export type ConfirmKind = "decoder" | "tuner" | "control" | "preset"
export interface ConfirmRequest {
	kind: ConfirmKind
	/** Text after the ▶ glyph, e.g. "restart readsb · up 51s · pid 1531". */
	prompt: string
	yes: string
	no: string
	/** Extra clause appended to the prompt after " · ", e.g. the bias-t warning. */
	extra?: string
	intent: WriteIntent
	presetIndex?: number
}

export interface MessagesUi {
	following: boolean
	/** Newest seq visible when the feed was paused; null while following. */
	pausedAtSeq: number | null
	filterText: string
	/** Non-null while the filter input row is open. */
	draft: string | null
	preset: PresetName
}

export interface DetailUi {
	open: boolean
	scroll: number
}

export interface UiState {
	view: ViewId
	help: boolean
	confirm: ConfirmRequest | null
	/** Selected row id per view (decoder id, or message seq as a string). */
	selected: Record<ViewId, string | null>
	detail: Record<ViewId, DetailUi>
	messages: MessagesUi
	edit: TunerEditState | null
	notice: { text: string; at: number } | null
	quit: boolean
	/** Bumped by `r` after a render error to remount the tree. */
	epoch: number
}

function perView<T>(make: () => T): Record<ViewId, T> {
	const out = {} as Record<ViewId, T>
	for (const v of VIEW_ORDER) out[v] = make()
	return out
}

export function initialUi(view: ViewId): UiState {
	return {
		view,
		help: false,
		confirm: null,
		selected: perView(() => null),
		detail: perView(() => ({ open: false, scroll: 0 })),
		messages: {
			following: true,
			pausedAtSeq: null,
			filterText: "",
			draft: null,
			preset: "all",
		},
		edit: null,
		notice: null,
		quit: false,
		epoch: 0,
	}
}
```

- [ ] **Step 8: Write `cli/source/views/types.ts`**

This file is imported only by `.tsx` files. `data/`, `ui/` and `view-models/` never import it.

```ts
import type { ReactElement } from "react"
import type { AppState, WriteIntent } from "../data/types.js"
import type { Action, ViewId, ViewKeyCtx } from "../ui/actions.js"
import type { HeightClass, WidthClass } from "../ui/line.js"
import type { UiState } from "../ui/ui-state.js"

export interface ViewProps {
	state: AppState
	ui: UiState
	/** Content width excluding the 1-column left gutter. */
	width: number
	/** Content rows available to the view. */
	height: number
	heightClass: HeightClass
	widthClass: WidthClass
}

export type Effect =
	| { kind: "write"; intent: WriteIntent }
	| { kind: "copy"; text: string }

export interface ViewOutcome {
	ui: UiState
	effects: Effect[]
}

export interface ViewKeyInfo {
	/** Selectable row ids in display order (top → bottom). */
	rowIds: string[]
	pageSize: number
	ctx: ViewKeyCtx
}

export interface ViewModule {
	id: ViewId
	title: string
	Component: (props: ViewProps) => ReactElement
	keyInfo(state: AppState, ui: UiState, width: number, height: number): ViewKeyInfo
	/** View-specific actions. Return undefined to fall back to applyUiAction. */
	onAction?(action: Action, state: AppState, ui: UiState): ViewOutcome | undefined
}
```

- [ ] **Step 9: Write `cli/source/test/scenario-types.ts`**

```ts
export type ScenarioName =
	| "live"
	| "idle"
	| "api-down"
	| "api-down-cached"
	| "ws-only"
	| "rest-only"
	| "dropping"
	| "crash-loop"
	| "legacy"
	| "long-text"
	| "burst"

export const SCENARIO_NAMES: readonly ScenarioName[] = [
	"live",
	"idle",
	"api-down",
	"api-down-cached",
	"ws-only",
	"rest-only",
	"dropping",
	"crash-loop",
	"legacy",
	"long-text",
	"burst",
]

export interface ScenarioRest {
	status: number
	body?: unknown
}

/** A WS frame as core sends it, replayed at (now − conn.wsAgoMs) + offsetMs (offset ≤ 0). */
export interface ScenarioFrame {
	offsetMs: number
	type: string
	channel: string
	data: unknown
}

/** An earlier REST answer: the current body of `path`, with `merge[id]` deep-merged into the array item whose `id` (or `sourceId`) matches. */
export interface ScenarioHistory {
	offsetMs: number
	path: string
	merge: Record<string, unknown>
}

export interface ScenarioConn {
	rest: "ok" | "down"
	ws: "open" | "closed"
	/** false = cold start with the API down: no REST success was ever seen. */
	cached: boolean
	/** Age of the last REST success at `now` (default 2000). */
	restAgoMs?: number
	/** For rest "down": how long it has been failing (default 1000). */
	downForMs?: number
	/** Replayed WS frames are timestamped at now − wsAgoMs + offsetMs (default: restAgoMs). */
	wsAgoMs?: number
	/** For rest "down": "ECONNREFUSED" or "timeout". */
	restError?: string
	/** For ws "closed": close code (default 1006) and age of the close (default = downForMs). */
	closeCode?: number
	wsClosedAgoMs?: number
}

export interface ScenarioTransform {
	/** Strip `activity` from sources and `totalBytesWritten` from all fanout bodies (older core). */
	legacy?: boolean
	/** Rewrite every decoder branch so Δdropped = pct% of Δoffered between consecutive snapshots. */
	dropPercent?: number
	/** Remove every decoder:output frame (no decodes observed). */
	noOutputs?: boolean
}

export interface Scenario {
	name: string
	description: string
	extends?: string
	/** ISO clock of the fixture (UTC). */
	now: string
	conn: ScenarioConn
	/** Keyed by REST path, e.g. "/api/decoders". */
	rest: Record<string, ScenarioRest>
	/** Per-path, per-id deep merges applied after `extends` (arrays matched by id/sourceId). */
	restPatch?: Record<string, Record<string, unknown>>
	restHistory?: ScenarioHistory[]
	ws: ScenarioFrame[]
	wsAppend?: ScenarioFrame[]
	transform?: ScenarioTransform
	/** Canned write results for the mock, keyed "METHOD /path/with/:params". */
	actions?: Record<string, ScenarioRest>
}
```

- [ ] **Step 10: Run the store test and the CLI typecheck**

```bash
pnpm exec vitest run tests/unit/cli/store.test.ts
pnpm --filter @wavekit/api-types build && pnpm exec tsc --noEmit -p tsconfig.json
pnpm --filter @wavekit/cli typecheck
```
Expected: the test passes, and both typechecks exit 0. The root typecheck compiles `data/store.ts` under strict flags through the test import.

- [ ] **Step 11: Commit**

```bash
git add cli/source/data/types.ts cli/source/data/store.ts cli/source/ui/line.ts cli/source/ui/actions.ts cli/source/ui/ui-state.ts cli/source/views/types.ts cli/source/test/scenario-types.ts tests/unit/cli/store.test.ts
git commit -m "feat(cli): shared contracts for the dashboard overhaul

AppState/Lane/Inbound, spans and lines, actions, UI state, view registry
and scenario types (spec §10.5, §11, §14).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 3: Theme, text measurement and copy rules

**Owner:** A · **Spec:** §5.2 (cellWidth, sanitize), §8 (glyphs, roles, NO_COLOR), §9 (banned words), P7

**Files:**
- Create: `cli/source/ui/theme.ts`
- Create: `cli/source/ui/text.ts`
- Create: `cli/source/ui/copy-rules.ts`
- Test: `tests/unit/cli/text.test.ts`
- Test: `tests/unit/cli/copy-rules.test.ts`

**Interfaces:**
- Consumes: `Role`, `Line`, `Span` from `ui/line.ts`.
- Produces:
  - `theme.ts`: `Glyphs`, `UTF8_GLYPHS`, `ASCII_GLYPHS`, `setGlyphMode(m: "utf8" | "ascii"): void`, `glyphs(): Glyphs`, `detectGlyphMode(env): "utf8" | "ascii"`, `detectColor(env, isTTY: boolean): boolean`, `InkTextProps`, `roleProps(role: Role, color: boolean, bold?: boolean): InkTextProps`.
  - `text.ts`: `stripAnsi`, `charWidth`, `cellWidth`, `sanitize`, `truncate(s, w)`, `padEnd(s, w)`, `padStart(s, w)`, `lineWidth(line)`, `lineText(line)`, `truncateLine(line, w)`, `padLine(line, w)`.
  - `copy-rules.ts`: `BANNED_RULES`, `stripQuoted(text)`, `findBanned(text): string[]`.

- [ ] **Step 1: Write the failing text tests (P7)**

`tests/unit/cli/text.test.ts`:

```ts
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import {
	cellWidth,
	padEnd,
	sanitize,
	stripAnsi,
	truncate,
	truncateLine,
	lineWidth,
} from "../../../cli/source/ui/text.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

describe("cellWidth", () => {
	it("counts ASCII, glyphs, wide and combining characters", () => {
		expect(cellWidth("api ● 2s")).toBe(8)
		expect(cellWidth("漢字")).toBe(4)
		expect(cellWidth("é")).toBe(1)
		expect(cellWidth("\x1b[31mred\x1b[0m")).toBe(3)
		expect(stripAnsi("\x1b]52;c;Zm9v\x07x")).toBe("x")
	})
})

describe("sanitize", () => {
	it("strips controls, expands tabs and replaces emoji", () => {
		expect(sanitize("a\tb\x1b[2Jc\r\nd\u0085e")).toBe("a b[2Jcde")
		expect(sanitize("hi 🚀")).toBe("hi ?")
	})

	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2
	it("P7: sanitize output has no C0, C1, ESC or DEL and is idempotent", () => {
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), s => {
				const once = sanitize(s)
				expect(CONTROL.test(once)).toBe(false)
				expect(sanitize(once)).toBe(once)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 7: sanitize and truncate
	// Validates: spec §5.2
	it("P7: truncate(s, w) fits w and ends in … iff the input was wider", () => {
		fc.assert(
			fc.property(
				fc.string({ unit: "grapheme" }).map(sanitize),
				fc.integer({ min: 1, max: 80 }),
				(s, w) => {
					const out = truncate(s, w)
					expect(cellWidth(out)).toBeLessThanOrEqual(w)
					if (cellWidth(s) > w) expect(out.endsWith("…")).toBe(true)
					else expect(out).toBe(s)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("truncate in ASCII mode", () => {
	afterEach(() => setGlyphMode("utf8"))
	it("uses a 3-column ellipsis and still fits", () => {
		setGlyphMode("ascii")
		expect(truncate("abcdefghij", 6)).toBe("abc...")
		expect(cellWidth(truncate("abcdefghij", 2))).toBeLessThanOrEqual(2)
	})
})

describe("line helpers", () => {
	it("truncates a span line to width with a trailing ellipsis", () => {
		const line = [
			{ text: "api ", role: "label" as const },
			{ text: "● 2s", role: "live" as const },
		]
		const cut = truncateLine(line, 5)
		expect(lineWidth(cut)).toBe(5)
		expect(cut.map(s => s.text).join("")).toBe("api …")
		expect(padEnd("ab", 4)).toBe("ab  ")
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/text.test.ts`
Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 3: Write `cli/source/ui/theme.ts`**

```ts
import type { Role } from "./line.js"

export interface Glyphs {
	live: string
	neutral: string
	fault: string
	attention: string
	unknown: string
	na: string
	ellipsis: string
	sep: string
	gap: string
	up: string
	down: string
	confirm: string
	cursor: string
	range: string
	spark: readonly string[]
}

export const UTF8_GLYPHS: Glyphs = {
	live: "●",
	neutral: "○",
	fault: "×",
	attention: "!",
	unknown: "?",
	na: "—",
	ellipsis: "…",
	sep: "·",
	gap: "─",
	up: "↑",
	down: "↓",
	confirm: "▶",
	cursor: "▏",
	range: "–",
	spark: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
}

export const ASCII_GLYPHS: Glyphs = {
	live: "*",
	neutral: "o",
	fault: "x",
	attention: "!",
	unknown: "?",
	na: "-",
	ellipsis: "...",
	sep: "|",
	gap: "-",
	up: "^",
	down: "v",
	confirm: ">",
	cursor: "|",
	range: "-",
	spark: ["_", ".", "-", "=", "+", "*", "#", "@"],
}

let mode: "utf8" | "ascii" = "utf8"

/** Set once in cli.tsx before rendering; tests reset it to "utf8". */
export function setGlyphMode(next: "utf8" | "ascii"): void {
	mode = next
}

export function glyphs(): Glyphs {
	return mode === "ascii" ? ASCII_GLYPHS : UTF8_GLYPHS
}

type Env = Readonly<Record<string, string | undefined>>

export function detectGlyphMode(env: Env): "utf8" | "ascii" {
	if (env["WAVEKIT_ASCII"] === "1") return "ascii"
	const locale = env["LC_ALL"] || env["LC_CTYPE"] || env["LANG"]
	if (locale === undefined || locale === "") return "utf8"
	return /utf-?8/i.test(locale) ? "utf8" : "ascii"
}

export function detectColor(env: Env, isTTY: boolean): boolean {
	const noColor = env["NO_COLOR"]
	if (noColor !== undefined && noColor !== "") return false
	return isTTY
}

export interface InkTextProps {
	color?: string
	bold?: boolean
	dimColor?: boolean
	inverse?: boolean
}

const ROLE_STYLE: Readonly<Record<Role, InkTextProps>> = {
	label: { dimColor: true },
	value: {},
	live: { color: "green" },
	neutral: {},
	fault: { color: "red" },
	attention: { color: "yellow" },
	unknown: {},
	old: { dimColor: true },
	accent: { color: "cyan" },
	selected: { color: "cyan", inverse: true, bold: true },
	edit: { color: "magenta", bold: true },
}

/** Role → Ink <Text> props. Without colour, keep bold/dim/inverse only (spec §8). */
export function roleProps(role: Role, color: boolean, bold = false): InkTextProps {
	const base = ROLE_STYLE[role]
	const out: InkTextProps = {}
	if (color && base.color !== undefined) out.color = base.color
	if (base.dimColor === true) out.dimColor = true
	if (base.inverse === true) out.inverse = true
	if (base.bold === true || bold) out.bold = true
	return out
}
```

- [ ] **Step 4: Write `cli/source/ui/text.ts`**

```ts
import type { Line, Span } from "./line.js"
import { glyphs } from "./theme.js"

// CSI, OSC (BEL or ST terminated) and 2-byte ESC sequences.
const ANSI_RE =
	/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/gu
const ZERO_WIDTH_RE = /^[\p{Mn}\p{Me}​-‏︀-️]$/u

export function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

function isWide(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x3fffd)
	)
}

export function charWidth(ch: string): 0 | 1 | 2 {
	if (ZERO_WIDTH_RE.test(ch)) return 0
	const cp = ch.codePointAt(0) ?? 0
	if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
	return isWide(cp) ? 2 : 1
}

export function cellWidth(s: string): number {
	let w = 0
	for (const ch of stripAnsi(s)) w += charWidth(ch)
	return w
}

/** Payload strings only: strip ESC sequences and C0/C1/DEL, tabs → space, emoji → "?". Idempotent. */
export function sanitize(s: string): string {
	// Order matters for idempotence: removing a control could otherwise join a
	// pictograph and U+FE0F into a new emoji sequence.
	return s.replace(/\t/g, " ").replace(CONTROL_RE, "").replace(EMOJI_RE, "?")
}

/** Width ≤ w; ends with the ellipsis glyph iff the input was wider than w. */
export function truncate(s: string, w: number): string {
	if (w <= 0) return ""
	if (cellWidth(s) <= w) return s
	const ell = glyphs().ellipsis
	const ellW = cellWidth(ell)
	if (ellW > w) return ".".repeat(w)
	let out = ""
	let used = 0
	for (const ch of s) {
		const cw = charWidth(ch)
		if (used + cw > w - ellW) break
		out += ch
		used += cw
	}
	return out + ell
}

export function padEnd(s: string, w: number): string {
	const t = truncate(s, w)
	return t + " ".repeat(Math.max(0, w - cellWidth(t)))
}

export function padStart(s: string, w: number): string {
	const t = truncate(s, w)
	return " ".repeat(Math.max(0, w - cellWidth(t))) + t
}

export function lineWidth(line: Line): number {
	let w = 0
	for (const s of line) w += cellWidth(s.text)
	return w
}

export function lineText(line: Line): string {
	return line.map(s => s.text).join("")
}

/** Cut a span line to width w, ending in the ellipsis glyph when it was wider. */
export function truncateLine(line: Line, w: number): Line {
	if (lineWidth(line) <= w) return line
	const ell = glyphs().ellipsis
	const budget = w - cellWidth(ell)
	const out: Span[] = []
	let used = 0
	for (const span of line) {
		const sw = cellWidth(span.text)
		if (used + sw <= budget) {
			out.push(span)
			used += sw
			continue
		}
		let part = ""
		for (const ch of span.text) {
			const cw = charWidth(ch)
			if (used + cw > budget) break
			part += ch
			used += cw
		}
		if (part !== "") out.push({ ...span, text: part })
		const last = out[out.length - 1]
		out.push({ text: budget < 0 ? ".".repeat(w) : ell, role: last?.role ?? span.role })
		return out
	}
	return out
}

/** Pad a line with trailing spaces to exactly w (truncating first if wider). */
export function padLine(line: Line, w: number): Line {
	const cut = truncateLine(line, w)
	const gap = w - lineWidth(cut)
	return gap > 0 ? [...cut, { text: " ".repeat(gap), role: "value" }] : cut
}
```

- [ ] **Step 5: Run the text tests**

Run: `pnpm exec vitest run tests/unit/cli/text.test.ts`
Expected: PASS. Note that `sanitize` removes ESC (0x1b) but keeps the printable `[2J` tail, which is harmless once ESC is gone.

- [ ] **Step 6: Write the failing copy-rules test**

`tests/unit/cli/copy-rules.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { findBanned, stripQuoted } from "../../../cli/source/ui/copy-rules.js"

describe("findBanned", () => {
	it("flags verdicts, filler and blame words", () => {
		expect(findBanned("receiver OK")).toContain("OK")
		expect(findBanned("Loading decoders")).toContain("Loading")
		expect(findBanned("decoder is slow")).toContain("slow")
		expect(findBanned("No messages yet")).toContain("No … yet")
		expect(findBanned("Status: up")).toContain("Status:")
		expect(findBanned("Connected")).toContain("Connected")
		expect(findBanned("all done!")).toContain("sentence !")
		expect(findBanned("rocket 🚀")).toContain("emoji")
	})
	it("accepts the spec's own copy", () => {
		const ok = [
			" api ● 2s  iq ● streaming · 4.1 MB/s  drops !34% now",
			" ! API unreachable · ECONNREFUSED · retry in 4s",
			" ● readsb  up 51s  none for 51s  !38%  out",
			" sent · frequency ok 18:07:52 · gain ok",
			" ▶ restart readsb · up 51s · pid 1531   y restart  n cancel",
			" squawk !7700 emergency",
			" iq ● connected · no samples",
		]
		for (const line of ok) expect(findBanned(line)).toEqual([])
	})
	it("ignores server text inside double quotes", () => {
		expect(stripQuoted('CORE reports "healthy"')).toBe('CORE reports ""')
		expect(findBanned('CORE reports "healthy"')).toEqual([])
	})
})
```

- [ ] **Step 7: Write `cli/source/ui/copy-rules.ts`**

```ts
export interface BannedRule {
	id: string
	re: RegExp
}

/** Spec §9 banned list plus T8 blame words. Matched after stripQuoted(). */
export const BANNED_RULES: readonly BannedRule[] = [
	{ id: "Waiting for", re: /\bWaiting for\b/i },
	{ id: "No … yet", re: /\bNo\b.*\byet\b/ },
	{ id: "Loading", re: /\bLoading\b/i },
	{ id: "OK", re: /\bOK\b/ },
	{ id: "healthy", re: /\b(?:un)?healthy\b/i },
	{ id: "stable", re: /\bstable\b/i },
	{ id: "all good", re: /\ball good\b/i },
	{ id: "Status:", re: /\bStatus:/ },
	{ id: "n/a", re: /\bn\/a\b/i },
	{ id: "unavailable", re: /\bunavailable\b(?! ·)/i },
	{ id: "successfully", re: /\bsuccessfully\b/i },
	{ id: "please", re: /\bplease\b/i },
	{ id: "sentence !", re: /[A-Za-z0-9)]!(?=\s|$)/ },
	{ id: "360°", re: /360°/ },
	{ id: "press N to view", re: /\bpress \S+ to view\b/i },
	{ id: "Connected", re: /\bConnected\b/ },
	{ id: "slow", re: /\bslow\b/i },
	{ id: "lagging", re: /\blagging\b/i },
	{ id: "overloaded", re: /\boverloaded\b/i },
	{ id: "bottleneck", re: /\bbottleneck\b/i },
	{ id: "emoji", re: /\p{Emoji_Presentation}/u },
]

/** Server-quoted text ("…") is shown verbatim and is exempt from the copy rules. */
export function stripQuoted(text: string): string {
	return text.replace(/"[^"\n]*"/g, '""')
}

export function findBanned(text: string): string[] {
	const t = stripQuoted(text)
	return BANNED_RULES.filter(r => r.re.test(t)).map(r => r.id)
}
```

- [ ] **Step 8: Run both test files**

Run: `pnpm exec vitest run tests/unit/cli/text.test.ts tests/unit/cli/copy-rules.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add cli/source/ui/theme.ts cli/source/ui/text.ts cli/source/ui/copy-rules.ts tests/unit/cli/text.test.ts tests/unit/cli/copy-rules.test.ts
git commit -m "feat(cli): glyph/role theme, cell-width text helpers, banned-copy rules

Property 7 (sanitize/truncate) per spec §5.2.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 4: Ink render harness

**Owner:** A · **Spec:** §13.2 (harness), research (a)–(c) on Ink debug mode, stdin and key parsing

**Files:**
- Create: `cli/source/test/harness.ts`
- Test: `cli/source/test/harness.test.tsx`
- Modify: `cli/package.json` (the `test` script only: drop `--passWithNoTests`)

**Interfaces:**
- Produces:
  ```ts
  export interface RenderHandle {
  	frame(): string[]           // last full frame, ANSI stripped, split on "\n"
  	text(): string              // frame().join("\n")
  	press(seq: string): Promise<void>  // one key per call; settles afterwards
  	resize(cols: number, rows: number): Promise<void>
  	rerender(el: ReactElement): Promise<void>
  	writes(): readonly string[]
  	unmount(): void
  }
  export function renderAt(el: ReactElement, size: { cols: number; rows: number }): Promise<RenderHandle>
  export function settle(ms?: number): Promise<void>
  export const KEYS: { up; down; left; right; pgup; pgdn; enter; esc; tab; shiftTab; backspace; ctrlC; space }
  ```

- [ ] **Step 1: Write the failing smoke test**

`cli/source/test/harness.test.tsx`:

```tsx
import { Text, useInput } from "ink"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { KEYS, renderAt } from "./harness.js"

function Echo() {
	const [last, setLast] = useState("none")
	useInput((input, key) => {
		if (key.escape) setLast("esc")
		else if (key.upArrow) setLast("up")
		else if (key.backspace || key.delete) setLast("backspace")
		else setLast(`input:${input}`)
	})
	return <Text>last {last}</Text>
}

describe("render harness", () => {
	it("captures the last full frame", async () => {
		const h = await renderAt(<Text>hello</Text>, { cols: 80, rows: 24 })
		expect(h.frame()).toEqual(["hello"])
		h.unmount()
	})
	it("delivers one key per chunk", async () => {
		const h = await renderAt(<Echo />, { cols: 80, rows: 24 })
		await h.press("q")
		expect(h.text()).toBe("last input:q")
		await h.press(KEYS.up)
		expect(h.text()).toBe("last up")
		await h.press(KEYS.backspace)
		expect(h.text()).toBe("last backspace")
		await h.press(KEYS.esc)
		expect(h.text()).toBe("last esc")
		h.unmount()
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @wavekit/cli test`
Expected: FAIL, `Cannot find module './harness.js'`.

- [ ] **Step 3: Write `cli/source/test/harness.ts`**

```ts
import { EventEmitter } from "node:events"
import { render } from "ink"
import type { ReactElement } from "react"
import { stripAnsi } from "../ui/text.js"

class FakeStdout extends EventEmitter {
	columns: number
	rows: number
	isTTY = false
	readonly chunks: string[] = []
	constructor(cols: number, rows: number) {
		super()
		this.columns = cols
		this.rows = rows
	}
	write(chunk: string): boolean {
		this.chunks.push(chunk)
		return true
	}
}

class FakeStdin extends EventEmitter {
	isTTY = true
	private readonly queue: string[] = []
	setRawMode(): this {
		return this
	}
	setEncoding(): this {
		return this
	}
	ref(): this {
		return this
	}
	unref(): this {
		return this
	}
	resume(): this {
		return this
	}
	pause(): this {
		return this
	}
	read(): string | null {
		return this.queue.shift() ?? null
	}
	feed(chunk: string): void {
		this.queue.push(chunk)
		this.emit("readable")
	}
}

export const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	pgup: "\x1b[5~",
	pgdn: "\x1b[6~",
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	backspace: "\x7f",
	ctrlC: "\x03",
	space: " ",
} as const

export function settle(ms = 15): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

export interface RenderHandle {
	frame(): string[]
	text(): string
	press(seq: string): Promise<void>
	resize(cols: number, rows: number): Promise<void>
	rerender(el: ReactElement): Promise<void>
	writes(): readonly string[]
	unmount(): void
}

/** Ink debug mode writes the full frame on every commit; the last non-empty write is the current frame. */
export async function renderAt(
	el: ReactElement,
	size: { cols: number; rows: number },
): Promise<RenderHandle> {
	const stdout = new FakeStdout(size.cols, size.rows)
	const stdin = new FakeStdin()
	const instance = render(el, {
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: stdout as unknown as NodeJS.WriteStream,
		stdin: stdin as unknown as NodeJS.ReadStream,
		debug: true,
		exitOnCtrlC: false,
		patchConsole: false,
	})
	// useInput attaches in a passive effect; input sent before it flushes is dropped.
	await settle()
	const frame = (): string[] => {
		for (let i = stdout.chunks.length - 1; i >= 0; i--) {
			const chunk = stdout.chunks[i] ?? ""
			const plain = stripAnsi(chunk)
			if (plain.trim() !== "") return plain.split("\n")
		}
		return []
	}
	return {
		frame,
		text: () => frame().join("\n"),
		press: async seq => {
			stdin.feed(seq)
			await settle()
		},
		resize: async (cols, rows) => {
			stdout.columns = cols
			stdout.rows = rows
			stdout.emit("resize")
			// use-terminal-size debounces 50 ms.
			await settle(90)
		},
		rerender: async next => {
			instance.rerender(next)
			await settle()
		},
		writes: () => stdout.chunks,
		unmount: () => {
			instance.unmount()
			instance.cleanup()
		},
	}
}
```

- [ ] **Step 4: Drop `--passWithNoTests` from `cli/package.json`**

Change `"test": "vitest run --passWithNoTests",` to `"test": "vitest run",`.

- [ ] **Step 5: Run the CLI tests and typecheck**

```bash
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli typecheck
```
Expected: 2 tests pass and the typecheck exits 0. If `press` assertions see the previous frame, raise the `settle()` default to 30 ms and note it in the commit.

- [ ] **Step 6: Run the phase 0 gate**

Run the full **Phase gate** command list from Global Constraints. Expected: everything exits 0.

- [ ] **Step 7: Commit**

```bash
git add cli/source/test/harness.ts cli/source/test/harness.test.tsx cli/package.json
git commit -m "test(cli): fake-stdout Ink render harness with key and resize helpers

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

## Phase 1 — logic in parallel

Phase 1 starts after the phase 0 gate. A, B and C work in parallel on disjoint files.

### Task 5: Freshness and memo (A)

**Owner:** A · **Spec:** T1, T2, T6, §10.10, P17

**Files:**
- Create: `cli/source/data/freshness.ts`
- Create: `cli/source/data/memo.ts`
- Test: `tests/unit/cli/freshness.test.ts`

**Interfaces:**
- Consumes: `Lane`, `LaneError`, `LaneOrigin`, `ConnState`, `MetricBeat`, `ApiView`, `IqView`, `GlyphRole` from `data/types.ts`. `ExtendedSourceStatus` from `@wavekit/api-types`.
- Produces:
  - `LANE_TTL_MS = 15_000`
  - `emptyLane<T>(origin?: LaneOrigin): Lane<T>`
  - `laneOk<T>(value: T, at: number, origin: LaneOrigin): Lane<T>`
  - `laneFail<T>(lane: Lane<T>, error: LaneError): Lane<T>`
  - `laneAge(lane, now): number | null`, `isOld(lane, now): boolean`, `isFresh(lane, now): boolean`, `hasData(lane): boolean`
  - `restFresh(conn: ConnState, now: number): boolean`
  - `apiView(conn: ConnState, now: number): ApiView`
  - `iqView(source: ExtendedSourceStatus | undefined, sourceFresh: boolean, beat: MetricBeat | undefined, now: number): IqView`
  - `iqSummary(sources: Lane<ExtendedSourceStatus[]>, metrics: Record<string, MetricBeat>, now: number): IqView`
  - `memoOne<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R`

- [ ] **Step 1: Write the failing tests**

This file also carries the cases migrated from `tests/unit/cli/source-activity.test.ts`. The old file is deleted in Task 44, and the stale boundary moves to `> 15 000 ms` per P17.

`tests/unit/cli/freshness.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import {
	LANE_TTL_MS,
	apiView,
	emptyLane,
	iqSummary,
	iqView,
	isOld,
	laneFail,
	laneOk,
} from "../../../cli/source/data/freshness.js"
import { memoOne } from "../../../cli/source/data/memo.js"
import type { ConnState, LaneError } from "../../../cli/source/data/types.js"

function source(over: Partial<ExtendedSourceStatus> = {}): ExtendedSourceStatus {
	return {
		id: "pi-iq",
		connected: true,
		consumers: 9,
		bytesReceived: 1,
		dataRate: 3994,
		reconnectAttempts: 0,
		caps: { kind: "iq", sampleRate: 2048000, format: "U8_IQ", exclusive: false },
		assignments: [],
		available: true,
		activity: { state: "streaming", lastSampleAt: null, sampleAgeMs: 4, timeoutMs: 10000 },
		...over,
	}
}

function conn(over: Partial<ConnState["rest"]> = {}, ws: ConnState["ws"]["state"] = "open"): ConnState {
	return {
		target: { base: "http://127.0.0.1:9000", ws: "ws://127.0.0.1:9000/ws" },
		discovery: { mode: "explicit", tried: [] },
		ws: { state: ws, since: 0, code: null, reason: null, nextRetryAt: null, attempt: 0 },
		rest: { lastOkAt: null, lastCycleAt: null, nextAt: null, failing: [], firstFailAt: null, lastError: null, ...over },
		invalidFrames: 0,
		rejectedItems: 0,
		lastEventAt: null,
	}
}

describe("migrated source-activity cases", () => {
	it("expires cached streaming after a failed refresh and recovers on a new snapshot", () => {
		const s = source()
		const fresh = (receivedAt: number | null, now: number) =>
			receivedAt !== null && !isOld({ value: [s], receivedAt, origin: "rest" }, now)
		expect(iqView(s, fresh(1000, 15999), undefined, 15999).word).toBe("streaming")
		expect(iqView(s, fresh(1000, 16001), undefined, 16001).word).toBe("unknown")
		expect(iqView(s, fresh(1000, 30000), undefined, 30000).word).toBe("unknown")
		expect(iqView(s, fresh(30000, 30001), undefined, 30001).word).toBe("streaming")
		expect(iqView(s, fresh(null, 30000), undefined, 30000).word).toBe("unknown")
	})
	it("does not infer streaming from an older server's connected flag", () => {
		const { activity: _a, ...old } = source()
		expect(iqView(old as ExtendedSourceStatus, true, undefined, 0).word).toBe("connected")
		expect(iqView({ ...(old as ExtendedSourceStatus), connected: false }, true, undefined, 0).word).toBe("disconnected")
	})
})

describe("iqView (T2)", () => {
	it("maps activity states to words and glyphs", () => {
		const v = (state: "waiting" | "stale" | "paused" | "ended" | "disconnected") =>
			iqView(source({ activity: { state, lastSampleAt: null, sampleAgeMs: 23000, timeoutMs: 10000 } }), true, undefined, 0)
		expect(v("waiting")).toMatchObject({ glyph: "neutral", word: "connected · no samples" })
		expect(v("stale")).toMatchObject({ glyph: "fault", word: "no samples", ageMs: 23000 })
		expect(v("paused").word).toBe("paused")
		expect(v("ended").word).toBe("ended")
		expect(v("disconnected")).toMatchObject({ glyph: "fault", word: "disconnected" })
	})
	it("falls back to the WS metrics heartbeat as `receiving`", () => {
		const beat = { bytesReceived: 1, dataRateKiB: 3994, at: 1000 }
		expect(iqView(source(), false, beat, 5000)).toMatchObject({ glyph: "live", word: "receiving", rateBytesPerSec: 3994 * 1024 })
		expect(iqView(source(), false, { ...beat, dataRateKiB: 0 }, 5000).word).toBe("unknown")
		expect(iqView(source(), false, beat, 1000 + LANE_TTL_MS + 1).word).toBe("unknown")
	})
	it("summarises two sources with the worst glyph (review focus 5)", () => {
		const lane = laneOk(
			[
				source(),
				source({ id: "b", activity: { state: "stale", lastSampleAt: null, sampleAgeMs: 30000, timeoutMs: 10000 } }),
			],
			1000,
			"rest",
		)
		expect(iqSummary(lane, {}, 2000)).toMatchObject({ glyph: "fault", word: "1/2 streaming" })
	})
	it("is unknown with no sources and no heartbeat", () => {
		expect(iqSummary(emptyLane(), {}, 0)).toMatchObject({ glyph: "unknown", word: "unknown" })
	})
})

describe("apiView (T1)", () => {
	it("is ok only when WS is open and REST is fresh", () => {
		expect(apiView(conn({ lastOkAt: 8000 }), 10000)).toEqual({ kind: "ok", restAgeMs: 2000 })
		expect(apiView(conn({ lastOkAt: 8000 }, "closed"), 10000)).toEqual({ kind: "split", ws: false, rest: true, restAgeMs: 2000 })
		expect(apiView(conn({ lastOkAt: 0 }), 45000)).toEqual({ kind: "split", ws: true, rest: false, restAgeMs: 45000 })
		expect(apiView(conn({ lastOkAt: 0 }, "closed"), 180000)).toEqual({ kind: "down", sinceMs: 180000 })
		expect(apiView(conn({}, "connecting"), 1000)).toEqual({ kind: "connecting" })
		expect(apiView(conn({ firstFailAt: 500 }, "closed"), 1000)).toEqual({ kind: "down", sinceMs: 500 })
	})
})

describe("lanes", () => {
	const err: LaneError = { kind: "network", message: "ECONNREFUSED", at: 5 }

	// Feature: cli-dashboard-overhaul, Property 17: freshness
	// Validates: spec T6, §10.10
	it("P17: old iff age > TTL; errors keep values; success clears errors", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 1e9 }), fc.integer({ min: 0, max: 100000 }), fc.anything(), (at, age, value) => {
				const lane = laneOk(value, at, "rest")
				expect(isOld(lane, at + age)).toBe(age > LANE_TTL_MS)
				const failed = laneFail(lane, err)
				expect(failed.value).toBe(value)
				expect(failed.receivedAt).toBe(at)
				expect(failed.error).toEqual(err)
				const healed = laneOk(value, at + age, "rest")
				expect(healed.error).toBeUndefined()
			}),
			{ numRuns: 100 },
		)
	})
	it("never-received lanes are not old (they are 'no data')", () => {
		expect(isOld(emptyLane(), 1e12)).toBe(false)
	})
})

describe("memoOne", () => {
	it("returns the cached result for identical arguments", () => {
		let calls = 0
		const f = memoOne((a: object, n: number) => {
			calls++
			return { a, n }
		})
		const a = {}
		expect(f(a, 1)).toBe(f(a, 1))
		expect(calls).toBe(1)
		f({}, 1)
		expect(calls).toBe(2)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/freshness.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `cli/source/data/memo.ts`**

```ts
/** Single-entry memo keyed on argument identity (Object.is). */
export function memoOne<A extends readonly unknown[], R>(
	fn: (...args: A) => R,
): (...args: A) => R {
	let last: { args: A; result: R } | null = null
	return (...args: A): R => {
		if (
			last !== null &&
			last.args.length === args.length &&
			last.args.every((a, i) => Object.is(a, args[i]))
		) {
			return last.result
		}
		const result = fn(...args)
		last = { args, result }
		return result
	}
}
```

- [ ] **Step 4: Write `cli/source/data/freshness.ts`**

```ts
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import type {
	ApiView,
	ConnState,
	GlyphRole,
	IqView,
	Lane,
	LaneError,
	LaneOrigin,
	MetricBeat,
} from "./types.js"

export const LANE_TTL_MS = 15_000

export function emptyLane<T>(origin: LaneOrigin = "rest"): Lane<T> {
	return { value: undefined, receivedAt: null, origin }
}

/** A success replaces the value and clears any error. */
export function laneOk<T>(value: T, at: number, origin: LaneOrigin): Lane<T> {
	return { value, receivedAt: at, origin }
}

/** An error never clears a cached value. */
export function laneFail<T>(lane: Lane<T>, error: LaneError): Lane<T> {
	return { value: lane.value, receivedAt: lane.receivedAt, origin: lane.origin, error }
}

export function laneAge<T>(lane: Lane<T>, now: number): number | null {
	return lane.receivedAt === null ? null : Math.max(0, now - lane.receivedAt)
}

export function isOld<T>(lane: Lane<T>, now: number): boolean {
	const age = laneAge(lane, now)
	return age !== null && age > LANE_TTL_MS
}

export function isFresh<T>(lane: Lane<T>, now: number): boolean {
	const age = laneAge(lane, now)
	return age !== null && age <= LANE_TTL_MS
}

export function hasData<T>(lane: Lane<T>): boolean {
	return lane.value !== undefined
}

export function restFresh(conn: ConnState, now: number): boolean {
	const ok = conn.rest.lastOkAt
	return ok !== null && now - ok <= LANE_TTL_MS
}

export function apiView(conn: ConnState, now: number): ApiView {
	const ws = conn.ws.state === "open"
	const rest = restFresh(conn, now)
	const restAgeMs = conn.rest.lastOkAt === null ? null : Math.max(0, now - conn.rest.lastOkAt)
	if (ws && rest) return { kind: "ok", restAgeMs: restAgeMs ?? 0 }
	if (!ws && !rest) {
		if (conn.rest.lastOkAt === null && conn.rest.firstFailAt === null && conn.ws.state !== "closed") {
			return { kind: "connecting" }
		}
		const since = conn.rest.lastOkAt ?? conn.rest.firstFailAt
		return { kind: "down", sinceMs: since === null ? null : Math.max(0, now - since) }
	}
	return { kind: "split", ws, rest, restAgeMs }
}

const UNKNOWN: IqView = { glyph: "unknown", word: "unknown", ageMs: null, rateBytesPerSec: null }

function beatFresh(beat: MetricBeat | undefined, now: number): beat is MetricBeat {
	return beat !== undefined && now - beat.at <= LANE_TTL_MS
}

/** T2: the word follows the evidence (activity → transport flag → WS heartbeat → unknown). */
export function iqView(
	source: ExtendedSourceStatus | undefined,
	sourceFresh: boolean,
	beat: MetricBeat | undefined,
	now: number,
): IqView {
	const liveBeat = beatFresh(beat, now) ? beat : undefined
	const rate = liveBeat
		? liveBeat.dataRateKiB * 1024
		: source && sourceFresh
			? source.dataRate * 1024
			: null
	if (source && sourceFresh) {
		const view = (glyph: GlyphRole, word: string, ageMs: number | null = null): IqView => ({
			glyph,
			word,
			ageMs,
			rateBytesPerSec: rate,
		})
		const a = source.activity
		if (a) {
			switch (a.state) {
				case "streaming":
					return view("live", "streaming")
				case "waiting":
					return view("neutral", "connected · no samples")
				case "stale":
					return view("fault", "no samples", a.sampleAgeMs)
				case "paused":
					return view("neutral", "paused")
				case "ended":
					return view("neutral", "ended")
				case "disconnected":
					return view("fault", "disconnected")
			}
		}
		return source.connected ? view("live", "connected") : view("fault", "disconnected")
	}
	if (liveBeat && liveBeat.dataRateKiB > 0) {
		return { glyph: "live", word: "receiving", ageMs: null, rateBytesPerSec: rate }
	}
	return UNKNOWN
}

const GLYPH_RANK: Readonly<Record<GlyphRole, number>> = { live: 0, neutral: 1, unknown: 2, fault: 3 }

export function iqSummary(
	sources: Lane<ExtendedSourceStatus[]>,
	metrics: Record<string, MetricBeat>,
	now: number,
): IqView {
	const fresh = isFresh(sources, now)
	const list = sources.value ?? []
	if (list.length === 0) {
		const beats = Object.values(metrics)
		return beats.length === 1 ? iqView(undefined, false, beats[0], now) : UNKNOWN
	}
	const views = list.map(s => iqView(s, fresh, metrics[s.id], now))
	const first = views[0]
	if (views.length === 1 && first) return first
	let worst: IqView = first ?? UNKNOWN
	for (const v of views) if (GLYPH_RANK[v.glyph] > GLYPH_RANK[worst.glyph]) worst = v
	const allSame = views.every(v => v.word === first?.word)
	const streaming = views.filter(v => v.word === "streaming").length
	const word = allSame && first ? `${views.length}/${views.length} ${first.word}` : `${streaming}/${views.length} streaming`
	const rates = views.map(v => v.rateBytesPerSec).filter((r): r is number => r !== null)
	return {
		glyph: worst.glyph,
		word,
		ageMs: null,
		rateBytesPerSec: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) : null,
	}
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/freshness.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/source/data/freshness.ts cli/source/data/memo.ts tests/unit/cli/freshness.test.ts
git commit -m "feat(cli): lane freshness, API/IQ evidence views and memoOne

Property 17; migrates the source-activity cases (old iff age > TTL).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 6: DTO guards (A)

**Owner:** A · **Spec:** §10.4, §6.5 sampling slot; research (a)/(c) wire shapes

**Files:**
- Create: `cli/source/data/guards.ts`
- Test: `tests/unit/cli/guards.test.ts`

**Interfaces:**
- Consumes: DTO types from `@wavekit/api-types` (`import type` only), plus `DecoderRow`, `CoreStatus`, `PresetMap`, `AircraftSnapshot`, `ResourceView`, `SdrHostView` and `WsEvent` from `data/types.ts`.
- Produces:
  - Primitives: `isObj`, `isStr`, `isNum`, `isBool`, `Guarded<T> = { value: T; rejected: number }`, `guardList<T>(v, guard): Guarded<T[]> | undefined`.
  - Guards, each `(v: unknown) => T | undefined`: `guardDecoder`, `guardDecoderCaps`, `guardSource`, `guardSourceCaps`, `guardTuner`, `guardRelay`, `guardFanout`, `guardResources`, `guardAlert`, `guardLiveAudioConfig`, `guardLiveAudioStatus`, `guardOutput`, `guardAircraftState`, `guardAircraftStats`, `guardAircraftSnapshot`, `guardCoreStatus`, `guardPresets`.
  - `readHostSampling(v: unknown): SdrHostSampling | undefined`.
  - `parseServerMessage(raw: unknown): WsEvent | undefined`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/guards.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
	guardCoreStatus,
	guardDecoder,
	guardFanout,
	guardList,
	guardPresets,
	guardResources,
	parseServerMessage,
	readHostSampling,
} from "../../../cli/source/data/guards.js"

const decoder = {
	id: "readsb",
	type: "readsb",
	running: true,
	health: "idle",
	pid: 1531,
	uptime: 51,
	stats: { bytesIn: 570600000, eventsOut: 0, errors: 6 },
	lastOutputAt: null,
	restartCount: 0,
	caps: { input: "iq", output: "jsonl", integrationPattern: "network_producer" },
}

describe("guardDecoder", () => {
	it("keeps required and well-typed optional fields", () => {
		expect(guardDecoder(decoder)).toMatchObject({ id: "readsb", pid: 1531, lastOutputAt: null })
	})
	it("drops a malformed optional field instead of rejecting", () => {
		const g = guardDecoder({ ...decoder, pid: "x", caps: { input: "??" } })
		expect(g).toBeDefined()
		expect(g && "pid" in g).toBe(false)
		expect(g && "caps" in g).toBe(false)
	})
	it("rejects a missing or mistyped required field", () => {
		expect(guardDecoder({ ...decoder, running: "yes" })).toBeUndefined()
		expect(guardDecoder({ ...decoder, health: "degraded" })).toBeUndefined()
		expect(guardDecoder(null)).toBeUndefined()
	})
	it("filters arrays element by element and counts rejects", () => {
		expect(guardList([decoder, { id: 1 }, decoder], guardDecoder)).toMatchObject({ rejected: 1, value: [{ id: "readsb" }, { id: "readsb" }] })
		expect(guardList({}, guardDecoder)).toBeUndefined()
	})
})

describe("guardFanout", () => {
	it("accepts snapshots without totalBytesWritten (older core)", () => {
		const snap = {
			timestamp: "2026-10-08T18:07:49.000Z",
			branches: [
				{ id: "decoder-readsb", decoderId: "readsb", backpressureActive: true, backpressureEnterCount: 121, droppedBytesTotal: 5, droppedChunksTotal: 1, bufferBytes: 389120, highWaterMark: 262144 },
			],
			backpressureActiveCount: 1,
			droppedBytesTotal: 5,
			droppedChunksTotal: 1,
		}
		const g = guardFanout(snap)
		expect(g?.branches[0]?.totalBytesWritten).toBeUndefined()
		expect(g?.totalBytesWritten).toBeUndefined()
	})
})

describe("readHostSampling", () => {
	const sampling = {
		state: "streaming",
		reason: null,
		timeoutMs: 5000,
		lastSampleAt: "2026-10-08T18:07:49.800Z",
		sampleAgeMs: 200,
		upstream: { bytesTotal: 1, bytesPerSec: 4096000, windowMs: 2000, expectedBytesPerSec: 4096000, rateBasis: "configured", rateStatus: "nominal" },
		epoch: { rtlmuxPid: 63, rtlTcpPid: 58, startedAt: null, resets: 0, lastResetReason: null },
		stats: { state: "ok", observedAt: null, ageMs: 200, lastError: null },
	}
	it("accepts a valid SdrHostSampling and rejects partial ones", () => {
		expect(readHostSampling(sampling)?.state).toBe("streaming")
		expect(readHostSampling({ ...sampling, upstream: null })).toBeUndefined()
		expect(readHostSampling(undefined)).toBeUndefined()
	})
	it("is carried on resource hosts only when present and valid", () => {
		const host = {
			available: true, sourceId: "pi-iq", apiUrl: "http://192.0.2.23:8080", uptime: 291,
			rtlTcp: null, rtlmux: null, dongle: null, warnings: [], errors: [], lastFetchedAt: null, fetchError: null,
		}
		const container = { available: true, cpuUsagePercent: 240, cpuThrottledPercent: null, memoryUsageBytes: 1, memoryLimitBytes: null, memoryUsagePercent: null, oomKillCount: 0, cgroupVersion: "v2" }
		const r = guardResources({ timestamp: "t", container, sdrHosts: [host, { ...host, sampling }], sourceBackpressure: [] })
		expect(r?.sdrHosts[0]?.sampling).toBeUndefined()
		expect(r?.sdrHosts[1]?.sampling?.state).toBe("streaming")
	})
})

describe("guardCoreStatus and guardPresets", () => {
	it("flattens non-decoder components", () => {
		const s = guardCoreStatus({
			status: "degraded", uptime: 460, version: "1.0.0", sources: [], decoders: {},
			health: { status: "degraded", timestamp: "t", uptime: 460, components: { api: { status: "up" }, sdrpp: { status: "down", message: "no route" }, decoders: { x: { status: "up" } }, source: { status: "up" } } },
		})
		expect(s?.components.map(c => c.name)).toEqual(["api", "sdrpp", "source"])
		expect(s?.components[1]).toEqual({ name: "sdrpp", status: "down", message: "no route" })
	})
	it("keeps presets with a numeric bandwidth", () => {
		expect(guardPresets({ nfm: { bandwidth: 12500 }, wfm: { bandwidth: 200000, deEmphasis: true, deEmphasisTau: 50 }, bad: {} })).toEqual({
			nfm: { bandwidth: 12500 },
			wfm: { bandwidth: 200000, deEmphasis: true, deEmphasisTau: 50 },
		})
	})
})

describe("parseServerMessage", () => {
	it("maps the subscribe ack and server errors", () => {
		expect(parseServerMessage({ type: "subscribed", data: { channels: ["decoders"] } })).toEqual({ type: "subscribed", channels: ["decoders"] })
		expect(parseServerMessage({ type: "error", data: { message: "Invalid JSON" } })).toEqual({ type: "server-error", message: "Invalid JSON" })
	})
	it("parses decoder:health without previousHealth", () => {
		expect(parseServerMessage({ type: "decoder:health", channel: "health", data: { decoderId: "readsb", health: "idle" } })).toEqual({ type: "decoder:health", decoderId: "readsb", health: "idle" })
	})
	it("follows the broadcaster for aircraft:lost ({icao, aircraft})", () => {
		expect(parseServerMessage({ type: "aircraft:lost", channel: "aircraft", data: { icao: "4ca9d2", aircraft: { icao: "4ca9d2" } } })).toEqual({ type: "aircraft:lost", icao: "4ca9d2" })
	})
	it("uses branchId on backpressure events", () => {
		expect(parseServerMessage({ type: "fanout:backpressure", channel: "fanout", data: { branchId: "decoder-readsb", bufferedBytes: 389120, timestamp: "t" } })).toMatchObject({ branchId: "decoder-readsb" })
	})
	it("tolerates extra keys on live-audio frames", () => {
		const config = { enabled: true, httpPort: 8081, modulation: "nfm", bandwidth: 12500, squelch: 0, noiseReduction: "off", lowPass: 0, highPass: 0, gain: 10, deEmphasis: false, deEmphasisTau: 50, audioFormat: "s16le", iqDcBlock: true, extra: 1 }
		expect(parseServerMessage({ type: "live-audio:config", channel: "live-audio", data: config })).toMatchObject({ type: "live-audio:config" })
	})
	it("rejects unknown types and malformed data", () => {
		expect(parseServerMessage({ type: "nope", channel: "x", data: {} })).toBeUndefined()
		expect(parseServerMessage({ type: "metrics", channel: "metrics", data: { sourceId: "pi-iq" } })).toBeUndefined()
		expect(parseServerMessage("x")).toBeUndefined()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/guards.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/guards.ts`**

```ts
import type {
	AircraftState,
	AircraftTrackerStats,
	BranchTelemetry,
	ContainerResources,
	DecoderAssignment,
	DecoderCaps,
	DecoderHealth,
	DecoderOutput,
	DecoderStats,
	ExtendedSourceStatus,
	FanoutSnapshot,
	LiveAudioConfig,
	LiveAudioStatus,
	ResourceAlert,
	SdrHostDongleInfo,
	SdrHostRtlTcpStatus,
	SdrHostRtlmuxStatus,
	SdrHostSampling,
	SourceActivity,
	SourceBackpressure,
	SourceCaps,
	TunerRelayCommandHistoryEntry,
	TunerRelayStatus,
	TunerState,
} from "@wavekit/api-types"
import type {
	AircraftSnapshot,
	AudioPreset,
	CoreComponent,
	CoreStatus,
	DecoderRow,
	PresetMap,
	ResourceView,
	SdrHostView,
	WsEvent,
} from "./types.js"

// ---------- primitives ----------

export type Obj = Record<string, unknown>
export function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v)
}
export function isStr(v: unknown): v is string {
	return typeof v === "string"
}
export function isNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v)
}
export function isBool(v: unknown): v is boolean {
	return typeof v === "boolean"
}
function isStrOrNull(v: unknown): v is string | null {
	return v === null || isStr(v)
}
function isNumOrNull(v: unknown): v is number | null {
	return v === null || isNum(v)
}
function oneOf<T extends string>(values: readonly T[]): (v: unknown) => v is T {
	return (v: unknown): v is T => isStr(v) && (values as readonly string[]).includes(v)
}

export interface Guarded<T> {
	value: T
	rejected: number
}

export function guardList<T>(
	v: unknown,
	guard: (x: unknown) => T | undefined,
): Guarded<T[]> | undefined {
	if (!Array.isArray(v)) return undefined
	const value: T[] = []
	let rejected = 0
	for (const x of v) {
		const g = guard(x)
		if (g === undefined) rejected++
		else value.push(g)
	}
	return { value, rejected }
}

function listOf<T>(v: unknown, guard: (x: unknown) => T | undefined): T[] {
	return guardList(v, guard)?.value ?? []
}

function strList(v: unknown): string[] {
	return Array.isArray(v) ? v.filter(isStr) : []
}

/** Copy the listed keys whose values pass `test`; others are dropped (never fatal). */
function pick<K extends string, V>(
	o: Obj,
	keys: readonly K[],
	test: (v: unknown) => v is V,
): Partial<Record<K, V>> {
	const out: Partial<Record<K, V>> = {}
	for (const k of keys) {
		const v = o[k]
		if (test(v)) out[k] = v
	}
	return out
}

// ---------- decoders ----------

const isHealth = oneOf<DecoderHealth>(["running", "idle", "faulted"])
const isInput = oneOf<DecoderCaps["input"]>(["audio_pcm", "iq", "external"])
const isOutFmt = oneOf<DecoderCaps["output"]>(["jsonl", "nmea", "beast", "text"])
const isPattern = oneOf<DecoderCaps["integrationPattern"]>([
	"pure_consumer",
	"network_producer",
	"external_sdr",
])

export function guardDecoderCaps(v: unknown): DecoderCaps | undefined {
	if (!isObj(v)) return undefined
	const input = v["input"]
	const output = v["output"]
	const integrationPattern = v["integrationPattern"]
	if (!isInput(input) || !isOutFmt(output) || !isPattern(integrationPattern)) return undefined
	const rates = v["preferredSampleRates"]
	return {
		input,
		output,
		integrationPattern,
		...pick(v, ["wantsExclusiveSource"] as const, isBool),
		...(Array.isArray(rates) ? { preferredSampleRates: rates.filter(isNum) } : {}),
	}
}

function guardStats(v: unknown): DecoderStats | undefined {
	if (!isObj(v)) return undefined
	const bytesIn = v["bytesIn"]
	const eventsOut = v["eventsOut"]
	const errors = v["errors"]
	if (!isNum(bytesIn) || !isNum(eventsOut) || !isNum(errors)) return undefined
	return { bytesIn, eventsOut, errors }
}

export function guardDecoder(v: unknown): DecoderRow | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const type = v["type"]
	const running = v["running"]
	const health = v["health"]
	const uptime = v["uptime"]
	const restartCount = v["restartCount"]
	const stats = guardStats(v["stats"])
	if (
		!isStr(id) ||
		!isStr(type) ||
		!isBool(running) ||
		!isHealth(health) ||
		!isNum(uptime) ||
		!isNum(restartCount) ||
		!stats
	) {
		return undefined
	}
	const lastOutputAt = v["lastOutputAt"]
	const caps = guardDecoderCaps(v["caps"])
	return {
		id,
		type,
		running,
		health,
		uptime,
		restartCount,
		stats,
		...pick(v, ["pid"] as const, isNum),
		...pick(v, ["version"] as const, isStr),
		...(isStrOrNull(lastOutputAt) ? { lastOutputAt } : {}),
		...(caps ? { caps } : {}),
	}
}

// ---------- sources ----------

const isActivityState = oneOf<SourceActivity["state"]>([
	"disconnected",
	"waiting",
	"streaming",
	"stale",
	"paused",
	"ended",
])
const isKind = oneOf<SourceCaps["kind"]>(["audio_pcm", "iq", "recording"])
const isSourceFormat = oneOf<SourceCaps["format"]>(["S16LE", "FLOAT32LE", "U8_IQ", "S16_IQ", "auto"])

function guardActivity(v: unknown): SourceActivity | undefined {
	if (!isObj(v)) return undefined
	const state = v["state"]
	const lastSampleAt = v["lastSampleAt"]
	const sampleAgeMs = v["sampleAgeMs"]
	const timeoutMs = v["timeoutMs"]
	if (!isActivityState(state) || !isStrOrNull(lastSampleAt) || !isNumOrNull(sampleAgeMs) || !isNum(timeoutMs)) {
		return undefined
	}
	return { state, lastSampleAt, sampleAgeMs, timeoutMs }
}

export function guardSourceCaps(v: unknown): SourceCaps | undefined {
	if (!isObj(v)) return undefined
	const kind = v["kind"]
	const sampleRate = v["sampleRate"]
	const format = v["format"]
	const exclusive = v["exclusive"]
	if (!isKind(kind) || !isNum(sampleRate) || !isSourceFormat(format) || !isBool(exclusive)) return undefined
	return { kind, sampleRate, format, exclusive, ...pick(v, ["channels", "centerFreq"] as const, isNum) }
}

function guardAssignment(v: unknown): DecoderAssignment | undefined {
	if (!isObj(v)) return undefined
	const decoderId = v["decoderId"]
	const sourceId = v["sourceId"]
	const assignedAt = v["assignedAt"]
	if (!isStr(decoderId) || !isStr(sourceId) || !isStr(assignedAt)) return undefined
	return { decoderId, sourceId, assignedAt }
}

export function guardSource(v: unknown): ExtendedSourceStatus | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const connected = v["connected"]
	const consumers = v["consumers"]
	const bytesReceived = v["bytesReceived"]
	const dataRate = v["dataRate"]
	const reconnectAttempts = v["reconnectAttempts"]
	const available = v["available"]
	const caps = guardSourceCaps(v["caps"])
	const assignments = guardList(v["assignments"], guardAssignment)
	if (
		!isStr(id) ||
		!isBool(connected) ||
		!isNum(consumers) ||
		!isNum(bytesReceived) ||
		!isNum(dataRate) ||
		!isNum(reconnectAttempts) ||
		!isBool(available) ||
		!caps ||
		!assignments
	) {
		return undefined
	}
	const activity = guardActivity(v["activity"])
	return {
		id,
		connected,
		consumers,
		bytesReceived,
		dataRate,
		reconnectAttempts,
		available,
		caps,
		assignments: assignments.value,
		...pick(v, ["type", "url", "lastError"] as const, isStr),
		...(activity ? { activity } : {}),
	}
}

// ---------- tuner + relay ----------

const isGainMode = oneOf<TunerState["gainMode"]>(["manual", "agc"])
const isDirect = oneOf<TunerState["directSampling"]>(["off", "i", "q"])
const isControl = oneOf<TunerState["controlMode"]>(["internal", "external"])

export function guardTuner(v: unknown): TunerState | undefined {
	if (!isObj(v)) return undefined
	const sourceId = v["sourceId"]
	const frequency = v["frequency"]
	const sampleRate = v["sampleRate"]
	const gainMode = v["gainMode"]
	const gain = v["gain"]
	const ppm = v["ppm"]
	const agcMode = v["agcMode"]
	const biasTee = v["biasTee"]
	const directSampling = v["directSampling"]
	const offsetTuning = v["offsetTuning"]
	const ifGain = v["ifGain"]
	const testMode = v["testMode"]
	const controlMode = v["controlMode"]
	const commandCount = v["commandCount"]
	const tig = v["tunerIfGain"]
	const tunerIfGain =
		tig === null
			? null
			: isObj(tig) && isNum(tig["stage"]) && isNum(tig["gain"])
				? { stage: tig["stage"], gain: tig["gain"] }
				: undefined
	if (
		!isStr(sourceId) ||
		!isNum(frequency) ||
		!isNum(sampleRate) ||
		!isGainMode(gainMode) ||
		!isNum(gain) ||
		!isNum(ppm) ||
		!isBool(agcMode) ||
		!isBool(biasTee) ||
		!isDirect(directSampling) ||
		!isBool(offsetTuning) ||
		!isNum(ifGain) ||
		!isBool(testMode) ||
		!isControl(controlMode) ||
		!isNum(commandCount) ||
		tunerIfGain === undefined
	) {
		return undefined
	}
	return {
		sourceId,
		frequency,
		sampleRate,
		gainMode,
		gain,
		ppm,
		agcMode,
		biasTee,
		directSampling,
		offsetTuning,
		ifGain,
		tunerIfGain,
		testMode,
		controlMode,
		commandCount,
		...pick(v, ["rtlXtal", "tunerXtal", "tunerGainIndex"] as const, isNum),
		...pick(v, ["lastCommandAt", "lastError"] as const, isStr),
	}
}

const isPolicy = oneOf<TunerRelayStatus["controlPolicy"]>(["exclusive", "shared"])
const isCompat = oneOf<NonNullable<TunerRelayStatus["compatibility"]>>([
	"ok",
	"missing-source",
	"unsupported-type",
	"unsupported-kind",
	"unsupported-format",
])

function guardHistoryEntry(v: unknown): TunerRelayCommandHistoryEntry | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const name = v["name"]
	const value = v["value"]
	const at = v["at"]
	if (!isNum(id) || !isStr(name) || !isNum(value) || !isStr(at)) return undefined
	return { id, name, value, at, ...pick(v, ["clientId", "clientRemote"] as const, isStr) }
}

export function guardRelay(v: unknown): TunerRelayStatus | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const listening = v["listening"]
	const host = v["host"]
	const port = v["port"]
	const clientsConnected = v["clientsConnected"]
	const controlPolicy = v["controlPolicy"]
	const bytesSent = v["bytesSent"]
	const bytesReceived = v["bytesReceived"]
	if (
		!isBool(enabled) ||
		!isBool(listening) ||
		!isStr(host) ||
		!isNum(port) ||
		!isNum(clientsConnected) ||
		!isPolicy(controlPolicy) ||
		!isNum(bytesSent) ||
		!isNum(bytesReceived)
	) {
		return undefined
	}
	const compatibility = v["compatibility"]
	const history = v["commandHistory"]
	const header = v["rtlTcpHeader"]
	return {
		enabled,
		listening,
		host,
		port,
		clientsConnected,
		controlPolicy,
		bytesSent,
		bytesReceived,
		...pick(
			v,
			[
				"sourceId",
				"sourceKind",
				"sourceFormat",
				"compatibilityMessage",
				"controlClientId",
				"controlClientRemote",
				"lastCommand",
				"lastCommandAt",
				"lastError",
			] as const,
			isStr,
		),
		...pick(
			v,
			[
				"maxClients",
				"lastCommandValue",
				"lastFrequency",
				"lastSampleRate",
				"lastGain",
				"lastPpm",
				"commandHistoryLimit",
			] as const,
			isNum,
		),
		...pick(v, ["sourceConnected"] as const, isBool),
		...(isCompat(compatibility) ? { compatibility } : {}),
		...(Array.isArray(history) ? { commandHistory: listOf(history, guardHistoryEntry) } : {}),
		...(isObj(header) && isStr(header["magic"]) && isNum(header["tunerType"]) && isNum(header["gainCount"])
			? { rtlTcpHeader: { magic: header["magic"], tunerType: header["tunerType"], gainCount: header["gainCount"] } }
			: {}),
	}
}

// ---------- fanout ----------

function pickStrOrNull<K extends string>(o: Obj, keys: readonly K[]): Partial<Record<K, string | null>> {
	return pick(o, keys, isStrOrNull)
}

function guardBranch(v: unknown): BranchTelemetry | undefined {
	if (!isObj(v)) return undefined
	const id = v["id"]
	const backpressureActive = v["backpressureActive"]
	const backpressureEnterCount = v["backpressureEnterCount"]
	const droppedBytesTotal = v["droppedBytesTotal"]
	const droppedChunksTotal = v["droppedChunksTotal"]
	const bufferBytes = v["bufferBytes"]
	const highWaterMark = v["highWaterMark"]
	if (
		!isStr(id) ||
		!isBool(backpressureActive) ||
		!isNum(backpressureEnterCount) ||
		!isNum(droppedBytesTotal) ||
		!isNum(droppedChunksTotal) ||
		!isNum(bufferBytes) ||
		!isNum(highWaterMark)
	) {
		return undefined
	}
	return {
		id,
		backpressureActive,
		backpressureEnterCount,
		droppedBytesTotal,
		droppedChunksTotal,
		bufferBytes,
		highWaterMark,
		...pick(v, ["decoderId", "sourceId"] as const, isStr),
		...pick(v, ["totalBytesWritten"] as const, isNum),
		...pickStrOrNull(v, ["backpressureSince", "lastBackpressureAt", "lastDrainAt"] as const),
	}
}

export function guardFanout(v: unknown): FanoutSnapshot | undefined {
	if (!isObj(v)) return undefined
	const timestamp = v["timestamp"]
	const branches = guardList(v["branches"], guardBranch)
	const backpressureActiveCount = v["backpressureActiveCount"]
	const droppedBytesTotal = v["droppedBytesTotal"]
	const droppedChunksTotal = v["droppedChunksTotal"]
	if (
		!isStr(timestamp) ||
		!branches ||
		!isNum(backpressureActiveCount) ||
		!isNum(droppedBytesTotal) ||
		!isNum(droppedChunksTotal)
	) {
		return undefined
	}
	return {
		timestamp,
		branches: branches.value,
		backpressureActiveCount,
		droppedBytesTotal,
		droppedChunksTotal,
		...pick(v, ["totalBytesWritten"] as const, isNum),
	}
}

// ---------- resources ----------

const isCgroup = oneOf<ContainerResources["cgroupVersion"]>(["v1", "v2", "unknown"])

function guardContainer(v: unknown): ContainerResources | undefined {
	if (!isObj(v)) return undefined
	const available = v["available"]
	const cgroupVersion = v["cgroupVersion"]
	const n = (k: string): number | null | undefined => {
		const x = v[k]
		return isNumOrNull(x) ? x : undefined
	}
	const cpuUsagePercent = n("cpuUsagePercent")
	const cpuThrottledPercent = n("cpuThrottledPercent")
	const memoryUsageBytes = n("memoryUsageBytes")
	const memoryLimitBytes = n("memoryLimitBytes")
	const memoryUsagePercent = n("memoryUsagePercent")
	const oomKillCount = n("oomKillCount")
	if (
		!isBool(available) ||
		!isCgroup(cgroupVersion) ||
		cpuUsagePercent === undefined ||
		cpuThrottledPercent === undefined ||
		memoryUsageBytes === undefined ||
		memoryLimitBytes === undefined ||
		memoryUsagePercent === undefined ||
		oomKillCount === undefined
	) {
		return undefined
	}
	return {
		available,
		cgroupVersion,
		cpuUsagePercent,
		cpuThrottledPercent,
		memoryUsageBytes,
		memoryLimitBytes,
		memoryUsagePercent,
		oomKillCount,
	}
}

function guardRtlTcp(v: unknown): SdrHostRtlTcpStatus | null {
	if (!isObj(v)) return null
	const running = v["running"]
	const pid = v["pid"]
	const restartCount = v["restartCount"]
	const lastRestartAt = v["lastRestartAt"]
	const c = v["config"]
	if (!isBool(running) || !isNumOrNull(pid) || !isNum(restartCount) || !isStrOrNull(lastRestartAt)) return null
	const config =
		isObj(c) && isNum(c["sampleRate"]) && isNum(c["frequency"]) && isNum(c["gain"]) && isBool(c["agc"])
			? { sampleRate: c["sampleRate"], frequency: c["frequency"], gain: c["gain"], agc: c["agc"] }
			: null
	return { running, pid, restartCount, lastRestartAt, config }
}

function guardRtlmux(v: unknown): SdrHostRtlmuxStatus | null {
	if (!isObj(v)) return null
	const running = v["running"]
	const pid = v["pid"]
	const restartCount = v["restartCount"]
	const lastRestartAt = v["lastRestartAt"]
	const clients = v["clients"]
	const bytesPerSec = v["bytesPerSec"]
	const totalBytesSent = v["totalBytesSent"]
	if (
		!isBool(running) ||
		!isNumOrNull(pid) ||
		!isNum(restartCount) ||
		!isStrOrNull(lastRestartAt) ||
		!isNum(clients) ||
		!isNum(bytesPerSec) ||
		!isNum(totalBytesSent)
	) {
		return null
	}
	const clientDetails = listOf(v["clientDetails"], (x: unknown) =>
		isObj(x) && isNum(x["id"]) && isStr(x["address"]) && isNum(x["bytesDropped"])
			? { id: x["id"], address: x["address"], bytesDropped: x["bytesDropped"] }
			: undefined,
	)
	return { running, pid, restartCount, lastRestartAt, clients, bytesPerSec, totalBytesSent, clientDetails }
}

function guardDongle(v: unknown): SdrHostDongleInfo | null {
	if (!isObj(v)) return null
	const found = v["found"]
	const vendor = v["vendor"]
	const product = v["product"]
	const serial = v["serial"]
	if (!isBool(found) || !isStrOrNull(vendor) || !isStrOrNull(product) || !isStrOrNull(serial)) return null
	return { found, vendor, product, serial }
}

const isSamplingState = oneOf<SdrHostSampling["state"]>(["disconnected", "waiting", "streaming", "stale", "unknown"])
const isRateBasis = oneOf<SdrHostSampling["upstream"]["rateBasis"]>(["configured", "client-controlled"])
const isRateStatus = oneOf<SdrHostSampling["upstream"]["rateStatus"]>(["nominal", "low", "unknown"])
const isReadingState = oneOf<SdrHostSampling["stats"]["state"]>(["ok", "stale", "unavailable"])
const isResetReason = oneOf<"rtlmux-restart" | "counter-decrease">(["rtlmux-restart", "counter-decrease"])
const isStatsError = oneOf<"timeout" | "unreachable" | "http" | "invalid">(["timeout", "unreachable", "http", "invalid"])

/** Spec §6.5 sampling slot: accept only a complete, well-typed SdrHostSampling. */
export function readHostSampling(v: unknown): SdrHostSampling | undefined {
	if (!isObj(v)) return undefined
	const up = v["upstream"]
	const ep = v["epoch"]
	const st = v["stats"]
	if (!isObj(up) || !isObj(ep) || !isObj(st)) return undefined
	const state = v["state"]
	const reason = v["reason"]
	const timeoutMs = v["timeoutMs"]
	const lastSampleAt = v["lastSampleAt"]
	const sampleAgeMs = v["sampleAgeMs"]
	const bytesTotal = up["bytesTotal"]
	const bytesPerSec = up["bytesPerSec"]
	const windowMs = up["windowMs"]
	const expectedBytesPerSec = up["expectedBytesPerSec"]
	const rateBasis = up["rateBasis"]
	const rateStatus = up["rateStatus"]
	const rtlmuxPid = ep["rtlmuxPid"]
	const rtlTcpPid = ep["rtlTcpPid"]
	const startedAt = ep["startedAt"]
	const resets = ep["resets"]
	const lastResetReason = ep["lastResetReason"]
	const statsState = st["state"]
	const observedAt = st["observedAt"]
	const ageMs = st["ageMs"]
	const lastError = st["lastError"]
	if (
		!isSamplingState(state) ||
		!isStrOrNull(reason) ||
		!isNum(timeoutMs) ||
		!isStrOrNull(lastSampleAt) ||
		!isNumOrNull(sampleAgeMs) ||
		!isNumOrNull(bytesTotal) ||
		!isNumOrNull(bytesPerSec) ||
		!isNumOrNull(windowMs) ||
		!isNumOrNull(expectedBytesPerSec) ||
		!isRateBasis(rateBasis) ||
		!isRateStatus(rateStatus) ||
		!isNumOrNull(rtlmuxPid) ||
		!isNumOrNull(rtlTcpPid) ||
		!isStrOrNull(startedAt) ||
		!isNum(resets) ||
		!(lastResetReason === null || isResetReason(lastResetReason)) ||
		!isReadingState(statsState) ||
		!isStrOrNull(observedAt) ||
		!isNumOrNull(ageMs) ||
		!(lastError === null || isStatsError(lastError))
	) {
		return undefined
	}
	return {
		state,
		reason,
		timeoutMs,
		lastSampleAt,
		sampleAgeMs,
		upstream: { bytesTotal, bytesPerSec, windowMs, expectedBytesPerSec, rateBasis, rateStatus },
		epoch: { rtlmuxPid, rtlTcpPid, startedAt, resets, lastResetReason },
		stats: { state: statsState, observedAt, ageMs, lastError },
	}
}

function guardHost(v: unknown): SdrHostView | undefined {
	if (!isObj(v)) return undefined
	const available = v["available"]
	const sourceId = v["sourceId"]
	const apiUrl = v["apiUrl"]
	const uptime = v["uptime"]
	const lastFetchedAt = v["lastFetchedAt"]
	const fetchError = v["fetchError"]
	if (
		!isBool(available) ||
		!isStr(sourceId) ||
		!isStr(apiUrl) ||
		!isNumOrNull(uptime) ||
		!isStrOrNull(lastFetchedAt) ||
		!isStrOrNull(fetchError)
	) {
		return undefined
	}
	const sampling = readHostSampling(v["sampling"])
	return {
		available,
		sourceId,
		apiUrl,
		uptime,
		rtlTcp: guardRtlTcp(v["rtlTcp"]),
		rtlmux: guardRtlmux(v["rtlmux"]),
		dongle: guardDongle(v["dongle"]),
		warnings: strList(v["warnings"]),
		errors: strList(v["errors"]),
		lastFetchedAt,
		fetchError,
		...(sampling ? { sampling } : {}),
	}
}

function guardSourceBackpressure(v: unknown): SourceBackpressure | undefined {
	if (!isObj(v)) return undefined
	const sourceId = v["sourceId"]
	const available = v["available"]
	const bytesDroppedUpstream = v["bytesDroppedUpstream"]
	const totalBytesSent = v["totalBytesSent"]
	const dropRate = v["dropRate"]
	const dropPercent = v["dropPercent"]
	const lastCheckedAt = v["lastCheckedAt"]
	if (
		!isStr(sourceId) ||
		!isBool(available) ||
		!isNum(bytesDroppedUpstream) ||
		!isNum(totalBytesSent) ||
		!isNum(dropRate) ||
		!isNum(dropPercent) ||
		!isStr(lastCheckedAt)
	) {
		return undefined
	}
	return { sourceId, available, bytesDroppedUpstream, totalBytesSent, dropRate, dropPercent, lastCheckedAt }
}

export function guardResources(v: unknown): ResourceView | undefined {
	if (!isObj(v)) return undefined
	const timestamp = v["timestamp"]
	const container = guardContainer(v["container"])
	if (!isStr(timestamp) || !container) return undefined
	return {
		timestamp,
		container,
		sdrHosts: listOf(v["sdrHosts"], guardHost),
		sourceBackpressure: listOf(v["sourceBackpressure"], guardSourceBackpressure),
	}
}

const isAlertType = oneOf<ResourceAlert["type"]>(["upstream-drops", "container-memory", "container-cpu", "sdr-host-error"])
const isSeverity = oneOf<ResourceAlert["severity"]>(["warning", "critical"])

export function guardAlert(v: unknown): ResourceAlert | undefined {
	if (!isObj(v)) return undefined
	const type = v["type"]
	const severity = v["severity"]
	const message = v["message"]
	const timestamp = v["timestamp"]
	if (!isAlertType(type) || !isSeverity(severity) || !isStr(message) || !isStr(timestamp)) return undefined
	return { type, severity, message, timestamp, ...pick(v, ["sourceId"] as const, isStr) }
}

// ---------- live audio ----------

const isModulation = oneOf<LiveAudioConfig["modulation"]>(["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"])
const isNoise = oneOf<LiveAudioConfig["noiseReduction"]>(["off", "voice", "noaa-apt", "narrow-band"])
const isAudioFormat = oneOf<LiveAudioConfig["audioFormat"]>(["s16le", "f32le"])
const isTau = (v: unknown): v is 50 | 75 => v === 50 || v === 75
const isPipeline = oneOf<LiveAudioStatus["pipelineHealth"]>(["running", "starting", "stopped", "error"])

export function guardLiveAudioConfig(v: unknown): LiveAudioConfig | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const httpPort = v["httpPort"]
	const modulation = v["modulation"]
	const bandwidth = v["bandwidth"]
	const squelch = v["squelch"]
	const noiseReduction = v["noiseReduction"]
	const lowPass = v["lowPass"]
	const highPass = v["highPass"]
	const gain = v["gain"]
	const deEmphasis = v["deEmphasis"]
	const deEmphasisTau = v["deEmphasisTau"]
	const audioFormat = v["audioFormat"]
	const iqDcBlock = v["iqDcBlock"]
	if (
		!isBool(enabled) ||
		!isNum(httpPort) ||
		!isModulation(modulation) ||
		!isNum(bandwidth) ||
		!isNum(squelch) ||
		!isNoise(noiseReduction) ||
		!isNum(lowPass) ||
		!isNum(highPass) ||
		!isNum(gain) ||
		!isBool(deEmphasis) ||
		!isTau(deEmphasisTau) ||
		!isAudioFormat(audioFormat) ||
		!isBool(iqDcBlock)
	) {
		return undefined
	}
	return {
		enabled,
		httpPort,
		modulation,
		bandwidth,
		squelch,
		noiseReduction,
		lowPass,
		highPass,
		gain,
		deEmphasis,
		deEmphasisTau,
		audioFormat,
		iqDcBlock,
		...pick(v, ["sourceId"] as const, isStr),
	}
}

export function guardLiveAudioStatus(v: unknown): LiveAudioStatus | undefined {
	if (!isObj(v)) return undefined
	const enabled = v["enabled"]
	const running = v["running"]
	const sourceId = v["sourceId"]
	const sourceConnected = v["sourceConnected"]
	const sourceIqSampleRate = v["sourceIqSampleRate"]
	const config = guardLiveAudioConfig(v["config"])
	const effectiveSampleRate = v["effectiveSampleRate"]
	const decimationFactor = v["decimationFactor"]
	const httpUrl = v["httpUrl"]
	const clientCount = v["clientCount"]
	const bytesStreamed = v["bytesStreamed"]
	const pipelineHealth = v["pipelineHealth"]
	if (
		!isBool(enabled) ||
		!isBool(running) ||
		!isStr(sourceId) ||
		!isBool(sourceConnected) ||
		!isNum(sourceIqSampleRate) ||
		!config ||
		!isNum(effectiveSampleRate) ||
		!isNum(decimationFactor) ||
		!isStr(httpUrl) ||
		!isNum(clientCount) ||
		!isNum(bytesStreamed) ||
		!isPipeline(pipelineHealth)
	) {
		return undefined
	}
	return {
		enabled,
		running,
		sourceId,
		sourceConnected,
		sourceIqSampleRate,
		config,
		effectiveSampleRate,
		decimationFactor,
		httpUrl,
		clientCount,
		bytesStreamed,
		pipelineHealth,
		...pick(v, ["lastError"] as const, isStr),
	}
}

// ---------- decoder output, aircraft ----------

export function guardOutput(v: unknown): DecoderOutput | undefined {
	if (!isObj(v)) return undefined
	const type = v["type"]
	const decoder = v["decoder"]
	const timestamp = v["timestamp"]
	if (!isStr(type) || !isStr(decoder) || !isStr(timestamp)) return undefined
	return { type, decoder, timestamp, data: v["data"] }
}

const isEmergency = oneOf<NonNullable<AircraftState["emergency"]>>([
	"none",
	"general",
	"lifeguard",
	"minfuel",
	"nordo",
	"unlawful",
	"downed",
	"reserved",
])

export function guardAircraftState(v: unknown): AircraftState | undefined {
	if (!isObj(v)) return undefined
	const icao = v["icao"]
	const seen = v["seen"]
	const messages = v["messages"]
	const firstSeen = v["firstSeen"]
	const lastUpdated = v["lastUpdated"]
	if (!isStr(icao) || !isNum(seen) || !isNum(messages) || !isNum(firstSeen) || !isNum(lastUpdated)) return undefined
	const pos = v["position"]
	const vel = v["velocity"]
	const alt = v["altitude"]
	const ident = v["identification"]
	const sig = v["signalQuality"]
	const emergency = v["emergency"]
	const baro = isObj(alt) ? alt["baro"] : undefined
	return {
		icao,
		seen,
		messages,
		firstSeen,
		lastUpdated,
		...pick(v, ["callsign", "squawk"] as const, isStr),
		...pick(v, ["seenPos"] as const, isNum),
		...(isEmergency(emergency) ? { emergency } : {}),
		...(isObj(pos) && isNum(pos["lat"]) && isNum(pos["lon"]) ? { position: { lat: pos["lat"], lon: pos["lon"] } } : {}),
		...(isObj(vel) ? { velocity: pick(vel, ["gs", "tas", "ias", "track", "trueHeading"] as const, isNum) } : {}),
		...(isObj(alt)
			? {
					altitude: {
						...pick(alt, ["geom", "baroRate", "geomRate"] as const, isNum),
						...pick(alt, ["onGround"] as const, isBool),
						...(isNumOrNull(baro) ? { baro } : {}),
					},
				}
			: {}),
		...(isObj(ident)
			? {
					identification: pick(
						ident,
						["registration", "typeCode", "typeDescription", "operator", "operatorCode", "country"] as const,
						isStr,
					),
				}
			: {}),
		...(isObj(sig) ? { signalQuality: pick(sig, ["rssi"] as const, isNum) } : {}),
	}
}

export function guardAircraftStats(v: unknown): AircraftTrackerStats | undefined {
	if (!isObj(v)) return undefined
	const cache = v["enrichmentCache"]
	const keys = ["aircraftCount", "withPosition", "withCallsign", "enrichedCount", "messagesProcessed", "messagesPerSecond"] as const
	const nums = pick(v, keys, isNum)
	const aircraftCount = nums.aircraftCount
	const withPosition = nums.withPosition
	const withCallsign = nums.withCallsign
	const enrichedCount = nums.enrichedCount
	const messagesProcessed = nums.messagesProcessed
	const messagesPerSecond = nums.messagesPerSecond
	if (
		aircraftCount === undefined ||
		withPosition === undefined ||
		withCallsign === undefined ||
		enrichedCount === undefined ||
		messagesProcessed === undefined ||
		messagesPerSecond === undefined ||
		!isObj(cache) ||
		!isNum(cache["hits"]) ||
		!isNum(cache["misses"]) ||
		!isNum(cache["size"])
	) {
		return undefined
	}
	return {
		aircraftCount,
		withPosition,
		withCallsign,
		enrichedCount,
		messagesProcessed,
		messagesPerSecond,
		enrichmentCache: { hits: cache["hits"], misses: cache["misses"], size: cache["size"] },
	}
}

export function guardAircraftSnapshot(v: unknown): AircraftSnapshot | undefined {
	if (!isObj(v)) return undefined
	const stats = guardAircraftStats(v["stats"])
	const timestamp = v["timestamp"]
	const aircraft = guardList(v["aircraft"], guardAircraftState)
	if (!stats || !isNum(timestamp) || !aircraft) return undefined
	return { aircraft: aircraft.value, stats, timestamp }
}

// ---------- status, presets ----------

export function guardCoreStatus(v: unknown): CoreStatus | undefined {
	if (!isObj(v)) return undefined
	const status = v["status"]
	const uptime = v["uptime"]
	const version = v["version"]
	if (!isStr(status) || !isNum(uptime) || !isStr(version)) return undefined
	const health = v["health"]
	const comps = isObj(health) ? health["components"] : undefined
	const components: CoreComponent[] = []
	if (isObj(comps)) {
		for (const [name, c] of Object.entries(comps)) {
			if (name === "decoders" || !isObj(c)) continue
			const cs = c["status"]
			if (!isStr(cs)) continue
			const message = c["message"]
			components.push({ name, status: cs, ...(isStr(message) ? { message } : {}) })
		}
	}
	return { status, uptime, version, components }
}

export function guardPresets(v: unknown): PresetMap | undefined {
	if (!isObj(v)) return undefined
	const out: PresetMap = {}
	for (const [name, p] of Object.entries(v)) {
		if (!isObj(p)) continue
		const bandwidth = p["bandwidth"]
		if (!isNum(bandwidth)) continue
		const tau = p["deEmphasisTau"]
		const preset: AudioPreset = {
			bandwidth,
			...pick(p, ["deEmphasis"] as const, isBool),
			...(isTau(tau) ? { deEmphasisTau: tau } : {}),
		}
		out[name] = preset
	}
	return out
}

// ---------- WS frames ----------

/** Turn one parsed WS frame into a typed event; undefined for unknown or malformed frames. */
export function parseServerMessage(raw: unknown): WsEvent | undefined {
	if (!isObj(raw)) return undefined
	const type = raw["type"]
	const d = raw["data"]
	if (!isStr(type)) return undefined
	const data: Obj = isObj(d) ? d : {}
	const s = (k: string): string | undefined => {
		const x = data[k]
		return isStr(x) ? x : undefined
	}
	const n = (k: string): number | undefined => {
		const x = data[k]
		return isNum(x) ? x : undefined
	}
	switch (type) {
		case "subscribed":
		case "unsubscribed":
			return { type, channels: strList(data["channels"]) }
		case "error": {
			const message = s("message")
			return message === undefined ? undefined : { type: "server-error", message }
		}
		case "decoder:output": {
			const decoderId = s("decoderId")
			const output = guardOutput(data["output"])
			return decoderId !== undefined && output ? { type, decoderId, output } : undefined
		}
		case "decoder:started":
		case "decoder:stopped": {
			const decoderId = s("decoderId")
			return decoderId !== undefined ? { type, decoderId } : undefined
		}
		case "decoder:error": {
			const decoderId = s("decoderId")
			const error = s("error")
			return decoderId !== undefined && error !== undefined ? { type, decoderId, error } : undefined
		}
		case "decoder:health": {
			const decoderId = s("decoderId")
			const health = data["health"]
			return decoderId !== undefined && isHealth(health) ? { type, decoderId, health } : undefined
		}
		case "source:connected": {
			const sourceId = s("sourceId")
			return sourceId !== undefined ? { type, sourceId } : undefined
		}
		case "source:disconnected": {
			const sourceId = s("sourceId")
			const error = s("error")
			if (sourceId === undefined) return undefined
			return error !== undefined ? { type, sourceId, error } : { type, sourceId }
		}
		case "source:error": {
			const sourceId = s("sourceId")
			const error = s("error")
			return sourceId !== undefined && error !== undefined ? { type, sourceId, error } : undefined
		}
		case "source:caps-changed": {
			const sourceId = s("sourceId")
			const caps = guardSourceCaps(data["caps"])
			return sourceId !== undefined && caps ? { type, sourceId, caps } : undefined
		}
		case "metrics": {
			const sourceId = s("sourceId")
			const bytesReceived = n("bytesReceived")
			const dataRate = n("dataRate")
			return sourceId !== undefined && bytesReceived !== undefined && dataRate !== undefined
				? { type, sourceId, bytesReceived, dataRate }
				: undefined
		}
		case "fanout:snapshot": {
			const snapshot = guardFanout(d)
			return snapshot ? { type, snapshot } : undefined
		}
		case "fanout:backpressure": {
			const branchId = s("branchId")
			const bufferedBytes = n("bufferedBytes")
			const timestamp = s("timestamp")
			return branchId !== undefined && bufferedBytes !== undefined && timestamp !== undefined
				? { type, branchId, bufferedBytes, timestamp }
				: undefined
		}
		case "fanout:drain": {
			const branchId = s("branchId")
			const durationMs = n("durationMs")
			const timestamp = s("timestamp")
			return branchId !== undefined && durationMs !== undefined && timestamp !== undefined
				? { type, branchId, durationMs, timestamp }
				: undefined
		}
		case "live-audio:status": {
			const status = guardLiveAudioStatus(d)
			return status ? { type, status } : undefined
		}
		case "live-audio:config": {
			const config = guardLiveAudioConfig(d)
			return config ? { type, config } : undefined
		}
		case "live-audio:started":
		case "live-audio:stopped":
			return { type }
		case "live-audio:error": {
			const message = s("message")
			return message !== undefined ? { type, message } : undefined
		}
		case "resources:snapshot": {
			const snapshot = guardResources(d)
			return snapshot ? { type, snapshot } : undefined
		}
		case "resources:alert": {
			const alert = guardAlert(d)
			return alert ? { type, alert } : undefined
		}
		case "tuner:state-changed": {
			const sourceId = s("sourceId")
			const state = guardTuner(data["state"])
			return sourceId !== undefined && state ? { type, sourceId, state } : undefined
		}
		case "tuner:command-sent": {
			const sourceId = s("sourceId")
			const command = s("command")
			return sourceId !== undefined && command !== undefined
				? { type, sourceId, command, value: data["value"] }
				: undefined
		}
		case "tuner:control-mode-changed": {
			const sourceId = s("sourceId")
			const mode = data["mode"]
			return sourceId !== undefined && isControl(mode) ? { type, sourceId, mode } : undefined
		}
		case "tuner:error": {
			const sourceId = s("sourceId")
			const error = s("error")
			return sourceId !== undefined && error !== undefined ? { type, sourceId, error } : undefined
		}
		case "aircraft:new":
		case "aircraft:update": {
			const aircraft = guardAircraftState(d)
			return aircraft ? { type, aircraft } : undefined
		}
		case "aircraft:lost": {
			const icao = s("icao")
			return icao !== undefined ? { type, icao } : undefined
		}
		case "aircraft:stats": {
			const stats = guardAircraftStats(d)
			return stats ? { type, stats } : undefined
		}
		default:
			return undefined
	}
}
```

- [ ] **Step 4: Run the tests and both typechecks**

```bash
pnpm exec vitest run tests/unit/cli/guards.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: PASS, and tsc exits 0. If `pick(...)` spreads fail `exactOptionalPropertyTypes`, the cause is that `Partial<Record<K, V>>` was widened. Annotate the call with the explicit `as const` key tuple shown, and do not cast the result.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/guards.ts tests/unit/cli/guards.test.ts
git commit -m "feat(cli): hand-written DTO guards and WS frame parser

Follows the broadcaster for decoder:health (health channel, no
previousHealth) and aircraft:lost ({icao, aircraft}); adds the
readHostSampling slot (spec §6.5).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 7: API base resolution and discovery (A)

**Owner:** A · **Spec:** §10.1; research (b)/(c) `/health` semantics

**Files:**
- Create: `cli/source/data/config.ts`
- Test: `tests/unit/cli/config.test.ts`

**Interfaces:**
- Consumes: `isObj` from `data/guards.ts`.
- Produces:
  - `interface ApiTarget { base: string; ws: string; explicit: boolean }`
  - `class CliUsageError extends Error`
  - `DISCOVERY_CANDIDATES: readonly string[]`
  - `deriveWs(base: string): string`, `deriveBase(ws: string): string`, `hostPort(url: string): string`
  - `checkTarget(url: string): URL`, which throws `CliUsageError` on port 4713 and rewrites `localhost`
  - `resolveExplicit(apiFlag: string | undefined, env: Readonly<Record<string, string | undefined>>): ApiTarget | null`
  - `type FetchLike = (url: string, init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>`
  - `discover(fetchFn: FetchLike, candidates?: readonly string[], timeoutMs?: number): Promise<{ target: ApiTarget | null; tried: string[] }>`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/config.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import {
	CliUsageError,
	DISCOVERY_CANDIDATES,
	deriveBase,
	deriveWs,
	discover,
	resolveExplicit,
	type FetchLike,
} from "../../../cli/source/data/config.js"

const json = (status: number, body: unknown) =>
	Promise.resolve({ ok: status < 400, status, statusText: "", json: () => Promise.resolve(body) })

describe("resolveExplicit", () => {
	it("prefers --api, then WAVEKIT_API_URL, then WAVEKIT_WS_URL(S)", () => {
		const env = {
			WAVEKIT_API_URL: "http://192.0.2.5:9000",
			WAVEKIT_WS_URL: "ws://192.0.2.6:9000/ws",
		}
		expect(resolveExplicit("http://192.0.2.4:9000", env)).toEqual({ base: "http://192.0.2.4:9000", ws: "ws://192.0.2.4:9000/ws", explicit: true })
		expect(resolveExplicit(undefined, env)?.base).toBe("http://192.0.2.5:9000")
		expect(resolveExplicit(undefined, { WAVEKIT_WS_URL: "ws://192.0.2.6:9000/ws" })).toEqual({ base: "http://192.0.2.6:9000", ws: "ws://192.0.2.6:9000/ws", explicit: true })
		expect(resolveExplicit(undefined, { WAVEKIT_WS_URLS: "wss://192.0.2.7/ws, ws://192.0.2.8/ws" })?.base).toBe("https://192.0.2.7")
		expect(resolveExplicit(undefined, {})).toBeNull()
	})
	it("rewrites localhost and refuses the RTL-TCP relay port", () => {
		expect(resolveExplicit("http://localhost:9000", {})?.base).toBe("http://127.0.0.1:9000")
		expect(() => resolveExplicit("http://127.0.0.1:4713", {})).toThrow(CliUsageError)
	})
	it("derives URLs both ways", () => {
		expect(deriveWs("https://192.0.2.9:8443")).toBe("wss://192.0.2.9:8443/ws")
		expect(deriveBase("ws://192.0.2.9:9000/ws")).toBe("http://192.0.2.9:9000")
	})
})

describe("discover", () => {
	it("never probes localhost or 4713", () => {
		for (const c of DISCOVERY_CANDIDATES) {
			expect(c).not.toContain("localhost")
			expect(c).not.toContain(":4713")
		}
		expect(DISCOVERY_CANDIDATES).toEqual(["http://127.0.0.1:9000", "http://127.0.0.1:3000"])
	})
	it("adopts the first candidate whose /health says status ok, even with 503", async () => {
		const fetchFn = vi.fn<FetchLike>(url => (url.includes(":9000") ? json(503, { status: "ok", timestamp: "t" }) : json(200, { status: "ok" })))
		const r = await discover(fetchFn)
		expect(r.target?.base).toBe("http://127.0.0.1:9000")
		expect(fetchFn).toHaveBeenCalledTimes(1)
	})
	it("skips a different service answering HTML (review focus 1)", async () => {
		const fetchFn = vi.fn<FetchLike>(url =>
			url.includes(":9000")
				? Promise.reject(new TypeError("fetch failed"))
				: Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.reject(new SyntaxError("Unexpected token <")) }),
		)
		const r = await discover(fetchFn)
		expect(r.target).toBeNull()
		expect(r.tried).toEqual(["127.0.0.1:9000", "127.0.0.1:3000"])
	})
	it("skips JSON that is not a WaveKit /health body", async () => {
		const r = await discover(() => json(200, { hello: "world" }))
		expect(r.target).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/config.ts`**

```ts
import { isObj } from "./guards.js"

export interface ApiTarget {
	base: string
	ws: string
	explicit: boolean
}

export class CliUsageError extends Error {
	override name = "CliUsageError"
}

/** Never `localhost` (IPv6-first resolution) and never 4713 (the RTL-TCP relay). */
export const DISCOVERY_CANDIDATES: readonly string[] = ["http://127.0.0.1:9000", "http://127.0.0.1:3000"]

const RELAY_PORT = "4713"

export type FetchLike = (
	url: string,
	init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; statusText: string; json(): Promise<unknown> }>

export function checkTarget(url: string): URL {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		throw new CliUsageError(`invalid API URL: ${url}`)
	}
	if (u.hostname === "localhost") u.hostname = "127.0.0.1"
	if (u.port === RELAY_PORT) {
		throw new CliUsageError(`port 4713 is the RTL-TCP relay, not the WaveKit API (${url})`)
	}
	return u
}

export function deriveWs(base: string): string {
	const u = new URL(base)
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:"
	u.pathname = "/ws"
	u.search = ""
	u.hash = ""
	return u.toString()
}

export function deriveBase(ws: string): string {
	const u = new URL(ws)
	u.protocol = u.protocol === "wss:" ? "https:" : "http:"
	return u.origin
}

export function hostPort(url: string): string {
	return new URL(url).host
}

type Env = Readonly<Record<string, string | undefined>>

/** Precedence: --api, WAVEKIT_API_URL, WAVEKIT_WS_URL, first of WAVEKIT_WS_URLS. */
export function resolveExplicit(apiFlag: string | undefined, env: Env): ApiTarget | null {
	const api = apiFlag ?? env["WAVEKIT_API_URL"]
	if (api !== undefined && api !== "") {
		const base = checkTarget(api).origin
		return { base, ws: deriveWs(base), explicit: true }
	}
	const ws = env["WAVEKIT_WS_URL"] ?? env["WAVEKIT_WS_URLS"]?.split(",")[0]?.trim()
	if (ws !== undefined && ws !== "") {
		const url = checkTarget(ws).toString()
		return { base: deriveBase(url), ws: url, explicit: true }
	}
	return null
}

/** Probe each candidate's /health; the first JSON body with status "ok" wins (200 or 503 both mean core answered). */
export async function discover(
	fetchFn: FetchLike,
	candidates: readonly string[] = DISCOVERY_CANDIDATES,
	timeoutMs = 2000,
): Promise<{ target: ApiTarget | null; tried: string[] }> {
	const tried: string[] = []
	for (const base of candidates) {
		tried.push(hostPort(base))
		try {
			const res = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) })
			const body = await res.json()
			if (isObj(body) && body["status"] === "ok") {
				return { target: { base, ws: deriveWs(base), explicit: false }, tried }
			}
		} catch {
			// unreachable, timed out or not JSON: try the next candidate
		}
	}
	return { target: null, tried }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/config.ts tests/unit/cli/config.test.ts
git commit -m "feat(cli): single API base resolver with /health discovery

Never localhost or 4713; a non-WaveKit answer on a candidate port is skipped.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 8: REST client and actions (A)

**Owner:** A · **Spec:** §10.2; research (b) action routes, bodies and error shapes

**Files:**
- Create: `cli/source/data/api-client.ts`
- Test: `tests/unit/cli/api-client.test.ts`

**Interfaces:**
- Consumes: `FetchLike` from `config.ts`, the guards from Task 6, and `Endpoint`, `ENDPOINT_PATHS`, `RestValues`, `FetchOutcome`, `LaneError`, `ActionResult`, `DecoderOp`, `TunerCommand` from `types.ts`. `LiveAudioConfig` from api-types.
- Produces:
  - `REST_GUARDS: { [E in Endpoint]: (v: unknown) => Guarded<RestValues[E]> | undefined }`
  - `classifyError(err: unknown, at: number, timeoutMs: number): LaneError`
  - Signature:
    ```ts
    interface ApiClient {
    	get<E extends Endpoint>(endpoint: E): Promise<FetchOutcome<RestValues[E]>>
    	decoder(id: string, op: DecoderOp): Promise<ActionResult>
    	tuner(sourceId: string, cmd: TunerCommand): Promise<ActionResult>
    	audio(op: "start" | "stop"): Promise<ActionResult>
    	patchAudio(patch: Partial<LiveAudioConfig>): Promise<ActionResult>
    }
    ```
  - `createApiClient(opts: { base: () => string | null; fetchFn: FetchLike; now: () => number; timeoutMs?: number }): ApiClient`. None of its methods ever reject.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/api-client.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { createApiClient } from "../../../cli/source/data/api-client.js"
import type { FetchLike } from "../../../cli/source/data/config.js"

const decoder = {
	id: "readsb", type: "readsb", running: true, health: "idle", uptime: 51,
	stats: { bytesIn: 1, eventsOut: 0, errors: 0 }, restartCount: 0,
}

function respond(status: number, body: unknown) {
	return Promise.resolve({ ok: status < 400, status, statusText: status === 500 ? "Internal Server Error" : "OK", json: () => Promise.resolve(body) })
}

function client(fetchFn: FetchLike) {
	return createApiClient({ base: () => "http://127.0.0.1:9000", fetchFn, now: () => 1000 })
}

describe("api-client GET", () => {
	it("guards the body and counts rejected items", async () => {
		const r = await client(() => respond(200, [decoder, { nope: 1 }])).get("decoders")
		expect(r).toMatchObject({ ok: true, rejected: 1 })
	})
	it("classifies HTTP errors with the server message", async () => {
		const r = await client(() => respond(500, { error: "x", code: "RESOURCES_ERROR", message: "boom" })).get("resources")
		expect(r).toEqual({ ok: false, error: { kind: "http", status: 500, message: "boom", at: 1000 } })
	})
	it("classifies timeouts and refused connections", async () => {
		const timeout = await client(() => Promise.reject(new DOMException("t", "TimeoutError"))).get("status")
		expect(timeout).toMatchObject({ ok: false, error: { kind: "timeout", message: "timeout 2s" } })
		const refused = await client(() => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).get("status")
		expect(refused).toMatchObject({ ok: false, error: { kind: "network", message: "ECONNREFUSED" } })
	})
	it("marks bodies that fail the guard as invalid", async () => {
		const r = await client(() => respond(200, { not: "a list" })).get("decoders")
		expect(r).toMatchObject({ ok: false, error: { kind: "invalid" } })
	})
	it("reports a missing target as a network error", async () => {
		const c = createApiClient({ base: () => null, fetchFn: () => respond(200, []), now: () => 1 })
		expect(await c.get("decoders")).toMatchObject({ ok: false, error: { kind: "network" } })
	})
})

describe("api-client actions", () => {
	it("posts decoder ops without a body", async () => {
		const fetchFn = vi.fn<FetchLike>(() => respond(200, { message: "Decoder restarted", decoder }))
		const r = await client(fetchFn).decoder("readsb", "restart")
		expect(r).toEqual({ ok: true, status: 200, message: "Decoder restarted" })
		expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9000/api/decoders/readsb/restart")
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "POST" })
		expect(fetchFn.mock.calls[0]?.[1]?.body).toBeUndefined()
	})
	it("posts tuner commands as JSON and surfaces error codes", async () => {
		const fetchFn = vi.fn<FetchLike>(() => respond(409, { error: "Conflict", code: "TUNER_CONTROL_EXTERNAL", message: "device busy" }))
		const r = await client(fetchFn).tuner("pi-iq", { setting: "frequency", body: { hz: 446000000 }, label: "frequency" })
		expect(r).toEqual({ ok: false, status: 409, code: "TUNER_CONTROL_EXTERNAL", message: "device busy" })
		expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9000/api/tuner/pi-iq/frequency")
		expect(fetchFn.mock.calls[0]?.[1]?.body).toBe('{"hz":446000000}')
	})
	it("patches live-audio config", async () => {
		const fetchFn = vi.fn<FetchLike>(() => respond(200, {}))
		await client(fetchFn).patchAudio({ modulation: "nfm", bandwidth: 12500 })
		expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", body: '{"modulation":"nfm","bandwidth":12500}' })
	})
	it("never rejects on network failure", async () => {
		const r = await client(() => Promise.reject(new TypeError("fetch failed"))).audio("start")
		expect(r).toMatchObject({ ok: false, status: null })
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/api-client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/api-client.ts`**

```ts
import type { LiveAudioConfig } from "@wavekit/api-types"
import type { FetchLike } from "./config.js"
import {
	guardAircraftSnapshot,
	guardCoreStatus,
	guardDecoder,
	guardFanout,
	guardList,
	guardLiveAudioStatus,
	guardPresets,
	guardRelay,
	guardResources,
	guardSource,
	guardTuner,
	isObj,
	isStr,
	type Guarded,
} from "./guards.js"
import {
	ENDPOINT_PATHS,
	type ActionResult,
	type DecoderOp,
	type Endpoint,
	type FetchOutcome,
	type LaneError,
	type RestValues,
	type TunerCommand,
} from "./types.js"

const one = <T>(v: T | undefined): Guarded<T> | undefined => (v === undefined ? undefined : { value: v, rejected: 0 })

export const REST_GUARDS: { [E in Endpoint]: (v: unknown) => Guarded<RestValues[E]> | undefined } = {
	decoders: v => guardList(v, guardDecoder),
	sources: v => guardList(v, guardSource),
	tuner: v => guardList(v, guardTuner),
	relay: v => one(guardRelay(v)),
	fanout: v => one(guardFanout(v)),
	resources: v => one(guardResources(v)),
	audio: v => one(guardLiveAudioStatus(v)),
	status: v => one(guardCoreStatus(v)),
	presets: v => one(guardPresets(v)),
	aircraft: v => one(guardAircraftSnapshot(v)),
}

export function classifyError(err: unknown, at: number, timeoutMs: number): LaneError {
	if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
		return { kind: "timeout", message: `timeout ${Math.round(timeoutMs / 1000)}s`, at }
	}
	const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined
	const code = isObj(cause) && isStr(cause["code"]) ? cause["code"] : undefined
	const message = code ?? (err instanceof Error ? err.message : String(err))
	return { kind: "network", message, at }
}

export interface ApiClient {
	get<E extends Endpoint>(endpoint: E): Promise<FetchOutcome<RestValues[E]>>
	decoder(id: string, op: DecoderOp): Promise<ActionResult>
	tuner(sourceId: string, cmd: TunerCommand): Promise<ActionResult>
	audio(op: "start" | "stop"): Promise<ActionResult>
	patchAudio(patch: Partial<LiveAudioConfig>): Promise<ActionResult>
}

export interface ApiClientOptions {
	base: () => string | null
	fetchFn: FetchLike
	now: () => number
	timeoutMs?: number
}

async function readJson(res: { json(): Promise<unknown> }): Promise<unknown> {
	try {
		return await res.json()
	} catch {
		return undefined
	}
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
	const timeoutMs = opts.timeoutMs ?? 2000

	async function get<E extends Endpoint>(endpoint: E): Promise<FetchOutcome<RestValues[E]>> {
		const base = opts.base()
		if (base === null) return { ok: false, error: { kind: "network", message: "no API target", at: opts.now() } }
		try {
			const res = await opts.fetchFn(`${base}${ENDPOINT_PATHS[endpoint]}`, {
				signal: AbortSignal.timeout(timeoutMs),
			})
			const body = await readJson(res)
			if (!res.ok) {
				const message = isObj(body) && isStr(body["message"]) ? body["message"] : res.statusText
				return { ok: false, error: { kind: "http", status: res.status, message, at: opts.now() } }
			}
			const guarded = REST_GUARDS[endpoint](body)
			if (!guarded) {
				return { ok: false, error: { kind: "invalid", message: "unexpected response shape", at: opts.now() } }
			}
			return { ok: true, value: guarded.value, rejected: guarded.rejected }
		} catch (err: unknown) {
			return { ok: false, error: classifyError(err, opts.now(), timeoutMs) }
		}
	}

	async function send(method: "POST" | "PATCH", path: string, body?: unknown): Promise<ActionResult> {
		const base = opts.base()
		if (base === null) return { ok: false, status: null, message: "no API target" }
		try {
			const res = await opts.fetchFn(`${base}${path}`, {
				method,
				signal: AbortSignal.timeout(timeoutMs),
				...(body !== undefined
					? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
					: {}),
			})
			const json = await readJson(res)
			const message = isObj(json) && isStr(json["message"]) ? json["message"] : res.ok ? "ok" : res.statusText
			const code = isObj(json) && isStr(json["code"]) ? json["code"] : undefined
			return {
				ok: res.ok,
				status: res.status,
				message,
				...(!res.ok && code !== undefined ? { code } : {}),
			}
		} catch (err: unknown) {
			return { ok: false, status: null, message: classifyError(err, opts.now(), timeoutMs).message }
		}
	}

	return {
		get,
		decoder: (id, op) => send("POST", `/api/decoders/${encodeURIComponent(id)}/${op}`),
		tuner: (sourceId, cmd) => send("POST", `/api/tuner/${encodeURIComponent(sourceId)}/${cmd.setting}`, cmd.body),
		audio: op => send("POST", `/api/live-audio/${op}`),
		patchAudio: patch => send("PATCH", "/api/live-audio/config", patch),
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/api-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/api-client.ts tests/unit/cli/api-client.test.ts
git commit -m "feat(cli): REST client with per-endpoint outcomes and typed write actions

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 9: WebSocket client (A)

**Owner:** A · **Spec:** §10.3; research (a) subscribe protocol and close behaviour

**Files:**
- Create: `cli/source/data/ws-client.ts`
- Test: `tests/unit/cli/ws-client.test.ts`

**Interfaces:**
- Consumes: `parseServerMessage` (Task 6), `Inbound` (Task 2).
- Produces:
  - `interface WsHandlers { open(): void; message(text: string): void; close(code: number, reason: string): void; error(message: string): void }`
  - `interface WsHandle { send(text: string): void; close(): void }`
  - `type WsFactory = (url: string, handlers: WsHandlers) => WsHandle`
  - `nodeWsFactory: WsFactory`, backed by `ws`
  - `CHANNELS`, `BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000]`, `backoffDelay(attempt, random): number` (±20 %)
  - `interface WsClient { start(): void; stop(): void; reconnectNow(): void }`
  - `createWsClient(deps: { url: () => string | null; factory: WsFactory; emit: (i: Inbound) => void; now: () => number; random: () => number; setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }): WsClient`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/ws-client.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import {
	CHANNELS,
	backoffDelay,
	createWsClient,
	type WsHandlers,
} from "../../../cli/source/data/ws-client.js"
import type { Inbound } from "../../../cli/source/data/types.js"

function harness() {
	const emitted: Inbound[] = []
	const sockets: Array<{ url: string; h: WsHandlers; sent: string[]; closed: boolean }> = []
	const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
	let clock = 1000
	const client = createWsClient({
		url: () => "ws://127.0.0.1:9000/ws",
		factory: (url, h) => {
			const s = { url, h, sent: [] as string[], closed: false }
			sockets.push(s)
			return { send: t => s.sent.push(t), close: () => { s.closed = true } }
		},
		emit: i => emitted.push(i),
		now: () => clock,
		random: () => 0.5,
		setTimeout: (fn, ms) => {
			const t = { fn, ms, cleared: false }
			timers.push(t)
			return t
		},
		clearTimeout: h => {
			;(h as { cleared: boolean }).cleared = true
		},
	})
	const fire = () => {
		const t = timers.filter(x => !x.cleared).shift()
		if (!t) throw new Error("no timer")
		t.cleared = true
		clock += t.ms
		t.fn()
	}
	return { client, emitted, sockets, timers, fire }
}

describe("backoffDelay", () => {
	it("follows 1, 2, 4, 8, 15 s with ±20 % jitter", () => {
		expect([0, 1, 2, 3, 4, 9].map(a => backoffDelay(a, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
		expect(backoffDelay(0, () => 0)).toBe(800)
		expect(backoffDelay(4, () => 1)).toBe(18000)
	})
})

describe("ws client", () => {
	it("subscribes on open and emits ws:open on the ack", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		const s = sockets[0]!
		s.h.open()
		expect(JSON.parse(s.sent[0]!)).toEqual({ type: "subscribe", channels: [...CHANNELS] })
		s.h.message(JSON.stringify({ type: "subscribed", data: { channels: [...CHANNELS] } }))
		expect(emitted.map(e => e.kind)).toEqual(["ws:connecting", "ws:open"])
	})
	it("drops bad frames into ws:invalid and forwards good ones", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		const s = sockets[0]!
		s.h.message("{nope")
		s.h.message(JSON.stringify({ type: "who-knows", data: {} }))
		s.h.message(JSON.stringify({ type: "decoder:started", channel: "decoders", data: { decoderId: "readsb" } }))
		expect(emitted.slice(1).map(e => e.kind)).toEqual(["ws:invalid", "ws:invalid", "ws"])
	})
	it("backs off after close and resets after a successful subscribe", () => {
		const { client, sockets, emitted, fire } = harness()
		client.start()
		sockets[0]!.h.error("connect ECONNREFUSED 127.0.0.1:9000")
		sockets[0]!.h.close(1006, "")
		const close = emitted.find(e => e.kind === "ws:close")
		expect(close).toMatchObject({ code: 1006, reason: "connect ECONNREFUSED 127.0.0.1:9000", nextRetryAt: 2000 })
		fire()
		expect(sockets).toHaveLength(2)
		sockets[1]!.h.close(1006, "")
		expect(emitted.filter(e => e.kind === "ws:close").at(-1)).toMatchObject({ nextRetryAt: 2000 + 2000 })
		fire()
		sockets[2]!.h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		sockets[2]!.h.close(1000, "Server shutting down")
		const last = emitted.filter(e => e.kind === "ws:close").at(-1)
		expect(last && "nextRetryAt" in last ? last.nextRetryAt : null).toBe(4000 + 1000)
	})
	it("reconnectNow ignores the old socket's events and connects immediately", () => {
		const { client, sockets, emitted } = harness()
		client.start()
		client.reconnectNow()
		expect(sockets).toHaveLength(2)
		expect(sockets[0]!.closed).toBe(true)
		const before = emitted.length
		sockets[0]!.h.close(1006, "")
		expect(emitted.length).toBe(before)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/ws-client.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/ws-client.ts`**

```ts
import WebSocket from "ws"
import { parseServerMessage } from "./guards.js"
import type { Inbound } from "./types.js"

export interface WsHandlers {
	open(): void
	message(text: string): void
	close(code: number, reason: string): void
	error(message: string): void
}
export interface WsHandle {
	send(text: string): void
	close(): void
}
export type WsFactory = (url: string, handlers: WsHandlers) => WsHandle

function rawToString(data: WebSocket.RawData): string {
	if (Buffer.isBuffer(data)) return data.toString("utf8")
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8")
	return Buffer.from(data).toString("utf8")
}

/** Every socket gets error and close handlers; nothing is logged. */
export const nodeWsFactory: WsFactory = (url, h) => {
	const sock = new WebSocket(url)
	sock.on("open", () => h.open())
	sock.on("message", (data: WebSocket.RawData) => h.message(rawToString(data)))
	sock.on("error", (err: Error) => h.error(err.message))
	sock.on("close", (code: number, reason: Buffer) => h.close(code, reason.toString("utf8")))
	return {
		send: text => {
			if (sock.readyState === WebSocket.OPEN) sock.send(text)
		},
		close: () => {
			sock.terminate()
		},
	}
}

export const CHANNELS = [
	"decoders",
	"health",
	"sources",
	"metrics",
	"fanout",
	"live-audio",
	"resources",
	"tuner",
	"aircraft",
] as const

export const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 15000] as const

export function backoffDelay(attempt: number, random: () => number): number {
	const base = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)] ?? 15000
	return Math.round(base * (0.8 + 0.4 * random()))
}

export interface WsClientDeps {
	url: () => string | null
	factory: WsFactory
	emit: (item: Inbound) => void
	now: () => number
	random: () => number
	setTimeout: (fn: () => void, ms: number) => unknown
	clearTimeout: (handle: unknown) => void
}

export interface WsClient {
	start(): void
	stop(): void
	reconnectNow(): void
}

export function createWsClient(deps: WsClientDeps): WsClient {
	let generation = 0
	let handle: WsHandle | null = null
	let timer: unknown = null
	let attempt = 0
	let stopped = true
	let lastError = ""

	function clearTimer(): void {
		if (timer !== null) deps.clearTimeout(timer)
		timer = null
	}

	function scheduleRetry(code: number, reason: string): void {
		const delay = backoffDelay(attempt, deps.random)
		attempt++
		const nextRetryAt = deps.now() + delay
		deps.emit({ kind: "ws:close", at: deps.now(), code, reason, nextRetryAt })
		clearTimer()
		timer = deps.setTimeout(() => {
			timer = null
			connect()
		}, delay)
	}

	function connect(): void {
		if (stopped) return
		const url = deps.url()
		const gen = ++generation
		if (url === null) {
			scheduleRetry(0, "no API target")
			return
		}
		lastError = ""
		deps.emit({ kind: "ws:connecting", at: deps.now(), attempt })
		handle = deps.factory(url, {
			open: () => {
				if (gen !== generation) return
				handle?.send(JSON.stringify({ type: "subscribe", channels: [...CHANNELS] }))
			},
			message: text => {
				if (gen !== generation) return
				let raw: unknown
				try {
					raw = JSON.parse(text)
				} catch {
					deps.emit({ kind: "ws:invalid", at: deps.now() })
					return
				}
				const event = parseServerMessage(raw)
				if (!event) {
					deps.emit({ kind: "ws:invalid", at: deps.now() })
					return
				}
				if (event.type === "subscribed") {
					attempt = 0
					deps.emit({ kind: "ws:open", at: deps.now() })
					return
				}
				deps.emit({ kind: "ws", event, at: deps.now() })
			},
			error: message => {
				if (gen !== generation) return
				lastError = message
			},
			close: (code, reason) => {
				if (gen !== generation) return
				handle = null
				scheduleRetry(code, reason !== "" ? reason : lastError)
			},
		})
	}

	return {
		start: () => {
			if (!stopped) return
			stopped = false
			connect()
		},
		stop: () => {
			stopped = true
			generation++
			clearTimer()
			handle?.close()
			handle = null
		},
		reconnectNow: () => {
			stopped = false
			generation++
			clearTimer()
			handle?.close()
			handle = null
			attempt = 0
			connect()
		},
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/ws-client.test.ts`
Expected: PASS. The backoff test expects the first `nextRetryAt` to be `1000 + 1000 = 2000`. After `fire()` the clock is 2000 and the second delay is 2000, so `nextRetryAt` is 4000. After a successful subscribe the attempt counter resets, so the next delay is 1000 from clock 4000, giving 5000.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/ws-client.ts tests/unit/cli/ws-client.test.ts
git commit -m "feat(cli): WS client with subscribe ack, guarded frames and jittered backoff

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 10: Rates — drop now, decode rate, sparkline (A)

**Owner:** A · **Spec:** §10.6, T4, P12, P13

**Files:**
- Create: `cli/source/data/rates.ts`
- Test: `tests/unit/cli/rates.test.ts`

**Interfaces:**
- Consumes: `FanoutSample`, `FanoutBranchSample`, `CounterSample` from `types.ts`. `FanoutSnapshot` from api-types.
- Produces:
  - Constants: `DROP_WINDOW_MS = 10_000`, `MIN_DROP_SPAN_MS = 2_000`, `RATE_WINDOW_MS = 60_000`, `MIN_RATE_SPAN_MS = 20_000`, `RESTART_WINDOW_MS = 300_000`, `SPARK_MINUTES = 30`
  - `fanoutSample(s: FanoutSnapshot): FanoutSample | null`
  - `pushFanout(history: readonly FanoutSample[], s: FanoutSnapshot): FanoutSample[]`
  - `interface BranchDelta { dDropped: number; dOffered: number; spanMs: number }`
  - `branchDelta(history, branchId): BranchDelta | null`, `branchDropNow(history, branchId): number | null`
  - `interface AggregateDrop { ratio: number | null; backpressure: number; branches: number; offeredBytesPerSec: number | null }`
  - `aggregateDropNow(history): AggregateDrop`, `relayDropNow(history): number | null`
  - `pushCounter(history, t, v, windowMs): CounterSample[]`, `counterRate(history): number | null` (per second), `restartIncrements(history, now): number`
  - `sparkAdd(spark, prev: CounterSample | undefined, cur: CounterSample): Record<string, number>`, `sparkBuckets(spark, now): Array<number | undefined>` (30 buckets, oldest first)

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/rates.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { FanoutSnapshot } from "@wavekit/api-types"
import {
	aggregateDropNow,
	branchDropNow,
	counterRate,
	pushCounter,
	pushFanout,
	restartIncrements,
	sparkAdd,
	sparkBuckets,
	type FanoutSample,
} from "../../../cli/source/data/rates.js"
import type { CounterSample } from "../../../cli/source/data/types.js"

function snap(t: number, offered: number | undefined, dropped: number, bp = false, id = "decoder-a"): FanoutSnapshot {
	return {
		timestamp: new Date(t).toISOString(),
		branches: [
			{
				id,
				decoderId: id.replace("decoder-", ""),
				backpressureActive: bp,
				backpressureEnterCount: 0,
				droppedBytesTotal: dropped,
				droppedChunksTotal: 0,
				bufferBytes: 0,
				highWaterMark: 0,
				...(offered !== undefined ? { totalBytesWritten: offered } : {}),
			},
		],
		backpressureActiveCount: bp ? 1 : 0,
		droppedBytesTotal: dropped,
		droppedChunksTotal: 0,
	}
}

const build = (snaps: FanoutSnapshot[]): FanoutSample[] => snaps.reduce<FanoutSample[]>((h, s) => pushFanout(h, s), [])

describe("drop now", () => {
	it("is Δdropped / Δoffered over the trailing 10 s", () => {
		const h = build([snap(0, 1000, 100), snap(5000, 2000, 400)])
		expect(branchDropNow(h, "decoder-a")).toBeCloseTo(0.3)
		expect(aggregateDropNow(h)).toMatchObject({ ratio: 0.3, backpressure: 0, branches: 1, offeredBytesPerSec: 200 })
	})
	it("is unknown for every §10.6 condition", () => {
		expect(branchDropNow(build([snap(0, 1000, 0)]), "decoder-a")).toBeNull()
		expect(branchDropNow(build([snap(0, 1000, 0), snap(1500, 2000, 0)]), "decoder-a")).toBeNull()
		expect(branchDropNow(build([snap(0, 1000, 0), snap(5000, 1000, 0)]), "decoder-a")).toBeNull()
		expect(branchDropNow(build([snap(0, 1000, 50), snap(5000, 2000, 10)]), "decoder-a")).toBeNull()
		expect(branchDropNow(build([snap(0, undefined, 0), snap(5000, undefined, 10)]), "decoder-a")).toBeNull()
		expect(branchDropNow([], "decoder-a")).toBeNull()
	})
	it("only uses deltas, so a server clock ahead of the local clock still computes (review focus 3)", () => {
		const future = Date.now() + 3_600_000
		expect(branchDropNow(build([snap(future, 0, 0), snap(future + 5000, 1000, 250)]), "decoder-a")).toBeCloseTo(0.25)
	})
	it("dedupes by timestamp and keeps only the trailing window", () => {
		const h = build([snap(0, 0, 0), snap(0, 0, 0), snap(20000, 10, 1), snap(25000, 20, 2)])
		expect(h.map(x => x.t)).toEqual([20000, 25000])
	})

	// Feature: cli-dashboard-overhaul, Property 12: drop now
	// Validates: spec §10.6
	it("P12: drop now is in [0,1] or unknown; equals Δd/Δo for two valid samples", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1e9 }),
				fc.integer({ min: 2000, max: 9000 }),
				fc.integer({ min: 0, max: 1e9 }),
				fc.integer({ min: 1, max: 1e9 }),
				fc.integer({ min: 0, max: 1e9 }),
				(o0, dt, d0, dO, dD) => {
					const dDrop = Math.min(dD, dO)
					const h = build([snap(0, o0, d0), snap(dt, o0 + dO, d0 + dDrop)])
					const r = branchDropNow(h, "decoder-a")
					expect(r).not.toBeNull()
					expect(r!).toBeGreaterThanOrEqual(0)
					expect(r!).toBeLessThanOrEqual(1)
					expect(r!).toBeCloseTo(dDrop / dO, 9)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 12: drop now
	// Validates: spec §10.6
	it("P12: any counter decrease makes drop now unknown", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1e6 }), fc.integer({ min: 1, max: 1e6 }), (a, b) => {
				const h = build([snap(0, a + b, a), snap(3000, a, a), snap(6000, a + b + 1, a)])
				expect(branchDropNow(h, "decoder-a")).toBeNull()
			}),
			{ numRuns: 100 },
		)
	})
})

describe("decode rate", () => {
	it("needs 20 s of history and resets on a counter decrease", () => {
		let h: CounterSample[] = []
		h = pushCounter(h, 0, 10, 60000)
		h = pushCounter(h, 10000, 12, 60000)
		expect(counterRate(h)).toBeNull()
		h = pushCounter(h, 30000, 16, 60000)
		expect(counterRate(h)).toBeCloseTo(6 / 30)
		h = pushCounter(h, 40000, 2, 60000)
		expect(h).toEqual([{ t: 40000, v: 2 }])
		expect(counterRate(h)).toBeNull()
	})

	// Feature: cli-dashboard-overhaul, Property 13: decode rate
	// Validates: spec §10.6
	it("P13: rate is ≥ 0 or unknown, and a decrease resets the history", () => {
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 30 }), values => {
				let h: CounterSample[] = []
				values.forEach((v, i) => {
					const before = h[h.length - 1]
					h = pushCounter(h, i * 5000, v, 60000)
					if (before && v < before.v) expect(h).toEqual([{ t: i * 5000, v }])
					const r = counterRate(h)
					if (r !== null) expect(r).toBeGreaterThanOrEqual(0)
				})
			}),
			{ numRuns: 100 },
		)
	})
})

describe("restarts and sparkline", () => {
	it("counts restart increments inside 5 minutes", () => {
		let h: CounterSample[] = []
		for (const [t, v] of [[0, 10], [60000, 11], [120000, 11], [180000, 13]] as const) h = pushCounter(h, t, v, 300000)
		expect(restartIncrements(h, 180000)).toBe(3)
		expect(restartIncrements(h, 180000 + 300001)).toBe(0)
	})
	it("leaves unobserved minutes undefined", () => {
		let spark: Record<string, number> = {}
		spark = sparkAdd(spark, undefined, { t: 600000, v: 5 })
		spark = sparkAdd(spark, { t: 600000, v: 5 }, { t: 660000, v: 8 })
		const b = sparkBuckets(spark, 660000)
		expect(b).toHaveLength(30)
		expect(b[29]).toBe(3)
		expect(b[28]).toBe(0)
		expect(b[27]).toBeUndefined()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/rates.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/rates.ts`**

```ts
import type { FanoutSnapshot } from "@wavekit/api-types"
import type { CounterSample, FanoutBranchSample, FanoutSample } from "./types.js"

export type { FanoutSample } from "./types.js"

export const DROP_WINDOW_MS = 10_000
export const MIN_DROP_SPAN_MS = 2_000
export const RATE_WINDOW_MS = 60_000
export const MIN_RATE_SPAN_MS = 20_000
export const RESTART_WINDOW_MS = 300_000
export const SPARK_MINUTES = 30

export function fanoutSample(s: FanoutSnapshot): FanoutSample | null {
	const t = Date.parse(s.timestamp)
	if (!Number.isFinite(t)) return null
	const branches: Record<string, FanoutBranchSample> = {}
	for (const b of s.branches) {
		branches[b.id] = {
			dropped: b.droppedBytesTotal,
			backpressure: b.backpressureActive,
			...(b.decoderId !== undefined ? { decoderId: b.decoderId } : {}),
			...(b.totalBytesWritten !== undefined ? { offered: b.totalBytesWritten } : {}),
		}
	}
	return { t, branches }
}

/** Add a snapshot (deduped by server timestamp) and keep the trailing 10 s by server time. */
export function pushFanout(history: readonly FanoutSample[], s: FanoutSnapshot): FanoutSample[] {
	const sample = fanoutSample(s)
	if (!sample || history.some(h => h.t === sample.t)) return [...history]
	const next = [...history, sample].sort((a, b) => a.t - b.t)
	const newest = next[next.length - 1]?.t ?? sample.t
	return next.filter(h => h.t >= newest - DROP_WINDOW_MS)
}

export interface BranchDelta {
	dDropped: number
	dOffered: number
	spanMs: number
}

export function branchDelta(history: readonly FanoutSample[], branchId: string): BranchDelta | null {
	const pts: Array<{ t: number; b: FanoutBranchSample }> = []
	for (const h of history) {
		const b = h.branches[branchId]
		if (b) pts.push({ t: h.t, b })
	}
	if (pts.length < 2) return null
	for (let i = 1; i < pts.length; i++) {
		const prev = pts[i - 1]
		const cur = pts[i]
		if (!prev || !cur || prev.b.offered === undefined || cur.b.offered === undefined) return null
		if (cur.b.offered < prev.b.offered || cur.b.dropped < prev.b.dropped) return null
	}
	const first = pts[0]
	const last = pts[pts.length - 1]
	if (!first || !last || first.b.offered === undefined || last.b.offered === undefined) return null
	const spanMs = last.t - first.t
	const dOffered = last.b.offered - first.b.offered
	if (spanMs < MIN_DROP_SPAN_MS || dOffered <= 0) return null
	return { dDropped: last.b.dropped - first.b.dropped, dOffered, spanMs }
}

export function branchDropNow(history: readonly FanoutSample[], branchId: string): number | null {
	const d = branchDelta(history, branchId)
	return d === null ? null : Math.min(1, Math.max(0, d.dDropped / d.dOffered))
}

export interface AggregateDrop {
	ratio: number | null
	/** Decoder branches in backpressure in the newest sample. */
	backpressure: number
	/** Decoder branches in the newest sample. */
	branches: number
	/** Mean offered bytes/s per decoder branch. */
	offeredBytesPerSec: number | null
}

function sumOver(history: readonly FanoutSample[], ids: string[]): { ratio: number | null; rates: number[] } {
	let dd = 0
	let dof = 0
	const rates: number[] = []
	for (const id of ids) {
		const d = branchDelta(history, id)
		if (!d) continue
		dd += d.dDropped
		dof += d.dOffered
		rates.push((d.dOffered / d.spanMs) * 1000)
	}
	return { ratio: dof > 0 ? Math.min(1, Math.max(0, dd / dof)) : null, rates }
}

/** Σ Δ dropped / Σ Δ offered over branches with a decoderId. */
export function aggregateDropNow(history: readonly FanoutSample[]): AggregateDrop {
	const newest = history[history.length - 1]
	if (!newest) return { ratio: null, backpressure: 0, branches: 0, offeredBytesPerSec: null }
	const ids = Object.entries(newest.branches)
		.filter(([, b]) => b.decoderId !== undefined)
		.map(([id]) => id)
	const backpressure = ids.filter(id => newest.branches[id]?.backpressure === true).length
	const { ratio, rates } = sumOver(history, ids)
	return {
		ratio,
		backpressure,
		branches: ids.length,
		offeredBytesPerSec: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
	}
}

/** Branches without a decoderId (the tuner relay), reported separately. */
export function relayDropNow(history: readonly FanoutSample[]): number | null {
	const newest = history[history.length - 1]
	if (!newest) return null
	const ids = Object.entries(newest.branches)
		.filter(([, b]) => b.decoderId === undefined)
		.map(([id]) => id)
	return sumOver(history, ids).ratio
}

/** Append a counter sample; a decrease resets the history; samples older than the window are dropped. */
export function pushCounter(
	history: readonly CounterSample[],
	t: number,
	v: number,
	windowMs: number,
): CounterSample[] {
	const last = history[history.length - 1]
	if (last && v < last.v) return [{ t, v }]
	if (last && t <= last.t) return [...history]
	return [...history, { t, v }].filter(s => s.t >= t - windowMs)
}

/** Per-second rate once the history spans ≥ 20 s; null otherwise. */
export function counterRate(history: readonly CounterSample[]): number | null {
	const first = history[0]
	const last = history[history.length - 1]
	if (!first || !last) return null
	const span = last.t - first.t
	if (span < MIN_RATE_SPAN_MS) return null
	return Math.max(0, ((last.v - first.v) / span) * 1000)
}

export function restartIncrements(history: readonly CounterSample[], now: number): number {
	let n = 0
	for (let i = 1; i < history.length; i++) {
		const prev = history[i - 1]
		const cur = history[i]
		if (!prev || !cur || cur.t < now - RESTART_WINDOW_MS) continue
		if (cur.v > prev.v) n += cur.v - prev.v
	}
	return n
}

export function sparkAdd(
	spark: Readonly<Record<string, number>>,
	prev: CounterSample | undefined,
	cur: CounterSample,
): Record<string, number> {
	const minute = Math.floor(cur.t / 60_000)
	const delta = prev && cur.v >= prev.v ? cur.v - prev.v : 0
	const next: Record<string, number> = {}
	for (const [k, v] of Object.entries(spark)) {
		if (Number(k) > minute - SPARK_MINUTES) next[k] = v
	}
	const key = String(minute)
	next[key] = (next[key] ?? 0) + delta
	return next
}

/** 30 one-minute buckets, oldest first; undefined = not observed. */
export function sparkBuckets(spark: Readonly<Record<string, number>>, now: number): Array<number | undefined> {
	const m = Math.floor(now / 60_000)
	return Array.from({ length: SPARK_MINUTES }, (_, i) => spark[String(m - (SPARK_MINUTES - 1) + i)])
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/rates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/rates.ts tests/unit/cli/rates.test.ts
git commit -m "feat(cli): windowed drop-now, decode rate, restart and sparkline maths

Properties 12 and 13 (spec §10.6).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 11: Decoder process state (A)

**Owner:** A · **Spec:** T3, §10.7, P16

**Files:**
- Create: `cli/source/data/decoder-state.ts`
- Test: `tests/unit/cli/decoder-state.test.ts`

**Interfaces:**
- Consumes: `DecoderRow`, `DecoderSession`, `GlyphRole` from `types.ts`.
- Produces:
  - `type ProcState = "faulted" | "crash-loop" | "stopped" | "down" | "starting" | "up"`
  - `STARTING_UPTIME_S = 10`, `CRASH_LOOP_INCREMENTS = 2`
  - `processState(d: DecoderRow, restartIncrements5m: number, stoppedByCli: boolean): ProcState`
  - `procRole(s: ProcState): GlyphRole`, `isFailing(s: ProcState): boolean`
  - `lastDecodeAt(d: DecoderRow, session: DecoderSession | undefined): number | null`
  - `type DecodesFact = { kind: "na" } | { kind: "rate"; perSec: number; lastAt: number | null } | { kind: "last"; lastAt: number } | { kind: "none"; uptimeSec: number } | { kind: "total"; count: number }`
  - `decodesFact(d: DecoderRow, ratePerSec: number | null, lastAt: number | null): DecodesFact`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/decoder-state.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	decodesFact,
	lastDecodeAt,
	procRole,
	processState,
} from "../../../cli/source/data/decoder-state.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"

function row(over: Partial<DecoderRow> = {}): DecoderRow {
	return {
		id: "acarsdec",
		type: "acarsdec",
		running: true,
		health: "running",
		uptime: 51,
		stats: { bytesIn: 1, eventsOut: 0, errors: 0 },
		restartCount: 0,
		...over,
	}
}

describe("processState (§10.7)", () => {
	it("follows the rule order", () => {
		expect(processState(row({ health: "faulted", running: true }), 5, false)).toBe("faulted")
		expect(processState(row({ running: true }), 2, false)).toBe("crash-loop")
		expect(processState(row({ running: false }), 0, true)).toBe("stopped")
		expect(processState(row({ running: false, health: "running", restartCount: 13 }), 0, false)).toBe("down")
		expect(processState(row({ uptime: 4 }), 0, false)).toBe("starting")
		expect(processState(row({ uptime: 4, stats: { bytesIn: 1, eventsOut: 1, errors: 0 } }), 0, false)).toBe("up")
		expect(processState(row({ health: "idle" }), 0, false)).toBe("up")
	})

	// Feature: cli-dashboard-overhaul, Property 16: process state
	// Validates: spec T3, §10.7
	it("P16: red iff faulted/crash-loop/down; idle never red; not running never up/starting", () => {
		const arb = fc.record({
			running: fc.boolean(),
			health: fc.constantFrom("running", "idle", "faulted") as fc.Arbitrary<DecoderRow["health"]>,
			uptime: fc.integer({ min: 0, max: 100000 }),
			eventsOut: fc.integer({ min: 0, max: 100 }),
			restartCount: fc.integer({ min: 0, max: 50 }),
			inc: fc.integer({ min: 0, max: 5 }),
			stopped: fc.boolean(),
		})
		fc.assert(
			fc.property(arb, a => {
				const d = row({ running: a.running, health: a.health, uptime: a.uptime, restartCount: a.restartCount, stats: { bytesIn: 0, eventsOut: a.eventsOut, errors: 0 } })
				const s = processState(d, a.inc, a.stopped)
				const red = procRole(s) === "fault"
				expect(red).toBe(s === "faulted" || s === "crash-loop" || s === "down")
				if (a.health === "idle" && a.inc < 2 && a.running) expect(red).toBe(false)
				if (!a.running) expect(["up", "starting"]).not.toContain(s)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("decodes facts", () => {
	it("prefers rate, then last decode, then none-for-uptime, then totals", () => {
		expect(decodesFact(row({ running: false }), 1, 5)).toEqual({ kind: "na" })
		expect(decodesFact(row(), 2 / 60, 1000)).toEqual({ kind: "rate", perSec: 2 / 60, lastAt: 1000 })
		expect(decodesFact(row(), 0, 1000)).toEqual({ kind: "last", lastAt: 1000 })
		expect(decodesFact(row(), null, null)).toEqual({ kind: "none", uptimeSec: 51 })
		expect(decodesFact(row({ stats: { bytesIn: 0, eventsOut: 7, errors: 0 } }), null, null)).toEqual({ kind: "total", count: 7 })
	})
	it("takes the newer of REST lastOutputAt and the newest WS output, even from a future server clock", () => {
		const future = "2099-01-01T00:00:00.000Z"
		expect(lastDecodeAt(row({ lastOutputAt: future }), undefined)).toBe(Date.parse(future))
		expect(lastDecodeAt(row({ lastOutputAt: "2026-10-08T18:00:00.000Z" }), { lastWsOutputAt: Date.parse("2026-10-08T18:05:00.000Z"), lastError: null, previousHealth: null, events: [], restarts: [], spark: {}, firstObservedAt: 0 })).toBe(Date.parse("2026-10-08T18:05:00.000Z"))
		expect(lastDecodeAt(row({ lastOutputAt: null }), undefined)).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/decoder-state.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/decoder-state.ts`**

```ts
import type { DecoderRow, DecoderSession, GlyphRole } from "./types.js"

export type ProcState = "faulted" | "crash-loop" | "stopped" | "down" | "starting" | "up"

export const STARTING_UPTIME_S = 10
export const CRASH_LOOP_INCREMENTS = 2

/** Spec §10.7, evaluated in order. `health` only ever makes a decoder look worse when it is "faulted". */
export function processState(d: DecoderRow, restartIncrements5m: number, stoppedByCli: boolean): ProcState {
	if (d.health === "faulted") return "faulted"
	if (restartIncrements5m >= CRASH_LOOP_INCREMENTS) return "crash-loop"
	if (!d.running) return stoppedByCli ? "stopped" : "down"
	if (d.uptime < STARTING_UPTIME_S && d.stats.eventsOut === 0) return "starting"
	return "up"
}

export function procRole(s: ProcState): GlyphRole {
	switch (s) {
		case "faulted":
		case "crash-loop":
		case "down":
			return "fault"
		case "stopped":
		case "starting":
			return "neutral"
		case "up":
			return "live"
	}
}

export function isFailing(s: ProcState): boolean {
	return procRole(s) === "fault"
}

export function lastDecodeAt(d: DecoderRow, session: DecoderSession | undefined): number | null {
	const rest = d.lastOutputAt ? Date.parse(d.lastOutputAt) : Number.NaN
	const ws = session?.lastWsOutputAt ?? Number.NaN
	const candidates = [rest, ws].filter(Number.isFinite)
	return candidates.length > 0 ? Math.max(...candidates) : null
}

export type DecodesFact =
	| { kind: "na" }
	| { kind: "rate"; perSec: number; lastAt: number | null }
	| { kind: "last"; lastAt: number }
	| { kind: "none"; uptimeSec: number }
	| { kind: "total"; count: number }

export function decodesFact(d: DecoderRow, ratePerSec: number | null, lastAt: number | null): DecodesFact {
	if (!d.running) return { kind: "na" }
	if (ratePerSec !== null && ratePerSec > 0) return { kind: "rate", perSec: ratePerSec, lastAt }
	if (lastAt !== null) return { kind: "last", lastAt }
	if (d.stats.eventsOut === 0) return { kind: "none", uptimeSec: d.uptime }
	return { kind: "total", count: d.stats.eventsOut }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/decoder-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/decoder-state.ts tests/unit/cli/decoder-state.test.ts
git commit -m "feat(cli): decoder process state and decode facts kept separate

Property 16: idle never reads as a fault; not running never reads as up.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 12: Message ring, gaps and aircraft map (A)

**Owner:** A · **Spec:** §10.8, P9

**Files:**
- Create: `cli/source/data/ring-buffer.ts`
- Test: `tests/unit/cli/ring-buffer.test.ts`

**Interfaces:**
- Consumes: `MessageRing`, `MessageEntry`, `Gap`, `AircraftEntry` from `types.ts`. `AircraftState` from api-types.
- Produces (all mutate in place):
  - `RING_CAPACITY = 1000`, `RING_FLOOR = 50`, `AIRCRAFT_TTL_MS = 300_000`
  - `createRing(capacity?, floor?): MessageRing`
  - `ringPush(ring, entry: Omit<MessageEntry, "seq">): MessageEntry`
  - `ringOpenGap(ring, from: number): void`, `ringCloseGap(ring, to: number): void`, `ringNewestSeq(ring): number | null`
  - `aircraftKey(icao: string): string`
  - `aircraftUpsert(map, a: AircraftState, at: number): void`, `aircraftDelete(map, icao): void`, `aircraftPrune(map, now): number` (returns the removed count), `aircraftResync(map, list, at): void`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/ring-buffer.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { AircraftState } from "@wavekit/api-types"
import {
	aircraftPrune,
	aircraftResync,
	aircraftUpsert,
	createRing,
	ringCloseGap,
	ringOpenGap,
	ringPush,
} from "../../../cli/source/data/ring-buffer.js"
import type { AircraftEntry, MessageEntry } from "../../../cli/source/data/types.js"

function entry(decoderId: string, at = 0): Omit<MessageEntry, "seq"> {
	return {
		decoderId,
		type: "t",
		receivedAt: at,
		output: { type: "t", decoder: decoderId, timestamp: "x", data: null },
		formatted: { protocol: "T", category: "other", segments: [], fields: [], emergency: false, searchText: "" },
	}
}

describe("message ring", () => {
	// Feature: cli-dashboard-overhaul, Property 9: message ring
	// Validates: spec §10.8
	it("P9: bounded, ordered, newest kept, per-decoder floor honoured", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 20 }).chain(n =>
					fc.tuple(fc.constant(n), fc.array(fc.integer({ min: 0, max: n - 1 }), { minLength: 1, maxLength: 2500 })),
				),
				([, picks]) => {
					const ring = createRing()
					const inserted = new Map<string, number[]>()
					let newest = -1
					for (const p of picks) {
						const id = `d${p}`
						const e = ringPush(ring, entry(id))
						newest = e.seq
						inserted.set(id, [...(inserted.get(id) ?? []), e.seq])
					}
					expect(ring.entries.length).toBeLessThanOrEqual(1000)
					for (let i = 1; i < ring.entries.length; i++) {
						expect(ring.entries[i]!.seq).toBeGreaterThan(ring.entries[i - 1]!.seq)
					}
					expect(ring.entries.at(-1)?.seq).toBe(newest)
					for (const [id, seqs] of inserted) {
						const kept = ring.entries.filter(e => e.decoderId === id).map(e => e.seq)
						expect(kept.length).toBeGreaterThanOrEqual(Math.min(seqs.length, 50))
						expect(kept).toEqual(seqs.slice(seqs.length - kept.length))
					}
				},
			),
			{ numRuns: 100 },
		)
	})
	it("evicts the overall oldest when every decoder is at the floor", () => {
		const ring = createRing(4, 2)
		for (const id of ["a", "a", "b", "b", "c"]) ringPush(ring, entry(id))
		expect(ring.entries.map(e => e.decoderId)).toEqual(["a", "b", "b", "c"])
	})
})

describe("gaps", () => {
	it("opens after the newest seq and closes with from ≤ to", () => {
		const ring = createRing()
		ringPush(ring, entry("a"))
		ringOpenGap(ring, 5000)
		ringOpenGap(ring, 6000)
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 5000, to: null }])
		ringCloseGap(ring, 4000)
		expect(ring.gaps).toEqual([{ afterSeq: 0, from: 5000, to: 5000 }])
	})
	it("prunes gaps older than the oldest retained entry", () => {
		const ring = createRing(2, 1)
		ringPush(ring, entry("a"))
		ringOpenGap(ring, 1)
		ringCloseGap(ring, 2)
		for (let i = 0; i < 4; i++) ringPush(ring, entry(`x${i}`))
		expect(ring.gaps).toEqual([])
	})
})

describe("aircraft map", () => {
	const ac = (icao: string, over: Partial<AircraftState> = {}): AircraftState => ({ icao, seen: 0, messages: 1, firstSeen: 0, lastUpdated: 0, ...over })
	it("merges identification on update and keys by upper-case ICAO", () => {
		const map = new Map<string, AircraftEntry>()
		aircraftUpsert(map, ac("4ca9d2", { identification: { registration: "EI-DCL" } }), 1)
		aircraftUpsert(map, ac("4CA9D2", { callsign: "RYR4KT", identification: { typeCode: "B738" } }), 2)
		expect(map.get("4CA9D2")?.state).toMatchObject({ callsign: "RYR4KT", identification: { registration: "EI-DCL", typeCode: "B738" } })
	})
	it("prunes after 300 s and resyncs wholesale", () => {
		const map = new Map<string, AircraftEntry>()
		aircraftUpsert(map, ac("a"), 0)
		aircraftUpsert(map, ac("b"), 200_000)
		expect(aircraftPrune(map, 300_001)).toBe(1)
		aircraftResync(map, [ac("c"), ac("d")], 400_000)
		expect([...map.keys()]).toEqual(["C", "D"])
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/ring-buffer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/ring-buffer.ts`**

```ts
import type { AircraftState } from "@wavekit/api-types"
import type { AircraftEntry, MessageEntry, MessageRing } from "./types.js"

export const RING_CAPACITY = 1000
export const RING_FLOOR = 50
export const AIRCRAFT_TTL_MS = 300_000

export function createRing(capacity = RING_CAPACITY, floor = RING_FLOOR): MessageRing {
	return { capacity, floor, entries: [], gaps: [], nextSeq: 0, perDecoder: {}, total: 0 }
}

export function ringNewestSeq(ring: MessageRing): number | null {
	return ring.entries[ring.entries.length - 1]?.seq ?? null
}

function evictOne(ring: MessageRing): void {
	let idx = ring.entries.findIndex(e => (ring.perDecoder[e.decoderId] ?? 0) > ring.floor)
	if (idx < 0) idx = 0
	const [gone] = ring.entries.splice(idx, 1)
	if (gone) ring.perDecoder[gone.decoderId] = Math.max(0, (ring.perDecoder[gone.decoderId] ?? 1) - 1)
}

function pruneGaps(ring: MessageRing): void {
	const oldest = ring.entries[0]?.seq
	if (oldest === undefined) return
	ring.gaps = ring.gaps.filter(g => g.afterSeq >= oldest - 1)
}

/** Append (seq is monotonic for the session). When full, evict the oldest entry of a decoder above the floor, else the overall oldest. */
export function ringPush(ring: MessageRing, e: Omit<MessageEntry, "seq">): MessageEntry {
	const entry: MessageEntry = { ...e, seq: ring.nextSeq }
	ring.nextSeq++
	ring.total++
	ring.entries.push(entry)
	ring.perDecoder[e.decoderId] = (ring.perDecoder[e.decoderId] ?? 0) + 1
	while (ring.entries.length > ring.capacity) evictOne(ring)
	pruneGaps(ring)
	return entry
}

export function ringOpenGap(ring: MessageRing, from: number): void {
	const last = ring.gaps[ring.gaps.length - 1]
	if (last && last.to === null) return
	ring.gaps.push({ afterSeq: ring.nextSeq - 1, from, to: null })
}

export function ringCloseGap(ring: MessageRing, to: number): void {
	const last = ring.gaps[ring.gaps.length - 1]
	if (!last || last.to !== null) return
	last.to = Math.max(to, last.from)
}

export function aircraftKey(icao: string): string {
	return icao.toUpperCase()
}

export function aircraftUpsert(map: Map<string, AircraftEntry>, a: AircraftState, at: number): void {
	const key = aircraftKey(a.icao)
	const prev = map.get(key)?.state
	const identification =
		prev?.identification || a.identification ? { ...prev?.identification, ...a.identification } : undefined
	const merged: AircraftState = {
		...prev,
		...a,
		icao: key,
		...(identification ? { identification } : {}),
	}
	map.set(key, { state: merged, at })
}

export function aircraftDelete(map: Map<string, AircraftEntry>, icao: string): void {
	map.delete(aircraftKey(icao))
}

export function aircraftPrune(map: Map<string, AircraftEntry>, now: number): number {
	let removed = 0
	for (const [key, e] of map) {
		if (now - e.at > AIRCRAFT_TTL_MS) {
			map.delete(key)
			removed++
		}
	}
	return removed
}

export function aircraftResync(map: Map<string, AircraftEntry>, list: readonly AircraftState[], at: number): void {
	map.clear()
	for (const a of list) aircraftUpsert(map, a, at)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/ring-buffer.test.ts`
Expected: PASS. If P9 is slow (> 10 s), lower `maxLength` to 2000. Keep `numRuns: 100`.

- [ ] **Step 5: Commit**

```bash
git add cli/source/data/ring-buffer.ts tests/unit/cli/ring-buffer.test.ts
git commit -m "feat(cli): bounded message ring with per-decoder floor, gaps, aircraft map

Property 9 (spec §10.8).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 13: Nominal bands and the tuned window (A)

**Owner:** A · **Spec:** T7, §10.9, P14, P15

**Files:**
- Create: `cli/source/data/nominal-bands.ts`
- Create: `cli/source/data/window.ts`
- Test: `tests/unit/cli/window.test.ts`

**Interfaces:**
- Consumes: `DecoderRow` from `types.ts`. `ExtendedSourceStatus`, `TunerState`, `TunerRelayStatus` from api-types.
- Produces:
  - `type NominalBand = { kind: "tuned"; label: "tuned" } | { kind: "channels"; channelsMHz: readonly number[]; label: string }`
  - `NOMINAL_BANDS: Readonly<Record<string, NominalBand>>`, `bandFor(type: string): NominalBand | undefined`
  - `interface TunedWindow { sourceId: string; centreHz: number; sampleRate: number; loHz: number; hiHz: number }`
  - `windowFor(sourceId, tuners, sources, relay): TunedWindow | null`
  - `decoderSourceId(decoderId, sources): string | null`
  - `type Membership = "in" | "out" | "?" | "—"`
  - `membership(band: NominalBand | undefined, win: TunedWindow | null): Membership`
  - `decoderMembership(d: DecoderRow, sources, tuners, relay): Membership`
  - `interface RetuneImpact { tuned: string[]; enters: string[]; leaves: string[] }`
  - `retuneImpact(decoders: ReadonlyArray<{ id: string; type: string }>, from: TunedWindow | null, to: TunedWindow): RetuneImpact`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/window.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import { bandFor, type NominalBand } from "../../../cli/source/data/nominal-bands.js"
import {
	decoderMembership,
	membership,
	retuneImpact,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"

const win = (centreHz: number, sampleRate = 2_048_000): TunedWindow => ({
	sourceId: "s",
	centreHz,
	sampleRate,
	loHz: centreHz - sampleRate / 2,
	hiHz: centreHz + sampleRate / 2,
})

function src(id: string, centreHz: number, decoders: string[]): ExtendedSourceStatus {
	return {
		id, connected: true, consumers: 1, bytesReceived: 0, dataRate: 0, reconnectAttempts: 0, available: true,
		caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ", exclusive: false, centerFreq: centreHz },
		assignments: decoders.map(d => ({ decoderId: d, sourceId: id, assignedAt: "t" })),
	}
}
const dec = (id: string, type = id): DecoderRow => ({ id, type, running: true, health: "running", uptime: 1, stats: { bytesIn: 0, eventsOut: 0, errors: 0 }, restartCount: 0 })

describe("nominal bands", () => {
	it("labels the spec table", () => {
		expect(bandFor("readsb")?.label).toBe("1090.000")
		expect(bandFor("acarsdec")?.label).toBe("131.550–131.825")
		expect(bandFor("dsd-fme")?.kind).toBe("tuned")
		expect(bandFor("mystery")).toBeUndefined()
	})
})

describe("window", () => {
	it("prefers TunerState, then caps.centerFreq, then relay.lastFrequency", () => {
		const tuner = { sourceId: "pi-iq", frequency: 445_970_700, sampleRate: 2_048_000 } as TunerState
		expect(windowFor("pi-iq", [tuner], [], undefined)?.loHz).toBe(444_946_700)
		expect(windowFor("pi-iq", [], [src("pi-iq", 100_000_000, [])], undefined)?.centreHz).toBe(100_000_000)
		expect(windowFor("pi-iq", [], [], undefined)).toBeNull()
	})
	it("handles two sources with decoders split between them (review focus 5)", () => {
		const sources = [src("a", 433_920_000, ["rtl433"]), src("b", 1_090_000_000, ["readsb", "ais-catcher"])]
		expect(decoderMembership(dec("rtl433"), sources, [], undefined)).toBe("in")
		expect(decoderMembership(dec("readsb"), sources, [], undefined)).toBe("in")
		expect(decoderMembership(dec("ais-catcher"), sources, [], undefined)).toBe("out")
		expect(decoderMembership(dec("dumpvdl2"), sources, [], undefined)).toBe("?")
		expect(decoderMembership({ ...dec("acarsdec"), caps: { input: "external", output: "jsonl", integrationPattern: "external_sdr" } }, sources, [], undefined)).toBe("—")
		expect(decoderMembership(dec("weird", "mystery"), [src("only", 1e8, [])], [], undefined)).toBe("?")
	})

	// Feature: cli-dashboard-overhaul, Property 14: window membership
	// Validates: spec §10.9
	it("P14: tuned → in; a channel at the centre → in; all channels outside half-span → out; no window → ?", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 24, max: 1900, noNaN: true }), { minLength: 1, maxLength: 4 }),
				fc.integer({ min: 250_000, max: 3_200_000 }),
				(channels, rate) => {
					const band: NominalBand = { kind: "channels", channelsMHz: channels, label: "x" }
					expect(membership({ kind: "tuned", label: "tuned" }, null)).toBe("in")
					expect(membership(band, win(channels[0]! * 1e6, rate))).toBe("in")
					const far = Math.max(...channels) * 1e6 + rate
					expect(membership(band, win(far + 1, rate))).toBe("out")
					expect(membership(band, null)).toBe("?")
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 15: retune impact
	// Validates: spec §10.9
	it("P15: retuneImpact = tuned ∪ decoders whose membership flips", () => {
		const types = ["readsb", "ais-catcher", "acarsdec", "dumpvdl2", "direwolf", "rtl433", "lora-meshtastic", "dsd-fme", "multimon-ng"]
		fc.assert(
			fc.property(fc.integer({ min: 24_000_000, max: 1_900_000_000 }), fc.integer({ min: 24_000_000, max: 1_900_000_000 }), (a, b) => {
				const decoders = types.map(t => ({ id: t, type: t }))
				const r = retuneImpact(decoders, win(a), win(b))
				expect(r.tuned.sort()).toEqual(["dsd-fme", "multimon-ng"])
				for (const d of decoders) {
					if (bandFor(d.type)?.kind === "tuned") continue
					const before = membership(bandFor(d.type), win(a)) === "in"
					const after = membership(bandFor(d.type), win(b)) === "in"
					expect(r.enters.includes(d.id)).toBe(!before && after)
					expect(r.leaves.includes(d.id)).toBe(before && !after)
				}
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/window.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `cli/source/data/nominal-bands.ts`**

```ts
export type NominalBand =
	| { kind: "tuned"; label: "tuned" }
	| { kind: "channels"; channelsMHz: readonly number[]; label: string }

const TUNED: NominalBand = { kind: "tuned", label: "tuned" }

/** CLI-owned nominal table keyed by decoder TYPE (spec §10.9). Replaced by the API band when request 2 lands. */
export const NOMINAL_BANDS: Readonly<Record<string, NominalBand>> = {
	readsb: { kind: "channels", channelsMHz: [1090.0], label: "1090.000" },
	"ais-catcher": { kind: "channels", channelsMHz: [161.975, 162.025], label: "161.975/162.025" },
	acarsdec: { kind: "channels", channelsMHz: [131.55, 131.725, 131.825], label: "131.550–131.825" },
	dumpvdl2: { kind: "channels", channelsMHz: [136.65, 136.7, 136.975], label: "136.650–136.975" },
	direwolf: { kind: "channels", channelsMHz: [144.39, 144.8], label: "144.390/144.800" },
	rtl433: { kind: "channels", channelsMHz: [433.92], label: "433.920" },
	"lora-meshtastic": { kind: "channels", channelsMHz: [869.525, 906.875], label: "869.525/906.875" },
	"dsd-fme": TUNED,
	"multimon-ng": TUNED,
}

export function bandFor(type: string): NominalBand | undefined {
	return NOMINAL_BANDS[type]
}
```

- [ ] **Step 4: Write `cli/source/data/window.ts`**

```ts
import type { ExtendedSourceStatus, TunerRelayStatus, TunerState } from "@wavekit/api-types"
import { bandFor, type NominalBand } from "./nominal-bands.js"
import type { DecoderRow } from "./types.js"

export interface TunedWindow {
	sourceId: string
	centreHz: number
	sampleRate: number
	loHz: number
	hiHz: number
}

/** centre ± sampleRate/2. Centre: TunerState → caps.centerFreq → relay.lastFrequency. Rate: TunerState → caps. */
export function windowFor(
	sourceId: string,
	tuners: readonly TunerState[] | undefined,
	sources: readonly ExtendedSourceStatus[] | undefined,
	relay: TunerRelayStatus | undefined,
): TunedWindow | null {
	const t = tuners?.find(x => x.sourceId === sourceId)
	const s = sources?.find(x => x.id === sourceId)
	const relayFreq = relay && (relay.sourceId === undefined || relay.sourceId === sourceId) ? relay.lastFrequency : undefined
	const centreHz = t?.frequency ?? s?.caps.centerFreq ?? relayFreq
	const sampleRate = t?.sampleRate ?? s?.caps.sampleRate
	if (centreHz === undefined || sampleRate === undefined || sampleRate <= 0) return null
	return { sourceId, centreHz, sampleRate, loHz: centreHz - sampleRate / 2, hiHz: centreHz + sampleRate / 2 }
}

/** The assignments entry, else the single source when exactly one exists. */
export function decoderSourceId(decoderId: string, sources: readonly ExtendedSourceStatus[] | undefined): string | null {
	if (!sources) return null
	for (const s of sources) if (s.assignments.some(a => a.decoderId === decoderId)) return s.id
	return sources.length === 1 ? (sources[0]?.id ?? null) : null
}

export type Membership = "in" | "out" | "?" | "—"

export function membership(band: NominalBand | undefined, win: TunedWindow | null): Membership {
	if (band?.kind === "tuned") return "in"
	if (!band || !win) return "?"
	const half = win.sampleRate / 2
	return band.channelsMHz.some(c => Math.abs(c * 1e6 - win.centreHz) <= half) ? "in" : "out"
}

export function decoderMembership(
	d: DecoderRow,
	sources: readonly ExtendedSourceStatus[] | undefined,
	tuners: readonly TunerState[] | undefined,
	relay: TunerRelayStatus | undefined,
): Membership {
	const assigned = sources?.some(s => s.assignments.some(a => a.decoderId === d.id)) ?? false
	if (d.caps?.integrationPattern === "external_sdr" && !assigned) return "—"
	const band = bandFor(d.type)
	if (band?.kind === "tuned") return "in"
	const sid = decoderSourceId(d.id, sources)
	if (sid === null) return "?"
	return membership(band, windowFor(sid, tuners, sources, relay))
}

export interface RetuneImpact {
	tuned: string[]
	enters: string[]
	leaves: string[]
}

export function retuneImpact(
	decoders: ReadonlyArray<{ id: string; type: string }>,
	from: TunedWindow | null,
	to: TunedWindow,
): RetuneImpact {
	const out: RetuneImpact = { tuned: [], enters: [], leaves: [] }
	for (const d of decoders) {
		const band = bandFor(d.type)
		if (band?.kind === "tuned") {
			out.tuned.push(d.id)
			continue
		}
		const before = membership(band, from) === "in"
		const after = membership(band, to) === "in"
		if (!before && after) out.enters.push(d.id)
		if (before && !after) out.leaves.push(d.id)
	}
	return out
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/window.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/source/data/nominal-bands.ts cli/source/data/window.ts tests/unit/cli/window.test.ts
git commit -m "feat(cli): nominal band table, tuned window and retune impact

Properties 14 and 15 (spec §10.9); membership is labelled nominal.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 14: Reducer (A)

**Owner:** A · **Spec:** §10.5 inbound → lane table, §10.8 gaps, P18, P19; research (a) event shapes

**Files:**
- Create: `cli/source/data/reducers.ts`
- Test: `tests/unit/cli/reducers.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 10, 12.
- Produces:
  - `interface ReduceDeps { summarize(output: DecoderOutput, decoderId: string, lookup: AircraftLookup): FormattedMessage }`
  - `PLAIN_SUMMARY: ReduceDeps`
  - `initialState(now: number): AppState`
  - `reduce(state: AppState, batch: readonly Inbound[], now: number, deps?: ReduceDeps): AppState`. It returns the same object when nothing changed. It advances `state.now` (and prunes aircraft) only when a 1 s boundary has passed, before folding the batch.
  - `endpointsFor(intent: WriteIntent): Endpoint[]`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/reducers.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { AircraftState, FanoutSnapshot } from "@wavekit/api-types"
import { initialState, reduce } from "../../../cli/source/data/reducers.js"
import type { AppState, DecoderRow, Inbound, RestInbound } from "../../../cli/source/data/types.js"

const T0 = 1_000_000

const decoder = (over: Partial<DecoderRow> = {}): DecoderRow => ({
	id: "readsb", type: "readsb", running: true, health: "running", uptime: 51,
	stats: { bytesIn: 1, eventsOut: 0, errors: 0 }, restartCount: 0, ...over,
})
const fanout = (t: number, offered: number, dropped: number): FanoutSnapshot => ({
	timestamp: new Date(t).toISOString(),
	branches: [{ id: "decoder-readsb", decoderId: "readsb", backpressureActive: false, backpressureEnterCount: 0, droppedBytesTotal: dropped, droppedChunksTotal: 0, bufferBytes: 0, highWaterMark: 0, totalBytesWritten: offered }],
	backpressureActiveCount: 0, droppedBytesTotal: dropped, droppedChunksTotal: 0, totalBytesWritten: offered,
})
const ac = (icao: string): AircraftState => ({ icao, seen: 0, messages: 1, firstSeen: 0, lastUpdated: 0 })

const restOk = (at: number, rows: DecoderRow[]): Inbound => ({ kind: "rest", endpoint: "decoders", outcome: { ok: true, value: rows, rejected: 0 }, at }) as RestInbound
const output = (at: number, decoderId = "dsd-fme"): Inbound => ({ kind: "ws", at, event: { type: "decoder:output", decoderId, output: { type: "call_end", decoder: decoderId, timestamp: "t", data: {} } } })

/** A pool of inbound factories; P18/P19 draw sequences from it. */
const POOL: Array<(at: number) => Inbound> = [
	at => restOk(at, [decoder({ stats: { bytesIn: 1, eventsOut: Math.floor(at / 1000), errors: 0 } })]),
	at => ({ kind: "rest", endpoint: "status", outcome: { ok: false, error: { kind: "network", message: "ECONNREFUSED", at } }, at }) as RestInbound,
	at => output(at),
	at => ({ kind: "ws", at, event: { type: "fanout:snapshot", snapshot: fanout(at, at * 10, at) } }),
	at => ({ kind: "ws", at, event: { type: "decoder:health", decoderId: "readsb", health: "idle" } }),
	at => ({ kind: "ws", at, event: { type: "metrics", sourceId: "pi-iq", bytesReceived: at, dataRate: 3994 } }),
	at => ({ kind: "ws", at, event: { type: "aircraft:update", aircraft: ac(`a${at % 3}`) } }),
	at => ({ kind: "ws", at, event: { type: "resources:alert", alert: { type: "container-cpu", severity: "critical", message: "High CPU usage: 273.5%", timestamp: "t" } } }),
	at => ({ kind: "ws:close", at, code: 1006, reason: "", nextRetryAt: at + 1000 }),
	at => ({ kind: "ws:open", at }),
	at => ({ kind: "ws:invalid", at }),
]

const comparable = (s: AppState) =>
	JSON.stringify({ ...s, aircraft: { ...s.aircraft, map: [...s.aircraft.map.entries()] } })

const seq = fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 60 })
const build = (picks: number[]): Inbound[] => picks.map((p, i) => POOL[p]!(T0 + i * 100))

describe("reduce", () => {
	// Feature: cli-dashboard-overhaul, Property 18: batched reduce
	// Validates: spec §10.5
	it("P18: reduce(s, batch) equals folding reduce over single events", () => {
		fc.assert(
			fc.property(seq, picks => {
				const items = build(picks)
				const now = T0 + 10_000
				const batched = reduce(initialState(T0), items, now)
				const folded = items.reduce((s, item) => reduce(s, [item], now), initialState(T0))
				expect(comparable(batched)).toBe(comparable(folded))
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 19: reconnect
	// Validates: spec §10.5, §10.8
	it("P19: one gap per disconnect with from ≤ to; histories empty after ws:open", () => {
		fc.assert(
			fc.property(seq, picks => {
				const items: Inbound[] = [{ kind: "ws:open", at: T0 - 1 }, ...build(picks)]
				let s = initialState(T0)
				let open = true
				let disconnects = 0
				for (const item of items) {
					s = reduce(s, [item], T0 + 10_000)
					if (item.kind === "ws:close" && open) disconnects++
					if (item.kind === "ws:close") open = false
					if (item.kind === "ws:open") {
						open = true
						expect(s.fanoutHistory).toEqual([])
						for (const sess of Object.values(s.session)) expect(sess.events).toEqual([])
					}
				}
				const gaps = s.messages.ring.gaps
				expect(gaps.length).toBeLessThanOrEqual(disconnects)
				for (const g of gaps) if (g.to !== null) expect(g.from).toBeLessThanOrEqual(g.to)
			}),
			{ numRuns: 100 },
		)
	})

	it("counts exactly one gap per disconnect while entries are retained", () => {
		let s = reduce(initialState(T0), [{ kind: "ws:open", at: T0 }, output(T0 + 1)], T0 + 2)
		s = reduce(s, [{ kind: "ws:close", at: T0 + 10, code: 1006, reason: "", nextRetryAt: T0 + 1010 }, { kind: "ws:close", at: T0 + 20, code: 1006, reason: "", nextRetryAt: T0 + 1020 }], T0 + 30)
		s = reduce(s, [{ kind: "ws:open", at: T0 + 50 }], T0 + 60)
		expect(s.messages.ring.gaps).toEqual([{ afterSeq: 0, from: T0 + 1, to: T0 + 50 }])
	})

	it("replaces aircraft keys with the REST resync list", () => {
		let s = reduce(initialState(T0), [{ kind: "ws", at: T0, event: { type: "aircraft:new", aircraft: ac("zzz") } }], T0)
		s = reduce(s, [{ kind: "rest", endpoint: "aircraft", at: T0 + 1, outcome: { ok: true, rejected: 0, value: { aircraft: [ac("abc"), ac("def")], timestamp: 1, stats: { aircraftCount: 2, withPosition: 0, withCallsign: 0, enrichedCount: 0, messagesProcessed: 0, messagesPerSecond: 0, enrichmentCache: { hits: 0, misses: 0, size: 0 } } } } } as RestInbound], T0 + 1)
		expect([...s.aircraft.map.keys()].sort()).toEqual(["ABC", "DEF"])
	})

	it("records previousHealth itself (core never sends it)", () => {
		let s = reduce(initialState(T0), [restOk(T0, [decoder({ health: "running" })])], T0)
		s = reduce(s, [{ kind: "ws", at: T0 + 1, event: { type: "decoder:health", decoderId: "readsb", health: "idle" } }], T0 + 1)
		expect(s.decoders.value?.[0]?.health).toBe("idle")
		expect(s.session["readsb"]?.previousHealth).toBe("running")
		expect(s.decoders.receivedAt).toBe(T0)
	})

	it("keeps cached values on REST errors and clears the error on success", () => {
		let s = reduce(initialState(T0), [restOk(T0, [decoder()])], T0)
		s = reduce(s, [{ kind: "rest", endpoint: "decoders", at: T0 + 5000, outcome: { ok: false, error: { kind: "timeout", message: "timeout 2s", at: T0 + 5000 } } } as RestInbound], T0 + 5000)
		expect(s.decoders.value).toHaveLength(1)
		expect(s.decoders.error?.kind).toBe("timeout")
		expect(s.conn.rest.failing).toEqual(["decoders"])
		s = reduce(s, [restOk(T0 + 10000, [decoder()])], T0 + 10000)
		expect(s.decoders.error).toBeUndefined()
		expect(s.conn.rest.failing).toEqual([])
		expect(s.conn.rest.lastOkAt).toBe(T0 + 10000)
	})

	it("schedules polls as effects and resolves decoder actions", () => {
		let s = reduce(initialState(T0), [{ kind: "action:sent", at: T0, key: "decoder:readsb", intent: { kind: "decoder", op: "stop", decoderId: "readsb" } }], T0)
		s = reduce(s, [{ kind: "action:result", at: T0 + 10, key: "decoder:readsb", outcomes: [{ label: "stop", result: { ok: true, status: 200, message: "ok" }, at: T0 + 10 }] }], T0 + 10)
		expect(s.actions.byKey["decoder:readsb"]?.state).toBe("ok")
		expect(s.actions.stoppedByCli).toEqual(["readsb"])
		expect(s.effects.polls).toEqual(["decoders"])
		s = reduce(s, [{ kind: "ws", at: T0 + 20, event: { type: "decoder:stopped", decoderId: "readsb" } }], T0 + 20)
		expect(s.actions.byKey["decoder:readsb"]?.confirmedAt).toBe(T0 + 20)
	})

	it("dedupes alerts by (type, sourceId, severity)", () => {
		const alert: Inbound = { kind: "ws", at: T0, event: { type: "resources:alert", alert: { type: "container-cpu", severity: "critical", message: "High CPU usage: 273.5%", timestamp: "t" } } }
		const s = reduce(initialState(T0), [alert, { ...alert, at: T0 + 5 }], T0 + 5)
		expect(s.alerts).toHaveLength(1)
		expect(s.alerts[0]).toMatchObject({ count: 2, firstAt: T0, lastAt: T0 + 5 })
	})

	it("returns the same object when nothing changed", () => {
		const s = initialState(T0)
		expect(reduce(s, [], T0 + 500)).toBe(s)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/reducers.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/reducers.ts`**

```ts
import type { DecoderOutput, TunerState } from "@wavekit/api-types"
import { emptyLane, laneFail, laneOk } from "./freshness.js"
import { RATE_WINDOW_MS, RESTART_WINDOW_MS, pushCounter, pushFanout, sparkAdd } from "./rates.js"
import {
	aircraftDelete,
	aircraftKey,
	aircraftPrune,
	aircraftResync,
	aircraftUpsert,
	createRing,
	ringCloseGap,
	ringOpenGap,
	ringPush,
} from "./ring-buffer.js"
import {
	POLL_ENDPOINTS,
	RESYNC_ENDPOINTS,
	type AircraftLookup,
	type AppState,
	type ConnState,
	type DecoderRow,
	type DecoderSession,
	type Endpoint,
	type FetchOutcome,
	type FormattedMessage,
	type Inbound,
	type Lane,
	type LaneError,
	type RestInbound,
	type WriteIntent,
	type WsEvent,
} from "./types.js"

export interface ReduceDeps {
	summarize(output: DecoderOutput, decoderId: string, lookup: AircraftLookup): FormattedMessage
}

export const PLAIN_SUMMARY: ReduceDeps = {
	summarize: (output, decoderId) => ({
		protocol: output.type.toUpperCase().slice(0, 8),
		category: "other",
		segments: [],
		fields: [],
		emergency: false,
		searchText: `${decoderId} ${output.type}`.toLowerCase(),
	}),
}

export function initialState(now: number): AppState {
	return {
		conn: {
			target: { base: null, ws: null },
			discovery: { mode: "probing", tried: [] },
			ws: { state: "idle", since: null, code: null, reason: null, nextRetryAt: null, attempt: 0 },
			rest: { lastOkAt: null, lastCycleAt: null, nextAt: null, failing: [], firstFailAt: null, lastError: null },
			invalidFrames: 0,
			rejectedItems: 0,
			lastEventAt: null,
		},
		sources: emptyLane(),
		metrics: {},
		decoders: emptyLane(),
		session: {},
		tuner: emptyLane(),
		tunerLastCommand: {},
		relay: emptyLane(),
		fanout: emptyLane(),
		fanoutHistory: [],
		branchEvents: {},
		resources: emptyLane(),
		alerts: [],
		audio: emptyLane(),
		presets: emptyLane(),
		status: emptyLane(),
		messages: { version: 0, ring: createRing() },
		aircraft: { version: 0, map: new Map(), stats: emptyLane() },
		actions: { byKey: {}, stoppedByCli: [] },
		effects: { polls: [] },
		now,
	}
}

function newSession(at: number): DecoderSession {
	return {
		lastWsOutputAt: null,
		lastError: null,
		previousHealth: null,
		events: [],
		restarts: [],
		spark: {},
		firstObservedAt: at,
	}
}

function addUnique<T>(list: readonly T[], items: readonly T[]): T[] {
	const out = [...list]
	for (const x of items) if (!out.includes(x)) out.push(x)
	return out
}

function withPolls(s: AppState, endpoints: readonly Endpoint[]): AppState {
	const polls = addUnique(s.effects.polls, endpoints)
	return polls.length === s.effects.polls.length ? s : { ...s, effects: { polls } }
}

function patchList<T>(lane: Lane<T[]>, match: (x: T) => boolean, patch: (x: T) => T): Lane<T[]> {
	const list = lane.value
	if (list === undefined) return lane
	let changed = false
	const value = list.map(x => {
		if (!match(x)) return x
		changed = true
		return patch(x)
	})
	return changed ? { ...lane, value } : lane
}

export function endpointsFor(intent: WriteIntent): Endpoint[] {
	switch (intent.kind) {
		case "decoder":
			return ["decoders"]
		case "tuner":
			return ["tuner", "relay"]
		case "audio":
		case "preset":
			return ["audio"]
	}
}

// ---------- REST ----------

function updateSessions(prev: Record<string, DecoderSession>, rows: readonly DecoderRow[], at: number): Record<string, DecoderSession> {
	const next: Record<string, DecoderSession> = { ...prev }
	for (const d of rows) {
		const cur = prev[d.id] ?? newSession(at)
		const lastEvent = cur.events[cur.events.length - 1]
		next[d.id] = {
			...cur,
			events: pushCounter(cur.events, at, d.stats.eventsOut, RATE_WINDOW_MS),
			restarts: pushCounter(cur.restarts, at, d.restartCount, RESTART_WINDOW_MS),
			spark: sparkAdd(cur.spark, lastEvent, { t: at, v: d.stats.eventsOut }),
		}
	}
	return next
}

function restOkConn(conn: ConnState, endpoint: Endpoint, rejected: number, at: number): ConnState {
	return {
		...conn,
		rejectedItems: conn.rejectedItems + rejected,
		rest: {
			...conn.rest,
			lastOkAt: at,
			failing: conn.rest.failing.filter(e => e !== endpoint),
			firstFailAt: null,
		},
	}
}

function restError(s: AppState, endpoint: Endpoint, error: LaneError, at: number): AppState {
	const conn: ConnState = {
		...s.conn,
		rest: {
			...s.conn.rest,
			failing: addUnique(s.conn.rest.failing, [endpoint]),
			lastError: error,
			firstFailAt: s.conn.rest.firstFailAt ?? at,
		},
	}
	switch (endpoint) {
		case "decoders":
			return { ...s, conn, decoders: laneFail(s.decoders, error) }
		case "sources":
			return { ...s, conn, sources: laneFail(s.sources, error) }
		case "tuner":
			return { ...s, conn, tuner: laneFail(s.tuner, error) }
		case "relay":
			return { ...s, conn, relay: laneFail(s.relay, error) }
		case "fanout":
			return { ...s, conn, fanout: laneFail(s.fanout, error) }
		case "resources":
			return { ...s, conn, resources: laneFail(s.resources, error) }
		case "audio":
			return { ...s, conn, audio: laneFail(s.audio, error) }
		case "status":
			return { ...s, conn, status: laneFail(s.status, error) }
		case "presets":
			return { ...s, conn, presets: laneFail(s.presets, error) }
		case "aircraft":
			return { ...s, conn, aircraft: { ...s.aircraft, stats: laneFail(s.aircraft.stats, error) } }
	}
}

function okOr<T>(
	s: AppState,
	endpoint: Endpoint,
	outcome: FetchOutcome<T>,
	at: number,
	onOk: (value: T, conn: ConnState) => AppState,
): AppState {
	if (!outcome.ok) return restError(s, endpoint, outcome.error, at)
	return onOk(outcome.value, restOkConn(s.conn, endpoint, outcome.rejected, at))
}

function reduceRest(s: AppState, item: RestInbound): AppState {
	const at = item.at
	switch (item.endpoint) {
		case "decoders":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				decoders: laneOk(value, at, "rest"),
				session: updateSessions(s.session, value, at),
			}))
		case "sources":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, sources: laneOk(value, at, "rest") }))
		case "tuner":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, tuner: laneOk(value, at, "rest") }))
		case "relay":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, relay: laneOk(value, at, "rest") }))
		case "fanout":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({
				...s,
				conn,
				fanout: laneOk(value, at, "rest"),
				fanoutHistory: pushFanout(s.fanoutHistory, value),
			}))
		case "resources":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, resources: laneOk(value, at, "rest") }))
		case "audio":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, audio: laneOk(value, at, "rest") }))
		case "status":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, status: laneOk(value, at, "rest") }))
		case "presets":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => ({ ...s, conn, presets: laneOk(value, at, "rest") }))
		case "aircraft":
			return okOr(s, item.endpoint, item.outcome, at, (value, conn) => {
				aircraftResync(s.aircraft.map, value.aircraft, at)
				return {
					...s,
					conn,
					aircraft: { version: s.aircraft.version + 1, map: s.aircraft.map, stats: laneOk(value.stats, at, "rest") },
				}
			})
	}
}

// ---------- WS ----------

function upsertTuner(lane: Lane<TunerState[]>, state: TunerState, at: number): Lane<TunerState[]> {
	const list = lane.value ?? []
	const idx = list.findIndex(t => t.sourceId === state.sourceId)
	const value = idx >= 0 ? list.map((t, i) => (i === idx ? state : t)) : [...list, state]
	return laneOk(value, at, "ws")
}

function reduceWs(s: AppState, ev: WsEvent, at: number, deps: ReduceDeps): AppState {
	switch (ev.type) {
		case "decoder:output": {
			const lookup: AircraftLookup = icao => s.aircraft.map.get(aircraftKey(icao))?.state
			const formatted = deps.summarize(ev.output, ev.decoderId, lookup)
			ringPush(s.messages.ring, {
				decoderId: ev.decoderId,
				type: ev.output.type,
				receivedAt: at,
				output: ev.output,
				formatted,
			})
			const sess = s.session[ev.decoderId] ?? newSession(at)
			return {
				...s,
				messages: { version: s.messages.version + 1, ring: s.messages.ring },
				session: { ...s.session, [ev.decoderId]: { ...sess, lastWsOutputAt: at } },
			}
		}
		case "decoder:started":
		case "decoder:stopped": {
			const key = `decoder:${ev.decoderId}`
			const rec = s.actions.byKey[key]
			const actions =
				rec && rec.confirmedAt === null
					? { ...s.actions, byKey: { ...s.actions.byKey, [key]: { ...rec, confirmedAt: at } } }
					: s.actions
			return withPolls({ ...s, actions }, ["decoders"])
		}
		case "decoder:health": {
			const prev = s.decoders.value?.find(d => d.id === ev.decoderId)?.health ?? null
			const sess = s.session[ev.decoderId] ?? newSession(at)
			return {
				...s,
				decoders: patchList(s.decoders, d => d.id === ev.decoderId, d => ({ ...d, health: ev.health })),
				session: {
					...s.session,
					[ev.decoderId]: prev !== null && prev !== ev.health ? { ...sess, previousHealth: prev } : sess,
				},
			}
		}
		case "decoder:error": {
			const sess = s.session[ev.decoderId] ?? newSession(at)
			return { ...s, session: { ...s.session, [ev.decoderId]: { ...sess, lastError: { message: ev.error, at } } } }
		}
		case "source:connected":
			return withPolls({ ...s, sources: patchList(s.sources, x => x.id === ev.sourceId, x => ({ ...x, connected: true })) }, ["sources"])
		case "source:disconnected": {
			const err = ev.error
			return withPolls(
				{
					...s,
					sources: patchList(s.sources, x => x.id === ev.sourceId, x => ({ ...x, connected: false, ...(err !== undefined ? { lastError: err } : {}) })),
				},
				["sources"],
			)
		}
		case "source:error":
			return withPolls({ ...s, sources: patchList(s.sources, x => x.id === ev.sourceId, x => ({ ...x, lastError: ev.error })) }, ["sources"])
		case "source:caps-changed":
			return { ...s, sources: patchList(s.sources, x => x.id === ev.sourceId, x => ({ ...x, caps: ev.caps })) }
		case "metrics":
			return {
				...s,
				metrics: { ...s.metrics, [ev.sourceId]: { bytesReceived: ev.bytesReceived, dataRateKiB: ev.dataRate, at } },
			}
		case "fanout:snapshot":
			return {
				...s,
				fanout: laneOk(ev.snapshot, at, "ws"),
				fanoutHistory: pushFanout(s.fanoutHistory, ev.snapshot),
			}
		case "fanout:backpressure":
			return {
				...s,
				branchEvents: { ...s.branchEvents, [ev.branchId]: { active: true, at, bufferedBytes: ev.bufferedBytes } },
			}
		case "fanout:drain":
			return { ...s, branchEvents: { ...s.branchEvents, [ev.branchId]: { active: false, at } } }
		case "resources:snapshot":
			return { ...s, resources: laneOk(ev.snapshot, at, "ws") }
		case "resources:alert": {
			const a = ev.alert
			const key = `${a.type}|${a.sourceId ?? ""}|${a.severity}`
			const idx = s.alerts.findIndex(x => x.key === key)
			const alerts =
				idx >= 0
					? s.alerts.map((x, i) => (i === idx ? { ...x, alert: a, count: x.count + 1, lastAt: at } : x))
					: [...s.alerts, { key, alert: a, count: 1, firstAt: at, lastAt: at }]
			return { ...s, alerts }
		}
		case "tuner:state-changed":
			return { ...s, tuner: upsertTuner(s.tuner, ev.state, at) }
		case "tuner:control-mode-changed": {
			const patched = patchList(s.tuner, t => t.sourceId === ev.sourceId, t => ({ ...t, controlMode: ev.mode }))
			return patched === s.tuner ? s : { ...s, tuner: { ...patched, receivedAt: at, origin: "ws" } }
		}
		case "tuner:command-sent":
			return {
				...s,
				tunerLastCommand: { ...s.tunerLastCommand, [ev.sourceId]: { command: ev.command, value: ev.value, at } },
			}
		case "live-audio:status":
			return { ...s, audio: laneOk(ev.status, at, "ws") }
		case "live-audio:config": {
			const cur = s.audio.value
			return cur ? { ...s, audio: laneOk({ ...cur, config: ev.config }, at, "ws") } : s
		}
		case "aircraft:new":
		case "aircraft:update":
			aircraftUpsert(s.aircraft.map, ev.aircraft, at)
			return { ...s, aircraft: { ...s.aircraft, version: s.aircraft.version + 1 } }
		case "aircraft:lost":
			aircraftDelete(s.aircraft.map, ev.icao)
			return { ...s, aircraft: { ...s.aircraft, version: s.aircraft.version + 1 } }
		case "aircraft:stats":
			return { ...s, aircraft: { ...s.aircraft, stats: laneOk(ev.stats, at, "ws") } }
		// The POST response carries tuner and audio failures; these frames add nothing the CLI shows.
		case "tuner:error":
		case "live-audio:started":
		case "live-audio:stopped":
		case "live-audio:error":
		case "subscribed":
		case "unsubscribed":
		case "server-error":
			return s
	}
}

function reduceWsOpen(s: AppState, at: number): AppState {
	ringCloseGap(s.messages.ring, at)
	const session: Record<string, DecoderSession> = {}
	for (const [id, sess] of Object.entries(s.session)) session[id] = { ...sess, events: [] }
	return withPolls(
		{
			...s,
			conn: { ...s.conn, ws: { state: "open", since: at, code: null, reason: null, nextRetryAt: null, attempt: 0 } },
			messages: { version: s.messages.version + 1, ring: s.messages.ring },
			fanoutHistory: [],
			session,
		},
		[...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS],
	)
}

function reduceWsClose(s: AppState, item: Extract<Inbound, { kind: "ws:close" }>): AppState {
	let messages = s.messages
	if (s.conn.ws.state === "open") {
		const from = Math.min(item.at, Math.max(s.conn.lastEventAt ?? item.at, s.conn.ws.since ?? 0))
		ringOpenGap(s.messages.ring, from)
		messages = { version: messages.version + 1, ring: messages.ring }
	}
	return {
		...s,
		messages,
		conn: {
			...s.conn,
			ws: {
				...s.conn.ws,
				state: "closed",
				since: item.at,
				code: item.code,
				reason: item.reason,
				nextRetryAt: item.nextRetryAt,
			},
		},
	}
}

// ---------- actions ----------

function reduceActionResult(s: AppState, item: Extract<Inbound, { kind: "action:result" }>): AppState {
	const rec = s.actions.byKey[item.key]
	if (!rec) return s
	const ok = item.outcomes.length > 0 && item.outcomes.every(o => o.result?.ok === true)
	let stopped = s.actions.stoppedByCli
	const intent = rec.intent
	if (intent.kind === "decoder" && ok) {
		const id = intent.decoderId
		stopped = intent.op === "stop" ? addUnique(stopped, [id]) : stopped.filter(x => x !== id)
	}
	return withPolls(
		{
			...s,
			actions: {
				byKey: {
					...s.actions.byKey,
					[item.key]: { ...rec, state: ok ? "ok" : "failed", outcomes: item.outcomes, doneAt: item.at },
				},
				stoppedByCli: stopped,
			},
		},
		endpointsFor(intent),
	)
}

function reduceOne(s: AppState, item: Inbound, deps: ReduceDeps): AppState {
	switch (item.kind) {
		case "rest":
			return reduceRest(s, item)
		case "rest:cycle":
			return { ...s, conn: { ...s.conn, rest: { ...s.conn.rest, lastCycleAt: item.at, nextAt: item.nextAt } } }
		case "ws":
			return reduceWs({ ...s, conn: { ...s.conn, lastEventAt: item.at } }, item.event, item.at, deps)
		case "ws:connecting":
			return { ...s, conn: { ...s.conn, ws: { ...s.conn.ws, state: "connecting", attempt: item.attempt } } }
		case "ws:open":
			return reduceWsOpen(s, item.at)
		case "ws:close":
			return reduceWsClose(s, item)
		case "ws:invalid":
			return { ...s, conn: { ...s.conn, invalidFrames: s.conn.invalidFrames + 1 } }
		case "target":
			return { ...s, conn: { ...s.conn, target: { base: item.base, ws: item.ws }, discovery: item.discovery } }
		case "action:sent":
			return {
				...s,
				actions: {
					...s.actions,
					byKey: {
						...s.actions.byKey,
						[item.key]: {
							key: item.key,
							intent: item.intent,
							sentAt: item.at,
							state: "sent",
							outcomes: [],
							doneAt: null,
							confirmedAt: null,
						},
					},
				},
			}
		case "action:result":
			return reduceActionResult(s, item)
	}
}

/**
 * Fold a batch of inbound items. `now` advances (and stale aircraft are pruned)
 * only when a 1 s boundary has passed, before the batch is applied, so
 * reduce(s, [a, b]) equals reduce(reduce(s, [a]), [b]) (P18).
 */
export function reduce(state: AppState, batch: readonly Inbound[], now: number, deps: ReduceDeps = PLAIN_SUMMARY): AppState {
	let s = state
	if (Math.floor(now / 1000) !== Math.floor(s.now / 1000)) {
		s = { ...s, now }
		if (aircraftPrune(s.aircraft.map, now) > 0) {
			s = { ...s, aircraft: { ...s.aircraft, version: s.aircraft.version + 1 } }
		}
	}
	for (const item of batch) s = reduceOne(s, item, deps)
	return s
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/reducers.test.ts`
Expected: PASS. The P19 test only asserts `gaps ≤ disconnects`, because gaps older than the oldest retained entry are pruned. The deterministic test above checks the exact one-gap-per-disconnect case.

- [ ] **Step 5: Root typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: exit 0. With `exactOptionalPropertyTypes`, the `source:disconnected` patch must use the conditional spread exactly as written.

- [ ] **Step 6: Commit**

```bash
git add cli/source/data/reducers.ts tests/unit/cli/reducers.test.ts
git commit -m "feat(cli): pure inbound reducer with lanes, gaps, effects and actions

Properties 18 and 19 (spec §10.5).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 15: Runtime and the store hook (A)

**Owner:** A · **Spec:** §10.2 poll cycle, §10.5 flush tick, P18 (one commit per tick), research (d) on batching

**Files:**
- Create: `cli/source/data/runtime.ts`
- Create: `cli/source/hooks/use-store.ts`
- Test: `tests/unit/cli/runtime.test.ts`
- Test: `cli/source/hooks/use-store.test.tsx`

**Interfaces:**
- Consumes: Tasks 2, 7, 8, 9, 14.
- Produces:
  - `FLUSH_MS = 200`, `POLL_MS = 5_000`, `REDISCOVER_AFTER_MS = 15_000`
  - `interface Timers { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void; setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void }`, `NODE_TIMERS: Timers` (the interval is unref'd)
  - `interface RuntimeDeps { fetchFn: FetchLike; wsFactory: WsFactory; now(): number; random(): number; timers: Timers; summarize: ReduceDeps["summarize"]; explicit: ApiTarget | null; discover?: (fetchFn: FetchLike) => Promise<{ target: ApiTarget | null; tried: string[] }> }`
  - `interface Runtime { readonly store: Store<AppState>; start(): void; stop(): void; reconnect(): void; send(intent: WriteIntent): void; tick(): void }`
  - `type RuntimeHandle = Pick<Runtime, "store" | "reconnect" | "send">`. This is what the App consumes, and tests fake it.
  - `createRuntime(deps: RuntimeDeps): Runtime`
  - `nodeRuntimeDeps(explicit: ApiTarget | null, summarize: ReduceDeps["summarize"]): RuntimeDeps`
  - `useStore<T, S>(store: Store<T>, selector: (state: T) => S): S`

- [ ] **Step 1: Write the failing runtime tests**

`tests/unit/cli/runtime.test.ts`:

```ts
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FetchLike } from "../../../cli/source/data/config.js"
import { PLAIN_SUMMARY } from "../../../cli/source/data/reducers.js"
import { FLUSH_MS, createRuntime, type Timers } from "../../../cli/source/data/runtime.js"
import type { WsFactory, WsHandlers } from "../../../cli/source/data/ws-client.js"

const TARGET = { base: "http://127.0.0.1:9100", ws: "ws://127.0.0.1:9100/ws", explicit: true }

const fakeTimers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
	setInterval: (fn, ms) => setInterval(fn, ms),
	clearInterval: h => clearInterval(h as NodeJS.Timeout),
}

function wsFake() {
	const sockets: WsHandlers[] = []
	const factory: WsFactory = (_url, h) => {
		sockets.push(h)
		return { send: () => undefined, close: () => undefined }
	}
	return { factory, sockets }
}

const never: FetchLike = () => new Promise(() => undefined)
const okJson = (body: unknown) => Promise.resolve({ ok: true, status: 200, statusText: "OK", json: () => Promise.resolve(body) })

function bodies(url: string): unknown {
	if (url.endsWith("/api/decoders")) return []
	if (url.endsWith("/api/sources")) return []
	if (url.endsWith("/api/tuner")) return []
	return { not: "valid" }
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe("runtime", () => {
	it("commits at most once per flush tick however many events arrive", () => {
		const ws = wsFake()
		const rt = createRuntime({ fetchFn: never, wsFactory: ws.factory, now: () => Date.now(), random: () => 0.5, timers: fakeTimers, summarize: PLAIN_SUMMARY.summarize, explicit: TARGET })
		rt.start()
		const h = ws.sockets[0]!
		h.open()
		h.message(JSON.stringify({ type: "subscribed", data: { channels: [] } }))
		for (let i = 0; i < 500; i++) {
			h.message(JSON.stringify({ type: "decoder:output", channel: "decoders", data: { decoderId: "readsb", output: { type: "aircraft", decoder: "readsb", timestamp: "t", data: {} } } }))
		}
		const before = rt.store.commits()
		vi.advanceTimersByTime(FLUSH_MS)
		expect(rt.store.commits() - before).toBe(1)
		expect(rt.store.get().messages.ring.entries).toHaveLength(500)
		rt.stop()
	})

	// Feature: cli-dashboard-overhaul, Property 18: batched reduce
	// Validates: spec §10.5 (one commit per tick)
	it("P18: k ticks produce at most k commits", () => {
		fc.assert(
			fc.property(fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 15 }), perTick => {
				const ws = wsFake()
				const rt = createRuntime({ fetchFn: never, wsFactory: ws.factory, now: () => Date.now(), random: () => 0.5, timers: fakeTimers, summarize: PLAIN_SUMMARY.summarize, explicit: TARGET })
				rt.start()
				const h = ws.sockets[0]!
				const before = rt.store.commits()
				for (const n of perTick) {
					for (let i = 0; i < n; i++) h.message(JSON.stringify({ type: "metrics", channel: "metrics", data: { sourceId: "s", bytesReceived: i, dataRate: 1 } }))
					vi.advanceTimersByTime(FLUSH_MS)
				}
				expect(rt.store.commits() - before).toBeLessThanOrEqual(perTick.length)
				rt.stop()
			}),
			{ numRuns: 100 },
		)
	})

	it("polls every endpoint and runs scheduled effects after the commit", async () => {
		const fetchFn = vi.fn<FetchLike>(url => okJson(bodies(url)))
		const rt = createRuntime({ fetchFn, wsFactory: wsFake().factory, now: () => Date.now(), random: () => 0.5, timers: fakeTimers, summarize: PLAIN_SUMMARY.summarize, explicit: TARGET })
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		const urls = fetchFn.mock.calls.map(c => c[0])
		for (const p of ["/api/decoders", "/api/sources", "/api/tuner", "/api/tuner-relay", "/api/telemetry/fanout", "/api/resources", "/api/live-audio/status", "/api/status", "/api/live-audio/presets", "/api/aircraft"]) {
			expect(urls).toContain(`${TARGET.base}${p}`)
		}
		expect(rt.store.get().decoders.value).toEqual([])
		expect(rt.store.get().conn.rest.failing).toContain("status")
		rt.stop()
	})

	it("sends tuner commands in order and stops at the first failure", async () => {
		const posts: string[] = []
		const fetchFn: FetchLike = (url, init) => {
			if (init?.method === "POST") {
				posts.push(url)
				return url.endsWith("/frequency")
					? Promise.resolve({ ok: false, status: 409, statusText: "Conflict", json: () => Promise.resolve({ code: "TUNER_CONTROL_EXTERNAL", message: "device busy" }) })
					: okJson({})
			}
			return new Promise(() => undefined)
		}
		const rt = createRuntime({ fetchFn, wsFactory: wsFake().factory, now: () => Date.now(), random: () => 0.5, timers: fakeTimers, summarize: PLAIN_SUMMARY.summarize, explicit: TARGET })
		rt.start()
		rt.send({ kind: "tuner", sourceId: "pi-iq", commands: [
			{ setting: "frequency", body: { hz: 446000000 }, label: "frequency" },
			{ setting: "gain", body: { tenthsDb: 207 }, label: "gain" },
		] })
		await vi.advanceTimersByTimeAsync(FLUSH_MS * 2)
		expect(posts).toEqual([`${TARGET.base}/api/tuner/pi-iq/frequency`])
		const rec = rt.store.get().actions.byKey["tuner:pi-iq"]
		expect(rec?.state).toBe("failed")
		expect(rec?.outcomes.map(o => [o.label, o.result?.status ?? null])).toEqual([["frequency", 409], ["gain", null]])
		rt.stop()
	})

	it("rediscovers after a failed discovery and reports what it tried", async () => {
		const discover = vi.fn(() => Promise.resolve({ target: null, tried: ["127.0.0.1:9000", "127.0.0.1:3000"] }))
		const rt = createRuntime({ fetchFn: never, wsFactory: wsFake().factory, now: () => Date.now(), random: () => 0.5, timers: fakeTimers, summarize: PLAIN_SUMMARY.summarize, explicit: null, discover })
		rt.start()
		await vi.advanceTimersByTimeAsync(FLUSH_MS)
		expect(rt.store.get().conn.discovery).toEqual({ mode: "failed", tried: ["127.0.0.1:9000", "127.0.0.1:3000"] })
		expect(rt.store.get().conn.rest.failing.length).toBeGreaterThan(0)
		await vi.advanceTimersByTimeAsync(15_000)
		expect(discover).toHaveBeenCalledTimes(2)
		rt.stop()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/runtime.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/data/runtime.ts`**

```ts
import { createApiClient } from "./api-client.js"
import { discover as defaultDiscover, type ApiTarget, type FetchLike } from "./config.js"
import { initialState, reduce, type ReduceDeps } from "./reducers.js"
import { createStore, type Store } from "./store.js"
import {
	POLL_ENDPOINTS,
	RESYNC_ENDPOINTS,
	actionKey,
	type ActionResult,
	type AppState,
	type CommandOutcome,
	type Endpoint,
	type FetchOutcome,
	type Inbound,
	type RestInbound,
	type RestValues,
	type WriteIntent,
} from "./types.js"
import { BACKOFF_STEPS_MS, createWsClient, nodeWsFactory, type WsFactory } from "./ws-client.js"

export const FLUSH_MS = 200
export const POLL_MS = 5_000
export const REDISCOVER_AFTER_MS = 15_000
const MAX_BACKOFF_MS = BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1] ?? 15_000

export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
	setInterval(fn: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}

export const NODE_TIMERS: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
	setInterval: (fn, ms) => {
		const h = setInterval(fn, ms)
		h.unref()
		return h
	},
	clearInterval: h => clearInterval(h as NodeJS.Timeout),
}

export interface RuntimeDeps {
	fetchFn: FetchLike
	wsFactory: WsFactory
	now(): number
	random(): number
	timers: Timers
	summarize: ReduceDeps["summarize"]
	explicit: ApiTarget | null
	discover?: (fetchFn: FetchLike) => Promise<{ target: ApiTarget | null; tried: string[] }>
}

export interface Runtime {
	readonly store: Store<AppState>
	start(): void
	stop(): void
	reconnect(): void
	send(intent: WriteIntent): void
	/** One flush: drain the inbound queue, reduce, commit once. Exposed for tests. */
	tick(): void
}

export type RuntimeHandle = Pick<Runtime, "store" | "reconnect" | "send">

export function nodeRuntimeDeps(explicit: ApiTarget | null, summarize: ReduceDeps["summarize"]): RuntimeDeps {
	return {
		fetchFn: (url, init) => fetch(url, init),
		wsFactory: nodeWsFactory,
		now: () => Date.now(),
		random: () => Math.random(),
		timers: NODE_TIMERS,
		summarize,
		explicit,
	}
}

export function createRuntime(deps: RuntimeDeps): Runtime {
	const queue: Inbound[] = []
	const push = (item: Inbound): void => {
		queue.push(item)
	}
	const store = createStore(initialState(deps.now()))
	const reduceDeps: ReduceDeps = { summarize: deps.summarize }
	const discoverFn = deps.discover ?? ((f: FetchLike) => defaultDiscover(f))
	let target: ApiTarget | null = deps.explicit
	let stopped = true
	let flushTimer: unknown = null
	let pollTimer: unknown = null
	let rediscoverTimer: unknown = null
	let discovering = false
	let unreachableSince: number | null = null

	const api = createApiClient({ base: () => target?.base ?? null, fetchFn: deps.fetchFn, now: deps.now })
	const ws = createWsClient({
		url: () => target?.ws ?? null,
		factory: deps.wsFactory,
		emit: push,
		now: deps.now,
		random: deps.random,
		setTimeout: deps.timers.setTimeout,
		clearTimeout: deps.timers.clearTimeout,
	})

	function restInbound<E extends Endpoint>(endpoint: E, outcome: FetchOutcome<RestValues[E]>, at: number): Inbound {
		// TS cannot correlate E across the mapped union; the shape is correct by construction.
		return { kind: "rest", endpoint, outcome, at } as RestInbound
	}

	/** Resolves true when the server answered at all (any non-network outcome). */
	async function fetchOne(endpoint: Endpoint): Promise<boolean> {
		const outcome = await api.get(endpoint)
		push(restInbound(endpoint, outcome, deps.now()))
		return outcome.ok || outcome.error.kind !== "network"
	}

	function schedulePoll(): void {
		if (stopped) return
		if (pollTimer !== null) deps.timers.clearTimeout(pollTimer)
		pollTimer = deps.timers.setTimeout(() => {
			pollTimer = null
			void pollCycle(POLL_ENDPOINTS)
		}, POLL_MS)
	}

	async function pollCycle(endpoints: readonly Endpoint[]): Promise<void> {
		const results = await Promise.allSettled(endpoints.map(fetchOne))
		if (stopped) return
		const at = deps.now()
		push({ kind: "rest:cycle", at, nextAt: at + POLL_MS })
		const answered = results.some(r => r.status === "fulfilled" && r.value)
		if (answered) unreachableSince = null
		else unreachableSince ??= at
		maybeRediscover(at)
		schedulePoll()
	}

	function maybeRediscover(at: number): void {
		if (deps.explicit !== null || discovering || unreachableSince === null) return
		if (at - unreachableSince < REDISCOVER_AFTER_MS) return
		void runDiscovery()
	}

	async function runDiscovery(): Promise<void> {
		discovering = true
		push({ kind: "target", at: deps.now(), base: target?.base ?? null, ws: target?.ws ?? null, discovery: { mode: "probing", tried: [] } })
		const found = await discoverFn(deps.fetchFn)
		discovering = false
		if (stopped) return
		const at = deps.now()
		if (found.target) {
			target = found.target
			unreachableSince = null
			push({ kind: "target", at, base: target.base, ws: target.ws, discovery: { mode: "found", tried: found.tried } })
			ws.reconnectNow()
			void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
			return
		}
		push({ kind: "target", at, base: null, ws: null, discovery: { mode: "failed", tried: found.tried } })
		for (const endpoint of POLL_ENDPOINTS) {
			push(restInbound(endpoint, { ok: false, error: { kind: "network", message: "no API answered", at } }, at))
		}
		push({ kind: "rest:cycle", at, nextAt: at + MAX_BACKOFF_MS })
		rediscoverTimer = deps.timers.setTimeout(() => {
			rediscoverTimer = null
			void runDiscovery()
		}, MAX_BACKOFF_MS)
	}

	function tick(): void {
		const current = store.get()
		const now = deps.now()
		if (queue.length === 0 && Math.floor(now / 1000) === Math.floor(current.now / 1000)) return
		const batch = queue.splice(0, queue.length)
		let next = reduce(current, batch, now, reduceDeps)
		const polls = next.effects.polls
		if (polls.length > 0) {
			next = { ...next, effects: { polls: [] } }
			for (const endpoint of polls) void fetchOne(endpoint)
		}
		store.set(next)
	}

	const stamp = (label: string, result: ActionResult): CommandOutcome => ({ label, result, at: deps.now() })

	async function execute(intent: WriteIntent): Promise<CommandOutcome[]> {
		switch (intent.kind) {
			case "decoder":
				return [stamp(intent.op, await api.decoder(intent.decoderId, intent.op))]
			case "audio":
				return [stamp(intent.op, await api.audio(intent.op))]
			case "preset":
				return [stamp(`preset ${intent.name}`, await api.patchAudio(intent.patch))]
			case "tuner": {
				const out: CommandOutcome[] = []
				let failed = false
				for (const cmd of intent.commands) {
					if (failed) {
						out.push({ label: cmd.label, result: null, at: null })
						continue
					}
					const r = await api.tuner(intent.sourceId, cmd)
					out.push(stamp(cmd.label, r))
					if (!r.ok) failed = true
				}
				return out
			}
		}
	}

	return {
		store,
		tick,
		start: () => {
			if (!stopped) return
			stopped = false
			flushTimer = deps.timers.setInterval(tick, FLUSH_MS)
			if (target) {
				push({ kind: "target", at: deps.now(), base: target.base, ws: target.ws, discovery: { mode: "explicit", tried: [] } })
				ws.start()
				void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
			} else {
				void runDiscovery()
			}
		},
		stop: () => {
			stopped = true
			for (const t of [pollTimer, rediscoverTimer]) if (t !== null) deps.timers.clearTimeout(t)
			if (flushTimer !== null) deps.timers.clearInterval(flushTimer)
			pollTimer = null
			rediscoverTimer = null
			flushTimer = null
			ws.stop()
		},
		reconnect: () => {
			if (stopped) return
			if (target === null) {
				if (!discovering) void runDiscovery()
				return
			}
			ws.reconnectNow()
			void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
		},
		send: intent => {
			const key = actionKey(intent)
			push({ kind: "action:sent", at: deps.now(), key, intent })
			void execute(intent).then(outcomes => {
				push({ kind: "action:result", at: deps.now(), key, outcomes })
			})
		},
	}
}
```

- [ ] **Step 4: Run the runtime tests**

Run: `pnpm exec vitest run tests/unit/cli/runtime.test.ts`
Expected: PASS. If the polling test sees no fetches, check that `start()` calls `pollCycle` synchronously, so the fetches begin before the first `advanceTimersByTimeAsync`.

- [ ] **Step 5: Write the failing use-store render test**

`cli/source/hooks/use-store.test.tsx`:

```tsx
import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { createStore, type Store } from "../data/store.js"
import { renderAt } from "../test/harness.js"
import { useStore } from "./use-store.js"

const selectN = (s: { n: number; other: number }) => s.n

function Show({ store }: { store: Store<{ n: number; other: number }> }) {
	const n = useStore(store, selectN)
	return <Text>n={n}</Text>
}

describe("useStore", () => {
	it("re-renders on store commits", async () => {
		const store = createStore({ n: 1, other: 0 })
		const h = await renderAt(<Show store={store} />, { cols: 40, rows: 10 })
		expect(h.text()).toBe("n=1")
		store.set({ n: 2, other: 0 })
		await new Promise(r => setTimeout(r, 10))
		expect(h.text()).toBe("n=2")
		h.unmount()
	})
})
```

- [ ] **Step 6: Write `cli/source/hooks/use-store.ts`**

```ts
import { useMemo, useSyncExternalStore } from "react"
import { memoOne } from "../data/memo.js"
import type { Store } from "../data/store.js"

/** useSyncExternalStore over the single store; the selector is memoised on state identity so getSnapshot is stable. */
export function useStore<T, S>(store: Store<T>, selector: (state: T) => S): S {
	const memo = useMemo(() => memoOne(selector), [selector])
	return useSyncExternalStore(store.subscribe, () => memo(store.get()))
}
```

- [ ] **Step 7: Run both suites**

```bash
pnpm exec vitest run tests/unit/cli/runtime.test.ts
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli typecheck
```
Expected: PASS and exit 0.

- [ ] **Step 8: Commit**

```bash
git add cli/source/data/runtime.ts cli/source/hooks/use-store.ts tests/unit/cli/runtime.test.ts cli/source/hooks/use-store.test.tsx
git commit -m "feat(cli): runtime with 200 ms single-commit flush, poll cycle, discovery, writes

Property 18 commit bound; useStore over useSyncExternalStore.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 16: Scenario state builder (A, after Task 28)

**Owner:** A · **Spec:** §13.1 fixtures, §13.2 matrix scenarios · **Starts after** Task 28 (C), which provides the scenario JSON and `cli/source/test/scenarios.ts`, is merged.

**Files:**
- Create: `cli/source/test/fixtures.ts`
- Test: `tests/unit/cli/fixtures.test.ts`

**Interfaces:**
- Consumes: `loadScenario(name): Scenario` and `mergeById(body: unknown, merge: Record<string, unknown>): unknown` from `test/scenarios.ts` (Task 28). `REST_GUARDS` (Task 8), `parseServerMessage` (Task 6), `initialState`, `reduce`, `ReduceDeps`, `PLAIN_SUMMARY` (Task 14).
- Produces:
  - `FIXTURE_BASE = "http://127.0.0.1:9000"`
  - `scenarioInbound(sc: Scenario): { items: Inbound[]; now: number }`
  - `scenarioState(name: ScenarioName, deps?: ReduceDeps): AppState`. Phase 2 view tests pass `{ summarize: formatMessage }` from `ui/messages/index.ts`.

- [ ] **Step 1: Write the failing test**

`tests/unit/cli/fixtures.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { aggregateDropNow, restartIncrements } from "../../../cli/source/data/rates.js"
import { apiView } from "../../../cli/source/data/freshness.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"

describe("scenario states", () => {
	it("builds every scenario", () => {
		for (const name of SCENARIO_NAMES) expect(() => scenarioState(name)).not.toThrow()
	})
	it("live: nine decoders, ws open, REST fresh, 21 % aggregate drop", () => {
		const s = scenarioState("live")
		expect(s.decoders.value).toHaveLength(9)
		expect(apiView(s.conn, s.now).kind).toBe("ok")
		expect(aggregateDropNow(s.fanoutHistory).ratio).toBeCloseTo(0.2125, 3)
		expect(s.messages.ring.entries).toHaveLength(7)
	})
	it("api-down has no cache; api-down-cached keeps values and is down", () => {
		const cold = scenarioState("api-down")
		expect(cold.decoders.value).toBeUndefined()
		expect(apiView(cold.conn, cold.now).kind).toBe("down")
		const cached = scenarioState("api-down-cached")
		expect(cached.decoders.value).toHaveLength(9)
		expect(apiView(cached.conn, cached.now)).toEqual({ kind: "down", sinceMs: 151000 })
		expect(cached.messages.ring.gaps).toHaveLength(1)
	})
	it("ws-only and rest-only are split states", () => {
		const wsOnly = scenarioState("ws-only")
		expect(apiView(wsOnly.conn, wsOnly.now)).toMatchObject({ kind: "split", ws: true, rest: false })
		const restOnly = scenarioState("rest-only")
		expect(apiView(restOnly.conn, restOnly.now)).toMatchObject({ kind: "split", ws: false, rest: true })
	})
	it("crash-loop sees ≥ 2 restart increments for acarsdec; legacy has no activity or offered bytes", () => {
		const s = scenarioState("crash-loop")
		expect(restartIncrements(s.session["acarsdec"]?.restarts ?? [], s.now)).toBeGreaterThanOrEqual(2)
		const legacy = scenarioState("legacy")
		expect(legacy.sources.value?.[0]?.activity).toBeUndefined()
		expect(aggregateDropNow(legacy.fanoutHistory).ratio).toBeNull()
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/fixtures.test.ts`
Expected: FAIL, `fixtures.js` not found.

- [ ] **Step 3: Write `cli/source/test/fixtures.ts`**

```ts
import { REST_GUARDS } from "../data/api-client.js"
import { parseServerMessage } from "../data/guards.js"
import { PLAIN_SUMMARY, initialState, reduce, type ReduceDeps } from "../data/reducers.js"
import {
	ENDPOINT_PATHS,
	POLL_ENDPOINTS,
	type AppState,
	type Endpoint,
	type Inbound,
	type LaneError,
	type RestInbound,
} from "../data/types.js"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"
import { loadScenario, mergeById } from "./scenarios.js"

export const FIXTURE_BASE = "http://127.0.0.1:9000"
const FIXTURE_WS = "ws://127.0.0.1:9000/ws"
const WINDOW_MS = 600_000

const PATH_TO_ENDPOINT = new Map<string, Endpoint>(
	(Object.entries(ENDPOINT_PATHS) as Array<[Endpoint, string]>).map(([e, p]) => [p, e]),
)

function restItem(path: string, body: unknown, at: number): Inbound | null {
	const endpoint = PATH_TO_ENDPOINT.get(path)
	if (!endpoint) return null
	const guarded = REST_GUARDS[endpoint](body)
	const outcome = guarded
		? { ok: true as const, value: guarded.value, rejected: guarded.rejected }
		: { ok: false as const, error: { kind: "invalid" as const, message: `fixture ${path} failed its guard`, at } }
	return { kind: "rest", endpoint, outcome, at } as RestInbound
}

function wsItem(f: ScenarioFrame, at: number): Inbound {
	const event = parseServerMessage({ type: f.type, channel: f.channel, data: f.data })
	if (!event) throw new Error(`fixture frame ${f.type} failed parseServerMessage`)
	return { kind: "ws", event, at }
}

function restError(sc: Scenario, at: number): LaneError {
	const reason = sc.conn.restError ?? "ECONNREFUSED"
	return reason === "timeout"
		? { kind: "timeout", message: "timeout 2s", at }
		: { kind: "network", message: reason, at }
}

/** Turn a resolved scenario into the inbound items a live runtime would have queued, oldest first. */
export function scenarioInbound(sc: Scenario): { items: Inbound[]; now: number } {
	const now = Date.parse(sc.now)
	const c = sc.conn
	const restAt = now - (c.restAgoMs ?? 2000)
	const wsBase = now - (c.wsAgoMs ?? c.restAgoMs ?? 2000)
	const downFor = c.downForMs ?? 1000
	const timed: Inbound[] = []
	if (c.cached) {
		for (const h of sc.restHistory ?? []) {
			const item = restItem(h.path, mergeById(sc.rest[h.path]?.body, h.merge), now + h.offsetMs)
			if (item) timed.push(item)
		}
		for (const [path, r] of Object.entries(sc.rest)) {
			if (r.status !== 200) continue
			const item = restItem(path, r.body, restAt)
			if (item) timed.push(item)
		}
		for (const f of [...sc.ws, ...(sc.wsAppend ?? [])]) timed.push(wsItem(f, wsBase + f.offsetMs))
		timed.push({ kind: "rest:cycle", at: restAt, nextAt: restAt + 5000 })
	}
	timed.sort((a, b) => a.at - b.at)
	const items: Inbound[] = [
		{ kind: "target", at: now - WINDOW_MS, base: FIXTURE_BASE, ws: FIXTURE_WS, discovery: { mode: "explicit", tried: [] } },
		// A cold start with the API down never had an open socket, so it must not open a gap.
		...(c.cached || c.ws === "open" ? [{ kind: "ws:open" as const, at: now - WINDOW_MS + 1 }] : []),
		...timed,
	]
	if (c.ws === "closed") {
		items.push({ kind: "ws:close", at: now - (c.wsClosedAgoMs ?? downFor), code: c.closeCode ?? 1006, reason: "", nextRetryAt: now + 8000 })
	}
	if (c.rest === "down") {
		for (const at of [now - downFor, now - 1000]) {
			for (const endpoint of POLL_ENDPOINTS) {
				items.push({ kind: "rest", endpoint, outcome: { ok: false, error: restError(sc, at) }, at } as RestInbound)
			}
		}
		items.push({ kind: "rest:cycle", at: now - 1000, nextAt: now + 4000 })
	}
	items.sort((a, b) => a.at - b.at)
	return { items, now }
}

export function scenarioState(name: ScenarioName, deps: ReduceDeps = PLAIN_SUMMARY): AppState {
	const { items, now } = scenarioInbound(loadScenario(name))
	return reduce(initialState(now - WINDOW_MS - 1000), items, now, deps)
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm exec vitest run tests/unit/cli/fixtures.test.ts`
Expected: PASS. If `apiView(cached.conn, …)` is not `{down, 151000}`, check that `api-down-cached.json` sets `restAgoMs: 151000` (Task 28).

- [ ] **Step 5: Commit**

```bash
git add cli/source/test/fixtures.ts tests/unit/cli/fixtures.test.ts
git commit -m "test(cli): build AppState from mock scenarios through the real reducer

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 17: Number, time and unit formatters (B)

**Owner:** B · **Spec:** §8 Numbers, T4, T5, P6, P8

**Files:**
- Create: `cli/source/ui/format.ts`
- Test: `tests/unit/cli/format.test.ts`

**Interfaces:**
- Consumes: `glyphs()` from `ui/theme.ts`.
- Produces. Every function accepts `number | null | undefined` and returns `"?"` for null, undefined or NaN (never `0`):
  - `isKnown(n): n is number`
  - `formatBytes(n, digits = 1)` (SI, base 1000: `"4.1 MB"`), `formatRate(bytesPerSec)` (`"4.1 MB/s"`), `kibToBytes(kib): number`
  - `formatSpaced(n)` (`"445 970 700"`), `formatCount(n)` (`"3 357"`, `"42"`)
  - `formatHz(hz)` (`"445 970 700 Hz"`), `formatSps(sps)` (`"2 048 000 S/s"`), `formatMSps(sps)` (`"2.048 MS/s"`)
  - `formatMHz(hz, decimals = 3)` (`"445.971 MHz"`), `formatMHzBare(hz, decimals)` (`"445.9707"`), `formatWindow(loHz, hiHz)` (`"444.947–446.995 MHz"`), `formatHalfSpan(sampleRate)` (`"±1.024"`)
  - `formatPercent(ratio)` (`"34%"`), `formatAge(ms)` (`"<1s"`, `"9s"`, `"2m 04s"`, `"12m"`, `"2h 10m"`, `"3d"`), `formatDuration(sec)`
  - `formatSampleAge(ms)`: `"4 ms"` below 1 s, `"0.2s"`-style tenths below 10 s, otherwise `formatAge`
  - `formatEventRate(perSec)` (`"2/min"`, `"1.2/s"`, `"<1/min"`), `formatDb(tenths)` (`"20.7 dB"`), `formatDeltaHz(hz)` (`"+29.3 kHz"`)
  - `formatClock(ms)` (`"18:07:52"`), `formatClockShort(ms)` (`"18:07"`), `formatClockMs(ms)` (`"18:12:10.412"`). These use local time, and tests set `process.env.TZ = "UTC"`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/format.test.ts`:

```ts
import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import * as f from "../../../cli/source/ui/format.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("formatters (spec §8)", () => {
	it("format the spec's examples", () => {
		expect(f.formatRate(f.kibToBytes(3994))).toBe("4.1 MB/s")
		expect(f.formatBytes(1_940_000_000, 2)).toBe("1.94 GB")
		expect(f.formatBytes(545_500_000)).toBe("545.5 MB")
		expect(f.formatBytes(0)).toBe("0 B")
		expect(f.formatMSps(2_048_000)).toBe("2.048 MS/s")
		expect(f.formatSps(2_048_000)).toBe("2 048 000 S/s")
		expect(f.formatHz(445_970_700)).toBe("445 970 700 Hz")
		expect(f.formatMHz(445_970_700)).toBe("445.971 MHz")
		expect(f.formatMHzBare(445_970_700, 4)).toBe("445.9707")
		expect(f.formatWindow(444_946_700, 446_994_700)).toBe("444.947–446.995 MHz")
		expect(f.formatHalfSpan(2_048_000)).toBe("±1.024")
		expect(f.formatPercent(0.3449)).toBe("34%")
		expect(f.formatCount(3357)).toBe("3 357")
		expect(f.formatCount(42)).toBe("42")
		expect(f.formatEventRate(2 / 60)).toBe("2/min")
		expect(f.formatEventRate(1.2)).toBe("1.2/s")
		expect(f.formatEventRate(0.001)).toBe("<1/min")
		expect(f.formatDb(207)).toBe("20.7 dB")
		expect(f.formatDeltaHz(29_300)).toBe("+29.3 kHz")
		expect(f.formatDeltaHz(-1_500_000)).toBe("−1.500 MHz")
		expect(f.formatClock(Date.parse("2026-10-08T18:07:52Z"))).toBe("18:07:52")
		expect(f.formatClockShort(Date.parse("2026-10-08T18:07:52Z"))).toBe("18:07")
		expect(f.formatClockMs(Date.parse("2026-10-08T18:12:10.412Z"))).toBe("18:12:10.412")
	})
	it("formats ages in buckets", () => {
		expect(f.formatAge(-5000)).toBe("<1s")
		expect(f.formatAge(400)).toBe("<1s")
		expect(f.formatAge(9_000)).toBe("9s")
		expect(f.formatAge(160_000)).toBe("2m 40s")
		expect(f.formatAge(124_000)).toBe("2m 04s")
		expect(f.formatAge(720_000)).toBe("12m")
		expect(f.formatAge(7_800_000)).toBe("2h 10m")
		expect(f.formatAge(3 * 86_400_000)).toBe("3d")
		expect(f.formatDuration(52)).toBe("52s")
		expect(f.formatSampleAge(4)).toBe("4 ms")
		expect(f.formatSampleAge(1200)).toBe("1.2s")
		expect(f.formatSampleAge(23_000)).toBe("23s")
	})

	const unknowns = [null, undefined, Number.NaN]
	const fns: Array<[string, (n: number | null | undefined) => string]> = [
		["bytes", n => f.formatBytes(n)],
		["rate", n => f.formatRate(n)],
		["spaced", n => f.formatSpaced(n)],
		["count", n => f.formatCount(n)],
		["hz", n => f.formatHz(n)],
		["sps", n => f.formatSps(n)],
		["msps", n => f.formatMSps(n)],
		["mhz", n => f.formatMHz(n)],
		["half", n => f.formatHalfSpan(n)],
		["percent", n => f.formatPercent(n)],
		["age", n => f.formatAge(n)],
		["duration", n => f.formatDuration(n)],
		["sampleAge", n => f.formatSampleAge(n)],
		["eventRate", n => f.formatEventRate(n)],
		["db", n => f.formatDb(n)],
		["delta", n => f.formatDeltaHz(n)],
		["clock", n => f.formatClock(n)],
	]

	// Feature: cli-dashboard-overhaul, Property 6: unknown is never zero
	// Validates: spec T5
	it("P6: null/undefined/NaN format as ? and never as a number", () => {
		fc.assert(
			fc.property(fc.constantFrom(...fns), fc.constantFrom(...unknowns), ([, fn], v) => {
				const out = fn(v)
				expect(out).toBe("?")
				expect(/\d/.test(out)).toBe(false)
			}),
			{ numRuns: 100 },
		)
	})

	const parseAge = (s: string): number => {
		if (s === "<1s") return 0
		let m = /^(\d+)s$/.exec(s)
		if (m) return Number(m[1])
		m = /^(\d+)m (\d+)s$/.exec(s)
		if (m) return Number(m[1]) * 60 + Number(m[2])
		m = /^(\d+)m$/.exec(s)
		if (m) return Number(m[1]) * 60
		m = /^(\d+)h (\d+)m$/.exec(s)
		if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60
		m = /^(\d+)d$/.exec(s)
		if (m) return Number(m[1]) * 86400
		throw new Error(`unparseable age ${s}`)
	}

	// Feature: cli-dashboard-overhaul, Property 8: ages
	// Validates: spec §8
	it("P8: formatAge is never negative/NaN and is non-decreasing in age", () => {
		fc.assert(
			fc.property(fc.integer({ min: -1e9, max: 1e10 }), fc.integer({ min: 0, max: 1e9 }), (a, d) => {
				const x = f.formatAge(a)
				const y = f.formatAge(a + d)
				expect(x.includes("-") || x.includes("NaN")).toBe(false)
				expect(parseAge(x)).toBeLessThanOrEqual(parseAge(y))
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/format.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/format.ts`**

```ts
import { glyphs } from "./theme.js"

type N = number | null | undefined
const UNKNOWN = "?"

export function isKnown(n: N): n is number {
	return typeof n === "number" && Number.isFinite(n)
}

const SI = ["B", "KB", "MB", "GB", "TB"] as const

export function formatBytes(n: N, digits = 1): string {
	if (!isKnown(n)) return UNKNOWN
	if (Math.abs(n) < 1000) return `${Math.round(n)} B`
	let v = n
	let i = 0
	while (Math.abs(v) >= 1000 && i < SI.length - 1) {
		v /= 1000
		i++
	}
	return `${v.toFixed(digits)} ${SI[i] ?? "TB"}`
}

export function formatRate(bytesPerSec: N): string {
	return isKnown(bytesPerSec) ? `${formatBytes(bytesPerSec)}/s` : UNKNOWN
}

/** Core reports dataRate in KiB/s. */
export function kibToBytes(kib: number): number {
	return kib * 1024
}

export function formatSpaced(n: N): string {
	if (!isKnown(n)) return UNKNOWN
	const sign = n < 0 ? "−" : ""
	return sign + String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
}

export function formatCount(n: N): string {
	if (!isKnown(n)) return UNKNOWN
	return Math.abs(n) < 1000 ? String(Math.round(n)) : formatSpaced(n)
}

export function formatHz(hz: N): string {
	return isKnown(hz) ? `${formatSpaced(hz)} Hz` : UNKNOWN
}

export function formatSps(sps: N): string {
	return isKnown(sps) ? `${formatSpaced(sps)} S/s` : UNKNOWN
}

export function formatMSps(sps: N): string {
	return isKnown(sps) ? `${(sps / 1e6).toFixed(3)} MS/s` : UNKNOWN
}

export function formatMHzBare(hz: N, decimals = 3): string {
	return isKnown(hz) ? (hz / 1e6).toFixed(decimals) : UNKNOWN
}

export function formatMHz(hz: N, decimals = 3): string {
	return isKnown(hz) ? `${formatMHzBare(hz, decimals)} MHz` : UNKNOWN
}

export function formatWindow(loHz: N, hiHz: N): string {
	if (!isKnown(loHz) || !isKnown(hiHz)) return UNKNOWN
	return `${formatMHzBare(loHz)}${glyphs().range}${formatMHzBare(hiHz)} MHz`
}

export function formatHalfSpan(sampleRate: N): string {
	return isKnown(sampleRate) ? `±${(sampleRate / 2e6).toFixed(3)}` : UNKNOWN
}

export function formatPercent(ratio: N): string {
	return isKnown(ratio) ? `${Math.round(ratio * 100)}%` : UNKNOWN
}

const pad2 = (n: number): string => String(n).padStart(2, "0")

/** <1s, 9s, 2m 04s (under 10 min), 12m, 2h 10m, 3d. Negative ages (clock skew) render <1s. */
export function formatAge(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const s = Math.floor(Math.max(0, ms) / 1000)
	if (s < 1) return "<1s"
	if (s < 60) return `${s}s`
	if (s < 600) return `${Math.floor(s / 60)}m ${pad2(s % 60)}s`
	if (s < 3600) return `${Math.floor(s / 60)}m`
	if (s < 86400) return `${Math.floor(s / 3600)}h ${pad2(Math.floor((s % 3600) / 60))}m`
	return `${Math.floor(s / 86400)}d`
}

export function formatDuration(sec: N): string {
	return isKnown(sec) ? formatAge(sec * 1000) : UNKNOWN
}

/** Server-relative sample age: "4 ms", "1.2s", then the age buckets. */
export function formatSampleAge(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const v = Math.max(0, ms)
	if (v < 1000) return `${Math.round(v)} ms`
	if (v < 10_000) return `${(v / 1000).toFixed(1)}s`
	return formatAge(v)
}

/** 3/min below 60/min, else 1.2/s. */
export function formatEventRate(perSec: N): string {
	if (!isKnown(perSec)) return UNKNOWN
	const perMin = perSec * 60
	if (perMin < 1) return "<1/min"
	if (perMin < 60) return `${Math.round(perMin)}/min`
	return `${perSec.toFixed(1)}/s`
}

export function formatDb(tenths: N): string {
	return isKnown(tenths) ? `${(tenths / 10).toFixed(1)} dB` : UNKNOWN
}

export function formatDeltaHz(hz: N): string {
	if (!isKnown(hz)) return UNKNOWN
	const sign = hz < 0 ? "−" : "+"
	const a = Math.abs(hz)
	return a >= 1e6 ? `${sign}${(a / 1e6).toFixed(3)} MHz` : `${sign}${(a / 1e3).toFixed(1)} kHz`
}

function clockParts(ms: number): { h: string; m: string; s: string; ms: string } {
	const d = new Date(ms)
	return {
		h: pad2(d.getHours()),
		m: pad2(d.getMinutes()),
		s: pad2(d.getSeconds()),
		ms: String(d.getMilliseconds()).padStart(3, "0"),
	}
}

export function formatClock(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}:${p.s}`
}

export function formatClockShort(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}`
}

export function formatClockMs(ms: N): string {
	if (!isKnown(ms)) return UNKNOWN
	const p = clockParts(ms)
	return `${p.h}:${p.m}:${p.s}.${p.ms}`
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/format.ts tests/unit/cli/format.test.ts
git commit -m "feat(cli): unit, time and rate formatters where unknown is always ?

Properties 6 and 8 (spec T5, §8).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 18: `fitGroups` (B)

**Owner:** B · **Spec:** §4.2, §5.2, P1–P3

**Files:**
- Create: `cli/source/ui/fit.ts`
- Test: `tests/unit/cli/fit.test.ts`

**Interfaces:**
- Consumes: `Group`, `Line`, `Span` from `ui/line.ts`. `lineWidth`, `truncateLine`, `cellWidth` from `ui/text.ts`.
- Produces:
  - `interface FitOptions { sep?: Line | string; rightAlignLast?: boolean; dropMarker?: Span }`. `sep` defaults to two spaces. `dropMarker` is appended (after a separator) whenever a group was dropped. Summaries pass `{ text: "…", role: "label" }`.
  - `interface FitResult { line: Line; present: boolean[]; variant: number[] }`
  - `fitGroupsDetailed(groups: readonly Group[], width: number, opts?: FitOptions): FitResult`
  - `fitGroups(groups: readonly Group[], width: number, opts?: FitOptions): Line`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/fit.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { fitGroups, fitGroupsDetailed } from "../../../cli/source/ui/fit.js"
import type { Group } from "../../../cli/source/ui/line.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

const g = (priority: number, ...variants: string[]): Group => ({ priority, variants: variants.map(t => [{ text: t, role: "value" as const }]) })

describe("fitGroups", () => {
	const strip = [g(1, "api ● 2s"), g(2, "iq ● streaming", "iq ● streaming · 4.1 MB/s"), g(5, "rx 445.971 MHz", "rx 445.971 MHz ±1.024"), g(3, "decoders 1 failing", "decoders 8/9 up · 1 failing"), g(4, "drops 34%", "drops 34% now"), g(6, "18:07")]
	it("removes lanes in reverse priority, then enriches in priority order", () => {
		expect(lineText(fitGroups(strip, 200))).toBe("api ● 2s  iq ● streaming · 4.1 MB/s  rx 445.971 MHz ±1.024  decoders 8/9 up · 1 failing  drops 34% now  18:07")
		expect(lineText(fitGroups(strip, 60))).toBe("api ● 2s  iq ● streaming  decoders 1 failing  drops 34% now")
	})
	it("right-aligns the last group", () => {
		const out = lineText(fitGroups([g(1, "left"), g(2, "clock")], 20, { rightAlignLast: true }))
		expect(out).toBe("left           clock")
	})
	it("appends a drop marker when segments were dropped", () => {
		const out = lineText(fitGroups([g(0, "TG 2350"), g(1, "SRC 2341234"), g(5, "CC 1")], 25, { dropMarker: { text: "…", role: "label" } }))
		expect(out).toBe("TG 2350  SRC 2341234  …")
	})
	it("cuts the last group at width-1 with … when even it overflows", () => {
		expect(lineText(fitGroups([g(0, "abcdefghij")], 6))).toBe("abcde…")
	})

	const arbGroups = fc.array(
		fc.record({
			priority: fc.integer({ min: 0, max: 6 }),
			variants: fc.array(fc.string({ minLength: 1, maxLength: 20 }).map(s => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "x")), { minLength: 1, maxLength: 3 }),
		}),
		{ minLength: 1, maxLength: 7 },
	).map(gs => gs.map(x => g(x.priority, ...x.variants)))

	// Feature: cli-dashboard-overhaul, Property 1: fitGroups width
	// Validates: spec §5.2
	it("P1: output width ≤ width for every width ≥ 1", () => {
		fc.assert(
			fc.property(arbGroups, fc.integer({ min: 1, max: 220 }), fc.boolean(), (groups, w, right) => {
				expect(lineWidth(fitGroups(groups, w, { rightAlignLast: right, dropMarker: { text: "…", role: "label" } }))).toBeLessThanOrEqual(w)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 2: fitGroups priority
	// Validates: spec §4.2
	it("P2: a present group implies every higher-priority group is present", () => {
		fc.assert(
			fc.property(arbGroups, fc.integer({ min: 1, max: 220 }), (groups, w) => {
				const r = fitGroupsDetailed(groups, w)
				groups.forEach((gi, i) => {
					if (!r.present[i]) return
					groups.forEach((gj, j) => {
						if (gj.priority < gi.priority) expect(r.present[j]).toBe(true)
					})
				})
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 3: fitGroups monotone presence
	// Validates: spec §4.2
	it("P3: widening never removes a group", () => {
		fc.assert(
			fc.property(arbGroups, fc.integer({ min: 1, max: 200 }), fc.integer({ min: 0, max: 50 }), (groups, w, d) => {
				const a = fitGroupsDetailed(groups, w).present
				const b = fitGroupsDetailed(groups, w + d).present
				a.forEach((p, i) => {
					if (p) expect(b[i]).toBe(true)
				})
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/fit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/fit.ts`**

```ts
import type { Group, Line, Span } from "./line.js"
import { cellWidth, lineWidth, truncateLine } from "./text.js"

export interface FitOptions {
	sep?: Line | string
	rightAlignLast?: boolean
	dropMarker?: Span
}

export interface FitResult {
	line: Line
	present: boolean[]
	variant: number[]
}

/**
 * Two passes (spec §4.2): presence at minimal variants, removing the highest
 * priority number first (ties: rightmost), then richness in priority order.
 * The last remaining group is never removed; if it still overflows, it is cut
 * with an ellipsis.
 */
export function fitGroupsDetailed(groups: readonly Group[], width: number, opts: FitOptions = {}): FitResult {
	const sep: Line = typeof opts.sep === "string" ? [{ text: opts.sep, role: "label" }] : (opts.sep ?? [{ text: "  ", role: "label" }])
	const sepW = lineWidth(sep)
	const markerW = opts.dropMarker ? sepW + cellWidth(opts.dropMarker.text) : 0
	const present = groups.map(g => g.variants.length > 0)
	const variant = groups.map(() => 0)
	let dropped = false

	const widthOf = (i: number): number => lineWidth(groups[i]?.variants[variant[i] ?? 0] ?? [])
	const total = (): number => {
		let w = 0
		let count = 0
		for (let i = 0; i < groups.length; i++) {
			if (!present[i]) continue
			w += widthOf(i)
			count++
		}
		w += Math.max(0, count - 1) * sepW
		if (dropped) w += markerW
		return w
	}
	const countPresent = (): number => present.filter(Boolean).length

	const removal = groups
		.map((g, i) => ({ p: g.priority, i }))
		.sort((a, b) => b.p - a.p || b.i - a.i)
	for (const { i } of removal) {
		if (total() <= width || countPresent() <= 1) break
		if (!present[i]) continue
		present[i] = false
		dropped = true
	}

	const enrich = groups
		.map((g, i) => ({ p: g.priority, i }))
		.sort((a, b) => a.p - b.p || a.i - b.i)
	for (const { i } of enrich) {
		if (!present[i]) continue
		const n = groups[i]?.variants.length ?? 0
		const base = variant[i] ?? 0
		for (let v = n - 1; v > base; v--) {
			variant[i] = v
			if (total() <= width) break
			variant[i] = base
		}
	}

	const parts: Line[] = []
	for (let i = 0; i < groups.length; i++) {
		if (present[i]) parts.push(groups[i]?.variants[variant[i] ?? 0] ?? [])
	}
	const line: Line = []
	parts.forEach((p, k) => {
		if (k > 0) {
			const isLast = k === parts.length - 1
			if (isLast && opts.rightAlignLast && present[groups.length - 1]) {
				const pad = Math.max(0, width - total())
				line.push(...sep, { text: " ".repeat(pad), role: "label" })
			} else {
				line.push(...sep)
			}
		}
		line.push(...p)
	})
	if (dropped && opts.dropMarker) line.push(...sep, opts.dropMarker)
	return { line: truncateLine(line, width), present, variant }
}

export function fitGroups(groups: readonly Group[], width: number, opts: FitOptions = {}): Line {
	return fitGroupsDetailed(groups, width, opts).line
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/fit.test.ts`
Expected: PASS. Here is how the 60-column example works out. With rx (priority 5) and clock (6) removed, the minimal variants come to 8 + 14 + 18 + 9 plus three 2-column separators, which is 55 columns. The richness pass then rejects the rich iq variant (+11, total 66) and the mid decoders variant (+9, total 64), and accepts `drops 34% now` (+4, total 59). This matches spec §4.2's 60-column row.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/fit.ts tests/unit/cli/fit.test.ts
git commit -m "feat(cli): fitGroups two-pass fitter (presence by priority, then richness)

Properties 1-3 (spec §4.2, §5.2).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 19: `layoutColumns` and table rows (B)

**Owner:** B · **Spec:** §5.2 layoutColumns, §5.3 column specs, P4

**Files:**
- Create: `cli/source/ui/columns.ts`
- Test: `tests/unit/cli/columns.test.ts`

**Interfaces:**
- Consumes: `Cell`, `Line` from `ui/line.ts`. `lineWidth`, `truncateLine` from `ui/text.ts`.
- Produces:
  - `interface ColumnSpec { id: string; min: number; pref: number; priority: number; align: "left" | "right"; flex?: boolean; header: Cell }`
  - `interface ColumnLayout { id: string; width: number; align: "left" | "right" }`
  - `layoutColumns(width: number, columns: readonly ColumnSpec[], gap?: number): ColumnLayout[]`. The default gap is 2. The result is in display order and holds present columns only.
  - `pickVariant(c: Cell, width: number): Line`
  - `padCell(line: Line, width: number, align: "left" | "right"): Line`
  - `renderRow(layout: readonly ColumnLayout[], cells: Readonly<Record<string, Cell>>, gap?: number): Line`
  - `renderHeader(layout: readonly ColumnLayout[], columns: readonly ColumnSpec[], gap?: number): Line`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/columns.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { layoutColumns, pickVariant, renderRow, type ColumnSpec } from "../../../cli/source/ui/columns.js"
import { cell, sp } from "../../../cli/source/ui/line.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

const col = (id: string, min: number, pref: number, priority: number, flex = false): ColumnSpec => ({ id, min, pref, priority, align: "left", flex, header: cell([sp(id, "label")]) })

describe("layoutColumns", () => {
	const cols = [col("glyph", 1, 1, 0), col("name", 12, 16, 0), col("process", 6, 18, 0), col("decodes", 8, 16, 1), col("drop", 4, 8, 1), col("window", 6, 6, 2), col("nominal", 15, 15, 3), col("lifetime", 8, 8, 4)]
	it("drops the highest priority number first and grows toward pref", () => {
		const at60 = layoutColumns(59, cols).map(c => c.id)
		expect(at60).toEqual(["glyph", "name", "process", "decodes", "drop", "window"])
		const at120 = layoutColumns(119, cols)
		expect(at120.map(c => c.id)).toContain("lifetime")
		expect(at120.find(c => c.id === "name")?.width).toBe(16)
	})
	it("gives leftover space to the flex column", () => {
		const r = layoutColumns(50, [col("t", 5, 8, 0), col("summary", 10, 10, 0, true)])
		expect(r.find(c => c.id === "summary")?.width).toBe(50 - 8 - 2)
	})

	const arbCols = fc.array(
		fc.record({ min: fc.integer({ min: 1, max: 20 }), extra: fc.integer({ min: 0, max: 10 }), priority: fc.integer({ min: 0, max: 6 }), flex: fc.boolean() }),
		{ minLength: 1, maxLength: 12 },
	).map(xs => xs.map((x, i) => col(`c${i}`, x.min, x.min + x.extra, x.priority, x.flex)))

	// Feature: cli-dashboard-overhaul, Property 4: layoutColumns
	// Validates: spec §5.2
	it("P4: fits, keeps a priority prefix, respects mins, monotone presence", () => {
		fc.assert(
			fc.property(arbCols, fc.integer({ min: 0, max: 220 }), fc.integer({ min: 0, max: 60 }), (columns, w, d) => {
				const r = layoutColumns(w, columns)
				const used = r.reduce((a, c) => a + c.width, 0) + Math.max(0, r.length - 1) * 2
				expect(used).toBeLessThanOrEqual(Math.max(0, w))
				const ids = new Set(r.map(c => c.id))
				for (const c of columns) {
					if (!ids.has(c.id)) continue
					for (const o of columns) if (o.priority < c.priority) expect(ids.has(o.id)).toBe(true)
					expect(r.find(x => x.id === c.id)!.width).toBeGreaterThanOrEqual(c.min)
				}
				const wider = new Set(layoutColumns(w + d, columns).map(c => c.id))
				for (const id of ids) expect(wider.has(id)).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("cells", () => {
	it("uses the richest variant that fits, then truncates the minimal one", () => {
		const c = cell([sp("up 51s")], [sp("up 51s · 1 restart")])
		expect(lineText(pickVariant(c, 20))).toBe("up 51s · 1 restart")
		expect(lineText(pickVariant(c, 8))).toBe("up 51s")
		expect(lineText(pickVariant(c, 4))).toBe("up …")
	})
	it("renders aligned rows of exact width", () => {
		const layout = [{ id: "a", width: 6, align: "left" as const }, { id: "b", width: 5, align: "right" as const }]
		const row = renderRow(layout, { a: cell([sp("ab")]), b: cell([sp("12%")]) })
		expect(lineText(row)).toBe("ab        12%")
		expect(lineWidth(row)).toBe(13)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/columns.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/columns.ts`**

```ts
import type { Cell, Line } from "./line.js"
import { lineWidth, truncateLine } from "./text.js"

export interface ColumnSpec {
	id: string
	min: number
	pref: number
	priority: number
	align: "left" | "right"
	flex?: boolean
	header: Cell
}

export interface ColumnLayout {
	id: string
	width: number
	align: "left" | "right"
}

/**
 * Spec §5.2: (1) include all, remove the highest priority number (rightmost on
 * ties) until Σmin + gaps fits; (2) grow toward pref in priority order;
 * (3) leftover to the flex column.
 */
export function layoutColumns(width: number, columns: readonly ColumnSpec[], gap = 2): ColumnLayout[] {
	const present = columns.map(() => true)
	const sumMin = (): number => {
		let w = 0
		let n = 0
		columns.forEach((c, i) => {
			if (present[i]) {
				w += c.min
				n++
			}
		})
		return w + Math.max(0, n - 1) * gap
	}
	const removal = columns.map((c, i) => ({ p: c.priority, i })).sort((a, b) => b.p - a.p || b.i - a.i)
	for (const { i } of removal) {
		if (sumMin() <= width) break
		present[i] = false
	}
	const widths = columns.map(c => c.min)
	let remaining = Math.max(0, width - sumMin())
	const grow = columns.map((c, i) => ({ p: c.priority, i })).sort((a, b) => a.p - b.p || a.i - b.i)
	for (const { i } of grow) {
		const c = columns[i]
		if (!present[i] || !c || remaining <= 0) continue
		const add = Math.min(c.pref - c.min, remaining)
		if (add > 0) {
			widths[i] = (widths[i] ?? c.min) + add
			remaining -= add
		}
	}
	const flexIdx = columns.findIndex((c, i) => present[i] && c.flex === true)
	if (flexIdx >= 0 && remaining > 0) widths[flexIdx] = (widths[flexIdx] ?? 0) + remaining
	const out: ColumnLayout[] = []
	columns.forEach((c, i) => {
		if (present[i]) out.push({ id: c.id, width: widths[i] ?? c.min, align: c.align })
	})
	return out
}

/** Richest variant (variants are minimal → rich) that fits; else the minimal one cut with an ellipsis. */
export function pickVariant(c: Cell, width: number): Line {
	for (let v = c.variants.length - 1; v >= 0; v--) {
		const line = c.variants[v]
		if (line && lineWidth(line) <= width) return line
	}
	return truncateLine(c.variants[0] ?? [], width)
}

export function padCell(line: Line, width: number, align: "left" | "right"): Line {
	const cut = truncateLine(line, width)
	const pad = width - lineWidth(cut)
	if (pad <= 0) return cut
	const spaces = { text: " ".repeat(pad), role: "value" as const }
	return align === "right" ? [spaces, ...cut] : [...cut, spaces]
}

const EMPTY: Cell = { variants: [[]] }

export function renderRow(layout: readonly ColumnLayout[], cells: Readonly<Record<string, Cell>>, gap = 2): Line {
	const out: Line = []
	layout.forEach((col, k) => {
		if (k > 0) out.push({ text: " ".repeat(gap), role: "value" })
		out.push(...padCell(pickVariant(cells[col.id] ?? EMPTY, col.width), col.width, col.align))
	})
	return out
}

export function renderHeader(layout: readonly ColumnLayout[], columns: readonly ColumnSpec[], gap = 2): Line {
	const cells: Record<string, Cell> = {}
	for (const c of columns) cells[c.id] = c.header
	return renderRow(layout, cells, gap)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/columns.test.ts`
Expected: PASS. For `layoutColumns(59, cols)`, the mins sum to 60, plus 7 gaps of 2, for 74 in total. Removing lifetime (priority 4) gives 64, and removing nominal (priority 3) gives 47 ≤ 59, so six columns remain.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/columns.ts tests/unit/cli/columns.test.ts
git commit -m "feat(cli): layoutColumns with priority drop, pref growth, flex leftover

Property 4 (spec §5.2).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 20: Frame budget (B)

**Owner:** B · **Spec:** §5.1, P5

**Files:**
- Create: `cli/source/ui/frame.ts`
- Test: `tests/unit/cli/frame.test.ts`

**Interfaces:**
- Consumes: `HeightClass`, `WidthClass` from `ui/line.ts`.
- Produces:
  - `MIN_COLS = 60`, `MIN_ROWS = 16`, `tooSmall(cols, rows): boolean`, `tooSmallText(cols, rows): string`. It returns the richest of `wavekit: terminal 59×15 is too small (minimum 60×16)`, then `wavekit: 50×12 too small (min 60×16)`, then `min 60×16`, whichever fits in `cols`, so the line is always one row.
  - `heightClass(rows): HeightClass`, `widthClass(cols): WidthClass`
  - `interface Chrome { frame: number; strip: 1; switcher: 0 | 1; blank: 0 | 1; banner: 0 | 1; footer: 1; content: number }`, `chromeRows(rows, bannerOn): Chrome`
  - `type DetailPlacement = { kind: "right"; width: number; gutter: 2 } | { kind: "bottom"; height: number } | { kind: "overlay" }`, `detailPlacement(cols, roomy: boolean, content): DetailPlacement`
  - `interface OverviewBudget { layout: "stacked" | "columns"; leftWidth: number; rightWidth: number; receiver: 2; gapAfterReceiver: 0 | 1; decoderHeader: 1; decoderRows: number; more: 0 | 1; hiddenDecoders: number; gapAfterDecoders: 0 | 1; messageHeader: 1; messageRows: number }`, `overviewBudget(cols, content, roomy, nDecoders): OverviewBudget`. Widths are content widths, `cols − 1`.
  - `interface ListBudget { header: number; listRows: number; gapRows: number; detailRows: number; placement: DetailPlacement }`, `listBudget(cols, content, roomy, headerRows, detailOpen): ListBudget`
  - Budgets take the **content** height. Views receive `height` (content rows) and `heightClass` in `ViewProps`, so they never need to know whether a banner is shown.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/frame.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { chromeRows, detailPlacement, heightClass, listBudget, overviewBudget, tooSmall, tooSmallText, widthClass } from "../../../cli/source/ui/frame.js"

describe("frame classes", () => {
	it("classifies sizes", () => {
		expect(tooSmall(59, 20)).toBe(true)
		expect(tooSmall(60, 16)).toBe(false)
		expect(tooSmallText(59, 15)).toBe("wavekit: terminal 59×15 is too small (minimum 60×16)")
		expect(tooSmallText(50, 12)).toBe("wavekit: 50×12 too small (min 60×16)")
		expect(tooSmallText(8, 4)).toBe("min 60×16")
		expect(heightClass(29)).toBe("compact")
		expect(heightClass(30)).toBe("roomy")
		expect([60, 80, 120, 160].map(widthClass)).toEqual(["narrow", "standard", "wide", "ultra"])
	})
	it("reserves rows-1 and the chrome rows", () => {
		expect(chromeRows(40, false)).toMatchObject({ frame: 39, switcher: 1, blank: 1, content: 35 })
		expect(chromeRows(24, true)).toMatchObject({ frame: 23, switcher: 0, blank: 0, banner: 1, content: 20 })
	})
	it("places the detail pane by size", () => {
		expect(detailPlacement(200, true, 45)).toEqual({ kind: "right", width: 86, gutter: 2 })
		expect(detailPlacement(120, true, 35)).toEqual({ kind: "bottom", height: 15 })
		expect(detailPlacement(80, false, 21)).toEqual({ kind: "overlay" })
	})
	it("matches the 80×24 and 60×20 mockups", () => {
		expect(overviewBudget(80, chromeRows(24, false).content, false, 9)).toMatchObject({ layout: "stacked", decoderRows: 9, more: 0, messageRows: 8 })
		expect(overviewBudget(60, chromeRows(16, false).content, false, 9)).toMatchObject({ decoderRows: 5, more: 1, hiddenDecoders: 4, messageRows: 3 })
		expect(overviewBudget(200, chromeRows(50, false).content, true, 9)).toMatchObject({ layout: "columns", rightWidth: 86 })
	})

	// Feature: cli-dashboard-overhaul, Property 5: frame budget
	// Validates: spec §5.1
	it("P5: regions fit rows-1, messages ≥ 3, decoders are all accounted for", () => {
		fc.assert(
			fc.property(fc.integer({ min: 60, max: 260 }), fc.integer({ min: 16, max: 90 }), fc.integer({ min: 0, max: 60 }), fc.boolean(), (cols, rows, n, banner) => {
				const c = chromeRows(rows, banner)
				const roomy = heightClass(rows) === "roomy"
				const b = overviewBudget(cols, c.content, roomy, n)
				const chrome = c.strip + c.switcher + c.blank + c.banner + c.footer
				const left = b.receiver + b.gapAfterReceiver + b.decoderHeader + b.decoderRows + b.more
				const stacked = left + b.gapAfterDecoders + b.messageHeader + b.messageRows
				const content = b.layout === "columns" ? Math.max(left, b.messageHeader + b.messageRows) : stacked
				expect(chrome + content).toBeLessThanOrEqual(rows - 1)
				expect(b.messageRows).toBeGreaterThanOrEqual(3)
				if (n === 0) expect(b.decoderRows).toBe(1)
				else expect(b.decoderRows + b.hiddenDecoders).toBe(n)
				expect(b.more).toBe(b.hiddenDecoders > 0 ? 1 : 0)
				const l = listBudget(cols, c.content, roomy, 1, true)
				expect(l.header + l.listRows + l.gapRows + (l.placement.kind === "bottom" ? l.detailRows : 0)).toBeLessThanOrEqual(c.content)
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/frame.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/frame.ts`**

```ts
import type { HeightClass, WidthClass } from "./line.js"

export const MIN_COLS = 60
export const MIN_ROWS = 16

export function tooSmall(cols: number, rows: number): boolean {
	return cols < MIN_COLS || rows < MIN_ROWS
}

/** One line that always fits (spec §5.1); the 52-column full text does not fit a 50-column terminal. */
export function tooSmallText(cols: number, rows: number): string {
	const variants = [
		`wavekit: terminal ${cols}×${rows} is too small (minimum ${MIN_COLS}×${MIN_ROWS})`,
		`wavekit: ${cols}×${rows} too small (min ${MIN_COLS}×${MIN_ROWS})`,
		`min ${MIN_COLS}×${MIN_ROWS}`,
	]
	return variants.find(v => [...v].length <= cols) ?? (variants[2] ?? "")
}

export function heightClass(rows: number): HeightClass {
	return rows >= 30 ? "roomy" : "compact"
}

export function widthClass(cols: number): WidthClass {
	if (cols < 80) return "narrow"
	if (cols < 120) return "standard"
	if (cols < 160) return "wide"
	return "ultra"
}

export interface Chrome {
	frame: number
	strip: 1
	switcher: 0 | 1
	blank: 0 | 1
	banner: 0 | 1
	footer: 1
	content: number
}

/** Frame height is rows − 1 so Ink's full-clear path (outputHeight ≥ rows) never triggers. */
export function chromeRows(rows: number, bannerOn: boolean): Chrome {
	const roomy = heightClass(rows) === "roomy"
	const frame = rows - 1
	const switcher: 0 | 1 = roomy ? 1 : 0
	const blank: 0 | 1 = roomy ? 1 : 0
	const banner: 0 | 1 = bannerOn ? 1 : 0
	return { frame, strip: 1, switcher, blank, banner, footer: 1, content: frame - 1 - switcher - blank - banner - 1 }
}

export type DetailPlacement =
	| { kind: "right"; width: number; gutter: 2 }
	| { kind: "bottom"; height: number }
	| { kind: "overlay" }

export function detailPlacement(cols: number, roomy: boolean, content: number): DetailPlacement {
	if (widthClass(cols) === "ultra") return { kind: "right", width: Math.floor(cols * 0.43), gutter: 2 }
	if (roomy) return { kind: "bottom", height: Math.max(8, Math.floor(content * 0.45)) }
	return { kind: "overlay" }
}

export interface OverviewBudget {
	layout: "stacked" | "columns"
	leftWidth: number
	rightWidth: number
	receiver: 2
	gapAfterReceiver: 0 | 1
	decoderHeader: 1
	decoderRows: number
	more: 0 | 1
	hiddenDecoders: number
	gapAfterDecoders: 0 | 1
	messageHeader: 1
	messageRows: number
}

const MIN_MESSAGES = 3

function decoderSplit(avail: number, n: number): { rows: number; more: 0 | 1; hidden: number } {
	const need = Math.max(1, n)
	if (need <= avail) return { rows: need, more: 0, hidden: 0 }
	const rows = Math.max(0, avail - 1)
	return { rows, more: 1, hidden: n - rows }
}

export function overviewBudget(cols: number, content: number, roomy: boolean, nDecoders: number): OverviewBudget {
	const c = { content }
	const sep: 0 | 1 = roomy ? 1 : 0
	const inner = cols - 1
	if (widthClass(cols) === "ultra") {
		const rightWidth = Math.floor(cols * 0.43)
		const leftWidth = inner - rightWidth - 2
		const split = decoderSplit(c.content - 2 - sep - 1, nDecoders)
		return {
			layout: "columns",
			leftWidth,
			rightWidth,
			receiver: 2,
			gapAfterReceiver: sep,
			decoderHeader: 1,
			decoderRows: split.rows,
			more: split.more,
			hiddenDecoders: split.hidden,
			gapAfterDecoders: 0,
			messageHeader: 1,
			messageRows: c.content - 1,
		}
	}
	const fixed = 2 + sep + 1 + sep + 1
	const avail = c.content - fixed
	const split = decoderSplit(avail - MIN_MESSAGES, nDecoders)
	return {
		layout: "stacked",
		leftWidth: inner,
		rightWidth: 0,
		receiver: 2,
		gapAfterReceiver: sep,
		decoderHeader: 1,
		decoderRows: split.rows,
		more: split.more,
		hiddenDecoders: split.hidden,
		gapAfterDecoders: sep,
		messageHeader: 1,
		messageRows: avail - split.rows - split.more,
	}
}

export interface ListBudget {
	header: number
	listRows: number
	gapRows: number
	detailRows: number
	placement: DetailPlacement
}

/** Decoders and Messages: header rows, list rows and the detail pane (spec §5.1 detail placement). */
export function listBudget(cols: number, content: number, roomy: boolean, headerRows: number, detailOpen: boolean): ListBudget {
	const c = { content }
	const placement = detailPlacement(cols, roomy, c.content)
	const body = c.content - headerRows
	if (!detailOpen) return { header: headerRows, listRows: body, gapRows: 0, detailRows: 0, placement }
	switch (placement.kind) {
		case "right":
			return { header: headerRows, listRows: body, gapRows: 0, detailRows: c.content, placement }
		case "bottom": {
			const detailRows = Math.min(placement.height, Math.max(0, body - 2))
			return { header: headerRows, listRows: body - 1 - detailRows, gapRows: 1, detailRows, placement: { kind: "bottom", height: detailRows } }
		}
		case "overlay":
			return { header: 0, listRows: 0, gapRows: 0, detailRows: c.content, placement }
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/frame.test.ts`
Expected: PASS. At 80×24 without a banner: content = 23 − 2 = 21, fixed = 4, avail = 17, and 9 decoders fit, which leaves 8 message rows (spec §6.1).

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/frame.ts tests/unit/cli/frame.test.ts
git commit -m "feat(cli): frame budget, height/width classes, detail placement

Property 5 (spec §5.1).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 21: Chain strip (B, after Task 5)

**Owner:** B · **Spec:** §4, T1, T2, T8, P21 · **Starts after** Task 5 (A), which provides `apiView` and `iqView` in `cli/source/data/freshness.ts`, is merged.

**Files:**
- Create: `cli/source/ui/strip.ts`
- Test: `tests/unit/cli/strip.test.ts`

**Interfaces:**
- Consumes: `ApiView`, `IqView`, `GlyphRole` from `data/types.ts`. `apiView`, `iqView` from `data/freshness.ts` (Task 5, A; test only, to build realistic `StripInput` lanes). `fitGroups` (Task 18), the format helpers (Task 17), `glyphs()`.
- Produces:
  - Signature:
    ```ts
    interface StripInput {
    	api: ApiView
    	iq: IqView
    	decoders: { up: number; total: number; failing: number; inWindow: number | null } | null
    	drops: { ratio: number | null; backpressure: boolean }
    	rx: { centreHz: number; halfSpanHz: number | null; control: "internal" | "external" | null } | null
    	clockMs: number
    	old: { iq: boolean; decoders: boolean; rx: boolean }
    }
    ```
  - `glyphSpan(role: GlyphRole): Span`
  - `stripGroups(input: StripInput): Group[]`, in display order api, iq, rx, decoders, drops, clock with priorities 1, 2, 5, 3, 4, 6
  - `stripLine(input: StripInput, width: number): Line`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/strip.test.ts`:

```ts
import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import { apiView, iqView } from "../../../cli/source/data/freshness.js"
import type { ConnState } from "../../../cli/source/data/types.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { stripLine, type StripInput } from "../../../cli/source/ui/strip.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const NOW = Date.parse("2026-10-08T18:07:52Z")
const live: StripInput = {
	api: { kind: "ok", restAgeMs: 2000 },
	iq: { glyph: "live", word: "streaming", ageMs: null, rateBytesPerSec: 3994 * 1024 },
	decoders: { up: 8, total: 9, failing: 1, inWindow: 2 },
	drops: { ratio: 0.34, backpressure: true },
	rx: { centreHz: 445_970_700, halfSpanHz: 1_024_000, control: "external" },
	clockMs: NOW,
	old: { iq: false, decoders: false, rx: false },
}

describe("strip (spec §4.2 widths)", () => {
	it("renders the 200/120/80/60 column variants", () => {
		expect(lineText(stripLine(live, 199))).toMatch(/^api ● 2s {2}iq ● streaming · 4\.1 MB\/s {2}rx 445\.971 MHz ±1\.024 · external control {2}decoders 8\/9 up · 1 failing · 2 in window {2}drops !34% now +18:07$/)
		expect(lineText(stripLine(live, 79))).toMatch(/^api ● 2s {2}iq ● streaming {2}rx 445\.971 MHz {2}decoders 1 failing {2}drops !34% +18:07$/)
		expect(lineText(stripLine(live, 59))).toBe("api ● 2s  iq ● streaming  decoders 1 failing  drops !34%")
	})
	it("renders the connectivity variants", () => {
		const t = (api: StripInput["api"]) => lineText(stripLine({ ...live, api }, 119))
		expect(t({ kind: "split", ws: true, rest: false, restAgeMs: 45000 })).toMatch(/^api ws ● rest × 45s/)
		expect(t({ kind: "split", ws: false, rest: true, restAgeMs: 2000 })).toMatch(/^api ws × rest ● 2s/)
		expect(t({ kind: "down", sinceMs: 151000 })).toMatch(/^api × 2m 31s/)
		expect(t({ kind: "connecting" })).toMatch(/^api ○ connecting/)
	})
	it("never shows 0 for unknowns", () => {
		const out = lineText(stripLine({ ...live, iq: { glyph: "unknown", word: "unknown", ageMs: null, rateBytesPerSec: null }, decoders: null, drops: { ratio: null, backpressure: false } }, 119))
		expect(out).toContain("iq ? unknown")
		expect(out).toContain("decoders ?")
		expect(out).toContain("drops ?")
	})

	function conn(ws: ConnState["ws"]["state"], lastOkAt: number | null): ConnState {
		return {
			target: { base: null, ws: null }, discovery: { mode: "explicit", tried: [] },
			ws: { state: ws, since: 0, code: null, reason: null, nextRetryAt: null, attempt: 0 },
			rest: { lastOkAt, lastCycleAt: null, nextAt: null, failing: [], firstFailAt: null, lastError: null },
			invalidFrames: 0, rejectedItems: 0, lastEventAt: null,
		}
	}
	const states = ["disconnected", "waiting", "streaming", "stale", "paused", "ended"] as const

	// Feature: cli-dashboard-overhaul, Property 21: strip honesty
	// Validates: spec T1, T2, §9
	it("P21: streaming only when activity is streaming and fresh; api ● only when WS open and REST fresh; no banned words", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...states),
				fc.boolean(),
				fc.option(fc.integer({ min: 0, max: 30000 }), { nil: null }),
				fc.constantFrom("idle", "connecting", "open", "closed") as fc.Arbitrary<ConnState["ws"]["state"]>,
				fc.option(fc.integer({ min: 0, max: 60000 }), { nil: null }),
				fc.integer({ min: 60, max: 220 }),
				(state, fresh, beatAge, ws, okAgo, width) => {
					const now = 100_000
					const source = { id: "s", connected: true, dataRate: 10, activity: { state, lastSampleAt: null, sampleAgeMs: 5, timeoutMs: 1 } } as ExtendedSourceStatus
					const beat = beatAge === null ? undefined : { bytesReceived: 1, dataRateKiB: 10, at: now - beatAge }
					const c = conn(ws, okAgo === null ? null : now - okAgo)
					const input: StripInput = { ...live, iq: iqView(source, fresh, beat, now), api: apiView(c, now) }
					const text = lineText(stripLine(input, width - 1))
					expect(lineWidth(stripLine(input, width - 1))).toBeLessThanOrEqual(width - 1)
					if (text.includes("streaming")) expect(fresh && state === "streaming").toBe(true)
					expect(text.startsWith("api ●")).toBe(ws === "open" && okAgo !== null && okAgo <= 15000)
					expect(findBanned(text)).toEqual([])
				},
			),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/strip.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/strip.ts`**

```ts
import type { ApiView, GlyphRole, IqView } from "../data/types.js"
import { fitGroups } from "./fit.js"
import { formatAge, formatClockShort, formatHalfSpan, formatMHz, formatPercent, formatRate } from "./format.js"
import type { Group, Line, Role, Span } from "./line.js"
import { glyphs } from "./theme.js"

export interface StripInput {
	api: ApiView
	iq: IqView
	decoders: { up: number; total: number; failing: number; inWindow: number | null } | null
	drops: { ratio: number | null; backpressure: boolean }
	rx: { centreHz: number; halfSpanHz: number | null; control: "internal" | "external" | null } | null
	clockMs: number
	old: { iq: boolean; decoders: boolean; rx: boolean }
}

const GLYPH_ROLE: Readonly<Record<GlyphRole, Role>> = { live: "live", neutral: "neutral", fault: "fault", unknown: "unknown" }

export function glyphSpan(role: GlyphRole): Span {
	const g = glyphs()
	const text = role === "live" ? g.live : role === "fault" ? g.fault : role === "neutral" ? g.neutral : g.unknown
	return { text, role: GLYPH_ROLE[role] }
}

const label = (text: string): Span => ({ text, role: "label" })
const value = (text: string, old = false, role: Role = "value"): Span => (old ? { text, role: "old" } : { text, role, bold: true })

function apiGroup(a: ApiView): Group {
	switch (a.kind) {
		case "connecting":
			return { priority: 1, variants: [[label("api "), glyphSpan("neutral"), value(" connecting")]] }
		case "ok":
			return { priority: 1, variants: [[label("api "), glyphSpan("live"), value(` ${formatAge(a.restAgeMs)}`)]] }
		case "split":
			return {
				priority: 1,
				variants: [
					[
						label("api ws "),
						glyphSpan(a.ws ? "live" : "fault"),
						label(" rest "),
						glyphSpan(a.rest ? "live" : "fault"),
						value(` ${formatAge(a.restAgeMs)}`),
					],
				],
			}
		case "down":
			return { priority: 1, variants: [[label("api "), glyphSpan("fault"), value(` ${formatAge(a.sinceMs)}`)]] }
	}
}

function iqGroup(iq: IqView, old: boolean): Group {
	const word = iq.word === "no samples" ? `no samples ${formatAge(iq.ageMs)}` : iq.word
	const base: Line = [label("iq "), glyphSpan(iq.glyph), value(` ${word}`, old)]
	const variants: Line[] = [base]
	if (iq.rateBytesPerSec !== null && iq.glyph !== "unknown") {
		variants.push([...base, label(` ${glyphs().sep} `), value(formatRate(iq.rateBytesPerSec), old)])
	}
	return { priority: 2, variants }
}

function decodersGroup(d: StripInput["decoders"], old: boolean): Group {
	if (d === null) return { priority: 3, variants: [[label("decoders "), { text: "?", role: "unknown" }]] }
	const sep = ` ${glyphs().sep} `
	const up = `${d.up}/${d.total} up`
	const minimal: Line = d.failing > 0
		? [label("decoders "), value(`${d.failing} failing`, old, "fault")]
		: [label("decoders "), value(up, old)]
	const mid: Line = d.failing > 0
		? [label("decoders "), value(up, old), label(sep), value(`${d.failing} failing`, old, "fault")]
		: minimal
	const rich: Line = d.inWindow !== null ? [...mid, label(sep), value(`${d.inWindow} in window`, old)] : mid
	return { priority: 3, variants: [minimal, mid, rich] }
}

function dropsGroup(d: StripInput["drops"]): Group {
	if (d.ratio === null) return { priority: 4, variants: [[label("drops "), { text: "?", role: "unknown" }]] }
	const pct = formatPercent(d.ratio)
	const v: Span = d.backpressure ? { text: `${glyphs().attention}${pct}`, role: "attention", bold: true } : value(pct)
	return { priority: 4, variants: [[label("drops "), v], [label("drops "), v, label(" now")]] }
}

function rxGroup(rx: NonNullable<StripInput["rx"]>, old: boolean): Group {
	const base: Line = [label("rx "), value(formatMHz(rx.centreHz), old)]
	const mid: Line = rx.halfSpanHz !== null ? [...base, value(` ${formatHalfSpan(rx.halfSpanHz * 2)}`, old)] : base
	const owner = rx.control === "external" ? "external control" : rx.control === "internal" ? "wavekit control" : null
	const rich: Line = owner ? [...mid, label(` ${glyphs().sep} `), value(owner, old)] : mid
	return { priority: 5, variants: [base, mid, rich] }
}

/** Display order: api, iq, rx, decoders, drops, clock (spec §4). */
export function stripGroups(input: StripInput): Group[] {
	const groups: Group[] = [apiGroup(input.api), iqGroup(input.iq, input.old.iq)]
	if (input.rx) groups.push(rxGroup(input.rx, input.old.rx))
	groups.push(decodersGroup(input.decoders, input.old.decoders), dropsGroup(input.drops))
	groups.push({ priority: 6, variants: [[label(formatClockShort(input.clockMs))]] })
	return groups
}

export function stripLine(input: StripInput, width: number): Line {
	return fitGroups(stripGroups(input), width, { rightAlignLast: true })
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/strip.test.ts`
Expected: PASS. `formatHalfSpan` takes the sample rate, which is why `rxGroup` passes `halfSpanHz * 2`.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/strip.ts tests/unit/cli/strip.test.ts
git commit -m "feat(cli): chain strip lanes with minimal/mid/rich variants

Property 21: streaming and api ● only on the evidence that supports them.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 22: Connectivity banner (B)

**Owner:** B · **Spec:** §9 banner copy, §5.1 banner row

**Files:**
- Create: `cli/source/ui/banner.ts`
- Test: `tests/unit/cli/banner.test.ts`

**Interfaces:**
- Consumes: `fitGroups`, `formatClock`, `glyphs()`.
- Produces:
  - Signature:
    ```ts
    type BannerCondition =
    	| { kind: "api-down"; reason: string; retryAt: number | null; asOf: number | null; target: string | null; tried: readonly string[] }
    	| { kind: "rest-down"; reason: string; retryAt: number | null; asOf: number | null }
    	| { kind: "ws-down"; code: number | null; retryAt: number | null }
    	| { kind: "endpoint"; path: string; reason: string }
    ```
  - `bannerLine(conds: readonly BannerCondition[], now: number, width: number): Line | null`. Priority runs api-down > rest-down > ws-down > endpoint, and `· +N` is added when more than one condition holds.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/banner.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { bannerLine, type BannerCondition } from "../../../cli/source/ui/banner.js"
import { lineText } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const NOW = Date.parse("2026-10-08T18:10:11Z")
const t = (conds: BannerCondition[], w = 119) => {
	const l = bannerLine(conds, NOW, w)
	return l ? lineText(l) : null
}

describe("banner copy (spec §9)", () => {
	it("is absent without a condition", () => {
		expect(t([])).toBeNull()
	})
	it("matches the spec rows", () => {
		expect(t([{ kind: "api-down", reason: "ECONNREFUSED", retryAt: NOW + 4000, asOf: Date.parse("2026-10-08T18:07:40Z"), target: "http://127.0.0.1:9000", tried: [] }])).toBe("! API unreachable · ECONNREFUSED · retry in 4s · data as of 18:07:40")
		expect(t([{ kind: "api-down", reason: "ECONNREFUSED", retryAt: NOW + 4000, asOf: null, target: "http://127.0.0.1:9000", tried: [] }])).toBe("! API unreachable · ECONNREFUSED · retry in 4s · 127.0.0.1:9000")
		expect(t([{ kind: "api-down", reason: "no API answered", retryAt: NOW + 4000, asOf: null, target: null, tried: ["127.0.0.1:9000", "127.0.0.1:3000"] }])).toBe("! API unreachable · tried 127.0.0.1:9000, 127.0.0.1:3000 · retry in 4s")
		expect(t([{ kind: "ws-down", code: 1006, retryAt: NOW + 8000 }])).toBe("! live feed down · ws closed 1006 · REST every 5s · retry in 8s")
		expect(t([{ kind: "rest-down", reason: "timeout 2s", retryAt: NOW + 3000, asOf: Date.parse("2026-10-08T18:08:20Z") }])).toBe("! REST failing · timeout 2s · retry in 3s · REST data as of 18:08:20")
		expect(t([{ kind: "endpoint", path: "/api/resources", reason: "500" }])).toBe("! GET /api/resources failing · 500 · other endpoints answering")
	})
	it("shows the highest-priority condition plus · +N", () => {
		const out = t([{ kind: "endpoint", path: "/api/resources", reason: "500" }, { kind: "ws-down", code: 1006, retryAt: NOW + 8000 }])
		expect(out).toBe("! live feed down · ws closed 1006 · REST every 5s · retry in 8s · +1")
	})
	it("drops trailing groups at narrow widths and never uses banned words", () => {
		const out = t([{ kind: "rest-down", reason: "timeout 2s", retryAt: NOW + 3000, asOf: NOW - 51000 }], 45)
		expect(out).toBe("! REST failing · timeout 2s · retry in 3s")
		expect(findBanned(out ?? "")).toEqual([])
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/banner.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/banner.ts`**

```ts
import { fitGroups } from "./fit.js"
import { formatClock } from "./format.js"
import type { Group, Line } from "./line.js"
import { glyphs } from "./theme.js"

export type BannerCondition =
	| { kind: "api-down"; reason: string; retryAt: number | null; asOf: number | null; target: string | null; tried: readonly string[] }
	| { kind: "rest-down"; reason: string; retryAt: number | null; asOf: number | null }
	| { kind: "ws-down"; code: number | null; retryAt: number | null }
	| { kind: "endpoint"; path: string; reason: string }

const RANK: Readonly<Record<BannerCondition["kind"], number>> = { "api-down": 0, "rest-down": 1, "ws-down": 2, endpoint: 3 }

const plain = (text: string, priority: number): Group => ({ priority, variants: [[{ text, role: "value" }]] })

function head(text: string): Group {
	return { priority: 0, variants: [[{ text: `${glyphs().attention} `, role: "attention", bold: true }, { text, role: "value", bold: true }]] }
}

function retry(retryAt: number | null, now: number): Group[] {
	if (retryAt === null) return []
	return [plain(`retry in ${Math.max(0, Math.ceil((retryAt - now) / 1000))}s`, 2)]
}

function hostOf(url: string): string {
	try {
		return new URL(url).host
	} catch {
		return url
	}
}

function groupsFor(c: BannerCondition, now: number): Group[] {
	switch (c.kind) {
		case "api-down": {
			const out: Group[] = [head("API unreachable")]
			if (c.target === null && c.tried.length > 0) out.push(plain(`tried ${c.tried.join(", ")}`, 1))
			else out.push(plain(c.reason, 1))
			out.push(...retry(c.retryAt, now))
			if (c.asOf !== null) out.push(plain(`data as of ${formatClock(c.asOf)}`, 3))
			else if (c.target !== null) out.push(plain(hostOf(c.target), 3))
			return out
		}
		case "rest-down": {
			const out: Group[] = [head("REST failing"), plain(c.reason, 1), ...retry(c.retryAt, now)]
			if (c.asOf !== null) out.push(plain(`REST data as of ${formatClock(c.asOf)}`, 3))
			return out
		}
		case "ws-down":
			return [head("live feed down"), plain(c.code === null ? "ws closed" : `ws closed ${c.code}`, 1), plain("REST every 5s", 3), ...retry(c.retryAt, now)]
		case "endpoint":
			return [head(`GET ${c.path} failing`), plain(c.reason, 1), plain("other endpoints answering", 3)]
	}
}

export function bannerLine(conds: readonly BannerCondition[], now: number, width: number): Line | null {
	if (conds.length === 0) return null
	const sorted = [...conds].sort((a, b) => RANK[a.kind] - RANK[b.kind])
	const first = sorted[0]
	if (!first) return null
	const groups = groupsFor(first, now)
	if (sorted.length > 1) groups.push(plain(`+${sorted.length - 1}`, 4))
	return fitGroups(groups, width, { sep: [{ text: ` ${glyphs().sep} `, role: "label" }] })
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/banner.test.ts`
Expected: PASS. In the ws-down row, `REST every 5s` (priority 3) is placed before `retry` (priority 2) to match the spec copy. Display order is the push order and dropping order is by priority, so at narrow widths `REST every 5s` goes first.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/banner.ts tests/unit/cli/banner.test.ts
git commit -m "feat(cli): one-line connectivity banner with spec §9 copy

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 23: Keymap, `resolveKey` and footer hints (B)

**Owner:** B · **Spec:** §7, P20

**Files:**
- Create: `cli/source/ui/keymap.ts`
- Test: `tests/unit/cli/keymap.test.ts`

**Interfaces:**
- Consumes: `Action`, `EditKey`, `ViewId`, `ViewKeyCtx`, `VIEW_ORDER`, `VIEW_TITLES`, `isWrite` (Task 2). `ConfirmKind`, `Group`, `HeightClass`, `fitGroups`, `glyphs()`.
- Produces:
  - `interface KeyFlags { upArrow?; downArrow?; leftArrow?; rightArrow?; pageUp?; pageDown?; return?; escape?; ctrl?; shift?; tab?; backspace?; delete?; meta? }`. All are optional booleans and structurally compatible with Ink's `Key`.
  - `keyName(input: string, k: KeyFlags): string`. Named keys are `<up> <down> <left> <right> <pgup> <pgdn> <enter> <esc> <tab> <shift-tab> <backspace> <space> <ctrl-x> <meta-x>`, and anything else is the raw input. Backspace and Delete both map to `<backspace>`.
  - `isPrintable(key: string): boolean`
  - `interface KeyContext { view: ViewId; confirm: ConfirmKind | null; help: boolean; input: boolean; edit: boolean; detail: boolean; heightClass: HeightClass; v: ViewKeyCtx }`
  - `type ModeName = "confirm" | "help" | "input" | "edit" | "detail" | "list" | "global"`, `modeChain(ctx): ModeName[]`
  - `interface Hint { keys: string; label: string; rich?: string }`, `interface Binding { mode; views?; keys; action(key, ctx): Action; hint?(ctx): Hint | null; when?(ctx): boolean }`, `BINDINGS: readonly Binding[]`
  - `resolveKey(ctx: KeyContext, key: string): Action | undefined`
  - `interface FooterHint { key: string; hint: Hint; mode: ModeName }`, `footerHints(ctx): FooterHint[]`, `footerGroups(ctx): Group[]`, `footerLine(ctx, width): Line`
  - `RECEIVER_EXTERNAL_NOTICE = "controlled externally · c to take control"`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/keymap.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { VIEW_ORDER, isWrite, type ViewId } from "../../../cli/source/ui/actions.js"
import { footerHints, footerLine, keyName, resolveKey, type KeyContext } from "../../../cli/source/ui/keymap.js"
import { lineText } from "../../../cli/source/ui/text.js"

const base: KeyContext = {
	view: "overview",
	confirm: null,
	help: false,
	input: false,
	edit: false,
	detail: false,
	heightClass: "roomy",
	v: { hasSelection: false, decoderRunning: null, control: null, audioRunning: null, paused: false },
}

describe("keyName", () => {
	it("normalises Ink keys; Backspace and Delete are the same key", () => {
		expect(keyName("", { backspace: false, delete: true })).toBe("<backspace>")
		expect(keyName("", { backspace: true })).toBe("<backspace>")
		expect(keyName("c", { ctrl: true })).toBe("<ctrl-c>")
		expect(keyName("", { escape: true, meta: true })).toBe("<esc>")
		expect(keyName("", { tab: true, shift: true })).toBe("<shift-tab>")
		expect(keyName(" ", {})).toBe("<space>")
		expect(keyName("q", {})).toBe("q")
	})
})

describe("resolveKey", () => {
	it("walks confirm → help → input → edit → detail → list → global", () => {
		expect(resolveKey({ ...base, confirm: "decoder" }, "1")).toBeUndefined()
		expect(resolveKey({ ...base, confirm: "decoder" }, "y")).toEqual({ type: "confirm-yes" })
		expect(resolveKey({ ...base, confirm: "decoder" }, "<enter>")).toBeUndefined()
		expect(resolveKey({ ...base, help: true }, "x")).toEqual({ type: "help-close" })
		expect(resolveKey({ ...base, view: "messages", input: true }, "q")).toEqual({ type: "filter-type", text: "q" })
		expect(resolveKey({ ...base, view: "messages", input: true }, "<ctrl-c>")).toEqual({ type: "quit" })
		expect(resolveKey({ ...base, view: "receiver", edit: true }, "7")).toEqual({ type: "edit-key", key: "7" })
		expect(resolveKey({ ...base, view: "decoders", detail: true }, "<esc>")).toEqual({ type: "escape" })
		expect(resolveKey(base, "3")).toEqual({ type: "view", view: "messages" })
		expect(resolveKey(base, "q")).toEqual({ type: "quit" })
	})
	it("gates decoder controls on selection and running state", () => {
		const d = { ...base, view: "decoders" as ViewId, v: { ...base.v, hasSelection: true, decoderRunning: true } }
		expect(resolveKey(d, "x")).toEqual({ type: "decoder-op", op: "stop" })
		expect(resolveKey(d, "s")).toBeUndefined()
		expect(resolveKey({ ...d, v: { ...d.v, decoderRunning: false } }, "s")).toEqual({ type: "decoder-op", op: "start" })
		expect(resolveKey(d, "R")).toEqual({ type: "decoder-op", op: "restart" })
	})
	it("reports external control on e instead of editing", () => {
		const r = { ...base, view: "receiver" as ViewId, v: { ...base.v, control: "external" as const } }
		expect(resolveKey(r, "e")).toEqual({ type: "notice", text: "controlled externally · c to take control" })
		expect(resolveKey({ ...r, v: { ...r.v, control: "internal" } }, "e")).toEqual({ type: "edit-open" })
	})
})

describe("footer", () => {
	it("matches the spec footers", () => {
		expect(lineText(footerLine(base, 119))).toBe("↑↓ select decoder  Enter open  r reconnect  q quit  ? help")
		expect(lineText(footerLine({ ...base, heightClass: "compact" }, 79))).toBe("Overview · 1-5 views  ↑↓ select  Enter open  r reconnect  q quit  ? help")
		const d = { ...base, view: "decoders" as ViewId, detail: true, v: { ...base.v, hasSelection: true, decoderRunning: true } }
		expect(lineText(footerLine(d, 119))).toBe("↑↓ select  Esc close  x stop  R restart  r reconnect  q quit  ? help")
		const r = { ...base, view: "receiver" as ViewId, v: { ...base.v, control: "external" as const } }
		expect(lineText(footerLine(r, 119))).toBe("c take control  r reconnect  q quit  ? help")
		const e = { ...base, view: "receiver" as ViewId, edit: true }
		expect(lineText(footerLine(e, 119))).toBe("←→ digit  ↑↓ change  0-9 type  Tab next field  Space toggle  Enter review  Esc discard")
		const i = { ...base, view: "messages" as ViewId, input: true }
		expect(lineText(footerLine(i, 119))).toBe("Enter apply  Esc cancel  space = and  , = or  !emerg = emergencies only")
	})
})

const arbCtx: fc.Arbitrary<KeyContext> = fc.record({
	view: fc.constantFrom(...VIEW_ORDER),
	confirm: fc.constantFrom(null, "decoder", "tuner", "control", "preset") as fc.Arbitrary<KeyContext["confirm"]>,
	help: fc.boolean(),
	input: fc.boolean(),
	edit: fc.boolean(),
	detail: fc.boolean(),
	heightClass: fc.constantFrom("roomy", "compact") as fc.Arbitrary<KeyContext["heightClass"]>,
	v: fc.record({
		hasSelection: fc.boolean(),
		decoderRunning: fc.constantFrom(null, true, false),
		control: fc.constantFrom(null, "internal", "external") as fc.Arbitrary<KeyContext["v"]["control"]>,
		audioRunning: fc.constantFrom(null, true, false),
		paused: fc.boolean(),
	}),
})
const NAV = ["<up>", "<down>", "<left>", "<right>", "<pgup>", "<pgdn>", "<tab>", "<shift-tab>", "<enter>", "<esc>", "<space>", "<backspace>", "g", "G", "j", "k", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
const ALL = [...NAV, ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ?/!,."]

describe("P20", () => {
	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: in input mode every printable key types", () => {
		fc.assert(
			fc.property(arbCtx, fc.string({ minLength: 1, maxLength: 4 }).filter(s => !/[\u0000-\u001f\u007f-\u009f]/.test(s) && !(s.startsWith("<") && s.endsWith(">"))), (ctx, s) => {
				const c = { ...ctx, confirm: null, help: false, input: true }
				const a = resolveKey(c, keyName(s, {}))
				expect(a).toEqual({ type: "filter-type", text: s })
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: no navigation key resolves to a write in any mode", () => {
		fc.assert(
			fc.property(arbCtx, fc.constantFrom(...NAV), (ctx, key) => {
				const a = resolveKey(ctx, key)
				expect(a === undefined || !isWrite(a)).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7, T9
	it("P20: writes come only from confirm y (and audio a in System list mode)", () => {
		fc.assert(
			fc.property(arbCtx, fc.constantFrom(...ALL), (ctx, key) => {
				const a = resolveKey(ctx, key)
				if (!a || !isWrite(a)) return
				const modal = ctx.confirm !== null || ctx.help || ctx.input || ctx.edit
				if (a.type === "confirm-yes") expect(ctx.confirm !== null && key === "y").toBe(true)
				else expect(a.type === "audio-toggle" && key === "a" && ctx.view === "system" && !modal).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 20: keymap safety
	// Validates: spec §7
	it("P20: every footer hint resolves to an action in its mode", () => {
		fc.assert(
			fc.property(arbCtx, ctx => {
				for (const h of footerHints(ctx)) expect(resolveKey(ctx, h.key)).toBeDefined()
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/keymap.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/keymap.ts`**

```ts
import { VIEW_ORDER, VIEW_TITLES, type Action, type EditKey, type ViewId, type ViewKeyCtx } from "./actions.js"
import { fitGroups } from "./fit.js"
import type { Group, HeightClass, Line } from "./line.js"
import { glyphs } from "./theme.js"
import type { ConfirmKind } from "./ui-state.js"

export interface KeyFlags {
	upArrow?: boolean
	downArrow?: boolean
	leftArrow?: boolean
	rightArrow?: boolean
	pageUp?: boolean
	pageDown?: boolean
	return?: boolean
	escape?: boolean
	ctrl?: boolean
	shift?: boolean
	tab?: boolean
	backspace?: boolean
	delete?: boolean
	meta?: boolean
}

/** Ink parses one key per stdin chunk; Backspace (0x7f) arrives as key.delete, so both map to <backspace>. */
export function keyName(input: string, k: KeyFlags): string {
	if (k.escape === true) return "<esc>"
	if (k.upArrow === true) return "<up>"
	if (k.downArrow === true) return "<down>"
	if (k.leftArrow === true) return "<left>"
	if (k.rightArrow === true) return "<right>"
	if (k.pageUp === true) return "<pgup>"
	if (k.pageDown === true) return "<pgdn>"
	if (k.return === true) return "<enter>"
	if (k.tab === true) return k.shift === true ? "<shift-tab>" : "<tab>"
	if (k.backspace === true || k.delete === true) return "<backspace>"
	if (k.ctrl === true) return `<ctrl-${input}>`
	if (k.meta === true) return `<meta-${input}>`
	if (input === " ") return "<space>"
	return input
}

const isNamed = (key: string): boolean => key.length > 2 && key.startsWith("<") && key.endsWith(">")

export function isPrintable(key: string): boolean {
	return key.length > 0 && !isNamed(key) && !/[\u0000-\u001f\u007f-\u009f]/.test(key)
}

export interface KeyContext {
	view: ViewId
	confirm: ConfirmKind | null
	help: boolean
	input: boolean
	edit: boolean
	detail: boolean
	heightClass: HeightClass
	v: ViewKeyCtx
}

export type ModeName = "confirm" | "help" | "input" | "edit" | "detail" | "list" | "global"

export interface Hint {
	keys: string
	label: string
	rich?: string
}

export interface Binding {
	mode: ModeName
	views?: readonly ViewId[]
	/** Key names; "*any" matches every key, "*printable" every printable key. */
	keys: readonly string[]
	action: (key: string, ctx: KeyContext) => Action
	hint?: (ctx: KeyContext) => Hint | null
	when?: (ctx: KeyContext) => boolean
}

export const RECEIVER_EXTERNAL_NOTICE = "controlled externally · c to take control"
const ANY = "*any"
const PRINTABLE = "*printable"
const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const
const LIST_VIEWS: readonly ViewId[] = ["overview", "decoders", "messages"]
const DETAIL_VIEWS: readonly ViewId[] = ["decoders", "messages"]

const ud = (): string => `${glyphs().up}${glyphs().down}`
const lr = (): string => (glyphs().up === "↑" ? "←→" : "<>")
const hint = (keys: string, label: string) => (): Hint => ({ keys, label })
const edit = (key: EditKey): Action => ({ type: "edit-key", key })

export const BINDINGS: readonly Binding[] = [
	// confirm (modal)
	{ mode: "confirm", keys: ["y"], action: () => ({ type: "confirm-yes" }) },
	{ mode: "confirm", keys: ["n", "<esc>"], action: () => ({ type: "confirm-no" }) },
	{ mode: "confirm", keys: ["P"], when: c => c.confirm === "preset", action: () => ({ type: "preset-next" }) },
	// help (modal)
	{ mode: "help", keys: [ANY], action: () => ({ type: "help-close" }) },
	// input: Messages filter (modal)
	{ mode: "input", keys: ["<enter>"], action: () => ({ type: "filter-apply" }), hint: hint("Enter", "apply") },
	{ mode: "input", keys: ["<esc>"], action: () => ({ type: "filter-cancel" }), hint: hint("Esc", "cancel") },
	{ mode: "input", keys: ["<backspace>"], action: () => ({ type: "filter-backspace" }) },
	{ mode: "input", keys: ["<space>"], action: () => ({ type: "filter-type", text: " " }) },
	{ mode: "input", keys: [PRINTABLE], action: key => ({ type: "filter-type", text: key }) },
	// edit: Receiver tuner (modal)
	{ mode: "edit", keys: ["<left>"], action: () => edit("left"), hint: () => ({ keys: lr(), label: "digit" }) },
	{ mode: "edit", keys: ["<right>"], action: () => edit("right") },
	{ mode: "edit", keys: ["<up>"], action: () => edit("up"), hint: () => ({ keys: ud(), label: "change" }) },
	{ mode: "edit", keys: ["<down>"], action: () => edit("down") },
	{ mode: "edit", keys: DIGITS, action: key => edit(key as EditKey), hint: hint("0-9", "type") },
	{ mode: "edit", keys: ["<tab>"], action: () => edit("tab"), hint: hint("Tab", "next field") },
	{ mode: "edit", keys: ["<space>"], action: () => edit("space"), hint: hint("Space", "toggle") },
	{ mode: "edit", keys: ["<backspace>"], action: () => edit("backspace") },
	{ mode: "edit", keys: ["<enter>"], action: () => ({ type: "edit-review" }), hint: hint("Enter", "review") },
	{ mode: "edit", keys: ["<esc>"], action: () => ({ type: "edit-discard" }), hint: hint("Esc", "discard") },
	// detail: Decoders / Messages with the detail open
	{ mode: "detail", views: DETAIL_VIEWS, keys: ["<up>", "k"], action: () => ({ type: "move", delta: -1 }), hint: () => ({ keys: ud(), label: "select" }) },
	{ mode: "detail", views: DETAIL_VIEWS, keys: ["<down>", "j"], action: () => ({ type: "move", delta: 1 }) },
	{ mode: "detail", views: ["messages"], keys: ["<pgup>"], action: () => ({ type: "detail-scroll", delta: -1 }), hint: hint("PgUp PgDn", "scroll") },
	{ mode: "detail", views: ["messages"], keys: ["<pgdn>"], action: () => ({ type: "detail-scroll", delta: 1 }) },
	{ mode: "detail", views: ["messages"], keys: ["y"], action: () => ({ type: "copy-json" }), hint: hint("y", "copy JSON") },
	{ mode: "detail", views: DETAIL_VIEWS, keys: ["<esc>"], action: () => ({ type: "escape" }), hint: hint("Esc", "close") },
	// list
	{
		mode: "list",
		views: LIST_VIEWS,
		keys: ["<up>", "k"],
		action: () => ({ type: "move", delta: -1 }),
		hint: c => ({ keys: ud(), label: "select", ...(c.view === "overview" && c.heightClass === "roomy" ? { rich: "select decoder" } : {}) }),
	},
	{ mode: "list", views: LIST_VIEWS, keys: ["<down>", "j"], action: () => ({ type: "move", delta: 1 }) },
	{ mode: "list", views: DETAIL_VIEWS, keys: ["<pgup>"], action: () => ({ type: "page", delta: -1 }) },
	{ mode: "list", views: DETAIL_VIEWS, keys: ["<pgdn>"], action: () => ({ type: "page", delta: 1 }) },
	{ mode: "list", views: DETAIL_VIEWS, keys: ["g"], action: () => ({ type: "top" }) },
	{ mode: "list", views: LIST_VIEWS, keys: ["<enter>"], when: c => !c.detail, action: () => ({ type: "open" }), hint: hint("Enter", "open") },
	{ mode: "list", views: LIST_VIEWS, keys: ["<esc>"], action: () => ({ type: "escape" }) },
	{ mode: "list", views: ["messages"], keys: ["/"], action: () => ({ type: "filter-open" }), hint: hint("/", "filter") },
	{ mode: "list", views: ["messages"], keys: ["p"], action: () => ({ type: "pause-toggle" }), hint: c => ({ keys: "p", label: c.v.paused ? "resume" : "pause" }) },
	{ mode: "list", views: ["messages"], keys: ["G"], action: () => ({ type: "newest" }), hint: hint("G", "newest") },
	{ mode: "list", views: ["decoders"], keys: ["G"], action: () => ({ type: "newest" }) },
	{ mode: "list", views: ["messages"], keys: ["F"], action: () => ({ type: "preset-cycle" }), hint: hint("F", "preset") },
	{
		mode: "list",
		views: ["decoders"],
		keys: ["s"],
		when: c => c.v.hasSelection && c.v.decoderRunning === false,
		action: () => ({ type: "decoder-op", op: "start" }),
		hint: hint("s", "start"),
	},
	{
		mode: "list",
		views: ["decoders"],
		keys: ["x"],
		when: c => c.v.hasSelection && c.v.decoderRunning === true,
		action: () => ({ type: "decoder-op", op: "stop" }),
		hint: hint("x", "stop"),
	},
	{ mode: "list", views: ["decoders"], keys: ["R"], when: c => c.v.hasSelection, action: () => ({ type: "decoder-op", op: "restart" }), hint: hint("R", "restart") },
	{ mode: "list", views: ["receiver"], keys: ["e"], when: c => c.v.control === "internal", action: () => ({ type: "edit-open" }), hint: hint("e", "edit tuner") },
	{
		mode: "list",
		views: ["receiver"],
		keys: ["e"],
		when: c => c.v.control !== "internal",
		action: () => ({ type: "notice", text: RECEIVER_EXTERNAL_NOTICE }),
	},
	{
		mode: "list",
		views: ["receiver"],
		keys: ["c"],
		when: c => c.v.control !== null,
		action: () => ({ type: "control-toggle" }),
		hint: c => ({ keys: "c", label: c.v.control === "internal" ? "release control" : "take control" }),
	},
	{
		mode: "list",
		views: ["system"],
		keys: ["a"],
		when: c => c.v.audioRunning !== null,
		action: () => ({ type: "audio-toggle" }),
		hint: c => ({ keys: "a", label: c.v.audioRunning === true ? "stop audio" : "start audio" }),
	},
	{ mode: "list", views: ["system"], keys: ["P"], action: () => ({ type: "preset-open" }), hint: hint("P", "preset") },
	// global
	{ mode: "global", keys: ["1", "2", "3", "4", "5"], action: key => ({ type: "view", view: VIEW_ORDER[Number(key) - 1] ?? "overview" }) },
	{ mode: "global", keys: ["<tab>"], action: () => ({ type: "view-step", delta: 1 }) },
	{ mode: "global", keys: ["<shift-tab>"], action: () => ({ type: "view-step", delta: -1 }) },
	{ mode: "global", keys: ["r"], action: () => ({ type: "reconnect" }), hint: hint("r", "reconnect") },
	{ mode: "global", keys: ["q"], action: () => ({ type: "quit" }), hint: hint("q", "quit") },
	{ mode: "global", keys: ["?"], action: () => ({ type: "help-open" }), hint: hint("?", "help") },
]

export function modeChain(ctx: KeyContext): ModeName[] {
	if (ctx.confirm !== null) return ["confirm"]
	if (ctx.help) return ["help"]
	if (ctx.input) return ["input"]
	if (ctx.edit) return ["edit"]
	return ctx.detail ? ["detail", "list", "global"] : ["list", "global"]
}

function applies(b: Binding, ctx: KeyContext): boolean {
	if (b.views && !b.views.includes(ctx.view)) return false
	return b.when ? b.when(ctx) : true
}

function matches(b: Binding, key: string): boolean {
	if (b.keys.includes(key)) return true
	if (b.keys.includes(ANY)) return true
	return b.keys.includes(PRINTABLE) && isPrintable(key)
}

/** Ctrl-C always quits; otherwise the first binding in the active mode chain wins. */
export function resolveKey(ctx: KeyContext, key: string): Action | undefined {
	if (key === "<ctrl-c>") return { type: "quit" }
	for (const mode of modeChain(ctx)) {
		for (const b of BINDINGS) {
			if (b.mode !== mode || !applies(b, ctx) || !matches(b, key)) continue
			return b.action(key, ctx)
		}
	}
	return undefined
}

export interface FooterHint {
	key: string
	hint: Hint
	mode: ModeName
}

export function footerHints(ctx: KeyContext): FooterHint[] {
	const out: FooterHint[] = []
	const seen = new Set<string>()
	for (const mode of modeChain(ctx)) {
		for (const b of BINDINGS) {
			if (b.mode !== mode || !b.hint || !applies(b, ctx)) continue
			const h = b.hint(ctx)
			const key = b.keys[0]
			if (!h || key === undefined || seen.has(h.keys)) continue
			seen.add(h.keys)
			out.push({ key, hint: h, mode })
		}
	}
	return out
}

const GLOBAL_PRIORITY: Readonly<Record<string, number>> = { "?": 0, q: 3, r: 4 }
const FILTER_LEGEND = ["space = and", ", = or", "!emerg = emergencies only"] as const

function hintLine(keys: string, label: string): Line {
	return [
		{ text: keys, role: "value" },
		{ text: ` ${label}`, role: "label" },
	]
}

/** Footer priorities (spec §7): ? help 0, mode keys 1, switcher (compact) 2, q quit 3, r reconnect 4. */
export function footerGroups(ctx: KeyContext): Group[] {
	const groups: Group[] = []
	const modal = ctx.confirm !== null || ctx.help || ctx.input || ctx.edit
	if (ctx.heightClass === "compact" && !modal) {
		groups.push({ priority: 2, variants: [[{ text: `${VIEW_TITLES[ctx.view]} ${glyphs().sep} 1-5 views`, role: "label" }]] })
	}
	const hints = footerHints(ctx)
	const mode = hints.filter(h => h.mode !== "global")
	const global = ["r", "q", "?"].flatMap(k => hints.filter(h => h.mode === "global" && h.key === k))
	for (const h of mode) {
		const variants = [hintLine(h.hint.keys, h.hint.label)]
		if (h.hint.rich !== undefined) variants.push(hintLine(h.hint.keys, h.hint.rich))
		groups.push({ priority: 1, variants })
	}
	if (ctx.input) for (const l of FILTER_LEGEND) groups.push({ priority: 5, variants: [[{ text: l, role: "label" }]] })
	for (const h of global) groups.push({ priority: GLOBAL_PRIORITY[h.key] ?? 4, variants: [hintLine(h.hint.keys, h.hint.label)] })
	return groups
}

export function footerLine(ctx: KeyContext, width: number): Line {
	return fitGroups(footerGroups(ctx), width)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/keymap.test.ts`
Expected: PASS. The Decoders detail footer reads `↑↓ select  Esc close  x stop  R restart  …` because the detail-mode `↑↓` hint dedupes the list-mode one, and `Enter open` is hidden while the detail is open. The rich `select decoder` hint appears only at roomy height, so the compact 80×24 footer matches spec §6.1.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/keymap.ts tests/unit/cli/keymap.test.ts
git commit -m "feat(cli): data-driven keymap shared by resolveKey and the footer

Property 20: navigation never writes; writes only from confirm y (audio a
is the T9 exception); every footer hint resolves.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 24: UI state reducer (B)

**Owner:** B · **Spec:** §7 key table (selection, Esc chain, pause), §6.3 pause/filter semantics

**Files:**
- Create: `cli/source/ui/ui-reducer.ts`
- Test: `tests/unit/cli/ui-reducer.test.ts`

**Interfaces:**
- Consumes: `Action`, `VIEW_ORDER`, `UiState`, `PRESET_ORDER`.
- Produces:
  - `interface UiCtx { rowIds: readonly string[]; pageSize: number }`
  - `applyUiAction(ui: UiState, action: Action, ctx: UiCtx, now: number): UiState`. It handles the generic actions (`view`, `view-step`, `help-*`, `quit`, `move`, `page`, `top`, `newest`, `open`, `escape`, `detail-scroll`, `filter-*`, `pause-toggle`, `preset-cycle`, `confirm-no`, `notice`) and returns `ui` unchanged for everything else.

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/ui-reducer.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { applyUiAction } from "../../../cli/source/ui/ui-reducer.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"

const ctx = { rowIds: ["a", "b", "c"], pageSize: 2 }

describe("applyUiAction", () => {
	it("moves and clamps the selection", () => {
		let ui = applyUiAction(initialUi("decoders"), { type: "move", delta: 1 }, ctx, 0)
		expect(ui.selected.decoders).toBe("a")
		ui = applyUiAction(ui, { type: "page", delta: 1 }, ctx, 0)
		expect(ui.selected.decoders).toBe("c")
		ui = applyUiAction(ui, { type: "move", delta: 1 }, ctx, 0)
		expect(ui.selected.decoders).toBe("c")
	})
	it("auto-pauses the Messages feed on movement and resumes on G", () => {
		const m = { rowIds: ["42", "41", "40"], pageSize: 5 }
		let ui = applyUiAction(initialUi("messages"), { type: "move", delta: -1 }, m, 0)
		expect(ui.messages).toMatchObject({ following: false, pausedAtSeq: 42 })
		expect(ui.selected.messages).toBe("42")
		ui = applyUiAction(ui, { type: "newest" }, m, 0)
		expect(ui.messages).toMatchObject({ following: true, pausedAtSeq: null })
		expect(ui.selected.messages).toBeNull()
	})
	it("walks the Esc chain: detail → selection → filter", () => {
		let ui = initialUi("messages")
		ui = { ...ui, messages: { ...ui.messages, filterText: "readsb" } }
		ui = applyUiAction(ui, { type: "open" }, { rowIds: ["7"], pageSize: 5 }, 0)
		expect(ui.detail.messages.open).toBe(true)
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.detail.messages.open).toBe(false)
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.selected.messages).toBeNull()
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.messages.filterText).toBe("")
	})
	it("edits a filter draft and applies or cancels it", () => {
		let ui = applyUiAction(initialUi("messages"), { type: "filter-open" }, ctx, 0)
		for (const t of ["r", "e", "a", "d", "s", "b", "x"]) ui = applyUiAction(ui, { type: "filter-type", text: t }, ctx, 0)
		ui = applyUiAction(ui, { type: "filter-backspace" }, ctx, 0)
		expect(ui.messages.draft).toBe("readsb")
		ui = applyUiAction(ui, { type: "filter-apply" }, ctx, 0)
		expect(ui.messages).toMatchObject({ draft: null, filterText: "readsb" })
		ui = applyUiAction(applyUiAction(ui, { type: "filter-open" }, ctx, 0), { type: "filter-cancel" }, ctx, 0)
		expect(ui.messages).toMatchObject({ draft: null, filterText: "readsb" })
	})
	it("wraps view steps, cycles presets and stores notices", () => {
		expect(applyUiAction(initialUi("overview"), { type: "view-step", delta: -1 }, ctx, 0).view).toBe("system")
		expect(applyUiAction(initialUi("messages"), { type: "preset-cycle" }, ctx, 0).messages.preset).toBe("aircraft")
		expect(applyUiAction(initialUi("receiver"), { type: "notice", text: "x" }, ctx, 9).notice).toEqual({ text: "x", at: 9 })
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/ui-reducer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/ui-reducer.ts`**

```ts
import { VIEW_ORDER, type Action } from "./actions.js"
import { PRESET_ORDER, type UiState } from "./ui-state.js"

export interface UiCtx {
	/** Selectable row ids in display order (Messages: seq strings, newest first). */
	rowIds: readonly string[]
	pageSize: number
}

function select(ui: UiState, id: string | null): UiState {
	return { ...ui, selected: { ...ui.selected, [ui.view]: id } }
}

/** Freeze the Messages slice at its newest visible seq so the selected row cannot move. */
function pause(ui: UiState, ctx: UiCtx): UiState {
	const seqs = ctx.rowIds.map(Number).filter(Number.isFinite)
	return {
		...ui,
		messages: { ...ui.messages, following: false, pausedAtSeq: seqs.length > 0 ? Math.max(...seqs) : null },
	}
}

function resume(ui: UiState): UiState {
	return { ...ui, messages: { ...ui.messages, following: true, pausedAtSeq: null } }
}

function moveBy(ui: UiState, ctx: UiCtx, delta: number): UiState {
	const base = ui.view === "messages" && ui.messages.following ? pause(ui, ctx) : ui
	const rows = ctx.rowIds
	if (rows.length === 0) return base
	const cur = base.selected[base.view]
	const idx = cur === null ? -1 : rows.indexOf(cur)
	const next = idx < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, idx + delta))
	return select(base, rows[next] ?? null)
}

export function applyUiAction(ui: UiState, action: Action, ctx: UiCtx, now: number): UiState {
	const v = ui.view
	switch (action.type) {
		case "view":
			return { ...ui, view: action.view, help: false, notice: null }
		case "view-step": {
			const n = VIEW_ORDER.length
			const i = VIEW_ORDER.indexOf(v)
			return { ...ui, view: VIEW_ORDER[(i + action.delta + n) % n] ?? v, help: false, notice: null }
		}
		case "help-open":
			return { ...ui, help: true }
		case "help-close":
			return { ...ui, help: false }
		case "quit":
			return { ...ui, quit: true }
		case "move":
			return moveBy(ui, ctx, action.delta)
		case "page":
			return moveBy(ui, ctx, action.delta * Math.max(1, ctx.pageSize))
		case "top": {
			const base = v === "messages" && ui.messages.following ? pause(ui, ctx) : ui
			return select(base, ctx.rowIds[0] ?? null)
		}
		case "newest":
			return v === "messages"
				? { ...resume(ui), selected: { ...ui.selected, messages: null } }
				: select(ui, ctx.rowIds[ctx.rowIds.length - 1] ?? null)
		case "open": {
			const id = ui.selected[v] ?? ctx.rowIds[0] ?? null
			if (id === null) return ui
			return { ...select(ui, id), detail: { ...ui.detail, [v]: { open: true, scroll: 0 } } }
		}
		case "escape": {
			if (ui.detail[v].open) return { ...ui, detail: { ...ui.detail, [v]: { open: false, scroll: 0 } } }
			if (ui.selected[v] !== null) return select(ui, null)
			if (v === "messages" && ui.messages.filterText !== "") {
				return { ...ui, messages: { ...ui.messages, filterText: "" } }
			}
			return ui
		}
		case "detail-scroll": {
			const d = ui.detail[v]
			return { ...ui, detail: { ...ui.detail, [v]: { ...d, scroll: Math.max(0, d.scroll + action.delta * 5) } } }
		}
		case "filter-open":
			return { ...ui, messages: { ...ui.messages, draft: ui.messages.filterText } }
		case "filter-type":
			return ui.messages.draft === null ? ui : { ...ui, messages: { ...ui.messages, draft: ui.messages.draft + action.text } }
		case "filter-backspace":
			return ui.messages.draft === null
				? ui
				: { ...ui, messages: { ...ui.messages, draft: Array.from(ui.messages.draft).slice(0, -1).join("") } }
		case "filter-apply":
			return {
				...ui,
				messages: { ...ui.messages, filterText: (ui.messages.draft ?? "").trim(), draft: null },
				selected: { ...ui.selected, messages: null },
			}
		case "filter-cancel":
			return { ...ui, messages: { ...ui.messages, draft: null } }
		case "pause-toggle":
			return ui.messages.following ? pause(ui, ctx) : resume(ui)
		case "preset-cycle": {
			const i = PRESET_ORDER.indexOf(ui.messages.preset)
			return { ...ui, messages: { ...ui.messages, preset: PRESET_ORDER[(i + 1) % PRESET_ORDER.length] ?? "all" } }
		}
		case "confirm-no":
			return { ...ui, confirm: null }
		case "notice":
			return { ...ui, notice: { text: action.text, at: now } }
		default:
			return ui
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/ui-reducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/ui-reducer.ts tests/unit/cli/ui-reducer.test.ts
git commit -m "feat(cli): pure UI state reducer for selection, Esc chain, filter and pause

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 25: Message filter (B)

**Owner:** B · **Spec:** §6.3 filter grammar and presets, P10

**Files:**
- Create: `cli/source/ui/filter.ts`
- Test: `tests/unit/cli/filter.test.ts`

**Interfaces:**
- Consumes: `MessageCategory` (Task 2), `PresetName`.
- Produces:
  - `interface FilterSpec { terms: string[][]; emerg: boolean }`, `EMPTY_FILTER`, `EMERG_TOKEN = "!emerg"`
  - `parseFilter(text): FilterSpec`, `printFilter(f): string`
  - `interface FilterSubject { text: string; emergency: boolean; category: MessageCategory }`
  - `matchesFilter(f, s): boolean`, `matchesPreset(p: PresetName, c: MessageCategory): boolean`
  - `applyFilter<T>(items: readonly T[], f, preset, subject: (t: T) => FilterSubject): T[]`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/filter.test.ts`:

```ts
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { EMPTY_FILTER, applyFilter, parseFilter, printFilter, type FilterSpec, type FilterSubject } from "../../../cli/source/ui/filter.js"

const rows: FilterSubject[] = [
	{ text: "readsb ADS-B 4CA9D2 EI-DCL !7700", emergency: true, category: "aircraft" },
	{ text: "ais-catcher AIS 235012345 SEA PRINCESS", emergency: false, category: "data" },
	{ text: "multimon-ng POCSAG 1234567 FIRE ALARM", emergency: false, category: "pager" },
]

describe("filter grammar", () => {
	it("ANDs space-separated terms, ORs comma alternatives, and supports !emerg", () => {
		const f = parseFilter("readsb,ais !emerg")
		expect(f).toEqual({ terms: [["readsb", "ais"]], emerg: true })
		expect(applyFilter(rows, f, "all", r => r).map(r => r.category)).toEqual(["aircraft"])
		expect(applyFilter(rows, parseFilter("readsb,ais"), "all", r => r)).toHaveLength(2)
		expect(applyFilter(rows, parseFilter("FIRE alarm"), "all", r => r)).toHaveLength(1)
		expect(applyFilter(rows, EMPTY_FILTER, "pager", r => r)).toHaveLength(1)
	})

	const term = fc.stringMatching(/^[a-z0-9.:-]{1,8}$/)
	const arbFilter: fc.Arbitrary<FilterSpec> = fc.record({
		terms: fc.array(fc.array(term, { minLength: 1, maxLength: 3 }), { maxLength: 4 }),
		emerg: fc.boolean(),
	})
	const arbRows = fc.array(
		fc.record({ text: fc.string({ maxLength: 30 }), emergency: fc.boolean(), category: fc.constantFrom("aircraft", "voice", "pager", "data", "other") as fc.Arbitrary<FilterSubject["category"]> }),
		{ maxLength: 30 },
	)

	// Feature: cli-dashboard-overhaul, Property 10: filter
	// Validates: spec §6.3
	it("P10: order-preserving subsequence, empty identity, AND never grows, parse(print(f)) = f", () => {
		fc.assert(
			fc.property(arbRows, arbFilter, term, (items, f, extra) => {
				const out = applyFilter(items, f, "all", r => r)
				let j = 0
				for (const x of out) {
					while (j < items.length && items[j] !== x) j++
					expect(j).toBeLessThan(items.length)
					j++
				}
				expect(applyFilter(items, EMPTY_FILTER, "all", r => r)).toEqual(items)
				const more = applyFilter(items, { ...f, terms: [...f.terms, [extra]] }, "all", r => r)
				expect(more.length).toBeLessThanOrEqual(out.length)
				expect(parseFilter(printFilter(f))).toEqual(f)
			}),
			{ numRuns: 100 },
		)
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/filter.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/filter.ts`**

```ts
import type { MessageCategory } from "../data/types.js"
import type { PresetName } from "./ui-state.js"

export interface FilterSpec {
	/** AND of OR-groups. */
	terms: string[][]
	emerg: boolean
}

export const EMPTY_FILTER: FilterSpec = { terms: [], emerg: false }
export const EMERG_TOKEN = "!emerg"

export function parseFilter(text: string): FilterSpec {
	const terms: string[][] = []
	let emerg = false
	for (const tok of text.trim().split(/\s+/)) {
		if (tok === "") continue
		if (tok.toLowerCase() === EMERG_TOKEN) {
			emerg = true
			continue
		}
		const alts = tok
			.toLowerCase()
			.split(",")
			.filter(x => x !== "")
		if (alts.length > 0) terms.push(alts)
	}
	return { terms, emerg }
}

export function printFilter(f: FilterSpec): string {
	return [...f.terms.map(t => t.join(",")), ...(f.emerg ? [EMERG_TOKEN] : [])].join(" ")
}

export interface FilterSubject {
	text: string
	emergency: boolean
	category: MessageCategory
}

export function matchesFilter(f: FilterSpec, s: FilterSubject): boolean {
	if (f.emerg && !s.emergency) return false
	const t = s.text.toLowerCase()
	return f.terms.every(alts => alts.some(a => t.includes(a)))
}

export function matchesPreset(p: PresetName, c: MessageCategory): boolean {
	if (p === "all") return true
	if (p === "data") return c === "data" || c === "other"
	return p === c
}

export function applyFilter<T>(
	items: readonly T[],
	f: FilterSpec,
	preset: PresetName,
	subject: (t: T) => FilterSubject,
): T[] {
	return items.filter(x => {
		const s = subject(x)
		return matchesPreset(preset, s.category) && matchesFilter(f, s)
	})
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/filter.ts tests/unit/cli/filter.test.ts
git commit -m "feat(cli): message filter grammar (space AND, comma OR, !emerg) and presets

Property 10 (spec §6.3).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 26: Per-protocol message formatters (B, after Task 6)

**Owner:** B · **Spec:** §10.8 (summary at ingest), §11 (`ui/messages/`), §6.3 message rows and detail; ported from `cli/source/components/decoded-message.tsx` · **Starts after** Task 6 (A), which provides `isObj`, `isStr`, `isNum` and `Obj` in `cli/source/data/guards.ts`, is merged.

**Files:**
- Create: `cli/source/ui/messages/common.ts`
- Create: `cli/source/ui/messages/aircraft.ts`
- Create: `cli/source/ui/messages/call.ts`
- Create: `cli/source/ui/messages/pager.ts`
- Create: `cli/source/ui/messages/mesh.ts`
- Create: `cli/source/ui/messages/acars.ts`
- Create: `cli/source/ui/messages/ais.ts`
- Create: `cli/source/ui/messages/rtl433.ts`
- Create: `cli/source/ui/messages/generic.ts`
- Create: `cli/source/ui/messages/index.ts`
- Test: `tests/unit/cli/messages-format.test.ts`

**Interfaces:**
- Consumes: `isObj`, `isStr`, `isNum`, `Obj` from `data/guards.ts` (Task 6, A). `FormattedMessage`, `MessageSegment`, `MessageCategory`, `AircraftLookup` (Task 2). `sanitize` (Task 3). `formatCount` (Task 17). `glyphs()`.
- Produces:
  - `formatMessage(output: DecoderOutput, decoderId: string, lookup?: AircraftLookup): FormattedMessage`. Its signature equals `ReduceDeps["summarize"]`.
  - `detailJson(data: unknown, maxLines?: number, maxChars?: number): string[]`
  - `EMERGENCY_SQUAWKS`, `MAX_TEXT = 2000`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/messages-format.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "@wavekit/api-types"
import { detailJson, formatMessage } from "../../../cli/source/ui/messages/index.js"

const out = (type: string, decoder: string, data: unknown): DecoderOutput => ({ type, decoder, timestamp: "2026-10-08T18:07:41.000Z", data })
const segs = (m: ReturnType<typeof formatMessage>) => m.segments.map(s => s.text)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

describe("formatMessage", () => {
	it("formats DMR call ends like the spec row", () => {
		const m = formatMessage(out("call_end", "dsd-fme", { protocol: "dmr", talkgroup: 2350, source: 2341234, slot: 1, duration: 8400, dmr: { cc: 1 }, quality: { crcErrs: 4, fecErrs: 3 }, flags: { encrypted: true } }), "dsd-fme")
		expect(m.protocol).toBe("DMR")
		expect(m.category).toBe("voice")
		expect(segs(m)).toEqual(["TG 2350", "SRC 2341234", "slot 1", "CC 1", "8.4 s", "quality 65%", "7 err", "encrypted"])
	})
	it("formats pager messages with free text", () => {
		const m = formatMessage(out("pocsag", "multimon-ng", { protocol: "POCSAG1200", address: 1234567, function: 3, messageType: "Alpha", message: "FIRE ALARM ACTIVATION" }), "multimon-ng")
		expect(m.protocol).toBe("POCSAG")
		expect(segs(m)).toEqual(["1234567", "fn 3"])
		expect(m.text).toBe("FIRE ALARM ACTIVATION")
		const n = formatMessage(out("pocsag", "multimon-ng", { address: 7654321, function: 0, messageType: "Numeric", message: "0207 555 0101" }), "multimon-ng")
		expect(segs(n)).toEqual(["7654321", "fn 0", "numeric"])
		const flex = formatMessage(out("flex", "multimon-ng", { protocol: "FLEX", capcode: "1-2345678", messageType: "ALN", message: "TEST PAGE 03:58" }), "multimon-ng")
		expect(flex.protocol).toBe("FLEX")
		expect(segs(flex)).toEqual(["1-2345678", "ALN"])
	})
	it("formats aircraft with emergency squawks and enrichment from the aircraft map", () => {
		const m = formatMessage(out("aircraft", "readsb", { hex: "4ca9d2", flight: "RYR4KT ", alt_baro: 37000, baro_rate: -1216, gs: 451.2, track: 134.1, lat: 51.4712, lon: -0.4521, squawk: "7700", rssi: -12.3, seen: 0.4, messages: 1204 }), "readsb", icao =>
			icao === "4CA9D2" ? { icao, seen: 0, messages: 0, firstSeen: 0, lastUpdated: 0, identification: { registration: "EI-DCL", typeCode: "B738" } } : undefined,
		)
		expect(m.protocol).toBe("ADS-B")
		expect(m.emergency).toBe(true)
		expect(segs(m)).toEqual(["4CA9D2", "EI-DCL", "RYR4KT", "B738", "FL370 ↓", "451 kt", "51.47,-0.45", "SE", "!7700"])
		expect(m.fields.find(f => f.label === "messages")?.value).toBe("1 204")
	})
	it("formats AIS, rtl_433, Meshtastic and ACARS", () => {
		expect(segs(formatMessage(out("ais", "ais-catcher", { mmsi: 235012345, shipname: "SEA PRINCESS", shiptype_text: "passenger", lat: 51.5, lon: -0.12, speed: 12.1 }), "ais-catcher"))).toEqual(["235012345", "SEA PRINCESS", "passenger", "51.50,-0.12", "12.1 kn"])
		expect(segs(formatMessage(out("data", "rtl433", { model: "Acurite-Tower", id: 1234, temperature_C: 21.25, humidity: 40, battery_ok: 0 }), "rtl433"))).toEqual(["Acurite-Tower", "#1234", "21.3°C", "40%", "battery low"])
		const mesh = formatMessage(out("meshtastic", "lora-meshtastic", { from: 0x11223344, to: 0xffffffff, id: 1, channel: 0, hopLimit: 2, hopStart: 3, wantAck: false, portnum: 1, payloadB64: Buffer.from("hello").toString("base64"), payloadLen: 5, rxRssi: -90, rxSnr: 7.25, rxTime: "t", frequency: 869525000, bw: 250, sf: 11, cr: 5 }), "lora-meshtastic")
		expect(segs(mesh)).toEqual(["!11223344→BCAST", "TEXT", "-90 dBm", "SNR 7.3", "1/3 hops"])
		expect(mesh.text).toBe("hello")
		const acars = formatMessage(out("acars", "acarsdec", { tail: ".EI-DCL", flight: "RYR4KT", label: "H1", text: "REQUEST WX", freq: 131.55 }), "acarsdec")
		expect(acars.protocol).toBe("ACARS")
		expect(segs(acars)).toEqual([".EI-DCL", "RYR4KT", "H1", "131.550 MHz"])
	})
	it("bounds and sanitises hostile payloads (review focus 4)", () => {
		const huge = "A".repeat(100_000) + "\x1b[2J\r\n🚀"
		const m = formatMessage(out("pocsag", "multimon-ng", { address: 1, message: huge }), "multimon-ng")
		expect(m.text?.length).toBeLessThanOrEqual(2000)
		expect(CONTROL.test(m.text ?? "")).toBe(false)
		expect(m.searchText.length).toBeLessThanOrEqual(4000)
		let deep: unknown = "x"
		for (let i = 0; i < 2000; i++) deep = { a: deep }
		const g = formatMessage(out("weird", "x", deep), "x")
		expect(CONTROL.test(g.text ?? "")).toBe(false)
		const lines = detailJson({ s: huge, deep })
		expect(lines.length).toBeLessThanOrEqual(201)
		for (const l of lines) expect(CONTROL.test(l)).toBe(false)
	})
	it("falls back to compact JSON for unknown shapes", () => {
		const m = formatMessage(out("sync", "dsd-fme", { mode: "DMR" }), "dsd-fme")
		expect(segs(m)).toEqual(["sync DMR"])
		expect(formatMessage(out("x", "y", { k: 1 }), "y").text).toBe('{"k":1}')
	})
})
```

- [ ] **Step 2: Run the test and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/messages-format.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/messages/common.ts`**

```ts
import { isNum, isObj, isStr, type Obj } from "../../data/guards.js"
import type { FormattedMessage, MessageCategory, MessageSegment } from "../../data/types.js"
import { sanitize } from "../text.js"

export const MAX_TEXT = 2000
export const MAX_SEARCH = 4000

/** Sanitise and bound a payload string (slice first so a 100 KB string costs little). */
export function clip(s: string, max = MAX_TEXT): string {
	const t = sanitize(s.length > max * 2 ? s.slice(0, max * 2) : s)
	return t.length > max ? t.slice(0, max) : t
}

export function seg(text: string, priority: number, role?: MessageSegment["role"]): MessageSegment {
	return role ? { text: clip(text, 200), priority, role } : { text: clip(text, 200), priority }
}

export function obj(o: Obj, key: string): Obj {
	const v = o[key]
	return isObj(v) ? v : {}
}

export function str(o: Obj, key: string): string | undefined {
	const v = o[key]
	return isStr(v) ? v : undefined
}

export function num(o: Obj, key: string): number | undefined {
	const v = o[key]
	return isNum(v) ? v : undefined
}

export function asObj(data: unknown): Obj {
	return isObj(data) ? data : {}
}

export function finish(
	decoderId: string,
	type: string,
	protocol: string,
	category: MessageCategory,
	segments: MessageSegment[],
	fields: FormattedMessage["fields"],
	extra: { text?: string; emergency?: boolean } = {},
): FormattedMessage {
	const text = extra.text !== undefined ? clip(extra.text) : undefined
	const search = [decoderId, protocol, type, ...segments.map(s => s.text), text ?? ""].join(" ").toLowerCase()
	return {
		protocol: clip(protocol, 8),
		category,
		segments,
		fields: fields.map(f => ({ ...f, value: clip(f.value, 400) })),
		emergency: extra.emergency ?? false,
		searchText: clip(search, MAX_SEARCH),
		...(text !== undefined && text !== "" ? { text } : {}),
	}
}
```

- [ ] **Step 4: Write `cli/source/ui/messages/aircraft.ts`**

```ts
import type { AircraftLookup, FormattedMessage } from "../../data/types.js"
import { formatCount, formatSpaced } from "../format.js"
import { glyphs } from "../theme.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

export const EMERGENCY_SQUAWKS: readonly string[] = ["7500", "7600", "7700"]
const DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const

export function isAircraftShape(data: unknown): boolean {
	const o = asObj(data)
	return str(o, "hex") !== undefined || str(o, "icao") !== undefined
}

export function formatAircraft(data: unknown, decoderId: string, type: string, lookup: AircraftLookup): FormattedMessage {
	const o = asObj(data)
	const icao = (str(o, "icao") ?? str(o, "hex") ?? "?").toUpperCase()
	const known = lookup(icao)
	const ident = obj(o, "identification")
	const reg = str(ident, "registration") ?? str(o, "registration") ?? str(o, "r") ?? known?.identification?.registration
	const typeCode = str(ident, "typeCode") ?? str(o, "typeCode") ?? str(o, "t") ?? known?.identification?.typeCode
	const flight = (str(o, "callsign") ?? str(o, "flight"))?.trim()
	const squawk = str(o, "squawk")
	const alt = obj(o, "altitude")
	const onGround = o["onGround"] === true || o["alt_baro"] === "ground" || alt["onGround"] === true
	const altFt = num(o, "alt_baro") ?? num(o, "altitude") ?? num(alt, "baro")
	const rate = num(o, "baro_rate") ?? num(o, "verticalRate") ?? num(alt, "baroRate")
	const vel = obj(o, "velocity")
	const gs = num(vel, "gs") ?? num(o, "gs") ?? num(o, "groundSpeed")
	const track = num(vel, "track") ?? num(o, "track")
	const pos = obj(o, "position")
	const lat = num(pos, "lat") ?? num(o, "lat")
	const lon = num(pos, "lon") ?? num(o, "lon")
	const rssi = num(obj(o, "signalQuality"), "rssi") ?? num(o, "rssi")
	const seen = num(o, "seen")
	const messages = num(o, "messages") ?? num(o, "messageCount")
	const emergencyField = str(o, "emergency")
	const emergency = (squawk !== undefined && EMERGENCY_SQUAWKS.includes(squawk)) || (emergencyField !== undefined && emergencyField !== "none")
	const g = glyphs()
	const trend = rate === undefined ? "" : rate > 300 ? ` ${g.up}` : rate < -300 ? ` ${g.down}` : ""
	const altText = onGround ? "GND" : altFt === undefined ? undefined : `FL${Math.round(altFt / 100)}${trend}`
	const dir = track === undefined ? undefined : DIRS[Math.round(track / 45) % 8]
	const segments = [
		seg(icao, 0),
		...(reg ? [seg(reg, 2)] : []),
		...(flight ? [seg(flight, 1)] : []),
		...(typeCode ? [seg(typeCode, 3)] : []),
		...(altText ? [seg(altText, 1)] : []),
		...(gs !== undefined ? [seg(`${Math.round(gs)} kt`, 4)] : []),
		...(lat !== undefined && lon !== undefined ? [seg(`${lat.toFixed(2)},${lon.toFixed(2)}`, 5)] : []),
		...(dir ? [seg(dir, 6)] : []),
		...(emergency && squawk ? [seg(`${g.attention}${squawk}`, 0, "attention")] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "icao", value: icao },
		...(reg ? [{ label: "reg", value: reg }] : []),
		...(flight ? [{ label: "flight", value: flight }] : []),
		...(typeCode ? [{ label: "type", value: typeCode }] : []),
		...(squawk ? [{ label: "squawk", value: emergency ? `${g.attention}${squawk} emergency` : squawk, attention: emergency }] : []),
		...(altText
			? [{ label: "alt", value: onGround ? "GND" : `${formatSpaced(altFt)} ft${trend}${rate !== undefined && trend ? ` ${formatSpaced(Math.abs(rate))} ft/min` : ""}` }]
			: []),
		...(gs !== undefined ? [{ label: "speed", value: `${Math.round(gs)} kt` }] : []),
		...(track !== undefined ? [{ label: "track", value: `${Math.round(track)}° ${dir ?? ""}`.trim() }] : []),
		...(lat !== undefined && lon !== undefined ? [{ label: "position", value: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }] : []),
		...(rssi !== undefined ? [{ label: "rssi", value: `${rssi.toFixed(1)} dBm` }] : []),
		...(seen !== undefined ? [{ label: "seen", value: `${seen.toFixed(1)}s ago` }] : []),
		...(messages !== undefined ? [{ label: "messages", value: formatCount(messages) }] : []),
	]
	return finish(decoderId, type, "ADS-B", "aircraft", segments, fields, { emergency })
}
```

- [ ] **Step 5: Write `cli/source/ui/messages/call.ts`**

```ts
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

/** Ported heuristic from decoded-message.tsx: 5 % per CRC/FEC error. */
function qualityPercent(errors: number): number {
	return Math.max(0, 100 - Math.min(errors * 5, 100))
}

export function formatCall(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const protocol = (str(o, "protocol") ?? "voice").toUpperCase()
	const tg = num(o, "talkgroup")
	const src = num(o, "source")
	const slot = num(o, "slot")
	const duration = num(o, "duration")
	const cc = num(obj(o, "dmr"), "cc")
	const nac = str(obj(o, "p25"), "nac")
	const ran = num(obj(o, "nxdn"), "ran")
	const my = str(obj(o, "dstar"), "my")?.trim()
	const q = o["quality"]
	const quality = obj(o, "quality")
	const errors = (num(quality, "crcErrs") ?? 0) + (num(quality, "fecErrs") ?? 0)
	const flags = obj(o, "flags")
	const isEnd = type === "call_end"
	const segments = [
		...(tg !== undefined && tg !== 0 ? [seg(`TG ${tg}`, 0)] : []),
		...(src !== undefined && src !== 0 ? [seg(`SRC ${src}`, 1)] : []),
		...(slot !== undefined ? [seg(`slot ${slot}`, 4)] : []),
		...(cc !== undefined ? [seg(`CC ${cc}`, 5)] : []),
		...(nac ? [seg(`NAC ${nac}`, 5)] : []),
		...(ran !== undefined ? [seg(`RAN ${ran}`, 5)] : []),
		...(my ? [seg(`MY ${my}`, 3)] : []),
		...(!isEnd ? [seg("call start", 2)] : []),
		...(duration !== undefined ? [seg(`${(duration / 1000).toFixed(1)} s`, 2)] : []),
		...(isEnd && q !== undefined ? [seg(`quality ${qualityPercent(errors)}%`, 3)] : []),
		...(errors > 0 ? [seg(`${errors} err`, 3)] : []),
		...(flags["encrypted"] === true ? [seg("encrypted", 1)] : []),
		...(flags["badSignal"] === true ? [seg("bad signal", 3)] : []),
		...(flags["timeout"] === true ? [seg("timeout", 4)] : []),
	]
	const wav = str(o, "wavFile")
	const fields: FormattedMessage["fields"] = [
		...(tg !== undefined ? [{ label: "talkgroup", value: String(tg) }] : []),
		...(src !== undefined ? [{ label: "source", value: String(src) }] : []),
		...(slot !== undefined ? [{ label: "slot", value: String(slot) }] : []),
		...(cc !== undefined ? [{ label: "colour code", value: String(cc) }] : []),
		...(duration !== undefined ? [{ label: "duration", value: `${(duration / 1000).toFixed(1)} s` }] : []),
		...(q !== undefined ? [{ label: "errors", value: `${errors} (crc ${num(quality, "crcErrs") ?? "?"}, fec ${num(quality, "fecErrs") ?? "?"})` }] : []),
		...(wav ? [{ label: "wav", value: wav.split("/").pop() ?? wav }] : []),
	]
	return finish(decoderId, type, protocol, "voice", segments, fields)
}
```

- [ ] **Step 6: Write `cli/source/ui/messages/pager.ts`**

```ts
import { isNum, isStr } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, seg, str } from "./common.js"

export function formatPager(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const proto = str(o, "protocol") ?? ""
	const protocol = type === "flex" || /flex/i.test(proto) ? "FLEX" : "POCSAG"
	const rawAddress = str(o, "capcode") ?? o["address"]
	const address = isStr(rawAddress) || isNum(rawAddress) ? String(rawAddress) : undefined
	const fn = o["function"]
	const fnText = isStr(fn) || isNum(fn) ? String(fn) : undefined
	const mtype = str(o, "messageType")
	const typeLabel = mtype === undefined || /^alpha$/i.test(mtype) ? undefined : /^numeric$/i.test(mtype) ? "numeric" : mtype
	const segments = [
		...(address ? [seg(address, 0)] : []),
		...(fnText !== undefined ? [seg(`fn ${fnText}`, 2)] : []),
		...(typeLabel ? [seg(typeLabel, 3)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		...(address ? [{ label: "address", value: address }] : []),
		...(fnText !== undefined ? [{ label: "function", value: fnText }] : []),
		...(mtype ? [{ label: "type", value: mtype }] : []),
	]
	const message = str(o, "message")
	return finish(decoderId, type, protocol, "pager", segments, fields, message !== undefined ? { text: message } : {})
}
```

- [ ] **Step 7: Write `cli/source/ui/messages/mesh.ts`**

```ts
import type { FormattedMessage } from "../../data/types.js"
import { asObj, clip, finish, num, seg, str } from "./common.js"

const BROADCAST = 0xffffffff
const PORTS: Readonly<Record<number, string>> = {
	0: "UNKNOWN", 1: "TEXT", 2: "REMOTE_HW", 3: "POS", 4: "NODE", 5: "ROUTING", 6: "ADMIN", 7: "TEXT_GZIP", 8: "WAYPOINT",
	9: "AUDIO", 10: "DETECT", 32: "REPLY", 33: "IP_TUN", 34: "PAXCNTR", 64: "SERIAL", 65: "STORE_FWD", 66: "RANGE_TEST",
	67: "TELEM", 68: "ZPS", 69: "SIM", 70: "TRACE", 71: "NEIGHBOR", 72: "ATAK", 73: "MAP", 74: "PWRSTRESS", 257: "PRIVATE", 258: "ATAK_FWD",
}

const nodeId = (n: number): string => (n === BROADCAST ? "BCAST" : `!${(n >>> 0).toString(16).padStart(8, "0")}`)

export function isMeshShape(data: unknown): boolean {
	const o = asObj(data)
	return num(o, "from") !== undefined && num(o, "to") !== undefined && num(o, "portnum") !== undefined && str(o, "payloadB64") !== undefined
}

export function formatMesh(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const from = num(o, "from") ?? 0
	const to = num(o, "to") ?? 0
	const port = num(o, "portnum") ?? 0
	const len = num(o, "payloadLen")
	const rssi = num(o, "rxRssi")
	const snr = num(o, "rxSnr")
	const hopStart = num(o, "hopStart")
	const hopLimit = num(o, "hopLimit")
	let text: string | undefined
	if (port === 1) {
		try {
			text = clip(Buffer.from(str(o, "payloadB64") ?? "", "base64").toString("utf8")).trim()
		} catch {
			text = undefined
		}
	}
	const segments = [
		seg(`${nodeId(from)}→${nodeId(to)}`, 0),
		seg(PORTS[port] ?? `PORT${port}`, 1),
		...(text === undefined && len !== undefined ? [seg(`${len} B`, 2)] : []),
		...(rssi !== undefined ? [seg(`${rssi} dBm`, 3)] : []),
		...(snr !== undefined ? [seg(`SNR ${snr.toFixed(1)}`, 3)] : []),
		...(hopStart !== undefined && hopLimit !== undefined ? [seg(`${Math.max(0, hopStart - hopLimit)}/${hopStart} hops`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "from", value: nodeId(from) },
		{ label: "to", value: nodeId(to) },
		{ label: "port", value: PORTS[port] ?? `PORT${port}` },
		...(num(o, "frequency") !== undefined ? [{ label: "frequency", value: `${((num(o, "frequency") ?? 0) / 1e6).toFixed(3)} MHz` }] : []),
	]
	return finish(decoderId, type, "MESH", "data", segments, fields, text ? { text } : {})
}
```

- [ ] **Step 8: Write `cli/source/ui/messages/acars.ts`**

```ts
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, obj, seg, str } from "./common.js"

export function formatAcars(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const vdl = obj(obj(obj(o, "vdl2"), "avlc"), "acars")
	const a = Object.keys(vdl).length > 0 ? vdl : o
	const protocol = type === "vdl2" || decoderId === "dumpvdl2" ? "VDL2" : "ACARS"
	const reg = str(a, "tail") ?? str(a, "reg")
	const flight = str(a, "flight")?.trim()
	const label = str(a, "label")
	const freq = num(o, "freq")
	const text = str(a, "text") ?? str(a, "msg_text")
	const segments = [
		...(reg ? [seg(reg, 0)] : []),
		...(flight ? [seg(flight, 1)] : []),
		...(label ? [seg(label, 2)] : []),
		...(freq !== undefined ? [seg(`${freq.toFixed(3)} MHz`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		...(reg ? [{ label: "reg", value: reg }] : []),
		...(flight ? [{ label: "flight", value: flight }] : []),
		...(label ? [{ label: "label", value: label }] : []),
	]
	return finish(decoderId, type, protocol, "aircraft", segments, fields, text !== undefined ? { text } : {})
}
```

- [ ] **Step 9: Write `cli/source/ui/messages/ais.ts` and `rtl433.ts`**

`cli/source/ui/messages/ais.ts`:

```ts
import { isNum, isStr } from "../../data/guards.js"
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, seg, str } from "./common.js"

export function isAisShape(data: unknown): boolean {
	const m = asObj(data)["mmsi"]
	return isNum(m) || isStr(m)
}

export function formatAis(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const mmsi = String(o["mmsi"] ?? "?")
	const name = str(o, "shipname")?.trim()
	const kind = str(o, "shiptype_text") ?? (isStr(o["type"]) ? o["type"] : undefined)
	const lat = num(o, "lat")
	const lon = num(o, "lon")
	const speed = num(o, "speed")
	const segments = [
		seg(mmsi, 0),
		...(name ? [seg(name, 1)] : []),
		...(kind ? [seg(kind, 3)] : []),
		...(lat !== undefined && lon !== undefined ? [seg(`${lat.toFixed(2)},${lon.toFixed(2)}`, 2)] : []),
		...(speed !== undefined ? [seg(`${speed.toFixed(1)} kn`, 4)] : []),
	]
	const fields: FormattedMessage["fields"] = [
		{ label: "mmsi", value: mmsi },
		...(name ? [{ label: "name", value: name }] : []),
		...(kind ? [{ label: "type", value: kind }] : []),
		...(lat !== undefined && lon !== undefined ? [{ label: "position", value: `${lat.toFixed(4)}, ${lon.toFixed(4)}` }] : []),
	]
	return finish(decoderId, type, "AIS", "data", segments, fields)
}
```

`cli/source/ui/messages/rtl433.ts`:

```ts
import type { FormattedMessage } from "../../data/types.js"
import { asObj, finish, num, seg, str } from "./common.js"

export function isRtl433Shape(data: unknown): boolean {
	return str(asObj(data), "model") !== undefined
}

export function formatRtl433(data: unknown, decoderId: string, type: string): FormattedMessage {
	const o = asObj(data)
	const model = str(o, "model") ?? "?"
	const id = o["id"]
	const temp = num(o, "temperature_C")
	const hum = num(o, "humidity")
	const battery = num(o, "battery_ok")
	const segments = [
		seg(model, 0),
		...(id !== undefined && id !== null ? [seg(`#${String(id)}`, 1)] : []),
		...(temp !== undefined ? [seg(`${temp.toFixed(1)}°C`, 2)] : []),
		...(hum !== undefined ? [seg(`${hum}%`, 3)] : []),
		...(battery === 0 ? [seg("battery low", 4)] : []),
	]
	return finish(decoderId, type, "433", "data", segments, [{ label: "model", value: model }])
}
```

- [ ] **Step 10: Write `cli/source/ui/messages/generic.ts` and `index.ts`**

`cli/source/ui/messages/generic.ts`:

```ts
import type { DecoderOutput } from "@wavekit/api-types"
import type { FormattedMessage } from "../../data/types.js"
import { sanitize } from "../text.js"
import { asObj, finish, seg, str } from "./common.js"

function compactJson(data: unknown): string {
	try {
		return JSON.stringify(data) ?? String(data)
	} catch {
		return "[unprintable]"
	}
}

export function formatGeneric(output: DecoderOutput, decoderId: string): FormattedMessage {
	const data = output.data
	const o = asObj(data)
	const type = output.type
	if (type === "sync" && str(o, "mode")) {
		return finish(decoderId, type, "SYNC", "voice", [seg(`sync ${str(o, "mode") ?? ""}`, 0)], [])
	}
	const text = typeof data === "string" ? data : (str(o, "message") ?? compactJson(data))
	return finish(decoderId, type, type.toUpperCase().slice(0, 6), "other", [], [], { text })
}

/** Pretty JSON for the detail pane: bounded in characters and lines, every line sanitised. */
export function detailJson(data: unknown, maxLines = 200, maxChars = 20_000): string[] {
	let s: string
	try {
		s = JSON.stringify(data, null, 2) ?? String(data)
	} catch {
		s = "[unprintable]"
	}
	const truncated = s.length > maxChars
	const lines = (truncated ? s.slice(0, maxChars) : s).split("\n").map(l => sanitize(l))
	if (lines.length > maxLines) return [...lines.slice(0, maxLines), "…"]
	return truncated ? [...lines, "…"] : lines
}
```

`cli/source/ui/messages/index.ts`:

```ts
import type { DecoderOutput } from "@wavekit/api-types"
import type { AircraftLookup, FormattedMessage } from "../../data/types.js"
import { formatAcars } from "./acars.js"
import { formatAircraft, isAircraftShape } from "./aircraft.js"
import { formatAis, isAisShape } from "./ais.js"
import { formatCall } from "./call.js"
import { formatGeneric } from "./generic.js"
import { formatMesh, isMeshShape } from "./mesh.js"
import { formatPager } from "./pager.js"
import { formatRtl433, isRtl433Shape } from "./rtl433.js"

export { detailJson } from "./generic.js"
export { EMERGENCY_SQUAWKS } from "./aircraft.js"
export { MAX_TEXT } from "./common.js"

const NONE: AircraftLookup = () => undefined

/** Matches ReduceDeps["summarize"]: computed once at ingest (spec §10.8). */
export function formatMessage(output: DecoderOutput, decoderId: string, lookup: AircraftLookup = NONE): FormattedMessage {
	const t = output.type.toLowerCase()
	const d = output.data
	if (t === "aircraft" || (decoderId === "readsb" && isAircraftShape(d))) return formatAircraft(d, decoderId, t, lookup)
	if (t === "call_start" || t === "call_end") return formatCall(d, decoderId, t)
	if (t === "pocsag" || t === "flex") return formatPager(d, decoderId, t)
	if (t === "meshtastic" && isMeshShape(d)) return formatMesh(d, decoderId, t)
	if (t === "acars" || t === "vdl2") return formatAcars(d, decoderId, t)
	if (t === "ais" || t === "ship" || isAisShape(d)) return formatAis(d, decoderId, t)
	if (isRtl433Shape(d)) return formatRtl433(d, decoderId, t)
	if (isAircraftShape(d)) return formatAircraft(d, decoderId, t, lookup)
	return formatGeneric(output, decoderId)
}
```

- [ ] **Step 11: Run the tests and the root typecheck**

```bash
pnpm exec vitest run tests/unit/cli/messages-format.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: PASS and exit 0. In the aircraft example, the 51.4712/−0.4521 position rounds to `51.47,-0.45`, and track 134.1° rounds to bucket 3 (`SE`).

- [ ] **Step 12: Commit**

```bash
git add cli/source/ui/messages tests/unit/cli/messages-format.test.ts
git commit -m "feat(cli): pure per-protocol message formatters ported from decoded-message

Aircraft, DMR/P25 calls, pager, Meshtastic, ACARS/VDL2, AIS, rtl_433 and a
bounded generic fallback; payloads are clipped and sanitised.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 27: Line renderer component (B)

**Owner:** B · **Spec:** §11 (components render spans), §8 roles

**Files:**
- Create: `cli/source/components/lines.tsx`
- Test: `cli/source/components/lines.test.tsx`

**Interfaces:**
- Consumes: `Line`, `roleProps`.
- Produces:
  - `ColorContext: React.Context<boolean>`, default `true`
  - `LineView(props: { line: Line; indent?: number }): ReactElement`, with a default indent of 1
  - `Lines(props: { lines: readonly Line[]; width: number; height?: number; indent?: number }): ReactElement`. An empty line renders as one blank row.

- [ ] **Step 1: Write the failing render test**

`cli/source/components/lines.test.tsx`:

```tsx
import { describe, expect, it } from "vitest"
import { renderAt } from "../test/harness.js"
import { ColorContext, Lines } from "./lines.js"

describe("Lines", () => {
	it("renders one row per line with a 1-column gutter, keeping empty rows", async () => {
		const lines = [[{ text: "api ", role: "label" as const }, { text: "● 2s", role: "live" as const }], [], [{ text: "x", role: "value" as const }]]
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<Lines lines={lines} width={20} />
			</ColorContext.Provider>,
			{ cols: 20, rows: 10 },
		)
		expect(h.frame()).toEqual([" api ● 2s", "", " x"])
		h.unmount()
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @wavekit/cli test`
Expected: FAIL, `./lines.js` not found.

- [ ] **Step 3: Write `cli/source/components/lines.tsx`**

```tsx
import { Box, Text } from "ink"
import { createContext, useContext, type ReactElement } from "react"
import type { Line } from "../ui/line.js"
import { roleProps } from "../ui/theme.js"

export const ColorContext = createContext(true)

export function LineView({ line, indent = 1 }: { line: Line; indent?: number }): ReactElement {
	const color = useContext(ColorContext)
	if (line.length === 0) return <Text> </Text>
	return (
		<Text wrap="truncate-end">
			{" ".repeat(indent)}
			{line.map((s, i) => (
				<Text key={i} {...roleProps(s.role, color, s.bold === true)}>
					{s.text}
				</Text>
			))}
		</Text>
	)
}

export function Lines({
	lines,
	width,
	height,
	indent = 1,
}: {
	lines: readonly Line[]
	width: number
	height?: number
	indent?: number
}): ReactElement {
	return (
		<Box flexDirection="column" width={width} {...(height !== undefined ? { height } : {})} overflow="hidden">
			{lines.map((l, i) => (
				<LineView key={i} line={l} indent={indent} />
			))}
		</Box>
	)
}
```

- [ ] **Step 4: Run the CLI tests**

Run: `pnpm --filter @wavekit/cli test`
Expected: PASS. Ink trims trailing spaces from the blank row, so the middle row reads `""`.

- [ ] **Step 5: Run the phase-1 B slice gates**

```bash
pnpm exec vitest run tests/unit/cli
pnpm exec tsc --noEmit -p tsconfig.json
pnpm --filter @wavekit/cli typecheck
pnpm run lint
```
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add cli/source/components/lines.tsx cli/source/components/lines.test.tsx
git commit -m "feat(cli): span Line renderer with role → Ink props and NO_COLOR context

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 28: Sanitised scenarios and the scenario loader (C)

**Owner:** C · **Spec:** §13.2 scenario list, §13.3 sanitised JSON, audit fixture state (spec header)

**Files:**
- Create: `cli/tools/mock-api/scenarios/live.json`
- Create: `cli/tools/mock-api/scenarios/{idle,api-down,api-down-cached,ws-only,rest-only,dropping,crash-loop,legacy,long-text,burst}.json`
- Create: `cli/source/test/scenarios.ts`
- Test: `tests/unit/cli/scenarios.test.ts`

**Interfaces:**
- Consumes: `Scenario`, `ScenarioName`, `SCENARIO_NAMES` (Task 2).
- Produces:
  - `SCENARIO_DIR: string`
  - `DELETE = "$delete"`, the sentinel that removes a key during a merge
  - `deepMerge(base: unknown, patch: unknown): unknown`. Objects merge, arrays and primitives replace, and `"$delete"` removes the key.
  - `mergeById(body: unknown, merge: Record<string, unknown>): unknown`. Array items are matched by `id`, else by `sourceId`.
  - `loadScenario(name: ScenarioName): Scenario`. The result is fully resolved: `extends`, `restPatch`, `transform` and `wsAppend` are applied and then removed.

**Source note.** The raw audit captures are not in the repository. The JSON below is hand-authored from the spec's fixture state and mockups. If a raw capture is used to refresh a scenario, it must be sanitised to `192.0.2.x`/`127.0.0.1` before commit.

- [ ] **Step 1: Write the failing test**

`tests/unit/cli/scenarios.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { SCENARIO_DIR, deepMerge, loadScenario, mergeById } from "../../../cli/source/test/scenarios.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"

describe("scenario loader", () => {
	it("loads and resolves every scenario", () => {
		for (const name of SCENARIO_NAMES) {
			const sc = loadScenario(name)
			expect(sc.name).toBe(name)
			expect(sc.extends).toBeUndefined()
			expect(sc.restPatch).toBeUndefined()
			expect(Array.isArray(sc.ws)).toBe(true)
		}
	})
	it("merges objects, replaces arrays and honours $delete", () => {
		expect(deepMerge({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 9, d: "$delete" }, e: [2] })).toEqual({ a: 1, b: { c: 9 }, e: [2] })
		expect(mergeById([{ id: "x", v: 1 }, { sourceId: "y", v: 1 }], { y: { v: 2 } })).toEqual([{ id: "x", v: 1 }, { sourceId: "y", v: 2 }])
	})
	it("applies transforms", () => {
		const legacy = loadScenario("legacy")
		const sources = legacy.rest["/api/sources"]?.body as Array<Record<string, unknown>>
		expect(sources[0]?.["activity"]).toBeUndefined()
		expect(JSON.stringify(legacy)).not.toContain("totalBytesWritten")
		expect(loadScenario("idle").ws.some(f => f.type === "decoder:output")).toBe(false)
	})
	it("contains only documentation or loopback addresses and no credentials", () => {
		for (const file of readdirSync(SCENARIO_DIR)) {
			const text = readFileSync(join(SCENARIO_DIR, file), "utf8")
			for (const ip of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
				expect(ip.startsWith("192.0.2.") || ip === "127.0.0.1" || ip === "0.0.0.0", `${file}: ${ip}`).toBe(true)
			}
			expect(text).not.toMatch(/password|secret|token|apikey|\.local\b|\.lan\b/i)
		}
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/scenarios.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/tools/mock-api/scenarios/live.json`**

This is the audit fixture state: `pi-iq` streaming at 2.048 MS/s around 445.9707 MHz, acarsdec down after 13 restarts, 4 decoder branches in backpressure. The per-branch drop-now values are 12/14/15/38/31/40/11/9 %, which aggregate to 21.25 %. Write it compactly, then format it in Step 6.

```json
{
	"name": "live",
	"description": "Audit fixture: pi-iq streaming 2.048 MS/s at 445.9707 MHz, acarsdec down (13 restarts), 4 branches in backpressure, 7 cached messages.",
	"now": "2026-10-08T18:07:52.000Z",
	"conn": { "rest": "ok", "ws": "open", "cached": true, "restAgoMs": 2000 },
	"rest": {
		"/health": { "status": 200, "body": { "status": "ok", "timestamp": "2026-10-08T18:07:52.000Z" } },
		"/api/decoders": { "status": 200, "body": [
			{ "id": "dsd-fme", "type": "dsd-fme", "running": true, "health": "running", "pid": 1490, "uptime": 52, "stats": { "bytesIn": 831500000, "eventsOut": 3, "errors": 0 }, "lastOutputAt": "2026-10-08T18:07:41.000Z", "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "pure_consumer" } },
			{ "id": "multimon-ng", "type": "multimon-ng", "running": true, "health": "running", "pid": 1495, "uptime": 51, "stats": { "bytesIn": 761100000, "eventsOut": 2, "errors": 0 }, "lastOutputAt": "2026-10-08T18:07:20.000Z", "restartCount": 0, "caps": { "input": "iq", "output": "text", "integrationPattern": "pure_consumer" } },
			{ "id": "rtl433", "type": "rtl433", "running": true, "health": "idle", "pid": 1501, "uptime": 51, "stats": { "bytesIn": 625900000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "pure_consumer" } },
			{ "id": "readsb", "type": "readsb", "running": true, "health": "idle", "pid": 1531, "uptime": 51, "stats": { "bytesIn": 570600000, "eventsOut": 0, "errors": 6 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "network_producer" } },
			{ "id": "acarsdec", "type": "acarsdec", "running": false, "health": "running", "uptime": 0, "stats": { "bytesIn": 43500000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 13, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "pure_consumer" } },
			{ "id": "ais-catcher", "type": "ais-catcher", "running": true, "health": "idle", "pid": 1540, "uptime": 51, "stats": { "bytesIn": 832500000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "network_producer" } },
			{ "id": "dumpvdl2", "type": "dumpvdl2", "running": true, "health": "idle", "pid": 1550, "uptime": 50, "stats": { "bytesIn": 656800000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "pure_consumer" } },
			{ "id": "direwolf", "type": "direwolf", "running": true, "health": "idle", "pid": 1560, "uptime": 50, "stats": { "bytesIn": 750700000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "audio_pcm", "output": "text", "integrationPattern": "network_producer" } },
			{ "id": "lora-meshtastic", "type": "lora-meshtastic", "running": true, "health": "idle", "pid": 1570, "uptime": 50, "stats": { "bytesIn": 116400000, "eventsOut": 0, "errors": 0 }, "lastOutputAt": null, "restartCount": 0, "caps": { "input": "iq", "output": "jsonl", "integrationPattern": "pure_consumer" } }
		] },
		"/api/sources": { "status": 200, "body": [
			{ "id": "pi-iq", "type": "rtl_tcp", "url": "tcp://192.0.2.23:5555", "connected": true, "activity": { "state": "streaming", "lastSampleAt": "2026-10-08T18:07:49.996Z", "sampleAgeMs": 4, "timeoutMs": 10000 }, "consumers": 9, "bytesReceived": 1200000000, "dataRate": 3994, "reconnectAttempts": 0, "caps": { "kind": "iq", "sampleRate": 2048000, "format": "U8_IQ", "centerFreq": 445970700, "exclusive": false }, "available": true, "assignments": [
				{ "decoderId": "dsd-fme", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "multimon-ng", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "rtl433", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "readsb", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "acarsdec", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "ais-catcher", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "dumpvdl2", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "direwolf", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" },
				{ "decoderId": "lora-meshtastic", "sourceId": "pi-iq", "assignedAt": "2026-10-08T18:07:00.000Z" }
			] }
		] },
		"/api/tuner": { "status": 200, "body": [
			{ "sourceId": "pi-iq", "frequency": 445970700, "sampleRate": 2048000, "gainMode": "manual", "gain": 0, "ppm": 0, "agcMode": false, "biasTee": false, "directSampling": "off", "offsetTuning": false, "ifGain": 0, "tunerIfGain": null, "testMode": false, "tunerGainIndex": 11, "controlMode": "external", "lastCommandAt": "2026-10-08T18:01:20.000Z", "commandCount": 42 }
		] },
		"/api/tuner-relay": { "status": 200, "body": { "enabled": true, "listening": true, "host": "0.0.0.0", "port": 4713, "sourceId": "pi-iq", "sourceConnected": true, "clientsConnected": 1, "controlClientId": "client-3", "controlClientRemote": "192.0.2.1:59430", "controlPolicy": "exclusive", "maxClients": 4, "bytesSent": 545500000, "bytesReceived": 840, "lastCommand": "set-frequency", "lastCommandAt": "2026-10-08T18:01:20.000Z", "lastCommandValue": 445970700, "lastFrequency": 445970700, "rtlTcpHeader": { "magic": "RTL0", "tunerType": 6, "gainCount": 29 }, "commandHistory": [
			{ "id": 42, "name": "set-frequency", "value": 445970700, "at": "2026-10-08T18:01:20.000Z", "clientId": "client-3", "clientRemote": "192.0.2.1:59430" },
			{ "id": 41, "name": "set-frequency", "value": 446860476, "at": "2026-10-08T18:00:56.000Z", "clientId": "client-3", "clientRemote": "192.0.2.1:59430" },
			{ "id": 40, "name": "set-tuner-gain-index", "value": 11, "at": "2026-10-08T18:00:50.000Z", "clientId": "client-3", "clientRemote": "192.0.2.1:59430" },
			{ "id": 39, "name": "set-frequency", "value": 446860476, "at": "2026-10-08T18:00:38.000Z", "clientId": "client-3", "clientRemote": "192.0.2.1:59430" },
			{ "id": 38, "name": "set-frequency", "value": 446524920, "at": "2026-10-08T18:00:20.000Z", "clientId": "client-3", "clientRemote": "192.0.2.1:59430" }
		] } },
		"/api/telemetry/fanout": { "status": 200, "body": { "timestamp": "2026-10-08T18:07:49.000Z", "backpressureActiveCount": 4, "droppedBytesTotal": 5738000000, "droppedChunksTotal": 114760, "totalBytesWritten": 15745500000, "branches": [
			{ "id": "decoder-dsd-fme", "decoderId": "dsd-fme", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 12, "droppedBytesTotal": 684000000, "droppedChunksTotal": 13680, "bufferBytes": 65536, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-multimon-ng", "decoderId": "multimon-ng", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 14, "droppedBytesTotal": 741000000, "droppedChunksTotal": 14820, "bufferBytes": 98304, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-rtl433", "decoderId": "rtl433", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 41, "droppedBytesTotal": 779000000, "droppedChunksTotal": 15580, "bufferBytes": 300000, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-readsb", "decoderId": "readsb", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 121, "droppedBytesTotal": 836000000, "droppedChunksTotal": 3357, "bufferBytes": 389120, "highWaterMark": 262144, "totalBytesWritten": 1900000000, "backpressureSince": "2026-10-08T18:07:48.800Z", "lastDrainAt": "2026-10-08T18:07:48.700Z" },
			{ "id": "decoder-ais-catcher", "decoderId": "ais-catcher", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 88, "droppedBytesTotal": 684000000, "droppedChunksTotal": 13680, "bufferBytes": 310000, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-dumpvdl2", "decoderId": "dumpvdl2", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 97, "droppedBytesTotal": 779000000, "droppedChunksTotal": 15580, "bufferBytes": 330000, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-direwolf", "decoderId": "direwolf", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 10, "droppedBytesTotal": 665000000, "droppedChunksTotal": 13300, "bufferBytes": 40960, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "decoder-lora-meshtastic", "decoderId": "lora-meshtastic", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 7, "droppedBytesTotal": 570000000, "droppedChunksTotal": 11400, "bufferBytes": 32768, "highWaterMark": 262144, "totalBytesWritten": 1900000000 },
			{ "id": "tuner-relay", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 0, "droppedBytesTotal": 0, "droppedChunksTotal": 0, "bufferBytes": 0, "highWaterMark": 8388608, "totalBytesWritten": 545500000 }
		] } },
		"/api/resources": { "status": 200, "body": { "timestamp": "2026-10-08T18:07:50.000Z",
			"container": { "available": true, "cpuUsagePercent": 240, "cpuThrottledPercent": null, "memoryUsageBytes": 1940000000, "memoryLimitBytes": null, "memoryUsagePercent": null, "oomKillCount": 0, "cgroupVersion": "v2" },
			"sdrHosts": [ { "available": true, "sourceId": "pi-iq", "apiUrl": "http://192.0.2.23:8080", "uptime": 291,
				"rtlTcp": { "running": true, "pid": 58, "restartCount": 0, "lastRestartAt": null, "config": { "sampleRate": 2048000, "frequency": 445970700, "gain": 0, "agc": false } },
				"rtlmux": { "running": true, "pid": 63, "restartCount": 0, "lastRestartAt": null, "clients": 1, "bytesPerSec": 4200000, "totalBytesSent": 1200000000, "clientDetails": [ { "id": 1, "address": "192.0.2.10:50122", "bytesDropped": 3500000 } ] },
				"dongle": { "found": true, "vendor": "RTL-SDR Blog", "product": "V4", "serial": null },
				"warnings": [], "errors": [], "lastFetchedAt": "2026-10-08T18:07:50.000Z", "fetchError": null } ],
			"sourceBackpressure": [ { "sourceId": "pi-iq", "available": true, "bytesDroppedUpstream": 3500000, "totalBytesSent": 1200000000, "dropRate": 0, "dropPercent": 0.29, "lastCheckedAt": "2026-10-08T18:07:50.000Z" } ] } },
		"/api/live-audio/status": { "status": 200, "body": { "enabled": true, "running": false, "sourceId": "pi-iq", "sourceConnected": true, "sourceIqSampleRate": 2048000, "effectiveSampleRate": 48000, "decimationFactor": 42, "httpUrl": "http://127.0.0.1:8081/stream", "clientCount": 0, "bytesStreamed": 0, "pipelineHealth": "stopped",
			"config": { "enabled": true, "sourceId": "pi-iq", "httpPort": 8081, "modulation": "nfm", "bandwidth": 12500, "squelch": 0, "noiseReduction": "off", "lowPass": 0, "highPass": 0, "gain": 10, "deEmphasis": false, "deEmphasisTau": 50, "audioFormat": "s16le", "iqDcBlock": true } } },
		"/api/live-audio/presets": { "status": 200, "body": { "nfm": { "bandwidth": 12500 }, "wfm": { "bandwidth": 200000, "deEmphasis": true, "deEmphasisTau": 50 }, "am": { "bandwidth": 10000 }, "usb": { "bandwidth": 2800 }, "lsb": { "bandwidth": 2800 }, "dsb": { "bandwidth": 5000 }, "cw": { "bandwidth": 500 }, "raw": { "bandwidth": 48000 } } },
		"/api/status": { "status": 200, "body": { "status": "degraded", "uptime": 460, "version": "1.0.0", "sources": [], "decoders": {}, "audio": { "outputPort": 8081, "clientsConnected": 0 },
			"health": { "status": "degraded", "timestamp": "2026-10-08T18:07:50.000Z", "uptime": 460, "components": { "api": { "status": "up" }, "source": { "status": "up" }, "decoders": {} } } } },
		"/api/aircraft": { "status": 200, "body": { "aircraft": [], "timestamp": 1791482870000, "stats": { "aircraftCount": 0, "withPosition": 0, "withCallsign": 0, "enrichedCount": 0, "messagesProcessed": 0, "messagesPerSecond": 0, "enrichmentCache": { "hits": 0, "misses": 0, "size": 0 } } } }
	},
	"restHistory": [
		{ "offsetMs": -60000, "path": "/api/decoders", "merge": { "dsd-fme": { "stats": { "eventsOut": 1 } }, "multimon-ng": { "stats": { "eventsOut": 1 } } } }
	],
	"ws": [
		{ "offsetMs": -6000, "type": "fanout:snapshot", "channel": "fanout", "data": { "timestamp": "2026-10-08T18:07:44.000Z", "backpressureActiveCount": 4, "droppedBytesTotal": 5703236224, "droppedChunksTotal": 114100, "totalBytesWritten": 15561456480, "branches": [
			{ "id": "decoder-dsd-fme", "decoderId": "dsd-fme", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 12, "droppedBytesTotal": 681546086, "droppedChunksTotal": 13600, "bufferBytes": 65536, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-multimon-ng", "decoderId": "multimon-ng", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 14, "droppedBytesTotal": 738137101, "droppedChunksTotal": 14740, "bufferBytes": 98304, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-rtl433", "decoderId": "rtl433", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 40, "droppedBytesTotal": 775932608, "droppedChunksTotal": 15500, "bufferBytes": 300000, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-readsb", "decoderId": "readsb", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 120, "droppedBytesTotal": 828229274, "droppedChunksTotal": 3320, "bufferBytes": 389120, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-ais-catcher", "decoderId": "ais-catcher", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 87, "droppedBytesTotal": 677660723, "droppedChunksTotal": 13560, "bufferBytes": 310000, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-dumpvdl2", "decoderId": "dumpvdl2", "sourceId": "pi-iq", "backpressureActive": true, "backpressureEnterCount": 96, "droppedBytesTotal": 770820288, "droppedChunksTotal": 15420, "bufferBytes": 330000, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-direwolf", "decoderId": "direwolf", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 10, "droppedBytesTotal": 662750579, "droppedChunksTotal": 13250, "bufferBytes": 40960, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "decoder-lora-meshtastic", "decoderId": "lora-meshtastic", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 7, "droppedBytesTotal": 568159565, "droppedChunksTotal": 11360, "bufferBytes": 32768, "highWaterMark": 262144, "totalBytesWritten": 1879550720 },
			{ "id": "tuner-relay", "sourceId": "pi-iq", "backpressureActive": false, "backpressureEnterCount": 0, "droppedBytesTotal": 0, "droppedChunksTotal": 0, "bufferBytes": 0, "highWaterMark": 8388608, "totalBytesWritten": 525050720 }
		] } },
		{ "offsetMs": -6000, "type": "metrics", "channel": "metrics", "data": { "sourceId": "pi-iq", "bytesReceived": 1179550720, "dataRate": 3994 } },
		{ "offsetMs": -1000, "type": "fanout:snapshot", "channel": "fanout", "data": "$fanoutRest" },
		{ "offsetMs": -1000, "type": "metrics", "channel": "metrics", "data": { "sourceId": "pi-iq", "bytesReceived": 1200000000, "dataRate": 3994 } },
		{ "offsetMs": -1000, "type": "resources:alert", "channel": "resources", "data": { "type": "container-cpu", "severity": "critical", "message": "High CPU usage: 273.5%", "timestamp": "2026-10-08T18:07:49.000Z" } },
		{ "offsetMs": -9000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "dsd-fme", "output": { "type": "call_end", "decoder": "dsd-fme", "timestamp": "2026-10-08T18:07:41.000Z", "data": { "protocol": "dmr", "talkgroup": 2350, "source": 2341234, "slot": 1, "duration": 8400, "dmr": { "cc": 1 }, "quality": { "crcErrs": 4, "fecErrs": 3 }, "flags": { "encrypted": true } } } } },
		{ "offsetMs": -30000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "multimon-ng", "output": { "type": "pocsag", "decoder": "multimon-ng", "timestamp": "2026-10-08T18:07:20.000Z", "data": { "protocol": "POCSAG1200", "address": 1234567, "function": 3, "messageType": "Alpha", "message": "FIRE ALARM ACTIVATION - 12 LONG STREET UNIT 4B - ZONE 3 SMOKE DETECTOR - RESPOND" } } } },
		{ "offsetMs": -48000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "dsd-fme", "output": { "type": "call_end", "decoder": "dsd-fme", "timestamp": "2026-10-08T18:07:02.000Z", "data": { "protocol": "dmr", "talkgroup": 2350, "source": 2340001, "slot": 2, "duration": 3100, "dmr": { "cc": 1 }, "quality": { "crcErrs": 2, "fecErrs": 0 } } } } },
		{ "offsetMs": -126000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "multimon-ng", "output": { "type": "pocsag", "decoder": "multimon-ng", "timestamp": "2026-10-08T18:05:44.000Z", "data": { "protocol": "POCSAG1200", "address": 7654321, "function": 0, "messageType": "Numeric", "message": "0207 555 0101" } } } },
		{ "offsetMs": -220000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "dsd-fme", "output": { "type": "call_end", "decoder": "dsd-fme", "timestamp": "2026-10-08T18:04:10.000Z", "data": { "protocol": "dmr", "talkgroup": 9, "source": 2341001, "slot": 1, "duration": 1200, "dmr": { "cc": 1 }, "quality": { "crcErrs": 1, "fecErrs": 1 } } } } },
		{ "offsetMs": -232000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "multimon-ng", "output": { "type": "flex", "decoder": "multimon-ng", "timestamp": "2026-10-08T18:03:58.000Z", "data": { "protocol": "FLEX", "capcode": "1-2345678", "messageType": "ALN", "message": "TEST PAGE 03:58" } } } },
		{ "offsetMs": -398000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "dsd-fme", "output": { "type": "call_end", "decoder": "dsd-fme", "timestamp": "2026-10-08T18:01:12.000Z", "data": { "protocol": "dmr", "talkgroup": 2350, "source": 2341234, "slot": 1, "duration": 12000, "dmr": { "cc": 1 }, "quality": { "crcErrs": 3, "fecErrs": 2 } } } } }
	]
}
```

`"$fanoutRest"` is a loader macro. When a frame's `data` is exactly that string, the loader substitutes the current `/api/telemetry/fanout` body, so the newest WS snapshot and the REST snapshot cannot drift apart.

- [ ] **Step 4: Write the ten derived scenarios**

`cli/tools/mock-api/scenarios/idle.json`:
```json
{ "extends": "live", "name": "idle", "description": "Feed live, nothing decoded: no outputs, no lastOutputAt.",
  "restPatch": { "/api/decoders": { "dsd-fme": { "stats": { "eventsOut": 0 }, "lastOutputAt": null }, "multimon-ng": { "stats": { "eventsOut": 0 }, "lastOutputAt": null } } },
  "restHistory": [], "transform": { "noOutputs": true } }
```

`cli/tools/mock-api/scenarios/api-down.json`:
```json
{ "extends": "live", "name": "api-down", "description": "Cold start with the API unreachable: no cache.",
  "conn": { "rest": "down", "ws": "closed", "cached": false, "downForMs": 151000, "restError": "ECONNREFUSED", "closeCode": 1006 } }
```

`cli/tools/mock-api/scenarios/api-down-cached.json`:
```json
{ "extends": "live", "name": "api-down-cached", "description": "API unreachable for 2m 31s with cached data; the feed gap is open.",
  "conn": { "rest": "down", "ws": "closed", "cached": true, "restAgoMs": 151000, "wsAgoMs": 152000, "downForMs": 151000, "wsClosedAgoMs": 151000, "restError": "ECONNREFUSED", "closeCode": 1006 } }
```

`cli/tools/mock-api/scenarios/ws-only.json`:
```json
{ "extends": "live", "name": "ws-only", "description": "REST timing out for 45 s while the WS feed is live.",
  "conn": { "rest": "down", "ws": "open", "cached": true, "restAgoMs": 45000, "wsAgoMs": 1000, "downForMs": 45000, "restError": "timeout" } }
```

`cli/tools/mock-api/scenarios/rest-only.json`:
```json
{ "extends": "live", "name": "rest-only", "description": "WS closed 1006 for 30 s; REST answering every 5 s.",
  "conn": { "rest": "ok", "ws": "closed", "cached": true, "restAgoMs": 2000, "wsAgoMs": 40000, "wsClosedAgoMs": 30000, "closeCode": 1006 } }
```

`cli/tools/mock-api/scenarios/dropping.json`:
```json
{ "extends": "live", "name": "dropping", "description": "Every decoder branch dropping 60 % of offered IQ now.", "transform": { "dropPercent": 60 } }
```

`cli/tools/mock-api/scenarios/crash-loop.json`:
```json
{ "extends": "live", "name": "crash-loop", "description": "acarsdec restarted 3 times in the last 4 minutes.",
  "restHistory": [
    { "offsetMs": -240000, "path": "/api/decoders", "merge": { "acarsdec": { "restartCount": 10 } } },
    { "offsetMs": -120000, "path": "/api/decoders", "merge": { "acarsdec": { "restartCount": 11 } } },
    { "offsetMs": -60000, "path": "/api/decoders", "merge": { "acarsdec": { "restartCount": 12 }, "dsd-fme": { "stats": { "eventsOut": 1 } }, "multimon-ng": { "stats": { "eventsOut": 1 } } } }
  ] }
```

`cli/tools/mock-api/scenarios/legacy.json`:
```json
{ "extends": "live", "name": "legacy", "description": "Older core: no source activity, no totalBytesWritten.", "transform": { "legacy": true } }
```

`cli/tools/mock-api/scenarios/long-text.json`:
```json
{ "extends": "live", "name": "long-text", "description": "Long payloads, control characters, emoji and an over-long decoder id.",
  "wsAppend": [
    { "offsetMs": -500, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "multimon-ng", "output": { "type": "pocsag", "decoder": "multimon-ng", "timestamp": "2026-10-08T18:07:49.500Z", "data": { "address": 1112223, "function": 2, "messageType": "Alpha", "message": "EXTENDED MAINTENANCE NOTICE FOR SECTOR 7 \u001b[31mRED\u001b[0m BELL\u0007 THEN TAB\tAND NEWLINE\nAND 🚀 ROCKET - LINE ONE OF MANY - LINE TWO OF MANY - LINE THREE OF MANY - LINE FOUR OF MANY - LINE FIVE OF MANY - LINE SIX OF MANY - LINE SEVEN OF MANY - LINE EIGHT OF MANY - LINE NINE OF MANY - LINE TEN OF MANY - END" } } } },
    { "offsetMs": -400, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "ais-catcher", "output": { "type": "ais", "decoder": "ais-catcher", "timestamp": "2026-10-08T18:07:49.600Z", "data": { "mmsi": 235012345, "shipname": "SEA PRINCESS OF THE NORTHERN WATERS AND THE FAR WESTERN ISLES", "shiptype_text": "passenger", "lat": 51.5, "lon": -0.12, "speed": 12.1 } } } },
    { "offsetMs": -300, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "an-extremely-long-decoder-identifier-used-for-truncation-tests", "output": { "type": "weird", "decoder": "an-extremely-long-decoder-identifier-used-for-truncation-tests", "timestamp": "2026-10-08T18:07:49.700Z", "data": { "nested": { "deeper": { "deepest": [1, 2, 3, "\u009b2J"] } } } } } }
  ] }
```

`cli/tools/mock-api/scenarios/burst.json`:
```json
{ "extends": "live", "name": "burst", "description": "Receiver at 1090 MHz; mixed ADS-B/AIS rows including an emergency squawk.",
  "restPatch": {
    "/api/tuner": { "pi-iq": { "frequency": 1090000000 } },
    "/api/sources": { "pi-iq": { "caps": { "centerFreq": 1090000000 } } }
  },
  "transform": { "noOutputs": true, "dropPercent": 0 },
  "rest": { "/api/aircraft": { "status": 200, "body": { "timestamp": 1791483130000,
    "aircraft": [
      { "icao": "4CA9D2", "seen": 0, "messages": 1204, "firstSeen": 0, "lastUpdated": 0, "callsign": "RYR4KT", "squawk": "7700", "identification": { "registration": "EI-DCL", "typeCode": "B738" } },
      { "icao": "3C6444", "seen": 1, "messages": 312, "firstSeen": 0, "lastUpdated": 0, "callsign": "DLH4XP", "identification": { "registration": "D-AIUE", "typeCode": "A320" } }
    ],
    "stats": { "aircraftCount": 14, "withPosition": 9, "withCallsign": 11, "enrichedCount": 8, "messagesProcessed": 5120, "messagesPerSecond": 12.5, "enrichmentCache": { "hits": 8, "misses": 6, "size": 14 } } } } },
  "wsAppend": [
    { "offsetMs": -2000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "readsb", "output": { "type": "aircraft", "decoder": "readsb", "timestamp": "2026-10-08T18:07:48.000Z", "data": { "hex": "4ca9d2", "flight": "RYR4KT ", "alt_baro": 37000, "baro_rate": -1216, "gs": 451.2, "track": 134.1, "lat": 51.4712, "lon": -0.4521, "squawk": "7700", "rssi": -12.3, "seen": 0.4, "messages": 1204 } } } },
    { "offsetMs": -8000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "ais-catcher", "output": { "type": "ais", "decoder": "ais-catcher", "timestamp": "2026-10-08T18:07:42.000Z", "data": { "mmsi": 235012345, "shipname": "SEA PRINCESS OF THE NORTHERN WATERS", "shiptype_text": "passenger", "lat": 51.5, "lon": -0.12, "speed": 12.1 } } } },
    { "offsetMs": -14000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "readsb", "output": { "type": "aircraft", "decoder": "readsb", "timestamp": "2026-10-08T18:07:36.000Z", "data": { "hex": "4ca9d2", "flight": "RYR4KT ", "alt_baro": 37500, "baro_rate": -1100, "gs": 449, "track": 134, "lat": 51.49, "lon": -0.47, "squawk": "7700" } } } },
    { "offsetMs": -41000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "readsb", "output": { "type": "aircraft", "decoder": "readsb", "timestamp": "2026-10-08T18:07:09.000Z", "data": { "hex": "3c6444", "flight": "DLH4XP", "alt_baro": 12000, "baro_rate": 1500, "gs": 312, "track": 45, "lat": 51.21, "lon": -0.31 } } } },
    { "offsetMs": -42000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "ais-catcher", "output": { "type": "ais", "decoder": "ais-catcher", "timestamp": "2026-10-08T18:07:08.000Z", "data": { "mmsi": 244660123, "shipname": "EEMS SPIRIT", "shiptype_text": "cargo", "lat": 51.44, "lon": 0.21, "speed": 8.4 } } } },
    { "offsetMs": -70000, "type": "decoder:output", "channel": "decoders", "data": { "decoderId": "readsb", "output": { "type": "aircraft", "decoder": "readsb", "timestamp": "2026-10-08T18:06:40.000Z", "data": { "hex": "4ca9d2", "flight": "RYR4KT ", "alt_baro": 38000, "baro_rate": -900, "gs": 447, "track": 134, "lat": 51.51, "lon": -0.49, "squawk": "7700" } } } }
  ] }
```

- [ ] **Step 5: Write `cli/source/test/scenarios.ts`**

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { Scenario, ScenarioFrame, ScenarioName } from "./scenario-types.js"

/** Scenario JSON lives outside source/ (read with fs, never imported, so rootDir stays ./source). */
export const SCENARIO_DIR = fileURLToPath(new URL("../../tools/mock-api/scenarios/", import.meta.url))
export const DELETE = "$delete"
const FANOUT_REST = "$fanoutRest"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

export function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isObj(base) || !isObj(patch)) return patch
	const out: Obj = { ...base }
	for (const [k, v] of Object.entries(patch)) {
		if (v === DELETE) delete out[k]
		else out[k] = deepMerge(base[k], v)
	}
	return out
}

export function mergeById(body: unknown, merge: Record<string, unknown>): unknown {
	if (!Array.isArray(body)) return deepMerge(body, merge)
	return body.map((item: unknown) => {
		if (!isObj(item)) return item
		const key = typeof item["id"] === "string" ? item["id"] : item["sourceId"]
		return typeof key === "string" && merge[key] !== undefined ? deepMerge(item, merge[key]) : item
	})
}

function readRaw(name: string): Obj {
	const raw: unknown = JSON.parse(readFileSync(`${SCENARIO_DIR}${name}.json`, "utf8"))
	if (!isObj(raw)) throw new Error(`scenario ${name} is not an object`)
	return raw
}

function fanoutBodies(sc: Obj): Obj[] {
	const out: Obj[] = []
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const f = rest["/api/telemetry/fanout"]
	if (isObj(f) && isObj(f["body"])) out.push(f["body"])
	for (const fr of Array.isArray(sc["ws"]) ? sc["ws"] : []) {
		if (isObj(fr) && fr["type"] === "fanout:snapshot" && isObj(fr["data"])) out.push(fr["data"])
	}
	return out
}

function applyLegacy(sc: Obj): void {
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const src = rest["/api/sources"]
	if (isObj(src) && Array.isArray(src["body"])) {
		for (const s of src["body"]) if (isObj(s)) delete s["activity"]
	}
	for (const body of fanoutBodies(sc)) {
		delete body["totalBytesWritten"]
		for (const b of Array.isArray(body["branches"]) ? body["branches"] : []) if (isObj(b)) delete b["totalBytesWritten"]
	}
}

function applyDropPercent(sc: Obj, pct: number): void {
	const frames = (Array.isArray(sc["ws"]) ? sc["ws"] : [])
		.filter((f): f is Obj => isObj(f) && f["type"] === "fanout:snapshot" && isObj(f["data"]))
		.sort((a, b) => Number(a["offsetMs"]) - Number(b["offsetMs"]))
	const first = frames[0]?.["data"]
	if (!isObj(first)) return
	const base = new Map<string, { offered: number; dropped: number }>()
	for (const b of Array.isArray(first["branches"]) ? first["branches"] : []) {
		if (isObj(b) && typeof b["id"] === "string") base.set(b["id"], { offered: Number(b["totalBytesWritten"] ?? 0), dropped: Number(b["droppedBytesTotal"] ?? 0) })
	}
	for (const body of fanoutBodies(sc)) {
		let total = 0
		for (const b of Array.isArray(body["branches"]) ? body["branches"] : []) {
			if (!isObj(b) || typeof b["id"] !== "string") continue
			const b0 = base.get(b["id"])
			if (b0 && b["decoderId"] !== undefined) {
				b["droppedBytesTotal"] = b0.dropped + Math.round((pct / 100) * (Number(b["totalBytesWritten"] ?? 0) - b0.offered))
				b["backpressureActive"] = pct > 0
			}
			total += Number(b["droppedBytesTotal"] ?? 0)
		}
		body["droppedBytesTotal"] = total
	}
}

function expandMacros(sc: Obj): void {
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const f = rest["/api/telemetry/fanout"]
	const body = isObj(f) ? f["body"] : undefined
	sc["ws"] = (Array.isArray(sc["ws"]) ? sc["ws"] : []).map((fr: unknown) =>
		isObj(fr) && fr["data"] === FANOUT_REST ? { ...fr, data: structuredClone(body) } : fr,
	)
}

function resolve(name: string): Obj {
	const own = readRaw(name)
	const parentName = own["extends"]
	let sc: Obj = typeof parentName === "string" ? (deepMerge(resolve(parentName), { ...own, extends: DELETE }) as Obj) : structuredClone(own)
	sc = structuredClone(sc)
	const patch = isObj(own["restPatch"]) ? own["restPatch"] : {}
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	for (const [path, merge] of Object.entries(patch)) {
		const r = rest[path]
		if (isObj(r) && isObj(merge)) r["body"] = mergeById(r["body"], merge)
	}
	const t = isObj(own["transform"]) ? own["transform"] : {}
	// noOutputs removes inherited outputs only; frames this scenario appends are kept.
	const inherited = Array.isArray(sc["ws"]) ? (sc["ws"] as unknown[]) : []
	const kept = t["noOutputs"] === true ? inherited.filter(f => !(isObj(f) && f["type"] === "decoder:output")) : inherited
	sc["ws"] = [...kept, ...(Array.isArray(own["wsAppend"]) ? (own["wsAppend"] as unknown[]) : [])]
	expandMacros(sc)
	if (typeof t["dropPercent"] === "number") applyDropPercent(sc, t["dropPercent"])
	if (t["legacy"] === true) applyLegacy(sc)
	delete sc["restPatch"]
	delete sc["transform"]
	delete sc["wsAppend"]
	delete sc["extends"]
	sc["name"] = name
	return sc
}

/** Fully resolved scenario (extends, restPatch, wsAppend, macros and transforms applied). */
export function loadScenario(name: ScenarioName): Scenario {
	return resolve(name) as unknown as Scenario
}

export type { ScenarioFrame }
```

- [ ] **Step 6: Format the JSON and run the test**

```bash
pnpm exec prettier --write cli/tools/mock-api/scenarios
pnpm exec vitest run tests/unit/cli/scenarios.test.ts
```
Expected: PASS. If the address scan flags `0.0.0.0`, that is the relay's listen address, which the test already allows.

- [ ] **Step 7: Commit**

```bash
git add cli/tools/mock-api/scenarios cli/source/test/scenarios.ts tests/unit/cli/scenarios.test.ts
git commit -m "test(cli): sanitised mock-core scenarios and resolver (extends, patches, transforms)

Documentation addresses only (192.0.2.x, 127.0.0.1).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 29: Mock core server (C)

**Owner:** C · **Spec:** §13.3. See the "Mock server location" delta in this plan's assumptions.

**Files:**
- Create: `cli/source/test/mock-api/server.ts`
- Test: `cli/source/test/mock-api/server.test.tsx` (CLI vitest, starts the server on an ephemeral port)

**Interfaces:**
- Consumes: the scenario JSON from Task 28, read from disk. The server is self-contained, so it duplicates the small resolver, and the duplication is intentional because Node type-stripping cannot import a sibling `.ts` file under `cli/tsconfig.json`.
- Produces:
  - Run with `node cli/source/test/mock-api/server.ts [--port 9100] [--scenario live]`, or `pnpm --filter @wavekit/cli mock`.
  - REST: `GET /health` and every §10.2 endpoint. Writes: `POST /api/decoders/:id/{start,stop,restart}`, `POST /api/tuner/:sourceId/:setting`, `POST /api/live-audio/{start,stop}`, `PATCH /api/live-audio/config`.
  - WS `/ws` with the subscribe protocol. It sends `fanout:snapshot` every 1 s, `metrics` every 5 s and `resources:snapshot` every 5 s, and replays the scenario's other frames on subscribe.
  - Control: `POST /__mock/scenario {name}`, `/__mock/rest {mode: ok|fail|hang|500}`, `/__mock/ws {mode: up|drop|refuse}`, `/__mock/burst {perSecond, seconds}`, `/__mock/fanout {dropPercent}`. Plus `GET /__mock/calls` and `POST /__mock/reset`.
  - Exported for tests: `startMockServer(opts: { port: number; scenario: string }): Promise<{ port: number; close(): Promise<void> }>`.

- [ ] **Step 1: Write the failing integration test**

`cli/source/test/mock-api/server.test.tsx`:

```tsx
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { startMockServer } from "./server.js"

let server: { port: number; close(): Promise<void> }
const base = () => `http://127.0.0.1:${server.port}`

beforeAll(async () => {
	server = await startMockServer({ port: 0, scenario: "live" })
})
afterAll(async () => {
	await server.close()
})

describe("mock core", () => {
	it("serves REST from the scenario and evolves fanout counters", async () => {
		const health = (await (await fetch(`${base()}/health`)).json()) as { status: string }
		expect(health.status).toBe("ok")
		const decoders = (await (await fetch(`${base()}/api/decoders`)).json()) as unknown[]
		expect(decoders).toHaveLength(9)
		const f1 = (await (await fetch(`${base()}/api/telemetry/fanout`)).json()) as { totalBytesWritten: number }
		await new Promise(r => setTimeout(r, 1100))
		const f2 = (await (await fetch(`${base()}/api/telemetry/fanout`)).json()) as { totalBytesWritten: number }
		expect(f2.totalBytesWritten).toBeGreaterThan(f1.totalBytesWritten)
	})
	it("records writes and refuses tuner commands under external control", async () => {
		const r = await fetch(`${base()}/api/tuner/pi-iq/frequency`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"hz":446000000}' })
		expect(r.status).toBe(409)
		const calls = (await (await fetch(`${base()}/__mock/calls`)).json()) as Array<{ path: string }>
		expect(calls.map(c => c.path)).toContain("/api/tuner/pi-iq/frequency")
	})
	it("acks subscribe on /ws and pushes fanout snapshots", async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
		const types: string[] = []
		await new Promise<void>((resolve, reject) => {
			ws.on("error", reject)
			ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", channels: ["fanout", "decoders"] })))
			ws.on("message", (d: WebSocket.RawData) => {
				const t = (JSON.parse(d.toString()) as { type: string }).type
				types.push(t)
				if (t === "fanout:snapshot") resolve()
			})
		})
		ws.terminate()
		expect(types[0]).toBe("subscribed")
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @wavekit/cli test`
Expected: FAIL, `./server.js` not found.

- [ ] **Step 3: Write `cli/source/test/mock-api/server.ts`**

```ts
/**
 * WaveKit mock core for CLI development and validation (spec §13.3).
 * Run: node cli/source/test/mock-api/server.ts [--port 9100] [--scenario live]
 * Write actions in CLI validation go ONLY to this mock, never to a live core.
 * Self-contained on purpose: Node type stripping cannot import sibling .ts
 * files under cli/tsconfig.json, so the small scenario resolver is duplicated.
 */
import { readFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { fileURLToPath } from "node:url"
import { WebSocketServer, type RawData, type WebSocket } from "ws"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const SCENARIO_DIR = fileURLToPath(new URL("../../../tools/mock-api/scenarios/", import.meta.url))
const BYTES_PER_SEC = 3994 * 1024

function deepMerge(base: unknown, patch: unknown): unknown {
	if (!isObj(base) || !isObj(patch)) return patch
	const out: Obj = { ...base }
	for (const [k, v] of Object.entries(patch)) {
		if (v === "$delete") delete out[k]
		else out[k] = deepMerge(base[k], v)
	}
	return out
}

function mergeById(body: unknown, merge: Obj): unknown {
	if (!Array.isArray(body)) return deepMerge(body, merge)
	return body.map((item: unknown) => {
		if (!isObj(item)) return item
		const key = typeof item["id"] === "string" ? item["id"] : item["sourceId"]
		return typeof key === "string" && merge[key] !== undefined ? deepMerge(item, merge[key]) : item
	})
}

function resolve(name: string): Obj {
	const own: unknown = JSON.parse(readFileSync(`${SCENARIO_DIR}${name}.json`, "utf8"))
	if (!isObj(own)) throw new Error(`bad scenario ${name}`)
	const parent = own["extends"]
	const sc = structuredClone(typeof parent === "string" ? (deepMerge(resolve(parent), { ...own, extends: "$delete" }) as Obj) : own)
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const patch = isObj(own["restPatch"]) ? own["restPatch"] : {}
	for (const [path, m] of Object.entries(patch)) {
		const r = rest[path]
		if (isObj(r) && isObj(m)) r["body"] = mergeById(r["body"], m)
	}
	const t = isObj(own["transform"]) ? own["transform"] : {}
	const inherited: unknown[] = Array.isArray(sc["ws"]) ? sc["ws"] : []
	const kept = t["noOutputs"] === true ? inherited.filter(f => !(isObj(f) && f["type"] === "decoder:output")) : inherited
	sc["ws"] = [...kept, ...(Array.isArray(own["wsAppend"]) ? (own["wsAppend"] as unknown[]) : [])]
	if (t["legacy"] === true) {
		sc["legacy"] = true
		const sources = restBody(sc, "/api/sources")
		if (Array.isArray(sources)) for (const x of sources) if (isObj(x)) delete x["activity"]
	}
	if (typeof t["dropPercent"] === "number") sc["dropPercent"] = t["dropPercent"]
	delete sc["restPatch"]
	delete sc["transform"]
	delete sc["wsAppend"]
	return sc
}

interface Branch {
	id: string
	decoderId?: string
	offered: number
	dropped: number
	ratio: number
	chunks: number
	base: Obj
}

interface Call {
	at: string
	method: string
	path: string
	body: unknown
}

interface State {
	name: string
	sc: Obj
	rest: "ok" | "fail" | "hang" | "500"
	ws: "up" | "drop" | "refuse"
	dropPercent: number | null
	calls: Call[]
	branches: Branch[]
	decoders: Obj[]
	tuner: Obj[]
	audio: Obj
	lastTick: number
	burst: NodeJS.Timeout | null
}

function restBody(sc: Obj, path: string): unknown {
	const rest = isObj(sc["rest"]) ? sc["rest"] : {}
	const r = rest[path]
	return isObj(r) ? r["body"] : undefined
}

function initBranches(sc: Obj): Branch[] {
	const body = restBody(sc, "/api/telemetry/fanout")
	const frames = (Array.isArray(sc["ws"]) ? sc["ws"] : []).filter(
		(f): f is Obj => isObj(f) && f["type"] === "fanout:snapshot" && isObj(f["data"]),
	)
	const first = frames[0]?.["data"]
	const firstById = new Map<string, Obj>()
	if (isObj(first)) for (const b of Array.isArray(first["branches"]) ? first["branches"] : []) if (isObj(b)) firstById.set(String(b["id"]), b)
	const out: Branch[] = []
	for (const b of isObj(body) && Array.isArray(body["branches"]) ? body["branches"] : []) {
		if (!isObj(b)) continue
		const id = String(b["id"])
		const b0 = firstById.get(id)
		const dO = Number(b["totalBytesWritten"] ?? 0) - Number(b0?.["totalBytesWritten"] ?? 0)
		const dD = Number(b["droppedBytesTotal"] ?? 0) - Number(b0?.["droppedBytesTotal"] ?? 0)
		out.push({
			id,
			...(typeof b["decoderId"] === "string" ? { decoderId: b["decoderId"] } : {}),
			offered: Number(b["totalBytesWritten"] ?? 0),
			dropped: Number(b["droppedBytesTotal"] ?? 0),
			ratio: dO > 0 ? dD / dO : 0,
			chunks: Number(b["droppedChunksTotal"] ?? 0),
			base: b,
		})
	}
	return out
}

function loadState(name: string, prev?: State): State {
	const sc = resolve(name)
	const decoders = restBody(sc, "/api/decoders")
	const tuner = restBody(sc, "/api/tuner")
	const audio = restBody(sc, "/api/live-audio/status")
	return {
		name,
		sc,
		rest: prev?.rest ?? "ok",
		ws: prev?.ws ?? "up",
		dropPercent: typeof sc["dropPercent"] === "number" ? sc["dropPercent"] : null,
		calls: prev?.calls ?? [],
		branches: initBranches(sc),
		decoders: Array.isArray(decoders) ? (structuredClone(decoders) as Obj[]) : [],
		tuner: Array.isArray(tuner) ? (structuredClone(tuner) as Obj[]) : [],
		audio: isObj(audio) ? structuredClone(audio) : {},
		lastTick: Date.now(),
		burst: null,
	}
}

function fanoutSnapshot(st: State): Obj {
	const now = Date.now()
	const dt = (now - st.lastTick) / 1000
	st.lastTick = now
	const legacy = st.sc["legacy"] === true
	let offered = 0
	let dropped = 0
	let chunks = 0
	let bp = 0
	const branches = st.branches.map(b => {
		const delta = BYTES_PER_SEC * dt
		const ratio = b.decoderId !== undefined && st.dropPercent !== null ? st.dropPercent / 100 : b.ratio
		b.offered += delta
		b.dropped += Math.round(delta * ratio)
		b.chunks += ratio > 0 ? Math.max(1, Math.round(dt * 10)) : 0
		const active = b.decoderId !== undefined && ratio >= 0.15
		offered += b.offered
		dropped += b.dropped
		chunks += b.chunks
		if (active) bp++
		const out: Obj = { ...b.base, backpressureActive: active, droppedBytesTotal: Math.round(b.dropped), droppedChunksTotal: b.chunks }
		if (legacy) delete out["totalBytesWritten"]
		else out["totalBytesWritten"] = Math.round(b.offered)
		return out
	})
	const snap: Obj = {
		timestamp: new Date(now).toISOString(),
		branches,
		backpressureActiveCount: bp,
		droppedBytesTotal: dropped,
		droppedChunksTotal: chunks,
	}
	if (!legacy) snap["totalBytesWritten"] = Math.round(offered)
	return snap
}

function textOf(d: RawData): string {
	if (Array.isArray(d)) return Buffer.concat(d).toString("utf8")
	return Buffer.isBuffer(d) ? d.toString("utf8") : Buffer.from(d).toString("utf8")
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise(resolveBody => {
		const chunks: Buffer[] = []
		req.on("data", (c: Buffer) => chunks.push(c))
		req.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8")
			if (text === "") return resolveBody(undefined)
			try {
				resolveBody(JSON.parse(text))
			} catch {
				resolveBody(undefined)
			}
		})
		req.on("error", () => resolveBody(undefined))
	})
}

function send(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" })
	res.end(JSON.stringify(body))
}

const TUNER_FIELDS: Readonly<Record<string, [string, string]>> = {
	frequency: ["frequency", "hz"],
	gain: ["gain", "tenthsDb"],
	"gain-mode": ["gainMode", "mode"],
	"sample-rate": ["sampleRate", "hz"],
	ppm: ["ppm", "ppm"],
	agc: ["agcMode", "enabled"],
	"bias-tee": ["biasTee", "enabled"],
	"offset-tuning": ["offsetTuning", "enabled"],
	"direct-sampling": ["directSampling", "mode"],
	"tuner-gain-index": ["tunerGainIndex", "index"],
	"control-mode": ["controlMode", "mode"],
}

const BURST_TEXT = "MAINTENANCE PAGE \u001b[31mRED\u001b[0m BELL\u0007 TAB\tEND 🚀 "

function burstFrame(i: number): Obj {
	const t = new Date().toISOString()
	switch (i % 4) {
		case 0:
			return { decoderId: "readsb", output: { type: "aircraft", decoder: "readsb", timestamp: t, data: { hex: (0x4ca9d2 + (i % 50)).toString(16), flight: `RYR${i % 900} `, alt_baro: 30000 + (i % 80) * 100, baro_rate: (i % 3) * 600 - 600, gs: 420 + (i % 40), track: (i * 7) % 360, lat: 51 + (i % 100) / 100, lon: -0.5 + (i % 50) / 100, squawk: i % 97 === 0 ? "7700" : "2000" } } }
		case 1:
			return { decoderId: "ais-catcher", output: { type: "ais", decoder: "ais-catcher", timestamp: t, data: { mmsi: 235000000 + i, shipname: `VESSEL ${i} OF THE EXTREMELY LONG NAMED FLEET`, shiptype_text: "cargo", lat: 51.4, lon: 0.2, speed: 8 + (i % 10) } } }
		case 2:
			return { decoderId: "multimon-ng", output: { type: "pocsag", decoder: "multimon-ng", timestamp: t, data: { address: 1000000 + i, function: i % 4, messageType: "Alpha", message: BURST_TEXT.repeat(1 + (i % 6)) } } }
		default:
			return { decoderId: "dsd-fme", output: { type: "call_end", decoder: "dsd-fme", timestamp: t, data: { protocol: "dmr", talkgroup: 2350 + (i % 5), source: 2340000 + i, slot: 1 + (i % 2), duration: 1000 + (i % 20) * 300, dmr: { cc: 1 }, quality: { crcErrs: i % 5, fecErrs: 0 } } } }
	}
}

export async function startMockServer(opts: { port: number; scenario: string }): Promise<{ port: number; close(): Promise<void> }> {
	let st = loadState(opts.scenario)
	const clients = new Map<WebSocket, Set<string>>()
	const hanging = new Set<ServerResponse>()

	const broadcast = (channel: string, type: string, data: unknown): void => {
		for (const [ws, chans] of clients) if (chans.has(channel)) ws.send(JSON.stringify({ type, channel, data }))
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://mock")
		const path = url.pathname
		const method = req.method ?? "GET"
		if (path.startsWith("/__mock/")) {
			const body = await readBody(req)
			const b = isObj(body) ? body : {}
			if (path === "/__mock/calls") return send(res, 200, st.calls)
			if (path === "/__mock/reset") {
				st.calls = []
				return send(res, 200, { ok: true })
			}
			if (path === "/__mock/scenario" && typeof b["name"] === "string") {
				st = loadState(b["name"], st)
				return send(res, 200, { scenario: st.name })
			}
			if (path === "/__mock/rest" && typeof b["mode"] === "string") {
				st.rest = b["mode"] as State["rest"]
				if (st.rest !== "hang") for (const r of hanging) r.destroy()
				return send(res, 200, { rest: st.rest })
			}
			if (path === "/__mock/ws" && typeof b["mode"] === "string") {
				st.ws = b["mode"] as State["ws"]
				if (st.ws === "drop") for (const ws of clients.keys()) ws.terminate()
				return send(res, 200, { ws: st.ws })
			}
			if (path === "/__mock/fanout") {
				st.dropPercent = typeof b["dropPercent"] === "number" ? b["dropPercent"] : null
				return send(res, 200, { dropPercent: st.dropPercent })
			}
			if (path === "/__mock/burst") {
				const perSecond = typeof b["perSecond"] === "number" ? b["perSecond"] : 50
				const seconds = typeof b["seconds"] === "number" ? b["seconds"] : 60
				if (st.burst) clearInterval(st.burst)
				let i = 0
				const until = Date.now() + seconds * 1000
				st.burst = setInterval(() => {
					if (Date.now() > until && st.burst) {
						clearInterval(st.burst)
						st.burst = null
						return
					}
					for (let k = 0; k < Math.max(1, Math.round(perSecond / 10)); k++) broadcast("decoders", "decoder:output", burstFrame(i++))
				}, 100)
				return send(res, 200, { perSecond, seconds })
			}
			return send(res, 404, { error: "Not Found", code: "NOT_FOUND", message: `mock route ${path} not found` })
		}
		if (path === "/health") return send(res, 200, { status: "ok", timestamp: new Date().toISOString() })
		if (st.rest === "fail") {
			req.socket.destroy()
			return
		}
		if (st.rest === "hang") {
			hanging.add(res)
			res.on("close", () => hanging.delete(res))
			return
		}
		if (st.rest === "500") return send(res, 500, { error: "Internal Server Error", code: "MOCK_FAILURE", message: "mock failure" })
		if (method === "GET") {
			if (path === "/api/decoders") return send(res, 200, st.decoders)
			if (path === "/api/tuner") return send(res, 200, st.tuner)
			if (path === "/api/live-audio/status") return send(res, 200, st.audio)
			if (path === "/api/telemetry/fanout") return send(res, 200, fanoutSnapshot(st))
			const body = restBody(st.sc, path)
			if (body !== undefined) return send(res, 200, body)
			return send(res, 404, { error: "Not Found", code: "NOT_FOUND", message: `Route GET:${path} not found` })
		}
		const body = await readBody(req)
		st.calls.push({ at: new Date().toISOString(), method, path, body })
		const dec = /^\/api\/decoders\/([^/]+)\/(start|stop|restart)$/.exec(path)
		if (method === "POST" && dec) {
			const d = st.decoders.find(x => x["id"] === decodeURIComponent(dec[1] ?? ""))
			if (!d) return send(res, 404, { error: "Not Found", code: "DECODER_NOT_FOUND", message: "Decoder not found" })
			const op = dec[2]
			if (op === "start" && d["running"] === true) return send(res, 409, { error: "Conflict", code: "DECODER_ALREADY_RUNNING", message: "Decoder already running" })
			if (op === "stop" && d["running"] !== true) return send(res, 409, { error: "Conflict", code: "DECODER_NOT_RUNNING", message: "Decoder not running" })
			d["running"] = op !== "stop"
			d["uptime"] = 0
			setTimeout(() => broadcast("decoders", op === "stop" ? "decoder:stopped" : "decoder:started", { decoderId: d["id"] }), 300)
			return send(res, 200, { message: `Decoder ${op === "stop" ? "stopped" : op === "start" ? "started" : "restarted"}`, decoder: d })
		}
		const tun = /^\/api\/tuner\/([^/]+)\/([a-z-]+)$/.exec(path)
		if (method === "POST" && tun) {
			const t = st.tuner.find(x => x["sourceId"] === decodeURIComponent(tun[1] ?? ""))
			const field = TUNER_FIELDS[tun[2] ?? ""]
			if (!t) return send(res, 404, { error: "Not Found", code: "TUNER_SOURCE_NOT_FOUND", message: "Unknown source" })
			if (!field || !isObj(body)) return send(res, 400, { error: "Bad Request", code: "TUNER_VALIDATION_ERROR", message: "invalid body" })
			if (t["controlMode"] === "external" && tun[2] !== "control-mode") {
				return send(res, 409, { error: "Conflict", code: "TUNER_CONTROL_EXTERNAL", message: "device busy" })
			}
			t[field[0]] = body[field[1]]
			t["commandCount"] = Number(t["commandCount"] ?? 0) + 1
			t["lastCommandAt"] = new Date().toISOString()
			broadcast("tuner", "tuner:state-changed", { sourceId: t["sourceId"], state: t })
			return send(res, 200, t)
		}
		if (method === "POST" && (path === "/api/live-audio/start" || path === "/api/live-audio/stop")) {
			st.audio["running"] = path.endsWith("start")
			st.audio["pipelineHealth"] = path.endsWith("start") ? "running" : "stopped"
			broadcast("live-audio", "live-audio:status", st.audio)
			return send(res, 200, { success: true })
		}
		if (method === "PATCH" && path === "/api/live-audio/config" && isObj(body)) {
			st.audio["config"] = { ...(isObj(st.audio["config"]) ? st.audio["config"] : {}), ...body }
			broadcast("live-audio", "live-audio:config", st.audio["config"])
			return send(res, 200, st.audio)
		}
		return send(res, 404, { error: "Not Found", code: "NOT_FOUND", message: `Route ${method}:${path} not found` })
	}

	const server = createServer((req, res) => {
		void handle(req, res)
	})
	const wss = new WebSocketServer({ noServer: true })
	server.on("upgrade", (req, socket, head) => {
		if (new URL(req.url ?? "/", "http://mock").pathname !== "/ws" || st.ws !== "up") {
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, ws => {
			clients.set(ws, new Set())
			ws.on("error", () => clients.delete(ws))
			ws.on("close", () => clients.delete(ws))
			ws.on("message", (data: RawData) => {
				let msg: unknown
				try {
					msg = JSON.parse(textOf(data))
				} catch {
					ws.send(JSON.stringify({ type: "error", data: { message: "Invalid JSON" } }))
					return
				}
				if (!isObj(msg) || msg["type"] !== "subscribe" || !Array.isArray(msg["channels"])) return
				const chans = clients.get(ws) ?? new Set<string>()
				for (const c of msg["channels"]) if (typeof c === "string") chans.add(c)
				clients.set(ws, chans)
				ws.send(JSON.stringify({ type: "subscribed", data: { channels: [...chans] } }))
				for (const f of Array.isArray(st.sc["ws"]) ? st.sc["ws"] : []) {
					if (isObj(f) && f["type"] !== "fanout:snapshot" && f["type"] !== "metrics" && chans.has(String(f["channel"]))) {
						ws.send(JSON.stringify({ type: f["type"], channel: f["channel"], data: f["data"] }))
					}
				}
			})
		})
	})

	const fanoutTimer = setInterval(() => broadcast("fanout", "fanout:snapshot", fanoutSnapshot(st)), 1000)
	const slowTimer = setInterval(() => {
		broadcast("metrics", "metrics", { sourceId: "pi-iq", bytesReceived: Math.round(st.branches[0]?.offered ?? 0), dataRate: 3994 })
		const r = restBody(st.sc, "/api/resources")
		if (r !== undefined) broadcast("resources", "resources:snapshot", { ...(r as Obj), timestamp: new Date().toISOString() })
	}, 5000)

	await new Promise<void>(r => server.listen(opts.port, "127.0.0.1", () => r()))
	const port = (server.address() as AddressInfo).port
	return {
		port,
		close: () =>
			new Promise<void>(r => {
				clearInterval(fanoutTimer)
				clearInterval(slowTimer)
				if (st.burst) clearInterval(st.burst)
				for (const ws of clients.keys()) ws.terminate()
				for (const h of hanging) h.destroy()
				wss.close()
				server.close(() => r())
			}),
	}
}

function arg(name: string, fallback: string): string {
	const i = process.argv.indexOf(name)
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	void startMockServer({ port: Number(arg("--port", "9100")), scenario: arg("--scenario", "live") }).then(s => {
		process.stdout.write(`wavekit mock core on http://127.0.0.1:${s.port} (scenario ${arg("--scenario", "live")})\n`)
	})
}
```

- [ ] **Step 4: Run the tests and a manual smoke**

```bash
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli typecheck
node cli/source/test/mock-api/server.ts --port 9100 &
sleep 1; curl -s http://127.0.0.1:9100/api/decoders | head -c 200; echo
curl -s -X POST -H 'content-type: application/json' -d '{"mode":"500"}' http://127.0.0.1:9100/__mock/rest
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9100/api/status
kill %1
```
Expected: the tests pass and typecheck exits 0. The first curl prints JSON starting `[{"id":"dsd-fme"`, and the status curl prints `500`.

- [ ] **Step 5: Commit**

```bash
git add cli/source/test/mock-api/server.ts cli/source/test/mock-api/server.test.tsx
git commit -m "test(cli): self-contained mock core (REST, /ws, control routes, write recording)

Lives under source/test so the read-only eslint project list covers it.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 30: Arguments and help text (C)

**Owner:** C · **Spec:** §3 (`--view` names, aliases, invalid view exit 2, `--help`)

**Files:**
- Create: `cli/source/args.ts`
- Test: `tests/unit/cli/args.test.ts`

**Interfaces:**
- Consumes: `ViewId`, `VIEW_ORDER` (Task 2).
- Produces:
  - `VIEW_ALIASES: Readonly<Record<string, ViewId>>`
  - `type ParsedArgs = { kind: "run"; view: ViewId; api?: string } | { kind: "help" } | { kind: "error"; message: string }`
  - `parseArgs(argv: readonly string[]): ParsedArgs`
  - `HELP_TEXT: string`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/args.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { HELP_TEXT, VIEW_ALIASES, parseArgs } from "../../../cli/source/args.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"

describe("parseArgs", () => {
	it("accepts new names and every old alias", () => {
		expect(parseArgs([])).toEqual({ kind: "run", view: "overview" })
		expect(parseArgs(["--view", "receiver"])).toEqual({ kind: "run", view: "receiver" })
		const legacy: Record<string, string> = { dashboard: "overview", decoders: "decoders", output: "messages", backpressure: "decoders", sources: "receiver", tuner: "receiver", "live-audio": "system", resources: "system" }
		for (const [from, to] of Object.entries(legacy)) expect(VIEW_ALIASES[from]).toBe(to)
		expect(parseArgs(["-v", "output"])).toEqual({ kind: "run", view: "messages" })
		expect(parseArgs(["--view=tuner"])).toEqual({ kind: "run", view: "receiver" })
		expect(parseArgs(["--api", "http://192.0.2.4:9000"])).toEqual({ kind: "run", view: "overview", api: "http://192.0.2.4:9000" })
		expect(parseArgs(["--help"])).toEqual({ kind: "help" })
	})
	it("rejects invalid views with the valid names", () => {
		const r = parseArgs(["--view", "nope"])
		expect(r.kind).toBe("error")
		expect(r.kind === "error" && r.message).toContain("overview, decoders, messages, receiver, system")
		expect(parseArgs(["--bogus"]).kind).toBe("error")
		expect(parseArgs(["--api"]).kind).toBe("error")
	})
	it("documents views, aliases, --api and every env var without banned copy", () => {
		for (const s of ["overview", "dashboard", "--api", "WAVEKIT_API_URL", "WAVEKIT_WS_URL", "WAVEKIT_WS_URLS", "NO_COLOR", "WAVEKIT_ASCII"]) expect(HELP_TEXT).toContain(s)
		expect(findBanned(HELP_TEXT)).toEqual([])
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/args.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/args.ts`**

```ts
import { VIEW_ORDER, type ViewId } from "./ui/actions.js"

export const VIEW_ALIASES: Readonly<Record<string, ViewId>> = {
	overview: "overview",
	decoders: "decoders",
	messages: "messages",
	receiver: "receiver",
	system: "system",
	dashboard: "overview",
	output: "messages",
	backpressure: "decoders",
	sources: "receiver",
	tuner: "receiver",
	"live-audio": "system",
	resources: "system",
}

export type ParsedArgs =
	| { kind: "run"; view: ViewId; api?: string }
	| { kind: "help" }
	| { kind: "error"; message: string }

const VALID = VIEW_ORDER.join(", ")

function viewError(v: string): ParsedArgs {
	return { kind: "error", message: `wavekit: invalid view "${v}" · valid views: ${VALID} (aliases: ${Object.keys(VIEW_ALIASES).filter(k => !VIEW_ORDER.includes(k as ViewId)).join(", ")})` }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	let view: ViewId = "overview"
	let api: string | undefined
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? ""
		if (a === "--help" || a === "-h") return { kind: "help" }
		if (a === "--view" || a === "-v" || a.startsWith("--view=")) {
			const v = a.startsWith("--view=") ? a.slice("--view=".length) : argv[++i]
			const id = v === undefined ? undefined : VIEW_ALIASES[v]
			if (id === undefined) return viewError(v ?? "")
			view = id
			continue
		}
		if (a === "--api" || a.startsWith("--api=")) {
			const v = a.startsWith("--api=") ? a.slice("--api=".length) : argv[++i]
			if (v === undefined || v === "") return { kind: "error", message: "wavekit: --api needs a URL, e.g. --api http://127.0.0.1:9000" }
			api = v
			continue
		}
		return { kind: "error", message: `wavekit: unknown argument "${a}" · see wavekit --help` }
	}
	return api === undefined ? { kind: "run", view } : { kind: "run", view, api }
}

export const HELP_TEXT = `wavekit · WaveKit terminal dashboard

Usage:
  wavekit [--view <view>] [--api <url>]
  wavekit --help

Views (keys 1-5):
  overview   1  chain strip, receiver, decoders, latest messages
  decoders   2  process state, decodes and IQ drops per decoder
  messages   3  filterable, pausable decoded-message feed
  receiver   4  source, tuner, relay, fanout and upstream drops
  system     5  container, SDR host, live audio, core

Aliases:
  dashboard → overview, output → messages, backpressure → decoders,
  sources → receiver, tuner → receiver, live-audio → system, resources → system

Options:
  --view, -v <view>   open this view first
  --api <url>         WaveKit API base URL, e.g. http://127.0.0.1:9000
  --help, -h          show this help

Environment:
  WAVEKIT_API_URL     API base URL (WebSocket derived as ws://host/ws)
  WAVEKIT_WS_URL      WebSocket URL (API base derived from it)
  WAVEKIT_WS_URLS     comma-separated WebSocket URLs; the first is used
  NO_COLOR            no colour (bold, dim and inverse are kept)
  WAVEKIT_ASCII=1     ASCII glyphs instead of ● ○ × …

With no URL set, wavekit tries http://127.0.0.1:9000, then http://127.0.0.1:3000.
`
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/source/args.ts tests/unit/cli/args.test.ts
git commit -m "feat(cli): five views with legacy aliases, --api, exit-2 on invalid view

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 31: Terminal handling and the entry point (C, after Task 7)

**Owner:** C · **Spec:** §5.1 alternate screen, §15 alt-screen risk, §14 phase 1 (cli.tsx may keep the old App until phase 2) · **Starts after** Task 7 (A), which provides `resolveExplicit` and `CliUsageError` in `cli/source/data/config.ts`, is merged. Until then C does Task 32.

**Files:**
- Create: `cli/source/terminal.ts`
- Modify: `cli/source/cli.tsx` (full rewrite; it still renders the legacy `App` until Task 37)
- Test: `tests/unit/cli/terminal.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `HELP_TEXT` (Task 30), `resolveExplicit`, `CliUsageError` from `data/config.ts` (Task 7, A), `detectGlyphMode`, `setGlyphMode` (Task 3).
- Produces:
  - `ALT_ENTER`, `ALT_EXIT`, `CURSOR_SHOW`
  - `interface Screen { enter(): void; restore(): void }`, `createScreen(out: { write(s: string): unknown; isTTY?: boolean }): Screen`. It is a no-op on a non-TTY, and `restore` is idempotent.
  - `osc52(text: string): string`
  - `installExitHandlers(proc: { on(event: string, fn: (...args: unknown[]) => void): unknown; stderr: { write(s: string): unknown } }, screen: Screen, shutdown: (code: number) => void): void`. It handles `exit` (restore), `SIGINT` (130), `SIGTERM` (143), and `uncaughtException`/`unhandledRejection` (restore, a one-line stderr message, then 1).

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/terminal.test.ts`:

```ts
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { ALT_ENTER, ALT_EXIT, createScreen, installExitHandlers, osc52 } from "../../../cli/source/terminal.js"

describe("screen", () => {
	it("enters and restores the alternate screen once, only on a TTY", () => {
		const writes: string[] = []
		const tty = createScreen({ isTTY: true, write: s => writes.push(s) })
		tty.enter()
		tty.enter()
		tty.restore()
		tty.restore()
		expect(writes.join("")).toBe(`${ALT_ENTER}\x1b[?25h${ALT_EXIT}`)
		const pipe: string[] = []
		const p = createScreen({ isTTY: false, write: s => pipe.push(s) })
		p.enter()
		p.restore()
		expect(pipe).toEqual([])
	})
	it("encodes OSC 52 clipboard writes", () => {
		expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07")
	})
	it("restores and exits with the conventional codes", () => {
		const proc = Object.assign(new EventEmitter(), { stderr: { write: vi.fn() } })
		const screen = { enter: vi.fn(), restore: vi.fn() }
		const shutdown = vi.fn()
		installExitHandlers(proc, screen, shutdown)
		proc.emit("SIGINT")
		proc.emit("SIGTERM")
		proc.emit("uncaughtException", new Error("boom"))
		proc.emit("exit")
		expect(shutdown.mock.calls.map(c => c[0])).toEqual([130, 143, 1])
		expect(screen.restore).toHaveBeenCalled()
		expect(proc.stderr.write).toHaveBeenCalledWith("wavekit: boom\n")
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/terminal.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/terminal.ts`**

```ts
export const ALT_ENTER = "\x1b[?1049h"
export const ALT_EXIT = "\x1b[?1049l"
export const CURSOR_SHOW = "\x1b[?25h"

export interface Screen {
	enter(): void
	restore(): void
}

export function createScreen(out: { write(s: string): unknown; isTTY?: boolean }): Screen {
	let active = false
	return {
		enter: () => {
			if (active || out.isTTY !== true) return
			out.write(ALT_ENTER)
			active = true
		},
		restore: () => {
			if (!active) return
			active = false
			out.write(CURSOR_SHOW + ALT_EXIT)
		},
	}
}

/** OSC 52 clipboard write; whether the terminal honours it cannot be observed. */
export function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`
}

export interface ProcessLike {
	on(event: string, fn: (...args: unknown[]) => void): unknown
	stderr: { write(s: string): unknown }
}

export function installExitHandlers(proc: ProcessLike, screen: Screen, shutdown: (code: number) => void): void {
	const fatal = (err: unknown): void => {
		screen.restore()
		const message = err instanceof Error ? err.message : String(err)
		proc.stderr.write(`wavekit: ${message}\n`)
		shutdown(1)
	}
	proc.on("exit", () => screen.restore())
	proc.on("SIGINT", () => shutdown(130))
	proc.on("SIGTERM", () => shutdown(143))
	proc.on("uncaughtException", fatal)
	proc.on("unhandledRejection", fatal)
}
```

- [ ] **Step 4: Rewrite `cli/source/cli.tsx`**

This is the phase-1 version. It keeps the legacy `App` (old view names) until Task 37 swaps in the new shell.

```tsx
#!/usr/bin/env node
import { render } from "ink"
import { App as LegacyApp } from "./app.js"
import { HELP_TEXT, parseArgs } from "./args.js"
import { resolveExplicit } from "./data/config.js"
import { createScreen, installExitHandlers } from "./terminal.js"
import type { ViewId } from "./ui/actions.js"
import { detectGlyphMode, setGlyphMode } from "./ui/theme.js"

const LEGACY_VIEW: Record<ViewId, "dashboard" | "decoders" | "output" | "sources" | "resources"> = {
	overview: "dashboard",
	decoders: "decoders",
	messages: "output",
	receiver: "sources",
	system: "resources",
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed.kind === "help") {
	process.stdout.write(HELP_TEXT)
	process.exit(0)
}
if (parsed.kind === "error") {
	process.stderr.write(`${parsed.message}\n`)
	process.exit(2)
}
try {
	resolveExplicit(parsed.api, process.env)
} catch (err: unknown) {
	process.stderr.write(`wavekit: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(2)
}

setGlyphMode(detectGlyphMode(process.env))
const screen = createScreen(process.stdout)
screen.enter()
const instance = render(<LegacyApp initialView={LEGACY_VIEW[parsed.view]} />)
let done = false
const shutdown = (code: number): void => {
	if (done) return
	done = true
	instance.unmount()
	screen.restore()
	process.exit(code)
}
installExitHandlers(process, screen, shutdown)
void instance.waitUntilExit().then(() => shutdown(0))
```

- [ ] **Step 5: Run the tests, build and exercise the entry**

```bash
pnpm exec vitest run tests/unit/cli/terminal.test.ts
pnpm --filter @wavekit/cli build
node cli/dist/cli.js --help | head -3
node cli/dist/cli.js --view nope; echo "exit=$?"
node cli/dist/cli.js --api http://127.0.0.1:4713; echo "exit=$?"
```
Expected: PASS, then the help header, then `wavekit: invalid view "nope" · valid views: …` with `exit=2`, then `wavekit: port 4713 is the RTL-TCP relay…` with `exit=2`.

- [ ] **Step 6: Commit**

```bash
git add cli/source/terminal.ts cli/source/cli.tsx tests/unit/cli/terminal.test.ts
git commit -m "feat(cli): alt screen with restore on exit/signals/crash; new arg handling

cli.tsx keeps the legacy App until the phase-2 shell lands.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 32: Tuner edit state machine (C)

**Owner:** C · **Spec:** §6.4 edit mode, fields, review confirm; research (b) tuner bodies and ranges

**Files:**
- Create: `cli/source/ui/tuner-edit.ts`
- Test: `tests/unit/cli/tuner-edit.test.ts`

**Interfaces:**
- Consumes: `TunerState` (api-types), `TunerCommand` (Task 2), `EditKey` (Task 2), `EditField`, `TunerDraft`, `TunerEditState` (Task 2).
- Produces:
  - `VALID_SAMPLE_RATES`, `FIELD_ORDER`, `SEND_ORDER`, `FREQ_MIN = 24_000_000`, `FREQ_MAX = 1_900_000_000`, `GAIN_MAX = 500`, `PPM_LIMIT = 500`, `FREQ_DIGITS = 10`
  - `draftFromTuner(t: TunerState): TunerDraft`, `startEdit(t: TunerState): TunerEditState`. Editing starts on frequency with the cursor on the 1 kHz digit (`digit: 3`).
  - `applyEditKey(s: TunerEditState, key: EditKey): TunerEditState`
  - `interface PendingChange { field: EditField; from: number | string | boolean; to: number | string | boolean }`, `pendingChanges(s): PendingChange[]` (in `SEND_ORDER`)
  - `pendingCommands(s): TunerCommand[]`, `turnsBiasTeeOn(s): boolean`, `editWindow(s): { centreHz: number; sampleRate: number }`, `digitAt(n: number, digit: number): number`

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/tuner-edit.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { FREQ_MAX, applyEditKey, pendingChanges, pendingCommands, startEdit, turnsBiasTeeOn } from "../../../cli/source/ui/tuner-edit.js"
import type { EditKey } from "../../../cli/source/ui/actions.js"

const tuner: TunerState = {
	sourceId: "pi-iq", frequency: 445_970_700, sampleRate: 2_048_000, gainMode: "manual", gain: 0, ppm: 0,
	agcMode: false, biasTee: false, directSampling: "off", offsetTuning: false, ifGain: 0, tunerIfGain: null,
	testMode: false, controlMode: "internal", commandCount: 0,
}
const press = (keys: EditKey[], s = startEdit(tuner)) => keys.reduce(applyEditKey, s)

describe("tuner edit", () => {
	it("sends nothing until something changed", () => {
		expect(pendingCommands(startEdit(tuner))).toEqual([])
	})
	it("moves a digit cursor, changes digits and types over them", () => {
		let s = press(["up"])
		expect(s.draft.frequency).toBe(445_971_700)
		s = press(["left", "left", "5"])
		expect(s.draft.frequency).toBe(445_570_700)
		expect(s.digit).toBe(4)
		s = press(["right", "backspace"])
		expect(s.draft.frequency).toBe(445_970_000)
		expect(s.digit).toBe(3)
	})
	it("clamps the frequency to the server range", () => {
		const s = press(Array.from({ length: 12 }, () => "left" as const).concat(["up", "up", "up"]))
		expect(s.draft.frequency).toBeLessThanOrEqual(FREQ_MAX)
	})
	it("cycles fields and edits sample rate, gain and toggles", () => {
		let s = press(["tab", "up"])
		expect(s.field).toBe("sampleRate")
		expect(s.draft.sampleRate).toBe(2_160_000)
		s = press(["tab", "up"], s)
		expect(s.field).toBe("gain")
		expect(s.draft.gainTenthsDb).toBe(1)
		s = press(["tab", "tab", "space"], s)
		expect(s.field).toBe("gainMode")
		expect(s.draft.gainMode).toBe("agc")
	})
	it("orders commands frequency → sample rate → gain mode → gain → … and skips gain under AGC", () => {
		let s = press(["up", "tab", "up", "tab", "up"])
		expect(pendingCommands(s).map(c => c.setting)).toEqual(["frequency", "sample-rate", "gain"])
		expect(pendingCommands(s)[2]?.body).toEqual({ tenthsDb: 1 })
		s = press(["tab", "tab", "space"], s)
		expect(pendingCommands(s).map(c => c.setting)).toEqual(["frequency", "sample-rate", "gain-mode"])
		expect(pendingChanges(s).find(c => c.field === "gainMode")).toEqual({ field: "gainMode", from: "manual", to: "agc" })
	})
	it("flags turning bias-t on", () => {
		const s = press(["tab", "tab", "tab", "tab", "tab", "tab", "space"])
		expect(s.field).toBe("biasTee")
		expect(turnsBiasTeeOn(s)).toBe(true)
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/tuner-edit.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/ui/tuner-edit.ts`**

```ts
import type { TunerState } from "@wavekit/api-types"
import type { TunerCommand } from "../data/types.js"
import type { EditKey } from "./actions.js"
import type { EditField, TunerDraft, TunerEditState } from "./ui-state.js"

/** RTL-SDR rates the CLI offers; core only range-checks 225 001–3 200 000. */
export const VALID_SAMPLE_RATES: readonly number[] = [
	250_000, 1_024_000, 1_536_000, 1_792_000, 1_920_000, 2_048_000, 2_160_000, 2_400_000, 2_560_000, 2_880_000, 3_200_000,
]
export const FIELD_ORDER: readonly EditField[] = ["frequency", "sampleRate", "gain", "ppm", "gainMode", "agc", "biasTee", "directSampling", "offsetTuning"]
export const SEND_ORDER: readonly EditField[] = ["frequency", "sampleRate", "gainMode", "gain", "ppm", "agc", "biasTee", "directSampling", "offsetTuning"]
export const FREQ_MIN = 24_000_000
export const FREQ_MAX = 1_900_000_000
export const GAIN_MAX = 500
export const PPM_LIMIT = 500
export const FREQ_DIGITS = 10

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function draftFromTuner(t: TunerState): TunerDraft {
	return {
		frequency: t.frequency,
		sampleRate: t.sampleRate,
		gainTenthsDb: t.gain,
		ppm: t.ppm,
		gainMode: t.gainMode,
		agc: t.agcMode,
		biasTee: t.biasTee,
		directSampling: t.directSampling,
		offsetTuning: t.offsetTuning,
	}
}

export function startEdit(t: TunerState): TunerEditState {
	const d = draftFromTuner(t)
	return { sourceId: t.sourceId, original: d, draft: { ...d }, field: "frequency", digit: 3 }
}

export function digitAt(n: number, digit: number): number {
	return Math.floor(n / 10 ** digit) % 10
}

function setDigit(n: number, digit: number, value: number): number {
	return n - digitAt(n, digit) * 10 ** digit + value * 10 ** digit
}

function nextRate(rate: number, dir: 1 | -1): number {
	let idx = VALID_SAMPLE_RATES.indexOf(rate)
	if (idx < 0) {
		idx = 0
		VALID_SAMPLE_RATES.forEach((r, i) => {
			if (Math.abs(r - rate) < Math.abs((VALID_SAMPLE_RATES[idx] ?? r) - rate)) idx = i
		})
	} else {
		idx = clamp(idx + dir, 0, VALID_SAMPLE_RATES.length - 1)
	}
	return VALID_SAMPLE_RATES[idx] ?? rate
}

function toggle(d: TunerDraft, field: EditField): TunerDraft {
	switch (field) {
		case "gainMode":
			return { ...d, gainMode: d.gainMode === "manual" ? "agc" : "manual" }
		case "agc":
			return { ...d, agc: !d.agc }
		case "biasTee":
			return { ...d, biasTee: !d.biasTee }
		case "offsetTuning":
			return { ...d, offsetTuning: !d.offsetTuning }
		case "directSampling":
			return { ...d, directSampling: d.directSampling === "off" ? "i" : d.directSampling === "i" ? "q" : "off" }
		default:
			return d
	}
}

export function applyEditKey(s: TunerEditState, key: EditKey): TunerEditState {
	const d = s.draft
	if (key === "tab") {
		const i = FIELD_ORDER.indexOf(s.field)
		let next = FIELD_ORDER[(i + 1) % FIELD_ORDER.length] ?? "frequency"
		if (next === "gain" && d.gainMode === "agc") next = "ppm"
		return { ...s, field: next }
	}
	if (key === "space") return { ...s, draft: toggle(d, s.field) }
	const dir: 1 | -1 | 0 = key === "up" ? 1 : key === "down" ? -1 : 0
	switch (s.field) {
		case "frequency": {
			if (key === "left") return { ...s, digit: Math.min(FREQ_DIGITS - 1, s.digit + 1) }
			if (key === "right") return { ...s, digit: Math.max(0, s.digit - 1) }
			if (key === "backspace") {
				return { ...s, draft: { ...d, frequency: clamp(setDigit(d.frequency, s.digit, 0), FREQ_MIN, FREQ_MAX) }, digit: Math.min(FREQ_DIGITS - 1, s.digit + 1) }
			}
			if (dir !== 0) return { ...s, draft: { ...d, frequency: clamp(d.frequency + dir * 10 ** s.digit, FREQ_MIN, FREQ_MAX) } }
			if (/^[0-9]$/.test(key)) {
				return { ...s, draft: { ...d, frequency: clamp(setDigit(d.frequency, s.digit, Number(key)), FREQ_MIN, FREQ_MAX) }, digit: Math.max(0, s.digit - 1) }
			}
			return s
		}
		case "sampleRate":
			return dir === 0 ? s : { ...s, draft: { ...d, sampleRate: nextRate(d.sampleRate, dir) } }
		case "gain":
			return dir === 0 || d.gainMode !== "manual" ? s : { ...s, draft: { ...d, gainTenthsDb: clamp(d.gainTenthsDb + dir, 0, GAIN_MAX) } }
		case "ppm":
			return dir === 0 ? s : { ...s, draft: { ...d, ppm: clamp(d.ppm + dir, -PPM_LIMIT, PPM_LIMIT) } }
		default:
			return dir === 0 ? s : { ...s, draft: toggle(d, s.field) }
	}
}

export interface PendingChange {
	field: EditField
	from: number | string | boolean
	to: number | string | boolean
}

const VALUE: Readonly<Record<EditField, (d: TunerDraft) => number | string | boolean>> = {
	frequency: d => d.frequency,
	sampleRate: d => d.sampleRate,
	gain: d => d.gainTenthsDb,
	ppm: d => d.ppm,
	gainMode: d => d.gainMode,
	agc: d => d.agc,
	biasTee: d => d.biasTee,
	directSampling: d => d.directSampling,
	offsetTuning: d => d.offsetTuning,
}

export function pendingChanges(s: TunerEditState): PendingChange[] {
	const out: PendingChange[] = []
	for (const field of SEND_ORDER) {
		if (field === "gain" && s.draft.gainMode !== "manual") continue
		const from = VALUE[field](s.original)
		const to = VALUE[field](s.draft)
		if (from !== to) out.push({ field, from, to })
	}
	return out
}

const COMMAND: Readonly<Record<EditField, (d: TunerDraft) => TunerCommand>> = {
	frequency: d => ({ setting: "frequency", body: { hz: d.frequency }, label: "frequency" }),
	sampleRate: d => ({ setting: "sample-rate", body: { hz: d.sampleRate }, label: "sample rate" }),
	gainMode: d => ({ setting: "gain-mode", body: { mode: d.gainMode }, label: "gain mode" }),
	gain: d => ({ setting: "gain", body: { tenthsDb: d.gainTenthsDb }, label: "gain" }),
	ppm: d => ({ setting: "ppm", body: { ppm: d.ppm }, label: "ppm" }),
	agc: d => ({ setting: "agc", body: { enabled: d.agc }, label: "rtl agc" }),
	biasTee: d => ({ setting: "bias-tee", body: { enabled: d.biasTee }, label: "bias-t" }),
	directSampling: d => ({ setting: "direct-sampling", body: { mode: d.directSampling }, label: "direct sampling" }),
	offsetTuning: d => ({ setting: "offset-tuning", body: { enabled: d.offsetTuning }, label: "offset tuning" }),
}

export function pendingCommands(s: TunerEditState): TunerCommand[] {
	return pendingChanges(s).map(c => COMMAND[c.field](s.draft))
}

export function turnsBiasTeeOn(s: TunerEditState): boolean {
	return !s.original.biasTee && s.draft.biasTee
}

export function editWindow(s: TunerEditState): { centreHz: number; sampleRate: number } {
	return { centreHz: s.draft.frequency, sampleRate: s.draft.sampleRate }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run tests/unit/cli/tuner-edit.test.ts`
Expected: PASS. Trace the `left, left, 5` case: the cursor moves 3 → 5, `5` writes the 100 kHz digit (445 **9**70 700 becomes 445 **5**70 700), and the cursor moves to 4.

- [ ] **Step 5: Commit**

```bash
git add cli/source/ui/tuner-edit.ts tests/unit/cli/tuner-edit.test.ts
git commit -m "feat(cli): tuner edit state machine producing ordered pending commands

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 33: tmux validation script (C)

**Owner:** C · **Spec:** §13.4

**Files:**
- Create: `cli/tools/validate/matrix.sh` (mode 755)

**Interfaces:**
- Consumes: the built CLI (`cli/dist/cli.js`), the mock server (Task 29), and the scenarios (Task 28).
- Produces: `cli/tools/validate/matrix.sh [all|matrix|resize|transitions|perf]`. It writes captures and `perf.md` under `${WAVEKIT_VALIDATE_OUT:-$TMPDIR/wavekit-cli-validate}` and exits non-zero if any check fails. Task 45 runs it. It is written now so phase 2 can use `matrix` mode as soon as views land.

- [ ] **Step 1: Write `cli/tools/validate/matrix.sh`**

```bash
#!/usr/bin/env bash
# WaveKit CLI validation (spec §13.4): tmux capture matrix, resize, transitions,
# sustained flow and cost. Talks ONLY to the local mock core; never point it at
# a live core and never run it with write keys against one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="${WAVEKIT_VALIDATE_OUT:-${TMPDIR:-/tmp}/wavekit-cli-validate}"
PORT="${WAVEKIT_MOCK_PORT:-9100}"
API="http://127.0.0.1:${PORT}"
SESSION="wkv-$$"
MODE="${1:-all}"
SCENARIOS=(live idle api-down api-down-cached ws-only rest-only dropping crash-loop legacy long-text burst)
VIEWS=(overview decoders messages receiver system)
SIZES=(60x16 60x20 80x24 120x40 200x50)
FAILS=0

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
need tmux; need node; need curl; need perl; need bc
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' \
	|| { echo "node >= 22.18 required for type stripping (have $(node --version))" >&2; exit 1; }

mkdir -p "$OUT"
CHECK="$OUT/check-capture.mjs"
cat >"$CHECK" <<'JS'
// usage: node check-capture.mjs <file> <cols> <rows>
import { readFileSync } from "node:fs"
const [file, cols, rows] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])]
const lines = readFileSync(file, "utf8").replace(/\n$/, "").split("\n")
const wide = cp => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
const width = s => [...s].reduce((w, ch) => w + (/\p{Mn}/u.test(ch) ? 0 : wide(ch.codePointAt(0)) ? 2 : 1), 0)
// Keep in sync with cli/source/ui/copy-rules.ts
const banned = [/\bWaiting for\b/i, /\bNo\b.*\byet\b/, /\bLoading\b/i, /\bOK\b/, /\b(?:un)?healthy\b/i, /\bstable\b/i, /\ball good\b/i, /\bStatus:/, /\bn\/a\b/i, /\bunavailable\b(?! ·)/i, /\bsuccessfully\b/i, /\bplease\b/i, /[A-Za-z0-9)]!(?=\s|$)/, /360°/, /\bpress \S+ to view\b/i, /\bConnected\b/, /\bslow\b/i, /\blagging\b/i, /\boverloaded\b/i, /\bbottleneck\b/i, /\p{Emoji_Presentation}/u]
const errs = []
lines.forEach((l, i) => {
	if (width(l) > cols) errs.push(`line ${i + 1} is ${width(l)} wide (> ${cols})`)
	const plain = l.replace(/"[^"\n]*"/g, '""')
	for (const re of banned) if (re.test(plain)) errs.push(`line ${i + 1} has banned copy ${re}`)
})
const used = lines.length - [...lines].reverse().findIndex(l => l.trim() !== "")
if (lines.some(l => l.trim() !== "") && used > rows - 1) errs.push(`frame uses ${used} rows (> ${rows - 1})`)
if (errs.length) {
	console.error(`FAIL ${file}\n  ${errs.join("\n  ")}`)
	process.exit(1)
}
JS

ms() { perl -MTime::HiRes=time -e 'printf "%d", time*1000'; }
mock() { curl -fsS -X POST -H 'content-type: application/json' -d "$2" "$API/__mock/$1" >/dev/null; }
capture() { tmux capture-pane -p -t "$SESSION" >"$1.txt"; tmux capture-pane -p -e -t "$SESSION" >"$1.ansi"; }
check() { node "$CHECK" "$1.txt" "$2" "$3" || FAILS=$((FAILS + 1)); }
start_cli() { # cols rows view
	tmux kill-session -t "$SESSION" 2>/dev/null || true
	tmux new-session -d -s "$SESSION" -x "$1" -y "$2" "exec env WAVEKIT_API_URL=$API node $ROOT/cli/dist/cli.js --view $3"
	sleep 2
}
cli_pid() { tmux list-panes -t "$SESSION" -F '#{pane_pid}' | head -1; }

pnpm --filter @wavekit/cli build >/dev/null
node "$ROOT/cli/source/test/mock-api/server.ts" --port "$PORT" --scenario live >"$OUT/mock.log" 2>&1 &
MOCK_PID=$!
cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 50); do curl -fsS "$API/health" >/dev/null 2>&1 && break; sleep 0.1; done

run_matrix() {
	for sc in "${SCENARIOS[@]}"; do
		mock scenario "{\"name\":\"$sc\"}"
		case "$sc" in
			api-down|api-down-cached) mock rest '{"mode":"fail"}'; mock ws '{"mode":"refuse"}' ;;
			ws-only) mock rest '{"mode":"hang"}'; mock ws '{"mode":"up"}' ;;
			rest-only) mock rest '{"mode":"ok"}'; mock ws '{"mode":"refuse"}' ;;
			*) mock rest '{"mode":"ok"}'; mock ws '{"mode":"up"}' ;;
		esac
		for size in "${SIZES[@]}"; do
			cols="${size%x*}"; rows="${size#*x}"
			for view in "${VIEWS[@]}"; do
				start_cli "$cols" "$rows" "$view"
				f="$OUT/matrix-$sc-$view-$size"
				capture "$f"
				check "$f" "$cols" "$rows"
			done
		done
	done
	mock rest '{"mode":"ok"}'; mock ws '{"mode":"up"}'; mock scenario '{"name":"live"}'
}

run_resize() {
	start_cli 120 40 overview
	i=0
	for size in 120x40 60x20 200x50 80x24 59x15 120x40; do
		cols="${size%x*}"; rows="${size#*x}"; i=$((i + 1))
		tmux resize-window -t "$SESSION" -x "$cols" -y "$rows"
		sleep 0.3; capture "$OUT/resize-$i-$size-0.3s"
		sleep 1.7; capture "$OUT/resize-$i-$size-2s"
		if [ "$size" = "59x15" ]; then
			grep -q "too small (minimum 60×16)" "$OUT/resize-$i-$size-2s.txt" || { echo "FAIL resize: no too-small line at 59x15" >&2; FAILS=$((FAILS + 1)); }
		else
			check "$OUT/resize-$i-$size-2s" "$cols" "$rows"
		fi
	done
}

run_transitions() {
	start_cli 120 40 overview
	capture "$OUT/transition-0-live"
	mock ws '{"mode":"drop"}'; sleep 16; capture "$OUT/transition-1-ws-drop"
	grep -q "gap since" "$OUT/transition-1-ws-drop.txt" || { echo "FAIL transitions: no open gap after ws drop" >&2; FAILS=$((FAILS + 1)); }
	mock ws '{"mode":"up"}'; sleep 8; capture "$OUT/transition-2-ws-up"
	grep -q "not replayed" "$OUT/transition-2-ws-up.txt" || { echo "FAIL transitions: gap did not close" >&2; FAILS=$((FAILS + 1)); }
	mock rest '{"mode":"hang"}'; sleep 20; capture "$OUT/transition-3-rest-hang"
	grep -q "REST failing" "$OUT/transition-3-rest-hang.txt" || { echo "FAIL transitions: no REST banner" >&2; FAILS=$((FAILS + 1)); }
	mock rest '{"mode":"ok"}'; sleep 8; capture "$OUT/transition-4-rest-ok"
}

perf_run() { # name view burstPerSecond pause
	local name="$1" view="$2" rate="$3" pause="$4" log="$OUT/perf-$1.tty" samples="$OUT/perf-$1.samples"
	: >"$log"; : >"$samples"
	start_cli 120 40 "$view"
	[ "$pause" = "yes" ] && tmux send-keys -t "$SESSION" p
	tmux pipe-pane -o -t "$SESSION" "cat >> $log"
	[ "$rate" -gt 0 ] && mock burst "{\"perSecond\":$rate,\"seconds\":60}"
	local pid; pid="$(cli_pid)"
	for _ in $(seq 1 60); do ps -o %cpu=,rss= -p "$pid" >>"$samples" || true; sleep 1; done
	local t0; t0="$(ms)"; tmux send-keys -t "$SESSION" 2
	local tries=0
	until tmux capture-pane -p -t "$SESSION" | grep -q "DECODERS" || [ "$tries" -ge 200 ]; do sleep 0.05; tries=$((tries + 1)); done
	local latency=$(( $(ms) - t0 ))
	tmux pipe-pane -t "$SESSION"
	local frames clears cpu rss0 rss1
	frames=$(grep -o ' api ' "$log" | wc -l | tr -d ' ')
	clears=$(grep -c $'\x1b\\[2J' "$log" || true)
	cpu=$(awk '{s+=$1} END {printf "%.1f", s/NR}' "$samples")
	rss0=$(head -1 "$samples" | awk '{print $2}'); rss1=$(tail -1 "$samples" | awk '{print $2}')
	printf '| %s | %.1f | %s | %s %% | %s MB | %s ms |\n' "$name" "$(echo "$frames / 60" | bc -l)" "$clears" "$cpu" "$(( (rss1 - rss0) / 1024 ))" "$latency" >>"$OUT/perf.md"
}

run_perf() {
	printf '| run | frames/s | ESC[2J | CPU avg | RSS growth | key→frame |\n|---|---|---|---|---|---|\n' >"$OUT/perf.md"
	perf_run idle-live overview 0 no
	perf_run burst-50 overview 50 no
	perf_run burst-500 messages 500 no
	perf_run burst-500-paused messages 500 yes
	cat "$OUT/perf.md"
}

case "$MODE" in
	all) run_matrix; run_resize; run_transitions; run_perf ;;
	matrix) run_matrix ;;
	resize) run_resize ;;
	transitions) run_transitions ;;
	perf) run_perf ;;
	*) echo "usage: $0 [all|matrix|resize|transitions|perf]" >&2; exit 2 ;;
esac
echo "captures in $OUT · failed checks: $FAILS"
exit $(( FAILS > 0 ? 1 : 0 ))
```

- [ ] **Step 2: Make it executable and lint it**

```bash
chmod +x cli/tools/validate/matrix.sh
bash -n cli/tools/validate/matrix.sh && echo syntax-ok
command -v shellcheck >/dev/null && shellcheck cli/tools/validate/matrix.sh || true
```
Expected: `syntax-ok`. Fix any shellcheck errors. Warnings about intentional word-splitting in `seq` loops can stay.

- [ ] **Step 3: Smoke the resize mode against the legacy UI**

Run: `cli/tools/validate/matrix.sh resize; echo "exit=$?"`
Expected: it runs to completion and writes captures under `$TMPDIR/wavekit-cli-validate`. A non-zero exit is expected until phase 2 replaces the legacy UI, so record the failures in the commit message rather than fixing them here.

- [ ] **Step 4: Run the phase 1 gate (C's part) and commit**

```bash
pnpm exec vitest run tests/unit/cli
pnpm --filter @wavekit/cli test && pnpm --filter @wavekit/cli typecheck
git add cli/tools/validate/matrix.sh
git commit -m "test(cli): tmux matrix/resize/transition/perf validation script (mock core only)

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

## Phase 2 — views, in parallel

Phase 2 starts after the phase 1 gate. Each implementer owns its view-models, views and tests. View render tests use `renderApp` from Task 37 and the scenarios through `scenarioState(name, { summarize: formatMessage })`.

### Task 34: Shared decoder and message row builders (B, first)

**Owner:** B · **Spec:** §5.3 column specs, §6.1/§6.2 table content, §10.7 cells, §6.3 rows and gaps

**Files:**
- Create: `cli/source/view-models/decoder-rows.ts`
- Create: `cli/source/view-models/message-rows.ts`
- Test: `tests/unit/cli/decoder-rows.test.ts`
- Test: `tests/unit/cli/message-rows.test.ts`

**Interfaces:**
- Consumes: Phase 1 data and ui modules.
- Produces:
  - `decoder-rows.ts`:
    ```ts
    interface DecoderFacts {
    	row: DecoderRow; proc: ProcState; role: GlyphRole; failing: boolean
    	decodes: DecodesFact; ratePerSec: number | null; lastAt: number | null
    	branch: BranchTelemetry | null; dropNow: number | null; backpressure: boolean; lifetime: number | null
    	membership: Membership; nominal: string; oldRest: boolean
    }
    decoderFacts(state: AppState): DecoderFacts[]                // memoised on the slices it reads
    decoderCells(f: DecoderFacts, now: number): Record<string, Cell>
    OVERVIEW_COLUMNS: ColumnSpec[]; DECODERS_COLUMNS: ColumnSpec[]
    interface DecoderTable { header: Line; rows: Line[]; shownIds: string[] }
    decoderTable(facts: readonly DecoderFacts[], columns: readonly ColumnSpec[], width: number, maxRows: number, selectedId: string | null, now: number): DecoderTable
    decodersPlaceholder(state: AppState): Line | null            // "fetching /api/decoders" | "no data · API unreachable" | "no decoders configured" | null
    ```
  - `message-rows.ts`:
    ```ts
    MESSAGE_COLUMNS: ColumnSpec[]; messageLayout(width: number): ColumnLayout[]   // narrow (< 79) drops the type column
    type FeedRow = { kind: "msg"; entry: MessageEntry } | { kind: "gap"; gap: Gap }
    newestFirst(ring: MessageRing): MessageEntry[]
    interleave(entriesNewestFirst: readonly MessageEntry[], gaps: readonly Gap[]): FeedRow[]
    summaryLine(fm: FormattedMessage, width: number): Line
    messageRow(e: MessageEntry, layout: readonly ColumnLayout[], selected: boolean, old: boolean): Line
    gapLine(g: Gap, now: number, width: number): Line
    feedCounts(ring: MessageRing, now: number): { in60s: number; total: number; cached: number }
    feedLines(rows: readonly FeedRow[], width: number, maxRows: number, selectedSeq: number | null, now: number, old: boolean): { lines: Line[]; shownSeqs: number[] }
    ```

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/decoder-rows.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { DECODERS_COLUMNS, OVERVIEW_COLUMNS, decoderFacts, decoderTable, decodersPlaceholder } from "../../../cli/source/view-models/decoder-rows.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("decoder rows (live fixture)", () => {
	const s = scenarioState("live", { summarize: formatMessage })
	const facts = decoderFacts(s)
	it("derives process, decodes, drops and window per decoder", () => {
		const by = (id: string) => facts.find(f => f.row.id === id)!
		expect(by("acarsdec")).toMatchObject({ proc: "down", failing: true, dropNow: null, membership: "out" })
		expect(by("readsb")).toMatchObject({ proc: "up", backpressure: true, membership: "out" })
		expect(by("readsb").dropNow).toBeCloseTo(0.38, 3)
		expect(by("dsd-fme")).toMatchObject({ membership: "in", nominal: "tuned" })
		expect(by("dsd-fme").ratePerSec).toBeGreaterThan(0)
	})
	it("renders the 120-column overview table like spec §6.1", () => {
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 119, 20, null, s.now)
		expect(lineText(t.header)).toMatch(/DECODERS +process +decodes +drop now +lifetime +nominal MHz +window/)
		const acars = t.rows.map(lineText).find(r => r.includes("acarsdec")) ?? ""
		expect(acars).toMatch(/× acarsdec +down · 13 restarts +— +— +— +131\.550–131\.825 +out/)
		const readsb = t.rows.map(lineText).find(r => r.includes("readsb")) ?? ""
		expect(readsb).toMatch(/● readsb +up 51s +none for 51s +!38% +44% +1090\.000 +out/)
		for (const r of t.rows) expect(lineWidth(r)).toBeLessThanOrEqual(119)
	})
	it("drops lifetime and nominal at 60 columns and marks hidden rows", () => {
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 59, 5, null, s.now)
		expect(lineText(t.header)).not.toContain("lifetime")
		expect(lineText(t.header)).not.toContain("nominal")
		expect(t.rows).toHaveLength(5)
		expect(lineText(t.rows[4] ?? [])).toContain("+5 more")
		expect(t.shownIds).toHaveLength(4)
	})
	it("hides nominal first in the Decoders view at 120 columns", () => {
		const t = decoderTable(facts, DECODERS_COLUMNS, 119, 20, "readsb", s.now)
		expect(lineText(t.header)).toMatch(/restarts +errors +decodes +events +IQ in +drop now +lifetime +window/)
		expect(lineText(t.header)).not.toContain("nominal")
	})
	it("keeps the selected row visible when rows are hidden", () => {
		const t = decoderTable(facts, OVERVIEW_COLUMNS, 79, 4, "lora-meshtastic", s.now)
		expect(t.shownIds).toContain("lora-meshtastic")
	})
	it("never shows zero for unknown drops (legacy core)", () => {
		const legacy = decoderFacts(scenarioState("legacy"))
		const t = decoderTable(legacy, OVERVIEW_COLUMNS, 119, 20, null, scenarioState("legacy").now)
		const dsd = t.rows.map(lineText).find(r => r.includes("dsd-fme")) ?? ""
		expect(dsd).toMatch(/\?/)
		expect(dsd).not.toMatch(/ 0% /)
	})
	it("explains missing decoder data", () => {
		expect(lineText(decodersPlaceholder(scenarioState("api-down")) ?? [])).toBe("no data · API unreachable")
		expect(decodersPlaceholder(scenarioState("live"))).toBeNull()
	})
})
```

`tests/unit/cli/message-rows.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"
import { feedCounts, feedLines, gapLine, interleave, messageLayout, messageRow, newestFirst, summaryLine } from "../../../cli/source/view-models/message-rows.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("message rows", () => {
	const s = scenarioState("live", { summarize: formatMessage })
	const entries = newestFirst(s.messages.ring)
	it("orders newest first and counts the last minute", () => {
		expect(entries[0]?.decoderId).toBe("dsd-fme")
		expect(feedCounts(s.messages.ring, s.now)).toEqual({ in60s: 3, total: 7, cached: 7 })
	})
	it("renders time, decoder, type and a fitted summary", () => {
		const layout = messageLayout(119)
		const row = lineText(messageRow(entries[0]!, layout, false, false))
		expect(row).toMatch(/^18:07:41 +dsd-fme +DMR +TG 2350 +SRC 2341234/)
		const narrow = messageLayout(59)
		expect(narrow.map(c => c.id)).toEqual(["time", "decoder", "summary"])
		expect(lineText(messageRow(entries[0]!, narrow, false, false))).toMatch(/^18:07 +dsd-fme +TG 2350/)
		for (const e of entries) expect(lineWidth(messageRow(e, narrow, false, false))).toBeLessThanOrEqual(59)
	})
	it("cuts free text at the row end and marks dropped segments", () => {
		const pager = entries.find(e => e.formatted.text?.startsWith("FIRE"))!
		const line = lineText(summaryLine(pager.formatted, 40))
		expect(line.startsWith("1234567  fn 3  FIRE ALARM")).toBe(true)
		expect(line.endsWith("…")).toBe(true)
		const call = entries[0]!
		expect(lineText(summaryLine(call.formatted, 30)).endsWith("…")).toBe(true)
	})
	it("renders open and closed gaps", () => {
		const now = Date.parse("2026-10-08T18:10:11Z")
		expect(lineText(gapLine({ afterSeq: 1, from: Date.parse("2026-10-08T18:07:40Z"), to: null }, now, 80))).toBe("── gap since 18:07:40 · 2m 31s ──")
		expect(lineText(gapLine({ afterSeq: 1, from: Date.parse("2026-10-08T18:08:37Z"), to: Date.parse("2026-10-08T18:10:41Z") }, now, 80))).toBe("── gap 18:08:37–18:10:41 · 2m 04s · not replayed ──")
	})
	it("interleaves gaps by afterSeq and keeps the selection in view", () => {
		const rows = interleave(entries, [{ afterSeq: entries[3]!.seq, from: 1, to: 2 }])
		expect(rows[3]?.kind).toBe("gap")
		const out = feedLines(rows, 79, 3, entries[6]!.seq, s.now, false)
		expect(out.shownSeqs).toContain(entries[6]!.seq)
		expect(out.lines).toHaveLength(3)
	})
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run tests/unit/cli/decoder-rows.test.ts tests/unit/cli/message-rows.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `cli/source/view-models/decoder-rows.ts`**

```ts
import type { BranchTelemetry } from "@wavekit/api-types"
import { decodesFact, isFailing, lastDecodeAt, procRole, processState, type DecodesFact, type ProcState } from "../data/decoder-state.js"
import { isFresh, isOld } from "../data/freshness.js"
import { memoOne } from "../data/memo.js"
import { bandFor } from "../data/nominal-bands.js"
import { branchDropNow, counterRate, restartIncrements } from "../data/rates.js"
import type { AppState, DecoderRow, GlyphRole } from "../data/types.js"
import { decoderMembership, type Membership } from "../data/window.js"
import { layoutColumns, renderHeader, renderRow, type ColumnSpec } from "../ui/columns.js"
import { formatAge, formatBytes, formatCount, formatDuration, formatEventRate, formatPercent } from "../ui/format.js"
import { cell, sp, type Cell, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { glyphs } from "../ui/theme.js"

export interface DecoderFacts {
	row: DecoderRow
	proc: ProcState
	role: GlyphRole
	failing: boolean
	decodes: DecodesFact
	ratePerSec: number | null
	lastAt: number | null
	branch: BranchTelemetry | null
	dropNow: number | null
	backpressure: boolean
	lifetime: number | null
	membership: Membership
	nominal: string
	oldRest: boolean
}

const compute = memoOne(
	(
		decoders: AppState["decoders"],
		session: AppState["session"],
		fanout: AppState["fanout"],
		history: AppState["fanoutHistory"],
		sources: AppState["sources"],
		tuner: AppState["tuner"],
		relay: AppState["relay"],
		stopped: readonly string[],
		now: number,
	): DecoderFacts[] => {
		const rows = decoders.value ?? []
		const oldRest = isOld(decoders, now)
		const fanoutFresh = isFresh(fanout, now)
		return rows.map(row => {
			const sess = session[row.id]
			const inc = restartIncrements(sess?.restarts ?? [], now)
			const proc = processState(row, inc, stopped.includes(row.id))
			const ratePerSec = oldRest ? null : counterRate(sess?.events ?? [])
			const lastAt = lastDecodeAt(row, sess)
			const branch = fanout.value?.branches.find(b => b.decoderId === row.id) ?? null
			const dropNow = branch && row.running && fanoutFresh ? branchDropNow(history, branch.id) : null
			const offered = branch?.totalBytesWritten
			const band = bandFor(row.type)
			return {
				row,
				proc,
				role: procRole(proc),
				failing: isFailing(proc),
				decodes: decodesFact(row, ratePerSec, lastAt),
				ratePerSec,
				lastAt,
				branch,
				dropNow,
				backpressure: branch?.backpressureActive === true && fanoutFresh,
				lifetime: branch && offered !== undefined && offered > 0 ? branch.droppedBytesTotal / offered : null,
				membership: decoderMembership(row, sources.value, tuner.value, relay.value),
				nominal: band ? band.label : "?",
				oldRest,
			}
		})
	},
)

export function decoderFacts(state: AppState): DecoderFacts[] {
	return compute(
		state.decoders,
		state.session,
		state.fanout,
		state.fanoutHistory,
		state.sources,
		state.tuner,
		state.relay,
		state.actions.stoppedByCli,
		state.now,
	)
}

const PROC_ROLE: Readonly<Record<ProcState, Role>> = {
	faulted: "fault",
	"crash-loop": "fault",
	down: "fault",
	stopped: "neutral",
	starting: "neutral",
	up: "value",
}

function processCell(f: DecoderFacts): Cell {
	const role: Role = f.oldRest ? "old" : PROC_ROLE[f.proc]
	const n = f.row.restartCount
	const restarts = `${formatCount(n)} restart${n === 1 ? "" : "s"}`
	const sep = ` ${glyphs().sep} `
	const up = formatDuration(f.row.uptime)
	switch (f.proc) {
		case "up":
			return n > 0 ? cell([sp(`up ${up}`, role)], [sp(`up ${up}${sep}${restarts}`, role)]) : cell([sp(`up ${up}`, role)])
		case "starting":
			return cell([sp(`starting ${up}`, role)])
		case "stopped":
			return cell([sp("stopped", role)])
		default:
			return cell([sp(f.proc, role)], [sp(`${f.proc}${sep}${restarts}`, role)])
	}
}

function decodesCell(f: DecoderFacts, now: number): Cell {
	const role: Role = f.oldRest ? "old" : "value"
	const d = f.decodes
	const ago = (at: number): string => `${formatAge(now - at)} ago`
	switch (d.kind) {
		case "na":
			return cell([sp(glyphs().na, "label")])
		case "rate": {
			const rate = formatEventRate(d.perSec)
			return d.lastAt === null ? cell([sp(rate, role)]) : cell([sp(ago(d.lastAt), role)], [sp(`${rate} ${glyphs().sep} ${ago(d.lastAt)}`, role)])
		}
		case "last":
			return cell([sp(ago(d.lastAt), role)])
		case "none": {
			const dur = formatDuration(d.uptimeSec)
			return cell([sp(`none ${dur}`, f.oldRest ? "old" : "neutral")], [sp(`none for ${dur}`, f.oldRest ? "old" : "neutral")])
		}
		case "total":
			return cell([sp(`${formatCount(d.count)} total`, role)])
	}
}

function dropCell(f: DecoderFacts): Cell {
	if (!f.row.running) return cell([sp(glyphs().na, "label")])
	if (f.dropNow === null) return cell([sp("?", "unknown")])
	const pct = formatPercent(f.dropNow)
	return f.backpressure ? cell([sp(glyphs().attention, "attention"), sp(pct, "attention")]) : cell([sp(pct)])
}

function lifetimeCell(f: DecoderFacts): Cell {
	if (f.lifetime !== null) return cell([sp(formatPercent(f.lifetime))])
	return f.branch === null && !f.row.running ? cell([sp(glyphs().na, "label")]) : cell([sp("?", "unknown")])
}

export function decoderCells(f: DecoderFacts, now: number): Record<string, Cell> {
	return {
		glyph: cell([glyphSpan(f.role)]),
		decoder: cell([sp(f.row.id)]),
		process: processCell(f),
		decodes: decodesCell(f, now),
		drop: dropCell(f),
		lifetime: lifetimeCell(f),
		nominal: cell([sp(f.nominal, f.nominal === "?" ? "unknown" : "value")]),
		window: cell([sp(f.membership, f.membership === "?" ? "unknown" : f.membership === "—" ? "label" : "value")]),
		restarts: cell([sp(formatCount(f.row.restartCount))]),
		errors: cell([sp(formatCount(f.row.stats.errors))]),
		events: cell([sp(formatCount(f.row.stats.eventsOut))]),
		iq: cell([sp(formatBytes(f.row.stats.bytesIn))]),
	}
}

const header = (...variants: string[]): Cell => ({ variants: variants.map(v => [sp(v, "label")]) })
const col = (id: string, min: number, pref: number, priority: number, align: "left" | "right", head: Cell): ColumnSpec => ({ id, min, pref, priority, align, header: head })
const TITLE: Cell = { variants: [[sp("DECODERS", "label", true)]] }

/** Spec §5.3 (min/pref, priority in brackets). */
export const OVERVIEW_COLUMNS: ColumnSpec[] = [
	col("glyph", 1, 1, 0, "left", header("")),
	col("decoder", 12, 16, 0, "left", TITLE),
	col("process", 6, 18, 0, "left", header("process")),
	col("decodes", 8, 16, 1, "left", header("decodes")),
	col("drop", 4, 8, 1, "right", header("drop", "drop now")),
	col("lifetime", 8, 8, 4, "right", header("lifetime")),
	col("nominal", 15, 15, 3, "left", header("nominal MHz")),
	col("window", 6, 6, 2, "left", header("window")),
]

/**
 * Decoders view adds restarts/errors/events/IQ in. Nominal gets priority 7 so it drops first; its
 * band moves to the detail pane. The core columns use their pref widths as minimums, so the 120-column
 * layout matches spec §6.2 (nominal gone, every other column present).
 */
export const DECODERS_COLUMNS: ColumnSpec[] = [
	col("glyph", 1, 1, 0, "left", header("")),
	col("decoder", 16, 16, 0, "left", TITLE),
	col("process", 10, 10, 0, "left", header("process")),
	col("restarts", 8, 8, 5, "right", header("restarts")),
	col("errors", 6, 6, 5, "right", header("errors")),
	col("decodes", 15, 15, 1, "left", header("decodes")),
	col("events", 6, 6, 6, "right", header("events")),
	col("iq", 9, 9, 6, "right", header("IQ in")),
	col("drop", 8, 8, 1, "right", header("drop", "drop now")),
	col("lifetime", 8, 8, 4, "right", header("lifetime")),
	col("nominal", 15, 15, 7, "left", header("nominal MHz")),
	col("window", 6, 6, 2, "left", header("window")),
]

export interface DecoderTable {
	header: Line
	rows: Line[]
	shownIds: string[]
}

/** maxRows includes the "+N more" marker row; the selected row is always kept visible. */
export function decoderTable(
	facts: readonly DecoderFacts[],
	columns: readonly ColumnSpec[],
	width: number,
	maxRows: number,
	selectedId: string | null,
	now: number,
): DecoderTable {
	const layout = layoutColumns(width, columns)
	const fits = facts.length <= maxRows
	const visible = fits ? facts.length : Math.max(0, maxRows - 1)
	const sel = selectedId === null ? -1 : facts.findIndex(f => f.row.id === selectedId)
	const start = fits || sel < visible ? 0 : Math.min(sel - visible + 1, facts.length - visible)
	const shown = facts.slice(start, start + visible)
	const rows = shown.map(f => {
		const cells = decoderCells(f, now)
		if (f.row.id === selectedId) {
			cells["decoder"] = cell([sp(f.row.id, "selected", true)])
		}
		return renderRow(layout, cells)
	})
	if (!fits) rows.push([sp(`  +${facts.length - shown.length} more`, "label")])
	return { header: renderHeader(layout, columns), rows, shownIds: shown.map(f => f.row.id) }
}

/** Spec §9: cold start, API down without cache, REST 200 with []. */
export function decodersPlaceholder(state: AppState): Line | null {
	const lane = state.decoders
	if (lane.value !== undefined) return lane.value.length === 0 ? [sp("no decoders configured", "label")] : null
	if (lane.error || state.conn.rest.firstFailAt !== null) return [sp("no data · API unreachable", "label")]
	return [sp("fetching /api/decoders", "label")]
}
```

- [ ] **Step 4: Run the decoder-row tests**

Run: `pnpm exec vitest run tests/unit/cli/decoder-rows.test.ts`
Expected: PASS. readsb's drop now is Δd/Δo = 7 770 726 / 20 449 280 ≈ 0.380. acarsdec is `out` because its nominal channels (131.550–131.825 MHz) lie outside 444.947–446.995 MHz. The regexes use ` +` on purpose, so that only content and order are pinned and exact widths are not.

- [ ] **Step 5: Write `cli/source/view-models/message-rows.ts`**

```ts
import type { FormattedMessage, Gap, MessageEntry, MessageRing } from "../data/types.js"
import { layoutColumns, renderRow, type ColumnLayout, type ColumnSpec } from "../ui/columns.js"
import { fitGroups } from "../ui/fit.js"
import { formatAge, formatClock, formatClockShort } from "../ui/format.js"
import { cell, sp, type Cell, type Group, type Line, type Role, type Span } from "../ui/line.js"
import { lineWidth, truncate, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

const hdr = (v: string): Cell => ({ variants: [[sp(v, "label")]] })

/** Spec §5.3: time 5/8 [0] (HH:MM below pref) · decoder 10/12 [0] · type 6/6 [3] · summary flex min 10 [0]. */
export const MESSAGE_COLUMNS: ColumnSpec[] = [
	{ id: "time", min: 5, pref: 8, priority: 0, align: "left", header: hdr("") },
	{ id: "decoder", min: 10, pref: 12, priority: 0, align: "left", header: hdr("") },
	{ id: "type", min: 6, pref: 6, priority: 3, align: "left", header: hdr("") },
	{ id: "summary", min: 10, pref: 10, priority: 0, align: "left", flex: true, header: hdr("") },
]

/** Narrow width class (spec §6.1 60×20): no type column, minimal time. */
const NARROW_MESSAGE_COLUMNS: ColumnSpec[] = [
	{ id: "time", min: 5, pref: 5, priority: 0, align: "left", header: hdr("") },
	{ id: "decoder", min: 10, pref: 11, priority: 0, align: "left", header: hdr("") },
	{ id: "summary", min: 10, pref: 10, priority: 0, align: "left", flex: true, header: hdr("") },
]

export function messageLayout(width: number): ColumnLayout[] {
	return layoutColumns(width, width < 79 ? NARROW_MESSAGE_COLUMNS : MESSAGE_COLUMNS)
}

export type FeedRow = { kind: "msg"; entry: MessageEntry } | { kind: "gap"; gap: Gap }

export function newestFirst(ring: MessageRing): MessageEntry[] {
	return [...ring.entries].reverse()
}

/** A gap with afterSeq k sits between entries k+1 (above) and k (below); newest first. */
export function interleave(entries: readonly MessageEntry[], gaps: readonly Gap[]): FeedRow[] {
	const pending = [...gaps].sort((a, b) => b.afterSeq - a.afterSeq)
	const out: FeedRow[] = []
	for (const entry of entries) {
		while (pending.length > 0 && (pending[0]?.afterSeq ?? -1) >= entry.seq) {
			const g = pending.shift()
			if (g) out.push({ kind: "gap", gap: g })
		}
		out.push({ kind: "msg", entry })
	}
	for (const g of pending) out.push({ kind: "gap", gap: g })
	return out
}

const ellipsis = (): Span => ({ text: glyphs().ellipsis, role: "label" })

/** Fixed segments by priority (dropping is marked with "  …"); free text takes the rest and is cut at the row end. */
export function summaryLine(fm: FormattedMessage, width: number): Line {
	const groups: Group[] = fm.segments.map(s => ({ priority: s.priority, variants: [[sp(s.text, s.role ?? "value")]] }))
	if (fm.text === undefined) return fitGroups(groups, width, { dropMarker: ellipsis() })
	if (groups.length === 0) return [sp(truncate(fm.text, width))]
	const fixed = fitGroups(groups, Math.max(0, width - 12), { dropMarker: ellipsis() })
	const rest = width - lineWidth(fixed) - 2
	return rest > 0 ? truncateLine([...fixed, sp("  ", "label"), sp(truncate(fm.text, rest))], width) : fixed
}

export function messageRow(e: MessageEntry, layout: readonly ColumnLayout[], selected: boolean, old: boolean): Line {
	const roleOf = (r: Role): Role => (selected ? "selected" : old ? "old" : r)
	const summaryWidth = layout.find(c => c.id === "summary")?.width ?? 10
	const summary = summaryLine(e.formatted, summaryWidth)
	const cells: Record<string, Cell> = {
		time: cell([sp(formatClockShort(e.receivedAt), roleOf("label"))], [sp(formatClock(e.receivedAt), roleOf("label"))]),
		decoder: cell([sp(e.decoderId, roleOf("value"))]),
		type: cell([sp(e.formatted.protocol, roleOf("label"))]),
		summary: cell(old ? summary.map(x => ({ ...x, role: "old" as const })) : summary),
	}
	return renderRow(layout, cells)
}

export function gapLine(g: Gap, now: number, width: number): Line {
	const rule = glyphs().gap.repeat(2)
	const sep = glyphs().sep
	const text =
		g.to === null
			? `${rule} gap since ${formatClock(g.from)} ${sep} ${formatAge(now - g.from)} ${rule}`
			: `${rule} gap ${formatClock(g.from)}${glyphs().range}${formatClock(g.to)} ${sep} ${formatAge(g.to - g.from)} ${sep} not replayed ${rule}`
	return [sp(truncate(text, width), "label")]
}

export function feedCounts(ring: MessageRing, now: number): { in60s: number; total: number; cached: number } {
	let in60s = 0
	for (const e of ring.entries) if (e.receivedAt >= now - 60_000) in60s++
	return { in60s, total: ring.total, cached: ring.entries.length }
}

/** Render at most maxRows feed rows, scrolled so the selected message stays visible. */
export function feedLines(
	rows: readonly FeedRow[],
	width: number,
	maxRows: number,
	selectedSeq: number | null,
	now: number,
	old: boolean,
): { lines: Line[]; shownSeqs: number[] } {
	const layout = messageLayout(width)
	const sel = selectedSeq === null ? -1 : rows.findIndex(r => r.kind === "msg" && r.entry.seq === selectedSeq)
	const start = sel < maxRows ? 0 : sel - maxRows + 1
	const slice = rows.slice(start, start + Math.max(0, maxRows))
	return {
		lines: slice.map(r => (r.kind === "gap" ? gapLine(r.gap, now, width) : messageRow(r.entry, layout, r.entry.seq === selectedSeq, old))),
		shownSeqs: slice.flatMap(r => (r.kind === "msg" ? [r.entry.seq] : [])),
	}
}
```

- [ ] **Step 6: Run both tests and the root typecheck**

```bash
pnpm exec vitest run tests/unit/cli/decoder-rows.test.ts tests/unit/cli/message-rows.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: PASS and exit 0. The first entry's time `18:07:41` is its `receivedAt`: the WS base (now − 2 s) minus 9 s. Rows show the local receipt time.

- [ ] **Step 7: Commit**

```bash
git add cli/source/view-models/decoder-rows.ts cli/source/view-models/message-rows.ts tests/unit/cli/decoder-rows.test.ts tests/unit/cli/message-rows.test.ts
git commit -m "feat(cli): shared decoder table and message feed row builders

Spec §5.3 column specs; gap rows; summaries drop by priority with a marker.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 35: Chrome view-models: strip input, banner conditions, footer, confirm, switcher, help (A)

**Owner:** A · **Spec:** §4 strip inputs, §9 banner selection, §6.6 help overlay, §7 footer/confirm bar

**Files:**
- Create: `cli/source/view-models/chrome.ts`
- Create: `cli/source/view-models/help.ts`
- Test: `tests/unit/cli/chrome.test.ts`

**Interfaces:**
- Consumes: Phase 1 modules. It computes decoder counts directly from `data/decoder-state.ts` and `data/window.ts`, so it does not depend on Task 34.
- Produces:
  - `stripInput(state: AppState): StripInput`
  - `bannerConditions(state: AppState): BannerCondition[]`
  - `NOTICE_MS = 5000`, `footerWithNotice(ctx: KeyContext, notice: UiState["notice"], now: number, width: number): Line`
  - `confirmLine(c: ConfirmRequest, width: number): Line`
  - `switcherLine(view: ViewId, width: number): Line`
  - `helpLines(ctx: KeyContext, width: number, height: number, diag: { invalidFrames: number; rejectedItems: number }): Line[]` (in `help.ts`)

- [ ] **Step 1: Write the failing tests**

`tests/unit/cli/chrome.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import type { KeyContext } from "../../../cli/source/ui/keymap.js"
import { stripLine } from "../../../cli/source/ui/strip.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { bannerConditions, confirmLine, footerWithNotice, stripInput, switcherLine } from "../../../cli/source/view-models/chrome.js"
import { helpLines } from "../../../cli/source/view-models/help.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const ctx: KeyContext = {
	view: "decoders", confirm: null, help: true, input: false, edit: false, detail: false, heightClass: "roomy",
	v: { hasSelection: true, decoderRunning: true, control: null, audioRunning: null, paused: false },
}

describe("strip input", () => {
	it("derives the audit strip from the live fixture", () => {
		const s = scenarioState("live")
		const input = stripInput(s)
		expect(input.decoders).toEqual({ up: 8, total: 9, failing: 1, inWindow: 2 })
		expect(input.drops.backpressure).toBe(true)
		expect(input.drops.ratio).toBeCloseTo(0.2125, 3)
		expect(lineText(stripLine(input, 119))).toMatch(/^api ● 2s {2}iq ● streaming · 4\.1 MB\/s {2}rx 445\.971 MHz/)
	})
	it("reads crash-loop as failing and REST-down as a split api lane", () => {
		expect(stripInput(scenarioState("crash-loop")).decoders?.failing).toBe(1)
		expect(lineText(stripLine(stripInput(scenarioState("ws-only")), 79))).toMatch(/^api ws ● rest × 45s {2}iq ● receiving/)
		expect(lineText(stripLine(stripInput(scenarioState("api-down")), 79))).toMatch(/^api × .*decoders \?.*drops \?/)
	})
	it("summarises two sources with the worst state (review focus 5)", () => {
		const s = scenarioState("live")
		const src = s.sources.value![0]!
		const stale: ExtendedSourceStatus = { ...src, id: "pi-b", activity: { state: "stale", lastSampleAt: null, sampleAgeMs: 30000, timeoutMs: 10000 } }
		const two = { ...s, sources: laneOk([src, stale], s.now - 1000, "rest") }
		expect(lineText(stripLine(stripInput(two), 119))).toContain("iq × 1/2 streaming")
	})
})

describe("banner conditions", () => {
	it("maps connectivity states to one banner each", () => {
		expect(bannerConditions(scenarioState("live"))).toEqual([])
		expect(bannerConditions(scenarioState("api-down-cached"))[0]).toMatchObject({ kind: "api-down", reason: "ECONNREFUSED" })
		expect(bannerConditions(scenarioState("ws-only"))[0]).toMatchObject({ kind: "rest-down", reason: "timeout 2s" })
		expect(bannerConditions(scenarioState("rest-only"))[0]).toMatchObject({ kind: "ws-down", code: 1006 })
	})
})

describe("footer, confirm, switcher, help", () => {
	it("prepends a recent notice", () => {
		const out = lineText(footerWithNotice({ ...ctx, help: false, view: "receiver", v: { ...ctx.v, control: "external" } }, { text: "controlled externally · c to take control", at: 1000 }, 2000, 119))
		expect(out.startsWith("controlled externally · c to take control  c take control")).toBe(true)
	})
	it("renders the confirm bar with the prompt cut before the hints", () => {
		const c = { kind: "decoder" as const, prompt: "restart readsb · up 51s · pid 1531", yes: "restart", no: "cancel", intent: { kind: "decoder" as const, op: "restart" as const, decoderId: "readsb" } }
		expect(lineText(confirmLine(c, 119))).toBe("▶ restart readsb · up 51s · pid 1531   y restart  n cancel")
		const narrow = lineText(confirmLine(c, 40))
		expect(narrow.endsWith("y restart  n cancel")).toBe(true)
		expect(cellWidth(narrow)).toBeLessThanOrEqual(40)
	})
	it("highlights the active view", () => {
		const l = switcherLine("decoders", 119)
		expect(lineText(l)).toBe("1 Overview  2 Decoders  3 Messages  4 Receiver  5 System")
		expect(l.find(s => s.text === "Decoders")?.role).toBe("selected")
	})
	it("draws a 60-column help box with the legend and diagnostics", () => {
		const lines = helpLines(ctx, 119, 35, { invalidFrames: 2, rejectedItems: 1 }).map(lineText)
		expect(lines[0]).toMatch(/┌─ keys · Decoders ─+┐/)
		const box = lines.filter(l => l.trim() !== "")
		for (const l of box) expect(cellWidth(l.trimStart())).toBe(60)
		expect(lines.join("\n")).toContain("nominal  band from WaveKit's built-in table, not the API")
		expect(lines.join("\n")).toContain("frames rejected 2 · items rejected 1")
		expect(findBanned(lines.join("\n"))).toEqual([])
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/chrome.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `cli/source/view-models/chrome.ts`**

```ts
import { isFailing, processState } from "../data/decoder-state.js"
import { apiView, iqSummary, isFresh, isOld } from "../data/freshness.js"
import { aggregateDropNow, restartIncrements } from "../data/rates.js"
import { ENDPOINT_PATHS, POLL_ENDPOINTS, type AppState, type Endpoint, type LaneError } from "../data/types.js"
import { decoderMembership } from "../data/window.js"
import { VIEW_ORDER, VIEW_TITLES, type ViewId } from "../ui/actions.js"
import type { BannerCondition } from "../ui/banner.js"
import { fitGroups } from "../ui/fit.js"
import { footerGroups, type KeyContext } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import type { StripInput } from "../ui/strip.js"
import { cellWidth, lineWidth, truncate, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"

export function stripInput(state: AppState): StripInput {
	const now = state.now
	const rows = state.decoders.value
	let decoders: StripInput["decoders"] = null
	if (rows !== undefined) {
		let up = 0
		let failing = 0
		let inWindow = 0
		let known = 0
		for (const d of rows) {
			const p = processState(d, restartIncrements(state.session[d.id]?.restarts ?? [], now), state.actions.stoppedByCli.includes(d.id))
			if (p === "up" || p === "starting") up++
			if (isFailing(p)) failing++
			const m = decoderMembership(d, state.sources.value, state.tuner.value, state.relay.value)
			if (m === "in") inWindow++
			if (m === "in" || m === "out") known++
		}
		decoders = { up, total: rows.length, failing, inWindow: known > 0 ? inWindow : null }
	}
	const agg = isFresh(state.fanout, now) ? aggregateDropNow(state.fanoutHistory) : null
	const tuner = state.tuner.value?.[0]
	const src = state.sources.value?.[0]
	const centre = tuner?.frequency ?? src?.caps.centerFreq ?? state.relay.value?.lastFrequency
	const rate = tuner?.sampleRate ?? src?.caps.sampleRate
	return {
		api: apiView(state.conn, now),
		iq: iqSummary(state.sources, state.metrics, now),
		decoders,
		drops: { ratio: agg?.ratio ?? null, backpressure: (agg?.backpressure ?? 0) > 0 },
		rx:
			centre === undefined
				? null
				: {
						centreHz: centre,
						halfSpanHz: rate === undefined ? null : rate / 2,
						control: tuner ? (tuner.controlMode === "external" ? "external" : "internal") : null,
					},
		clockMs: now,
		old: { iq: false, decoders: isOld(state.decoders, now), rx: isOld(state.tuner, now) && isOld(state.sources, now) },
	}
}

function laneError(state: AppState, e: Endpoint): LaneError | undefined {
	switch (e) {
		case "decoders":
			return state.decoders.error
		case "sources":
			return state.sources.error
		case "tuner":
			return state.tuner.error
		case "relay":
			return state.relay.error
		case "fanout":
			return state.fanout.error
		case "resources":
			return state.resources.error
		case "audio":
			return state.audio.error
		case "status":
			return state.status.error
		case "presets":
			return state.presets.error
		case "aircraft":
			return state.aircraft.stats.error
	}
}

const reason = (err: LaneError | null | undefined): string =>
	!err ? "?" : err.kind === "http" ? String(err.status ?? "http") : err.message

/** Spec §9: one banner row; bannerLine shows the highest-priority condition plus · +N. */
export function bannerConditions(state: AppState): BannerCondition[] {
	const c = state.conn
	const allFailing = c.rest.failing.length > 0 && POLL_ENDPOINTS.every(e => c.rest.failing.includes(e))
	if (allFailing && c.ws.state !== "open") {
		return [
			{
				kind: "api-down",
				reason: reason(c.rest.lastError),
				retryAt: c.rest.nextAt,
				asOf: c.rest.lastOkAt,
				target: c.target.base,
				tried: c.discovery.mode === "failed" ? c.discovery.tried : [],
			},
		]
	}
	const out: BannerCondition[] = []
	if (allFailing) out.push({ kind: "rest-down", reason: reason(c.rest.lastError), retryAt: c.rest.nextAt, asOf: c.rest.lastOkAt })
	if (c.ws.state === "closed") out.push({ kind: "ws-down", code: c.ws.code, retryAt: c.ws.nextRetryAt })
	if (!allFailing) {
		for (const e of c.rest.failing) out.push({ kind: "endpoint", path: ENDPOINT_PATHS[e], reason: reason(laneError(state, e)) })
	}
	return out
}

export const NOTICE_MS = 5000

export function footerWithNotice(ctx: KeyContext, notice: UiState["notice"], now: number, width: number): Line {
	const groups = footerGroups(ctx)
	if (notice && now - notice.at < NOTICE_MS) groups.unshift({ priority: 0, variants: [[sp(notice.text, "attention")]] })
	return fitGroups(groups, width)
}

/** ▶ prompt, cut so the y/n hints always fit (spec §6.2, §6.4, §6.5). */
export function confirmLine(c: ConfirmRequest, width: number): Line {
	const hints: Line = [
		sp("y", "value", true),
		sp(` ${c.yes}`, "label"),
		sp("  ", "label"),
		sp("n", "value", true),
		sp(` ${c.no}`, "label"),
		...(c.kind === "preset" ? [sp("  ", "label"), sp("P", "value", true), sp(" next", "label")] : []),
	]
	const head = `${glyphs().confirm} `
	const prompt = c.extra ? `${c.prompt} ${glyphs().sep} ${c.extra}` : c.prompt
	const room = width - lineWidth(hints) - cellWidth(head) - 3
	return truncateLine([sp(head, "edit"), sp(truncate(prompt, Math.max(1, room)), "value", true), sp("   ", "label"), ...hints], width)
}

export function switcherLine(view: ViewId, width: number): Line {
	const out: Line = []
	VIEW_ORDER.forEach((v, i) => {
		if (i > 0) out.push(sp("  ", "label"))
		out.push(sp(`${i + 1} `, "label"), sp(VIEW_TITLES[v], v === view ? "selected" : "value", v === view))
	})
	return truncateLine(out, width)
}
```

- [ ] **Step 4: Write `cli/source/view-models/help.ts`**

```ts
import { VIEW_TITLES } from "../ui/actions.js"
import { footerHints, type KeyContext } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import { padEnd, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

const BOX_WIDTH = 60

function boxChars(): { tl: string; tr: string; bl: string; br: string; h: string; v: string } {
	return glyphs().ellipsis === "…"
		? { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" }
		: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" }
}

function entries(ctx: KeyContext): Array<[string, string]> {
	const base: KeyContext = { ...ctx, help: false, confirm: null, input: false, edit: false }
	const seen = new Set<string>()
	const out: Array<[string, string]> = []
	const add = (k: string, l: string): void => {
		if (seen.has(k)) return
		seen.add(k)
		out.push([k, l])
	}
	for (const c of [{ ...base, detail: false }, { ...base, detail: true }, { ...base, edit: ctx.view === "receiver" }]) {
		for (const h of footerHints(c)) if (h.mode !== "global") add(h.hint.keys, h.hint.rich ?? h.hint.label)
	}
	return out
}

/** Spec §6.6: centred 60-column box; current view keys, then global keys, then the legend. */
export function helpLines(ctx: KeyContext, width: number, height: number, diag: { invalidFrames: number; rejectedItems: number }): Line[] {
	const b = boxChars()
	const g = glyphs()
	const w = Math.min(BOX_WIDTH, width)
	const inner = w - 3
	const half = Math.floor((inner - 1) / 2)
	const left = " ".repeat(Math.max(0, Math.floor((width - w) / 2)))
	const pair = (a: [string, string] | undefined, c: [string, string] | undefined): string =>
		padEnd(a ? `${padEnd(a[0], 10)} ${a[1]}` : "", half) + " " + (c ? `${padEnd(c[0], 8)} ${c[1]}` : "")
	const body: string[] = []
	const view = entries(ctx)
	for (let i = 0; i < view.length; i += 2) body.push(pair(view[i], view[i + 1]))
	body.push("")
	const global: Array<[string, string]> = [["1-5 Tab", "views"], ["r", "reconnect + refetch"], ["?", "this help"], ["q", "quit"]]
	for (let i = 0; i < global.length; i += 2) body.push(pair(global[i], global[i + 1]))
	body.push("")
	body.push(`${g.live} live  ${g.neutral} idle or off  ${g.fault} fault  ${g.attention} now  ${g.unknown} unknown`)
	body.push(`dim  older than 15 s      ${g.na} not applicable`)
	body.push("nominal  band from WaveKit's built-in table, not the API")
	body.push(`frames rejected ${diag.invalidFrames} ${g.sep} items rejected ${diag.rejectedItems}`)
	const title = `${b.h} keys ${g.sep} ${VIEW_TITLES[ctx.view]} `
	const top = `${b.tl}${title}${b.h.repeat(Math.max(0, w - 2 - title.length))}${b.tr}`
	const rows = body.map(t => `${b.v} ${padEnd(truncate(t, inner), inner)}${b.v}`)
	const bottom = `${b.bl}${b.h.repeat(w - 2)}${b.br}`
	const maxBody = Math.max(0, height - 2)
	const shown = rows.length > maxBody ? [...rows.slice(0, Math.max(0, maxBody - 1)), `${b.v} ${padEnd(g.ellipsis, inner)}${b.v}`] : rows
	return [top, ...shown, bottom].map(t => [sp(left + t, "label")])
}
```

- [ ] **Step 5: Run the tests and the root typecheck**

```bash
pnpm exec vitest run tests/unit/cli/chrome.test.ts
pnpm exec tsc --noEmit -p tsconfig.json
```
Expected: PASS and exit 0.

- [ ] **Step 6: Commit**

```bash
git add cli/source/view-models/chrome.ts cli/source/view-models/help.ts tests/unit/cli/chrome.test.ts
git commit -m "feat(cli): chrome view-models (strip input, banner, footer notice, confirm, help)

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 36: Terminal hooks and chrome components (A)

**Owner:** A · **Spec:** §5.1 (rows−1, resize, too small), §6.6, §7 (one root `useInput`), research (a)/(c) on Ink resize and keys

**Files:**
- Modify: `cli/source/hooks/use-terminal-size.ts` (full rewrite)
- Create: `cli/source/hooks/use-keys.ts`
- Create: `cli/source/components/chain-strip.tsx`, `switcher.tsx`, `footer.tsx`, `banner.tsx`, `confirm-bar.tsx`, `help-overlay.tsx`, `too-small.tsx`
- Modify: `cli/source/components/error-boundary.tsx` (full rewrite, same path)
- Test: `cli/source/components/chrome.test.tsx`

**Interfaces:**
- Consumes: Task 35 view-models, `Lines`/`LineView`/`ColorContext` (Task 27), `keyName`/`resolveKey` (Task 23), `tooSmallText` (Task 20).
- Produces:
  - `useTerminalSize(debounceMs = 50): { columns: number; rows: number }`. It subscribes to stdout `resize` itself, so it works under `CI=true`. It writes one `ESC[2J ESC[H` when a dimension shrinks.
  - `useKeys(ctx: KeyContext, dispatch: (a: Action) => void): void`. This is the only `useInput` in the app.
  - Components: `ChainStrip({ state, width })`, `Switcher({ view, width })`, `Footer({ ctx, notice, now, width })`, `Banner({ line })`, `ConfirmBar({ confirm, width })`, `HelpOverlay({ ctx, state, width, height })`, `TooSmall({ cols, rows })`, and `ErrorBoundary({ children })`, a class component whose fallback is `wavekit: render error · <message> · q quit`.

- [ ] **Step 1: Write the failing component tests**

`cli/source/components/chrome.test.tsx`:

```tsx
import { Box, Text } from "ink"
import { describe, expect, it } from "vitest"
import { useTerminalSize } from "../hooks/use-terminal-size.js"
import { renderAt } from "../test/harness.js"
import { ConfirmBar } from "./confirm-bar.js"
import { ErrorBoundary } from "./error-boundary.js"
import { ColorContext } from "./lines.js"
import { TooSmall } from "./too-small.js"

function Size() {
	const { columns, rows } = useTerminalSize()
	return <Text>{`${columns}x${rows}`}</Text>
}

function Boom(): never {
	throw new Error("boom \u001b[2J")
}

describe("chrome components", () => {
	it("tracks resize through its own stdout listener (works under CI=true)", async () => {
		const h = await renderAt(<Size />, { cols: 120, rows: 40 })
		expect(h.text()).toBe("120x40")
		await h.resize(60, 16)
		expect(h.text()).toBe("60x16")
		expect(h.writes().some(w => w.includes("\u001b[2J"))).toBe(true)
		h.unmount()
	})
	it("renders the too-small line", async () => {
		const h = await renderAt(<TooSmall cols={50} rows={12} />, { cols: 50, rows: 12 })
		expect(h.text()).toBe("wavekit: 50×12 too small (min 60×16)")
		h.unmount()
	})
	it("renders the confirm bar", async () => {
		const confirm = { kind: "decoder" as const, prompt: "restart readsb · up 51s · pid 1531", yes: "restart", no: "cancel", intent: { kind: "decoder" as const, op: "restart" as const, decoderId: "readsb" } }
		const h = await renderAt(
			<ColorContext.Provider value={false}>
				<ConfirmBar confirm={confirm} width={119} />
			</ColorContext.Provider>,
			{ cols: 120, rows: 10 },
		)
		expect(h.text()).toBe(" ▶ restart readsb · up 51s · pid 1531   y restart  n cancel")
		h.unmount()
	})
	it("catches render errors with a sanitised one-line fallback", async () => {
		const h = await renderAt(
			<Box>
				<ErrorBoundary>
					<Boom />
				</ErrorBoundary>
			</Box>,
			{ cols: 80, rows: 10 },
		)
		expect(h.text()).toBe("wavekit: render error · boom [2J · q quit")
		h.unmount()
	})
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm --filter @wavekit/cli test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Rewrite `cli/source/hooks/use-terminal-size.ts`**

```ts
import { useStdout } from "ink"
import { useEffect, useRef, useState } from "react"

export interface TerminalSize {
	columns: number
	rows: number
}

/**
 * Ink only listens to 'resize' when not in CI, so subscribe directly. Debounce
 * 50 ms; on any shrink write one clear so re-wrapped old lines leave no residue.
 */
export function useTerminalSize(debounceMs = 50): TerminalSize {
	const { stdout } = useStdout()
	const read = (): TerminalSize => ({ columns: stdout.columns || 80, rows: stdout.rows || 24 })
	const [size, setSize] = useState<TerminalSize>(read)
	const last = useRef(size)
	useEffect(() => {
		let timer: NodeJS.Timeout | null = null
		const onResize = (): void => {
			if (timer) clearTimeout(timer)
			timer = setTimeout(() => {
				const next = { columns: stdout.columns || 80, rows: stdout.rows || 24 }
				const prev = last.current
				if (next.columns < prev.columns || next.rows < prev.rows) stdout.write("\x1b[2J\x1b[H")
				last.current = next
				setSize(next)
			}, debounceMs)
		}
		stdout.on("resize", onResize)
		return () => {
			stdout.off("resize", onResize)
			if (timer) clearTimeout(timer)
		}
	}, [stdout, debounceMs])
	return size
}
```

- [ ] **Step 4: Write `cli/source/hooks/use-keys.ts`**

```ts
import { useInput } from "ink"
import { useRef } from "react"
import type { Action } from "../ui/actions.js"
import { keyName, resolveKey, type KeyContext } from "../ui/keymap.js"

/** The single root useInput (spec §7). Ink parses one key per stdin chunk; no escape buffer unless tmux validation shows a need (§15). */
export function useKeys(ctx: KeyContext, dispatch: (a: Action) => void): void {
	const ref = useRef({ ctx, dispatch })
	ref.current = { ctx, dispatch }
	useInput((input, key) => {
		const action = resolveKey(ref.current.ctx, keyName(input, key))
		if (action) ref.current.dispatch(action)
	})
}
```

- [ ] **Step 5: Write the chrome components**

`cli/source/components/chain-strip.tsx`:

```tsx
import type { ReactElement } from "react"
import type { AppState } from "../data/types.js"
import { stripLine } from "../ui/strip.js"
import { stripInput } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function ChainStrip({ state, width }: { state: AppState; width: number }): ReactElement {
	return <LineView line={stripLine(stripInput(state), width)} />
}
```

`cli/source/components/switcher.tsx`:

```tsx
import type { ReactElement } from "react"
import type { ViewId } from "../ui/actions.js"
import { switcherLine } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function Switcher({ view, width }: { view: ViewId; width: number }): ReactElement {
	return <LineView line={switcherLine(view, width)} />
}
```

`cli/source/components/footer.tsx`:

```tsx
import type { ReactElement } from "react"
import type { KeyContext } from "../ui/keymap.js"
import type { UiState } from "../ui/ui-state.js"
import { footerWithNotice } from "../view-models/chrome.js"
import { LineView } from "./lines.js"

export function Footer({ ctx, notice, now, width }: { ctx: KeyContext; notice: UiState["notice"]; now: number; width: number }): ReactElement {
	return <LineView line={footerWithNotice(ctx, notice, now, width)} />
}
```

`cli/source/components/banner.tsx`:

```tsx
import type { ReactElement } from "react"
import type { Line } from "../ui/line.js"
import { LineView } from "./lines.js"

export function Banner({ line }: { line: Line }): ReactElement {
	return <LineView line={line} />
}
```

`cli/source/components/confirm-bar.tsx`:

```tsx
import { Text } from "ink"
import { useContext, type ReactElement } from "react"
import { roleProps } from "../ui/theme.js"
import type { ConfirmRequest } from "../ui/ui-state.js"
import { confirmLine } from "../view-models/chrome.js"
import { ColorContext } from "./lines.js"

/** The confirm bar is one of the three inverse elements (spec §8). */
export function ConfirmBar({ confirm, width }: { confirm: ConfirmRequest; width: number }): ReactElement {
	const color = useContext(ColorContext)
	return (
		<Text wrap="truncate-end">
			{" "}
			<Text inverse>
				{confirmLine(confirm, width).map((s, i) => (
					<Text key={i} {...roleProps(s.role, color, s.bold === true)}>
						{s.text}
					</Text>
				))}
			</Text>
		</Text>
	)
}
```

`cli/source/components/help-overlay.tsx`:

```tsx
import type { ReactElement } from "react"
import type { AppState } from "../data/types.js"
import type { KeyContext } from "../ui/keymap.js"
import { helpLines } from "../view-models/help.js"
import { Lines } from "./lines.js"

export function HelpOverlay({ ctx, state, width, height }: { ctx: KeyContext; state: AppState; width: number; height: number }): ReactElement {
	const lines = helpLines(ctx, width, height, { invalidFrames: state.conn.invalidFrames, rejectedItems: state.conn.rejectedItems })
	return <Lines lines={lines} width={width + 1} height={height} />
}
```

`cli/source/components/too-small.tsx`:

```tsx
import { Text } from "ink"
import type { ReactElement } from "react"
import { tooSmallText } from "../ui/frame.js"

export function TooSmall({ cols, rows }: { cols: number; rows: number }): ReactElement {
	return <Text wrap="truncate-end">{tooSmallText(cols, rows)}</Text>
}
```

`cli/source/components/error-boundary.tsx` (replaces the old file at this path):

```tsx
import { Text } from "ink"
import { Component, type ReactNode } from "react"
import { sanitize } from "../ui/text.js"

interface Props {
	children: ReactNode
}
interface State {
	error: Error | null
}

/** Mounted inside the frame; the app keys stay live, and `r` remounts it via a new key. */
export class ErrorBoundary extends Component<Props, State> {
	override state: State = { error: null }

	static getDerivedStateFromError(error: Error): State {
		return { error }
	}

	override render(): ReactNode {
		if (this.state.error) {
			return <Text wrap="truncate-end">wavekit: render error · {sanitize(this.state.error.message)} · q quit</Text>
		}
		return this.props.children
	}
}
```

- [ ] **Step 6: Run the CLI tests and typecheck**

```bash
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli typecheck
```
Expected: PASS and exit 0. React logs the boundary's caught error to stderr in the test, and that is expected. If vitest treats it as a failure, wrap the boundary test in `vi.spyOn(console, "error").mockImplementation(() => undefined)` inside the test, which is allowed in test code.

- [ ] **Step 7: Commit**

```bash
git add cli/source/hooks/use-terminal-size.ts cli/source/hooks/use-keys.ts cli/source/components/chain-strip.tsx cli/source/components/switcher.tsx cli/source/components/footer.tsx cli/source/components/banner.tsx cli/source/components/confirm-bar.tsx cli/source/components/help-overlay.tsx cli/source/components/too-small.tsx cli/source/components/error-boundary.tsx cli/source/components/chrome.test.tsx
git commit -m "feat(cli): resize hook, single root key hook and chrome components

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 37: App shell and the app test harness (A)

**Owner:** A · **Spec:** §5.1 frame, §7 dispatch, §6.6 error boundary, §14 view registry · Review focus 2

**Files:**
- Rename: `cli/source/app.tsx` → `cli/source/legacy-app.tsx` (`git mv`, contents unchanged)
- Modify: `cli/source/cli.tsx` (one import line: `./app.js` → `./legacy-app.js`)
- Create: `cli/source/app.tsx` (the new shell)
- Create: `cli/source/test/app-harness.tsx`
- Test: `cli/source/app.test.tsx`

The legacy dashboard keeps running from `legacy-app.tsx` until Task 43 switches `cli.tsx` to the new shell, and Task 44 deletes it. `cli.tsx` belongs to C in phase 1, but in phase 2 only A edits it.

**Interfaces:**
- Consumes: Tasks 15, 23, 24, 35, 36, `ViewModule` (Task 2).
- Produces:
  - `interface AppProps { runtime: RuntimeHandle; views: Partial<Record<ViewId, ViewModule>>; initialView: ViewId; color: boolean; writeRaw?: (s: string) => void }`
  - `App(props: AppProps): ReactElement`
  - `test/app-harness.tsx`: `fakeRuntime(state): FakeRuntime` (with `sent: WriteIntent[]` and `reconnects: number`), and `renderApp({ state, views, view, cols, rows, writeRaw? }): Promise<RenderHandle & { runtime: FakeRuntime }>`. Tests push new states with `h.runtime.store.set(next)`.

- [ ] **Step 1: Write the failing app tests**

`cli/source/app.test.tsx`:

```tsx
import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { renderApp } from "./test/app-harness.js"
import { scenarioState } from "./test/fixtures.js"
import { KEYS } from "./test/harness.js"
import { EMPTY_VIEW_CTX } from "./ui/actions.js"
import type { ViewModule } from "./views/types.js"

const stubDecoders: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: () => <Text>stub decoders</Text>,
	keyInfo: () => ({ rowIds: ["a"], pageSize: 1, ctx: { ...EMPTY_VIEW_CTX, hasSelection: true, decoderRunning: true } }),
	onAction: (a, _s, ui) =>
		a.type === "decoder-op"
			? { ui: { ...ui, confirm: { kind: "decoder", prompt: "restart a", yes: "restart", no: "cancel", intent: { kind: "decoder", op: "restart", decoderId: "a" } } }, effects: [] }
			: undefined,
}
const stubOverview: ViewModule = {
	id: "overview",
	title: "Overview",
	Component: () => <Text>stub overview</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const views = { overview: stubOverview, decoders: stubDecoders }

describe("App shell", () => {
	it("frames chrome in rows−1 with the strip, switcher and footer", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "overview", cols: 120, rows: 40 })
		const f = h.frame()
		expect(f.length).toBeLessThanOrEqual(39)
		expect(f[0]).toMatch(/^ api ● 2s {2}iq ● streaming/)
		expect(f[1]).toBe(" 1 Overview  2 Decoders  3 Messages  4 Receiver  5 System")
		for (const l of f) expect([...l].length).toBeLessThanOrEqual(120)
		expect(h.text()).toContain("stub overview")
		h.unmount()
	})
	it("switches views, opens and closes help", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "overview", cols: 120, rows: 40 })
		await h.press("2")
		expect(h.text()).toContain("stub decoders")
		await h.press("?")
		expect(h.text()).toContain("keys · Decoders")
		await h.press("x")
		expect(h.text()).toContain("stub decoders")
		h.unmount()
	})
	it("shows a banner when the API is down", async () => {
		const h = await renderApp({ state: scenarioState("api-down-cached"), views, view: "overview", cols: 80, rows: 24 })
		expect(h.frame()[1]).toMatch(/^ ! API unreachable · ECONNREFUSED/)
		h.unmount()
	})
	it("keeps a pending confirm across too-small resizes and writes only on y (review focus 2)", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "decoders", cols: 120, rows: 40 })
		await h.press("R")
		expect(h.frame().at(-1)).toContain("▶ restart a")
		await h.resize(50, 12)
		expect(h.frame()).toEqual(["wavekit: 50×12 too small (min 60×16)"])
		await h.resize(120, 40)
		expect(h.frame().at(-1)).toContain("▶ restart a")
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([{ kind: "decoder", op: "restart", decoderId: "a" }])
		expect(h.frame().at(-1)).not.toContain("▶")
		h.unmount()
	})
	it("cancels confirms with Esc and reconnects on r", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "decoders", cols: 120, rows: 40 })
		await h.press("R")
		await h.press(KEYS.esc)
		expect(h.frame().at(-1)).not.toContain("▶")
		await h.press("r")
		expect(h.runtime.reconnects).toBe(1)
		expect(h.runtime.sent).toEqual([])
		h.unmount()
	})
})
```

- [ ] **Step 2: Write `cli/source/test/app-harness.tsx`**

```tsx
import { App } from "../app.js"
import type { RuntimeHandle } from "../data/runtime.js"
import { createStore } from "../data/store.js"
import type { AppState, WriteIntent } from "../data/types.js"
import type { ViewId } from "../ui/actions.js"
import type { ViewModule } from "../views/types.js"
import { renderAt, type RenderHandle } from "./harness.js"

export interface FakeRuntime extends RuntimeHandle {
	sent: WriteIntent[]
	reconnects: number
}

export function fakeRuntime(state: AppState): FakeRuntime {
	const rt: FakeRuntime = {
		store: createStore(state),
		sent: [],
		reconnects: 0,
		send: intent => {
			rt.sent.push(intent)
		},
		reconnect: () => {
			rt.reconnects++
		},
	}
	return rt
}

export async function renderApp(opts: {
	state: AppState
	views: Partial<Record<ViewId, ViewModule>>
	view: ViewId
	cols: number
	rows: number
	writeRaw?: (s: string) => void
}): Promise<RenderHandle & { runtime: FakeRuntime }> {
	const runtime = fakeRuntime(opts.state)
	const h = await renderAt(
		<App runtime={runtime} views={opts.views} initialView={opts.view} color={false} writeRaw={opts.writeRaw ?? (() => undefined)} />,
		{ cols: opts.cols, rows: opts.rows },
	)
	return Object.assign(h, { runtime })
}
```

- [ ] **Step 3: Move the legacy app aside and see the tests fail**

```bash
git mv cli/source/app.tsx cli/source/legacy-app.tsx
sed -i '' 's#from "./app.js"#from "./legacy-app.js"#' cli/source/cli.tsx
pnpm --filter @wavekit/cli test
```
On Linux use `sed -i` without `''`. Expected: FAIL, `Cannot find module './app.js'` from the harness.

- [ ] **Step 4: Write the new `cli/source/app.tsx`**

```tsx
import { Box, Text, useApp } from "ink"
import { useEffect, useState, type ReactElement } from "react"
import { Banner } from "./components/banner.js"
import { ChainStrip } from "./components/chain-strip.js"
import { ConfirmBar } from "./components/confirm-bar.js"
import { ErrorBoundary } from "./components/error-boundary.js"
import { Footer } from "./components/footer.js"
import { HelpOverlay } from "./components/help-overlay.js"
import { ColorContext } from "./components/lines.js"
import { Switcher } from "./components/switcher.js"
import { TooSmall } from "./components/too-small.js"
import type { RuntimeHandle } from "./data/runtime.js"
import type { AppState } from "./data/types.js"
import { useKeys } from "./hooks/use-keys.js"
import { useStore } from "./hooks/use-store.js"
import { useTerminalSize } from "./hooks/use-terminal-size.js"
import { osc52 } from "./terminal.js"
import { EMPTY_VIEW_CTX, type Action, type ViewId } from "./ui/actions.js"
import { bannerLine } from "./ui/banner.js"
import { chromeRows, heightClass, tooSmall, widthClass } from "./ui/frame.js"
import type { KeyContext } from "./ui/keymap.js"
import { applyUiAction } from "./ui/ui-reducer.js"
import { initialUi, type UiState } from "./ui/ui-state.js"
import { bannerConditions } from "./view-models/chrome.js"
import type { Effect, ViewKeyInfo, ViewModule } from "./views/types.js"

export interface AppProps {
	runtime: RuntimeHandle
	views: Partial<Record<ViewId, ViewModule>>
	initialView: ViewId
	color: boolean
	writeRaw?: (s: string) => void
}

const selectAll = (s: AppState): AppState => s
const NO_INFO: ViewKeyInfo = { rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }

export function App({ runtime, views, initialView, color, writeRaw }: AppProps): ReactElement {
	const { exit } = useApp()
	const { columns: cols, rows } = useTerminalSize()
	const state = useStore(runtime.store, selectAll)
	const [ui, setUi] = useState<UiState>(() => initialUi(initialView))
	const small = tooSmall(cols, rows)
	const hc = heightClass(rows)
	const wc = widthClass(cols)
	const width = cols - 1
	const banner = small ? null : bannerLine(bannerConditions(state), state.now, width)
	const chrome = chromeRows(rows, banner !== null)
	const view = views[ui.view]
	const info = view ? view.keyInfo(state, ui, width, chrome.content) : NO_INFO
	const ctx: KeyContext = {
		view: ui.view,
		confirm: ui.confirm?.kind ?? null,
		help: ui.help,
		input: ui.view === "messages" && ui.messages.draft !== null,
		edit: ui.view === "receiver" && ui.edit !== null,
		detail: ui.detail[ui.view].open,
		heightClass: hc,
		v: info.ctx,
	}

	const applyEffect = (e: Effect): void => {
		if (e.kind === "write") runtime.send(e.intent)
		else (writeRaw ?? (s => process.stdout.write(s)))(osc52(e.text))
	}

	const dispatch = (a: Action): void => {
		switch (a.type) {
			case "quit":
				setUi(u => ({ ...u, quit: true }))
				return
			case "reconnect":
				runtime.reconnect()
				setUi(u => ({ ...u, epoch: u.epoch + 1 }))
				return
			case "confirm-yes": {
				const c = ui.confirm
				if (!c) return
				runtime.send(c.intent)
				setUi(u => ({ ...u, confirm: null, edit: c.kind === "tuner" ? null : u.edit }))
				return
			}
			case "audio-toggle":
				if (info.ctx.audioRunning === null) return
				runtime.send({ kind: "audio", op: info.ctx.audioRunning ? "stop" : "start" })
				return
			default:
				break
		}
		const out = view?.onAction?.(a, state, ui)
		if (out) {
			setUi(out.ui)
			for (const e of out.effects) applyEffect(e)
			return
		}
		setUi(u => applyUiAction(u, a, { rowIds: info.rowIds, pageSize: info.pageSize }, state.now))
	}

	useKeys(ctx, dispatch)
	useEffect(() => {
		if (ui.quit) exit()
	}, [ui.quit, exit])

	if (small) return <TooSmall cols={cols} rows={rows} />

	return (
		<ColorContext.Provider value={color}>
			<Box flexDirection="column" width={cols} height={rows - 1} overflow="hidden">
				<ChainStrip state={state} width={width} />
				{chrome.switcher === 1 ? <Switcher view={ui.view} width={width} /> : null}
				{chrome.blank === 1 ? <Text> </Text> : null}
				{banner ? <Banner line={banner} /> : null}
				<Box flexDirection="column" height={chrome.content} overflow="hidden">
					<ErrorBoundary key={ui.epoch}>
						{ui.help ? (
							<HelpOverlay ctx={ctx} state={state} width={width} height={chrome.content} />
						) : view ? (
							<view.Component state={state} ui={ui} width={width} height={chrome.content} heightClass={hc} widthClass={wc} />
						) : (
							<Text> </Text>
						)}
					</ErrorBoundary>
				</Box>
				{ui.confirm ? <ConfirmBar confirm={ui.confirm} width={width} /> : <Footer ctx={ctx} notice={ui.notice} now={state.now} width={width} />}
			</Box>
		</ColorContext.Provider>
	)
}
```

- [ ] **Step 5: Run the tests, typecheck and build**

```bash
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli typecheck
pnpm --filter @wavekit/cli build
```
Expected: PASS, exit 0, and the build succeeds. `legacy-app.tsx` and the old `components/*.tsx` files still compile because they import only the old `utils/`, `hooks/use-websocket.ts` and `types.ts`, which still exist. Task 44 deletes all of them.

- [ ] **Step 6: Commit**

```bash
git add cli/source/app.tsx cli/source/legacy-app.tsx cli/source/app.test.tsx cli/source/test/app-harness.tsx cli/source/cli.tsx
git commit -m "feat(cli): app shell with rows-1 frame, keymap dispatch, confirm bar, error boundary

Pending confirms survive too-small resizes and write only on y.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 38: Overview view (A, after Task 34)

**Owner:** A · **Spec:** §6.1 (all five mockups), §5.1 Overview budget, §9 empty and no-data states

**Files:**
- Create: `cli/source/view-models/overview.ts`
- Create: `cli/source/views/overview.tsx`
- Test: `tests/unit/cli/overview-vm.test.ts`
- Test: `cli/source/views/overview.test.tsx` (goldens in `cli/source/views/__snapshots__/overview.test.tsx.snap`)

**Interfaces:**
- Consumes: Task 34 (`decoderFacts`, `decoderTable`, `OVERVIEW_COLUMNS`, `decodersPlaceholder`, `newestFirst`, `interleave`, `feedLines`, `feedCounts`), `overviewBudget` (Task 20), `iqView` (Task 5), `windowFor` (Task 13).
- Produces:
  - `interface OverviewModel { layout: "stacked" | "columns"; left: Line[]; right: Line[]; leftWidth: number; rightWidth: number; rowIds: string[]; pageSize: number }`
  - `overviewModel(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): OverviewModel`
  - `receiverSummary(state: AppState, width: number): [Line, Line]`
  - `feedHeader(state: AppState): Line`, `emptyFeedLine(state: AppState): Line`. These are Overview-only. Messages (Task 40) builds its own header because it adds pause, filter and preset parts.
  - `overviewView: ViewModule`

- [ ] **Step 1: Write the failing view-model test**

`tests/unit/cli/overview-vm.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { overviewModel, receiverSummary } from "../../../cli/source/view-models/overview.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})
const deps = { summarize: formatMessage }

describe("overview view-model", () => {
	it("renders the receiver rows by width", () => {
		const s = scenarioState("live", deps)
		const [a, b] = receiverSummary(s, 119).map(lineText)
		expect(a).toBe("RECEIVER  pi-iq · rtl_tcp 192.0.2.23:5555   ● streaming · sample age 4 ms   4.1 MB/s · 2.048 MS/s   relay 1 client")
		expect(b).toBe("window    444.947–446.995 MHz · centre 445.9707   external control · 192.0.2.1   last command 6m 32s ago")
		const [c, d] = receiverSummary(s, 59).map(lineText)
		expect(c?.startsWith("RECEIVER  pi-iq   ● streaming")).toBe(true)
		expect(c).toContain("4.1 MB/s")
		expect(c).not.toContain("relay")
		expect(c).not.toContain("rtl_tcp")
		expect(d).toBe("window    444.947–446.995 MHz   external control")
	})
	it("fits every size and keeps ≥ 3 message rows", () => {
		const s = scenarioState("live", deps)
		for (const [w, h, roomy] of [[59, 13, false], [59, 17, false], [79, 21, false], [119, 35, true], [199, 45, true]] as const) {
			const m = overviewModel(s, initialUi("overview"), w, h, roomy)
			expect(m.left.length).toBeLessThanOrEqual(h)
			expect(m.right.length).toBeLessThanOrEqual(h)
			for (const l of [...m.left, ...m.right]) expect(cellWidth(lineText(l))).toBeLessThanOrEqual(w)
			const msgRows = (m.layout === "columns" ? m.right : m.left).filter(l => /\d\d:\d\d/.test(lineText(l))).length
			expect(msgRows).toBeGreaterThanOrEqual(3)
			for (const l of [...m.left, ...m.right]) expect(findBanned(lineText(l))).toEqual([])
		}
	})
	it("shows cached data with a gap row and ticking decode ages when the API is down", () => {
		const s = scenarioState("api-down-cached", deps)
		const text = overviewModel(s, initialUi("overview"), 79, 20, false).left.map(lineText).join("\n")
		expect(text).toContain("MESSAGES  feed stopped")
		expect(text).toMatch(/── gap since \d\d:\d\d:\d\d · 2m 3\ds ──/)
		expect(text).toMatch(/dsd-fme .* ago/)
	})
	it("explains a cold start with the API down", () => {
		const text = overviewModel(scenarioState("api-down", deps), initialUi("overview"), 79, 20, false).left.map(lineText).join("\n")
		expect(text).toContain("no data · API unreachable")
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/overview-vm.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/view-models/overview.ts`**

```ts
import { iqView, isFresh, isOld } from "../data/freshness.js"
import type { AppState } from "../data/types.js"
import { windowFor } from "../data/window.js"
import { fitGroups } from "../ui/fit.js"
import { formatAge, formatClock, formatClockShort, formatMHz, formatMHzBare, formatMSps, formatRate, formatSampleAge, formatWindow } from "../ui/format.js"
import { overviewBudget } from "../ui/frame.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { UiState } from "../ui/ui-state.js"
import { OVERVIEW_COLUMNS, decoderFacts, decoderTable, decodersPlaceholder } from "./decoder-rows.js"
import { feedCounts, feedLines, interleave, newestFirst } from "./message-rows.js"

const GROUP_SEP = "   "
const title = (t: string): Line => [sp(padEnd(t, 10), "label", true)]
const label = (t: string): Line => [sp(padEnd(t, 10), "label")]

function hostOf(url: string | undefined): string | null {
	if (!url) return null
	try {
		return new URL(url).host
	} catch {
		return null
	}
}

/** Spec §6.1 receiver rows: groups drop by priority (relay clients and centre first). */
export function receiverSummary(state: AppState, width: number): [Line, Line] {
	const now = state.now
	const src = state.sources.value?.[0]
	const sep = ` ${glyphs().sep} `
	if (!src) {
		const why = state.sources.error || state.conn.rest.firstFailAt !== null ? "no data · API unreachable" : "fetching /api/sources"
		return [[...title("RECEIVER"), sp(why, "label")], label("window")]
	}
	const old = isOld(state.sources, now)
	const v = (t: string, role: Role = "value"): { text: string; role: Role } => ({ text: t, role: old ? "old" : role })
	const iq = iqView(src, isFresh(state.sources, now), state.metrics[src.id], now)
	const host = hostOf(src.url)
	const transport = src.type ?? "source"
	const age = src.activity?.sampleAgeMs
	const relay = state.relay.value
	const rate: Line = [v(formatRate(iq.rateBytesPerSec))]
	const rateRich: Line = [...rate, sp(sep, "label"), v(formatMSps(src.caps.sampleRate))]
	const relayText = relay ? `relay ${relay.clientsConnected} client${relay.clientsConnected === 1 ? "" : "s"}` : null
	// Priorities: activity first, then the source identity, then rates; relay clients are the richest
	// rate variant so they are the first thing to go (spec §6.1 "relay clients and centre first").
	const row1: Group[] = [
		{
			priority: 1,
			variants: [
				[...title("RECEIVER"), v(src.id)],
				[...title("RECEIVER"), v(src.id), sp(`${sep}${transport}${host ? ` ${host}` : ""}`, "label")],
			],
		},
		{
			priority: 0,
			variants: [
				[glyphSpan(iq.glyph), v(` ${iq.word}`)],
				...(iq.word === "streaming" && age !== null && age !== undefined ? [[glyphSpan(iq.glyph), v(` ${iq.word}`), sp(`${sep}sample age ${formatSampleAge(age)}`, "label")]] : []),
			],
		},
		{ priority: 2, variants: [rate, rateRich, ...(relayText ? [[...rateRich, sp(`${GROUP_SEP}${relayText}`, "label")]] : [])] },
	]
	const win = windowFor(src.id, state.tuner.value, state.sources.value, relay)
	const tuner = state.tuner.value?.find(t => t.sourceId === src.id)
	const owner = tuner ? (tuner.controlMode === "external" ? "external control" : "wavekit control") : null
	const ownerIp = relay?.controlClientRemote?.split(":")[0]
	const lastCmd = tuner?.lastCommandAt ? Date.parse(tuner.lastCommandAt) : Number.NaN
	const row2: Group[] = [
		{
			priority: 0,
			variants: win
				? [
						[...label("window"), v(formatWindow(win.loHz, win.hiHz))],
						[...label("window"), v(formatWindow(win.loHz, win.hiHz)), sp(`${sep}centre ${formatMHzBare(win.centreHz, 4)}`, "label")],
					]
				: [[...label("window"), sp("?", "unknown")]],
		},
		...(owner
			? [{ priority: 1, variants: [[v(owner)], ...(owner === "external control" && ownerIp ? [[v(owner), sp(`${sep}${ownerIp}`, "label")]] : [])] }]
			: []),
		...(Number.isFinite(lastCmd) ? [{ priority: 2, variants: [[sp(`last command ${formatAge(now - lastCmd)} ago`, "label")]] }] : []),
	]
	return [fitGroups(row1, width, { sep: GROUP_SEP }), fitGroups(row2, width, { sep: GROUP_SEP })]
}

/** MESSAGES header: live counts, or "feed stopped" while the WS is down (spec §6.1). */
export function feedHeader(state: AppState): Line {
	const c = feedCounts(state.messages.ring, state.now)
	const sep = ` ${glyphs().sep} `
	if (state.conn.ws.state !== "open" && state.conn.ws.since !== null && c.cached > 0) {
		return [...title("MESSAGES"), sp(`feed stopped ${formatClock(state.conn.ws.since)}${sep}${c.cached} cached`, "label")]
	}
	return [...title("MESSAGES"), sp(`${c.in60s} in 60s${sep}${c.total} total`, "label")]
}

/** Spec §6.3 empty state: no decodes since … · n of m decoders in window · rx …. */
export function emptyFeedLine(state: AppState): Line {
	const facts = decoderFacts(state)
	const since = state.conn.ws.since ?? state.now
	const inWin = facts.filter(f => f.membership === "in").length
	const centre = state.tuner.value?.[0]?.frequency
	const sep = ` ${glyphs().sep} `
	const parts = [
		`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
		...(facts.length > 0 ? [`${inWin} of ${facts.length} decoders in window`] : []),
		...(centre !== undefined ? [`rx ${formatMHz(centre)}`] : []),
	]
	return [sp(parts.join(sep), "label")]
}

export interface OverviewModel {
	layout: "stacked" | "columns"
	left: Line[]
	right: Line[]
	leftWidth: number
	rightWidth: number
	rowIds: string[]
	pageSize: number
}

export function overviewModel(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): OverviewModel {
	const facts = decoderFacts(state)
	const b = overviewBudget(width + 1, height, roomy, facts.length)
	const leftWidth = b.layout === "columns" ? b.leftWidth : width
	const receiver = receiverSummary(state, leftWidth)
	const table = decoderTable(facts, OVERVIEW_COLUMNS, leftWidth, b.decoderRows + b.more, ui.selected.overview, state.now)
	const placeholder = decodersPlaceholder(state)
	const decoderLines = placeholder ? [table.header, placeholder] : [table.header, ...table.rows]
	const msgWidth = b.layout === "columns" ? b.rightWidth : width
	const ring = state.messages.ring
	const rows = interleave(newestFirst(ring), ring.gaps)
	const feedOld = state.conn.ws.state !== "open"
	const feed = rows.length > 0 ? feedLines(rows, msgWidth, b.messageRows, null, state.now, feedOld).lines : [emptyFeedLine(state)]
	const messages = [feedHeader(state), ...feed].map(l => truncateLine(l, msgWidth))
	const left = [...receiver, ...(b.gapAfterReceiver ? [[]] : []), ...decoderLines]
	if (b.layout === "columns") {
		return { layout: "columns", left: left.slice(0, height), right: messages.slice(0, height), leftWidth, rightWidth: b.rightWidth, rowIds: facts.map(f => f.row.id), pageSize: b.decoderRows }
	}
	const stacked = [...left, ...(b.gapAfterDecoders ? [[]] : []), ...messages]
	return { layout: "stacked", left: stacked.slice(0, height), right: [], leftWidth, rightWidth: 0, rowIds: facts.map(f => f.row.id), pageSize: b.decoderRows }
}
```

- [ ] **Step 4: Run the view-model tests**

Run: `pnpm exec vitest run tests/unit/cli/overview-vm.test.ts`
Expected: PASS.

The greedy fitter does not reproduce every mockup character for character. At 59 columns it can afford `· sample age 4 ms`, where the 60×20 mockup leaves it out. The tests therefore pin the content that must be present or absent, and the goldens in Step 7 are what reviewers compare against §6.1.

- [ ] **Step 5: Write `cli/source/views/overview.tsx`**

```tsx
import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { overviewModel } from "../view-models/overview.js"
import type { ViewModule, ViewProps } from "./types.js"

function OverviewComponent({ state, ui, width, height, heightClass }: ViewProps): ReactElement {
	const m = overviewModel(state, ui, width, height, heightClass === "roomy")
	if (m.layout === "stacked") return <Lines lines={m.left} width={width + 1} height={height} />
	return (
		<Box flexDirection="row" height={height}>
			<Lines lines={m.left} width={m.leftWidth + 1} height={height} />
			<Box width={2} />
			<Lines lines={m.right} width={m.rightWidth} height={height} indent={0} />
		</Box>
	)
}

export const overviewView: ViewModule = {
	id: "overview",
	title: "Overview",
	Component: OverviewComponent,
	keyInfo: (state: AppState, ui: UiState, width: number, height: number) => {
		const m = overviewModel(state, ui, width, height, height >= 25)
		return { rowIds: m.rowIds, pageSize: m.pageSize, ctx: { ...EMPTY_VIEW_CTX, hasSelection: ui.selected.overview !== null } }
	},
	onAction: (action, _state, ui) => {
		if (action.type !== "open") return undefined
		const id = ui.selected.overview
		if (id === null) return undefined
		return {
			ui: { ...ui, view: "decoders", selected: { ...ui.selected, decoders: id }, detail: { ...ui.detail, decoders: { open: true, scroll: 0 } } },
			effects: [],
		}
	},
}
```

`keyInfo` does not receive the height class. `height >= 25` is the exact roomy test, because roomy means rows ≥ 30, and that gives content ≥ 25 without a banner and ≥ 24 with one. The only effect of misjudging is `pageSize`.

- [ ] **Step 6: Write the golden and interaction test**

`cli/source/views/overview.test.tsx`:

```tsx
import { Text } from "ink"
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { formatMessage } from "../ui/messages/index.js"
import { overviewView } from "./overview.js"
import type { ViewModule } from "./types.js"

const deps = { summarize: formatMessage }
const decodersProbe: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: ({ ui }) => <Text>{`decoders selected=${ui.selected.decoders ?? "none"} detail=${String(ui.detail.decoders.open)}`}</Text>,
	keyInfo: () => ({ rowIds: [], pageSize: 1, ctx: EMPTY_VIEW_CTX }),
}
const views = { overview: overviewView, decoders: decodersProbe }

describe("Overview goldens (spec §6.1)", () => {
	const cases: Array<[string, Parameters<typeof scenarioState>[0], number, number]> = [
		["live 120x40", "live", 120, 40],
		["live 80x24", "live", 80, 24],
		["live 60x20", "live", 60, 20],
		["live 200x50", "live", 200, 50],
		["api-down-cached 80x24", "api-down-cached", 80, 24],
		["ws-only (REST down) 80x24", "ws-only", 80, 24],
	]
	for (const [name, scenario, cols, rows] of cases) {
		it(name, async () => {
			const h = await renderApp({ state: scenarioState(scenario, deps), views, view: "overview", cols, rows })
			const f = h.frame()
			expect(f.length).toBeLessThanOrEqual(rows - 1)
			expect(h.text()).toMatchSnapshot()
			h.unmount()
		})
	}
	it("selects a decoder and opens it in view 2", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "overview", cols: 120, rows: 40 })
		await h.press(KEYS.down)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		expect(h.text()).toContain("decoders selected=multimon-ng detail=true")
		h.unmount()
	})
})
```

- [ ] **Step 7: Run, review the goldens against §6.1, commit**

```bash
pnpm --filter @wavekit/cli test -- -u
pnpm --filter @wavekit/cli test
```

Open `cli/source/views/__snapshots__/overview.test.tsx.snap` and compare each frame with the matching §6.1 mockup: content, wording, order, and which columns dropped. Expected differences are the computed 21 % aggregate, the `!` on the drops lane, and the times derived from the fixture clock. Fix any other difference in the view-models, then regenerate.

```bash
git add cli/source/view-models/overview.ts cli/source/views/overview.tsx cli/source/views/overview.test.tsx cli/source/views/__snapshots__/overview.test.tsx.snap tests/unit/cli/overview-vm.test.ts
git commit -m "feat(cli): Overview view (receiver rows, decoder table, latest messages) with goldens

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 39: Decoders view (B)

**Owner:** B · **Spec:** §6.2 (table, detail rows, controls, result lines), §10.7, T9 · The render-test steps (6–7) start after Task 37 is merged.

**Files:**
- Create: `cli/source/view-models/detail.ts` (shared detail helpers: `wrapKV`, `sparkline`)
- Create: `cli/source/view-models/decoders.ts`
- Create: `cli/source/views/decoders.tsx`
- Test: `tests/unit/cli/decoders-vm.test.ts`
- Test: `cli/source/views/decoders.test.tsx` (goldens in `cli/source/views/__snapshots__/decoders.test.tsx.snap`)

**Interfaces:**
- Consumes: Task 34 (`decoderFacts`, `decoderCells`, `decoderTable`, `DECODERS_COLUMNS`, `decodersPlaceholder`), `listBudget` (Task 20), `sparkBuckets` (Task 10), `windowFor`/`decoderSourceId` (Task 13).
- Produces:
  - `detail.ts`: `LABEL_WIDTH = 10`, `wrapKV(label: string, text: string, width: number, bold?: boolean): Line[]`, `sparkline(buckets: ReadonlyArray<number | undefined>): string`
  - `decoders.ts`: `RESULT_MS = 10_000`, `decoderDetail(state, f: DecoderFacts, width, now): Line[]`, `decoderActionText(state, id, now): string | null`, `decoderConfirm(state, id, op): ConfirmRequest | null`, `decodersModel(state, ui, width, height, roomy): DecodersModel`
  - `decodersView: ViewModule`

- [ ] **Step 1: Write the failing view-model test**

`tests/unit/cli/decoders-vm.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { decoderFacts } from "../../../cli/source/view-models/decoder-rows.js"
import { decoderActionText, decoderConfirm, decoderDetail, decodersModel } from "../../../cli/source/view-models/decoders.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("decoders view-model", () => {
	const s = scenarioState("live")
	it("builds the readsb detail rows (spec §6.2)", () => {
		const f = decoderFacts(s).find(x => x.row.id === "readsb")!
		const rows = decoderDetail(s, f, 119, s.now).map(lineText)
		expect(rows[0]).toBe("readsb    ADS-B · network producer · IQ in, JSON lines out · pid 1531 · version —")
		expect(rows).toContain("process   up 51s · 0 restarts · 6 errors · server health idle")
		expect(rows).toContain("decodes   none since start (51s) · 0 events · last output —")
		expect(rows.find(r => r.startsWith("IQ"))).toBe("IQ        570.6 MB in · branch decoder-readsb · buffer 389.1 KB, high-water 262.1 KB · in backpressure 0.2s, 121× total")
		expect(rows.find(r => r.startsWith("drops"))).toBe("drops     38% now · 44% lifetime · 836.0 MB in 3 357 chunks · last drain 0.3s ago")
		expect(rows).toContain("band      1090.000 MHz nominal · window 444.947–446.995 MHz · out of window")
		expect(rows.find(r => r.startsWith("activity"))).toMatch(/decodes\/min since \d\d:\d\d \(\d+ of 30 min observed\)/)
	})
	it("shows the server's contradictory health verbatim for a down decoder", () => {
		const f = decoderFacts(s).find(x => x.row.id === "acarsdec")!
		expect(decoderDetail(s, f, 119, s.now).map(lineText)).toContain("process   down · 13 restarts · 0 errors · server health running")
	})
	it("builds confirm prompts that name the target", () => {
		expect(decoderConfirm(s, "readsb", "restart")).toMatchObject({ kind: "decoder", prompt: "restart readsb · up 51s · pid 1531", yes: "restart", no: "cancel", intent: { kind: "decoder", op: "restart", decoderId: "readsb" } })
	})
	it("reports sent → restarted → cleared, and failures with the status", () => {
		const t0 = s.now
		let st = reduce(s, [{ kind: "action:sent", at: t0, key: "decoder:readsb", intent: { kind: "decoder", op: "restart", decoderId: "readsb" } }], t0)
		expect(decoderActionText(st, "readsb", t0)).toBe("restart sent 18:07:52")
		st = reduce(st, [
			{ kind: "action:result", at: t0 + 500, key: "decoder:readsb", outcomes: [{ label: "restart", result: { ok: true, status: 200, message: "ok" }, at: t0 + 500 }] },
			{ kind: "ws", at: t0 + 1000, event: { type: "decoder:started", decoderId: "readsb" } },
		], t0 + 1000)
		expect(decoderActionText(st, "readsb", t0 + 1000)).toBe("restarted 18:07:53")
		expect(decoderActionText(st, "readsb", t0 + 12_000)).toBeNull()
		const failed = reduce(s, [
			{ kind: "action:sent", at: t0, key: "decoder:readsb", intent: { kind: "decoder", op: "restart", decoderId: "readsb" } },
			{ kind: "action:result", at: t0 + 10, key: "decoder:readsb", outcomes: [{ label: "restart", result: { ok: false, status: 502, message: "bad gateway" }, at: t0 + 10 }] },
		], t0 + 10)
		expect(decoderActionText(failed, "readsb", t0 + 20)).toBe('restart failed · 502 · "bad gateway"')
	})
	it("truncates unknown long decoder ids and shows ? for unknown nominal bands (review focus)", () => {
		const odd: DecoderRow = { id: "an-extremely-long-decoder-identifier-used-for-truncation-tests", type: "mystery", running: true, health: "running", uptime: 5, stats: { bytesIn: 0, eventsOut: 0, errors: 0 }, restartCount: 0 }
		const st = { ...s, decoders: laneOk([...(s.decoders.value ?? []), odd], s.now - 1000, "rest" as const) }
		const m = decodersModel(st, initialUi("decoders"), 119, 35, true)
		const row = m.list.map(lineText).find(r => r.includes("an-extremely"))!
		expect(row).toContain("…")
		expect(cellWidth(row)).toBeLessThanOrEqual(119)
	})
	it("places the detail by size", () => {
		const ui = { ...initialUi("decoders"), selected: { ...initialUi("decoders").selected, decoders: "readsb" }, detail: { ...initialUi("decoders").detail, decoders: { open: true, scroll: 0 } } }
		expect(decodersModel(s, ui, 119, 35, true).placement.kind).toBe("bottom")
		expect(decodersModel(s, ui, 199, 45, true).placement.kind).toBe("right")
		const overlay = decodersModel(s, ui, 79, 21, false)
		expect(overlay.placement.kind).toBe("overlay")
		expect(overlay.list).toEqual([])
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/decoders-vm.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Write `cli/source/view-models/detail.ts`**

```ts
import { sp, type Line } from "../ui/line.js"
import { cellWidth, padEnd, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"

export const LABEL_WIDTH = 10

/** Label/value row that wraps on " · " boundaries; continuation rows are indented under the value (spec §8: the detail pane wraps). */
export function wrapKV(label: string, text: string, width: number, bold = false): Line[] {
	const sep = ` ${glyphs().sep} `
	const room = Math.max(1, width - LABEL_WIDTH)
	const parts = text.split(sep)
	const rows: string[] = []
	let cur = ""
	for (const part of parts) {
		const next = cur === "" ? part : `${cur}${sep}${part}`
		if (cellWidth(next) <= room || cur === "") cur = next
		else {
			rows.push(cur)
			cur = part
		}
	}
	rows.push(cur)
	return rows.map((r, i) => [
		sp(i === 0 ? padEnd(label, LABEL_WIDTH) : " ".repeat(LABEL_WIDTH), i === 0 && bold ? "value" : "label", i === 0 && bold),
		sp(truncate(r, room)),
	])
}

/** 30 one-minute buckets; unobserved minutes are blank, not ▁ (spec §6.2). */
export function sparkline(buckets: ReadonlyArray<number | undefined>): string {
	const levels = glyphs().spark
	const max = Math.max(0, ...buckets.filter((b): b is number => b !== undefined))
	return buckets
		.map(b => {
			if (b === undefined) return " "
			if (max === 0) return levels[0] ?? " "
			return levels[Math.min(levels.length - 1, Math.round((b / max) * (levels.length - 1)))] ?? " "
		})
		.join("")
}
```

- [ ] **Step 4: Write `cli/source/view-models/decoders.ts`**

```ts
import type { DecoderOp } from "../data/types.js"
import { sparkBuckets } from "../data/rates.js"
import type { AppState } from "../data/types.js"
import { decoderSourceId, windowFor } from "../data/window.js"
import { formatAge, formatBytes, formatClock, formatClockShort, formatCount, formatDuration, formatEventRate, formatPercent, formatWindow } from "../ui/format.js"
import { listBudget, type DetailPlacement } from "../ui/frame.js"
import { sp, type Line } from "../ui/line.js"
import { lineText, sanitize } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"
import { DECODERS_COLUMNS, decoderCells, decoderFacts, decoderTable, decodersPlaceholder, type DecoderFacts } from "./decoder-rows.js"
import { sparkline, wrapKV } from "./detail.js"

export const RESULT_MS = 10_000

const PROTOCOL: Readonly<Record<string, string>> = {
	readsb: "ADS-B",
	"ais-catcher": "AIS",
	acarsdec: "ACARS",
	dumpvdl2: "VDL2",
	direwolf: "APRS",
	rtl433: "ISM 433",
	"lora-meshtastic": "Meshtastic",
	"dsd-fme": "DMR/P25",
	"multimon-ng": "POCSAG/FLEX",
}
const PATTERN = { pure_consumer: "pure consumer", network_producer: "network producer", external_sdr: "external SDR" } as const
const INPUT = { iq: "IQ in", audio_pcm: "audio in", external: "own SDR" } as const
const OUTPUT = { jsonl: "JSON lines out", text: "text out", nmea: "NMEA out", beast: "Beast out" } as const
const PAST: Readonly<Record<DecoderOp, string>> = { start: "started", stop: "stopped", restart: "restarted" }

/** Sub-10 s server-relative durations as tenths ("0.2s", spec §6.2), longer ones as ages. */
const secs = (ms: number): string => (ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatAge(ms))

const processText = (f: DecoderFacts, now: number, rich: boolean): string => {
	const v = decoderCells(f, now)["process"]?.variants ?? []
	return lineText((rich ? v[v.length - 1] : v[0]) ?? [])
}

export function decoderActionText(state: AppState, id: string, now: number): string | null {
	const rec = state.actions.byKey[`decoder:${id}`]
	if (!rec || rec.intent.kind !== "decoder") return null
	const op = rec.intent.op
	if (rec.state === "sent") return `${op} sent ${formatClock(rec.sentAt)}`
	if (now - Math.max(rec.doneAt ?? 0, rec.confirmedAt ?? 0) > RESULT_MS) return null
	if (rec.state === "failed") {
		const r = rec.outcomes[0]?.result
		return `${op} failed ${glyphs().sep} ${r?.status ?? "network"} ${glyphs().sep} "${sanitize(r?.message ?? "?")}"`
	}
	return rec.confirmedAt !== null ? `${PAST[op]} ${formatClock(rec.confirmedAt)}` : `${op} sent ${formatClock(rec.sentAt)}`
}

export function decoderDetail(state: AppState, f: DecoderFacts, width: number, now: number): Line[] {
	const g = glyphs()
	const sep = ` ${g.sep} `
	const r = f.row
	const sess = state.session[r.id]
	const caps = r.caps
	const identity = [
		PROTOCOL[r.type] ?? r.type,
		...(caps ? [PATTERN[caps.integrationPattern], `${INPUT[caps.input]}, ${OUTPUT[caps.output]}`] : []),
		`pid ${r.pid ?? g.na}`,
		`version ${r.version ?? g.na}`,
	].join(sep)
	const lines: Line[] = [...wrapKV(r.id, identity, width, true)]
	const result = decoderActionText(state, r.id, now)
	if (result) lines.push(...wrapKV("action", result, width))
	const prev = sess?.previousHealth
	lines.push(
		...wrapKV(
			"process",
			`${processText(f, now, false)}${sep}${formatCount(r.restartCount)} restarts${sep}${formatCount(r.stats.errors)} errors${sep}server health ${r.health}${prev ? ` (was ${prev})` : ""}`,
			width,
		),
	)
	const events = `${formatCount(r.stats.eventsOut)} events`
	const lastOut = f.lastAt === null ? g.na : `${formatAge(now - f.lastAt)} ago`
	const d = f.decodes
	const decodes =
		d.kind === "none"
			? `none since start (${formatDuration(d.uptimeSec)})${sep}${events}${sep}last output ${g.na}`
			: `${d.kind === "rate" ? formatEventRate(d.perSec) : d.kind === "na" ? g.na : d.kind === "total" ? `${formatCount(d.count)} total` : `last ${lastOut}`}${sep}${events}${sep}last output ${lastOut}`
	lines.push(...wrapKV("decodes", decodes, width))
	const b = f.branch
	const snapT = Date.parse(state.fanout.value?.timestamp ?? "")
	const since = (iso: string | null | undefined): string => {
		const t = iso ? Date.parse(iso) : Number.NaN
		return Number.isFinite(t) && Number.isFinite(snapT) ? secs(snapT - t) : "?"
	}
	if (b) {
		const bp = f.backpressure ? `in backpressure ${since(b.backpressureSince)}` : "no backpressure now"
		lines.push(...wrapKV("IQ", `${formatBytes(r.stats.bytesIn)} in${sep}branch ${b.id}${sep}buffer ${formatBytes(b.bufferBytes)}, high-water ${formatBytes(b.highWaterMark)}${sep}${bp}, ${formatCount(b.backpressureEnterCount)}× total`, width))
		const drain = b.lastDrainAt ? `${since(b.lastDrainAt)} ago` : g.na
		lines.push(
			...wrapKV(
				"drops",
				`${f.dropNow === null ? "?" : formatPercent(f.dropNow)} now${sep}${f.lifetime === null ? "?" : formatPercent(f.lifetime)} lifetime${sep}${formatBytes(b.droppedBytesTotal)} in ${formatCount(b.droppedChunksTotal)} chunks${sep}last drain ${drain}`,
				width,
			),
		)
	} else {
		lines.push(...wrapKV("IQ", `${formatBytes(r.stats.bytesIn)} in${sep}no fanout branch`, width))
	}
	const sid = decoderSourceId(r.id, state.sources.value)
	const win = sid ? windowFor(sid, state.tuner.value, state.sources.value, state.relay.value) : null
	const member = { in: "in window", out: "out of window", "?": "window ?", "—": "own SDR, not on the shared window" }[f.membership]
	const band = f.nominal === "tuned" ? "tuned (follows the receiver)" : `${f.nominal} MHz nominal`
	lines.push(...wrapKV("band", `${band}${sep}window ${win ? formatWindow(win.loHz, win.hiHz) : "?"}${sep}${member}`, width))
	const buckets = sparkBuckets(sess?.spark ?? {}, now)
	const observed = buckets.filter(x => x !== undefined).length
	const from = sess?.firstObservedAt ?? now
	lines.push([
		sp("activity  ", "label"),
		sp(sparkline(buckets), "value"),
		sp(`  decodes/min since ${formatClockShort(from)} (${observed} of 30 min observed)`, "label"),
	])
	if (sess?.lastError) lines.push(...wrapKV("error", `"${sanitize(sess.lastError.message)}"${sep}${formatAge(now - sess.lastError.at)} ago`, width))
	return lines
}

export function decoderConfirm(state: AppState, id: string, op: DecoderOp): ConfirmRequest | null {
	const f = decoderFacts(state).find(x => x.row.id === id)
	if (!f) return null
	const sep = ` ${glyphs().sep} `
	return {
		kind: "decoder",
		prompt: `${op} ${id}${sep}${processText(f, state.now, false)}${sep}pid ${f.row.pid ?? glyphs().na}`,
		yes: op,
		no: "cancel",
		intent: { kind: "decoder", op, decoderId: id },
	}
}

export interface DecodersModel {
	list: Line[]
	detail: Line[] | null
	placement: DetailPlacement
	listWidth: number
	detailWidth: number
	rowIds: string[]
	pageSize: number
	selected: DecoderFacts | null
}

export function decodersModel(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): DecodersModel {
	const facts = decoderFacts(state)
	const selected = facts.find(f => f.row.id === ui.selected.decoders) ?? null
	const open = ui.detail.decoders.open && selected !== null
	const b = listBudget(width + 1, height, roomy, 1, open)
	const listWidth = open && b.placement.kind === "right" ? width - b.placement.width - 2 : width
	const detailWidth = b.placement.kind === "right" ? b.placement.width : width
	const table = decoderTable(facts, DECODERS_COLUMNS, listWidth, b.listRows, selected?.row.id ?? null, state.now)
	const placeholder = decodersPlaceholder(state)
	const list = open && b.placement.kind === "overlay" ? [] : placeholder ? [table.header, placeholder] : [table.header, ...table.rows]
	const detail = open && selected ? decoderDetail(state, selected, detailWidth, state.now).slice(0, b.detailRows) : null
	return { list, detail, placement: b.placement, listWidth, detailWidth, rowIds: facts.map(f => f.row.id), pageSize: Math.max(1, b.listRows), selected }
}
```

- [ ] **Step 5: Run the view-model tests**

Run: `pnpm exec vitest run tests/unit/cli/decoders-vm.test.ts`
Expected: PASS. In the fixture, readsb's `backpressureSince` and `lastDrainAt` are 0.2 s and 0.3 s before the snapshot timestamp. Both are measured as server-time deltas, so clock skew cannot affect them, and they render as `0.2s` and `0.3s`. In the failure case the server message is quoted, because it is server text (assumption 9).

- [ ] **Step 6: Write `cli/source/views/decoders.tsx`**

```tsx
import { Box } from "ink"
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { decoderConfirm, decodersModel } from "../view-models/decoders.js"
import type { ViewModule, ViewProps } from "./types.js"

function DecodersComponent({ state, ui, width, height, heightClass }: ViewProps): ReactElement {
	const m = decodersModel(state, ui, width, height, heightClass === "roomy")
	if (m.detail && m.placement.kind === "overlay") return <Lines lines={m.detail} width={width + 1} height={height} />
	if (m.detail && m.placement.kind === "right") {
		return (
			<Box flexDirection="row" height={height}>
				<Lines lines={m.list} width={m.listWidth + 1} height={height} />
				<Box width={2} />
				<Lines lines={m.detail} width={m.detailWidth} height={height} indent={0} />
			</Box>
		)
	}
	const lines = m.detail ? [...m.list, [], ...m.detail] : m.list
	return <Lines lines={lines.slice(0, height)} width={width + 1} height={height} />
}

export const decodersView: ViewModule = {
	id: "decoders",
	title: "Decoders",
	Component: DecodersComponent,
	keyInfo: (state: AppState, ui: UiState, width: number, height: number) => {
		const m = decodersModel(state, ui, width, height, height >= 25)
		return {
			rowIds: m.rowIds,
			pageSize: m.pageSize,
			ctx: { ...EMPTY_VIEW_CTX, hasSelection: m.selected !== null, decoderRunning: m.selected ? m.selected.row.running : null },
		}
	},
	onAction: (action, state, ui) => {
		if (action.type !== "decoder-op" || ui.selected.decoders === null) return undefined
		const confirm = decoderConfirm(state, ui.selected.decoders, action.op)
		return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
	},
}
```

- [ ] **Step 7: Write the render test with goldens and the confirm flow**

`cli/source/views/decoders.test.tsx`:

```tsx
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { formatMessage } from "../ui/messages/index.js"
import { decodersView } from "./decoders.js"

const deps = { summarize: formatMessage }
const views = { decoders: decodersView }
const selectReadsb = async (h: Awaited<ReturnType<typeof renderApp>>) => {
	for (let i = 0; i < 4; i++) await h.press(KEYS.down)
}

describe("Decoders view (spec §6.2)", () => {
	it("golden: 120x40 with readsb detail as a bottom pane", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "decoders", cols: 120, rows: 40 })
		await selectReadsb(h)
		await h.press(KEYS.enter)
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toContain("readsb    ADS-B · network producer")
		expect(h.frame().at(-1)).toContain("x stop")
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("golden: crash-loop 120x40", async () => {
		const h = await renderApp({ state: scenarioState("crash-loop", deps), views, view: "decoders", cols: 120, rows: 40 })
		expect(h.text()).toMatch(/× acarsdec +crash-loop\b/)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("confirms before restarting and sends only on y", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "decoders", cols: 120, rows: 40 })
		await selectReadsb(h)
		await h.press("R")
		expect(h.frame().at(-1)).toBe(" ▶ restart readsb · up 51s · pid 1531   y restart  n cancel")
		await h.press("n")
		expect(h.runtime.sent).toEqual([])
		await h.press("R")
		await h.press(KEYS.enter)
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([{ kind: "decoder", op: "restart", decoderId: "readsb" }])
		h.unmount()
	})
	it("offers s only for a stopped decoder", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "decoders", cols: 120, rows: 40 })
		for (let i = 0; i < 5; i++) await h.press(KEYS.down)
		expect(h.frame().at(-1)).not.toContain("x stop")
		await h.press("x")
		expect(h.frame().at(-1)).not.toContain("▶")
		await h.press("s")
		expect(h.frame().at(-1)).toContain("▶ start acarsdec")
		h.unmount()
	})
})
```

- [ ] **Step 8: Run, review goldens against §6.2, commit**

```bash
pnpm --filter @wavekit/cli test -- -u
pnpm --filter @wavekit/cli test
pnpm exec vitest run tests/unit/cli/decoders-vm.test.ts
```
Compare `cli/source/views/__snapshots__/decoders.test.tsx.snap` with the §6.2 mockup (columns, detail rows, footer) and fix the view-models where they differ.

```bash
git add cli/source/view-models/detail.ts cli/source/view-models/decoders.ts cli/source/views/decoders.tsx cli/source/views/decoders.test.tsx cli/source/views/__snapshots__/decoders.test.tsx.snap tests/unit/cli/decoders-vm.test.ts
git commit -m "feat(cli): Decoders view with detail pane, confirmed start/stop/restart and results

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 40: Messages view and the filter input (B)

**Owner:** B · **Spec:** §6.3 (filter, pause, gaps, detail, copy, empty states, aircraft enrichment), P11 · The render-test steps (7–8) start after Task 37 is merged.

**Files:**
- Create: `cli/source/view-models/messages.ts`
- Create: `cli/source/components/input-line.tsx`
- Create: `cli/source/views/messages.tsx`
- Test: `tests/unit/cli/messages-vm.test.ts`
- Test: `cli/source/views/messages.test.tsx` (goldens in `cli/source/views/__snapshots__/messages.test.tsx.snap`)

**Interfaces:**
- Consumes: Task 34 (`newestFirst`, `interleave`, `feedLines`, `feedCounts`), Task 25 (`parseFilter`, `applyFilter`), Task 26 (`detailJson`), Task 39 (`wrapKV`, `LABEL_WIDTH`), `listBudget`.
- Produces:
  - `interface FeedView { rows: FeedRow[]; visible: MessageEntry[]; matching: number; total: number; newCount: number }`, `feedView(ring: MessageRing, mu: MessagesUi): FeedView`
  - `messagesHeader(state, mu, fv): Line`, `inputLine(draft: string, width: number): Line`
  - `messageDetail(e: MessageEntry, width: number, height: number, scroll: number): Line[]`
  - `messagesModel(state, ui, width, height, roomy): MessagesModel`
  - `InputLine({ text, width })`, `messagesView: ViewModule`

- [ ] **Step 1: Write the failing view-model tests (P11)**

`tests/unit/cli/messages-vm.test.ts`:

```ts
import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import { createRing, ringNewestSeq, ringPush } from "../../../cli/source/data/ring-buffer.js"
import type { MessageEntry } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { initialUi, type MessagesUi } from "../../../cli/source/ui/ui-state.js"
import { feedView, messageDetail, messagesHeader, messagesModel } from "../../../cli/source/view-models/messages.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

const entry = (decoderId: string): Omit<MessageEntry, "seq"> => ({
	decoderId,
	type: "t",
	receivedAt: 0,
	output: { type: "t", decoder: decoderId, timestamp: "x", data: null },
	formatted: { protocol: "T", category: decoderId === "d1" ? "aircraft" : "data", segments: [], fields: [], emergency: false, searchText: decoderId },
})

describe("feedView", () => {
	// Feature: cli-dashboard-overhaul, Property 11: pause
	// Validates: spec §6.3
	it("P11: while paused, visible rows ⊆ rows at pause time; new = matching appends", () => {
		fc.assert(
			fc.property(
				fc.array(fc.constantFrom("d1", "d2", "d3"), { minLength: 1, maxLength: 60 }),
				fc.array(fc.constantFrom("d1", "d2", "d3"), { maxLength: 60 }),
				fc.constantFrom("", "d1", "d2,d3"),
				(before, after, filterText) => {
					const ring = createRing()
					for (const d of before) ringPush(ring, entry(d))
					const mu: MessagesUi = { following: false, pausedAtSeq: ringNewestSeq(ring), filterText, draft: null, preset: "all" }
					const atPause = new Set(feedView(ring, mu).visible.map(e => e.seq))
					for (const d of after) ringPush(ring, entry(d))
					const later = feedView(ring, mu)
					for (const e of later.visible) expect(atPause.has(e.seq)).toBe(true)
					const alts = filterText === "" ? null : filterText.split(",")
					expect(later.newCount).toBe(after.filter(d => alts === null || alts.includes(d)).length)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("messages header and states", () => {
	const s = scenarioState("burst", { summarize: formatMessage })
	it("shows pause, filter and counts", () => {
		const mu: MessagesUi = { following: false, pausedAtSeq: -1, filterText: "readsb,ais", draft: null, preset: "all" }
		const fv = feedView(s.messages.ring, mu)
		expect(fv.newCount).toBe(6)
		expect(lineText(messagesHeader(s, mu, fv))).toBe(`MESSAGES  paused · 6 new · filter readsb,ais · ${fv.matching} of ${fv.total}`)
	})
	it("adds aircraft tracker stats for the aircraft preset", () => {
		const mu: MessagesUi = { following: true, pausedAtSeq: null, filterText: "", draft: null, preset: "aircraft" }
		expect(lineText(messagesHeader(s, mu, feedView(s.messages.ring, mu)))).toContain("preset aircraft · 14 tracked · 9 with position")
	})
	it("explains an empty filter result and an empty feed", () => {
		const ui = { ...initialUi("messages"), messages: { ...initialUi("messages").messages, filterText: "nothing-matches" } }
		const text = messagesModel(s, ui, 119, 35, true).list.map(lineText).join("\n")
		expect(text).toMatch(/0 of \d+ match "nothing-matches"/)
		const idle = scenarioState("idle", { summarize: formatMessage })
		expect(messagesModel(idle, initialUi("messages"), 119, 35, true).list.map(lineText).join("\n")).toMatch(/^no decodes since \d\d:\d\d \(.+\) · 2 of 9 decoders in window · rx 445\.971 MHz$/m)
	})
	it("renders the aircraft detail with label/value rows and bounded JSON", () => {
		const e = s.messages.ring.entries.find(x => x.decoderId === "readsb")!
		const lines = messageDetail(e, 119, 20, 0).map(lineText)
		expect(lines[0]).toMatch(/^readsb · aircraft · \d\d:\d\d:\d\d\.\d{3}$/)
		expect(lines.join("\n")).toContain("squawk !7700 emergency")
		expect(lines.some(l => l.includes('"hex": "4ca9d2"'))).toBe(true)
		expect(lines.length).toBeLessThanOrEqual(20)
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/messages-vm.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/view-models/messages.ts`**

```ts
import type { AppState, MessageEntry, MessageRing } from "../data/types.js"
import { applyFilter, parseFilter, type FilterSubject } from "../ui/filter.js"
import { formatAge, formatClock, formatClockMs, formatClockShort, formatMHz } from "../ui/format.js"
import { listBudget, type DetailPlacement } from "../ui/frame.js"
import { sp, type Line, type Span } from "../ui/line.js"
import { detailJson } from "../ui/messages/index.js"
import { cellWidth, padEnd, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { MessagesUi, UiState } from "../ui/ui-state.js"
import { decoderFacts } from "./decoder-rows.js"
import { LABEL_WIDTH } from "./detail.js"
import { feedCounts, feedLines, interleave, newestFirst, type FeedRow } from "./message-rows.js"

export interface FeedView {
	rows: FeedRow[]
	visible: MessageEntry[]
	matching: number
	total: number
	newCount: number
}

const subject = (e: MessageEntry): FilterSubject => ({
	text: `${e.decoderId} ${e.formatted.protocol} ${e.formatted.searchText}`,
	emergency: e.formatted.emergency,
	category: e.formatted.category,
})

/** Pause freezes the slice at pausedAtSeq; evicted rows simply disappear, nothing is replaced in place (spec §6.3). */
export function feedView(ring: MessageRing, mu: MessagesUi): FeedView {
	const entries = newestFirst(ring)
	const matched = applyFilter(entries, parseFilter(mu.filterText), mu.preset, subject)
	const cut = mu.following || mu.pausedAtSeq === null ? null : mu.pausedAtSeq
	const visible = cut === null ? matched : matched.filter(e => e.seq <= cut)
	const newCount = cut === null ? 0 : matched.length - visible.length
	return { rows: interleave(visible, ring.gaps), visible, matching: matched.length, total: entries.length, newCount }
}

const title = (): Span => sp(padEnd("MESSAGES", LABEL_WIDTH), "label", true)

export function messagesHeader(state: AppState, mu: MessagesUi, fv: FeedView): Line {
	const sep = ` ${glyphs().sep} `
	const parts: string[] = []
	if (!mu.following) parts.push(`paused${sep}${fv.newCount} new`)
	if (mu.filterText !== "") parts.push(`filter ${mu.filterText}`)
	if (mu.preset !== "all") {
		const st = state.aircraft.stats.value
		parts.push(mu.preset === "aircraft" && st ? `preset aircraft${sep}${st.aircraftCount} tracked${sep}${st.withPosition} with position` : `preset ${mu.preset}`)
	}
	const c = feedCounts(state.messages.ring, state.now)
	if (mu.filterText !== "" || mu.preset !== "all") parts.push(`${fv.matching} of ${fv.total}`)
	else if (state.conn.ws.state !== "open" && state.conn.ws.since !== null && c.cached > 0) parts.push(`feed stopped ${formatClock(state.conn.ws.since)}${sep}${c.cached} cached`)
	else if (mu.following) parts.push(`${c.in60s} in 60s${sep}${c.total} total`)
	return [title(), sp(parts.join(sep), "label")]
}

export function inputLine(draft: string, width: number): Line {
	return [sp("/ ", "accent"), sp(truncate(draft, Math.max(1, width - 3)), "accent"), sp(glyphs().cursor, "accent")]
}

function emptyLine(state: AppState, mu: MessagesUi, fv: FeedView): Line {
	const sep = ` ${glyphs().sep} `
	if (fv.total > 0) {
		const what = [mu.filterText, ...(mu.preset !== "all" ? [`preset ${mu.preset}`] : [])].filter(x => x !== "").join(" ")
		return [sp(`0 of ${fv.total} match "${what}"`, "label")]
	}
	const facts = decoderFacts(state)
	const since = state.conn.ws.since ?? state.now
	const centre = state.tuner.value?.[0]?.frequency
	return [
		sp(
			[
				`no decodes since ${formatClockShort(since)} (${formatAge(state.now - since)})`,
				...(facts.length > 0 ? [`${facts.filter(f => f.membership === "in").length} of ${facts.length} decoders in window`] : []),
				...(centre !== undefined ? [`rx ${formatMHz(centre)}`] : []),
			].join(sep),
			"label",
		),
	]
}

/** Label/value groups packed three spaces apart, wrapping to the pane width. */
function packFields(fields: MessageEntry["formatted"]["fields"], width: number): Line[] {
	const out: Line[] = []
	let cur: Line = []
	let used = 0
	for (const f of fields) {
		const w = cellWidth(f.label) + 1 + cellWidth(f.value)
		if (used > 0 && used + 3 + w > width) {
			out.push(cur)
			cur = []
			used = 0
		}
		if (used > 0) {
			cur.push(sp("   ", "label"))
			used += 3
		}
		cur.push(sp(`${f.label} `, "label"), sp(truncate(f.value, Math.max(1, width - used - cellWidth(f.label) - 1)), f.attention ? "attention" : "value"))
		used += w
	}
	if (cur.length > 0) out.push(cur)
	return out
}

export function messageDetail(e: MessageEntry, width: number, height: number, scroll: number): Line[] {
	const sep = ` ${glyphs().sep} `
	const head: Line = [sp(truncate(`${e.decoderId}${sep}${e.output.type}${sep}${formatClockMs(e.receivedAt)}`, width), "value", true)]
	const body = [...packFields(e.formatted.fields, width), ...detailJson(e.output.data).map(l => [sp(truncate(l, width), "label")])]
	const start = Math.min(scroll, Math.max(0, body.length - (height - 1)))
	return [head, ...body.slice(start, start + Math.max(0, height - 1))]
}

export interface MessagesModel {
	header: Line
	input: Line | null
	list: Line[]
	detail: Line[] | null
	placement: DetailPlacement
	listWidth: number
	detailWidth: number
	rowIds: string[]
	pageSize: number
	selected: MessageEntry | null
}

export function messagesModel(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): MessagesModel {
	const mu = ui.messages
	const fv = feedView(state.messages.ring, mu)
	const selSeq = ui.selected.messages === null ? null : Number(ui.selected.messages)
	const selected = fv.visible.find(e => e.seq === selSeq) ?? null
	const open = ui.detail.messages.open && selected !== null
	const headerRows = mu.draft !== null ? 2 : 1
	const b = listBudget(width + 1, height, roomy, headerRows, open)
	const listWidth = open && b.placement.kind === "right" ? width - b.placement.width - 2 : width
	const detailWidth = b.placement.kind === "right" ? b.placement.width : width
	const old = state.conn.ws.state !== "open"
	const list =
		open && b.placement.kind === "overlay"
			? []
			: fv.rows.length === 0
				? [emptyLine(state, mu, fv)]
				: feedLines(fv.rows, listWidth, b.listRows, selected?.seq ?? null, state.now, old).lines
	return {
		header: messagesHeader(state, mu, fv),
		input: mu.draft !== null ? inputLine(mu.draft, width) : null,
		list,
		detail: open && selected ? messageDetail(selected, detailWidth, b.detailRows, ui.detail.messages.scroll) : null,
		placement: b.placement,
		listWidth,
		detailWidth,
		rowIds: fv.visible.map(e => String(e.seq)),
		pageSize: Math.max(1, b.listRows),
		selected,
	}
}
```

- [ ] **Step 4: Run the view-model tests**

Run: `pnpm exec vitest run tests/unit/cli/messages-vm.test.ts`
Expected: PASS. P11 has no eviction (fewer than 1000 entries), so `newCount` equals the matching appends exactly.

- [ ] **Step 5: Write `cli/source/components/input-line.tsx`**

```tsx
import type { ReactElement } from "react"
import { inputLine } from "../view-models/messages.js"
import { LineView } from "./lines.js"

export function InputLine({ text, width }: { text: string; width: number }): ReactElement {
	return <LineView line={inputLine(text, width)} />
}
```

- [ ] **Step 6: Write `cli/source/views/messages.tsx`**

```tsx
import { Box } from "ink"
import type { ReactElement } from "react"
import { InputLine } from "../components/input-line.js"
import { LineView, Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { messagesModel } from "../view-models/messages.js"
import type { ViewModule, ViewProps } from "./types.js"

function MessagesComponent({ state, ui, width, height, heightClass }: ViewProps): ReactElement {
	const m = messagesModel(state, ui, width, height, heightClass === "roomy")
	const head = (
		<>
			<LineView line={m.header} />
			{ui.messages.draft !== null ? <InputLine text={ui.messages.draft} width={width} /> : null}
		</>
	)
	if (m.detail && m.placement.kind === "overlay") return <Lines lines={m.detail} width={width + 1} height={height} />
	const body = m.input ? height - 2 : height - 1
	if (m.detail && m.placement.kind === "right") {
		return (
			<Box flexDirection="row" height={height}>
				<Box flexDirection="column" width={m.listWidth + 1}>
					{head}
					<Lines lines={m.list} width={m.listWidth + 1} height={body} />
				</Box>
				<Box width={2} />
				<Lines lines={m.detail} width={m.detailWidth} height={height} indent={0} />
			</Box>
		)
	}
	const lines = m.detail ? [...m.list, [], ...m.detail] : m.list
	return (
		<Box flexDirection="column" height={height}>
			{head}
			<Lines lines={lines.slice(0, body)} width={width + 1} height={body} />
		</Box>
	)
}

export const messagesView: ViewModule = {
	id: "messages",
	title: "Messages",
	Component: MessagesComponent,
	keyInfo: (state: AppState, ui: UiState, width: number, height: number) => {
		const m = messagesModel(state, ui, width, height, height >= 25)
		return { rowIds: m.rowIds, pageSize: m.pageSize, ctx: { ...EMPTY_VIEW_CTX, hasSelection: m.selected !== null, paused: !ui.messages.following } }
	},
	onAction: (action, state, ui) => {
		if (action.type !== "copy-json") return undefined
		const seq = ui.selected.messages === null ? null : Number(ui.selected.messages)
		const e = state.messages.ring.entries.find(x => x.seq === seq)
		if (!e) return undefined
		return {
			ui: { ...ui, notice: { text: "copy sent (OSC 52)", at: state.now } },
			effects: [{ kind: "copy", text: JSON.stringify(e.output.data, null, 2) ?? "null" }],
		}
	},
}
```

- [ ] **Step 7: Write the render tests**

`cli/source/views/messages.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest"
import { reduce } from "../data/reducers.js"
import type { Inbound } from "../data/types.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { formatMessage } from "../ui/messages/index.js"
import { messagesView } from "./messages.js"

const deps = { summarize: formatMessage }
const views = { messages: messagesView }
const typeText = async (h: Awaited<ReturnType<typeof renderApp>>, text: string) => {
	for (const ch of text) await h.press(ch)
}

describe("Messages view (spec §6.3)", () => {
	it("golden: burst 120x40 following, then paused + filtered + detail open", async () => {
		const h = await renderApp({ state: scenarioState("burst", deps), views, view: "messages", cols: 120, rows: 40 })
		expect(h.text()).toMatchSnapshot("following")
		await h.press("p")
		await h.press("/")
		await typeText(h, "readsb,ais")
		await h.press(KEYS.enter)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		expect(h.text()).toContain("MESSAGES  paused · 0 new · filter readsb,ais")
		expect(h.text()).toMatch(/readsb · aircraft · \d\d:\d\d:\d\d\.\d{3}/)
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toMatchSnapshot("paused-filtered-detail")
		h.unmount()
	})
	it("types q and digits into the filter instead of quitting or switching views", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "messages", cols: 120, rows: 40 })
		await h.press("/")
		await typeText(h, "q1")
		expect(h.text()).toContain("/ q1▏")
		expect(h.frame().at(-1)).toContain("Enter apply  Esc cancel")
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("/ q1")
		h.unmount()
	})
	it("counts new messages while paused", async () => {
		const state = scenarioState("live", deps)
		const h = await renderApp({ state, views, view: "messages", cols: 120, rows: 40 })
		await h.press("p")
		const at = state.now + 500
		const items: Inbound[] = [0, 1].map(i => ({ kind: "ws", at: at + i, event: { type: "decoder:output", decoderId: "dsd-fme", output: { type: "call_end", decoder: "dsd-fme", timestamp: "t", data: { talkgroup: 9 + i } } } }))
		h.runtime.store.set(reduce(state, items, at + 2, deps))
		await new Promise(r => setTimeout(r, 20))
		expect(h.text()).toContain("paused · 2 new")
		await h.press("G")
		expect(h.text()).toContain("MESSAGES  5 in 60s · 9 total")
		h.unmount()
	})
	it("copies JSON with OSC 52 and walks the Esc chain", async () => {
		const writeRaw = vi.fn()
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "messages", cols: 120, rows: 40, writeRaw })
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		await h.press("y")
		expect(String(writeRaw.mock.calls[0]?.[0])).toMatch(/^\u001b\]52;c;/)
		expect(h.frame().at(-1)).toContain("copy sent (OSC 52)")
		await h.press(KEYS.esc)
		expect(h.text()).not.toMatch(/dsd-fme · call_end · /)
		h.unmount()
	})
	it("keeps the selected message across resizes, by seq (spec §13.2)", async () => {
		const h = await renderApp({ state: scenarioState("live", deps), views, view: "messages", cols: 120, rows: 40 })
		await h.press(KEYS.down)
		await h.press(KEYS.down)
		await h.press(KEYS.enter)
		const header = (): string | undefined => h.frame().join("\n").match(/multimon-ng · pocsag · \d\d:\d\d:\d\d\.\d{3}/)?.[0]
		const before = header()
		expect(before).toBeDefined()
		await h.resize(60, 16)
		expect(header()).toBe(before)
		await h.resize(200, 50)
		expect(header()).toBe(before)
		h.unmount()
	})
	it("keeps hostile payloads inside the frame at 60x20 (review focus 4)", async () => {
		const h = await renderApp({ state: scenarioState("long-text", deps), views, view: "messages", cols: 60, rows: 20 })
		for (const l of h.frame()) expect([...l].length).toBeLessThanOrEqual(60)
		expect(h.writes().join("")).not.toMatch(/\u0007|\u009b/)
		h.unmount()
	})
})
```

- [ ] **Step 8: Run, review goldens against §6.3, commit**

```bash
pnpm --filter @wavekit/cli test -- -u
pnpm --filter @wavekit/cli test
pnpm exec vitest run tests/unit/cli/messages-vm.test.ts
```
Compare the `paused-filtered-detail` snapshot with the §6.3 mockup (header wording, row content, detail rows, footer) and fix any difference in the view-models.

```bash
git add cli/source/view-models/messages.ts cli/source/components/input-line.tsx cli/source/views/messages.tsx cli/source/views/messages.test.tsx cli/source/views/__snapshots__/messages.test.tsx.snap tests/unit/cli/messages-vm.test.ts
git commit -m "feat(cli): Messages view with filter grammar, pause and new count, gaps, detail, OSC 52 copy

Property 11 (spec §6.3).

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 41: Receiver view with tuner edit and control (C)

**Owner:** C · **Spec:** §6.4 (blocks, edit mode, confirms, results), §10.9 retune impact, T9 · The render-test steps (6–7) start after Task 37 is merged.

**Files:**
- Create: `cli/source/view-models/receiver.ts`
- Create: `cli/source/views/receiver.tsx`
- Test: `tests/unit/cli/receiver-vm.test.ts`
- Test: `cli/source/views/receiver.test.tsx` (goldens in `cli/source/views/__snapshots__/receiver.test.tsx.snap`)

**Interfaces:**
- Consumes: `tuner-edit.ts` (Task 32), `retuneImpact`/`windowFor`/`decoderMembership` (Task 13), `aggregateDropNow`/`relayDropNow` (Task 10), `iqView` (Task 5), format helpers.
- Produces:
  - `receiverLines(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): Line[]`
  - `changeText(c: PendingChange): string` (pending row), `confirmItem(c: PendingChange): string` (confirm bar)
  - `tunerConfirm(edit: TunerEditState): ConfirmRequest | null`, `controlConfirm(state: AppState): ConfirmRequest | null`
  - `tunerResultText(state: AppState, sourceId: string, now: number): string | null`
  - `receiverControl(state: AppState): "internal" | "external" | null`
  - `receiverView: ViewModule`

- [ ] **Step 1: Write the failing view-model test**

`tests/unit/cli/receiver-vm.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type { AppState } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { applyEditKey, startEdit } from "../../../cli/source/ui/tuner-edit.js"
import type { EditKey } from "../../../cli/source/ui/actions.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { controlConfirm, receiverLines, tunerConfirm, tunerResultText } from "../../../cli/source/view-models/receiver.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

function internal(s: AppState): AppState {
	const t = s.tuner.value![0]!
	return { ...s, tuner: laneOk([{ ...t, controlMode: "internal" }], s.now - 1000, "rest") }
}

describe("receiver view-model (spec §6.4)", () => {
	const s = scenarioState("live")
	const text = receiverLines(s, initialUi("receiver"), 119, 35, true).map(lineText)
	it("renders SOURCE, TUNER, RELAY, FANOUT and upstream rows", () => {
		expect(text).toContain("SOURCE    pi-iq · rtl_tcp 192.0.2.23:5555   ● connected   ● streaming · sample age 4 ms · timeout 10 s")
		expect(text).toContain("rate      4.1 MB/s (2.048 MS/s U8 IQ)   received 1.2 GB   reconnects 0   last error —   assigned 9 decoders")
		expect(text.find(l => l.startsWith("TUNER"))).toMatch(/^TUNER {5}external control · relay client-3 192\.0\.2\.1:59430 · 42 commands · last set-frequency 6m 32s ago$/)
		expect(text).toContain("frequency 445 970 700 Hz   window 444.947–446.995 MHz   sample rate 2 048 000 S/s   ppm 0")
		expect(text).toContain("gain      manual · index 11 (R828D)   rtl agc off   bias-t off   direct sampling off   offset tuning off")
		expect(text).toContain("in window dsd-fme, multimon-ng (tuned)")
		expect(text).toContain("out       rtl433, readsb, acarsdec, ais-catcher, dumpvdl2, direwolf, lora-meshtastic")
		expect(text.find(l => l.startsWith("RELAY"))).toBe("RELAY     listening :4713 · 1 of 4 clients · 545.5 MB sent · exclusive control · last error —")
		expect(text.some(l => /^18:01:20 {2}client-3 192\.0\.2\.1:59430 {2}set-frequency +445 970 700$/.test(l))).toBe(true)
		expect(text.find(l => l.startsWith("FANOUT"))).toBe("FANOUT    decoder branches: 21% of offered IQ dropped now · 4 of 8 in backpressure · 4.1 MB/s offered each")
		expect(text.find(l => l.startsWith("upstream"))).toBe("upstream  Pi rtlmux → core: 3.5 MB dropped lifetime (0.29%) · 0 B/s now · checked 2s ago")
		for (const l of text) {
			expect(cellWidth(l)).toBeLessThanOrEqual(119)
			expect(findBanned(l)).toEqual([])
		}
	})
	it("never exceeds the height and drops relay history first", () => {
		const lines = receiverLines(s, initialUi("receiver"), 79, 18, false)
		expect(lines.length).toBeLessThanOrEqual(18)
		expect(lines.map(lineText).some(l => l.startsWith("FANOUT"))).toBe(true)
	})
	it("shows ? with the reason when fanout cannot be computed (legacy core)", () => {
		const legacy = receiverLines(scenarioState("legacy"), initialUi("receiver"), 119, 35, true).map(lineText)
		expect(legacy.find(l => l.startsWith("FANOUT"))).toContain("drop now ? · needs 2 snapshots in 10s")
	})
	it("renders edit mode with a digit cursor, pending changes and the affected decoders", () => {
		const st = internal(s)
		let edit = startEdit(st.tuner.value![0]!)
		const keys: EditKey[] = [...Array(29).fill("up"), "right", "up", "up", "up", "tab", "tab", ...Array(207).fill("up")]
		for (const k of keys) edit = applyEditKey(edit, k)
		const ui = { ...initialUi("receiver"), edit }
		const lines = receiverLines(st, ui, 119, 35, true).map(lineText)
		expect(lines).toContain("TUNER     EDIT · wavekit control · nothing sent until confirmed")
		expect(lines.find(l => l.startsWith("frequency"))).toMatch(/^frequency 446 000 ▏000 Hz {3}window 444\.976–447\.024 MHz/)
		expect(lines).toContain("pending   frequency 445 970 700 → 446 000 000 · gain 0.0 → 20.7 dB")
		expect(lines).toContain("affects   dsd-fme, multimon-ng (tuned) · no decoder enters or leaves the window")
		expect(tunerConfirm(edit)).toMatchObject({
			kind: "tuner",
			prompt: "send 2 commands to pi-iq: frequency 446 000 000 Hz (+29.3 kHz), gain 20.7 dB",
			yes: "send",
			no: "back",
			intent: { kind: "tuner", sourceId: "pi-iq", commands: [{ setting: "frequency", body: { hz: 446000000 } }, { setting: "gain", body: { tenthsDb: 207 } }] },
		})
	})
	it("warns when bias-t is turned on and confirms control changes", () => {
		let edit = startEdit(internal(s).tuner.value![0]!)
		for (const k of ["tab", "tab", "tab", "tab", "tab", "tab", "space"] as EditKey[]) edit = applyEditKey(edit, k)
		expect(tunerConfirm(edit)?.extra).toBe("bias-t supplies DC on the antenna port")
		expect(controlConfirm(s)).toMatchObject({ kind: "control", prompt: "take tuner control from relay client-3 192.0.2.1? its next tuning command is refused", yes: "take", intent: { commands: [{ setting: "control-mode", body: { mode: "internal" } }] } })
		expect(controlConfirm(internal(s))).toMatchObject({ prompt: "release tuner control to external clients?", yes: "release" })
	})
	it("reports tuner results for 10 s", () => {
		const t0 = s.now
		const st = reduce(s, [
			{ kind: "action:sent", at: t0, key: "tuner:pi-iq", intent: { kind: "tuner", sourceId: "pi-iq", commands: [] } },
			{ kind: "action:result", at: t0, key: "tuner:pi-iq", outcomes: [
				{ label: "frequency", result: { ok: false, status: 409, code: "TUNER_CONTROL_EXTERNAL", message: "device busy" }, at: t0 },
				{ label: "gain", result: null, at: null },
			] },
		], t0)
		expect(tunerResultText(st, "pi-iq", t0 + 1000)).toBe('frequency failed · 409 · "device busy" · gain not sent')
		expect(tunerResultText(st, "pi-iq", t0 + 11_000)).toBeNull()
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/receiver-vm.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/view-models/receiver.ts`**

```ts
import type { ExtendedSourceStatus, TunerRelayStatus, TunerState } from "@wavekit/api-types"
import { iqView, isFresh, isOld } from "../data/freshness.js"
import { bandFor } from "../data/nominal-bands.js"
import { aggregateDropNow } from "../data/rates.js"
import type { AppState, DecoderRow } from "../data/types.js"
import { decoderMembership, decoderSourceId, retuneImpact, windowFor, type TunedWindow } from "../data/window.js"
import { fitGroups } from "../ui/fit.js"
import { formatAge, formatBytes, formatClock, formatDb, formatDeltaHz, formatHz, formatMSps, formatPercent, formatRate, formatSampleAge, formatSps, formatSpaced, formatWindow } from "../ui/format.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, padStart, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import { editWindow, pendingChanges, pendingCommands, turnsBiasTeeOn, type PendingChange } from "../ui/tuner-edit.js"
import type { ConfirmRequest, EditField, TunerEditState, UiState } from "../ui/ui-state.js"

const RESULT_MS = 10_000
const TUNER_TYPES: Readonly<Record<number, string>> = { 1: "E4000", 2: "FC0012", 3: "FC0013", 4: "FC2580", 5: "R820T", 6: "R828D" }
const sep = (): string => ` ${glyphs().sep} `
const lbl = (t: string, bold = false): Line => [sp(padEnd(t, 10), "label", bold)]
const one = (priority: number, ...variants: Line[]): Group => ({ priority, variants })
const txt = (t: string, role: Role = "value"): Line => [sp(t, role)]
const onOff = (b: boolean): string => (b ? "on" : "off")

function row(label: Line, groups: Group[], width: number): Line {
	return [...label, ...fitGroups(groups, Math.max(1, width - 10), { sep: "   " })]
}

function hostOf(url: string | undefined): string | null {
	if (!url) return null
	try {
		return new URL(url).host
	} catch {
		return null
	}
}

function noData(state: AppState, path: string): string {
	return state.conn.rest.firstFailAt !== null ? "no data · API unreachable" : `fetching ${path}`
}

export function receiverControl(state: AppState): "internal" | "external" | null {
	const t = state.tuner.value?.[0]
	return t ? t.controlMode : null
}

function sourceBlock(state: AppState, src: ExtendedSourceStatus, width: number): Line[] {
	const now = state.now
	const old = isOld(state.sources, now)
	const role: Role = old ? "old" : "value"
	const iq = iqView(src, isFresh(state.sources, now), state.metrics[src.id], now)
	const host = hostOf(src.url)
	const a = src.activity
	const g = glyphs()
	const row1: Group[] = [
		one(0, txt(src.id, role), txt(`${src.id}${sep()}${src.type ?? "source"}${host ? ` ${host}` : ""}`, role)),
		one(0, [glyphSpan(src.connected ? "live" : "fault"), sp(src.connected ? " connected" : " disconnected", role)]),
		one(
			1,
			[glyphSpan(iq.glyph), sp(` ${iq.word}`, role)],
			...(a ? [[glyphSpan(iq.glyph), sp(` ${iq.word}${sep()}sample age ${formatSampleAge(a.sampleAgeMs)}${sep()}timeout ${Math.round(a.timeoutMs / 1000)} s`, role)]] : []),
		),
		...(src.available ? [] : [one(2, txt("no assignment capacity", "attention"))]),
	]
	const rate = formatRate(iq.rateBytesPerSec)
	const row2: Group[] = [
		one(0, txt(rate, role), txt(`${rate} (${formatMSps(src.caps.sampleRate)} ${src.caps.format.replace("_", " ")})`, role)),
		one(1, txt(`received ${formatBytes(src.bytesReceived)}`, role)),
		one(2, txt(`reconnects ${src.reconnectAttempts}`, role)),
		one(1, txt(`last error ${src.lastError ? `"${truncate(sanitize(src.lastError), 40)}"` : g.na}`, role)),
		one(3, txt(`assigned ${src.assignments.length} decoders`, role)),
	]
	return [row(lbl("SOURCE", true), row1, width), row(lbl("rate"), row2, width)]
}

const FIELD_LABEL: Readonly<Record<EditField, string>> = {
	frequency: "frequency",
	sampleRate: "sample rate",
	gain: "gain",
	ppm: "ppm",
	gainMode: "gain mode",
	agc: "rtl agc",
	biasTee: "bias-t",
	directSampling: "direct sampling",
	offsetTuning: "offset tuning",
}

function plainValue(field: EditField, v: number | string | boolean): string {
	if (typeof v === "boolean") return onOff(v)
	if (typeof v === "string") return v
	switch (field) {
		case "frequency":
			return formatSpaced(v)
		case "sampleRate":
			return formatSps(v)
		case "gain":
			return (v / 10).toFixed(1)
		default:
			return String(v)
	}
}

/** Pending row: "frequency 445 970 700 → 446 000 000", "gain 0.0 → 20.7 dB". */
export function changeText(c: PendingChange): string {
	const to = c.field === "gain" && typeof c.to === "number" ? formatDb(c.to) : plainValue(c.field, c.to)
	return `${FIELD_LABEL[c.field]} ${plainValue(c.field, c.from)} → ${to}`
}

/** Confirm item: "frequency 446 000 000 Hz (+29.3 kHz)", "gain 20.7 dB". */
export function confirmItem(c: PendingChange): string {
	if (c.field === "frequency" && typeof c.to === "number" && typeof c.from === "number") return `frequency ${formatHz(c.to)} (${formatDeltaHz(c.to - c.from)})`
	if (c.field === "gain" && typeof c.to === "number") return `gain ${formatDb(c.to)}`
	return `${FIELD_LABEL[c.field]} ${plainValue(c.field, c.to)}`
}

export function tunerConfirm(edit: TunerEditState): ConfirmRequest | null {
	const commands = pendingCommands(edit)
	if (commands.length === 0) return null
	const n = commands.length
	return {
		kind: "tuner",
		prompt: `send ${n} command${n === 1 ? "" : "s"} to ${edit.sourceId}: ${pendingChanges(edit).map(confirmItem).join(", ")}`,
		...(turnsBiasTeeOn(edit) ? { extra: "bias-t supplies DC on the antenna port" } : {}),
		yes: "send",
		no: "back",
		intent: { kind: "tuner", sourceId: edit.sourceId, commands },
	}
}

export function controlConfirm(state: AppState): ConfirmRequest | null {
	const t = state.tuner.value?.[0]
	if (!t) return null
	const relay = state.relay.value
	const toInternal = t.controlMode === "external"
	const who = relay?.controlClientId
		? `relay ${relay.controlClientId}${relay.controlClientRemote ? ` ${relay.controlClientRemote.split(":")[0] ?? ""}` : ""}`
		: "external clients"
	return {
		kind: "control",
		prompt: toInternal ? `take tuner control from ${who}? its next tuning command is refused` : "release tuner control to external clients?",
		yes: toInternal ? "take" : "release",
		no: "cancel",
		intent: { kind: "tuner", sourceId: t.sourceId, commands: [{ setting: "control-mode", body: { mode: toInternal ? "internal" : "external" }, label: "control" }] },
	}
}

export function tunerResultText(state: AppState, sourceId: string, now: number): string | null {
	const rec = state.actions.byKey[`tuner:${sourceId}`]
	if (!rec) return null
	if (rec.state === "sent") return `sending ${formatClock(rec.sentAt)}`
	if (rec.doneAt === null || now - rec.doneAt > RESULT_MS) return null
	const parts = rec.outcomes.map((o, i) => {
		if (o.result === null) return `${o.label} not sent`
		if (o.result.ok) return `${o.label} ok${i === 0 && o.at !== null ? ` ${formatClock(o.at)}` : ""}`
		return `${o.label} failed${sep()}${o.result.status ?? "network"}${sep()}"${sanitize(o.result.message)}"`
	})
	return `${rec.state === "ok" ? `sent${sep()}` : ""}${parts.join(sep())}`
}

function withCursor(freq: number, digit: number): Line {
	const s = formatSpaced(freq)
	let count = -1
	let idx = s.length
	for (let i = s.length - 1; i >= 0; i--) {
		if (/\d/.test(s[i] ?? "")) count++
		if (count === digit) {
			idx = i
			break
		}
	}
	return [sp(s.slice(0, idx), "accent"), sp(glyphs().cursor, "edit"), sp(`${s.slice(idx)} Hz`, "accent")]
}

function membershipLists(decoders: readonly DecoderRow[], state: AppState): { inside: string; outside: string } {
	const tuned: string[] = []
	const inside: string[] = []
	const outside: string[] = []
	for (const d of decoders) {
		const m = decoderMembership(d, state.sources.value, state.tuner.value, state.relay.value)
		if (bandFor(d.type)?.kind === "tuned") tuned.push(d.id)
		else if (m === "in") inside.push(d.id)
		else if (m === "out") outside.push(d.id)
	}
	const ins = [...inside, ...(tuned.length > 0 ? [`${tuned.join(", ")} (tuned)`] : [])]
	return { inside: ins.join(", ") || glyphs().na, outside: outside.join(", ") || glyphs().na }
}

function tunerBlock(state: AppState, ui: UiState, t: TunerState, relay: TunerRelayStatus | undefined, width: number): Line[] {
	const now = state.now
	const g = glyphs()
	const role: Role = isOld(state.tuner, now) ? "old" : "value"
	const decoders = (state.decoders.value ?? []).filter(d => decoderSourceId(d.id, state.sources.value) === t.sourceId)
	const edit = ui.edit && ui.edit.sourceId === t.sourceId ? ui.edit : null
	const win: TunedWindow | null = edit
		? (() => {
				const w = editWindow(edit)
				return { sourceId: t.sourceId, centreHz: w.centreHz, sampleRate: w.sampleRate, loHz: w.centreHz - w.sampleRate / 2, hiHz: w.centreHz + w.sampleRate / 2 }
			})()
		: windowFor(t.sourceId, state.tuner.value, state.sources.value, relay)
	const focus = (f: EditField): Role => (edit && edit.field === f ? "accent" : role)
	const d = edit?.draft
	const freqCell: Line = edit ? withCursor(edit.draft.frequency, edit.digit) : txt(formatHz(t.frequency), role)
	const lines: Line[] = []
	if (edit) {
		lines.push([...lbl("TUNER", true), sp("EDIT", "edit", true), sp(`${sep()}wavekit control${sep()}nothing sent until confirmed`, "label")])
	} else {
		const owner = t.controlMode === "external" ? "external control" : "wavekit control"
		const client = t.controlMode === "external" && relay?.controlClientId ? `${sep()}relay ${relay.controlClientId}${relay.controlClientRemote ? ` ${relay.controlClientRemote}` : ""}` : ""
		const last = state.tunerLastCommand[t.sourceId] ?? (relay?.lastCommand && relay.lastCommandAt ? { command: relay.lastCommand, at: Date.parse(relay.lastCommandAt) } : null)
		const lastText = last && Number.isFinite(last.at) ? `${sep()}last ${last.command} ${formatAge(now - last.at)} ago` : ""
		lines.push([...lbl("TUNER", true), sp(`${owner}${client}${sep()}${t.commandCount} commands${lastText}`, role)])
	}
	lines.push(
		row(
			lbl("frequency"),
			[
				one(0, freqCell),
				one(0, txt(`window ${win ? formatWindow(win.loHz, win.hiHz) : "?"}`, role)),
				one(1, txt(`sample rate ${formatSps(d?.sampleRate ?? t.sampleRate)}`, focus("sampleRate"))),
				one(2, txt(`ppm ${d?.ppm ?? t.ppm}`, focus("ppm"))),
			],
			width,
		),
	)
	const gainMode = d?.gainMode ?? t.gainMode
	const tunerType = relay?.rtlTcpHeader ? TUNER_TYPES[relay.rtlTcpHeader.tunerType] : undefined
	const gainText = gainMode === "agc"
		? "agc"
		: d
			? `manual${sep()}${formatDb(d.gainTenthsDb)}`
			: t.tunerGainIndex !== undefined && t.gain === 0
				? `manual${sep()}index ${t.tunerGainIndex}${tunerType ? ` (${tunerType})` : ""}`
				: `manual${sep()}${formatDb(t.gain)}`
	lines.push(
		row(
			lbl("gain"),
			[
				one(0, txt(gainText, edit && (edit.field === "gain" || edit.field === "gainMode") ? "accent" : role)),
				one(1, txt(`rtl agc ${onOff(d?.agc ?? t.agcMode)}`, focus("agc"))),
				one(1, txt(`bias-t ${onOff(d?.biasTee ?? t.biasTee)}`, focus("biasTee"))),
				one(2, txt(`direct sampling ${d?.directSampling ?? t.directSampling}`, focus("directSampling"))),
				one(2, txt(`offset tuning ${onOff(d?.offsetTuning ?? t.offsetTuning)}`, focus("offsetTuning"))),
			],
			width,
		),
	)
	if (edit) {
		const changes = pendingChanges(edit)
		lines.push([...lbl("pending"), sp(truncate(changes.length > 0 ? changes.map(changeText).join(sep()) : "nothing changed", width - 10), "value")])
		const from = windowFor(t.sourceId, state.tuner.value, state.sources.value, relay)
		const impact = win ? retuneImpact(decoders, from, win) : { tuned: [], enters: [], leaves: [] }
		const moves = [...impact.enters.map(x => `${x} enters`), ...impact.leaves.map(x => `${x} leaves`)]
		const tuned = impact.tuned.length > 0 ? `${impact.tuned.join(", ")} (tuned)${sep()}` : ""
		lines.push([...lbl("affects"), sp(truncate(`${tuned}${moves.length > 0 ? moves.join(", ") : "no decoder enters or leaves the window"}`, width - 10), "value")])
		return lines
	}
	if (relay?.lastFrequency !== undefined && relay.lastFrequency !== t.frequency) {
		const at = relay.lastCommandAt ? ` ${formatClock(Date.parse(relay.lastCommandAt))}` : ""
		lines.push([...lbl("relay set"), sp(`${formatHz(relay.lastFrequency)}${at}`, role)])
	}
	const result = tunerResultText(state, t.sourceId, now)
	if (result) lines.push([...lbl("result"), sp(truncate(result, width - 10), "value")])
	const lists = membershipLists(decoders, state)
	lines.push([...lbl("in window"), sp(truncate(lists.inside, width - 10), role)])
	lines.push([...lbl("out"), sp(truncate(lists.outside, width - 10), role)])
	return lines
}

function relayHeader(relay: TunerRelayStatus, width: number): Line {
	const g = glyphs()
	const parts = [
		relay.listening ? `listening :${relay.port}` : "not listening",
		`${relay.clientsConnected} of ${relay.maxClients ?? "?"} clients`,
		`${formatBytes(relay.bytesSent)} sent`,
		`${relay.controlPolicy} control`,
		`last error ${relay.lastError ? `"${truncate(sanitize(relay.lastError), 40)}"` : g.na}`,
	]
	return [...lbl("RELAY", true), sp(truncate(parts.join(sep()), width - 10), "value")]
}

function historyRows(relay: TunerRelayStatus, max: number, width: number): Line[] {
	const rows = [...(relay.commandHistory ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, Math.max(0, max))
	return rows.map(h => {
		const who = `${h.clientId ?? "?"}${h.clientRemote ? ` ${h.clientRemote}` : ""}`
		return [sp(truncate(`${formatClock(Date.parse(h.at))}  ${who}  ${padEnd(h.name, 22)}${padStart(formatSpaced(h.value), 12)}`, width), "label")]
	})
}

function fanoutBlock(state: AppState, width: number): Line[] {
	const now = state.now
	const f = state.fanout.value
	if (!f) return [[...lbl("FANOUT", true), sp(noData(state, "/api/telemetry/fanout"), "label")]]
	const agg = isFresh(state.fanout, now) ? aggregateDropNow(state.fanoutHistory) : null
	const dec = f.branches.filter(b => b.decoderId !== undefined)
	const bp = dec.filter(b => b.backpressureActive).length
	const head =
		agg?.ratio !== null && agg?.ratio !== undefined
			? `decoder branches: ${formatPercent(agg.ratio)} of offered IQ dropped now${sep()}${bp} of ${dec.length} in backpressure${sep()}${formatRate(agg.offeredBytesPerSec)} offered each`
			: `decoder branches: drop now ?${sep()}needs 2 snapshots in 10s${sep()}${bp} of ${dec.length} in backpressure`
	const offered = dec.every(b => b.totalBytesWritten !== undefined) && dec.length > 0 ? dec.reduce((a, b) => a + (b.totalBytesWritten ?? 0), 0) : null
	const dropped = dec.reduce((a, b) => a + b.droppedBytesTotal, 0)
	const relayDropped = f.branches.filter(b => b.decoderId === undefined).reduce((a, b) => a + b.droppedBytesTotal, 0)
	const life = `${offered === null ? "?" : formatBytes(offered / dec.length)} offered per branch${sep()}${formatBytes(dropped)} dropped across branches (${offered === null ? "?" : formatPercent(dropped / offered)})${sep()}relay branch ${formatBytes(relayDropped)} dropped`
	const src = state.sources.value?.[0]
	const up = src ? state.resources.value?.sourceBackpressure.find(b => b.sourceId === src.id) : undefined
	const upText = up
		? `Pi rtlmux → core: ${formatBytes(up.bytesDroppedUpstream)} dropped lifetime (${up.dropPercent.toFixed(2)}%)${sep()}${formatRate(up.dropRate)} now${sep()}checked ${formatAge(now - Date.parse(up.lastCheckedAt))} ago`
		: "Pi rtlmux → core: ? (no SDR host data)"
	return [
		[...lbl("FANOUT", true), sp(truncate(head, width - 10), "value")],
		[...lbl("lifetime"), sp(truncate(life, width - 10), "value")],
		[...lbl("upstream"), sp(truncate(upText, width - 10), "value")],
	]
}

/** Spec §6.4 order: SOURCE, TUNER, RELAY (+history filling what remains), FANOUT, upstream. */
export function receiverLines(state: AppState, ui: UiState, width: number, height: number, roomy: boolean): Line[] {
	const src = state.sources.value?.[0]
	const relay = state.relay.value
	const t = state.tuner.value?.find(x => x.sourceId === src?.id) ?? state.tuner.value?.[0]
	const gap: Line[] = roomy ? [[]] : []
	const source = src ? sourceBlock(state, src, width) : [[...lbl("SOURCE", true), sp(noData(state, "/api/sources"), "label")]]
	const tuner = t ? tunerBlock(state, ui, t, relay, width) : [[...lbl("TUNER", true), sp(noData(state, "/api/tuner"), "label")]]
	const relayHead = relay ? [relayHeader(relay, width)] : [[...lbl("RELAY", true), sp(noData(state, "/api/tuner-relay"), "label")]]
	const fanout = fanoutBlock(state, width)
	const fixed = source.length + gap.length + tuner.length + gap.length + relayHead.length + gap.length + fanout.length
	const history = relay ? historyRows(relay, height - fixed, width) : []
	return [...source, ...gap, ...tuner, ...gap, ...relayHead, ...history, ...gap, ...fanout].slice(0, height)
}
```

- [ ] **Step 4: Run the view-model tests**

Run: `pnpm exec vitest run tests/unit/cli/receiver-vm.test.ts`
Expected: PASS. Notes on the values:
- The live fixture has 8 decoder branches, because acarsdec is down and has none, which is why the row says `4 of 8 in backpressure`.
- `last set-frequency 6m 32s ago` follows the §8 age format (minutes plus seconds under 10 min).
- In edit mode, editing starts with the cursor on the 1 kHz digit (`digit: 3`), and the 29 `up` presses add 29 kHz. `right` then moves the cursor to the 100 Hz digit (`digit: 2`), and three more `up` presses add 300 Hz. That is why the frequency row reads `446 000 ▏000 Hz`, with the cursor glyph placed before the digit under the cursor.

- [ ] **Step 5: Write `cli/source/views/receiver.tsx`**

```tsx
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import { RECEIVER_EXTERNAL_NOTICE } from "../ui/keymap.js"
import { applyEditKey, startEdit } from "../ui/tuner-edit.js"
import type { UiState } from "../ui/ui-state.js"
import { controlConfirm, receiverControl, receiverLines, tunerConfirm } from "../view-models/receiver.js"
import type { ViewModule, ViewProps } from "./types.js"

function ReceiverComponent({ state, ui, width, height, heightClass }: ViewProps): ReactElement {
	return <Lines lines={receiverLines(state, ui, width, height, heightClass === "roomy")} width={width + 1} height={height} />
}

export const receiverView: ViewModule = {
	id: "receiver",
	title: "Receiver",
	Component: ReceiverComponent,
	keyInfo: (state: AppState, _ui: UiState) => ({ rowIds: [], pageSize: 1, ctx: { ...EMPTY_VIEW_CTX, control: receiverControl(state) } }),
	onAction: (action, state, ui) => {
		const notice = (text: string) => ({ ui: { ...ui, notice: { text, at: state.now } }, effects: [] })
		switch (action.type) {
			case "edit-open": {
				const t = state.tuner.value?.[0]
				if (!t) return notice("tuner state ?")
				if (t.controlMode !== "internal") return notice(RECEIVER_EXTERNAL_NOTICE)
				return { ui: { ...ui, edit: startEdit(t) }, effects: [] }
			}
			case "edit-key":
				return ui.edit ? { ui: { ...ui, edit: applyEditKey(ui.edit, action.key) }, effects: [] } : undefined
			case "edit-review": {
				if (!ui.edit) return undefined
				const confirm = tunerConfirm(ui.edit)
				return confirm ? { ui: { ...ui, confirm }, effects: [] } : notice("nothing changed")
			}
			case "edit-discard":
				return { ui: { ...ui, edit: null }, effects: [] }
			case "control-toggle": {
				const confirm = controlConfirm(state)
				return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
			}
			default:
				return undefined
		}
	},
}
```

- [ ] **Step 6: Write the render test**

`cli/source/views/receiver.test.tsx`:

```tsx
import { describe, expect, it } from "vitest"
import { laneOk } from "../data/freshness.js"
import type { AppState } from "../data/types.js"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { KEYS } from "../test/harness.js"
import { receiverView } from "./receiver.js"

const views = { receiver: receiverView }
function internal(s: AppState): AppState {
	const t = s.tuner.value![0]!
	return { ...s, tuner: laneOk([{ ...t, controlMode: "internal" }], s.now - 1000, "rest") }
}

describe("Receiver view (spec §6.4)", () => {
	it("golden: 120x40 under external control", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "receiver", cols: 120, rows: 40 })
		expect(h.frame().at(-1)).toContain("c take control")
		expect(h.frame().length).toBeLessThanOrEqual(39)
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("refuses to edit under external control and confirms take-over", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "receiver", cols: 120, rows: 40 })
		await h.press("e")
		expect(h.frame().at(-1)).toContain("controlled externally · c to take control")
		await h.press("c")
		expect(h.frame().at(-1)).toBe(" ▶ take tuner control from relay client-3 192.0.2.1? its next tuning command is refused   y take  n cancel")
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([{ kind: "tuner", sourceId: "pi-iq", commands: [{ setting: "control-mode", body: { mode: "internal" }, label: "control" }] }])
		h.unmount()
	})
	it("sends nothing while editing; n goes back, Esc discards, y sends", async () => {
		const h = await renderApp({ state: internal(scenarioState("live")), views, view: "receiver", cols: 120, rows: 40 })
		await h.press("e")
		expect(h.text()).toContain("EDIT · wavekit control · nothing sent until confirmed")
		await h.press(KEYS.up)
		await h.press(KEYS.enter)
		expect(h.frame().at(-1)).toContain("▶ send 1 command to pi-iq: frequency 445 971 700 Hz (+1.0 kHz)")
		await h.press("n")
		expect(h.text()).toContain("EDIT · wavekit control")
		await h.press(KEYS.esc)
		expect(h.text()).not.toContain("EDIT")
		expect(h.runtime.sent).toEqual([])
		await h.press("e")
		await h.press(KEYS.up)
		await h.press(KEYS.enter)
		await h.press("y")
		expect(h.runtime.sent).toEqual([{ kind: "tuner", sourceId: "pi-iq", commands: [{ setting: "frequency", body: { hz: 445971700 }, label: "frequency" }] }])
		expect(h.text()).not.toContain("EDIT")
		h.unmount()
	})
})
```

- [ ] **Step 7: Run, review the golden against §6.4, commit**

```bash
pnpm --filter @wavekit/cli test -- -u
pnpm --filter @wavekit/cli test
```
Compare the snapshot with the §6.4 mockup and fix any difference in the view-model.

```bash
git add cli/source/view-models/receiver.ts cli/source/views/receiver.tsx cli/source/views/receiver.test.tsx cli/source/views/__snapshots__/receiver.test.tsx.snap tests/unit/cli/receiver-vm.test.ts
git commit -m "feat(cli): Receiver view with confirmed tuner edits, control take/release, fanout and upstream

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 42: System view with audio and presets (C)

**Owner:** C · **Spec:** §6.5 (container, alerts, SDR host + sampling slot, audio, core), T9, research (b) on presets and linear gain · The render-test steps (5–6) start after Task 37 is merged.

**Files:**
- Create: `cli/source/view-models/system.ts`
- Create: `cli/source/views/system.tsx`
- Test: `tests/unit/cli/system-vm.test.ts`
- Test: `cli/source/views/system.test.tsx` (goldens in `cli/source/views/__snapshots__/system.test.tsx.snap`)

**Interfaces:**
- Consumes: format helpers, `glyphSpan`, guards' typed lanes.
- Produces:
  - `systemLines(state: AppState, width: number, height: number, roomy: boolean): Line[]`
  - `presetNames(state: AppState): string[]`, `presetConfirm(state: AppState, index: number): ConfirmRequest | null`
  - `audioResultText(state: AppState, now: number): string | null`
  - `systemView: ViewModule`

- [ ] **Step 1: Write the failing view-model test**

`tests/unit/cli/system-vm.test.ts`:

```ts
import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { audioResultText, presetConfirm, systemLines } from "../../../cli/source/view-models/system.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

describe("system view-model (spec §6.5)", () => {
	const s = scenarioState("live")
	const text = systemLines(s, 119, 35, true).map(lineText)
	it("renders container, alerts, SDR host, audio and core", () => {
		expect(text).toContain("CONTAINER cgroup v2 · as of 2s ago")
		expect(text).toContain("cpu       240%   throttled —   oom kills 0")
		expect(text).toContain("mem       1.94 GB · no limit")
		expect(text).toContain('alerts    ! container-cpu critical "High CPU usage: 273.5%" · 1× since 18:07 · last 3s ago')
		expect(text).toContain("SDR HOST  pi-iq · http://192.0.2.23:8080 · polled by core 2s ago · uptime 4m 51s")
		expect(text).toContain("rtl_tcp   ● running · pid 58 · 0 restarts")
		expect(text).toContain("rtlmux    ● running · pid 63 · 1 client · 4.2 MB/s · 1.2 GB sent · 0 restarts")
		expect(text.some(l => l.startsWith("sampling"))).toBe(false)
		expect(text).toContain("dongle    RTL-SDR Blog V4 · serial —")
		expect(text).toContain("AUDIO     ○ stopped · 0 clients · 127.0.0.1:8081/stream")
		expect(text).toContain("demod     pi-iq at 445.9707 MHz · nfm 12.5 kHz · squelch 0 · gain 10 · 48 kHz s16le")
		expect(text).toContain('CORE      v1.0.0 · uptime 7m 40s · reports "degraded"')
		for (const l of text) {
			expect(cellWidth(l)).toBeLessThanOrEqual(119)
			expect(findBanned(l)).toEqual([])
		}
	})
	it("fills the sampling slot only when core surfaces it (request 6)", () => {
		const r = s.resources.value!
		const host = r.sdrHosts[0]!
		const sampling = {
			state: "streaming" as const, reason: null, timeoutMs: 5000, lastSampleAt: null, sampleAgeMs: 200,
			upstream: { bytesTotal: 1, bytesPerSec: 4096000, windowMs: 2000, expectedBytesPerSec: 4096000, rateBasis: "configured" as const, rateStatus: "nominal" as const },
			epoch: { rtlmuxPid: 63, rtlTcpPid: 58, startedAt: null, resets: 0, lastResetReason: null },
			stats: { state: "ok" as const, observedAt: null, ageMs: 200, lastError: null },
		}
		const st = { ...s, resources: laneOk({ ...r, sdrHosts: [{ ...host, sampling }] }, s.now - 2000, "rest" as const) }
		const lines = systemLines(st, 119, 35, true).map(lineText)
		const i = lines.findIndex(l => l.startsWith("sampling"))
		expect(lines[i]).toBe("sampling  ● streaming · sample age 200 ms · 4.1 MB/s upstream (nominal) · 0 resets")
		expect(lines[i - 1]?.startsWith("rtlmux")).toBe(true)
		expect(lines[i + 1]?.startsWith("dongle")).toBe(true)
	})
	it("marks a Pi the core cannot reach", () => {
		const r = s.resources.value!
		const st = { ...s, resources: laneOk({ ...r, sdrHosts: [{ ...r.sdrHosts[0]!, fetchError: "connect ETIMEDOUT" }] }, s.now - 2000, "rest" as const) }
		expect(systemLines(st, 119, 35, true).map(lineText)).toContain('          × core cannot reach the Pi API · "connect ETIMEDOUT"')
	})
	it("builds preset confirms with the modulation (presets carry only bandwidth/de-emphasis)", () => {
		expect(presetConfirm(s, 1)).toMatchObject({
			kind: "preset",
			prompt: 'apply audio preset "wfm" (wfm 200 kHz)?',
			yes: "apply",
			no: "cancel",
			presetIndex: 1,
			intent: { kind: "preset", name: "wfm", patch: { modulation: "wfm", bandwidth: 200000, deEmphasis: true, deEmphasisTau: 50 } },
		})
	})
	it("reports audio results for 10 s", () => {
		const t0 = s.now
		const st = reduce(s, [
			{ kind: "action:sent", at: t0, key: "audio", intent: { kind: "audio", op: "start" } },
			{ kind: "action:result", at: t0, key: "audio", outcomes: [{ label: "start", result: { ok: false, status: 503, message: "source not connected" }, at: t0 }] },
		], t0)
		expect(audioResultText(st, t0 + 1000)).toBe('audio start failed · 503 · "source not connected"')
		expect(audioResultText(st, t0 + 11_000)).toBeNull()
	})
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run tests/unit/cli/system-vm.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `cli/source/view-models/system.ts`**

```ts
import type { LiveAudioConfig } from "@wavekit/api-types"
import { isOld } from "../data/freshness.js"
import type { AppState, SdrHostView } from "../data/types.js"
import { formatAge, formatBytes, formatClockShort, formatDuration, formatMHzBare, formatRate, formatSampleAge } from "../ui/format.js"
import { sp, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest } from "../ui/ui-state.js"

const RESULT_MS = 10_000
const MODULATIONS: readonly LiveAudioConfig["modulation"][] = ["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"]
const sep = (): string => ` ${glyphs().sep} `
const lbl = (t: string, bold = false): Line => [sp(padEnd(t, 10), "label", bold)]
const kv = (label: string, text: string, width: number, role: Role = "value", bold = false): Line => [...lbl(label, bold), sp(truncate(text, Math.max(1, width - 10)), role)]
const kHz = (hz: number): string => `${(hz / 1000).toFixed(1).replace(/\.0$/, "")} kHz`
const quote = (s: string): string => `"${truncate(sanitize(s), 60)}"`

function noData(state: AppState, path: string): string {
	return state.conn.rest.firstFailAt !== null ? "no data · API unreachable" : `fetching ${path}`
}

function containerBlock(state: AppState, width: number): Line[] {
	const r = state.resources.value
	if (!r) return [kv("CONTAINER", noData(state, "/api/resources"), width, "label", true)]
	const now = state.now
	const role: Role = isOld(state.resources, now) ? "old" : "value"
	const c = r.container
	const g = glyphs()
	const age = state.resources.receivedAt === null ? "?" : formatAge(now - state.resources.receivedAt)
	const lines: Line[] = [[...lbl("CONTAINER", true), sp(c.available ? `cgroup ${c.cgroupVersion}${sep()}as of ${age} ago` : `no cgroup data${sep()}as of ${age} ago`, "label")]]
	const pct = (v: number | null): string => (v === null ? g.na : `${Math.round(v)}%`)
	lines.push(kv("cpu", `${c.cpuUsagePercent === null ? "?" : `${Math.round(c.cpuUsagePercent)}%`}   throttled ${pct(c.cpuThrottledPercent)}   oom kills ${c.oomKillCount ?? "?"}`, width, role))
	const used = formatBytes(c.memoryUsageBytes, 2)
	const mem = c.memoryLimitBytes === null ? `${used}${sep()}no limit` : `${used} of ${formatBytes(c.memoryLimitBytes, 2)} (${pct(c.memoryUsagePercent)})`
	lines.push(kv("mem", mem, width, role))
	const alerts = [...state.alerts].sort((a, b) => b.lastAt - a.lastAt)
	alerts.slice(0, 3).forEach((a, i) => {
		const t = `${g.attention} ${a.alert.type} ${a.alert.severity} ${quote(a.alert.message)}${sep()}${a.count}× since ${formatClockShort(a.firstAt)}${sep()}last ${formatAge(now - a.lastAt)} ago`
		lines.push(kv(i === 0 ? "alerts" : "", t, width, a.alert.severity === "critical" ? "attention" : "value"))
	})
	if (alerts.length > 3) lines.push(kv("", `+${alerts.length - 3} more`, width, "label"))
	return lines
}

function hostBlock(state: AppState, h: SdrHostView, width: number): Line[] {
	const now = state.now
	const g = glyphs()
	const unreachable = h.fetchError !== null
	const role: Role = unreachable ? "old" : "value"
	const polled = h.lastFetchedAt ? `${formatAge(now - Date.parse(h.lastFetchedAt))} ago` : "?"
	const lines: Line[] = [kv("SDR HOST", `${h.sourceId}${sep()}${h.apiUrl}${sep()}polled by core ${polled}${sep()}uptime ${formatDuration(h.uptime)}`, width, "value", true)]
	if (unreachable) lines.push([...lbl(""), glyphSpan("fault"), sp(truncate(` core cannot reach the Pi API${sep()}${quote(h.fetchError ?? "")}`, width - 11), "fault")])
	const proc = (label: string, p: { running: boolean; pid: number | null; restartCount: number } | null, extra: string): Line =>
		p === null
			? kv(label, "?", width, "unknown")
			: [...lbl(label), glyphSpan(p.running ? "live" : "fault"), sp(truncate(` ${p.running ? "running" : "down"}${sep()}pid ${p.pid ?? g.na}${extra}${sep()}${p.restartCount} restarts`, width - 11), role)]
	lines.push(proc("rtl_tcp", h.rtlTcp, ""))
	const mux = h.rtlmux
	lines.push(proc("rtlmux", mux, mux ? `${sep()}${mux.clients} client${mux.clients === 1 ? "" : "s"}${sep()}${formatRate(mux.bytesPerSec)}${sep()}${formatBytes(mux.totalBytesSent)} sent` : ""))
	const smp = h.sampling
	if (smp) {
		const glyph = smp.state === "streaming" ? "live" : smp.state === "waiting" ? "neutral" : smp.state === "unknown" ? "unknown" : "fault"
		const rate = smp.upstream.bytesPerSec === null ? "?" : formatRate(smp.upstream.bytesPerSec)
		lines.push([...lbl("sampling"), glyphSpan(glyph), sp(truncate(` ${smp.state}${sep()}sample age ${formatSampleAge(smp.sampleAgeMs)}${sep()}${rate} upstream (${smp.upstream.rateStatus})${sep()}${smp.epoch.resets} resets`, width - 11), role)])
	}
	const d = h.dongle
	lines.push(kv("dongle", d === null ? "?" : d.found ? `${[d.vendor, d.product].filter(Boolean).join(" ") || "?"}${sep()}serial ${d.serial ?? g.na}` : "not found", width, role))
	for (const w of h.warnings) lines.push(kv("warning", quote(w), width, "attention"))
	for (const e of h.errors) lines.push(kv("error", quote(e), width, "fault"))
	return lines
}

export function audioResultText(state: AppState, now: number): string | null {
	const sepS = sep()
	for (const key of ["audio", "preset"] as const) {
		const rec = state.actions.byKey[key]
		if (!rec || rec.doneAt === null || now - rec.doneAt > RESULT_MS) continue
		const r = rec.outcomes[0]?.result
		const intent = rec.intent
		if (intent.kind === "audio") {
			return rec.state === "ok"
				? `audio ${intent.op === "start" ? "started" : "stopped"}${sepS}${state.audio.value?.clientCount ?? "?"} clients`
				: `audio ${intent.op} failed${sepS}${r?.status ?? "network"}${sepS}${quote(r?.message ?? "?")}`
		}
		if (intent.kind === "preset") {
			return rec.state === "ok" ? `preset ${intent.name} applied` : `preset ${intent.name} failed${sepS}${r?.status ?? "network"}${sepS}${quote(r?.message ?? "?")}`
		}
	}
	return null
}

function audioBlock(state: AppState, width: number): Line[] {
	const a = state.audio.value
	if (!a) return [kv("AUDIO", noData(state, "/api/live-audio/status"), width, "label", true)]
	const role: Role = isOld(state.audio, state.now) ? "old" : "value"
	const glyph = a.pipelineHealth === "error" ? "fault" : a.running ? "live" : "neutral"
	const word = a.pipelineHealth === "error" ? "error" : a.running ? "running" : "stopped"
	let url = a.httpUrl
	try {
		const u = new URL(a.httpUrl)
		url = `${u.host}${u.pathname}`
	} catch {
		url = sanitize(a.httpUrl)
	}
	const c = a.config
	const centre = state.tuner.value?.find(t => t.sourceId === a.sourceId)?.frequency
	const lines: Line[] = [
		[...lbl("AUDIO", true), glyphSpan(glyph), sp(truncate(` ${word}${sep()}${a.clientCount} client${a.clientCount === 1 ? "" : "s"}${sep()}${url}`, width - 11), role)],
		kv(
			"demod",
			`${a.sourceId} at ${centre === undefined ? "?" : `${formatMHzBare(centre, 4)} MHz`}${sep()}${c.modulation} ${kHz(c.bandwidth)}${sep()}squelch ${c.squelch}${sep()}gain ${c.gain}${sep()}${Math.round(a.effectiveSampleRate / 1000)} kHz ${c.audioFormat}`,
			width,
			role,
		),
	]
	const result = audioResultText(state, state.now)
	if (result) lines.push(kv("result", result, width))
	if (a.lastError) lines.push(kv("error", quote(a.lastError), width, "fault"))
	return lines
}

function coreBlock(state: AppState, width: number): Line[] {
	const s = state.status.value
	if (!s) return [kv("CORE", noData(state, "/api/status"), width, "label", true)]
	const lines: Line[] = [kv("CORE", `v${s.version}${sep()}uptime ${formatDuration(s.uptime)}${sep()}reports ${quote(s.status)}`, width, "value", true)]
	for (const c of s.components) if (c.message) lines.push(kv("", `${c.name} ${c.status} ${quote(c.message)}`, width, "label"))
	return lines
}

export function systemLines(state: AppState, width: number, height: number, roomy: boolean): Line[] {
	const gap: Line[] = roomy ? [[]] : []
	const hosts = state.resources.value?.sdrHosts ?? []
	const hostLines = hosts.length > 0 ? hosts.flatMap((h, i) => [...(i > 0 ? gap : []), ...hostBlock(state, h, width)]) : [kv("SDR HOST", state.resources.value ? "none configured" : noData(state, "/api/resources"), width, "label", true)]
	return [...containerBlock(state, width), ...gap, ...hostLines, ...gap, ...audioBlock(state, width), ...gap, ...coreBlock(state, width)].slice(0, height)
}

export function presetNames(state: AppState): string[] {
	return Object.keys(state.presets.value ?? {}).filter((n): n is LiveAudioConfig["modulation"] => (MODULATIONS as readonly string[]).includes(n))
}

/** Presets carry only bandwidth and de-emphasis, so the PATCH also sends the modulation (research (b)). */
export function presetConfirm(state: AppState, index: number): ConfirmRequest | null {
	const names = presetNames(state)
	if (names.length === 0) return null
	const i = ((index % names.length) + names.length) % names.length
	const name = names[i] as LiveAudioConfig["modulation"]
	const p = state.presets.value?.[name]
	if (!p) return null
	return {
		kind: "preset",
		prompt: `apply audio preset "${name}" (${name} ${kHz(p.bandwidth)})?`,
		yes: "apply",
		no: "cancel",
		presetIndex: i,
		intent: {
			kind: "preset",
			name,
			patch: {
				modulation: name,
				bandwidth: p.bandwidth,
				...(p.deEmphasis !== undefined ? { deEmphasis: p.deEmphasis } : {}),
				...(p.deEmphasisTau !== undefined ? { deEmphasisTau: p.deEmphasisTau } : {}),
			},
		},
	}
}
```

- [ ] **Step 4: Run the view-model tests**

Run: `pnpm exec vitest run tests/unit/cli/system-vm.test.ts`
Expected: PASS. The alert's last-seen age is 3 s because the fixture's alert frame arrives at WS base − 1 s, which is now − 3 s. The CORE status is quoted, so the copy check exempts it (assumption 9).

- [ ] **Step 5: Write `cli/source/views/system.tsx`**

```tsx
import type { ReactElement } from "react"
import { Lines } from "../components/lines.js"
import type { AppState } from "../data/types.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { UiState } from "../ui/ui-state.js"
import { presetConfirm, presetNames, systemLines } from "../view-models/system.js"
import type { ViewModule, ViewProps } from "./types.js"

function SystemComponent({ state, width, height, heightClass }: ViewProps): ReactElement {
	return <Lines lines={systemLines(state, width, height, heightClass === "roomy")} width={width + 1} height={height} />
}

export const systemView: ViewModule = {
	id: "system",
	title: "System",
	Component: SystemComponent,
	keyInfo: (state: AppState, _ui: UiState) => ({ rowIds: [], pageSize: 1, ctx: { ...EMPTY_VIEW_CTX, audioRunning: state.audio.value ? state.audio.value.running : null } }),
	onAction: (action, state, ui) => {
		if (action.type === "preset-open") {
			const current = presetNames(state).indexOf(state.audio.value?.config.modulation ?? "")
			const confirm = presetConfirm(state, current + 1)
			return confirm ? { ui: { ...ui, confirm }, effects: [] } : { ui: { ...ui, notice: { text: "no audio presets", at: state.now } }, effects: [] }
		}
		if (action.type === "preset-next" && ui.confirm?.kind === "preset") {
			const confirm = presetConfirm(state, (ui.confirm.presetIndex ?? 0) + 1)
			return confirm ? { ui: { ...ui, confirm }, effects: [] } : undefined
		}
		return undefined
	},
}
```

`preset-next` arrives while the confirm bar is open. The App only reaches `onAction` for actions it does not handle itself, and `preset-next` is one of those, so the view rebuilds the prompt.

- [ ] **Step 6: Write the render test**

`cli/source/views/system.test.tsx`:

```tsx
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { systemView } from "./system.js"

const views = { system: systemView }

describe("System view (spec §6.5)", () => {
	it("golden: 120x40", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "system", cols: 120, rows: 40 })
		expect(h.frame().at(-1)).toContain("a start audio  P preset")
		expect(h.text()).toMatchSnapshot()
		h.unmount()
	})
	it("starts audio without a confirm (T9)", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "system", cols: 120, rows: 40 })
		await h.press("a")
		expect(h.runtime.sent).toEqual([{ kind: "audio", op: "start" }])
		h.unmount()
	})
	it("confirms presets, cycles with P and sends the modulation with the preset", async () => {
		const h = await renderApp({ state: scenarioState("live"), views, view: "system", cols: 120, rows: 40 })
		await h.press("P")
		expect(h.frame().at(-1)).toBe(' ▶ apply audio preset "wfm" (wfm 200 kHz)?   y apply  n cancel  P next')
		await h.press("P")
		expect(h.frame().at(-1)).toContain('apply audio preset "am" (am 10 kHz)?')
		expect(h.runtime.sent).toEqual([])
		await h.press("y")
		expect(h.runtime.sent).toEqual([{ kind: "preset", name: "am", patch: { modulation: "am", bandwidth: 10000 } }])
		h.unmount()
	})
})
```

- [ ] **Step 7: Run, review the golden against §6.5, commit**

```bash
pnpm --filter @wavekit/cli test -- -u
pnpm --filter @wavekit/cli test
```
Compare the snapshot with the §6.5 mockup and fix any difference in the view-model.

```bash
git add cli/source/view-models/system.ts cli/source/views/system.tsx cli/source/views/system.test.tsx cli/source/views/__snapshots__/system.test.tsx.snap tests/unit/cli/system-vm.test.ts
git commit -m "feat(cli): System view (container, alerts, SDR host + sampling slot, audio, presets, core)

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

- [ ] **Step 8: Run the phase 2 gate**

After all of Tasks 34–42 are merged, run the full **Phase gate** from Global Constraints. Expected: everything exits 0.

---

## Phase 3 — integration and validation

Phase 3 starts after the phase 2 gate. Task order: **43 → (44, 46) → 45**. Task 43 (A) goes first and alone. Then Task 44 (A) and Task 46 (B) run in parallel. Task 45 (C) starts once both are merged. A owns every phase-3 fix in `cli/source/**`, except the conditional files in Task 45's **Files** block (see the phase 3 order notes under **Task index and ownership**). B and C report failures to A and edit no other file under `cli/source/**`.

### Task 43: View registry, final entry point and the P22 render matrix (A)

**Owner:** A · **Spec:** §14 registry, §13.2 matrix, P22

**Files:**
- Create: `cli/source/views/registry.ts`
- Modify: `cli/source/cli.tsx` (full rewrite to the new runtime and shell)
- Test: `cli/source/views/matrix.test.tsx`

**Interfaces:**
- Consumes: all five `*View` modules, `createRuntime`/`nodeRuntimeDeps` (Task 15), `formatMessage` (Task 26), `App` (Task 37).
- Produces: `VIEWS: Record<ViewId, ViewModule>`. The shipped `wavekit` binary runs the new dashboard.

- [ ] **Step 1: Write the failing P22 matrix test**

`cli/source/views/matrix.test.tsx`:

```tsx
import { describe, expect, it } from "vitest"
import { renderApp } from "../test/app-harness.js"
import { scenarioState } from "../test/fixtures.js"
import { SCENARIO_NAMES } from "../test/scenario-types.js"
import { VIEW_ORDER } from "../ui/actions.js"
import { findBanned } from "../ui/copy-rules.js"
import { formatMessage } from "../ui/messages/index.js"
import { cellWidth } from "../ui/text.js"
import { VIEWS } from "./registry.js"

const SIZES = [
	[60, 16],
	[60, 20],
	[80, 24],
	[120, 40],
	[200, 50],
] as const

// Feature: cli-dashboard-overhaul, Property 22: render bound
// Validates: spec §5.1, §9
describe("P22: every view × scenario × size fits rows−1 × cols with no banned copy", () => {
	for (const scenario of SCENARIO_NAMES) {
		for (const view of VIEW_ORDER) {
			it(`${scenario} · ${view}`, async () => {
				const state = scenarioState(scenario, { summarize: formatMessage })
				for (const [cols, rows] of SIZES) {
					const h = await renderApp({ state, views: VIEWS, view, cols, rows })
					const frame = h.frame()
					expect(frame.length, `${cols}x${rows} rows`).toBeLessThanOrEqual(rows - 1)
					for (const line of frame) {
						expect(cellWidth(line), `${cols}x${rows}: ${line}`).toBeLessThanOrEqual(cols)
						expect(findBanned(line), `${cols}x${rows}: ${line}`).toEqual([])
					}
					h.unmount()
				}
			})
		}
	}
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm --filter @wavekit/cli test -- matrix`
Expected: FAIL, `./registry.js` not found.

- [ ] **Step 3: Write `cli/source/views/registry.ts`**

```ts
import type { ViewId } from "../ui/actions.js"
import { decodersView } from "./decoders.js"
import { messagesView } from "./messages.js"
import { overviewView } from "./overview.js"
import { receiverView } from "./receiver.js"
import { systemView } from "./system.js"
import type { ViewModule } from "./types.js"

export const VIEWS: Record<ViewId, ViewModule> = {
	overview: overviewView,
	decoders: decodersView,
	messages: messagesView,
	receiver: receiverView,
	system: systemView,
}
```

- [ ] **Step 4: Run the matrix and fix every failure at its source**

Run: `pnpm --filter @wavekit/cli test -- matrix`
Expected: PASS for all 55 cases. For each failure, the message names the size and the offending line:
- An over-wide line points at the view-model that built it. Route it through `fitGroups`, `truncate`, or a column layout.
- Too many rows points at a budget miscount. Check the `slice(0, height)` in the view-model and the header rows passed to `listBudget`.
- A banned word: if it is CLI copy, change the copy. If it is server text, wrap it in double quotes (assumption 9).

Fix the owning file. In phase 3, A owns these fixes in any file under `cli/source/**`. B and C are not running yet while Task 43 is open, and later they report failures to A instead of editing. Fixes stay inside `cli/**`.

- [ ] **Step 5: Rewrite `cli/source/cli.tsx`**

```tsx
#!/usr/bin/env node
import { render } from "ink"
import { App } from "./app.js"
import { HELP_TEXT, parseArgs } from "./args.js"
import { resolveExplicit, type ApiTarget } from "./data/config.js"
import { createRuntime, nodeRuntimeDeps } from "./data/runtime.js"
import { createScreen, installExitHandlers } from "./terminal.js"
import { formatMessage } from "./ui/messages/index.js"
import { detectColor, detectGlyphMode, setGlyphMode } from "./ui/theme.js"
import { VIEWS } from "./views/registry.js"

const parsed = parseArgs(process.argv.slice(2))
if (parsed.kind === "help") {
	process.stdout.write(HELP_TEXT)
	process.exit(0)
}
if (parsed.kind === "error") {
	process.stderr.write(`${parsed.message}\n`)
	process.exit(2)
}

let explicit: ApiTarget | null
try {
	explicit = resolveExplicit(parsed.api, process.env)
} catch (err: unknown) {
	process.stderr.write(`wavekit: ${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(2)
}

setGlyphMode(detectGlyphMode(process.env))
const runtime = createRuntime(nodeRuntimeDeps(explicit, formatMessage))
const screen = createScreen(process.stdout)
screen.enter()
runtime.start()
const instance = render(
	<App runtime={runtime} views={VIEWS} initialView={parsed.view} color={detectColor(process.env, process.stdout.isTTY === true)} />,
	{ exitOnCtrlC: false },
)

let done = false
const shutdown = (code: number): void => {
	if (done) return
	done = true
	runtime.stop()
	instance.unmount()
	screen.restore()
	process.exit(code)
}
installExitHandlers(process, screen, shutdown)
void instance.waitUntilExit().then(() => shutdown(0))
```

- [ ] **Step 6: Build and smoke against the mock core**

```bash
pnpm --filter @wavekit/cli build
node cli/source/test/mock-api/server.ts --port 9100 &
sleep 1
tmux new-session -d -s wk-smoke -x 120 -y 40 "exec env WAVEKIT_API_URL=http://127.0.0.1:9100 node $PWD/cli/dist/cli.js"
sleep 3; tmux capture-pane -p -t wk-smoke | head -5
tmux send-keys -t wk-smoke q; sleep 1
tmux kill-session -t wk-smoke 2>/dev/null; kill %1
```
Expected: the capture starts with ` api ● …  iq ● streaming …` and the switcher row. `q` exits, and the shell does not stay in the alternate screen.

- [ ] **Step 7: Commit**

```bash
git add cli/source/views/registry.ts cli/source/views/matrix.test.tsx cli/source/cli.tsx
git commit -m "feat(cli): wire the five-view dashboard into the wavekit entry point

P22 enumerated render bound over 11 scenarios × 5 views × 5 sizes.

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 44: Remove the legacy UI, add the guards corpus, run the final gates (A)

**Owner:** A · **Spec:** §11 Removed, §13.1 guards corpus, §14 phase 3 (A)

**Files:**
- Delete: `cli/source/legacy-app.tsx`, `cli/source/types.ts`, `cli/source/utils/{args,format,index,source-activity}.ts`, `cli/source/hooks/use-websocket.ts`, `cli/source/hooks/index.ts`, `cli/source/components/index.ts`, `cli/source/components/{backpressure-panel,dashboard,decoded-message,decoder-list,decoder-output,header,help-bar,live-audio-panel,resource-panel,source-status,tab-bar,terminal-link,tuner-panel}.tsx`, `tests/unit/cli/source-activity.test.ts`
- Test: `tests/unit/cli/guards-corpus.test.ts`

- [ ] **Step 1: Write the guards corpus test**

`tests/unit/cli/guards-corpus.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { REST_GUARDS } from "../../../cli/source/data/api-client.js"
import { parseServerMessage } from "../../../cli/source/data/guards.js"
import { ENDPOINT_PATHS, type Endpoint } from "../../../cli/source/data/types.js"
import { loadScenario } from "../../../cli/source/test/scenarios.js"
import { SCENARIO_NAMES } from "../../../cli/source/test/scenario-types.js"

const BY_PATH = new Map((Object.entries(ENDPOINT_PATHS) as Array<[Endpoint, string]>).map(([e, p]) => [p, e]))

describe("guards corpus (spec §13.1)", () => {
	for (const name of SCENARIO_NAMES) {
		it(`accepts every REST body and WS frame in ${name}`, () => {
			const sc = loadScenario(name)
			for (const [path, r] of Object.entries(sc.rest)) {
				const e = BY_PATH.get(path)
				if (!e) continue
				const g = REST_GUARDS[e](r.body)
				expect(g, `${name} ${path}`).toBeDefined()
				expect(g?.rejected, `${name} ${path} rejected items`).toBe(0)
			}
			for (const f of sc.ws) expect(parseServerMessage({ type: f.type, channel: f.channel, data: f.data }), `${name} ${f.type}`).toBeDefined()
		})
	}
})
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run tests/unit/cli/guards-corpus.test.ts`
Expected: PASS. A failure means the scenario JSON (Task 28) or a guard (Task 6) disagrees with the wire shape from research (a)/(c). Fix whichever is wrong, and treat the broadcaster as the authority.

- [ ] **Step 3: Delete the legacy files**

```bash
git rm cli/source/legacy-app.tsx cli/source/types.ts \
	cli/source/utils/args.ts cli/source/utils/format.ts cli/source/utils/index.ts cli/source/utils/source-activity.ts \
	cli/source/hooks/use-websocket.ts cli/source/hooks/index.ts cli/source/components/index.ts \
	cli/source/components/backpressure-panel.tsx cli/source/components/dashboard.tsx cli/source/components/decoded-message.tsx \
	cli/source/components/decoder-list.tsx cli/source/components/decoder-output.tsx cli/source/components/header.tsx \
	cli/source/components/help-bar.tsx cli/source/components/live-audio-panel.tsx cli/source/components/resource-panel.tsx \
	cli/source/components/source-status.tsx cli/source/components/tab-bar.tsx cli/source/components/terminal-link.tsx \
	cli/source/components/tuner-panel.tsx tests/unit/cli/source-activity.test.ts
grep -rn "utils/\|use-websocket\|legacy-app\|from \"../types.js\"\|from \"./types.js\"" cli/source tests/unit/cli || echo "no stale imports"
```
Expected: `no stale imports`. Any hit (other than `views/types.js` and `data/types.js`) must be fixed. The `source-activity` cases already live in `freshness.test.ts` (Task 5).

- [ ] **Step 4: Check that no console output remains**

```bash
grep -rn "console\." cli/source --include=*.ts --include=*.tsx | grep -v "\.test\.tsx\?:" || echo "no console in production code"
```
Expected: `no console in production code`.

- [ ] **Step 5: Run the full gate from a clean build**

```bash
rm -rf cli/dist
pnpm --filter @wavekit/api-types build
pnpm run typecheck
pnpm test
pnpm --filter @wavekit/cli test
pnpm --filter @wavekit/cli build
pnpm run lint
pnpm exec prettier --check cli tests/unit/cli
```
Expected: all exit 0. `pnpm run lint` may report the pre-existing warnings, but no errors.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/cli/guards-corpus.test.ts
git commit -m "chore(cli): remove the legacy dashboard; guards corpus over every scenario

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

The `git rm` deletions from Step 3 are already staged, so this commit includes them. Do not run `git add -A`.

---

### Task 45: tmux validation, performance runs and terminal findings (C, after Tasks 44 and 46)

**Owner:** C · **Spec:** §13.4, §15 (Esc split risk), §16 · **Starts after** Task 44 (A) and Task 46 (B) are merged. Task 43 has switched `cli.tsx` to the new shell, Task 44 has removed the legacy UI, and Task 46 has created `docs/CLI.md`. C owns only its `## Validation` section of that file.

**Files:**
- Modify: `docs/CLI.md` (append the `## Validation` section)
- Modify (only if Step 2 finds an idle-CPU miss): `cli/source/data/runtime.ts`, `tests/unit/cli/runtime.test.ts`
- Modify (only if Step 3 finds split Esc): `cli/source/hooks/use-keys.ts`, `cli/source/test/harness.ts`, `cli/source/hooks/use-keys.test.tsx` (new)

These conditional files are C's for the duration of Task 45 only, and A does not edit them while Task 45 runs. Every other failure is reported to A, who owns the fix (phase 3 fix ownership).

- [ ] **Step 1: Run the full validation script against the mock core**

```bash
pnpm --filter @wavekit/cli build
cli/tools/validate/matrix.sh all 2>&1 | tee "$TMPDIR/wavekit-validate.log"
```
Expected: `failed checks: 0`, plus a `perf.md` table under `$TMPDIR/wavekit-cli-validate/`. In tmux, `api-down-cached` looks like `api-down`, because the mock cannot serve a cache it never answered. The cached states are covered exactly by the P22 render matrix. For any other failed check, open the named capture and report it to A with the check name, scenario, view, size and capture path. Do not edit the view-model yourself. A fixes the owning file and merges, then C rebuilds and reruns `matrix.sh all` until `failed checks: 0`.

- [ ] **Step 2: Compare against the budgets**

Check each row of `perf.md` against spec §13.4:

| Measure | Budget |
|---|---|
| Frames/s | ≤ 5 |
| `ESC[2J` | 0 outside resize-shrink |
| CPU, idle | < 2 % |
| CPU, 50/s | < 8 % |
| CPU, 500/s | responsive, key→frame < 300 ms |
| RSS growth over 60 s | < 20 MB |

If idle CPU misses its budget at 200×50, apply the spec §15 mitigation in `cli/source/data/runtime.ts`. When the queue is empty and only the 1 s clock advances, tick every 500 ms instead of 200 ms. Add a test asserting ≤ 2 commits/s while idle. Record misses honestly. The doc states measured numbers, including misses.

- [ ] **Step 3: Check Esc handling under tmux**

```bash
for et in 0 500; do
	tmux -L wkesc new-session -d -s esc -x 120 -y 40 "exec env WAVEKIT_API_URL=http://127.0.0.1:9100 node $PWD/cli/dist/cli.js --view decoders"
	tmux -L wkesc set -g escape-time $et
	sleep 2; tmux -L wkesc send-keys -t esc Down Enter; sleep 0.5; tmux -L wkesc send-keys -t esc Escape; sleep 0.5
	tmux -L wkesc capture-pane -p -t esc | grep -c "ADS-B\|DMR/P25" ; tmux -L wkesc kill-server
done
```
(Start the mock first: `node cli/source/test/mock-api/server.ts --port 9100 &`, and stop it afterwards.) Expected: `0` both times, meaning Esc closed the detail. If a count is non-zero, Esc was misread. Implement the 20 ms escape buffer.

`cli/source/hooks/use-keys.ts` (replaces the Task 36 version):

```ts
import { useInput } from "ink"
import { useRef } from "react"
import type { Action } from "../ui/actions.js"
import { keyName, resolveKey, type KeyContext } from "../ui/keymap.js"

const ESC_BUFFER_MS = 20
/** When ESC and the rest of a CSI sequence arrive in separate chunks, Ink reports Esc then "[A". */
const SPLIT: Readonly<Record<string, string>> = {
	"[A": "<up>", "[B": "<down>", "[C": "<right>", "[D": "<left>",
	OA: "<up>", OB: "<down>", OC: "<right>", OD: "<left>",
	"[5~": "<pgup>", "[6~": "<pgdn>", "[Z": "<shift-tab>",
}

export function useKeys(ctx: KeyContext, dispatch: (a: Action) => void): void {
	const ref = useRef({ ctx, dispatch })
	ref.current = { ctx, dispatch }
	const pending = useRef<NodeJS.Timeout | null>(null)
	const fire = (name: string): void => {
		const action = resolveKey(ref.current.ctx, name)
		if (action) ref.current.dispatch(action)
	}
	useInput((input, key) => {
		if (pending.current) {
			clearTimeout(pending.current)
			pending.current = null
			const joined = SPLIT[input]
			if (joined) return fire(joined)
			fire("<esc>")
		}
		const name = keyName(input, key)
		if (name === "<esc>") {
			pending.current = setTimeout(() => {
				pending.current = null
				fire("<esc>")
			}, ESC_BUFFER_MS)
			return
		}
		fire(name)
	})
}
```

In `cli/source/test/harness.ts`, make `press` wait 40 ms after a lone `"\x1b"` (`await settle(seq === "\x1b" ? 40 : 15)`) so every existing Esc test still sees the result. Add `cli/source/hooks/use-keys.test.tsx`:

```tsx
import { Text } from "ink"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { renderAt } from "../test/harness.js"
import { EMPTY_VIEW_CTX } from "../ui/actions.js"
import type { KeyContext } from "../ui/keymap.js"
import { useKeys } from "./use-keys.js"

const ctx: KeyContext = { view: "decoders", confirm: null, help: false, input: false, edit: false, detail: true, heightClass: "roomy", v: EMPTY_VIEW_CTX }

function Probe() {
	const [last, setLast] = useState("none")
	useKeys(ctx, a => setLast(a.type === "move" ? `move ${a.delta}` : a.type))
	return <Text>{last}</Text>
}

describe("useKeys escape buffer", () => {
	it("joins a split arrow and still delivers a lone Esc", async () => {
		const h = await renderAt(<Probe />, { cols: 40, rows: 5 })
		void h.press("\x1b")
		await h.press("[A")
		expect(h.text()).toBe("move -1")
		await h.press("\x1b")
		expect(h.text()).toBe("escape")
		h.unmount()
	})
})
```

Rerun `pnpm --filter @wavekit/cli test` and the tmux check.

- [ ] **Step 4: Append the `## Validation` section to `docs/CLI.md`**

Append exactly this structure, filled with the measured values from `perf.md` and the matrix log. Every number must come from this run:

```markdown
## Validation

Measured on <date> with `cli/tools/validate/matrix.sh all` against the mock core (no live core, no writes outside the mock). Terminal: tmux <version>, <OS>, Node <version>.

### Render matrix

11 scenarios × 5 views × 5 sizes (60×16, 60×20, 80×24, 120×40, 200×50): <N> captures, <F> failed checks. The Ink render matrix (`cli/source/views/matrix.test.tsx`, P22) covers the same grid in CI.

### Resize

120×40 → 60×20 → 200×50 → 80×24 → 59×15 → 120×40, captured at 0.3 s and 2 s: <result>.

### Transitions

ws drop → gap opens, drop cells `?` within <s> s · ws up → gap closes `not replayed` · rest hang → banner after <s> s · rest ok → recovered.

### Cost (60 s per run, 120×40)

| run | frames/s | ESC[2J | CPU avg | RSS growth | key→frame |
|---|---|---|---|---|---|
<rows from perf.md>

<one line per budget miss, stating the measured value and the budget>

### Terminal limitations found

- OSC 52 copy: <tmux result with/without `set-clipboard on`>.
- Esc under tmux `escape-time 0` and `500`: <result; whether the 20 ms buffer was needed>.
- Ambiguous-width glyphs (● ○ ▁): render 2 columns wide in some CJK locales; use `WAVEKIT_ASCII=1`.
- 16-colour themes: every state also carries a glyph or word, so meaning does not depend on colour.
```

- [ ] **Step 5: Commit**

```bash
git add docs/CLI.md
# only if Step 3 required the escape buffer:
git add cli/source/hooks/use-keys.ts cli/source/hooks/use-keys.test.tsx cli/source/test/harness.ts
git commit -m "docs(cli): record tmux matrix, resize, transition and cost measurements

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

---

### Task 46: User documentation, coordination status and copy audit (B)

**Owner:** B · **Spec:** §11 (`docs/CLI.md`), §14 phase 3 (B), §9 copy rules · **Starts after** Task 43 (A), which creates `cli/source/views/matrix.test.tsx` and switches `cli.tsx`, is merged. It runs in parallel with Task 44. Do Steps 2 and 3 first. Step 1's grep runs only after Task 44 is merged, because the legacy components it deletes still contain banned literals.

**Files:**
- Create: `docs/CLI.md` (everything except `## Validation`, which Task 45 appends)
- Modify: `docs/CLI-COORDINATION.md` (append to `## Status` and add `## Observed contract notes`)

- [ ] **Step 1: Run the copy audit**

```bash
pnpm --filter @wavekit/cli test -- matrix
pnpm exec vitest run tests/unit/cli/copy-rules.test.ts tests/unit/cli/strip.test.ts tests/unit/cli/banner.test.ts tests/unit/cli/args.test.ts
grep -rn "Loading\|Waiting for\|healthy\|successfully\|please\|N/A\|n/a" cli/source --include=*.ts --include=*.tsx | grep -v "copy-rules\|\.test\." || echo "no banned literals"
```
Expected: PASS and `no banned literals`. Any hit is CLI copy that must change. B does not edit the file. B reports the file, line and literal to A, who owns the fix (phase 3 fix ownership), then reruns this step after A's fix is merged.

- [ ] **Step 2: Write `docs/CLI.md`**

````markdown
# WaveKit CLI dashboard

`wavekit` is the terminal dashboard for a running WaveKit core. It reads the core's REST API and WebSocket feed and shows the receive chain in the order an operator checks it: is the API reachable, is IQ arriving, what is the receiver tuned to, which decoders are up, which of them can hear the tuned window, is anything decoding, and how much IQ is being dropped now.

It never claims a verdict. You will not see "OK", "healthy" or "stable". Every value is evidence with an age, and anything unknown is shown as `?`.

## Running

```bash
pnpm dashboard                 # build and start
wavekit                        # after a build: node cli/dist/cli.js
wavekit --view receiver        # open a view first (overview, decoders, messages, receiver, system)
wavekit --api http://192.0.2.10:9000
```

The old view names still work as aliases: `dashboard`, `output`, `backpressure`, `sources`, `tuner`, `live-audio`, `resources`. An unknown view prints the valid names and exits with status 2.

| Variable | Meaning |
|---|---|
| `WAVEKIT_API_URL` | API base URL; the WebSocket is derived as `ws://host/ws` |
| `WAVEKIT_WS_URL` / `WAVEKIT_WS_URLS` | WebSocket URL (first of a comma list); the API base is derived from it |
| `NO_COLOR` | no colour; bold, dim and inverse stay |
| `WAVEKIT_ASCII=1` | ASCII glyphs (`* o x ! ? - ...`) instead of `● ○ × ! ? — …` |

With nothing set, wavekit tries `http://127.0.0.1:9000`, then `http://127.0.0.1:3000`. It never uses `localhost` and never port 4713, which is the RTL-TCP relay. If no candidate answers, it retries every 15 s and the banner lists what it tried.

## Reading the screen

Row 1 is the **chain strip**, one lane per link:

| Lane | Examples | Meaning |
|---|---|---|
| `api` | `api ● 2s` · `api ws ● rest × 45s` · `api × 3m` | `●` only when the WebSocket is open **and** REST answered within 15 s; the age is since the last REST success |
| `iq` | `iq ● streaming` · `iq × no samples 23s` · `iq ● receiving` · `iq ? unknown` | `streaming` only from fresh source activity; `connected` on older cores; `receiving` when only the WS byte-rate heartbeat is available |
| `rx` | `rx 445.971 MHz ±1.024 · external control` | centre frequency, half span, who controls the tuner |
| `decoders` | `decoders 8/9 up · 1 failing · 2 in window` | `failing` = faulted, down or crash-looping; `in window` uses the **nominal** band table |
| `drops` | `drops !34% now` | share of offered IQ dropped over the last 10 s on decoder branches; `!` = a branch is in backpressure now; `?` = not computable |

Legend: `●` live · `○` idle or off · `×` fault · `!` attention now · `?` unknown · `—` not applicable. Dim text is older than 15 s. `now` figures cover the last 10 s and `lifetime` figures are counters; the two are never mixed. *Nominal* bands come from WaveKit's built-in table, not from the API, until core exposes target bands.

When the API or the live feed has a problem, a one-line **banner** under the strip says what, why, when it retries, and how old the shown data is (`data as of 18:07:40`). Cached data stays visible but dim. While the WebSocket is down the message feed shows a gap row, and when it reconnects the row closes as `── gap 18:08:37–18:10:41 · 2m 04s · not replayed ──`.

## Views

| Key | View | Shows |
|---|---|---|
| `1` | Overview | receiver summary, decoder table, latest messages |
| `2` | Decoders | process state, restarts, errors, decodes, IQ in, drop now/lifetime per decoder; detail pane with a 30-minute decode sparkline |
| `3` | Messages | filterable, pausable feed with per-protocol summaries and a JSON detail |
| `4` | Receiver | source transport and activity, tuner (with edit mode), relay and its command history, fanout drops, upstream (Pi) drops |
| `5` | System | container CPU/memory and alerts, SDR host processes (and Pi sampling when core reports it), live audio, core version |

## Keys

| Key | Where | Action |
|---|---|---|
| `1`–`5`, `Tab`, `Shift-Tab` | anywhere | switch view |
| `?` | anywhere | help overlay (any key closes) |
| `q`, `Ctrl-C` | anywhere (`q` types inside the filter) | quit and restore the terminal |
| `r` | anywhere | reconnect now and refetch everything |
| `↑↓` `j k`, `PgUp PgDn`, `g G` | lists | move, page, top / newest |
| `Enter` / `Esc` | lists | open the detail / close it, clear the selection, clear the filter |
| `/`, `p`, `F`, `y` | Messages | filter, pause/resume, cycle presets, copy JSON (OSC 52) |
| `s` `x` `R` | Decoders | start / stop / restart the selected decoder (confirm) |
| `e`, `c` | Receiver | edit the tuner (WaveKit control only), take or release control (confirm) |
| `a`, `P` | System | start/stop live audio, apply an audio preset (confirm) |

Filter grammar: words are AND-ed, a comma inside a word means OR (`readsb,ais`), and `!emerg` keeps emergencies only.

## Writes

Navigation never writes. Every write except audio start/stop goes through a confirm bar that names the target, for example `▶ restart readsb · up 51s · pid 1531   y restart  n cancel`. Only `y` sends. `Enter` does not confirm. Tuner edits send nothing until you confirm, and then go out one command at a time, stopping at the first failure. The result line reports exactly what was sent.

## Terminal requirements

- At least 60×16. Smaller terminals show one line saying so; the view comes back when the terminal grows.
- The dashboard uses the alternate screen and restores it on exit, Ctrl-C, SIGTERM and crashes.
- The frame is one row shorter than the terminal, so the terminal never has to clear and scroll.
- OSC 52 copy only works where the terminal allows it (in tmux, `set -g set-clipboard on`). The CLI reports `copy sent (OSC 52)` because it cannot observe the result.

## Development

```bash
pnpm --filter @wavekit/cli test                  # Ink render tests (cli/source/**/*.test.tsx)
pnpm exec vitest run tests/unit/cli              # pure logic + fast-check properties
node cli/source/test/mock-api/server.ts --port 9100   # mock core (the only target for write actions)
WAVEKIT_API_URL=http://127.0.0.1:9100 node cli/dist/cli.js
cli/tools/validate/matrix.sh all                 # tmux matrix, resize, transitions, cost
```

Pure code (`cli/source/data`, `ui`, `view-models`) must never import Ink, React or `.tsx`. Root tests compile it under the strictest flags. Mock scenarios live in `cli/tools/mock-api/scenarios/` and use documentation addresses only.

Pending API requests that would remove CLI fallbacks are tracked in `docs/CLI-COORDINATION.md`.
````

- [ ] **Step 3: Append to `docs/CLI-COORDINATION.md`**

Append this under the existing `## Status` list, as the last bullet:

```markdown
- 2026-10-08 — CLI overhaul implemented on the plan
  `docs/superpowers/plans/2026-10-08-cli-dashboard-overhaul.md`: five views,
  chain strip, confirmed writes, mock-core validation (`docs/CLI.md` ·
  Validation). Requests 1–7 below remain open; the CLI ships a fallback for each.
```

Append a new section at the end of the file:

```markdown
## Observed contract notes (CLI, informational)

Found while building the CLI against `src/api/**`; no CLI change is blocked.

- `aircraft:lost` is broadcast as `{icao, aircraft}`, while
  `packages/api-types/src/aircraft.ts` declares `AircraftLostEvent.data` as
  `{icao, lastSeen, totalMessages, trackDuration}`. The CLI follows the broadcaster.
- `decoder:health` is sent on the `health` channel without `previousHealth`, and
  the comment mentioning `degraded` does not match the enum (`running|idle|faulted`).
- `/health` always returns `{status: "ok"}`; only the HTTP code (200/503) carries
  information. The CLI uses it for discovery only.
- `dataRate` is computed as KiB/s (`bytes/1024/s`) though commented as KB/s.
- `/api/live-audio/presets` entries carry only bandwidth/de-emphasis; the CLI adds
  `modulation` itself when applying a preset.
- `eslint.config.js` lists no project covering `cli/tools/**`; the CLI therefore
  keeps its TypeScript dev tooling under `cli/source/test/` (excluded from the build).
```

- [ ] **Step 4: Format and commit**

`docs/CLI-COORDINATION.md` is shared with other teams, and they may have unstaged edits in it. Before staging, run `git diff docs/CLI-COORDINATION.md`, or `git status`, which shows `??` while the file is still untracked. If any hunk other than the two above is not yours, do **not** stage the file. Report it to the orchestrator and commit `docs/CLI.md` alone.

```bash
pnpm exec prettier --check docs/CLI.md || pnpm exec prettier --write docs/CLI.md
git add docs/CLI.md docs/CLI-COORDINATION.md
git commit -m "docs(cli): user guide for the overhauled dashboard; coordination status and contract notes

Claude-Session: https://claude.ai/code/session_01YJGgH93pe7X3coKxorLyx6"
```

- [ ] **Step 5: Final phase 3 gate (after Tasks 43–46 and every A follow-up fix are merged)**

Run the full **Phase gate** from Global Constraints once more on the merged branch. Expected: everything exits 0. The plan is complete when the gate is green and `docs/CLI.md` includes C's `## Validation` section.
