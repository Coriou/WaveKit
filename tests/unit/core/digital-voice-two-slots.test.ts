/**
 * Two concurrent DMR slot calls on one decoder: each slot keeps its own call,
 * a slot is muted by its own call while it is encrypted or its encryption is
 * not known yet, the end of one slot never clears the other, and the auto
 * listen tap (a whole-datagram consumer) obeys the most restrictive active
 * call. Also the call-first seam: `encryptionKnown` reaches a tap end to end.
 * UDP is mocked; HTTP binds 127.0.0.1 port 0.
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
	static nextPort = 41_900
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

/** 20 ms stereo datagram: left (slot 1) = a, right (slot 2) = b. */
function stereo(a: number, b: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) {
		buf.writeInt16LE(a, i * 4)
		buf.writeInt16LE(b, i * 4 + 2)
	}
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
		httpPort: 41_238,
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

const S1 = 111
const S2 = 222

const s1 = (overrides: Record<string, unknown> = {}) =>
	state({ callId: "dsd-fme-s1", slot: 1, talkgroup: 1, ...overrides })
const s2 = (overrides: Record<string, unknown> = {}) =>
	state({ callId: "dsd-fme-s2", slot: 2, talkgroup: 2, ...overrides })

function values(pcm: Buffer): Set<number> {
	const out = new Set<number>()
	for (let i = 0; i + 1 < pcm.length; i += 2) out.add(pcm.readInt16LE(i))
	return out
}

describe("digital voice: two concurrent DMR slot calls", () => {
	it("repro timeline: no unknown or encrypted slot audio passes; slot 2 plays alone once known clear", async () => {
		const { service, decoder, socket, connect, router, clock, auto } =
			await routed()
		const client = connect()
		const frames: Array<{
			phase: string
			pcm: Buffer
			call: VoiceTapCall | null
		}> = []
		let phase = ""
		service.addVoiceTap({
			frame: (_id, pcm, call) =>
				frames.push({
					phase,
					pcm: Buffer.from(pcm),
					call: call && { ...call },
				}),
			call: () => undefined,
			detach: () => undefined,
		})
		const burst = (name: string, left: number, right: number) => {
			phase = name
			for (let n = 0; n < 5; n++) socket.emit("message", stereo(left, right))
			vi.advanceTimersByTime(100)
			for (let i = 0; i < 5; i++) clock.tick(20)
		}
		// t=1000 s1 unknown
		decoder.emit("voice-call", s1({ encryptionKnown: false }))
		burst("s1-unknown", S1, 0)
		// t=1030 s2 unknown
		decoder.emit("voice-call", s2({ encryptionKnown: false }))
		burst("both-unknown", S1, S2)
		// t=1960 s1 known encrypted
		decoder.emit("voice-call", s1({ encryptionKnown: true, encrypted: true }))
		burst("s1-enc-s2-unknown", S1, S2)
		// t=2350 s2 known clear
		decoder.emit("voice-call", s2({ encryptionKnown: true }))
		burst("s1-enc-s2-clear", S1, S2)
		// s1 end: s2 stays active and clear
		decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true, active: false }),
		)
		expect(service.getStatus().call?.callId).toBe("dsd-fme-s2")
		burst("s2-clear", 0, S2)
		// s2 end
		decoder.emit("voice-call", s2({ encryptionKnown: true, active: false }))
		expect(service.getStatus().call).toBeNull()
		vi.advanceTimersByTime(800)

		const heard = new Set(client.samples())
		// The auto route obeys the most restrictive call: never slot 1's voice.
		const routedVoice = new Set(auto.samples())
		expect(routedVoice.has(S1)).toBe(false)
		expect(routedVoice.has(S1 + S2)).toBe(false)
		router.destroy()
		expect(heard.has(S2)).toBe(true)
		expect(heard.has(S1)).toBe(false)
		expect(heard.has(S1 + S2)).toBe(false)
		// Nothing before slot 2 was known clear reached the tap.
		for (const f of frames.filter(f =>
			["s1-unknown", "both-unknown", "s1-enc-s2-unknown"].includes(f.phase),
		))
			expect([...values(f.pcm)]).toEqual([0])
		// Known clear slot 2 alongside encrypted slot 1: only slot 2's voice, and
		// the tap is handed the most restrictive call (slot 1, encrypted).
		const mixed = frames.filter(f => f.phase === "s1-enc-s2-clear")
		expect(mixed.length).toBe(5)
		for (const f of mixed) {
			expect([...values(f.pcm)]).toEqual([S2])
			expect(f.call?.callId).toBe("dsd-fme-s1")
			expect(f.call?.encrypted).toBe(true)
		}
		const alone = frames.filter(f => f.phase === "s2-clear")
		expect(alone.length).toBe(5)
		for (const f of alone) {
			expect([...values(f.pcm)]).toEqual([S2])
			expect(f.call?.callId).toBe("dsd-fme-s2")
		}
	})

	it("the tap call is restrictive while any slot is unknown, and an end of one slot keeps the other", async () => {
		const { service, decoder, socket } = await started()
		const tapCalls: VoiceTapCall[] = []
		const frameCalls: Array<VoiceTapCall | null> = []
		service.addVoiceTap({
			frame: (_id, _pcm, call) => frameCalls.push(call && { ...call }),
			call: (_id, call) => tapCalls.push({ ...call }),
			detach: () => undefined,
		})
		decoder.emit("voice-call", s2({ encryptionKnown: true }))
		decoder.emit("voice-call", s1({ encryptionKnown: false }))
		socket.emit("message", stereo(S1, S2))
		expect(frameCalls.at(-1)?.callId).toBe("dsd-fme-s1")
		// A clear update on slot 2 does not hide the unknown slot 1.
		decoder.emit("voice-call", s2({ encryptionKnown: true, talkgroup: 7 }))
		expect(tapCalls.at(-1)?.callId).toBe("dsd-fme-s1")
		// Slot 2 ends; slot 1 (unknown) still mutes its slot.
		decoder.emit("voice-call", s2({ encryptionKnown: true, active: false }))
		expect(tapCalls.at(-1)).toMatchObject({
			callId: "dsd-fme-s1",
			active: true,
		})
		expect(service.getStatus().call?.callId).toBe("dsd-fme-s1")
		socket.emit("message", stereo(S1, 0))
		expect(frameCalls.at(-1)?.callId).toBe("dsd-fme-s1")
		// The last end hands the end event itself.
		decoder.emit("voice-call", s1({ encryptionKnown: false, active: false }))
		expect(tapCalls.at(-1)).toMatchObject({
			callId: "dsd-fme-s1",
			active: false,
		})
	})

	it("a call whose slot becomes known moves off the unknown slot", async () => {
		const { service, decoder, socket, connect } = await started()
		const client = connect()
		decoder.emit("voice-call", s1({ encryptionKnown: false, slot: null }))
		decoder.emit("voice-call", s1({ encryptionKnown: true }))
		for (let n = 0; n < 20; n++) socket.emit("message", stereo(S1, 0))
		vi.advanceTimersByTime(800)
		expect(client.samples().some(s => s === S1)).toBe(true)
		expect(service.getStatus().decoders[0]!.encryptedDatagramsDropped).toBe(0)
	})

	it("both slots restricted drop the whole datagram", async () => {
		const { service, decoder, socket } = await started()
		decoder.emit("voice-call", s1({ encryptionKnown: false }))
		decoder.emit("voice-call", s2({ encrypted: true }))
		const frames: Buffer[] = []
		service.addVoiceTap({
			frame: (_id, pcm) => frames.push(pcm),
			call: () => undefined,
			detach: () => undefined,
		})
		socket.emit("message", stereo(S1, S2))
		expect(frames).toHaveLength(0)
	})

	it("a re-attached decoder starts with no calls", async () => {
		const { service, decoder, socket, connect } = await started()
		decoder.emit("voice-call", s1({ encryptionKnown: false }))
		const fresh = new EventEmitter()
		service.attachDecoder("dsd-fme", fresh)
		expect(service.getStatus().call).toBeNull()
		const client = connect()
		for (let n = 0; n < 20; n++) socket.emit("message", stereo(S1, 0))
		vi.advanceTimersByTime(800)
		expect(client.samples().some(s => s === S1)).toBe(true)
		void decoder
	})
})

describe("call-first seam: encryptionKnown reaches the auto-listen tap", () => {
	it("a tap consumer receives encryptionKnown false then true on call and frame", async () => {
		const { service, decoder, socket } = await started()
		const onCall: Array<boolean | undefined> = []
		const onFrame: Array<boolean | undefined> = []
		const known = (call: VoiceTapCall | null): boolean | undefined =>
			call !== null && "encryptionKnown" in call
				? (call as VoiceTapCall & { encryptionKnown?: boolean }).encryptionKnown
				: undefined
		service.addVoiceTap({
			frame: (_id, _pcm, call) => onFrame.push(known(call)),
			call: (_id, call) => onCall.push(known(call)),
			detach: () => undefined,
		})
		decoder.emit("voice-call", s1({ encryptionKnown: false }))
		socket.emit("message", stereo(S1, 0))
		decoder.emit("voice-call", s1({ encryptionKnown: true }))
		socket.emit("message", stereo(S1, 0))
		expect(onCall).toEqual([false, true])
		expect(onFrame).toEqual([false, true])
	})
})
