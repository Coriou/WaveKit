// tests/unit/core/digital-voice-runtime.test.ts
/**
 * Digital voice for scanner probes (spec § 6.5): channels added and removed
 * at runtime, the HTTP server started lazily for the first channel, and
 * /stream bound to configured decoders only. UDP is mocked.
 */
import { EventEmitter } from "node:events"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../../src/utils/logger.js"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import type { DigitalVoiceService as DigitalVoiceServiceType } from "../../../src/core/digital-voice.js"
import { AudioHttpServer } from "../../../src/core/audio-stream-server.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 42_000
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
const dsd = (
	id: string,
	options: Record<string, unknown> = {},
): DecoderConfig => ({
	id,
	type: "dsd-fme",
	enabled: true,
	options: { mode: "auto", ...options },
})

async function freePort(): Promise<number> {
	const server = http.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

describe("DigitalVoiceService runtime channels", () => {
	let DigitalVoiceService: new (
		...args: ConstructorParameters<typeof DigitalVoiceServiceType>
	) => DigitalVoiceServiceType
	let service: DigitalVoiceServiceType
	let port: number
	const open: http.IncomingMessage[] = []

	const get = (path: string) =>
		new Promise<http.IncomingMessage>((resolve, reject) => {
			const req = http.get({ host: "127.0.0.1", port, path }, res => {
				open.push(res)
				resolve(res)
			})
			req.on("error", reject)
		})
	const clients = (id: string) =>
		service.getStatus().decoders.find(d => d.decoderId === id)?.clientCount

	beforeEach(async () => {
		FakeSocket.created = []
		DigitalVoiceService = (await import("../../../src/core/digital-voice.js"))
			.DigitalVoiceService
		port = await freePort()
		service = new DigitalVoiceService(
			logger,
			DigitalVoiceConfigSchema.parse({ httpPort: port }),
		)
	})
	afterEach(async () => {
		for (const res of open.splice(0)) res.destroy()
		await service.destroy()
	})

	it("addChannel binds a socket and routes the probe config to it", async () => {
		const routed = await service.addChannel(dsd("scan-j1-dmr-1"))
		expect(routed.options).toMatchObject({
			output: "udp",
			udpHost: "127.0.0.1",
			udpPort: FakeSocket.created[0]!.port,
		})
		expect(service.getStatus().decoders.map(d => d.decoderId)).toEqual([
			"scan-j1-dmr-1",
		])
	})

	it("returns the config unchanged when not eligible or when digital voice is disabled", async () => {
		const wav = dsd("scan-wav", { output: "wav" })
		expect(await service.addChannel(wav)).toBe(wav)
		const off = new DigitalVoiceService(
			logger,
			DigitalVoiceConfigSchema.parse({ httpPort: port, enabled: false }),
		)
		const probe = dsd("scan-off")
		expect(await off.addChannel(probe)).toBe(probe)
		expect(FakeSocket.created).toHaveLength(0)
		await off.destroy()
	})

	it("rejects a second channel with the same id", async () => {
		await service.addChannel(dsd("scan-j1-dmr-1"))
		await expect(
			service.addChannel(dsd("scan-j1-dmr-1")),
		).rejects.toMatchObject({ code: "DIGITAL_VOICE_CHANNEL_EXISTS" })
	})

	it("ensureStarted serves a probe-only host lazily, once; /stream has no configured decoder", async () => {
		const started = vi.fn()
		service.on("started", started)
		await service.addChannel(dsd("scan-j1-dmr-1"))
		await Promise.all([service.ensureStarted(), service.ensureStarted()])
		await service.ensureStarted()
		expect(started).toHaveBeenCalledTimes(1)
		expect(service.getStatus().running).toBe(true)
		expect((await get("/decoders/scan-j1-dmr-1/stream")).statusCode).toBe(200)
		expect((await get("/stream")).statusCode).toBe(404)
	})

	it("ensureStarted without any channel rejects like start()", async () => {
		await expect(service.ensureStarted()).rejects.toMatchObject({
			code: "DIGITAL_VOICE_UNAVAILABLE",
		})
	})

	it("/stream and the status URL stay on the configured decoder when a probe was added first", async () => {
		await service.addChannel(dsd("scan-j1-dmr-1"))
		await service.prepareDecoderConfigs([dsd("dsd-fme")])
		await service.ensureStarted()
		await get("/stream")
		await vi.waitFor(() => expect(clients("dsd-fme")).toBe(1))
		expect(clients("scan-j1-dmr-1")).toBe(0)
		expect(service.getStatus().httpUrl).toBe(
			`http://localhost:${port}/decoders/dsd-fme/stream`,
		)
	})

	it("removeChannel ends its clients, closes its socket and unpublishes it", async () => {
		await service.addChannel(dsd("scan-j1-dmr-1"))
		await service.ensureStarted()
		const res = await get("/decoders/scan-j1-dmr-1/stream")
		await vi.waitFor(() => expect(clients("scan-j1-dmr-1")).toBe(1))
		const ended = new Promise<void>(resolve =>
			res.once("close", () => resolve()),
		)
		await service.removeChannel("scan-j1-dmr-1")
		await ended
		expect(FakeSocket.created[0]!.closed).toBe(true)
		expect(service.getStatus().decoders).toEqual([])
		expect((await get("/decoders/scan-j1-dmr-1/stream")).statusCode).toBe(404)
		await service.removeChannel("scan-j1-dmr-1") // unknown: no-op
	})

	it("a concurrent addChannel for the same id rejects and releases its socket", async () => {
		const results = await Promise.allSettled([
			service.addChannel(dsd("scan-j1-dmr-1")),
			service.addChannel(dsd("scan-j1-dmr-1")),
		])
		expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"])
		expect(FakeSocket.created.filter(s => s.closed)).toHaveLength(1)
		expect(service.getStatus().decoders).toHaveLength(1)
	})

	it("start() joins an in-flight ensureStarted(): one http.start, one started event", async () => {
		// Boot start() (src/index.ts) may overlap a probe's ensureStarted().
		const httpStart = vi.spyOn(AudioHttpServer.prototype, "start")
		const started = vi.fn()
		service.on("started", started)
		await service.prepareDecoderConfigs([dsd("dsd-fme")])
		await service.addChannel(dsd("scan-j1-dmr-1"))
		try {
			await Promise.all([
				service.start(),
				service.ensureStarted(),
				service.start(),
			])
			expect(httpStart).toHaveBeenCalledTimes(1)
			expect(started).toHaveBeenCalledTimes(1)
			expect(service.getStatus().running).toBe(true)
		} finally {
			httpStart.mockRestore()
		}
	})

	it("supports the probe pool's order: addChannel, ensureStarted, then attachDecoder", async () => {
		const routed = await service.addChannel(dsd("scan-j1-dmr-1"))
		await service.ensureStarted()
		const decoder = new EventEmitter()
		service.attachDecoder(routed.id, decoder)
		decoder.emit("voice-call", {
			callId: "c1",
			protocol: "DMR",
			talkgroup: 9,
			source: 1234,
			slot: 1,
			encrypted: false,
			active: true,
			startedAt: new Date(0).toISOString(),
		})
		expect(service.getStatus().decoders[0]?.call).toMatchObject({
			decoderId: "scan-j1-dmr-1",
			talkgroup: 9,
		})
		await service.removeChannel(routed.id)
		expect(decoder.listenerCount("voice-call")).toBe(0)
	})
})
