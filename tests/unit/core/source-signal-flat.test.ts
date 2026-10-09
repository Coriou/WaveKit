/**
 * Signal-flat check wired into SourceManager: the subsampled IQ level of a
 * network IQ source per metrics interval. Surfaces in getStatus() as
 * `signalFlat` / `signalLevelDbfs` and emits "signal-flat-changed".
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import * as net from "node:net"
import {
	SourceManager,
	type SourceManagerOptions,
} from "../../../src/core/source-manager.js"
import type { SourceCaps } from "../../../src/config.js"
import { createLogger } from "../../../src/utils/logger.js"

const TICK = 5_000

/** u8 IQ `dev` LSB either side of 127.5 (dev ∈ k + 0.5). */
function u8(dev: number, length = 64 * 1024): Buffer {
	const chunk = Buffer.alloc(length)
	for (let i = 0; i < length; i++)
		chunk[i] = i % 2 === 0 ? 127.5 - dev : 127.5 + dev
	return chunk
}
const FLAT = u8(0.5) // −48.1 dBFS
const NORMAL = u8(7.5) // −24.6 dBFS

describe("source signal flat", () => {
	let manager: SourceManager
	let server: net.Server | undefined
	const sockets: net.Socket[] = []
	let now = 1_000_000

	afterEach(async () => {
		vi.restoreAllMocks()
		await manager.disconnectAll()
		for (const socket of sockets) socket.destroy()
		sockets.length = 0
		if (server)
			await new Promise<void>(resolve => server!.close(() => resolve()))
		server = undefined
	})

	async function connect(
		caps: Pick<SourceCaps, "kind" | "format"> = {
			kind: "iq",
			format: "U8_IQ",
		},
		options: SourceManagerOptions = {},
	) {
		manager = new SourceManager(createLogger({ level: "fatal" }), options)
		vi.spyOn(Date, "now").mockImplementation(() => now)
		server = net.createServer(socket => sockets.push(socket))
		await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as net.AddressInfo).port
		const stream = await manager.connect({
			id: "iq",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port,
			loop: false,
			playbackSpeed: 1,
			caps: { ...caps, sampleRate: 2_048_000, exclusive: false },
		})
		stream.resume()
		await vi.waitFor(() => expect(sockets.length).toBe(1))
		// rtl_tcp: the first 12 bytes are the (stripped) protocol header.
		await deliver(Buffer.alloc(12))
	}

	async function deliver(chunk: Buffer) {
		const before = manager.getStatus("iq")!.bytesReceived
		sockets[0]!.write(chunk)
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(
				before + chunk.length,
			),
		)
	}

	function tick() {
		now += TICK
		;(manager as unknown as { emitMetrics(id: string): void }).emitMetrics("iq")
	}

	/** One metrics interval carrying `chunk` (nothing for null). */
	async function interval(chunk: Buffer | null) {
		if (chunk) await deliver(chunk)
		tick()
	}

	it("flags a sustained flat IQ level and clears after recovery", async () => {
		await connect()
		const changes: string[] = []
		manager.on("signal-flat-changed", (id: string) => changes.push(id))
		await interval(null) // discard the header-only interval
		for (let i = 0; i < 5; i++) await interval(FLAT)
		expect(manager.getStatus("iq")!.signalFlat).toBeUndefined()
		expect(manager.getStatus("iq")!.signalLevelDbfs).toBe(-48.1)
		await interval(FLAT)
		expect(manager.getStatus("iq")!.signalFlat).toMatchObject({
			levelDbfs: -48.1,
			thresholdDbfs: -40,
		})
		expect(manager.getStatus("iq")!.signalFlat!.since).toBeInstanceOf(Date)
		expect(changes).toEqual(["iq"])

		for (let i = 0; i < 6; i++) await interval(NORMAL)
		expect(manager.getStatus("iq")!.signalFlat).toBeUndefined()
		expect(manager.getStatus("iq")!.signalLevelDbfs).toBe(-24.6)
		expect(changes).toEqual(["iq", "iq"])
	}, 20_000)

	it("does not flag a connected source that sends nothing", async () => {
		await connect()
		for (let i = 0; i < 10; i++) await interval(null)
		const status = manager.getStatus("iq")!
		expect(status.signalFlat).toBeUndefined()
		expect(status).not.toHaveProperty("signalLevelDbfs")
	}, 20_000)

	it("clears the flag on a caps rate change", async () => {
		await connect()
		const changes: string[] = []
		manager.on("signal-flat-changed", (id: string) => changes.push(id))
		for (let i = 0; i < 7; i++) await interval(FLAT)
		expect(manager.getStatus("iq")!.signalFlat).toBeDefined()
		manager.updateSourceCaps("iq", { sampleRate: 2_400_000 })
		expect(manager.getStatus("iq")!.signalFlat).toBeUndefined()
		expect(changes).toEqual(["iq", "iq"])
		// A centre-frequency-only change keeps the measurement.
		for (let i = 0; i < 6; i++) await interval(FLAT)
		manager.updateSourceCaps("iq", { centerFreq: 1_090_000_000 })
		expect(manager.getStatus("iq")!.signalFlat).toBeDefined()
	}, 20_000)

	it("clears the flag when the source disconnects", async () => {
		await connect()
		for (let i = 0; i < 7; i++) await interval(FLAT)
		expect(manager.getStatus("iq")!.signalFlat).toBeDefined()
		sockets[0]!.destroy()
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.connected).toBe(false),
		)
		tick()
		expect(manager.getStatus("iq")!.signalFlat).toBeUndefined()
		expect(manager.getStatus("iq")!.signalLevelDbfs).toBeUndefined()
	}, 20_000)

	it("never measures audio PCM sources", async () => {
		await connect({ kind: "audio_pcm", format: "S16LE" })
		for (let i = 0; i < 8; i++) await interval(Buffer.alloc(4096))
		const status = manager.getStatus("iq")!
		expect(status.signalFlat).toBeUndefined()
		expect(status.signalLevelDbfs).toBeUndefined()
	}, 20_000)

	it("honours the configured threshold and hold", async () => {
		await connect(undefined, {
			signalFlatThresholdDbfs: -20,
			signalFlatHoldMs: 10_000,
		})
		await interval(null)
		await interval(NORMAL)
		await interval(NORMAL)
		expect(manager.getStatus("iq")!.signalFlat).toMatchObject({
			thresholdDbfs: -20,
			levelDbfs: -24.6,
		})
	}, 20_000)
})
