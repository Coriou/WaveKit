/**
 * Digital voice stream: dsd-fme UDP ingest -> paced constant-rate PCM, call
 * metadata from voice-call events, encrypted calls muted, decoder config
 * routing. UDP is mocked; the HTTP server listens on a free local port.
 */

import { EventEmitter } from "node:events"
import * as http from "node:http"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import type {
	DigitalVoiceCall,
	DigitalVoiceService as DigitalVoiceServiceType,
} from "../../../src/core/digital-voice.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 41_000
	port = FakeSocket.nextPort++
	closed = false
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
	close(): void {
		this.closed = true
	}
}

vi.mock("node:dgram", () => ({
	createSocket: (options: unknown) => new FakeSocket(options),
}))

const logger = createLogger({ level: "fatal" })

function dsd(id: string, options: Record<string, unknown> = {}): DecoderConfig {
	return {
		id,
		type: "dsd-fme",
		enabled: true,
		options: { mode: "auto", ...options },
	}
}

/** 20 ms stereo datagram, both channels = value (one active slot). */
function datagram(value: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) {
		buf.writeInt16LE(value, i * 4)
		buf.writeInt16LE(value, i * 4 + 2)
	}
	return buf
}

class ClientTransport extends Writable {
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

async function freePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "0.0.0.0", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

type Internals = {
	channels: Map<
		string,
		{
			registry: {
				register(
					res: http.ServerResponse,
					addr: string,
					stream: unknown,
				): unknown
			}
		}
	>
}

describe("DigitalVoiceService", () => {
	let DigitalVoiceService: new (
		...args: ConstructorParameters<typeof DigitalVoiceServiceType>
	) => DigitalVoiceServiceType
	let service: DigitalVoiceServiceType
	let port: number

	async function create(
		overrides: Record<string, unknown> = {},
	): Promise<DigitalVoiceServiceType> {
		const config = DigitalVoiceConfigSchema.parse({
			httpPort: port,
			jitterBufferMs: 100,
			maxBufferMs: 500,
			...overrides,
		})
		return new DigitalVoiceService(logger, config)
	}

	function socket(index = 0): FakeSocket {
		return FakeSocket.created[index]!
	}

	function connect(decoderId = "dsd-fme"): ClientTransport {
		const client = new ClientTransport()
		const channel = (service as unknown as Internals).channels.get(decoderId)!
		channel.registry.register(
			client as unknown as http.ServerResponse,
			"test",
			{
				rate: 8000,
				format: "s16le",
			},
		)
		return client
	}

	beforeEach(async () => {
		FakeSocket.created = []
		const module = await import("../../../src/core/digital-voice.js")
		DigitalVoiceService = module.DigitalVoiceService
		port = await freePort()
		service = await create()
	})

	afterEach(async () => {
		vi.useRealTimers()
		await service.destroy()
	})

	describe("decoder routing", () => {
		it("points eligible dsd-fme decoders at their own loopback UDP socket", async () => {
			const prepared = await service.prepareDecoderConfigs([
				dsd("dsd-fme"),
				dsd("dsd-ysf", { mode: "ysf", output: "udp", voiceSlot: 2 }),
				dsd("dsd-null", { output: "null" }),
				dsd("dsd-wav", { output: "wav" }),
				dsd("dsd-ext", { output: "udp", udpHost: "10.0.0.2", udpPort: 9000 }),
				{ id: "pocsag", type: "multimon-ng", enabled: true, options: {} },
			])
			expect(FakeSocket.created).toHaveLength(2)
			expect(prepared[0]!.options).toMatchObject({
				mode: "auto",
				output: "udp",
				udpHost: "127.0.0.1",
				udpPort: socket(0).port,
				voiceSlot: "both",
			})
			// A decoder's own voiceSlot wins over the global default.
			expect(prepared[1]!.options).toMatchObject({
				udpPort: socket(1).port,
				voiceSlot: 2,
			})
			expect(prepared[2]).toEqual(dsd("dsd-null", { output: "null" }))
			expect(prepared[3]).toEqual(dsd("dsd-wav", { output: "wav" }))
			expect(prepared[4]!.options["udpPort"]).toBe(9000)
			expect(prepared[5]!.options).toEqual({})
			const status = service.getStatus()
			expect(status.decoders.map(d => [d.decoderId, d.mode])).toEqual([
				["dsd-fme", "auto"],
				["dsd-ysf", "ysf"],
			])
			expect(status.httpUrl).toBe(
				`http://localhost:${port}/decoders/dsd-fme/stream`,
			)
		})

		it("bounds each socket's kernel receive queue", async () => {
			await service.prepareDecoderConfigs([dsd("dsd-fme")])
			expect(socket().options).toMatchObject({ recvBufferSize: 32 * 1024 })
		})

		it("leaves configs untouched when digital voice is disabled", async () => {
			service = await create({ enabled: false })
			const configs = [dsd("dsd-fme")]
			expect(await service.prepareDecoderConfigs(configs)).toEqual(configs)
			expect(FakeSocket.created).toHaveLength(0)
			await expect(service.start()).rejects.toMatchObject({
				code: "DIGITAL_VOICE_UNAVAILABLE",
			})
		})
	})

	describe("paced stream", () => {
		beforeEach(async () => {
			await service.prepareDecoderConfigs([dsd("dsd-fme")])
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
			await service.start()
		})

		it("discards voice and runs no timer while nobody listens", () => {
			for (let n = 0; n < 10; n++) socket().emit("message", datagram(1))
			const decoder = service.getStatus().decoders[0]!
			expect(decoder.datagramsReceived).toBe(10)
			expect(decoder.bufferedMs).toBe(0)
			expect(vi.getTimerCount()).toBe(0)
			const client = connect()
			expect(vi.getTimerCount()).toBe(1)
			client.destroy()
		})

		it("streams exact silence at 8 kHz when no voice arrives", () => {
			const client = connect()
			vi.advanceTimersByTime(1000)
			const samples = client.samples()
			expect(samples).toHaveLength(8000)
			expect(samples.every(s => s === 0)).toBe(true)
		})

		it("mixes UDP voice to mono and plays it after the jitter target, in order", () => {
			const client = connect()
			vi.advanceTimersByTime(100)
			for (let n = 1; n <= 10; n++) socket().emit("message", datagram(n * 100))
			vi.advanceTimersByTime(500)
			const voice = client.samples().filter(s => s !== 0)
			expect(voice).toHaveLength(1600)
			expect(voice.slice(0, 160).every(s => s === 100)).toBe(true)
			expect(voice.slice(-160).every(s => s === 1000)).toBe(true)
			expect(client.samples()).toHaveLength(4800)
			expect(service.getStatus().decoders[0]!.datagramsReceived).toBe(10)
		})

		it("bounds the jitter buffer, dropping the oldest voice", () => {
			connect()
			for (let n = 0; n < 100; n++) socket().emit("message", datagram(1))
			const decoder = service.getStatus().decoders[0]!
			expect(decoder.bufferedMs).toBe(500)
			expect(decoder.droppedSamples).toBe(100 * 160 - 4000)
		})

		it("rejects malformed datagrams", () => {
			connect()
			socket().emit("message", Buffer.alloc(641))
			socket().emit("message", Buffer.alloc(0))
			expect(service.getStatus().decoders[0]!.datagramsRejected).toBe(2)
		})
	})

	describe("call metadata", () => {
		let decoder: EventEmitter
		let calls: DigitalVoiceCall[]

		beforeEach(async () => {
			await service.prepareDecoderConfigs([dsd("dsd-fme")])
			decoder = new EventEmitter()
			service.attachDecoder("dsd-fme", decoder)
			calls = []
			service.on("call", (call: DigitalVoiceCall) => calls.push(call))
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
			await service.start()
		})

		const state = (overrides: Record<string, unknown> = {}) => ({
			callId: "dsd-fme-abc-1",
			protocol: "dmr",
			talkgroup: 9,
			source: 2060945,
			slot: 1,
			encrypted: false,
			active: true,
			startedAt: "2026-10-09T12:00:00.000Z",
			...overrides,
		})

		it("publishes call start and end with the decoder id and keeps status consistent", () => {
			decoder.emit("voice-call", state())
			expect(calls[0]).toEqual({ decoderId: "dsd-fme", ...state() })
			expect(service.getStatus().call?.callId).toBe("dsd-fme-abc-1")
			expect(service.getStatus().decoders[0]!.call?.active).toBe(true)

			decoder.emit(
				"voice-call",
				state({ active: false, endedAt: "2026-10-09T12:00:05.000Z" }),
			)
			expect(calls[1]).toMatchObject({ active: false, callId: "dsd-fme-abc-1" })
			const status = service.getStatus()
			expect(status.call).toBeNull()
			expect(status.decoders[0]!.call).toBeNull()
			expect(status.decoders[0]!.lastCall?.endedAt).toBe(
				"2026-10-09T12:00:05.000Z",
			)
		})

		it("streams silence for an encrypted call and counts the dropped voice", () => {
			const client = connect()
			decoder.emit("voice-call", state({ encrypted: true }))
			for (let n = 0; n < 20; n++) socket().emit("message", datagram(500))
			vi.advanceTimersByTime(800)
			expect(client.samples().every(s => s === 0)).toBe(true)
			expect(client.samples().length).toBeGreaterThan(0)
			const status = service.getStatus()
			expect(status.decoders[0]!.encryptedDatagramsDropped).toBe(20)
			expect(status.call?.encrypted).toBe(true)
		})

		it("mutes voice already queued when a running call turns out encrypted", () => {
			const client = connect()
			decoder.emit("voice-call", state())
			for (let n = 0; n < 3; n++) socket().emit("message", datagram(500))
			decoder.emit("voice-call", state({ encrypted: true }))
			vi.advanceTimersByTime(800)
			expect(client.samples().every(s => s === 0)).toBe(true)
		})

		it("ignores malformed voice-call events", () => {
			decoder.emit("voice-call", { callId: 3 })
			expect(calls).toHaveLength(0)
		})
	})

	describe("HTTP endpoints", () => {
		beforeEach(async () => {
			await service.prepareDecoderConfigs([dsd("dsd-fme"), dsd("dsd:2")])
			await service.start()
		})

		const get = (path: string) =>
			new Promise<http.IncomingMessage>((resolve, reject) => {
				const req = http.get({ host: "127.0.0.1", port, path }, resolve)
				req.on("error", reject)
			})

		it("serves /stream, /stream.wav and per-decoder streams at a fixed 8 kHz", async () => {
			const raw = await get("/stream")
			expect(raw.statusCode).toBe(200)
			expect(raw.headers["x-audio-format"]).toBe("s16le")
			expect(raw.headers["x-sample-rate"]).toBe("8000")
			expect(raw.headers["x-channels"]).toBe("1")

			const wav = await get(
				`/decoders/${encodeURIComponent("dsd:2")}/stream.wav`,
			)
			expect(wav.headers["content-type"]).toBe("audio/wav")
			const header = await new Promise<Buffer>(resolve =>
				wav.once("data", (chunk: Buffer) => resolve(chunk)),
			)
			expect(header.subarray(0, 4).toString("ascii")).toBe("RIFF")
			expect(header.readUInt32LE(24)).toBe(8000)
			const status = service.getStatus()
			expect(status.decoders.map(d => d.clientCount)).toEqual([1, 1])
			expect(status.clientCount).toBe(2)
			raw.destroy()
			wav.destroy()
		})

		it("answers 404 for an unknown decoder or path", async () => {
			expect((await get("/decoders/nope/stream")).statusCode).toBe(404)
			expect((await get("/other")).statusCode).toBe(404)
		})
	})
})
