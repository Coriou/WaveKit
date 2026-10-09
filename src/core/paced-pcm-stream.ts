/**
 * Paced PCM stream: turns bursty mono s16le input (dsd-fme UDP voice) into
 * continuous constant-rate audio.
 *
 * A timer emits exactly `sampleRate` samples per second of wall-clock time
 * (tracked against the start time, so ticks never drift). Queued voice is
 * played once a jitter target is buffered (or has waited that long);
 * otherwise exact digital silence is emitted. The queue is bounded: beyond
 * `maxBufferMs` the oldest audio is dropped.
 */

import { EventEmitter } from "node:events"

export interface PacedPcmStreamOptions {
	sampleRate: number
	/** Timer period (default 20 ms). */
	tickMs?: number
	/** Audio buffered (or waited for) before playback starts after silence. */
	jitterBufferMs: number
	/** Queue bound; older audio beyond it is dropped. */
	maxBufferMs: number
	/**
	 * Monotonic clock in ms (default performance.now()): a wall-clock step,
	 * e.g. an NTP correction, must not stall or burst the output.
	 */
	now?: () => number
}

export interface PacedPcmStats {
	/** Voice samples played. */
	voiceSamples: number
	/** Silence samples emitted (between and inside calls). */
	silenceSamples: number
	/** Queued samples dropped because the queue was full. */
	droppedSamples: number
	/**
	 * Times the queue ran dry mid-tick while playing during an active call
	 * (see setCallActive): gaps inside a call, not the end of a burst after it.
	 */
	underruns: number
}

export interface PacedPcmStreamEvents {
	audio: (chunk: Buffer) => void
}

const BYTES_PER_SAMPLE = 2
/** After an event-loop stall longer than this, skip ahead instead of bursting. */
const MAX_CATCH_UP_MS = 1000

export class PacedPcmStream extends EventEmitter {
	private readonly sampleRate: number
	private readonly tickMs: number
	private readonly jitterSamples: number
	private readonly maxSamples: number
	private queue: Buffer[] = []
	private queuedSamples = 0
	private firstQueuedAt: number | null = null
	private playing = false
	private timer: ReturnType<typeof setInterval> | null = null
	private startedAt = 0
	private emittedSamples = 0
	private callActive = false
	private readonly now: () => number
	readonly stats: PacedPcmStats = {
		voiceSamples: 0,
		silenceSamples: 0,
		droppedSamples: 0,
		underruns: 0,
	}

	constructor(options: PacedPcmStreamOptions) {
		super()
		this.sampleRate = options.sampleRate
		this.tickMs = options.tickMs ?? 20
		this.now = options.now ?? (() => performance.now())
		this.jitterSamples = Math.round(
			(options.sampleRate * options.jitterBufferMs) / 1000,
		)
		this.maxSamples = Math.max(
			this.jitterSamples,
			Math.round((options.sampleRate * options.maxBufferMs) / 1000),
		)
	}

	get running(): boolean {
		return this.timer !== null
	}

	/** Milliseconds of voice waiting to be played. */
	get bufferedMs(): number {
		return Math.round((this.queuedSamples * 1000) / this.sampleRate)
	}

	start(): void {
		if (this.timer) return
		this.startedAt = this.now()
		this.emittedSamples = 0
		this.timer = setInterval(() => this.tick(), this.tickMs)
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer)
		this.timer = null
		this.clear()
	}

	/** Queues mono s16le voice (an odd trailing byte is ignored). */
	push(pcm: Buffer): void {
		const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE)
		if (samples === 0) return
		const chunk =
			pcm.length === samples * BYTES_PER_SAMPLE
				? pcm
				: pcm.subarray(0, samples * BYTES_PER_SAMPLE)
		if (this.queuedSamples === 0 && !this.playing) {
			this.firstQueuedAt = this.now()
		}
		this.queue.push(chunk)
		this.queuedSamples += samples
		this.dropOldest()
	}

	/** Whether a call is in progress (running dry then counts as an underrun). */
	setCallActive(active: boolean): void {
		this.callActive = active
	}

	/** Discards queued voice: the output is silence from the next tick. */
	clear(): void {
		this.queue = []
		this.queuedSamples = 0
		this.firstQueuedAt = null
		this.playing = false
	}

	private dropOldest(): void {
		let excess = this.queuedSamples - this.maxSamples
		while (excess > 0 && this.queue.length > 0) {
			const head = this.queue[0]!
			const headSamples = head.length / BYTES_PER_SAMPLE
			if (headSamples <= excess) {
				this.queue.shift()
				this.queuedSamples -= headSamples
				this.stats.droppedSamples += headSamples
				excess -= headSamples
			} else {
				this.queue[0] = head.subarray(excess * BYTES_PER_SAMPLE)
				this.queuedSamples -= excess
				this.stats.droppedSamples += excess
				excess = 0
			}
		}
	}

	private tick(): void {
		const now = this.now()
		let due =
			Math.floor(((now - this.startedAt) * this.sampleRate) / 1000) -
			this.emittedSamples
		if (due <= 0) return
		const catchUpLimit = Math.round((this.sampleRate * MAX_CATCH_UP_MS) / 1000)
		if (due > catchUpLimit) {
			// The event loop stalled: resynchronise rather than burst seconds of audio.
			const tickSamples = Math.round((this.sampleRate * this.tickMs) / 1000)
			this.emittedSamples += due - tickSamples
			due = tickSamples
		}

		if (!this.playing && this.queuedSamples > 0) {
			const waited = this.firstQueuedAt === null ? 0 : now - this.firstQueuedAt
			const waitedSamples = (waited * this.sampleRate) / 1000
			if (
				this.queuedSamples >= this.jitterSamples ||
				waitedSamples >= this.jitterSamples
			) {
				this.playing = true
			}
		}

		const out = Buffer.alloc(due * BYTES_PER_SAMPLE)
		let filled = 0
		if (this.playing) {
			while (filled < due && this.queue.length > 0) {
				const head = this.queue[0]!
				const take = Math.min(due - filled, head.length / BYTES_PER_SAMPLE)
				head.copy(out, filled * BYTES_PER_SAMPLE, 0, take * BYTES_PER_SAMPLE)
				filled += take
				this.queuedSamples -= take
				if (take * BYTES_PER_SAMPLE === head.length) this.queue.shift()
				else this.queue[0] = head.subarray(take * BYTES_PER_SAMPLE)
			}
			if (this.queuedSamples === 0) {
				// Ran dry: re-buffer before the next burst plays.
				if (filled < due && this.callActive) this.stats.underruns++
				this.playing = false
				this.firstQueuedAt = null
			}
		}
		this.stats.voiceSamples += filled
		this.stats.silenceSamples += due - filled
		this.emittedSamples += due
		this.emit("audio", out)
	}
}
