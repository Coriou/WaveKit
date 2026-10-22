# Link Burst Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A network IQ source gets one per-source burst absorber in front of its fanout, every drop
interval is attributed (`none | link | host | consumer | unknown`), the efficiency gate stops judging
newcomers on link weather and sheds the newest automatic placement on sustained late host or consumer
drops, and every network source has a numeric link report.

**Architecture:** A frozen contract (package 0: `packages/api-types`, `src/core/link-burst/contract.ts`,
`src/decoders/enablement/contract.ts`, `src/config.ts`) lets five lanes build in parallel with disjoint
files: the absorber and its router/fanout seams (lane AB), ingest instrumentation and reporting
(lane IR), attribution and the gate (lane AG), the fake link and benches (lane FL), and the delivery
hook and docs (lane HD). Main composes everything in `src/index.ts` (task M.1), runs the fake-link
acceptance, records the live instrumentation run and flips the absorber default on in the same commit
as that record.

**Tech Stack:** TypeScript (Node 24, ESM, strict), Zod, Fastify, Vitest + fast-check, Python 3
(`scripts/capacity/`), Docker Compose (scratch acceptance only), pnpm + Turborepo.

**Spec:** `docs/specs/link-burst-resilience/requirements.md` and
`docs/specs/link-burst-resilience/design.md`. Executors read the requirement and design section each
task cites; this plan does not restate the design's option tables or budget rationale, only the values
a task pins.

## Global Constraints

- Worktree `/Users/ben/Projects/wavekit-lbr`, branch `batch/link-burst` off `main`. Task 0.1 lands
  first; then each lane works in its own worktree off `batch/link-burst`
  (`/Users/ben/Projects/wavekit-lbr-<lane>`). Commit only own paths with
  `git commit -m "..." -- <paths>`; never `git add -A`; never `git stash` without a unique tag; never
  run Prettier on `docs/CLI-COORDINATION.md`; do not push unless the brief says so.
- File ownership is disjoint per lane (see File Structure). A lane that needs a change in another
  lane's file asks Main; it never edits it.
- Main-only seams: `src/index.ts`, `src/config.ts`, `src/core/link-burst/contract.ts`,
  `src/core/link-burst/compose.ts`, `src/decoders/enablement/contract.ts`, `packages/api-types/**`,
  build files (`package.json`, lockfile, `Dockerfile`, `Makefile`).
- Hard gates for lanes: no RF, tuning, receiver or Raspberry Pi work, no deploys, no Docker builds or
  runs. Tests use in-process fakes only: fake sources, fake fanout ports, fake consumers with scripted
  drain schedules, injected monotonic clocks. Never connect to `host.docker.internal:15555/15556/18080`,
  ports 9000/5173/8081/8082, or any Pi/LAN IP. The scratch compose project (task FL.2) uses a private
  network and an ephemeral host port only; only Main runs it.
- Performance (docs/PERFORMANCE.md): per-sample IQ work at or above channel rate belongs in Rust under
  `native/`; this design adds only per-chunk and per-block TypeScript. At most 2 ms added event-loop
  p99 at 2.048 Msps. No per-chunk allocation in steady state (ring empty: the socket's `Buffer` passes
  through untouched). Read IQ once per source: the absorber is not a fanout branch and adds no branch.
  Claims are measured (task FL.3 bench) and backed by chunk-split invariance tests.
- Fanout: `FanoutManager.distributeData` body does not change; overflow always counts as drops; no
  change to general fanout backpressure without Property 1's oracle equivalence test.
  Decoder-enablement Properties 16 and 17 (`tests/unit/core/fanout-manager.test.ts:719`, `:845`) stay
  green unchanged.
- Trust: gates are pull-based on the monitor's monotonic clock and fail closed; unknown or missing
  evidence never credits and never yields `link`. Only the built-in catalogue is gated and sheddable;
  YAML (`config`) and `always` decoders are admitted without verdict; operator-started decoders are
  never shed. Never exclude a protocol from identify; no automatic band time-share; late shedding never
  retunes, changes a rate or writes to the receiver.
- Reports and logs carry numbers, ids and closed enums only: never host names, addresses, SSIDs,
  request parameters or error messages (use `safeErrorFields` from `src/decoders/safe-error-fields.ts`).
- Code: strict TS, no `any`, ESM with `.js` relative imports, `import type`, tabs/no semicolons/double
  quotes, errors from `src/utils/errors.ts`, component loggers via `createComponentLogger`
  (`src/utils/logger.ts`), Zod at boundaries, shared DTOs in `packages/api-types`.
- Property tests: fast-check `numRuns >= 100` (200 for Properties 1, 3 and 4), with
  `// Feature: link-burst-resilience, Property N: <name>` and `// Validates: Requirements X.Y`.
- Public repo: never reference private notes, agent or model names, or internal batch process in
  tracked files, commits or PR text.
- Every lane, before reporting: its touched test files (`pnpm exec vitest run <files>`),
  `pnpm run typecheck`, `pnpm run lint`. Lanes do not run the full root suite; Main does in M.1.
  Reports give base/head, commits, check output and open gaps.

## Assumptions (spec gaps resolved here)

- **A1 Transport.** A source is `network` when its type is not `recording`, its caps format is
  `U8_IQ` or `S16_IQ`, its configured host (`sourceManager.getConfig(id).host`) is defined, and
  `isLoopbackHost(host)` (`src/core/link-advisory.ts:9`) is false. The configured host is used, not
  `getActiveHost()`, so the absorber and the link advisory (`src/index.ts:1949`, `linkInput`) never
  disagree after an endpoint switch. Decided once per `connected`.
- **A2 IQ only.** Only caps formats `U8_IQ` (frame 2 bytes) and `S16_IQ` (frame 4 bytes) are IQ; every
  other format (including `auto`, which auto-detects audio formats) gets no recorder and no absorber.
- **A3 Partial frames.** SourceManager already frame-aligns, but the absorber does not rely on it: a
  chunk that fits is held whole (including any partial trailing frame); releases are frame-aligned
  blocks, so a partial frame waits in the ring for its remainder. Only the overflow cut point is
  frame-aligned (the part that fits is floored to a frame).
- **A4 Overflow and Property 11.** Absorber overflow is drop evidence exactly as an all-branch drop
  with the same attribution: a `link`-attributed overflow neither closes the drop term nor resets the
  clean window (requirement 4.4 wins); any other attribution of an overflow does both. Property 11 is
  tested in that form.
- **A5 CPU comparison.** Attribution's `host` rule uses "at or above `cpuGuardPercent`" (requirement
  3.5). The gate's existing admission and `highCpu` rule (strictly above, `efficiency-gate.ts`) is
  decoder-enablement behaviour and stays unchanged.
- **A6 Upstream evidence.** The monitor computes the upstream drop delta from a new side-effect-free
  `SourceBackpressureTracker.upstreamDroppedTotal(id)` (cumulative `bytesDropped`, null when
  unavailable). A decrease (rtlmux restart) yields null for that sample. `getBackpressure()` is not
  called by the monitor, because it mutates the tracker's rate history.
- **A7 Inactive branches.** Deferred (inactive) fanout branches never drop and are excluded from the
  "every active branch" test. `FanoutManager` gains `isBranchActive(id)`; the router's counter map
  carries `active` per key.
- **A8 Late-shed bookkeeping placement.** The monitor keeps the per-source ring of complete 10 s
  windows; the gate keeps the shed cooldown and the "late since" mark (last time the source had a
  probationer, or the last shed) and ignores windows that started before it. Behaviour is the
  design's; only the field owner differs. HD.2 records this as a one-line erratum in the design's
  "EfficiencyMonitor and EfficiencyGate changes" section so spec and code agree.
- **A9 Advisory alerting path.** The `link-capacity` alert keeps today's emission path
  (`ResourceAggregator.reportLinkAdvisory`), fed from two places: the rate policy's re-check through
  `reportLink` (unchanged), and a link-quality re-check (`LinkQuality.recheckAdvisories()`, IR.4)
  that the aggregator calls on every broadcast tick (`DEFAULT_BROADCAST_INTERVAL_MS`, 2 s), so a
  link-hold `dropping` level is raised well within `LINK_DROPPING_HOLD_MS`. Each path reports only
  on a level change per source; one transition may therefore alert at most twice (once per path),
  which is accepted. Absorbed bursts raise nothing (6.6).
- **A10 Receiver facts.** Core polls the SDR host's `GET /api/host` in `SdrHostPoller` (it fetches
  only `/api/status` today) and keeps only: the default-route interface (lowest non-null
  `defaultRouteMetric`) `kind` and `wireless.signalDbm`, `power.undervoltageNow`, and
  `power.throttling.value.throttled`. Any reading whose `state` is not `"ok"` is null. The SDR host
  hardcodes throttling as unavailable today, so `throttled` is null in practice.
- **A11 Shortfall payload.** The new `LinkAdvisor.shortfall(sourceId, sampleRateHz, frameBytes)` uses
  `sampleRateHz × frameBytes` as payload; `classify` keeps its existing `× 2`.
- **A12 Ingest interval resolution.** The recorder answers `interval(from, to)` from a 64-entry ring of
  250 ms max-gap cells (16 s); a gap is attributed to the cell in which it ended, so the "this or the
  previous interval" lookup is exact to 250 ms.
- **A13 `RunningPlacement.mode` / `startMode` are optional** so existing fixtures compile; a placement
  without both is never sheddable (fail closed).
- **A14 Slow test consumer (requirements 9.2, 9.3).** The spec's "deliberately slow test consumer"
  is a YAML `rtl433` decoder entry (`link-burst-slow-sink`, raw path, no `mode`) whose `rtl_433` is
  shadowed in the scratch container by `scripts/link-burst/slow-sink/rtl_433` (FL.2); no core code
  or decoder type is added. It is a YAML placement, so it is gate-exempt and never shed; `late-shed`
  therefore expects the newest graduated catalogue placement to be shed, not the sink. Assumed and
  checked on the first M.2 `consumer` run: backpressure from the throttled shim through the csdr pipe
  congests the decoder's own fanout branch (the driver marks the run invalid otherwise), and the
  decoder manager does not restart a decoder that emits no output for 10 minutes. If the pipe
  buffers absorb the throttled rate, the driver falls back to the shim's pause mode (sentinel `0`:
  the shim stops reading, so finite pipe buffers fill and the branch must congest); see FL.2.
- **A15 Instrumentation exposure (requirements 2.1–2.3).** The live record needs the raw
  distributions, not only the window summaries, so `SourceLinkQuality` carries an optional
  `histograms` block (gap, chunk size and catch-up-per-burst counts over the 10 min window, with
  bucket edges) and an optional `loopDelay` block (last efficiency-interval max/p99 plus 10 min
  maxima). The loop delay is process-wide, so every source's report carries the same `loopDelay`
  values. The loop meter keeps a 300-entry ring of the intervals the monitor takes and serves a
  non-resetting `report()`; only `takeInterval()` resets the native histogram (design
  "EventLoopMeter").
- **A16 Sibling latency proxy (requirement 9.2).** Sibling added latency is measured as the
  absorber's longest continuous holding episode (`peakHeldMs10m`) and the longest
  congested-to-excluded time of a laggard (`laggardExcludeMsMax10m`), both from the absorber's
  counters and both in the report; FL.2 records them per scenario.

## Review Focus

1. **A branch in startup refusal whose backlog already drained.** `startupDraining` is only cleared
   inside `distributeData`; if `congestedBranchIds` reported the flag as-is, a holding absorber would
   never call `distribute` and would hold forever. `congestedBranchIds` must report startup refusal
   only while the same clearing condition still fails. Test in AB.1 (`startup-draining branch below
its mark is not congested`) and AB.2 (`holding absorber releases once a startup branch drained`).
2. **A deferred (inactive) branch beside branches that all dropped.** It must not turn an all-branch
   burst into `consumer`. Test in AB.3 (`counter map marks inactive branches`) and AG.2
   (`inactive branch does not make a burst a strict subset`).
3. **Odd-sized and S16 chunks while holding.** Bytes are conserved and every delivered chunk is a
   multiple of the frame size, for frame 2 and 4. Test in AB.2 (Property 3 generator includes odd
   chunk lengths and both frame sizes).
4. **A disconnect or manual reconnect while holding.** Held bytes are flushed and counted as
   `flushedBytes` (not drops), and the reconnect pause is not recorded as an arrival gap (the router
   resets the recorder's arrival clock on `disconnected`/`removed`). Test in AB.3
   (`disconnect while holding flushes and resets arrival`) and IR.1 (`resetArrival breaks the gap
chain`).
5. **Untrusted strings in the report or route errors.** `GET /api/resources/link-quality/:sourceId`
   with an unknown id answers 404 with a fixed message that does not echo the parameter; the report
   never carries host names or addresses even when the SDR host sends them. Test in IR.3
   (`404 does not echo the source id`, Property 12 string check).

---

## File Structure

| Path                                                                                                                                                                                           | Owner | Responsibility                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/resources.ts`                                                                                                                                                          | 0     | `DropAttribution`, `SourceLinkQuality` and parts (incl. `histograms?`, `loopDelay?`), `resources:link-quality`, `SdrHostStatus.iqDelivery?` |
| `packages/api-types/src/tuner.ts`                                                                                                                                                              | 0     | `LinkBurstSummary`, `LinkAdvisory.burst?`                                                                                                   |
| `packages/api-types/src/receiver-capabilities.ts`                                                                                                                                              | 0     | `ReceiverIqDelivery`, `ReceiverCapabilities.iqDelivery?`                                                                                    |
| `packages/api-types/src/decoders.ts`                                                                                                                                                           | 0     | `late-drops` detail; `attribution?`, `lateDrops?` on the efficiency source view                                                             |
| `src/core/link-burst/contract.ts`                                                                                                                                                              | 0     | Constants and interfaces shared by every lane                                                                                               |
| `src/decoders/enablement/contract.ts`                                                                                                                                                          | 0     | `LATE_SHED_*`, `RunningPlacement.mode?/startMode?`, verdict detail, `SourceDropSample.attribution?`                                         |
| `src/config.ts`                                                                                                                                                                                | 0     | `sources[].burstAbsorber`, `sources[].delivery`                                                                                             |
| `src/core/fanout-manager.ts`                                                                                                                                                                   | AB    | `distribute`, `congestedBranchIds`, `isBranchActive`, `attachIngest`                                                                        |
| `src/core/link-burst/absorber.ts`                                                                                                                                                              | AB    | `createBurstAbsorber`                                                                                                                       |
| `src/core/source-fanout-router.ts`                                                                                                                                                             | AB    | Per-source recorder/absorber wiring, `@absorber` counters, `linkBurst(id)`                                                                  |
| `src/core/link-burst/recorder.ts`                                                                                                                                                              | IR    | `createIngestRecorder`                                                                                                                      |
| `src/core/link-burst/loop-meter.ts`                                                                                                                                                            | IR    | `createEventLoopMeter`                                                                                                                      |
| `src/core/link-burst/link-quality.ts`                                                                                                                                                          | IR    | `createLinkQuality`                                                                                                                         |
| `src/core/sdr-host-poller.ts`                                                                                                                                                                  | IR    | `/api/host` link facts, `iqDelivery` parse                                                                                                  |
| `src/core/link-advisory.ts`                                                                                                                                                                    | IR    | `shortfall()`, link hold, `burst`                                                                                                           |
| `src/core/resource-aggregator.ts`, `src/api/routes/resources.ts`, `src/api/websocket/events.ts`, `src/api/server.ts`                                                                           | IR    | Report route, WS event, `sdrHostStatusSchema.iqDelivery`, advisory re-check tick                                                            |
| `src/decoders/enablement/attribution.ts`                                                                                                                                                       | AG    | `attributeInterval`                                                                                                                         |
| `src/decoders/enablement/efficiency-monitor.ts`                                                                                                                                                | AG    | Per-key deltas, attribution, link path, windows, accessors                                                                                  |
| `src/decoders/enablement/efficiency-gate.ts`                                                                                                                                                   | AG    | Link admission wait, late shed, view fields                                                                                                 |
| `src/decoders/manager.ts`, `src/api/routes/decoder-status-schemas.ts`, `src/api/routes/decoders.ts`                                                                                            | AG    | Mode/start mode in running placements, late-shed backoff, schemas                                                                           |
| `src/core/source-backpressure-tracker.ts`                                                                                                                                                      | AG    | `upstreamDroppedTotal`, `peekDropRate`                                                                                                      |
| `scripts/capacity/fake_rtl_tcp.py`, `scripts/link-burst/**`, `scripts/bench/burst-absorber.ts`                                                                                                 | FL    | Fake link, scratch compose, bench                                                                                                           |
| `src/core/tuner-capabilities/provider.ts`, `src/core/tuner-capabilities/types.ts`, `src/api/routes/receiver-capabilities.ts`, `packages/sdr-host/src/api/routes/status.ts`                     | HD    | Delivery hook                                                                                                                               |
| `docs/specs/decoder-enablement/*.md`, `docs/specs/link-burst-resilience/design.md` (A8 erratum only), `docs/CLI-COORDINATION.md`, `docs/API.md`, `docs/specs/README.md`, `config/default.yaml` | HD    | Amendments, erratum, contract note, docs                                                                                                    |
| `src/core/link-burst/compose.ts`, `src/index.ts`                                                                                                                                               | Main  | Composition (M.1)                                                                                                                           |
| `docs/engineering/LINK-BURST-2026-10-*.md`                                                                                                                                                     | Main  | Records (M.2–M.4)                                                                                                                           |

Tests live under `tests/unit/core/link-burst/`, `tests/unit/core/`, `tests/unit/decoders/enablement/`,
`tests/unit/api/`, `tests/unit/utils/`, `tests/unit/capacity/`, `tests/unit/scripts/`,
`tests/unit/bench/` and `packages/sdr-host/tests/unit/`, owned by the lane of the code they test.

---

### Task 0.1: Freeze the contract (Main)

**Files:**

- Modify: `packages/api-types/src/resources.ts`, `packages/api-types/src/tuner.ts:198-205`,
  `packages/api-types/src/receiver-capabilities.ts:99`, `packages/api-types/src/decoders.ts:389-425`
- Create: `src/core/link-burst/contract.ts`
- Modify: `src/decoders/enablement/contract.ts`, `src/config.ts:96-134`
- Test: `tests/unit/core/link-burst/contract.test.ts`, `tests/unit/utils/config-link-burst.test.ts`

**Interfaces (Produces; every lane consumes these names verbatim):**

`packages/api-types` (exported from `packages/api-types/src/index.ts` as the existing files are):

```ts
export type DropAttribution = "none" | "link" | "host" | "consumer" | "unknown"
export interface SourceLinkAbsorber {
	enabled: boolean
	capacityBytes: number
	capacitySeconds: number
	heldBytes: number
	peakHeldBytes10m: number
	/** Longest continuous holding episode in the window (sibling latency proxy, 9.2). */
	peakHeldMs10m: number
	/** Longest congested-to-excluded time of a laggard in the window; null when none was excluded. */
	laggardExcludeMsMax10m: number | null
	absorbedBytesTotal: number
	overflowBytesTotal: number
	overflowChunksTotal: number
	flushedBytesTotal: number
	absorbedBytes10m: number
	overflowBytes10m: number
	flushedBytes10m: number
}
export interface SourceLinkArrivals {
	windowMs: number
	worstStallMs: number | null
	gapP99Ms: number | null
	burstSeconds: number
	catchupBytes10m: number
	chunks10m: number
}
export interface SourceLinkReceiver {
	interfaceKind: "ethernet" | "wireless" | "other" | null
	signalDbm: number | null
	undervoltageNow: boolean | null
	throttled: boolean | null
}
/** Raw distributions over the 10 min window (requirement 2.1, record 2.3). Counts align with edges. */
export interface SourceLinkHistograms {
	windowMs: number
	gapBucketUpperMs: number[]
	gapCounts: number[] // 48 buckets
	chunkSizeBucketUpperBytes: number[]
	chunkSizeCounts: number[] // 16 buckets
	catchupBucketUpperBytes: number[]
	catchupCounts: number[] // 16 buckets, one count per closed catch-up window (burst)
}
/** Event-loop delay per efficiency sample interval (requirement 2.2); process-wide. */
export interface SourceLinkLoopDelay {
	last: { maxMs: number; p99Ms: number } | null
	maxMs10m: number | null
	p99MaxMs10m: number | null
	intervals10m: number
}
export interface SourceLinkQuality {
	sourceId: string
	transport: "loopback" | "network"
	at: string
	absorber: SourceLinkAbsorber
	arrivals: SourceLinkArrivals
	attribution: {
		last: DropAttribution | null
		counts10m: Record<DropAttribution, number>
	}
	upstreamDropBytesPerSecond: number | null
	receiver: SourceLinkReceiver | null
	histograms?: SourceLinkHistograms
	loopDelay?: SourceLinkLoopDelay | null
}
// ResourceEventType gains "resources:link-quality"; SdrHostStatus gains
//   iqDelivery?: { modes: ("raw" | "channels")[] } | null
export interface LinkBurstSummary {
	worstStallMs: number | null
	overflowedBytes10m: number
	burstSeconds: number
}
// LinkAdvisory gains burst?: LinkBurstSummary
export interface ReceiverIqDelivery {
	readonly advertised: readonly ("raw" | "channels")[] | null
	readonly configured: "raw" | "channels" | "auto"
	readonly resolved: "raw"
}
// ReceiverCapabilities gains readonly iqDelivery?: ReceiverIqDelivery
// DecoderEfficiencyDetail = "budget" | "cpu" | "drops" | "unknown" | "late-drops"
export interface DecoderLateDropsView {
	condemningWindows: number
	windows: number
	cooldownUntil: string | null
	sheddable: number
	/** Why sustained late drops are not shedding (requirement 5.5); null when not held. */
	held: "nothing-sheddable" | "link-or-unknown" | null
}
// DecoderEfficiencySourceView gains attribution?: DropAttribution; lateDrops?: DecoderLateDropsView
```

`src/core/link-burst/contract.ts` (values from the design's Constants table):

```ts
export const BURST_ABSORBER_DEFAULT_S = 2
export const BURST_ABSORBER_MAX_S = 10
/** Instrumentation first (requirement 2.3): false until the live record flips it (task M.3). */
export const BURST_ABSORBER_DEFAULT_ENABLED = false
export const ABSORBER_RELEASE_BYTES = 65_536
export const ABSORBER_LAGGARD_MS = 500 // provisional
export const LINK_GAP_MS = 80 // provisional
export const HOST_LOOP_DELAY_MS = 50
export const CATCHUP_WINDOW_MS = 500
export const LINK_QUALITY_WINDOW_MS = 600_000
export const LINK_QUALITY_SLOT_MS = 10_000
export const LINK_DROPPING_HOLD_MS = 60_000
export const LOOP_METER_RESOLUTION_MS = 10
export const ABSORBER_COUNTER_PREFIX = "@absorber"
export const GAP_BUCKETS = 48 // geometric, ratio 1.25 from 1 ms
export const CHUNK_SIZE_BUCKETS = 16 // log2 bytes
export const CATCHUP_BUCKETS = 16 // log2 from CATCHUP_BUCKET_BASE_BYTES
export const CATCHUP_BUCKET_BASE_BYTES = 1_024
export const LOOP_DELAY_RING = 300 // 10 min of 2 s efficiency intervals
export type SourceTransport = "loopback" | "network"
export function frameBytesFor(format: string): 2 | 4 | null // U8_IQ→2, S16_IQ→4, else null
export function resolveAbsorberSeconds(
	configured: number | undefined,
	transport: SourceTransport,
): number
// configured ?? (transport === "network" && BURST_ABSORBER_DEFAULT_ENABLED ? BURST_ABSORBER_DEFAULT_S : 0)
export interface AbsorberFanoutPort {
	distribute(chunk: Buffer): void
	congestedBranchIds(out: Set<string>): void
	activeBranchIds(out: Set<string>): void
	on(
		event: "drain" | "branch-added" | "branch-removed" | "backpressure",
		fn: (id: string) => void,
	): void
	off(
		event: "drain" | "branch-added" | "branch-removed" | "backpressure",
		fn: (id: string) => void,
	): void
}
export interface IngestObserver {
	observeChunk(bytes: number, mono: number): void
	noteHolding(mono: number): void
}
export interface IngestInterval {
	maxGapMs: number
	catchupBytes: number
	chunks: number
}
export interface IngestWindowStats {
	worstStallMs: number | null
	gapP99Ms: number | null
	burstSeconds: number
	catchupBytes: number
	chunks: number
}
export interface IngestHistograms {
	gapBucketUpperMs: readonly number[]
	gapCounts: readonly number[]
	chunkSizeBucketUpperBytes: readonly number[]
	chunkSizeCounts: readonly number[]
	catchupBucketUpperBytes: readonly number[]
	catchupCounts: readonly number[]
}
export interface IngestRecorder extends IngestObserver {
	configure(sampleRateHz: number, frameBytes: number): void
	resetArrival(): void
	interval(fromMono: number, toMono: number): IngestInterval | null
	window(nowMono: number): IngestWindowStats
	/** Read-only; allocates per call (reporting path only, never per chunk). */
	histograms(nowMono: number): IngestHistograms
}
export interface AbsorberCounters {
	capacityBytes: number
	heldBytes: number
	absorbedBytesTotal: number
	overflowBytesTotal: number
	overflowChunksTotal: number
	flushedBytesTotal: number
	window: {
		peakHeldBytes: number
		absorbedBytes: number
		overflowBytes: number
		flushedBytes: number
		peakHeldMs: number
		maxLaggardExcludeMs: number | null
	}
}
export interface BurstAbsorber {
	configure(capacityBytes: number): void
	ingest(chunk: Buffer): void
	flush(reason: "disconnect" | "rate" | "removed"): void
	counters(): AbsorberCounters
	dispose(): void
}
export interface BurstAbsorberDeps {
	fanout: AbsorberFanoutPort
	recorder: IngestObserver | null
	monoNow: () => number
	frameBytes: number
	log: Logger
}
export interface LoopDelayInterval {
	maxMs: number
	p99Ms: number
}
export interface LoopDelayReport {
	last: LoopDelayInterval | null
	maxMs10m: number | null
	p99MaxMs10m: number | null
	intervals10m: number
}
export interface EventLoopMeter {
	/** The monitor's read: returns and resets the native histogram (the only reset). */
	takeInterval(): LoopDelayInterval | null
	/** Reporting read: never resets; answers from the ring of taken intervals. */
	report(nowMono: number): LoopDelayReport
	dispose(): void
}
export interface SdrHostLinkFacts {
	interfaceKind: "ethernet" | "wireless" | "other" | null
	signalDbm: number | null
	undervoltageNow: boolean | null
	throttled: boolean | null
}
export interface LinkBurstHandles {
	transport: SourceTransport
	capacitySeconds: number
	recorder: IngestRecorder | null
	absorber: BurstAbsorber | null
}
export interface LinkBurstFactories {
	createRecorder(sourceId: string): IngestRecorder
	createAbsorber(sourceId: string, deps: BurstAbsorberDeps): BurstAbsorber
	monoNow: () => number
}
```

`src/decoders/enablement/contract.ts` additions:

```ts
export const LATE_SHED_WINDOWS = 3
export const LATE_SHED_HITS = 2
export const LATE_SHED_COOLDOWN_MS = 30_000
// SourceDropSample gains attribution?: DropAttribution
// RunningPlacement gains mode?: DecoderMode; startMode?: DecoderStartMode
// ProbationVerdict.detail: "drops" | "cpu" | "late-drops"
export interface LateDropWindow {
	startMono: number
	endMono: number
	condemning: boolean
	/** Positive drops occurred in the window, but only in samples attributed `link` or `unknown`. */
	linkOrUnknownDrops: boolean
}
```

`src/config.ts` `SourceConfigSchema` additions:

```ts
burstAbsorber: z.object({ seconds: z.number().min(0).max(10) }).strict().optional(),
delivery: z
	.enum(["raw", "channels", "auto"])
	.default("auto")
	.refine(v => v !== "channels", { message: CHANNELS_RESERVED_MESSAGE }),
```

The refinement sits on the field (not the object), so `SourceConfigSchema` stays a plain `ZodObject`.
`CHANNELS_RESERVED_MESSAGE` is
`"delivery \"channels\" is reserved for a later receiver-side channelizer (link-burst-resilience 7.1)"`;
startup validation surfaces it as a `ConfigValidationError` like every other schema issue.

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/link-burst/contract.test.ts`: assert every constant equals the value above;
`frameBytesFor("U8_IQ") === 2`, `("S16_IQ") === 4`, `("S16LE") === null`, `("auto") === null`;
`resolveAbsorberSeconds(undefined, "network") === 0` while `BURST_ABSORBER_DEFAULT_ENABLED` is false,
`resolveAbsorberSeconds(undefined, "loopback") === 0`, `resolveAbsorberSeconds(3, "loopback") === 3`.

`tests/unit/utils/config-link-burst.test.ts`:

```ts
// Feature: link-burst-resilience, Property 14: Delivery hook (config half)
// Validates: Requirements 7.1, 8.2
it("auto and raw parse, channels fails, absent defaults to auto", () => {
	fc.assert(fc.property(fc.constantFrom("raw", "auto", "channels", undefined), d => {
		const r = SourceConfigSchema.safeParse({ ...baseSource, ...(d ? { delivery: d } : {}) })
		if (d === "channels") expect(r.success).toBe(false)
		else expect(r.success && r.data.delivery).toBe(d ?? "auto")
	}), { numRuns: 100 })
})
it("burstAbsorber.seconds accepts 0..10 and rejects outside", ...) // -0.1, 10.1 fail; 0, 2, 10 pass
it("env override sets the absorber seconds", ...) // WAVEKIT_SOURCES_0_BURST_ABSORBER__SECONDS=0 (the documented `_<index>_` array form, mapped by the indexed branch of parseEnvironmentVariables in src/config.ts) → sources[0].burstAbsorber.seconds === 0 via parseEnvironmentVariables + loadConfig
```

`baseSource` is a minimal valid `rtl_tcp` source with `caps` copied from an existing config fixture in
`tests/unit/utils/config.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/link-burst/contract.test.ts tests/unit/utils/config-link-burst.test.ts`
Expected: FAIL (module `src/core/link-burst/contract.js` not found; `delivery` unknown).

- [ ] **Step 3: Implement the contract files above.** DTO fields are all optional where marked so
      existing goldens stay byte-identical. Widen the `ResourceEventType` union only (no emitter yet).

- [ ] **Step 4: Verify**

Run: the two test files, then `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`.
Expected: PASS; no existing test changes.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): freeze contract, constants and config keys" -- packages/api-types/src/resources.ts packages/api-types/src/tuner.ts packages/api-types/src/receiver-capabilities.ts packages/api-types/src/decoders.ts src/core/link-burst/contract.ts src/decoders/enablement/contract.ts src/config.ts tests/unit/core/link-burst/contract.test.ts tests/unit/utils/config-link-burst.test.ts
```

---

## Lane AB: absorber

### Task AB.1: FanoutManager seams and the backpressure oracle

**Files:**

- Modify: `src/core/fanout-manager.ts:125-161,274,300`
- Create: `tests/unit/core/fanout-oracle.ts` (reference model), `tests/unit/core/fanout-equivalence.property.test.ts`
- Test: `tests/unit/core/fanout-manager.test.ts` (unchanged; must stay green)

**Interfaces:**

- Consumes: `AbsorberFanoutPort` (0.1).
- Produces on `FanoutManager`:
  - `distribute(chunk: Buffer): void` — public; calls the existing private `distributeData(chunk)`, body unchanged.
  - `congestedBranchIds(out: Set<string>): void` — clears `out`, adds every **active** branch with
    `backpressure === true`, or with `startupDraining === true` while the clearing condition of
    `distributeData` step 3 still fails (`stream.destroyed || stream.writableEnded ||
stream.writableLength >= highWaterMark`). Reads fields only; mutates nothing.
  - `activeBranchIds(out: Set<string>): void` — clears `out`, adds every active branch id.
  - `isBranchActive(id: string): boolean`
  - `attachIngest(source: Readable, ingest: (chunk: Buffer) => void): void` — identical to
    `attachSource` except the `data` handler is `ingest`; `detachSource()` removes it the same way.
  - `FanoutManager` structurally satisfies `AbsorberFanoutPort`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/core/fanout-oracle.ts` exports `createFanoutOracle(branches: {id, highWaterMark, startup?: {highWaterMark, durationMs}}[])`
modelling `distributeData` rules 1–7 (inactive skip; `totalBytesWritten`; startup draining clear or
drop; drop while backpressured; write and `canWrite` with the startup mark; enter backpressure;
startup timer end sets draining when `writableLength >= highWaterMark`), with per-branch
`{ output: number[]; droppedBytesTotal; droppedChunksTotal; transitions: ("bp" | "drain")[] }` and a
`consume(id, bytes)` step that emits `drain` when the model's writable length reaches 0 after a refusal.

`tests/unit/core/fanout-equivalence.property.test.ts`, reusing the harness style of
`fanout-manager.test.ts:700-760` (`vi.useFakeTimers`, `advanceTimersByTimeAsync`):

```ts
// Feature: link-burst-resilience, Property 1: Fanout backpressure equivalence
// Validates: Requirements 1.7
it("distribute matches the oracle per branch", async () => {
	await fc.assert(fc.asyncProperty(opsArb /* write(len 1..70000) | read(id, n) | expire | resume(id) | pause(id) */, async ops => {
		// run the same ops on a real FanoutManager fed via distribute() and on the oracle
		expect(realPerBranch).toEqual(oraclePerBranch) // output bytes, dropped totals, bp/drain transitions
	}), { numRuns: 200 })
})
it("attachSource and distribute are indistinguishable", async () => { /* same ops: one fanout fed by a PassThrough via attachSource, one by distribute(); telemetry and outputs equal */ }, )
it("startup-draining branch below its mark is not congested", ...) // activateBranch with startup mark, fill, expire timer, drain consumer below mark → congestedBranchIds(out) has no id
it("congestedBranchIds lists backpressured active branches only", ...) // deferred branch never listed
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/fanout-equivalence.property.test.ts`
Expected: FAIL (`distribute` is not a function).

- [ ] **Step 3: Implement the five public members.** No change inside `distributeData`, the startup
      timer, or telemetry.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run tests/unit/core/fanout-equivalence.property.test.ts tests/unit/core/fanout-manager.test.ts`
Expected: PASS, including decoder-enablement Properties 16 and 17 unchanged.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(fanout): read-only congestion seam and oracle equivalence property" -- src/core/fanout-manager.ts tests/unit/core/fanout-oracle.ts tests/unit/core/fanout-equivalence.property.test.ts
```

### Task AB.2: BurstAbsorber

**Files:**

- Create: `src/core/link-burst/absorber.ts`
- Test: `tests/unit/core/link-burst/absorber.test.ts`, `tests/unit/core/link-burst/absorber.property.test.ts`,
  `tests/unit/core/link-burst/fake-fanout.ts` (fake `AbsorberFanoutPort` with scripted per-branch congestion and drain events, recording delivered `Buffer` objects and the tick of delivery)

**Interfaces:**

- Consumes: `BurstAbsorber`, `BurstAbsorberDeps`, `AbsorberCounters`, `ABSORBER_RELEASE_BYTES`,
  `ABSORBER_LAGGARD_MS`, `LINK_QUALITY_SLOT_MS`, `LINK_QUALITY_WINDOW_MS` (0.1).
- Produces: `createBurstAbsorber(deps: BurstAbsorberDeps): BurstAbsorber`.

Behaviour (design "BurstAbsorber"; requirements 1.3–1.8):

- `configure(capacityBytes)`: floors to a frame multiple; allocates one `Buffer.allocUnsafeSlow` only
  when capacity changes; 0 frees the ring and makes `ingest` a pure pass-through. Held bytes at
  reconfigure are flushed (`reason: "rate"`).
- `ingest(chunk)`: `recorder?.noteHolding(mono)` when it holds; ring empty and no gating branch
  congested → `fanout.distribute(chunk)` with the same object, synchronously. Otherwise append (A3),
  overflow = the part beyond the frame-floored free space, counted in bytes and one chunk per
  overflowing ingest; then `release()`.
- `release()`: while ring non-empty and no gating branch congested, copy up to
  `ABSORBER_RELEASE_BYTES` (frame-floored; a lone partial frame stays) into `Buffer.allocUnsafe`,
  advance head, `distribute`. Triggered by `ingest` and by fanout `drain`, `branch-added`,
  `branch-removed`. No timers.
- Gating set = `activeBranchIds` minus excluded laggards. `congestedSinceMono` per branch from
  `backpressure`/`drain` events and reads; `siblingProgressMono` = last time another gating branch was
  seen uncongested. A branch congested for at least `ABSORBER_LAGGARD_MS` with sibling progress since
  it congested joins the excluded set; it leaves on its `drain`. With one active branch nothing is
  excluded.
- Overflow episodes log one info line at start and one at end with fixed fields
  `{ overflowBytes, overflowChunks, durationMs }` (8.3).
- `counters().window` covers the last sixty `LINK_QUALITY_SLOT_MS` slots, rotated lazily by
  `monoNow()` on each event (preallocated `Float64Array(60)` per field).
- Latency proxy (requirement 9.2, A16): a holding episode starts when the ring goes from empty to
  non-empty and ends when it is empty again (or is flushed); `window.peakHeldMs` is the longest
  episode duration (an open episode counts up to `monoNow()`). `window.maxLaggardExcludeMs` is the
  longest time from a branch's `congestedSinceMono` to its exclusion (null when no branch was
  excluded in the window). Both are kept per slot in the same preallocated arrays.
- `dispose()` removes fanout listeners and frees the ring.

- [ ] **Step 1: Write the failing tests**

`absorber.property.test.ts` (each with the trace comment; frames 2 and 4; chunk lengths 1..70 000
including odd; consumer schedules as arrays of `congest(id) | drain(id) | ingest(len)`):

```ts
// Feature: link-burst-resilience, Property 2: Pass-through identity (absorber half)
// Validates: Requirements 1.3
// capacity 0, or ring empty and no gating branch congested: delivered[i] === ingested[i] (same object) in the same tick

// Feature: link-burst-resilience, Property 3: Byte conservation and order
// Validates: Requirements 1.4, 1.6, 1.8
// concat(delivered) == concat(ingested) minus exactly the overflowed and flushed ranges, in order;
// every overflowed range is a chunk tail that arrived while the ring was full;
// every released (non-pass-through) chunk length % frameBytes === 0 — numRuns 200

// Feature: link-burst-resilience, Property 4: Chunk-split invariance
// Validates: Requirements 1.4
// same byte stream, two splittings with the same per-byte arrival times and schedule →
// equal delivered bytes, overflow bytes and final counters — numRuns 200

// Feature: link-burst-resilience, Property 5: Within capacity, no loss
// Validates: Requirements 1.4, 9.1
// held never exceeds capacity and consumers drain between bursts → overflowBytesTotal === 0 and the
// fake fanout's per-branch drop counters stay 0

// Feature: link-burst-resilience, Property 6: Laggard bound
// Validates: Requirements 1.5, 9.2
// one branch stuck, a sibling progressing: stuck excluded no later than ABSORBER_LAGGARD_MS + one ingest
// after it congested; afterwards the sibling receives every byte with no extra delay beyond the
// release of what was held; a single active branch is never excluded
```

`absorber.test.ts`: `holding absorber releases once a startup branch drained` (fake port reports
uncongested on next read with no `drain` event; the next `ingest` releases);
`flush counts flushedBytes and is not overflow`; `configure(0) frees and passes through`;
`peakHeldMs measures the longest holding episode` (scripted congest at t, drain at t + 300 ms →
`window.peakHeldMs === 300`); `maxLaggardExcludeMs records congested-to-excluded time` (one stuck
branch, sibling progressing → value in `[ABSORBER_LAGGARD_MS, ABSORBER_LAGGARD_MS + one ingest interval]`;
no exclusion → null);
`overflow episode logs start and end once`; `window counters forget slots older than 10 min`;
`steady-state pass-through allocates nothing` (spy on `Buffer.allocUnsafe` stays uncalled over 1 000
pass-through ingests).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/link-burst/absorber.test.ts tests/unit/core/link-burst/absorber.property.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `createBurstAbsorber`** in `src/core/link-burst/absorber.ts`. The ring is a
      head/length byte ring; appends that wrap use two `Buffer.copy` calls.

- [ ] **Step 4: Verify** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): per-source burst absorber ring" -- src/core/link-burst/absorber.ts tests/unit/core/link-burst/absorber.test.ts tests/unit/core/link-burst/absorber.property.test.ts tests/unit/core/link-burst/fake-fanout.ts
```

### Task AB.3: Router wiring and the `@absorber` counter

**Files:**

- Modify: `src/core/source-fanout-router.ts` (constructor opts, `connected`/`disconnected`/`removed`,
  `getFanout`, `branchDropCounters`, `destroy`)
- Test: `tests/unit/core/source-fanout-router-link-burst.test.ts`

**Interfaces:**

- Consumes: `FanoutManager.attachIngest/isBranchActive` (AB.1), `createBurstAbsorber` shape via
  `LinkBurstFactories` (0.1), `isLoopbackHost` (`src/core/link-advisory.ts`), `frameBytesFor`,
  `resolveAbsorberSeconds`, `ABSORBER_COUNTER_PREFIX`.
- Produces:
  - Constructor `opts` gains `linkBurst?: LinkBurstFactories`. Absent: wiring is exactly today's.
  - `linkBurst(sourceId: string): LinkBurstHandles | null` (null for non-IQ or unknown sources).
  - `branchDropCounters(id)` values gain `active: boolean`; when the source has an absorber the map
    also holds `"@absorber#<instance>"` → `{ droppedBytesTotal: overflowBytesTotal, droppedChunksTotal: overflowChunksTotal, active: true }`,
    with a fresh `<instance>` from `branchInstance` per created absorber.
  - Branch ids starting with `@` are refused: a `branch-added` with such an id logs one warning and
    is removed again (`FanoutManager.removeBranch(id)`, `fanout-manager.ts:252`), so it never reaches the counters.

Wiring rules (requirement 1.1, 1.2, 1.8, 1.9; research finding [1]):

- On `connected` (and the constructor replay and `getFanout` lazy attach) through one private
  `wire(sourceId, fanout, stream)`: decide transport per A1/A2. IQ source: create (once per source) and
  `configure(caps.sampleRate, frameBytes)` the recorder; add `stream.on("data", recorderListener)`
  before the fanout listener. Capacity = `resolveAbsorberSeconds(config.burstAbsorber?.seconds, transport) × sampleRate × frameBytes`;
  above 0 → create (once) or reuse the absorber, `configure(capacity)`, `fanout.attachIngest(stream, absorber.ingest)`;
  otherwise `fanout.attachSource(stream)` exactly as today.
- New `sources.on("caps-changed", ...)`: if rate or format changed → `absorber.flush("rate")`,
  recompute frame and capacity, `configure`; `recorder.configure`. Removed in `destroy()`.
- `disconnected`: `absorber.flush("disconnect")`, `recorder.resetArrival()`, remove the recorder
  listener, then today's detach. `removed`: `flush("removed")`, same, plus today's `releaseUnused`.
- `source-removed` and `destroy()`: `absorber.dispose()`, drop the handles.
- SourceManager's own `data` event and other taps are untouched (1.9).

- [ ] **Step 1: Write the failing tests** (fake `SourceManager` built on `EventEmitter` with
      `getStream`, `getCaps`, `getConfig`, `getStatus`, `getAllStatus`; fake factories recording calls):

```ts
// Feature: link-burst-resilience, Property 2: Pass-through identity (router half)
// Validates: Requirements 1.1, 1.3
// loopback host, recording, audio format, or seconds 0 → fanout fed by attachSource; each chunk reaches
// the branch as the same Buffer in the same tick; no absorber created
it("network IQ source gets one absorber sized seconds × rate × frame", ...) // 2 s × 2_048_000 × 2
it("caps-changed flushes and resizes", ...)
it("disconnect while holding flushes and resets arrival", ...)
it("counter map marks inactive branches", ...) // deferred branch → active: false
it("@absorber key carries overflow totals and a fresh instance per absorber", ...)
it("a branch id starting with @ is refused", ...)
it("other data taps see chunks while the absorber holds", ...) // sources.on("data") listener gets every chunk synchronously
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/source-fanout-router-link-burst.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the router changes.**

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run tests/unit/core/source-fanout-router-link-burst.test.ts tests/unit/core/source-fanout-router-telemetry.test.ts tests/unit/core/source-fanout-router-dedicated.test.ts tests/unit/core/fanout-manager.test.ts`
Expected: PASS; existing router tests unchanged (no `linkBurst` option there).

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): wire recorder and absorber per network IQ source" -- src/core/source-fanout-router.ts tests/unit/core/source-fanout-router-link-burst.test.ts
```

---

## Lane IR: instrumentation and reporting

### Task IR.1: IngestRecorder and EventLoopMeter

**Files:**

- Create: `src/core/link-burst/recorder.ts`, `src/core/link-burst/loop-meter.ts`
- Test: `tests/unit/core/link-burst/recorder.test.ts`, `tests/unit/core/link-burst/recorder.property.test.ts`, `tests/unit/core/link-burst/loop-meter.test.ts`

**Interfaces:**

- Consumes: `IngestRecorder`, `IngestInterval`, `IngestWindowStats`, `EventLoopMeter`,
  `LINK_GAP_MS`, `CATCHUP_WINDOW_MS`, `LINK_QUALITY_*`, `LOOP_METER_RESOLUTION_MS` (0.1).
- Produces: `createIngestRecorder(): IngestRecorder`;
  `createEventLoopMeter(deps?: { histogram?: { max: number; percentile(p: number): number; count: number; reset(): void; enable(): void; disable(): void }; monoNow?: () => number }): EventLoopMeter`
  (default `monitorEventLoopDelay({ resolution: 10 })`; ns → ms; `takeInterval()` returns null when
  `count === 0`, then resets, and pushes each non-null interval with its `monoNow()` stamp into a
  preallocated `LOOP_DELAY_RING`-entry ring; `report(nowMono)` reads only that ring: `last` is the
  newest entry, `maxMs10m`/`p99MaxMs10m` are maxima over entries within `LINK_QUALITY_WINDOW_MS`,
  `intervals10m` their count; it never calls `reset()` on the histogram, A15).

Recorder layout (design "IngestRecorder", A12), all preallocated at construction:

- Gap histogram: `GAP_BUCKETS` (48) geometric buckets, ratio 1.25 from 1 ms (`bucket = gap < 1 ? 0 : min(47, 1 + floor(ln(gap)/ln(1.25)))`), per 10 s slot: `Uint32Array(60 × 48)`; worst gap `Float64Array(60)`; catch-up bytes `Float64Array(60)`; chunk count `Float64Array(60)`; chunk sizes `CHUNK_SIZE_BUCKETS` (16) log2 buckets `Uint32Array(60 × 16)`; catch-up bytes per closed catch-up window in `CATCHUP_BUCKETS` (16) log2 buckets from `CATCHUP_BUCKET_BASE_BYTES` `Uint32Array(60 × 16)`; slot stamps `Float64Array(60)`.
- `histograms(now)`: sums the in-window slots into fresh arrays with the bucket upper edges (A15);
  it is a reporting read and the only recorder method allowed to allocate.
- Burst seconds: `Float64Array(600)` second stamps; a second is marked when a gap of at least
  `LINK_GAP_MS` ends in it or `noteHolding` is called in it.
- Interval cells: 64 × 250 ms max-gap cells with stamps.
- Catch-up: when a gap ≥ `LINK_GAP_MS` ends, open a window of `CATCHUP_WINDOW_MS`; at close (first
  chunk after it, or `window()`/`interval()` read), add `max(0, bytes − rate × frame × elapsed / 1000)`.
- `resetArrival()` forgets the previous arrival time (no gap is recorded across it).
- `configure(rate, frame)` keeps history, resets arrival and any open catch-up window.
- `window(now)`: slots older than `LINK_QUALITY_WINDOW_MS` excluded; `gapP99Ms` is the upper edge of
  the bucket holding the 99th percentile; null fields when no gap was recorded.

- [ ] **Step 1: Write the failing tests**

```ts
// Feature: link-burst-resilience, Property 12: Report bounds (recorder half)
// Validates: Requirements 2.1, 6.3
// any arrival sequence (times monotonic, sizes 1..70000, spanning up to 20 min): window() covers only
// the last sixty slots; worstStallMs equals the largest gap ended in them; gapP99Ms lies within one
// bucket (×1.25) of the exact p99 of those gaps; burstSeconds equals the count of distinct seconds in
// the window with a gap ≥ LINK_GAP_MS ending or a noteHolding call
```

`recorder.test.ts`: `resetArrival breaks the gap chain`; `catch-up counts bytes above nominal after a
long gap`; `interval returns the largest gap ended in range`; `observeChunk allocates nothing` (after a
warm-up, 10 000 `observeChunk` calls grow `process.memoryUsage().heapUsed` by less than 64 KiB).
`histograms sums in-window slots and matches window()` (gap counts total equals the number of gaps
recorded in the window; a slot older than 10 min is excluded; catch-up counts one per closed burst).
`loop-meter.test.ts`: fake histogram returns
`max 30e6`, `p99 12e6` → `{ maxMs: 30, p99Ms: 12 }`, reset called; `count 0` → null;
`report never resets the histogram` (spy: `reset` call count unchanged by `report()`; `report().last`
equals the last `takeInterval()` result; entries older than 10 min leave `maxMs10m`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/link-burst/recorder.test.ts tests/unit/core/link-burst/recorder.property.test.ts tests/unit/core/link-burst/loop-meter.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both modules.**

- [ ] **Step 4: Verify** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): ingest recorder and event-loop meter" -- src/core/link-burst/recorder.ts src/core/link-burst/loop-meter.ts tests/unit/core/link-burst/recorder.test.ts tests/unit/core/link-burst/recorder.property.test.ts tests/unit/core/link-burst/loop-meter.test.ts
```

### Task IR.2: SDR host link facts and `iqDelivery` in the poller

**Files:**

- Modify: `src/core/sdr-host-poller.ts:272-340` (poll), status mapping (~L480-520)
- Test: `tests/unit/core/sdr-host-poller-link.test.ts`

**Interfaces:**

- Consumes: `SdrHostLinkFacts` (0.1); `SdrHostTelemetry` shape from `packages/api-types/src/sdr-host.ts`
  (only the fields in A10).
- Produces: `SdrHostPoller.getLinkFacts(sourceId: string): SdrHostLinkFacts | null`;
  `SdrHostStatus.iqDelivery` filled from `/api/status` `iqDelivery.modes` when it parses as
  `z.object({ modes: z.array(z.enum(["raw", "channels"])).max(2) })`, else `null`.

Each poll also fetches `${apiUrl}/api/host` with the same timeout and fetch function; parse with a Zod
schema that keeps only `network.state/value[].{kind, defaultRouteMetric, wireless.signalDbm}` and
`power.{undervoltageNow, throttling}` `{state, value}` (`.passthrough()` is not used; unknown keys are
stripped). A failed or invalid `/api/host` leaves link facts null and never marks the status
unavailable.

- [ ] **Step 1: Write the failing tests** (`fetchFn` fake keyed by URL):
      `default-route wireless interface yields kind and signal`; `stale undervoltage reading is null`;
      `throttling unavailable is null`; `/api/host failure keeps status available`;
      `addresses and names are never retained` (serialize `getLinkFacts` output; no `"192.168."`, no
      interface name); `iqDelivery modes parse; invalid → null`. The response schema that keeps
      `iqDelivery` through Fastify serialization is IR.3 (it owns `src/api/routes/resources.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/sdr-host-poller-link.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run tests/unit/core/sdr-host-poller-link.test.ts tests/unit/core/sdr-host-poller.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(sdr-host-poller): receiver link facts and advertised IQ delivery" -- src/core/sdr-host-poller.ts tests/unit/core/sdr-host-poller-link.test.ts
```

### Task IR.3: LinkQuality, the route and the WebSocket event

**Files:**

- Create: `src/core/link-burst/link-quality.ts`
- Modify: `src/core/resource-aggregator.ts` (components, tick), `src/api/routes/resources.ts`
  (two routes and JSON schemas; `sdrHostStatusSchema` gains `iqDelivery`), `src/api/websocket/events.ts`
  (event type, `broadcastLinkQuality`), `src/api/server.ts:~895` (forward the aggregator's
  `link-quality` event)
- Test: `tests/unit/core/link-burst/link-quality.test.ts`, `tests/unit/core/link-burst/link-quality.property.test.ts`,
  `tests/unit/api/resources-link-quality.test.ts`, `tests/unit/api/resources-sdr-host.test.ts` (extend)

**Interfaces:**

- Consumes: `LinkBurstHandles`, `SdrHostLinkFacts`, `LoopDelayReport`, DTOs (0.1);
  `IngestRecorder.window`/`histograms`, `BurstAbsorber.counters` (by interface).
- Produces:

```ts
export interface LinkQualityDeps {
	sources: () => readonly string[]
	handles: (id: string) => LinkBurstHandles | null
	attribution: (
		id: string,
	) => {
		last: DropAttribution | null
		counts10m: Record<DropAttribution, number>
	} | null
	upstreamDropRate: (id: string) => number | null
	receiver: (id: string) => SdrHostLinkFacts | null
	loopDelay?: () => LoopDelayReport | null
	monoNow: () => number
	now: () => number // wall clock, for `at`
}
export interface LinkQuality {
	all(): SourceLinkQuality[]
	one(sourceId: string): SourceLinkQuality | null
	burst(sourceId: string): LinkBurstSummary | null // null for loopback or no recorder
}
export function createLinkQuality(deps: LinkQualityDeps): LinkQuality
```

`ResourceAggregator` components gain `linkQuality?: Pick<LinkQuality, "all" | "one"> | null`;
`getLinkQuality(): SourceLinkQuality[]`, `getLinkQualityFor(id): SourceLinkQuality | null`; the
broadcast tick also emits `"link-quality"` with `all()` when the component is present.
Routes: `GET /api/resources/link-quality` → `SourceLinkQuality[]`;
`GET /api/resources/link-quality/:sourceId` → one, or 404
`{ error: "NotFound", code: "LINK_QUALITY_NOT_FOUND", message: "No link-quality report for this source" }`.
WS: `"resources:link-quality"` on the `resources` channel.

Rules: only sources with a handle (IQ) are reported. No absorber → `absorber.enabled: false` and zeros
(`laggardExcludeMsMax10m: null`). `absorber.peakHeldMs10m`/`laggardExcludeMsMax10m` map
`counters().window.peakHeldMs`/`maxLaggardExcludeMs`. `histograms` is `recorder.histograms(monoNow())`
with `windowMs: LINK_QUALITY_WINDOW_MS` (omitted when the recorder throws); `loopDelay` is
`deps.loopDelay?.()` (null when absent or throwing). The JSON schemas for both routes declare
`histograms` (six number arrays plus `windowMs`) and `loopDelay` (`last` object or null, three
numbers or nulls) so Fastify serialization keeps them.
`sdrHostStatusSchema` gains `iqDelivery: { type: ["object", "null"], properties: { modes: { type: "array", items: { type: "string", enum: ["raw", "channels"] } } } }`
(requirement 8.1: without it fast-json-stringify strips the field).
`receiver` is null when `receiver(id)` is null or every field is null. Throwing deps degrade the field
to null or zero; `all()` never throws.

- [ ] **Step 1: Write the failing tests**

```ts
// Feature: link-burst-resilience, Property 11: Overflow is drop evidence (report half)
// Validates: Requirements 1.6, 6.2
// any absorber counters: report.absorber.overflowBytesTotal === counters.overflowBytesTotal and
// overflowBytes10m === counters.window.overflowBytes

// Feature: link-burst-resilience, Property 12: Report bounds (report half)
// Validates: Requirements 6.2, 6.5
// for arbitrary deps outputs, including receiver facts built from strings: every string in
// JSON.stringify(report) is the source id, an ISO `at`, a key name, or a member of the closed enums
```

`resources-link-quality.test.ts` (Fastify `inject`, fake aggregator): list and single routes match
schema; `404 does not echo the source id` (request `/api/resources/link-quality/evil%3Chost%3E`; body
contains no `evil`); WS broadcaster sends `resources:link-quality` frames on `broadcastLinkQuality`;
`histograms and loopDelay survive serialization` (fake report with both blocks → response body
deep-equals it). `link-quality.test.ts`: `report carries histograms and loopDelay from deps`;
`loopDelay null when the dep throws`. `resources-sdr-host.test.ts` (extend): a fake status with
`iqDelivery: { modes: ["raw"] }` is returned unchanged by `GET /api/resources/sdr-hosts` and the
single-host route; `iqDelivery: null` stays null.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/link-burst/link-quality.test.ts tests/unit/core/link-burst/link-quality.property.test.ts tests/unit/api/resources-link-quality.test.ts tests/unit/api/resources-sdr-host.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: the three files plus `tests/unit/api/resources-sdr-host.test.ts tests/unit/core/resource-aggregator-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): per-source link-quality report, route and event" -- src/core/link-burst/link-quality.ts src/core/resource-aggregator.ts src/api/routes/resources.ts src/api/websocket/events.ts src/api/server.ts tests/unit/core/link-burst/link-quality.test.ts tests/unit/core/link-burst/link-quality.property.test.ts tests/unit/api/resources-link-quality.test.ts tests/unit/api/resources-sdr-host.test.ts
```

### Task IR.4: Link advisory: shortfall, link hold, burst summary

**Files:**

- Modify: `src/core/link-advisory.ts`, `src/core/rate-policy-contract.ts` (the `LinkAdvisor` interface only),
  `src/core/link-burst/link-quality.ts` (advisory re-check), `src/core/resource-aggregator.ts` (call it per tick)
- Test: `tests/unit/core/link-advisory-burst.property.test.ts`, `tests/unit/core/link-burst/link-quality-recheck.test.ts`

**Interfaces:**

- Consumes: `LINK_DROPPING_HOLD_MS`, `LinkBurstSummary` (0.1).
- Produces:
  - `LinkAdvisor.shortfall(sourceId: string, sampleRateHz: number, frameBytes: number): boolean | null`
    (null until the 10 s window is full or when the rate differs; true when the time-weighted received
    average is below `rate × frameBytes × (1 − LINK_SHORTFALL_PERCENT/100)`, A11).
  - `createLinkAdvisor(deps: { now: () => number; monoNow?: () => number; linkDropsSince?: (sourceId: string, sinceMono: number) => boolean; burst?: (sourceId: string) => LinkBurstSummary | null })`.
    `classify`: a network source becomes `dropping` when `linkDropsSince(id, monoNow() − LINK_DROPPING_HOLD_MS)`
    is true; loopback stays `none`; attaches `burst` when `burst(id)` is non-null and the source is
    network. Throwing deps are treated as absent.
  - Advisory re-check (A9; the link hold must reach the alert within `LINK_DROPPING_HOLD_MS` without
    waiting for a rate change): `LinkQualityDeps` gains optional
    `advisory?: (id: string) => LinkAdvisory | null` and
    `reportAdvisory?: (id: string, advisory: LinkAdvisory) => void`; `LinkQuality` gains
    `recheckAdvisories(): void`, which for every network source with a handle calls `advisory(id)` and,
    when the level differs from the last level it saw for that source, records it and calls
    `reportAdvisory(id, advisory)` (a `none` level is recorded but not reported). Throwing deps are
    skipped for that source. `ResourceAggregator`'s `linkQuality` component type widens to
    `Pick<LinkQuality, "all" | "one" | "recheckAdvisories">` (optional member) and its broadcast tick
    calls `recheckAdvisories()` before emitting `link-quality`. Main wires `advisory` and
    `reportAdvisory` in M.1.

- [ ] **Step 1: Write the failing tests**

`link-quality-recheck.test.ts`: `link hold raises dropping on the next tick` (fake `advisory` returns
`dropping` from a given mono → `reportAdvisory` called once within one recheck, not again while the
level holds; back to `none` then `dropping` reports again); `loopback sources are never re-checked`;
`a throwing advisory skips only that source`; `aggregator tick calls recheckAdvisories` (fake
component, `broadcastIntervalMs` 2 000 with fake timers).

```ts
// Feature: link-burst-resilience, Property 13: Advisory
// Validates: Requirements 6.4, 6.6
// loopback host → level "none" for any deps; network + linkDropsSince true → "dropping";
// burst summaries with overflowedBytes10m 0 never change the level computed without them
```

Plus `shortfall null before a full window, true below 99 %`, `S16 payload uses frame 4`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/link-advisory-burst.property.test.ts tests/unit/core/link-burst/link-quality-recheck.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest run tests/unit/core/link-advisory-burst.property.test.ts tests/unit/core/link-burst/link-quality-recheck.test.ts tests/unit/core/link-burst/link-quality.test.ts tests/unit/core/link-advisory.test.ts tests/unit/core/link-advisory.property.test.ts tests/unit/core/rate-policy-link-recheck.test.ts tests/unit/core/resource-aggregator-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-advisory): link-hold dropping, shortfall query, burst summary and periodic re-check" -- src/core/link-advisory.ts src/core/rate-policy-contract.ts src/core/link-burst/link-quality.ts src/core/resource-aggregator.ts tests/unit/core/link-advisory-burst.property.test.ts tests/unit/core/link-burst/link-quality-recheck.test.ts
```

---

## Lane AG: attribution and gate

### Task AG.1: `attributeInterval`

**Files:**

- Create: `src/decoders/enablement/attribution.ts`
- Test: `tests/unit/decoders/enablement/attribution.property.test.ts`

**Interfaces:**

- Consumes: `DropAttribution` (api-types), `LINK_GAP_MS`, `HOST_LOOP_DELAY_MS` (0.1).
- Produces: `IntervalEvidence` (exactly the design's fields) and
  `attributeInterval(e: IntervalEvidence): DropAttribution`.

Rule order (design "Attribution", A5): `!complete` → `unknown`; no positive value in `branchDrops`
and `absorberOverflow` not above 0 → `none`; some but not all branches rose and overflow not above 0
→ `consumer`; `upstreamDropDelta > 0` → `unknown`; `maxGapMs`, `loopDelayMaxMs`, `shortfall` all
non-null, `maxGapMs − loopDelayMaxMs >= LINK_GAP_MS`, `shortfall === false` → `link`;
`loopDelayMaxMs >= HOST_LOOP_DELAY_MS` or `cpuPercent >= cpuGuardPercent` → `host`; else `unknown`.
An empty `branchDrops` with overflow above 0 counts as "every branch". Non-finite or negative numbers
are treated as null (fail closed).

- [ ] **Step 1: Write the failing test**

```ts
// Feature: link-burst-resilience, Property 7: Attribution rules
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
// total and deterministic (same input twice → same output, never throws, always a member of the union);
// complete false → "unknown"; strict non-empty subset rose and overflow ≤ 0 → "consumer";
// result "link" ⇒ every branch rose or overflow > 0, maxGap − loop ≥ LINK_GAP_MS, shortfall === false,
//   upstream null or 0; upstream > 0 with drops → never "link"; any null among gap, loop, shortfall →
//   never "link"; no positive delta → "none"
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/decoders/enablement/attribution.property.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(enablement): pure drop attribution" -- src/decoders/enablement/attribution.ts tests/unit/decoders/enablement/attribution.property.test.ts
```

### Task AG.2: EfficiencyMonitor attribution, link path and late windows

**Files:**

- Modify: `src/decoders/enablement/efficiency-monitor.ts`, `src/decoders/enablement/efficiency-gate.ts`
  (only the `DropReader` interface additions below), `src/core/source-backpressure-tracker.ts`
- Test: `tests/unit/decoders/enablement/efficiency-monitor-attribution.test.ts`,
  `tests/unit/decoders/enablement/efficiency-monitor-attribution.property.test.ts`,
  `tests/unit/core/source-backpressure-tracker-totals.test.ts`

**Interfaces:**

- Consumes: `attributeInterval` (AG.1), `IngestInterval`, `LoopDelayInterval`, `LATE_SHED_WINDOWS`,
  `LateDropWindow`, `EFFICIENCY_DROP_WINDOW_MS`.
- Produces:
  - `createEfficiencyMonitor` deps gain (all optional; absent → the evidence is null):
    `ingest?: (id: string, fromMono: number, toMono: number) => IngestInterval | null`,
    `loopDelay?: () => LoopDelayInterval | null`, `shortfall?: (id: string) => boolean | null`,
    `upstreamDroppedTotal?: (id: string) => number | null`, `cpuGuardPercent?: number`
    (default `EFFICIENCY_CPU_GUARD_PERCENT`), `log?: Logger`.
  - `branchCounters` values accept optional `active?: boolean`.
  - `DropReader` gains optional `latestAttribution?(id: string): DropAttribution | null`,
    `lateWindows?(id: string): readonly LateDropWindow[]`,
    `linkDropsSince?(id: string, sinceMono: number): boolean`.
  - Monitor also returns `attributionCounts(id: string): { last: DropAttribution | null; counts10m: Record<DropAttribution, number> } | null`.
  - `SourceBackpressureTracker.upstreamDroppedTotal(id: string): number | null` and
    `peekDropRate(id: string): number | null` (no `recordDrops`, no history mutation).

Monitor changes (design "EfficiencyMonitor and EfficiencyGate changes", research finding [2]):

- Read `loopDelay()` and CPU once per `sampleNow`, before the source loop.
- Per source, compute per-key deltas into a reused `Map`; keys starting with `@` feed
  `absorberOverflow` (null when no such key); keys with `active === false` are left out of
  `branchDrops`. The existing summed `bytes`/`chunks` still include every key (overflow is drop
  evidence, 1.6).
- Raw clock values of this and the two previous samples are kept per source; `ingest(id, rawPrevPrev, rawNow)`
  supplies `maxGapMs` (this or the previous interval). Any discontinuity clears them (4.6).
- `upstreamDropDelta` from consecutive `upstreamDroppedTotal` values; a decrease or a null → null.
- `complete` passed to `attributeInterval` is the existing `comparable`.
- Third path: when the attribution is `link` and the sample has positive drops → no coverage push, no
  `fault()`, no `lastDropMono`, no `drops[]` push, `cleanSinceMono` untouched. Every other attribution
  keeps today's branches exactly. `SourceDropSample.attribution` is always set.
- Windows: per source, consecutive `EFFICIENCY_DROP_WINDOW_MS` windows from the first sample; a sample
  at or past the open window's end closes it; a window condemns when a sample in it had positive drops
  attributed `consumer` or `host`; a window that does not condemn but had positive drops attributed
  `link` or `unknown` sets `linkOrUnknownDrops: true` (0.1). Keep the last `LATE_SHED_WINDOWS` closed
  windows; a discontinuity clears them.
- Link drops: a 32-entry ring of link-with-drops sample times for `linkDropsSince`.
- Attribution counts: a 300-entry ring (10 min of 2 s samples) of `(mono, code)`.
- Logging (3.8, 8.3): one info line `{ sourceId, attribution, dropBytes, gapMs, loopDelayMs, cpuPercent }`
  "Drop interval attributed" per attributed interval with drops, at most one per minute per
  `(source, attribution)`; one info line "Drop attribution changed" `{ sourceId, from, to }` when the
  latest non-`none` attribution changes.

- [ ] **Step 1: Write the failing tests** (fake counters/ingest/loop/shortfall/upstream deps; injected
      `monoNow` and manual `sampleNow()`):

```ts
// Feature: link-burst-resilience, Property 8: Link neither condemns nor credits (monitor half)
// Validates: Requirements 4.1, 4.2, 4.3
// any sample sequence: droppedSinceMono / droppedBetweenMono are true only for samples whose
// attribution is not "link"; coveredSinceMono never grows across a link sample's interval

// Feature: link-burst-resilience, Property 9: Clean window (monitor half)
// Validates: Requirements 4.4
// cleanAtMono is unchanged by link drop samples and reset by every other positive drop

// Feature: link-burst-resilience, Property 11: Overflow is drop evidence (monitor half)
// Validates: Requirements 1.6
// replacing an all-branch drop by an equal @absorber overflow with the same attribution evidence yields
// the same dropState sequence and the same droppedSinceMono answers (A4)
```

`efficiency-monitor-attribution.test.ts`: `inactive branch does not make a burst a strict subset`;
`upstream decrease yields unknown not link`; `discontinuity discards the ingest window` (raw clock goes
back → next sample cannot be `link`); `late windows condemn only on consumer or host` (and a link- or unknown-only window has
`linkOrUnknownDrops: true`, `condemning: false`);
`attribution log is rate-limited per minute`. `source-backpressure-tracker-totals.test.ts`: the two new
reads return the same values as `getBackpressure` without changing its later `dropRate`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/decoders/enablement/efficiency-monitor-attribution.test.ts tests/unit/decoders/enablement/efficiency-monitor-attribution.property.test.ts tests/unit/core/source-backpressure-tracker-totals.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: the three files plus `tests/unit/decoders/enablement/efficiency-monitor.test.ts tests/unit/decoders/enablement/efficiency-earned.property.test.ts`
Expected: PASS; existing monitor tests unchanged.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(enablement): attribute drop intervals; link drops neither condemn nor credit" -- src/decoders/enablement/efficiency-monitor.ts src/decoders/enablement/efficiency-gate.ts src/core/source-backpressure-tracker.ts tests/unit/decoders/enablement/efficiency-monitor-attribution.test.ts tests/unit/decoders/enablement/efficiency-monitor-attribution.property.test.ts tests/unit/core/source-backpressure-tracker-totals.test.ts
```

### Task AG.3: Gate: link admission wait and late shedding

**Files:**

- Modify: `src/decoders/enablement/efficiency-gate.ts` (`admit`, `probation`, `view`, deps gain `log?: Logger`)
- Test: `tests/unit/decoders/enablement/efficiency-gate-late.property.test.ts`, `tests/unit/decoders/enablement/efficiency-gate-link.test.ts`

**Interfaces:**

- Consumes: `DropReader.latestAttribution/lateWindows` (AG.2); `LATE_SHED_*`, `RunningPlacement.mode/startMode` (0.1).
- Produces: `probation()` may return `{ key, detail: "late-drops" }`; `view()` source entries carry
  `attribution` (from `latestAttribution`) and `lateDrops` (`cooldownUntil` as an ISO string of the
  monotonic value, rebased by the manager like `retryAt`; `held` as below).
  `createEfficiencyGate(inputs, deps: { drops?: DropReader; log?: Logger })`; Main passes a component
  logger in M.1 (`src/index.ts:498`).

Rules (requirements 4.5, 5.1–5.5; A8):

- `admit`: after the retry check, if `latestAttribution(sourceId) === "link"` → `{ admit: false, detail: "unknown", retryAtMs: now + EFFICIENCY_SAMPLE_MS }` (no backoff recorded).
- `probation`: unchanged for sources with a probationer (they also set `lateSince[source] = mono`).
  For a source with running placements and none on probation, when `mono >= cooldownUntil[source]`:
  take `lateWindows(source)` with `startMono >= lateSince[source]`, last `LATE_SHED_WINDOWS`; when at
  least `LATE_SHED_HITS` condemn, pick the running placement on that source with the largest admitted
  mark among `graduated && mode !== undefined && mode !== "always" && startMode === "auto"`; if found:
  `failures.add(key)`, verdict `late-drops`, `cooldownUntil = mono + LATE_SHED_COOLDOWN_MS`,
  `lateSince = mono`. If none is eligible, no verdict.
- Held state and warning (requirement 5.5; decoder-enablement 4.4 as amended): for a source with no
  probationer, `held` is `"nothing-sheddable"` when at least `LATE_SHED_HITS` of the eligible windows
  condemn but no placement is eligible, else `"link-or-unknown"` when fewer than `LATE_SHED_HITS`
  condemn but at least `LATE_SHED_HITS` of them have `condemning || linkOrUnknownDrops`, else null.
  While `held` is non-null the gate logs one warn line "Late drops not shed"
  `{ sourceId, reason: held, condemningWindows, windows }` at most once per 60 000 ms (monotonic) per
  `(sourceId, reason)`, and `view()` shows `held`. No `log` → no line; behaviour is otherwise identical.
- `noteSuspended(key, "late-drops", now)` uses the existing doubling path unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// Feature: link-burst-resilience, Property 8: Link neither condemns nor credits (gate half)
// Validates: Requirements 4.1, 4.2, 4.3
// fake DropReader scripted per sample: a probationer is never suspended for drops seen only in link
// samples; drops in consumer, host or unknown samples suspend the newest probationer as before

// Feature: link-burst-resilience, Property 9: Clean window (gate half)
// Validates: Requirements 4.5
// admit never returns admit:true while latestAttribution is "link"; the refusal has detail "unknown"
// and records no retry

// Feature: link-burst-resilience, Property 10: Late shed
// Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5
// no probationer: a shed happens exactly when ≥ 2 of the last 3 eligible windows condemn; it picks the
// most recently admitted eligible placement; never mode "always", startMode "operator" or missing mode;
// never for windows whose drops were only link or unknown; at most one per LATE_SHED_COOLDOWN_MS;
// successive noteSuspended(key, "late-drops") retry delays are 300 000, 600 000, ... capped at 1 800 000
```

`efficiency-gate-link.test.ts`: `view carries attribution and lateDrops`; `probation still judges
newest probationer while another source late-sheds`; `nothing sheddable warns once per minute`
(condemning windows, only YAML/`always`/operator placements → no verdict, `held: "nothing-sheddable"`,
fake logger gets one warn per 60 s of monotonic time across many `probation()` calls);
`link or unknown late drops warn and never shed` (windows with `linkOrUnknownDrops` only →
`held: "link-or-unknown"`, one warn per minute, no verdict); `no warning without a logger or when not held`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/decoders/enablement/efficiency-gate-late.property.test.ts tests/unit/decoders/enablement/efficiency-gate-link.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: the two files plus `tests/unit/decoders/enablement/efficiency-gate.test.ts tests/unit/decoders/enablement/efficiency-gate.property.test.ts tests/unit/decoders/enablement/efficiency-earned.property.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(enablement): link-aware admission and late-drop shedding" -- src/decoders/enablement/efficiency-gate.ts tests/unit/decoders/enablement/efficiency-gate-late.property.test.ts tests/unit/decoders/enablement/efficiency-gate-link.test.ts
```

### Task AG.4: Manager and efficiency schemas

**Files:**

- Modify: `src/decoders/manager.ts:247,677-700,700-745,812-880`, `src/api/routes/decoder-status-schemas.ts:27`,
  `src/api/routes/decoders.ts:426`
- Test: `tests/unit/decoders/enablement/manager-late-shed.test.ts`, `tests/unit/api/decoders-efficiency-route.test.ts` (extend)

**Interfaces:**

- Consumes: gate verdict `late-drops` (AG.3).
- Produces: `runningPlacements()` entries carry `mode: this.modeFor(owner).mode` and
  `startMode: owner.startMode`, where `owner` is `this.decoders.get(state.parentId)` for channel
  placements, else `state`. `DecoderState` gains `efficiencyLateShed?: boolean`.

Rules: a `late-drops` verdict sets `state.efficiencyLateShed = true` before the existing suspension
path; the post-probation backoff reset (`delete state.efficiencyBackoffMs`, ~L826-833) skips states
with `efficiencyLateShed`, so `efficiencyBackoffMs` doubles on each further shed or probation failure
up to `EFFICIENCY_RETRY_MAX_MS`. Each late shed logs one warn line
`{ reasonCode: "efficiency-budget", detail: "late-drops", sourceId, decoderId }` "Late drops shed a
decoder". `efficiencyView()` rebases `lateDrops.cooldownUntil` exactly as it rebases `retryAt`.
Schemas: detail enums gain `"late-drops"`; the efficiency source schema gains optional `attribution`
(enum of the five) and `lateDrops` (object of the five fields, `cooldownUntil` string or null, `held`
enum `"nothing-sheddable" | "link-or-unknown"` or null).

- [ ] **Step 1: Write the failing tests** (`manager-late-shed.test.ts`, following the fixtures of
      `tests/unit/decoders/enablement/manager-gate.test.ts`):
      `channel placement inherits parent mode and start mode`;
      `late-drops verdict suspends with efficiency-budget and detail late-drops`;
      `second late shed doubles the retry delay` (300 000 then 600 000);
      `YAML placement is never passed to the gate` (existing `gateExemptKey` path, asserted with a
      late-shed-capable fake gate). Route test: `/api/decoders/efficiency` accepts `late-drops`,
      `attribution` and `lateDrops` (including `held`, which survives serialization).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/decoders/enablement/manager-late-shed.test.ts tests/unit/api/decoders-efficiency-route.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify**

Run: the two files plus `tests/unit/decoders/enablement/manager-gate.test.ts tests/unit/decoders/enablement/manager-always.property.test.ts tests/unit/decoders/enablement/manager-lifecycle.property.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(decoders): late-drop sheds back off and expose attribution" -- src/decoders/manager.ts src/api/routes/decoder-status-schemas.ts src/api/routes/decoders.ts tests/unit/decoders/enablement/manager-late-shed.test.ts tests/unit/api/decoders-efficiency-route.test.ts
```

---

## Lane FL: fake link and benches

### Task FL.1: Stall schedule in the fake `rtl_tcp`

**Files:**

- Modify: `scripts/capacity/fake_rtl_tcp.py` (`main()` args, `stream()`)
- Create: `tests/unit/capacity/test_fake_rtl_tcp_stalls.py`, `tests/unit/capacity/fake-rtl-tcp-stalls.test.ts`

**Interfaces:**

- Produces CLI flags: `--stall-schedule "offset_s:stall_ms,..."` (offsets relative to the previous
  stall; the list repeats), `--stall-mode catchup|drop` (default `catchup`),
  `--stats-port N` (optional; serves rtlmux-shaped JSON `{ "clients": [{ "bytesDropped": n }] , "totalSent": n }`
  on `127.0.0.1` or the container interface). Each stall emits one JSON line
  `{"event":"stall","stall_ms":…,"mode":…,"withheld_bytes":…}`; `drop` adds `dropped_bytes_total`.

`catchup` withholds the paced blocks for the stall and then sends them back to back; `drop` skips them.
Pacing after a stall resumes from the schedule clock (no drift).

- [ ] **Step 1: Write the failing tests** — Python unit test drives `stream()` with a fake socket
      and fake clock: schedule `1:150,2:500` with rate 2 048 000 → stall events at 1 s and 3 s,
      `withheld_bytes == round(0.15 × 4 096 000)` within one block; `drop` totals add up. The TS wrapper
      spawns `python3 tests/unit/capacity/test_fake_rtl_tcp_stalls.py` like `capacity-scripts.test.ts`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/capacity/fake-rtl-tcp-stalls.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify** (same command, plus `tests/unit/capacity/capacity-scripts.test.ts`). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(capacity): stall schedule and drop mode for the fake rtl_tcp" -- scripts/capacity/fake_rtl_tcp.py tests/unit/capacity/test_fake_rtl_tcp_stalls.py tests/unit/capacity/fake-rtl-tcp-stalls.test.ts
```

### Task FL.2: Scratch compose project, slow-sink consumer and acceptance driver

**Files:**

- Create: `scripts/link-burst/compose.yaml`, `scripts/link-burst/config.yaml`,
  `scripts/link-burst/slow-sink/rtl_433` (executable, `#!/usr/bin/env python3`),
  `scripts/link-burst/run_acceptance.py`, `scripts/link-burst/README.md`
- Test: `tests/unit/scripts/link-burst-compose.test.ts`, `tests/unit/scripts/test_link_burst_slow_sink.py`

**Slow consumer mechanism (chosen: a test-only binary shim in FL's own files, no core change).**
WaveKit has no generic or exec decoder type: `DecoderConfigSchema.type` (`src/config.ts:193`) must
name an adapter registered in `src/index.ts`, and every adapter hardcodes its executable through
`BaseDecoder.getCommand()` (`src/decoders/base-decoder.ts:121`). The RTL-TCP relay is not usable
either: `TunerRelay.attachBranch()` (`src/core/tuner-relay.ts`) adds one shared branch for all
clients, drains it in flowing mode, and `distributeToClients()` disconnects a slow client once its
socket queue exceeds `iqClientBufferLimit`. A slow relay client therefore never raises a fanout
branch's `droppedBytesTotal` and can never yield `consumer`. The slow branch is instead a real,
registered adapter whose executable is shadowed in the scratch container only:

- `config.yaml` carries one YAML decoder entry, `id: link-burst-slow-sink`, `type: rtl433`,
  `enabled: true`, `sourceId` = the fake source, `useChannelizer: false` (raw fanout path, so the
  decoder owns its own fanout branch; see `src/decoders/manager.ts` channel routing), no `mode` key,
  and `options.extraArgs: ["link-burst-slow-sink"]` (validated by `rtl433OptionsSchema` in
  `src/decoders/options/rtl433.ts`, which allows `extraArgs`). `Rtl433Decoder.getCommand()`
  (`src/decoders/builtin/rtl433.ts`) returns bare `rtl_433`, run by `IqDecimateDecoder` through
  `/bin/sh -c`, so `PATH` resolution applies; decoder children inherit `PATH` (`csdrChildEnv()` in
  `src/decoders/csdr-buffers.ts` only strips access and csdr-buffer variables).
- `compose.yaml` bind-mounts `./slow-sink` read-only at `/opt/link-burst/bin` in `core` and sets
  `PATH=/opt/link-burst/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`
  (`with-contenv` in `docker/overlay/s6-overlay/s6-rc.d/wavekit-api/run` passes it to the core).
- `slow-sink/rtl_433`: when its argv does not contain `link-burst-slow-sink` it `os.execv`s
  `/usr/local/bin/rtl_433` with the same argv, so every catalogue `rtl433` placement runs the real
  decoder. With the marker it prints nothing and reads stdin until EOF (exit 0): as fast as possible
  while `/tmp/link-burst-slow` is absent, and at the integer bytes/s written in that file while it
  exists (re-checked every read, 64 KiB reads, sleep-paced); a value of `0` is pause mode: the shim
  stops reading entirely (it re-checks the file every 250 ms without touching stdin), so the finite
  pipe buffers between the core and the shim fill and the branch must congest. The driver toggles it with
  `docker compose exec core sh -c 'echo 131072 > /tmp/link-burst-slow'` and `rm -f` (131 072 B/s is
  far below the 1 MHz cu8 decimated stream of 2 MB/s, so the branch congests and drops steadily).
- **Gate status: the slow sink is a YAML (`config`) placement, so it is admitted without verdict and
  is never shed (requirement 5.5).** Consequently `late-shed` is expected to shed the newest
  graduated automatic catalogue placement on the fake source, not the slow sink; because the sink
  keeps dropping, a further shed follows only after `LATE_SHED_COOLDOWN_MS` and two of three new
  condemned windows, one per cooldown, in reverse admission order, until nothing is sheddable (then
  one warning per minute, no shed). The sink, YAML, `always` and operator-started placements stay
  running throughout.

**Interfaces:**

- Produces: `python3 scripts/link-burst/run_acceptance.py --rate 2048000|2400000 --scenario lossless|overflow|consumer|host|upstream|late-shed --minutes 10 --out <dir>`
  which starts the project with a unique `-p wkburst-<pid>` name, waits for the core's
  ephemeral API port (`docker compose port`), polls `/api/resources/link-quality`,
  `/api/decoders/efficiency` and `/api/telemetry/fanout` every 2 s, writes `samples.jsonl` and
  `summary.json` (per-branch drop %, overflow bytes, attribution counts, suspensions, sheds, the slow
  sink's branch id and drop %, sink restarts, the sink mode used, and the sibling latency proxy of A16:
  the maximum over the run of `absorber.peakHeldBytes10m`, `absorber.peakHeldMs10m` and
  `absorber.laggardExcludeMsMax10m`, plus the largest chunk-size bucket edge with a non-zero count from
  `histograms.chunkSizeCounts` converted to milliseconds at the run's byte rate, so M.2 can check
  `peakHeldMs10m <= ABSORBER_LAGGARD_MS + one chunk`), and tears the project down. The sink's branch is the
  fanout branch whose id carries `link-burst-slow-sink`; every other branch on the source is a
  sibling. Scenarios map to the design's "Fake-link acceptance plan" bullets: intervals
  `9,1,130,50,40,71,161` s; lossless stalls 150, 500, 1 000, 1 800 ms; overflow stalls 2 500,
  4 000 ms; in those, `host` and `upstream` the sink stays in fast mode and counts as one more
  sibling. `consumer`: smooth link (no stalls), sentinel `131072` written after 60 s. If the sink
  branch's drops have not risen 120 s after the sentinel (csdr or `sh` pipe buffers absorbing the
  throttled rate), the driver rewrites the sentinel to `0` (pause mode) once and records
  `sinkMode: "pause"`; the 10 minutes are counted from the moment the sink branch first drops. The run
  is invalid (exit 2, not a pass or fail, `summary.json` carries `invalidReason`) when the sink branch
  still never drops in pause mode or the sink restarted. A pause-mode run that still never drops means
  the decoder path decouples the branch from the shim; Main then records the `consumer` half of 9.2
  as an open gap in the acceptance record (no core change in this plan).
  `host` runs `stress-ng` inside the core container; `upstream` uses `--stall-mode drop` with
  `--stats-port`. `late-shed`: phase 1 waits until `/api/decoders/efficiency` shows no placement on
  probation for the fake source (every catalogue placement graduated); phase 2 runs overflow-length
  stalls for 3 minutes with the sink fast (link-only bursts, expect no shed); phase 3 writes the
  sentinel and records every shed with its monotonic time, key, admission order and detail.
- `compose.yaml`: services `fake` (python image running `fake_rtl_tcp.py`) and `core` (the locally
  built `wavekit` image), on an `internal: true` network; `core` publishes only its API port as
  `"127.0.0.1::9000"`-style ephemeral mapping (container port, no fixed host port); the RTL-TCP relay
  and audio TCP port stay disabled; the core config points the source at `fake:1234` with
  `burstAbsorber.seconds` set per scenario via env `WAVEKIT_SOURCES_0_BURST_ABSORBER__SECONDS`.

- [ ] **Step 1: Write the failing tests**
  - `link-burst-compose.test.ts` parses `compose.yaml` and `config.yaml` (with `yaml`) and asserts:
    no `host.docker.internal`; no host port among 15555/15556/18080/9000/5173/8081/8082; no published
    fixed host port at all; no IPv4 literal outside `127.0.0.1`; network `internal: true`; source
    host is the `fake` service name; relay not enabled. Slow-sink assertions:
    `ConfigSchema.safeParse(parsedConfig).success === true` (`src/config.ts`); exactly one decoder
    whose `options.extraArgs` contains `link-burst-slow-sink`, with `type === "rtl433"`,
    `useChannelizer === false`, `enabled === true`, no `mode` key (so it is a YAML placement and
    gate-exempt), and `rtl433OptionsSchema.safeParse(options).success`; `src/index.ts` text contains
    `decoderRegistry.register("rtl433"` (the type is registered); `core` mounts `./slow-sink` at
    `/opt/link-burst/bin` read-only and its `PATH` begins with `/opt/link-burst/bin:`;
    `scripts/link-burst/slow-sink/rtl_433` is executable. It runs
    `python3 scripts/link-burst/run_acceptance.py --help` (exit 0) and spawns
    `python3 tests/unit/scripts/test_link_burst_slow_sink.py` like `capacity-scripts.test.ts`.
  - `test_link_burst_slow_sink.py` imports the shim's functions (pure `should_throttle(argv)`,
    `read_rate(path)` and `sink(stdin, sentinel, clock, sleep)` with an injected fake clock): without
    the marker `should_throttle` is false (exec path); with the marker and no sentinel, 1 MiB of input
    is consumed with zero sleeps and exit 0 at EOF; with the sentinel holding `65536`, 256 KiB is
    consumed over at least 3.9 fake seconds; removing the sentinel mid-run returns to fast reads; an
    unreadable or non-integer sentinel throttles at the 131 072 default (fails safe toward drops,
    never toward silence); a sentinel holding `0` reads nothing from stdin over 10 fake seconds and
    resumes reading when the sentinel is removed.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/scripts/link-burst-compose.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Lanes do not run Docker; Main runs it in M.2.

- [ ] **Step 4: Verify** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
chmod +x scripts/link-burst/slow-sink/rtl_433
git commit -m "feat(link-burst): scratch fake-link acceptance project with a slow-sink consumer" -- scripts/link-burst/compose.yaml scripts/link-burst/config.yaml scripts/link-burst/slow-sink/rtl_433 scripts/link-burst/run_acceptance.py scripts/link-burst/README.md tests/unit/scripts/link-burst-compose.test.ts tests/unit/scripts/test_link_burst_slow_sink.py
```

### Task FL.3: Absorber and recorder bench (after AB.2 and IR.1 merge into `batch/link-burst`)

**Files:**

- Create: `scripts/bench/burst-absorber.ts`, `tests/unit/bench/burst-absorber.test.ts`

**Interfaces:**

- Consumes: `createBurstAbsorber` (AB.2), `createIngestRecorder` (IR.1).
- Produces: a bench built and run like `scripts/bench/carrier-meter.ts` (header comment:
  `pnpm exec esbuild scripts/bench/burst-absorber.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/burst-absorber.mjs`,
  then `node output/bench/burst-absorber.mjs --rate 2048000|2400000 --seconds 30`) printing one JSON line
  `{ rate, passThroughNsPerChunk, recorderNsPerChunk, holdCoreFraction, releaseCoreFraction, loopP99AddedMs, ringBytes }`
  with chunk sizes drawn from 4 KiB, 16 KiB and 64 KiB, a fake fanout with three branches, and a
  scripted 600 ms stall plus catch-up per 10 s.
- Exported pure `runBench(opts): BenchResult` for the test.

- [ ] **Step 1: Write the failing test** — `runBench({ rate: 2_048_000, seconds: 1 })` returns finite
      non-negative numbers, `ringBytes === 2 × 2_048_000 × 2`, and delivered bytes plus overflow equal
      ingested bytes.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/bench/burst-absorber.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify** (same command). Expected: PASS. Then run the bench at both rates on the
      desktop and paste the JSON into the lane report (Main copies it into the M.2 record).

- [ ] **Step 5: Commit**

```bash
git commit -m "bench(link-burst): absorber and recorder cost bench" -- scripts/bench/burst-absorber.ts tests/unit/bench/burst-absorber.test.ts
```

---

## Lane HD: delivery hook and docs

### Task HD.1: `iqDelivery` in receiver capabilities and the SDR host

**Files:**

- Modify: `src/core/tuner-capabilities/provider.ts:221` (factory signature, `project`),
  `src/core/tuner-capabilities/types.ts:513` (schema), `src/api/routes/receiver-capabilities.ts`
  (response schema), `packages/sdr-host/src/api/routes/status.ts:40-80`
- Test: `tests/unit/core/receiver-capabilities-iq-delivery.property.test.ts`,
  `packages/sdr-host/tests/unit/status-iq-delivery.test.ts`

**Interfaces:**

- Consumes: `ReceiverIqDelivery` (0.1).
- Produces: `createReceiverCapabilitiesProvider(reader, descriptor, iqDelivery?: (sourceId: string) => { advertised: readonly ("raw" | "channels")[] | null; configured: "raw" | "channels" | "auto" } | null)`;
  the projected DTO carries `iqDelivery: { advertised, configured, resolved: "raw" }` when the callback
  returns non-null, and omits it otherwise; a throwing callback omits it. The SDR host `/api/status`
  body gains `iqDelivery: { modes: ["raw"] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// Feature: link-burst-resilience, Property 14: Delivery hook (resolution half)
// Validates: Requirements 7.1, 7.2, 7.3
// any configured "raw" | "auto" and any advertised list (or null): iqDelivery.resolved === "raw",
// configured echoed, advertised echoed; the DTO still validates against receiverCapabilitiesSchema
```

SDR host test: status route body has `iqDelivery.modes` equal to `["raw"]`.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run tests/unit/core/receiver-capabilities-iq-delivery.property.test.ts` and
`pnpm --filter @wavekit/sdr-host exec vitest run tests/unit/status-iq-delivery.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Verify** — both commands plus `tests/unit/core/receiver-capabilities-provider.test.ts tests/unit/api/receiver-capabilities.test.ts`.
      Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(receiver-capabilities): reserve the IQ delivery contract" -- src/core/tuner-capabilities/provider.ts src/core/tuner-capabilities/types.ts src/api/routes/receiver-capabilities.ts packages/sdr-host/src/api/routes/status.ts tests/unit/core/receiver-capabilities-iq-delivery.property.test.ts packages/sdr-host/tests/unit/status-iq-delivery.test.ts
```

### Task HD.2: Amendments and docs

**Files:**

- Modify: `docs/specs/decoder-enablement/requirements.md` (4.1 c, 4.4, 5.4, 11.2 in-place notes),
  `docs/specs/decoder-enablement/design.md` (property 6, "Calls made" bullet),
  `docs/specs/link-burst-resilience/design.md` (one-line erratum, A8),
  `docs/CLI-COORDINATION.md` (append only, hand-formatted, no Prettier), `docs/API.md` (resources
  section: two routes, WS event, new optional fields), `docs/specs/README.md` (index entry),
  `config/default.yaml` (commented `burstAbsorber` and `delivery` keys under the source example)
- Test: `tests/unit/repo/agent-instructions.test.ts` (unchanged; must pass)

Content is fixed by the design's "Amendments to decoder-enablement" section (copy its wording; numbers
unchanged; each note links `../link-burst-resilience/requirements.md`). The coordination note lists:
`SourceLinkQuality` and parts, `DropAttribution`, `LinkAdvisory.burst?`,
`ReceiverCapabilities.iqDelivery?`, efficiency `attribution?`/`lateDrops?`, the `late-drops` detail,
`resources:link-quality`, and the two routes, all optional and additive (also `histograms?`,
`loopDelay?`, `lateDrops.held` and `SdrHostStatus.iqDelivery?`).

Erratum (A8): append one line under the first bullet of the design's "EfficiencyMonitor and
EfficiencyGate changes" section: "Erratum: the monitor keeps the window ring; the gate keeps the
last shed time (cooldown) and the late-since mark (last probationer or shed). Behaviour is
unchanged." No other edit to the link-burst-resilience spec.

- [ ] **Step 1: Edit the files.**
- [ ] **Step 2: Verify**

Run: `pnpm exec vitest run tests/unit/repo/agent-instructions.test.ts` and
`pnpm exec vitest run tests/unit/utils/config.test.ts` (default config still parses).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(link-burst): amend decoder-enablement, announce contract, document routes" -- docs/specs/decoder-enablement/requirements.md docs/specs/decoder-enablement/design.md docs/specs/link-burst-resilience/design.md docs/CLI-COORDINATION.md docs/API.md docs/specs/README.md config/default.yaml
```

---

## Main: composition, acceptance and the default flip

### Task M.1: Composition (after lanes AB, IR, AG, HD merge; FL.1–FL.2 may merge in any order)

**Files:**

- Create: `src/core/link-burst/compose.ts`
- Modify: `src/index.ts:498` (gate `log`), `:1170` (router opts), `:1319-1345` (monitor deps),
  `:1887-1900` (aggregator components), `:1939` (advisor deps), the receiver-capabilities provider
  construction
- Test: `tests/unit/core/link-burst/compose.test.ts`

**Interfaces:**

- Produces:

```ts
export function composeLinkBurst(deps: {
	log: Logger
	monoNow?: () => number
}): {
	factories: LinkBurstFactories
	loopMeter: EventLoopMeter
	dispose(): void
}
```

`src/index.ts` wiring: router `opts.linkBurst = composed.factories`; monitor deps
`ingest: (id, from, to) => sourceRouting.linkBurst(id)?.recorder?.interval(from, to) ?? null`,
`loopDelay: () => composed.loopMeter.takeInterval()`,
`shortfall: id => advisorRef.current?.shortfall(id, rateOf(id), frameOf(id)) ?? null` (a `let`
holder, because the advisor is created later at `:1939`),
`upstreamDroppedTotal: id => backpressureTracker?.upstreamDroppedTotal(id) ?? null` (lazy; tracker
is created at `:1887`), `cpuGuardPercent`, `log`; `createLinkAdvisor({ now: Date.now, monoNow: monitor.monoNow, linkDropsSince: monitor.linkDropsSince, burst: id => linkQuality.burst(id) })`;
`createLinkQuality` with `handles: id => sourceRouting.linkBurst(id)`,
`attribution: id => monitor.attributionCounts(id)`, `upstreamDropRate: id => backpressureTracker?.peekDropRate(id) ?? null`,
`receiver: id => sdrHostPoller?.getLinkFacts(id) ?? null`,
`loopDelay: () => composed.loopMeter.report(monitor.monoNow())`,
`advisory: id => { const input = linkInputOf(id); return input && advisorRef.current ? advisorRef.current.classify(input, backpressureTracker?.peekDropRate(id) ?? null) : null }`
(`linkInputOf` is the rate policy's inline `linkInput` lambda at `:1949`, hoisted to a named const
and passed to both; the re-check uses the non-mutating `peekDropRate`, A6, never `getBackpressure`),
`reportAdvisory: (id, a) => resourceAggregator?.reportLinkAdvisory(id, a)`; aggregator `linkQuality`
component; gate `createEfficiencyGate(inputs, { drops, log: createComponentLogger(log, "EfficiencyGate") })`;
provider `iqDelivery` callback from `sourceManager.getConfig(id)?.delivery` and
`sdrHostPoller?.getStatus(id)?.iqDelivery?.modes ?? null`. `own(20, composed.dispose)`.

- [ ] **Step 1: Write the failing test** — `compose.test.ts`: factories create a recorder and an
      absorber satisfying the contract; `loopMeter.takeInterval()` returns null or finite values;
      `loopMeter.report(now)` returns a `LoopDelayReport` without resetting; `dispose()` disables the
      histogram.
- [ ] **Step 2: Run to verify failure** — `pnpm exec vitest run tests/unit/core/link-burst/compose.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `compose.ts` and the `src/index.ts` wiring.**
- [ ] **Step 4: Verify** — `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm test`
      (full suite). `make dev-local` starts and `GET /api/resources/link-quality` answers `[]` or reports
      with `absorber.enabled: false` (default still off) and, for an IQ source, `histograms` and
      `loopDelay` present.
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(link-burst): compose recorder, absorber, attribution and link report" -- src/core/link-burst/compose.ts src/index.ts tests/unit/core/link-burst/compose.test.ts
```

### Task M.2: Fake-link acceptance (requirements 9.1–9.4)

- [ ] **Step 1:** Build the image from the batch worktree (never the shared checkout):
      `make docker-build`. Clean leftovers after the run.
- [ ] **Step 2:** For each rate 2 048 000 and 2 400 000, run with `burstAbsorber.seconds: 2` forced by
      env: `python3 scripts/link-burst/run_acceptance.py --rate <r> --scenario lossless --minutes 10 --out /tmp/lbr/<r>-lossless`,
      then `overflow`, `consumer`, `host`, `upstream`, `late-shed`.
      Pass criteria (copy verbatim into the record): lossless → every branch 0.00 % bytes dropped and
      absorber overflow 0; overflow → overflow equals withheld bytes beyond capacity within one release
      block, every such interval `link`, no probationer suspended, clean window not restarted; consumer →
      slow-sink branch (`link-burst-slow-sink`, FL.2) drops, intervals `consumer`, every sibling branch
      0.00 %, sibling added latency ≤ `ABSORBER_LAGGARD_MS` plus one chunk, measured by the A16 proxy in
      `summary.json` (`peakHeldMs10m` and `laggardExcludeMsMax10m` each ≤ `ABSORBER_LAGGARD_MS` + the
      run's largest-chunk duration); host → `host`; upstream →
      `unknown`; late-shed → phase 2 (link-only bursts, sink fast) sheds nothing; phase 3 sheds the newest
      eligible graduated automatic catalogue placement after two of three condemned windows, nothing else
      for `LATE_SHED_COOLDOWN_MS`, later sheds one per cooldown in reverse admission order; the slow sink
      (a gate-exempt YAML placement) and every YAML/`always`/operator placement are never shed. A run the
      driver marks invalid (sink never dropped, even after its pause-mode fallback, or restarted) is
      repeated once, not counted; if the repeat is invalid for the same reason, the record states the
      `consumer` half of 9.2 (and phase 3 of `late-shed`) as an open gap with the driver's
      `invalidReason`, and the remaining scenarios still gate acceptance.
- [ ] **Step 3:** Measure CPU and memory on the desktop at both rates with
      `scripts/bench/burst-absorber.ts` and the scenario's container stats; event-loop p99 added ≤ 2 ms
      at 2.048 Msps. Measure a Pi 4-class core host the same way if one is available. Write
      `docs/engineering/LINK-BURST-2026-10-ACCEPTANCE.md` against the design's budget table. If no Pi
      4-class core host was measured, the record's Pi 4 column states, in so many words, "estimate: 4×
      the desktop figure (design budget table), pending measurement (task M.5)", and requirement 9.4 is
      listed as partially met until M.5 lands.
- [ ] **Step 4: Commit** the record: `git commit -m "docs(engineering): link-burst fake-link acceptance" -- docs/engineering/LINK-BURST-2026-10-ACCEPTANCE.md`

### Task M.3: Instrumentation record and default flip (requirement 2.3)

- [ ] **Step 1:** With the absorber default still off, run the core on the live Wi-Fi path for at least
      30 minutes at 2.048 Msps and 30 minutes at 2.4 Msps. Poll `GET /api/resources/link-quality` every
      2 s and keep every response. From it take: the gap histogram (`histograms.gapBucketUpperMs`/
      `gapCounts`) and worst gaps (`arrivals.worstStallMs`, `gapP99Ms`); catch-up bytes per burst
      (`histograms.catchupBucketUpperBytes`/`catchupCounts`, plus `arrivals.catchupBytes10m` over
      `arrivals.burstSeconds`); the chunk-size distribution (`histograms.chunkSizeBucketUpperBytes`/
      `chunkSizeCounts`); per-interval loop delay (`loopDelay.last` per poll, `loopDelay.maxMs10m`,
      `p99MaxMs10m`). Take branch drop times against gap times from the attribution log lines
      ("Drop interval attributed", which carry `gapMs` and `loopDelayMs`) and `/api/telemetry/fanout`.
      The record reports each 10 min window's histograms at both rates.
- [ ] **Step 2:** Write `docs/engineering/LINK-BURST-2026-10-INSTRUMENTATION.md` stating whether
      `LINK_GAP_MS`, `ABSORBER_LAGGARD_MS` and the 2 s default stand or change, with numbers.
- [ ] **Step 3:** In `src/core/link-burst/contract.ts` set `BURST_ABSORBER_DEFAULT_ENABLED = true` and
      any changed constants; update `tests/unit/core/link-burst/contract.test.ts` expectations
      (`resolveAbsorberSeconds(undefined, "network") === 2`).
- [ ] **Step 4: Verify** — `pnpm test`, `pnpm run typecheck`, `pnpm run lint`.
- [ ] **Step 5: Commit record and flip together:**

```bash
git commit -m "feat(link-burst): enable the 2 s absorber on network sources per instrumentation record" -- docs/engineering/LINK-BURST-2026-10-INSTRUMENTATION.md src/core/link-burst/contract.ts tests/unit/core/link-burst/contract.test.ts
```

### Task M.4: Live soak (requirement 9.5)

- [ ] **Step 1:** On the current path, 2 h at 2.048 Msps then 2 h at 2.4 Msps with the default
      catalogue. Record branch and absorber drop %, bursts by stall length, attribution counts, sheds,
      advisory level history and core CPU.
- [ ] **Step 2:** Pass: 0.00 % branch drops for every burst within capacity; every overflow `link`; no
      probationer suspended in a `link` interval; no shed while only `link` or `unknown` drops occur.
      Write `docs/engineering/LINK-BURST-2026-10-SOAK.md` and update the requirements status line.
- [ ] **Step 3: Commit:** `git commit -m "docs(engineering): link-burst live soak" -- docs/engineering/LINK-BURST-2026-10-SOAK.md docs/specs/link-burst-resilience/requirements.md`

### Task M.5: Pi 4-class CPU and memory measurement (requirement 9.4 follow-up)

Runs only if M.2 Step 3 had no Pi 4-class core host; otherwise it is closed by M.2.

- [ ] **Step 1:** On a Pi 4-class core host (not the receiver), build the bench as in FL.3 and run
      `node output/bench/burst-absorber.mjs --rate 2048000 --seconds 30` and `--rate 2400000`; run the
      `lossless` and `overflow` scenarios of M.2 there if Docker is available, recording container CPU and
      memory.
- [ ] **Step 2:** Replace the estimate column in `docs/engineering/LINK-BURST-2026-10-ACCEPTANCE.md`
      with the measured figures and mark 9.4 met (or record the budget miss with numbers).
- [ ] **Step 3: Commit:** `git commit -m "docs(engineering): link-burst Pi 4-class measurement" -- docs/engineering/LINK-BURST-2026-10-ACCEPTANCE.md`

---

## Self-review notes

- Slow consumer for 9.2/9.3: FL.2 shadows `rtl_433` with a test-only shim for one YAML `rtl433`
  entry (gate-exempt); the RTL-TCP relay was rejected because its single shared branch never drops.
- Coverage: 1.1–1.9 → AB.1–AB.3; 2.1 → 0.1, IR.1, IR.3 (`histograms`); 2.2 → 0.1, IR.1
  (`report()`), IR.3 (`loopDelay`), M.1; 2.3 → IR.3 (exposure), M.3; 3.1–3.8 → AG.1–AG.2;
  4.1–4.6 → AG.2–AG.3; 5.1–5.4 → AG.2–AG.4; 5.5 → 0.1 (`held`, `linkOrUnknownDrops`), AG.2, AG.3
  (warning, view), AG.4 (schema), M.1 (gate logger); 5.6 → AG.3; 6.1–6.3, 6.5–6.6 → IR.3–IR.4;
  6.4 → IR.4 (link hold and per-tick re-check), M.1; 7.1–7.3 → 0.1, HD.1; 8.1 → 0.1, IR.3
  (`sdrHostStatusSchema.iqDelivery`, report schemas), AG.4, HD.2; 8.2 → 0.1; 8.3 → AB.2, AG.2, AG.3,
  AG.4; 9.1, 9.3 → FL.1–FL.2, M.2; 9.2 → AB.2 (latency proxy), FL.2 (summary, consumer fallback),
  M.2; 9.4 → FL.3, M.2, M.5; 9.5 → M.4; 10.1 → HD.2. Design erratum for A8 → HD.2.
- Properties 1–14 each have a named test in exactly one lane (2, 8, 9, 11, 12, 14 split into halves
  across the lane that owns each code path).
- Type names used across tasks are the ones in 0.1's Interfaces block.
