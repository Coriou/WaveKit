# Decoder Enablement (WG13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every decoder the image ships exists without YAML, has one `auto | always | off` switch, listens
off-centre through the core channelizer, is admitted only within a drop-free CPU budget, and ADS-B gets
its 2.4 Msps rate when the operator tunes to 1 090 MHz.

**Architecture:** A frozen contract (`src/decoders/enablement/contract.ts`,
`src/core/rate-policy-contract.ts`, `packages/api-types`) lets six lanes build in parallel: a pure
catalogue and mode resolver (CM), a pure placement planner (PL), an efficiency gate and sampler (EF), an
in-place channel retune in `wavekit-chan` (CH), a rate policy and link advisor on the tuner controller
(RP), and the `DecoderManager` integration that runs one process per placement from its serial caps
worker (MG). Main composes everything in `src/index.ts` and `src/api/server.ts`, then runs the live
acceptance and flips `CHANNELIZER_AUTO_ACCEPTED` only on a passed capacity record.

**Tech Stack:** TypeScript (Node 24, ESM, strict), Zod, Fastify, Vitest + fast-check, Rust
(`native/wavekit-chan`), pnpm + Turborepo.

**Spec:** `docs/specs/decoder-enablement/requirements.md`, `docs/specs/decoder-enablement/design.md`,
`docs/specs/decoder-enablement/tasks.md`. Executors read the spec section each task cites; this plan
does not restate the design tables (costs, worst windows, constants rationale) beyond the values a task
pins.

## Global Constraints

- Worktree `/Users/ben/Projects/wavekit-wg13`, branch `batch/wg13`. Each lane works in its own worktree off
  `batch/wg13` after task 0.1 lands; commit only own paths with `git commit -m "..." -- <paths>`; never
  `git add -A`; never Prettier `docs/CLI-COORDINATION.md`; do not push unless the brief says so.
- Hard gates for every lane: no RF, tuning, receiver or Raspberry Pi work, no deploys, no Docker builds or
  runs, no network access. Never connect to `127.0.0.1:15555/15556/18080`, `host.docker.internal`,
  LAN/Pi IPs, or ports 9000/5173/8081/8082. Tests use fake decoders/child processes, fake sources, a fake
  rtl_tcp on an ephemeral `127.0.0.1` port, fake channelizer transports, temp dirs and injected clocks.
  Only Main runs "Live (Main)" steps.
- Main-only seams: `src/index.ts`, `src/api/server.ts`, `src/config.ts`, `config/*.yaml`, `packages/**`,
  `docs/**`, `cli/**`, `src/decoders/enablement/contract.ts`, `src/core/rate-policy-contract.ts`,
  `src/api/routes/decoder-rate-schemas.ts`, `src/api/routes/decoder-status-schemas.ts`,
  `tests/unit/decoders/decoder-enablement-contract.test.ts`, build files (`package.json`, lockfile,
  `Dockerfile`, `Makefile`, `native/wavekit-chan/Cargo.toml`, `Cargo.lock`). A new `packages/*` manifest
  needs a root `Dockerfile` COPY (none is planned).
- Never edit `src/core/scanner/**` (owned by the concurrent identify lane), `src/decoders/band-defaults.ts`,
  `src/decoders/band-region.ts`, `src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`
  (byte-identical). Importing from `src/core/scanner/cpu-meter.ts` and `src/core/bandplans/scanner-feed.ts`
  is allowed (import only).
- Defaults: shipped config (`decoders: []`) and no new key set ⇒ every route, frame, argv, log line and
  receiver write is byte-identical to the WG13 base except the requirements "Defaults" paragraph. Every
  golden a lane changes is listed in its report with the requirement that changes it.
- Never bake band time-sharing into defaults; no component writes a frequency; the 1 090 MHz raise
  (6.1/6.2) is the only automatic radio write and only after an operator REST retune.
- PERFORMANCE rules: IQ is read once per source; channel decoders use a per-source channelizer channel,
  never another full-rate fanout branch; no new csdr or `sh -c` DSP chains.
- Trust: drop-free and utilisation claims default to the safe answer on unknown, missing or malformed
  input (`unknown` closes the gate; null CPU is reported `null`); never echo untrusted values (host names,
  error messages): logs use fixed fields and `safeErrorFields` from `src/decoders/safe-error-fields.ts`.
- Code: strict TS, no `any`, ESM with `.js` relative imports, `import type`, tabs/no semicolons/double
  quotes, errors from `src/utils/errors.ts` (`WaveKitError` subclasses), component loggers via
  `createComponentLogger`, Zod at boundaries, streams with `error` handlers.
- Property tests: fast-check `numRuns >= 100`, trace comment
  `// Feature: decoder-enablement, Property N: <name>` and `// Validates: Requirements X.Y`.
- Public repo: no memory, handoff, review-tool or model names in tracked files, commits or PR text.
- Every lane, before reporting: its touched test files, `pnpm run typecheck`, `pnpm run lint`, and
  `make chan-test` when it touched Rust. Lanes do not run the full root suite (Main does in MA.3).
- Execution model: each lane is an orchestrator delegating implementation with an independent review per
  diff; lanes report base/head, commits, check output and changed goldens.

## Assumptions (spec gaps resolved here)

- **A1 `useChannelizer` presence (accepted by Main; now in the spec).** `DecoderConfigSchema.useChannelizer`
  is `z.boolean().default(false)` (`src/config.ts:222`), so an explicit `false` is indistinguishable from
  absence after parsing, and the schema default cannot change without altering the parsed config and
  export. A YAML decoder is eligible for channel placements (VFO, band-plan, off-centre) only when
  `useChannelizer === true`; every other YAML decoder gets exactly today's single raw placement. The
  requirements "Defaults" paragraph and the design "Placement" section already state this (amended before
  0.1), so PL.1 builds on an accepted requirement; no MA.2 step remains for it.
- **A2 Unknown cost.** A placement of a type absent from `DECODER_COSTS` (a non-catalogue YAML type) is
  charged `DECODER_COST_UNKNOWN_CORES = 0.60` (the largest declared cost, basis `estimate`): safe on
  unknown.
- **A3 Budget on other hosts.** `defaultCpuBudgetCores(arch, cpuCount)` returns 0.75 only for `arm64` with
  `cpuCount <= 4`, and 1.5 otherwise (including `arm64` with more cores).
- **A4 Band-plan change trigger.** No `bandplans:changed` event exists in `src/core/bandplans/`. The manager
  exposes `notifyBandplansChanged(): void`; Main calls it in MA.1 from the band-plans broadcast path in
  `src/index.ts` (the same place that publishes `bandplans` frames).
- **A5 CPU meter.** The efficiency monitor takes a `{ readonly normalisedPercent: number | null }` port.
  Main passes the scanner's existing `CpuMeter` instance (`src/core/scanner/cpu-meter.ts`) when the scanner
  is constructed, otherwise a new `CpuMeter` started by `src/index.ts` with `sampleMs: EFFICIENCY_SAMPLE_MS`.
- **A6 `DecoderStatus.efficiency`.** Requirement 11.1 names it; the design table does not shape it. It is
  `efficiency?: { detail: DecoderEfficiencyDetail; retryAt?: string }`, present only when the primary
  placement is blocked by the gate.
- **A7 Placement key.** `<decoderId>#<channelHz>@<sourceId>` for channel reach and
  `<decoderId>#raw@<sourceId>` / `<decoderId>#centre@<sourceId>` for raw and centre reach.
- **A8 Channelizer auto start = lazy construction plus a linger.** `ChannelizerManager`
  (`src/core/channelizer/channelizer-manager.ts`) has no start/stop API: it spawns a source's engine on the
  first `requestChannel` and retires it in the private `stopIfIdle` as soon as the last channel goes.
  `src/index.ts` (around lines 1095-1142) builds the manager and the settlement observer only when
  `config.channelizer.enabled`, else calls `decoderManager.setChannelizer(null)`. "Auto start" is therefore
  (a) Main constructing the manager and observer when `channelizerComposition(config.channelizer,
CHANNELIZER_AUTO_ACCEPTED)` (0.1) returns `"auto"` — still lazy, nothing spawns before the first channel
  request — and (b) a per-source idle linger of `CHANNELIZER_IDLE_STOP_MS` owned by lane CH (task CH.2) as
  a new optional `idleStopMs` dep of `ChannelizerManager`, passed by Main only in `"auto"` composition. MG
  never starts or stops an engine and never defers `releaseChannel`; it only requests and releases channels.
  `channelizer.enabled: true` keeps today's immediate retire (no `idleStopMs`).
- **A9 External-control advice comes from the relay path.** A REST `setFrequency` in external control is
  rejected by `validateSourceForControl` (`src/core/tuner-controller.ts`) before any hook runs, and relay
  (SDR++) retunes go through `applyExternalCommand` (`SET_FREQUENCY` case, around lines 643-866), never
  through `setFrequency`. Requirement 6.4/6.5's external-control advice is therefore emitted by a new
  `RatePolicy.onRelayRetune(sourceId, hz)` called from the accepted relay `SET_FREQUENCY` update: it emits
  `skipped` / `external-control` with the link advisory when the raise conditions other than control mode
  hold, and never writes. It is edge-triggered per source (one event on entering reach; re-armed when a
  relay retune leaves reach, on `reset`, or when control returns to internal) so an SDR++ drag does not
  flood the `tuner` channel. An accepted relay `SET_SAMPLE_RATE` calls `onOperatorSampleRate` (the relay
  client's rate wins, 6.3), so a stale record never restores over it. `beforeOperatorRetune` itself never
  sees external control through the controller; if called so directly it writes nothing and emits nothing.
- **A10 Link feed.** `SourceManager` has no bytes/s event; it emits `metrics(sourceId, { bytesReceived,
dataRate })` every `METRICS_INTERVAL_MS` (5 s, `src/core/source-manager.ts:210`) with `dataRate` in KiB/s
  (`emitMetrics`, around line 1892). MA.1 feeds `LinkAdvisor.observe(sourceId, dataRate * 1024,
tuner.sampleRateOf(sourceId), Date.now())` from that event and calls `LinkAdvisor.reset(sourceId)` on
  `connected` (every (re)connect, lines 1011/1443). The advisor's 10 s window therefore holds two samples;
  it treats a window as full once it spans `LINK_SUSTAINED_WINDOW_MS`.
- **A11 `dropping` after a raise.** The event action union (`raised | restored | skipped`) has no slot for a
  later re-classification, so a `dropping` verdict found by RP.2's periodic re-check surfaces as the
  `critical` `link-capacity` resource alert (7.2) and not as a new `tuner:rate-policy` event; the raise
  event keeps carrying the advisory computed at raise time. The re-check never writes the radio (7.2
  "never blocks or reverts a raise").

## Review Focus

1. **Shipped config, no binaries installed (dev Mac, `make dev-local`).** All nine catalogue instances are
   listed, none spawns, each reports `decoder-unavailable`; no spawn-error log storm, no crash loop, no
   restart timer. Test: CM.1 `binary.test.ts` "missing binary yields unavailable without spawning" and
   MG.1 "unavailable catalogue instance never spawns and never schedules a restart".
2. **Source not yet connected (centre or rate null) at boot.** The planner must not throw or place on a
   null window; decoders show `frequency-out-of-band` only once a window exists, and before that keep
   today's "unknown never suspends" rule for YAML decoders. Test: PL.1 "source with null centre yields no
   placements and no throw".
3. **VFO jitter while dragging in Listen.** Many VFO events per second must cause at most one channel move
   per `VFO_SETTLE_MS` and no process restart storm. Test: PL.2 Property 13 planner half and MG.1
   "VFO burst produces one retarget".
4. **Gate oscillation.** A placement that is blocked, then admitted, then suspended by probation must back
   off (5 min doubling to 30 min) and never flip every sample tick. Test: EF.1 "probation failure doubles
   retry up to 30 min" and MG.2 "blocked placement is retried no more than once per retry period".
5. **REST retune while the rate write fails or the source is relay-owned.** The frequency must not be
   written after a failed raise, the record must not be set, and a relay-owned source must never be
   written. Test: RP.1 "failed raise leaves frequency unwritten and no record" and "relay retune into
   reach emits one skipped external-control and writes nothing".
6. **Settings PATCH `mode` end to end.** CM.2 widens the patch policy, but the route's own shape gate
   (`PATCH_BODY_KEYS`, `isSettingsPatchShape`, the docs-only body schema in `src/api/routes/decoders.ts`)
   would still reject `mode` with today's 400. Test: MG.1 `decoder-settings-route-mode.test.ts`
   "PATCH mode always persists through the route and calls applyDecoderMode once".
7. **Link `dropping` is actually produced.** Without a feed and a re-check after the raise, the advisor can
   only ever say `unproven`. Test: MA.1 wiring "metrics event feeds observe and connected resets" and RP.2
   "re-check 10 s after a raise reports dropping once as a critical alert".

---

## File Structure

| Path                                                                                                                                         | Owner    | Responsibility                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/{decoders,decoder-settings,tuner,resources}.ts` (modify)                                                             | Main 0.1 | DTOs and widened unions (design "Contract")                                                                                 |
| `src/config.ts` (modify)                                                                                                                     | Main 0.1 | `decoders[].mode`, `decoderPolicy`, `channelizer.auto`, all optional, no default                                            |
| `src/decoders/enablement/contract.ts` (create)                                                                                               | Main 0.1 | constants, catalogue type list, costs, planner and gate types                                                               |
| `src/core/rate-policy-contract.ts` (create)                                                                                                  | Main 0.1 | rate policy and link constants and ports                                                                                    |
| `src/api/routes/decoder-rate-schemas.ts`, `src/api/routes/decoder-status-schemas.ts` (modify)                                                | Main 0.1 | Fastify enum and optional fields                                                                                            |
| `cli/source/data/guards.ts`, `cli/source/view-models/decoders.ts` (modify)                                                                   | Main 0.1 | guard and reason words                                                                                                      |
| `src/decoders/enablement/{catalogue,mode,binary}.ts` (create)                                                                                | CM       | catalogue builder, mode precedence, binary resolution                                                                       |
| `src/decoders/settings/{layers,patch-policy,service,store}.ts` (modify)                                                                      | CM       | settings `mode` (store, patch policy, view, service port)                                                                   |
| `src/decoders/options/{dsd-fme,multimon-ng,direwolf}.ts` (modify)                                                                            | CM       | `channelsHz` descriptors                                                                                                    |
| `src/decoders/enablement/{placement,channel-sources}.ts` (create)                                                                            | PL       | planner; VFO and band-plan lookups                                                                                          |
| `src/decoders/{base-decoder,audio-demod-decoder,iq-decimate-decoder}.ts`, `src/decoders/builtin/{readsb,lora-meshtastic}.ts` (modify)        | PL       | `reach()` hook                                                                                                              |
| `src/decoders/enablement/{efficiency-gate,efficiency-monitor}.ts` (create), `src/core/source-fanout-router.ts` (modify)                      | EF       | gate core, sampler, per-source branch telemetry                                                                             |
| `native/wavekit-chan/src/**`, `src/core/channelizer/{protocol,channelizer-process,channelizer-manager}.ts` (modify)                          | CH       | `retune` request (CH.1); per-source idle linger `idleStopMs` (CH.2, A8)                                                     |
| `src/core/{rate-policy,link-advisory}.ts` (create), `src/core/{tuner-controller,resource-aggregator}.ts`, `src/api/routes/tuner.ts` (modify) | RP       | 1090 raise/restore, relay external-control advice (A9), link advisory, post-raise link re-check (A11), alert                |
| `src/decoders/{manager,manager-options,types}.ts`, `src/api/serializers/decoder-status.ts`, `src/api/routes/decoders.ts` (modify)            | MG       | placements, mode, gate, channelizer auto, efficiency route handler, settings PATCH route shape gate accepting `mode` (MG.1) |
| `src/index.ts`, `src/api/server.ts`, `config/default.yaml`, `docs/**` (modify)                                                               | Main MA  | composition, docs, acceptance                                                                                               |

Tests live under `tests/unit/decoders/enablement/` (CM, PL, EF, MG unit), `tests/unit/core/` (RP, CH TS
side), `tests/unit/api/` (routes), `native/wavekit-chan` (Rust).

Order: 0.1 → {CM, PL, EF, CH, RP, MG} in parallel → MA.1 → MA.2 → MA.3 → MA.4 → MA.5. ID-F.\* wait for the
identify lane to merge `src/core/scanner/**`. One cross-lane dependency: MG.1 Step 7 (settings route `mode`
end-to-end tests) runs after CM.2 is merged into `batch/wg13` (MG rebases first); every other MG step and
all of CM.2 run in parallel. CM.2 never edits or tests through `src/api/routes/decoders.ts`.

---

### Task 0.1: Freeze the contract (Main)

**Files:**

- Modify: `packages/api-types/src/decoders.ts` (union at line 183, `DecoderStatus` at line 227),
  `packages/api-types/src/decoder-settings.ts`, `packages/api-types/src/tuner.ts` (line 177),
  `packages/api-types/src/resources.ts` (line 204), `src/config.ts` (`DecoderConfigSchema` line 193,
  `ChannelizerConfigSchema` line 525, root schema), `src/api/routes/decoder-rate-schemas.ts`,
  `src/api/routes/decoder-status-schemas.ts`, `cli/source/data/guards.ts`, `cli/source/view-models/decoders.ts`
- Create: `src/decoders/enablement/contract.ts`, `src/core/rate-policy-contract.ts`
- Test: `tests/unit/decoders/decoder-enablement-contract.test.ts`

**Interfaces — Produces (every lane consumes these exact names):**

`packages/api-types`:

```ts
export type DecoderMode = "auto" | "always" | "off"
export type DecoderModeSource =
	| "settings"
	| "config"
	| "legacy-enabled"
	| "legacy-band"
	| "default"
export type DecoderReachKind = "channel" | "raw" | "centre"
export type DecoderEfficiencyDetail = "budget" | "cpu" | "drops" | "unknown"
export interface DecoderPlacementView {
	sourceId: string
	channelHz?: number
	reach: DecoderReachKind
	origin: "configured" | "band" | "vfo" | "bandplan" | "fallback"
	primary: boolean
	running: boolean
	suspension?: DecoderSuspension
	efficiencyDetail?: DecoderEfficiencyDetail
	costCores: number
	probation?: boolean
}
export interface DecoderEfficiencyPlacement {
	decoderId: string
	sourceId: string
	channelHz: number | null
	reach: DecoderReachKind
	costCores: number
	probation: boolean
	detail?: DecoderEfficiencyDetail
	retryAt?: string
}
export interface DecoderEfficiencySourceView {
	sourceId: string
	coresInUse: number
	cpu: { percent: number | null; limit: number }
	drops: "ok" | "dropping" | "clearing" | "unknown"
	dropBytesPerSecond: number | null
	admitted: DecoderEfficiencyPlacement[]
	blocked: DecoderEfficiencyPlacement[]
}
export interface DecoderEfficiencyView {
	budgetCores: number
	cpuGuardPercent: number
	sources: DecoderEfficiencySourceView[]
}
// DecoderStatus gains: mode?, modeSource?, origin?: "config" | "catalogue", placements?: DecoderPlacementView[],
//   efficiency?: { detail: DecoderEfficiencyDetail; retryAt?: string }
// DecoderSuspensionReasonCode gains "efficiency-budget" | "decoder-unavailable"
// DecoderSettingsView.mode?: { value: DecoderMode; source: DecoderSettingSource }; DecoderSettingsUpdate.mode?: DecoderMode | null
// TunerCommandOrigin gains "decoder-rate"; TunerRatePolicy { raisedFromHz: number; since: string }; TunerState.ratePolicy?
// TunerRatePolicyEventData { sourceId; action: "raised" | "restored" | "skipped"; reason: "adsb-1090"; fromHz: number; toHz: number;
//   skipped?: "external-control" | "rate-above" | "write-failed"; link?: LinkAdvisory }
// LinkAdvisory { level: "none" | "unproven" | "dropping"; transport: "loopback" | "network"; payloadBytesPerSecond: number;
//   sustainedBytesPerSecond: number | null; shortfallPercent: number | null; upstreamDropBytesPerSecond: number | null }
// ResourceAlert.type gains "link-capacity"
```

(Use the existing suspension object type of `DecoderStatus.suspension` for `DecoderPlacementView.suspension`;
check its name in `packages/api-types/src/decoders.ts` near line 350.)

`src/decoders/enablement/contract.ts` — constants exactly as the design table: `CHANNELIZER_AUTO_ACCEPTED =
false`, `DECODER_MAX_BANDPLAN_CHANNELS = 4`, `VFO_SETTLE_MS = 1_000`, `EFFICIENCY_SAMPLE_MS = 2_000`,
`EFFICIENCY_DROP_WINDOW_MS = 10_000`, `EFFICIENCY_CLEAR_MS = 60_000`, `EFFICIENCY_PROBATION_MS = 30_000`,
`EFFICIENCY_RETRY_MS = 300_000`, `EFFICIENCY_RETRY_MAX_MS = 1_800_000`, `EFFICIENCY_BUDGET_X64 = 1.5`,
`EFFICIENCY_BUDGET_ARM64 = 0.75`, `EFFICIENCY_CPU_GUARD_PERCENT = 90`, `CHANNELIZER_IDLE_STOP_MS = 60_000`,
`CHANNEL_MARGINAL_CORES = 0.11`, `CHANNELIZER_BASE_CORES_2048K = 0.22`, `CHANNELIZER_BASE_CORES_2400K = 0.26`,
`DECODER_COST_UNKNOWN_CORES = 0.6` (A2). Plus:

```ts
/** A8: how src/index.ts composes the channelizer. "enabled": today's opt-in (immediate retire);
 *  "auto": constructed lazily with the idle linger; null: nothing constructed, setChannelizer(null). */
export type ChannelizerComposition = "enabled" | "auto" | null
export function channelizerComposition(
	cfg: { enabled: boolean; auto?: boolean | undefined },
	accepted: boolean,
): ChannelizerComposition
// enabled → "enabled"; else auto !== false && accepted → "auto"; else null
export const CATALOGUE_TYPES = [
	"readsb",
	"ais-catcher",
	"acarsdec",
	"dumpvdl2",
	"rtl433",
	"direwolf",
	"multimon-ng",
	"dsd-fme",
	"lora-meshtastic",
] as const
export type CatalogueType = (typeof CATALOGUE_TYPES)[number]
export const CHANNEL_CAPABLE_TYPES: readonly CatalogueType[] // the seven of requirement 5.1
export const DECODER_PROTOCOLS: Readonly<
	Partial<Record<CatalogueType, readonly string[]>>
>
// dsd-fme: dmr, p25p1, p25p2, ysf, dstar, nxdn48, nxdn96, dpmr; multimon-ng: pocsag, flex
export type DecoderReach = DecoderReachKind
export interface DecoderCost {
	cores: number
	basis: "measurement" | "estimate"
}
export const DECODER_COSTS: Readonly<Record<CatalogueType, DecoderCost>>
// readsb 0.25 e, ais-catcher 0.10 m, acarsdec 0.05 e, dumpvdl2 0.15 e, rtl433 0.10 e, direwolf 0.05 e,
// multimon-ng 0.03 e, dsd-fme 0.045 e, lora-meshtastic 0.60 e (decoder share; channel reach adds CHANNEL_MARGINAL_CORES)
export function placementCostCores(type: string, reach: DecoderReach): number
export function channelizerBaseCores(sampleRateHz: number): number // <= 2_048_000 → 0.22, else 0.26
export function defaultCpuBudgetCores(arch: string, cpuCount: number): number // A3
export interface CatalogueEntry {
	type: CatalogueType
	options: Readonly<Record<string, unknown>>
}
export interface ResolvedMode {
	mode: DecoderMode
	source: DecoderModeSource
}
export interface PlannerDecoder {
	id: string
	type: string
	origin: "config" | "catalogue"
	order: number // YAML index, then YAML length + catalogue index
	mode: DecoderMode
	startMode: DecoderStartMode
	configuredSourceId: string | null
	band: DecoderBandRequirements | undefined // undefined: unknown, never band-suspended
	configuredChannelsHz: readonly number[]
	reach: DecoderReach
	channelBandwidthHz: number
	channelTransitionHz: number
	protocols: readonly string[]
	channelPlacements: boolean // catalogue: true; YAML: useChannelizer === true (A1)
	unavailable: boolean
	ownDevice: boolean
	centreSlotHz: { minHz: number; maxHz: number } | null
	centrePassbandHz: number | null // lora only
}
export interface PlannerSource {
	id: string
	centreHz: number | null
	sampleRateHz: number | null
	usableFraction: number
	dedicatedScanner: boolean
	held: boolean
	reservedBy: string | null
	channelizerAvailable: boolean
	order: number
}
export interface PlannerVfo {
	sourceId: string
	frequencyHz: number
}
export type BandplanChannelLookup = (
	window: { sourceId: string; minHz: number; maxHz: number },
	protocols: readonly string[],
) => readonly number[]
export interface PlannerInput {
	decoders: readonly PlannerDecoder[]
	sources: readonly PlannerSource[]
	vfo: PlannerVfo | null
	bandplanChannels: BandplanChannelLookup
	maxBandplanChannels: number
}
export interface WantedPlacement {
	key: string
	decoderId: string
	sourceId: string
	channelHz: number | null
	reach: DecoderReach
	origin: DecoderPlacementView["origin"]
	primary: boolean
	costCores: number
	sampleRateHz: number
}
export interface PlacementPlan {
	wanted: readonly WantedPlacement[] // admission order (4.2, 3.7)
	unplaced: ReadonlyMap<string, DecoderSuspensionReasonCode> // decoderId → reason when it has no placement
}
export type PlacementPlanner = (input: PlannerInput) => PlacementPlan
export function placementKey(
	decoderId: string,
	sourceId: string,
	reach: DecoderReach,
	channelHz: number | null,
): string // A7
export interface SourceDropSample {
	droppedBytesDelta: number | null
	droppedChunksDelta: number | null
} // null: unreadable
export interface EfficiencySample {
	atMs: number
	cpuPercent: number | null
	sources: ReadonlyMap<string, SourceDropSample>
}
export interface EfficiencyInputs {
	budgetCores: number
	cpuGuardPercent: number
}
export interface RunningPlacement {
	key: string
	sourceId: string
	reach: DecoderReach
	costCores: number
	sampleRateHz: number
	admittedAtMs: number
}
export type AdmissionDecision =
	| { admit: true }
	| { admit: false; detail: DecoderEfficiencyDetail; retryAtMs: number }
export interface ProbationVerdict {
	key: string
	detail: "drops" | "cpu"
}
export interface EfficiencyGate {
	record(sample: EfficiencySample): void
	admit(
		newcomer: WantedPlacement,
		running: readonly RunningPlacement[],
		now: number,
	): AdmissionDecision
	probation(
		running: readonly RunningPlacement[],
		now: number,
	): readonly ProbationVerdict[]
	noteSuspended(key: string, detail: DecoderEfficiencyDetail, now: number): void
	forget(key: string): void
	view(
		running: readonly RunningPlacement[],
		blocked: readonly {
			placement: WantedPlacement
			decision: AdmissionDecision
		}[],
		now: number,
	): DecoderEfficiencyView
}
```

(`DecoderBandRequirements` from `src/decoders/band-resolver.ts`; `DecoderStartMode`,
`DecoderSuspensionReasonCode`, `DecoderPlacementView`, `DecoderEfficiencyView` from `@wavekit/api-types`.)

`src/core/rate-policy-contract.ts`:

```ts
export { READSB_SAMPLE_RATE } from "../decoders/builtin/readsb.js" // 2_400_000, do not redefine
export const READSB_REACH_HZ = 200_000
export const ADSB_FREQUENCY_HZ = 1_090_000_000
export const LINK_SUSTAINED_WINDOW_MS = 10_000
export const LINK_SHORTFALL_PERCENT = 1
export const LINK_UPSTREAM_DROPS_BYTES_PER_SECOND = 10_000 // same value as HIGH_DROP_RATE_THRESHOLD in resource-aggregator.ts
export interface ReadsbRateFacts {
	mode: DecoderMode
	ownDevice: boolean
}
export interface RatePolicyPort {
	readsbOn(sourceId: string): ReadsbRateFacts | null
} // null: no readsb instance for the source
export interface RatePolicy {
	beforeOperatorRetune(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
	): Promise<void>
	onOperatorSampleRate(sourceId: string): void // REST rate write, or an accepted relay rate write (A9)
	onRelayRetune(sourceId: string, hz: number): void // A9: advice only, never writes
	recordFor(sourceId: string): TunerRatePolicy | undefined
	reset(sourceId: string): void
	dispose(): void // cancels every post-raise link re-check timer (A11)
}
export interface LinkAdvisoryInput {
	sourceId: string
	host: string
	sampleRateHz: number
}
export interface LinkAdvisor {
	observe(
		sourceId: string,
		receivedBytesPerSecond: number | null,
		sampleRateHz: number | null,
		atMs: number,
	): void
	classify(
		input: LinkAdvisoryInput,
		upstreamDropBytesPerSecond: number | null,
	): LinkAdvisory
	reset(sourceId: string): void
}
```

`src/config.ts`: `DecoderConfigSchema.mode: z.enum(["auto","always","off"]).optional()`; root
`decoderPolicy: z.object({ catalogue: z.boolean().optional(), rateRaise: z.boolean().optional(), efficiency:
z.object({ cpuBudgetCores: z.number().positive().max(64).optional(), cpuGuardPercent:
z.number().min(1).max(100).optional(), maxBandplanChannels: z.number().int().min(0).max(16).optional()
}).strict().optional() }).strict().optional()`; `ChannelizerConfigSchema.auto: z.boolean().optional()`.
No `.default(...)` on any of them.

- [ ] **Step 1: Write the failing contract test** `tests/unit/decoders/decoder-enablement-contract.test.ts`
      with cases:
  - `"pins constants with their arithmetic"`: every constant above equals its value;
    `expect(4 * (CHANNEL_MARGINAL_CORES + DECODER_COSTS["dsd-fme"].cores)).toBeCloseTo(0.62, 2)`;
    `expect(EFFICIENCY_DROP_WINDOW_MS / EFFICIENCY_SAMPLE_MS).toBe(5)`;
    `expect(EFFICIENCY_BUDGET_ARM64 * 4).toBe(3)`; window C sum
    `channelizerBaseCores(2_400_000) + DECODER_COSTS["lora-meshtastic"].cores + placementCostCores("rtl433","channel") + placementCostCores("dsd-fme","channel") + placementCostCores("multimon-ng","channel")`
    `toBeCloseTo(1.365, 3)` and `< EFFICIENCY_BUDGET_X64`; `READSB_SAMPLE_RATE * 2 === 4_800_000`.
  - `"placementCostCores charges channel marginal only for channel reach and the unknown cost for unknown types"`:
    `placementCostCores("ais-catcher","channel")` ≈ 0.21; `placementCostCores("readsb","raw")` = 0.25;
    `placementCostCores("my-yaml-type","raw")` = 0.6.
  - `"channelizerBaseCores bound"`: 2_048_000 → 0.22, 2_048_001 → 0.26.
  - `"channelizer is never composed while auto is not accepted"` (A8): `CHANNELIZER_AUTO_ACCEPTED === false`;
    with `accepted = CHANNELIZER_AUTO_ACCEPTED`, `channelizerComposition` returns `null` for `{ enabled:
false }`, `{ enabled: false, auto: true }` and `{ enabled: false, auto: false }`, and `"enabled"` for
    `{ enabled: true }`; with `accepted = true` it returns `"auto"` for `{ enabled: false }` and `{ enabled:
false, auto: true }`, `null` for `auto: false`, and `"enabled"` whenever `enabled`. The shipped config's
    parsed `channelizer` yields `null`. (MA.1's wiring test pins that composition calls this helper and,
    on `null`, constructs no `ChannelizerManager` or observer and spawns nothing.)
  - `"defaultCpuBudgetCores"`: (`"x64"`,8) → 1.5; (`"arm64"`,4) → 0.75; (`"arm64"`,5) → 1.5.
  - `"unions widened"`: type-level assignments `const r: DecoderSuspensionReasonCode = "efficiency-budget"`,
    `"decoder-unavailable"`, `const o: TunerCommandOrigin = "decoder-rate"`, `const t: ResourceAlert["type"] = "link-capacity"`.
  - `"parsed shipped config is unchanged"`: parse `config/default.yaml` through `ConfigSchema` and assert
    the result has no `decoderPolicy` key, `channelizer` has no `auto` key, and equals a snapshot taken
    from the base (store the expected JSON inline, generated once from `HEAD` before the schema change).
  - `"Fastify status schema keeps the new optional fields"`: build the decoder status schema and
    serialise a status with `mode`, `origin`, `placements`, `efficiency`; the fields survive. The same
    check for `GET /api/decoders/efficiency` lives in MG.2 (its response schema is in MG's route file, so
    0.1 cannot import it yet): MG.2 adds `"efficiency route schema keeps every DecoderEfficiencyView
field"` to `tests/unit/api/decoders-efficiency-route.test.ts`, serialising a view with `cpu.percent:
null`, `drops: "unknown"`, `dropBytesPerSecond: null` and admitted/blocked entries with `detail` and
    `retryAt`, and asserting every field and every null survives.
  - `"CLI words"`: the reason word for `efficiency-budget` is `"over the efficiency budget"` and for
    `decoder-unavailable` is `"not installed"`; the alert guard accepts `type: "link-capacity"`.
    (Catalogue default options free of option issues — requirement 1.7 — are pinned in CM.1, which owns
    `CATALOGUE_DEFAULT_OPTIONS`.)
- [ ] **Step 2: Run it, expect FAIL** — `pnpm exec vitest run tests/unit/decoders/decoder-enablement-contract.test.ts`
      (module not found).
- [ ] **Step 3: Implement the types, constants, functions and schema keys above.** CLI changes go through
      `cli/source/data/guards.ts` and the reason-word map in `cli/source/view-models/decoders.ts`.
- [ ] **Step 4: Run** the contract test, `pnpm --filter @wavekit/api-types build`, `pnpm run typecheck`,
      `pnpm run lint`, `pnpm exec vitest run tests/unit/api/decoder-status-contract.test.ts tests/unit/api/decoder-rate-contract.test.ts tests/unit/api/config-export.test.ts`.
      Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(contract): freeze the decoder enablement contract" -- <the files above>`.
      Live (Main): none.

---

### Task CM.1: Catalogue and binary resolution (lane CM)

**Files:**

- Create: `src/decoders/enablement/catalogue.ts`, `src/decoders/enablement/binary.ts`
- Test: `tests/unit/decoders/enablement/catalogue.test.ts`, `tests/unit/decoders/enablement/catalogue.property.test.ts`,
  `tests/unit/decoders/enablement/binary.test.ts`

**Interfaces:**

- Consumes: `CATALOGUE_TYPES`, `CatalogueType` (0.1); `DecoderConfig` from `src/config.ts`.
- Produces:
  - `CATALOGUE_DEFAULT_OPTIONS: (region: BandRegionCode) => Readonly<Record<CatalogueType, Record<string, unknown>>>`
    (acarsdec `frequencies: [131_550_000, 131_725_000]`; dumpvdl2 `frequencies: [136_650_000, 136_700_000, 136_975_000]`
    using the adapters' existing option keys; lora-meshtastic `region` from the band region mapping in
    `src/decoders/band-region.ts`; others `{}`).
  - `buildDecoderCatalogue(configs: readonly DecoderConfig[], opts: { enabled: boolean; region: BandRegionCode }): DecoderConfig[]`
  - `isCatalogueConfig(config: DecoderConfig): boolean` (module-private `WeakSet`, no new config key)
  - `resolveDecoderBinary(type: string, env: { PATH?: string | undefined }, fs?: { stat(p: string): Promise<{ isFile(): boolean; mode: number }> }): Promise<{ available: boolean }>`
  - `DECODER_BINARIES: Readonly<Record<CatalogueType, string>>` (read each adapter's spawn command; for
    adapters that spawn a chain, the decoder executable itself).

- [ ] **Step 1: Write failing tests.**
  - `catalogue.test.ts`: `"shipped config yields nine entries in catalogue order with id === type"`;
    `"a YAML decoder of type ais-catcher suppresses the catalogue ais-catcher"`;
    `"a YAML decoder with id 'readsb' of type rtl433 suppresses both catalogue readsb and catalogue rtl433"`;
    `"enabled: false yields the YAML list unchanged"` (1.5); `"isCatalogueConfig is true only for derived entries"`;
    `"catalogue entries do not appear in the config export"` (build the export from configs filtered by
    `!isCatalogueConfig`, assert equal to the base export);
    `"every catalogue default validates with empty optionIssues"` (1.7): for each type, run the WG6 option
    validator used by `GET /api/decoders/:id/settings` and expect `[]`.
  - `catalogue.property.test.ts` — **Property 1: Catalogue completeness** (trace comment, Validates 1.1,
    1.2, 1.5): arbitrary YAML lists of `{ id, type }` drawn from catalogue types, catalogue ids and random
    strings; assert YAML entries come first unchanged and in order, exactly one entry per unclaimed type,
    no duplicate ids. `numRuns: 200`.
  - `binary.test.ts`: `"found on PATH"`, `"missing binary yields unavailable without spawning"` (fake fs, no
    `child_process` import reachable), `"non-executable file is unavailable"`, `"empty PATH is unavailable"`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/decoders/enablement/` — expect FAIL.
- [ ] **Step 3: Implement** `catalogue.ts` and `binary.ts`. `resolveDecoderBinary` splits `PATH` on `:`,
      stats `<dir>/<binary>`, available when a regular file with any execute bit; never spawns.
- [ ] **Step 4: Run** the tests, `pnpm run typecheck`, `pnpm run lint` — PASS.
- [ ] **Step 5: Commit** `-- src/decoders/enablement/catalogue.ts src/decoders/enablement/binary.ts tests/unit/decoders/enablement/catalogue*.ts tests/unit/decoders/enablement/binary.test.ts`.
      Live (Main, after MA.1): L and W, shipped config plus sources: nine decoders listed with ids equal to
      types; a missing binary shows `decoder-unavailable`; `GET /api/config/export` byte-identical to base.

### Task CM.2: Mode resolution, settings `mode`, `channelsHz` descriptors (lane CM)

**Files:**

- Create: `src/decoders/enablement/mode.ts`
- Modify: `src/decoders/settings/store.ts`, `src/decoders/settings/patch-policy.ts`,
  `src/decoders/settings/layers.ts`, `src/decoders/settings/service.ts`,
  `src/decoders/options/dsd-fme.ts`, `src/decoders/options/multimon-ng.ts`, `src/decoders/options/direwolf.ts`
- Test: `tests/unit/decoders/enablement/mode.property.test.ts`, `tests/unit/decoders/enablement/settings-mode.test.ts`,
  `tests/unit/decoders/enablement/live-mode.property.test.ts`, `tests/unit/decoders/enablement/channels-option.test.ts`

**Interfaces:**

- Consumes: `ResolvedMode`, `DecoderMode`, `DecoderModeSource` (0.1).
- Produces:
  - `resolveDecoderMode(input: { settingsMode?: DecoderMode; settingsEnabled?: boolean; configMode?: DecoderMode; configEnabled: boolean; configBandSuspension?: boolean; apiBandSuspension?: boolean }): ResolvedMode`
    — precedence 2.2: settings mode (`settings`) > settings enabled false (`off`, `settings`) > YAML mode
    (`config`) > YAML enabled false (`off`, `legacy-enabled`) > config or API `bandSuspension: false`
    (`always`, `legacy-band`) > `auto` (`default`).
  - Store entry `mode?: DecoderMode` (schema version stays 1); `DecoderPatch.mode?: DecoderMode | null`
    (null deletes); view `mode: { value, source }` via `buildDecoderSettingsView`.
  - `src/decoders/settings/patch-policy.ts`: `BODY_KEYS` (line 72) becomes `new Set(["enabled", "options",
"mode"])`; the empty-body message (line 328) becomes `"body must set enabled, options or mode"` and the
    unknown-key message (line 330) `"body may only contain enabled, options and mode"`; `validateDecoderPatch`
    accepts `mode` as one of `"auto" | "always" | "off"` or `null`, any other value a
    `DECODER_OPTIONS_INVALID` issue at path `mode` with a fixed message (no echo of the value). Update any
    existing test asserting the two old messages and list it as a changed golden.
  - The route's own shape gate in `src/api/routes/decoders.ts` is MG's file: CM.2 does not touch it, and
    route-level `mode` tests live in MG.1 Step 7.
  - Service dep `applyDecoderMode?: (id: string, mode: DecoderMode) => Promise<void>`, called after a
    successful persist when `mode` changed; failures are logged with `safeErrorFields` and do not fail the
    PATCH (the persisted mode applies at next evaluation/restart). `pendingRestart` unchanged (options only).
  - Option descriptor `channelsHz` (list of positive Hz, max 16 entries, each within the existing
    frequency bounds used by `channelHz`) on dsd-fme, multimon-ng, direwolf; patchable like other list options.

- [ ] **Step 1: Write failing tests.**
  - `mode.property.test.ts` — **Property 2: Mode precedence** (Validates 2.1, 2.2, 2.3): arbitrary inputs;
    expected computed by an independent table in the test; plus a fixed case table covering each rung.
  - `settings-mode.test.ts` (service and patch-policy level only: `validateDecoderPatch` and the settings
    service's `update` with a temp-dir store; no Fastify instance):
    `"mode always persists and the view reports source settings"`;
    `"mode null removes the override and the view falls back to config"`;
    `"stale revision rejects a mode patch with today's error code"`;
    `"invalid mode value is DECODER_OPTIONS_INVALID at path mode with no echo of the value"`;
    `"body with only mode is accepted; empty body and unknown keys carry the new fixed messages"`;
    `"older store file without mode parses"`; `"mode patch does not set pendingRestart"`;
    `"applyDecoderMode is called once after persist and not on a failed persist"`;
    `"applyDecoderMode rejecting is logged with fixed fields and the update still succeeds"`.
  - `live-mode.property.test.ts` — **Property 12: Live mode (store half)** (Validates 2.4, 2.5): arbitrary
    PATCH sequences against a fake port; after each successful PATCH, the port's last call equals the new
    resolved mode and the revision increments by exactly one; failed PATCHes never call the port.
  - `channels-option.test.ts`: `"channelsHz accepts 16 entries and rejects 17"`; `"rejects zero, negative and non-finite"`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Keep `enabled` boot-only semantics (web-gaps-8 1.5) untouched; `mode` is the
      live path.
- [ ] **Step 4: Run** the new tests plus `tests/unit/api/decoder-settings-route.test.ts tests/unit/api/decoder-patch-legacy.test.ts`,
      typecheck, lint — PASS.
- [ ] **Step 5: Commit** own paths. Live (Main, after MA.1): L, protected mode: PATCH readsb `off`,
      `always`, `auto`; each applies within one evaluation and survives a core restart.

---

### Task PL.1: Placement planner (lane PL)

**Files:**

- Create: `src/decoders/enablement/placement.ts`
- Test: `tests/unit/decoders/enablement/placement.test.ts`, `tests/unit/decoders/enablement/placement.property.test.ts`

**Interfaces:**

- Consumes: `PlannerInput`, `PlacementPlan`, `WantedPlacement`, `placementKey`, `placementCostCores`,
  `READSB_REACH_HZ`, `ADSB_FREQUENCY_HZ` (0.1); `distanceToRange` from `src/decoders/band-resolver.ts`.
- Produces: `planPlacements: PlacementPlanner` and
  `fitsReach(d: PlannerDecoder, s: PlannerSource, channelHz: number | null): boolean`.

Rules (requirements 3.2, 3.3, 3.7, 3.9, 8.1, 8.2):

- `channel` reach fits when `Math.abs(f - c) + bw / 2 + transition <= fs * usableFraction / 2`.
- `raw` (readsb) fits when `Math.abs(ADSB_FREQUENCY_HZ - c) <= READSB_REACH_HZ`; `centre` (LoRa) fits when
  `centreSlotHz` lies inside `[c - centrePassbandHz/2, c + centrePassbandHz/2]`.
- Skip decoders with `mode === "off"`, `ownDevice`, or `unavailable` (record `decoder-unavailable` in `unplaced`).
- Eligible sources: `configuredSourceId` only, if set; otherwise all except `dedicatedScanner` and those with
  `reservedBy` set to another decoder id. Sources with null centre or rate yield nothing.
- `channelPlacements === false` (A1) or source `!channelizerAvailable` for a YAML channel type: exactly one
  raw placement at the centre with today's band verdict (`band` fits by the existing window rule).
  For a catalogue channel type without a channelizer: no placement, `unplaced` = `channelizer-unavailable`.
- Candidates per type (3.3): ais-catcher `[162_000_000]` (bw 384 kHz); dumpvdl2 one channel at the midpoint
  of its frequencies (bw from the adapter's channel request); acarsdec one per configured frequency;
  rtl433 one per band range part clipped to the window, centred on the part; direwolf one per band target
  in window; dsd-fme/multimon-ng from configured channels, then the inputs from PL.2 (VFO, band-plan).
  Channel bandwidth and transition come from `PlannerDecoder` (filled by MG from `getChannelRequest`).
- Band term: `mode === "auto"` and `startMode !== "operator"` require the channel inside a band range or at
  a band target (unknown band never suspends); otherwise skip with `frequency-out-of-band`.
- `always` with no in-window candidate: one `fallback` placement (VFO channel for dsd-fme/multimon-ng when
  the VFO is on that source, else the centre channel; raw/centre path for readsb/LoRa).
- Dedup 8.2: per (decoder, channelHz) keep one source: configured source, then smaller `|f − c|`, then
  lower `order`.
- Held sources: placements are kept but MG suspends them (`tuner-scanning`); a channel also covered by an
  unheld source is placed on the unheld one (8.3).
- Output order: decoder class (operator pin, `always`, `auto`), then `order`, then per decoder: configured,
  band (ascending Hz), vfo, bandplan (nearest centre first), fallback; the first per decoder is `primary`.

- [ ] **Step 1: Write failing tests** (`placement.test.ts`, fake sources only):
      `"AIS at 161.5 MHz centre, 2.4 Msps, usable 0.8 is placed at 162.0"` (0.5 MHz + 192 kHz + transition ≤ 0.96 MHz);
      `"channel reach at the exact bound fits and 1 Hz past it does not"`;
      `"readsb fits at 1 090.2 MHz centre and not at 1 090.200001 MHz"`;
      `"source with null centre yields no placements and no throw"` (Review Focus 2);
      `"off decoder yields no placement"`; `"ownDevice readsb is never planned"`;
      `"unavailable decoder is unplaced with decoder-unavailable"`;
      `"catalogue channel type without channelizer is unplaced with channelizer-unavailable"`;
      `"YAML channel type without useChannelizer gets one raw centre placement"` (A1);
      `"always with nothing in window gets one fallback placement"`;
      `"dedicated scanner source used only via explicit sourceId"`;
      `"window C at 869.525 MHz yields rtl433, LoRa centre in catalogue order"`.
- [ ] **Step 2:** **Property 4: Reach is honest** (Validates 3.2, 3.3), **Property 11: One instance per
      channel** (Validates 8.1 to 8.3), **Property 3: Always skips only the band — planner half** (Validates 2.1,
      3.9): in `placement.property.test.ts`, arbitrary fake sources (1–4, random centres 100 MHz–1.2 GHz,
      rates in {1_024_000, 2_048_000, 2_400_000}, roles, holds, reservations) and decoders; assert every
      wanted placement satisfies `fitsReach`; no (decoder, channelHz) appears twice; an `always` decoder is
      never in `unplaced` with `frequency-out-of-band`. `numRuns: 200`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement** `planPlacements` and `fitsReach`.
- [ ] **Step 5: Bench (report-only)** in `placement.test.ts`: 9 decoders × 4 sources × 7 channels, 200 runs;
      the test asserts only that every run completes with a deterministic plan (same `wanted` keys each run)
      and logs the median with the design budget (0.1 ms) for the lane report. No wall-clock pass/fail (repo
      rule: never write a test whose pass depends on throughput inside a wall-clock budget).
- [ ] **Step 6: Run** tests, typecheck, lint — PASS. **Commit** own paths. Live: none alone (MG.1).

### Task PL.2: VFO and band-plan channel sources; `reach()` hook (lane PL)

**Files:**

- Create: `src/decoders/enablement/channel-sources.ts`
- Modify: `src/decoders/base-decoder.ts`, `src/decoders/audio-demod-decoder.ts`,
  `src/decoders/iq-decimate-decoder.ts`, `src/decoders/builtin/readsb.ts`, `src/decoders/builtin/lora-meshtastic.ts`,
  `src/decoders/enablement/placement.ts` (VFO and band-plan candidates)
- Test: `tests/unit/decoders/enablement/channel-sources.test.ts`, `tests/unit/decoders/enablement/channel-sources.property.test.ts`,
  `tests/unit/decoders/enablement/reach-hook.test.ts`

**Interfaces:**

- Consumes: `PlannerVfo`, `BandplanChannelLookup`, `DECODER_PROTOCOLS`, `VFO_SETTLE_MS` (0.1);
  `createScannerBandplanProvider` (import only) and `BandPlanStackView` from `@wavekit/api-types`.
- Produces:
  - `createVfoTracker(deps: { now: () => number; setTimer: (fn: () => void, ms: number) => { cancel(): void }; onSettled: (vfo: PlannerVfo | null) => void }): { update(vfo: PlannerVfo | null): void; current(): PlannerVfo | null; dispose(): void }`
    — emits `onSettled` only after the value is unchanged for `VFO_SETTLE_MS`.
  - `vfoFromLiveDemod(port: { sourceId(): string | null; offsetHz(): number; centreHz(sourceId: string): number | null }): PlannerVfo | null`
  - `createBandplanChannelLookup(deps: { getStackView: () => BandPlanStackView | undefined; scannerPlans: () => readonly Bandplan[] }): BandplanChannelLookup`
    — `Band.channels` of the resolved stack inside the window whose frequency lies in a scanner plan range
    listing one of the protocols. (`BandPlanStackView` from `@wavekit/api-types`; `Bandplan` is the scanner plan type `scanner-feed.ts` imports — import it from the same module, no scanner edit.)
  - `BaseDecoder.reach(): DecoderReach` (default `"raw"`); audio and IQ bases return `"channel"` when
    `channelizerSupported()` else `"raw"`; readsb overrides `"raw"`; lora-meshtastic overrides `"centre"`.
  - Placement candidates for dsd-fme (VFO when inside its band ranges) and multimon-ng (VFO when inside a
    scanner plan range listing `pocsag` or `flex`), band-plan channels capped at `maxBandplanChannels`
    nearest the centre first.

- [ ] **Step 1: Failing tests.** `channel-sources.test.ts`:
      `"VFO burst of 20 updates in 900 ms settles once, 1000 ms after the last"` (Review Focus 3);
      `"VFO equals centre plus offsetHz on the liveDemod source, with or without a listener"`;
      `"band-plan lookup returns only channels in a range listing the protocol"`;
      `"built-in packs yield no band-plan channels"`; `"view getter that throws falls back to bandplansFor(region) and returns no channels"`;
      `"five band-plan channels are capped to four nearest the centre"` and `"cap 0 yields none"`.
      `reach-hook.test.ts`: readsb `"raw"`, lora-meshtastic `"centre"`, ais-catcher/acarsdec/dumpvdl2/rtl433/
      multimon-ng/dsd-fme/direwolf `"channel"`; argv goldens of all adapters unchanged (run existing
      `tests/unit/decoders/argv-golden-wg7-b.test.ts` and `argv-golden-wg7-c.test.ts`).
- [ ] **Step 2:** **Property 5: Channel sources** (Validates 3.4, 3.5, 3.7) and **Property 13: VFO follows —
      planner half** (Validates 3.5, 5.5) in `channel-sources.property.test.ts`: dsd-fme/multimon-ng placements
      equal configured ∪ in-range VFO ∪ ≤4 qualifying band-plan channels in 3.7 order; for arbitrary timed VFO
      sequences the settled value equals the last value held ≥ `VFO_SETTLE_MS`, at most one settle per period.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** tests plus
      `tests/unit/decoders/base-decoder.test.ts tests/unit/decoders/channel-requests.test.ts`, typecheck, lint — PASS.
- [ ] **Step 6: Commit** own paths. Live (Main, after MA.1): L, operator band plan with one POCSAG channel in
      the window: multimon-ng lists the band-plan placement and the VFO placement.

---

### Task EF.1: Efficiency gate decision core (lane EF)

**Files:**

- Create: `src/decoders/enablement/efficiency-gate.ts`
- Test: `tests/unit/decoders/enablement/efficiency-gate.test.ts`, `tests/unit/decoders/enablement/efficiency-gate.property.test.ts`

**Interfaces:**

- Consumes: `EfficiencyGate`, `EfficiencyInputs`, `EfficiencySample`, `RunningPlacement`, `WantedPlacement`,
  `AdmissionDecision`, `channelizerBaseCores`, `EFFICIENCY_*` (0.1).
- Produces: `createEfficiencyGate(inputs: EfficiencyInputs): EfficiencyGate`.

Semantics: `record` keeps per-source drop history (last drop time, `unknown` flag from the latest sample)
and the latest CPU. `admit` returns not-admit, in this order: `unknown` when the source's latest sample is
null/non-finite or no sample yet; `drops` when a drop occurred within `EFFICIENCY_DROP_WINDOW_MS` or within
`EFFICIENCY_CLEAR_MS` after the last drop; `cpu` when `cpuPercent !== null && cpuPercent > cpuGuardPercent`;
`budget` when `Σ running.costCores + newcomer.costCores + base` exceeds `budgetCores`, where `base` sums
`channelizerBaseCores(rate)` once per source that has ≥ 1 channel placement among running ∪ newcomer; also
not-admit while the key's retry time is in the future (keep previous detail). `retryAtMs = now +
backoff(key)` where backoff starts at `EFFICIENCY_RETRY_MS` and doubles after each probation failure up
to `EFFICIENCY_RETRY_MAX_MS`. `probation` returns at most one verdict per source: the newest running
placement with `now - admittedAtMs < EFFICIENCY_PROBATION_MS` on a source that dropped or (globally) over
CPU since its admission; nothing when no probationer exists (callers log one warning per minute).
The gate never returns a verdict for a non-probationer (4.3, 4.8).

- [ ] **Step 1: Failing tests** (`efficiency-gate.test.ts`, injected `now`):
      `"admits window A on desktop budget"`; `"blocks the four dsd-fme band-plan channels in window C+ with budget"`;
      `"Pi budget 0.75 in window C admits rtl433 and multimon-ng and blocks dsd-fme and LoRa"` (design budget arithmetic);
      `"budget exactly equal admits and 0.001 over blocks"`;
      `"cpu 90 admits and 90.1 blocks with cpu"`; `"null cpu leaves the decision to budget and drops"`;
      `"drop 9.9 s ago blocks; 10.1 s ago still blocks until 60 s after the last drop; 60.1 s admits"`;
      `"unreadable counter blocks with unknown"`; `"NaN delta blocks with unknown"`;
      `"no sample yet blocks with unknown"`;
      `"probation drop suspends the newest probationer only"`; `"drop with no probationer suspends nothing"`;
      `"probation failure doubles retry up to 30 min"` (5 → 10 → 20 → 30 → 30 min; Review Focus 4);
      `"channelizer base charged once per source"`; `"view reports drops unknown and cpu.percent null, never ok or 0"`.
- [ ] **Step 2:** Properties in `efficiency-gate.property.test.ts`: **Property 6: No eviction** (Validates 4.3,
      4.4), **Property 7: Budget bound** (Validates 4.1, 4.2: simulate a driver that admits in order and assert
      the admitted sum ≤ budget and no later placement admitted while an earlier one with `budget` detail is
      blocked and would fit), **Property 8: Unknown is never drop-free** (Validates 4.6). `numRuns: 200`.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run**, typecheck, lint — PASS.
- [ ] **Step 6: Commit** own paths. Live: none alone (MG.2).

### Task EF.2: Efficiency monitor and branch telemetry (lane EF)

**Files:**

- Create: `src/decoders/enablement/efficiency-monitor.ts`
- Modify: `src/core/source-fanout-router.ts`
- Test: `tests/unit/decoders/enablement/efficiency-monitor.test.ts`, `tests/unit/core/source-fanout-router-telemetry.test.ts`

**Interfaces:**

- Consumes: `EfficiencySample`, `EFFICIENCY_SAMPLE_MS` (0.1); `FanoutManager` branch telemetry
  (`droppedBytesTotal`, `droppedChunksTotal`, `src/core/fanout-manager.ts:48-84`).
- Produces:
  - `SourceFanoutRouter.branchDropTotals(sourceId: string): { droppedBytesTotal: number; droppedChunksTotal: number } | null`
    — sums every branch on the source including the channelizer input branch; null when the source has no fanout.
  - `createEfficiencyMonitor(deps: { sources: () => readonly string[]; dropTotals: (sourceId: string) => { droppedBytesTotal: number; droppedChunksTotal: number } | null; cpu: { readonly normalisedPercent: number | null }; now: () => number; setInterval: (fn: () => void, ms: number) => { cancel(): void }; onSample: (s: EfficiencySample) => void }): { start(): void; stop(): void; sampleNow(): EfficiencySample }`
    — deltas against the previous totals; first read, a throw, a null, a non-finite value or a total that
    went backwards (counter reset) yields `null` deltas for that source (unknown); non-finite CPU → null.

- [ ] **Step 1: Failing tests:** `"two branches' drops are summed per source"`; `"channelizer input branch is included"`;
      `"throwing read yields unknown for that source only"`; `"counter going backwards yields unknown"`;
      `"first sample is unknown, second has deltas"`; `"NaN cpu is null"`; `"stop cancels the interval"`;
      `"bench (report-only): 64 branches read"` (asserts the summed totals are correct and logs the median
      against the 0.05 ms design budget for the lane report; no wall-clock pass/fail).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** plus `tests/unit/core/fanout-manager.test.ts`,
      typecheck, lint — PASS.
- [ ] **Step 5: Commit** own paths. Live (Main, after MA.1): L, `GET /api/decoders/efficiency` matches `ps`
      and the fanout counters for 10 minutes.

---

### Task CH.1: In-place channel retune (lane CH)

**Files:**

- Modify: `native/wavekit-chan/src/protocol.rs`, `native/wavekit-chan/src/runtime.rs`,
  `native/wavekit-chan/src/channel.rs`, `native/wavekit-chan/src/admission.rs` (and `demod_channel.rs` if
  demod channels share the NCO), `src/core/channelizer/protocol.ts`,
  `src/core/channelizer/channelizer-process.ts`, `src/core/channelizer/channelizer-manager.ts`
- Test: Rust unit tests beside the modules; `tests/unit/core/channelizer-protocol.test.ts`,
  `tests/unit/core/channelizer-manager.test.ts`, new `tests/unit/core/channelizer-retune.test.ts`

**Interfaces:**

- Produces:
  - Protocol request `retune { channelId, centerHz }` → reply `retuned { channelId, centerHz }` or
    `refused { channelId, reason: "admission" }`. Same output rate and taps; NCO phase continuous.
  - `ChannelizerManager.retuneChannel(sourceId: string, channelId: string, centerHz: number): Promise<"retuned" | "refused">`
    — on `refused` or transport error the caller closes and reopens (MG handles it).

- [ ] **Step 1: Failing Rust tests:** `retune_keeps_output_rate_and_taps`, `retune_is_phase_continuous`
      (tone across the retune boundary: no sample-to-sample phase jump beyond the frequency step's expected
      increment), `retune_outside_admission_is_refused`, `retune_equivalence` (retuned channel's output after
      the filter settles equals a freshly opened channel at the new centre within 1e-4 RMS),
      `chunk_split_invariance_across_retune` (same input split at random boundaries yields identical output).
- [ ] **Step 2: Failing TS tests** `channelizer-retune.test.ts` with a fake transport:
      `"retuneChannel sends retune and resolves retuned"`; `"refused resolves refused and leaves the channel open"`;
      `"unknown channel id throws WaveKitError without echoing the id"`.
- [ ] **Step 3: Run** `make chan-test` and the TS tests — FAIL.
- [ ] **Step 4: Implement.** Bench before/after with the crate's existing bench harness (do not add benches
      to `chan-test`); record numbers in the lane report.
- [ ] **Step 5: Run** `make chan-test`, TS tests plus existing `tests/unit/core/channelizer-*.test.ts`,
      typecheck, lint — PASS. **Commit** own paths. Property 13 engine half is `retune_equivalence` plus
      `chunk_split_invariance_across_retune` (proptest if the crate already uses it, else a loop of ≥ 100
      seeded cases). Live (Main, after MA.1): L, drag the VFO across a DMR channel: dsd-fme keeps its pid and
      decodes after the settle time.

### Task CH.2: Per-source idle linger (lane CH, after CH.1)

**Files:**

- Modify: `src/core/channelizer/channelizer-manager.ts` (`ChannelizerManagerDeps`, `requestChannel`,
  private `stopIfIdle` near line 1388, `invalidate`, `destroy`)
- Test: new `tests/unit/core/channelizer-idle-linger.test.ts`; existing `tests/unit/core/channelizer-manager.test.ts`

**Interfaces:**

- Consumes: `CHANNELIZER_IDLE_STOP_MS` (0.1) only in its test; the manager takes the value as a dep.
- Produces: `ChannelizerManagerDeps.idleStopMs?: number` (A8). Absent or `0`: today's behaviour exactly
  (retire as soon as idle). Positive: when a source becomes idle through `last-channel-released`,
  `last-channel-died` or `no-channels`, the engine stays up and a per-source timer (unref'd) is armed; a
  `requestChannel` for that source before it fires cancels it and reuses the running engine (no spawn); on
  fire, the source is re-checked with the existing idle condition and retired with cause `idle-timeout`.
  `invalidate` (caps change, source loss), `socket-path-unavailable` and `destroy()` clear the timer and
  retire at once, as today. Nothing else in the public API changes.

- [ ] **Step 1: Failing tests** `channelizer-idle-linger.test.ts` (fake process and transport, vitest fake
      timers): `"idle stop after 60 s, not at 59.9 s"`; `"a release then a request within the linger reuses the
engine: one spawn"` (the close-and-reopen fallback of a VFO move does not cycle the engine);
      `"without idleStopMs the last release retires at once"`; `"caps change during the linger retires at once
and clears the timer"`; `"source loss during the linger retires at once"`; `"destroy during the linger
stops the process and leaves no timer"`; `"the linger timer does not keep the event loop alive"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** the new test, every existing
      `tests/unit/core/channelizer-*.test.ts` (unchanged results), typecheck, lint — PASS.
- [ ] **Step 5: Commit** own paths. Live (Main, after MA.4 flips acceptance): L, shipped config, VFO onto a
      DMR channel spawns one `wavekit-chan`; move the VFO off every channel: the process stays 60 s, then exits.

---

### Task RP.1: Rate policy (lane RP)

**Files:**

- Create: `src/core/rate-policy.ts`
- Modify: `src/core/tuner-controller.ts` (`setFrequency` line 870, `setSampleRate` line 950, state
  emission), `src/api/routes/tuner.ts`
- Test: `tests/unit/core/rate-policy.test.ts`, `tests/unit/core/rate-policy.property.test.ts`

**Interfaces:**

- Consumes: `RatePolicy`, `RatePolicyPort`, `READSB_REACH_HZ`, `ADSB_FREQUENCY_HZ`, `READSB_SAMPLE_RATE`,
  `LinkAdvisor` (0.1); `TunerWriteOptions` (`src/core/tuner-controller.ts:34`).
- Produces:
  - `createRatePolicy(deps: { port: RatePolicyPort; tuner: { sampleRateOf(sourceId: string): number | null; controlModeOf(sourceId: string): "internal" | "external" | null; setSampleRate(sourceId: string, hz: number, opts: TunerWriteOptions): Promise<void> }; link: LinkAdvisor | null; linkInput(sourceId: string): LinkAdvisoryInput | null; upstreamDropsOf(sourceId: string): number | null; reportLink(sourceId: string, advisory: LinkAdvisory): void; setTimer(fn: () => void, ms: number): { cancel(): void }; emit(event: TunerRatePolicyEventData): void; now: () => Date; log: Logger; enabled: boolean }): RatePolicy`
    — `reportLink` is wired by Main to `ResourceAggregator.reportLinkAdvisory`; on a raise the policy calls
    it with the advisory it put on the event (7.2). `upstreamDropsOf` and `setTimer` serve RP.2's re-check
    (RP.1 accepts them and RP.2 uses them; RP.1 tests pass no-op fakes). `dispose()` cancels timers.
  - `TunerController.setBeforeOperatorRetune(hook: ((sourceId: string, hz: number, opts: TunerWriteOptions) => Promise<void>) | null): void`;
    `setFrequency` awaits it only when `opts.origin === "rest"`, before `proveSampleRateForFrequency` and the
    frequency write; a rejection propagates (no frequency write).
  - The hook runs after `validateSourceForControl` (so a REST retune in external control is rejected as
    today and never reaches it).
  - `TunerController` calls `ratePolicy.onOperatorSampleRate(sourceId)` on a `setSampleRate` with origin
    `rest` and on an accepted relay `SET_SAMPLE_RATE` in `applyExternalCommand` (via an optional
    `onOperatorSampleRate` hook set the same way); `TunerState.ratePolicy` filled from `recordFor`.
  - `TunerController.setOnRelayRetune(hook: ((sourceId: string, hz: number) => void) | null): void`; called
    from `applyExternalCommand` in the `SET_FREQUENCY` case only when the value was accepted (`updated`),
    after the state update; a throwing hook is caught and logged with `safeErrorFields` (relay handling
    never fails because of it). Main wires it to `ratePolicy.onRelayRetune` (A9).
  - `tuner:rate-policy` emitted through the controller's existing `tuner` event channel.

Behaviour: raise when in-reach (`|ADSB − hz| ≤ READSB_REACH_HZ`), readsb facts non-null, mode ≠ `off`,
`!ownDevice`, control internal, rate known and `< READSB_SAMPLE_RATE`, `enabled !== false` (config
`decoderPolicy.rateRaise`): write `READSB_SAMPLE_RATE` with origin `decoder-rate`, record `{ previousHz, since }`,
emit `raised`. Restore when out of reach or readsb `off` with a record: write `previousHz` with origin
`decoder-rate`, clear, emit `restored`. Skips: external control → `skipped`/`external-control` (no write),
emitted only by `onRelayRetune` (A9) when the relay value is in reach, readsb facts non-null, mode ≠ `off`,
`!ownDevice`, rate known and `< READSB_SAMPLE_RATE` and `enabled !== false`, once per entry into reach per
source (re-armed on leaving reach, `reset`, or control returning to internal); `beforeOperatorRetune` called
in external control writes and emits nothing; rate `> READSB_SAMPLE_RATE` → `skipped`/`rate-above`; rate exactly `READSB_SAMPLE_RATE` → nothing; write
failure → `skipped`/`write-failed`, no record, rethrow. One info log line per raise/restore/skip with
fixed fields (`decoderId: "readsb"`, `sourceId`, `action`, `fromHz`, `toHz`, reason code).

- [ ] **Step 1: Failing tests** (`rate-policy.test.ts`). Pure policy cases use a fake tuner port. Every case
      that names `setFrequency`, `setSampleRate` or `applyExternalCommand` (the call-order case, all relay
      cases, "REST retune in external control is rejected before the hook", "a throwing relay hook ...",
      "failed raise ...", "scanner, config and replay origins never reach the hook") uses the real
      `TunerController` from `src/core/tuner-controller.ts` with the policy wired through its hooks, connected
      to a fake rtl_tcp server listening on an ephemeral `127.0.0.1` port (`listen(0)`) that records every
      command; follow the existing harness in `tests/unit/core/tuner-controller.test.ts`. Failure cases make the
      fake server reject or drop the rate command. Cases:
      `"REST retune to 1090 at 2.048 Msps writes 2.4 Msps before the frequency, origin decoder-rate"`
      (assert call order on a fake rtl_tcp command log);
      `"1090.2 MHz raises; 1090.200001 MHz does not"`; `"retune to 162 MHz restores 2.048 Msps then writes the frequency"`;
      `"operator sample-rate write clears the record; later retune away restores nothing"`;
      `"relay retune into reach emits one skipped external-control and writes nothing"` (Review Focus 5; drive
      `applyExternalCommand(SET_FREQUENCY, 1_090_000_000)` on a fake tuner controller and assert no rtl_tcp
      command and exactly one event carrying the link advisory);
      `"relay drag inside reach emits once; leaving and re-entering reach emits again"`;
      `"relay retune into reach with readsb off, ownDevice, rate 2.4 Msps or rateRaise false emits nothing; rate 3.2 Msps emits skipped rate-above"`;
      `"relay sample-rate write clears the record; a later REST retune away restores nothing"`;
      `"REST retune in external control is rejected before the hook: no write, no event"`;
      `"a throwing relay hook does not break relay command handling"`;
      `"rate 3.2 Msps emits skipped rate-above; 2.4 Msps emits nothing"`;
      `"failed raise leaves frequency unwritten and no record"` (Review Focus 5);
      `"readsb off: no raise; turning off while raised restores at the next REST retune"`;
      `"ownDevice readsb: no raise"`; `"scanner, config and replay origins never reach the hook"`;
      `"decoderPolicy.rateRaise false: no writes, no events"`; `"TunerState.ratePolicy present only while recorded"`;
      `"event carries link advisory from the advisor"`.
- [ ] **Step 2:** **Property 9: Raise and restore** (Validates 6.1 to 6.4, 10.1) in
      `rate-policy.property.test.ts`: arbitrary sequences of REST retunes, operator rate writes, scanner hops,
      relay commands (`SET_FREQUENCY` and `SET_SAMPLE_RATE` through `applyExternalCommand`, which switch the
      source to external control) and readsb mode changes against the real `TunerController` connected to one
      fake rtl_tcp server on an ephemeral `127.0.0.1` port per property run (reset between sequences, not per
      command; `numRuns: 100`); assert the recorded rtl_tcp commands match a reference
      model, the policy never writes a frequency, relay commands never cause a policy write, and
      `skipped`/`external-control` events match the model's edge-triggered advice exactly (A9).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** plus existing
      `tests/unit/core/dynamic-sample-rate.test.ts` and the tuner controller tests, typecheck, lint — PASS.
- [ ] **Step 6: Commit** own paths. Live (Main, after MA.1): L at 2.048 Msps: tune to 1 090 MHz → 2.4 Msps
      and readsb decodes; tune to 162 MHz → 2.048 Msps. W with SDR++ on the relay at 2.048 Msps: tuning to
      1 090 MHz from SDR++ writes nothing (the rate stays 2.048 Msps) and the `tuner` WS channel carries one
      `tuner:rate-policy` `skipped` / `external-control` event with the link advisory; dragging within reach
      emits no further event.

### Task RP.2: Link advisor and `link-capacity` alert (lane RP)

**Files:**

- Create: `src/core/link-advisory.ts`
- Modify: `src/core/resource-aggregator.ts`
- Test: `tests/unit/core/link-advisory.test.ts`, `tests/unit/core/link-advisory.property.test.ts`,
  `tests/unit/core/resource-aggregator-link.test.ts`

**Interfaces:**

- Consumes: `LinkAdvisor`, `LinkAdvisoryInput`, `LINK_*` (0.1); `SourceBackpressureTracker` drop rate.
- Modify also: `src/core/rate-policy.ts` (RP.1, same lane) for the post-raise re-check.
- Test also: `tests/unit/core/rate-policy-link-recheck.test.ts`.
- Produces: `createLinkAdvisor(deps: { now: () => number }): LinkAdvisor`;
  `isLoopbackHost(host: string): boolean` (literal `127.0.0.0/8`, `::1`, `localhost`, case-insensitive; no DNS);
  `ResourceAggregator.reportLinkAdvisory(sourceId: string, advisory: LinkAdvisory): void` emitting
  `link-capacity` (`warning` for `unproven`, `critical` for `dropping`, nothing for `none`) with a fixed
  message that contains numbers only.

Behaviour: `observe` keeps a 10 s rolling average of received bytes/s per source; the sustained maximum is
updated only while the average is within `LINK_SHORTFALL_PERCENT` of `sampleRateHz * 2`; `reset` on
reconnect. `classify`: loopback → `none`; else `dropping` when the post-change average falls short of
`payload` by > 1 % over a full 10 s window or `upstreamDrop > LINK_UPSTREAM_DROPS_BYTES_PER_SECOND`; else
`unproven` when sustained is null or `< payload`; else `none`. Samples arrive every 5 s from the source
metrics event (A10); a window is full once its samples span `LINK_SUSTAINED_WINDOW_MS`.

Post-raise re-check (A11, requirement 7.1 `dropping`, 7.2): after a raise on a non-loopback source the rate
policy arms `setTimer(recheck, LINK_SUSTAINED_WINDOW_MS)`; each run re-classifies with
`classify(linkInput(sourceId), upstreamDropsOf(sourceId))` and calls `reportLink(sourceId, advisory)` only
when the level differs from the last reported level for that source (so `dropping` raises one `critical`
alert, and a later `none`/`unproven` reports the change), then re-arms while the raise record exists. The
timer is cancelled on restore, on an operator or relay rate write that clears the record, on `reset` and on
`dispose`; it is unref'd and never writes the radio or emits a `tuner:rate-policy` event.

- [ ] **Step 1: Failing tests:** `rate-policy-link-recheck.test.ts` (fake tuner port, real
      `createLinkAdvisor`, injected `now` and a manual `setTimer`, no real clock):
      `"re-check 10 s after a raise reports dropping once as a critical alert"` (feed observe samples 2 % short
      of 4.8 MB/s after the raise); `"upstream drops above 10 000 B/s at the re-check report dropping"`;
      `"a healthy link after the raise reports nothing new"`; `"dropping then recovered reports the new level
once"`; `"restore, an operator rate write, reset and dispose each cancel the re-check"`;
      `"loopback source arms no re-check"`; `"re-check never writes the radio and never emits a tuner event"`.
      `link-advisory.test.ts`: `"127.0.0.5, ::1 and LOCALHOST are none"`; `"10.0.0.2 with no history is unproven"`;
      `"sustained 2.048 MB/s, payload 4.8 MB/s is unproven"`; `"shortfall 1.0 % is not dropping, 1.01 % is"`;
      `"upstream drops 10 000 B/s is not dropping, 10 001 is"`; `"reconnect resets sustained"`;
      `"advisory and alert contain no host string"` (assert `JSON.stringify` excludes the host);
      `"aggregator emits warning for unproven, critical for dropping, nothing for none"`.
- [ ] **Step 2:** **Property 10: Link advisory** (Validates 7.1, 7.2, 7.3) in the property file: arbitrary
      timed observe sequences and upstream drop rates; the classification matches a reference model, and over
      arbitrary re-check runs the reported levels are exactly the level changes of the model.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** plus `rate-policy.test.ts`, existing
      resource aggregator tests, typecheck, lint — PASS. **Commit** own paths. Live (Main, after MA.1): W at
      1.024 Msps via REST: tune to 1 090 MHz; the `raised` event carries `unproven`; if the link cannot carry
      4.8 MB/s, within about 10 to 20 s of the raise a `critical` `link-capacity` alert (`dropping`) appears on
      the resources channel and the rate stays 2.4 Msps; L reports `none` and arms no re-check.

---

### Task MG.1: Manager placements, mode, status (lane MG)

**Files:**

- Modify: `src/decoders/manager.ts` (`DecoderState` owner union line 190, `assessEligibility`, `startAll`,
  `enqueueSourceEvaluation` line 2520, status assembly near line 1423), `src/decoders/manager-options.ts`,
  `src/decoders/types.ts`, `src/api/serializers/decoder-status.ts`, `src/api/routes/decoders.ts` (settings
  PATCH shape gate only: `PATCH_BODY_KEYS` line 185, `isSettingsPatchShape` line 251, the docs-only PATCH
  body schema near line 836 and its description, the shape-error message near line 910)
- Test: `tests/unit/decoders/enablement/manager-placements.test.ts`, `tests/unit/decoders/enablement/manager-mode.test.ts`,
  `tests/unit/decoders/enablement/manager-always.property.test.ts`, `tests/unit/api/decoder-settings-route-mode.test.ts`

**Interfaces:**

- Consumes: `PlacementPlanner`, `PlannerInput`, `WantedPlacement`, `ResolvedMode`, `placementKey` (0.1);
  CM, PL, EF modules through fakes until they merge (inject via `manager-options.ts`).
- Produces (in `manager-options.ts`, all optional so existing callers compile):
  `enablement?: { planner: PlacementPlanner; resolveMode: (id: string) => ResolvedMode; isCatalogue: (config: DecoderConfig) => boolean; unavailable: (id: string) => boolean; recheckAvailable: (id: string) => Promise<boolean>; vfo: () => PlannerVfo | null; bandplanChannels: BandplanChannelLookup; maxBandplanChannels: number; gate?: EfficiencyGate }`
  (`recheckAvailable` re-resolves the binary, requirement 1.6; Main wires it to `resolveDecoderBinary`).
  Route (settings PATCH shape gate): `PATCH_BODY_KEYS = new Set(["enabled", "options", "mode"])`;
  `isSettingsPatchShape` accepts `mode` when it is a string or `null` (value validation stays in CM.2's
  `validateDecoderPatch`, so an unknown string is a 400 from the policy with no echo); the docs-only body
  schema gains `mode: { type: ["string", "null"], enum: ["auto", "always", "off", null] }` and the
  description and shape-error message name `mode`. Nothing else in the PATCH handler changes.
  Channelizer availability is whether `setChannelizer` received a provider (A8); MG has no auto flag.
  Manager methods: `applyDecoderMode(id: string, mode: DecoderMode): Promise<void>`;
  `notifyVfoSettled(vfo: PlannerVfo | null): void`; `notifyBandplansChanged(): void` (A4);
  `readsbRateFacts(sourceId: string): ReadsbRateFacts | null` (RP port); `efficiencyView(): DecoderEfficiencyView`
  (MG.2). When `enablement` is absent the manager behaves exactly as today.

Behaviour (design "Manager integration"): owner union becomes `"config" | "scanner" | "placement"`; worker
states keyed by `placementKey`, created through the same spawn, wiring, rate-plan, crash-restart and
channel paths, with `channelHz` set in the worker's option copy; excluded from `GET /api/decoders`,
`decoder:created`, `decoder:removed`, config export; output re-emitted under the parent id with the
placement frequency in RF provenance (`src/decoders/provenance-bindings.ts` read-only use); worker log lines
into the parent ring prefixed `[<channelHz>]`. `assessEligibility` order: hold → `decoder-unavailable` →
rate → mode/band (`always` and operator pin skip band) → reach (`channelizer-unavailable`) → gate. Mode:
`off` = `stopDecoder` + `desiredRunning = false`, `startAll` skips it; leaving `off` starts with
`startMode: "auto"`; `auto`↔`always` enqueue an evaluation. Status: `mode`, `modeSource`, `origin`
(`catalogue` when `isCatalogue`), `placements[]`, top-level suspension from the primary; with no placement,
reason precedence `tuner-scanning`, rate, `decoder-unavailable`, `channelizer-unavailable`,
`frequency-out-of-band`, `efficiency-budget` (11.3). Requirement 1.6: an operator (REST) start of an
instance marked unavailable awaits `recheckAvailable(id)`; on `true` the mark clears and the start proceeds
as today; on `false` it stays `decoder-unavailable`, spawns nothing and schedules no restart. A primary that moved is retargeted through the existing
caps-change restart path; a worker whose VFO channel moved is retuned via `retuneChannel` when available
(CH), else closed and reopened. One info log line per transition with fixed fields; errors via
`safeErrorFields`.

- [ ] **Step 1: Failing tests** (fake decoders, fake channelizer transport, fake sources):
      `"162.0 MHz with channelizer: AIS, dsd-fme VFO and multimon-ng VFO run; GET list shows three decoders"`;
      `"worker output is emitted under the parent id with the placement frequency"`;
      `"worker never appears in decoder:created or the list"`; `"worker log lines carry the [channelHz] prefix"`;
      `"unavailable catalogue instance never spawns and never schedules a restart"` (Review Focus 1);
      `"off stops now; leaving off starts with startMode auto"`; `"REST stop of always holds until start, mode change or restart and keeps the stored mode"`;
      `"VFO burst produces one retarget"` (Review Focus 3); `"retune refused falls back to close and reopen"`;
      `"scanner hold suspends workers with tuner-scanning"`; `"reason precedence with no placement"` (table test of 11.3);
      `"REST start of an unavailable instance re-checks the binary: found starts it, still missing stays decoder-unavailable without spawning"` (1.6);
      `"without enablement options, existing manager tests are unchanged"` (run `tests/unit/decoders/manager-*.test.ts`).
- [ ] **Step 2:** **Property 3: Always skips only the band — manager half** (Validates 2.1, 3.9) in
      `manager-always.property.test.ts`: arbitrary caps; `always` is never `frequency-out-of-band` and is
      suspended for hold/rate/unavailable/gate exactly when the equivalent `auto` is.
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run** the new tests and every
      `tests/unit/decoders/manager-*.test.ts`, `tests/unit/api/decoder-status-contract.test.ts`, typecheck, lint — PASS.
- [ ] **Step 6: Commit** own paths.
- [ ] **Step 7: Settings route accepts `mode` (after CM.2 is merged; rebase first).** Failing tests in
      `tests/unit/api/decoder-settings-route-mode.test.ts`, built like `tests/unit/api/decoder-settings-route.test.ts`
      (Fastify `inject`, real settings service from CM.2 on a temp-dir store, fake manager recording
      `applyDecoderMode`): `"PATCH mode always persists through the route and calls applyDecoderMode once"`
      (Review Focus 6); `"PATCH mode null removes the override"`; `"If-Match mismatch rejects a mode patch with
today's status"`; `"protected-mode rule unchanged for mode"` (mirror the existing `enabled` cases);
      `"invalid mode value is a 400 with no echo of the value"`; `"mode of a non-string type is rejected by the
shape gate"`; `"enabled and options patches are byte-identical to before"`. Run them (FAIL), implement the
      route change above, run them plus `tests/unit/api/decoder-settings-route.test.ts
tests/unit/api/decoder-patch-legacy.test.ts tests/unit/api/server-decoder-settings-wiring.test.ts`,
      typecheck, lint — PASS. Update any existing assertion of the old shape-error message and list it as a
      changed golden. Commit own paths. Live (Main, after MA.1): L at 162.0 MHz with the channelizer enabled:
      AIS, dsd-fme (VFO) and multimon-ng (VFO) run as placements; Activity shows one decoder each.

### Task MG.2: Gate in the caps worker, channelizer auto start, efficiency route (lane MG)

**Files:**

- Modify: `src/decoders/manager.ts`, `src/api/routes/decoders.ts`
- Test: `tests/unit/decoders/enablement/manager-gate.test.ts`, `tests/unit/api/decoders-efficiency-route.test.ts`

**Interfaces:**

- Consumes: `EfficiencyGate` (0.1); the channel provider set by `DecoderManager.setChannelizer`, using
  only its existing `requestChannel` / `releaseChannel` (and CH.1 `retuneChannel`). There is no start/stop
  API: the engine spawns lazily on the first request, and the idle linger is CH.2's `idleStopMs` (A8). MG
  releases a channel as soon as its placement goes and never defers `releaseChannel`.
- Produces: route handler `GET /api/decoders/efficiency` registered in `src/api/routes/decoders.ts` returning
  `DecoderEfficiencyView` (Fastify response schema in the route file); manager `efficiencyView()`.

Behaviour: on each evaluation, newcomers in plan order go through `gate.admit`; not-admitted are suspended
`efficiency-budget` with the detail and scheduled at `retryAtMs` (and re-checked on the
`EFFICIENCY_SAMPLE_MS` tick while blocked placements exist); `gate.probation` verdicts suspend the named
key only. Drops/CPU with no probationer: one warning per minute, nothing suspended. Channelizer auto (A8):
when a provider is set, an admitted channel placement requests its channel (the first request spawns the
source's engine) and a removed one releases it; the 60 s idle stop is the provider's (CH.2), and whether a
provider exists at all is Main's composition (MA.1). `channelizer.enabled: true` unchanged. Catalogue
channel types without a provider: `channelizer-unavailable`; YAML ones keep the raw path (5.3).

- [ ] **Step 1: Failing tests:** `"budget 0.5 at 869.525 MHz: LoRa and dsd-fme efficiency-budget (budget), nothing restarts in a loop over 10 simulated minutes"`;
      `"blocked placement is retried no more than once per retry period"` (Review Focus 4);
      `"probation drop suspends only the newest probationer"`; `"operator-started decoder outside probation is never stopped by the gate"`;
      `"no provider → channelizer-unavailable for catalogue channel types, raw for YAML"`;
      `"with a provider, the first admitted channel placement requests a channel and its removal releases it immediately"`;
      `"no channel is requested before a channel placement is admitted"`;
      `"route returns budget, cpu null as null, drops unknown as unknown, ordered admitted and blocked"`;
      `"route is read-only in protected mode under today's access rules for GET /api/decoders"`;
      `"efficiency route schema keeps every DecoderEfficiencyView field"` (the 0.1 schema-survival case for this
      route: nulls, `unknown`, `detail`, `retryAt` survive Fastify serialisation).
- [ ] **Step 2:** Integration versions of **Property 6** and **Property 7** with fake monitor samples
      (`numRuns: 100`).
- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** **Step 5: Run**, typecheck, lint — PASS.
- [ ] **Step 6: Commit** own paths. Live (Main, after MA.1): L with `cpuBudgetCores` 0.5 at 869.525 MHz: LoRa
      and dsd-fme shown `efficiency-budget` (`budget`); nothing restarts in a loop.

---

### Task MA.1: Composition (Main)

**Files:** Modify `src/index.ts`, `src/api/server.ts`, `config/default.yaml`.
Test: `tests/unit/core/decoder-enablement-wiring.test.ts` (create).

- [ ] **Step 1: Failing wiring test:** with the shipped config and fake binaries resolver, boot composition
      yields nine catalogue decoders before `openDecoderSettingsService`; `decoderPolicy.catalogue: false` yields
      none; `GET /api/config/export` equals the base; `tuner:rate-policy` reaches the `tuner` WS channel;
      `GET /api/decoders/efficiency` is registered; with the shipped config and `CHANNELIZER_AUTO_ACCEPTED`
      false, no `ChannelizerManager` and no settlement observer are constructed, nothing is spawned and
      `decoderManager.setChannelizer(null)` is called (A8); with the composition helper stubbed to `"auto"`, a
      manager and observer are constructed with `idleStopMs: CHANNELIZER_IDLE_STOP_MS` and still nothing spawns
      until a channel request; `channelizer.enabled: true` constructs them without `idleStopMs`; a relay
      `SET_FREQUENCY` into reach reaches `ratePolicy.onRelayRetune` (A9);
      `"metrics event feeds observe and connected resets"` (A10, 7.1): a fake `SourceManager` emitting
      `metrics("s1", { bytesReceived, dataRate: 4_000 })` produces `observe("s1", 4_096_000, <tuner rate>,
<now>)` on a spy advisor, and `connected("s1")` produces `reset("s1")`; the rate policy's `reportLink`
      reaches `ResourceAggregator.reportLinkAdvisory` (7.2); `"settings mode applies live"` (2.5): the settings
      service built by composition has `applyDecoderMode` bound to `DecoderManager.applyDecoderMode`, so a
      service `update({ mode: "off" })` calls the manager method once with `("readsb", "off")`; the manager's
      `enablement.recheckAvailable` resolves through `resolveDecoderBinary` (1.6); shutdown calls
      `ratePolicy.dispose()`.
- [ ] **Step 2: Implement:** in the channelizer block of `src/index.ts` (around lines 1095-1142), replace
      both `config.channelizer.enabled` checks with `const chanMode = channelizerComposition(config.channelizer,
CHANNELIZER_AUTO_ACCEPTED)`: build the `SettlementRegistry` / provider lifetime / observer and the
      `ChannelizerManager` when `chanMode !== null`, adding `idleStopMs: CHANNELIZER_IDLE_STOP_MS` only when
      `chanMode === "auto"`; otherwise `setChannelizer(null)` exactly as today (the scanner block near line 1364
      then sees the same observer, which is what 5.2's "no decoder or scanner channel" linger covers).
      `buildDecoderCatalogue` + `resolveDecoderBinary` before the settings service
      and decoder creation; `resolveDecoderMode` from settings + config; gate (`defaultCpuBudgetCores(os.arch(),
os.cpus().length)` unless `decoderPolicy.efficiency.cpuBudgetCores`), monitor (A5), planner sources
      (live demodulator → `createVfoTracker` → `notifyVfoSettled`; band-plans service → lookup and
      `notifyBandplansChanged`, A4); `createRatePolicy` with `manager.readsbRateFacts`, `createLinkAdvisor`, the
      tuner hooks (`setBeforeOperatorRetune`, `onOperatorSampleRate`, `setOnRelayRetune` → `onRelayRetune`),
      `reportLink` → `ResourceAggregator.reportLinkAdvisory`, `upstreamDropsOf` from the aggregator's
      `SourceBackpressureTracker` drop rate, and `setTimer` over `setTimeout(...).unref()`; the link feed (A10):
      `sourceManager.on("metrics", ...)` → `link.observe(id, dataRate * 1024, tuner rate, Date.now())` and
      `sourceManager.on("connected", id => link.reset(id))`; the settings service dep `applyDecoderMode` →
      `decoderManager.applyDecoderMode` (2.5); `enablement.recheckAvailable` → `resolveDecoderBinary` (1.6);
      `ratePolicy.dispose()` in shutdown; `config/default.yaml` comments documenting `mode`,
      `decoderPolicy`, `channelizer.auto` (comments only, no keys set).
- [ ] **Step 3: Run** the wiring test, `pnpm run typecheck`, `pnpm run lint` — PASS. Commit own paths.

### Task MA.2: Docs (Main)

- [ ] Update `docs/API.md` (mode, placements, efficiency route, reasons, `tuner:rate-policy`, `link-capacity`);
      add the band-plans requirement 1.2 amendment note in `docs/specs/band-plans/requirements.md` (3.10);
      the web-gaps-8 requirement 1.5 note in `docs/specs/web-gaps-8/requirements.md` (2.5); append the widened
      unions to `docs/CLI-COORDINATION.md` by hand (never Prettier); `docs/ROADMAP.md` status (A1 is already in
      the requirements Defaults paragraph). Run
      `pnpm exec vitest run tests/unit/repo/agent-instructions.test.ts`. Commit own paths.

### Task MA.3: Checkpoint (Main)

- [ ] `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `make chan-test`; review every golden change in
      lane reports against the requirements Defaults paragraph; grep `cli/` for each widened union (CLI
      landing check). Expected: all green; no unlisted golden change.

### Task MA.4: Capacity acceptance (Main, live)

- [ ] Run requirement 5.4 on the desktop reference and a Pi 4-class core host at 2.048 and 2.4 Msps,
      windows C and A for 10 minutes unthrottled (0.00 % drops on every branch including the channelizer
      input), and window C+ with the budget raised (no drop, or the gate suspends the newest probationer before
      a second drop window). Record in `docs/engineering/` (new file
      `docs/engineering/2026-10-decoder-enablement-capacity.md`). Only if every check passed, set
      `CHANNELIZER_AUTO_ACCEPTED = true` in `src/decoders/enablement/contract.ts`, update the contract test's
      shipped-config composition expectation (`"auto"`) and the MA.1 wiring test's default-config case (manager
      and observer now constructed with the linger, still nothing spawned before a request), and commit them
      with the record in one commit. Then run CH.2's live step.

### Task MA.5: Live acceptance (Main, live)

- [ ] Requirement 12.2 on L at 2.4 Msps: ADS-B after a tune to 1 090 MHz; AIS at 161.5 MHz centre; rtl_433
      at 433.92 MHz; POCSAG on a configured channel and on the VFO; DMR on the VFO; every running decoder's
      branch 0.00 % drops for 10 minutes; efficiency view matches `ps`. Then the W checks of RP.1 and RP.2 and
      every lane's deferred "Live (Main)" step. Record results in `docs/ROADMAP.md`.

---

### Dependent follow-ups (wait for the identify lane to merge `src/core/scanner/**`)

- [ ] **ID-F.1** Verify priors clamped above 0 and only user-typed lists bound trials; add
      **Property 14: Identify is never excluded by priors** (Validates 9.1) under `tests/unit/core/scanner/` if
      missing. Live: L, identify an analog FM signal inside a band-plan range not listing `analog-fm`.
- [ ] **ID-F.2** Temporary channelizer probe for AIS, ACARS, VDL2, LoRa on a detected signal anywhere in the
      window within the probe pool budget (9.2). Live: L, identify an AIS burst with ais-catcher `off`.
- [ ] **ID-F.3** Scanner status `channelizerAvailable` reports an auto-started engine (5.2).

---

## Self-review notes

- Coverage: 1.x → CM.1, MG.1 (1.6 re-check on operator start), MA.1; 2.x → CM.2 (policy, store, service),
  MG.1 (route shape gate, Step 7), MA.1 (2.5 `applyDecoderMode` binding); 3.x → PL.1, PL.2, MG.1, MA.2 (3.10); 4.x → EF.1, EF.2,
  MG.2; 5.1–5.3 → MG.2, CH.2, MA.1 (A8); 5.4 → MA.4; 5.5 → CH.1, MG.1; 6.x → RP.1 (6.4/6.5 external-control advice
  via the relay hook, A9); 7.x → RP.2 (advisor, alert, post-raise re-check producing `dropping`, A11), MA.1
  (feed from source metrics and reconnect reset, A10); 8.x → PL.1, MG.1; 9.x → ID-F;
  10.x → RP.1 Property 9, Global Constraints; 11.x → 0.1, MG.1, MA.2; 12.x → MA.5 and each lane's live step.
- Properties 1–14 each have an owning task.
- Lane files stay disjoint: `src/api/routes/decoders.ts` is MG's alone (CM.2's `mode` reaches it only through
  MG.1 Step 7); `src/core/rate-policy.ts` is RP's in both RP.1 and RP.2; MA.1 touches only Main seams.
- Timing: no test passes or fails on wall-clock throughput; PL.1 and EF.2 benches are report-only; timers
  are injected or fake everywhere.
