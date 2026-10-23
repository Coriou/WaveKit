# Evidence Squelch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In `squelchMode: "auto"` on NFM and AM, live client audio passes only once an over shows
analog voice or (NFM) a standard CTCSS tone or DCS code, plays from the over's first sample through a
bounded pre-roll, and `auto` becomes the runtime default; transmissions, Activity, tones, identify,
recordings and decoders stay byte-identical.

**Architecture:** Stage 1 (today's auto squelch) still delimits transmissions. A TypeScript
`EvidenceGate` on PCM decimated to 8 kHz (`VoiceFrameMeter` + `ToneEvidence` + the scanner's pinned
judge) decides what listeners hear, and a preallocated, run-length-tagged `PreRoll` FIFO rewrites each
PCM chunk in place (one output byte per input byte) so an over plays from its onset with a constant
delay that is paid back from the silence after it. A frozen contract (task 0.1) lets lanes EV, PR, FX
and D build in parallel; lane W wires `src/core/live-demodulator.ts` against fake ports, then
integrates the real gate and pre-roll.

**Tech Stack:** TypeScript (Node 24, ESM, strict), Zod, Vitest + fast-check, Python 3
(`scripts/evidence-squelch/`), the existing Rust analyzer binary `wavekit-iqcap analyze` (read-only
use), Docker Compose (scratch acceptance, Main only), pnpm + Turborepo.

**Spec:** `docs/specs/evidence-squelch/requirements.md`, `docs/specs/evidence-squelch/design.md`,
`docs/specs/evidence-squelch/tasks.md`. Executors read the requirement and design sections each task
cites; tasks.md's lane split and file ownership are authoritative. This plan does not restate the
design's option tables or budget rationale, only what each task pins.

## Global Constraints

- Worktree `/Users/ben/Projects/wavekit-evs`, branch `batch/evidence-squelch` off `main`. Task 0.1
  lands first; each lane then works in its own worktree off `batch/evidence-squelch`
  (`/Users/ben/Projects/wavekit-evs-<lane>`). Commit only own paths with
  `git commit -m "..." -- <paths>`; never `git add -A`; never `git stash` without a unique tag; do not
  push unless the brief says so.
- File ownership (tasks.md, exclusive): **M** `packages/api-types/src/live-audio.ts`,
  `src/core/evidence-squelch/contract.ts`, `tests/unit/core/evidence-squelch/synthetic.ts`,
  `tests/unit/core/evidence-squelch/contract.test.ts`,
  `docs/engineering/EVIDENCE-SQUELCH-2026-10-ACCEPTANCE.md`; **EV**
  `src/core/evidence-squelch/{voice-meter,tone-evidence,evidence-gate}.ts`,
  `src/core/scanner/analog-trial.ts` (new exports only),
  `tests/unit/core/evidence-squelch/{voice-meter,tone-evidence,evidence-gate}*.test.ts`; **PR**
  `src/core/evidence-squelch/pre-roll.ts`, `tests/unit/core/evidence-squelch/pre-roll*.test.ts`,
  `scripts/bench/evidence-squelch.ts`; **FX** `scripts/evidence-squelch/**`,
  `tests/mocks/fixtures/evidence-squelch/**`,
  `tests/unit/core/evidence-squelch/meter-equivalence.test.ts`; **W** `src/core/live-demodulator.ts`,
  `src/core/live-demod/rust-run.ts` (only if needed; see A6), `src/api/routes/live-audio.ts`,
  `src/api/websocket/events.ts`, `tests/unit/core/live-demodulator-evidence*.test.ts`,
  `tests/unit/api/live-audio-auto-squelch*.test.ts`; **D** `docs/API.md`, `docs/ROADMAP.md`,
  `docs/CLI-COORDINATION.md` (append only, never Prettier), `config/default.yaml` (comments only).
  A lane needing a change in another lane's file asks Main.
- Hard gates for lanes: no RF, tuning, receiver or Raspberry Pi work, no deploys, no Docker builds or
  runs. Unit tests use synthetic PCM and IQ, fake child processes (`spawnStage` seam), injected clocks.
  Never connect to `127.0.0.1:15555/15556/18080`, `host.docker.internal`, any Pi/LAN IP, or ports
  9000/5173/8081/8082; in-process fakes on ephemeral ports only. Live acceptance (M.4) is Main with
  the user.
- Performance (docs/PERFORMANCE.md rules 1-5, 7, 8): no per-sample IQ work in TypeScript; per-sample
  TS only at audio rate (about 25 kHz, then 8 kHz); analysis runs only while stage 1 is open; at most
  2 ms added event-loop p99 at 2.048 Msps; no per-chunk allocation in steady state (every buffer and
  typed array allocated at construction); squelch-mode and tone-squelch changes in place (only a
  modulation change restarts); no copied GPL code. The judge's small median arrays are the one
  accepted allocation, only while waiting (design, Judge reuse).
- Decode regardless of listening: the `pcm` event bytes, transmission open/close, Activity, tone
  results, identify, recordings and decoders never read the evidence gate or the pre-roll. `pcm` is
  emitted before any rewrite of the chunk, exactly as today.
- Code: strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), no `any`, ESM with
  `.js` relative imports, `import type`, tabs / no semicolons / double quotes, errors from
  `src/utils/errors.ts` (`WaveKitError` and subclasses), `createComponentLogger` (no `console.log` in
  `src/`), Zod at external boundaries.
- Property tests: fast-check `numRuns >= 100`, trace comments
  `// Feature: evidence-squelch, Property N: <name>` and `// Validates: Requirements X.Y`; injected
  clocks; stream time counted in samples; no wall-clock throughput assertions in unit tests.
- Contract: api-types additions are additive and optional. Announce in `docs/CLI-COORDINATION.md` by
  hand (D.2) and grep `cli/source` for `squelchMode` before landing.
- Defaults byte-identical except requirements 1.1-1.5, 2.x (auto on NFM/AM), 3.1 (default flip) and
  4.1 (additive field). Goldens are recorded from the frozen code before `live-demodulator.ts` changes;
  a lane lists every golden it changes with the requirement that changes it.
- Public repo: no private notes, agent/model/reviewer names or IPs in tracked files or commits.
- Before reporting, every lane runs its touched test files (`pnpm exec vitest run <files>`),
  `pnpm run typecheck` and `pnpm run lint`. Lanes do not run the full root suite; Main does in M.1.
  Reports give base/head, commits, check output and open gaps.

## Assumptions (spec gaps resolved here)

- **A1 Spec on the branch.** The three spec files and the `docs/specs/README.md` index edit are
  untracked/modified in the shared checkout. Main commits exactly those four paths on `main`
  (`git commit -m "docs(evidence-squelch): spec" -- docs/specs/evidence-squelch docs/specs/README.md`)
  before creating the batch worktree.
- **A2 Close-guard reporting.** The design's `closed()` returns `void`, yet the wiring must tag the
  first `CLOSE_GUARD_MS` of closed PCM `guard` (design, Wiring: "tag `guard` while latched within the
  guard"). The contract makes `closed()` return the count of leading bytes of that range that fall
  inside the close guard (0 unless latched), so guard and hang clocks stay inside the gate and the
  guard/drop boundary is exact for any chunk split.
- **A3 Split-sample tags.** A sample split across two `PreRoll.process` calls takes the tag of the
  call that delivered its first byte; the tag passed with its completing bytes is ignored for that
  sample. `latch()` and `abandon()` also retag a held partial `pending` sample.
- **A4 Gate-held as closed.** While `run.gateHeld` (offset swap pending) the wiring treats stage 1 as
  closed for the evidence path (consistent with `isSquelchOpen()`), and the swap start clears gate and
  pre-roll (requirement 2.9).
- **A5 Injection seam.** `LiveDemodulatorOptions.evidenceSquelch?: EvidenceSquelchFactory` (an
  injected option key). In W.2, absent means no evidence path (frozen behaviour) so W can merge before
  EV and PR; from W.3, absent means the real `EvidenceGate`/`PreRoll`. If a factory throws for a run
  (rate below 8 kHz, bad gain), the run logs a warning and takes the frozen stage-1 auto path.
- **A6 Rust carrier evidence.** `measureRun`'s sampled path already receives `sample.quieted`
  (`metricsQuieted` in `src/core/live-demod/rust-run.ts:736`), so `rust-run.ts` is expected to stay
  unchanged.
- **A7 Existing tests and the default flip.** Existing tests that relied on the implicit `manual`
  default with an `nfm`/`am` config may change behaviour after W.1's flip. W may add an explicit
  `squelchMode: "manual"` to those configs (one-line edits, no other change) in files outside its
  list, and lists every such file in its report.
- **A8 AM at the pinned thresholds.** Until M.3 resolves requirement 8.4, `am` stays in
  `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`. If Main decides AM keeps stage 1 only, it amends the constant
  to `["nfm"]` and the requirements; no wiring change follows because W reads the constant.
- **A9 Fixture storage.** Committed goldens are the analyzer's 8 kHz s16le audio and statistics JSON
  per fixture (at most 4 s, 64 KB each). CU8 files for the fake `rtl_tcp` are generated on demand
  into `output/evidence-squelch/` (git-ignored) and never committed.
- **A10 Non-finite frames and tone evidence.** Requirement 1.4's "a non-finite statistic fails that
  judgement closed" applies to the voice judgement (1.3) only. A non-finite frame in the voice window
  does **not** block tone evidence: tones are qualified by `CtcssBank`/`DcsDecoder`, which have their
  own input handling, and a NaN in the meter's window says nothing about a tone that the detectors
  qualified. So `judgeEvidence` checks the tone first and only then applies `framesFinite`. This
  deliberately differs from `classifyAnalogTrial`, which returns `no-sync` for any non-finite frame
  before it looks at the tone; Property 2 therefore never generates a qualified tone together with a
  non-finite frame.
- **A11 Empty quiet window.** With `notedBlocks === 0` the window is not quiet enough (fail closed);
  the rule `quietBlocks >= ANALOG_TRIAL_MIN_QUIET_FRACTION × notedBlocks` applies only when
  `notedBlocks > 0`. Without this, `0 >= 0` would count an empty window as quiet.

## Review Focus

1. **A PCM chunk boundary inside a sample at a stage-1 edge or a latch** (odd byte counts for s16le,
   1-3 byte tails for f32le). Expected: output bytes identical to any other split; muting and
   playback only ever on whole samples. Test: W.2 Step 1 `odd chunk sizes across edges`.
2. **A kerchunk then voice inside the hang** (stage 1 closes during `waiting`, reopens 300 ms later
   with speech). Expected: the first burst's evidence is discarded, the new over needs a fresh full
   window and still plays from its own onset; the first burst is never played. Test: EV.3 Step 1
   `discards evidence on a close before latch` and PR.1 `abandoned over then new over`.
3. **Switching `squelchMode` from `auto` to `manual` (or setting a tone squelch) while 1 s is queued.**
   Expected: delay 0 at once, nothing queued is played, the next bytes follow the new mode. Test: W.2
   `mode change mid-over clears the queue`.
4. **A carrier held for minutes** (latched voice over, or a silent carrier stuck in `waiting`).
   Expected: delay constant while latched; in `waiting` the FIFO stays at capacity, overflow discards
   only `pending`, nothing is allocated. Test: PR.1 `ten minutes waiting at capacity` and PR.2.
5. **Non-finite f32le samples (NaN/Infinity) in PCM.** Expected: the meter fails that frame closed
   (no voice evidence), the decimator counts it as 0, the pre-roll carries bytes verbatim. Test: EV.1
   `non-finite input fails the frame closed` and EV.3 `NaN audio never opens`.

## File Structure

| Path                                                               | Lane | Responsibility                                                            |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------- |
| `packages/api-types/src/live-audio.ts`                             | M    | `LIVE_AUDIO_AUTO_SQUELCH_*`, `LiveAudioAutoSquelch`, optional fields      |
| `src/core/evidence-squelch/contract.ts`                            | M    | Ports, factory type, sizing and applicability helpers                     |
| `tests/unit/core/evidence-squelch/synthetic.ts`                    | M    | Synthetic 8 kHz-and-up PCM generators shared by lanes                     |
| `tests/unit/core/evidence-squelch/contract.test.ts`                | M    | Pins values, equalities and the sizing table                              |
| `src/core/evidence-squelch/voice-meter.ts`                         | EV   | `VoiceFrameMeter` (audioDb, syllabic, cluster per 50 ms frame)            |
| `src/core/evidence-squelch/tone-evidence.ts`                       | EV   | `ToneEvidence` (any standard CTCSS / DCS)                                 |
| `src/core/evidence-squelch/evidence-gate.ts`                       | EV   | `EvidenceGate` state machine, `judgeEvidence`                             |
| `src/core/scanner/analog-trial.ts`                                 | EV   | Export `toneQualified`, `dataLike` (no behaviour change)                  |
| `src/core/evidence-squelch/pre-roll.ts`                            | PR   | `PreRoll` tagged FIFO                                                     |
| `scripts/bench/evidence-squelch.ts`                                | PR   | Bench, before/after table                                                 |
| `scripts/evidence-squelch/{fixtures.py,goldens.py}`                | FX   | Fixture generator (CF32 48 kHz, CU8 2.048/2.4 Msps), analyzer goldens     |
| `scripts/evidence-squelch/{compose.yaml,config*.yaml,run_acceptance.py,README.md}` | FX | Scratch fake-link project and driver                              |
| `tests/mocks/fixtures/evidence-squelch/`                           | FX   | `<name>.audio.s16le`, `<name>.stats.json`, `manifest.json`                |
| `tests/unit/core/evidence-squelch/meter-equivalence.test.ts`       | FX   | Requirement 5.1/5.2                                                       |
| `src/core/live-demodulator.ts`                                     | W    | Default flip, evidence path, lifecycle, status                            |
| `src/api/routes/live-audio.ts`, `src/api/websocket/events.ts`      | W    | Route fallback, `autoSquelch` in REST status DTO + schema, `live-audio:level` |
| `tests/unit/core/live-demodulator-evidence*.test.ts`               | W    | Goldens, wiring, integration                                              |
| `tests/unit/api/live-audio-auto-squelch*.test.ts`                  | W    | Route default, REST status `autoSquelch` (inject), level DTO              |
| `docs/API.md`, `docs/ROADMAP.md`, `docs/CLI-COORDINATION.md`, `config/default.yaml` | D | Docs and coordination                                     |
| `docs/engineering/EVIDENCE-SQUELCH-2026-10-ACCEPTANCE.md`          | M    | Fake-link and live records                                                |

Order: 0.1 → (EV, PR.1-PR.2, FX.1, D.1, W.1-W.2 in parallel) → FX.2 after EV.1; PR.3 after EV.3;
W.3 after EV and PR merge → M.2 immediately after W.3 → M.3 before W.1's default-flip commit merges
→ D.2 → M.4, M.5.

---

## Contract

### Task 0.1: Freeze the contract (Main)

**Files:**
- Modify: `packages/api-types/src/live-audio.ts` (after `LIVE_AUDIO_TONE_SQUELCH_CLOSE_COUNT`, line 49;
  `LiveAudioConfig.squelchMode` doc comment line 58; `LiveAudioStatus` line 86; `LiveAudioLevel`
  line 142)
- Create: `src/core/evidence-squelch/contract.ts`
- Create: `tests/unit/core/evidence-squelch/synthetic.ts`
- Test: `tests/unit/core/evidence-squelch/contract.test.ts`

**Interfaces:**
- Produces (api-types, exported from `@wavekit/api-types`):
  - `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS: readonly LiveAudioConfig["modulation"][]` = frozen
    `["nfm", "am"]`
  - `LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS` = frozen `["nfm"]`
  - `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS = 50`, `_VOICE_FRAMES = 20`, `_QUIET_WINDOW_BLOCKS = 100`,
    `_TONE_MIN_MS = 750`, `_HANG_MS = 1_500`, `_PREROLL_MAX_MS = 1_500`, `_CLOSE_GUARD_MS = 200`
  - `type LiveAudioAutoSquelchEvidence = "voice" | "ctcss" | "dcs"`
  - `interface LiveAudioAutoSquelch { state: "off" | "waiting" | "open"; evidence?: LiveAudioAutoSquelchEvidence }`
  - `LiveAudioStatus.autoSquelch?: LiveAudioAutoSquelch`, `LiveAudioLevel.autoSquelch?: LiveAudioAutoSquelch`
- Produces (`src/core/evidence-squelch/contract.ts`):

```ts
export type EvidencePcmFormat = "s16le" | "f32le"
export type PreRollTag = "pending" | "pass" | "guard" | "drop"
export interface EvidenceGatePort {
	readonly state: "waiting" | "open"
	readonly evidence: LiveAudioAutoSquelchEvidence | null
	noteBlock(carrier: boolean): void
	/** Byte offset in [start, end] of the first sample after a latch in this call, or -1. */
	push(pcm: Buffer, format: EvidencePcmFormat, start: number, end: number): number
	/** Stage-1-closed bytes: advances hang and guard; returns leading bytes inside the close guard (A2). */
	closed(byteCount: number, format: EvidencePcmFormat): number
	reset(): void
}
export interface PreRollPort {
	process(chunk: Buffer, start: number, end: number, tag: PreRollTag): void
	latch(): void
	abandon(): void
	clear(): void
	readonly delaySamples: number
}
export interface EvidenceGateOptions { rate: number; modulation: "nfm" | "am"; gain: number }
export interface PreRollOptions { rate: number; format: EvidencePcmFormat }
export interface EvidenceSquelchFactory {
	createGate(options: EvidenceGateOptions): EvidenceGatePort
	createPreRoll(options: PreRollOptions): PreRollPort
}
export function msToSamples(ms: number, rate: number): number // Math.ceil(rate * ms / 1000)
export function preRollCapacitySamples(rate: number): number // msToSamples(PREROLL_MAX_MS, rate)
export function preRollBytes(rate: number, format: EvidencePcmFormat): number // (capacity + 1) * width
export function evidenceGateApplies(config: {
	squelchMode?: LiveAudioSquelchMode | undefined
	modulation: LiveAudioConfig["modulation"]
	toneSquelch?: LiveAudioToneSquelch | undefined
}): boolean // mode === "auto" && modulation in MODULATIONS && (toneSquelch absent or kind "none")
```

- Produces (`synthetic.ts`, all deterministic from a seed, returning `Float32Array` at a given rate,
  amplitude in PCM full-scale units): `voiceLike({ rate, seconds, seed, level? })` (harmonic
  speech-shaped signal, 4 Hz syllabic envelope with pauses), `ctcssMix({ rate, seconds, hz })`,
  `dcsMix({ rate, seconds, code, polarity })`, `carrierSilence({ rate, seconds, noiseLevel? })`,
  `fskBursts({ rate, seconds, levels: 2 | 4, baud, burstMs, gapMs, seed })`,
  `clicks({ rate, seconds, perSecond, seed })`, `impulseNoise(...)`, `whiteNoise(...)`, `mix(a, b)`,
  `toPcm(samples, format): Buffer`. Reuse `speechLike`, `ctcssTone`, `dcsAudio`, `whiteNoise` from
  `tests/unit/core/audio-tones/dcs-synth.ts` where they fit.

- [ ] **Step 1: Write the failing contract test** `tests/unit/core/evidence-squelch/contract.test.ts`

```ts
expect(LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS).toEqual(["nfm", "am"])
expect(LIVE_AUDIO_AUTO_SQUELCH_TONE_MODULATIONS).toEqual(["nfm"])
expect(LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS).toBe(ANALOG_TRIAL_FRAME_MS)
expect(LIVE_AUDIO_AUTO_SQUELCH_TONE_MIN_MS).toBe(DCS_MIN_AUDIO_SECONDS * 1000)
expect(LIVE_AUDIO_AUTO_SQUELCH_HANG_MS).toBe(ANALOG_TRANSMISSION_MERGE_GAP_MS)
expect(LIVE_AUDIO_AUTO_SQUELCH_VOICE_FRAMES * LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS).toBe(1000)
expect(LIVE_AUDIO_AUTO_SQUELCH_QUIET_WINDOW_BLOCKS).toBe(100)
expect([LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS, LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS]).toEqual([1500, 200])
// Sizing table (design, Pre-roll sizing): rate, samples, s16le bytes, f32le bytes
for (const [rate, samples, s16, f32] of [
	[2_048_000 / Math.round(2_048_000 / 25_000), 37_464, 74_930, 149_860],
	[25_000, 37_500, 75_002, 150_004],
	[50_000, 75_000, 150_002, 300_004],
	[2_048_000 / Math.round(2_048_000 / 20_000), 30_118, 60_238, 120_476],
]) { expect(preRollCapacitySamples(rate)).toBe(samples); expect(preRollBytes(rate, "s16le")).toBe(s16); expect(preRollBytes(rate, "f32le")).toBe(f32) }
expect(evidenceGateApplies({ squelchMode: "auto", modulation: "nfm" })).toBe(true)
expect(evidenceGateApplies({ squelchMode: "auto", modulation: "am", toneSquelch: { kind: "none" } })).toBe(true)
for (const m of ["wfm", "usb", "lsb", "dsb", "cw", "raw"] as const) expect(evidenceGateApplies({ squelchMode: "auto", modulation: m })).toBe(false)
expect(evidenceGateApplies({ squelchMode: "manual", modulation: "nfm" })).toBe(false)
expect(evidenceGateApplies({ squelchMode: "noise", modulation: "nfm" })).toBe(false)
expect(evidenceGateApplies({ squelchMode: "auto", modulation: "nfm", toneSquelch: { kind: "ctcss", frequencyTenthsHz: 670 } })).toBe(false)
```

Plus a smoke test per `synthetic.ts` generator: length `round(rate × seconds)`, all finite, same
output for the same seed.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run tests/unit/core/evidence-squelch/contract.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement the api-types additions, `contract.ts` and `synthetic.ts`** as listed in
  Interfaces. Change the `squelchMode` doc comment to say `auto` is the runtime default and, on NFM
  and AM, gates client audio on voice/tone evidence with a pre-roll; `manual` and `noise` unchanged.
  Do not edit the core `LiveAudioLevel` in `src/core/live-demodulator.ts` (lane W).

- [ ] **Step 4: Run to verify it passes**, then `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`.
  Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(evidence-squelch): freeze contract" -- packages/api-types/src/live-audio.ts src/core/evidence-squelch/contract.ts tests/unit/core/evidence-squelch/synthetic.ts tests/unit/core/evidence-squelch/contract.test.ts
```

---

## Lane EV: evidence

### Task EV.1: `VoiceFrameMeter`

**Files:**
- Create: `src/core/evidence-squelch/voice-meter.ts`
- Test: `tests/unit/core/evidence-squelch/voice-meter.test.ts`

**Interfaces:**
- Consumes: `LIVE_AUDIO_AUTO_SQUELCH_FRAME_MS`, `_VOICE_FRAMES`; `AUDIO_TONE_RATE_HZ` (8 000) from
  `src/core/audio-tones/tone-detector.ts`.
- Produces:

```ts
export const VOICE_METER_FRAME_SAMPLES = 400
export interface VoiceFrame { audioDb: number; syllabic: number; cluster: number; finite: boolean }
export class VoiceFrameMeter {
	constructor(options: { gain: number }) // WaveKitError "EVIDENCE_GAIN" unless finite and > 0
	/** One 8 kHz sample in PCM full-scale units. True when a frame completed (read `frame`). */
	push(sample: number): boolean
	readonly frame: Readonly<VoiceFrame> // reused record: the last completed frame
	readonly frameCount: number
	reset(): void
}
```

Algorithms (design, VoiceFrameMeter; reference `native/wavekit-chan/src/iqcap/analyze.rs`
`audio_band_power` line 505, `push_envelope` 553, `syllabic_index` 800, `cluster_score` 842,
`cluster_levels` 846, `kmeans_hist` 889, `Biquad::from_rbj` 1078; textbook reimplementation, no
line-by-line port): scale `x = sample / (gain / 2)`; `audioDb` = 10·log10(mean square of
HP 300 Hz → LP 3 kHz RBJ biquads at 8 kHz / 0.32), −160 for zero; `syllabic` from a
`Float64Array(20)` envelope ring of frame band power (one-pole 2 Hz high-pass over the ring started
at rest, RMS of output / ring mean, clamp 0..160, 0 for < 2 entries or silent mean); `cluster` = max
of the histogram k-means score (256 bins, 6 iterations, k = 2 and 4, 15 % band, min centroid span
0.15 rad) on the 2.4 kHz low-passed frame and on the frame as received, after
`rad = x × (2π × 5000 / 48000) / 0.8`. All state allocated in the constructor.

- [ ] **Step 1: Write failing tests**
  - `emits one frame per 400 samples`: 4 000 samples → 10 `true` returns, `frameCount === 10`.
  - `silence`: zeros → `audioDb === -160`, `syllabic === 0`, `finite === true`.
  - `full-deviation sine reads 0 dB`: a 1 kHz sine of amplitude 0.8 at gain 2 → `audioDb` within
    0.5 of 0; same sine ×1.5 at `gain: 3` → within 0.5 of 0 (requirement 5.2).
  - `voice-like is syllabic`: `voiceLike` 2 s at 8 kHz → median syllabic of frames 20..40 ≥ 0.3 and
    median audioDb ≥ −30.
  - `steady tone is not syllabic`: 1 kHz sine 2 s → median syllabic < 0.3.
  - `4-level FSK clusters`: `fskBursts({ levels: 4, baud: 4800, burstMs: 1000, gapMs: 0 })` at
    deviation-scaled amplitude → median cluster ≥ 0.6; `voiceLike` → median cluster < 0.6.
  - `non-finite input fails the frame closed`: one `NaN` in a frame → that frame `finite === false`;
    the next all-finite frame `finite === true`.
  - `reset returns to constructed state`: run voice, `reset()`, run silence → identical frames to a
    fresh meter on silence.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/evidence-squelch/voice-meter.test.ts` →
  FAIL (module missing).
- [ ] **Step 3: Implement `VoiceFrameMeter`** per Interfaces.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(evidence-squelch): voice frame meter` with both paths.

### Task EV.2: `ToneEvidence` and judge exports

**Files:**
- Create: `src/core/evidence-squelch/tone-evidence.ts`
- Modify: `src/core/scanner/analog-trial.ts` (export `toneQualified` at line 135; add exported
  `dataLike(stats: AnalogTrialStats): boolean` = the median-cluster test now inline in
  `classifyAnalogTrial`, and use it there)
- Test: `tests/unit/core/evidence-squelch/tone-evidence.test.ts`

**Interfaces:**
- Consumes: `CtcssBank`, `CTCSS_HZ` (`src/core/audio-tones/ctcss.ts`); `DcsDecoder`, `packDcs`
  (`src/core/audio-tones/dcs.ts`); `DCS_STANDARD_CODES`, `LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT`.
- Produces:

```ts
export type ToneReading =
	| { kind: "ctcss"; index: number; hz: number }
	| { kind: "dcs"; packed: number; dcs: AnalogTransmissionDcs }
export class ToneEvidence {
	constructor() // one CtcssBank, one DcsDecoder, frozen packed→AnalogTransmissionDcs table for every standard code × polarity
	/** One 8 kHz sample. */
	push(sample: number): void
	/** Latest qualified tone (reused records), or null. No 750 ms floor here: the gate applies it. */
	current(): Readonly<ToneReading> | null
	reset(): void
}
export function toneQualified(tones: AnalogTrialTones | null | undefined): boolean // analog-trial.ts
export function dataLike(stats: AnalogTrialStats): boolean // analog-trial.ts: median cluster >= ANALOG_TRIAL_DATA_SCORE
```

Rules: CTCSS qualifies when two consecutive completed blocks (`blockCount()` advanced) report the
same `lastBlockToneIndex() >= 0`; it stays current while consecutive blocks keep that index and is
replaced when another index qualifies. DCS qualifies when, after a new bit, `wordReading()` is in the
standard table and `wordHits() >= LIVE_AUDIO_TONE_SQUELCH_OPEN_COUNT`. Allocation-free per sample.

- [ ] **Step 1: Write failing tests**
  - `qualifies 67.0, 100.0 and 250.3 Hz`: `ctcssMix` + `voiceLike` at 8 kHz, 1.5 s → `current()`
    is `{ kind: "ctcss", hz }` for each; first qualification at sample ≥ 6 000 (750 ms).
  - `qualifies DCS 023N and 754I`: `dcsMix` + voice, 1.5 s → `{ kind: "dcs", dcs: { code, polarity } }`
    with the configured code or its twin (`dcsTwin`).
  - `off-table tone never qualifies`: 1 kHz and 60 Hz sines → `current() === null`.
  - `voice and FSK alone never qualify`.
  - `reset clears`.
  - `analog-trial exports keep behaviour`: the existing tests
    `tests/unit/core/scanner/analog-trial*.test.ts` (run them unchanged) plus, with a test-local
    helper building 20 finite frames of a given cluster score,
    `dataLike({ mode: "nfm", frames: twentyFramesWithCluster(0.6), gapSamples: 0, floorDb: -100 }) === true`,
    `0.59 → false`, `toneQualified({ ctcssHz: 67, dcs: null, audioSeconds: 0.75 }) === true`,
    `audioSeconds: 0.74 → false`.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/evidence-squelch/tone-evidence.test.ts tests/unit/core/scanner/analog-trial.test.ts tests/unit/core/scanner/analog-trial.property.test.ts tests/unit/core/scanner/job-analog-trial.test.ts` → FAIL (new exports missing).
- [ ] **Step 3: Implement** `ToneEvidence` and the two exports (no behaviour change to
  `classifyAnalogTrial`).
- [ ] **Step 4: Run** → PASS, including every existing scanner test.
- [ ] **Step 5: Commit** `feat(evidence-squelch): tone evidence and judge exports`.

### Task EV.3: `EvidenceGate`

**Files:**
- Create: `src/core/evidence-squelch/evidence-gate.ts`
- Test: `tests/unit/core/evidence-squelch/evidence-gate.test.ts`,
  `tests/unit/core/evidence-squelch/evidence-gate.property.test.ts`

**Interfaces:**
- Consumes: EV.1, EV.2; `PcmDecimator` (`src/core/audio-tones/tone-detector.ts:55`);
  `isVoice`, `dataLike`, `toneQualified`, `classifyAnalogTrial`; `ANALOG_TRIAL_MIN_QUIET_FRACTION`;
  contract `EvidenceGatePort`, `EvidenceGateOptions`, `msToSamples`.
- Produces:

```ts
export class EvidenceGate implements EvidenceGatePort {
	constructor(options: EvidenceGateOptions) // WaveKitError "EVIDENCE_RATE" when rate < 8000 or not finite
}
/**
 * Pure judge (Property 2). Order: (1) tone (NFM only, audio >= TONE_MIN_MS, standard CTCSS or DCS)
 * → its kind, regardless of `framesFinite` (A10); (2) `!framesFinite` → null; (3) median cluster
 * >= ANALOG_TRIAL_DATA_SCORE → null; (4) quiet enough: `notedBlocks > 0 &&
 * quietBlocks >= ANALOG_TRIAL_MIN_QUIET_FRACTION * notedBlocks` (A11), else null; (5) `isVoice`
 * → "voice", else null. AM never takes step 1.
 */
export function judgeEvidence(input: {
	modulation: "nfm" | "am"
	stats: AnalogTrialStats // 20 frames; carrierDb/hfNoiseDb unused
	tone: Readonly<ToneReading> | null
	audioMs: number
	quietBlocks: number
	notedBlocks: number // blocks noted in the last QUIET_WINDOW_BLOCKS
	framesFinite: boolean
}): LiveAudioAutoSquelchEvidence | null
```

State machine (design table): `idle` → `waiting` on the first `push` (audio clock 0, quiet ring
`Uint8Array(100)` empty); in `waiting`, voice is judged on every new frame once 20 frames are in the
ring, tone on every new reading once audio ≥ 750 ms; latch returns the byte offset of the first
sample after the latching sample. `closed()` while `waiting` only keeps framing (wiring calls
`reset()` on the edge). `closed()` while `open`: counts closed samples; returns guard bytes for the
first `msToSamples(CLOSE_GUARD_MS, rate)` samples; after `msToSamples(HANG_MS, rate)` closed samples
→ `idle`, evidence `null`. `push` after `closed` while `open` = reopen within the hang: latch kept,
closed counter and tone stage reset, meter kept. A different standard tone qualifying while `open`
sets `evidence` to the new kind (renewal; `push` returns -1). `noteBlock` ignored while `idle`. Split
samples carried as in `ToneSquelchGate` (4-byte hold). `reset()` → `idle`, all evidence dropped,
framing kept. Allocation only inside `judgeEvidence` medians.

- [ ] **Step 1: Write failing example tests** (`evidence-gate.test.ts`, 25 kHz s16le unless stated;
  stage-1 open throughout unless stated; carrier blocks noted every 10 ms of audio):
  - `opens on voice within 1.5 s`: `voiceLike` with all blocks quiet → `state` `open`, `evidence`
    `voice`, latch offset ≤ bytes of 1 500 ms.
  - `opens on CTCSS at >= 750 ms`, `opens on DCS at >= 750 ms` (NFM), evidence `ctcss` / `dcs`.
  - `AM ignores tones`: AM gate with `ctcssMix` + silence → never opens; AM `voiceLike` with blocks
    quiet → opens `voice`.
  - `voice without quieting never opens`: voice, every `noteBlock(false)`.
  - `NaN audio never opens`: f32le `voiceLike` with one NaN per frame.
  - `discards evidence on a close before latch`: 600 ms voice, `reset()`, 300 ms closed, 700 ms voice
    → still `waiting` (window not refilled); continued voice opens later than a fresh gate would by
    ≥ 0 samples.
  - `hang`: latch, then `closed()` for 1 499 ms → `open`; 1 ms more → `waiting` with evidence `null`.
  - `close guard`: latch, `closed(bytesOf(300 ms))` returns `bytesOf(200 ms)`; a second call returns 0.
  - `reopen within the hang keeps the latch`; `renewal`: latched `ctcss` 67.0, close 500 ms, reopen with
    DCS 023N → `evidence === "dcs"`, `state` stays `open`, `push` never returns ≥ 0 again.
  - `rate below 8 kHz throws`.
- [ ] **Step 2: Write failing property tests** (`evidence-gate.property.test.ts`), each with its trace
  comments and `numRuns: 100`:
  - Property 1 Monotone in evidence (Validates 1.2, 1.3): drive `judgeEvidence` frame by frame for a
    generated frame sequence and a dominated-by-better sequence; the better one opens no later.
  - Property 2 Judge agreement (Validates 1.2, 1.3, 1.4): generate `modulation` (`nfm` | `am`),
    20 frames (`syllabic`, `audioDb`, `cluster` finite), a tone record, `audioMs` in [0, 3000],
    `notedBlocks` in [0, 100] and `quietBlocks` in [0, notedBlocks]. Assert
    `judgeEvidence(...) !== null` iff
    `["decoded", "heard"].includes(classifyAnalogTrial(statsWithQuietFramesMatchingCount, tones))`,
    with the oracle inputs built as follows (each rule closes a known divergence; do not move the
    gate's thresholds to make the property pass):
    - **Quiet-frame mapping:** `quietFrames = notedBlocks === 0 ? 0 : Math.floor(20 × quietBlocks / notedBlocks)`.
      `floor` makes `quietFrames >= 10` exactly equivalent to `quietBlocks >= 0.5 × notedBlocks`
      (requirement 1.3); `ceil` would let ratios above 0.45 through (q = 46, n = 100 → 10 frames).
      `notedBlocks === 0` maps to 0 quiet frames, matching A11.
    - **Frame quieting:** every frame has `carrierDb` and `hfNoiseDb` above −159.9 (not silence).
      NFM: `hfNoiseDb = −10` on the first `quietFrames` frames, `0` on the rest. AM: `floorDb = −60`,
      `carrierDb = −50` (≥ floor + 6) on the first `quietFrames` frames, `−60` on the rest.
    - **Tones:** NFM: the generated record (none, a standard or off-table CTCSS Hz, a standard or
      non-standard DCS code) with `audioSeconds = audioMs / 1000`. AM: always pass `tones` with no
      CTCSS and no DCS, because `classifyAnalogTrial` returns `decoded` for a qualified tone in any
      mode while requirement 1.2 counts only voice on AM; the gate receives the generated tone record
      unchanged, so the property also checks that AM ignores it.
    - **Non-finite frames (A10):** with probability ~1/5 one generated frame gets a non-finite field
      and `framesFinite = false`, in which case the tone record is forced to "none" for both sides (a
      qualified tone with a non-finite frame is excluded from the iff; the gate's tone-first order
      would say open while the classifier says `no-sync`). A separate example test in
      `evidence-gate.test.ts`, `tone opens despite a non-finite voice frame`, pins A10 directly:
      `judgeEvidence` with a qualified NFM CTCSS, `audioMs = 800`, `framesFinite = false` → `"ctcss"`.
  - Property 3 Bare carrier and data never open (Validates 1.4): generated stage-1 schedules over
    silence, an off-table steady tone, noise with `noteBlock(false)`, `fskBursts` → never `open`.
  - Property 4 Latch through the hang (Validates 1.5).
  - Property 5 Status at received time, gate part (Validates 2.7, 4.1): the sample index at which
    `state` becomes `open` is the same whether or not a `PreRoll` stub consumes the bytes.
  - Property 6 Chunk-split invariance, gate state sequence (Validates 2.3): same PCM and schedule, two
    random byte splits (including inside samples, s16le and f32le) → identical per-sample state
    sequence and latch sample index.
- [ ] **Step 3: Run** both files → FAIL.
- [ ] **Step 4: Implement `EvidenceGate` and `judgeEvidence`.**
- [ ] **Step 5: Run** both files and EV.1/EV.2 tests → PASS; `pnpm run typecheck`, `pnpm run lint`.
- [ ] **Step 6: Commit** `feat(evidence-squelch): evidence gate`.

---

## Lane PR: pre-roll

### Task PR.1: `PreRoll`

**Files:**
- Create: `src/core/evidence-squelch/pre-roll.ts`
- Test: `tests/unit/core/evidence-squelch/pre-roll.test.ts`,
  `tests/unit/core/evidence-squelch/pre-roll.property.test.ts`

**Interfaces:**
- Consumes: contract `PreRollPort`, `PreRollOptions`, `PreRollTag`, `preRollCapacitySamples`,
  `preRollBytes`.
- Produces: `export class PreRoll implements PreRollPort { constructor(options: PreRollOptions); readonly capacitySamples: number }`
  (WaveKitError `"PRE_ROLL_FORMAT"` on an unknown format, `"PRE_ROLL_RATE"` on a non-finite or
  non-positive rate).

Storage: one byte ring `Buffer.alloc(preRollBytes(rate, format))` and a run-length tag ring
`Int32Array(2 × 160)` (length, tag code), allocated in the constructor. Output rule exactly as design
(PreRoll, steps 1-3), implemented per run of samples with `Buffer.copy`; split-sample input hold and
output-in-flight counter per A3; fast path: FIFO empty and tag `drop` → `chunk.fill(0, start, end)`.

- [ ] **Step 1: Write failing example tests** (s16le and f32le, rate 25 000 unless stated):
  - `fast path zero-fills`: empty FIFO, `drop` → range zeroed, `delaySamples === 0`.
  - `waiting emits zeros and grows delay`: 400 ms `pending` → output zeros, `delaySamples` = samples.
  - `latch plays from onset`: 900 ms `pending`, `latch()`, 2 s `pass` → output after the zeros equals
    the input from sample 0, delay constant 900 ms worth.
  - `catch-up after the tail`: then 300 ms `guard` and 2 s `drop` → the 900 ms tail and the guard play,
    then `delaySamples === 0` within one sample and the rest is zeros.
  - `abandoned over then new over`: 600 ms `pending`, `abandon()`, 200 ms `drop`, 1 s `pending`,
    `latch()` → none of the first 600 ms is ever emitted; the new over plays from its first sample.
  - `overflow discards oldest pending`: 2 s `pending` then `latch()` → playback starts 1 500 ms before
    the latch; `delaySamples <= capacitySamples` throughout.
  - `capacity bound per sizing row`: for each of the four contract sizing rows and both formats,
    `pending` for exactly `capacitySamples` then one more sample → `delaySamples === capacitySamples`,
    no throw.
  - `ten minutes waiting at capacity`: 10 min of 10 ms `pending` chunks → `delaySamples` stays
    `capacitySamples`, output all zeros.
  - `clear`: queued `pass`, `clear()` → `delaySamples === 0`; next `pass` input emitted at delay 0 and
    no earlier byte ever appears.
- [ ] **Step 2: Write failing properties** (`pre-roll.property.test.ts`, generated per-sample tag
  schedules consistent with the wiring: `pending` runs end in `latch()` or `abandon()`, `guard` only
  after `pass`), each `numRuns: 100` with trace comments: Property 6 (output bytes, Validates 2.3),
  7 Nominal rate (2.3), 8 Delayed copy (2.4), 9 Bounded delay (2.2), 10 Onset (2.1), 11 Catch-up
  drops only silence (2.5, 2.6; instrument with a reference model that labels every input sample and
  checks each discarded one), 13 Lifecycle (2.9).
- [ ] **Step 3: Run** `pnpm exec vitest run tests/unit/core/evidence-squelch/pre-roll.test.ts tests/unit/core/evidence-squelch/pre-roll.property.test.ts` → FAIL.
- [ ] **Step 4: Implement `PreRoll`.**
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** `feat(evidence-squelch): pre-roll`.

### Task PR.2: Allocation check

**Files:** Test: `tests/unit/core/evidence-squelch/pre-roll.alloc.test.ts`

- [ ] **Step 1: Write the test** `no allocation after construction`: construct `PreRoll` (25 kHz,
  s16le and f32le), preallocate 10 000 input chunks of mixed sizes (1..2 048 bytes) and a tag schedule
  covering every tag, `latch`, `abandon`; then `vi.spyOn` `Buffer.alloc`, `Buffer.allocUnsafe`,
  `Buffer.from`, `Buffer.concat` and wrap the `Int32Array`, `Uint8Array`, `Float32Array`,
  `Float64Array` constructors via `vi.stubGlobal`; run all chunks through `process`; assert zero calls.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/evidence-squelch/pre-roll.alloc.test.ts` →
  PASS (fix `pre-roll.ts` if not).
- [ ] **Step 3: Commit** `test(evidence-squelch): pre-roll allocation check`.

### Task PR.3: Bench (after EV.3 merges)

**Files:** Create: `scripts/bench/evidence-squelch.ts`; output table pasted into the acceptance
document by Main (M.2).

- [ ] **Step 1: Write the bench** (same header style and esbuild invocation as
  `scripts/bench/burst-absorber.ts`): cases 25 kHz and 50 kHz audio, s16le and f32le, voice over
  `waiting` → `open`, closed idle; measures (a) CPU per second of audio (core fraction) and (b) the
  largest synchronous step for a 64 KiB chunk (median of five passes after a warmup) for: the frozen
  path (`ToneSquelchGate`-free `chunk.fill(0)` and a `ToneSquelchGate` push), `EvidenceGate.push` +
  `PreRoll.process`, and the fast path. Prints a Markdown table "before/after" with design budget
  rows (Budgets table) and a pass/fail column against ≤ 0.006 core and ≤ 1 ms per 64 KiB on desktop.
  CLI: `--seconds <n>` (default 30), `--json`.
- [ ] **Step 2: Run**
  `pnpm exec esbuild scripts/bench/evidence-squelch.ts --bundle --platform=node --format=esm --packages=external --outfile=output/bench/evidence-squelch.mjs && node output/bench/evidence-squelch.mjs --seconds 10`
  Expected: a table with every row filled; report the numbers in the lane report.
- [ ] **Step 3: Commit** `bench(evidence-squelch): gate and pre-roll cost`.

---

## Lane FX: fixtures and equivalence

### Task FX.1: Fixture generator and analyzer goldens

**Files:**
- Create: `scripts/evidence-squelch/fixtures.py`, `scripts/evidence-squelch/goldens.py`,
  `scripts/evidence-squelch/README.md`
- Create: `tests/mocks/fixtures/evidence-squelch/manifest.json`,
  `tests/mocks/fixtures/evidence-squelch/<name>.audio.s16le`,
  `tests/mocks/fixtures/evidence-squelch/<name>.stats.json`

**Interfaces:**
- Produces fixture names (manifest keys) and expected verdicts: `nfm-ctcss-670-voice`,
  `nfm-ctcss-1000-voice`, `nfm-ctcss-2503-voice` (open, `ctcss`), `nfm-dcs-023n-voice`,
  `nfm-dcs-754i-voice` (open, `dcs`), `nfm-voice` (open, `voice`), `am-voice` (open, `voice`,
  subject to 8.4), `nfm-carrier`, `am-carrier`, `nfm-dmr-4fsk`, `nfm-pocsag-512`,
  `nfm-pocsag-1200`, `nfm-clicks`, `nfm-impulse`, `nfm-noise` (never open). Manifest entry:
  `{ "mode": "nfm" | "am", "expect": "voice" | "ctcss" | "dcs" | "none", "verdict": "voice" | "data-like" | "neither", "overOnsetS": number, "seed": number }`.
- `fixtures.py` CLI: `--format cf32 --rate 48000 --out <dir>` (analyzer input, ≤ 4 s each) and
  `--format cu8 --rate 2048000|2400000 --out output/evidence-squelch/cu8 --gap-s 3` (fake `rtl_tcp`,
  over at a known offset with silence between overs, A9). POCSAG reuses
  `fixtures/generators/pocsag.py`. Deterministic per seed. Python standard library only (`scripts/capacity/` uses no numpy).
- `goldens.py`: runs `native/wavekit-chan/target/release/wavekit-iqcap analyze --in <abs cf32> --mode nfm|am`
  with fd 4 inherited to capture the JSON line, stdout to `<name>.audio.s16le`, JSON to
  `<name>.stats.json`; exits non-zero on any `reject`.

- [ ] **Step 1: Write `fixtures.py`** with a `--self-test` that asserts each class's length, finite
  samples and determinism.
- [ ] **Step 2: Run** `python3 scripts/evidence-squelch/fixtures.py --self-test` → `ok`.
- [ ] **Step 3: Write `goldens.py`**; run `make chan-build` then
  `python3 scripts/evidence-squelch/goldens.py --out tests/mocks/fixtures/evidence-squelch` → one
  audio and one stats file per manifest entry; total under 1.2 MB.
- [ ] **Step 4: Check the analyzer verdicts** in the README: for every fixture, the stats JSON's
  medians give the manifest `verdict` (apply `isVoice`/`dataLike` by hand or with a one-off
  `pnpm exec tsx` snippet that is not committed). A fixture whose analyzer verdict disagrees with its
  class is regenerated with adjusted synthesis parameters, not with changed thresholds.
- [ ] **Step 5: Commit** `test(evidence-squelch): fixtures and analyzer goldens` with the scripts,
  README, manifest and goldens.

### Task FX.2: Meter equivalence (after EV.1 merges)

**Files:** Test: `tests/unit/core/evidence-squelch/meter-equivalence.test.ts`

- [ ] **Step 1: Write the test**: for every manifest fixture, feed `<name>.audio.s16le` (as
  `int16 / 32768`) through `new VoiceFrameMeter({ gain: 2 })`; compare medians with the stats JSON
  frames: `|ΔaudioDb| <= 1.5`, `|Δsyllabic| <= 0.1`, `|Δcluster| <= 0.15` and same side of 0.6; the
  verdict (`voice` = `isVoice`, `data-like` = `dataLike`, else `neither`) equals the manifest
  `verdict`. Non-default gain case: the same audio scaled by 1.5 into a meter with `gain: 3` meets
  the same tolerances. AGC and de-emphasis cases: apply a TS reimplementation of a fast AGC and a
  50 µs de-emphasis to the audio, compute verdicts, and `console.info` them in the test output only
  (no assertion; requirement 5.2, 8.4); the AM fixture's AGC verdict and its three medians are printed
  in a line beginning `EVIDENCE-SQUELCH 8.4:` for Main.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/evidence-squelch/meter-equivalence.test.ts`
  → PASS; copy the `8.4` line into the lane report.
- [ ] **Step 3: Commit** `test(evidence-squelch): meter equivalence`.

### Task FX.3: Scratch Compose project and acceptance driver

**Files:** Create: `scripts/evidence-squelch/compose.yaml`, `scripts/evidence-squelch/config.yaml`,
`scripts/evidence-squelch/run_acceptance.py`; update `scripts/evidence-squelch/README.md`.

**Interfaces:** modelled on `scripts/link-burst/` (compose with a unique project `wkevs-<pid>`, an
internal network, `fake:1234` running `scripts/capacity/fake_rtl_tcp.py --file <cu8> --loop`, core
image from `EVIDENCE_SQUELCH_IMAGE` (default `wavekit:latest`, never built or pulled by the script),
API published on an ephemeral loopback port only). CLI:
`run_acceptance.py --rate 2048000|2400000 --engine csdr|rust --fixture <name>|all [--cpu-quota 0.75] --out <dir>`
and `--replay <out>`, `--self-test`. Per fixture it runs `squelchMode: auto` and a `manual` baseline
on the same file and records `/stream` bytes with arrival times, `live-audio:level` and status
samples, transmission events and event-loop p99 from the core metrics.

Verdicts (design, Fake-link acceptance plan): opened or not per manifest `expect`; first played
sample within 20 ms of the over onset (cross-correlation with the demodulated reference); per-over
delay ≤ 1.5 s; byte rate within 0.5 % of nominal per minute; transmission events equal to the manual
run (count; open/close within one 10 ms block); p99 within 2 ms of manual; measured back-chain drain
≤ `CLOSE_GUARD_MS` (else report the measured drain). Exit codes 0 pass, 1 fail, 2 invalid. Every
container, network and volume removed in a `finally`.

- [ ] **Step 1: Write the driver** with `--self-test`, which runs the verdict functions on synthetic
  recorded observations (one passing, one per failure kind) without Docker.
- [ ] **Step 2: Run** `python3 scripts/evidence-squelch/run_acceptance.py --self-test` → `ok`;
  `python3 -m py_compile scripts/evidence-squelch/*.py` → no output. Do not run Docker.
- [ ] **Step 3: Commit** `test(evidence-squelch): fake-link acceptance driver`.

---

## Lane W: wiring

Line numbers below refer to `src/core/live-demodulator.ts` at the batch base.

### Task W.1: Goldens from the frozen code and the default flip

**Files:**
- Test: `tests/unit/core/live-demodulator-evidence-golden.test.ts`,
  `tests/unit/api/live-audio-auto-squelch.test.ts`
- Modify: `src/core/live-demodulator.ts:88-102` (`.default("auto")`),
  `src/api/routes/live-audio.ts:253` (`config.squelchMode ?? "auto"`)

**Interfaces:** Consumes the `createDemodHarness` helper and `ClientTransport` from
`tests/unit/core/live-demodulator-continuity-fakes.ts`.

- [ ] **Step 1: Record goldens on the frozen code** (before any `src/` edit): a harness feeds a
  deterministic PCM script (synthetic voice, silence, FSK; 3 s, chunk sizes cycling 1 / 333 / 4 096 /
  65 536 bytes) out of the fake back stage, with stage 1 scripted open/closed through the fake
  squelch, for each case: `manual` × every modulation; `noise` × `nfm`, `wfm`; tone squelch CTCSS
  67.0 and DCS 023N on `nfm` with `squelchMode` auto and manual; `auto` × `wfm`, `usb`, `lsb`, `dsb`,
  `cw`, `raw`; plus `auto` × `nfm`, `am` for the `pcm` event only. Store SHA-256 of the registry bytes
  (client transport) and of the concatenated `pcm` event bytes inline in the test as a `GOLDENS`
  record, with a header comment naming the base commit.
- [ ] **Step 2: Run** `pnpm exec vitest run tests/unit/core/live-demodulator-evidence-golden.test.ts`
  → PASS on the frozen code. Commit `test(evidence-squelch): frozen live-audio goldens`.
- [ ] **Step 3: Write failing default tests**:
  - Property 14 Default (Validates 3.1, `numRuns: 100` over generated valid configs):
    `LiveDemodRuntimeConfigSchema.parse(cfgWithout squelchMode).squelchMode === "auto"`; an explicit
    value is kept.
  - `tests/unit/api/live-audio-auto-squelch.test.ts`: `GET` config with a core config lacking
    `squelchMode` reports `"auto"` (route fallback), via the existing live-audio route test setup in
    `tests/unit/api/live-audio.test.ts` (in-process Fastify `inject`, no port).
- [ ] **Step 4: Run** → FAIL. **Step 5: Implement** the two one-line changes.
- [ ] **Step 6: Run** the new tests plus
  `pnpm exec vitest run tests/unit/core/live-demod* tests/unit/core/live-demodulator* tests/unit/api/live-audio* tests/unit/core/analog-transmission*`
  → PASS after applying A7 (explicit `squelchMode: "manual"` where a test relied on the old default).
  The golden test stays green (the auto-NFM/AM registry bytes are not pinned by it).
- [ ] **Step 7: Commit separately** `feat(evidence-squelch): auto squelch by default` with the two
  source files, the new tests and any A7 edits. Main merges this commit only after M.3.

### Task W.2: Evidence path against fake ports

**Files:**
- Modify: `src/core/live-demodulator.ts` (`LiveDemodulatorOptions` ~line 186 and
  `InjectedOptionKeys`; core `LiveAudioLevel` line 107; `PipelineRun` line 239; run creation ~line
  1416; `getStatus` line 716; `publishSquelchChange` line 885; `measureRun` line 956; level timer line
  1092; retune ~line 1184; offset swap `gateHeld = true` line 687; `reconfigure` node-only apply
  ~line 597-656; `stop` line 539; `handleAudioData` line 1856; core `LiveDemodStatus` interface
  line 116, next to `toneSquelch?` at line 147),
  `src/api/routes/live-audio.ts` (`liveDemodStatusSchema` lines 93-140, `toApiLiveDemodStatus`
  lines 275-319)
- Test: `tests/unit/core/live-demodulator-evidence.test.ts`,
  `tests/unit/core/live-demodulator-evidence.property.test.ts`,
  `tests/unit/api/live-audio-auto-squelch.test.ts` (extend)

**Interfaces:**
- Consumes: contract (`EvidenceSquelchFactory`, ports, `evidenceGateApplies`,
  `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS`), api-types `LiveAudioAutoSquelch`.
- Produces: `LiveDemodulatorOptions.evidenceSquelch?: EvidenceSquelchFactory` (A5);
  `PipelineRun.evidence: { gate: EvidenceGatePort; preRoll: PreRollPort; tailTag: PreRollTag } | null`
  (built at run start for `nfm`/`am` streams in every squelch mode, with
  `{ rate: run.stream.rate, modulation, gain: config.gain }` and `{ rate, format }`); core
  `LiveAudioLevel.autoSquelch?: LiveAudioAutoSquelch`; core
  `LiveDemodStatus.autoSquelch?: LiveAudioAutoSquelch` (`src/core/live-demodulator.ts:116`, `import type`
  from `@wavekit/api-types`), set by `getStatus` while a run exists; the REST DTO and its response
  schema carry it (see REST status below).

Behaviour (design, Wiring):
- `handleAudioData`: when `run.tone === null`, `run.evidence !== null` and
  `evidenceGateApplies(this.config)`: `emitPcm(chunk)` first; `open = runGateOpen(run) && !run.gateHeld`
  (A4) at chunk arrival; leading bytes completing a held sample get `run.evidence.tailTag`; then
  slices of `max(1, round(rate × TONE_SLICE_MS / 1000)) × width` bytes. Open slice: `k = gate.push(...)`;
  `k >= 0` → `process([start,k), "pending")`, `latch()`, `process([k,end), "pass")`; else tag `pass`
  if `gate.state === "open"` else `pending`. Closed slice: if `gate.state === "waiting"` →
  `preRoll.abandon()`; `g = gate.closed(len, format)`; `process([start,start+g), "guard")`,
  `process([start+g,end), "drop")`. Then `this.audio.write(chunk)` once. Every other case takes the
  frozen path unchanged.
- `publishSquelchChange` on a close edge with the evidence path active and `gate.state === "waiting"`:
  `gate.reset()`, `preRoll.abandon()`.
- `measureRun`: after the floor update, while stage 1 open and the path active,
  `gate.noteBlock(carrier)` with `carrier` = NFM csdr `run.squelch.blockQuieted()`, NFM Rust
  `sample.quieted`, AM `power !== null && run.noiseFloorDbfs !== null && power >= run.noiseFloorDbfs + ANALOG_TRIAL_AM_CARRIER_DB`.
- Lifecycle: `gate.reset()` + `preRoll.clear()` when `evidenceGateApplies` flips either way on
  reconfigure (mode, tone squelch), at offset-swap start, on retune and on stop. The silence fill is
  untouched.
- Status: `autoSquelch` = `{ state: "off" }` when the path is inactive; else
  `{ state: gate.state, ...(gate.evidence !== null ? { evidence: gate.evidence } : {}) }`, a fresh
  object per call; same on the level event.
- REST status (requirement 4.1): `GET /api/live-audio/status` builds its DTO field by field in
  `toApiLiveDemodStatus` and Fastify's serializer drops any property not declared in
  `liveDemodStatusSchema`, so a field set only on the core status never reaches the JSON body.
  (1) In `toApiLiveDemodStatus`, after the `toneSquelch` copy (line 309):
  `...(status.autoSquelch !== undefined ? { autoSquelch: { state: status.autoSquelch.state, ...(status.autoSquelch.evidence !== undefined ? { evidence: status.autoSquelch.evidence } : {}) } } : {})`.
  (2) In `liveDemodStatusSchema.properties`, after `toneSquelch`:
  `autoSquelch: { type: "object", properties: { state: { type: "string", enum: ["off", "waiting", "open"] }, evidence: { type: "string", enum: ["voice", "ctcss", "dcs"] } }, required: ["state"] }`.
  The `live-audio:status` WS event spreads the whole core status, so it needs no change.

- [ ] **Step 1: Write failing tests** with fake ports (scripted `EvidenceGatePort` latching at a
  chosen sample; recording `PreRollPort` that logs `(start, end, tag)` and calls) on
  `createDemodHarness`:
  - `pcm event bytes unchanged and emitted before rewrite` (all modes).
  - `slices and tags`: stage 1 open, gate waiting then latching at sample 12 345 → the recorded calls
    are `pending` up to the latch byte, `latch()`, then `pass`, with slice ends on sample boundaries.
  - `close guard and drop`: latched, stage 1 closes → `guard` for the bytes the fake returns, then
    `drop`.
  - `close before latch abandons and resets`.
  - `noteBlock sources`: csdr NFM uses `blockQuieted()`; Rust NFM uses `sample.quieted`; AM uses the
    floor + 6 dB rule and `false` without a floor; nothing noted while stage 1 is closed.
  - `odd chunk sizes across edges`: chunk sizes 1, 3, 5 bytes s16le and 1-3 bytes f32le across an
    open → latch → close sequence → the tags the fake pre-roll receives, mapped per sample, equal
    those of a single-chunk run.
  - `mode change mid-over clears the queue`: auto→manual, auto + tone squelch set, offset swap,
    retune, stop → `reset()` and `clear()` called once each; manual→auto → no clear, gate starts idle.
  - `pre-roll per NFM or AM run only`: a WFM run calls neither factory method; a modulation change
    NFM→AM builds new instances.
  - `factory failure falls back`: `createGate` throws → warning logged, registry bytes equal the
    frozen auto path.
  - `status and level`: `autoSquelch` `off` for manual NFM, `waiting` then `open`/`voice` for auto
    NFM; `squelchOpen` stays stage 1; absent when no run.
  - `REST status carries autoSquelch` (`tests/unit/api/live-audio-auto-squelch.test.ts`, Validates
    4.1): with the existing in-process Fastify setup from `tests/unit/api/live-audio.test.ts` and a
    stubbed demodulator whose `getStatus()` returns `autoSquelch: { state: "open", evidence: "ctcss" }`,
    `app.inject({ method: "GET", url: "/api/live-audio/status" })` (route at `src/api/routes/live-audio.ts:322`) → the
    parsed JSON body has `autoSquelch` deep-equal to that object; with `{ state: "waiting" }` the body
    has no `evidence` key; with no `autoSquelch` on the core status the body has no `autoSquelch` key.
    Fails before the schema and DTO edits because the serializer drops the field.
  - Property 5 Status at received time, wiring part (Validates 2.7, 4.1, 4.2): for generated stage-1
    schedules and latch points, the `squelchOpen` and `autoSquelch.state` sequence observed per chunk
    is independent of the fake pre-roll's delay.
- [ ] **Step 2: Run**
  `pnpm exec vitest run tests/unit/core/live-demodulator-evidence.test.ts tests/unit/core/live-demodulator-evidence.property.test.ts tests/unit/api/live-audio-auto-squelch.test.ts`
  → FAIL.
- [ ] **Step 3: Implement** per Behaviour.
- [ ] **Step 4: Run** the three files, the golden test (W.1) and
  `pnpm exec vitest run tests/unit/core/live-demod* tests/unit/core/live-demodulator* tests/unit/api/live-audio*` → PASS.
- [ ] **Step 5: Commit** `feat(evidence-squelch): live demodulator evidence path`.

### Task W.3: Integration with the real gate and pre-roll (after EV and PR merge)

**Files:**
- Modify: `src/core/live-demodulator.ts` (default factory),
  `src/api/websocket/events.ts` (doc comment of `broadcastLiveAudioLevel` naming `autoSquelch`; the
  payload already passes `level` through)
- Test: `tests/unit/core/live-demodulator-evidence-e2e.test.ts`,
  `tests/unit/core/live-demodulator-evidence-golden.test.ts` (extend),
  `tests/unit/api/live-audio-auto-squelch.test.ts` (extend)

- [ ] **Step 1: Write failing tests**:
  - End-to-end per class of requirement 8.1 at 25 kHz s16le on csdr fakes (stage 1 scripted open for
    the over, blocks noted as quieted for tone/voice/carrier classes, unquieted for noise): CTCSS +
    voice, DCS + voice, voice, AM voice open within 1.5 s and the client bytes after the waiting
    zeros start with the over's first sample; bare NFM/AM carrier, 4FSK, POCSAG-like FSK, clicks,
    impulse noise, unquieted noise never open and the client receives only zeros.
  - Property 12 Byte-identical elsewhere (Validates 1.6-1.9, `numRuns: 100`): generated PCM and
    configs outside the evidence path → registry and `pcm` SHA-256 equal a frozen-path oracle; the
    W.1 goldens still match.
  - Registry byte count equals delivered byte count for every chunk (Property 7 at the wiring level);
    a WAV client receives the unchanged header once.
  - `live-audio:level` broadcast carries `autoSquelch` (events test through `broadcastLiveAudioLevel`
    with a capturing broadcaster).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the default factory
  `{ createGate: o => new EvidenceGate(o), createPreRoll: o => new PreRoll(o) }` when
  `options.evidenceSquelch` is absent.
- [ ] **Step 4: Run** all W test files and
  `pnpm exec vitest run tests/unit/core/live-demod* tests/unit/core/live-demodulator* tests/unit/api/live-audio* tests/unit/core/analog-transmission* tests/unit/core/evidence-squelch`
  → PASS; `pnpm run typecheck`, `pnpm run lint`.
- [ ] **Step 5: Commit** `feat(evidence-squelch): integrate gate and pre-roll`.

---

## Lane D: documentation

### Task D.1: API and config comments

**Files:** Modify: `docs/API.md` (live-audio config section ~lines 1351-1440, status fields ~1399,
`live-audio:level` ~5750, the second config example ~5837-5860), `config/default.yaml:310` (comments
only).

- [ ] **Step 1:** Document: `auto` is the default; on NFM and AM it is two-stage (stage 1 floor +
  `autoMarginDb` delimits transmissions; stage 2 passes audio on voice, or NFM CTCSS/DCS, after
  ≥ 750 ms); the stream runs up to 1.5 s behind during an over and catches up by dropping the silence
  after it; `squelchOpen` is still stage 1; `autoSquelch` `{ state, evidence? }` on status and
  `live-audio:level`; overs under about one second with no tone are not heard; `manual`/`noise` keep
  "any carrier"; a configured tone squelch is unchanged; other modulations unchanged. Update both
  examples (`"squelchMode": "auto"`, add `"autoSquelch": { "state": "waiting" }`).
- [ ] **Step 2: Verify** `git diff --check -- docs/API.md config/default.yaml` → no output; every relative link added resolves (`ls` each target).
- [ ] **Step 3: Commit** `docs(evidence-squelch): API and config comments` -- `docs/API.md config/default.yaml`.

### Task D.2: ROADMAP and coordination (after W.3)

**Files:** Modify: `docs/ROADMAP.md`, `docs/CLI-COORDINATION.md` (append by hand, never Prettier).

- [ ] **Step 1:** `rg -n "squelchMode|squelchOpen|autoMarginDb" cli/source` and record every hit and
  whether it assumes a `manual` default.
- [ ] **Step 2:** Append `### Evidence auto squelch — 2026-10-23` (same style as the link-burst note):
  auto semantics, default flip, optional `autoSquelch`, `squelchOpen` unchanged, `autoMarginDb` tunes
  stage 1, stream delay up to 1.5 s, the CLI hits from Step 1.
- [ ] **Step 3:** ROADMAP: update the live-audio squelch item and add a Landed paragraph.
- [ ] **Step 4: Verify** `git diff --stat docs/CLI-COORDINATION.md` shows only appended lines;
  `git diff --check -- docs/ROADMAP.md` → no output.
- [ ] **Step 5: Commit** `docs(evidence-squelch): roadmap and coordination note` -- both paths.

---

## Main: merge, acceptance, checkpoint

### Task M.1: Merge order and full suite

- [ ] Merge into `batch/evidence-squelch` in order EV, PR (PR.1-PR.2), FX.1, D.1, W.1 golden commit,
  W.2, then W.3, FX.2, PR.3. Hold W.1's default-flip commit until M.3.
- [ ] After W.3: `pnpm run build && pnpm run typecheck && pnpm run lint && pnpm test` → all green;
  record base/head.

### Task M.2: Fake-link acceptance (early, right after W.3)

- [ ] Build the core image from the batch worktree (never the shared checkout); generate CU8 with
  `fixtures.py --format cu8` at 2.048 and 2.4 Msps; run
  `python3 scripts/evidence-squelch/run_acceptance.py --rate <r> --engine <csdr|rust> --fixture all --out output/evidence-squelch/<r>-<engine>`
  for both rates and engines, plus `--cpu-quota 0.75`.
- [ ] Record verdicts, the PR.3 bench table and the measured back-chain drain in
  `docs/engineering/EVIDENCE-SQUELCH-2026-10-ACCEPTANCE.md`; if drain > 200 ms, amend
  `LIVE_AUDIO_AUTO_SQUELCH_CLOSE_GUARD_MS` in the contract and the design table. Remove scratch
  images and output per disk hygiene.

### Task M.3: Checkpoint 8.4 (before the default flip merges)

- [ ] From FX.2's `EVIDENCE-SQUELCH 8.4:` line and the M.2 AM run: keep AM evidence-gated, set a
  measured AM threshold (amend requirements), or set `LIVE_AUDIO_AUTO_SQUELCH_MODULATIONS = ["nfm"]`
  (A8). Record the decision as an amendment in `docs/specs/evidence-squelch/requirements.md`, then
  merge W.1's flip commit and D.2.

### Task M.4: Live acceptance with the user (design, Live acceptance plan)

- [ ] Steps 1-6 of the design's live plan on the default csdr engine; append the record to the
  acceptance document; failures become amendments.

### Task M.5: Pi 4-class measurement (when a host exists)

- [ ] CPU and event-loop p99 at 2.048 and 2.4 Msps; until then the Pi 4-class column stays an
  estimate.

## Self-review notes

- Coverage: 1.1-1.5 EV.3 + W.2; 1.6-1.9 W.1/W.3 (Property 12); 1.10 W.2 noteBlock both engines;
  1.11 W.2 lifecycle; 2.1-2.6, 2.8, 2.9 PR.1/PR.2 + W.2; 2.7 Property 5; 3.1 W.1; 3.2 no change;
  4.1-4.3 0.1 + W.2 (REST DTO + schema + inject test)/W.3 (level event); 5.1-5.2 FX.2; 6.1 PR.2 + PR.3 + M.2; 6.2 PR.3; 7.1-7.2 D.1/D.2; 8.1 W.3 +
  EV.3; 8.2 FX.3 + M.2; 8.3 M.4; 8.4 FX.2 + M.3.
- Properties 1-14 each have one owning task (5 and 6 split as in tasks.md).
