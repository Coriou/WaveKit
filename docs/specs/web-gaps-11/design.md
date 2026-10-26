# Web gaps 11 design (WG11)

Status: implemented (checkpoint open, see [tasks](tasks.md)); the contract below is as frozen.
Requirements in [requirements](requirements.md), tasks in [tasks](tasks.md). Background: the
WG7/WG9/WG10 identify runner (ambient trials, unavailable memo, analog evidence), the § 6.4 probe
pool and its transports, the § 7 discovery store and its journal and snapshot (with the WG10 backlog
bound), the § 10.7 passive cost check, the WG5/WG9 tuner controller and reconnect restore, the
spectrum pipeline tracker, and the `wavekit-chan` native channelizer crate.

## Contract (frozen)

| File                                                 | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`                  | `ScannerTrialOutcome` gains `"heard"`; `ScannerIdentifyTrial.transport` and `ScanJobProbe.transport` gain `"replay"`; `ScannerSettingsValues.passive.maxEngineUtilization?`; `ScannerSettingsValues.iqCapture?` (`ScannerIqCaptureSettings`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/api-types/src/spectrum.ts`                 | `SpectrumFrameTrack` (the frame track, now named) with optional `trackId`, `snrDb`, `peakDbfs`, `blocks`, `ageMs`, `surfaced`, `scanner` (`SpectrumFrameTrackScanner`) and `flags.spur?`; `SpectrumFrameEventData.tracks: SpectrumFrameTrack[]`; `SPECTRUM_FRAME_TRACK_MAX_EXTRA_BYTES` (260)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/api-types/src/tuner.ts`                    | `TunerCommandOrigin` gains `"config"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/config.ts`                                      | `SourceTunerConfigSchema` and `SourceConfigSchema.tuner?`; `ScannerConfigSchema.passive.maxEngineUtilization?`; `ScannerConfigSchema.iqCapture?` (`enabled` false, `maxTotalMb` 256, `maxCaptureMs` 4 000, `preRollMs` 500, `binaryPath` `wavekit-iqcap`). All optional with no default filled in at the parent, so the parsed shipped config is unchanged                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/scanner/passive-cost-contract.ts` (new)    | `PASSIVE_COST_LIMIT_DEFAULT` (0.25), `PASSIVE_COST_WINDOW_MS` (60 000), `PASSIVE_COST_RECHECK_MS` (300 000), `PASSIVE_COST_CLEAR_RATIO` (0.8), `PassiveCostInput`, `PassiveCostDecision`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/core/scanner/iq-capture-contract.ts` (new)      | `IQ_CAPTURE_RATE_HZ` (48 000), `IQ_CAPTURE_BYTES_PER_SAMPLE` (8), `IQ_CAPTURE_MAX_MS` (4 000), `IQ_CAPTURE_MAX_BYTES` (1 536 000), `IQ_CAPTURE_TOTAL_MAX_BYTES` (256 MiB), `IQ_CAPTURE_ORPHAN_TTL_MS` (10 min), `IQ_CAPTURE_PREROLL_MAX_MS` (2 000), `IQ_CAPTURE_MAX_CONCURRENT` (2), `IQ_CAPTURE_PER_SOURCE_PER_MINUTE` (6), `IQ_CAPTURE_DIR` (`iq-captures`), `IQ_CAPTURE_FILE_PATTERN`, `IQ_CAPTURE_CONTROL_LINE_MAX_BYTES` (4 096), `IQ_REPLAY_MAX_PROBES` (1), `IQ_REPLAY_PROBE_CORES` (0.15), `IDENTIFY_REPLAY_MAX_CAPTURES` (2), `IQ_REPLAY_MAX_TRIALS` (8), `IqCaptureView`, `IqCaptureRequest`, `IqCaptureRefusal`, `IqCaptureDiscardReason`, `IqCapturePort`, `IqReplayPlanInput`, `IqReplayTrial`, `IqReplayPlanner`, `IqReplayResult`, `IqReplaySink` |
| `src/core/scanner/known-protocol-contract.ts` (new)  | `KNOWN_PROTOCOL_MAX_MISSES` (2), `KnownProtocolMemory`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/core/spectrum/track-identity-contract.ts` (new) | `SpectrumTrackIdentityLookup`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `src/core/scanner/probes/probe-pool.ts`              | `ProbeTransport` gains `"replay"` (type only; no behaviour)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cli/source/data/scanner-guards.ts`                  | trial outcome enum gains `heard`; trial and probe transport enums gain `replay` (with `tests/unit/cli/scanner-guards.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`tests/unit/core/wg11-contract.test.ts` pins every constant with its arithmetic, the widened
unions (outcome, transports, command origin), the frame track shape and its CLI guard acceptance
(every new field present, 256 tracks still accepted), the CLI identify guard accepting `heard`
and `replay`, the config shapes (absent keys parse to the frozen output; bounds; `manual` needs
`gainDb`; `agc` refuses it), the capture file grammar (accepted and refused names) and the port
shapes. `wg7-contract`, `wg9-contract` and `wg10-contract` are amended where they pinned the old
unions.

Names a lane creates and Main consumes at merge (frozen here by name):

- ID: `narrowRasterAt(ranges: readonly ScanRange[], hz: number): boolean` (pure) in new
  `src/core/scanner/narrow-digital.ts`; `IdentifyDeps.narrowRasterAt?: (hz: number) => boolean`
  (absent: no narrow trials added, today's plan); `IDENTIFY_NARROW_DIGITAL_MIN_SCORE` (0.3) in
  `identify.ts`; `createKnownProtocolMemory(deps: { discovery: (id: string) => { protocol:
ScannerProtocol; confidence: ScannerConfidence } | undefined }): KnownProtocolMemory` in new
  `src/core/scanner/known-protocol.ts`; `IdentifyDeps.knownProtocols?: KnownProtocolMemory` and
  the same optional dep on the job driver deps (absent: today's order, no miss counting);
  `planReplayTrials(input: IqReplayPlanInput): IqReplayTrial[]` (pure, an `IqReplayPlanner`) in new
  `src/core/scanner/replay-plan.ts`.
- SC: `DiscoveryStore.countsByJob(jobId: string): Record<ScannerConfidence, number>`;
  `ScannerPersistence.writeSnapshotOf(store: DiscoveryStore): Promise<void>` (worker path, falls
  back to `writeSnapshot(store.snapshot())`); worker entry `src/core/scanner/store/snapshot-worker.ts`
  (built to `dist/snapshot-worker.js`); `passiveCostDecision(input: PassiveCostInput):
PassiveCostDecision` in new `src/core/scanner/passive-cost.ts`.
- GN: `TunerController.setConfiguredTuning(sourceId: string, tuner: SourceTunerConfig |
undefined): void`; `configuredTuningFrames(tuner: SourceTunerConfig): ReadonlyArray<readonly
[command: number, value: number]>` (pure) in new `src/core/tuner-config-gain.ts`.
- TR: `SpectrumService.setTrackIdentityLookup(lookup: SpectrumTrackIdentityLookup | null): void`;
  scanner side `ScannerService.trackIdentity(sourceId: string, trackId: string):
SpectrumFrameTrackScanner | null` (exact Main diff).
- IQ: `createIqCaptureService(options): IqCaptureService` (implements `IqCapturePort`, plus
  `start()`, `stop()`, `sweep()`) in new `src/core/iq-capture/service.ts`;
  `createReplayTransport(port: IqCapturePort): TransportStrategy` in new
  `src/core/scanner/probes/replay-transport.ts`; `IdentifyDeps.iqCapture?: IqCapturePort` and
  `ProbeRequest.replay?: { captureId: string }` (exact diffs to lane ID's files, applied after ID
  merges); `createIqReplayQueue(deps: { port, probes, planner: IqReplayPlanner, sink:
IqReplaySink, planInput, now?, logger }): IqReplayQueue` in new
  `src/core/iq-capture/replay-queue.ts`; `ScannerServiceDeps.iqCapture?: IqCapturePort` and the
  scanner-side sink `ScannerService.applyReplayResult(result: IqReplayResult): void` (exact diff);
  binary `wavekit-iqcap` (`native/wavekit-chan/src/bin/wavekit-iqcap.rs`).

Every DTO addition is optional or a widening the CLI guards accept after the contract commit; no
WebSocket event type is added; no route is added.

## Pipeline positions

```
identify tick → analogStep (closed match: decoded with tone/DCS, else heard; ends only waiting
  analog trials) → probe runs continue → finishTarget when every trial ended
identify plan → identifyScores (+ narrow digital at a ≤ 6.25 kHz raster, floor score 0.3 × prior)
  → known protocol first → planIdentifyTrials → ambient → analog → [claimed captures: replay
  trials after the live runs] → memo → result → settle (discard) the claimed captures
POST /api/scanner/jobs/:id/cancel → requireJob → ended? 200 unchanged : lifecycle(cancel)
maintenance (1 s) → passive cost: first check at open + 60 s, then every 300 s →
  passiveCostDecision → disable | clear | keep → refreshPassive
engine track → ScannerService ingest → DiscoveryStore.ingest (index lookup, cached median,
  field-wise change test, one journal line) → journal append → mirror message to snapshot worker
snapshot timer / hole → writeSnapshotOf(store) → worker builds text from its mirror → write+fsync
progress (≤ 2 Hz per job) → countsByJob (O(1))
rtl_tcp session first payload → synchronizeOnConnect: [config frames for fields not accepted in
  this process, internal control only] → restore of accepted fields → caps reconcile
worker block → tracker associates segments → BlockTrack + track fields → summary wire →
  spectrum-service frame (+ scanner identity lookup) → spectrum:frame
engine tap (main thread, CU8, absolute samples) → wavekit-iqcap stdin (ring ≤ 2 s) ;
  track surfaced (below classified) | identify target → capture request (fd 3) → NCO + decimate →
  <uuid>.cf32 → replay queue (FIFO) → planReplayTrials (known first) → one replay probe at a
  time (replay transport → wavekit-iqcap replay, filtered to the decoder shape → decoder input,
  no fanout) → first accepted decode or all trials ended → IqReplayResult → applyReplayResult
  (evidence / undecoded reason, known-protocol memory) → discard
live probe or identify decode on the observation → confirmLive → unreplayed captures discarded
no result 10 min after capture end → orphan discard
```

## CPU and IO budgets

| Item              | Position                                     | Budget                                                                                                                                                                                                                                          | How measured                                  |
| ----------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| ID heard / analog | per identify tick                            | unchanged O(32) evidence scan                                                                                                                                                                                                                   | by construction                               |
| ID narrow digital | per identify plan                            | O(ranges); ≤ 3 more trials, ≤ 2 more runs (nxdn48, dpmr; dstar shares a dsd-fme `auto` run when its mode key matches)                                                                                                                           | counted runs in tests                         |
| ID cancel ended   | per request                                  | O(1), no write                                                                                                                                                                                                                                  | counted persistence calls                     |
| SC passive cost   | every 300 s per source                       | one utilization read                                                                                                                                                                                                                            | by construction                               |
| SC ingest         | per observation                              | ≤ 50 µs mean at 10 000 discoveries on one source (today: a scan of every source discovery with a 64-sample median sort each, and two whole-record stringifies)                                                                                  | bench, before/after, load average             |
| SC counts         | per progress build (≤ 2 Hz per job)          | O(1) (today: a paged list of every job discovery with a clone each)                                                                                                                                                                             | bench                                         |
| SC snapshot       | per snapshot (interval or hole, ≥ 1 s apart) | main thread ≤ 5 ms at 10 000 discoveries + 50 000 observations; worker heap ≤ 2 × snapshot text                                                                                                                                                 | bench, heap reported                          |
| SC journal        | per change                                   | one stringify of the changed records (the journal line); mirror message is that line                                                                                                                                                            | by construction                               |
| GN connect        | per new connection                           | ≤ 3 extra rtl_tcp commands (5 bytes each)                                                                                                                                                                                                       | counted writes                                |
| TR frame          | per frame per profile group                  | O(tracks) copies + one Map lookup per track; ≤ 260 B JSON per track (`"trackId":"…"` ~30, `"snrDb"`/`"peakDbfs"` ~30, `"blocks"`/`"ageMs"` ~25, `"surfaced"` ~16, `"spur"` ~13, `"scanner":{…}` ~110, separators)                               | serialized size test, frame build bench       |
| TR worker         | per block                                    | O(segments) association already done by the tracker; fields copied                                                                                                                                                                              | by construction                               |
| IQ ring           | per tap chunk                                | memcpy at 2 × fs bytes/s (4.1 MB/s at 2.048 Msps); ring ≤ 2 s × fs × 2 B (8.2 MB at 2.048 Msps, 12.8 MB at 3.2 Msps)                                                                                                                            | native bench, RSS                             |
| IQ capture DSP    | per active capture (≤ 4 s, ≤ 2 at once)      | one NCO + decimation channel (≈ 0.1–0.2 core on the Mac reference, as one `wavekit-chan` channel)                                                                                                                                               | native bench at 2.048 / 2.4 Msps              |
| IQ tap feed       | per tap chunk, main thread                   | one pipe write (no copy beyond the existing tap buffer); drop with a counted gap above 1 MiB queued                                                                                                                                             | counted gaps, event-loop p99                  |
| IQ disk           | per capture                                  | discarded at its result; orphans after 10 min ⇒ at most 60 per source (92 MB) without a drain. ≤ 1 536 000 B (4 s × 48 000 × 8 B); 6 per minute per source ⇒ ≤ 9.2 MB/min; 256 MiB ⇒ 174 captures                                               | store tests at the cap                        |
| IQ replay         | per replay probe (≤ 1 at once)               | filter at 48 kHz, faster than real time; probe cost `IQ_REPLAY_PROBE_CORES` 0.15 in the budget                                                                                                                                                  | wall time per decoder, reported               |
| IQ queue          | per capture                                  | ≤ 8 replay trials, one replay probe at a time, known protocol first (typically 1 trial when known); unknown signal ≈ 8 × (replay ≤ 1 s + start ≈ 0.5 s) ≤ 12 s ⇒ ≥ 5 captures/min drained; backlog bounded by the 10 min orphan TTL and the cap | queue drain rate with fake decoders, reported |

## Identify and scan quality (lane ID)

**Heard** (1.1): `analogStep` sets `decoded` when the newest matching closed transmission (the
one `analogResultOf` reports) has `ctcssHz !== null || dcs !== null`, `heard` otherwise. The
verdict input (`IdentifyVerdictAnalog`) is unchanged. `heard` joins the trial outcomes that
are final (never reset by a later tick).

**Analog does not stop digital** (1.2): `analogStep` no longer calls `endAmbient(t,
"not-needed")`; a match ends only the other `live-audio` trials still running (they cannot add
evidence). `tryStep` finishes the target when no run is active, none is left and no ambient or
live-audio trial is running (today's rule). The WG10 settle wait is unchanged.

**Narrow digital** (1.3): `narrowRasterAt(ranges, hz)` is true when a range of the active region
containing `hz` lists a raster with `spacingHz ≤ 6250`. `identifyScores` takes an optional
`narrow: boolean`; when true it adds the `fsk4-6k25` hypotheses (`nxdn48`, `dpmr`) and the
`gmsk-narrow` one (`dstar`) at `max(h.score × weight, IDENTIFY_NARROW_DIGITAL_MIN_SCORE)` before
the prior, unless the request's protocol list excludes them. Main's scanner-service diff passes
`narrowRasterAt: hz => narrowRasterAt(ranges, hz)` into the runner deps next to `priorsAt`. The
lane reports the plan for a 12.5 kHz analog-looking track at a 6.25 kHz raster (runs, holds,
start latency) against the 15 s default and fixes the order if a narrow run would not start in
time.

**Known protocol** (1.7, 1.8): `createKnownProtocolMemory` answers `known(id)` from the store's
discovery (`protocol` when `confidence === "decoded"`) unless the in-memory miss count (a
bounded `Map`, at most the store's discovery cap, entries dropped on `forget`) reached
`KNOWN_PROTOCOL_MAX_MISSES`. Identify: when the resolved discovery has a known protocol, its
probe mode's run moves first (stable order otherwise). A known trial counts a miss only when it
ran its full hold (not cut short, not unavailable, not `cancelled`) and decoded nothing; any
accepted decode on the discovery resets it. The job drivers count misses and decodes of their
live probes the same way (the passive job's reconfirm probes included). `planReplayTrials`
builds a capture's trials: the known protocol's mode first (`known: true`), then the modes
`identifyScores` gives the captured track (priors, narrow raster), deduplicated by mode key, at
most `IQ_REPLAY_MAX_TRIALS`; without a track, the known protocol alone, else the probe modes of
the capture's band priors (`priors > 0`).

**Band-scan DMR** (1.4): investigation order: (a) `ProbePool.admit` deferrals for a sweep job
(`cpuGuardPercent` 90 against the container's normalised CPU, `cpuBudgetCores` 1 with the engine
cost, `maxProbes.offset` 1) and what `undecodedForDeferral` records; (b) whether the sweep's hop
dwell covers the DMR probe hold (1 800 ms late entry) plus start latency, or the probe is
stopped by the hop (`cancelled`, no verdict); (c) the protocol plan for the sweep's ranges
(`protocols.ts`, priors) and the probe modes for `tdma-ms` / `fsk4-12k5`; (d) the spectral
class of a synthetic DMR burst train (two-slot TDMA, 30 ms on / 30 ms off, 9 kHz OBW) at the
sweep's integration (`acf30`/`acf60` thresholds); (e) `ladderOf` (a spectral tier never goes
above `candidate`; the web's "Heard" is `activity`). The lane reproduces with a synthetic track
stream and a fake probe pool, names the cause(s) with evidence, fixes those in its files, and
delivers exact diffs for others.

**Clean stop** (1.6): in `JobDriver.dispatch` (job-runner) a `cancel` on an ended record returns
without a transition, an action, an event or a persistence write; `transition` keeps its INVALID
for pause/resume. If `ScannerService.lifecycle` must skip `arbitrate`/`updateMasks` for it, that
is an exact diff (both are idempotent today; the lane verifies with counted calls).

## Passive cost and scanner store CPU (lane SC)

**Passive cost** (2.x): `passiveCostDecision({ utilization, limit, disabled, sinceOpenMs,
sinceLastCheckMs })` returns `disable` (enabled, utilization > limit, first check due or recheck
due), `clear` (disabled, utilization ≤ limit × 0.8, recheck due), else `keep`; null utilization →
`keep`. Main's diff replaces `costChecked` (once per engine) by a per-source last-check time and
reads the limit from `settings().passive.maxEngineUtilization ?? PASSIVE_COST_LIMIT_DEFAULT`.

**Index and medians** (3.1, 3.2): per source and family, an array of `{ centreHz, id }` sorted by
the cached median centre; updated when a discovery is created, removed, merged, re-sourced or its
median changes (only on its observation list change). `stickyMatch` binary-searches `[centre −
tol, centre + tol]` and applies today's tie-break among the hits.

**Counts** (3.3): a `Map<jobId, counts>` updated on every confidence change, job id attach and
discovery removal; `countsByJob` returns a copy. Property against the full recount.

**Change detection** (3.4): a per-record revision counter bumped by every mutating helper (the
store already funnels mutations through a few helpers) replaces `JSON.stringify` before/after;
`finish()` stringifies each changed record once for the journal line and does not clone.

**Snapshot worker** (3.5): the store emits the journal entries it writes (`seq`, discoveries,
observations, removed ids) to a mirror sink; trims and evictions that change the snapshot set
without a journal entry also emit a mirror removal. The worker applies them in `seq` order to
`Map<id, text>` and, on a snapshot request carrying `lastSeq`, the small parts (corrections,
prepared recording operations, aliases) and `savedAt`, writes the same text today's
`writeSnapshot` would (records sorted by id / `compareObs`, same key order) to the temporary
file, fsyncs and renames as today, and acknowledges. The main thread sees only the
acknowledgement. Divergence guard: the request carries the record counts; a mismatch fails that
snapshot to the main-thread path and resets the mirror from a full `snapshot()` once.

## Gain and AGC on connect (lane GN)

`configuredTuningFrames(tuner)` maps the config to `[SET_GAIN_MODE, manual ? 1 : 0]`, then (manual)
`[SET_GAIN, round(gainDb × 10)]`, then (when given) `[SET_AGC_MODE, agcMode ? 1 : 0]`.
`setConfiguredTuning` stores them per source and applies them to the baseline fields (so status
and the `reset` policy return to them). `synchronizeOnConnect`, before the replay plan: when the
control mode is internal, writes each configured frame whose field is not a desired (accepted)
field, marks it written on this connection, emits `command-sent` with origin `config`, and logs
one info line with the command names. Desired fields keep precedence (written by the replay plan
as today). Under `reset` the accepted fields are discarded first, so the configured ones are
written. A write failure is today's restore failure. Main calls `setConfiguredTuning` for each
configured `rtl_tcp` source right after `initializeSource` in `src/index.ts` and warns once for
`tuner` on another source type.

## Stable tracks on frames (lane TR)

The tracker already maps each segment of a block to an open track (or opens one). The pipeline
records, per emitted `BlockTrack`, the track id and its running stats from that same block
(`snrDb`, `peakDbfs` rounded to 0.5 dB, `blocks`, `ageMs` = (lastSample − startSample) / fs,
`flags.spur`, and `surfaced` by the display rule of requirement 5.1); `summary-wire.ts` carries
them across the worker boundary (absent fields stay absent). `spectrum-service` copies them into
the frame and adds `scanner` from the lookup when it returns an identity for `(sourceId,
trackId)`; the lookup is called once per track per frame group, guarded by try/catch (fixed-text
debug once per minute). The scanner's `trackIdentity` reads its live observation map (track id →
observation → discovery id → protocol and confidence); only a live observation of the same source
counts.

## IQ capture and replay (lane IQ)

**Native tool** (`wavekit-iqcap`, second binary of the `wavekit-chan` crate, sharing its DSP
modules; no new crate dependency): `wavekit-iqcap run --sample-rate <hz> --ring-ms <≤ 2000>
--out-dir <dir> --max-ms <≤ 4000>` reads CU8 on stdin, JSON-line commands on fd 3 and writes
JSON-line events on fd 4 (the lane may mirror `wavekit-chan`'s fd convention instead; it
documents the choice). Commands: `capture { id, offsetHz, fromSample, maxMs }` (sample numbers
in the tool's own count, which the bridge maps from engine samples), `end { id }`, `gap {
samples }`, `flush` (epoch change: aborts open captures, clears the ring), `shutdown`. Events:
`ready`, `captured { id, samples, gapSamples }`, `aborted { id, reason }`, `error { code }`.
Files are written as `<id>.cf32.tmp` and renamed on completion; the tool never writes outside
`--out-dir` and refuses ids outside the uuid grammar. `wavekit-iqcap replay --in <file>
--bandwidth <hz> --transition <hz>` writes the filtered cf32 to stdout and exits.

**Bridge and store** (`src/core/iq-capture/*`): one supervised tool process per source while
capture is enabled and the source is an IQ source, fed from the spectrum engine tap (bounded
queue, counted gaps), restarted with backoff; capture requests pass the rate limit, the
concurrency bound and the cap, and are refused with an `IqCaptureRefusal` code; the store index
lives in memory; files are verified (lstat chain, regular file, uid, size ≤ max) before a
replay; discard per requirement 6.6 (result, live confirmation, orphan TTL from an injected
clock); refusal at the cap; the startup sweep per requirement 6.6. A capture has one owner at a
time: the replay queue, or an identify job that `claim`ed it before its replay started; the
owner's result discards it (`settle`).

**Replay queue** (`replay-queue.ts`, requirement 6.4): FIFO of finished captures; skips claimed
ones; for the head entry asks `planner(planInput(capture))`, then requests one replay probe at a
time from the probe pool (`ProbeRequest.replay`, the capture's source, epoch, observation and
RF frequency, priority between identify and passive), stops at the first accepted decode, then
calls `sink(result)` exactly once and discards the capture. A deferred replay request (budget,
CPU guard) waits in place (FIFO, no busy loop: retried on the pool's slot release or 1 s);
the orphan TTL bounds the wait. `stop()` cancels the running replay and discards everything.

**Replay transport** (`replay-transport.ts`): `kind: "replay"`, `preRoll: false`, `maxProbes:
() => IQ_REPLAY_MAX_PROBES`, `cores: () => IQ_REPLAY_PROBE_CORES`, `supports` only for a request with `replay`
and a decoder type other than `rtl433`; `configure` gives the decoder the channel-input options
the channel transport gives it (the lane proves the planned argv equals the channel transport's
for the same request); the input `Readable` is the `replay` process stdout (the probe pool's
`input` path; an exact diff to `probe-pool.ts` if the pool must call the port to obtain it).

**Identify** (exact diff to `identify.ts`): at plan time, `iqCapture.near(...)` (≤ 2, newest
first) and `claim` each; for each probe run whose protocols are not decoded at the end of the
live runs, one replay run per claimed capture (trial transport `replay`); `settle` every claimed
capture when the target reaches its result (every path: identified, all trials ended, cancel,
failure, shutdown). When the target resolves a track with no capture, `iqCapture.capture(...)` is
requested once and claimed when it finishes. A live decode calls `confirmLive`.

**Scanner** (exact diff to `scanner-service.ts`): on a surfaced observation without a confirmed
result for this transmission (requirement 6.3; not spur or image, usable span), request a
capture; `end` on the track's close; `flush` on an epoch change; `confirmLive` when a live probe
decodes the observation; `applyReplayResult` appends the decode as evidence on the capture's
observation (epoch of the capture, P17 rules) or records the undecoded reason, and feeds the
known-protocol memory (`recordDecode` / `recordMiss` for a `known` trial that ran its hold).

**Docker** (Main): the `chan-build` stage also installs `target/release/wavekit-iqcap`; the
runtime stage copies it next to `wavekit-chan` and the verification step runs `wavekit-iqcap
--version` and the same `ldd` allow-list check.

## Main wiring

- ID: scanner-service diff (`narrowRasterAt` dep; cancel path if needed); CLI coordination note
  (`heard`).
- SC: scanner-service diff (`countsByJob`, `writeSnapshotOf`, `passiveCostDecision` with
  rechecks); `package.json` build adds `./src/core/scanner/store/snapshot-worker.ts`.
- GN: `src/index.ts` `setConfiguredTuning` per configured source; warn for other types;
  `config/default.yaml` commented example.
- TR: scanner-service diff (`trackIdentity`); `src/index.ts`
  `spectrum.setTrackIdentityLookup((s, t) => scanner.trackIdentity(s, t))` after the scanner
  exists.
- Known protocol: one `createKnownProtocolMemory` instance (scanner-service diff from ID) passed to
  identify, the job drivers and the replay sink; `forget` on discovery delete and merge.
- IQ: after ID merges, the identify and probe-pool diffs; scanner-service diff; the replay queue
  with `planReplayTrials` (ID) as planner and `applyReplayResult` as sink; `src/index.ts`
  `createIqCaptureService` (protected mode and enabled only; sweep before the scanner starts),
  `createReplayTransport` added to the probe pool transports; Dockerfile; Makefile help line.
- Docs, coordination note, CLI grep, contract test updates after merges.

## Correctness properties

1. **Heard is honest.** For random analog evidence sets (tone, DCS, trust, timing, modulation), a
   `live-audio` trial ends `decoded` iff a matching closed transmission carried a tone or code,
   `heard` iff it matched without one, and no other trial ever ends `heard`; the verdict equals
   the WG10 verdict for the same evidence. _Validates 1.1._
2. **Analog never stops digital.** For random plans (probe runs, ambient trials, analog trials)
   and evidence and decode timings, no non-analog trial ends `not-needed` because of analog
   evidence; a digital decode still ends the others unless `exhaustive`. _Validates 1.2._
3. **Narrow modes where the raster says so.** For random targets, ranges (rasters, regions),
   priors and protocol lists, `nxdn48`, `dpmr` and `dstar` are planned iff the target lies in a
   range with a raster ≤ 6 250 Hz, they are not excluded and their prior is > 0, each scored at
   least 0.3 × prior. _Validates 1.3._
4. **A stop is clean.** For random job states and interleavings of cancel, completion, failure,
   pause and resume, a cancel on an ended job changes nothing, and every job ends in exactly one
   terminal state with its end actions run once. _Validates 1.6._
5. **Passive guard decides by the limit.** For random utilization traces, limits and check
   times, passive is disabled only above the limit at a due check and cleared only at or below
   0.8 × limit at a due recheck. _Validates 2.1–2.3._
6. **Index equals scan.** For random ingest, merge, prune and evict sequences, the index's
   `stickyMatch` and the cached medians equal a linear scan with a fresh median.
   _Validates 3.1, 3.2._
7. **Counts equal a recount.** For random sequences, `countsByJob` equals the full recount at
   every step. _Validates 3.3._
8. **Snapshot text unchanged.** For random store operation sequences, the worker's snapshot text
   equals `JSON.stringify` of today's snapshot structure for the same state and `savedAt`.
   _Validates 3.5._
9. **Configured gain, once, never over the operator.** For random sequences of connects,
   accepted API or relay gain changes, policies and control modes, configured frames are written
   iff configured, internal and not accepted in this process, once per connection, in order, with
   origin `config`. _Validates 4.2, 4.3._
10. **Track fields are the tracker's.** For random block sequences, every frame track's fields
    equal the associated track's stats in the same block, `surfaced` follows the rule, and no
    identity crosses a source or epoch. _Validates 5.1–5.3._
11. **Capture store bounds.** For random request, completion, claim, settle, live confirmation and
    clock sequences, the total never exceeds the cap, no file exceeds the per-capture bound, a
    capture being replayed is never deleted, every capture is discarded at its result (or
    unreplayed at a live confirmation), and none outlives its end by more than 10 minutes.
    _Validates 6.4._
12. **Capture DSP is chunk-invariant.** For random chunkings of a synthetic stream with tones at
    random offsets, the tool's capture is identical whatever the chunking, the tone lands at the
    expected frequency within one bin, and the replay output has the decoder shape's rate.
    (Rust proptest.) _Validates 6.2, 6.5._
13. **Sweep touches only provable captures.** For random directory contents (names, types,
    symbolic links, owners), the startup sweep removes only regular files matching the grammar
    and owned by this uid. _Validates 6.4, 6.7._
14. **Known first, decays safely.** For random discoveries (confidence, protocol), transmissions
    and trial outcomes (decode of any protocol, full-hold miss, cut short, unavailable), the known
    protocol is planned first iff the discovery is `decoded` with fewer than 2 consecutive
    full-hold misses, every other plausible trial is still planned, and a decode resets the
    count. _Validates 1.7, 1.8._
15. **Queue order holds.** For random capture arrivals, claims, live confirmations, replay
    outcomes, deferrals and clocks, each capture goes capture → queue → trials (known first, one
    replay probe at a time) → exactly one result → discard, stops at the first accepted decode,
    and a claimed capture is never replayed by the queue. _Validates 6.4, 6.5, 6.8._

## Design amendment: trial choice and memory

Requirements 9.1 to 9.6. All of it lives in `src/core/scanner/**`.

- **Pager range.** `bandplan/builtin.ts` gains the French plan `pager-fr` (EU variant; Main's
  request, with the isolation tests' pinned size and hash updated and `pagers` as its display
  group in `src/core/bandplans/builtin-packs.ts`). The wider EU UHF paging span stays a scanner
  overlay next to LPD433: `PAGER_UHF_RANGE` in `classify/priors.ts`, added by
  `withScannerOverlays` when the effective plans hold an EU-only plan (`ism-433` or `pmr446`),
  minus the span of any `pager-fr` range (`pagerOverlayParts`; the whole span when `pager-fr` is
  hidden). At 575 kHz wide it is the narrowest range at its frequencies, so
  `narrowestPriors` gives POCSAG, FLEX and DMR 1 and the other specific protocols 0.25.
- **Pager hypotheses.** `classHypotheses(cls, priors)` in `classify/classifier.ts` adds
  `PAGER_RANGE_HYPOTHESES` when `inPagerRange(priors)` (pocsag or flex prior at least 1):
  fsk4-12k5 pocsag 0.6 and flex 0.56 (DMR 0.55), analog-fm pocsag 0.65 and flex 0.62
  (analog-fm 0.6), fsk2-wide unchanged. The spectral classifier, the channel tier and
  `identifyScores` all read it. `isPagerTonePair` in `classify/channel-tier.ts` replaces the
  fixed ±4 to 5 kHz tone windows with spacing 9 000 ± 1 500 Hz and a midpoint within 1 500 Hz.
- **Replay plan.** `planReplayTrialsDetailed(input, replayInput)` in `replay-plan.ts` returns the
  trials and the skipped extras. `REPLAY_INPUT_DECODERS` (iq-capture-contract) is the capability
  set (dsd-fme, multimon-ng, direwolf) and also gates the replay transport. In a paging range the
  candidates form three groups (known digital and pager, analog, rest), each ordered by
  `orderTrialsByMemory` (the first with `keepBackoff`, the others with `allowEmpty`); elsewhere
  one memory order. Then the `known` flag is kept only on the leading run, so the queue's
  known-first partition cannot change the order, and the mode-key dedup and the bound of 8 apply. Each candidate carries the protocols of every
  candidate with the same mode key, so a sibling protocol cannot bring a backed-off run back.
- **Trial memory.** `trial-memory.ts` (`TrialMemory`): a Map in least-recently-updated order,
  Zod-checked rows (`parseTrialMemory`), a 5 s debounced atomic write of
  `<scanner storage>/trial-memory.json`, a flush on stop, no write before the load. The service
  records every `IqReplayResult` trial in `applyReplayResult` (`rememberReplayTrials`, after the
  evidence: live discovery, else the stored one, else the pre-evidence id), forgets deleted, merged-away and
  evicted discoveries, and passes `trialMemory` and `nowMs` in the plan input (optional fields of
  `IqReplayPlanInput`). `trialMemoryOf(id)` reads it; no DTO field yet.
- **Pending capture.** `requestIqCapture` no longer needs a discovery when the track's gate passed;
  `PendingCaptureLimiter` (`pending-capture.ts`) allows 2 per source per rolling 60 s for such
  tracks (at most 64 sources, 2 timestamps each) and gives a slot back when the port refuses. The
  port keeps its own pre-roll, rate, concurrency and disk caps. A replay decode of a pending
  observation still live or in `recent` admits it through `applyEvidence`; one that left both
  before its replay ended is lost (gap).
- **Gaps.** rtl433 has no probe mode and no replay input (the capture service refuses it, the
  adapter reads cu8 only); acarsdec, dumpvdl2, ais-catcher, the LoRa decoder and readsb are no
  probe decoder types, and the 48 kHz capture is too narrow for VDL2 (dumpvdl2 needs multiples of
  105 kHz), LoRa (125 kHz) and 1090 MHz (2 Msps). These stay skipped until Main adds the inputs.

### Properties

- Property TC-1: any pager-class track inside the paging range ranks a pager protocol first.
- Property TC-2: every ISM 868 plan names rtl433 (planned or skipped) and never runs it
  without the capability; at most 8 trials.
- Property TC-3: parsing any persisted value never throws and stays within the bounds.

## Design amendment: activity-ranked decoder channels (scanner side)

`src/core/scanner/channel-activity.ts` implements the planner's `ChannelActivityPort`
(`src/decoders/enablement/activity-contract.ts`) with `createChannelActivityRanker({ monoNow,
timers?, history? })`. It returns the port, `epochOf`, the ingest hooks (`ingestEpoch`,
`ingestBlock`, `ingestTrack`, `stop`, `noteDecode`, `noteReplayTrial`), `setHistory`, `sizes`
and `dispose`. All times are on the planner's monotonic clock.

- Per source it keeps the current epoch (source, engine, epoch), the last frame time, energy
  segments keyed by track id (least recently seen dropped), ended gated tracks, pushed decodes and
  replay notes, and the last pulled history. A block updates segments in O(tracks) and marks a live
  edge when a segment appears or goes.
- A snapshot evaluates each query on its own: candidates are sorted once, each evidence item is
  associated by binary search (nearest within half the width, ambiguous when a second candidate is
  in reach), and the score is `100·live + 2·f(energy, 15 min) + 0.5·min(4, Σ f(track, 15 min)) +
3·f(decode, 6 h) + 2·f(success, 6 h) + 0.5·duty − 1·backoff`, with `f(a, W) = max(0, 1 − a/W)`.
  The non-live part is at most 9.5, so live comes first.
- A snapshot records its query as an interest (at most 128). A dirty source evaluates its
  interests in a coalesced pass and sends one notice when any channel's live flag, state or order
  changed, or its health changed. The pass also arms one timer at the earliest deadline.
- The scanner feeds the ranker from its pipeline handler (epoch starts, blocks, track closes),
  from engine stops, failures and source removal, from applied decodes and from replay results
  (weighted by `replayTrialWeight`, complete = whole hold without a gap). Its history provider
  reads decoded discoveries and remembered replay successes in the tuned window and the
  rolling-hour occupancy.
- `ScannerServiceDeps` gains `channelActivity`. `ChannelLiveCoverage` is a Stage 2 type only.
- `IqReplayResult` gains an optional `rfHz`; the scanner falls back to the capture view.
  `discoveryOnChannel` gives frequency attribution (exactly one discovery within 6 250 Hz, then a compatible protocol). `trackWithinPassband` states the Stage 2 coverage containment rule; Stage 1 never consults coverage (no sample-arrival time) and always captures. `AmbientEvidence` reads the manager's placement binding (`{ sourceId, channelHz }`, Zod-checked) and places a point decoder's evidence at its channel. Decode times are recorded only when the store accepted the decode. Decode history reads per-discovery decode times (at most 2 048). Live energy expires 1 000 ms after the last accepted block; overloaded blocks clear it and are no frame.
