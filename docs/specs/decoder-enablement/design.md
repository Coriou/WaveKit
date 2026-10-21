# Decoder enablement design (WG13)

Status: reviewed design, not implemented (2026-10-20). Requirements in
[requirements](requirements.md), tasks in [tasks](tasks.md). Background: the band suspension and
start pin ([band defaults](../../superpowers/specs/2026-10-09-decoder-band-defaults-and-override.md),
`assessEligibility` in `src/decoders/manager.ts`), the rate model and its serial caps worker
([rate addendum](../../superpowers/specs/2026-10-08-rate-model-instances-and-suspension.md)),
the channelizer prototype and its capacity report
([addendum](../../superpowers/specs/2026-10-09-core-channelizer-prototype-addendum.md),
[capacity](../../CAPACITY-2026-10-10-CHANNELIZER.md)), the WG8 decoder settings store
(`src/decoders/settings/`), the tuner controller (`src/core/tuner-controller.ts`) and the
performance rules ([PERFORMANCE](../../PERFORMANCE.md)).

## Overview

```
config decoders ─┐
catalogue ───────┼─> logical decoders ──(mode)──┐
settings store ──┘                              v
source windows, VFO, band-plan channels ──> placement planner (pure) ──> wanted placements
                                                                              │ ordered
fanout counters, CPU meter, cost table ──> efficiency gate ──────────────────>│ admit / block
                                                                              v
                       DecoderManager: primary instance + placement workers, serial caps worker
                                                                              │
              per-source engine (wavekit-chan) channels  <──── channel reach ─┤
              fanout raw branch (readsb, LoRa, YAML raw)  <──── raw / centre ─┘

REST retune ──> rate policy (1090 raise / restore) ──> tuner controller ──> link advisory
```

The planner and gate are pure and synchronous; the manager calls them from the existing serial
caps worker (`enqueueSourceEvaluation`), so every transition still runs in one place. Nothing in
this design writes a frequency.

## Contract (frozen by task 0.1)

| File                                                                  | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/api-types/src/decoders.ts`                                  | `DecoderMode` (`"auto" \| "always" \| "off"`); `DecoderModeSource` (`"settings" \| "config" \| "legacy-enabled" \| "legacy-band" \| "default"`); `DecoderPlacementView` (`sourceId`, `channelHz?`, `reach: "channel" \| "raw" \| "centre"`, `origin: "configured" \| "band" \| "vfo" \| "bandplan" \| "fallback"`, `primary`, `running`, `suspension?`, `efficiencyDetail?`, `costCores`, `probation?`); `DecoderEfficiencyDetail` (`"budget" \| "cpu" \| "drops" \| "unknown"`); `DecoderEfficiencyView` (an admitted placement's `detail` may be `"configured"` for a YAML decoder); `DecoderStatus.mode?`, `modeSource?`, `origin?: "config" \| "catalogue"`, `placements?`; `DecoderSuspensionReasonCode` gains `"efficiency-budget"`, `"decoder-unavailable"` |
| `packages/api-types/src/decoder-settings.ts`                          | `DecoderSettingsView.mode?: { value: DecoderMode; source: DecoderSettingSource }`; `DecoderSettingsUpdate.mode?: DecoderMode \| null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/api-types/src/tuner.ts`                                     | `TunerCommandOrigin` gains `"decoder-rate"`; `TunerRatePolicy` (`raisedFromHz`, `since`); `TunerState.ratePolicy?`; `TunerRatePolicyEventData` (`sourceId`, `action: "raised" \| "restored" \| "skipped"`, `reason: "adsb-1090"`, `fromHz`, `toHz`, `skipped?: "external-control" \| "rate-above" \| "write-failed"`, `link?: LinkAdvisory`); `LinkAdvisory` (`level: "none" \| "unproven" \| "dropping"`, `transport: "loopback" \| "network"`, `payloadBytesPerSecond`, `sustainedBytesPerSecond: number \| null`, `shortfallPercent: number \| null`, `upstreamDropBytesPerSecond: number \| null`)                                                                                                                                                             |
| `packages/api-types/src/resources.ts`                                 | `ResourceAlert.type` gains `"link-capacity"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/config.ts`                                                       | `DecoderConfigSchema.mode?`; `decoderPolicy?: { catalogue?: boolean; rateRaise?: boolean; efficiency?: { cpuBudgetCores?, cpuGuardPercent?, maxBandplanChannels? } }`; `ChannelizerConfigSchema.auto?: boolean`. All optional with no default filled in, so the parsed shipped config and its export are unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/decoders/enablement/contract.ts` (new)                           | constants below; `CATALOGUE_TYPES`; `CatalogueEntry`; `DECODER_COSTS`; `ResolvedMode`; `PlannerDecoder`, `PlannerSource`, `PlannerVfo`, `BandplanChannelLookup`, `WantedPlacement`, `PlacementPlan`, `PlacementPlanner`; `EfficiencySample`, `EfficiencyInputs`, `AdmissionDecision`, `EfficiencyGate`; `DecoderReach`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/core/rate-policy-contract.ts` (new)                              | `READSB_REACH_HZ`, `ADSB_FREQUENCY_HZ`, `LINK_*` constants; `RatePolicyPort`, `LinkAdvisoryInput`, `LinkAdvisor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/api/routes/decoder-rate-schemas.ts`, `decoder-status-schemas.ts` | the widened reason enum and the new optional status fields (Fastify drops unlisted fields)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cli/source/data/guards.ts`, `cli/source/view-models/decoders.ts`     | the alert type guard accepts `link-capacity`; reason words for `efficiency-budget` ("over the efficiency budget") and `decoder-unavailable` ("not installed")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Constants (with arithmetic, pinned by `tests/unit/decoders/decoder-enablement-contract.test.ts`):

| Constant                           | Value                    | Why                                                                                                       |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `channelizerAutoAccepted(arch)`    | `arch === "x64"`         | x86-64 accepted by the 2026-10-21 capacity record; arm64 pending a Pi 4-class run (requirement 5.4)       |
| `DECODER_MAX_BANDPLAN_CHANNELS`    | 4                        | 4 × (0.11 + 0.045) = 0.62 cores for dsd-fme band-plan channels, under half the 1.5 desktop budget         |
| `VFO_SETTLE_MS`                    | 1 000                    | a click-to-tune or drag settles before a channel moves; ≤ 1 channel move per second per decoder           |
| `EFFICIENCY_SAMPLE_MS`             | 2 000                    | counters sampled 5 times per drop window                                                                  |
| `EFFICIENCY_DROP_WINDOW_MS`        | 10 000                   | 5 samples; at 4.8 MB/s a single dropped 64 KiB chunk is 0.14 % of the window and is seen                  |
| `EFFICIENCY_CLEAR_MS`              | 60 000                   | six clean windows before newcomers are admitted again                                                     |
| `EFFICIENCY_PROBATION_MS`          | 30 000                   | three drop windows after a start; covers decoder warm-up (spawn, channel open ≤ 2 s)                      |
| `EFFICIENCY_RETRY_MS`              | 300 000, ×2 to 1 800 000 | at most 12 retries per hour after the first failure, then 2 per hour                                      |
| `EFFICIENCY_BUDGET_X64` / `_ARM64` | 1.5 / 0.75 cores         | design "Worst windows": max window C is 1.37 reference cores; 0.75 × 4 (Pi factor) = 3.0 of 4 Pi cores    |
| `EFFICIENCY_CPU_GUARD_PERCENT`     | 90                       | the scanner's `cpuGuardPercent` default, same meter                                                       |
| `CHANNELIZER_IDLE_STOP_MS`         | 60 000                   | a retune that briefly empties a source does not cycle the process                                         |
| `READSB_REACH_HZ`                  | 200 000                  | readsb detects the pulse envelope (magnitude); a 200 kHz offset keeps the 1 MHz main lobe inside ±1.2 MHz |
| `ADSB_FREQUENCY_HZ`                | 1 090 000 000            |                                                                                                           |
| `LINK_SUSTAINED_WINDOW_MS`         | 10 000                   | the source metric's averaging window                                                                      |
| `LINK_SHORTFALL_PERCENT`           | 1                        | above rtl_tcp jitter; 1 % at 4.8 MB/s is 48 KB/s, above the 10 KB/s upstream-drops alert                  |

## Catalogue (lane CM)

`buildDecoderCatalogue(configs: readonly DecoderConfig[], opts: { enabled: boolean }):
DecoderConfig[]` (pure, `src/decoders/enablement/catalogue.ts`) returns the YAML configs followed
by one entry per `CATALOGUE_TYPES` member that neither a YAML type nor a YAML id claims
(requirement 1.2). An entry is `{ id: type, type, enabled: true, options: CATALOGUE_DEFAULT_OPTIONS[type] }`
marked by a module-private `WeakSet` (no new `DecoderConfig` key, so the config export and
`effectiveConfig` stay unchanged); `isCatalogueConfig(config)` reads it. The frozen default
options use only adapter defaults: `acarsdec` frequencies 131 550 000 and 131 725 000 Hz,
`dumpvdl2` 136 650 000, 136 700 000 and 136 975 000 Hz (both today's adapter fallbacks),
`lora-meshtastic` region from the band region mapping, the others `{}`. Main composes it in
`src/index.ts` before `openDecoderSettingsService` and decoder creation, so settings views and
the manager see the same list.

Binary check (requirement 1.6): `resolveDecoderBinary(type, env)` (lane CM) stats the type's
executable on `PATH` once at startup. A catalogue instance without one is created with
`unavailable: true`; the manager reports it suspended (`decoder-unavailable`) and never spawns it.

## Mode (lane CM)

`resolveDecoderMode(input): { mode: DecoderMode; source: DecoderModeSource }` (pure,
`src/decoders/enablement/mode.ts`) applies the precedence of requirement 2.2. The settings store
entry gains `mode?: DecoderMode` (schema version stays 1; an older core ignores the key); the patch
policy accepts `mode` beside `enabled` and `options`; the view gains `mode`. The service gains a
manager-port call `applyDecoderMode(id, mode)` (implemented by lane MG), invoked after a
successful persist, so a mode change is live (requirement 2.5).

In the manager, mode maps onto existing mechanisms: `off` is `stopDecoder` plus
`desiredRunning = false` and `startAll` skips it; `always` is `bandSuspends = false` in
`assessEligibility` (durably, independent of `startMode`); `auto` is today's band suspension.

## Placement planner (lane PL)

`planPlacements(input: PlannerInput): PlacementPlan` (pure, `src/decoders/enablement/placement.ts`).

Inputs: every non-`off` configuration-owned decoder (`PlannerDecoder`: id, type, mode, start mode,
configured source, band requirements from the existing resolver, configured channels, reach
kind, channel bandwidth and transition from the adapter's channel request, unavailable flag);
every source (`PlannerSource`: id, centre, rate, usable fraction, scanner role, held, exclusive
reservation by another decoder, channelizer availability, configuration order); the VFO
(`PlannerVfo`: source id and frequency, or null); and `BandplanChannelLookup(sourceWindow,
protocols): number[]`.

Per decoder and eligible source (requirement 8.1), candidate channels come from requirement 3.3
to 3.5 and are kept when they fit the decoder's reach (requirement 3.2). The VFO and band-plan
channel lookups are adapters in lane PL (`src/decoders/enablement/channel-sources.ts`): the VFO
from a `LiveDemodulator` port (config `sourceId` and `offsetHz` plus the source centre); band-plan
channels from the band-plans service's resolved stack (`Band.channels`) filtered by the scanner
plan ranges' protocol lists, read from the effective scanner plan list
(`createScannerBandplanProvider` in `src/core/bandplans/scanner-feed.ts`, which equals
`bandplansFor(region)` under the default stack; import only, no scanner edit). Deduplication across sources follows requirement 8.2. The plan lists wanted
placements in admission order (requirement 4.2, 3.7) with their declared cost.

A YAML decoder without `useChannelizer: true` (the schema default is `false`, so an absent key and an
explicit `false` are the same), or a YAML decoder of a channel type while no
channelizer is available, gets exactly one placement on today's raw path with today's band
verdict, so its behaviour is unchanged. readsb with `rtlTcpHost` is external and never planned.

Adapter hook: `BaseDecoder.reach(): DecoderReach` (`"channel" | "raw" | "centre"`), derived from
`channelizerSupported()` for the audio and IQ bases, overridden to `"raw"` by readsb and
`"centre"` by lora-meshtastic. For LoRa the planner input's `centreSlotHz` is the configured
channel (`frequency ± bw/2`, the source centre with `followCenter`) and `centrePassbandHz` the
decimated span `bw × oversampling` bounded by the usable window (`fs × 0.8`), so LongFast at
869.525 MHz (EU) fits a source centred within 835 kHz of it at 2.4 Msps. Each placement worker is created with `channelHz` set to its
channel, so the adapters' existing `getChannelRequest` produces the channel unchanged (acarsdec
and dumpvdl2 already honour `channelHz`); multi-channel types get a `channelsHz` option descriptor
(dsd-fme, multimon-ng, direwolf) for configured channels.

## Manager integration (lane MG)

- **Primary and workers.** The decoder's existing `DecoderState` runs the primary placement. Each
  further placement is an internal `DecoderState` with owner `"placement"`, key
  `<id>#<channelHz>@<sourceId>`, created through the same spawn, wiring, rate-plan, crash-restart
  and channel paths as a configured decoder, excluded from `GET /api/decoders`, `decoder:created`
  and `decoder:removed`, and summarised in the parent's `placements[]`. Worker output is emitted
  under the parent id with the worker's frequency in the RF provenance (requirement 3.8). Worker
  log lines go into the parent's log ring with a `[<channelHz>]` prefix.
- **Eligibility order.** `assessEligibility` becomes: scanner hold, then `decoder-unavailable`,
  then rate, then mode and band (`always` and the operator pin skip the band term), then reach
  (`channelizer-unavailable` for a catalogue channel type without a channelizer), then the gate
  (`efficiency-budget`). Rate and band are still assessed for reporting.
- **Evaluation.** On every source evaluation the caps worker builds the planner input, plans,
  diffs wanted against running placements, asks the gate for each newcomer in order, then
  starts, retargets, suspends or ends placements. A primary whose placement moved is retargeted
  through the existing caps-change restart path. Triggers: caps change (today), mode change,
  band override, VFO change (after `VFO_SETTLE_MS`), band-plan change (`bandplans:changed`),
  channelizer availability change, gate re-check (`EFFICIENCY_SAMPLE_MS` tick when blocked
  placements exist).
- **Holds.** Scanner holds suspend workers exactly like their parent (`tuner-scanning`).

## Efficiency gate (lane EF)

`createEfficiencyGate(deps): EfficiencyGate` (`src/decoders/enablement/efficiency-gate.ts`, pure
decision core) and `createEfficiencyMonitor(deps)` (`efficiency-monitor.ts`, the sampler).

- The monitor samples every `EFFICIENCY_SAMPLE_MS`: per source, the summed
  `droppedBytesTotal`/`droppedChunksTotal` deltas of every fanout branch on that source
  (`SourceFanoutRouter` → `FanoutManager` branch telemetry, including the channelizer input
  branch), and the CPU meter's `normalisedPercent`. A read that throws or returns non-finite
  numbers yields `unknown` for that source. Evidence is per branch identity: the router keys
  counters `<branch id>#<instance>` (a re-added id is a new branch) and reports a removal epoch.
  The monitor keeps the last valid counters per branch across unreadable reads; a branch valid in
  two reads with non-decreasing counters contributes its positive delta, a branch added since the
  last read counts its first total, and a decrease, removal or epoch change loses only that
  comparability (the source is `unknown` for admission). A placement's own channelizer branch
  therefore never faults its probation. Probation (`droppedSinceMono`) sees only positive drop
  deltas at or after the admission mark, and is earned: coverage is the set of intervals between
  consecutive complete reads (every branch valid) at most 1.5 sample periods apart;
  `coverageCompleteAtMono` names the sample that completes `EFFICIENCY_PROBATION_MS` of it, and
  the gate graduates a placement (sticky) only when `droppedBetweenMono` and the CPU history show
  nothing in [admission, that sample]. Evidence time is strictly monotonic: a raw clock that goes
  back is offset to continue, and any discontinuity discards every source's coverage while drop
  times stay valid, while the clean window restarts. Unknown evidence closes admission but
  suspends nobody. CPU evidence is stamped with the evidence time of the sample it arrived with.
  Known bound: drop and CPU histories keep the latest 1024 samples (about 34 minutes), so
  evidence that would disqualify a placement can be evicted if probation evaluation stalls that
  long; in normal operation probation is evaluated every sample.
- At most one gated placement per source is on probation: an otherwise admissible newcomer waits
  (detail `unknown`, re-checked every sample without backoff) until the current probationer
  graduates or is suspended, so probation evidence is always attributable to one newcomer;
  admission order is unchanged. A placement's raw fanout branch is created deferred and receives
  data (and counts drops) only once its decoder has started and connected its input; the
  channelizer's input branch is already added only after `wavekit-chan` reports ready.
- Startup buffer: for `DECODER_BRANCH_STARTUP_MS` (5 s) after activation (one unref'd timer per
  activation, no clock read per chunk) a decoder's raw branch counts congestion only when its
  writable backlog exceeds max(normal mark, `DECODER_BRANCH_STARTUP_BUFFER_S` (1.5 s) of the
  source's byte rate); overflow beyond that still counts as drops. Frame size: the source's IQ
  frame (CU8 2, S16 IQ 4, float32 IQ 8 bytes) or 2 / 4 bytes per audio channel. When the period
  ends with a writable backlog at or above the normal mark, a startup-only refusal drops (and
  counts) new chunks until the stream is writable again with its writable backlog below the normal
  mark, checked on every chunk; a destroyed or ended stream stays refused. Normal backpressure and
  its accounting are unchanged for every branch. Memory bound per starting branch: the startup
  mark plus the normal mark on the readable side plus one source chunk and stream bookkeeping
  (CU8: 6.1 MB + 0.5 MiB at 2.048 Msps, 7.2 MB + 0.5 MiB at 2.4 Msps), held while its consumer
  lags; a consumer that stalls can keep that backlog beyond the 5 s, never more. One gated
  probationer per source means at most one catalogue startup branch per source at a time; YAML
  decoders also get the buffer at their start, so the worst case per source is (1 + YAML decoders
  starting together) such branches.
  An `unknown` admission records no backoff and returns the source's clear-window time
  (`cleanAtMono`, or one clear window from now without a clean run) as its retry.
- `admit(newcomer, running, sample, now): AdmissionDecision` implements requirement 4.1 to 4.4:
  budget sum, CPU limit, drop and clear windows, probation, retry backoff. It is the only place
  that decides; the manager applies.
- The gate governs catalogue decoders only (requirement 4.9). In `startPlacementNow` the manager
  admits a placement of a YAML decoder (origin `config`, whatever its mode) without calling
  `admit`, leaves it out of the list passed to `probation` and never applies a verdict to it. It
  stays in the running list given to `admit` and `view`, so its declared cost reduces catalogue
  headroom; `efficiencyView()` reports it as admitted with `probation: false` and
  `detail: "configured"`.
- Costs come from `DECODER_COSTS` (below). The channelizer base of a source is charged once while
  at least one decoder channel is open on it. The scanner keeps its own budget; a shared
  `wavekit-chan` is therefore charged by both, which over-counts (safe).
- `GET /api/decoders/efficiency` (route in `src/api/routes/decoders.ts`) serves the view.

## Channelizer routing and retune (lanes MG, CH)

`channelizer.auto` (absent means true) lets the manager ask the channelizer manager to start a
source's engine when a planned placement needs a channel there and `channelizerAutoAccepted`
holds for the host architecture (x86-64 accepted per
[the capacity record](../../engineering/CAPACITY-2026-10-21-DECODER-ENABLEMENT.md); arm64
pending; the C+ late-drop clause is deferred to the link-burst attribution design); the engine stops after `CHANNELIZER_IDLE_STOP_MS` with no channel. `channelizer.enabled:
true` keeps today's behaviour. Lane CH adds a `retune` request to the engine protocol
(`src/core/channelizer/protocol.ts`, `native/wavekit-chan`): new channel centre for an open
channel, phase-continuous NCO change, same output rate and taps (PERFORMANCE rule 5); a retune
outside the admission rule is refused and the caller closes and reopens instead.

## Rate policy and link advisory (lane RP)

`createRatePolicy(deps)` (`src/core/rate-policy.ts`) implements requirement 6. The tuner
controller gains an optional `beforeOperatorRetune(sourceId, hz, opts)` hook called by
`setFrequency` only when `opts.origin === "rest"` and before the existing
`proveSampleRateForFrequency` and frequency writes; the hook may write the rate with origin
`decoder-rate`. Readsb's state (mode, external device) comes from a manager port. The record per
source is in memory: `{ previousHz, since }`; an operator `POST /api/tuner/:sourceId/sample-rate`
clears it. Scanner (`scanner`), `config` and `replay` origins never reach the hook.

`createLinkAdvisor(deps)` (`src/core/link-advisory.ts`) keeps, per network source connection, the
highest 10 s average of the source's received byte rate (`SourceManager` metrics) observed while
the received rate was within `LINK_SHORTFALL_PERCENT` of `fs × 2`; a reconnect resets it. It
classifies per requirement 7.1 and reads the upstream drop rate from `SourceBackpressureTracker`
when available. `ResourceAggregator` emits the `link-capacity` alert. Loopback detection uses the
configured host literal only (no DNS).

## Worst windows (reference cores, 2.4 Msps, channelizer on)

Channel cost = 0.11 (marginal per channel) + decoder; channelizer base 0.26 per source.

| Window | Centre        | Placements                                                                            | Sum                                                   |
| ------ | ------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A      | 162.000 MHz   | AIS (0.21), dsd-fme VFO (0.155), multimon-ng VFO (0.14)                               | 0.26 + 0.21 + 0.155 + 0.14 = **0.765**                |
| B      | 433.920 MHz   | rtl_433 (0.21), dsd-fme VFO (0.155)                                                   | 0.26 + 0.21 + 0.155 = **0.625**                       |
| C      | 869.525 MHz   | LoRa raw (0.60), rtl_433 863–870 (0.21), dsd-fme VFO (0.155), multimon-ng VFO¹ (0.14) | 0.26 + 0.60 + 0.21 + 0.155 + 0.14 = **1.365**         |
| D      | 131.600 MHz   | acarsdec ×2 (0.32), multimon-ng VFO¹ (0.14)                                           | 0.26 + 0.32 + 0.14 = **0.72**                         |
| E      | 1 090.000 MHz | readsb raw (0.25)                                                                     | **0.25** (no channel, no base)                        |
| C+     | 869.525 MHz   | C plus four dsd-fme band-plan channels (4 × 0.155 = 0.62)                             | 1.985 > 1.5: the four channels are blocked (`budget`) |

¹ only when a configured or imported band plan lists pager channels there; counted to bound the
worst case. At 2.048 Msps the channelizer base is 0.22, so every channel window is 0.04 lower.

## CPU and IO budgets

Desktop reference: the capacity report's host (Intel i5-1038NG7, 4 cores). Pi 4-class: Cortex-A72
at 1.5 GHz, estimated at 4 × the reference cost per core (unmeasured; the acceptance in task MA.4
measures it).

| Item                                        | Where / when                                             | Desktop 2.048 / 2.4 Msps                                                               | Pi 4-class 2.048 / 2.4 Msps | Basis / check                              |
| ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------ |
| Raw fanout branch                           | per raw placement, per chunk                             | memcpy 4.10 / 4.80 MB/s; < 0.01 core                                                   | < 0.04 core                 | existing fanout                            |
| Channelizer base                            | per source with ≥ 1 channel                              | 0.22 / 0.26                                                                            | 0.88 / 1.04 (estimate)      | capacity report N = 1, measurement         |
| Channel marginal                            | per channel                                              | 0.11 / 0.11 ((0.56 − 0.22) / 3 at 2.048, (0.55 − 0.26) / 3 = 0.097 at 2.4, rounded up) | 0.44                        | capacity report N = 1 → 4, measurement     |
| AIS-catcher on channel                      | per placement (384 kHz)                                  | 0.10                                                                                   | 0.40                        | capacity report (0.32 − 0.22), measurement |
| rtl_433 on channel                          | per placement                                            | 0.10                                                                                   | 0.40                        | scanner `CPU_COST`, estimate               |
| dsd-fme / multimon-ng / direwolf on channel | per placement (48 kHz audio)                             | 0.045 / 0.03 / 0.05                                                                    | 0.18 / 0.12 / 0.20          | scanner `CPU_COST`, estimate               |
| acarsdec on channel                         | per placement (24 kHz)                                   | 0.05                                                                                   | 0.20                        | estimate                                   |
| dumpvdl2 on channel                         | per placement (1.05 MHz)                                 | 0.15                                                                                   | 0.60                        | estimate                                   |
| readsb raw                                  | per placement, 2.4 Msps only                             | 0.25                                                                                   | 1.00                        | estimate                                   |
| lora-meshtastic raw                         | per placement                                            | 0.60                                                                                   | 2.40                        | estimate (csdr decimation + gr-lora)       |
| Planner                                     | per evaluation (≤ 1 per 300 ms debounce, per VFO settle) | ≤ 9 decoders × 4 sources × 7 channels = 252 candidates; < 0.1 ms                       | < 0.5 ms                    | unit bench, main thread                    |
| Efficiency monitor                          | every 2 s                                                | ≤ 64 branches read; < 0.05 ms                                                          | < 0.2 ms                    | unit bench                                 |
| Link advisor                                | per source metric tick (1 s)                             | one comparison; negligible                                                             | negligible                  |                                            |
| Main thread                                 | total                                                    | ≪ 2 ms event-loop p99 (PERFORMANCE rule 2)                                             | same                        | live acceptance                            |

Budget arithmetic: on desktop, window C (1.365) fits 1.5 with 0.135 to spare; on a Pi 4-class
host 0.75 reference cores × 4 = 3.0 Pi cores of 4 (75 %, below the 90 % guard), so in window C the
admission order (readsb, AIS, acarsdec, dumpvdl2, rtl_433, direwolf, multimon-ng, dsd-fme, LoRa)
admits base 0.26 + rtl_433 0.21 + multimon-ng 0.14 = 0.61, blocks dsd-fme (0.765 > 0.75) and LoRa,
and reports both as `efficiency-budget` (`budget`). IQ link payloads: 1.024 Msps = 2.048 MB/s
(today's Wi-Fi receiver), 2.048 Msps = 4.096 MB/s, 2.4 Msps = 4.8 MB/s.

## Calls made in this design (review these)

- Readsb raw reach is ±200 kHz around 1 090 MHz (`READSB_REACH_HZ`), not the full window.
- A REST retune is the only raise trigger; a relay client in external control is never
  overridden (advice only), because the relay client owns the radio and its display.
- The raise never lowers a rate above 2.4 Msps; readsb then uses its existing adaptation.
- Catalogue channel decoders do not fall back to a full-rate raw branch (PERFORMANCE rule 6);
  before the capacity acceptance they show `channelizer-unavailable`. YAML decoders keep their raw
  fallback.
- Band-plan channels are `Band.channels` of the resolved stack (built-in packs have none), with
  the protocol taken from the scanner plan range covering the channel.
- Probation suspends only the newest placement; drops with no probationer close the gate but
  suspend nothing.
- An operator pin on a built-in (catalogue) decoder is still subject to the gate (ordered first); a
  YAML decoder is never gated (requirement 4.9).
- Default budgets 1.5 (x86-64) and 0.75 (arm64 ≤ 4 cores) reference cores.

## Correctness properties

Each becomes a property test (`fast-check`, `numRuns ≥ 100`) with the trace comment
`// Feature: decoder-enablement, Property N: <name>`.

1. **Catalogue completeness.** For any YAML decoder list, the catalogue output contains the YAML
   entries unchanged and in order, plus exactly one entry for each catalogue type no YAML type or
   id claims, and no duplicate id. _Validates 1.1, 1.2, 1.5._
2. **Mode precedence.** For any combination of settings `mode`/`enabled`, YAML `mode`/`enabled`,
   band `bandSuspension` and API override, the resolved mode follows 2.2; `off` never yields a
   running placement. _Validates 2.1, 2.2, 2.3._
3. **Always skips only the band.** For any caps, an `always` decoder is never suspended with
   `frequency-out-of-band`, and is suspended exactly when an `auto` decoder with the same inputs
   would be for a hold, rate, unavailable or gate reason. _Validates 2.1, 3.9._
4. **Reach is honest.** Every planned placement satisfies its reach rule (3.2) on its source; a
   channel that satisfies it and passes the mode and band terms is planned unless a cap or
   deduplication removes it. _Validates 3.2, 3.3._
5. **Channel sources.** Placements of dsd-fme and multimon-ng are exactly the configured, VFO
   (in range) and up to 4 band-plan channels whose plan range lists a decoder protocol, in the
   order of 3.7. _Validates 3.4, 3.5, 3.7._
6. **No eviction.** For any sequence of samples, admissions and plans, a running placement is
   suspended by the gate only while on probation, and only the newest probationer of its source.
   _Validates 4.3, 4.4._
7. **Budget bound.** After every admission, the sum of declared costs of admitted placements is at
   most the budget, and admission follows 4.2 order (no later placement admitted while an earlier
   one fits and is blocked). _Validates 4.1, 4.2._
8. **Unknown is never drop-free.** Any unreadable or non-finite counter sample closes the gate for
   its source and reports `unknown`; a null CPU reading never reports a percent. _Validates 4.6._
9. **Raise and restore.** For any sequence of REST retunes, operator rate writes, scanner hops,
   relay commands and readsb mode changes, the rate policy writes 2.4 Msps exactly on a REST
   retune into reach with readsb not off, internal control and a lower rate; restores exactly the
   recorded rate on the next REST retune out of reach; writes nothing for other origins; and never
   writes a frequency. _Validates 6.1 to 6.4, 10.1._
10. **Link advisory.** Loopback is always `none`; a network source whose sustained rate is
    unknown or below the payload is never `none`; measured shortfall or upstream drops give
    `dropping`. _Validates 7.1, 7.3._
11. **One instance per channel.** For any set of fake sources, roles, holds and reservations, each
    (decoder, channel) is placed on at most one source, chosen by 8.2; dedicated and
    exclusively reserved sources only by explicit `sourceId`. _Validates 8.1 to 8.3._
12. **Live mode.** For any sequence of PATCHes, the running state after each successful PATCH
    matches the new mode without a restart, and the store revision rules are unchanged.
    _Validates 2.4, 2.5._
13. **VFO follows.** For any sequence of VFO changes, the dsd-fme VFO placement's channel equals
    the last VFO frequency held for at least `VFO_SETTLE_MS`, with at most one move per settle
    period. _Validates 3.5, 5.5._
14. **Identify is never excluded by priors** (verified on the scanner side, task ID-F.1). For any
    band plan and target without a user-typed list, the trial set equals the set with no band
    plan. _Validates 9.1._
