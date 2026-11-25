import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FetchLike } from "../../src/data/api-client.ts"
import {
	PAIRED_KEY,
	SESSION_LIFETIME_MS,
	SESSION_REFRESH_BELOW_MS,
	SESSION_REFRESH_MIN_GAP_MS,
	createDataLayer,
	shouldRefreshSession,
} from "../../src/data/index.ts"
import { recordingReadiness } from "../../src/data/recording-readiness.ts"
import { connectionNotice } from "../../src/features/connection/notice.ts"
import { isReadOnly } from "../../src/app/context.ts"
import { json } from "./fake-fetch.ts"
import { fakeSockets } from "./fake-socket.ts"

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

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
const session = (expiresAt: number) => ({
	deviceId: `device_${"d".repeat(43)}`,
	expiresAt,
	csrfToken: "a".repeat(43),
})

function memoryStorage(seed: Record<string, string> = {}) {
	const m = new Map(Object.entries(seed))
	return {
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
		map: m,
	}
}

class FocusTarget extends EventTarget {
	focus() {
		this.dispatchEvent(new Event("focus"))
	}
}

class VisibilityTarget extends EventTarget {
	visibilityState = "visible"
	show(state: "visible" | "hidden") {
		this.visibilityState = state
		this.dispatchEvent(new Event("visibilitychange"))
	}
}

function core(opts: { session: () => Response; refresh?: () => Response }): {
	fetch: FetchLike
	refreshes: () => number
} {
	let n = 0
	const fetch: FetchLike = async (url, init) => {
		const path = url.replace(/\?.*$/, "")
		const method = init?.method ?? "GET"
		if (path === "/api/access/bootstrap") return json(200, BOOTSTRAP)
		if (path === "/api/access/session" && method === "GET")
			return opts.session()
		if (path === "/api/access/session/refresh") {
			n += 1
			return (opts.refresh ?? (() => json(500, { code: "X" })))()
		}
		return json(404, { code: "NOT_FOUND" })
	}
	return { fetch, refreshes: () => n }
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
	await vi.advanceTimersByTimeAsync(0)
}

describe("session refresh on launch and focus", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("ties the threshold to the session lifetime: 30 days less one, at most once an hour", () => {
		expect(SESSION_LIFETIME_MS).toBe(30 * DAY)
		expect(SESSION_REFRESH_BELOW_MS).toBe(29 * DAY)
		expect(SESSION_REFRESH_MIN_GAP_MS).toBe(60 * 60 * 1000)
	})

	it("refreshes below 29 days left, not at or above it, and never once expired", () => {
		const now = T0
		expect(shouldRefreshSession(now + 29 * DAY, now, null)).toBe(false)
		expect(shouldRefreshSession(now + 29 * DAY - 1, now, null)).toBe(true)
		expect(shouldRefreshSession(now + 30 * DAY, now, null)).toBe(false)
		expect(shouldRefreshSession(now + 1, now, null)).toBe(true)
		expect(shouldRefreshSession(now, now, null)).toBe(false)
		expect(shouldRefreshSession(now - 1, now, null)).toBe(false)
	})

	it("asks again only an hour after the last ask", () => {
		const exp = T0 + DAY
		const gap = SESSION_REFRESH_MIN_GAP_MS
		expect(shouldRefreshSession(exp, T0 + gap - 1, T0)).toBe(false)
		expect(shouldRefreshSession(exp, T0 + gap, T0)).toBe(true)
	})

	it("refreshes at launch with 28 days left, and focus within the hour does not ask again", async () => {
		let clock = T0
		const focus = new FocusTarget()
		const expires = T0 + 28 * DAY
		const { fetch, refreshes } = core({
			session: () => json(200, session(expires)),
			refresh: () => json(500, { code: "BUSY" }),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: focus,
		})
		await data.start()
		await flush()
		expect(refreshes()).toBe(1)
		// the failed refresh keeps the old session
		expect(data.access.get().session?.expiresAt).toBe(expires)
		clock = T0 + SESSION_REFRESH_MIN_GAP_MS - 1
		focus.focus()
		await flush()
		expect(refreshes()).toBe(1)
		clock = T0 + SESSION_REFRESH_MIN_GAP_MS
		focus.focus()
		await flush()
		expect(refreshes()).toBe(2)
		data.dispose()
	})

	it("does not refresh a fresh session at launch or on focus", async () => {
		const clock = T0
		const focus = new FocusTarget()
		const { fetch, refreshes } = core({
			session: () => json(200, session(T0 + 29 * DAY)),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: focus,
		})
		await data.start()
		focus.focus()
		await flush()
		expect(refreshes()).toBe(0)
		data.dispose()
	})

	it("takes the refreshed session: a full lifetime again, so the next focus does not ask", async () => {
		let clock = T0
		const focus = new FocusTarget()
		const { fetch, refreshes } = core({
			session: () => json(200, session(T0 + 10 * DAY)),
			refresh: () => json(200, session(clock + SESSION_LIFETIME_MS)),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: focus,
		})
		await data.start()
		await flush()
		expect(refreshes()).toBe(1)
		expect(data.access.get().session?.expiresAt).toBe(T0 + SESSION_LIFETIME_MS)
		clock = T0 + 2 * SESSION_REFRESH_MIN_GAP_MS
		focus.focus()
		await flush()
		expect(refreshes()).toBe(1)
		data.dispose()
		focus.focus()
		await flush()
		expect(refreshes()).toBe(1)
	})
})

describe("session refresh when the tab is shown, and stale answers", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("refreshes when the tab becomes visible, not when hidden, with the same hourly limit", async () => {
		let clock = T0
		const tab = new VisibilityTarget()
		const { fetch, refreshes } = core({
			session: () => json(200, session(T0 + 28 * DAY)),
			refresh: () => json(500, { code: "BUSY" }),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: null,
			visibilityTarget: tab,
		})
		await data.start()
		await flush()
		expect(refreshes()).toBe(1)
		clock = T0 + SESSION_REFRESH_MIN_GAP_MS
		tab.show("hidden")
		await flush()
		expect(refreshes()).toBe(1)
		tab.show("visible")
		await flush()
		expect(refreshes()).toBe(2)
		tab.show("visible")
		await flush()
		expect(refreshes()).toBe(2)
		data.dispose()
		clock = T0 + 3 * SESSION_REFRESH_MIN_GAP_MS
		tab.show("visible")
		await flush()
		expect(refreshes()).toBe(2)
	})

	it("drops a refresh answer that arrives after a sign-out", async () => {
		const clock = T0
		const focus = new FocusTarget()
		let answer: (r: Response) => void = () => {}
		const { fetch: base, refreshes } = core({
			session: () => json(200, session(T0 + 10 * DAY)),
		})
		const fetch: FetchLike = async (url, init) => {
			if (url === "/api/access/session/logout")
				return json(200, { revoked: true })
			if (url.startsWith("/api/access/session/refresh")) {
				void base(url, init)
				return new Promise<Response>(resolve => {
					answer = resolve
				})
			}
			return base(url, init)
		}
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: focus,
		})
		await data.start()
		await flush()
		expect(refreshes()).toBe(1)
		await data.logout()
		expect(data.access.get().session).toBeNull()
		answer(json(200, session(T0 + SESSION_LIFETIME_MS)))
		await flush()
		expect(data.access.get().session).toBeNull()
		data.dispose()
	})

	it("drops a timer refresh answer that arrives after a sign-out", async () => {
		let clock = T0
		let answer: (r: Response) => void = () => {}
		const { fetch: base, refreshes } = core({
			session: () => json(200, session(T0 + 29 * DAY)),
		})
		const fetch: FetchLike = async (url, init) => {
			if (url === "/api/access/session/logout")
				return json(200, { revoked: true })
			if (url.startsWith("/api/access/session/refresh")) {
				void base(url, init)
				return new Promise<Response>(resolve => {
					answer = resolve
				})
			}
			return base(url, init)
		}
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => clock,
			storage: memoryStorage(),
			focusTarget: null,
		})
		await data.start()
		await flush()
		expect(refreshes()).toBe(0)
		clock = T0 + 29 * DAY
		await vi.advanceTimersByTimeAsync(29 * DAY)
		expect(refreshes()).toBe(1)
		await data.logout()
		answer(json(200, session(clock + SESSION_LIFETIME_MS)))
		await flush()
		expect(data.access.get().session).toBeNull()
		data.dispose()
	})
})

describe("an expired session", () => {
	const notice = (data: ReturnType<typeof createDataLayer>) =>
		connectionNotice("open", data.access.get(), isReadOnly(data.access.get()))

	it("says Session expired, pair again when this browser was paired before", async () => {
		const storage = memoryStorage({ [PAIRED_KEY]: String(T0 - 1) })
		const { fetch } = core({
			session: () => json(401, { code: "AUTH_REQUIRED" }),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => T0,
			storage,
			focusTarget: null,
		})
		await data.start()
		expect(data.access.get().sessionExpired).toBe(true)
		expect(notice(data)?.title).toBe("Session expired, pair again")
		data.dispose()
	})

	it("keeps the bare pairing prompt for a browser never paired", async () => {
		const { fetch } = core({
			session: () => json(401, { code: "AUTH_REQUIRED" }),
		})
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => T0,
			storage: memoryStorage(),
			focusTarget: null,
		})
		await data.start()
		expect(data.access.get().sessionExpired).toBe(false)
		expect(notice(data)?.title).toBe("Pair this browser")
		data.dispose()
	})

	it("remembers a session, and forgets it on a sign-out here", async () => {
		const storage = memoryStorage()
		const { fetch } = core({
			session: () => json(200, session(T0 + 29 * DAY)),
		})
		const data = createDataLayer({
			fetch: async (url, init) =>
				url === "/api/access/session/logout"
					? json(200, { revoked: true })
					: fetch(url, init),
			createSocket: fakeSockets().factory,
			now: () => T0,
			storage,
			focusTarget: null,
		})
		await data.start()
		expect(storage.map.get(PAIRED_KEY)).toBe(String(T0 + 29 * DAY))
		await data.logout()
		expect(storage.map.has(PAIRED_KEY)).toBe(false)
		expect(data.access.get().sessionExpired).toBe(false)
		expect(notice(data)?.title).toBe("Pair this browser")
		data.dispose()
	})
})

describe("recordings still being saved, across sessions", () => {
	afterEach(() => {
		recordingReadiness.reset()
		vi.useRealTimers()
	})

	it("a sign-out forgets the links this browser saw as just linked", async () => {
		vi.useFakeTimers({ now: T0 })
		const { fetch: base } = core({
			session: () => json(200, session(T0 + 10 * DAY)),
		})
		const fetch: FetchLike = async (url, init) =>
			url === "/api/access/session/logout"
				? json(200, { revoked: true })
				: base(url, init)
		const data = createDataLayer({
			fetch,
			createSocket: fakeSockets().factory,
			now: () => T0,
			storage: memoryStorage(),
		})
		await data.start()
		await flush()
		recordingReadiness.note([
			{
				eventId: "evt_1",
				commitSeq: "1",
				kind: "decoder-reception",
				producedAt: new Date(T0).toISOString(),
				receivedAt: new Date(T0).toISOString(),
				decoderId: "dsd-fme",
				sourceId: "src-0",
				protocol: "ysf",
				category: "voice",
				frequencyHz: null,
				entityKey: "talkgroup:1",
				title: "TG 1",
				fields: [],
				recording: { id: "dsd~a.wav", durationMs: 8000 },
			},
		])
		expect(recordingReadiness.isSaving("dsd~a.wav")).toBe(true)
		await data.logout()
		expect(recordingReadiness.isSaving("dsd~a.wav")).toBe(false)
		expect(recordingReadiness.retryIn("dsd~a.wav")).toBeNull()
		data.dispose()
	})
})
