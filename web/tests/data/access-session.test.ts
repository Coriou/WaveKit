import { describe, expect, it } from "vitest"
import type { FetchLike } from "../../src/data/api-client.ts"
import { createDataLayer, refreshDelayMs } from "../../src/data/index.ts"
import { isReadOnly } from "../../src/app/context.ts"
import { json } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const BOOTSTRAP = {
	version: 1,
	apiOrigin: "http://rx:3000",
	analogAudioOrigin: "http://rx:8081",
	digitalAudioOrigin: "http://rx:8082",
	webSocketUrl: "ws://rx:3000/ws",
	access: { mode: "protected", sessionAvailable: true, pairingAvailable: true },
	capabilities: {
		analogAudioAvailable: true,
		digitalAudioAvailable: true,
		operatorDataAvailable: true,
	},
}
const session = (token: string) => ({
	deviceId: `device_${"d".repeat(43)}`,
	expiresAt: Date.now() + 86_400_000,
	csrfToken: token.repeat(43),
})

interface Seen {
	method: string
	path: string
	csrf: string | undefined
}

function core(answer: (method: string, path: string) => Response | null): {
	fetch: FetchLike
	seen: Seen[]
} {
	const seen: Seen[] = []
	const fetch: FetchLike = async (url, init) => {
		const method = init?.method ?? "GET"
		const path = url.replace(/\?.*$/, "")
		const headers = (init?.headers ?? {}) as Record<string, string>
		seen.push({ method, path, csrf: headers["X-WaveKit-CSRF"] })
		if (path === "/api/access/bootstrap") return json(200, BOOTSTRAP)
		return answer(method, path) ?? json(404, { code: "NOT_FOUND" })
	}
	return { fetch, seen }
}

// Feature: web app protected mode (docs/CLI-COORDINATION.md, urgent web note 2026-10-17)
describe("browser session on a protected core", () => {
	it("reads the session at start and sends its CSRF token on unsafe requests", async () => {
		const { fetch, seen } = core((method, path) =>
			path === "/api/access/session"
				? json(200, session("a"))
				: path === "/api/scanner/jobs/j1/cancel"
					? json(200, {})
					: null,
		)
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		expect(data.access.get().session?.csrfToken).toBe("a".repeat(43))
		expect(isReadOnly(data.access.get())).toBe(false)
		await data.api.post("/api/scanner/jobs/j1/cancel")
		expect(seen.at(-1)).toMatchObject({
			method: "POST",
			csrf: "a".repeat(43),
		})
		data.dispose()
	})

	it("stays read-only without a session, then pairs, reopens the socket and reloads", async () => {
		let paired = false
		const { fetch, seen } = core((method, path) => {
			if (path === "/api/access/session")
				return paired
					? json(200, session("b"))
					: json(401, { code: "AUTH_REQUIRED" })
			if (path === "/api/access/pair" && method === "POST") {
				paired = true
				return json(201, session("b"))
			}
			return null
		})
		const sockets = fakeSockets()
		const data = createDataLayer({ fetch, createSocket: sockets.factory })
		await data.start()
		expect(data.access.get().session).toBeNull()
		expect(isReadOnly(data.access.get())).toBe(true)
		const before = sockets.sockets.length
		const loadsBefore = seen.filter(s => s.path === "/api/sources").length
		await data.pair({ code: "ABCDE-FGHIJ", name: "Tablet", kind: "browser" })
		expect(isReadOnly(data.access.get())).toBe(false)
		expect(sockets.sockets.length).toBe(before + 1)
		expect(seen.filter(s => s.path === "/api/sources").length).toBe(
			loadsBefore + 1,
		)
		await data.api.patch("/api/live-audio/config", {}).catch(() => undefined)
		expect(seen.at(-1)?.csrf).toBe("b".repeat(43))
		data.dispose()
	})

	it("drops the session and the token when a request answers 401", async () => {
		const { fetch, seen } = core((_method, path) =>
			path === "/api/access/session"
				? json(200, session("c"))
				: path === "/api/tuner/s1/frequency"
					? json(401, { code: "AUTH_REQUIRED" })
					: null,
		)
		const data = createDataLayer({ fetch, createSocket: fakeSockets().factory })
		await data.start()
		await expect(
			data.api.post("/api/tuner/s1/frequency", { frequency: 1 }),
		).rejects.toMatchObject({ status: 401 })
		expect(data.access.get().session).toBeNull()
		await data.api.post("/api/tuner/s1/frequency").catch(() => undefined)
		expect(seen.at(-1)?.csrf).toBeUndefined()
		data.dispose()
	})

	it("logs out: clears the token even when the core does not answer", async () => {
		const { fetch } = core(() => null)
		const data = createDataLayer({
			fetch: async (url, init) =>
				url === "/api/access/session" && (init?.method ?? "GET") === "GET"
					? json(200, session("d"))
					: url === "/api/access/session/logout"
						? Promise.reject(new TypeError("offline"))
						: fetch(url, init),
			createSocket: fakeSockets().factory,
		})
		await data.start()
		expect(data.access.get().session).not.toBeNull()
		await expect(data.logout()).rejects.toMatchObject({ status: 0 })
		expect(data.access.get().session).toBeNull()
		data.dispose()
	})

	it("renews at half the time left, at least a minute later", () => {
		expect(refreshDelayMs(1_000_000 + 7_200_000, 1_000_000)).toBe(3_600_000)
		expect(refreshDelayMs(1_000, 1_000)).toBe(60_000)
		expect(refreshDelayMs(Number.MAX_SAFE_INTEGER, 0)).toBe(2 ** 31 - 1)
	})
})
