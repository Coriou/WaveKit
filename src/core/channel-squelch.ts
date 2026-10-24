/**
 * Channel Squelch - pre-demodulation power squelch on channel IQ.
 *
 * The live demodulator decimates the capture to the channel (complex float32
 * IQ) in one CSDR process and demodulates in a second one; this squelch sits
 * between them. It measures the mean channel power |z|² per 10 ms block and,
 * while closed, replaces the IQ with zeros so the demodulator outputs silence
 * and the audio stream keeps flowing at its nominal rate.
 *
 * Measuring before demodulation is what makes the threshold meaningful: after
 * an FM discriminator noise is louder than a quieted carrier, so a level
 * squelch on the audio can never work.
 *
 * Click-free transitions: a closed gate does not output zeros (arg(0) = 0
 * makes the discriminator jump by -last_phase, a full-scale click). It holds
 * the last passed sample's phase at -80 dBFS (|z| = 1e-4), so the phase does
 * not move on close; on reopen the passed IQ is rotated by a constant so its
 * first sample continues that phase. A constant rotation does not change FM,
 * AM or SSB demodulation.
 *
 * Threshold semantics (config `squelch`): dBFS of channel power relative to a
 * full-scale complex IQ sample (|z| = 1 → 0 dBFS). The gate opens on the first
 * block at or above the threshold, stays open while blocks remain within
 * `hysteresisDb` below it, and closes once `hangMs` of stream time has passed
 * since the last such block.
 *
 * Noise tail (WG7 req 4.1). With a threshold set just above the channel noise
 * (an operator raising the squelch until idle is silent lands about 2-3 dB
 * above the noise mean), the 2 dB band reached into the noise itself: noise
 * blocks kept refreshing the hang and the gate stayed open for a random
 * 0.3 s to several seconds after the carrier. One rule keeps the band out of
 * the noise: given a noise floor estimate (`setNoiseFloorDbfs`), a band block
 * (below the threshold, within `hysteresisDb` of it) that is also less than
 * `hysteresisDb` above that floor is indistinguishable from noise and does
 * not refresh the hang; it is treated like a block below the band. Every
 * other block is gated exactly as before. A causal gate cannot tell whether
 * the carrier has ended, so such a block also stops refreshing the hang in
 * the middle of a transmission (a fade to within 2 dB of the floor).
 *
 * The floor the rule uses is sampled only while the gate is closed: it
 * freezes when the gate opens and follows the estimate again once it closes.
 * An owner's floor estimate keeps rising while the gate is open (the auto
 * squelch's slow open rise); fed straight into the rule it climbed under a
 * held carrier until band blocks no longer held, chopping a transmission.
 * The frozen floor is the noise the gate last saw idle, so the rule only
 * drops band blocks that look like that noise.
 *
 * Timing uses sample counts (stream time), so it does not depend on how
 * bursty the network delivers data.
 *
 * Noise mode (WG7 req 2.2, `setMode("noise")`): the gate follows a
 * `NoiseSquelch` (FM quieting of the channel IQ) instead of the power
 * threshold; the power measurement (`powerDbfs`) keeps running. The power
 * ("power" mode, used by the manual and auto squelch) code path is unchanged.
 *
 * Carrier observer (WG10 req 2.6, `carrierObserver: true`, built by the owner
 * only for the auto squelch on nfm/wfm): a second `NoiseSquelch` measures the
 * FM quieting of every block at `LIVE_AUDIO_NOISE_QUIETING_DB.default`;
 * `blockQuieted()` tells the owner whether the last measured block carried a
 * carrier, so a quieted block never seeds or raises the owner's floor. While
 * the owner has no floor (`setNoiseFloorDbfs(null)` or never set) the gate in
 * power mode follows the observer's open/closed decision instead of the power
 * threshold, so a carrier already present at start or after a retune is heard
 * at once. Once a floor exists the power path runs unchanged. Order: the
 * observer measures inside `process()`, before it returns the block, so an
 * owner callback run after `process()` for that block (the live
 * demodulator's `measureRun`) sees `blockQuieted()` of that same block.
 * Without the option nothing of this runs (byte-identical traces).
 *
 * Carrier evidence (WG10 activity hygiene, `carrierEvidence: true`, built by the owner
 * for nfm/wfm in every squelch mode): `blockCarrier()` tells whether the last measured
 * block carried a carrier, for the analog transmission tracker only. It reads the
 * observer when one exists (auto), the noise gate's own quieting against its threshold
 * in noise mode, and otherwise (manual) a passive `NoiseSquelch` meter at
 * `LIVE_AUDIO_NOISE_QUIETING_DB.default`. The meter never drives the gate, the floor or
 * `blockQuieted()`: audio gating is identical with and without it.
 */

import { Transform, type TransformCallback } from "node:stream"
import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import {
	NOISE_QUIETING_DB_DEFAULT,
	NoiseSquelch,
	validateNoiseQuietingDb,
} from "./noise-squelch.js"

/** Gate source: channel power ("power", manual/auto) or FM quieting ("noise"). */
export type ChannelSquelchMode = "power" | "noise"

export interface ChannelSquelchOptions {
	/** Channel IQ sample rate in Hz (complex samples per second). */
	sampleRate: number
	/** Squelch threshold in dBFS; null disables gating (power is still measured). */
	thresholdDbfs: number | null
	hysteresisDb?: number
	hangMs?: number
	/** Measurement block length in ms (default 10). */
	blockMs?: number
	/** Gate source (default "power"). */
	mode?: ChannelSquelchMode
	/** Channel bandwidth in Hz for the noise reference (default sampleRate / 2). */
	bandwidthHz?: number
	/** Noise-mode quieting threshold in dB (default 6, range 1–30). */
	noiseQuietingDb?: number
	/**
	 * WG10 req 2.6: builds the FM quieting observer (auto nfm/wfm only).
	 * Default false: no observer, `blockQuieted()` always false.
	 */
	carrierObserver?: boolean
	/**
	 * WG10 activity hygiene: measures `blockCarrier()` (nfm/wfm). Never changes the gate.
	 * Default false: `blockCarrier()` always false, `hasCarrierEvidence` false.
	 */
	carrierEvidence?: boolean
	/**
	 * Evidence squelch A19 (envelope demodulators: am, dsb, cw on csdr): a closed block is exact
	 * zeros instead of the -80 dBFS hold vector, with no rotation on reopen, and every closed
	 * output sample is logged so `muteClosedPcm` can zero the PCM it becomes. Default false.
	 */
	muteZeros?: boolean
	/**
	 * A19 revision: channel samples by which the PCM content leads the PCM sample count (a FIR
	 * stage that keeps its window back emits sample `p` centred on input `p + lead`). PCM
	 * sample `p` is muted when channel sample `p + lead` was closed. Default 0.
	 */
	pcmLeadSamples?: number
}

/**
 * Closed spans in flight for `muteClosedPcm` (a ring). At the cap the two oldest spans merge,
 * muting the open gap between them: silence is never lost, at worst some open audio is muted.
 * At most 50 closes per second (alternating 10 ms blocks) x a PCM backlog of a few seconds
 * stays far below 1 024; the cap covers about 20 s of backlog at that worst rate.
 */
export const CLOSED_SPANS_MAX = 1024

/** Reported floor for an all-zero channel (matches the config minimum). */
export const CHANNEL_POWER_FLOOR_DBFS = -160

const BYTES_PER_COMPLEX_SAMPLE = 8
/** Magnitude of the muted carrier (-80 dBFS). */
const MUTED_MAGNITUDE = 1e-4
/** Time constant of the reported (smoothed) channel power. */
const REPORT_SMOOTHING_MS = 100

export class ChannelSquelch {
	private readonly blockBytes: number
	private readonly blockMs: number
	private readonly hysteresisDb: number
	private readonly hangMs: number
	private thresholdDbfs: number | null
	private remainder: Buffer = Buffer.alloc(0)
	private streamMs = 0
	private lastAboveMs = Number.NEGATIVE_INFINITY
	/**
	 * Noise floor for the hold rule (null = unknown): the owner's estimate,
	 * sampled only while the gate is closed (frozen while open).
	 */
	private floorDbfs: number | null = null
	private gateOpen: boolean
	private smoothedPower: number | null = null
	/** Gate state of the previous output block (to detect transitions). */
	private outputOpen: boolean
	/** Constant rotation applied to passed IQ since the last reopen. */
	private rotCos = 1
	private rotSin = 0
	/** Muted vector: the last passed sample's phase at MUTED_MAGNITUDE. */
	private fillI = MUTED_MAGNITUDE
	private fillQ = 0
	private lastI = 0
	private lastQ = 0
	private readonly sampleRate: number
	private readonly bandwidthHz: number
	private squelchMode: ChannelSquelchMode = "power"
	private quietingDb: number
	/** Created on the first switch to noise mode, then kept. */
	private noise: NoiseSquelch | null = null
	/** WG10 req 2.6: FM quieting observer (null unless `carrierObserver`). */
	private observer: NoiseSquelch | null
	/** Last measured block's quieting ≥ the observer threshold. */
	private lastBlockQuieted = false
	/** The owner's last floor estimate was finite (a floor exists). */
	private ownerFloorKnown = false
	/** WG10 activity hygiene: carrier evidence wanted (nfm/wfm). */
	private evidenceEnabled: boolean
	/** Passive quieting meter (built lazily, only without observer in power mode). */
	private evidenceMeter: NoiseSquelch | null = null
	/** Last measured block carried a carrier (evidence only, never gating). */
	private lastBlockCarrier = false
	/** A19: zeros while closed, plus the closed-span log. */
	private readonly muteZeros: boolean
	/** Output samples emitted so far (A19 span positions). */
	private emittedSamples = 0
	/** A19: closed output-sample spans [start, end) in a ring, oldest at `spanHead`. */
	private readonly spanStarts: Float64Array
	private readonly spanEnds: Float64Array
	private spanHead = 0
	private spanCount = 0
	/** A19 revision: PCM content lead in channel samples (see `pcmLeadSamples`). */
	private readonly pcmLead: number

	constructor(options: ChannelSquelchOptions) {
		const blockSamples = Math.max(
			1,
			Math.round((options.sampleRate * (options.blockMs ?? 10)) / 1000),
		)
		this.blockBytes = blockSamples * BYTES_PER_COMPLEX_SAMPLE
		this.blockMs = (blockSamples / options.sampleRate) * 1000
		this.hysteresisDb = options.hysteresisDb ?? 2
		this.hangMs = options.hangMs ?? 250
		this.thresholdDbfs = normalizeThreshold(options.thresholdDbfs)
		this.gateOpen = this.thresholdDbfs === null
		this.outputOpen = this.gateOpen
		this.sampleRate = options.sampleRate
		this.bandwidthHz =
			options.bandwidthHz !== undefined &&
			Number.isFinite(options.bandwidthHz) &&
			options.bandwidthHz > 0
				? options.bandwidthHz
				: options.sampleRate / 2
		this.quietingDb = validateNoiseQuietingDb(
			options.noiseQuietingDb ?? NOISE_QUIETING_DB_DEFAULT,
		)
		this.observer =
			options.carrierObserver === true ? this.createObserver() : null
		this.evidenceEnabled = options.carrierEvidence === true
		this.muteZeros = options.muteZeros === true
		// 16 KB per muting squelch only; others keep empty rings.
		this.spanStarts = new Float64Array(this.muteZeros ? CLOSED_SPANS_MAX : 0)
		this.spanEnds = new Float64Array(this.muteZeros ? CLOSED_SPANS_MAX : 0)
		const lead = options.pcmLeadSamples ?? 0
		this.pcmLead = Number.isFinite(lead) && lead > 0 ? Math.round(lead) : 0
		if (options.mode === "noise") this.setMode("noise")
	}

	/**
	 * WG10 req 2.6: builds (fresh state) or drops the carrier observer at runtime, so
	 * the owner keeps it only in auto nfm/wfm. Dropping clears the last quieting
	 * (`blockQuieted()` false) and returns the gate to the frozen power path. No-op
	 * when unchanged.
	 */
	setCarrierObserver(enabled: boolean): void {
		if (enabled === (this.observer !== null)) return
		this.observer = enabled ? this.createObserver() : null
		this.lastBlockQuieted = false
	}

	private createObserver(): NoiseSquelch {
		return new NoiseSquelch({
			sampleRate: this.sampleRate,
			bandwidthHz: this.bandwidthHz,
			quietingDb: LIVE_AUDIO_NOISE_QUIETING_DB.default,
			hangMs: this.hangMs,
			hysteresisDb: this.hysteresisDb,
		})
	}

	/**
	 * WG10 activity hygiene: turns carrier evidence on or off at runtime (the owner keeps it
	 * on for nfm/wfm). Off clears `blockCarrier()`. Never touches the gate.
	 */
	setCarrierEvidence(enabled: boolean): void {
		if (enabled === this.evidenceEnabled) return
		this.evidenceEnabled = enabled
		this.evidenceMeter = null
		this.lastBlockCarrier = false
	}

	/** Whether `blockCarrier()` measures anything (WG10 activity hygiene). */
	get hasCarrierEvidence(): boolean {
		return this.evidenceEnabled
	}

	/**
	 * WG10 activity hygiene: the last measured block carried a carrier (observer quieting at
	 * the default, the noise gate's quieting at its own threshold, or the passive meter).
	 * False without `carrierEvidence`, before the first block and for an unusable block.
	 */
	blockCarrier(): boolean {
		return this.lastBlockCarrier
	}

	/** Whether the carrier observer exists (WG10 req 2.6). */
	get hasCarrierObserver(): boolean {
		return this.observer !== null
	}

	/**
	 * WG10 req 2.6: true when the last measured block's FM quieting is at
	 * least `LIVE_AUDIO_NOISE_QUIETING_DB.default` (a carrier is present).
	 * Always false without the observer, before the first block, and for a
	 * block without a usable quieting (NaN, silent IQ): fail closed, so an
	 * unknown block is treated as noise by the gate but the owner's floor
	 * logic is the frozen one.
	 */
	blockQuieted(): boolean {
		return this.lastBlockQuieted
	}

	/** Current gate source. */
	get mode(): ChannelSquelchMode {
		return this.squelchMode
	}

	/** Noise-mode quieting threshold in dB. */
	get noiseQuietingDb(): number {
		return this.quietingDb
	}

	/** Quieting of the last noise-mode block in dB (null outside noise mode). */
	get noiseQuietingLevelDb(): number | null {
		return this.squelchMode === "noise" && this.noise
			? this.noise.lastQuietingDb
			: null
	}

	/**
	 * Switches the gate source at runtime. Entering noise mode starts closed
	 * with a fresh discriminator state; returning to power mode starts from
	 * the power threshold's rest state (open when disabled, else closed).
	 * No-op when the mode is unchanged.
	 */
	setMode(mode: ChannelSquelchMode): void {
		if (mode === this.squelchMode) return
		if (mode === "noise") {
			this.noise ??= new NoiseSquelch({
				sampleRate: this.sampleRate,
				bandwidthHz: this.bandwidthHz,
				quietingDb: this.quietingDb,
				hangMs: this.hangMs,
				hysteresisDb: this.hysteresisDb,
			})
			this.noise.reset()
			this.squelchMode = "noise"
			this.gateOpen = false
			return
		}
		this.squelchMode = "power"
		this.lastAboveMs = Number.NEGATIVE_INFINITY
		this.gateOpen = this.thresholdDbfs === null
	}

	/** Sets the noise-mode quieting threshold (1–30 dB; throws otherwise). */
	setNoiseQuietingDb(db: number): void {
		this.quietingDb = validateNoiseQuietingDb(db)
		this.noise?.setQuietingDb(db)
	}

	/** Current gate state (always true while disabled). */
	get open(): boolean {
		return this.gateOpen
	}

	/** Smoothed channel power in dBFS, or null before the first block. */
	get powerDbfs(): number | null {
		if (this.smoothedPower === null) return null
		return toDbfs(this.smoothedPower)
	}

	/** Applies a new threshold (null/0 disables) without resetting timing. */
	setThreshold(thresholdDbfs: number | null): void {
		this.thresholdDbfs = normalizeThreshold(thresholdDbfs)
		if (this.thresholdDbfs === null && this.squelchMode === "power")
			this.gateOpen = true
	}

	/**
	 * Noise floor estimate of the channel in dBFS (null when unknown), used
	 * only to keep the hysteresis hold band out of the noise (WG7 req 4.1):
	 * a band block less than `hysteresisDb` above this floor does not refresh
	 * the hang. Without an estimate the gate is exactly the pre-WG7 gate.
	 *
	 * A finite estimate is taken only while the gate is closed; while it is
	 * open the floor in force stays the one sampled before it opened (the
	 * owner's estimate may rise under a carrier). Null (estimate reset, e.g.
	 * on retune) clears it in every state.
	 */
	setNoiseFloorDbfs(floorDbfs: number | null): void {
		if (floorDbfs === null || !Number.isFinite(floorDbfs)) {
			this.floorDbfs = null
			this.ownerFloorKnown = false
			return
		}
		this.ownerFloorKnown = true
		if (!this.gateOpen) this.floorDbfs = floorDbfs
	}

	/**
	 * WG10 R1 m1: a front swap (new channel offset). The gate returns to its rest state
	 * (closed unless disabled), the hang and the noise and carrier-observer state start
	 * afresh, so nothing measured on the old channel opens the gate on the new one. The
	 * owner's floor estimate is its own (reset on retune); the output phase stays continuous.
	 */
	resetGate(): void {
		this.gateOpen = this.squelchMode === "power" && this.thresholdDbfs === null
		this.lastAboveMs = Number.NEGATIVE_INFINITY
		this.smoothedPower = null
		this.noise?.reset()
		if (this.observer !== null) this.observer = this.createObserver()
		this.lastBlockQuieted = false
		this.evidenceMeter = null
		this.lastBlockCarrier = false
	}

	/** Gates complete blocks; a partial block waits for the next chunk. */
	process(chunk: Buffer): Buffer[] {
		const data =
			this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk
		const out: Buffer[] = []
		let offset = 0
		while (data.length - offset >= this.blockBytes) {
			const block = data.subarray(offset, offset + this.blockBytes)
			offset += this.blockBytes
			out.push(this.gateBlock(block))
		}
		this.remainder = Buffer.from(data.subarray(offset))
		return out
	}

	/** Releases the buffered partial block using the current gate state. */
	flush(): Buffer[] {
		if (this.remainder.length === 0) return []
		const tail = this.remainder
		this.remainder = Buffer.alloc(0)
		return [this.emitBlock(tail)]
	}

	private gateBlock(block: Buffer): Buffer {
		const power = blockPower(block)
		this.streamMs += this.blockMs
		this.smoothedPower =
			this.smoothedPower === null
				? power
				: this.smoothedPower +
					(power - this.smoothedPower) *
						Math.min(1, this.blockMs / REPORT_SMOOTHING_MS)

		const observer = this.observer
		let observerOpen = false
		if (observer !== null) {
			observerOpen = observer.processBlock(block)
			const quieting = observer.lastQuietingDb
			this.lastBlockQuieted =
				quieting !== null && quieting >= LIVE_AUDIO_NOISE_QUIETING_DB.default
		}

		if (this.squelchMode === "noise" && this.noise) {
			this.gateOpen = this.noise.processBlock(block)
			if (this.evidenceEnabled) {
				const q = this.noise.lastQuietingDb
				this.lastBlockCarrier = q !== null && q >= this.noise.quietingDb
			}
			return this.emitBlock(block)
		}
		if (this.evidenceEnabled) this.measureCarrierEvidence(block)

		const threshold = this.thresholdDbfs
		if (threshold === null) return this.emitBlock(block)

		if (observer !== null && !this.ownerFloorKnown) {
			// WG10 req 2.6: no floor yet; the quieting decision drives the gate.
			// An open observer refreshes the power hang so the handover to the
			// power path (first floor) does not chop a carrier at once.
			this.gateOpen = observerOpen
			if (observerOpen) this.lastAboveMs = this.streamMs
			return this.emitBlock(block)
		}

		const levelDbfs = toDbfs(power)
		if (levelDbfs >= threshold) {
			this.gateOpen = true
			this.lastAboveMs = this.streamMs
		} else if (this.gateOpen) {
			// WG7 req 4.1 (noise tail): a band block within `hysteresisDb` of
			// the noise floor is noise, not a held carrier; it counts as below
			// the band. This is the only difference from the pre-WG7 gate.
			const holds =
				levelDbfs >= threshold - this.hysteresisDb &&
				(this.floorDbfs === null ||
					levelDbfs >= this.floorDbfs + this.hysteresisDb)
			if (holds) {
				this.lastAboveMs = this.streamMs
			} else if (this.streamMs - this.lastAboveMs >= this.hangMs) {
				this.gateOpen = false
			}
		}
		return this.emitBlock(block)
	}

	/** WG10 activity hygiene: evidence in power mode (observer, else the passive meter). */
	private measureCarrierEvidence(block: Buffer): void {
		if (this.observer !== null) {
			this.lastBlockCarrier = this.lastBlockQuieted
			return
		}
		this.evidenceMeter ??= this.createObserver()
		this.evidenceMeter.processBlock(block)
		const q = this.evidenceMeter.lastQuietingDb
		this.lastBlockCarrier =
			q !== null && q >= LIVE_AUDIO_NOISE_QUIETING_DB.default
	}

	/** A19: true when closed output is exact zeros and its PCM can be muted. */
	get mutesClosedPcm(): boolean {
		return this.muteZeros
	}

	/** A19: closed spans not yet consumed by `muteClosedPcm` (tests, diagnostics). */
	get closedSpansInFlight(): number {
		return this.spanCount
	}

	/**
	 * A19: zeroes the bytes of `chunk` whose PCM samples came from closed output samples. The
	 * back chain emits one PCM sample per channel sample, so PCM sample `p` is output sample
	 * `p + pcmLeadSamples`; `startByte` is the stream byte position of the chunk, `width` the
	 * sample width. Spans wholly before the chunk's end are dropped. No-op without `muteZeros`.
	 */
	muteClosedPcm(chunk: Buffer, startByte: number, width: number): void {
		if (!this.muteZeros) return
		const endByte = startByte + chunk.length
		const lead = this.pcmLead
		while (this.spanCount > 0) {
			const i = this.spanHead
			const from = Math.max(0, this.spanStarts[i]! - lead) * width
			const to = Math.max(0, this.spanEnds[i]! - lead) * width
			if (from >= endByte) return
			const a = Math.max(from, startByte)
			const b = Math.min(to, endByte)
			if (b > a) chunk.fill(0, a - startByte, b - startByte)
			if (to > endByte) return
			this.spanHead = (i + 1) % CLOSED_SPANS_MAX
			this.spanCount--
		}
	}

	private noteSpan(closed: boolean, samples: number): void {
		const start = this.emittedSamples
		this.emittedSamples += samples
		if (!closed || samples === 0) return
		if (this.spanCount > 0) {
			const last = (this.spanHead + this.spanCount - 1) % CLOSED_SPANS_MAX
			if (this.spanEnds[last] === start) {
				this.spanEnds[last] = this.emittedSamples
				return
			}
		}
		if (this.spanCount === CLOSED_SPANS_MAX) {
			// Merge the two oldest: the gap between them is muted too (never less silence).
			const oldest = this.spanHead
			const next = (oldest + 1) % CLOSED_SPANS_MAX
			this.spanStarts[next] = this.spanStarts[oldest]!
			this.spanHead = next
			this.spanCount--
		}
		const slot = (this.spanHead + this.spanCount) % CLOSED_SPANS_MAX
		this.spanStarts[slot] = start
		this.spanEnds[slot] = this.emittedSamples
		this.spanCount++
	}

	/** Passes (rotated) IQ or the muted vector, keeping the phase continuous. */
	private emitBlock(block: Buffer): Buffer {
		const samples = Math.floor(block.length / BYTES_PER_COMPLEX_SAMPLE)
		if (this.muteZeros) {
			this.noteSpan(!this.gateOpen, samples)
			// A19: exact zeros freeze the envelope chain's AGC; no phase to continue.
			if (!this.gateOpen) {
				this.outputOpen = false
				return Buffer.alloc(block.length)
			}
			this.outputOpen = true
			return block
		}
		if (!this.gateOpen) {
			if (this.outputOpen) {
				const magnitude = Math.hypot(this.lastI, this.lastQ)
				if (magnitude > 0) {
					this.fillI = (this.lastI / magnitude) * MUTED_MAGNITUDE
					this.fillQ = (this.lastQ / magnitude) * MUTED_MAGNITUDE
				}
				this.outputOpen = false
			}
			const muted = Buffer.alloc(block.length)
			for (let n = 0; n < samples; n++) {
				muted.writeFloatLE(this.fillI, n * 8)
				muted.writeFloatLE(this.fillQ, n * 8 + 4)
			}
			return muted
		}

		if (samples === 0) return block
		if (!this.outputOpen) {
			// Rotate so the first passed sample continues the muted phase.
			const first = Math.atan2(block.readFloatLE(4), block.readFloatLE(0))
			const rotation = Math.atan2(this.fillQ, this.fillI) - first
			this.rotCos = Math.cos(rotation)
			this.rotSin = Math.sin(rotation)
			this.outputOpen = true
		}
		let out = block
		if (this.rotCos !== 1 || this.rotSin !== 0) {
			out = Buffer.from(block)
			for (let n = 0; n < samples; n++) {
				const i = block.readFloatLE(n * 8)
				const q = block.readFloatLE(n * 8 + 4)
				out.writeFloatLE(i * this.rotCos - q * this.rotSin, n * 8)
				out.writeFloatLE(i * this.rotSin + q * this.rotCos, n * 8 + 4)
			}
		}
		const last = (samples - 1) * 8
		this.lastI = out.readFloatLE(last)
		this.lastQ = out.readFloatLE(last + 4)
		return out
	}
}

/** Stream adapter used between the two CSDR processes. */
export function createChannelSquelchTransform(
	squelch: ChannelSquelch,
): Transform {
	return new Transform({
		transform(chunk: Buffer, _encoding, callback: TransformCallback) {
			for (const block of squelch.process(chunk)) this.push(block)
			callback()
		},
		flush(callback: TransformCallback) {
			for (const block of squelch.flush()) this.push(block)
			callback()
		},
	})
}

function normalizeThreshold(value: number | null): number | null {
	return value === null || value >= 0 || !Number.isFinite(value) ? null : value
}

function blockPower(block: Buffer): number {
	const samples = block.length / BYTES_PER_COMPLEX_SAMPLE
	let sum = 0
	for (let i = 0; i < block.length; i += 4) {
		const value = block.readFloatLE(i)
		if (Number.isFinite(value)) sum += value * value
	}
	return sum / samples
}

function toDbfs(power: number): number {
	if (!(power > 0)) return CHANNEL_POWER_FLOOR_DBFS
	return Math.max(CHANNEL_POWER_FLOOR_DBFS, 10 * Math.log10(power))
}
