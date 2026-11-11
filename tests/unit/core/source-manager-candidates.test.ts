/**
 * Candidate endpoints of an rtl_tcp source: the primary, then the candidates in order,
 * with the usual backoff; the first that delivers a payload wins (a header alone does not); a delivering endpoint is
 * retried SOURCE_CANDIDATE_RETRIES times after a loss before the next one is tried. Loopback only:
 * fake rtl_tcp servers and closed ports this test opened itself (port 0). Real timers.
 */
import * as net from "node:net"
import { once } from "node:events"
import Fastify from "fastify"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SOURCE_CANDIDATE_RETRIES,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import type { SourceConfig } from "../../../src/config.js"

const log = pino({ level: "silent" })
const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

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

	it(
		`a delivering endpoint lost is retried ${SOURCE_CANDIDATE_RETRIES} times, then the next one is tried`,
		{ timeout: 60_000 },
		async () => {
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
			await primary.stop()
			// The loss and the first retries stay on the primary.
			await waitFor(
				() => (m.getStatus("rtl")?.candidate?.failures ?? 0) >= 2,
				15_000,
			)
			expect(m.getStatus("rtl")?.candidate?.index).toBe(0)
			expect(backup.accepts()).toBe(0)
			// Past the retries (1 loss + 3 refused retries = 4 losses), the backup.
			await waitFor(() => m.getStatus("rtl")?.candidate?.index === 1, 45_000)
			await waitFor(
				() => m.getStatus("rtl")?.candidate?.delivering === true,
				20_000,
			)
			expect(m.getStatus("rtl")?.candidate?.selectedBecause).toBe(
				`previous failed: refused (${SOURCE_CANDIDATE_RETRIES + 1} losses)`,
			)
			expect(backup.accepts()).toBe(1)
		},
	)

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
