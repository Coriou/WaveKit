/**
 * Candidate endpoints of an rtl_tcp source: the primary, then the candidates in order,
 * with the usual backoff; the first that delivers a payload wins (a header alone does not); a delivering endpoint is
 * retried SOURCE_CANDIDATE_RETRIES times after a loss before the next one is tried; an endpoint
 * that accepts but sends no payload within SOURCE_SILENT_DEADLINE_MS is left. Loopback only: fake
 * rtl_tcp servers and closed ports this test opened itself (port 0). The backoff and the
 * deadlines run on fake timers where the test waits through them (socket I/O stays real).
 */
import * as net from "node:net"
import { once } from "node:events"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SOURCE_CANDIDATE_RETRIES,
	SOURCE_SILENT_DEADLINE_MS,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type { SourceConfig } from "../../../src/config.js"

const log = pino({ level: "silent" })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

/** Fake setTimeout only: the backoff and deadlines; sockets and setImmediate stay real. */
const fakeTimers = () =>
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

/** Real I/O turns between fake-time steps. */
const ioTurns = async (n = 10) => {
	for (let i = 0; i < n; i++)
		await new Promise(resolve => setImmediate(resolve))
}

/**
 * Advances fake time in 100 ms steps (real I/O between them) until `check` holds, at most
 * `fakeMs` of fake time; returns the fake time it took.
 */
const advanceUntil = async (check: () => boolean, fakeMs: number) => {
	let spent = 0
	await ioTurns()
	while (!check()) {
		if (spent >= fakeMs) throw new Error(`not reached in ${fakeMs} fake ms`)
		await vi.advanceTimersByTimeAsync(100)
		spent += 100
		await ioTurns()
	}
	return spent
}

const HEADER = Buffer.from("RTL0\0\0\0\x05\0\0\0\x1d", "binary")

async function closedPort(): Promise<number> {
	const server = net.createServer()
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const port = (server.address() as net.AddressInfo).port
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

/** A fake rtl_tcp that can stop listening (refuse) and start again on its port. */
async function fakeRtlTcp() {
	const sockets = new Set<net.Socket>()
	let accepts = 0
	const make = () =>
		net.createServer(socket => {
			accepts += 1
			sockets.add(socket)
			socket.on("error", () => {})
			socket.on("close", () => sockets.delete(socket))
			socket.write(Buffer.concat([HEADER, Buffer.alloc(1024, 127)]))
		})
	let server = make()
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const port = (server.address() as net.AddressInfo).port
	let listening = true
	const stop = async () => {
		if (!listening) return
		listening = false
		for (const s of sockets) s.destroy()
		await new Promise<void>(resolve => server.close(() => resolve()))
	}
	cleanup.push(stop)
	return {
		port,
		accepts: () => accepts,
		stop,
		start: async () => {
			server = make()
			server.listen(port, "127.0.0.1")
			await once(server, "listening")
			listening = true
		},
	}
}

const source = (
	port: number,
	candidates: NonNullable<SourceConfig["candidates"]>,
): SourceConfig => ({
	id: "rtl",
	type: "rtl_tcp",
	host: "127.0.0.1",
	port,
	loop: false,
	playbackSpeed: 1,
	stallTimeoutMs: 0,
	caps: {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
	},
	candidates,
})

const waitFor = async (check: () => boolean, ms: number) => {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}

function manager() {
	const m = new SourceManager(log)
	m.on("error", () => {})
	cleanup.push(() => m.disconnectAll())
	return m
}

describe("SourceManager candidates", () => {
	it(
		"the primary refused: the next candidate that sends a header wins, with the reason in status",
		{ timeout: 20_000 },
		async () => {
			vi.spyOn(Math, "random").mockReturnValue(0)
			const primary = await closedPort()
			const rx = await fakeRtlTcp()
			const m = manager()
			await m
				.connect(
					source(primary, [{ host: "127.0.0.1", port: rx.port, label: "usb" }]),
				)
				.catch(() => undefined)
			// connect() settles on the refused attempt; its close then rotates.
			await waitFor(() => m.getStatus("rtl")?.candidate?.index === 1, 2_000)
			expect(m.getStatus("rtl")?.candidate).toMatchObject({
				index: 1,
				count: 2,
				label: "usb",
				selectedBecause: "trying: previous failed: refused",
				delivering: false,
			})
			await waitFor(
				() => m.getStatus("rtl")?.candidate?.delivering === true,
				10_000,
			)
			expect(m.getStatus("rtl")?.candidate).toEqual({
				index: 1,
				count: 2,
				label: "usb",
				target: `127.0.0.1:${rx.port}`,
				selectedBecause: "previous failed: refused",
				delivering: true,
				failures: 0,
				retries: SOURCE_CANDIDATE_RETRIES,
			})
			expect(m.getStatus("rtl")?.connected).toBe(true)

			// GET /api/sources carries it through the response schema.
			const app = Fastify({ logger: false })
			cleanup.push(() => app.close())
			await app.register(sourceRoutes, { sourceManager: m })
			const res = await app.inject({ url: "/api/sources" })
			expect(res.statusCode).toBe(200)
			expect(res.json()[0].candidate).toMatchObject({
				index: 1,
				selectedBecause: "previous failed: refused",
			})
		},
	)

	it(
		"the primary answering first is selected as first reachable; nothing else is contacted",
		{ timeout: 10_000 },
		async () => {
			const rx = await fakeRtlTcp()
			const other = await fakeRtlTcp()
			const m = manager()
			await m.connect(
				source(rx.port, [{ host: "127.0.0.1", port: other.port }]),
			)
			await waitFor(
				() => m.getStatus("rtl")?.candidate?.delivering === true,
				5_000,
			)
			expect(m.getStatus("rtl")?.candidate).toMatchObject({
				index: 0,
				selectedBecause: "first reachable",
			})
			expect(other.accepts()).toBe(0)
		},
	)

	it(`a delivering endpoint lost is retried ${SOURCE_CANDIDATE_RETRIES} times, then the next one is tried`, async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const primary = await fakeRtlTcp()
		const backup = await fakeRtlTcp()
		const m = manager()
		await m.connect(
			source(primary.port, [{ host: "127.0.0.1", port: backup.port }]),
		)
		await waitFor(
			() => m.getStatus("rtl")?.candidate?.delivering === true,
			5_000,
		)
		fakeTimers()
		await primary.stop()
		// The loss and the first retries stay on the primary.
		await advanceUntil(
			() => (m.getStatus("rtl")?.candidate?.failures ?? 0) >= 2,
			20_000,
		)
		expect(m.getStatus("rtl")?.candidate?.index).toBe(0)
		expect(backup.accepts()).toBe(0)
		// Past the retries (1 loss + 3 refused retries = 4 losses), the backup: with Math.random
		// at 0 the equal-jitter backoff waits 1, 2, 4 and 8 s (15 s), never much more.
		const spent = await advanceUntil(
			() => m.getStatus("rtl")?.candidate?.index === 1,
			60_000,
		)
		expect(spent).toBeLessThanOrEqual(30_000)
		await advanceUntil(
			() => m.getStatus("rtl")?.candidate?.delivering === true,
			30_000,
		)
		expect(m.getStatus("rtl")?.candidate?.selectedBecause).toBe(
			`previous failed: refused (${SOURCE_CANDIDATE_RETRIES + 1} losses)`,
		)
		expect(backup.accepts()).toBe(1)
	})

	it(`an endpoint that accepts but sends nothing is left after ${SOURCE_SILENT_DEADLINE_MS} ms as silent`, async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		// Accepts and holds the connection without a byte.
		const held = new Set<net.Socket>()
		const silent = net.createServer(socket => {
			held.add(socket)
			socket.on("error", () => {})
		})
		silent.listen(0, "127.0.0.1")
		await once(silent, "listening")
		cleanup.push(async () => {
			for (const sock of held) sock.destroy()
			await new Promise<void>(resolve => silent.close(() => resolve()))
		})
		const port = (silent.address() as net.AddressInfo).port
		const backup = await fakeRtlTcp()
		const m = manager()
		fakeTimers()
		await m.connect(source(port, [{ host: "127.0.0.1", port: backup.port }]))
		expect(m.getStatus("rtl")?.connected).toBe(true)
		// Just before the deadline: still on the silent endpoint.
		await vi.advanceTimersByTimeAsync(SOURCE_SILENT_DEADLINE_MS - 100)
		await ioTurns()
		expect(m.getStatus("rtl")?.candidate?.index).toBe(0)
		expect(backup.accepts()).toBe(0)
		// At the deadline: failed as silent, rotated to the backup.
		await advanceUntil(() => m.getStatus("rtl")?.candidate?.index === 1, 200)
		expect(m.getStatus("rtl")?.candidate?.selectedBecause).toBe(
			"trying: previous failed: silent",
		)
		expect(m.getStatus("rtl")?.connectFailure).toMatchObject({
			errorClass: "silent",
			attempts: 1,
		})
		await advanceUntil(
			() => m.getStatus("rtl")?.candidate?.delivering === true,
			10_000,
		)
		expect(backup.accepts()).toBe(1)
	})

	it("a source without candidates keeps a silent connection (no deadline)", async () => {
		const held = new Set<net.Socket>()
		const silent = net.createServer(socket => {
			held.add(socket)
			socket.on("error", () => {})
		})
		silent.listen(0, "127.0.0.1")
		await once(silent, "listening")
		cleanup.push(async () => {
			for (const sock of held) sock.destroy()
			await new Promise<void>(resolve => silent.close(() => resolve()))
		})
		const port = (silent.address() as net.AddressInfo).port
		const m = manager()
		fakeTimers()
		await m.connect({ ...source(port, []), candidates: undefined })
		await vi.advanceTimersByTimeAsync(SOURCE_SILENT_DEADLINE_MS * 3)
		await ioTurns()
		expect(m.getStatus("rtl")?.connected).toBe(true)
		expect(m.getStatus("rtl")?.connectFailure).toBeUndefined()
	})

	it(
		"an endpoint that sends a header but never a payload is left: the next one is tried",
		{ timeout: 30_000 },
		async () => {
			vi.spyOn(Math, "random").mockReturnValue(0)
			// Header, then the connection closes before any sample: every time.
			let headerOnlyAccepts = 0
			const headerOnly = net.createServer(socket => {
				headerOnlyAccepts += 1
				socket.on("error", () => {})
				socket.write(HEADER, () => setTimeout(() => socket.destroy(), 50))
			})
			headerOnly.listen(0, "127.0.0.1")
			await once(headerOnly, "listening")
			cleanup.push(
				() => new Promise<void>(resolve => headerOnly.close(() => resolve())),
			)
			const port = (headerOnly.address() as net.AddressInfo).port
			const backup = await fakeRtlTcp()
			const m = manager()
			await m
				.connect(source(port, [{ host: "127.0.0.1", port: backup.port }]))
				.catch(() => undefined)
			await waitFor(() => m.getStatus("rtl")?.candidate?.index === 1, 10_000)
			await waitFor(
				() => m.getStatus("rtl")?.candidate?.delivering === true,
				10_000,
			)
			expect(headerOnlyAccepts).toBeGreaterThanOrEqual(1)
			expect(headerOnlyAccepts).toBeLessThanOrEqual(
				SOURCE_CANDIDATE_RETRIES + 1,
			)
			expect(backup.accepts()).toBe(1)
			expect(m.getStatus("rtl")?.candidate).toMatchObject({
				index: 1,
				delivering: true,
				failures: 0,
			})
		},
	)

	it("a source without candidates has no candidate status and dials its host as before", async () => {
		const rx = await fakeRtlTcp()
		const m = manager()
		await m.connect({ ...source(rx.port, []), candidates: undefined })
		expect(m.getStatus("rtl")?.candidate).toBeUndefined()
		expect(m.getSelectedCandidate("rtl")).toBeUndefined()
	})

	it("endpoint selection never retargets a source while it is on a candidate", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0)
		const primary = await closedPort()
		const m = manager()
		const rx = await fakeRtlTcp()
		await m
			.connect(source(primary, [{ host: "127.0.0.1", port: rx.port }]))
			.catch(() => undefined)
		await waitFor(() => m.getSelectedCandidate("rtl")?.index === 1, 2_000)
		expect(m.retarget("rtl", "127.0.0.2", "test")).toBe(false)
	})
})
