import { afterEach, describe, expect, it, vi } from "vitest"
import * as net from "node:net"
import { SourceManager } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

describe("source sample activity", () => {
	const manager = new SourceManager(createLogger({ level: "fatal" }))
	let server: net.Server | undefined
	const sockets: net.Socket[] = []

	afterEach(async () => {
		vi.restoreAllMocks()
		await manager.disconnectAll()
		for (const socket of sockets) socket.destroy()
		sockets.length = 0
		if (server)
			await new Promise<void>(resolve => server!.close(() => resolve()))
	})

	async function connect() {
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
			caps: {
				kind: "iq",
				format: "U8_IQ",
				sampleRate: 2048000,
				exclusive: false,
			},
		})
		await vi.waitFor(() => expect(sockets.length).toBe(1))
		return stream
	}

	it("does not count fragmented headers as samples, ages payload and recovers", async () => {
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		const stream = await connect()
		stream.resume()
		expect(manager.getStatus("iq")!.activity.state).toBe("waiting")
		sockets[0]!.write(Buffer.from("RTL0"))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(4),
		)
		sockets[0]!.write(Buffer.alloc(8))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(12),
		)
		expect(manager.getStatus("iq")!.activity.lastSampleAt).toBeNull()
		clock.mockReturnValue(start + 10000)
		expect(manager.getStatus("iq")!.activity.state).toBe("stale")
		sockets[0]!.write(Buffer.alloc(64))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("streaming"),
		)
		clock.mockReturnValue(start + 20000)
		expect(manager.getStatus("iq")!.activity).toMatchObject({
			state: "stale",
			sampleAgeMs: 10000,
		})
		sockets[0]!.write(Buffer.alloc(64))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("streaming"),
		)
	})

	it("distinguishes backpressure from stale input and gives resume grace", async () => {
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		const stream = await connect()
		sockets[0]!.write(Buffer.alloc(1024 * 1024))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("paused"),
		)
		clock.mockReturnValue(start + 30000)
		expect(manager.getStatus("iq")!.activity.state).toBe("paused")
		stream.resume()
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(1024 * 1024),
		)
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("streaming"),
		)
		clock.mockReturnValue(start + 40000)
		expect(manager.getStatus("iq")!.activity.state).toBe("stale")
	})

	it("gives resume grace without receiving further upstream payload", async () => {
		const start = Date.now()
		const clock = vi.spyOn(Date, "now").mockReturnValue(start)
		const stream = await connect()
		const payload = Buffer.alloc(512 * 1024)
		sockets[0]!.write(payload)
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(payload.length),
		)
		expect(manager.getStatus("iq")!.activity.state).toBe("paused")
		clock.mockReturnValue(start + 30000)
		stream.resume()
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("waiting"),
		)
		expect(manager.getStatus("iq")!.activity.lastSampleAt).toBe(
			new Date(start).toISOString(),
		)
		clock.mockReturnValue(start + 40000)
		expect(manager.getStatus("iq")!.activity.state).toBe("stale")
	})

	it("resets session freshness on automatic reconnect while retaining totals", async () => {
		const stream = await connect()
		stream.resume()
		sockets[0]!.write(Buffer.alloc(76))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("streaming"),
		)
		sockets[0]!.destroy()
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.activity.state).toBe("disconnected"),
		)
		expect(manager.getStatus("iq")!.dataRate).toBe(0)
		await vi.waitFor(() => expect(sockets.length).toBe(2), { timeout: 6000 })
		expect(manager.getStatus("iq")!).toMatchObject({
			bytesReceived: 76,
			dataRate: 0,
			activity: { state: "waiting", lastSampleAt: null, sampleAgeMs: null },
		})
		sockets[1]!.write(Buffer.alloc(12))
		await vi.waitFor(() =>
			expect(manager.getStatus("iq")!.bytesReceived).toBe(88),
		)
		expect(manager.getStatus("iq")!.activity.state).toBe("waiting")
	})
})
