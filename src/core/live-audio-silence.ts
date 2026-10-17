/**
 * WG10 req 2.2: silence fill while a live audio restart keeps the stream
 * format. Attached clients receive one zero chunk of
 * `LIVE_AUDIO_SILENCE_CHUNK_MS` per chunk of stream time (measured on an
 * injected clock) until the new pipeline's first audio, a stop, a failure or
 * `LIVE_AUDIO_SILENCE_FILL_MAX_MS`. Writes go to the client sink only (never
 * the `pcm` event), so tone detection, transmissions and recordings never
 * see the silence.
 *
 * Bound: 5 000 ms / 20 ms = 250 chunks per arm; one zero buffer per
 * (rate, format) is allocated and reused (25 kHz s16le: 500 samples, 1 000
 * bytes; 48 kHz f32le: 960 samples, 3 840 bytes).
 */

import {
	LIVE_AUDIO_SILENCE_CHUNK_MS,
	LIVE_AUDIO_SILENCE_FILL_MAX_MS,
} from "@wavekit/api-types"
import { pcmFrameBytes, type StreamFormat } from "./audio-stream-server.js"

/** Most chunks one arm can send: the bound divided by the chunk length. */
export const LIVE_AUDIO_SILENCE_MAX_CHUNKS = Math.floor(
	LIVE_AUDIO_SILENCE_FILL_MAX_MS / LIVE_AUDIO_SILENCE_CHUNK_MS,
)

export interface SilenceFillClock {
	now(): number
	setTimer(callback: () => void, ms: number): unknown
	clearTimer(handle: unknown): void
}

export const systemSilenceClock: SilenceFillClock = {
	now: () => Date.now(),
	setTimer: (callback, ms) => {
		const handle = setTimeout(callback, ms)
		handle.unref()
		return handle
	},
	clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Where silence goes: the client registry (write + partial-sample reset). */
export interface SilenceSink {
	write(chunk: Buffer): void
	clearRemainder(): void
}

export type SilenceDisarmReason = "audio" | "stop" | "failure" | "bound"

/** Samples in one silence chunk at this rate (whole samples, at least one). */
export function silenceChunkSamples(rate: number): number {
	return Math.max(1, Math.round((rate * LIVE_AUDIO_SILENCE_CHUNK_MS) / 1000))
}

export class SilenceFill {
	private readonly sink: SilenceSink
	private readonly clock: SilenceFillClock
	private zero: { key: string; buffer: Buffer } | null = null
	private armedAt = 0
	private sent = 0
	private timer: unknown = null
	private active = false
	/** Chunks written over this fill's lifetime (all arms), for tests and logs. */
	totalChunks = 0

	constructor(sink: SilenceSink, clock: SilenceFillClock = systemSilenceClock) {
		this.sink = sink
		this.clock = clock
	}

	get armed(): boolean {
		return this.active
	}

	/** Chunks sent by the current (or last) arm. */
	get chunksSent(): number {
		return this.sent
	}

	/** Starts (or restarts) the fill in this stream format; the first chunk goes now. */
	arm(stream: StreamFormat): void {
		this.stopTimer()
		const key = `${stream.rate}:${stream.format}`
		if (this.zero?.key !== key)
			this.zero = {
				key,
				buffer: Buffer.alloc(
					silenceChunkSamples(stream.rate) * pcmFrameBytes(stream.format),
				),
			}
		this.sink.clearRemainder()
		this.active = true
		this.armedAt = this.clock.now()
		this.sent = 0
		this.tick()
	}

	/** Ends the fill; returns false when it was not armed. */
	disarm(_reason: SilenceDisarmReason): boolean {
		if (!this.active) return false
		this.active = false
		this.stopTimer()
		this.sink.clearRemainder()
		return true
	}

	private tick(): void {
		this.timer = null
		if (!this.active || this.zero === null) return
		const elapsed = Math.max(0, this.clock.now() - this.armedAt)
		// One chunk covers each started chunk of stream time, up to the bound.
		const due = Math.min(
			LIVE_AUDIO_SILENCE_MAX_CHUNKS,
			Math.floor(elapsed / LIVE_AUDIO_SILENCE_CHUNK_MS) + 1,
		)
		while (this.sent < due) {
			this.sent++
			this.totalChunks++
			this.sink.write(this.zero.buffer)
		}
		if (elapsed >= LIVE_AUDIO_SILENCE_FILL_MAX_MS) {
			this.disarm("bound")
			return
		}
		const next = Math.min(
			this.sent * LIVE_AUDIO_SILENCE_CHUNK_MS,
			LIVE_AUDIO_SILENCE_FILL_MAX_MS,
		)
		this.timer = this.clock.setTimer(
			() => this.tick(),
			Math.max(1, next - elapsed),
		)
	}

	private stopTimer(): void {
		if (this.timer !== null) this.clock.clearTimer(this.timer)
		this.timer = null
	}
}
