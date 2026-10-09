/**
 * Shared HTTP PCM audio streaming: client registry, bounded per-client
 * queues, stall disconnect, stream headers and the streaming WAV header.
 *
 * Used by the live analog demodulator and the digital voice stream. Each
 * stream endpoint pair is:
 * - GET <base>      raw PCM, described by X-Audio-Format / X-Sample-Rate /
 *                   X-Channels headers.
 * - GET <base>.wav  the same audio behind a streaming WAV header, so players
 *                   need no format flags.
 * A slow client keeps at most about one second of queued audio; older audio
 * is dropped (latency beats completeness). A client that accepts nothing for
 * the stall timeout is disconnected.
 */

import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { createServer } from "node:http"
import type { Logger } from "../utils/logger.js"
import { liveAudioClientQueueLimit } from "./client-buffer.js"

export type PcmFormat = "s16le" | "f32le"

export interface StreamFormat {
	rate: number
	format: PcmFormat
}

/** Bytes per mono sample. */
export function pcmFrameBytes(format: PcmFormat): number {
	return format === "s16le" ? 2 : 4
}

/** 44-byte WAV header for an unbounded mono stream (sizes set to 0xFFFFFFFF). */
export function wavStreamHeader(stream: StreamFormat): Buffer {
	const bytesPerSample = pcmFrameBytes(stream.format)
	const rate = Math.max(1, Math.round(stream.rate))
	const header = Buffer.alloc(44)
	header.write("RIFF", 0, "ascii")
	header.writeUInt32LE(0xffffffff, 4)
	header.write("WAVE", 8, "ascii")
	header.write("fmt ", 12, "ascii")
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(stream.format === "s16le" ? 1 : 3, 20)
	header.writeUInt16LE(1, 22)
	header.writeUInt32LE(rate, 24)
	header.writeUInt32LE(rate * bytesPerSample, 28)
	header.writeUInt16LE(bytesPerSample, 32)
	header.writeUInt16LE(bytesPerSample * 8, 34)
	header.write("data", 36, "ascii")
	header.writeUInt32LE(0xffffffff, 40)
	return header
}

/** Headers describing the raw stream, sent on both endpoints. */
export function streamHeaders(stream: StreamFormat): Record<string, string> {
	return {
		"X-Audio-Format": stream.format,
		"X-Sample-Rate": String(stream.rate),
		"X-Channels": "1",
		"Cache-Control": "no-cache, no-store",
		"Access-Control-Expose-Headers":
			"X-Audio-Format, X-Sample-Rate, X-Channels",
	}
}

export interface AudioClient {
	id: string
	response: http.ServerResponse
	remoteAddress: string
	connectedAt: Date
	bytesWritten: number
	stream: StreamFormat
	queue: Buffer[]
	queuedBytes: number
	droppedBytes: number
	waitingDrain: boolean
	lastProgressAt: number
}

export interface AudioClientRegistryOptions {
	/** Disconnect a client that accepts nothing for this long. */
	stallTimeoutMs: number
	/** Log label, e.g. "Live audio" or "Digital voice". */
	label: string
	/** Initial stream (sets frame size and the ~1 s queue limit). */
	stream: StreamFormat
}

export interface AudioClientRegistryEvents {
	"client-connected": (clientId: string) => void
	"client-disconnected": (clientId: string) => void
}

/**
 * Streaming clients of one PCM stream. Every dispatched chunk is a whole
 * number of samples; each client's queue is bounded to about one second.
 */
export class AudioClientRegistry extends EventEmitter {
	readonly clients: Map<string, AudioClient> = new Map()
	private readonly log: Logger
	private readonly stallTimeoutMs: number
	private readonly label: string
	private clientIdCounter = 0
	private remainder: Buffer = Buffer.alloc(0)
	private frameBytes: number
	private queueLimit: number
	bytesStreamed = 0

	constructor(log: Logger, options: AudioClientRegistryOptions) {
		super()
		this.log = log
		this.stallTimeoutMs = options.stallTimeoutMs
		this.label = options.label
		this.frameBytes = pcmFrameBytes(options.stream.format)
		this.queueLimit = liveAudioClientQueueLimit(
			options.stream.rate,
			this.frameBytes,
		)
	}

	get size(): number {
		return this.clients.size
	}

	get queueLimitBytes(): number {
		return this.queueLimit
	}

	/** Applies a new stream format (frame size, queue limit) and drops any partial sample. */
	configure(stream: StreamFormat): void {
		this.frameBytes = pcmFrameBytes(stream.format)
		this.queueLimit = liveAudioClientQueueLimit(stream.rate, this.frameBytes)
		this.remainder = Buffer.alloc(0)
	}

	register(
		response: http.ServerResponse,
		remoteAddress: string,
		stream: StreamFormat,
	): AudioClient {
		const clientId = `client-${++this.clientIdCounter}`
		const client: AudioClient = {
			id: clientId,
			response,
			remoteAddress,
			connectedAt: new Date(),
			bytesWritten: 0,
			stream,
			queue: [],
			queuedBytes: 0,
			droppedBytes: 0,
			waitingDrain: false,
			lastProgressAt: Date.now(),
		}
		this.clients.set(clientId, client)
		this.emit("client-connected", clientId)
		this.log.info(
			{ clientId, remoteAddress, totalClients: this.clients.size, stream },
			`${this.label} client connected`,
		)

		response.on("close", () => this.cleanup(clientId))
		response.on("error", err => {
			this.log.debug({ clientId, err }, `${this.label} client error`)
		})
		return client
	}

	/** Sends audio to every client (whole samples only; a partial sample waits). */
	write(chunk: Buffer): void {
		const aligned = this.align(chunk)
		if (!aligned || this.clients.size === 0) return
		for (const client of [...this.clients.values()]) {
			this.enqueue(client, aligned)
		}
	}

	close(client: AudioClient, reason: string, destroy: boolean): void {
		this.log.debug(
			{ clientId: client.id, reason },
			`Closing ${this.label} client`,
		)
		try {
			if (destroy) client.response.destroy()
			else client.response.end()
		} catch {
			// Ignore
		}
		this.cleanup(client.id)
	}

	closeAll(reason: string, destroy: boolean): void {
		for (const client of [...this.clients.values()]) {
			this.close(client, reason, destroy)
		}
	}

	closeWhere(
		predicate: (client: AudioClient) => boolean,
		reason: string,
		destroy: boolean,
	): void {
		for (const client of [...this.clients.values()]) {
			if (predicate(client)) this.close(client, reason, destroy)
		}
	}

	private cleanup(clientId: string): void {
		const client = this.clients.get(clientId)
		if (!client) return
		this.clients.delete(clientId)
		client.queue = []
		client.queuedBytes = 0
		this.emit("client-disconnected", clientId)
		this.log.info(
			{
				clientId,
				bytesWritten: client.bytesWritten,
				droppedBytes: client.droppedBytes,
				totalClients: this.clients.size,
			},
			`${this.label} client disconnected`,
		)
	}

	private align(chunk: Buffer): Buffer | null {
		const frame = this.frameBytes
		const data =
			this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk
		const usable = data.length - (data.length % frame)
		this.remainder =
			usable === data.length
				? Buffer.alloc(0)
				: Buffer.from(data.subarray(usable))
		return usable > 0 ? data.subarray(0, usable) : null
	}

	private enqueue(client: AudioClient, payload: Buffer): void {
		const response = client.response
		if (response.writableEnded || response.destroyed) {
			this.cleanup(client.id)
			return
		}
		if (
			client.waitingDrain &&
			Date.now() - client.lastProgressAt > this.stallTimeoutMs
		) {
			this.log.warn(
				{ clientId: client.id, droppedBytes: client.droppedBytes },
				`Disconnecting stalled ${this.label} client`,
			)
			this.close(client, "stalled", true)
			return
		}
		client.queue.push(payload)
		client.queuedBytes += payload.length
		this.flush(client)
		this.trim(client)
	}

	/** Drops the oldest queued audio beyond about one second. */
	private trim(client: AudioClient): void {
		let excess = client.queuedBytes - this.queueLimit
		if (excess <= 0) return
		const frame = this.frameBytes
		excess = Math.ceil(excess / frame) * frame
		if (client.droppedBytes === 0) {
			this.log.warn(
				{ clientId: client.id, limitBytes: this.queueLimit },
				`${this.label} client is slow; dropping its oldest audio`,
			)
		}
		while (excess > 0 && client.queue.length > 0) {
			const head = client.queue[0]!
			if (head.length <= excess) {
				client.queue.shift()
				excess -= head.length
				client.queuedBytes -= head.length
				client.droppedBytes += head.length
			} else {
				client.queue[0] = head.subarray(excess)
				client.queuedBytes -= excess
				client.droppedBytes += excess
				excess = 0
			}
		}
	}

	private flush(client: AudioClient): void {
		const response = client.response
		while (!client.waitingDrain && client.queue.length > 0) {
			const next = client.queue.shift()!
			client.queuedBytes -= next.length
			let accepted: boolean
			try {
				accepted = response.write(next)
			} catch (err) {
				this.log.debug(
					{ clientId: client.id, err },
					`Error writing ${this.label} chunk`,
				)
				this.cleanup(client.id)
				return
			}
			client.bytesWritten += next.length
			this.bytesStreamed += next.length
			if (accepted) {
				client.lastProgressAt = Date.now()
			} else {
				client.waitingDrain = true
				response.once("drain", () => {
					client.waitingDrain = false
					client.lastProgressAt = Date.now()
					if (this.clients.get(client.id) === client) this.flush(client)
				})
			}
		}
	}
}

/**
 * Answers one GET for a stream: writes the self-describing headers (and the
 * WAV header for `.wav`) and registers the response as a streaming client.
 */
export function acceptAudioStream(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	registry: AudioClientRegistry,
	stream: StreamFormat,
	wav: boolean,
): AudioClient {
	res.writeHead(200, {
		"Content-Type": wav ? "audio/wav" : "application/octet-stream",
		Connection: "keep-alive",
		...streamHeaders(stream),
	})
	req.socket.setNoDelay(true)
	if (wav) res.write(wavStreamHeader(stream))
	else res.flushHeaders()
	const remoteAddress = `${req.socket.remoteAddress ?? "unknown"}:${req.socket.remotePort ?? "?"}`
	return registry.register(res, remoteAddress, stream)
}

/** A stream endpoint resolved from a request path. */
export interface AudioRoute {
	registry: AudioClientRegistry
	stream: StreamFormat
	wav: boolean
}

/**
 * Splits "<base>" / "<base>.wav" request paths: returns the base path and
 * whether the WAV form was requested.
 */
export function parseStreamPath(url: string | undefined): {
	base: string
	wav: boolean
} {
	const path = (url ?? "").split("?")[0] ?? ""
	if (path.endsWith(".wav")) return { base: path.slice(0, -4), wav: true }
	return { base: path, wav: false }
}

/**
 * HTTP server for PCM stream endpoints. `resolve` maps a GET path to a
 * stream (or null for 404). close() does not wait on streaming clients.
 */
export class AudioHttpServer {
	private server: http.Server | null = null
	private readonly log: Logger
	private readonly label: string
	private readonly resolve: (req: http.IncomingMessage) => AudioRoute | null
	private readonly onError: (err: Error) => void

	constructor(
		log: Logger,
		label: string,
		resolve: (req: http.IncomingMessage) => AudioRoute | null,
		onError: (err: Error) => void,
	) {
		this.log = log
		this.label = label
		this.resolve = resolve
		this.onError = onError
	}

	get listening(): boolean {
		return this.server !== null
	}

	async start(port: number, host = "0.0.0.0"): Promise<void> {
		if (this.server) return
		const server = createServer((req, res) => this.handle(req, res))
		this.server = server
		server.on("error", err => {
			this.log.error({ err }, `${this.label} HTTP server error`)
			this.onError(err)
		})
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject)
				server.listen(port, host, () => {
					server.off("error", reject)
					resolve()
				})
			})
		} catch (err) {
			if (this.server === server) this.server = null
			throw err
		}
	}

	/** Closes the server; callers close their registries' clients first. */
	async close(): Promise<void> {
		const server = this.server
		if (!server) return
		server.closeAllConnections()
		await new Promise<void>(resolve => {
			server.close(err => {
				if (err) this.log.warn({ err }, `Error closing ${this.label} server`)
				resolve()
			})
		})
		if (this.server === server) this.server = null
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const route = req.method === "GET" ? this.resolve(req) : null
		if (!route) {
			res.statusCode = 404
			res.end("Not Found")
			return
		}
		acceptAudioStream(req, res, route.registry, route.stream, route.wav)
	}
}
