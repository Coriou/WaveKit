// Low-latency live audio in the browser: fetch(status.httpUrl) as a stream of raw PCM, decode to Float32
// and feed the AudioWorklet ring (pcm-worklet.ts); volume through a GainNode. The AudioContext is created
// and resumed inside the Listen gesture (autoplay rules). AudioWorklet is secure-context only: on a
// plain-http page outside localhost (http://pi.local:5173) the same ring renders from a
// ScriptProcessorNode on the main thread instead. The <audio> WAV path in controller.ts is the fallback
// where Web Audio or fetch streaming is missing.
import workletUrl from "./pcm-worklet.ts?worker&url"
import {
	parsePcmFormat,
	parsePositiveInt,
	parsePositiveRate,
	PcmDecoder,
	PcmRing,
	STATS_EVERY_S,
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

/** True where this player can run (Web Audio and fetch streaming). */
export function pcmPlayerSupported(): boolean {
	return (
		typeof AudioContext !== "undefined" &&
		typeof ReadableStream !== "undefined" &&
		typeof fetch === "function"
	)
}

/**
 * AudioWorklet is usable: secure contexts only. On a plain-http page outside localhost
 * AudioWorkletNode still exists but `audioWorklet` does not (addModule would throw).
 */
function workletUsable(ctx: AudioContext): boolean {
	return (
		globalThis.isSecureContext !== false &&
		typeof AudioWorkletNode !== "undefined" &&
		typeof ctx.audioWorklet?.addModule === "function"
	)
}

/** Where the decoded PCM goes: the worklet, or the main-thread ring of a ScriptProcessorNode. */
interface PcmSink {
	post(msg: ToWorklet, transfer?: Transferable[]): void
	/** What the sink itself adds, ms (the ScriptProcessor's block). */
	latencyMs: number
	disconnect(): void
}

async function workletSink(
	ctx: AudioContext,
	out: AudioNode,
	onStats: (stats: RingStats) => void,
): Promise<PcmSink> {
	await ctx.audioWorklet.addModule(workletUrl)
	const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
		numberOfInputs: 0,
		numberOfOutputs: 1,
		outputChannelCount: [1],
	})
	node.port.onmessage = (event: MessageEvent<FromWorklet>) => {
		if (event.data.type === "stats") onStats(event.data)
	}
	node.connect(out)
	return {
		post: (msg, transfer = []) => node.port.postMessage(msg, transfer),
		latencyMs: 0,
		disconnect: () => node.disconnect(),
	}
}

/** Block size of the ScriptProcessor fallback: about 43 ms at 48 kHz, well under the ring's target. */
const SCRIPT_BLOCK = 2048

function scriptSink(
	ctx: AudioContext,
	out: AudioNode,
	onStats: (stats: RingStats) => void,
): PcmSink {
	const ring = new PcmRing({ rate: ctx.sampleRate })
	const node = ctx.createScriptProcessor(SCRIPT_BLOCK, 1, 1)
	let wasPlaying = false
	let lastStats = 0
	node.onaudioprocess = event => {
		const buffer = event.outputBuffer
		const ch0 = buffer.getChannelData(0)
		ring.render(ch0, ring.sampleRate / ctx.sampleRate)
		for (let c = 1; c < buffer.numberOfChannels; c++)
			buffer.getChannelData(c).set(ch0)
		const playing = ring.playing
		if (
			playing !== wasPlaying ||
			ctx.currentTime - lastStats >= STATS_EVERY_S
		) {
			wasPlaying = playing
			lastStats = ctx.currentTime
			onStats(ring.stats())
		}
	}
	node.connect(out)
	return {
		post: msg => {
			if (msg.type === "pcm") ring.push(msg.samples)
			else if (msg.type === "format") ring.setRate(msg.rate)
			else ring.reset()
		},
		latencyMs: (SCRIPT_BLOCK / ctx.sampleRate) * 1000,
		disconnect: () => {
			node.onaudioprocess = null
			node.disconnect()
		},
	}
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
	private sink: PcmSink | null = null
	private gain: GainNode | null = null
	private ready: Promise<PcmSink> | null = null
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
			const onStats = (stats: RingStats) => this.events.onStats(stats)
			const sink = workletUsable(ctx)
				? workletSink(ctx, gain, onStats)
				: Promise.resolve(scriptSink(ctx, gain, onStats))
			this.ready = sink.then(made => {
				this.sink = made
				return made
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
		return (
			((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000 +
			(this.sink?.latencyMs ?? 0)
		)
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
		this.sink?.disconnect()
		this.sink = null
		const ctx = this.ctx
		this.ctx = null
		this.ready = null
		if (ctx && ctx.state !== "closed") ctx.close().catch(() => undefined)
	}

	private post(msg: ToWorklet, transfer: Transferable[] = []): void {
		this.sink?.post(msg, transfer)
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
		const sink = await ready
		if (signal.aborted) return
		sink.post({ type: "format", rate })
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
					sink.post({ type: "pcm", samples }, [samples.buffer])
			}
		} finally {
			reader.releaseLock()
		}
		if (!signal.aborted) throw new Error("The audio stream ended")
	}
}
