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
 * since the last such block. Timing uses sample counts (stream time), so it
 * does not depend on how bursty the network delivers data.
 *
 * Noise mode (WG7 req 2.2, `setMode("noise")`): the gate follows a
 * `NoiseSquelch` (FM quieting of the channel IQ) instead of the power
 * threshold; the power measurement (`powerDbfs`) keeps running. The power
 * ("power" mode, used by the manual and auto squelch) code path is unchanged.
 */

import { Transform, type TransformCallback } from "node:stream"
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
}

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
		if (options.mode === "noise") this.setMode("noise")
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

		if (this.squelchMode === "noise" && this.noise) {
			this.gateOpen = this.noise.processBlock(block)
			return this.emitBlock(block)
		}

		const threshold = this.thresholdDbfs
		if (threshold === null) return this.emitBlock(block)

		const levelDbfs = toDbfs(power)
		if (levelDbfs >= threshold) {
			this.gateOpen = true
			this.lastAboveMs = this.streamMs
		} else if (this.gateOpen) {
			if (levelDbfs >= threshold - this.hysteresisDb) {
				this.lastAboveMs = this.streamMs
			} else if (this.streamMs - this.lastAboveMs >= this.hangMs) {
				this.gateOpen = false
			}
		}
		return this.emitBlock(block)
	}

	/** Passes (rotated) IQ or the muted vector, keeping the phase continuous. */
	private emitBlock(block: Buffer): Buffer {
		const samples = Math.floor(block.length / BYTES_PER_COMPLEX_SAMPLE)
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
