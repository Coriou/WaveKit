/**
 * In-process fake-link fixture for the auto listen route acceptance (docs/specs/auto-listen-route,
 * design "Fake-link acceptance plan"): the real `LiveDemodulator` on fake CSDR stages with the
 * real evidence pre-roll, the real `DigitalVoiceService` fed through loopback UDP (127.0.0.1,
 * OS-assigned ports), a coverage port stub with the seam's yes/no/unknown answers and generation
 * counter, an injected router clock and `/auto` clients (HTTP on 127.0.0.1 port 0, or in memory).
 */
import * as dgram from "node:dgram"
import { EventEmitter } from "node:events"
import * as http from "node:http"
import type { LiveAudioAutoRouteLevel } from "@wavekit/api-types"
import {
	DigitalVoiceConfigSchema,
	LiveDemodConfigSchema,
} from "../../../../src/config.js"
import { AUTO_ROUTE_STREAM } from "../../../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
} from "../../../../src/core/auto-listen/contract.js"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import type { AutoListenRouter } from "../../../../src/core/auto-listen/router.js"
import type { StreamFormat } from "../../../../src/core/audio-stream-server.js"
import { DigitalVoiceService } from "../../../../src/core/digital-voice.js"
import type {
	EvidenceSquelchFactory,
	PreRollPort,
} from "../../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import type { LiveDemodulator } from "../../../../src/core/live-demodulator.js"
import type { PreRollShadow } from "../../../../src/core/auto-listen/preroll-shadow.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { createLogger } from "../../../../src/utils/logger.js"
import {
	ClientTransport,
	createFakeFanout,
	createFakeSourceManager,
	FakeProcess,
	ManualClock,
	waitFor,
} from "../live-demodulator-continuity-fakes.js"
import { FakeGate } from "../live-demodulator-evidence-fakes.js"
import { feed } from "./helpers.js"

export const logger = createLogger({ level: "fatal" })
/** The `Host` the live-audio listener sees (legacy access accepts any). */
const AUTHORITY = "receiver.local:41234"

export class RouteClock implements AutoRouteClock {
	t = 0
	private fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
	/** Advances the clock and runs the pacer once (a late tick when `ms` > 20). */
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
	/** Advances without running the pacer (an event-loop stall). */
	stall(ms: number): void {
		this.t += ms
	}
}

/**
 * Coverage port stub with the MAIN-NEEDED seam semantics: `generation` increments at every
 * event that can change coverage (here the demodulator's `config-changed`, plus explicit
 * `bump()` calls standing in for VFO settles and decoder status changes); `covers` answers
 * per decoder and counts its calls.
 */
export class CoverageStub implements VoiceCoveragePort {
	generation = 1
	readonly answers = new Map<string, VoiceCoverage>()
	readonly calls: Array<{ id: string; generation: number }> = []
	fallback: VoiceCoverage = "yes"
	covers(decoderId: string): VoiceCoverage {
		this.calls.push({ id: decoderId, generation: this.generation })
		return this.answers.get(decoderId) ?? this.fallback
	}
	bump(): void {
		this.generation++
	}
}

/** Mutable gate script for the evidence factory (read at each evidence build). */
export const evidenceScript = {
	latchByte: null as number | null,
	guardBytes: 0,
}

/** The real pre-roll with a scripted gate that latches at `evidenceScript.latchByte`. */
export const scriptedEvidence: EvidenceSquelchFactory = {
	createGate: options =>
		new FakeGate(options, evidenceScript.latchByte, evidenceScript.guardBytes),
	createPreRoll: options => new PreRoll(options),
}

export interface Span {
	bytes: Buffer
	audible: boolean
	stream: StreamFormat
}

interface Internals {
	http: {
		start(port: number, host?: string): Promise<void>
		server: http.Server | null
	}
	autoRoute: AutoListenRouter
	run: {
		squelch: object
		stream: StreamFormat
		evidence?: {
			preRoll: PreRollPort
			shadow: PreRollShadow | null
		} | null
	} | null
	handleAudioData(chunk: Buffer): void
	registerClient(response: unknown, remoteAddress: string): unknown
}

interface VoiceInternals {
	http: { start(port: number, host?: string): Promise<void> }
}

export interface HarnessOptions {
	config?: Record<string, unknown>
	factory?: EvidenceSquelchFactory
	/** Digital voice decoder ids; none: `/auto` stays analog only. */
	decoders?: readonly string[]
}

const disposers: Array<() => Promise<void>> = []

export async function disposeAll(): Promise<void> {
	for (const dispose of disposers.splice(0).reverse()) await dispose()
}

function dsd(id: string): DecoderConfig {
	return { id, type: "dsd-fme", enabled: true, options: { mode: "auto" } }
}

/** One dsd-fme stereo datagram (both channels carry the same mono sample). */
export function stereoDatagram(mono: Int16Array): Buffer {
	const buf = Buffer.alloc(mono.length * 4)
	for (let i = 0; i < mono.length; i++) {
		const v = mono[i] ?? 0
		buf.writeInt16LE(v, i * 4)
		buf.writeInt16LE(v, i * 4 + 2)
	}
	return buf
}

/** 160 voice samples (20 ms at 8 kHz) of a deterministic waveform, frame `k` of a call. */
export function voiceFrame(k: number, seed: number): Int16Array {
	const out = new Int16Array(160)
	for (let i = 0; i < out.length; i++) {
		const n = k * 160 + i
		out[i] = Math.round(
			6_000 * Math.sin((2 * Math.PI * (300 + seed) * n) / 8_000) +
				2_000 * Math.sin((2 * Math.PI * 1_100 * n) / 8_000),
		)
	}
	return out
}

/** A voice-call event as dsd-fme emits it. */
export function callState(overrides: Record<string, unknown> = {}) {
	return {
		callId: "dsd-fme-call-1",
		protocol: "DMR",
		talkgroup: 9,
		source: 2_060_945,
		slot: 1,
		encrypted: false,
		active: true,
		startedAt: "2026-10-24T12:00:00.000Z",
		...overrides,
	}
}

/** Non-zero s16le samples whose two bytes are both non-zero (a muted sample is all zeros). */
export function ramp(samples: number, seed: number): Buffer {
	const out = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++) {
		const v = (seed + i) % 32_000
		out[2 * i] = 1 + (v % 254)
		out[2 * i + 1] = 1 + (Math.floor(v / 254) % 126)
	}
	return out
}

export function samplesOf(bytes: Buffer): Int16Array {
	const out = new Int16Array(Math.floor(bytes.length / 2))
	for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(2 * i)
	return out
}

/**
 * The analog reference, independent of the `/auto` wiring: the bytes a `/stream` client received
 * from the `/auto` connect on, through a fresh 48 kHz resampler. A `/stream` sample qualifies
 * exactly when it plays (the analog input is never zero while the squelch passes it, and muted
 * samples are zeros), so the input is split wherever that changes.
 */
export function analogReference(
	streamBytes: Buffer,
	rate: number,
): { samples: number[]; flags: number[] } {
	const input = samplesOf(streamBytes)
	const cuts: number[] = []
	for (let i = 1; i < input.length; i++)
		if ((input[i] !== 0) !== (input[i - 1] !== 0)) cuts.push(i)
	const flagOf = (sample: number): number => (input[sample] !== 0 ? 1 : 0)
	return feed(new PolyphaseResampler(rate, 48_000), input, cuts, 4_096, flagOf)
}

/** The digital reference: a call's voice through a fresh 8 → 48 kHz resampler plus its tail flush. */
export function digitalReference(frames: readonly Int16Array[]): number[] {
	const res = new PolyphaseResampler(8_000, 48_000)
	const total = frames.reduce((n, f) => n + f.length, 0)
	const input = new Int16Array(total + res.taps - 1)
	let at = 0
	for (const f of frames) {
		input.set(f, at)
		at += f.length
	}
	return feed(res, input, [], 4_096).samples
}

/** `/auto` samples (s16le) of a byte buffer. */
export function autoSamples(bytes: Buffer): number[] {
	const out: number[] = []
	for (let i = 0; i + 1 < bytes.length; i += 2) out.push(bytes.readInt16LE(i))
	return out
}

/** Index of the first differing element, -1 when equal. */
export function firstDifference(
	a: ArrayLike<number | boolean>,
	b: ArrayLike<number | boolean>,
): number {
	const n = Math.max(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
	return -1
}

export interface RouteChange {
	level: LiveAudioAutoRouteLevel
	/** Output sample index (since the pacer started) of the block the switch applies to. */
	at: number
	decoderId: string | undefined
	slot: number | null | undefined
}

/** An `/auto` client over HTTP on the live-audio listener (127.0.0.1, OS-assigned port). */
export interface HttpAutoClient {
	readonly status: number
	readonly headers: http.IncomingHttpHeaders
	received(): Buffer
	close(): void
}

export function httpAuto(
	port: number,
	path = "/auto",
): Promise<HttpAutoClient> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method: "GET",
				headers: { Host: AUTHORITY },
			},
			response => {
				response.on("data", (chunk: Buffer) => chunks.push(chunk))
				response.on("error", () => undefined)
				resolve({
					status: response.statusCode ?? 0,
					headers: response.headers,
					received: () => Buffer.concat(chunks),
					close: () => {
						response.destroy()
						req.destroy()
					},
				})
			},
		)
		req.on("error", reject)
		req.end()
	})
}

/** Lets loopback sockets move (UDP receipt, HTTP writes). */
export function yieldIo(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve))
}

/**
 * A started demodulator (fake stages, real pre-roll when `factory` is the scripted evidence) and,
 * with `decoders`, a started digital voice service attached through the coverage stub.
 */
export async function harness(options: HarnessOptions = {}) {
	const { LiveDemodulator: Demod } =
		await import("../../../../src/core/live-demodulator.js")
	const processes: FakeProcess[] = []
	const realKill = process.kill.bind(process)
	process.kill = ((pid: number, signal?: string | number): true => {
		const proc = processes.find(p => p.pid === Math.abs(pid))
		if (!proc) {
			const err = new Error("ESRCH") as NodeJS.ErrnoException
			err.code = "ESRCH"
			throw err
		}
		proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
		return true
	}) as typeof process.kill
	const routeClock = new RouteClock()
	const config = LiveDemodConfigSchema.parse({
		enabled: true,
		sourceId: "rtl-pi",
		// Never bound: the listener below is rebound to port 0.
		httpPort: 41_234,
		...options.config,
	})
	const sourceManager = createFakeSourceManager()
	const demod: LiveDemodulator = new Demod(
		logger,
		sourceManager as never,
		createFakeFanout() as never,
		config,
		{
			httpHost: "127.0.0.1",
			clock: new ManualClock(),
			restartBaseDelayMs: 1,
			autoRouteClock: routeClock,
			...(options.factory !== undefined
				? { evidenceSquelch: options.factory }
				: {}),
			spawnStage: (command: string) => {
				const proc = new FakeProcess(command)
				processes.push(proc)
				return proc as never
			},
		},
	)
	const internals = demod as unknown as Internals
	const start = internals.http.start.bind(internals.http)
	internals.http.start = () => start(0, "127.0.0.1")
	disposers.push(async () => {
		try {
			await demod.stop()
		} catch {
			// cleanup only
		}
		process.kill = realKill
	})
	await demod.start()
	const stage = { open: false }
	const script = () => {
		const run = internals.run
		if (run === null) throw new Error("no run")
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => stage.open,
		})
	}
	script()
	const router = internals.autoRoute

	// Every span the router is handed while it runs (the analog reference input).
	const spans: Span[] = []
	const push = router.pushAnalog.bind(router)
	router.pushAnalog = (chunk, s, e, audible, stream) => {
		if (router.wanted)
			spans.push({
				bytes: Buffer.from(chunk.subarray(s, e)),
				audible,
				stream,
			})
		push(chunk, s, e, audible, stream)
	}
	// Every block the router produced, by reference (Property 14 compares the clients' bytes).
	const blocks: Buffer[] = []
	const blockCopies: Buffer[] = []
	/** `router.underruns` after each block (an increment marks that block as an underrun). */
	const underrunsAfter: number[] = []
	const write = router.registry.write.bind(router.registry)
	router.registry.write = (chunk: Buffer) => {
		blocks.push(chunk)
		underrunsAfter.push(router.underruns)
		blockCopies.push(Buffer.from(chunk))
		write(chunk)
	}
	// The oracle's input: a `/stream` client from the start, and its byte count at the first
	// `/auto` connect (the `/auto` analog reference starts there).
	const witness = new ClientTransport()
	internals.registerClient(witness, "witness")
	let streamAtAuto: number | null = null
	router.registry.on("client-connected", () => {
		streamAtAuto ??= witness.received().length
	})
	const changes: RouteChange[] = []
	router.on("auto-route-changed", (level: LiveAudioAutoRouteLevel) => {
		const route = demod.getStatus().autoRoute
		changes.push({
			level,
			at: router.emittedSamples,
			decoderId: route?.decoderId,
			slot: route?.slot,
		})
	})

	const coverage = new CoverageStub()
	// The seam: live-audio `config-changed` and source `caps-changed` bump the generation.
	demod.on("config-changed", () => coverage.bump())
	sourceManager.on("caps-changed", () => coverage.bump())
	let service: DigitalVoiceService | null = null
	const decoders = new Map<string, EventEmitter>()
	const ports = new Map<string, number>()
	let sender: dgram.Socket | null = null
	if (options.decoders !== undefined && options.decoders.length > 0) {
		const voiceConfig = DigitalVoiceConfigSchema.parse({
			// Never bound: the listener below is rebound to port 0.
			httpPort: 41_235,
			jitterBufferMs: 100,
			maxBufferMs: 500,
		})
		const voice = new DigitalVoiceService(logger, voiceConfig, {
			httpHost: "127.0.0.1",
		})
		service = voice
		const vi = voice as unknown as VoiceInternals
		const vstart = vi.http.start.bind(vi.http)
		vi.http.start = () => vstart(0, "127.0.0.1")
		await voice.prepareDecoderConfigs(options.decoders.map(dsd))
		for (const id of options.decoders) {
			const emitter = new EventEmitter()
			voice.attachDecoder(id, emitter)
			decoders.set(id, emitter)
		}
		await voice.start()
		for (const d of voice.getStatus().decoders)
			ports.set(d.decoderId, d.udpPort)
		const socket = dgram.createSocket("udp4")
		await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve))
		sender = socket
		demod.attachAutoRouteVoice(voice, coverage)
		disposers.push(async () => {
			socket.close()
			await voice.destroy()
		})
	}

	const received = (id: string): number =>
		service?.getStatus().decoders.find(d => d.decoderId === id)
			?.datagramsReceived ?? 0

	const rate = (): number => internals.run?.stream.rate ?? 0
	let carry = 0
	let seed = 0

	return {
		demod,
		internals,
		router,
		routeClock,
		stage,
		script,
		spans,
		blocks,
		blockCopies,
		underrunsAfter,
		changes,
		/** The `/stream` bytes since the first `/auto` connect. */
		streamSinceAuto(): Buffer {
			return witness.received().subarray(streamAtAuto ?? 0)
		},
		sourceManager,
		coverage,
		service,
		rate,
		port(): number {
			const address = internals.http.server?.address()
			if (!address || typeof address === "string") throw new Error("no port")
			return address.port
		},
		addStreamClient(): ClientTransport {
			const transport = new ClientTransport()
			internals.registerClient(transport, "stream")
			return transport
		},
		addAutoClient() {
			const transport = new ClientTransport()
			const client = router.registry.register(
				transport as never,
				"auto",
				AUTO_ROUTE_STREAM,
			)
			return { transport, client }
		},
		async connectHttp(): Promise<HttpAutoClient> {
			const before = router.registry.size
			const client = await httpAuto(this.port())
			await waitFor(() => router.registry.size > before)
			return client
		},
		feed(chunk: Buffer) {
			internals.handleAudioData(chunk)
		},
		/**
		 * 20 ms of analog audio: a ramp while the stage-1 squelch is open, silence while it is
		 * closed (as the squelched demodulator outputs).
		 */
		feedAnalog20(): void {
			const exact = rate() / 50 + carry
			const samples = Math.floor(exact)
			carry = exact - samples
			internals.handleAudioData(
				stage.open ? ramp(samples, seed) : Buffer.alloc(samples * 2),
			)
			seed += samples
		},
		voiceCall(id: string, overrides: Record<string, unknown> = {}): void {
			decoders.get(id)?.emit("voice-call", callState(overrides))
		},
		/** Sends one datagram over loopback UDP and waits until the service ingested it. */
		async voice(id: string, mono: Int16Array): Promise<void> {
			const port = ports.get(id)
			if (sender === null || port === undefined) throw new Error("no voice")
			const before = received(id)
			const socket = sender
			await new Promise<void>((resolve, reject) =>
				socket.send(stereoDatagram(mono), port, "127.0.0.1", err =>
					err ? reject(err) : resolve(),
				),
			)
			await waitFor(() => received(id) > before)
		},
		evidence() {
			const evidence = internals.run?.evidence
			if (evidence === undefined || evidence === null)
				throw new Error("no evidence path")
			return evidence
		},
	}
}

export type Harness = Awaited<ReturnType<typeof harness>>
