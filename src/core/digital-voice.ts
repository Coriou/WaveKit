/**
 * Digital voice stream: decoded dsd-fme voice (AMBE/IMBE via mbelib) as a
 * continuous HTTP PCM stream with per-call metadata, like live analog audio.
 *
 * - Before decoders are created, prepareDecoderConfigs() binds one loopback
 *   UDP socket per eligible dsd-fme decoder and points the decoder at it
 *   (`-o udp:127.0.0.1:<port>`, `-V` slot selection).
 * - Each datagram (8 kHz s16le, stereo in auto/DMR modes) is validated,
 *   mixed to mono and queued in a bounded jitter buffer; a timer emits
 *   constant-rate audio with exact silence between calls. The timer runs
 *   only while a stream has clients; without one, voice is discarded.
 * - Call state comes from the decoder's "voice-call" events, published in
 *   the same tick as its call_start / call_end outputs. Audio of a call
 *   flagged encrypted is discarded (dsd-fme also mutes it): silence plus
 *   `encrypted: true`.
 *
 * Endpoints on httpPort (default 8082): /stream and /stream.wav serve the
 * first dsd-fme decoder; /decoders/<id>/stream[.wav] serve each decoder.
 * Format is fixed for the stream's life (8000 Hz mono s16le), so clients are
 * never disconnected between calls.
 */

import * as dgram from "node:dgram"
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { z } from "zod"
import type { DigitalVoiceConfig } from "../config.js"
import type { DecoderConfig } from "../decoders/types.js"
import {
	DSD_FME_MODES,
	dsdFmeUdpChannels,
	type DsdFmeMode,
} from "../decoders/builtin/dsd-fme.js"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
	parseStreamPath,
	type AudioRoute,
	type StreamFormat,
} from "./audio-stream-server.js"
import {
	DSD_FME_VOICE_SAMPLE_RATE,
	downmixDsdFmeDatagram,
	type VoiceChannels,
} from "./dsd-fme-voice-format.js"
import { PacedPcmStream } from "./paced-pcm-stream.js"

export type { DigitalVoiceConfig } from "../config.js"

export interface DigitalVoiceCall {
	decoderId: string
	callId: string
	protocol: string | null
	talkgroup: number | null
	source: number | null
	slot: number | null
	encrypted: boolean
	active: boolean
	startedAt: string
	endedAt?: string
}

export interface DigitalVoiceDecoderStatus {
	decoderId: string
	mode: string
	udpPort: number
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	datagramsReceived: number
	datagramsRejected: number
	encryptedDatagramsDropped: number
	droppedSamples: number
	underruns: number
	bufferedMs: number
	lastDatagramAt?: string
	call: DigitalVoiceCall | null
	lastCall?: DigitalVoiceCall
}

export interface DigitalVoiceStatus {
	enabled: boolean
	running: boolean
	config: DigitalVoiceConfig
	sampleRate: number
	audioFormat: "s16le"
	channels: 1
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	decoders: DigitalVoiceDecoderStatus[]
	call: DigitalVoiceCall | null
	lastError?: string
}

export interface DigitalVoiceServiceOptions {
	/** Pacing timer period (default 20 ms, one vocoder frame). */
	tickMs?: number
	/** A client that accepts nothing for this long is disconnected. */
	clientStallTimeoutMs?: number
	/** Kernel receive buffer per UDP socket (bounded; default 32 KiB). */
	udpReceiveBufferBytes?: number
}

export interface DigitalVoiceEvents {
	call: (call: DigitalVoiceCall) => void
	started: () => void
	stopped: () => void
	"clients-changed": () => void
	error: (error: Error) => void
}

/** Something that publishes dsd-fme "voice-call" events (a DsdFmeDecoder). */
export interface VoiceCallSource {
	on(event: "voice-call", listener: (state: unknown) => void): unknown
	off(event: "voice-call", listener: (state: unknown) => void): unknown
}

const STREAM: StreamFormat = {
	rate: DSD_FME_VOICE_SAMPLE_RATE,
	format: "s16le",
}

const VoiceCallStateSchema = z.object({
	callId: z.string().min(1),
	protocol: z.string().nullable(),
	talkgroup: z.number().nullable(),
	source: z.number().nullable(),
	slot: z.number().nullable(),
	encrypted: z.boolean(),
	active: z.boolean(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
})

const DEFAULT_UDP_RECEIVE_BUFFER_BYTES = 32 * 1024

interface VoiceChannel {
	decoderId: string
	mode: DsdFmeMode
	channels: VoiceChannels
	socket: dgram.Socket
	port: number
	paced: PacedPcmStream
	registry: AudioClientRegistry
	call: DigitalVoiceCall | null
	lastCall: DigitalVoiceCall | null
	datagrams: number
	rejected: number
	encryptedDropped: number
	lastDatagramAt: Date | null
	detach: (() => void) | null
}

function isDsdFmeMode(value: unknown): value is DsdFmeMode {
	return DSD_FME_MODES.includes(value as DsdFmeMode)
}

export class DigitalVoiceService extends EventEmitter {
	private readonly log: Logger
	private readonly config: DigitalVoiceConfig
	private readonly options: Required<DigitalVoiceServiceOptions>
	private readonly channels: Map<string, VoiceChannel> = new Map()
	private readonly http: AudioHttpServer
	private running = false
	private lastError: string | null = null

	constructor(
		logger: Logger,
		config: DigitalVoiceConfig,
		options: DigitalVoiceServiceOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "DigitalVoice")
		this.config = config
		this.options = {
			tickMs: options.tickMs ?? 20,
			clientStallTimeoutMs: options.clientStallTimeoutMs ?? 30_000,
			udpReceiveBufferBytes:
				options.udpReceiveBufferBytes ?? DEFAULT_UDP_RECEIVE_BUFFER_BYTES,
		}
		this.http = new AudioHttpServer(
			this.log,
			"Digital voice",
			req => this.resolveRoute(req),
			err => this.emitError(err),
		)
	}

	get enabled(): boolean {
		return this.config.enabled
	}

	/**
	 * Binds a voice socket for every eligible dsd-fme decoder and returns the
	 * configs with `output: "udp"` pointed at it. Eligible: digital voice
	 * enabled, type dsd-fme, and `output` unset (or "udp" without a port). A
	 * decoder that sets output itself keeps its own choice.
	 */
	async prepareDecoderConfigs(
		configs: readonly DecoderConfig[],
	): Promise<DecoderConfig[]> {
		if (!this.config.enabled) return [...configs]
		const prepared: DecoderConfig[] = []
		for (const config of configs) {
			if (!this.isEligible(config) || this.channels.has(config.id)) {
				prepared.push(config)
				continue
			}
			const channel = await this.createChannel(config)
			this.channels.set(config.id, channel)
			const voiceSlot = config.options["voiceSlot"] ?? this.config.voiceSlot
			prepared.push({
				...config,
				options: {
					...config.options,
					output: "udp",
					udpHost: "127.0.0.1",
					udpPort: channel.port,
					voiceSlot,
				},
			})
			this.log.info(
				{
					decoderId: config.id,
					udpPort: channel.port,
					mode: channel.mode,
					channels: channel.channels,
					voiceSlot,
				},
				"dsd-fme voice routed to the digital voice stream",
			)
		}
		return prepared
	}

	/** Follows a decoder's call state (its "voice-call" events). */
	attachDecoder(decoderId: string, source: VoiceCallSource): void {
		const channel = this.channels.get(decoderId)
		if (!channel) return
		channel.detach?.()
		const listener = (state: unknown) => this.handleVoiceCall(channel, state)
		source.on("voice-call", listener)
		channel.detach = () => source.off("voice-call", listener)
	}

	async start(): Promise<void> {
		if (this.running) {
			this.log.warn("Digital voice stream already running")
			return
		}
		if (this.channels.size === 0) {
			const err = new WaveKitError(
				this.config.enabled
					? "No dsd-fme decoder streams voice (none configured, or each sets its own output)"
					: "Digital voice is disabled in config (digitalVoice.enabled); enable it and restart",
				"DIGITAL_VOICE_UNAVAILABLE",
			)
			this.lastError = err.message
			throw err
		}
		try {
			await this.http.start(this.config.httpPort)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.lastError = error.message
			this.emitError(error)
			throw error
		}
		this.running = true
		for (const channel of this.channels.values()) {
			if (channel.registry.size > 0) channel.paced.start()
		}
		this.lastError = null
		this.emit("started")
		this.log.info(
			{ httpPort: this.config.httpPort, decoders: [...this.channels.keys()] },
			"Digital voice stream started",
		)
	}

	async stop(): Promise<void> {
		if (!this.running) return
		this.running = false
		for (const channel of this.channels.values()) {
			channel.paced.stop()
			channel.registry.closeAll("stop", true)
		}
		await this.http.close()
		this.emit("stopped")
		this.log.info("Digital voice stream stopped")
	}

	/** Stops the stream and releases the UDP sockets (shutdown only). */
	async destroy(): Promise<void> {
		await this.stop()
		for (const channel of this.channels.values()) {
			channel.detach?.()
			channel.socket.close()
		}
		this.channels.clear()
	}

	getStatus(): DigitalVoiceStatus {
		const decoders = [...this.channels.values()].map(channel =>
			this.channelStatus(channel),
		)
		const first = decoders[0]
		const status: DigitalVoiceStatus = {
			enabled: this.config.enabled,
			running: this.running,
			config: { ...this.config },
			sampleRate: STREAM.rate,
			audioFormat: "s16le",
			channels: 1,
			httpUrl: first?.httpUrl ?? this.url("/stream"),
			wavUrl: first?.wavUrl ?? this.url("/stream.wav"),
			clientCount: decoders.reduce((sum, d) => sum + d.clientCount, 0),
			bytesStreamed: decoders.reduce((sum, d) => sum + d.bytesStreamed, 0),
			decoders,
			call: decoders.find(d => d.call?.active)?.call ?? null,
		}
		if (this.lastError) status.lastError = this.lastError
		return status
	}

	private isEligible(config: DecoderConfig): boolean {
		if (config.type !== "dsd-fme") return false
		const output = config.options["output"]
		if (output === undefined) return true
		return output === "udp" && config.options["udpPort"] === undefined
	}

	private async createChannel(config: DecoderConfig): Promise<VoiceChannel> {
		const modeOption = config.options["mode"] ?? "auto"
		const mode: DsdFmeMode = isDsdFmeMode(modeOption) ? modeOption : "auto"
		const socket = dgram.createSocket({
			type: "udp4",
			recvBufferSize: this.options.udpReceiveBufferBytes,
		})
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject)
			socket.bind(0, "127.0.0.1", () => {
				socket.off("error", reject)
				resolve()
			})
		})
		const registry = new AudioClientRegistry(this.log, {
			stallTimeoutMs: this.options.clientStallTimeoutMs,
			label: "Digital voice",
			stream: STREAM,
		})
		const paced = new PacedPcmStream({
			sampleRate: STREAM.rate,
			tickMs: this.options.tickMs,
			jitterBufferMs: this.config.jitterBufferMs,
			maxBufferMs: this.config.maxBufferMs,
		})
		const channel: VoiceChannel = {
			decoderId: config.id,
			mode,
			channels: dsdFmeUdpChannels(mode),
			socket,
			port: socket.address().port,
			paced,
			registry,
			call: null,
			lastCall: null,
			datagrams: 0,
			rejected: 0,
			encryptedDropped: 0,
			lastDatagramAt: null,
			detach: null,
		}
		paced.on("audio", (chunk: Buffer) => registry.write(chunk))
		// Pace only while someone listens: with no client, voice is discarded
		// and the stream costs nothing.
		registry.on("client-connected", () => {
			if (this.running) paced.start()
			this.emit("clients-changed")
		})
		registry.on("client-disconnected", () => {
			if (registry.size === 0) paced.stop()
			this.emit("clients-changed")
		})
		socket.on("message", (msg: Buffer) => this.ingest(channel, msg))
		socket.on("error", err => {
			this.log.warn(
				{ err, decoderId: channel.decoderId },
				"Digital voice UDP socket error",
			)
		})
		return channel
	}

	private ingest(channel: VoiceChannel, datagram: Buffer): void {
		channel.datagrams++
		channel.lastDatagramAt = new Date()
		if (!this.running || !channel.paced.running) return
		const mono = downmixDsdFmeDatagram(datagram, channel.channels)
		if (!mono) {
			if (channel.rejected === 0) {
				this.log.warn(
					{
						decoderId: channel.decoderId,
						bytes: datagram.length,
						channels: channel.channels,
					},
					"Rejected a malformed dsd-fme voice datagram",
				)
			}
			channel.rejected++
			return
		}
		if (channel.call?.active && channel.call.encrypted) {
			channel.encryptedDropped++
			return
		}
		channel.paced.push(mono)
	}

	private handleVoiceCall(channel: VoiceChannel, raw: unknown): void {
		const parsed = VoiceCallStateSchema.safeParse(raw)
		if (!parsed.success) {
			this.log.warn(
				{ decoderId: channel.decoderId, issues: parsed.error.issues },
				"Ignoring a malformed voice-call event",
			)
			return
		}
		const state = parsed.data
		const call: DigitalVoiceCall = {
			decoderId: channel.decoderId,
			callId: state.callId,
			protocol: state.protocol,
			talkgroup: state.talkgroup,
			source: state.source,
			slot: state.slot,
			encrypted: state.encrypted,
			active: state.active,
			startedAt: state.startedAt,
			...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
		}
		if (call.active) {
			channel.call = call
			// Never play audio of an encrypted call, even if some was queued.
			if (call.encrypted) channel.paced.clear()
		} else {
			channel.call = null
			channel.lastCall = call
		}
		this.emit("call", call)
	}

	private resolveRoute(req: http.IncomingMessage): AudioRoute | null {
		const { base, wav } = parseStreamPath(req.url)
		let channel: VoiceChannel | undefined
		if (base === "/stream") {
			channel = this.channels.values().next().value
		} else {
			const match = /^\/decoders\/([^/]+)\/stream$/.exec(base)
			if (match?.[1]) {
				try {
					channel = this.channels.get(decodeURIComponent(match[1]))
				} catch {
					channel = undefined
				}
			}
		}
		if (!channel) return null
		return { registry: channel.registry, stream: STREAM, wav }
	}

	private channelStatus(channel: VoiceChannel): DigitalVoiceDecoderStatus {
		const base = `/decoders/${encodeURIComponent(channel.decoderId)}/stream`
		const status: DigitalVoiceDecoderStatus = {
			decoderId: channel.decoderId,
			mode: channel.mode,
			udpPort: channel.port,
			httpUrl: this.url(base),
			wavUrl: this.url(`${base}.wav`),
			clientCount: channel.registry.size,
			bytesStreamed: channel.registry.bytesStreamed,
			datagramsReceived: channel.datagrams,
			datagramsRejected: channel.rejected,
			encryptedDatagramsDropped: channel.encryptedDropped,
			droppedSamples: channel.paced.stats.droppedSamples,
			underruns: channel.paced.stats.underruns,
			bufferedMs: channel.paced.bufferedMs,
			call: channel.call,
		}
		if (channel.lastDatagramAt) {
			status.lastDatagramAt = channel.lastDatagramAt.toISOString()
		}
		if (channel.lastCall) status.lastCall = channel.lastCall
		return status
	}

	private url(path: string): string {
		return `http://localhost:${this.config.httpPort}${path}`
	}

	private emitError(err: Error): void {
		if (this.listenerCount("error") > 0) this.emit("error", err)
	}
}
