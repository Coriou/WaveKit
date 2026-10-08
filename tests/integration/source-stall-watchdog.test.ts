/**
 * Stall watchdog for continuous-stream rtl_tcp IQ sources, against a fake
 * rtl_tcp server that can go silent without FIN (half-open after a host reboot).
 * Design: docs/superpowers/specs/2026-10-08-tuner-reconnect-sync.md
 */

import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import {
	SOURCE_STALL_TIMEOUT_MS,
	SourceManager,
} from "../../src/core/source-manager.js"
import type { SourceConfig } from "../../src/core/source-manager.js"
import { SourceConfigSchema } from "../../src/config.js"

const logger = createLogger({ level: "fatal" })
const STALL_MS = 400

interface FakeConnection {
	socket: net.Socket
	timer?: ReturnType<typeof setInterval>
}

/** rtl_tcp-like server: header, then IQ every `intervalMs` until silenced. */
async function startServer(options: { intervalMs?: number; bytes?: number }) {
	const connections: FakeConnection[] = []
	let streaming = true
	const server = net.createServer(socket => {
		const conn: FakeConnection = { socket }
		connections.push(conn)
		socket.on("error", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		socket.write(header)
		if (options.intervalMs !== undefined && streaming) {
			conn.timer = setInterval(() => {
				if (streaming && !socket.destroyed)
					socket.write(Buffer.alloc(options.bytes ?? 512, 127))
			}, options.intervalMs)
		}
		socket.on("close", () => clearInterval(conn.timer))
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	return {
		port,
		connections,
		/** Stop sending payload but keep every socket open (no FIN). */
		goSilent() {
			streaming = false
			for (const conn of connections) clearInterval(conn.timer)
		},
		async close() {
			for (const conn of connections) {
				clearInterval(conn.timer)
				conn.socket.destroy()
			}
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}

function rtlSource(
	port: number,
	overrides: Partial<SourceConfig> = {},
): SourceConfig {
	return {
		id: "rtl-1",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: STALL_MS,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2_048_000,
			exclusive: false,
		},
		...overrides,
	}
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting")
		await new Promise(resolve => setTimeout(resolve, 10))
	}
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.restoreAllMocks()
})

async function setup(
	serverOptions: { intervalMs?: number; bytes?: number },
	overrides: Partial<SourceConfig> = {},
	consume = true,
) {
	vi.spyOn(Math, "random").mockReturnValue(0) // reconnect backoff = 2 s
	const server = await startServer(serverOptions)
	cleanups.push(() => server.close())
	const manager = new SourceManager(logger)
	cleanups.push(() => manager.disconnectAll())
	const disconnects: Array<string | undefined> = []
	manager.on("disconnected", (_id, err) => disconnects.push(err?.message))
	const payloadStarts: string[] = []
	manager.on("payload-started", id => payloadStarts.push(id))
	const stream = await manager.connect(rtlSource(server.port, overrides))
	if (consume) stream.resume()
	await waitFor(() => server.connections.length === 1)
	return { server, manager, disconnects, stream, payloadStarts }
}

describe("source stall watchdog", () => {
	it("defaults to 15 s and validates the config (0 = off, otherwise >= 1 s)", () => {
		expect(SOURCE_STALL_TIMEOUT_MS).toBe(15_000)
		const base = rtlSource(1234, {})
		delete (base as { stallTimeoutMs?: number }).stallTimeoutMs
		expect(SourceConfigSchema.parse(base).stallTimeoutMs).toBeUndefined()
		expect(
			SourceConfigSchema.parse({ ...base, stallTimeoutMs: 0 }).stallTimeoutMs,
		).toBe(0)
		expect(
			SourceConfigSchema.safeParse({ ...base, stallTimeoutMs: 500 }).success,
		).toBe(false)
	})

	it("reconnects a half-open rtl_tcp source that stops streaming, without a reconnect storm", async () => {
		const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive")
		const { server, manager, disconnects, payloadStarts } = await setup({
			intervalMs: 50,
		})
		await waitFor(
			() => manager.getStatus("rtl-1")?.activity.state === "streaming",
		)
		expect(keepAlive).toHaveBeenCalledWith(true, 5000)
		expect(payloadStarts).toEqual(["rtl-1"]) // once per session, not per chunk

		const silentAt = Date.now()
		server.goSilent()
		await waitFor(() => disconnects.length === 1)
		expect(Date.now() - silentAt).toBeLessThan(STALL_MS * 4)
		expect(disconnects[0]).toMatch(/no data .*stall watchdog/i)
		expect(manager.getStatus("rtl-1")?.lastError).toMatch(/stall watchdog/i)

		// Normal reconnect/backoff path brings up a new connection.
		await waitFor(() => server.connections.length === 2)
		await waitFor(() => manager.getStatus("rtl-1")?.connected === true)
		expect(manager.getStatus("rtl-1")?.reconnectAttempts).toBe(0)

		// The new session never streams: it is not tripped again (no storm).
		await sleep(STALL_MS * 3)
		expect(server.connections).toHaveLength(2)
		expect(disconnects).toHaveLength(1)
		expect(manager.getStatus("rtl-1")?.connected).toBe(true)
		expect(payloadStarts).toEqual(["rtl-1"]) // header alone is not payload
	}, 20_000)

	it("does not trip on a slow but non-zero stream", async () => {
		const { server, disconnects } = await setup({
			intervalMs: STALL_MS / 2,
			bytes: 2,
		})
		await sleep(STALL_MS * 5)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
	}, 20_000)

	it("keeps a connected receiver that has not produced samples (e64e16b)", async () => {
		const { server, manager, disconnects } = await setup({})
		await sleep(STALL_MS * 4)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
		expect(manager.getStatus("rtl-1")?.connected).toBe(true)
	}, 20_000)

	it("does not trip while the source is paused by local backpressure", async () => {
		const { server, manager, disconnects, stream } = await setup(
			{ intervalMs: 5, bytes: 64 * 1024 },
			{},
			false,
		)
		await waitFor(() => manager.getStatus("rtl-1")?.activity.state === "paused")
		server.goSilent()
		await sleep(STALL_MS * 3)
		expect(disconnects).toEqual([])

		// Draining resets the clock; the silent server then trips the watchdog.
		stream.resume()
		await waitFor(() => disconnects.length === 1)
		expect(disconnects[0]).toMatch(/stall watchdog/i)
	}, 20_000)

	it("is off when stallTimeoutMs is 0", async () => {
		const { server, manager, disconnects } = await setup(
			{ intervalMs: 50 },
			{ stallTimeoutMs: 0 },
		)
		await waitFor(
			() => manager.getStatus("rtl-1")?.activity.state === "streaming",
		)
		server.goSilent()
		await sleep(STALL_MS * 3)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
	}, 20_000)

	it("exempts SDR++ network sources, which may legitimately idle", async () => {
		const { server, manager, disconnects } = await setup(
			{ intervalMs: 50 },
			{
				type: "sdrpp-network",
				caps: {
					kind: "audio_pcm",
					format: "S16LE",
					sampleRate: 48_000,
					exclusive: false,
				},
			},
		)
		await waitFor(() => (manager.getStatus("rtl-1")?.bytesReceived ?? 0) > 0)
		server.goSilent()
		await sleep(STALL_MS * 3)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
	}, 20_000)

	it("stops the watchdog on explicit disconnect", async () => {
		const { server, manager, disconnects } = await setup({ intervalMs: 50 })
		await waitFor(
			() => manager.getStatus("rtl-1")?.activity.state === "streaming",
		)
		await manager.disconnect("rtl-1")
		await sleep(50) // the explicit close emits 'disconnected' asynchronously
		const afterDisconnect = disconnects.length
		server.goSilent()
		await sleep(STALL_MS * 3)
		expect(disconnects).toHaveLength(afterDisconnect)
		expect(disconnects.some(m => /stall/i.test(m ?? ""))).toBe(false)
		expect(server.connections).toHaveLength(1)
		expect(manager.getStatus("rtl-1")).toBeUndefined()
	}, 20_000)

	it("does not arm on the rtl_tcp header when the format keeps it in-stream (non-U8_IQ)", async () => {
		const { server, disconnects } = await setup(
			{},
			{
				caps: {
					kind: "iq",
					format: "S16_IQ",
					sampleRate: 2_048_000,
					exclusive: false,
				},
			},
		)
		await sleep(STALL_MS * 4)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
	}, 20_000)

	it("falls back to the default timeout for a non-finite stallTimeoutMs (no trip loop)", async () => {
		const { server, manager, disconnects } = await setup(
			{ intervalMs: 50 },
			{ stallTimeoutMs: Number.NaN },
		)
		await waitFor(
			() => manager.getStatus("rtl-1")?.activity.state === "streaming",
		)
		server.goSilent()
		await sleep(STALL_MS * 3)
		expect(disconnects).toEqual([])
		expect(server.connections).toHaveLength(1)
	}, 20_000)
})
