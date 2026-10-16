import { describe, expect, it, vi } from "vitest"
import type { ScanJob, TunerState } from "@wavekit/api-types"
import { ApiClient, ApiError } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { IdentifyStore } from "../../src/data/identify-store.ts"
import { Store } from "../../src/data/store.ts"
import { TunerStore } from "../../src/data/tuner-store.ts"
import { fakeSockets } from "./fake-socket.ts"

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	})
}

describe("Store", () => {
	it("notifies listeners with the new and previous value, only on change", () => {
		const store = new Store({ n: 1 })
		const listener = vi.fn()
		const off = store.subscribe(listener)
		const first = store.get()
		store.set(first)
		expect(listener).not.toHaveBeenCalled()
		store.update(s => ({ n: s.n + 1 }))
		expect(store.get()).toEqual({ n: 2 })
		expect(listener).toHaveBeenCalledWith({ n: 2 }, first)
		off()
		store.set({ n: 3 })
		expect(listener).toHaveBeenCalledTimes(1)
	})
})

describe("ApiClient", () => {
	it("sends credentials, JSON and the CSRF header on unsafe methods only", async () => {
		const calls: [string, RequestInit | undefined][] = []
		const api = new ApiClient({
			fetch: async (url, init) => {
				calls.push([url, init])
				return json(200, { ok: true })
			},
		})
		api.setCsrfToken("tok")
		await api.get("/api/tuner", {
			query: { a: 1, b: ["x", "y"], c: undefined },
		})
		await api.post("/api/live-audio/start", { x: 1 })
		expect(calls[0]?.[0]).toBe("/api/tuner?a=1&b=x&b=y")
		expect(calls[0]?.[1]?.credentials).toBe("include")
		expect(
			(calls[0]?.[1]?.headers as Record<string, string>)["X-WaveKit-CSRF"],
		).toBeUndefined()
		expect(
			(calls[1]?.[1]?.headers as Record<string, string>)["X-WaveKit-CSRF"],
		).toBe("tok")
		expect(calls[1]?.[1]?.body).toBe('{"x":1}')
	})

	it("maps errors to ApiError with the core's code, and 404 bootstrap to legacy", async () => {
		const api = new ApiClient({
			fetch: async url =>
				url.endsWith("/bootstrap")
					? json(404, {
							message: "Route GET:/api/access/bootstrap not found",
							error: "Not Found",
							statusCode: 404,
						})
					: json(409, {
							error: "ScannerApiError",
							code: "OUT_OF_WINDOW",
							message: "tune first",
						}),
		})
		expect(await api.bootstrap()).toEqual({ mode: "legacy" })
		const error = await api
			.post("/api/scanner/identify", {})
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ApiError)
		expect(error).toMatchObject({
			status: 409,
			code: "OUT_OF_WINDOW",
			message: "tune first",
		})
	})

	it("reports network failures as status 0", async () => {
		const api = new ApiClient({
			fetch: () => Promise.reject(new TypeError("Failed to fetch")),
		})
		await expect(api.get("/health")).rejects.toMatchObject({
			status: 0,
			code: "NETWORK_ERROR",
		})
	})
})

const tunerState = (frequency: number): TunerState =>
	({ sourceId: "rtl-0", frequency, sampleRate: 2_400_000 }) as TunerState

describe("TunerStore", () => {
	it("loads, follows tuner:state-changed and tunes via REST", async () => {
		const posted: unknown[] = []
		const api = new ApiClient({
			fetch: async (url, init) => {
				if (init?.method === "POST") {
					posted.push(JSON.parse(String(init.body)))
					return json(200, tunerState(156_800_000))
				}
				return json(200, [tunerState(161_500_000)])
			},
		})
		const { factory, last } = fakeSockets()
		const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		const tuner = new TunerStore(api, events)
		events.connect()
		last().open()
		expect(last().sent).toEqual([{ type: "subscribe", channels: ["tuner"] }])
		await tuner.load()
		expect(tuner.state()?.frequency).toBe(161_500_000)
		last().receive({
			type: "tuner:state-changed",
			channel: "tuner",
			data: { sourceId: "rtl-0", state: tunerState(162_000_000) },
		})
		expect(tuner.state("rtl-0")?.frequency).toBe(162_000_000)
		await tuner.tune(156_800_000.4)
		expect(posted).toEqual([{ hz: 156_800_000 }])
		expect(tuner.get().bySource["rtl-0"]?.frequency).toBe(156_800_000)
		expect(tuner.get().pending).toEqual({})
	})
})

describe("IdentifyStore", () => {
	it("keeps progress that arrives before the POST answer", async () => {
		const { factory, last } = fakeSockets()
		const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		events.connect()
		last().open()
		let answer: (r: Response) => void = () => undefined
		const api = new ApiClient({
			fetch: () => new Promise<Response>(resolve => (answer = resolve)),
		})
		const identify = new IdentifyStore(api, events)
		const started = identify.start(161_150_000)
		expect(identify.active).toBe(true)
		const event = {
			jobId: "j_1",
			targetHz: 161_150_000,
			state: "trying",
			trials: [],
		}
		last().receive({
			type: "scanner:identify",
			channel: "scanner",
			data: event,
		})
		answer(
			json(201, {
				id: "j_1",
				state: "running",
				identify: { targets: [] },
			} as unknown as ScanJob),
		)
		await started
		expect(identify.get().event).toEqual(event)
		last().receive({
			type: "scanner:identify",
			channel: "scanner",
			data: { ...event, state: "identified" },
		})
		expect(identify.get().event?.state).toBe("identified")
		expect(identify.active).toBe(false)
		last().receive({
			type: "scanner:identify",
			channel: "scanner",
			data: { ...event, jobId: "other", state: "trying" },
		})
		expect(identify.get().event?.state).toBe("identified")
	})
})
