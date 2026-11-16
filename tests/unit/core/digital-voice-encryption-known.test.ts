/**
 * Call-first digital voice: a call whose encryption is not known yet
 * (`encryptionKnown` present and not true) is muted on /stream and on the auto
 * listen route like an encrypted one, becomes audible once known clear, stays
 * muted once known encrypted, and malformed values fail closed. An absent field
 * is a legacy call whose encryption is known. UDP is mocked; HTTP binds
 * 127.0.0.1 port 0.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import type {
	AutoRouteClock,
	VoiceCoveragePort,
	VoiceTapCall,
} from "../../../src/core/auto-listen/contract.js"
import { AUTO_ROUTE_STREAM } from "../../../src/core/auto-listen/contract.js"
import { AutoListenRouter } from "../../../src/core/auto-listen/router.js"
import type {
	DigitalVoiceCall,
	DigitalVoiceService as Service,
} from "../../../src/core/digital-voice.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { createLogger } from "../../../src/utils/logger.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 41_800
	port = FakeSocket.nextPort++
	constructor(readonly options: unknown) {
		super()
		FakeSocket.created.push(this)
	}
	bind(_port: number, _host: string, cb: () => void): void {
		setImmediate(cb)
	}
	address(): { port: number } {
		return { port: this.port }
	}
	close(): void {}
}

vi.mock("node:dgram", () => ({
	createSocket: (options: unknown) => new FakeSocket(options),
}))

const logger = createLogger({ level: "fatal" })

class Transport extends Writable {
	readonly chunks: Buffer[] = []
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
	samples(): number[] {
		const all = Buffer.concat(this.chunks)
		const out: number[] = []
		for (let i = 0; i + 1 < all.length; i += 2) out.push(all.readInt16LE(i))
		return out
	}
}

class RouteClock implements AutoRouteClock {
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
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

function dsd(id: string): DecoderConfig {
	return { id, type: "dsd-fme", enabled: true, options: { mode: "auto" } }
}

/** 20 ms stereo datagram: slot 1 = value, slot 2 silent (the call's slot only). */
function slot1(value: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) buf.writeInt16LE(value, i * 4)
	return buf
}

const state = (overrides: Record<string, unknown> = {}) => ({
	callId: "dsd-fme-abc-1",
	protocol: "DMR",
	talkgroup: 9,
	source: 2060945,
	slot: 1,
	encrypted: false,
	active: true,
	startedAt: "2026-10-09T12:00:00.000Z",
	...overrides,
})

interface Internals {
	http: { start(port: number, host?: string): Promise<void> }
	channels: Map<
		string,
		{
			registry: {
				register(res: unknown, addr: string, stream: unknown): unknown
			}
		}
	>
}

let DigitalVoiceService: new (
	...args: ConstructorParameters<typeof Service>
) => Service
const services: Service[] = []

beforeEach(async () => {
	FakeSocket.created = []
	DigitalVoiceService = (await import("../../../src/core/digital-voice.js"))
		.DigitalVoiceService
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "Date", "performance"],
	})
})

afterEach(async () => {
	vi.useRealTimers()
	for (const service of services.splice(0)) await service.destroy()
})

async function started() {
	const config = DigitalVoiceConfigSchema.parse({
		httpPort: 41_236,
		jitterBufferMs: 100,
		maxBufferMs: 500,
	})
	const service = new DigitalVoiceService(logger, config, {
		httpHost: "127.0.0.1",
	})
	services.push(service)
	const internals = service as unknown as Internals
	const start = internals.http.start.bind(internals.http)
	internals.http.start = () => start(0, "127.0.0.1")
	const first = FakeSocket.created.length
	await service.prepareDecoderConfigs([dsd("dsd-fme")])
	const decoder = new EventEmitter()
	service.attachDecoder("dsd-fme", decoder)
	const calls: DigitalVoiceCall[] = []
	service.on("call", (call: DigitalVoiceCall) => calls.push(call))
	await service.start()
	const socket = FakeSocket.created[first]
	if (socket === undefined) throw new Error("no socket")
	return {
		service,
		decoder,
		socket,
		calls,
		connect(): Transport {
			const transport = new Transport()
			internals.channels
				.get("dsd-fme")
				?.registry.register(transport, "t", { rate: 8000, format: "s16le" })
			return transport
		},
	}
}

function coverage(): VoiceCoveragePort {
	return { generation: 1, covers: () => "yes" }
}

async function routed() {
	const voice = await started()
	const clock = new RouteClock()
	const router = new AutoListenRouter(logger, { clock })
	router.attachVoice(voice.service, coverage())
	const auto = new Transport()
	router.registry.register(
		auto as unknown as http.ServerResponse,
		"auto",
		AUTO_ROUTE_STREAM,
	)
	return { ...voice, router, clock, auto }
}

describe("digital voice: encryption not known yet (call-first)", () => {
	describe("/stream", () => {
		it("never plays an unknown call and counts its voice as dropped", async () => {
			const { decoder, socket, connect, calls, service } = await started()
			const client = connect()
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			for (let n = 0; n < 20; n++) socket.emit("message", slot1(500))
			vi.advanceTimersByTime(800)
			expect(client.samples().length).toBeGreaterThan(0)
			expect(client.samples().every(s => s === 0)).toBe(true)
			expect(calls[0]?.encryptionKnown).toBe(false)
			expect(service.getStatus().call?.encryptionKnown).toBe(false)
			expect(service.getStatus().decoders[0]!.encryptedDatagramsDropped).toBe(
				20,
			)
		})

		it("drops a whole datagram of an unknown call whose slot is unknown", async () => {
			const { decoder, socket, connect, service } = await started()
			const client = connect()
			decoder.emit("voice-call", state({ encryptionKnown: false, slot: null }))
			const both = Buffer.alloc(640)
			for (let i = 0; i < 320; i++) both.writeInt16LE(700, i * 2)
			for (let n = 0; n < 10; n++) socket.emit("message", both)
			vi.advanceTimersByTime(800)
			expect(client.samples().every(s => s === 0)).toBe(true)
			expect(service.getStatus().decoders[0]!.encryptedDatagramsDropped).toBe(
				10,
			)
		})

		it("unknown then known clear: audible from then on, never the unknown part", async () => {
			const { decoder, socket, connect, calls } = await started()
			const client = connect()
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			for (let n = 0; n < 5; n++) socket.emit("message", slot1(111))
			decoder.emit("voice-call", state({ encryptionKnown: true }))
			for (let n = 0; n < 20; n++) socket.emit("message", slot1(500))
			vi.advanceTimersByTime(800)
			const voice = client.samples().filter(s => s !== 0)
			expect(voice.length).toBeGreaterThan(0)
			expect(voice.every(s => s === 500)).toBe(true)
			expect(calls.map(c => c.encryptionKnown)).toEqual([false, true])
		})

		it("mutes voice queued just before an unknown call update arrives", async () => {
			const { decoder, socket, connect } = await started()
			const client = connect()
			// Pre-call queued voice must not leak into the unknown call either.
			for (let n = 0; n < 3; n++) socket.emit("message", slot1(500))
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			vi.advanceTimersByTime(800)
			expect(client.samples().every(s => s === 0)).toBe(true)
		})

		it("unknown then known encrypted: stays muted", async () => {
			const { decoder, socket, connect } = await started()
			const client = connect()
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			for (let n = 0; n < 5; n++) socket.emit("message", slot1(500))
			decoder.emit(
				"voice-call",
				state({ encryptionKnown: true, encrypted: true }),
			)
			for (let n = 0; n < 20; n++) socket.emit("message", slot1(500))
			vi.advanceTimersByTime(800)
			expect(client.samples().length).toBeGreaterThan(0)
			expect(client.samples().every(s => s === 0)).toBe(true)
		})

		it.each([["true"], [1], [null], [0], [{}], ["false"]])(
			"fails closed on a malformed encryptionKnown %j: the call is published as unknown and muted",
			async value => {
				const { decoder, socket, connect, calls } = await started()
				const client = connect()
				decoder.emit("voice-call", state({ encryptionKnown: value }))
				for (let n = 0; n < 20; n++) socket.emit("message", slot1(500))
				vi.advanceTimersByTime(800)
				expect(calls).toHaveLength(1)
				expect(calls[0]?.encryptionKnown).toBe(false)
				expect(client.samples().every(s => s === 0)).toBe(true)
			},
		)

		it("absent encryptionKnown is a legacy known call: clear plays, no field is added", async () => {
			const { decoder, socket, connect, calls } = await started()
			const client = connect()
			decoder.emit("voice-call", state())
			for (let n = 0; n < 20; n++) socket.emit("message", slot1(500))
			vi.advanceTimersByTime(800)
			expect(calls[0]).not.toHaveProperty("encryptionKnown")
			expect(client.samples().some(s => s === 500)).toBe(true)
		})
	})

	describe("auto listen tap and route", () => {
		it("the tap gets the unknown call's slot muted and a wholly unknown datagram not at all", async () => {
			const { service, decoder, socket } = await started()
			const frames: Array<{ pcm: Buffer; call: VoiceTapCall | null }> = []
			service.addVoiceTap({
				frame: (_id, pcm, call) => frames.push({ pcm: Buffer.from(pcm), call }),
				call: () => undefined,
				detach: () => undefined,
			})
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			socket.emit("message", slot1(900))
			expect(frames).toHaveLength(1)
			const pcm = frames[0]!.pcm
			for (let i = 0; i + 1 < pcm.length; i += 2)
				expect(pcm.readInt16LE(i)).toBe(0)
			decoder.emit("voice-call", state({ encryptionKnown: false, slot: null }))
			socket.emit("message", slot1(900))
			expect(frames).toHaveLength(1)
		})

		it("an unknown call is never routed on the auto route", async () => {
			const { decoder, socket, router, clock, auto } = await routed()
			const changes: string[] = []
			router.on("auto-route-changed", (level: { active: string }) =>
				changes.push(level.active),
			)
			decoder.emit("voice-call", state({ encryptionKnown: false }))
			for (let i = 0; i < 20; i++) socket.emit("message", slot1(4_000))
			for (let i = 0; i < 50; i++) clock.tick(20)
			expect(auto.samples().every(s => s === 0)).toBe(true)
			expect(changes).not.toContain("digital")
			router.destroy()
		})

		it("unknown then known clear becomes audible on the auto route; known encrypted does not", async () => {
			const clear = await routed()
			clear.decoder.emit("voice-call", state({ encryptionKnown: false }))
			for (let i = 0; i < 5; i++) clear.socket.emit("message", slot1(111))
			clear.decoder.emit("voice-call", state({ encryptionKnown: true }))
			for (let i = 0; i < 20; i++) clear.socket.emit("message", slot1(4_000))
			for (let i = 0; i < 50; i++) clear.clock.tick(20)
			const heard = clear.auto.samples().filter(s => s !== 0)
			expect(heard.length).toBeGreaterThan(0)
			expect(heard).not.toContain(111)
			clear.router.destroy()

			const enc = await routed()
			enc.decoder.emit("voice-call", state({ encryptionKnown: false }))
			enc.decoder.emit(
				"voice-call",
				state({ encryptionKnown: true, encrypted: true }),
			)
			for (let i = 0; i < 20; i++) enc.socket.emit("message", slot1(4_000))
			for (let i = 0; i < 50; i++) enc.clock.tick(20)
			expect(enc.auto.samples().every(s => s === 0)).toBe(true)
			enc.router.destroy()
		})
	})
})
