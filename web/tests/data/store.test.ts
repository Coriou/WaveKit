import { describe, expect, it, vi } from "vitest"
import type { ScanJob, TunerState } from "@wavekit/api-types"
import { ApiClient, ApiError } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import { IdentifyStore, knownAt } from "../../src/data/identify-store.ts"
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

	it("shares one in-flight bootstrap between concurrent callers", async () => {
		let n = 0
		const api = new ApiClient({
			fetch: async () => {
				n += 1
				await new Promise(resolve => setTimeout(resolve, 5))
				return json(404, { error: "Not Found", statusCode: 404 })
			},
		})
		const [a, b] = await Promise.all([api.bootstrap(), api.bootstrap()])
		expect(n).toBe(1)
		expect(a).toEqual({ mode: "legacy" })
		expect(b).toBe(a)
		await api.bootstrap()
		expect(n).toBe(2)
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

	it("remembers what it identified for the session, and marks a start on its own", async () => {
		const { factory, last } = fakeSockets()
		const events = new EventsClient({ createSocket: factory, url: "ws://x/ws" })
		events.connect()
		last().open()
		const api = new ApiClient({
			fetch: () =>
				Promise.resolve(
					json(201, {
						id: "j_2",
						state: "running",
						identify: { targets: [] },
					} as unknown as ScanJob),
				),
		})
		const identify = new IdentifyStore(
			api,
			events,
			{ getItem: () => "1", setItem: () => undefined },
			() => 1000,
		)
		await identify.start(431_926_000, { auto: true })
		// on its own: answers the transmission that started it, never waits on and on
		expect(identify.get()).toMatchObject({ auto: true, waitSince: null })
		const result = {
			protocol: "dmr",
			confidence: "decoded",
			identity: { kind: "dmr-cc", value: "0" },
			metadata: {
				talkgroups: [],
				sources: [],
				slots: [],
				callsigns: [],
				capcodes: [],
				ismModels: [],
			},
			measurements: { source: "track" },
		}
		last().receive({
			type: "scanner:identify",
			channel: "scanner",
			data: {
				jobId: "j_2",
				targetHz: 431_926_000,
				state: "identified",
				trials: [],
				result,
			},
		})
		expect(identify.get().known).toEqual([
			{ hz: 431_926_000, result, at: 1000 },
		])
		identify.reset()
		expect(identify.get().known).toHaveLength(1)
		expect(knownAt(identify.get().known, 431_930_000, 6250)?.hz).toBe(
			431_926_000,
		)
		expect(knownAt(identify.get().known, 431_950_000, 6250)).toBeNull()
		identify.dispose()
	})

	it("waits until a transmission: a job that heard nothing is followed by the next", async () => {
		vi.useFakeTimers()
		try {
			const { factory, last } = fakeSockets()
			const events = new EventsClient({
				createSocket: factory,
				url: "ws://x/ws",
			})
			events.connect()
			last().open()
			const bodies: unknown[] = []
			const api = new ApiClient({
				fetch: async (_url, init) => {
					bodies.push(JSON.parse(String(init?.body)))
					return json(201, {
						id: `j_${bodies.length}`,
						state: "running",
						createdAt: new Date().toISOString(),
						identify: { timeoutMs: 120_000, targets: [] },
					} as unknown as ScanJob)
				},
			})
			const kept = new Map<string, string>()
			const storage = {
				getItem: (k: string) => kept.get(k) ?? null,
				setItem: (k: string, v: string) => void kept.set(k, v),
			}
			const identify = new IdentifyStore(api, events, storage)
			identify.setUntilSignal(true)
			expect(kept.get("wk.identify.untilSignal")).toBe("1")
			await identify.start(431_925_000)
			// WG12: the core waits for the transmission itself
			expect(bodies[0]).toMatchObject({
				waitUntilSignal: true,
				waitMs: 600_000,
			})
			const since = identify.get().waitSince
			expect(since).not.toBeNull()
			const nothing = {
				targetHz: 431_925_000,
				state: "unidentified",
				trials: [],
				result: {
					confidence: "activity",
					metadata: {},
					measurements: { source: "spectrum", class: "unknown" },
				},
			}
			last().receive({
				type: "scanner:identify",
				channel: "scanner",
				data: { ...nothing, jobId: "j_1" },
			})
			expect(identify.active).toBe(true)
			expect(identify.get().waitSince).toBe(since)
			await vi.advanceTimersByTimeAsync(600)
			expect(bodies).toHaveLength(2)
			expect(identify.get().job?.id).toBe("j_2")
			// a transmission came: the answer shows and the wait is over
			last().receive({
				type: "scanner:identify",
				channel: "scanner",
				data: {
					jobId: "j_2",
					targetHz: 431_925_000,
					state: "identified",
					trials: [],
				},
			})
			expect(identify.get().event?.state).toBe("identified")
			expect(identify.get().waitSince).toBeNull()
			await vi.advanceTimersByTimeAsync(2_000)
			expect(bodies).toHaveLength(2)
			// the choice is remembered for the next store (another page load)
			expect(new IdentifyStore(api, events, storage).get().untilSignal).toBe(
				true,
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it("waits on an older core with 2 min jobs, and follows a WG12 no-signal end", async () => {
		vi.useFakeTimers()
		try {
			const { factory, last } = fakeSockets()
			const events = new EventsClient({
				createSocket: factory,
				url: "ws://x/ws",
			})
			events.connect()
			last().open()
			const bodies: Record<string, unknown>[] = []
			const api = new ApiClient({
				fetch: async (_url, init) => {
					const body = JSON.parse(String(init?.body)) as Record<string, unknown>
					bodies.push(body)
					if (body["waitUntilSignal"] !== undefined)
						return json(400, { code: "VALIDATION_ERROR", message: "bad" })
					return json(201, {
						id: `j_${bodies.length}`,
						state: "running",
						createdAt: new Date().toISOString(),
						identify: { timeoutMs: 120_000, targets: [] },
					} as unknown as ScanJob)
				},
			})
			const identify = new IdentifyStore(api, events)
			identify.setUntilSignal(true)
			await identify.start(431_925_000)
			expect(bodies).toHaveLength(2)
			expect(bodies[1]).toMatchObject({ timeoutMs: 120_000 })
			expect(bodies[1]?.["waitUntilSignal"]).toBeUndefined()
			expect(identify.get().error).toBeNull()
			// a no-signal end (as a WG12 core says it) starts the next listen
			last().receive({
				type: "scanner:identify",
				channel: "scanner",
				data: {
					jobId: "j_2",
					targetHz: 431_925_000,
					state: "unidentified",
					trials: [],
					result: {
						confidence: "activity",
						metadata: {},
						ended: "no-signal",
						measurements: { source: "track", class: "unknown" },
					},
				},
			})
			await vi.advanceTimersByTimeAsync(600)
			expect(bodies).toHaveLength(3)
			expect(bodies[2]?.["waitUntilSignal"]).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops the wait on Stop: no next job", async () => {
		vi.useFakeTimers()
		try {
			const { factory, last } = fakeSockets()
			const events = new EventsClient({
				createSocket: factory,
				url: "ws://x/ws",
			})
			events.connect()
			last().open()
			let posts = 0
			const urls: string[] = []
			const api = new ApiClient({
				fetch: async url => {
					urls.push(url)
					if (url.endsWith("/cancel")) return json(200, {})
					posts += 1
					return json(201, {
						id: `j_${posts}`,
						state: "running",
						createdAt: new Date().toISOString(),
						identify: { targets: [] },
					} as unknown as ScanJob)
				},
			})
			const identify = new IdentifyStore(api, events)
			identify.setUntilSignal(true)
			await identify.start(431_925_000)
			last().receive({
				type: "scanner:identify",
				channel: "scanner",
				data: {
					jobId: "j_1",
					targetHz: 431_925_000,
					state: "unidentified",
					trials: [],
				},
			})
			// the next job is waiting: Stop cancels it and starts no other
			await vi.advanceTimersByTimeAsync(600)
			expect(posts).toBe(2)
			identify.reset()
			await vi.advanceTimersByTimeAsync(3_000)
			expect(posts).toBe(2)
			expect(urls.at(-1)).toMatch(/\/api\/scanner\/jobs\/j_2\/cancel$/)
			expect(identify.get().untilSignal).toBe(true)
			expect(identify.active).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})
})
