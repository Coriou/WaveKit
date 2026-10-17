// Low-latency live audio in the browser: fetch(status.httpUrl) as a stream of raw PCM, decode to Float32
// and feed the AudioWorklet ring (pcm-worklet.ts); volume through a GainNode. The AudioContext is created
// and resumed inside the Listen gesture (autoplay rules). The <audio> WAV path in controller.ts is the
// fallback where AudioWorklet is missing.
import workletUrl from "./pcm-worklet.ts?worker&url"
import {
	parsePcmFormat,
	parsePositiveInt,
	parsePositiveRate,
	PcmDecoder,
	WORKLET_NAME,
} from "./pcm.ts"
import type { FromWorklet, PcmFormat, RingStats, ToWorklet } from "./pcm.ts"

export interface PcmSource {
	url: string
	/** Used when the response does not expose X-Audio-Format / X-Sample-Rate. */
	format: PcmFormat
	rate: number
	/** Include the session cookie (a protected core's audio port is cross-origin). */
	credentials?: boolean
}

export interface PcmPlayerEvents {
	/** The worklet started or stopped producing stream audio (stats arrive a few times a second). */
	onStats(stats: RingStats): void
	/** The stream failed or ended on its own (not after stop()/play()). */
	onEnded(reason: string): void
	/** The context is still suspended: needs a user gesture (unlock()). */
	onBlocked(): void
}

/** True where this player can run (AudioWorklet and fetch streaming). */
export function pcmPlayerSupported(): boolean {
	return (
		typeof AudioContext !== "undefined" &&
		typeof AudioWorkletNode !== "undefined" &&
		typeof ReadableStream !== "undefined" &&
		typeof fetch === "function"
	)
}

function makeContext(rate: number | null): AudioContext {
	if (rate !== null) {
		try {
			// the stream's own rate avoids resampling where the browser allows it
			return new AudioContext({ sampleRate: rate, latencyHint: "interactive" })
		} catch {
			// rate out of range for this browser: the worklet resamples
		}
	}
	return new AudioContext({ latencyHint: "interactive" })
}

export class PcmPlayer {
	private ctx: AudioContext | null = null
	private node: AudioWorkletNode | null = null
	private gain: GainNode | null = null
	private ready: Promise<AudioWorkletNode> | null = null
	private abort: AbortController | null = null
	private volume = 1
	private tap: ((samples: Float32Array, rate: number) => void) | null = null
	private readonly events: PcmPlayerEvents

	constructor(events: PcmPlayerEvents) {
		this.events = events
	}

	/**
	 * Call inside the user gesture: creates (at `rateHint` when possible) or resumes the context and
	 * starts loading the worklet.
	 */
	unlock(rateHint: number | null): void {
		if (!this.ctx || this.ctx.state === "closed") {
			const ctx = makeContext(rateHint)
			this.ctx = ctx
			const gain = ctx.createGain()
			gain.gain.value = this.volume
			gain.connect(ctx.destination)
			this.gain = gain
			this.ready = ctx.audioWorklet.addModule(workletUrl).then(() => {
				const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
					numberOfInputs: 0,
					numberOfOutputs: 1,
					outputChannelCount: [1],
				})
				node.port.onmessage = (event: MessageEvent<FromWorklet>) => {
					if (event.data.type === "stats") this.events.onStats(event.data)
				}
				node.connect(gain)
				this.node = node
				return node
			})
			// a failed load surfaces through play()
			this.ready.catch(() => undefined)
		}
		if (this.ctx.state === "suspended") this.ctx.resume().catch(() => undefined)
	}

	/** Plays `source`, replacing whatever was playing (the ring starts empty). */
	play(source: PcmSource): void {
		this.abort?.abort()
		const abort = new AbortController()
		this.abort = abort
		void this.pump(source, abort.signal).catch((error: unknown) => {
			if (abort.signal.aborted) return
			this.events.onEnded(
				error instanceof Error ? error.message : "The audio stream failed",
			)
		})
	}

	/** Stops the stream and silences the output; the context is suspended until the next unlock(). */
	stop(): void {
		this.abort?.abort()
		this.abort = null
		this.post({ type: "reset" })
		if (this.ctx?.state === "running") this.ctx.suspend().catch(() => undefined)
	}

	/** Receives a copy of every decoded chunk (Listen › Record); null stops it. */
	setTap(tap: ((samples: Float32Array, rate: number) => void) | null): void {
		this.tap = tap
	}

	/** What the device and context add after the ring, ms. */
	outputLatencyMs(): number {
		const ctx = this.ctx
		if (!ctx) return 0
		return ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000
	}

	setVolume(volume: number): void {
		this.volume = volume
		const gain = this.gain
		if (gain && this.ctx)
			gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.02)
	}

	dispose(): void {
		this.abort?.abort()
		this.abort = null
		this.node?.disconnect()
		this.node = null
		const ctx = this.ctx
		this.ctx = null
		this.ready = null
		if (ctx && ctx.state !== "closed") ctx.close().catch(() => undefined)
	}

	private post(msg: ToWorklet, transfer: Transferable[] = []): void {
		this.node?.port.postMessage(msg, transfer)
	}

	private async pump(source: PcmSource, signal: AbortSignal): Promise<void> {
		const ready = this.ready
		if (!ready) throw new Error("Audio is not unlocked")
		const response = await fetch(source.url, {
			signal,
			cache: "no-store",
			...(source.credentials ? { credentials: "include" as const } : {}),
		})
		if (!response.ok || !response.body)
			throw new Error(`The audio stream answered ${response.status}`)
		const headers = response.headers
		const format =
			parsePcmFormat(headers.get("X-Audio-Format")) ?? source.format
		const rate = parsePositiveRate(headers.get("X-Sample-Rate")) ?? source.rate
		const channels = parsePositiveInt(headers.get("X-Channels")) ?? 1
		const node = await ready
		if (signal.aborted) return
		node.port.postMessage({ type: "format", rate } satisfies ToWorklet)
		if (this.ctx?.state === "suspended") this.events.onBlocked()
		const decoder = new PcmDecoder(format, channels)
		const reader = response.body.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				const samples = decoder.push(value)
				if (samples.length > 0 && this.tap) this.tap(samples.slice(), rate)
				if (samples.length > 0)
					node.port.postMessage({ type: "pcm", samples } satisfies ToWorklet, [
						samples.buffer,
					])
			}
		} finally {
			reader.releaseLock()
		}
		if (!signal.aborted) throw new Error("The audio stream ended")
	}
}
