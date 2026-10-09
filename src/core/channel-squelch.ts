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
 * Threshold semantics (config `squelch`): dBFS of channel power relative to a
 * full-scale complex IQ sample (|z| = 1 → 0 dBFS). The gate opens on the first
 * block at or above the threshold, stays open while blocks remain within
 * `hysteresisDb` below it, and closes once `hangMs` of stream time has passed
 * since the last such block. Timing uses sample counts (stream time), so it
 * does not depend on how bursty the network delivers data.
 */

import { Transform, type TransformCallback } from "node:stream"

export interface ChannelSquelchOptions {
	/** Channel IQ sample rate in Hz (complex samples per second). */
	sampleRate: number
	/** Squelch threshold in dBFS; null disables gating (power is still measured). */
	thresholdDbfs: number | null
	hysteresisDb?: number
	hangMs?: number
	/** Measurement block length in ms (default 10). */
	blockMs?: number
}

/** Reported floor for an all-zero channel (matches the config minimum). */
export const CHANNEL_POWER_FLOOR_DBFS = -160

const BYTES_PER_COMPLEX_SAMPLE = 8
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
		if (this.thresholdDbfs === null) this.gateOpen = true
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
		return [this.gateOpen ? tail : Buffer.alloc(tail.length)]
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

		const threshold = this.thresholdDbfs
		if (threshold === null) return block

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
		return this.gateOpen ? block : Buffer.alloc(block.length)
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
