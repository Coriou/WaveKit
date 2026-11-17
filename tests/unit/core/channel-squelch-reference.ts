/**
 * Test-only reference of the channel squelch before the allocation change: a verbatim copy of
 * the `ChannelSquelch` class and its private helpers as they were, renamed
 * `ReferenceChannelSquelch`. The equivalence tests compare the current class with it byte for
 * byte. Never imported by `src/`.
 */

import { LIVE_AUDIO_NOISE_QUIETING_DB } from "@wavekit/api-types"
import {
	CHANNEL_POWER_FLOOR_DBFS,
	CLOSED_SPANS_MAX,
	type ChannelSquelchMode,
	type ChannelSquelchOptions,
} from "../../../src/core/channel-squelch.js"
import {
	NOISE_QUIETING_DB_DEFAULT,
	NoiseSquelch,
	validateNoiseQuietingDb,
} from "../../../src/core/noise-squelch.js"

const BYTES_PER_COMPLEX_SAMPLE = 8
/** Magnitude of the muted carrier (-80 dBFS). */
const MUTED_MAGNITUDE = 1e-4
/** Time constant of the reported (smoothed) channel power. */
const REPORT_SMOOTHING_MS = 100

export class ReferenceChannelSquelch {
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
	/** FM quieting observer (null unless `carrierObserver`). */
	private observer: NoiseSquelch | null
	/** Last measured block's quieting ≥ the observer threshold. */
	private lastBlockQuieted = false
	/** The owner's last floor estimate was finite (a floor exists). */
	private ownerFloorKnown = false
	/** carrier evidence wanted (nfm/wfm). */
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
	/** Listen: decide without gating the output. */
	private detectOnlyEnabled: boolean

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
		this.detectOnlyEnabled = options.detectOnly === true
		// A detect-only output never closed: no rotation, the IQ passes byte-identical.
		if (this.detectOnlyEnabled) this.outputOpen = true
		if (options.mode === "noise") this.setMode("noise")
	}

	/**
	 * builds (fresh state) or drops the carrier observer at runtime, so
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
	 * turns carrier evidence on or off at runtime (the owner keeps it
	 * on for nfm/wfm). Off clears `blockCarrier()`. Never touches the gate.
	 */
	setCarrierEvidence(enabled: boolean): void {
		if (enabled === this.evidenceEnabled) return
		this.evidenceEnabled = enabled
		this.evidenceMeter = null
		this.lastBlockCarrier = false
	}

	/**
	 * Listen: turns detect-only on or off at runtime. The gate state is untouched; the next block
	 * leaves gated (off) or raw (on). Phase continuity across the switch follows the gate rules.
	 */
	setDetectOnly(enabled: boolean): void {
		this.detectOnlyEnabled = enabled
	}

	/** Listen: whether the output passes every block whatever the gate decides. */
	get detectOnly(): boolean {
		return this.detectOnlyEnabled
	}

	/** Whether `blockCarrier()` measures anything. */
	get hasCarrierEvidence(): boolean {
		return this.evidenceEnabled
	}

	/**
	 * the last measured block carried a carrier (observer quieting at
	 * the default, the noise gate's quieting at its own threshold, or the passive meter).
	 * False without `carrierEvidence`, before the first block and for an unusable block.
	 */
	blockCarrier(): boolean {
		return this.lastBlockCarrier
	}

	/** Whether the carrier observer exists. */
	get hasCarrierObserver(): boolean {
		return this.observer !== null
	}

	/**
	 * true when the last measured block's FM quieting is at
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
	 * a front swap (new channel offset). The gate returns to its rest state
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
			// no floor yet; the quieting decision drives the gate.
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

	/** evidence in power mode (observer, else the passive meter). */
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
		// Listen: detect-only output passes as if open; the decision stays in `gateOpen`.
		const passing = this.gateOpen || this.detectOnlyEnabled
		if (this.muteZeros) {
			this.noteSpan(!passing, samples)
			// A19: exact zeros freeze the envelope chain's AGC; no phase to continue.
			if (!passing) {
				this.outputOpen = false
				return Buffer.alloc(block.length)
			}
			this.outputOpen = true
			return block
		}
		if (!passing) {
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
