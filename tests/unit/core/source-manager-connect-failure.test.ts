/**
 * Connect-failure status of a network source: closed error classes, a validated target, a fixed
 * hint, the attempt count and time, cleared by a successful connect, and carried by
 * GET /api/sources. Loopback only: a port this test opened and closed itself.
 */
import * as net from "node:net"
import { once } from "node:events"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SourceManager } from "../../../src/core/source-manager.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"
import {
	connectErrorClass,
	connectFailureStatus,
	connectHint,
	connectTarget,
	noteConnectFailure,
} from "../../../src/core/source-manager-connect-failure.js"
import { sourceRoutes } from "../../../src/api/routes/sources.js"
import { SOURCE_CONNECT_ERROR_CLASSES } from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"

const log = createLogger({ level: "fatal" })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const close of cleanup.splice(0).reverse()) await close()
})

const withCode = (code: unknown) => Object.assign(new Error("x"), { code })

describe("connect error classes", () => {
	it.each([
		["ECONNREFUSED", "refused"],
		["ETIMEDOUT", "timeout"],
		["SOURCE_CONNECT_TIMEOUT", "timeout"],
		["EHOSTUNREACH", "unreachable"],
		["ENETUNREACH", "unreachable"],
		["EHOSTDOWN", "unreachable"],
		["ENOTFOUND", "not-found"],
		["EAI_AGAIN", "not-found"],
		["ECONNRESET", "reset"],
		["EPIPE", "reset"],
		["SOURCE_STALLED", "stalled"],
	])("%s is %s", (code, cls) => {
		expect(connectErrorClass(withCode(code))).toBe(cls)
	})

	it("anything unknown or malformed is other", () => {
		expect(connectErrorClass(withCode("EWHATEVER"))).toBe("other")
		expect(connectErrorClass(withCode(111))).toBe("other")
		expect(connectErrorClass(new Error("no code"))).toBe("other")
		expect(connectErrorClass(null)).toBe("other")
		expect(connectErrorClass("ECONNREFUSED")).toBe("other")
	})

	it("every class has a fixed hint that never carries error text", () => {
		for (const cls of SOURCE_CONNECT_ERROR_CLASSES) {
			const hint = connectHint(cls, "rx.local:1234")
			expect(hint).toContain("rx.local:1234")
			expect(connectHint(cls, null)).toContain("the configured receiver")
		}
		expect(connectHint("refused", "rx.local:1234")).toBe(
			"Nothing listening at rx.local:1234: is the bridge or rtl_tcp running?",
		)
	})
})

describe("connect target", () => {
	it("shows plain host names and addresses with a valid port", () => {
		expect(connectTarget("rx.local", 1234)).toBe("rx.local:1234")
		expect(connectTarget("127.0.0.1", 1)).toBe("127.0.0.1:1")
		expect(connectTarget("::1", 65_535)).toBe("[::1]:65535")
	})

	it("refuses ports outside 1..65535 and non-integers", () => {
		expect(connectTarget("rx", 0)).toBeNull()
		expect(connectTarget("rx", 65_536)).toBeNull()
		expect(connectTarget("rx", 1.5)).toBeNull()
		expect(connectTarget("rx", "1234")).toBeNull()
	})

	it("shows a 253-character name, not a 254-character one, and nothing with other characters", () => {
		const name = (n: number) => "a".repeat(n)
		expect(connectTarget(name(253), 80)).toBe(`${name(253)}:80`)
		expect(connectTarget(name(254), 80)).toBeNull()
		expect(connectTarget("rx\nINJECTED", 80)).toBeNull()
		expect(connectTarget("rx local", 80)).toBeNull()
		expect(connectTarget("<b>rx</b>", 80)).toBeNull()
		expect(connectTarget("", 80)).toBeNull()
		expect(connectTarget(undefined, 80)).toBeNull()
	})

	it("counts attempts and renders the status without the error message", () => {
		const first = noteConnectFailure(
			null,
			withCode("ECONNREFUSED"),
			"rx",
			1234,
			1_000,
		)
		const second = noteConnectFailure(
			first,
			withCode("ETIMEDOUT"),
			"rx",
			1234,
			2_000,
		)
		expect(connectFailureStatus(second)).toEqual({
			target: "rx:1234",
			errorClass: "timeout",
			attempts: 2,
			lastAttemptAt: new Date(2_000).toISOString(),
			hint: "No answer from rx:1234 in time: is the host up and the port open?",
		})
		const hidden = noteConnectFailure(
			null,
			withCode("ECONNREFUSED"),
			"bad host",
			1,
			0,
		)
		expect(connectFailureStatus(hidden)).not.toHaveProperty("target")
	})
})

/** A loopback port nothing listens on: opened by this test, then closed. */
async function closedPort(): Promise<number> {
	const server = net.createServer()
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const port = (server.address() as net.AddressInfo).port
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

describe("SourceManager connect failure status", () => {
	it(
		"a refused connect shows target, class, count and hint; a later connect clears it",
		{ timeout: 15_000 },
		async () => {
			const port = await closedPort()
			const manager = new SourceManager(log)
			manager.on("error", () => {})
			cleanup.push(() => manager.disconnectAll())
			// Equal-jitter backoff at its floor: the reconnect comes after half the first base delay.
			vi.spyOn(Math, "random").mockReturnValue(0)
			const before = Date.now()
			await expect(
				manager.connect({
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
				}),
			).rejects.toThrow()
			const failed = manager.getStatus("rtl")
			expect(failed?.connected).toBe(false)
			const at = Date.parse(failed?.connectFailure?.lastAttemptAt ?? "")
			expect(at).toBeGreaterThanOrEqual(before - 1)
			expect(failed?.connectFailure).toEqual({
				target: `127.0.0.1:${port}`,
				errorClass: "refused",
				attempts: 1,
				lastAttemptAt: new Date(at).toISOString(),
				hint: `Nothing listening at 127.0.0.1:${port}: is the bridge or rtl_tcp running?`,
			})

			// Something listens there now: the scheduled reconnect connects and the record goes.
			const sockets = new Set<net.Socket>()
			const server = net.createServer(socket => {
				sockets.add(socket)
				socket.on("error", () => {})
				socket.write(Buffer.from("RTL0\0\0\0\x05\0\0\0\x1d", "binary"))
			})
			server.listen(port, "127.0.0.1")
			await once(server, "listening")
			cleanup.push(async () => {
				await manager.disconnectAll()
				for (const socket of sockets) socket.destroy()
				await new Promise<void>(resolve => server.close(() => resolve()))
			})
			await once(manager, "connected")
			expect(manager.getStatus("rtl")?.connectFailure).toBeUndefined()
		},
	)
})

describe("GET /api/sources", () => {
	it("carries connectFailure through the response schema", async () => {
		const status: SourceStatus = {
			id: "rtl",
			type: "rtl_tcp",
			url: "rx:1234",
			connected: false,
			activity: {
				state: "disconnected",
				lastSampleAt: null,
				sampleAgeMs: null,
				timeoutMs: 10_000,
			},
			bytesReceived: 0,
			dataRate: 0,
			reconnectAttempts: 3,
			caps: {
				kind: "iq",
				sampleRate: 2_048_000,
				format: "U8_IQ",
				exclusive: false,
			},
			connectFailure: {
				target: "rx:1234",
				errorClass: "refused",
				attempts: 3,
				lastAttemptAt: "2026-01-01T00:00:00.000Z",
				hint: "Nothing listening at rx:1234: is the bridge or rtl_tcp running?",
			},
		}
		const app = Fastify({ logger: false })
		cleanup.push(() => app.close())
		await app.register(sourceRoutes, {
			sourceManager: {
				getAllStatus: () => [status],
				getStatus: () => status,
				getSourceAssignments: () => [],
				isSourceAvailable: () => false,
			} as unknown as SourceManager,
		})
		const res = await app.inject({ url: "/api/sources" })
		expect(res.statusCode).toBe(200)
		expect(res.json()[0].connectFailure).toEqual(status.connectFailure)
	})
})
