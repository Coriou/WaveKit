/**
 * /stream hold of voice whose encryption is not known yet: held per lane in a
 * bounded ring, released head first once the call is known clear (late, never
 * reordered), discarded when it turns out encrypted, ends unknown or the
 * decoder detaches; overflow drops the oldest; two slots are independent; the
 * auto-listen tap is unchanged (muted, live). UDP is mocked; datagrams arrive
 * at the real 20 ms rate on fake timers; HTTP binds 127.0.0.1 port 0.
 */
import { EventEmitter } from "node:events"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import {
	VOICE_HOLD_MAX_MS,
	type DigitalVoiceCall,
	type DigitalVoiceService as Service,
} from "../../../src/core/digital-voice.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { createLogger } from "../../../src/utils/logger.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 42_100
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

function dsd(id: string, mode = "auto"): DecoderConfig {
	return { id, type: "dsd-fme", enabled: true, options: { mode } }
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

async function started(mode = "auto") {
	const config = DigitalVoiceConfigSchema.parse({
		httpPort: 41_239,
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
	await service.prepareDecoderConfigs([dsd("dsd-fme", mode)])
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

const FRAME = 160

/** 20 ms stereo datagram: left (slot 1) = a, right (slot 2) = b. */
function stereo(a: number, b: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < FRAME; i++) {
		buf.writeInt16LE(a, i * 4)
		buf.writeInt16LE(b, i * 4 + 2)
	}
	return buf
}

/** 20 ms mono datagram. */
function mono(value: number): Buffer {
	const buf = Buffer.alloc(320)
	for (let i = 0; i < FRAME; i++) buf.writeInt16LE(value, i * 2)
	return buf
}

/** The expected voice: each value for one 20 ms frame, in order. */
function frames(values: readonly number[]): number[] {
	return values.flatMap(v => Array<number>(FRAME).fill(v))
}

function range(from: number, to: number): number[] {
	const out: number[] = []
	for (let v = from; v <= to; v++) out.push(v)
	return out
}

type Started = Awaited<ReturnType<typeof started>>

/** One datagram per 20 ms, as dsd-fme sends them. */
function send(voice: Started, datagrams: readonly Buffer[]): void {
	for (const datagram of datagrams) {
		voice.socket.emit("message", datagram)
		vi.advanceTimersByTime(20)
	}
}

const hold = (voice: Started) =>
	voice.service.getStatus().decoders[0]!.voiceHold!

const s1 = (overrides: Record<string, unknown> = {}) =>
	state({ callId: "dsd-fme-s1", slot: 1, talkgroup: 1, ...overrides })
const s2 = (overrides: Record<string, unknown> = {}) =>
	state({ callId: "dsd-fme-s2", slot: 2, talkgroup: 2, ...overrides })

describe("digital voice /stream hold of voice not known clear", () => {
	it("the cap is 2000 ms", () => {
		expect(VOICE_HOLD_MAX_MS).toBe(2000)
	})

	it("a whole clear over is heard head first, byte-exact, once known clear", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 50).map(v => stereo(v, 0)),
		)
		expect(client.samples().every(s => s === 0)).toBe(true)
		expect(hold(voice)).toMatchObject({ heldMs: 1000, bufferedMs: 1000 })
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		expect(hold(voice).releasedMs).toBe(1000)
		send(
			voice,
			range(51, 100).map(v => stereo(v, 0)),
		)
		// Live lag: the over plays 1000 ms late.
		expect(hold(voice).bufferedMs).toBe(1000)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(3000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, 100)))
		expect(hold(voice)).toEqual({
			heldMs: 1000,
			releasedMs: 1000,
			discardedMs: 0,
			overflowDroppedMs: 0,
			bufferedMs: 0,
		})
		const status = voice.service.getStatus().decoders[0]!
		expect(status.encryptedDatagramsDropped).toBe(0)
		expect(status.droppedSamples).toBe(0)
	})

	it("known encrypted discards the held voice and plays nothing", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 10).map(v => stereo(v, 0)),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true }),
		)
		send(
			voice,
			range(11, 20).map(v => stereo(v, 0)),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true, active: false }),
		)
		vi.advanceTimersByTime(3000)
		expect(client.samples().every(s => s === 0)).toBe(true)
		expect(hold(voice)).toMatchObject({
			heldMs: 200,
			releasedMs: 0,
			discardedMs: 200,
			bufferedMs: 0,
		})
		expect(
			voice.service.getStatus().decoders[0]!.encryptedDatagramsDropped,
		).toBe(10)
	})

	it("a call that ends unknown discards its held voice; the next clear call plays live", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 10).map(v => stereo(v, 0)),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: false, active: false }),
		)
		expect(hold(voice)).toMatchObject({ discardedMs: 200, bufferedMs: 0 })
		vi.advanceTimersByTime(1000)
		expect(client.samples().every(s => s === 0)).toBe(true)
		voice.decoder.emit("voice-call", s1({ callId: "dsd-fme-next" }))
		send(
			voice,
			range(11, 20).map(v => stereo(v, 0)),
		)
		expect(hold(voice).bufferedMs).toBe(0)
		vi.advanceTimersByTime(1000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(11, 20)))
	})

	it("a call replaced on its slot by another call discards its held voice", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 5).map(v => stereo(v, 0)),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ callId: "dsd-fme-other", encryptionKnown: false }),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ callId: "dsd-fme-other", encryptionKnown: true }),
		)
		vi.advanceTimersByTime(1000)
		expect(client.samples().every(s => s === 0)).toBe(true)
		expect(hold(voice)).toMatchObject({ discardedMs: 100, releasedMs: 0 })
	})

	it("at the cap nothing is dropped", async () => {
		const voice = await started()
		const client = voice.connect()
		const n = VOICE_HOLD_MAX_MS / 20
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, n).map(v => stereo(v, 0)),
		)
		expect(hold(voice)).toMatchObject({
			heldMs: 2000,
			overflowDroppedMs: 0,
			bufferedMs: 2000,
		})
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(4000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, n)))
	})

	it("past the cap the oldest held voice is dropped and counted", async () => {
		const voice = await started()
		const client = voice.connect()
		const n = VOICE_HOLD_MAX_MS / 20 + 3
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, n).map(v => stereo(v, 0)),
		)
		expect(hold(voice)).toMatchObject({
			heldMs: n * 20,
			overflowDroppedMs: 60,
			bufferedMs: 2000,
		})
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		expect(hold(voice).releasedMs).toBe(2000)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(4000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(4, n)))
	})

	it("two slots: a clear slot plays live while the other is held, then discarded once encrypted", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		voice.decoder.emit("voice-call", s2({ encryptionKnown: true }))
		send(
			voice,
			range(1, 10).map(() => stereo(111, 222)),
		)
		// Slot 2 is not delayed: its voice is already playing.
		expect(client.samples().filter(s => s !== 0).length).toBeGreaterThan(0)
		expect(new Set(client.samples())).toEqual(new Set([0, 222]))
		expect(hold(voice)).toMatchObject({ heldMs: 200, bufferedMs: 200 })
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true }),
		)
		send(
			voice,
			range(1, 10).map(() => stereo(111, 222)),
		)
		voice.decoder.emit(
			"voice-call",
			s2({ encryptionKnown: true, active: false }),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true, active: false }),
		)
		vi.advanceTimersByTime(2000)
		expect(client.samples().filter(s => s !== 0)).toEqual(
			frames(Array<number>(20).fill(222)),
		)
		expect(hold(voice)).toMatchObject({ discardedMs: 200, releasedMs: 0 })
	})

	it("two slots held at once: each is released or discarded on its own", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		voice.decoder.emit("voice-call", s2({ encryptionKnown: false }))
		send(
			voice,
			range(1, 10).map(v => stereo(1000 + v, v)),
		)
		expect(hold(voice).heldMs).toBe(400)
		voice.decoder.emit("voice-call", s2({ encryptionKnown: true }))
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true }),
		)
		send(
			voice,
			range(11, 20).map(v => stereo(1000 + v, v)),
		)
		voice.decoder.emit(
			"voice-call",
			s2({ encryptionKnown: true, active: false }),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, encrypted: true, active: false }),
		)
		vi.advanceTimersByTime(2000)
		// Slot 2's whole over, head first; nothing of slot 1.
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, 20)))
		expect(hold(voice)).toMatchObject({
			heldMs: 400,
			releasedMs: 200,
			discardedMs: 200,
		})
	})

	it("one voice on both channels with both slots restricted is discarded, never held", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		voice.decoder.emit("voice-call", s2({ encryptionKnown: false }))
		send(
			voice,
			range(1, 5).map(v => stereo(v, v)),
		)
		expect(hold(voice).heldMs).toBe(0)
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		voice.decoder.emit("voice-call", s2({ encryptionKnown: true }))
		vi.advanceTimersByTime(1000)
		expect(client.samples().every(s => s === 0)).toBe(true)
		expect(
			voice.service.getStatus().decoders[0]!.encryptedDatagramsDropped,
		).toBe(5)
	})

	it("a call on an unknown slot is held whole and released in order", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit(
			"voice-call",
			state({ slot: null, encryptionKnown: false }),
		)
		send(
			voice,
			range(1, 10).map(v => stereo(v, v)),
		)
		expect(hold(voice).heldMs).toBe(200)
		voice.decoder.emit(
			"voice-call",
			state({ slot: null, encryptionKnown: true }),
		)
		send(
			voice,
			range(11, 20).map(v => stereo(v, v)),
		)
		voice.decoder.emit(
			"voice-call",
			state({ slot: null, encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(2000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, 20)))
	})

	it("a held call whose slot becomes known is discarded (fail closed), then plays live", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ slot: null, encryptionKnown: false }))
		send(
			voice,
			range(1, 5).map(v => stereo(v, v)),
		)
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		expect(hold(voice).discardedMs).toBe(100)
		send(
			voice,
			range(6, 10).map(v => stereo(v, 0)),
		)
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(2000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(6, 10)))
	})

	it("mono decoder: held, then released in order; or discarded once encrypted", async () => {
		const clear = await started("p25")
		const client = clear.connect()
		clear.decoder.emit(
			"voice-call",
			state({ protocol: "P25", slot: null, encryptionKnown: false }),
		)
		send(clear, range(1, 10).map(mono))
		clear.decoder.emit(
			"voice-call",
			state({ protocol: "P25", slot: null, encryptionKnown: true }),
		)
		send(clear, range(11, 15).map(mono))
		clear.decoder.emit(
			"voice-call",
			state({
				protocol: "P25",
				slot: null,
				encryptionKnown: true,
				active: false,
			}),
		)
		vi.advanceTimersByTime(2000)
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, 15)))

		const enc = await started("p25")
		const encClient = enc.connect()
		enc.decoder.emit(
			"voice-call",
			state({ slot: null, encryptionKnown: false }),
		)
		send(enc, range(1, 10).map(mono))
		enc.decoder.emit(
			"voice-call",
			state({ slot: null, encryptionKnown: true, encrypted: true }),
		)
		vi.advanceTimersByTime(2000)
		expect(encClient.samples().every(s => s === 0)).toBe(true)
		expect(hold(enc).discardedMs).toBe(200)
	})

	it("a re-attached decoder discards held voice", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 10).map(v => stereo(v, 0)),
		)
		voice.service.attachDecoder("dsd-fme", new EventEmitter())
		expect(hold(voice)).toMatchObject({ discardedMs: 200, bufferedMs: 0 })
		vi.advanceTimersByTime(1000)
		expect(client.samples().every(s => s === 0)).toBe(true)
	})

	it("the tap is unchanged by the hold: muted live frames, never the held voice", async () => {
		const voice = await started()
		const client = voice.connect()
		const tapped: Array<{ values: number[]; known: boolean | undefined }> = []
		voice.service.addVoiceTap({
			frame: (_id, pcm, call) => {
				const values = new Set<number>()
				for (let i = 0; i + 1 < pcm.length; i += 2)
					values.add(pcm.readInt16LE(i))
				tapped.push({
					values: [...values],
					known: (call as { encryptionKnown?: boolean } | null)
						?.encryptionKnown,
				})
			},
			call: () => undefined,
			detach: () => undefined,
		})
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 5).map(v => stereo(v, 0)),
		)
		voice.decoder.emit("voice-call", s1({ encryptionKnown: true }))
		send(
			voice,
			range(6, 10).map(v => stereo(v, 0)),
		)
		voice.decoder.emit(
			"voice-call",
			s1({ encryptionKnown: true, active: false }),
		)
		vi.advanceTimersByTime(2000)
		expect(tapped).toEqual([
			...range(1, 5).map(() => ({ values: [0], known: false })),
			...range(6, 10).map(v => ({ values: [v], known: true })),
		])
		expect(client.samples().filter(s => s !== 0)).toEqual(frames(range(1, 10)))
	})

	it("the last listener leaving discards queued hold voice", async () => {
		const voice = await started()
		const client = voice.connect()
		voice.decoder.emit("voice-call", s1({ encryptionKnown: false }))
		send(
			voice,
			range(1, 10).map(v => stereo(v, 0)),
		)
		client.destroy()
		await new Promise(resolve => setImmediate(resolve))
		expect(hold(voice)).toMatchObject({ discardedMs: 200, bufferedMs: 0 })
	})
})
