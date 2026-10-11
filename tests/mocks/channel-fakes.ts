/**
 * Scripted ChannelProvider for DecoderManager channel tests (addendum §4, §5).
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SourceCaps } from "../../src/config.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
	DecoderChannelRequest,
} from "../../src/core/channelizer/types.js"

export class FakeChannelProvider
	extends EventEmitter
	implements ChannelProvider
{
	generation = 1
	/** Scripted FIFO; "ok" (or an empty queue) grants the channel. */
	results: Array<ChannelRequestResult | "ok"> = []
	calls: Array<{
		sourceId: string
		decoderId: string
		req: DecoderChannelRequest
		inputCaps: SourceCaps | undefined
	}> = []
	released: string[] = []
	streams = new Map<string, PassThrough>()
	/** When set, every request waits for it after recording the call. */
	gate: Promise<void> | null = null
	/** Runs after the gate, before the result is built (to race invalidations). */
	beforeResult: (() => void) | null = null

	/** Widened so it satisfies `ChannelProvider.off`, whose listener takes `never[]`. */
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void)
	}

	async requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
	): Promise<ChannelRequestResult> {
		this.calls.push({ sourceId, decoderId, req, inputCaps })
		if (this.gate) await this.gate
		const next = this.results.shift() ?? "ok"
		if (next !== "ok") return next
		const channelId = `${decoderId}-g${this.generation}`
		const stream = new PassThrough()
		this.streams.set(channelId, stream)
		const granted: ChannelRequestResult = {
			ok: true,
			stream,
			channelId,
			generation: this.generation,
			realised: {
				outputRateHz: req.outputRateHz,
				format: req.format,
				groupDelaySamples: 10,
			},
		}
		const hook = this.beforeResult
		this.beforeResult = null
		hook?.()
		return granted
	}

	async releaseChannel(channelId: string): Promise<void> {
		this.released.push(channelId)
		this.streams.get(channelId)?.destroy()
	}

	currentGeneration(_sourceId: string): number {
		return this.generation
	}

	/** Emits `channel-invalidated` first, then destroys the streams (ChannelizerManager order). */
	invalidate(sourceId: string, ids: string[]): void {
		const gen = this.generation++
		this.emit("channel-invalidated", sourceId, gen, ids)
		for (const id of ids) this.streams.get(id)?.destroy()
	}
}
