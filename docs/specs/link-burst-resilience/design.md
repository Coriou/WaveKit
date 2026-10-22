# Link burst resilience design

Status: design, not implemented (2026-10-22). Requirements in [requirements](requirements.md).
Background: the stream pipeline (`src/core/source-manager.ts`, `src/core/source-fanout-router.ts`,
`src/core/fanout-manager.ts`), the efficiency gate and monitor
(`src/decoders/enablement/efficiency-gate.ts`, `src/decoders/enablement/efficiency-monitor.ts`,
`src/decoders/enablement/contract.ts`) of [decoder-enablement](../decoder-enablement/design.md),
the link advisory (`src/core/link-advisory.ts`, `src/core/rate-policy-contract.ts`), upstream
drop tracking (`src/core/source-backpressure-tracker.ts`), the resource aggregator
(`src/core/resource-aggregator.ts`), receiver-host telemetry (`packages/sdr-host/src/telemetry/`)
and the [performance rules](../../PERFORMANCE.md).

## Overview

```
socket ─> SourceManager (align, metrics, signal level) ──> source stream ──┬─> other taps (unchanged)
                                                                            │
                         IngestRecorder <── arrival time, bytes ────────────┤
                                                                            v
                       network IQ source?  no ─────────────────────> FanoutManager (unchanged)
                                           yes ─> BurstAbsorber ──────> FanoutManager (unchanged)
                                                   ^      │ overflow counter
                     congestion (read-only) ───────┘      v
FanoutManager branch counters ─┐                  "@absorber" drop counter
IngestRecorder, loop meter ────┼─> EfficiencyMonitor ─> attributeInterval() ─> EfficiencyGate
CPU meter, upstream drops ─────┘        (2 s, monotonic)                          probation, clean
                                                                                  window, late shed
IngestRecorder, absorber, attribution, SdrHostPoller ─> LinkQuality ─> REST, resources:link-quality,
                                                                         link advisory, alerts
```

Three ideas carry the design:

1. **Absorb in the core, before fanout, once per source.** The clumping happens on the hop into
   the core, so only the core can smooth it. One shared buffer per source replaces raising every
   branch's mark, and it costs nothing while the link is smooth.
2. **Attribute before judging.** The gate keeps its fail-closed rules, but a drop that is
   positively the link's no longer condemns a newcomer or resets the clean window.
3. **Shed late only for causes a decoder can fix.** Sustained host or consumer drops after
   graduation shed the newest automatic placement; link and unknown drops only alert.

## Options weighed

Each decision area lists the options considered, their pros and cons, and the choice.

### A. Absorber shape and placement

| Option                                                                 | Pros                                                                                                                                      | Cons                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1. Raise every branch's mark (for example 256 KiB → 2 s)              | No new component; per-branch isolation kept                                                                                               | Memory × branches (eight branches × 9.6 MB at 2.4 Msps); every slow consumer then hides up to 2 s of backlog; changes fanout backpressure for every source including loopback             |
| **A2. One elastic ring per source, before fanout (chosen)**            | One copy of the bytes per source; zero latency while empty; loopback untouched; fanout code unchanged; overflow is countable in one place | Holds all branches while one is congested (bounded by the laggard rule); one new component on the ingest path                                                                             |
| A3. Paced jitter buffer (release on the sample clock at a fixed delay) | Smooth output; textbook design                                                                                                            | Constant added latency of the full buffer; main-thread timers at block rate; clock drift handling between receiver and core                                                               |
| A4. Relay buffer on the receiver host                                  | Close to the radio; would help a receiver-side Wi-Fi radio                                                                                | Cannot smooth clumping on a hop after it, which is where it happens today; receiver-specific; rtlmux already queues 4 MiB per client                                                      |
| A5. TCP backpressure: pause the socket and let rtlmux's queue absorb   | No core memory                                                                                                                            | Pushes the stall back onto the link (window closes, then another catch-up); plain `rtl_tcp` has no comparable bounded queue; rtlmux drops whole blocks at 4 MiB (about 0.9 s at 2.4 Msps) |
| A6. Larger socket receive buffer                                       | One setsockopt                                                                                                                            | Kernel limits are host-specific and small; does not help once bytes are in user space, where the overflow happens                                                                         |

Chosen: A2. Within A2 two storage shapes were weighed: holding the socket's own `Buffer`
references (no copy, but the retained memory per chunk depends on how Node backs socket reads,
and small Wi-Fi chunks need many slots) or copying into one preallocated byte ring (exact,
preallocated memory; one memcpy of held bytes only while holding; one allocation per released
block only while draining a backlog). The byte ring is chosen for its fixed memory bound;
steady state (empty ring) still passes the socket's chunk through untouched, so rule 4 of the
performance rules holds where it applies.

Overflow policy: dropping the newest bytes that do not fit loses the fewest bytes and keeps the
held backlog contiguous; dropping the oldest keeps freshness but loses as much; resetting the
ring restores real time at the cost of the whole backlog. Newest-that-does-not-fit is chosen.

### B. Attribution method

| Option                                                                               | Pros                                                                                                            | Cons                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1. Interval rules over existing counters plus ingest and loop evidence (chosen)** | Pure, testable, reuses the monitor's 2 s complete reads and per-branch deltas; no change to the fanout hot path | 2 s granularity: a coincident consumer drop and link burst in one interval is judged together (falls to `link` only if every branch dropped, otherwise `consumer`) |
| B2. Per-drop event timestamps from the fanout                                        | Exact "same tick" correlation                                                                                   | Adds work and a clock read to the fanout's drop path, which must stay identical; more state per branch                                                             |
| B3. Upstream counters only                                                           | Simple                                                                                                          | Blind to clumping (upstream is 0 in the observed case) and to plain `rtl_tcp`                                                                                      |
| B4. No attribution: treat every drop alike (today)                                   | No new logic                                                                                                    | Link weather condemns newcomers and stalls admission; C+ late drops stay unhandled                                                                                 |
| B5. Statistical classifier                                                           | Could learn host patterns                                                                                       | Opaque, untestable as a property, cannot fail closed by construction                                                                                               |

Chosen: B1. The rule order puts `consumer` (a strict subset dropped) first because it needs no
timing evidence; `link` needs positive evidence on three independent axes; `host` needs positive
host evidence; everything else is `unknown`. An arrival gap measured in JavaScript also appears
when the event loop itself stalls, so the link rule subtracts the interval's loop-delay maximum
from the gap before comparing it (conservative: the maximum may belong to another moment).
Receiver upstream counters exist only behind an SDR host; the received-rate check (no
shortfall, so samples arrived late rather than lost) is the transport-agnostic stand-in, and a
measured upstream drop always forces `unknown` because the core then cannot separate link loss
from core loss.

### C. Late-drop response (after graduation)

| Option                                                                                                                     | Pros                                                                                                   | Cons                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| C1. Alert only (today)                                                                                                     | Never removes a running decoder                                                                        | Sustained host or consumer overload persists indefinitely (C+ record)                                                  |
| **C2. Shed the newest graduated automatic catalogue placement on sustained consumer or host drops, with backoff (chosen)** | Mirrors probation's "newest goes first"; the operator's own choices are safe; link weather never sheds | A shed decoder may not be the one dropping; one shed per cooldown converges slowly with many placements                |
| C3. Shed on any late drop                                                                                                  | Simple                                                                                                 | Sheds for link weather and on one-off spikes                                                                           |
| C4. Shed the branch's own consumer                                                                                         | Targets the slow decoder                                                                               | The slow branch is often the channelizer input, which serves several placements; would shed operator and YAML decoders |
| C5. Grow branch marks dynamically                                                                                          | No shedding                                                                                            | Hides overload as latency; memory grows without bound in the overload case                                             |

Chosen: C2, with the sustained test "two of the last three 10 s windows". One window alone is a
spike; requiring three of three would let a pattern that misses a window escape. A cooldown of
three windows gives the shed's effect a fresh history before the next judgement. Operator-started
placements are excluded with YAML and `always` ones, because decoder-enablement 4.8 forbids the
gate from stopping a decoder the operator started outside probation.

### D. Link-quality reporting

| Option                                                                                      | Pros                                                                                          | Cons                                     |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **D1. Extend the advisory and add a per-source `SourceLinkQuality` DTO and route (chosen)** | One place for facts; the advisory and alert stay the single verdict; the web UI reads numbers | New DTO surface                          |
| D2. A new alert type per burst                                                              | Visible                                                                                       | Alert noise for bursts that cost nothing |
| D3. Logs only                                                                               | Cheap                                                                                         | Invisible to the web UI                  |

Chosen: D1. Absorbed bursts are facts, not alerts (requirement 6.6); only loss moves the
advisory.

### E. Receiver-side options

| Option                                              | Pros                                           | Cons                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1. Plain decimation on the receiver                | Cuts link payload                              | Narrows the window for every consumer, defeating identify-anywhere; a rate cut the user can already make; low value                                      |
| E2. Channelization on the receiver                  | Payload proportional to channels, not span     | Receiver CPU on Pi 3-class hosts ([research](../../RESEARCH-2026-10-08-PI-CHANNELIZER.md)); a second protocol; spectrum and identify still need wideband |
| E3. Compression or bit reduction                    | —                                              | Excluded (2026-10-08 decision)                                                                                                                           |
| E4. Decoders on the receiver                        | —                                              | Excluded                                                                                                                                                 |
| **E5. Reserve the delivery contract only (chosen)** | Later spec can add E2 without breaking clients | No payload relief now                                                                                                                                    |

Chosen: E5; E2 is a separate later spec.

## Components

### BurstAbsorber (`src/core/link-burst/absorber.ts`)

```ts
interface BurstAbsorberDeps {
	fanout: AbsorberFanoutPort // distribute(chunk), congestedBranchIds(out), on/off(events)
	recorder: IngestObserver | null // observeChunk(bytes, mono)
	monoNow: () => number // performance.now
	frameBytes: number // 2 for U8_IQ, 4 for S16_IQ
	log: Logger
}
interface BurstAbsorber {
	configure(capacityBytes: number): void // allocate once; 0 frees and becomes pass-through
	ingest(chunk: Buffer): void
	flush(reason: "disconnect" | "rate" | "removed"): void
	counters(): AbsorberCounters // held, peakHeld, absorbed, overflowBytes/Chunks, flushed
	dispose(): void
}
```

- **Storage.** One `Buffer.allocUnsafeSlow(capacityBytes)` ring with head and length, allocated
  when the rate is known, kept across reconnects at the same rate.
- **Ingest.** Record arrival (when the recorder is installed by the router, it is called once
  per chunk, before the absorber). If the ring is empty and no gating branch is congested, call
  `fanout.distribute(chunk)` with the same `Buffer` (pass-through). Otherwise copy the
  frame-aligned prefix that fits into the ring; count the rest as overflow; then try a release.
- **Release.** While the ring is non-empty and no gating branch is congested: take at most
  `ABSORBER_RELEASE_BYTES` frame-aligned bytes from the head, copy them into a fresh
  `Buffer.allocUnsafe` (the fanout keeps references to written chunks, so ring memory cannot be
  handed out), advance the head, `distribute` it. Releases are triggered by `ingest` and by the
  fanout's `drain`, `branch-removed` and `branch-added` events; there are no timers.
- **Congestion.** `FanoutManager` gains one read-only method, `congestedBranchIds(out: Set<string>)`,
  which clears `out` and adds every active branch in backpressure or startup refusal. It reads
  existing fields only. The absorber keeps `congestedSinceMono` per branch from the `backpressure`
  and `drain` events and from these reads, and `siblingProgressMono` (the last time any other
  gating branch was seen uncongested).
- **Laggard rule.** On every ingest and release attempt: a congested branch whose
  `congestedSinceMono` is at least `ABSORBER_LAGGARD_MS` old and that saw sibling progress since
  then joins the excluded set; it leaves when the fanout reports it drained. A single active
  branch can never be a laggard, so a lone slow consumer fills the ring and then overflows
  (attributed by the monitor, not by the absorber).
- **Flush.** On disconnect, removal, rate or format change: discard held bytes, count them as
  `flushedBytes`, clear congestion bookkeeping.

The router (`SourceFanoutRouter`) decides per source at `connected`: if the source is IQ, its
transport is `network` and the resolved capacity is above 0, it attaches an absorber
(`stream.on("data", absorber.ingest)`, `fanout.attachIngest(absorber)`); otherwise it calls
`fanout.attachSource(stream)` exactly as today. `FanoutManager.distribute(chunk)` is a public
name for the existing private `distributeData`; its body does not change.

### IngestRecorder (`src/core/link-burst/recorder.ts`)

Per IQ source, independent of the absorber (it runs with capacity 0, requirement 2.3):

- `observeChunk(bytes, mono)`: arrival gap since the previous chunk into a 48-bucket geometric
  histogram (ratio 1.25 from 1 ms, so p99 is within 25 %); chunk size into a 16-bucket log2
  histogram; when a gap of at least `LINK_GAP_MS` ends, open a catch-up window of
  `CATCHUP_WINDOW_MS` and accumulate bytes above `rate × bytesPerSample × elapsed`.
- Sixty 10 s slots (10 min) of: gap histogram, worst gap, catch-up bytes, burst seconds. All
  arrays preallocated at construction; `observeChunk` does integer arithmetic only.
- `interval(fromMono, toMono)`: the largest gap that ended in the range, catch-up bytes, chunk
  count; used by the monitor for attribution.

### EventLoopMeter (`src/core/link-burst/loop-meter.ts`)

`perf_hooks.monitorEventLoopDelay({ resolution: 10 })`, enabled once per process. The monitor
calls `takeInterval()` each sample: it reads max and p99 in milliseconds and resets the
histogram. One instance is shared; it is the only consumer allowed to reset it.

### Attribution (`src/decoders/enablement/attribution.ts`)

A pure function:

```ts
type DropAttribution = "none" | "link" | "host" | "consumer" | "unknown"
interface IntervalEvidence {
	complete: boolean // every branch counter read validly (decoder-enablement 4.6)
	branchDrops: ReadonlyMap<string, number> // per active branch delta, absorber excluded
	absorberOverflow: number | null // null: no absorber on this source
	maxGapMs: number | null // this or the previous interval; null: no ingest record
	loopDelayMaxMs: number | null
	cpuPercent: number | null
	cpuGuardPercent: number
	shortfall: boolean | null // link window received-rate shortfall beyond 1 %; null unknown
	upstreamDropDelta: number | null // null: unmeasured
}
function attributeInterval(e: IntervalEvidence): DropAttribution
```

Any malformed or non-finite evidence field makes the whole interval `unknown` (fail closed).

Rules in order: incomplete → `unknown`; no positive delta anywhere → `none`; a strict non-empty
subset of branches rose and no overflow → `consumer`; upstream delta above 0 → `unknown`; gap,
loop delay and shortfall all known, `maxGapMs − loopDelayMaxMs ≥ LINK_GAP_MS` and no shortfall
→ `link`; loop delay at least `HOST_LOOP_DELAY_MS` or CPU at or above the guard → `host`;
otherwise `unknown`.

### EfficiencyMonitor and EfficiencyGate changes

- The monitor's per-source state gains the attribution of each sample, a ring of the last
  `LATE_SHED_WINDOWS` complete 10 s windows (condemning or not), `lastNonLinkDropMono` and the
  last shed time. The absorber's overflow counter enters the existing per-branch counter map
  under the reserved key `@absorber#<instance>` (the router refuses fanout branch ids starting
  with `@`), so overflow is drop evidence under every existing rule.
  Erratum: the monitor keeps the window ring; the gate keeps the last shed time (cooldown) and the late-since mark (last probationer or shed). Behaviour is unchanged.
- `SourceDropSample` gains `attribution`. A `link` sample does not set `lastDropMono` and does
  not reset `cleanSinceMono`; it breaks the credited coverage chain as an incomplete read does.
- `probation()` skips `always` and operator-started placements, consistent with never shedding
  these placements. For the newest eligible probationer it now condemns only on drops in
  samples attributed `consumer`, `host` or `unknown`. When a source has no probationer, it
  evaluates the late-drop rule and may return one verdict `{ key, detail: "late-drops" }` for the
  newest eligible placement. Eligibility needs the placement's mode and start mode, so
  `RunningPlacement` gains `mode` and `startMode`; the manager already excludes YAML placements
  (`gateExemptKey`).
- `noteSuspended(key, "late-drops", now)` uses the existing failure backoff path.
- The view's per-source entry gains `attribution` (last sample) and `lateDrops` (windows
  condemning of the last three, cooldown end, sheddable count).

### LinkQuality (`src/core/link-burst/link-quality.ts`) and advisory

`createLinkQuality(deps)` composes, per IQ source, the recorder's 10 min stats, the absorber's
counters, the monitor's attribution counts, the upstream drop rate from
`SourceBackpressureTracker` and receiver facts from `SdrHostPoller` (network interface on the
default route: kind and `wireless.signalDbm`; `power.undervoltageNow`; `power.throttling.throttled`).
`ResourceAggregator` emits `resources:link-quality` on its tick and serves the two routes in
`src/api/routes/resources.ts`. `createLinkAdvisor` gains an optional dependency
`linkDropsSince(sourceId, mono)`; `classify` returns `dropping` when a `link` attribution with
drops lies within `LINK_DROPPING_HOLD_MS`, and attaches the optional `burst` summary.

### Delivery hook

`SourceConfigSchema` gains `delivery` (`z.enum(["raw", "channels", "auto"]).default("auto")`)
with a refinement rejecting `channels`, and `burstAbsorber` (`z.object({ seconds:
z.number().min(0).max(10) }).optional()`). `src/core/tuner-capabilities/provider.ts` adds
`iqDelivery` (advertised modes from the SDR host status when present, else null; configured;
resolved `"raw"`). The SDR host status API reports `iqDelivery: { modes: ["raw"] }`.

## Data flow of one burst

1. The link stalls 600 ms; no chunks arrive; branches drain to empty.
2. 2.4 MB arrive within a few milliseconds. The first chunks pass through; the branches fill to
   their marks and congest; the rest goes into the ring (well under 2 s × 4.8 MB/s = 9.6 MB).
3. Each `drain` releases blocks until a branch congests again. Consumers run faster than real
   time on a backlog, so the ring empties within a fraction of a second to a few seconds.
4. The recorder logs a 600 ms gap and the catch-up bytes; no counter rose, so the interval is
   `none`; the report shows one burst second and the bytes absorbed. Nothing alerts.
5. Had the stall lasted 3 s, about 4.8 MB would overflow: the `@absorber` counter rises, the
   interval is `link`, probation and the clean window ignore it, the advisory turns `dropping`
   for 60 s and the `link-capacity` alert is critical.

## Constants

Provisional values are confirmed or replaced by the instrumentation record (requirement 2.3).

| Constant                               | Value   | Sizing rationale                                                                                                                                                                                                                    |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BURST_ABSORBER_DEFAULT_S`             | 2       | Operator decision. Above the 1.5 s decoder start-up buffer precedent and rtlmux's ~0.9–1 s queue, so a stall the receiver survives is also survived in the core. Memory 8.2 MB at 2.048 Msps, 9.6 MB at 2.4 Msps per network source |
| `BURST_ABSORBER_MAX_S`                 | 10      | Bounds memory at 48 MB per source at 2.4 Msps                                                                                                                                                                                       |
| `ABSORBER_RELEASE_BYTES`               | 65 536  | Node's socket read size; keeps one release step's memcpy and fanout writes small (rule 2)                                                                                                                                           |
| `ABSORBER_LAGGARD_MS` (provisional)    | 500     | A healthy branch's congestion episode during catch-up lasts the time to drain its mark at faster than real time (under about 130 ms); 500 ms is about 4× that, while bounding siblings' extra latency                               |
| `LINK_GAP_MS` (provisional)            | 80      | About 70 % of the smallest effective branch buffering (about 110 ms), so every stall that can overflow a branch qualifies as link evidence                                                                                          |
| `HOST_LOOP_DELAY_MS`                   | 50      | 25 × the 2 ms rule-2 budget; a loop stall this long can by itself overflow a 256 KiB branch at 2.4 Msps (55 ms)                                                                                                                     |
| `CATCHUP_WINDOW_MS`                    | 500     | Longer than the observed catch-up bursts' arrival span; short enough not to merge bursts                                                                                                                                            |
| `LINK_QUALITY_WINDOW_MS`               | 600 000 | 10 min, as requested for burst-seconds; sixty 10 s slots                                                                                                                                                                            |
| `LINK_DROPPING_HOLD_MS`                | 60 000  | Same as `EFFICIENCY_CLEAR_MS`: one clean minute before the advisory relaxes                                                                                                                                                         |
| `LATE_SHED_WINDOWS` / `LATE_SHED_HITS` | 3 / 2   | Operator decision ("2 of 3 drop windows"); window = `EFFICIENCY_DROP_WINDOW_MS` (10 s)                                                                                                                                              |
| `LATE_SHED_COOLDOWN_MS`                | 30 000  | Three windows: the next judgement uses only post-shed evidence                                                                                                                                                                      |
| Loop meter resolution                  | 10 ms   | Node default; native sampling                                                                                                                                                                                                       |

## Budgets (performance rule 3)

Desktop reference host and Pi 4-class core host as in decoder-enablement (Pi estimated at 4 × the
reference cost per core until measured, requirement 9.4).

| Item                                 | When                                | Desktop 2.048 / 2.4 Msps                                            | Pi 4-class 2.048 / 2.4 Msps       | Basis                                                 |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------- |
| Recorder                             | per chunk (about 60–3 000 chunks/s) | ≤ 0.002 / 0.002 core                                                | ≤ 0.008 / 0.008                   | one clock read and a few integer ops per chunk; bench |
| Absorber pass-through                | per chunk, ring empty               | < 0.001 / 0.001                                                     | < 0.004 / 0.004                   | one length check and one congestion read              |
| Absorber hold                        | only while holding                  | ≈ 0.005 core active-period; ≈ 0.0003 averaged                       | ≈ 0.020 active; ≈ 0.0012 averaged | bench                                                 |
| Absorber release                     | only while draining                 | one 64 KiB alloc and memcpy per block; ≈ 0.003 core during catch-up | ≈ 0.012                           | bench                                                 |
| Fanout of released bytes             | same as today per byte              | unchanged                                                           | unchanged                         | existing fanout                                       |
| Loop meter                           | continuous                          | negligible                                                          | negligible                        | native histogram                                      |
| Attribution, late rule, link quality | every 2 s per source                | < 0.05 ms per sample                                                | < 0.2 ms                          | unit bench                                            |
| Total steady state                   |                                     | < 0.01 core                                                         | < 0.04 core                       | well below the 0.3-core noise floor                   |
| Event-loop p99 added                 |                                     | largest release step ≤ 256 KiB ≈ 0.2–0.6 ms                         | ≤ 1 ms                            | rule 2 cap 2 ms; acceptance 9.4                       |
| Memory                               | per network source                  | ring 8.2 / 9.6 MB; recorder < 64 KB                                 | same                              | preallocated                                          |

Main-thread bound: `ABSORBER_RELEASE_STEP_BLOCKS` caps each synchronous release at four
64 KiB blocks (256 KiB); remaining bytes resume on a later event-loop turn. No step is
proportional to the ring's size.

## Correctness properties

Each becomes a property test (`fast-check`, `numRuns ≥ 100`, 200 for the equivalence
properties) with the trace comment `// Feature: link-burst-resilience, Property N: <name>`.
Tests use fake fanout ports, fake branch consumers with scripted drain schedules and injected
monotonic clocks.

1. **Fanout backpressure equivalence.** For any chunk sequence and any consumer schedule, a real
   `FanoutManager` fed through `distribute` produces, per branch, the same output bytes and the
   same `droppedBytesTotal`, `droppedChunksTotal` and backpressure transitions as a reference
   oracle model of today's drop-on-congestion and startup-mark rules fed the same sequence; and a
   fanout fed by `attachSource` and one fed the same chunks by `distribute` are indistinguishable.
   Decoder-enablement properties 16 and 17 stay green unchanged. _Validates 1.7._
2. **Pass-through identity.** With capacity 0, or a loopback source, the router wires the stream
   with `attachSource` and every chunk reaches the fanout as the same `Buffer` object in the same
   tick. With capacity above 0, while the ring is empty and no gating branch is congested, every
   chunk is delivered as the same object in the same tick. _Validates 1.1, 1.3._
3. **Byte conservation and order.** For any chunk sequence, splits and consumer schedule, the
   concatenation of bytes delivered to the fanout equals the concatenation of ingested bytes with
   exactly the overflowed and flushed ranges removed, in order; overflowed ranges are tails of
   chunks that arrived while the ring was full; every delivered chunk is frame-aligned.
   _Validates 1.4, 1.6, 1.8._
4. **Chunk-split invariance.** For any byte stream and two different splittings with the same
   per-byte arrival times and consumer schedule, the delivered byte stream, overflow bytes and
   final counters are equal. _Validates 1.4 (performance rule 7)._
5. **Within capacity, no loss.** For any burst schedule where the held bytes never exceed
   capacity and every gating consumer drains faster than the source rate between bursts, no
   branch counter and no overflow counter rises. _Validates 1.4, 9.1._
6. **Laggard bound.** For any schedule with one consumer stuck while a sibling progresses, the
   stuck branch is excluded no later than `ABSORBER_LAGGARD_MS` plus one ingest after it
   congested; afterwards siblings receive every byte with no added delay beyond the release of
   what was held; a single active branch is never excluded. _Validates 1.5, 9.2._
7. **Attribution rules.** `attributeInterval` is total and deterministic; incomplete evidence is
   `unknown`; a strict subset with no overflow is `consumer`; `link` implies every rule of 3.4
   holds; a positive upstream delta with drops is never `link`; any null among gap, loop delay or
   shortfall never yields `link`; no drops is `none`. _Validates 3.1 to 3.7._
8. **Link neither condemns nor credits.** For any sample sequence, a probationer is never
   suspended for drops seen only in `link` samples, and no `link` interval adds coverage; drops in
   a `consumer`, `host` or `unknown` sample suspend the newest probationer exactly as the
   decoder-enablement gate does. _Validates 4.1, 4.2, 4.3._
9. **Clean window.** For any sequence, `cleanAtMono` is unchanged by `link` drops and is reset by
   every other positive drop; admission never happens while the newest sample is `link`.
   _Validates 4.4, 4.5._
10. **Late shed.** For any sample sequence with no probationer, a shed happens exactly when at
    least 2 of the last 3 complete windows condemn; it picks the most recently admitted eligible
    placement; never a YAML, `always` or operator-started placement; never for `link` or
    `unknown` windows; at most one per cooldown; the retry delay doubles up to the maximum.
    _Validates 5.1 to 5.5._
11. **Overflow is drop evidence.** Any absorber overflow makes the source's drop state
    `dropping` for the same windows a branch drop would, and appears in the link report's
    overflowed bytes. _Validates 1.6, 6.2._
12. **Report bounds.** For any arrival sequence, the 10 min stats cover only the last sixty
    slots, worst stall equals the largest recorded gap in them, p99 lies within one bucket of
    the exact p99, and the report contains no string other than ids and closed enums.
    _Validates 2.1, 6.2, 6.3, 6.5._
13. **Advisory.** Loopback stays `none`; a `link` drop within the hold makes a network source
    `dropping`; absorbed bursts without loss never change the level. _Validates 6.4, 6.6._
14. **Delivery hook.** For any config, `auto` and `raw` resolve to `raw`; `channels` fails
    validation; `iqDelivery.resolved` is always `"raw"`. _Validates 7.1, 7.2._

## Instrumentation first

The first deliverable is the recorder, the loop meter and a read-only `SourceLinkQuality`
(absorber fields report `enabled: false`), with `BURST_ABSORBER_DEFAULT_S` forced to 0 by a
build constant. On the live Wi-Fi path the record measures, at 2.048 and 2.4 Msps for at least
30 minutes each: the gap histogram and worst gaps, catch-up bytes per burst, chunk size
distribution, branch drop times against gap times (from the attribution log lines), and loop
delay. The record states whether `LINK_GAP_MS`, `ABSORBER_LAGGARD_MS` and the 2 s default stand,
and the commit that lands it flips the default on.

## Fake-link acceptance plan

- `scripts/capacity/fake_rtl_tcp.py` gains `--stall-schedule` (`offset_s:stall_ms,...`, relative
  to the previous stall) and `--stall-mode catchup|drop`. `catchup` withholds blocks for the
  stall and then sends them back to back (the observed clumping); `drop` skips them and reports
  them as upstream drops in its JSON line and in an optional rtlmux-shaped stats endpoint.
- A scratch compose project (`scripts/link-burst/`) runs the core and the fake in two containers
  on a private network, so the source is `network` without touching the live receiver's bridge
  ports or the live API port; the core's API port is ephemeral.
- Runs (each 10 minutes, at 2.048 and 2.4 Msps): interval schedule 9, 1, 130, 50, 40, 71, 161 s
  repeated; stalls 150, 500, 1 000, 1 800 ms (must be lossless) and 2 500, 4 000 ms (must be
  `link` overflow); a slow test consumer (`consumer`); CPU contention with `stress-ng` in the
  core container and a smooth link (`host`); `--stall-mode drop` (`unknown`); late-drop shedding
  with graduated placements and a sustained slow consumer.
- A bench (`scripts/bench/burst-absorber.ts`) measures the per-chunk, hold and release costs for
  the budget table, before and after.

## Live soak plan

On the current path (receiver on Ethernet, the core host on Wi-Fi, the LAN bridge into the
core), after the fake-link acceptance passes: 2 hours at 2.048 Msps, then 2 hours at 2.4 Msps,
with the default catalogue running. Recorded: branch and absorber drop percentages, burst
counts by stall length, attribution counts, sheds, advisory level history and the CPU of the
core. Pass: 0.00 % branch drops for every burst within capacity; every overflow attributed
`link`; no probationer suspended in a `link` interval; no shed while only `link` or `unknown`
drops occur. Results go in `docs/engineering/` with the commit that records them.

## Amendments to decoder-enablement

Each amended criterion gains an in-place note in
[decoder-enablement requirements](../decoder-enablement/requirements.md); numbers are unchanged.

- **4.1 (c):** "dropped a byte" and "the last drop" exclude drops attributed `link`
  ([link-burst-resilience](../link-burst-resilience/requirements.md) 4.4, 4.5).
- **4.4:** probation is judged on drops attributed `consumer`, `host` or `unknown`; a `link`
  interval neither condemns nor credits (4.1, 4.2). The sentence "Drops or CPU with no
  probationer suspend nothing" becomes: "Drops or CPU with no probationer close the gate for
  newcomers, log one warning per minute and show in the efficiency view; sustained `consumer`
  or `host` drops shed the newest eligible graduated placement (link-burst-resilience 5)."
- **5.4:** the open C+ clause is resolved by link-burst-resilience 3 and 5: late drops are
  attributed, and sustained `consumer` or `host` late drops shed.
- **11.2:** `DecoderEfficiencyDetail` gains `late-drops`.
- **Design:** property 6 ("No eviction") reads "a running placement is suspended by the gate only
  while on probation, as the newest probationer of its source, or by the late-drop rule"; the
  "Calls made" bullet on drops with no probationer points to link-burst-resilience 5.

## Calls made in this design (review these)

- Copying held bytes into a preallocated ring, with one allocation per released 64 KiB block
  while draining, rather than holding socket buffers by reference.
- Overflow drops the newest bytes that do not fit.
- A lone slow consumer is never excluded as a laggard; the ring fills and overflows, and the
  monitor attributes it.
- A measured upstream drop with core drops is `unknown`; an unmeasured upstream does not block
  `link` because the received-rate check stands in for it.
- `unknown` drops keep condemning probationers (today's rule) but never shed after graduation.
- Operator-started placements are never shed (decoder-enablement 4.8).
- `delivery: channels` is rejected until the later spec; `auto` is the default and resolves to
  `raw`.
- A local dongle served to a containerised core through the Docker host gateway is classed
  `network` by host literal and gets the absorber; set `burstAbsorber.seconds: 0` to opt out.
