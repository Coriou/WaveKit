# Scanner Redesign (WG12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scanner report only real transmissions, park on a window that fits, label only from trial evidence (with a derived proof), confirm through IQ capture and replay first (including an analog replay trial on the Rust NFM/AM kernel), and expose what the scan is doing.

**Architecture:** Main freezes the contract first (task 0.1). Four lanes then run in parallel on pairwise disjoint files: DT (parking, channel gate, profiling), EV (evidence-only labels, proof, API filters, unavailable decoders), RP (replay first, analog replay trial, `wavekit-iqcap analyze`) and ID (identify wait, live-audio evidence, job phase). Lanes deliver changes to Main-owned seams (`scanner-service.ts`, `src/index.ts`, `src/config.ts`, `live-demodulator.ts`) as exact diffs, which Main applies in the order DT, EV, RP, ID. A lane never compiles against a member that another lane adds: cross-lane store access goes only through the structural interfaces frozen in 0.1 (`ObservationEvidenceSink`, `DiscoveryNearQuery`), lane tests use fakes of those interfaces, and the real-store scanner-service tests run at Main's merge step (MA.1). The capture default flip comes last, after live acceptance.

**Tech Stack:** TypeScript (Node 24, ESM, strict), Vitest + fast-check, Zod, Fastify, worker_threads spectrum worker, Rust (`native/wavekit-chan`, proptest) for `wavekit-iqcap`.

**Spec:** `docs/specs/scanner-redesign/requirements.md`, `docs/specs/scanner-redesign/design.md`, `docs/specs/scanner-redesign/tasks.md`. Dependency spec: `docs/specs/rust-demod-a/` (lives on the rust-demod-a branch until it merges). Requirement numbers are stable; the plan cites them as `R x.y` and design properties as `P n`.

## Global Constraints

- Public repository: never copy `.agents/` content, memory, live values, frequencies of private users, IPs, job ids, identifiers, review or reviewer names into tracked files, commits or code comments.
- Spec files stay in `docs/specs/scanner-redesign/{requirements,design,tasks}.md`; never renumber requirements. Spec amendments are diffs Main applies.
- Property tests: fast-check `numRuns >= 100`, each with `// Feature: scanner-redesign, Property N: <name>` and `// Validates: Requirements X.Y`. Rust properties use proptest with the same comment.
- Hot path (`docs/PERFORMANCE.md`): per-sample IQ work at or above channel rate belongs in Rust under `native/`; no new csdr or `sh -c` DSP chain; no extra full-rate fanout branch; at most 2 ms added event-loop delay p99 at 2.048 Msps; nothing allocated per IQ chunk; new Rust code MIT/Apache, no FFTW or VOLK, no port from GPL code; no new npm dependency; no new crate dependency (adding one is a Main `Cargo.toml` change and needs an amendment).
- Defaults: with the shipped config every route, frame, log line, argv and receiver write is byte-identical to the WG11 base except the changes listed in requirements § Defaults. Each lane lists every golden it changes with the requirement that changes it. Access default stays `legacy`. Capture stays off by default until MA.6.
- Contracts back-compatible: every new DTO field optional; enum widenings land only in the 0.1 commit together with `cli/source/data/scanner-guards.ts` and `tests/unit/cli/scanner-guards.test.ts`. No route, WebSocket event type, state or error code is added. `docs/CLI-COORDINATION.md` is appended by hand, never run through Prettier.
- Pinned, never edited: `src/core/scanner/bandplan/index.ts`, `src/core/scanner/bandplan/builtin.ts`, `src/decoders/band-region.ts`, `src/decoders/band-defaults.ts`.
- Lanes do no RF, tuning, receiver, Raspberry Pi, Docker, deploy or network work. Tests use fakes, temp dirs, synthetic IQ and audio, injected clocks, and only ephemeral `127.0.0.1` ports (port 0). Never 9000, 5173, 8081, 8082, 15555, 15556, 18080, never `host.docker.internal`. Only Main runs live acceptance.
- Main-only seams: `src/index.ts`, `src/api/server.ts`, barrels, `src/config.ts`, `config/*.yaml`, `packages/**`, `docs/**`, `cli/**`, `src/core/scanner/scanner-service.ts`, `src/core/scanner/types.ts`, `src/core/spectrum/types.ts`, the contract modules (`scanner-redesign-contract.ts`, `iq-capture-contract.ts`, `identify-analog-contract.ts`), `src/core/live-demodulator.ts`, `package.json`, the lockfile, `Dockerfile`, `Makefile`, `native/wavekit-chan/Cargo.toml`, `Cargo.lock`, `native/wavekit-chan/src/lib.rs`.
- Code conventions (AGENTS.md): strict TS, ESM with `.js` relative imports, `import type`, no `any`, no `console.log` (use `createComponentLogger`), throw `WaveKitError` family, Zod at boundaries, tabs, no semicolons, double quotes, `x => ...`.
- Commits: `git commit -m "..." -- <paths>` with only your own paths; never `git add -A`; no push unless the brief says so. Each lane works in its own git worktree off the 0.1 commit.
- Lane workflow: each lane is an orchestrator delegating implementation to an implementer agent, with a final independent review of at most 3 rounds. Before reporting done: touched tests, `pnpm run typecheck`, `pnpm run lint`, and `make chan-test` when Rust is touched. Report base/head, commits, check output and the changed-golden list. No full root suite in lanes (Main runs it at MA.3).

## Review Focus

1. **A parked job whose job runner waits for a tune that never comes.** After a one-hop `leaveHop` returns no tune action, the job runner must keep dwelling, counting sweeps and serving holds. Test: DT.2 `scheduler-parked-job-runner.test.ts` drives the real `JobRunner` with a parked scheduler for 10 dwells and asserts `sweepIndex` advances by 10 and zero `arbiter.retune` calls after the first.
2. **Tracks with no gate field.** Engines without a channel plan (and stored or replayed observations) produce tracks with `gate` absent. A reasonable person expects no crash, no discovery from noise, and the old display rule on frames. Test: EV.1 `discovery-store-gate.test.ts` "absent gate is treated as pending" and DT.1c `frame-tracks.test.ts` "absent gate keeps the minSurfaceBlocks display rule".
3. **A plan edit that moves a parked one-hop job to a new centre while a hold or capture is open.** Expect exactly one tune, the hold ended, the capture finishing under WG11 rules. Test: DT.2 `scheduler-parking.test.ts` "replan to a new centre leaves the park with one tune".
4. **Analyze on a truncated or gap-carrying capture** (fewer than 80 frames, `gapSamples > 0`, a zero-length file). Expect a bounded event with fewer frames and a classification, never a hang or `decoded` from silence. Test: RP.2 `analyze_short_and_gap_captures` (Rust) and RP.3 `analog-trial-runner.test.ts` "zero-frame analysis ends no-sync".
5. **A replay trial whose decoder program is missing.** Today it becomes `cancelled` (or `no-sync` for an upstream stage). Expect `unsupported`, the type in `unavailable`, no known-protocol miss. Test: RP.1c `pool-adapter.test.ts` "exit 127 before output maps to unsupported and lists the type".
6. **Proof after a restart.** Trial, analog and unavailable evidence is in memory only (A12). A reader may expect a restart to keep "Analog FM voice, CTCSS 88.5". It does not: that discovery becomes `weak`, while a discovery whose observation holds a persisted decode stays `decoded`. Both restart cases are tested in EV.2 `discovery-store-evidence-sink.test.ts`, and the journal and snapshot bytes are unchanged by the sink.

## Assumptions and spec gaps (explicit, not blocking)

- **A1 Kernel API.** Research shows rust-demod-a froze `wavekit_chan::demod::{Modulation, DemodConfig, Demodulator, block_power_dbfs, NoiseMeter}`, not the `DemodKernel` the scanner design assumed. Its output rate equals its input rate, and `process(input, out)` needs `out.len() == input.len() <= max_chunk`. RP.2 plans against `Demodulator`/`DemodConfig` (R 5.1 allows this: "the lane adapts its own module only"). `analyze` runs the kernel at 48 000 Hz with `low_pass_hz: Some(3_400.0)`, then decimates by 6 to 8 000 Hz using the crate's existing `stages::RationalFir` (L = 1, M = 6) with a `design.rs` prototype.
- **A2 Complex type.** The crate has no `Complex32` and no `num-complex`. `stages.rs` uses split I/Q slices. RP.2 uses whatever complex type rust-demod-a introduces and re-exports from `demod`, and adds no dependency.
- **A3 Quieting statistic.** `NoiseMeter` measures a different band (an RBJ high-pass at 0.3 × rate) than design § Statistics (3.5–12 kHz). RP.2 keeps its own discriminator statistic (`hfNoiseDb`) as the design specifies, and reuses `block_power_dbfs` for `carrierDb`. No amendment is needed.
- **A4 Analyze transport.** The 4 KiB control-line protocol belongs to the long-lived `run` process. `analyze` becomes a sibling argv subcommand of `replay` (`wavekit-iqcap analyze --in <abs file> --mode nfm|am`), using the same input convention as `replay`. Stdout carries s16le 8 kHz audio. The single JSON event line goes on fd 4. The 4 KiB bound and both-side validation from the design apply to that event line. This is a 0.1 design amendment, already written into design.md (§ Contract › Amendments and § Analog replay trial) and tasks.md RP.2. 0.1 also adds an optional port method `IqCapturePort.openAnalyze?` (below), so the analog runner never reaches into the service internals.
- **A5 Unsupported on replay.** `IqReplayTrialOutcome` gets `"unsupported"` (added in 0.1) so the replay path can carry R 4.5. It is internal and not a DTO widening.
- **A6 Scope of "decoder program missing".** Probe decoders run as `/bin/sh -c "<csdr…> | <decoder>"` without `pipefail`, so only the last stage's 126/127 (and spawn ENOENT/EACCES) are detectable. R 4.5 is implemented for those. A missing upstream DSP stage still ends `no-sync`. Fixing that would need edits to `src/decoders/audio-demod-decoder.ts` and `iq-decimate-decoder.ts`, which no lane owns. This is recorded as an open gap for MA.2 / ROADMAP.
- **A7 Channel plan transport.** tasks.md names a "`set-channel-plan` worker message". Research shows every scanner input reaches the worker as a `PipelineInput` that the engine caches and replays on worker restart. DT carries the plan as a new `PipelineInputSchema` kind `"channel-plan"` (same behaviour, and it survives restarts). `src/core/spectrum/spectrum-engine.ts` is added to DT's allocation, since no other lane touches it.
- **A8 Gate on absent field.** A track without `gate` is `pending` for the store (no discovery). Frames keep the old `minSurfaceBlocks` display rule (R 2.5 "keeps only its display role").
- **A9 Wide tracks.** A track whose OBW exceeds one slot uses the covering slots. Its `channelSnrDb` comes from the summed sums of those slots, and its state is `passed` once any covering slot's run passed.
- **A10 kCh persistence.** `kCh` adapts in memory per `rangeKey` and is not persisted (WG11 state export is unchanged, so the defaults goldens stay byte-identical).
- **A11 Burst entries.** `ChannelPlanEntry.burst` is true when the range's protocols intersect the scanner's existing `BURST_PROTOCOLS` (the same rule `updateMasks` uses for `burstRanges`). The pinned band-plan files are read only.
- **A12 Where trial evidence lives.** The shipped `Observation` (`packages/api-types/src/scanner.ts`) has only `decode?` and `hypotheses`, and the store keeps no per-observation trial list today. 0.1 freezes one store ingest API, `ObservationEvidenceSink` (`nextTrialOrder`, `recordTrial`, `recordAnalog`, `recordUnavailable`), and every lane writes through it. EV.2 implements it in `discovery-store.ts`. Nothing else may add evidence to an observation. **The evidence lives only in memory.** It goes into a private side table of `DiscoveryStore` keyed by observation id. It is not a field on the `Observation` record, it is not in the snapshot, it writes no journal entry, and it is not in any persistence or mirror payload. This follows R 3.5 ("derived from stored evidence … never persisted as a new store field") and R 3.3 (a record without proof is `weak`). The consequence: after a restart, only proofs rebuilt from persisted `Observation.decode` (live, replay or ambient decodes) survive, as `decoded`. `analog-tone`, `analog-voice`, `digital-undecoded` and `carrier-only` proofs are lost, and those discoveries become `weak` until new evidence arrives. Main records this in docs/SCANNER.md as designed behaviour and adds the ROADMAP follow-up "persist trial evidence across restart" (WG13) (MA.2); the spec lists it under tasks.md § Open items. Because of this choice, `store/schemas.ts`, `persistence.ts`, the snapshot and mirror modules, and the journal bytes stay unchanged. The DT, EV, RP and ID scanner-service diffs touch no persistence call. The persistence and journal goldens stay byte-identical. The store-seed goldens change only through EV.1, because their drivers record no trial evidence.

## Lane and dependency overview

| Task      | Owner | Needs                                                                           | Parallel with                                       |
| --------- | ----- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| 0.1       | Main  | –                                                                               | –                                                   |
| DT.0–DT.3 | DT    | 0.1                                                                             | EV, RP.1, ID                                        |
| EV.1–EV.4 | EV    | 0.1                                                                             | DT, RP.1, ID                                        |
| RP.1      | RP    | 0.1 (`ObservationEvidenceSink` only; fakes in tests)                            | DT, ID; EV only through the 0.1 contract interfaces |
| RP.2      | RP    | rust-demod-a task 2 merged                                                      | –                                                   |
| RP.3      | RP    | RP.2                                                                            | –                                                   |
| ID.1–ID.4 | ID    | 0.1 (`ObservationEvidenceSink`, `DiscoveryNearQuery`; ID.4 uses a fake runner)  | DT, RP; EV only through the 0.1 contract interfaces |
| MA.1–MA.6 | Main  | lanes merged in order DT, EV, RP, ID; real-store scanner-service tests after EV | –                                                   |

RP and ID never import a `DiscoveryStore` member that EV adds (`near`, `nextTrialOrder`, `recordTrial`, `recordAnalog`, `recordUnavailable`). Their lane-local code and tests type against `ObservationEvidenceSink` and `DiscoveryNearQuery` from `scanner-redesign-contract.ts`, with fakes implementing them. Their scanner-service and index wiring diffs are checked in the lane with `git apply --check` against the 0.1 commit plus their own unit tests using fakes; the scanner-service tests against the real store run only at MA.1, after EV has merged.

Shared goldens: EV.1 owns regenerating `tests/unit/core/scanner/identify-analog-goldens.test.ts`/`.json` and `tests/unit/core/scanner/identify-narrow-digital-goldens.test.ts`/`.json`. No other lane rewrites those files; ID adds golden files of its own if it needs any, and Main reconciles at merge.

Research status: rust-demod-a has only its spec, with all 9 tasks unchecked and no `native/wavekit-chan/src/demod/`. RP starts RP.1 at once. RP.2 waits for rust-demod-a task 2 (kernel `demod/`, `NoiseMeter`). RP.3's pure classifier (RP.3a) can start before RP.2 on synthetic statistics. Its calibration step waits for RP.2.

---

## Main: Task 0.1 Freeze the contract

**Files:**

- Modify: `packages/api-types/src/scanner.ts`, `packages/api-types/src/spectrum.ts`, `packages/api-types/src/live-audio.ts`
- Modify: `src/core/scanner/types.ts` (identical DTO copies), `src/core/spectrum/types.ts` (`TrackSnapshot.gate?`, `channelSnrDb?`, `gatePassedSample?`; `BlockTrack.gate?`, `channelSnrDb?`)
- Create: `src/core/scanner/scanner-redesign-contract.ts`
- Modify: `src/core/scanner/iq-capture-contract.ts`
- Modify: `src/config.ts` (`ScannerConfigSchema.iqCapture.allowLegacy`, boolean, default false; `enabled` default unchanged false)
- Modify: `src/api/routes/scanner-schemas.ts` (accepted fields only)
- Modify: `cli/source/data/scanner-guards.ts`
- Test: `tests/unit/core/scanner-redesign-contract.test.ts` (new), `tests/unit/cli/scanner-guards.test.ts`, `tests/unit/core/wg10-contract.test.ts`, `tests/unit/core/wg11-contract.test.ts`, `tests/unit/api/scanner-dto-contract.test.ts`

**Interfaces (produces, frozen by name; lanes import from these):**

The api-types additions are exactly design § Contract row 1–3. Pinned spellings:

```ts
// packages/api-types/src/scanner.ts
export type ScannerProofKind =
	| "decoded"
	| "analog-tone"
	| "analog-voice"
	| "digital-undecoded"
	| "carrier-only"
export type ScannerProofTransport = "live" | "replay" | "ambient"
export interface ScannerProof {
	kind: ScannerProofKind
	protocol: ScannerProtocol
	transport: ScannerProofTransport
	at: string
	observationId: string
	identity?: Identity
	talkgroup?: string
	tone?: { ctcssHz: number | null; dcs: AnalogTransmissionDcs | null }
	voice?: boolean
	tried: ScannerProtocol[]
	unavailable: ScannerProbeDecoderType[]
	encrypted: boolean
	summary: string
}
export type ScannerEvidenceLevel = "proven" | "weak"
export type ScanJobPhase =
	| "settling"
	| "holding"
	| "trialing"
	| "replaying"
	| "capturing"
	| "watching"
export interface ScannerDiscoveryQueryParams {
	evidence?: "proven" | "weak" | "all"
	nearHz?: number
	toleranceHz?: number
}
// + IDENTIFY_WAIT_DEFAULT_MS = 300_000, IDENTIFY_WAIT_MAX_MS = 600_000, IDENTIFY_WAIT_MIN_MS = 1_000,
//   DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ = 6_250, DISCOVERY_NEAR_MAX_TOLERANCE_HZ = 1_000_000,
//   SCANNER_PROOF_SUMMARY_MAX_CHARS = 160, SCANNER_PROOF_TRIED_MAX = 16, DISCOVERY_MERGED_IDS_MAX = 64,
//   SCANNER_PROOF_PROTOCOL_LABEL (design § Proof labels, every ScannerProtocol key)
```

`scanner-redesign-contract.ts` holds every constant and type in design § Contract row "scanner-redesign-contract.ts" with the listed values, plus:

```ts
export interface AnalogTrialFrame {
	carrierDb: number
	hfNoiseDb: number
	audioDb: number
	syllabic: number
	cluster: number
}
export interface AnalogTrialStats {
	mode: AnalogTrialMode
	frames: readonly AnalogTrialFrame[]
	gapSamples: number
	floorDb: number
}
export interface AnalogTrialTones {
	ctcssHz: number | null
	dcs: AnalogTransmissionDcs | null
	audioSeconds: number
}
export interface AnalogTrialResult {
	outcome: AnalogTrialOutcome
	mode: AnalogTrialMode
	voice: boolean
	tones: AnalogTrialTones
	stats: AnalogTrialStats | null
	error?: "capture-gone" | "analyze-failed" | "cancelled" | "unavailable"
}
export interface AnalogTrialRunner {
	run(
		captureId: string,
		mode: AnalogTrialMode,
		signal: AbortSignal,
	): Promise<AnalogTrialResult>
}
export interface JobActivityView {
	capturing: number
	replaying: {
		protocol: ScannerProtocol
		decoder: string
		discoveryId: string | null
	} | null
	replayQueueDepth: number
}
export interface JobPhaseInput {
	schedulerPhase: "tuning" | "settling" | "hold" | "dwell" | null
	parked: boolean
	liveProbe: {
		protocol: ScannerProtocol
		decoder: string
		transport: "offset" | "channel"
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	} | null
	hold: {
		discoveryId: string | null
		frequencyHz: number
		trackId: string
	} | null
	activity: JobActivityView
}
export interface ProofDecodeInput {
	protocol: ScannerProtocol
	transport: ScannerProofTransport
	at: number
	identity?: Identity
	talkgroup?: string
	encrypted: boolean
}
export interface ProofTrialInput {
	protocol: ScannerProtocol
	decoder: string
	outcome: ScannerTrialOutcome
	order: number
	at: number
}
export interface ProofAnalogInput {
	outcome: AnalogTrialOutcome
	mode: AnalogTrialMode
	voice: boolean
	tone: { ctcssHz: number | null; dcs: AnalogTransmissionDcs | null }
	transport: ScannerProofTransport
	at: number
}
export interface ProofInput {
	observationId: string
	decodes: readonly ProofDecodeInput[]
	trials: readonly ProofTrialInput[]
	analog: readonly ProofAnalogInput[]
	unavailable: readonly ScannerProbeDecoderType[]
	trust: TuningTrust
	digitalPlanComplete: boolean
}
/** A12: the only way evidence reaches an observation's ProofInput. Implemented by DiscoveryStore (EV.2); in memory only. */
export const PROOF_TRIALS_MAX_PER_OBSERVATION = 32
export const PROOF_ANALOG_MAX_PER_OBSERVATION = 8
export interface ObservationEvidenceSink {
	/** Monotonic per store instance, starting at 1; callers take one value when a trial starts. */
	nextTrialOrder(): number
	/** Upsert keyed by (protocol, decoder, order): a later outcome for the same key replaces the earlier one. */
	recordTrial(observationId: string, trial: ProofTrialInput): boolean
	/** Appends; exact duplicates (same outcome, mode, transport, at) are ignored. */
	recordAnalog(observationId: string, analog: ProofAnalogInput): boolean
	/** Set semantics; kept sorted. */
	recordUnavailable(
		observationId: string,
		type: ScannerProbeDecoderType,
	): boolean
}
/** Discoveries within toleranceHz of hz (inclusive), sorted by |Δf| then id. Implemented by DiscoveryStore (EV.3). */
export interface DiscoveryNearQuery {
	near(hz: number, toleranceHz: number, sourceId?: string): Discovery[]
}
export type AnalyzeEvent =
	| { event: "analysis"; frames: AnalogTrialFrame[]; gapSamples: number }
	| {
			event: "error"
			code: "bad-args" | "open-failed" | "bad-file" | "kernel-config" | "io"
	  }
export const ANALYZE_EVENT_MAX_BYTES = 4_096
```

`iq-capture-contract.ts` additions: `IqReplayTrial.kind?: "probe" | "analog"`, `IqReplayTrial.analogMode?: AnalogTrialMode`. `IqReplayTrialOutcome` gains `"heard" | "data-like" | "carrier-only" | "unsupported"` (A5). `IqReplayResult.trials[]` gains optional `decoder?: string`, `mode?: AnalogTrialMode`, `reason?: "decoder-unavailable"`. `IqReplayResult.analog?: AnalogTrialResult`. `IqReplayResult.unavailable?: ProbeDecoderType[]`. `IqCapturePort.openAnalyze?(captureId: string, mode: AnalogTrialMode): { audio: Readable; event: Promise<AnalyzeEvent>; kill(): void } | null` (A4).

`DiscoveryNearQuery` is frozen next to `ObservationEvidenceSink` in the same module. `DiscoveryStore` implements it in EV.3 (`class DiscoveryStore implements ObservationEvidenceSink, DiscoveryNearQuery` once both EV.2 and EV.3 land). ID.3 consumes it as a structural type; no lane other than EV names `DiscoveryStore.near`.

`ObservationEvidenceSink` semantics, frozen here and implemented in EV.2. Lanes code against this interface, and their tests use a fake of it.

- Every method returns `false` and does nothing when the observation id is unknown or was removed. It never throws. It returns `true` only when the observation's `ProofInput` changed.
- A `true` return re-derives the owning discovery's proof (through the cache keyed by discovery version) and emits the store's existing `updated` discovery change to listeners. It does this with no journal entry and no dirty mark for persistence.
- Bounds: trials keep the `PROOF_TRIALS_MAX_PER_OBSERVATION` entries with the highest `order`. Analog keeps the `PROOF_ANALOG_MAX_PER_OBSERVATION` newest entries by `at`. Unavailable is bounded by the `ScannerProbeDecoderType` enum.
- Side-table entries are deleted whenever their observation leaves the store: retention trim, eviction, `pruneInactive`, `delete` or `restore`. They follow the observation id through `settle()` merges and `rekey`, because the observation id does not change. `snapshot()`, `restore()` and `replay()` neither read nor write them.
- Which callers use it, and where `order` comes from:
  - Live probes (EV.4 diff): take `nextTrialOrder()` when the probe starts, then call `recordTrial` on each state change that carries an outcome. An unavailable decoder adds `recordUnavailable`.
  - Replay results (RP.1c diff): in `applyReplayResult`, take consecutive `nextTrialOrder()` values in the result's trial order, because a replay's trials run one at a time. Then call `recordTrial` per trial (skipping `not-needed`), `recordAnalog` for `result.analog` with transport `replay`, and `recordUnavailable` per `result.unavailable` entry.
  - Live audio (ID.3): `recordAnalog` with transport `live`.
  - Decodes keep using the existing `appendObservationEvidence`, which is persisted. The proof's `decodes` input comes from `Observation.decode`.

- [ ] **Step 1: Write the failing contract test** `tests/unit/core/scanner-redesign-contract.test.ts`, following the style of `tests/unit/core/wg11-contract.test.ts`:

```ts
it("pins the gate arithmetic", () => {
	expect(CHANNEL_GATE_K_DB + CHANNEL_GATE_MARGIN_DB).toBe(6)
	expect(CHANNEL_GATE_K_DB + CHANNEL_GATE_BURST_MARGIN_DB).toBe(9)
	expect(CHANNEL_GATE_MIN_DURATION_MS / 50).toBe(6)
	expect(CHANNEL_GATE_BURST_MIN_DURATION_MS / 50).toBe(2)
	expect(CHANNEL_GATE_MAX_MASKED_FRACTION).toBe(0.5)
	expect(CHANNEL_GATE_MAX_SLOTS).toBe(4_096)
})
it("pins the analog trial frame budget", () => {
	expect(ANALOG_TRIAL_MAX_FRAMES * ANALOG_TRIAL_FRAME_MS).toBe(
		IQ_CAPTURE_MAX_MS,
	)
	expect(ANALOG_TRIAL_CORES).toBe(0.05)
})
it("pins the proof summary examples (R 3.5)", () => {
	const examples = [
		"DMR decoded (CC1, TG 9)",
		"Analog FM voice, CTCSS 88.5",
		"Digital, not decoded (tried DMR, dPMR, NXDN)",
		"Carrier only",
	]
	for (const s of examples)
		expect(s.length).toBeLessThanOrEqual(SCANNER_PROOF_SUMMARY_MAX_CHARS)
	expect(SCANNER_PROOF_SUMMARY_MAX_CHARS).toBe(160)
	expect(SCANNER_PROOF_TRIED_MAX).toBe(16)
	expect(DISCOVERY_MERGED_IDS_MAX).toBe(64)
	// SCANNER_PROOF_PROTOCOL_LABEL is Record<ScannerProtocol, string>, so tsc enforces every key
	expect(SCANNER_PROOF_PROTOCOL_LABEL.dmr).toBe("DMR")
	expect(SCANNER_PROOF_PROTOCOL_LABEL.dpmr).toBe("dPMR")
	expect(SCANNER_PROOF_PROTOCOL_LABEL.nxdn48).toBe("NXDN")
	expect(SCANNER_PROOF_PROTOCOL_LABEL.nxdn96).toBe("NXDN")
})
it("CLI guards accept every new value and strip nothing they must keep", () => {
	// guardScan, guardSpectrumFrame and the SCAN_* fixtures are the existing ones
	// (cli/source/data/scanner-guards.ts, cli/source/test/fixtures.ts); no new guard is added
	const target = SCAN_JOB.identify.targets[0]
	const jobWith = (patch: object) => ({
		...SCAN_JOB,
		identify: { ...SCAN_JOB.identify, targets: [{ ...target, ...patch }] },
	})
	const trial = (outcome: string, decoder = "dsd-fme") => ({
		protocol: "dmr",
		decoder,
		mode: null,
		transport: "replay",
		outcome,
	})
	for (const outcome of ["data-like", "carrier-only"])
		expect(
			guardScan("job", jobWith({ trials: [trial(outcome)] }))?.identify
				?.targets[0]?.trials[0]?.outcome,
		).toBe(outcome)
	expect(
		guardScan("job", jobWith({ trials: [trial("heard", "analog-demod")] }))
			?.identify?.targets[0]?.trials[0]?.decoder,
	).toBe("analog-demod")
	expect(
		guardScan(
			"job",
			jobWith({ result: { ...target.result, ended: "no-signal" } }),
		)?.identify?.targets[0]?.result?.ended,
	).toBe("no-signal")
	expect(
		guardScan("job", jobWith({ result: { ...target.result, ended: "bogus" } })),
	).toBeUndefined()
	const proof = {
		kind: "carrier-only",
		protocol: "unknown",
		transport: "replay",
		at: "2026-01-01T00:00:00.000Z",
		observationId: "o1",
		tried: [],
		unavailable: [],
		encrypted: false,
		summary: "Carrier only",
	}
	expect(
		guardScan("discovery", {
			...SCAN_DISCOVERY,
			proof,
			evidenceLevel: "proven",
			mergedIds: ["d2"],
		}),
	).toBeDefined()
	const progress = {
		...SCAN_JOB.progress,
		phase: "trialing",
		parked: true,
		holding: { discoveryId: null, frequencyHz: 446_006_250, trackId: "t1" },
		trial: {
			protocol: "dmr",
			decoder: "dsd-fme",
			transport: "replay",
			discoveryId: null,
		},
		replayQueueDepth: 0,
	}
	expect(guardScan("job", { ...SCAN_JOB, progress })).toBeDefined()
	const tracks = Array.from({ length: 256 }, (_, i) => ({
		...SCAN_FRAME.tracks[0],
		trackId: `t${i}`,
		gate: "passed",
		channelSnrDb: 7.5,
	}))
	expect(guardSpectrumFrame({ ...SCAN_FRAME, tracks })?.tracks).toHaveLength(
		256,
	)
})
it("config: absent iqCapture parses to the WG11 output; allowLegacy defaults false", () => {
	expect(ScannerConfigSchema.parse({}).iqCapture).toEqual(wg11IqCaptureDefault)
	expect(
		ScannerConfigSchema.parse({ iqCapture: { enabled: true } }).iqCapture
			?.allowLegacy,
	).toBe(false)
})
it("pins the evidence sink bounds (A12)", () => {
	expect(PROOF_TRIALS_MAX_PER_OBSERVATION).toBe(32)
	expect(PROOF_ANALOG_MAX_PER_OBSERVATION).toBe(8)
	const sink: ObservationEvidenceSink = {
		nextTrialOrder: () => 1,
		recordTrial: () => false,
		recordAnalog: () => false,
		recordUnavailable: () => false,
	}
	expect(sink.nextTrialOrder()).toBe(1)
})
it("route schemas: waitMs without waitUntilSignal and toleranceHz without nearHz are refused", async () => {
	// Fastify app with identifyBodySchema and discoveryQuerySchema, as in tests/unit/api/scanner-schemas-wg6.test.ts
	const target = { frequencyHz: 446_006_250 }
	expect(
		(await postIdentify({ sourceId: "rtl", target, waitMs: 5_000 })).statusCode,
	).toBe(400)
	expect(
		(
			await postIdentify({
				sourceId: "rtl",
				target,
				waitUntilSignal: true,
				waitMs: 5_000,
			})
		).statusCode,
	).toBe(200)
	expect((await getDiscoveries("toleranceHz=1000")).statusCode).toBe(400)
	expect(
		(await getDiscoveries("nearHz=446006250&toleranceHz=1000")).statusCode,
	).toBe(200)
	expect((await getDiscoveries("evidence=proven")).statusCode).toBe(200)
	expect((await getDiscoveries("evidence=maybe")).statusCode).toBe(400)
})
it("bounds: waitMs 999 and 600001 refused, 1000 and 600000 accepted; toleranceHz 1000001 refused", async () => {
	const body = (waitMs: number) => ({
		sourceId: "rtl",
		target: { frequencyHz: 446_006_250 },
		waitUntilSignal: true,
		waitMs,
	})
	expect(IDENTIFY_WAIT_MIN_MS).toBe(1_000)
	expect(IDENTIFY_WAIT_MAX_MS).toBe(600_000)
	expect(IDENTIFY_WAIT_DEFAULT_MS).toBe(300_000)
	expect(DISCOVERY_NEAR_MAX_TOLERANCE_HZ).toBe(1_000_000)
	expect(DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ).toBe(6_250)
	expect((await postIdentify(body(999))).statusCode).toBe(400)
	expect((await postIdentify(body(1_000))).statusCode).toBe(200)
	expect((await postIdentify(body(600_000))).statusCode).toBe(200)
	expect((await postIdentify(body(600_001))).statusCode).toBe(400)
	expect(
		(await getDiscoveries("nearHz=446006250&toleranceHz=1000000")).statusCode,
	).toBe(200)
	expect(
		(await getDiscoveries("nearHz=446006250&toleranceHz=1000001")).statusCode,
	).toBe(400)
})
it("DiscoveryNearQuery is structural", () => {
	const q: DiscoveryNearQuery = { near: () => [] }
	expect(q.near(446_006_250, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ)).toEqual([])
})
// postIdentify / getDiscoveries: local helpers that app.inject against a Fastify instance registering
// identifyBodySchema (POST /identify, echoing 200) and discoveryQuerySchema (GET /discoveries, echoing 200)
```

- [ ] **Step 2: Run to verify it fails.** Run: `pnpm exec vitest run tests/unit/core/scanner-redesign-contract.test.ts`. Expected: FAIL (module `scanner-redesign-contract.js` not found).
- [ ] **Step 3: Add the contract files, DTO copies, config key, accepted route fields and CLI guard widening** (`trial outcome` enum + `data-like`, `carrier-only`; `ended: z.enum(["window-moved", "no-signal"])`). Amend `wg10-contract`/`wg11-contract` where they pinned `ended` as a literal or the old outcome list. Extend `tests/unit/cli/scanner-guards.test.ts` with the new values.
- [ ] **Step 4: Design amendments.** design.md § Contract › Amendments (task 0.1) already records A4 (analyze as an argv subcommand with its event on fd 4, `openAnalyze`; the § Analog replay trial command text and tasks.md RP.2 are amended to match), A12 (`ObservationEvidenceSink` and `DiscoveryNearQuery`, the two bounds, in-memory-only trial, analog and unavailable evidence, weak after a restart; open item "persist trial evidence across restart", WG13) and the `createAnalogTrialRunner` deps without `process`. Main confirms that text against the committed contract and appends A5 (`unsupported` replay outcome) there. tasks.md already carries A7 (the `spectrum-engine.ts` allocation) and the `tests/mocks/iq/analog-synth.ts` allocation for RP. Do not renumber anything.
- [ ] **Step 5: Verify.** Run: `pnpm exec vitest run tests/unit/core/scanner-redesign-contract.test.ts tests/unit/cli/scanner-guards.test.ts tests/unit/core/wg10-contract.test.ts tests/unit/core/wg11-contract.test.ts tests/unit/api/scanner-dto-contract.test.ts && pnpm run typecheck && pnpm run lint`. Expected: PASS. Then `pnpm run build` (api-types dist for the CLI).
- [ ] **Step 6: Commit** `feat(scanner): freeze the scanner redesign contract` with only the paths above. Lanes branch from this commit.

---

## Lane DT: parking, channel gate, profiling

Allocation: `src/core/spectrum/channel-gate.ts` (new), `detector.ts`, `pipeline.ts`, `pipeline-host.ts`, `spectrum-worker.ts`, `worker-protocol.ts`, `summary-wire.ts`, `frame-tracks.ts`, `spectrum-service.ts`, `spectrum-engine.ts` (A7), `emissions/tracker.ts`; `src/core/scanner/scheduler.ts`, `src/core/scanner/tuner-arbiter.ts`; `scripts/bench/spectrum-profile.ts` (new), `scripts/bench/frame-tracks.ts`. Tests under `tests/unit/core/spectrum/` and `tests/unit/core/scanner/`. Seam output: an exact diff of `scanner-service.ts` (DT.3).

### Task DT.0: Profile first (R 9.1–9.3)

**Files:**

- Create: `scripts/bench/spectrum-profile.ts`
- Modify (instrumentation, off unless enabled): `src/core/spectrum/pipeline.ts` (an optional `profile?: { sampleEvery: number }` option recording `performance.now()` spans for window, fft, power, floor, detector, gate, segmenter+tracker, summary wire, on one block in ten)

**Interfaces:**

- Produces: `PipelineProfile { blocks: number; busyMs: number; stages: Record<"window"|"fft"|"power"|"floor"|"detector"|"gate"|"tracker"|"wire", number> }`, exposed through the existing `export-state` reply only when profiling is on (absent otherwise, so defaults stay byte-identical).

- [ ] **Step 1: Write the failing test** `tests/unit/core/spectrum/pipeline-profile.test.ts`. Assert that with `profile` absent the export-state payload has no `profile` key (deep-equal to the pre-change golden from `pipeline-harness.ts`). Assert that with `profile: { sampleEvery: 10 }` after 100 blocks, `profile.blocks === 10` and every stage is ≥ 0.
- [ ] **Step 2: Run.** `pnpm exec vitest run tests/unit/core/spectrum/pipeline-profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the spans and the bench.** The bench assembles the core in process: a fake rtl_tcp `net.createServer` on `127.0.0.1:0` streaming U8 synthetic noise plus 3 NFM and 2 4FSK channels at 2.048 and 2.4 Msps, one parked job over a 200 kHz scope and the passive job, 120 s per rate. It prints a JSON report with: the worker stage split; engine utilization as the passive guard reads it; main-thread ELU and delay p50/p99 (`perf_hooks.monitorEventLoopDelay`) split by listener (tap feed, summary decode, frame build, scanner ingest, store); `os.loadavg()`; and the verdict line `rustDetectorGate: "met" | "deferred"`. The gate is met when (window+fft+power+wire)/busy ≥ 0.5 and utilization > `PASSIVE_COST_LIMIT_DEFAULT` at 2.048 Msps. It also lists every listener over 1 ms p99.
- [ ] **Step 4: Run the test (PASS) and the bench once on the base.** Run: `pnpm exec esbuild scripts/bench/spectrum-profile.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/spectrum-profile.mjs && node output/bench/spectrum-profile.mjs --seconds 120`. Expected: a report object with both rates. Save the output in the lane report (Main writes `docs/engineering/scanner-profile.md`). Re-run after DT.1.
- [ ] **Step 5: Commit** `feat(spectrum): opt-in worker stage profile and spectrum profile bench`.

### Task DT.1a: Channel gate module (R 2.1–2.4, P1, P2)

**Files:**

- Create: `src/core/spectrum/channel-gate.ts`
- Test: `tests/unit/core/spectrum/channel-gate.test.ts`, `tests/unit/core/spectrum/channel-gate.property.test.ts`

**Interfaces:**

- Consumes: `ChannelPlan`, `ChannelPlanEntry`, `ChannelGateState`, `CHANNEL_GATE_*` from `src/core/scanner/scanner-redesign-contract.ts`; `CFAR_STEP_DB`, `CFAR_MAX_RAISE_DB`, `CFAR_RAISE_WINDOW_MIN`, `CFAR_LOWER_WINDOW_MIN`, `defaultK` from `src/core/spectrum/detector.ts`.
- Produces:

```ts
export interface ChannelGate {
	setPlan(plan: ChannelPlan | null): void
	setFaTargets(
		byRangeKey: ReadonlyMap<string, number>,
		defaultPerMhzMin: number,
	): void
	setPinnedOffsetDb(offsetDb: number | null): void // pinned k − table k; null = adaptive
	block(
		powerDb: Float32Array,
		floorDb: Float32Array,
		masked: Uint8Array,
		sample: number,
	): void
	gateOf(
		centreHz: number,
		obwHz: number,
	): {
		state: ChannelGateState
		channelSnrDb: number
		passedSample: number | null
	}
	kFor(rangeKey: string): number
	stats(): {
		slots: number
		coarsened: number
		maskedSkipped: number
		falseAlarms: number
	}
}
export function createChannelGate(opts: {
	binHz: number
	blockMs: number
	centreHz: number
	bins: number
	now?: () => number
}): ChannelGate
```

Behaviour pinned by the spec and design:

- Slots: raster entries sit at `firstChannelHz + n·rasterHz` inside `[startHz, endHz]`. Other entries and uncovered usable span use a sliding grid at `widthHz/2` steps with `defaultWidthHz`. More than `CHANNEL_GATE_MAX_SLOTS` slots → double the grid step until under the cap, counting `coarsened`.
- Per block: convert to linear into preallocated scratch. Prefix sums of power and floor over unmasked bins (masked contribute 0 and are counted). For each slot, use the bins whose centres lie in `[slot.lo, slot.hi)`. Masked fraction > 0.5 → skipped (state unchanged, not tested). `channelSnrDb = 10·log10(P/F)`.
- On at `snr ≥ kCh`, off below `kCh − 1.5`. A run tolerates one off block. The run passes when `onBlocks·blockMs ≥ minMs` (300, or 100 when `entry.burst`) and best SNR ≥ `kCh + margin` (3.0, or 6.0 when burst). `passedSample` is the sample of the passing block.
- CFAR per `rangeKey`: a run that ends without passing is one false alarm. Raise 0.5 dB per 5 min when the rate is above target, cap +4 dB. Lower per 30 min when below target/4, never below `CHANNEL_GATE_K_DB`. Pinned offset → `kCh = CHANNEL_GATE_K_DB + offset`, no adaptation.
- No allocation in `block()` (scratch is sized in `setPlan` / construction).

- [ ] **Step 1: Write failing unit tests** (`channel-gate.test.ts`):

```ts
it("a 12.5 kHz channel at 7 dB for 300 ms passes on block 6, not block 5", () => {
	// binHz 1000, blockMs 50; plan entry widthHz 12_500, rasterHz 12_500
	// feed 5 blocks: state "pending"; 6th: "passed", passedSample === sample of block 6
})
it("one off block inside the run counts as on; two end the run", () => {})
it("a burst entry passes after 2 blocks at 9.5 dB and not at 8.5 dB", () => {})
it("a 2 kHz blip at 3.5 dB per-bin SNR in a 12.5 kHz channel reads 0.8 ± 0.1 dB and never turns on", () => {})
it("a slot with 7 of 12 bins masked is skipped; with 6 of 12 it is tested", () => {})
it("passed is sticky across later quiet blocks for the same track", () => {})
it("kCh rises by 0.5 dB after 5 min of unpassed runs above target and stops at +4 dB", () => {})
it("kCh never drops below CHANNEL_GATE_K_DB", () => {})
it("pinned offset 2 dB pins kCh at 5 dB and disables adaptation", () => {})
it("slot count over 4096 coarsens the grid and counts it", () => {})
it("widths clamp to [6250, 200000]", () => {})
```

- [ ] **Step 2: Write failing properties** (`channel-gate.property.test.ts`):

```ts
// Feature: scanner-redesign, Property 1: Noise never passes the gate
// Validates: Requirements 2.2, 2.3, 2.4
// exponential bins around random floors (fc.float floors −120..−60 dBFS), random blips
// width ≤ 30 % of W and per-bin SNR ≤ 10 dB, any duration, random masks → no slot passed;
// channel-filling signals at snr ≥ 6 dB for ≥ 6 blocks → passed within 7 blocks. numRuns: 100
// Feature: scanner-redesign, Property 2: The gate is channel-matched
// Validates: Requirements 2.1, 2.2, 2.7
// channelSnrDb equals 10·log10 of direct bin sums over unmasked in-passband bins (rel 1e-6);
// >50 % masked never tested; splitting the same block sequence across two gates fed in
// different call groupings yields identical states. numRuns: 100
```

- [ ] **Step 3: Run.** `pnpm exec vitest run tests/unit/core/spectrum/channel-gate.test.ts tests/unit/core/spectrum/channel-gate.property.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 4: Implement `createChannelGate`** per the behaviour above.
- [ ] **Step 5: Run.** Same command. Expected: PASS.
- [ ] **Step 6: Commit** `feat(spectrum): channel-matched gate with duration, margin and per-range adaptation`.

### Task DT.1b: Gate in the worker pipeline and the channel-plan input (R 2.1, 2.3, 2.4, 2.7)

**Files:**

- Modify: `src/core/spectrum/worker-protocol.ts` (`PipelineInputSchema` gains `{ kind: "channel-plan", plan: ChannelPlanSchema | null }`, Zod-validated: entries ≤ 4 096, finite numbers, `startHz < endHz`, width in the clamp range)
- Modify: `src/core/spectrum/pipeline.ts` (create the gate at init/retune epoch; `case "channel-plan"`; run `gate.block` after the tracker using the same mask as the detector (`Detector.unmasked()` inverted plus spur/exclusion `extra`, with image tracks' bins added); per open track call `gateOf` and store on the tracker's record; pass `cfarRanges` targets via `setFaTargets`; pinned k offset from `cfg`)
- Modify: `src/core/spectrum/emissions/tracker.ts` (`OpenTrack.gate`, `channelSnrDb`, `gatePassedSample`; `setGate(id, g)`; sticky `passed`; at close `pending` → `below`; `TrackSnapshot` carries the three fields only when a plan is set)
- Modify: `src/core/spectrum/spectrum-engine.ts` (`setChannelPlan(plan: ChannelPlan | null): void`, cached and replayed on worker restart next to the masks replay)
- Modify: `src/core/spectrum/spectrum-service.ts` (`setChannelPlan(sourceId: string, plan: ChannelPlan | null): void` → `this.engine(sourceId)?.setChannelPlan(plan)`)
- Modify: `src/core/spectrum/pipeline-host.ts`, `src/core/spectrum/spectrum-worker.ts` only if the input pass-through needs it
- Test: `tests/unit/core/spectrum/pipeline-gate.test.ts` (new, uses `pipeline-harness.ts`), `tests/unit/core/spectrum/spectrum-engine.test.ts`, `tests/unit/core/spectrum/emissions/` tracker tests

**Interfaces:**

- Consumes: `createChannelGate` (DT.1a).
- Produces: `SpectrumService.setChannelPlan(sourceId, plan)`; `TrackSnapshot.gate/channelSnrDb/gatePassedSample` on `track-open`/`track-update`/`track-close`; close emits `gate: "below"` when never passed.

- [ ] **Step 1: Write failing tests:**
  - `pipeline-gate.test.ts`: "without a channel-plan input, track events are deep-equal to the pre-change golden" (byte-identical defaults). "With a plan, a 7 dB NFM-width signal for 400 ms yields track-update gate passed and a snapshot gatePassedSample". "A 2-block 3.5 dB blip closes with gate below". "A spur-masked channel never passes".
  - `spectrum-engine.test.ts`: "setChannelPlan is replayed after a worker restart" (mirror the existing masks replay test).
  - `worker-protocol` case: "a channel-plan input with 4097 entries is rejected; 4096 accepted".
- [ ] **Step 2: Run.** `pnpm exec vitest run tests/unit/core/spectrum/pipeline-gate.test.ts tests/unit/core/spectrum/spectrum-engine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per Files.
- [ ] **Step 4: Run** the same tests plus `tests/unit/core/spectrum/pipeline*.test.ts tests/unit/core/spectrum/emissions`. Expected: PASS. Any golden change is listed with R 2.4.
- [ ] **Step 5: Commit** `feat(spectrum): channel plan input and per-track gate state in the worker`.

### Task DT.1c: Summary wire, frames, size bound, measured report (R 2.6, 2.8)

**Files:**

- Modify: `src/core/spectrum/summary-wire.ts` (carry `gate` and `channelSnrDb` on `BlockTrack`; host `sanitizeBlockTrack` accepts `"pending" | "passed"` and finite numbers only, drops anything else)
- Modify: `src/core/spectrum/frame-tracks.ts` (`surfacedOf`: if `t.gate !== undefined` → `t.gate === "passed" && !spur && !iqImage`; else today's rule (A8); `channelSnrDb` rounded with `roundHalfDb`)
- Modify: `scripts/bench/frame-tracks.ts` (gate fields in the bench)
- Test: `tests/unit/core/spectrum/frame-tracks.test.ts`, `frame-tracks-property.test.ts`, `summary-wire-tracks.test.ts`, new `frame-track-gate-size.test.ts`, new `channel-gate-report.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `frame-track-gate-size.test.ts`: "gate and channelSnrDb add at most SPECTRUM_FRAME_TRACK_GATE_MAX_EXTRA_BYTES (40) per track". Serialize a track without and with `{"gate":"passed","channelSnrDb":-123.5}` and assert `diff ≤ 40`. Also "256 tracks still fit the frame bound".
  - `frame-tracks.test.ts`: "surfaced equals gate passed when gate is present", "absent gate keeps the minSurfaceBlocks display rule", "a passed spur is not surfaced".
  - `summary-wire-tracks.test.ts`: "gate below or a non-finite channelSnrDb is stripped by sanitizeBlockTrack".
  - `channel-gate-report.test.ts`: the measured report as assertions at the reference FFT size (2048) and 50 ms blocks. Noise false-alarm passes: 0 in 20 000 synthetic channel-blocks at default `kCh`. Detection probability for NFM, 4FSK, GMSK and OOK bursts at channel SNR 3, 6, 9, 12 dB is printed, and asserted ≥ 0.95 at 9 dB and ≥ 0.5 at 6 dB for 500 ms bursts. The lane report carries the printed table.
- [ ] **Step 2: Run.** `pnpm exec vitest run tests/unit/core/spectrum/frame-tracks.test.ts tests/unit/core/spectrum/frame-track-gate-size.test.ts tests/unit/core/spectrum/summary-wire-tracks.test.ts tests/unit/core/spectrum/channel-gate-report.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the above plus `frame-tracks-property.test.ts frame-tracks-golden.test.ts frame-track-rollover.test.ts frame-track-id-bound-log.test.ts tests/unit/core/wg11-contract.test.ts`. Expected: PASS. List each changed golden with R 2.6.
- [ ] **Step 5: Re-run DT.0's bench** and record the gate stage cost (budget ≈ 10 µs per block, 0.0002 core).
- [ ] **Step 6: Commit** `feat(spectrum): frame tracks carry the channel gate; surfaced means passed`.

### Task DT.2: Parking, no same-hop retune, arbiter no-op, stable ids (R 1.1–1.6, P3, P4, P5)

**Files:**

- Modify: `src/core/scanner/scheduler.ts`
- Modify: `src/core/scanner/tuner-arbiter.ts`
- Test: `tests/unit/core/scanner/scheduler-parking.test.ts` (new), `scheduler-parking.property.test.ts` (new), `scheduler-parked-job-runner.test.ts` (new), `tuner-arbiter-noop.test.ts` (new), `tuner-arbiter-noop.property.test.ts` (new), `tests/unit/core/spectrum/track-ids-parked.property.test.ts` (new); existing `scheduler.test.ts`, `scheduler-range-dwell.test.ts`, `tuner-arbiter.test.ts`

**Interfaces:**

- Produces: `SweepScheduler.parked: boolean` (getter). `snapshot().sweepPeriodMs === null` while parked, `hopIndex 0`, `hopCount 1`, `coverage 1`. `TunerArbiter.retune(lease, target, allowed?)` keeps its signature.

Scheduler rules:

- `parked` becomes true when a one-hop plan's first visit settles.
- `leaveHop` on a one-hop plan never calls `tuneTo`. It runs `endVisit`. It emits `sweep-complete` only when `now − lastSweepCountAt ≥ hop dwellMs` (then `sweepIndex++`, `lastSweepCountAt = now`, `sweepPeriodMs` stays null). It starts a new visit on hop 0 with phase `dwell`.
- `replan`: one hop at the same centre keeps the park. A new centre clears `parked` and returns exactly one tune action. A plan becoming multi-hop leaves the park.
- Multi-hop: when the picked hop (revisit or coarse) equals the current hop, set `dwellEnd += hop dwell` and return no tune action.

Arbiter no-op (research Option A): add per-lease `verified: { centreHz; sampleRateHz: number | null; gainTenthsDb: number | null; epoch: number } | null`, set after a successful `retune`. `retune` returns the current epoch's `PendingEpoch` with no writes, no markers and no `markChanged` when all of these hold:

- `lease.verified` equals the target field-for-field;
- `clock.currentEpoch().epoch === verified.epoch`, its `tuningTrust === "commanded"` and `startSample !== null`;
- the controller's `tuningWrittenOnConnection()` is true;
- frequency, sampleRate, gain and gainMode are absent from `getState().unknownFields` and `declaredOnlyFields`.

Clear `verified` on disconnect or payload restart, `control-mode-changed`, an untracked retune or host-centre mismatch, handover and release.

- [ ] **Step 1: Write failing scheduler tests** (`scheduler-parking.test.ts`): "a one-hop plan emits exactly one tune action over 20 dwells". "sweep-complete once per elapsed dwellMs, not on an early hold end". "sweepPeriodMs null and parked true after the first settle". "a hold while parked ends without a tune action". "afterSweeps 3 stops after 3 dwells". "replan keeping the centre stays parked". "replan to a new centre leaves the park with one tune" (with an open hold: the hold ends). "multi-hop: a revisit picking the current hop extends dwellEnd and emits no tune".
- [ ] **Step 2: Write failing property** (`scheduler-parking.property.test.ts`):

```ts
// Feature: scanner-redesign, Property 3: A fitting window stays tuned
// Validates: Requirements 1.1, 1.3, 1.4
// random one-hop plans and event sequences (blocks, holds, probes, centre-keeping range
// edits, afterSweeps) → exactly one tune action, sweep-complete count == floor(elapsed/dwell),
// sweepPeriodMs null; random multi-hop plans → no tune action targets the hop being visited. numRuns: 100
```

- [ ] **Step 3: Write failing arbiter tests** (`tuner-arbiter-noop.test.ts`), using the existing fakes in `tuner-arbiter.test.ts`: "same centre/rate/gain on a verified commanded started epoch writes nothing, no markers, returns the same epoch". "Different gain writes". "An unverified epoch (operator settle window open) writes". "After a reconnect, the first same-centre retune writes". "After handover to another job, the same target writes". "The rate in declaredOnlyFields writes". Plus the property:

```ts
// Feature: scanner-redesign, Property 4: Same-centre retune writes nothing
// Validates: Requirements 1.2
// random lease/write/epoch histories: writes == 0 and epoch kept iff (holder, target equals
// last accepted, epoch verified); else the write count equals today's path. numRuns: 100
```

- [ ] **Step 4: Write failing ids property** (`track-ids-parked.property.test.ts`, using `pipeline-harness.ts`):

```ts
// Feature: scanner-redesign, Property 5: Track ids survive parking
// Validates: Requirements 1.5, 2.6
// random block sequences of one emission with gaps < hang, no epoch change → one trackId on
// every frame track and every snapshot, across the 120 s rollover. numRuns: 100
```

- [ ] **Step 5: Write the failing integration test** `scheduler-parked-job-runner.test.ts` (Review Focus 1). Use the real `JobRunner` from `src/core/scanner/job-runner.ts` (read only) with a fake arbiter and clock: 10 dwells → `progress().sweepIndex` +10, `arbiter.retune` called once, `progress().sweepPeriodMs === null`. If `job-runner.ts` needs a change for this, DT writes it as an exact diff in the lane report for ID/Main, not as an edit.
- [ ] **Step 6: Run.** `pnpm exec vitest run tests/unit/core/scanner/scheduler-parking.test.ts tests/unit/core/scanner/scheduler-parking.property.test.ts tests/unit/core/scanner/tuner-arbiter-noop.test.ts tests/unit/core/scanner/tuner-arbiter-noop.property.test.ts tests/unit/core/scanner/scheduler-parked-job-runner.test.ts tests/unit/core/spectrum/track-ids-parked.property.test.ts`. Expected: FAIL.
- [ ] **Step 7: Implement** scheduler and arbiter rules above.
- [ ] **Step 8: Run** the tests above plus `scheduler.test.ts scheduler-range-dwell.test.ts tuner-arbiter.test.ts tuner-arbiter-config-origin.test.ts plan/` previews. Expected: PASS. List golden changes with R 1.1–1.4.
- [ ] **Step 9: Commit** `feat(scanner): park one-hop plans; same-centre retune is a no-op`.

### Task DT.3: Exact scanner-service diff (R 2.1, 2.5, 4.1)

**Files:**

- Deliver (not commit): an exact unified diff of `src/core/scanner/scanner-service.ts` in the lane report. Main applies it in MA.1. No diff file is tracked.
- Test (lane-owned, committed): `tests/unit/core/scanner/scanner-service-channel-plan.test.ts` (new). It runs against the patched service in the lane worktree; Main commits the service change with it.

Diff content:

- `channelPlanOf(sourceId: string): ChannelPlan | null`. Gather the non-terminal jobs' enabled ranges on the source plus the passive job's band-plan view ranges. One entry per range: `widthHz = clamp(r.obwHz?.[0] ?? rasterSpacing(r) ?? CHANNEL_GATE_DEFAULT_WIDTH_HZ, 6_250, 200_000)`, `rasterHz` and `firstChannelHz` from `r.rasters?.[0]` or null, `burst` per A11, `rangeKey = \`${Math.round(r.startHz)}:${Math.round(r.endHz)}\``. Return null when no job runs. `defaultWidthHz: CHANNEL_GATE_DEFAULT_WIDTH_HZ`.
- In `updateMasks(sourceId)`: after `engine.setMasks(...)`, call `this.spectrum.setChannelPlan(sourceId, this.channelPlanOf(sourceId))`. This inherits every existing trigger: create, patch (range edit), lockout replan, open engine, lease loss, lifecycle start/stop, resume, arbitration.
- Ingest: a `track-close` whose snapshot has `gate === "below"` → `counts.transients++` only, and no store ingest, capture, probe or activity event beyond today's transient handling.
- `nextCandidate` input: carry `gate` and skip tracks whose gate is not `passed`.

- [ ] **Step 1: Write failing test** `scanner-service-channel-plan.test.ts`: "job start sends a plan with one entry per enabled range, widths clamped". "Range edit resends the plan". "Stop of the last job sends null". "obwHz 3000 clamps to 6250; 500000 clamps to 200000". "A below track increments transients and creates no discovery". "nextCandidate skips pending tracks".
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/scanner-service-channel-plan.test.ts` → FAIL. Apply the diff locally, re-run → PASS, together with `scanner-service-range-masks.test.ts scanner-service-range-edits.test.ts scanner-service.test.ts`.
- [ ] **Step 3: Commit only the test file** `test(scanner): channel plan and gate-aware ingest`. Hand the diff to Main.

---

## Lane EV: evidence labels, proof, API, unavailable decoders

Allocation: `src/core/scanner/classify/**`, `src/core/scanner/band-scan-burst-prior.ts`, `src/core/scanner/store/discovery-store.ts`, `store/schemas.ts`, `store/frequency-index.ts`, `store/job-counts.ts`, `src/core/scanner/proof.ts` (new), `src/core/scanner/probes/probe-pool.ts`, `src/api/routes/scanner.ts`, `src/api/routes/scanner-schemas.ts`, `scripts/bench/scanner-store.ts`.

### Task EV.1: Evidence-only labels and gated surfacing (R 2.5, 3.1–3.3, 3.9, P6, P7)

**Files:**

- Modify: `src/core/scanner/store/discovery-store.ts`. Remove `surfaces()`, `singleBlockHit()` and the constants `SINGLE_BLOCK_HITS`, `SINGLE_BLOCK_WINDOW_MS`, `SINGLE_BLOCK_EXTRA_DB` (lines ~156–158, ~1334–1380). The new surfacing test is `obs.track.gate === "passed"`; absent counts as `pending` (A8). Replace `observedProtocol`/`ladderOf` (lines ~340–360) with `labelFromEvidence`.
- Modify: `src/core/scanner/classify/classifier.ts`, `classify/channel-tier.ts`, `band-scan-burst-prior.ts`. Outputs stay as measurements and trial order; they no longer feed `protocol`, `family` or `confidence`.
- Test: `tests/unit/core/scanner/discovery-store-gate.test.ts` (new), `labels-from-evidence.property.test.ts` (new), `gated-surfacing.property.test.ts` (new); update `discovery-store.test.ts`, `surfacing-noise.test.ts`, `band-scan-dmr.test.ts`, `band-scan-dmr-classify.test.ts`, `job-runner-signals-only.test.ts`, `classify/p18-neighbour-ghosts.test.ts`, the store goldens `tests/unit/core/scanner/__goldens__/store-seed-{1,5,7,9,42}.txt.gz` (regenerated through `tests/unit/core/scanner/__goldens__/store-golden-driver.ts`; seeds in `tests/mocks/scanner/observations.ts` gain `gate: "passed"` where the old rule surfaced), `tests/unit/core/scanner/identify-analog-goldens.test.ts`/`.json`, `tests/unit/core/scanner/identify-narrow-digital-goldens.test.ts`/`.json`. EV.1 owns regenerating these shared identify goldens; no other lane rewrites them (ID adds new golden files of its own if needed) and Main reconciles at merge.

**Interfaces:**

- Produces: `labelFromEvidence(e: ProofInput): { protocol: ScannerProtocol; family: ScannerFamily | null; confidence: ScannerConfidence }` (exported for tests).
  - Rules: decode → its protocol; ladder `decoded`. Analog `decoded` tone/code on `commanded`/`relay` → `analog-fm`/`analog-am`, `classified`; on `unverified` → `candidate`. Analog `heard` → `analog-fm`/`analog-am`, `candidate`. `data-like` + `digitalPlanComplete` with no decode → `digital-unknown`, `candidate`. `carrier-only` → `carrier`, `activity`. Otherwise `unknown`, `activity`. DMR still needs the same CC on two CRC-clean link lines (existing acceptance).
- Consumes: `TrackSnapshot.gate` (0.1), `ProofInput` (0.1).

- [ ] **Step 1: Write failing tests** `discovery-store-gate.test.ts`: "a pending track creates no discovery". "Absent gate is treated as pending". "A passed track creates one discovery with protocol unknown and confidence activity". "A below track changes only counts.transients". "minSurfaceBlocks no longer affects discovery creation (2 vs 10 give the same store)". "A prior-only hypothesis at score 0.9 leaves protocol unknown and activity". "Stored records load unchanged (no migration)". "An ambient AIS decode sets protocol ais, decoded".
- [ ] **Step 2: Write failing properties:**

```ts
// Feature: scanner-redesign, Property 6: Only gated tracks surface
// Validates: Requirements 2.5, 4.1
// Feature: scanner-redesign, Property 7: Labels only from evidence
// Validates: Requirements 3.1, 3.2, 3.3, 3.9
// random classes, hypotheses, priors and band plans without evidence → protocol unknown,
// activity, no proof; then a random evidence sequence → protocol/confidence per labelFromEvidence. numRuns: 100
```

- [ ] **Step 3: Run.** `pnpm exec vitest run tests/unit/core/scanner/discovery-store-gate.test.ts tests/unit/core/scanner/labels-from-evidence.property.test.ts tests/unit/core/scanner/gated-surfacing.property.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Regenerate the goldens and run** the full list in Files plus `store-change-golden*.test.ts discovery-store*.test.ts`. Expected: PASS. List each golden with R 2.5 / 3.1 / 3.2.
- [ ] **Step 6: Commit** `feat(scanner): discoveries only from gated tracks; labels only from evidence`.

### Task EV.2: Proof derivation (R 3.4–3.6, 3.8, 6.5, P8)

**Files:**

- Create: `src/core/scanner/proof.ts`
- Modify: `src/core/scanner/store/discovery-store.ts`. `DiscoveryStore implements ObservationEvidenceSink` (0.1, A12). Add a private `Map<string, { trials: ProofTrialInput[]; analog: ProofAnalogInput[]; unavailable: ScannerProbeDecoderType[] }>` keyed by observation id, with the frozen bounds and removal rules. Build `ProofInput` per observation from `Observation.decode` (persisted) plus that side table (memory only), `trust` from `Observation.tuningTrust`, and `digitalPlanComplete`. `digitalPlanComplete` is true when an analog `data-like` outcome exists and every recorded trial whose order is above it has a terminal outcome other than `pending` or `running`. Cache the per-discovery proof by discovery version. DTOs carry `proof` and `evidenceLevel`. Per A12 nothing new is persisted. The sink writes no journal entry, so `store/schemas.ts`, `persistence.ts` and the snapshot and mirror modules are unchanged, and DTO `proof`/`evidenceLevel` are never written to disk. Those modules serialise records, not DTOs; EV asserts this in a test.
- Modify: `scripts/bench/scanner-store.ts` (proof on; ingest mean ≤ 50 µs; proof derive ≤ 0.1 ms p99)
- Test: `tests/unit/core/scanner/proof.test.ts`, `proof.property.test.ts`, `discovery-store-evidence-sink.test.ts` (new)

**Interfaces:**

- Produces: `deriveProof(input: ProofInput): ScannerProof | null`, `proofSummary(p: Omit<ScannerProof, "summary">): string`, `evidenceLevelOf(d: { proof?: ScannerProof }): ScannerEvidenceLevel`, `strongestProof(proofs: readonly ScannerProof[]): ScannerProof | null` (rank decoded > analog-tone > analog-voice > digital-undecoded > carrier-only, ties newest `at`). It also produces `DiscoveryStore`'s `ObservationEvidenceSink` methods, exactly as frozen in 0.1. Other lanes reach them only through the scanner-service diffs and fakes.
- `tried`: trial protocols with outcome in {decoded, no-sync, crc-errors, timeout, heard, data-like, carrier-only}, ordered by `order`, unique, ≤ 16. The analog trial adds no protocol unless it decoded. NXDN48/96 dedupe in labels. `unavailable`: sorted, unique.

- [ ] **Step 1: Write failing tests** `proof.test.ts`, with exact strings from design § Proof grammar:

```ts
expect(
	proofSummary(
		dmr({ identity: { kind: "dmr-cc", value: "1" }, talkgroup: "9" }),
	),
).toBe("DMR decoded (CC1, TG 9)")
expect(proofSummary(tone({ ctcssHz: 88.5, voice: true }))).toBe(
	"Analog FM voice, CTCSS 88.5",
)
expect(
	proofSummary(tone({ dcs: { code: "023", polarity: "normal" }, voice: true })),
).toBe("Analog FM voice, DCS 023N")
expect(proofSummary(tone({ ctcssHz: 88.5, voice: false }))).toBe(
	"Analog FM, CTCSS 88.5",
)
expect(proofSummary(voice("am"))).toBe("Analog AM voice")
expect(proofSummary(undecoded(["dmr", "dpmr", "nxdn48"]))).toBe(
	"Digital, not decoded (tried DMR, dPMR, NXDN)",
)
expect(proofSummary(undecoded(["dpmr"], ["dsd-fme"]))).toBe(
	"Digital, not decoded (tried dPMR; dsd-fme unavailable)",
)
expect(proofSummary(undecoded([]))).toBe(
	"Digital, not decoded (no decoder available)",
)
expect(proofSummary(carrier())).toBe("Carrier only")
expect(proofSummary(dmr({ encrypted: true }))).toBe("DMR decoded (encrypted)")
// 16 long-labelled protocols: length ≤ 160 and ends with "+<n> more)"
```

Also: "an unavailable decoder is never in tried"; "unsupported, skipped-budget, cancelled, pending trials are not tried"; "ambient decode → transport ambient".

`discovery-store-evidence-sink.test.ts` (A12):

- "recordTrial on an unknown observation → false, no change emitted".
- "recordTrial then a later outcome for the same (protocol, decoder, order) replaces it".
- "nextTrialOrder is strictly increasing".
- "33 trials keep the 32 highest orders". "9 analog entries keep the 8 newest".
- "recordUnavailable is set-like and sorted".
- "a true return emits one updated change whose discovery DTO carries the new proof".
- "the sink writes no journal entry and snapshot() is deep-equal before and after" (spy on the persistence sink).
- "restore(snapshot()) of a store with an analog-voice proof → that discovery is weak; a store with a persisted decode → still decoded".
- "evicting or pruning a discovery deletes its observations' side-table entries" (side-table size returns to 0).
- "after a merge, the survivor's proof still sees the absorbed observation's trials".
- [ ] **Step 2: Write failing property:**

```ts
// Feature: scanner-redesign, Property 8: Proof is a function of the evidence
// Validates: Requirements 3.4, 3.5, 4.5
// deterministic; tried ⊆ ran-outcome trials, no unavailable type; unavailable sorted unique;
// discovery proof == strongest-then-newest; summary matches grammar regex and ≤ 160. numRuns: 100
```

- [ ] **Step 3: Run** `pnpm exec vitest run tests/unit/core/scanner/proof.test.ts tests/unit/core/scanner/proof.property.test.ts tests/unit/core/scanner/discovery-store-evidence-sink.test.ts` → FAIL. **Step 4: Implement.** **Step 5:** Run again plus `discovery-store*.test.ts` and the persistence and snapshot tests (`pnpm exec vitest run tests/unit/core/scanner/persistence.test.ts tests/unit/core/scanner/persistence-range-fields.test.ts tests/unit/core/scanner/snapshot-mirror.test.ts tests/unit/core/scanner/snapshot-worker.test.ts tests/unit/core/scanner/snapshot-writer-bounds.test.ts`, which must pass with no golden changes), and `pnpm exec esbuild scripts/bench/scanner-store.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/scanner-store.mjs && node output/bench/scanner-store.mjs` → PASS within the budgets above.
- [ ] **Step 6: Commit** `feat(scanner): derived proof and evidence level on discoveries and observations`.

### Task EV.3: API filter, near, mergedIds (R 3.7, 7.5, 7.6, P9)

**Files:**

- Modify: `src/core/scanner/store/discovery-store.ts` (`list(query)` honours `evidence`; `DiscoveryStore implements DiscoveryNearQuery` (0.1): `near(hz: number, toleranceHz: number, sourceId?: string): Discovery[]` via `store/frequency-index.ts`, sorted by |Δf| then id; merge passes absorbed ids, sorted, ≤ 64, to the `merged` change)
- Modify: `src/core/scanner/store/frequency-index.ts` (range query across sources, O(log n + k))
- Modify: `src/api/routes/scanner.ts`, `src/api/routes/scanner-schemas.ts` (behaviour behind the 0.1 accepted fields; paging by the existing `limit`/cursor)
- Test: `tests/unit/core/scanner/discovery-filter.property.test.ts` (new), `tests/unit/api/scanner-discoveries-query.test.ts` (new), `merge-alias-store.test.ts`

- [ ] **Step 1: Write failing tests.** Route: "absent evidence/nearHz → body byte-identical to the base response" (snapshot from the base fixture). "toleranceHz without nearHz → 400". "toleranceHz 1000001 → 400". "nearHz with default tolerance 6250 returns ±6250 inclusive, sorted by distance then id". "evidence=proven combined with sourceId and limit". Merge: "merged event carries mergedIds sorted, capped at 64".
- [ ] **Step 2: Property:**

```ts
// Feature: scanner-redesign, Property 9: The filter partitions
// Validates: Requirements 3.6, 3.7, 7.6
// proven ∩ weak = ∅, proven ∪ weak = all, all ≡ absent (byte-equal JSON); near returns exactly
// those within tolerance, sorted by |Δf| then id. numRuns: 100
```

- [ ] **Step 3: Run** `pnpm exec vitest run tests/unit/core/scanner/discovery-filter.property.test.ts tests/unit/api/scanner-discoveries-query.test.ts tests/unit/core/scanner/merge-alias-store.test.ts` → FAIL. **Step 4: Implement.** **Step 5:** Run again → PASS. Bench `near` and the filter at 10 000 discoveries (≤ 0.1 ms `near`).
- [ ] **Step 6: Commit** `feat(api): discoveries evidence filter, nearHz query and merged ids`.

### Task EV.4: Missing decoder program is unavailable, not no-sync (R 4.5, 3.4)

**Files:**

- Modify: `src/core/scanner/probes/probe-pool.ts`. Add `isDecoderUnavailableExit(exit: { code: number | null; signal: NodeJS.Signals | null; outputSeen: boolean; spawnError?: unknown }): boolean`, combining `isSpawnUnavailableError` and `isUnavailableExit` (126/127, no signal) before the first output. The unavailable stop path sets the probe's terminal state to `unsupported` with `undecodedReason` absent and reason `decoder-unavailable`, and records the memo (existing `unavailableAt`, `reportUnavailable`). Reuse the existing public `ProbePool.unavailableTypes(now)` (`src/core/scanner/probes/probe-pool.ts`, around line 1333) for callers other than identify; its signature is unchanged and nothing is added.
- Test: `tests/unit/core/scanner/probe-pool-unavailable.test.ts` (new); existing `identify-decoder-unavailable.test.ts`, `identify-unavailable-memo*.test.ts`
- Deliver: the exact scanner-service diff. In `onProbeState` (around lines 3497–3523), an `unsupported`/`decoder-unavailable` probe never calls `undecodedForProbe` and never records a known-protocol miss. Evidence goes only through `ObservationEvidenceSink` (A12):
  - When a probe starts, the diff takes `store.nextTrialOrder()` and keeps it on the probe's bookkeeping.
  - Each probe state change with an outcome calls `store.recordTrial(observationId, { protocol, decoder, outcome, order, at })`. That includes the unavailable probe, with outcome `unsupported`.
  - An unavailable probe also calls `store.recordUnavailable(observationId, type)`.
  - The diff adds no store method and no persistence call. Add a test `tests/unit/core/scanner/scanner-service-trial-evidence.test.ts`, which Main commits with the diff: a fake pool drives one `no-sync` probe and one exit-127 probe on one observation, and the discovery DTO's proof reads `Digital, not decoded (tried <protocol>; <type> unavailable)` once an analog `data-like` outcome is recorded. Also include the proof/evidenceLevel pass-through on every emitted discovery and observation DTO, `mergedIds` pass-through, and query pass-through.

- [ ] **Step 1: Write failing tests:** "spawn ENOENT → unsupported, decoder-unavailable, memo set". "Exit 127 before output → same". "Exit 127 after output → today's path". "Exit 126 → unavailable". "An unavailable probe never yields undecodedReason no-sync". "The memo clears after a successful spawn". "isDecoderUnavailableExit truth table" (8 rows).
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/probe-pool-unavailable.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** Run again plus `identify-decoder-unavailable.test.ts identify-unavailable-memo.test.ts identify-unavailable-memo-pool.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(scanner): missing probe decoder program reports unavailable on the probe path`. Hand the scanner-service diff to Main and note A6 in the report.

---

## Lane RP: replay first, analog replay trial, analyze

Allocation: `native/wavekit-chan/src/iqcap/**`, `native/wavekit-chan/src/bin/wavekit-iqcap.rs`, `native/wavekit-chan/examples/iqcap_bench.rs`, `src/core/iq-capture/**`, `src/core/scanner/replay-plan.ts`, `src/core/scanner/analog-trial.ts` (new), `src/core/scanner/probes/replay-transport.ts`, `scripts/bench/iq-capture.ts`, `scripts/bench/analog-trial.ts` (new), `tests/mocks/iq/analog-synth.ts` (new, RP.3b). Reads, never edits, `native/wavekit-chan/src/demod/**`. Seam output: exact diffs of `scanner-service.ts` (RP.1c) and `src/index.ts` (RP.3b), checked with `git apply --check` in the lane and run against the real store at MA.1.

### Task RP.1a: Replay planner with the analog step and stop rule (R 4.4, 4.6, 5.5, 5.6, P12 part)

**Files:**

- Modify: `src/core/scanner/replay-plan.ts` (`planReplayTrials`: known first. Then one `{ kind: "analog", protocol: "analog-fm" | "analog-am", analogMode, known: false, mode }` when the analog prior > 0 and is not excluded (`am` when the band plan at `capture.rfHz` lists AM, read through the existing read-only bandplan API, else `nfm`). Then digital modes by `identifyScores × prior`. `replayModeOf` keeps excluding analog from probe modes. `boundReplayTrials` caps at `IQ_REPLAY_MAX_TRIALS` (8) with the analog trial counted.)
- Test: `tests/unit/core/scanner/replay-plan.test.ts` (existing), `replay-plan.property.test.ts` (new)

- [ ] **Step 1: Failing tests:** "known dmr first, then analog nfm, then digital by score". "AM band plan → analogMode am". "Analog prior 0 → no analog trial". "9 candidates → exactly 8 with analog counted". "Analog excluded by request → none".
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/replay-plan.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS. **Step 5: Commit** `feat(scanner): replay plan gains the analog trial and stays within eight`.

### Task RP.1b: Replay queue runs the analog trial and applies the stop rule (R 4.6, 5.5, P12)

**Files:**

- Modify: `src/core/iq-capture/replay-queue.ts`. Deps gain `analog?: AnalogTrialRunner` and `reserveCores?: (cores: number) => (() => void) | null`. In `next()`, a `kind: "analog"` trial calls `analog.run(captureId, mode, signal)` instead of `probes.request`, holding `ANALOG_TRIAL_CORES` (0.05) through `reserveCores`; refused → `skipped-budget`. If `analog` is absent the trial ends `unsupported`. `onAnswer` handles `heard`, `data-like`, `carrier-only`, `unsupported`. After analog `decoded` or `heard`, the remaining digital trials end `not-needed`. After `data-like`, `carrier-only` or `no-sync` they run. Widen `OUTCOMES` and `sanitize()`. The result carries `analog` and `unavailable`.
- Modify: `src/core/scanner/probes/replay-transport.ts` only if the core constants move (they do not; keep `IQ_REPLAY_PROBE_CORES`).
- Test: `tests/unit/core/iq-capture/replay-queue.test.ts`, `tests/unit/core/iq-capture/replay-queue-analog.property.test.ts` (new), drain measurement in `scripts/bench/iq-capture.ts`

- [ ] **Step 1: Failing tests:** "analog heard → digital trials not-needed, one result, one discard". "Analog data-like → digital trials run". "Analog carrier-only → digital run". "No analog dep → unsupported". "Budget refused → skipped-budget". "Abort mid-analog → cancelled, discard once". "R 6.3: a capture of a transmission live audio already identified (the fake `ObservationEvidenceSink` holds a live `decoded` analog entry with CTCSS for that observation) still runs its own analog trial first; with analog `data-like` the digital trials run, with analog `heard` they end `not-needed`; the live entry never skips or replaces the replay analog trial". Property:

```ts
// Feature: scanner-redesign, Property 12: Replay order and stop
// Validates: Requirements 4.4, 4.6, 5.5
// known first, ≤ 1 analog, digital by score; no digital after analog decoded/heard; ≤ 8 run;
// exactly one result and one discard per capture. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/iq-capture/replay-queue.test.ts tests/unit/core/iq-capture/replay-queue-analog.property.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS.
- [ ] **Step 5: Re-measure drain** with fake decoders: `pnpm exec esbuild scripts/bench/iq-capture.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/iq-capture.mjs && node output/bench/iq-capture.mjs --drain`. Expected: ≥ 5.6 captures/min worst case (8 trials, unknown digital), ≈ 37/min known-first. Record it in the report.
- [ ] **Step 6: Commit** `feat(iq-capture): replay queue runs the analog trial and stops digital after voice`.

### Task RP.1c: Unavailable on replay, capture at gate pass, replay-first confirm (R 4.2, 4.3, 4.5, P13)

**Files:**

- Modify: `src/core/iq-capture/pool-adapter.ts`. A probe stopped `"unavailable"` (or `decoder-unavailable` event) before output → outcome `unsupported`, `reason: "decoder-unavailable"`, type appended to `unavailable`. `outcomeOf` never returns `no-sync` for it.
- Create: `src/core/iq-capture/replay-first.ts` (inside RP's `src/core/iq-capture/**`). The scanner-service diff calls this pure helper: `needsLiveConfirm(input: { gate: ChannelGateState | undefined; captureRunning: boolean; capturePending: boolean; replayEnded: boolean; replayDecoded: boolean; trackOpen: boolean; discoveryDecoded: boolean; emitterOnAir: boolean }): boolean`.
  - Pending or not-passed gate → false. Capture not running → true (today's path). Capture pending or replay not ended → false. Replay ended without decode and track open → true (4.2 b). Discovery decoded and emitter on air → true (4.2 c). Else false.
- Deliver: the exact scanner-service diff. The capture request moves from the old surfacing point to gate pass (first snapshot with `gate === "passed"` and no result for this transmission; WG11 6.3 bounds unchanged). `needsConfirm` uses `needsLiveConfirm`. `applyReplayResult` (around lines 3899–3960) writes evidence only through `ObservationEvidenceSink` (A12):
  - For each `result.trials[]` entry except `not-needed`, in result order, it takes `store.nextTrialOrder()` and calls `store.recordTrial(observationId, { protocol, decoder: trial.decoder ?? <the probe decoder name>, outcome, order, at })`. The analog trial is recorded with decoder `analog-demod`.
  - `result.analog` becomes `store.recordAnalog(observationId, { outcome, mode, voice, tone: { ctcssHz, dcs }, transport: "replay", at })`.
  - Each `result.unavailable` entry becomes `store.recordUnavailable(observationId, type)`.
  - The diff adds no store method and no persistence call. It does not `markUndecoded(..., "no-sync")` for `unsupported` trials, and does not `recordMiss` for them. It creates the queue with `analog` and `reserveCores` (wired in MA.1).
- Test: `tests/unit/core/iq-capture/pool-adapter.test.ts`, `tests/unit/core/iq-capture/replay-first.property.test.ts` (new), `tests/unit/core/iq-capture/replay-evidence-calls.test.ts` (new)

- [ ] **Step 1: Failing tests:** `pool-adapter.test.ts` "exit 127 before output maps to unsupported and lists the type" (Review Focus 5) and "a clean exit without decode stays no-sync". Property:

```ts
// Feature: scanner-redesign, Property 13: Replay before live in scans
// Validates: Requirements 4.2, 4.3
// random gated tracks, capture availability and replay timings → needsLiveConfirm true only in
// cases (a) no capture, (b) on air after replay ended undecoded, (c) identity follow-up. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/iq-capture/pool-adapter.test.ts tests/unit/core/iq-capture/replay-first.property.test.ts tests/unit/core/iq-capture/replay-evidence-calls.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS, plus `tests/unit/core/scanner/replay-pool.test.ts`. The scanner-service diff calls `ObservationEvidenceSink` methods that `DiscoveryStore` only gains in EV.2, so the lane does not compile or run it against the real store. It checks the diff with `git apply --check` against the 0.1 commit, and covers its evidence calls with `tests/unit/core/iq-capture/replay-evidence-calls.test.ts` (new, lane-owned): the `applyReplayResult` evidence mapping is factored as a pure `replayEvidenceCalls(result: IqReplayResult, observationId: string, sink: ObservationEvidenceSink, at: number): void` in `src/core/iq-capture/replay-first.ts`, which the diff calls, and the test drives it with a recording fake sink (one `nextTrialOrder()` per non-`not-needed` trial in result order, the analog trial with decoder `analog-demod`, `recordAnalog` with transport `replay`, one `recordUnavailable` per type, and no `markUndecoded`/miss input for `unsupported`). `scanner-service-wg11-*.test.ts` and `replay-scanner-service.test.ts` against the real store run at MA.1, after EV merges.
- [ ] **Step 5: Commit** `feat(iq-capture): unavailable replay decoders and the replay-first confirm rule`. Hand the diff to Main.

### Task RP.2: `wavekit-iqcap analyze` (after rust-demod-a task 2 merges; R 5.1, 5.2, 5.7, P11)

**Files:**

- Create: `native/wavekit-chan/src/iqcap/analyze.rs`
- Modify: `native/wavekit-chan/src/iqcap/mod.rs` (`Some("analyze")` branch in `main_entry`, `parse_analyze`, USAGE line), `native/wavekit-chan/src/bin/wavekit-iqcap.rs` if needed, `native/wavekit-chan/examples/iqcap_bench.rs` (4 s analyze case)
- Modify: `src/core/iq-capture/service.ts` (`openAnalyze(captureId, mode)` next to `openReplay`. Same verified-file checks; stdio `["ignore", "pipe", "pipe", verified.fd, "pipe"]`; event parsed from fd 4 with Zod against `AnalyzeEvent`, ≤ `ANALYZE_EVENT_MAX_BYTES`; no size check on stdout audio but a cap of 32 000 × 2 bytes; `kill()` on abort)
- Modify: `src/core/iq-capture/process.ts` / `protocol.ts` only for the analyze event schema
- Test: `native/wavekit-chan/tests/iqcap_analyze.rs` (new), `tests/unit/core/iq-capture/service-analyze.test.ts` (new, fake child process)

**Interfaces:**

- Consumes: `wavekit_chan::demod::{Modulation, DemodConfig, Demodulator, block_power_dbfs}` and its complex type (A1, A2).
- Produces: argv `analyze --in <abs file> --mode nfm|am` (input convention identical to `replay`). Stdout is s16le mono at 8 000 Hz. Fd 4 carries one line, `{"event":"analysis","frames":[…≤80],"gapSamples":n}` or `{"event":"error","code":…}`, with numbers rounded to 0.1. Exit 0 on analysis, non-zero on error.

Algorithm (not determined by the signature):

- Read in chunks ≤ `max_chunk` (pick 4 800 = 100 ms). `Demodulator` NFM `deviation_hz 5_000`, `gain 2.0`, `de_emphasis_us None`, `low_pass_hz Some(3_400.0)`, `high_pass_hz Some(300.0)`; AM the same filters. Then `RationalFir` L=1 M=6 to 8 kHz. Convert to s16le with saturation.
- Per 50 ms frame (2 400 input samples): `carrierDb = block_power_dbfs`. `hfNoiseDb`: own discriminator `atan2(Im(x·conj(x₋₁)), Re(…))`, band-pass 3.5–12 kHz power, minus the pure-noise reference (derive and pin the constant in a test from complex Gaussian noise). `audioDb`: 300–3 000 Hz power of the 48 kHz audio relative to full deviation. `syllabic`: the 2–10 Hz modulation index of the audio power envelope over a sliding 1 s window ending at the frame. `cluster`: the fraction of symbol-rate-filtered discriminator samples within ±15 % of the best 2- or 4-level centroid set.
- All state persists across chunks (chunk-invariant). No file is written.

- [ ] **Step 1: Failing Rust tests** `tests/iqcap_analyze.rs`: `analyze_audio_rate_is_8000` (4 s input → 32 000 samples ± 6). `analyze_frames_capped_at_80`. `analyze_short_and_gap_captures` (0-length → frames [] and exit 0; a 1 s file → 20 frames). `analyze_bad_mode_is_bad_args`. `analyze_event_line_under_4096_bytes`. `noise_reference_hf_noise_near_zero_db` (complex Gaussian → |hfNoiseDb| < 1). `nfm_tone_quiets_by_more_than_8_db` at 15 dB SNR. Proptest:

```rust
// Feature: scanner-redesign, Property 11: Analyze is chunk-invariant
// Validates: Requirements 5.2
// random chunkings of a synthetic capture → identical frames and audio bytes; audio rate 8000.
```

- [ ] **Step 2: Run** `make chan-test` → FAIL (no `analyze`). **Step 3: Implement** `analyze.rs`. **Step 4:** `make chan-test` → PASS; `cargo run --release --example iqcap_bench --manifest-path native/wavekit-chan/Cargo.toml -- analyze` reports ≤ 8 ms per 4 s capture.
- [ ] **Step 5: TS side failing test** `service-analyze.test.ts` (fake spawn): "argv is analyze --in … --mode nfm, stdio fd 4 pipe". "A malformed or over-4096-byte event → error analyze-failed". "A gone capture → null". "Abort kills the child". Run `pnpm exec vitest run tests/unit/core/iq-capture/service-analyze.test.ts` → FAIL. Implement `openAnalyze` → PASS. Re-run `tests/unit/core/iq-capture/service.test.ts`.
- [ ] **Step 6: Commit** `feat(iqcap): analyze command for the analog replay trial`.

### Task RP.3a: `classifyAnalogTrial` (R 5.4, P10; can start before RP.2)

**Files:**

- Create: `src/core/scanner/analog-trial.ts`
- Test: `tests/unit/core/scanner/analog-trial.test.ts`, `analog-trial.property.test.ts`

**Interfaces:**

- Produces: `classifyAnalogTrial(stats: AnalogTrialStats, tones: AnalogTrialTones): AnalogTrialOutcome` (pure) and `isVoice(stats): boolean`.
- Decision order: tone or DCS qualified → `decoded`. Fewer than 0.5 of frames with `−hfNoiseDb ≥ 8` → `no-sync` (AM: `carrierDb ≥ floorDb + 6` in place of quieting). Median `cluster ≥ 0.6` → `data-like`. Median `syllabic ≥ 0.3` and median `audioDb ≥ −30` → `heard`. Else `carrier-only`. Zero frames → `no-sync`.

- [ ] **Step 1: Failing tests** with boundary values: quiet fraction 0.5 exactly passes, 0.49 → no-sync; cluster 0.6 → data-like, 0.59 → next rule; syllabic 0.3/audioDb −30 → heard; a tone with no quieting → decoded. Property:

```ts
// Feature: scanner-redesign, Property 10: The analog trial decides by its rules
// Validates: Requirements 5.3, 5.4
// random stats and tones → outcome equals the reference decision order. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/analog-trial.test.ts tests/unit/core/scanner/analog-trial.property.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS. **Step 5: Commit** `feat(scanner): analog trial decision`.

### Task RP.3b: Runner, calibration, bench, index diff (after RP.2; R 5.3, 5.4, 5.7)

**Files:**

- Create: `src/core/iq-capture/analog-trial.ts` (`createAnalogTrialRunner(deps: { port: IqCapturePort; tones: () => ToneDetector; logger: Logger }): AnalogTrialRunner` (no process dependency: `IqCaptureService.openAnalyze` spawns the child through its existing `SpawnFn`, and tests fake the port). It calls `port.openAnalyze`, feeds audio to a fresh `ToneDetector` (`src/core/audio-tones/tone-detector.ts`) in slices ≤ 4 096 samples with `setImmediate` between slices, applies WG2/WG6 qualification (minimum audio seconds, `DCS_MIN_WORDS`), awaits the event, and classifies. Missing `openAnalyze` → `unavailable`. Gone capture → `capture-gone`.)
- Create: `scripts/bench/analog-trial.ts` (wall time and CPU per 4 s capture for analyze and the tone pass; event-loop delay p99 during a burst of 6)
- Create: `tests/mocks/iq/analog-synth.ts` (synthetic cf32 at 48 kHz: NFM syllabic multitone ± CTCSS 88.5 / DCS 023N, 4FSK 4 800 and 2 400 sym/s, GMSK, carrier, noise; SNR 6–20 dB; deterministic seed). It is in RP's allocation.
- Test: `tests/unit/core/iq-capture/analog-trial-runner.test.ts` (fake port), `tests/integration/analog-trial-calibration.test.ts` (runs the built `wavekit-iqcap` when present, skipped otherwise)
- Deliver: an exact `src/index.ts` diff that creates the runner next to `createIqCaptureService` (around lines 1300–1325) and passes it to the replay queue deps and to `IdentifyDeps.analogTrial`. Also deliver a `reserveCores` hook diff for `probe-pool.ts` admission (EV's file; Main applies it after EV merges): `reserveExternal(cores: number): (() => void) | null`, counted in `estimatedCores()`.

- [ ] **Step 1: Failing runner tests:** "zero-frame analysis ends no-sync". "A CTCSS 88.5 audio stream qualifies → decoded, ctcssHz 88.5". "Slices never exceed 4096 samples per turn" (spy on `ToneDetector.push`). "Abort → cancelled and child killed". "Port without openAnalyze → unavailable".
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/iq-capture/analog-trial-runner.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS.
- [ ] **Step 5: Calibrate.** `make chan-build && pnpm exec vitest run tests/integration/analog-trial-calibration.test.ts`. Expected at 10–20 dB: NFM voice → heard, +CTCSS/DCS → decoded, 4FSK and GMSK → data-like, carrier → carrier-only, noise → no-sync. If a threshold must move, write a contract amendment diff for `scanner-redesign-contract.ts` with the measured margins, for Main.
- [ ] **Step 6: Bench.** `pnpm exec esbuild scripts/bench/analog-trial.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/analog-trial.mjs && node output/bench/analog-trial.mjs`. Expected: analyze ≤ 8 ms, tone pass ≤ 10 ms per capture, event-loop p99 ≤ 1 ms per slice during 6 captures. Record the numbers.
- [ ] **Step 7: Commit** `feat(iq-capture): analog trial runner with sliced tone pass and benches`. Hand over the index and probe-pool diffs.

---

## Lane ID: identify, live audio, phase

Allocation: `src/core/scanner/identify.ts`, `src/core/scanner/job-runner.ts`, `src/core/scanner/analog-evidence.ts`, `src/core/scanner/known-protocol.ts`, `src/core/scanner/job-phase.ts` (new), `src/core/scanner/live-audio-evidence.ts` (new). ID never rewrites the shared identify goldens (`tests/unit/core/scanner/identify-analog-goldens.test.ts`/`.json`, `identify-narrow-digital-goldens.test.ts`/`.json`; EV.1 owns them): it runs them unchanged, adds golden files of its own if it needs any, and Main reconciles at merge. ID types every store dependency against the 0.1 contract interfaces (`DiscoveryNearQuery`, `ObservationEvidenceSink`) or against `DiscoveryStore` members that exist at the 0.1 commit, never against members EV adds. Its scanner-service, `src/index.ts` and `live-demodulator.ts` diffs are checked with `git apply --check` against the 0.1 commit plus ID's own unit tests with fakes; the real-store scanner-service tests run at MA.1, after EV merges.

### Task ID.1: Identify until a transmission (R 6.1, 6.2, P14)

**Files:**

- Modify: `src/core/scanner/identify.ts` (`IdentifyDeps.gatedAt?: (sourceId: string, hz: number, toleranceHz: number) => { startSample: number; atMs: number } | null`. With `waitUntilSignal`: target `waiting-for-signal` until `gatedAt` returns a start; the trial timeout runs from `atMs`. `waitMs` (default `IDENTIFY_WAIT_DEFAULT_MS`) elapsing first → `unidentified`, `result.ended: "no-signal"`, every trial `cancelled`, no verdict, no miss. Without `gatedAt` or `waitUntilSignal` → today's path. `window-moved` unchanged.)
- Test: `tests/unit/core/scanner/identify-wait.test.ts` (new), `identify-wait.property.test.ts` (new)

- [ ] **Step 1: Failing tests** (injected clock): "waits, then timeoutMs counts from the gated start". "waitMs 1000 with no transmission ends no-signal at 1000 ms with all trials cancelled". "No miss is recorded on no-signal". "Without waitUntilSignal: deep-equal to the base identify transcript". "A window move during the wait ends window-moved". "Lookups per tick ≤ open tracks (≤ 256)". Property:

```ts
// Feature: scanner-redesign, Property 14: Waiting identify ends honestly
// Validates: Requirements 6.1
// random gated timings, waitMs, timeoutMs → no-signal iff no gated start within waitMs; else
// trial timeout measured from the gated start. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/identify-wait.test.ts tests/unit/core/scanner/identify-wait.property.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS plus `identify*.test.ts`.
- [ ] **Step 5:** Put the docs/API.md text for "Decode here" in the report: `{ target: { frequencyHz, bandwidthHz? }, waitUntilSignal: true, waitMs? }`. Deliver the `gatedAt` scanner-service diff, built from the source's open tracks with `gate === "passed"` within tolerance, using `gatePassedSample`.
- [ ] **Step 6: Commit** `feat(scanner): identify waits for a gated transmission`.

### Task ID.2: Job phase and progress fields (R 7.1–7.4, 7.7, 1.3, P15)

**Files:**

- Create: `src/core/scanner/job-phase.ts` (`jobPhase(input: JobPhaseInput): ScanJobPhase`. Precedence: `settling` (schedulerPhase tuning/settling) > `holding` (hold) > `trialing` (live probe while parked or in-window) > `replaying` (`activity.replaying`) > `capturing` (`activity.capturing > 0`) > `watching`.)
- Modify: `src/core/scanner/job-runner.ts` (`JobDriverDeps.activity?: (jobId: string) => JobActivityView`. `progress()` adds `phase`, `parked` (scheduler parked or in-window), `holding` iff phase holding or trialing, `trial`, `replayQueueDepth`. Fields are absent when `activity` is absent, so defaults stay byte-identical. `sweepPeriodMs` null while parked.)
- Test: `tests/unit/core/scanner/job-phase.test.ts`, `job-phase.property.test.ts` (new); `job-runner.test.ts`

- [ ] **Step 1: Failing tests:** one row per precedence pair (settling beats holding, etc.). "In-window job → parked true". "No activity dep → progress deep-equal to base". Property:

```ts
// Feature: scanner-redesign, Property 15: Phase follows the precedence
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 1.3
// first applicable phase; holding present iff phase ∈ {holding, trialing}; sweepPeriodMs null when parked. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/job-phase.test.ts tests/unit/core/scanner/job-phase.property.test.ts tests/unit/core/scanner/job-runner.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS. Also apply any DT job-runner diff from DT.2 Step 5 here (ID owns the file).
- [ ] **Step 5:** Deliver the scanner-service diff. It adds the per-job `activity` view (capturing count from the capture service, replaying trial and queue depth from the replay queue, keyed by the job's discoveries) and the five fields on `scanner:progress`, at the existing 2 Hz cadence. **Commit** `feat(scanner): scan job phase, parked, holding, trial and queue depth`.

### Task ID.3: Live-audio evidence and tone on status (R 6.3–6.5, P16)

**Files:**

- Create: `src/core/scanner/live-audio-evidence.ts` (`createLiveAudioEvidence(deps: { store: DiscoveryNearQuery & Pick<ObservationEvidenceSink, "recordAnalog"> & Pick<DiscoveryStore, "observations">; analogLog: AnalogEvidenceLog; trust: (sourceId: string) => TuningTrust; logger: Logger }): LiveAudioEvidence` with `start(): void; stop(): void`. `DiscoveryNearQuery` and `ObservationEvidenceSink` are the 0.1 contract interfaces (EV.3 and EV.2 implement them on the real store); `observations(discoveryId, cursor, limit)` already exists on `DiscoveryStore` at the 0.1 commit (`src/core/scanner/store/discovery-store.ts`, around line 1135), so the lane compiles without EV. Per closed transmission on `commanded`/`relay`: `near(hz, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ, sourceId)`, take the nearest, then the observation of that discovery whose `[startedAt, endedAt ?? now]` overlaps the transmission (the first page of `observations(id, null, 64)`, newest first). Call `store.recordAnalog(observationId, { outcome: tone || code ? "decoded" : "heard", mode, voice: true, tone: { ctcssHz, dcs }, transport: "live", at })`. Never create a discovery. `unverified` → nothing. No overlapping observation → nothing. This evidence is in memory only (A12).)
- Modify: `src/core/scanner/analog-evidence.ts` only for a subscribe hook if `AnalogEvidenceLog` lacks one.
- Deliver: an exact `src/core/live-demodulator.ts` diff. Keep the current or last closed transmission's `{ ctcssHz, dcs, at }`, expose it as `status().tone` while running, and clear it on retune and stop. Main applies it after rust-demod-a merges. Also deliver the scanner-service/index wiring diff, which passes the real `DiscoveryStore` as `deps.store`; that assignment type-checks only once EV.2 and EV.3 have merged, so the lane verifies it with `git apply --check` against the 0.1 commit and Main compiles and runs it at MA.1. There is no store diff: ID uses only the frozen interfaces (A12).
- Test: `tests/unit/core/scanner/live-audio-evidence.test.ts`, `live-audio-evidence.property.test.ts` (new); a test for the live-demodulator diff in `tests/unit/core/live-demodulator-tone.test.ts` (new, committed by Main with the diff)

- [ ] **Step 1: Failing tests:** "CTCSS on commanded → decoded with tone". "No tone → heard". "Unverified → nothing". "No discovery within 6250 Hz → nothing, none created". "Relay counts as trusted". Property:

```ts
// Feature: scanner-redesign, Property 16: Live-audio evidence attaches only where it belongs
// Validates: Requirements 6.3, 6.5
// attaches only on commanded/relay within tolerance of an existing discovery, never creates,
// decoded iff tone or code. numRuns: 100
```

- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/live-audio-evidence.test.ts tests/unit/core/scanner/live-audio-evidence.property.test.ts` → FAIL. **Step 3: Implement** (store and log are fakes in tests; the store fake implements `DiscoveryNearQuery`, `recordAnalog` and `observations`). **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(scanner): live-audio channel evidence attaches to discoveries`. Hand over the diffs.

### Task ID.4: Analog replay trial in identify (R 6.6, 5.5)

**Files:**

- Modify: `src/core/scanner/identify.ts` (`IdentifyDeps.analogTrial?: AnalogTrialRunner`. For each claimed capture (WG11 6.8) whose plan includes analog, run the trial with `decoder: "analog-demod"`, `transport: "replay"`, `mode`. Feed the WG10 verdict as a `live-audio` match: `decoded` with tone on `commanded`/`relay` → identified, otherwise candidate. Outcome `heard` maps to the trial outcome `heard`. Absent dep → no analog replay trial.)
- Modify: `src/core/scanner/known-protocol.ts` only if the analog outcome must not count as a known-protocol miss (it must not).
- Test: `tests/unit/core/scanner/identify-analog-replay.test.ts` (new, fake `AnalogTrialRunner`)

- [ ] **Step 1: Failing tests:** "Claimed capture + CTCSS decoded on commanded → identified, trial decoder analog-demod transport replay". "Unverified → candidate". "No analogTrial dep → trial list deep-equal to base". "Analog no-sync is not a known-protocol miss".
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/scanner/identify-analog-replay.test.ts` → FAIL. **Step 3: Implement.** **Step 4:** PASS plus `identify-analog*.test.ts identify-heard.test.ts known-protocol*.test.ts`. The shared identify goldens must pass unchanged in ID's worktree; ID does not regenerate them.
- [ ] **Step 5: Commit** `feat(scanner): identify runs the analog replay trial on claimed captures`.

---

## Main: integration, docs, acceptance, flip

### Task MA.1: Merge and apply the seam diffs (R 10.2, 9.3)

- [ ] **Step 1:** If DT.0 reported `rustDetectorGate: "met"`, first amend the spec with a Rust detector frame engine task in lane DT. Otherwise record "deferred to WG13" with the numbers.
- [ ] **Step 2:** Merge in order DT, EV, RP, ID, applying each lane's scanner-service diff in that order. Also apply: the `src/index.ts` runner wiring (RP.3b); `gatedAt`, `analogTrial`, `activity` and `createLiveAudioEvidence` wiring (ID); the probe-pool `reserveExternal` diff (RP.3b, after EV); and any `job-runner.ts` diff from DT.2. Apply the `live-demodulator.ts` tone diff only after rust-demod-a merges.
- [ ] **Step 3:** Commit each lane's delivered test files together with the diff they cover (`scanner-service-channel-plan.test.ts`, `scanner-service-trial-evidence.test.ts`, `live-demodulator-tone.test.ts`). After EV has merged and before applying the RP and ID diffs, `pnpm run typecheck` must pass; after each of the RP and ID diffs, run the real-store scanner-service tests the lanes could not run (`tests/unit/core/scanner/scanner-service*.test.ts tests/unit/core/scanner/replay-scanner-service.test.ts`, which include `scanner-service-wg11-*.test.ts`), plus `tests/unit/core/scanner/live-audio-evidence*.test.ts` against the real store wiring. Reconcile the shared identify goldens (`identify-analog-goldens`, `identify-narrow-digital-goldens`): EV.1's regenerated files stand, and a later failure there is fixed in code or by a regeneration Main makes and lists with its requirement. Run those tests, the contract tests, `pnpm run typecheck` and `pnpm run lint` → PASS.
- [ ] **Step 4:** Commit per applied diff, with explicit paths.

### Task MA.2: Docs and coordination (R 10.3)

- [ ] **Step 1:** `docs/API.md`: every new value, field, bound and rule, including "Decode here" (ID.1 text). `docs/SCANNER.md`: parking, gate, evidence labels, proof grammar, analog trial, replay first, phases, Decode here, defaults, A6 as a known gap, and A12: trial, analog and unavailable evidence is in memory only, so after a restart only decoded proofs survive and other proven discoveries read `weak` until new evidence. `docs/ROADMAP.md`. `docs/engineering/scanner-profile.md` from DT.0/DT.1c.
- [ ] **Step 2:** Append design § Coordination note text by hand to `docs/CLI-COORDINATION.md` (no Prettier), with the merge date filled in.
- [ ] **Step 3:** `grep -rn "ScannerTrialOutcome\|ended\|surfaced\|sweepPeriodMs" cli/source` and confirm every changed contract is handled. Commit the docs.

### Task MA.3: Checkpoint (R 12.1, 12.2)

- [ ] Run `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `make chan-test`. All PASS. Grep that every property 1–16 has its trace comment and `numRuns` ≥ 100: `grep -rn "Feature: scanner-redesign, Property" tests native | wc -l` ≥ 16. Tick tasks.md and update the spec status.

### Task MA.4 / MA.5: Live acceptance, capture off then on (R 11.1–11.5)

- [ ] Main only, with the receiver grant. Run design § Live acceptance S0–S6 (with the user) and N1–N6 against pass criteria (a)–(e), first with capture off, then with capture on in protected mode. Record results generically in the spec status and docs/SCANNER.md (no private frequencies, identifiers or job ids). Restore the receiver's configured gain and AGC afterwards.

### Task MA.6: Capture default flip (only if MA.5 passes S0–S6; R 8.1–8.4, 10.4)

- [ ] **Step 1: Failing test** in `tests/unit/core/scanner-redesign-contract.test.ts`: "absent iqCapture → enabled true". "Protected starts". "Legacy without allowLegacy does not start and logs one info line naming allowLegacy". "enabled:false is off".
- [ ] **Step 2:** In `src/config.ts`, make `iqCapture` `.default({})` with `enabled` default true. Service start rule: `enabled && (mode === "protected" || allowLegacy)`. Add commented-block docs in `config/default.yaml` (the shipped file sets nothing). Update the parsed-shipped-config golden. Update API.md and SCANNER.md, and append a follow-up coordination note by hand.
- [ ] **Step 3:** Run the contract test, config tests, `pnpm test`, typecheck, lint → PASS. Commit. If MA.5 failed, record why in the spec status and leave the default off.

---

## Spec coverage map

| Requirement        | Task                           |
| ------------------ | ------------------------------ |
| 1.1–1.6            | DT.2 (1.5 also DT.1b)          |
| 2.1–2.4, 2.7       | DT.1a, DT.1b, DT.3             |
| 2.5                | EV.1, DT.3                     |
| 2.6, 2.8           | DT.1c                          |
| 3.1–3.3, 3.9       | EV.1                           |
| 3.4–3.6, 3.8, 6.5  | EV.2                           |
| 3.7, 7.5, 7.6      | EV.3                           |
| 4.1                | DT.3, EV.1                     |
| 4.2, 4.3           | RP.1c                          |
| 4.4, 4.6, 5.5, 5.6 | RP.1a, RP.1b                   |
| 4.5                | EV.4, RP.1c                    |
| 5.1, 5.2, 5.7      | RP.2, RP.3b                    |
| 5.3, 5.4           | RP.3a, RP.3b                   |
| 6.1, 6.2           | ID.1                           |
| 6.3, 6.4           | ID.3 (6.4 applied in MA.1)     |
| 6.6                | ID.4                           |
| 7.1–7.4, 7.7       | ID.2                           |
| 8.1–8.4            | 0.1 (8.2), MA.6                |
| 9.1–9.4            | DT.0, DT.1c, RP.2, RP.3b, MA.1 |
| 10.1–10.4          | 0.1, MA.1, MA.2, MA.6          |
| 11.1–11.5          | MA.4, MA.5                     |
| 12.1, 12.2         | every lane, MA.3               |
