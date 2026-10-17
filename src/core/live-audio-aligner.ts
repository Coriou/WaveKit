/**
 * WG10 req 2.3: a passthrough between one front stage's stdout and the
 * channel squelch that forwards whole complex samples only (CF32: 8 bytes).
 * Each front has its own aligner, so the squelch input stays complex-sample
 * aligned when a front swap switches it from the old front to the new one:
 * the old front's partial sample is dropped with `resetAlignment()`.
 */

import { Transform, type TransformCallback } from "node:stream"

/** Bytes per complex float32 sample of channel IQ. */
export const CHANNEL_IQ_SAMPLE_BYTES = 8

export class ComplexSampleAligner extends Transform {
	private remainder: Buffer | null = null
	private seenData = false
	private readonly onFirstData: (() => void) | null
	/** Partial-sample bytes discarded by `resetAlignment()`. */
	droppedBytes = 0

	constructor(onFirstData?: () => void) {
		super()
		this.onFirstData = onFirstData ?? null
	}

	/** Drops the partial complex sample held from this front's last chunk. */
	resetAlignment(): void {
		if (this.remainder !== null) this.droppedBytes += this.remainder.length
		this.remainder = null
	}

	override _transform(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: TransformCallback,
	): void {
		if (!this.seenData && chunk.length > 0) {
			this.seenData = true
			this.onFirstData?.()
		}
		const data =
			this.remainder === null ? chunk : Buffer.concat([this.remainder, chunk])
		const usable = data.length - (data.length % CHANNEL_IQ_SAMPLE_BYTES)
		this.remainder =
			usable === data.length ? null : Buffer.from(data.subarray(usable))
		if (usable > 0)
			this.push(usable === data.length ? data : data.subarray(0, usable))
		callback()
	}

	override _flush(callback: TransformCallback): void {
		// A trailing partial sample never reaches the squelch.
		this.resetAlignment()
		callback()
	}
}

/**
 * Most capture bytes queued for a starting front before chunks are dropped:
 * 1 MiB is about 218 ms of U8 IQ at 2.4 Msps (4.8 MB/s).
 */
export const FRONT_SWAP_FEED_MAX_QUEUED_BYTES = 1 << 20

/**
 * Drops are whole multiples of this many bytes, so the starting front keeps
 * the IQ sample framing of every capture format (U8 2, S16 4, F32 8 bytes).
 */
export const CAPTURE_FRAME_ALIGN_BYTES = 8

/**
 * WG10 req 2.3: feeds capture IQ to a front that is still starting without
 * backpressure on the branch (a shared pipe would stall the running front
 * while the new process starts). Beyond the queue bound chunks are dropped,
 * in multiples of `CAPTURE_FRAME_ALIGN_BYTES`, so no byte slip reaches the
 * new front and the pipe that replaces this feed at the switch stays framed.
 */
export class FrontSwapFeed {
	private readonly target: NodeJS.WritableStream & { writableLength: number }
	private readonly maxQueuedBytes: number
	/** Bytes dropped so far (always a multiple of the frame alignment). */
	droppedBytes = 0

	constructor(
		target: NodeJS.WritableStream & { writableLength: number },
		maxQueuedBytes = FRONT_SWAP_FEED_MAX_QUEUED_BYTES,
	) {
		this.target = target
		this.maxQueuedBytes = maxQueuedBytes
	}

	push(chunk: Buffer): void {
		if (this.target.writableLength < this.maxQueuedBytes) {
			this.target.write(chunk)
			return
		}
		// Drop the frame-aligned head; the few tail bytes keep the framing.
		const keep = chunk.length % CAPTURE_FRAME_ALIGN_BYTES
		this.droppedBytes += chunk.length - keep
		if (keep > 0) this.target.write(chunk.subarray(chunk.length - keep))
	}
}
