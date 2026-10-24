# Auto listen route design

Status: design, not implemented (2026-10-24). See [requirements](requirements.md) and
[tasks](tasks.md).

## Overview

A new `AutoListenRouter` (`src/core/auto-listen/`) owns one `AudioClientRegistry` for `/auto`.
It is created by the live demodulator and served by the live demodulator's existing
`AudioHttpServer` (one more branch in `resolveRoute`). Two kinds of input feed it while `/auto`
has a client:

- **Analog tap**: in `handleAudioData`, after the squelch, tone gate or evidence pre-roll has
  rewritten the chunk and just before `this.audio.write(chunk)`, the live demodulator calls
  `router.pushAnalog(chunk, start, end, audible)` once per sample-aligned span with one
  qualification state. The bytes are exactly what `/stream` clients hear.
- **Voice tap**: the digital voice service calls a registered tap from `ingest()` with each
  downmixed, encryption-muted 8 kHz mono datagram, and notifies it of every call change and
  decoder detach.

Each input is resampled straight into its own preallocated 48 kHz Int16 FIFO. A 20 ms
monotonic pacer selects one source per block by the switching rules and writes the block to the
registry. Nothing is mixed; every sample leaves a FIFO at most once.

```
csdr / rust pcm ──► LiveDemodulator.handleAudioData ──► /stream registry (unchanged)
                                   │ (client bytes + audible)
                                   ▼
                          AnalogInput: resampler ─► FIFO(48k, 3 s, audible runs)
dsd-fme UDP ─► DigitalVoiceService.ingest ─► paced /stream (unchanged)
                                   │ (mono 8k + call)
                                   ▼
                    VoiceInput[decoderId]: resampler ─► FIFO(48k, 3 s)
                                   │
              AutoListenRouter pacer (20 ms, 960 samples) ─► /auto registry
```

## Options weighed

### A. Transport

- HTTP route on the live-audio server (chosen). The web player (`pcm-player.ts`) already plays
  `fetch` PCM streams with `X-Audio-Format` / `X-Sample-Rate` and `credentials: "include"` on a
  protected core, and the WAV fallback; `/auto` drops in as one more `AudioStreamSource`. It
  reuses the access adapter, leases, CORS and stall handling unchanged (1.2).
- WebSocket binary audio (rejected for now). CORE-GAPS words the ask as a WebSocket, but the web
  code consumes HTTP streams only; a WS transport would need a second access path, its own
  backpressure and a player change. It can be added later over the same router registry.
- A route on the digital voice server (rejected): the analog pipeline and its status live in
  the live demodulator, and the web derives the analog URL from live-audio status.

### B. Output format

48 000 Hz s16le mono (chosen). CORE-GAPS asks for "a clean 48 kHz"; browsers run their
`AudioContext` at 48 kHz on most hardware, so the player's `makeContext(48000)` avoids worklet
resampling; 48 000 is an integer multiple of 8 000 (decoded voice, ratio 6) and the
fixed rate is what lets clients survive rate changes (1.4). s16le halves bandwidth against
f32le (96 kB/s per client) and matches the digital voice stream. The alternative of the analog
rate (about 25 kHz) would force a re-negotiation on every rate change and still need 8 k → 25 k
for voice. Cost is in the budget table: the polyphase kernel sized by requirement 2.3 stays
under about 0.015 core on the desktop host even at 200 kHz input.

### C. Where analog qualification is measured

- From the live demodulator's governing squelch at the client write (chosen, 3.1). It reuses the
  decision listeners already hear, needs no edit of `src/core/evidence-squelch/**`, and keeps
  `/auto` analog byte-equal (after resampling) to `/stream`.
- Re-running an evidence gate inside the router (rejected): duplicate CPU and a second opinion
  that could disagree with `/stream`.

Decision for the non-auto modes: with `manual` or `noise` squelch, analog qualifies while the
squelch gate is open, the operator's own definition of "a signal is there". The trade-off is that
a manual threshold left wide open keeps analog qualifying forever; 4.5 bounds how long that
delays digital (1.5 s) and digital wins after it.

### D. Alignment of analog pre-roll and digital latency

The evidence pre-roll delays an analog over by up to 1.5 s and catches up after it; dsd-fme
voice arrives in bursts with its own decode delay. Instead of predicting latencies, each source
keeps its own FIFO of audible samples and the handover waits for the outgoing source to release
(4.4) while the incoming source queues from its first sample (4.3). The backlog this creates is
removed only from inaudible stretches (4.7), the same rule the pre-roll uses, so overs are never
compressed or clipped. Bounded preemption (4.5) and the 3 s FIFO cap bound the worst case.

## Components

### Contract (`src/core/auto-listen/contract.ts`, constants in `packages/api-types`)

Constants in `packages/api-types/src/live-audio.ts` (exported, pinned by a contract test):

| Constant                                   | Value     | Note                                       |
| ------------------------------------------ | --------- | ------------------------------------------ |
| `LIVE_AUDIO_AUTO_ROUTE_RATE`               | 48 000    | Hz                                         |
| `LIVE_AUDIO_AUTO_ROUTE_FORMAT`             | `"s16le"` |                                            |
| `LIVE_AUDIO_AUTO_ROUTE_BLOCK_MS`           | 20        | 960 samples                                |
| `LIVE_AUDIO_AUTO_ROUTE_FIFO_MS`            | 3 000     | per source                                 |
| `LIVE_AUDIO_AUTO_ROUTE_DIGITAL_HOLD_MS`    | 300       | 3.2                                        |
| `LIVE_AUDIO_AUTO_ROUTE_DIGITAL_START_MS`   | 200       | 4.6                                        |
| `LIVE_AUDIO_AUTO_ROUTE_ANALOG_RELEASE_MS`  | 300       | 4.4                                        |
| `LIVE_AUDIO_AUTO_ROUTE_DIGITAL_RELEASE_MS` | 300       | 4.4                                        |
| `LIVE_AUDIO_AUTO_ROUTE_PREEMPT_MAX_MS`     | 1 500     | = `LIVE_AUDIO_AUTO_SQUELCH_PREROLL_MAX_MS` |
| `LIVE_AUDIO_AUTO_ROUTE_TARGET_MS`          | 60        | 4.7                                        |
| `LIVE_AUDIO_AUTO_ROUTE_CATCHUP_MAX_BLOCKS` | 5         | 2.7, 100 ms per tick                       |

DTOs:

```ts
export type LiveAudioAutoRouteSource = "analog" | "digital" | "none"
export interface LiveAudioAutoRoute {
	active: LiveAudioAutoRouteSource
	protocol?: string
	decoderId?: string
	slot?: number | null
	since: string
	httpUrl: string
	wavUrl: string
	clientCount: number
	digitalAvailable: boolean
	underruns: number
	droppedMs: number
	clockRebases: number
	latencyMs: number
}
export interface LiveAudioAutoRouteLevel {
	active: LiveAudioAutoRouteSource
	protocol?: string
}
// LiveDemodStatus.autoRoute?: LiveAudioAutoRoute; LiveAudioLevel.autoRoute?: LiveAudioAutoRouteLevel
```

Ports in `contract.ts`:

```ts
export interface VoiceTapCall {
	callId: string
	active: boolean
	encrypted: boolean
	protocol: string | null
	slot: number | null
}
export interface VoiceTap {
	/** 8 kHz s16le mono after encryption muting; the buffer is only valid during the call. */
	frame(decoderId: string, pcm: Buffer, call: VoiceTapCall | null): void
	/** Every validated voice-call event, in the tick it is handled (start, update, end). */
	call(decoderId: string, call: VoiceTapCall): void
	/** The decoder's voice channel was removed or the service stopped. */
	detach(decoderId: string): void
}
export interface VoiceTapSource {
	addVoiceTap(tap: VoiceTap): () => void
	readonly voiceSampleRate: number
}
/** "unknown" is treated exactly like "no". */
export type VoiceCoverage = "yes" | "no" | "unknown"
export interface VoiceCoveragePort {
	/** Called only when `generation` changed since the caller's cached answer. */
	covers(decoderId: string): VoiceCoverage
	/** Incremented at every event that can change coverage (retune, settle, placement). */
	readonly generation: number
}
export interface AutoRouteClock {
	now(): number
	setInterval(fn: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}
```

### PolyphaseResampler (`src/core/auto-listen/resampler.ts`)

Arbitrary-ratio windowed-sinc resampler (textbook polyphase interpolation, Smith's bandlimited
interpolation), Kaiser window. The filter is sized from requirement 2.3, not fixed:

- Let `m = min(in, out)`. The prototype passes `0.4 m`, stops at `0.5 m`, so the transition is
  `0.1 m`, normalised to the input rate `Δω = 2π × 0.1 m / in`.
- Attenuation `A = 55 dB` (5 dB margin over the 50 dB requirement): Kaiser `β = 0.1102 (A − 8.7)
≈ 5.10`, length in input samples `N ≈ (A − 8) / (2.285 Δω)`, rounded up to even. Passband ripple
  at 55 dB is about ±0.015 dB, inside ±0.5 dB.
- Cutoff `0.45 m` (the transition centre), unity DC gain per phase.

| Input rate                                | Ratio     | `N` (input taps per output sample) |
| ----------------------------------------- | --------- | ---------------------------------- |
| 8 000 (voice)                             | up 6      | 34                                 |
| 25 000 / 25 600 (NFM at 2.4 / 2.048 Msps) | up        | 34                                 |
| 48 000                                    | 1         | 34                                 |
| 96 000                                    | down 2    | 66                                 |
| 200 000 (WFM ceiling)                     | down 4.17 | 138                                |

Phases: when the reduced ratio `out / in = L / M` has `L ≤ 512`, the table holds exactly `L`
phases and the phase step lands on table points (8 k → 48 k: `L = 6`; 25 k → 48 k: `L = 48`;
25.6 k → 48 k: `L = 15`), so no interpolation is used. Otherwise (rates with a large reduced
`L`) the table holds 512 phases and adjacent phases are linearly interpolated; the
interpolation error is bounded by `(π × 0.5 / 512)² / 8 ≈ 1.2 × 10⁻⁶` (about −118 dB), far
below the stopband. The phase accumulator is the integer pair (`k mod L`, input index), so long
runs never drift. Tables (`Float64Array(phases × N)`, Float64 so the dot product needs no float32 conversion; at most 513 × 138 × 8 B ≈ 566 kB) and an
`N`-sample history ring are allocated in the constructor only, and only when the rate changes.

```ts
class PolyphaseResampler {
	constructor(inRate: number, outRate: number)
	/** Reads input samples from a typed view and writes into out[outStart..outEnd). */
	process(
		input: Int16Array | Float32Array,
		inStart: number,
		inEnd: number,
		out: Int16Array,
		outStart: number,
		outEnd: number,
	): void
	readonly consumed: number // set by the last process call
	readonly produced: number
	/** Input samples whose effect has not yet reached the output (group delay). */
	readonly delayInputSamples: number
	reset(): void
}
```

Qualification flags travel with the resampled stream: an input sample's flag applies to the
output samples whose filter centre falls on it, so flag transitions move by the filter's group
delay exactly as the audio does (`SourceFifo` stores flags per output run).

### SourceFifo (`src/core/auto-listen/source-fifo.ts`)

A 48 kHz Int16 ring of `FIFO_MS` plus a run ring (flag, length) like the pre-roll's run model.
Each sample carries one flag: `audible`, `admitted` (digital: received while the source was
admitted, 3.2) or `silent`. Operations: `writeFrom(resampler, view, start, end, flag)`
(resample directly into ring space, wrapping in two calls), `read(out, offset, n)` (zeros past
the end), `discardSilentHead(maxSamples)`, `discardUntilAudible()`, `clear()`,
`oldestQueuedAt`, `queuedSamples`, `queuedAudibleSamples`, `overflowDroppedSamples`. Overflow
drops the oldest samples and counts them.

### Analog qualification at sample resolution (`src/core/auto-listen/preroll-shadow.ts`)

The `/stream` bytes are already decided per slice by the live demodulator: the tone path mutes
per `TONE_SLICE_MS` slice (`handleAudioData`), and the evidence path tags spans of at most
`TONE_SLICE_MS` before the pre-roll rewrites them (`processEvidence` / `evidenceSpan`), so one
flag per chunk cannot describe a chunk that spans an open or a close. The live demodulator
therefore pushes one span per decision, sample-aligned, after the chunk is rewritten:

- **Manual, noise, auto outside the evidence path:** one span per chunk, flag
  `runGateOpen(run)`, the same per-chunk decision `/stream` already applies (the squelch state
  is sampled at chunk arrival there too).
- **Tone squelch:** one span per slice of the existing slice loop, flag `!muted` of that slice;
  the closed-gate branch is one silent span.
- **Evidence path:** the output of the pre-roll is delayed, so the input tags do not describe
  the output samples. `PreRollShadow` replays the pre-roll's documented run model (design of
  [evidence-squelch](../evidence-squelch/design.md), PreRoll: one output byte per input byte,
  `pending` / `pass` / `guard` / `drop` codes, `latch` retags pending to play, `abandon` retags
  pending to drop, catch-up removes a leading drop run, overflow only while all pending) on tag
  runs only, no audio: the live demodulator calls `shadow.process(n, tag)`, `shadow.latch()`,
  `shadow.abandon()` and `shadow.clear()` next to each call on the real pre-roll. The shadow
  returns the output runs of that call (`play` or `mute`), which become spans: a sample
  qualifies only when the pre-roll plays it, so delayed but unqualified audio
  (`delaySamples > 0` while pending) never qualifies.
- **Continuous tracking.** The shadow is created, cleared and dropped together with the run's
  pre-roll (`buildEvidence`, `resetEvidence`) and tracks every pre-roll call whether or not
  `/auto` has a client, so a first connect or a reconnect at any moment (pending, playback,
  final drain) finds it already in sync; there is no mid-stream start. Its idle cost is tag
  bookkeeping only: at most two `process` calls per `TONE_SLICE_MS` slice, each an O(1) run
  append plus a head trim on a fixed `Int32Array` run ring (the pre-roll's 160-run bound), no
  audio copy and no allocation, under 0.0005 core (budget table). Output runs are only turned
  into router spans while `/auto` has a client.
- **Self-check and resync.** After each `process` the live demodulator compares
  `shadow.delaySamples` with `preRoll.delaySamples`. On a mismatch (a defect, never expected)
  it logs once and marks the analog source silent (fail closed). Resync is concrete: at the
  first `process` after which `preRoll.delaySamples === 0`, the real pre-roll holds no sample,
  so the shadow is cleared to the empty state, which is then exact, and analog qualification
  resumes. A delay of zero is reached in every silence after catch-up, so a mismatch costs at
  most the rest of the current over. `/stream` is never touched by the shadow.
- Split-sample lead bytes take the previous span's flag, as the pre-roll and tone path do.

No file under `src/core/evidence-squelch/**` changes; the shadow imports only its contract
types. An equivalence property test runs the real `PreRoll` with a ramp input and checks that
the shadow's `play` samples are exactly the non-zero output samples.

### Inputs (`src/core/auto-listen/inputs.ts`)

- `AnalogInput`: carries a 4-byte split-sample remainder (as `pcmPhase`) and copies each span's
  aligned bytes with `chunk.copy(scratch, ...)` into a preallocated scratch `Buffer` (sized for
  the largest chunk seen, grown only on a new maximum) read through `Int16Array` /
  `Float32Array` views created once over that scratch, so no view or buffer object is created
  per chunk. It rebuilds its resampler and views on rate or format change (5.2).
- `VoiceInput` per decoder: the same scratch-copy path (8 k s16le), resampler 8 k → 48 k,
  `lastFrameAt`, `call` snapshot, `admitted` (3.2 evaluated per frame and per call event),
  cached coverage (below).

### Digital resampler tail (requirement 4.11)

The resampler's history holds up to `N − 1` input samples (33 at 8 kHz, about 4 ms) whose
contribution to the output is not yet complete, so the last syllable of a call would never
appear when no further datagram arrives. A voice input **flushes** when its call ends (`call`
with `active: false`) or when it has admitted no frame for `DIGITAL_HOLD_MS`, whichever comes
first: it feeds `N − 1` zero samples from a preallocated zero scratch (the full remaining filter
support, so every real sample's response is complete), writes all produced output with the flag
of the last real input sample (`admitted` if the last frame was admitted), then `reset()`s the
resampler so the next samples start from an empty history. The flush is armed whenever real
samples enter the resampler and disarmed by a flush or reset; a duplicate flush is suppressed
only while the history is empty. So a hold-expiry flush in the middle of a call, later frames of
the same call, then the call end give two flushes, each completing the samples before it. `detach` and
invalidation do not flush: they clear the FIFO and reset the resampler. Analog needs no flush:
its stream is continuous (muted audio arrives as zeros) and `resetAnalog` discards on purpose.

### Digital admission versus drain (requirements 3.2, 4.3, 4.10)

Admission and eligibility to play are separate:

- **Admission** is decided per datagram: a frame is written as `admitted` only while the
  decoder covers the channel (cached `"yes"` at the current generation), its call is active and not wholly
  encrypted. Other frames are written as `silent` (or not written at all when the source is not
  selected).
- **Drain eligibility** does not require the call to still be active: a voice input with queued
  `admitted` samples stays eligible until they are played or invalidated, even after the call
  ended and the hold expired. So a 0.5 s DMR over that starts and ends entirely while the
  analog tail drains is queued, then plays in full once analog releases.
- **Invalidation** clears a voice FIFO: an encrypted update of its call (`call` with
  `encrypted: true`, even with no further datagram), `detach`, a coverage generation change, coverage
  turning `"no"` or `"unknown"`, or queued audio older than `FIFO_MS` (it is dropped and counted;
  it can no longer be in time). A cleared selected source plays zeros from the next sample and
  releases at once.
- **Release** (4.4) for digital: no admitted sample queued and not admitted for
  `DIGITAL_RELEASE_MS`.

### Coverage (requirement 3.4) and the MAIN-NEEDED seam (`src/index.ts`)

The router needs the digital voice service and decoder coverage, both built in `src/index.ts`.
Without this diff `/auto` works analog-only (`digitalAvailable: false`).

Coverage is `"yes"` only when the tuned frequency is verified and agrees:

- The **live** frequency (`vfoFromLiveDemod` over the live demodulator's current source, offset
  and the source centre) and the **settled** VFO (`vfo.current()`) must be equal. While a retune
  is pending they differ and coverage is `"unknown"`.
- A running placement covers only when its `sourceId` equals the live source and its
  `channelHz` is present and within half the channel bandwidth of the live frequency, whatever
  its origin (a `vfo` placement that has not moved yet does not cover).
- Without placements, a configured target covers only when the decoder's `sourceId` is present
  and equals the live source, and the target is within half the bandwidth.
- Anything missing or throwing is `"unknown"`.

**Generation, not sampling.** `generation` is a counter incremented at each event that can
change coverage, not derived from a sampled frequency, so A → B → A between two pacer ticks, or
an offset and centre change that keep the sum, still invalidates. It increments on: live-audio
`config-changed` (offset, source, bandwidth, modulation), source `caps-changed` (centre, rate),
every VFO settle (`onSettled`), and decoder `decoder:started`, `decoder:stopped`,
`decoder:removed` and `decoder:status-changed` (placement moves). The router compares each voice
input's stored generation once per block and per frame; any difference clears the input's queued
audio and cached coverage. In the window between a real retune and its first event, frames are
still admitted under the old coverage; the retune's `config-changed` or `caps-changed` then
invalidates them before they can play unless they were already played.

**Cached, allocation-free in steady state.** `covers()` builds status and VFO objects (Zod
parse in `vfoFromLiveDemod`, `getStatus` objects), so the router calls it only when an input's
cached generation differs from the port's, at most once per input per generation, and otherwise
reads the cached answer. Recompute cost is bounded by the event rate (retunes, decoder status
changes, a few per second at most), not by blocks or frames; the bench measures it.

Insert after `liveDemod.on("config-changed", updateVfo)` (the diff is indented with spaces
here; apply it with the file's tabs), and extend the VFO tracker's `onSettled` above it:

```diff
   onSettled: value => {
     decoderManager.notifyVfoSettled(value)
+    coverageGeneration++
   },
 ...
 liveDemod.on("config-changed", updateVfo)
 sourceManager.on("caps-changed", updateVfo)
+// auto-listen-route 3.4: coverage only on a verified, settled frequency that matches.
+const bumpCoverage = () => {
+  coverageGeneration++
+}
+liveDemod.on("config-changed", bumpCoverage)
+sourceManager.on("caps-changed", bumpCoverage)
+for (const event of [
+  "decoder:started",
+  "decoder:stopped",
+  "decoder:removed",
+  "decoder:status-changed",
+] as const)
+  decoderManager.on(event, bumpCoverage)
+const liveVfo = () =>
+  vfoFromLiveDemod({
+    sourceId: () =>
+      liveDemod.getStatus().sourceId || defaultSourceIdFor(config.sources) || null,
+    offsetHz: () => liveDemod.getStatus().config.offsetHz,
+    centreHz: id => sourceManager.getCaps(id)?.centerFreq ?? null,
+  })
+liveDemod.attachAutoRouteVoice(digitalVoice, {
+  get generation() {
+    return coverageGeneration
+  },
+  covers: decoderId => {
+    try {
+      const live = liveVfo()
+      const settled = vfo.current()
+      const status = decoderManager.getStatus(decoderId)
+      if (!live || !settled || !status) return "unknown"
+      if (
+        settled.sourceId !== live.sourceId ||
+        settled.frequencyHz !== live.frequencyHz
+      )
+        return "unknown"
+      if (!status.running) return "no"
+      const half = liveDemod.getStatus().config.bandwidth / 2
+      const near = (hz: number | undefined) =>
+        hz !== undefined && Math.abs(hz - live.frequencyHz) <= half
+      const placements = status.placements ?? []
+      if (placements.length > 0)
+        return placements.some(
+          p => p.running && p.sourceId === live.sourceId && near(p.channelHz),
+        )
+          ? "yes"
+          : "no"
+      if (status.sourceId === undefined) return "unknown"
+      if (status.sourceId !== live.sourceId) return "no"
+      return (status.targetFrequenciesHz ?? []).some(hz => near(hz)) ? "yes" : "no"
+    } catch {
+      return "unknown"
+    }
+  },
+})
```

`let coverageGeneration = 0` is declared before `createVfoTracker`. A pending VFO settle answers
`"unknown"`, and the settle itself bumps the generation, so coverage is recomputed right after
it.

### Pacing, backlog and discontinuities (requirements 2.6, 2.7)

The pacer targets `due = floor((now − start) × 48 000 / 1 000)` samples. Each tick emits
`min(due − emitted, CATCHUP_MAX_BLOCKS × 960)` samples in whole 960-sample blocks:

- **Normal jitter** (a tick late by up to 100 ms) is caught up in the same tick; the long-run
  rate is exact.
- **Stall** (event loop blocked for more than 100 ms beyond the last tick): after emitting the
  capped amount, the clock is **rebased**: `start` moves forward so that `due − emitted = 0`,
  `clockRebases` counts it. The output then has a timing discontinuity (the client's own buffer
  underruns), but no source sample is dropped or repeated: the FIFOs keep their audio, so the
  backlog grows by the stall and is reduced by catch-up (4.7) in the next silence.
- **Backlog bound**: each source FIFO is capped at `FIFO_MS` (overflow drops oldest, counted),
  so `latencyMs` never exceeds `FIFO_MS + BLOCK_MS`.
- A monotonic clock step backwards (not expected from `performance.now()`) emits nothing until
  `due` passes `emitted`.

### AutoListenRouter (`src/core/auto-listen/router.ts`)

```ts
class AutoListenRouter extends EventEmitter {
	constructor(log: Logger, options: { clock?: AutoRouteClock })
	readonly registry: AudioClientRegistry
	get wanted(): boolean // registry.size > 0
	pushAnalog(
		chunk: Buffer,
		start: number,
		end: number,
		audible: boolean,
		stream: StreamFormat,
	): void
	resetAnalog(): void
	attachVoice(source: VoiceTapSource, coverage: VoiceCoveragePort): void
	detachVoice(): void
	status(urls: { httpUrl: string; wavUrl: string }): LiveAudioAutoRoute
	level(): LiveAudioAutoRouteLevel
	destroy(): void
	// emits "auto-route-changed" once per switch (6.4)
}
```

Per block:

1. Refresh state: analog release timer from its last audible span; per voice input, the
   coverage generation (a change invalidates and recomputes `covers`; anything but `"yes"`
   invalidates) and the tail flush (4.11).
2. Choose: if the selected source has not released (4.4), keep it, unless it is analog and a
   drain-eligible digital input has waited `PREEMPT_MAX_MS` (4.5). Otherwise pick a
   drain-eligible digital input (sticky first, else oldest queued admitted voice, ties by id)
   whose start buffer is met (4.6); else analog if it has queued audible samples; else `none`.
3. Non-selected sources: `discardUntilAudible()` (silent audio is never kept; audible and
   admitted audio waits).
4. Selected source: `discardSilentHead(backlog − TARGET)` while its head is silent (4.7), then
   `read` 960 samples into the next output block; empty → zeros and an underrun.
5. Write the block (buffer ownership below).

When `registry.size` drops to 0 the pacer stops, the taps are disabled and all FIFOs clear
(7.1); when it rises from 0 the pacer starts from zero emitted samples.

### Output buffer ownership (requirement 2.8)

`AudioClientRegistry.write()` does not copy: `align()` returns the caller's buffer (or a
subarray of it) and `enqueue()` pushes that reference onto each client's queue; `flush()` then
hands it to `response.write()`, and a socket that is not draining keeps the reference until it
drains or the client is closed (stall timeout 30 s). So a reused output block could be
overwritten while still queued, and the retention time is bounded only by the stall timeout,
not by the per-client queue limit (about one second of audio).

Decision: **one fresh block per 20 ms output block**, `Buffer.allocUnsafe(1 920)`, never
mutated after `registry.write`. A pool sized to the queue limit is not safe because socket
retention outlives the queue bound. Arithmetic: 50 allocations per second of 1 920 B each,
96 kB/s, served from Node's 8 kB pre-allocated slab (sizes under 4 kB), so about 12 slab
allocations per second; at most `30 s × 96 kB/s ≈ 2.9 MB` can be retained per stalled client
before it is disconnected. This is an output-side cost per output block, independent of input
chunking, and equals what `/stream` already pays when its pipeline hands each chunk to the
registry.

**Allocation guarantee, narrowed (requirement 2.4).** Allocation-free in steady state: the
router's own per-chunk, per-datagram and per-block paths (scratch copy, resampling, FIFO writes
and reads, shadow runs, selection, cached coverage reads). Bounded exceptions, with arithmetic:

| Allocation                                                                                                                                                  | Rate                                                                  | Bytes per second                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------- |
| Output block (above)                                                                                                                                        | 50/s                                                                  | 96 000                                 |
| Existing `downmixDsdFmeDatagram` copy per datagram (`Buffer.from` / `Buffer.alloc`, not new; the service already pays it while its own stream has a client) | about 50/s per decoder in a call, now also while only `/auto` listens | about 16 000 per decoder (8 kHz × 2 B) |
| Coverage recompute (`getStatus`, `vfoFromLiveDemod` Zod parse)                                                                                              | once per input per generation change, a few per second at most        | under 10 000                           |
| `status()` / `level()` objects                                                                                                                              | per REST poll and per level event (10 to 20/s)                        | under 4 000                            |
| Scratch growth on a new largest chunk                                                                                                                       | rare, then never                                                      | 0 in steady state                      |

All are small objects or short buffers from Node's slab; none is audio-sized storage that
grows with run time. The downmix copy stays as is because changing it alters the digital voice
module beyond the minimal tap. A delayed-drain regression test holds a fake
client's socket write pending for several seconds, keeps the router emitting distinct ramps, then
drains and checks every queued block still holds its original bytes.

### Live demodulator wiring (`src/core/live-demodulator.ts`, minimal)

- Construct `this.autoRoute = new AutoListenRouter(this.log, {...})` in the constructor.
- `resolveRoute`: `base === "/auto"` → `{ registry: this.autoRoute.registry, stream:
AUTO_ROUTE_STREAM, wav }`.
- `handleAudioData`: when `this.autoRoute.wanted`, push spans as in "Analog qualification at
  sample resolution", immediately before each `this.audio.write(chunk)`; the evidence path also
  drives the `PreRollShadow` next to each `preRoll` call in `processEvidence` / `evidenceSpan`
  and the abandon / clear sites (`resetEvidence`, the discard note).
- Silence fill (`this.silence`) chunks are not pushed.
- On retune, offset swap, modulation change, stop: `this.autoRoute.resetAnalog()` next to the
  existing `resetEvidence` calls.
- `getStatus()`: `status.autoRoute = this.autoRoute.status(urls)` while the HTTP server listens;
  URLs built exactly as `httpUrl` with `/auto` and `/auto.wav`.
- Level: `level.autoRoute = this.autoRoute.level()` while `wanted`.
- New public `attachAutoRouteVoice(source, coverage)` delegating to the router; new event
  `auto-route-changed`.

### Digital voice wiring (`src/core/digital-voice.ts`, minimal)

- `private readonly voiceTaps = new Set<VoiceTap>()`; `addVoiceTap(tap)` returns a remover;
  `get voiceSampleRate()` returns `STREAM.rate`.
- `ingest()`: the early return becomes `if (!this.running || (!channel.paced.running &&
this.voiceTaps.size === 0)) return`; the whole-datagram encrypted drop stays before the taps;
  after the downmix, taps get `frame(decoderId, mono, snapshot)`; `channel.paced.push(mono)` only
  when `channel.paced.running`, so the service's own stream and counters are unchanged (7.2).
- `handleVoiceCall()`: after updating `channel.call`, taps get `call(decoderId, snapshot)` for
  every validated event (start, update including an encrypted flip, end).
- `removeChannel()` and `stop()` / `destroy()`: taps get `detach(decoderId)` per channel.
- A tap that throws is caught and logged once. No change to pacing, encryption rules, routes or
  status.

### REST status (`src/api/routes/live-audio.ts`)

Add `autoRoute` to `liveDemodStatusSchema` (all fields above, `slot` nullable) and carry it in
`toApiLiveDemodStatus`, including the legacy URL rewrite applied to `httpUrl`/`wavUrl`.

## Budgets (performance rule 3)

The router runs once regardless of client count. MAC = multiply-add; JavaScript typed-array
inner loops are taken at about 1 ns per MAC on the desktop reference host and 5 ns on a Pi
4-class core. Analog NFM at 2.048 Msps is about 25.6 kHz and at 2.4 Msps 25 kHz, both on the
34-tap exact-phase path, so the IQ rate barely changes cost.

| Stage                                      | Work                                | Desktop core | Pi 4-class core (estimate) |
| ------------------------------------------ | ----------------------------------- | ------------ | -------------------------- |
| Analog NFM resample (2.048 / 2.4 Msps)     | 48 000 × 34 MAC/s                   | ≤ 0.002      | ≤ 0.01                     |
| Analog worst case, 200 kHz input           | 48 000 × 138 × 2 MAC/s (interp)     | ≤ 0.014      | ≤ 0.07                     |
| Voice resample 8 k → 48 k, per decoder     | 48 000 × 34 MAC/s, during calls     | ≤ 0.002      | ≤ 0.01                     |
| Voice ingest without a voice client        | existing downmix, only with `/auto` | ≤ 0.002      | ≤ 0.005                    |
| Pre-roll shadow                            | run bookkeeping per span            | ≤ 0.001      | ≤ 0.002                    |
| Pacer, selection, FIFO copy, block alloc   | 50 blocks/s                         | ≤ 0.002      | ≤ 0.005                    |
| Per-client queueing (existing registry)    | 96 kB/s per client                  | ≤ 0.001      | ≤ 0.003                    |
| Total, NFM + one decoder, one client       |                                     | ≤ 0.01       | ≤ 0.035                    |
| Total, worst case (200 kHz + two decoders) |                                     | ≤ 0.025      | ≤ 0.1                      |
| No `/auto` client                          | shadow tags plus one branch/chunk   | ≤ 0.0005     | ≤ 0.002                    |

**Measured and proposed revision (not yet adopted; pending a quiet-host re-run).** The first
bench run (Intel i5-1038NG7, 4 cores / 8 threads, node darwin-x64, load average 50 to 63 during
the run) measured the resampler alone, after the inner-loop optimisation (contiguous double-ring
window, Float64 history and taps, 4-way unrolled dot product, fused FIFO copy and flag count),
at a best-of-run 4.3 ms per audio second at 25 kHz in, 3.0 ms at 8 kHz in and 16 ms at
200 kHz in. That is 4.3 ms / (48 000 × 34) ≈ 2.6 ns per multiply-add, not the 1 ns taken above,
on an oversubscribed host (about 7 runnable threads per hardware thread), so the true
quiet-host figure is likely lower. If a quiet re-run confirms about 2.6 ns per MAC, the
desktop rows become:

| Stage                                  | Arithmetic                         | Proposed desktop core |
| -------------------------------------- | ---------------------------------- | --------------------- |
| Analog NFM resample                    | 48 000 × 34 × 2.6 ns ≈ 4.3 ms/s    | ≤ 0.005               |
| Analog 200 kHz (exact 6/25 phases)     | 48 000 × 138 × 2.6 ns ≈ 17 ms/s    | ≤ 0.02                |
| Voice 8 k → 48 k, per decoder          | 48 000 × 34 × 2.6 ns ≈ 4.3 ms/s    | ≤ 0.005               |
| Total, NFM + one decoder, one client   | 2 × 0.005 + routing ≈ 0.003        | ≤ 0.015               |
| Total, worst case (200 kHz + two dec.) | 0.02 + 2 × 0.005 + routing ≈ 0.005 | ≤ 0.04                |

Pi 4-class estimates scale by the same factor (about × 5 per MAC): NFM plus one decoder about
0.07, worst case about 0.2 core, still under the 0.3-core floor but no longer negligible; the
Pi figures need a measurement before the 200 kHz worst case is accepted there.

All below the 0.3-core noise floor. The bench `tests/bench/auto-listen-route.bench.ts` (not
collected by the root suite, which takes only `tests/**/*.test.ts`; run with
`pnpm exec vitest bench tests/bench/auto-listen-route.bench.ts`) records the desktop figures at
both IQ rates and at 200 kHz, including the shadow alone (no client), coverage recomputes at
10 generations per second and `status()` at 20 per second; Pi figures stay estimates until measured.

## Correctness properties

Tests carry `// Feature: auto-listen-route, Property N: <name>` and `numRuns ≥ 100`, with
synthetic PCM, a fake voice source, a fake coverage port and an injected clock.

1. **Chunk-split invariance.** For any input and any split (including splits inside a sample),
   resampler, flag and router output are identical. _Validates 2.4, 2.5._
2. **Resampler response.** For random input rates in [8 000, 200 000], tones up to `0.4 m` come
   out within ±0.5 dB and tones above `0.5 m` are attenuated by at least 50 dB. _Validates 2.2,
   2.3._
3. **Bounded pacing.** For random tick schedules: emitted never exceeds due; after every tick
   `due − emitted < 960` or a rebase was counted; with no tick later than 100 ms the long-run
   count equals `floor(elapsed × 48)` within one block and `clockRebases` is 0; one tick emits at
   most `CATCHUP_MAX_BLOCKS` blocks; across a rebase no
   source sample is lost or repeated. _Validates 2.6, 2.7._
4. **No doubled audio.** Tag every input sample with a unique ramp; across random schedules,
   no tag is emitted twice and the tags of one source are emitted in increasing order.
   _Validates 4.2._
5. **No loss inside an over.** For random sequential overs (analog then digital, digital then
   analog, gaps from 0 to 2 s, digital overs from 0.1 s, including overs wholly inside the
   analog handover delay) with no overflow, preemption or invalidation, every audible or
   admitted sample is emitted exactly once. _Validates 4.3, 4.4, 4.6, 4.10._
6. **Priority and bound.** While digital is drain-eligible, it is selected within
   `PREEMPT_MAX_MS + BLOCK_MS` of its first queued sample; analog never preempts digital.
   _Validates 4.1, 4.5, 4.9._
7. **Catch-up only on silence.** Every discarded sample is silent, except counted overflow,
   preemption and invalidation drops, and `droppedMs` equals their duration. _Validates 4.3, 4.7._
8. **Analog equals `/stream`, sample-aligned.** With only analog input and random chunks that
   span opens, closes, tone-slice changes and the final pre-roll drain, `/auto` equals the
   `/stream` bytes through the reference resampler, and exactly the samples the governing gate
   plays qualify. _Validates 3.1, 3.6._
9. **Pre-roll shadow equivalence.** Driving the real `PreRoll` and `PreRollShadow` with the same
   random tag, latch, abandon and clear sequences, the shadow's `play` samples are exactly the
   non-zero output samples of a non-zero ramp input, and the delays agree. _Validates 3.6._
10. **Encryption.** For random encrypted flags, slots and timing (including clear → encrypted
    with audio queued and no further datagram), no sample of an encrypted call reaches `/auto`
    after the encrypted event. _Validates 3.2, 4.10._
11. **Several decoders.** For random overlapping calls on up to four decoders, the selected
    decoder changes only on release or invalidation, and the choice follows stickiness, age,
    id. _Validates 3.5._
12. **Coverage.** For random retunes, pending retunes, A → B → A and offset-plus-centre changes
    that keep the frequency, several of them between two pacer ticks with no frames, no admitted
    voice queued before a generation change or under `"unknown"` / `"no"` is emitted, and
    `covers` runs at most once per input per generation. _Validates 3.4,
    4.10._
13. **Existing streams unchanged.** With random `/auto` connect and disconnect, `/stream` and
    the digital voice streams are byte-identical to a run without `/auto`. _Validates 7.1, 7.2._
14. **Output blocks are immutable.** Under a delayed drain, every block a client finally
    receives equals the bytes the router produced for it. _Validates 2.8._
15. **Shadow from any start.** For random first-connect and reconnect instants (pending,
    playback, final drain), `/auto` analog qualification equals that of a client connected from
    the start for every sample after the connect; after an injected mismatch, qualification is
    silent until the first zero delay and exact after it. _Validates 3.6, 3.7._
16. **Digital tail.** For random calls ending in a non-zero impulse followed by no datagram,
    the impulse's full resampled response (all `N − 1` trailing input samples of support) is
    emitted exactly once with its admission flag, and the next samples start from an empty
    history; this includes a hold-expiry flush mid-call, later frames of the same call, then the
    call end (two flushes, nothing lost or repeated). _Validates 4.11._

## Fake-link acceptance plan (requirement 9.1, in-process)

`tests/unit/core/auto-listen/acceptance.test.ts` builds a `LiveDemodulator` with fake pipeline
ports (as existing live-demodulator tests do), a real `DigitalVoiceService` with a fake voice-call
source and datagrams injected through a loopback UDP socket on an OS-assigned port (port 0), a
fake coverage port, and an injected clock. It registers an in-memory `/auto` client and drives
9.1 and 9.2. No external process, receiver, container or fixed port is used.

## Live test plan (requirement 9.3, maintainer)

1. Tune a channel with both analog FM and DMR traffic and a dsd-fme decoder following the VFO;
   play `/auto` in the web Auto mode.
2. An analog over then a DMR call: both are heard from their first word; status goes `analog`,
   `digital` (`DMR`, slot), `none`.
3. A short DMR call immediately after an analog over (under one second): heard in full after
   the analog tail, no clipped start, no repeat.
4. `squelchMode: manual` with a low threshold: digital still takes over within 1.5 s.
5. Encrypted call: never heard.
6. Retune and modulation change with `/auto` connected: the client stays connected; no digital
   audio from the previous frequency plays after the retune.
7. `/stream` and the digital voice stream still behave as before; record core CPU and event loop
   p99 with and without an `/auto` client, and `clockRebases`.

## Calls made in this design (review these)

- HTTP, not WebSocket, because the web player is HTTP; WS can reuse the registry later.
- Manual and noise squelch qualify analog by the open gate; a wide-open manual squelch delays
  digital by at most 1.5 s.
- Evidence-path qualification comes from a shadow of the pre-roll's run model that tracks
  continuously (also with no `/auto` client), checked against its `delaySamples`, so the
  evidence squelch itself is not edited; a mismatch fails closed until the next zero delay.
- Coverage is invalidated by an event-driven generation and cached between generations.
- The digital resampler tail is flushed at call end or hold expiry.
- One fresh 1 920 B output block per 20 ms, because the registry and sockets retain buffers
  beyond the queue bound.
- Short digital overs queued during an analog handover still play; queued digital audio is
  invalidated by encryption, detach, retune or loss of verified coverage.
- A stall over 100 ms rebases the output clock (a client-visible gap) rather than bursting
  seconds of audio.
- Silent samples of a non-selected source are discarded, so a source cannot replay old silence
  after a handover.
- 300 ms release times both ways: the evidence pre-roll already bridges syllable gaps; long
  enough to bridge dsd-fme frame bursts.
- The digital voice service ingests voice for the router even with no digital voice client; a
  small CPU cost only while `/auto` has a client.
