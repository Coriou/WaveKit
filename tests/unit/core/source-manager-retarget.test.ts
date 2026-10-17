/**
 * SourceManager.retarget (docs/specs/receiver-endpoints 3.3, 3.5): a deliberate
 * endpoint switch keeps the registration, stream and assignments, reconnects
 * without a backoff step, and reports `endpoint` only for tracked sources.
 */
import { afterEach, describe, expect, it } from "vitest"
import * as net from "node:net"
import { once } from "node:events"
import {
	SourceManager,
	type SourceConfig,
} from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const HEADER = Buffer.concat([
	Buffer.from("RTL0"),
	Buffer.from([0, 0, 0, 5, 0, 0, 0, 29]),
])

interface Peer {
	server: net.Server
	connections: number
	sockets: Set<net.Socket>
	close(): Promise<void>
}

async function rtlPeer(
	host: string,
	port: number,
	fill: number,
): Promise<Peer> {
	const sockets = new Set<net.Socket>()
	const peer: Peer = {
		server: net.createServer(socket => {
			peer.connections++
			sockets.add(socket)
			socket.on("error", () => {})
			socket.on("close", () => sockets.delete(socket))
			socket.write(HEADER)
			socket.write(Buffer.alloc(4096, fill))
		}),
		connections: 0,
		sockets,
		async close() {
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => peer.server.close(() => resolve()))
		},
	}
	peer.server.listen({ host, port, ipv6Only: host.includes(":") })
	await once(peer.server, "listening")
	return peer
}

const config = (port: number): SourceConfig => ({
	id: "pi",
	type: "rtl_tcp",
	host: "127.0.0.1",
	port,
	loop: false,
	playbackSpeed: 1,
	caps: {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
	},
})

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}

let cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const step of cleanup.reverse()) await step()
	cleanup = []
})

async function twoPeers(): Promise<{ a: Peer; b: Peer; port: number } | null> {
	const a = await rtlPeer("127.0.0.1", 0, 0x11)
	cleanup.push(() => a.close())
	const port = (a.server.address() as net.AddressInfo).port
	try {
		const b = await rtlPeer("::1", port, 0x22)
		cleanup.push(() => b.close())
		return { a, b, port }
	} catch {
		return null // No IPv6 loopback here.
	}
}

describe("SourceManager.retarget", () => {
	it("reports no endpoint for sources that selection does not track (default output unchanged)", async () => {
		const peers = await twoPeers()
		if (!peers) return
		const manager = new SourceManager(logger)
		cleanup.push(() => manager.disconnectAll())
		await manager.connect(config(peers.port))
		const status = manager.getStatus("pi")
		expect(status).toBeDefined()
		expect(Object.keys(status ?? {})).not.toContain("endpoint")
		expect(status?.url).toBe(`127.0.0.1:${peers.port}`)
	})

	it("moves the same registration and stream to the new host without a backoff step", async () => {
		const peers = await twoPeers()
		if (!peers) return
		const manager = new SourceManager(logger)
		cleanup.push(() => manager.disconnectAll())
		const stream = await manager.connect(config(peers.port))
		const seen = new Set<number>()
		stream.on("data", (chunk: Buffer) => seen.add(chunk[chunk.length - 1] ?? 0))
		await until(() => seen.has(0x11))
		expect(manager.trackEndpoint("pi")).toBe(true)
		expect(manager.getStatus("pi")?.endpoint).toEqual({
			configuredHost: "127.0.0.1",
			activeHost: "127.0.0.1",
			reason: "configured",
			at: null,
		})

		expect(manager.retarget("pi", "::1", "verified ethernet endpoint")).toBe(
			true,
		)
		await until(() => seen.has(0x22))
		expect(peers.b.connections).toBe(1)
		expect(manager.getStream("pi")).toBe(stream)
		expect(manager.getActiveHost("pi")).toBe("::1")
		const status = manager.getStatus("pi")
		expect(status).toMatchObject({
			connected: true,
			reconnectAttempts: 0,
			url: `127.0.0.1:${peers.port}`,
			endpoint: {
				configuredHost: "127.0.0.1",
				activeHost: "::1",
				reason: "verified ethernet endpoint",
			},
		})
		expect(typeof status?.endpoint?.at).toBe("string")

		// Back to the configured host clears the override.
		manager.retarget("pi", "127.0.0.1", "fallback: test")
		await until(() => peers.a.connections === 2)
		expect(manager.getActiveHost("pi")).toBe("127.0.0.1")
		expect(manager.getStatus("pi")?.endpoint?.activeHost).toBe("127.0.0.1")
	})

	it("refuses recordings and unknown sources, and is a no-op for the current host", () => {
		const manager = new SourceManager(logger)
		expect(manager.retarget("missing", "::1", "x")).toBe(false)
		expect(manager.trackEndpoint("missing")).toBe(false)
		expect(manager.getActiveHost("missing")).toBeUndefined()
	})
})
