/**
 * Fakes for DecoderManager tests with direct channel input (direct-channel-input.ts): a provider that answers a direct
 * request with a paused, unread socket and any other with a relay stream, and a decoder that takes the socket at its
 * spawn the way BaseDecoder does. Nothing connects anywhere.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { SourceCaps } from "../../../src/config.js"
import type {
	ChannelProvider,
	ChannelRequestOptions,
	ChannelRequestResult,
	ChannelStats,
	DecoderChannelRequest,
	DirectChannelRequestResult,
	DirectChannelSocket,
} from "../../../src/core/channelizer/types.js"
import type {
	DecoderChannelRequestResult,
	DecoderStatus,
} from "../../../src/decoders/types.js"
import { RateDecoder } from "../../mocks/rate-fakes.js"

export const CENTER = 162e6

export type FakeSocket = PassThrough & { bytesRead: number }

/** A paused, unread socket, as the channelizer's direct connector hands it over. */
export function fakeSocket(): FakeSocket {
	const socket = Object.assign(new PassThrough(), { bytesRead: 0 })
	socket.pause()
	return socket
}

/** Answers a direct request with the socket, any other with a relay stream; records the order of events. */
export class DirectProvider extends EventEmitter implements ChannelProvider {
	generation = 1
	readonly calls: Array<{
		decoderId: string
		args: number
		options?: ChannelRequestOptions
	}> = []
	readonly sockets = new Map<string, FakeSocket>()
	readonly streams = new Map<string, PassThrough>()
	readonly released: string[] = []
	/** Grants a direct socket that is already closed (a channelizer race between the grant and the spawn). */
	closeBeforeGrant = false
	/** The id of the channel granted to `decoderId` (default: one per decoder and generation). */
	channelIdFor: (decoderId: string) => string = decoderId =>
		`${decoderId}-g${this.generation}`
	/** Shared with the decoders: "release:<id>" and "signal:<id>" in the order they happen. */
	constructor(readonly order: string[] = []) {
		super()
	}
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void)
	}
	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		signal?: AbortSignal,
	): Promise<ChannelRequestResult>
	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		signal: AbortSignal | undefined,
		options: ChannelRequestOptions,
	): Promise<DirectChannelRequestResult>
	requestChannel(
		_sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		_inputCaps: SourceCaps | undefined,
		...rest: [AbortSignal?, ChannelRequestOptions?]
	): Promise<DirectChannelRequestResult> {
		const options = rest[1]
		this.calls.push({
			decoderId,
			args: 4 + rest.length,
			...(options ? { options } : {}),
		})
		const channelId = this.channelIdFor(decoderId)
		const realised = {
			outputRateHz: req.outputRateHz,
			format: req.format,
			groupDelaySamples: 10,
		}
		if (options?.input === "direct") {
			const socket = fakeSocket()
			this.sockets.set(channelId, socket)
			if (this.closeBeforeGrant) socket.destroy()
			return Promise.resolve({
				ok: true,
				input: "direct",
				socket: socket as DirectChannelSocket,
				channelId,
				generation: this.generation,
				realised,
			})
		}
		const stream = new PassThrough()
		this.streams.set(channelId, stream)
		return Promise.resolve({
			ok: true,
			stream,
			channelId,
			generation: this.generation,
			realised,
		})
	}
	releaseChannel(channelId: string): Promise<void> {
		this.order.push(`release:${channelId}`)
		this.released.push(channelId)
		this.sockets.get(channelId)?.destroy()
		this.streams.get(channelId)?.destroy()
		return Promise.resolve()
	}
	currentGeneration(): number {
		return this.generation
	}
	/** The end of the generation (a centre move, a channelizer exit): every listed channel, then a new generation. */
	endGeneration(sourceId: string, ids: string[], cause = "caps-changed") {
		const generation = this.generation++
		this.emit("channel-invalidated", sourceId, generation, ids, cause)
	}
	/** wavekit-chan's write failed: the reader is gone (same generation). */
	clientGone(sourceId: string, id: string) {
		this.emit(
			"channel-invalidated",
			sourceId,
			this.generation,
			[id],
			"client-gone",
		)
	}
	stats(entry: Partial<ChannelStats> & { channelId: string }) {
		const stats: ChannelStats = {
			sourceId: "rtl",
			generation: this.generation,
			outputSamples: 0,
			bytesPerSample: 8,
			...entry,
		}
		this.emit("channel-stats", stats)
	}
}

/**
 * Mirrors BaseDecoder's direct input: holds the socket, takes it at the spawn, destroys Node's copy after it. Its
 * channel is centred on its `channelHz` option (a placement's), else on CENTER.
 */
export class DirectDecoder extends RateDecoder {
	options: Record<string, unknown>
	held: FakeSocket | null = null
	/** The sockets each spawn took as stdin. */
	readonly spawnedWith: FakeSocket[] = []
	readonly relayed: unknown[] = []
	bytes = 0
	constructor(
		id: string,
		private readonly order: string[],
		options: Record<string, unknown> = {},
	) {
		super(id, {
			input: "iq",
			output: "text",
			integrationPattern: "pure_consumer",
		})
		this.options = { ...options }
	}
	getChannelRequest(): DecoderChannelRequestResult {
		const channelHz = this.options["channelHz"]
		return {
			centerHz: typeof channelHz === "number" ? channelHz : CENTER,
			bandwidthHz: 45_600,
			transitionHz: 1200,
			outputRateHz: 48_000,
			format: "cf32",
		}
	}
	override updateOptions(updates: Record<string, unknown>) {
		this.options = { ...this.options, ...updates }
	}
	attachDirectInput(socket: DirectChannelSocket) {
		this.detachInput()
		this.held = socket as FakeSocket
	}
	addInputBytes(bytes: number) {
		this.bytes += bytes
	}
	override attachInput(input: never) {
		this.relayed.push(input)
		super.attachInput(input)
	}
	override detachInput() {
		this.held?.destroy()
		this.held = null
		super.detachInput()
	}
	override async start() {
		const socket = this.held
		this.held = null
		try {
			await super.start()
		} finally {
			socket?.destroy()
		}
		if (socket) this.spawnedWith.push(socket)
	}
	override async stop() {
		if (this.running) this.order.push(`signal:${this.id}`)
		await super.stop()
	}
	/** The child ends by itself (EOF or a crash). */
	exit(code: number | null = 0, signal: string | null = null) {
		this.running = false
		this.emit("exit", code, signal)
	}
	override getStatus(): DecoderStatus {
		const status = super.getStatus()
		return { ...status, stats: { ...status.stats, bytesIn: this.bytes } }
	}
}
