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
 *   flagged encrypted is muted (dsd-fme also mutes it): silence plus
 *   `encrypted: true`. In stereo only that call's slot is silenced.
 *
 * Endpoints on httpPort (default 8082): /stream and /stream.wav serve the
 * first configured dsd-fme decoder; /decoders/<id>/stream[.wav] serve each
 * decoder, including scanner probes added at runtime (addChannel).
 * Format is fixed for the stream's life (8000 Hz mono s16le), so clients are
 * never disconnected between calls.
 */

import * as dgram from "node:dgram"
import type { NodeHttpAccessOptions } from "../access/node-http-adapter.js"
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
	dsdFmeDatagramBytes,
	type VoiceChannels,
} from "./dsd-fme-voice-format.js"
import { PacedPcmStream } from "./paced-pcm-stream.js"
import type { VoiceTap, VoiceTapSource } from "./auto-listen/contract.js"

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
	colourCode?: number
	nac?: string
	algorithmId?: string
	keyId?: string
	ran?: number
	errors?: { crc: number; fec: number }
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
	/** Borrowed shared protected policy/session/lease authority. */
	httpAccess?: NodeHttpAccessOptions
	/** Canonical configured public origin; never inferred from listener binding. */
	publicOrigin?: string
	httpHost?: string
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

const META_FIELDS = [
	"colourCode",
	"ran",
	"nac",
	"algorithmId",
	"keyId",
	"errors",
] as const

type MetaField = (typeof META_FIELDS)[number]

/** Invalid optional metadata becomes undefined instead of failing the call. */
function lenient<T>(schema: z.ZodType<T>) {
	return schema.optional().catch(undefined)
}

function lenientHex(maxLength: number) {
	const pattern = new RegExp(`^[0-9A-F]{1,${maxLength}}$`)
	return z.preprocess(
		value => (typeof value === "string" ? value.trim().toUpperCase() : value),
		z.string().regex(pattern).optional().catch(undefined),
	)
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
	/** DMR colour code 0–15. */
	colourCode: lenient(z.number().int().min(0).max(15)),
	/** NXDN RAN 0–63. */
	ran: lenient(z.number().int().min(0).max(63)),
	/** P25 NAC, upper-case hex, 1–4 digits. */
	nac: lenientHex(4),
	/** Encryption algorithm id, upper-case hex, 1–8 digits. */
	algorithmId: lenientHex(8),
	/** Encryption key id, upper-case hex, 1–8 digits. */
	keyId: lenientHex(8),
	errors: lenient(
		z.object({
			crc: z.number().int().nonnegative(),
			fec: z.number().int().nonnegative(),
		}),
	),
})

function droppedMetadataFields(
	raw: unknown,
	parsed: Partial<Record<MetaField, unknown>>,
): MetaField[] {
	if (typeof raw !== "object" || raw === null) return []
	const record = raw as Record<string, unknown>
	const dropped: MetaField[] = []
	for (const field of META_FIELDS) {
		if (record[field] !== undefined && parsed[field] === undefined) {
			dropped.push(field)
		}
	}
	return dropped
}

const DEFAULT_UDP_RECEIVE_BUFFER_BYTES = 32 * 1024

interface VoiceChannel {
	decoderId: string
	/** "scanner": a probe channel added at runtime; never served on /stream. */
	owner: "config" | "scanner"
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
	/** Datagrams of an unexpected (but frame-aligned) size: logged once. */
	oddSized: number
	encryptedDropped: number
	lastDatagramAt: Date | null
	detach: (() => void) | null
}

function isDsdFmeMode(value: unknown): value is DsdFmeMode {
	return DSD_FME_MODES.includes(value as DsdFmeMode)
}

export class DigitalVoiceService
	extends EventEmitter
	implements VoiceTapSource
{
	private readonly log: Logger
	private readonly config: DigitalVoiceConfig
	private readonly options: Required<
		Omit<DigitalVoiceServiceOptions, "httpAccess" | "publicOrigin" | "httpHost">
	> &
		Pick<DigitalVoiceServiceOptions, "httpAccess" | "publicOrigin" | "httpHost">
	private readonly channels: Map<string, VoiceChannel> = new Map()
	private readonly http: AudioHttpServer
	private running = false
	private lastError: string | null = null
	private starting: Promise<void> | null = null
	/** Optional voice-call fields dropped because they failed validation. */
	private metadataDrops = 0
	private metadataDropLogged = false
	/** Auto listen route taps (auto-listen-route 3.3); empty unless `/auto` has a client. */
	private readonly voiceTaps = new Set<VoiceTap>()
	private voiceTapFailureLogged = false

	constructor(
		logger: Logger,
		config: DigitalVoiceConfig,
		options: DigitalVoiceServiceOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "DigitalVoice")
		this.config = config
		this.options = {
			...options,
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
			options.httpAccess,
		)
	}

	/** Rate of the mono voice handed to taps (8 kHz s16le). */
	get voiceSampleRate(): number {
		return STREAM.rate
	}

	/**
	 * Registers an auto listen route tap: decoded, encryption-muted mono voice per datagram
	 * (even with no client on this service's own streams), every call event and every detach.
	 * Returns its remover. This service's own streams, pacing and counters are unchanged.
	 */
	addVoiceTap(tap: VoiceTap): () => void {
		this.voiceTaps.add(tap)
		return () => {
			this.voiceTaps.delete(tap)
		}
	}

	private notifyTaps(fn: (tap: VoiceTap) => void): void {
		for (const tap of this.voiceTaps) {
			try {
				fn(tap)
			} catch {
				this.noteTapFailure()
			}
		}
	}

	/** A fixed message: no property of the thrown value is read (it is untrusted). */
	private noteTapFailure(): void {
		if (this.voiceTapFailureLogged) return
		this.voiceTapFailureLogged = true
		this.log.warn("Auto listen voice tap failed")
	}

	/** Invalid optional call-metadata fields dropped so far. */
	get metadataFieldDrops(): number {
		return this.metadataDrops
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
			let channel: VoiceChannel
			try {
				channel = await this.createChannel(config, "config")
			} catch (err) {
				// The decoder still runs, with call metadata only (-o null).
				this.log.error(
					{ err, decoderId: config.id },
					"Could not bind a digital voice UDP socket; voice disabled for this decoder",
				)
				prepared.push(config)
				continue
			}
			this.channels.set(config.id, channel)
			prepared.push(this.routeConfig(config, channel))
		}
		return prepared
	}

	/**
	 * Binds a voice socket for a scanner probe and returns its config routed
	 * to it (spec § 6.5). Unchanged when digital voice is disabled or the
	 * config sets its own output. Does not start the server: ensureStarted().
	 */
	async addChannel(config: DecoderConfig): Promise<DecoderConfig> {
		if (!this.config.enabled || !this.isEligible(config)) return config
		if (this.channels.has(config.id)) {
			throw new WaveKitError(
				`Digital voice channel already exists: ${config.id}`,
				"DIGITAL_VOICE_CHANNEL_EXISTS",
			)
		}
		const channel = await this.createChannel(config, "scanner")
		if (this.channels.has(config.id)) {
			// A concurrent addChannel for the same id bound first.
			channel.socket.close()
			throw new WaveKitError(
				`Digital voice channel already exists: ${config.id}`,
				"DIGITAL_VOICE_CHANNEL_EXISTS",
			)
		}
		this.channels.set(config.id, channel)
		return this.routeConfig(config, channel)
	}

	/** Disconnects the channel's listeners and releases its socket; no-op if unknown. */
	async removeChannel(decoderId: string): Promise<void> {
		const channel = this.channels.get(decoderId)
		if (!channel) return
		this.channels.delete(decoderId)
		channel.detach?.()
		channel.paced.stop()
		channel.registry.closeAll("removed", true)
		channel.socket.close()
		this.notifyTaps(tap => tap.detach(decoderId))
		this.emit("clients-changed")
		this.log.info({ decoderId }, "Digital voice channel removed")
	}

	/** Starts the HTTP server if it is not running (lazy start for the first probe). */
	async ensureStarted(): Promise<void> {
		if (this.running) return
		await this.start()
	}

	private routeConfig(
		config: DecoderConfig,
		channel: VoiceChannel,
	): DecoderConfig {
		const voiceSlot = config.options["voiceSlot"] ?? this.config.voiceSlot
		this.log.info(
			{
				decoderId: config.id,
				owner: channel.owner,
				udpPort: channel.port,
				mode: channel.mode,
				channels: channel.channels,
				voiceSlot,
			},
			"dsd-fme voice routed to the digital voice stream",
		)
		return {
			...config,
			options: {
				...config.options,
				output: "udp",
				udpHost: "127.0.0.1",
				udpPort: channel.port,
				voiceSlot,
			},
		}
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

	/**
	 * Starts the HTTP server. A call while a start is in flight (the boot
	 * start racing a probe's ensureStarted()) joins it: one http.start.
	 */
	async start(): Promise<void> {
		if (this.running) {
			this.log.warn("Digital voice stream already running")
			return
		}
		this.starting ??= this.startServer().finally(() => {
			this.starting = null
		})
		await this.starting
	}

	private async startServer(): Promise<void> {
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
			await this.http.start(this.config.httpPort, this.options.httpHost)
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

	/** Stop HTTP admission immediately, before global route draining. */
	shutdownAdmission(): void {
		this.http.shutdownAdmission()
	}

	stopAdmission(): void {
		this.http.stopAdmission()
	}

	async stop(): Promise<void> {
		this.stopAdmission()
		if (!this.running) return
		this.running = false
		for (const channel of this.channels.values()) {
			channel.paced.stop()
			channel.registry.closeAll("stop", true)
			this.notifyTaps(tap => tap.detach(channel.decoderId))
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
			this.notifyTaps(tap => tap.detach(channel.decoderId))
		}
		this.channels.clear()
	}

	getStatus(): DigitalVoiceStatus {
		const decoders = [...this.channels.values()].map(channel =>
			this.channelStatus(channel),
		)
		const first = decoders.find(
			d => this.channels.get(d.decoderId)?.owner === "config",
		)
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

	private async createChannel(
		config: DecoderConfig,
		owner: "config" | "scanner",
	): Promise<VoiceChannel> {
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
			owner,
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
			oddSized: 0,
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
		// `own`: this service's stream is paced. Taps alone never move its counters (7.2).
		const own = channel.paced.running
		if (!this.running || (!own && this.voiceTaps.size === 0)) return
		const call = channel.call
		const encrypted = call?.active === true && call.encrypted
		const slot = call?.slot
		if (encrypted && (channel.channels === 1 || (slot !== 1 && slot !== 2))) {
			// Mono, or the slot is unknown: the whole datagram may be that call.
			if (own) channel.encryptedDropped++
			return
		}
		const mono = downmixDsdFmeDatagram(
			datagram,
			channel.channels,
			// Stereo: mute only the encrypted call's slot; a clear call on the
			// other slot keeps playing (dsd-fme zero-fills the muted slot too).
			encrypted && (slot === 1 || slot === 2) ? { muteSlot: slot } : {},
		)
		if (
			own &&
			mono &&
			datagram.length % dsdFmeDatagramBytes(channel.channels) !== 0
		) {
			if (channel.oddSized === 0) {
				this.log.warn(
					{
						decoderId: channel.decoderId,
						bytes: datagram.length,
						expectedMultipleOf: dsdFmeDatagramBytes(channel.channels),
						channels: channel.channels,
					},
					"Unexpected dsd-fme voice datagram size: is the mode or output format overridden?",
				)
			}
			channel.oddSized++
		}
		if (!mono) {
			if (!own) return
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
		// Inline loop: no closure per datagram.
		for (const tap of this.voiceTaps) {
			try {
				tap.frame(channel.decoderId, mono, channel.call)
			} catch {
				this.noteTapFailure()
			}
		}
		if (!own) return
		if (encrypted) channel.encryptedDropped++
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
		const dropped = droppedMetadataFields(raw, state)
		if (dropped.length > 0) this.noteMetadataDrop(channel.decoderId, dropped)
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
			...(state.colourCode !== undefined
				? { colourCode: state.colourCode }
				: {}),
			...(state.nac !== undefined ? { nac: state.nac } : {}),
			...(state.algorithmId !== undefined
				? { algorithmId: state.algorithmId }
				: {}),
			...(state.keyId !== undefined ? { keyId: state.keyId } : {}),
			...(state.ran !== undefined ? { ran: state.ran } : {}),
			...(state.errors !== undefined ? { errors: state.errors } : {}),
		}
		channel.paced.setCallActive(call.active)
		if (call.active) {
			channel.call = call
			// Never play audio of an encrypted call, even if some was queued.
			if (call.encrypted) channel.paced.clear()
		} else {
			channel.call = null
			channel.lastCall = call
		}
		if (this.voiceTaps.size > 0)
			this.notifyTaps(tap => tap.call(channel.decoderId, call))
		this.emit("call", call)
	}

	private resolveRoute(req: http.IncomingMessage): AudioRoute | null {
		const { base, wav } = parseStreamPath(req.url)
		let channel: VoiceChannel | undefined
		if (base === "/stream") {
			// /stream is the configured decoders' stream; probes come and go.
			channel = [...this.channels.values()].find(c => c.owner === "config")
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
		return `${this.options.publicOrigin ?? `http://localhost:${this.config.httpPort}`}${path}`
	}

	/** Count every dropped field. Log only the first drop for this process. */
	private noteMetadataDrop(decoderId: string, fields: readonly string[]): void {
		this.metadataDrops += fields.length
		if (this.metadataDropLogged) return
		this.metadataDropLogged = true
		this.log.warn(
			{ decoderId, fields, metadataFieldDrops: this.metadataDrops },
			"Dropped invalid digital voice call metadata",
		)
	}

	private emitError(err: Error): void {
		if (this.listenerCount("error") > 0) this.emit("error", err)
	}
}
