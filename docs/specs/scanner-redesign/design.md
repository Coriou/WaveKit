# Scanner redesign design (WG12)

Status: reviewed design, not implemented (2026-10-18); the contract below is frozen when Main's
task 0.1 lands. Requirements in [requirements](requirements.md), tasks in [tasks](tasks.md).
Background: the spectrum worker pipeline (per-bin detector, segmenter, tracker, summary wire),
the scheduler and tuner arbiter of the master design § 10.2–10.3, the discovery store and
ladder (§ 7), the WG7–WG11 identify runner, the probe pool and its transports, the WG11 IQ
capture service, replay queue and `wavekit-iqcap`, the WG2/WG6 CTCSS and DCS detectors, and the
rust-demod-a NFM/AM kernel (separate spec, in progress; dependency of section 5).

## Design summary

Three faults made the scanner report noise and never what was heard: it re-tuned a window that
already fit, it judged 1 kHz bins instead of channels, and it labelled from priors. The redesign
fixes each at its root and adds the missing proof path:

1. **Park** a one-hop plan: tune once, then behave as in-window on the lease. A same-centre
   retune writes nothing. Track ids and the tuned card stay stable.
2. **Gate** on the channel: sum bin power over the channel width of the covering range, require
   a minimum duration and an SNR margin. Only gated tracks reach the scanner. Narrow noise
   blips, integrated over a 12.5 kHz channel, sit far below the gate.
3. **Prove** before labelling: priors only order trials; `protocol` comes from a decode or an
   analog-trial outcome; each observation and discovery carries a derived `proof` with a fixed
   English summary; anything unproven is `weak` and hidden by the web's default filter.
4. **Replay first**: every gated transmission is captured and replayed: known protocol, then an
   analog trial (Rust NFM/AM kernel, TS CTCSS/DCS), then digital probes. Live probes are kept for
   on-air follow-up.
5. **Tell the user**: progress gains a phase, a parked flag, the held track, the running trial
   and the replay queue depth.

Trade-off settled: the gate costs sensitivity on the very weakest signals (a channel SNR below
`kCh + margin`, 6 dB by default, never surfaces) in exchange for zero noise discoveries; such
signals are still visible on the waterfall, and an identify at the point still waits for them
(its own gate is the same, so a user who hears a signal the gate refuses learns it from the
`no-signal` end, not from a false label). The second settled trade-off: an analog `heard` or
tone outcome ends the remaining digital replay trials of that capture (cheap, and "plausible"
after a voice verdict means analog), at the risk of a digital mode mistaken for voice; the
data-like score is checked before the voice score to keep that risk low, and the live
acceptance measures it.

## Contract (frozen)

| File                                                  | Addition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/scanner.ts`                   | `ScannerTrialOutcome` gains `"data-like"` and `"carrier-only"`; `ScannerIdentifyTrial.decoder` gains `"analog-demod"`; `ScannerIdentifyResult.ended` becomes `"window-moved" \| "no-signal"`; `ScannerIdentifyRequest.waitUntilSignal?: boolean`, `waitMs?: number`; `ScannerProofKind` (`decoded`, `analog-tone`, `analog-voice`, `digital-undecoded`, `carrier-only`), `ScannerProofTransport` (`live`, `replay`, `ambient`), `ScannerProof` (`kind`, `protocol`, `transport`, `at`, `observationId`, `identity?`, `talkgroup?`, `tone?: { ctcssHz: number \| null; dcs: AnalogTransmissionDcs \| null }`, `voice?: boolean`, `tried: ScannerProtocol[]`, `unavailable: ScannerProbeDecoderType[]`, `encrypted`, `summary`); `ScannerEvidenceLevel` (`proven`, `weak`); `Discovery.proof?`, `Discovery.evidenceLevel?`, `Observation.proof?`; `ScanJobPhase` (`settling`, `holding`, `trialing`, `replaying`, `capturing`, `watching`); `ScanJobProgress` and `ScannerProgressEventData` gain `phase?`, `parked?`, `holding?: { discoveryId: string \| null; frequencyHz: number; trackId: string }`, `trial?: { protocol: ScannerProtocol; decoder: string; transport: "offset" \| "channel" \| "replay"; discoveryId: string \| null }`, `replayQueueDepth?`; `ScannerDiscoveryEventData.mergedIds?: string[]`; new `ScannerDiscoveryQueryParams` (the new query fields only: `evidence?: "proven" \| "weak" \| "all"`, `nearHz?`, `toleranceHz?`); constants `IDENTIFY_WAIT_DEFAULT_MS` (300 000), `IDENTIFY_WAIT_MAX_MS` (600 000), `IDENTIFY_WAIT_MIN_MS` (1 000), `DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ` (6 250), `DISCOVERY_NEAR_MAX_TOLERANCE_HZ` (1 000 000), `SCANNER_PROOF_SUMMARY_MAX_CHARS` (160), `SCANNER_PROOF_TRIED_MAX` (16), `DISCOVERY_MERGED_IDS_MAX` (64), `SCANNER_PROOF_PROTOCOL_LABEL: Readonly<Record<ScannerProtocol, string>>` |
| `packages/api-types/src/spectrum.ts`                  | `SpectrumFrameTrack.gate?: "pending" \| "passed"`, `channelSnrDb?: number`; `SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES` (40)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/api-types/src/live-audio.ts`                | `LiveAudioStatus.tone?: { ctcssHz: number \| null; dcs: AnalogTransmissionDcs \| null; at: string }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/scanner/types.ts`                           | the same DTO copies (kept identical by `tests/unit/api/scanner-dto-contract.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `src/core/spectrum/types.ts`                          | `TrackSnapshot.gate?: ChannelGateState`, `channelSnrDb?: number`, `gatePassedSample?: number` (absent on engines without a channel plan)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/config.ts`                                       | `ScannerConfigSchema.iqCapture.allowLegacy` (boolean, default false). `enabled` keeps default false until task MA.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/core/scanner/scanner-redesign-contract.ts` (new) | Channel gate: `CHANNEL_GATE_DEFAULT_WIDTH_HZ` (12 500), `CHANNEL_GATE_MIN_WIDTH_HZ` (6 250), `CHANNEL_GATE_MAX_WIDTH_HZ` (200 000), `CHANNEL_GATE_K_DB` (3.0), `CHANNEL_GATE_HYSTERESIS_DB` (1.5), `CHANNEL_GATE_MARGIN_DB` (3.0), `CHANNEL_GATE_MIN_DURATION_MS` (300), `CHANNEL_GATE_BURST_MIN_DURATION_MS` (100), `CHANNEL_GATE_BURST_MARGIN_DB` (6.0), `CHANNEL_GATE_MAX_MASKED_FRACTION` (0.5), `CHANNEL_GATE_MAX_SLOTS` (4 096), `ChannelGateState` (`pending`, `passed`, `below`), `ChannelPlanEntry` (`startHz`, `endHz`, `widthHz`, `rasterHz: number \| null`, `firstChannelHz: number \| null`, `burst: boolean`, `rangeKey: string`), `ChannelPlan` (`sourceId`, `entries`, `defaultWidthHz`). Analog trial: `ANALOG_TRIAL_CORES` (0.05), `ANALOG_TRIAL_FRAME_MS` (50), `ANALOG_TRIAL_MAX_FRAMES` (80), `ANALOG_TRIAL_QUIETING_DB` (8), `ANALOG_TRIAL_MIN_QUIET_FRACTION` (0.5), `ANALOG_TRIAL_VOICE_INDEX` (0.3), `ANALOG_TRIAL_AUDIO_MIN_DB` (−30), `ANALOG_TRIAL_DATA_SCORE` (0.6), `ANALOG_TRIAL_AM_CARRIER_DB` (6), `AnalogTrialMode` (`nfm`, `am`), `AnalogTrialFrame`, `AnalogTrialStats`, `AnalogTrialTones`, `AnalogTrialOutcome` (`decoded`, `heard`, `data-like`, `carrier-only`, `no-sync`), `AnalogTrialResult`, `AnalogTrialRunner` (port: `run(captureId, mode, signal): Promise<AnalogTrialResult>`). Jobs: `JobActivityView` (`capturing: number`, `replaying: { protocol, decoder, discoveryId } \| null`, `replayQueueDepth: number`), `JobPhaseInput`. Proof: `ProofInput` (observation evidence, trials, analog outcomes, unavailable types, trust)                                                                                                                                                                                                                                                                        |
| `src/core/scanner/iq-capture-contract.ts`             | `IqReplayTrial.kind?: "probe" \| "analog"` (absent = `probe`), `IqReplayTrial.analogMode?: AnalogTrialMode`; `IqReplayTrialOutcome` gains `heard`, `data-like`, `carrier-only`; `IqReplayResult.analog?: AnalogTrialResult`; `IqReplayResult.unavailable?: ProbeDecoderType[]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cli/source/data/scanner-guards.ts`                   | trial outcome enum gains `data-like` and `carrier-only`; `result.ended` becomes `z.enum(["window-moved", "no-signal"])`; with `tests/unit/cli/scanner-guards.test.ts`. The discovery, progress and frame guards are non-strict objects and strip the new optional fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/api/routes/scanner-schemas.ts`                   | identify body accepts `waitUntilSignal` and `waitMs` (bounds above, `waitMs` without `waitUntilSignal` refused 400); the discoveries query accepts `evidence`, `nearHz`, `toleranceHz` (bounds above; `toleranceHz` without `nearHz` refused 400). Accepted fields only: behaviour lands with lanes EV and ID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`tests/unit/core/scanner-redesign-contract.test.ts` pins every constant with its arithmetic
(gate thresholds: `CHANNEL_GATE_K_DB + CHANNEL_GATE_MARGIN_DB` = 6 dB; burst 9 dB; 300 ms = 6
blocks of 50 ms; 100 ms = 2 blocks; `ANALOG_TRIAL_MAX_FRAMES × ANALOG_TRIAL_FRAME_MS` =
`IQ_CAPTURE_MAX_MS`), the widened unions (outcomes, decoder, `ended`), the DTO shapes (every new
field optional), the CLI guards accepting a payload carrying every new value and field (trial
outcomes, `ended: "no-signal"`, discovery with `proof` and `evidenceLevel`, progress with
`phase` … `replayQueueDepth`, a frame track with `gate` and `channelSnrDb`, 256 tracks still
accepted), the config shapes (absent `iqCapture` parses to the WG11 output; `allowLegacy`
default false), the proof summary grammar examples of § Proof, and the query and body bounds.
`wg10-contract` and `wg11-contract` are amended where they pinned `ended` as a literal or the old
outcome list.

Names a lane creates and Main consumes at merge (frozen here by name):

- DT: `createChannelGate(opts: { binHz: number; blockMs: number; centreHz: number; bins:
number }): ChannelGate` in new `src/core/spectrum/channel-gate.ts` with `setPlan(plan:
ChannelPlan | null): void`, `block(power: Float32Array, floor: Float32Array, masked:
Uint8Array, sample: number): void` and `gateOf(centreHz: number, obwHz: number): { state:
ChannelGateState; channelSnrDb: number; passedSample: number | null }`;
  `SpectrumService.setChannelPlan(sourceId: string, plan: ChannelPlan | null): void`;
  `Scheduler.parked: boolean` (getter); `TunerArbiter.retune` keeps its signature (no-op rule
  1.2); scanner side `ScannerService.channelPlanOf(sourceId: string): ChannelPlan | null` (exact
  Main diff, built from the running jobs' enabled ranges and the passive band-plan view).
- EV: `deriveProof(input: ProofInput): ScannerProof | null` and `proofSummary(p: Omit<ScannerProof,
"summary">): string` (pure) in new `src/core/scanner/proof.ts`; `evidenceLevelOf(d): ScannerEvidenceLevel`;
  `DiscoveryStore.near(hz: number, toleranceHz: number, sourceId?: string): Discovery[]` (the
  store implements the contract's `DiscoveryNearQuery` and `ObservationEvidenceSink`, see
  § Contract › Amendments);
  `DiscoveryStore.list(query)` honours `evidence`; the store's merge emits `mergedIds`;
  `isDecoderUnavailableExit(exit): boolean` in `probes/probe-pool.ts`.
- RP: `wavekit-iqcap` command `analyze` (event and output shape below);
  `createAnalogTrialRunner(deps: { port: IqCapturePort, tones, logger }):
AnalogTrialRunner` in new `src/core/iq-capture/analog-trial.ts`; `classifyAnalogTrial(stats:
AnalogTrialStats, tones: AnalogTrialTones): AnalogTrialOutcome` (pure) in new
  `src/core/scanner/analog-trial.ts`; `planReplayTrials` with the analog step and the stop rule
  (4.6); `createIqReplayQueue` deps gain `analog?: AnalogTrialRunner`.
- ID: `IdentifyDeps.gatedAt?: (sourceId: string, hz: number, toleranceHz: number) => {
startSample: number; atMs: number } | null` and `IdentifyDeps.analogTrial?: AnalogTrialRunner`
  (absent: today's behaviour, no wait and no analog replay trial); `jobPhase(input:
JobPhaseInput): ScanJobPhase` (pure) in new `src/core/scanner/job-phase.ts`;
  `JobDriverDeps.activity?: (jobId: string) => JobActivityView`; `createLiveAudioEvidence(deps:
{ store, analogLog, trust, logger }): LiveAudioEvidence` in new
  `src/core/scanner/live-audio-evidence.ts`; the `LiveAudioStatus.tone` exact diff to
  `src/core/live-demodulator.ts`.

Every DTO addition is optional or a widening the CLI guards accept after the contract commit;
no WebSocket event type and no route is added; no state or error code is added (the 400s use
the existing validation error).

### Amendments (task 0.1)

Recorded with the contract commit; requirement numbers are unchanged.

- **A4: analyze transport.** The 4 KiB control-line protocol belongs to the long-lived `run`
  process, so `analyze` is a sibling argv subcommand of `replay`:
  `wavekit-iqcap analyze --in <abs file> --mode nfm|am`. Stdout carries s16le 8 kHz audio; the
  single JSON event line (`AnalyzeEvent`, at most `ANALYZE_EVENT_MAX_BYTES` = 4 096, validated
  both sides) goes on fd 4. `iq-capture-contract.ts` gains the optional port method
  `IqCapturePort.openAnalyze?(captureId: string, mode: AnalogTrialMode): { audio: Readable;
event: Promise<AnalyzeEvent>; kill(): void } | null`, so the analog trial runner never reaches
  into the capture service. `createAnalogTrialRunner` therefore takes no process dependency
  (`deps: { port, tones, logger }`): the service spawns the child.
- **A12: where trial evidence lives.** `scanner-redesign-contract.ts` freezes two structural
  interfaces that every lane codes against (lane tests use fakes of them):
  `ObservationEvidenceSink` (`nextTrialOrder(): number`, `recordTrial(observationId, trial:
ProofTrialInput): boolean`, `recordAnalog(observationId, analog: ProofAnalogInput): boolean`,
  `recordUnavailable(observationId, type: ScannerProbeDecoderType): boolean`) with the bounds
  `PROOF_TRIALS_MAX_PER_OBSERVATION` (32, highest `order` kept) and
  `PROOF_ANALOG_MAX_PER_OBSERVATION` (8, newest kept), and `DiscoveryNearQuery` (`near(hz: number,
toleranceHz: number, sourceId?: string): Discovery[]`). `DiscoveryStore` implements both (EV);
  no other lane depends on a store member EV adds. Trial, analog and unavailable evidence is kept
  in an in-memory side table of the store keyed by observation id: not a field of the
  `Observation` record, not in the snapshot, the journal or any persistence or mirror payload
  (3.5: derived, never persisted as a new store field). A `true` return re-derives the owning
  discovery's proof and emits the existing `updated` change, with no journal entry. Consequence:
  after a restart only proofs rebuilt from a persisted `Observation.decode` (live, replay or
  ambient) survive as `decoded`; `analog-tone`, `analog-voice`, `digital-undecoded` and
  `carrier-only` proofs are lost and those discoveries read `weak` (3.6) until new evidence
  arrives. This is designed behaviour, documented in docs/SCANNER.md; persisting trial evidence
  across a restart is an open item (tasks.md § Open items, WG13).

## Pipeline positions

```
worker block → window → FFT → power (existing) → noise floor → masks (DC, edges, exclusions,
  spurs, images) → per-bin detector → segmenter → tracker (centre, OBW, class, ACF)
  → [NEW channel gate: prefix sums of power and floor over the block → channel slots of the
     plan → on/off with hysteresis → per-track gate state] → summary wire (+ gate, channelSnrDb)
  → main thread: spectrum-service frame (surfaced = gate passed) ; scanner ingest
scanner ingest → track gate passed? no: transient count only ; yes: DiscoveryStore.ingest
  (no prior label) → capture trigger (gate pass, WG11 6.3 bounds) → replay queue
replay queue (FIFO, one at a time) → planReplayTrials: [known protocol] → [analog trial:
  wavekit-iqcap analyze (Rust NFM/AM kernel) → stats line + 8 kHz audio → TS CTCSS/DCS
  (sliced ≤ 4 096 samples per turn) → classifyAnalogTrial] → decoded/heard: stop ;
  data-like/no-sync: [digital replay probes by score × prior] → IqReplayResult (analog?,
  unavailable?) → applyReplayResult → proof re-derived → discard
scheduler (one-hop plan) → tune once → settle → parked: dwell windows counted as sweeps,
  no tune action ; multi-hop: next hop == current hop → visit continues
TunerArbiter.retune(same centre, rate, gain, verified epoch) → no write, current epoch
live probe → only for a gated track: capture not running, still on air after its capture with
  no decode yet, or identity follow-up on a decoded discovery
probe exit before any output with the program missing → unsupported/decoder-unavailable →
  unavailable memo → proof.unavailable
identify (waitUntilSignal) → waiting-for-signal until gatedAt(target) → timeoutMs from the
  gated start → trials (claimed captures replay, analog trial included) | waitMs elapsed →
  unidentified, ended no-signal
live audio closed transmission (commanded/relay) → LiveAudioEvidence → observation analog
  evidence (transport live) → proof
progress (≤ 2 Hz per job) → jobPhase(scheduler phase, parked, probe of job, activity view)
```

## CPU and IO budgets

Reference desktop host = the Mac reference used since WG9; Pi 4-class figures are estimates
(×3 for Rust, ×4 for JS on the reference) until DT.0 and RP.3 measure them. "Core" is one CPU
core; event-loop figures are the main thread at 2.048 Msps.

| Item                     | Position                                      | 2.048 Msps (ref / Pi 4)                                                                                                                                                                                                                                                               | 2.4 Msps (ref / Pi 4)                                    | Event loop                                                | How measured                                                       |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------ |
| DT channel gate          | worker, per block (20 /s at 50 ms)            | prefix sums over N = 2 048 bins (power, floor: 4 096 adds) + ≤ 2 × 130 sliding slots over the usable span × 4 ops ≈ 5 000 ops ≈ 10 µs per block ⇒ 0.0002 / 0.001 core                                                                                                                 | same N and block rate, span × 1.17 ⇒ 0.0002 / 0.001 core | 0 (worker); one typed-array pass, no allocation per block | worker bench in DT.0, before/after                                 |
| DT summary wire          | worker → main, per block                      | + 2 numbers per gated track; ≤ 40 B JSON per frame track (`"gate":"passed"` 15, `"channelSnrDb":12.5` 20, separators)                                                                                                                                                                 | same                                                     | ≤ 0.05 ms p99                                             | serialized size test, frame bench                                  |
| DT parking               | per job                                       | removes one retune, settle and `closeAll` per pass (today about one per 5 s on a one-hop scope): a saving                                                                                                                                                                             | same                                                     | saving                                                    | counted tuner writes in tests                                      |
| DT arbiter no-op         | per retune call                               | O(1) comparison                                                                                                                                                                                                                                                                       | same                                                     | 0                                                         | counted writes                                                     |
| EV labels                | per observation ingest                        | removes the prior-to-protocol step; O(1)                                                                                                                                                                                                                                              | same                                                     | ≤ 0                                                       | store bench (WG11 bench, unchanged budget ≤ 50 µs mean per ingest) |
| EV proof                 | per evidence change of a discovery            | ≤ 64 observations × ≤ 16 trials ≈ 1 000 ops ≈ 20 µs, cached per discovery version; reads use the cache                                                                                                                                                                                | same                                                     | ≤ 0.1 ms p99                                              | store bench with proof                                             |
| EV evidence filter       | per list request                              | O(n) as today's list                                                                                                                                                                                                                                                                  | same                                                     | as today                                                  | bench at 10 000 discoveries                                        |
| EV near                  | per request                                   | per-source frequency index: O(log n + k)                                                                                                                                                                                                                                              | same                                                     | ≤ 0.1 ms                                                  | bench                                                              |
| RP capture on by default | `wavekit-iqcap` process                       | ring 0.0002 core idle; 0.06–0.14 core with 2 captures active (WG11 measurement); ≤ 6 captures per minute × ≤ 4 s ⇒ ≤ 40 % duty ⇒ ≤ 0.06 core average / ≤ 0.2 Pi                                                                                                                       | × 1.17 ⇒ ≤ 0.07 / ≤ 0.23                                 | tap feed: one pipe write per chunk (WG11, unmeasurable)   | native bench at both rates (existing `iqcap_bench`)                |
| RP analyze               | `wavekit-iqcap analyze`, per replayed capture | 192 000 cf32 samples per 4 s capture; kernel ≤ 30 ns/sample (assumed, rust-demod-a measures) + stats ≈ 10 ns/sample ⇒ ≤ 8 ms per capture; ≤ 6 per minute ⇒ 0.0008 / 0.0024 core                                                                                                       | independent of source rate (capture is 48 kHz)           | 0 (separate process)                                      | `scripts/bench/analog-trial.ts` and a crate example                |
| RP tone pass             | main thread, per analog trial                 | 32 000 samples at 8 kHz through the CTCSS and DCS detectors ≤ 10 ms per capture, sliced ≤ 4 096 samples per turn (`setImmediate` between slices) ⇒ 0.001 / 0.004 core                                                                                                                 | same                                                     | ≤ 1 ms p99 (one slice)                                    | bench with event-loop histogram during a burst of 6                |
| RP replay queue          | per capture                                   | unknown signal: analog ≤ 0.2 s + ≤ 7 probe trials × (replay ≤ 1 s + start ≈ 0.5 s) ≤ 10.7 s ⇒ ≥ 5.6 captures per minute drained at one replay probe; after `heard`/tone ≤ 0.2 s; known protocol ≤ 1.5 s. Probe budget: 0.15 core while a replay probe runs, 0.05 for the analog trial | same                                                     | as WG11                                                   | drain rate with fake decoders                                      |
| RP disk                  | per capture                                   | unchanged WG11 bounds (≤ 1 536 000 B, ≤ 9.2 MB/min per source, 256 MiB total)                                                                                                                                                                                                         | same                                                     | —                                                         | store tests at the cap                                             |
| ID phase                 | per progress build (≤ 2 Hz per job)           | O(1)                                                                                                                                                                                                                                                                                  | same                                                     | 0                                                         | by construction                                                    |
| ID wait                  | per identify tick                             | O(open tracks of the source) ≤ 256 gate lookups                                                                                                                                                                                                                                       | same                                                     | ≤ 0.05 ms                                                 | tests count lookups                                                |
| ID live-audio evidence   | per closed transmission                       | one index lookup + one evidence append                                                                                                                                                                                                                                                | same                                                     | ≤ 0.1 ms                                                  | by construction                                                    |

**Why the WG11 limits now suffice (4.4).** The capture limits were sized for real transmissions
and were exhausted by noise tracks. With the gate, a parked narrow band produces captures only
for transmissions with at least 300 ms of channel SNR ≥ 6 dB; a busy PMR or land-mobile band has
a few such keyings per minute, below the 6 per minute ceiling, and the queue drains at least 5.6
captures per minute in the worst case (unknown digital signal, 8 trials) and about 37 per minute
when the known protocol decodes first. A sustained excess is bounded by the 10 min orphan TTL
(60 per source) and refused at the cap, counted; a live probe on the gated track (4.2 a) then
still confirms.

**Why noise cannot pass (2.4).** For a narrow blip of width `b` at per-bin SNR `s` inside a
channel of width `W`, the channel SNR is `10·log10(1 + (b/W)(10^(s/10) − 1))`. A 2 kHz blip at
3.5 dB in a 12.5 kHz channel gives 0.8 dB, a 2.5 kHz blip at 8 dB gives 2.0 dB: both below
`kCh` (3 dB), far below the 6 dB gate. With about 12 bins × 50 FFT frames per block, the channel
power estimate of pure noise has a standard deviation of about 4.34 / √600 ≈ 0.18 dB, so a 3 dB
threshold is about 17 σ: a pure-noise channel essentially never turns on; floor-estimate error,
not variance, dominates, which the CFAR adaptation (2.3) handles. A real NFM or 4FSK channel
fills most of `W`, so its channel SNR is close to its per-bin SNR.

## Parking (lane DT)

`Scheduler` gains `parked`: true once a one-hop plan's first visit settled. In `leaveHop` a
one-hop plan does not call `tuneTo`; it ends the visit's accounting (activity share, hit stats),
emits `sweep-complete` when a full `dwellMs` has elapsed since the last count, and starts a new
visit record on the same hop without a tune action (`phase` back to `dwell`). Holds and probes
work as in-window (offset probes within the window; no lease release). `sweepPeriodMs` is null
while parked. On `replan` (range edit) the plan is rebuilt; a one-hop plan with the same centre
stays parked, a new centre leaves the park through one tune. In a multi-hop plan, `leaveHop`
compares the picked hop with the current one and, when equal, extends the visit
(`dwellEnd` += hop dwell) instead of `tuneTo`.

`TunerArbiter.retune(holder, centre, rate, gain)`: when `holder` holds the lease and the
connection's last written and accepted centre, rate and gain equal the request and the current
epoch is verified (settle passed, not `unverified`), it returns that epoch and writes nothing
(no frequency write, no test-mode markers, no new epoch). Restore, lease handover, a reconnect
and an external retune keep today's paths.

## Channel gate (lane DT)

The plan comes from the scanner (`channelPlanOf`), per source, rebuilt on job start, stop and
range edit. Entry width: first `obwHz`, else raster spacing, else the default, clamped. Raster
entries place channel slots on `firstChannelHz + n × rasterHz`; entries without a raster and
uncovered span use a sliding grid at `widthHz / 2` steps. Slots are capped at
`CHANNEL_GATE_MAX_SLOTS`; past the cap the grid coarsens (counted). Per block, the gate builds
prefix sums of linear power and floor over unmasked bins (masked bins contribute 0 to both and
are counted), and for each slot computes the sums over the bins whose centres lie inside the
slot. A slot with masked fraction above 0.5 is skipped. On/off per slot with hysteresis; per
slot the run start, the in-run best SNR and a one-block dropout allowance. A track maps to the
slot nearest its centre whose passband contains it (wider tracks: the slot set covering its OBW,
power summed). `gateOf` returns `passed` once the slot's run reached the minimum duration and
the margin; the track keeps `passed` for its life (sticky on the tracker's track record). CFAR
per `rangeKey` counts a slot run that ended without passing as one false alarm.

The per-bin detector, segmenter and tracker are unchanged; they still form tracks and
measure them. Goldens record the old surfacing; the lane lists each changed golden with 2.4–2.6.

## Evidence labels and proof (lane EV)

`observedProtocol` and `ladderOf` are replaced by `labelFromEvidence(observation evidence)`:
`protocol` is set only by (a) an accepted decode (live, replay, ambient), (b) an analog outcome
(`decoded` tone/code or `heard` → `analog-fm`/`analog-am`; `carrier-only` → `carrier`), or (c) a
`data-like` analog outcome followed by every planned digital trial ending without a decode →
`digital-unknown`. The ladder follows requirement 3.2. `classOf`, `applyPriors` and
`classifySpectral` stay as measurement and trial-ordering helpers; their outputs no longer flow
into `protocol`, `family` or `confidence`.

**Proof derivation.** `deriveProof` reads an observation's decode evidence, its trial outcomes
(live and replay), analog outcomes and unavailable types; it returns null when no naming outcome
exists. Discovery proof: strongest observation proof, rank `decoded` > `analog-tone` >
`analog-voice` > `digital-undecoded` > `carrier-only`, ties newest. `tried`: protocols of trials
that ran to an outcome in {`decoded`, `no-sync`, `crc-errors`, `timeout`, `heard`, `data-like`,
`carrier-only`}, run order, unique, at most 16; the analog trial contributes no protocol to
`tried` unless it decoded (the summary lists digital trials).

**Proof grammar** (`proofSummary`, fixed English, at most 160 characters):

| Kind                | Summary                                                                                                                                                                                                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decoded`           | `<Label> decoded` + ` (<parts>)` when any part: identity part, `TG <talkgroup>`, `encrypted`, joined by `, `. Identity parts: `dmr-cc` `CC<n>`, `dpmr-cc` `CC<n>`, `p25-nac` `NAC <value>`, `nxdn-ran` `RAN <n>`, `ysf-dgid` `DG-ID <n>`, `pocsag-capcode` `capcode <n>`, `ais-mmsi` `MMSI <n>`, other kinds the value |
| `analog-tone`       | `Analog FM voice, CTCSS 88.5` (tone with one decimal) or `Analog FM voice, DCS 023N` (`N`/`I` polarity); without voice: `Analog FM, CTCSS 88.5`; AM: `Analog AM …`                                                                                                                                                     |
| `analog-voice`      | `Analog FM voice` / `Analog AM voice`                                                                                                                                                                                                                                                                                  |
| `digital-undecoded` | `Digital, not decoded (tried DMR, dPMR, NXDN)`; with unavailable decoders `Digital, not decoded (tried dPMR; dsd-fme unavailable)`; none tried `Digital, not decoded (no decoder available)`; past 160 characters the tried list ends with `+<n> more`                                                                 |
| `carrier-only`      | `Carrier only`                                                                                                                                                                                                                                                                                                         |

Labels (`SCANNER_PROOF_PROTOCOL_LABEL`): `dmr` DMR, `p25p1` P25, `p25p2` P25 Phase 2,
`nxdn48`/`nxdn96` NXDN (deduplicated in lists), `ysf` YSF, `dstar` D-STAR, `dpmr` dPMR, `pocsag`
POCSAG, `flex` FLEX, `aprs` APRS, `ism` ISM, `ais` AIS, `acars` ACARS, `vdl2` VDL2, `lora` LoRa,
`analog-fm` Analog FM, `analog-am` Analog AM, `digital-unknown` Digital, `carrier` Carrier,
`unknown` Unknown. Identifiers in summaries stay on the host, as every other API field.

**Filter and near.** `evidence=proven` keeps discoveries with a proof, `weak` those without,
`all` (or absent) both; `nearHz` uses the store's per-source frequency index (WG11 3.1) across
sources, sorted by |Δf| then id, paged by the existing `limit`/cursor rules. `mergedIds`: the
store's merge path passes the absorbed ids to the `merged` event.

**Unavailable on the probe path.** The probe pool classifies an exit before any output with
`ENOENT`/`EACCES` on spawn, or the decoder's own "not found" exit code family, as unavailable:
the probe ends `unsupported`/`decoder-unavailable`, the memo records the type, no
`undecodedReason`, no known-protocol miss, and the replay result lists it in `unavailable`.

## Replay first and trial order (lanes RP and Main)

The scanner-service diff of RP routes confirmation: for a gated track on a source whose capture
service runs, the scheduler's `needsConfirm` is false while a capture of the track is pending or
its replay has not ended; it becomes true when the track is still open after the replay ended
without a decode (4.2 b) or for identity follow-up (4.2 c). Without capture (off, legacy
without `allowLegacy`, binary missing, refused at a bound) today's confirm path runs on gated
tracks only.

`planReplayTrials`: known protocol first (WG11 1.7), then one analog trial when `analog-fm` or
`analog-am` is plausible (prior > 0, not excluded; `am` when the band plan at the frequency lists
AM, else `nfm`), then the digital probe modes by `identifyScores` × prior, total at most 8. The
queue runs them in order; after an analog `decoded` or `heard` the remaining digital trials end
`not-needed`; after `data-like`, `carrier-only` (digital still run once: a carrier may precede
data) or `no-sync` they run. The first accepted digital decode ends the rest (WG11). When the
digital trials all ran without a decode after `data-like`, the result names `digital-unknown`.

## Analog replay trial (lane RP)

**Kernel API assumption** (rust-demod-a, frozen in its design; this lane adapts only its own
module if it differs): a pure kernel in the `wavekit-chan` crate, cf32 in and audio out, with no
I/O and no allocation per call:

```rust
pub enum DemodMode { Nfm { deviation_hz: f32, audio_bw_hz: f32 }, Am { audio_bw_hz: f32 } }
pub struct DemodKernel { /* state */ }
impl DemodKernel {
    pub fn new(mode: DemodMode, input_rate_hz: u32, audio_rate_hz: u32) -> Self;
    /// Consumes interleaved cf32 IQ, appends f32 audio at `audio_rate_hz` to `audio`.
    pub fn process(&mut self, iq: &[num_complex::Complex32], audio: &mut Vec<f32>);
}
```

If the kernel exposes no discriminator output, the `analyze` module computes the quadrature
discriminator itself (conjugate product and `atan2` per sample, an idea, not a port) for the
statistics; the audio always comes from the kernel.

**`analyze` command** (amended in task 0.1, see § Contract › Amendments: an argv subcommand,
a sibling of `replay`, not a control line of the long-lived `run` process):
`wavekit-iqcap analyze --in <abs file> --mode nfm|am`, with the same input convention and file
checks as `replay` (`IqCapturePort.openAnalyze` opens it). The tool writes s16le mono audio at
8 000 Hz on stdout and exactly one bounded event line on fd 4 (4 KiB bound, validated both
sides): `{ "event": "analysis", "frames": [ … ≤ 80 ], "gapSamples": n }` per capture, each frame
`{ carrierDb, hfNoiseDb, audioDb, syllabic, cluster }` (numbers rounded to 0.1), or
`{ "event": "error", "code": … }` with a fixed code (`bad-args`, `open-failed`, `bad-file`,
`kernel-config`, `io`). Exit 0 on analysis, non-zero on error. No file is written.

**Statistics.** `hfNoiseDb`: discriminator power in 3.5–12 kHz relative to the pure-noise
reference (the discriminator output of complex Gaussian noise has a fixed power, independent of
input level; the lane derives and pins it); quieting = −`hfNoiseDb`. `audioDb`: audio power in
300–3 000 Hz relative to full deviation. `syllabic`: the 2–10 Hz modulation index of the audio
power envelope. `cluster`: the fraction of symbol-rate-filtered discriminator samples within
± 15 % of the best 2-level or 4-level centroid set (data-like signals cluster; voice does not).
AM uses `carrierDb` steadiness (`ANALOG_TRIAL_AM_CARRIER_DB` above the capture's floor) in place
of quieting.

**Decision** (`classifyAnalogTrial`, pure, in order): a qualified CTCSS tone or DCS code →
`decoded` (voice flag from the voice test); fewer than `ANALOG_TRIAL_MIN_QUIET_FRACTION` of
frames quieted by `ANALOG_TRIAL_QUIETING_DB` → `no-sync`; median `cluster` ≥
`ANALOG_TRIAL_DATA_SCORE` → `data-like`; `syllabic` ≥ `ANALOG_TRIAL_VOICE_INDEX` and `audioDb`
≥ `ANALOG_TRIAL_AUDIO_MIN_DB` → `heard`; otherwise `carrier-only`. The thresholds are starting
values; the lane calibrates them on synthetic signals (NFM with a voice-like syllabic multitone,
with and without CTCSS/DCS; 4FSK at 4 800 and 2 400 symbols/s; GMSK; an unmodulated carrier;
noise) at 6–20 dB channel SNR and delivers any change as a contract amendment diff with the
measured margins.

**Tones.** The runner feeds the audio to the existing CTCSS and DCS detectors
(`src/core/audio-tones/ctcss.ts`, `dcs.ts`, `tone-detector.ts`) with their WG2/WG6 qualification
(minimum audio seconds, DCS minimum words), sliced, and returns `AnalogTrialTones`.

## Identify and live audio (lane ID)

**Wait.** With `waitUntilSignal`, a target stays `waiting-for-signal` until `gatedAt(source,
target, tolerance)` returns a gated transmission start; its trial timeout then runs from that
start. `waitMs` elapsing first finishes the target `unidentified` with `ended: "no-signal"`,
trials `cancelled`, no verdict, no miss. A window move still ends `window-moved`.

**Analog trial in identify.** When identify claims captures (WG11 6.8), it runs the analog trial
through `IdentifyDeps.analogTrial` for each claimed capture whose plan includes analog (trial
`decoder: "analog-demod"`, `transport: "replay"`); its outcome feeds the WG10 verdict like a
`live-audio` match (`decoded` with tone → identified on `commanded`/`relay`, else candidate).
The live-audio trial is unchanged.

**Live-audio evidence.** `LiveAudioEvidence` subscribes to the analog evidence log (WG10) and,
for each closed transmission on a `commanded` or `relay` frequency, finds the discovery within
the tolerance (`DiscoveryNearQuery.near`, implemented by `DiscoveryStore`) and its overlapping observation, and records analog
evidence (`decoded` with tone/code, else `heard`; transport `live`). No discovery is created
from live audio alone (the gate creates discoveries). The evidence goes through
`ObservationEvidenceSink.recordAnalog` and lives in memory only (§ Contract › Amendments, A12).

**Tone on status.** The diff keeps the last closed or current transmission's tone in the live
demodulator and adds it to `status()`; cleared on retune and stop.

**Phase.** `jobPhase` takes the scheduler phase (`tuning`/`settling`, `hold`, `dwell`), `parked`,
whether a live probe of the job runs, and the `JobActivityView`; it applies the precedence of
7.1. `holding` and `trial` come from the scheduler's hold and the running probe or replay trial.

## Capture default flip (Main, task MA.6)

Config change only: `iqCapture` becomes `.default({})` with `enabled` default true; the service
start rule becomes `enabled && (mode === "protected" || allowLegacy)`. Goldens: the parsed
shipped config (one more object), the startup log line in legacy mode (the WG11 info line, now
also naming `allowLegacy`), docs/API.md, docs/SCANNER.md and `config/default.yaml` comments.
Nothing else changes; every WG11 file and leak rule holds.

## Profiling and the Rust detector gate (lane DT, task DT.0)

`scripts/bench/spectrum-profile.ts` runs a core assembly in process (no Docker, no network
beyond 127.0.0.1) fed by a fake rtl_tcp server on port 0 at 2.048 and 2.4 Msps (U8, synthetic
noise plus a few NFM and 4FSK channels), with one parked job over a 200 kHz scope and the
passive job, for 120 s each. It reports: worker busy fraction split by stage (window, FFT, power,
floor, detector, gate, segmenter and tracker, summary wire; `performance.now()` spans aggregated
per block, sampled one block in ten to stay out of the measurement), engine utilization as the
passive guard reads it, main-thread event-loop utilization and delay p50/p99 split by the
listeners (tap feed, summary decode, frame build, scanner ingest, store), and the load average.
Run before (base) and after DT.1. **Gate**: if window + FFT + power + summary wire ≥ 50 % of the
worker's busy time and engine utilization > 0.25 at 2.048 Msps on the reference host, Main amends
this spec with a Rust detector frame engine task (lane DT); otherwise it is recorded as deferred
to WG13 with the numbers. Any main-thread listener over 1 ms of p99 delay gets a fix task in the
owning lane.

## Main wiring

- Contract commit (0.1) before any lane; the CLI guard and contract test with it.
- DT: scanner-service diff (`channelPlanOf`, `setChannelPlan` calls on job start, stop, range
  edit; gate-aware ingest: transient-only for `below`; `nextCandidate` input carries the gate);
  `src/index.ts` passes nothing new.
- EV: scanner-service diff (proof and `evidenceLevel` on every discovery and observation DTO the
  service emits; `mergedIds` pass-through; query pass-through).
- RP: scanner-service diff (capture trigger at gate pass; replay-first `needsConfirm`;
  `applyReplayResult` carries `analog` and `unavailable` into the store); `src/index.ts` creates
  the analog trial runner and passes it to the replay queue and to identify; Dockerfile only if
  the binary set changes (it does not: `analyze` is a command of `wavekit-iqcap`).
- ID: scanner-service diff (`activity` view per job, `phase`/`parked`/`holding`/`trial`/
  `replayQueueDepth` on `scanner:progress`, `gatedAt` and `analogTrial` into identify deps,
  `createLiveAudioEvidence` wiring); `src/core/live-demodulator.ts` tone diff after the
  rust-demod-a lane merges.
- Docs, coordination note, CLI grep, contract test updates after merges; the flip last.

## Live acceptance

Only Main, on the live receiver, with the receiver grant; lanes never. Setup for every
scenario: a protected-mode core at the merged head, the scanner job named per scenario, the web
or the API read through Main's local session; `spectrum:frame` and `scanner:*` recorded to a
private log for the measurements; a scanner-off baseline of the same duration for cost. After
the session Main restores the receiver's configured gain and AGC.

Pass criteria for every scenario (requirement 11.3): (a) no noise discoveries over the empty-band
minutes (no new discovery of any evidence level whose transmission Main cannot attribute to a
real emitter on the waterfall); (b) one `trackId` per transmission on `spectrum:frame` across its
length; (c) while parked, zero epoch changes and zero scanner tuner commands after the first
tune; (d) the expected proof summary within T s of the transmission's end; (e) event-loop delay
p99 added ≤ 2 ms against the baseline, core process CPU reported against § budgets, FanoutManager
drop-mode count reported.

**Scheduled with the user (S), T = 10 s.** One job over 446.0–446.2 MHz (one hop, parked).
PMR446 analog channels: channel n at 446.006 25 + (n − 1) × 0.012 5 MHz.

| Id  | What the user does                                                                               | Expected                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| S0  | Nothing for 30 min (radios off)                                                                  | no new discovery; job `parked`, `phase` `watching`; no epoch change                                                        |
| S1  | Analog radio, channel 1 (446.006 25 MHz), CTCSS 88.5 Hz, 5 overs of 3–10 s, 20 s apart, speaking | one discovery; each observation "Analog FM voice, CTCSS 88.5"; `classified`                                                |
| S2  | Analog radio, channel 3 (446.031 25 MHz), no tone, speaking                                      | "Analog FM voice"; `candidate`                                                                                             |
| S3  | Analog radio, channel 8 (446.093 75 MHz), a DCS code the user sets, speaking                     | "Analog FM voice, DCS <code><N\|I>"                                                                                        |
| S4  | DMR radio on a channel the user names, colour code and talkgroup as programmed, 5 overs          | "DMR decoded (CC<n>, TG <m>)"; `decoded`; if the channel lies outside the scope Main runs a second one-hop job covering it |
| S5  | Analog radio, channel 3, key up 5 s without speaking                                             | "Carrier only" (no voice, no tone)                                                                                         |
| S6  | Alternate S1 and S4 within 60 s                                                                  | two discoveries, no cross-label; `phase` visibly cycles `watching` → `capturing` → `replaying` → `watching`                |

Each S scenario runs twice: capture off (live probe on gated tracks; analog evidence from live
audio when Main listens, else the scenario records `weak` as the expected capture-off outcome
for S1–S3 and S5), then capture on. The flip (MA.6) needs S0–S6 passing with capture on.

**Natural traffic (N), Main alone, T = 20 s.** Frequencies are chosen by Main from the local
waterfall and the active region's band plan; none is written to tracked files.

| Id  | Band and traffic                                                                               | Expected                                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Pager channel (POCSAG or FLEX), 30 min                                                         | "POCSAG decoded (capcode …)" or "FLEX decoded …" per message burst; no noise discoveries between bursts                                                               |
| N2  | ISM/IoT 433.92 MHz and 868 MHz, 30 min each                                                    | no noise discoveries; a proven ISM discovery carries an rtl433 decode (ambient or live probe; no replay for rtl433, WG11 6.7); undecoded bursts stay `weak`           |
| N3  | Aviation: ACARS and VDL2 channels with their ambient decoders; ADS-B decoder running alongside | "ACARS decoded (…)", "VDL2 decoded (…)" (ambient); ADS-B has no scanner protocol: pass = no noise discoveries and no core CPU increase ≥ 0.3 core with the scanner on |
| N4  | AIS channels A and B                                                                           | "AIS decoded (MMSI …)" (ambient)                                                                                                                                      |
| N5  | APRS channel of the region                                                                     | "APRS decoded (<call>)" via direwolf replay                                                                                                                           |
| N6  | Random voice: airband AM, 2 m / 70 cm FM, digital voice where present                          | "Analog AM voice", "Analog FM voice[, CTCSS …]", "<Protocol> decoded (…)" or "Digital, not decoded (tried …)"; no prior-derived label anywhere                        |

Results go into the spec status and docs/SCANNER.md generically.

## Coordination note text

Main appends this by hand to `docs/CLI-COORDINATION.md` (no Prettier) when the lanes merge:

> #### Core: WG12 scanner redesign (parking, channel gate, evidence-only labels, analog replay trial, scan phases) — <merge date, filled by Main>
>
> Announcement for the CLI and for the web session. Spec: [scanner-redesign](specs/scanner-redesign/requirements.md). Details in [API.md](API.md). One closed enum was widened in `@wavekit/api-types` (`ScannerTrialOutcome` gains `data-like` and `carrier-only`), `ScannerIdentifyTrial.decoder` gains `analog-demod`, and `ScannerIdentifyResult.ended` gains `no-signal`. Every new field is optional (older cores omit them). No route, WebSocket event type, state or error code was added.
>
> 1. Labels come only from evidence. `Discovery.protocol` stays `unknown` until a decode or an analog trial names something; priors no longer produce "Maybe X". Show `discovery.proof.summary` (fixed English, at most 160 characters: "DMR decoded (CC1, TG 9)", "Analog FM voice, CTCSS 88.5", "Digital, not decoded (tried DMR, dPMR, NXDN)", "Carrier only"). `evidenceLevel` is `proven` or `weak`; request `GET /api/scanner/discoveries?evidence=proven` for the result list and offer "show weak activity" (`evidence=all`, today's default answer). Each observation has its own `proof` (analog or digital per transmission).
> 2. Only real transmissions surface. A channel-matched gate (channel width from the range, 300 ms at 6 dB channel SNR by default; bursts 100 ms at 9 dB) replaces the old surfacing rules. On `spectrum:frame` tracks, `surfaced` now means "passed the gate"; new optional `gate` (`pending` | `passed`) and `channelSnrDb`. Keep keying by (`sourceId`, `trackId`).
> 3. A window that fits stays tuned. A one-hop scan parks: no retune, no epoch change, track ids stay for a whole transmission. `sweepPeriodMs` is null while parked; progress has `parked: true`.
> 4. What the scan is doing: `ScanJobProgress` / `scanner:progress` gain `phase` (`settling`, `holding`, `trialing`, `replaying`, `capturing`, `watching`), `holding { discoveryId, frequencyHz, trackId }`, `trial { protocol, decoder, transport, discoveryId }` and `replayQueueDepth`.
> 5. Trials: the analog replay trial shows as `decoder: "analog-demod"`, `mode: "nfm" | "am"`, `transport: "replay"`, outcomes `decoded` (tone or DCS), `heard` (voice), `data-like`, `carrier-only` or `no-sync`. A missing decoder program is `unsupported` with reason `decoder-unavailable` on every path (never `no-sync`) and appears in `proof.unavailable`. Web: `web/src/data/scanner-format.ts` `TRIAL_OUTCOMES: Record<ScannerTrialOutcome, string>` fails the web typecheck once it pulls these api-types; add `data-like` ("Data-like") and `carrier-only` ("Carrier only"), and label `analog-demod` (for example "Analog (from capture)").
> 6. Decode here: `POST /api/scanner/identify` with `{ target: { frequencyHz }, waitUntilSignal: true, waitMs? }` waits (default 5 min, at most 10 min) for the next gated transmission; `timeoutMs` then counts from its start; no transmission ends `unidentified` with `result.ended: "no-signal"`.
> 7. Also: `GET /api/scanner/discoveries?nearHz=&toleranceHz=` (default 6 250 Hz, at most 1 MHz, sorted by distance); `scanner:discovery` `merged` events carry `mergedIds`; `LiveAudioStatus.tone { ctcssHz, dcs, at }` while live audio runs; the live-audio channel's closed transmissions now attach analog evidence to the matching discovery automatically.
> 8. IQ capture and replay: unchanged and off by default until the live acceptance passes; then on by default in protected mode (legacy needs `scanner.iqCapture.allowLegacy: true`). A follow-up note announces the flip.
> 9. CLI: nothing breaks. `cli/source/data/scanner-guards.ts` accepts the new outcomes and `ended: "no-signal"` (widened in the contract commit); the discovery, progress and frame guards strip the new fields. Pinned by `tests/unit/core/scanner-redesign-contract.test.ts`.
>
> For the web session: result list = `evidence=proven` with `proof.summary`; "show weak activity" toggles `evidence=all`; a scan header from `phase`, `parked`, `holding`, `trial` and `replayQueueDepth`; "Decode here" = identify with `waitUntilSignal`; `docs/web/CORE-GAPS.md` can tick identify until a transmission, `nearHz`, `mergedIds`, `progress.holding`, missing decoder reported as unavailable, analog versus digital per transmission, tone on live status, the CTCSS trial, and the automatic identify of the live-audio channel.

## Correctness properties

1. **Noise never passes the gate.** For random noise blocks (exponential bins around random
   floors), random narrow blips (width ≤ 30 % of the channel, per-bin SNR ≤ 10 dB, any duration)
   and random masks, no track's gate is `passed`; for random channel-filling signals with channel
   SNR ≥ `kCh + margin` for ≥ the minimum duration, the gate passes within the duration plus one
   block. _Validates 2.2–2.4._
2. **The gate is channel-matched.** For random power and floor arrays, plans and masks, each
   slot's `channelSnrDb` equals 10·log10 of the bin sums over its unmasked in-passband bins
   (within 1e-6 relative), a slot with more than half its bins masked is never tested, and
   chunking blocks differently gives the same states. _Validates 2.1, 2.2, 2.7._
3. **A fitting window stays tuned.** For random one-hop plans and random event sequences
   (blocks, holds, probes, range edits keeping the centre, `afterSweeps`), the scheduler emits
   exactly one tune action, `sweep-complete` once per elapsed dwell, and `sweepPeriodMs` null;
   for multi-hop plans no tune action targets the hop being visited. _Validates 1.1, 1.3, 1.4._
4. **Same-centre retune writes nothing.** For random lease, write and epoch histories, `retune`
   writes nothing and keeps the epoch iff the holder asks for the written, accepted centre, rate
   and gain with a verified epoch; otherwise today's writes happen. _Validates 1.2._
5. **Track ids survive parking.** For random block sequences of one emission with gaps shorter
   than the hang, under a parked job, the emission carries one `trackId` on every frame and
   every observation. _Validates 1.5, 2.6._
6. **Only gated tracks surface.** For random track streams with random gate states, the store
   creates or updates a discovery only from `passed` tracks, and a `below` track changes nothing
   but the transient count. _Validates 2.5, 4.1._
7. **Labels only from evidence.** For random classes, hypotheses, priors and band plans without
   trial evidence, every discovery's `protocol` is `unknown`, its confidence `activity` and its
   proof absent; adding a random evidence sequence sets `protocol` and confidence exactly as
   requirements 3.1 and 3.2 state. _Validates 3.1–3.3, 3.9._
8. **Proof is a function of the evidence.** For random evidence sets, `deriveProof` is
   deterministic, `tried` holds only trials that ran (never an unavailable decoder, never
   `unsupported`, `skipped-budget`, `cancelled` or `pending`), `unavailable` is sorted and unique,
   the discovery proof is the strongest-then-newest observation proof, and `summary` matches the
   grammar and is at most 160 characters. _Validates 3.4, 3.5, 4.5._
9. **The filter partitions.** For random stores and queries, `proven` and `weak` are disjoint,
   their union is `all`, `all` and an absent parameter equal today's answer byte for byte, and
   `nearHz` returns exactly the discoveries within the tolerance sorted by distance then id.
   _Validates 3.6, 3.7, 7.6._
10. **The analog trial decides by its rules.** For random statistics and tone results the
    outcome follows the decision order; for synthetic captures (NFM voice-like with and without
    CTCSS/DCS, 4FSK, GMSK, carrier, noise) at 10–20 dB channel SNR the outcome is the expected
    one. _Validates 5.3, 5.4._
11. **Analyze is chunk-invariant.** For random chunkings of a synthetic capture, the `analyze`
    statistics and audio are identical, and the audio rate is 8 000 Hz. (Rust proptest.)
    _Validates 5.2._
12. **Replay order and stop.** For random plans, priors, known protocols and outcome sequences,
    the known protocol runs first, then at most one analog trial, then digital trials by score;
    after `decoded` or `heard` from the analog trial no digital trial runs; at most 8 trials run;
    every capture still ends with one result and one discard. _Validates 4.4, 4.6, 5.5._
13. **Replay before live in scans.** For random gated tracks, capture availabilities and replay
    timings, a live confirm hold starts only in the cases of requirement 4.2. _Validates 4.2,
    4.3._
14. **Waiting identify ends honestly.** For random gated-transmission timings, `waitMs` and
    `timeoutMs`, a target ends `no-signal` iff no gated transmission began within `waitMs`, and
    otherwise its trial timeout counts from the gated start. _Validates 6.1._
15. **Phase follows the precedence.** For random scheduler phases, parked flags, live probes and
    activity views, `jobPhase` returns the first applicable phase of requirement 7.1, `holding`
    is present iff the phase is `holding` or `trialing`, and `sweepPeriodMs` is null whenever
    `parked`. _Validates 7.1–7.4, 1.3._
16. **Live-audio evidence attaches only where it belongs.** For random closed transmissions
    (trust, frequency, tone, DCS) and stores, evidence attaches only on `commanded` or `relay`
    frequencies within the tolerance of an existing discovery, never creates one, and gives
    `decoded` iff a tone or code was heard. _Validates 6.3, 6.5._
