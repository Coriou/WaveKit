import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	Discovery,
	ScannerDiscoveryEventData,
	ScanJob,
	ScanJobHit,
	ScannerStatus,
} from "@wavekit/api-types"
import { ApiClient, isApiError } from "../../src/data/api-client.ts"
import { EventsClient } from "../../src/data/events-client.ts"
import {
	ScannerStore,
	absorbedBy,
	deriveJobs,
	discoveryComparator,
	matchesDiscoveryQuery,
	takeoverImpact,
} from "../../src/data/scanner-store.ts"
import type { WriteOrderLimits } from "../../src/data/write-order.ts"
import { fakeSockets } from "./fake-socket.ts"

const T0 = Date.parse("2026-10-17T08:00:00.000Z")
const iso = (s: number) => new Date(T0 + s * 1000).toISOString()

function discovery(id: string, over: Partial<Discovery> = {}): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	return {
		id,
		frequencyHz: 446_006_250,
		frequencyKey: "446006250",
		measuredOffsetHz: 0,
		bandwidthHz: 12_500,
		protocol: "dmr",
		family: "digital-voice",
		class: "fsk4-12k5",
		confidence: "decoded",
		encrypted: false,
		coChannel: [],
		firstSeenAt: iso(0),
		lastSeenAt: iso(10),
		observationCount: 1,
		airtimeMs: 1000,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["pi"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	}
}

function job(id: string, over: Partial<ScanJob> = {}): ScanJob {
	return {
		resumeAt: null,
		resumeHeldBy: null,
		id,
		name: null,
		state: "running",
		passive: false,
		spec: { kind: "discover", mode: "sweep" } as ScanJob["spec"],
		plan: {
			hops: [
				{
					index: 0,
					centreHz: 446_000_000,
					covered: { startHz: 445e6, endHz: 447e6 },
					channelCount: 10,
					dcAdjacentChannelsHz: [],
					excluded: [],
					dcMinEdgeHz: 0,
				},
			],
			usableHalfSpanHz: 1e6,
			dcGuardHz: 10_000,
			ppmMarginHz: 0,
		},
		issues: [],
		impact: null,
		unrestorable: [],
		progress: {
			sweepIndex: 0,
			hopIndex: 0,
			hopCount: 4,
			sweepPeriodMs: null,
			coverage: 0,
			holdingOn: null,
			settleMode: null,
			probes: [],
			counts: {
				observations: 0,
				transients: 0,
				discoveries: { activity: 0, candidate: 0, classified: 0, decoded: 0 },
			},
		},
		createdAt: iso(0),
		updatedAt: iso(0),
		...over,
	}
}

const STATUS = { enabled: true, engines: [] } as unknown as ScannerStatus

interface Call {
	method: string
	url: string
	body: unknown
}

type Route = (call: Call) => { status?: number; body?: unknown } | undefined

function setup(route: Route = () => undefined) {
	const calls: Call[] = []
	const api = new ApiClient({
		fetch: async (url, init) => {
			const call: Call = {
				method: init?.method ?? "GET",
				url,
				body:
					typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			}
			calls.push(call)
			if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
			const answer = route(call) ?? defaults(call)
			return new Response(
				answer.body === undefined ? null : JSON.stringify(answer.body),
				{ status: answer.status ?? 200 },
			)
		},
	})
	const sockets = fakeSockets()
	const events = new EventsClient({ createSocket: sockets.factory })
	events.connect()
	sockets.last().open()
	const frames: (() => void)[] = []
	const store = new ScannerStore(api, events, {
		frame: {
			request: cb => frames.push(cb),
			cancel: h => {
				frames[(h as number) - 1] = () => undefined
			},
		},
	})
	const send = (type: string, data: unknown) =>
		sockets.last().receive({ type, channel: "scanner", data })
	const tick = () => {
		for (const f of frames.splice(0)) f()
	}
	return { api, events, sockets, store, calls, send, tick, frames }
}

function defaults(call: Call): { status?: number; body?: unknown } {
	const path = call.url.split("?")[0]
	if (path === "/api/scanner") return { body: STATUS }
	if (path === "/api/scanner/jobs" && call.method === "GET") return { body: [] }
	if (path === "/api/scanner/bandplans") return { body: [] }
	if (path === "/api/scanner/discoveries")
		return { body: { items: [], nextCursor: null } }
	return { status: 404, body: { code: "SCANNER_NOT_FOUND", message: "nope" } }
}

afterEach(() => {
	vi.useRealTimers()
})

describe("ScannerStore loading", () => {
	it("load() fetches status, jobs and band plans and derives sweep and passive", async () => {
		const sweep = job("j1")
		const passive = job("jp", { passive: true })
		const identify = job("ji", {
			spec: { kind: "identify" } as ScanJob["spec"],
			createdAt: iso(5),
		})
		const { store, calls } = setup(call =>
			call.url === "/api/scanner/jobs"
				? { body: [sweep, passive, identify] }
				: undefined,
		)
		await store.load()
		const s = store.get()
		expect(s.status).toEqual(STATUS)
		expect(s.jobsLoaded).toBe(true)
		expect(s.sweep?.id).toBe("j1")
		expect(s.passive?.id).toBe("jp")
		expect(s.bandplans).toEqual([])
		expect(store.progress.get()).toMatchObject({
			jobId: "j1",
			hopCount: 4,
			centerHz: 446_000_000,
		})
		await store.loadBandplans()
		expect(calls.filter(c => c.url === "/api/scanner/bandplans")).toHaveLength(
			1,
		)
	})

	it("keeps the status error and code (scanner disabled)", async () => {
		const { store } = setup(call =>
			call.url === "/api/scanner"
				? {
						status: 503,
						body: { code: "SCANNER_DISABLED", message: "Scanner is disabled" },
					}
				: undefined,
		)
		await store.load()
		expect(store.get().statusError).toBe("Scanner is disabled")
		expect(store.get().statusErrorCode).toBe("SCANNER_DISABLED")
	})

	it("refreshDiscoveries sends the real query params and loadMore follows the cursor", async () => {
		const { store, calls } = setup(call => {
			if (!call.url.startsWith("/api/scanner/discoveries")) return undefined
			return call.url.includes("cursor=2")
				? {
						body: { items: [discovery("c"), discovery("b")], nextCursor: null },
					}
				: {
						body: {
							items: [discovery("a"), discovery("b")],
							nextCursor: "2",
						},
					}
		})
		await store.refreshDiscoveries({
			q: "base",
			identity: "dmr-cc:1",
			protocol: "dmr",
			minConfidence: "candidate",
			freqMinHz: 1,
			freqMaxHz: 2,
			sort: "frequency",
			limit: 2,
		})
		const url = calls.at(-1)?.url ?? ""
		const params = new URLSearchParams(url.split("?")[1])
		expect(Object.fromEntries(params)).toEqual({
			q: "base",
			identity: "dmr-cc:1",
			protocol: "dmr",
			minConfidence: "candidate",
			freqMinHz: "1",
			freqMaxHz: "2",
			sort: "frequency",
			limit: "2",
		})
		expect(store.get().discoveries).toMatchObject({
			loaded: true,
			loading: false,
			nextCursor: "2",
		})
		await store.loadMore()
		expect(calls.at(-1)?.url).toContain("cursor=2")
		expect(store.get().discoveries.items.map(d => d.id)).toEqual([
			"a",
			"b",
			"c",
		])
		expect(store.get().discoveries.nextCursor).toBeNull()
		await store.loadMore()
		expect(
			calls.filter(c => c.url.startsWith("/api/scanner/discoveries")),
		).toHaveLength(2)
	})

	it("a newer refresh wins over an older one still in flight", async () => {
		let release: (() => void) | null = null
		const api = new ApiClient({
			fetch: (url, init) =>
				new Promise((resolve, reject) => {
					const answer = () =>
						resolve(
							new Response(
								JSON.stringify({
									items: [discovery(url.includes("q=new") ? "new" : "old")],
									nextCursor: null,
								}),
							),
						)
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					)
					if (url.includes("q=old")) release = answer
					else answer()
				}),
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		const store = new ScannerStore(api, events)
		const first = store.refreshDiscoveries({ q: "old" })
		await store.refreshDiscoveries({ q: "new" })
		;(release as (() => void) | null)?.()
		await first
		expect(store.get().discoveries.items.map(d => d.id)).toEqual(["new"])
		expect(store.get().discoveries.error).toBeNull()
		store.dispose()
	})

	it("asks again without the evidence filter when the core refuses it", async () => {
		const { store, calls } = setup(call =>
			call.url.includes("evidence=")
				? { status: 400, body: { code: "VALIDATION_ERROR", message: "bad" } }
				: call.url.startsWith("/api/scanner/discoveries")
					? { body: { items: [discovery("a")], nextCursor: null } }
					: undefined,
		)
		await store.refreshDiscoveries({ evidence: "proven" })
		await vi.waitFor(() => expect(store.get().discoveries.loaded).toBe(true))
		expect(calls.map(c => c.url)).toEqual([
			"/api/scanner/discoveries?evidence=proven",
			"/api/scanner/discoveries",
		])
		expect(store.get().discoveries).toMatchObject({
			evidenceSupported: false,
			error: null,
			query: {},
		})
	})

	it("records a list error", async () => {
		const { store } = setup(call =>
			call.url.startsWith("/api/scanner/discoveries")
				? { status: 400, body: { code: "VALIDATION_ERROR", message: "bad" } }
				: undefined,
		)
		await store.refreshDiscoveries({})
		expect(store.get().discoveries).toMatchObject({
			loaded: false,
			loading: false,
			error: "bad",
		})
	})
})

describe("ScannerStore live events", () => {
	async function loaded(items: Discovery[], nextCursor: string | null = null) {
		const ctx = setup(call =>
			call.url.startsWith("/api/scanner/discoveries")
				? { body: { items, nextCursor } }
				: undefined,
		)
		await ctx.store.load()
		await ctx.store.refreshDiscoveries({})
		return ctx
	}

	it("coalesces events into one snapshot per frame", async () => {
		const { store, send, tick } = await loaded([])
		const listener = vi.fn()
		store.subscribe(listener)
		send("scanner:discovery", { change: "created", discovery: discovery("a") })
		send("scanner:discovery", {
			change: "created",
			discovery: discovery("b", { lastSeenAt: iso(20) }),
		})
		send("scanner:status", STATUS)
		expect(listener).not.toHaveBeenCalled()
		tick()
		expect(listener).toHaveBeenCalledTimes(1)
		expect(store.get().discoveries.items.map(d => d.id)).toEqual(["b", "a"])
	})

	it("applies created, updated, upgraded and deleted", async () => {
		const { store, send, tick } = await loaded([discovery("a")])
		send("scanner:discovery", {
			change: "upgraded",
			discovery: discovery("a", { confidence: "decoded", lastSeenAt: iso(30) }),
		})
		send("scanner:discovery", {
			change: "created",
			discovery: discovery("b", { lastSeenAt: iso(20) }),
		})
		tick()
		expect(store.get().discoveries.items.map(d => d.id)).toEqual(["a", "b"])
		send("scanner:discovery", { change: "deleted", discovery: discovery("a") })
		tick()
		expect(store.get().discoveries.items.map(d => d.id)).toEqual(["b"])
		expect(store.discovery("a")).toBeUndefined()
	})

	it("drops an update that no longer matches the query", async () => {
		const { store, send, tick } = await loaded([discovery("a")])
		await store.refreshDiscoveries({ minConfidence: "decoded" })
		send("scanner:discovery", {
			change: "updated",
			discovery: discovery("a", { confidence: "candidate" }),
		})
		tick()
		expect(store.get().discoveries.items).toHaveLength(0)
		expect(store.discovery("a")?.confidence).toBe("candidate")
	})

	it("does not insert past the loaded pages", async () => {
		const ctx = setup(call =>
			call.url.startsWith("/api/scanner/discoveries")
				? {
						body: {
							items: [discovery("a", { frequencyHz: 100 })],
							nextCursor: "1",
						},
					}
				: undefined,
		)
		await ctx.store.refreshDiscoveries({ sort: "frequency" })
		ctx.send("scanner:discovery", {
			change: "created",
			discovery: discovery("z", { frequencyHz: 900 }),
		})
		ctx.send("scanner:discovery", {
			change: "created",
			discovery: discovery("b", { frequencyHz: 50 }),
		})
		ctx.tick()
		expect(ctx.store.get().discoveries.items.map(d => d.id)).toEqual(["b", "a"])
		expect(ctx.store.discovery("z")).toBeDefined()
	})

	it("on merged replaces the survivor and drops the absorbed one", async () => {
		const { store, send, tick } = await loaded([
			discovery("keep", { lastSeenAt: iso(5) }),
			discovery("drop", { lastSeenAt: iso(4) }),
			discovery("other", { frequencyKey: "1", lastSeenAt: iso(3) }),
		])
		send("scanner:discovery", {
			change: "merged",
			discovery: discovery("keep", {
				identity: { kind: "dmr-cc", value: "1" },
				lastSeenAt: iso(6),
			}),
		})
		tick()
		expect(store.get().discoveries.items.map(d => d.id)).toEqual([
			"keep",
			"other",
		])
	})

	it("on merged drops exactly the ids the core names (WG12 mergedIds)", async () => {
		const { store, send, tick } = await loaded([
			discovery("keep", { lastSeenAt: iso(5) }),
			discovery("lookalike", { lastSeenAt: iso(4) }),
			discovery("far", { frequencyKey: "1", lastSeenAt: iso(3) }),
		])
		send("scanner:discovery", {
			change: "merged",
			discovery: discovery("keep", { lastSeenAt: iso(6) }),
			mergedIds: ["far"],
		})
		tick()
		expect(store.get().discoveries.items.map(d => d.id)).toEqual([
			"keep",
			"lookalike",
		])
	})

	it("tracks job hits from discovery events for live jobs", async () => {
		const ctx = setup(call =>
			call.url === "/api/scanner/jobs" ? { body: [job("j1")] } : undefined,
		)
		await ctx.store.load()
		const hit: ScanJobHit = {
			jobId: "j1",
			discoveryId: "a",
			hits: 3,
			firstHitAt: iso(1),
			lastHitAt: iso(2),
			firstSeenInJob: true,
		}
		ctx.send("scanner:discovery", {
			change: "updated",
			discovery: discovery("a"),
			jobHits: [hit],
		})
		ctx.tick()
		expect(ctx.store.get().jobHits.get("j1")?.get("a")).toEqual(hit)
		// discoveries were never listed: the event is still kept by id
		expect(ctx.store.get().discoveries.items).toHaveLength(0)
		expect(ctx.store.discovery("a")).toBeDefined()
	})

	it("keeps the last sweep's hits after it ends and drops older ended jobs'", async () => {
		const ctx = setup(call =>
			call.url === "/api/scanner/jobs"
				? { body: [job("old"), job("j1", { createdAt: iso(9) })] }
				: undefined,
		)
		await ctx.store.load()
		for (const jobId of ["old", "j1"])
			ctx.send("scanner:discovery", {
				change: "updated",
				discovery: discovery("a"),
				jobHits: [
					{
						jobId,
						discoveryId: "a",
						hits: 1,
						firstHitAt: iso(1),
						lastHitAt: iso(1),
						firstSeenInJob: false,
					},
				],
			})
		ctx.tick()
		ctx.send(
			"scanner:job",
			job("old", { state: "cancelled", updatedAt: iso(20) }),
		)
		ctx.send(
			"scanner:job",
			job("j1", { state: "completed", createdAt: iso(9), updatedAt: iso(20) }),
		)
		ctx.tick()
		const s = ctx.store.get()
		expect(s.sweep).toBeNull()
		expect(s.lastSweepId).toBe("j1")
		expect([...s.jobHits.keys()]).toEqual(["j1"])
	})

	it("publishes sweep progress, at most once per frame", async () => {
		const ctx = setup(call =>
			call.url === "/api/scanner/jobs" ? { body: [job("j1")] } : undefined,
		)
		await ctx.store.load()
		const listener = vi.fn()
		ctx.store.progress.subscribe(listener)
		const progress = (hopIndex: number, jobId = "j1") => ({
			jobId,
			state: "running",
			sweepIndex: 1,
			hopIndex,
			hopCount: 4,
			centerHz: 446e6,
			coverage: 0.5,
			probes: 0,
		})
		ctx.send("scanner:progress", progress(1))
		ctx.send("scanner:progress", progress(2))
		ctx.send("scanner:progress", progress(3, "other"))
		ctx.tick()
		expect(listener).toHaveBeenCalledTimes(1)
		expect(ctx.store.progress.get()).toMatchObject({ hopIndex: 2 })
		ctx.send("scanner:progress", { ...progress(2), state: "holding" })
		ctx.tick()
		expect(ctx.store.get().sweep?.state).toBe("holding")
	})

	it("new sweep job via scanner:job becomes the sweep", async () => {
		const { store, send, tick } = await loaded([])
		send("scanner:job", job("j2", { state: "starting" }))
		tick()
		expect(store.get().sweep?.id).toBe("j2")
		expect(store.progress.get()?.jobId).toBe("j2")
		send("scanner:job", job("j2", { state: "cancelled", updatedAt: iso(1) }))
		tick()
		expect(store.get().sweep).toBeNull()
		expect(store.progress.get()).toBeNull()
	})

	it("activeNow follows activity and clears stale observations after ~10 s", async () => {
		vi.useFakeTimers({ now: T0 })
		const { store, send, tick } = await loaded([])
		const activity = (observationId: string, active: boolean) => ({
			sourceId: "pi",
			observationId,
			discoveryId: `d_${observationId}`,
			jobIds: [],
			frequencyHz: 446e6,
			active,
			peakDbfs: -30,
		})
		send("scanner:activity", activity("o1", true))
		send("scanner:activity", activity("o2", true))
		tick()
		expect([...store.get().activeNow]).toEqual(["d_o1", "d_o2"])
		const before = store.get().activeNow
		send("scanner:activity", activity("o1", true))
		tick()
		expect(store.get().activeNow).toBe(before)
		send("scanner:activity", activity("o2", false))
		tick()
		expect([...store.get().activeNow]).toEqual(["d_o1"])
		vi.advanceTimersByTime(10_100)
		tick()
		expect(store.get().activeNow.size).toBe(0)
		expect(store.get().activity.size).toBe(0)
	})

	it("re-syncs on reconnect", async () => {
		const { store, sockets, calls, send, tick } = await loaded([discovery("a")])
		send("scanner:activity", {
			sourceId: "pi",
			observationId: "o",
			discoveryId: "a",
			jobIds: [],
			frequencyHz: 1,
			active: true,
			peakDbfs: -30,
		})
		tick()
		const before = calls.length
		vi.useFakeTimers()
		sockets.last().drop()
		vi.advanceTimersByTime(20_000)
		vi.useRealTimers()
		sockets.last().open()
		await vi.waitFor(() => {
			const urls = calls.slice(before).map(c => c.url.split("?")[0])
			expect(urls).toEqual(
				expect.arrayContaining([
					"/api/scanner",
					"/api/scanner/jobs",
					"/api/scanner/discoveries",
				]),
			)
		})
		expect(store.get().activeNow.size).toBe(0)
		const resub = sockets.last().sent as { type: string; channels?: string[] }[]
		expect(
			resub.some(
				m => m.type === "subscribe" && m.channels?.includes("scanner"),
			),
		).toBe(true)
	})
})

describe("ScannerStore actions", () => {
	it("startJob sends takeover and surfaces SCANNER_TAKEOVER_REQUIRED with its impact", async () => {
		const impact = {
			liveAudioClients: 1,
			digitalVoiceListeners: 0,
			runningDecoders: ["adsb"],
			pinnedDecoders: [],
			scannerJobs: [],
			unrestorable: [],
		}
		const { store, calls } = setup(call => {
			if (call.url !== "/api/scanner/jobs" || call.method !== "POST")
				return undefined
			const body = call.body as { takeover?: boolean }
			return body.takeover
				? { status: 201, body: job("j9", { state: "starting" }) }
				: {
						status: 409,
						body: {
							code: "SCANNER_TAKEOVER_REQUIRED",
							message: "resend with takeover",
							details: { impact },
						},
					}
		})
		const spec = { mode: "sweep" as const, bandplans: ["pmr446"] }
		const error = await store.startJob(spec).catch((e: unknown) => e)
		expect(isApiError(error) && error.code).toBe("SCANNER_TAKEOVER_REQUIRED")
		expect(takeoverImpact(error)).toEqual(impact)
		const started = await store.startJob(spec, { takeover: true })
		expect(started.id).toBe("j9")
		expect(calls.at(-1)?.body).toEqual({ ...spec, takeover: true })
		expect(store.get().sweep?.id).toBe("j9")
	})

	it("pause, resume, cancel and patch post to the job routes", async () => {
		const { store, calls } = setup(call => {
			const m = /^\/api\/scanner\/jobs\/j1(\/(\w+))?$/.exec(call.url)
			if (!m) return undefined
			if (call.method === "PATCH")
				return {
					body: {
						job: job("j1", { name: "Edited", updatedAt: iso(5) }),
						plan: job("j1").plan,
						issues: [],
					},
				}
			const state =
				m[2] === "pause"
					? "paused"
					: m[2] === "cancel"
						? "cancelled"
						: "running"
			return { body: job("j1", { state, updatedAt: iso(100 + calls.length) }) }
		})
		expect((await store.pauseJob("j1")).state).toBe("paused")
		expect(store.get().sweep?.state).toBe("paused")
		await store.resumeJob("j1", { takeover: true })
		expect(calls.at(-1)).toMatchObject({
			method: "POST",
			url: "/api/scanner/jobs/j1/resume",
			body: { takeover: true },
		})
		const patched = await store.patchJob("j1", { dwellMs: 200 })
		expect(patched.job.name).toBe("Edited")
		expect(calls.at(-1)).toMatchObject({
			method: "PATCH",
			body: { dwellMs: 200 },
		})
		await store.cancelJob("j1")
		expect(calls.at(-1)?.url).toBe("/api/scanner/jobs/j1/cancel")
		expect(store.get().sweep).toBeNull()
	})

	it("cancel of a job that already ended is a success on an older core too", async () => {
		const { store } = setup(call => {
			if (call.url === "/api/scanner/jobs/j1/cancel")
				return {
					status: 409,
					body: { code: "SCANNER_INVALID_TRANSITION", message: "ended" },
				}
			if (call.url === "/api/scanner/jobs/j1")
				return { body: job("j1", { state: "completed" }) }
			return undefined
		})
		expect((await store.cancelJob("j1")).state).toBe("completed")
	})

	it("previewPlan passes the abort signal", async () => {
		const { store } = setup(call =>
			call.url === "/api/scanner/plan" ? { body: { issues: [] } } : undefined,
		)
		const abort = new AbortController()
		abort.abort()
		await expect(
			store.previewPlan({ mode: "sweep" }, { signal: abort.signal }),
		).rejects.toMatchObject({ name: "AbortError" })
		await expect(store.previewPlan({ mode: "sweep" })).resolves.toEqual({
			issues: [],
		})
	})

	it("getJobHits stores hits and stats", async () => {
		const hit: ScanJobHit = {
			jobId: "j1",
			discoveryId: "a",
			hits: 2,
			firstHitAt: iso(1),
			lastHitAt: iso(3),
			firstSeenInJob: false,
		}
		const stats = {
			discoveries: 1,
			hits: 2,
			newDiscoveries: 0,
			truncated: false,
		}
		const { store, calls } = setup(call =>
			call.url.startsWith("/api/scanner/jobs/j1/hits")
				? { body: { jobId: "j1", stats, hits: [hit] } }
				: undefined,
		)
		await store.getJobHits("j1", 50)
		expect(calls.at(-1)?.url).toBe("/api/scanner/jobs/j1/hits?limit=50")
		expect(store.get().jobHits.get("j1")?.get("a")).toEqual(hit)
		expect(store.get().jobHitStats.get("j1")).toEqual(stats)
	})

	it("patchDiscovery, deleteDiscovery and listenDiscovery", async () => {
		const { store, calls } = setup(call => {
			if (call.url.startsWith("/api/scanner/discoveries?"))
				return { body: { items: [discovery("a")], nextCursor: null } }
			if (call.url === "/api/scanner/discoveries/a" && call.method === "PATCH")
				return {
					body: discovery("a", {
						operator: call.body as NonNullable<Discovery["operator"]>,
					}),
				}
			if (call.url === "/api/scanner/discoveries/a" && call.method === "DELETE")
				return { status: 204 }
			if (call.url === "/api/scanner/discoveries/a/listen")
				return {
					body: {
						mode: "live-audio",
						sourceId: "pi",
						frequencyHz: 446e6,
						httpUrl: "/a",
						wavUrl: "/a.wav",
					},
				}
			return undefined
		})
		await store.refreshDiscoveries({})
		const d = await store.patchDiscovery("a", { label: "Site", keep: true })
		expect(d.operator).toEqual({ label: "Site", keep: true })
		expect(store.get().discoveries.items[0]?.operator?.label).toBe("Site")
		expect((await store.listenDiscovery("a")).mode).toBe("live-audio")
		await store.deleteDiscovery("a")
		expect(calls.at(-1)?.method).toBe("DELETE")
		expect(store.get().discoveries.items).toHaveLength(0)
		// already gone on the core: still resolves
		await expect(store.deleteDiscovery("missing")).resolves.toBeUndefined()
	})

	it("surfaces core errors as ApiError", async () => {
		const { store } = setup(call =>
			call.url.endsWith("/listen")
				? {
						status: 409,
						body: { code: "OUT_OF_WINDOW", message: "Not in the tuned span" },
					}
				: undefined,
		)
		await expect(store.listenDiscovery("x")).rejects.toMatchObject({
			code: "OUT_OF_WINDOW",
			status: 409,
			message: "Not in the tuned span",
		})
	})
})

describe("scanner store helpers", () => {
	it("discoveryComparator mirrors the core sorts", () => {
		const a = discovery("a", {
			frequencyHz: 2,
			confidence: "candidate",
			lastSeenAt: iso(5),
		})
		const b = discovery("b", {
			frequencyHz: 1,
			confidence: "decoded",
			lastSeenAt: iso(1),
		})
		expect([a, b].sort(discoveryComparator("lastSeen")).map(d => d.id)).toEqual(
			["a", "b"],
		)
		expect(
			[a, b].sort(discoveryComparator("frequency")).map(d => d.id),
		).toEqual(["b", "a"])
		expect(
			[a, b].sort(discoveryComparator("confidence")).map(d => d.id),
		).toEqual(["b", "a"])
	})

	it("matchesDiscoveryQuery filters like the core", () => {
		const d = discovery("a", {
			identity: { kind: "dmr-cc", value: "1" },
			operator: { label: "Base Site" },
		})
		expect(matchesDiscoveryQuery(d, { q: "base" })).toBe(true)
		expect(matchesDiscoveryQuery(d, { q: "nope" })).toBe(false)
		expect(matchesDiscoveryQuery(d, { identity: "dmr-cc: 1" })).toBe(true)
		expect(matchesDiscoveryQuery(d, { identity: "p25-nac:1" })).toBe(false)
		expect(matchesDiscoveryQuery(d, { freqMaxHz: 1 })).toBe(false)
		expect(matchesDiscoveryQuery(d, { protocol: "dmr" })).toBe(true)
	})

	it("absorbedBy names same-key, same-family, same-identity discoveries", () => {
		const keep = discovery("k")
		expect(
			absorbedBy(keep, [
				discovery("x"),
				discovery("y", { frequencyKey: "other" }),
				discovery("z", { identity: { kind: "dmr-cc", value: "2" } }),
				keep,
			]),
		).toEqual(["x"])
	})

	it("deriveJobs prefers the newest live operator job and ignores identify", () => {
		const { sweep, passive } = deriveJobs([
			job("a", { createdAt: iso(1) }),
			job("b", { createdAt: iso(2), state: "paused" }),
			job("c", { createdAt: iso(3), state: "completed" }),
			job("p", { passive: true, state: "completed" }),
		])
		expect(sweep?.id).toBe("b")
		expect(passive?.id).toBe("p")
	})
})

describe("ScannerStore: band inspection UX merges (req 3.1, 3.2)", () => {
	async function ready(items: Discovery[], route: Route = () => undefined) {
		const ctx = setup(
			call =>
				route(call) ??
				(call.url.startsWith("/api/scanner/discoveries")
					? { body: { items, nextCursor: null } }
					: undefined),
		)
		await ctx.store.load()
		await ctx.store.refreshDiscoveries({})
		return ctx
	}
	const flush = () => new Promise(r => setTimeout(r, 0))

	it("a deleted survivor drops every id in mergedIds too", async () => {
		const { store, send, tick } = await ready([
			discovery("s"),
			discovery("a"),
			discovery("b"),
			discovery("keep"),
		])
		send("scanner:discovery", {
			change: "deleted",
			discovery: discovery("s"),
			mergedIds: ["a", "b"],
		})
		tick()
		const d = store.get().discoveries
		expect([...d.byId.keys()]).toEqual(["keep"])
		expect(d.items.map(x => x.id)).toEqual(["keep"])
		store.dispose()
	})

	it("mergedTruncated refetches the survivor and the list and bumps the epoch", async () => {
		const { store, send, tick, calls } = await ready([discovery("s")])
		const before = calls.length
		const epoch = store.get().discoveries.epoch
		send("scanner:discovery", {
			change: "merged",
			discovery: discovery("s"),
			mergedIds: Array.from({ length: 64 }, (_, i) => `m${i}`),
			mergedTruncated: true,
		})
		tick()
		await flush()
		const urls = calls.slice(before).map(c => c.url.split("?")[0])
		expect(urls).toContain("/api/scanner/discoveries/s")
		expect(urls).toContain("/api/scanner/discoveries")
		expect(store.get().discoveries.epoch).toBe(epoch + 1)
		store.dispose()
	})

	it("a truncated merge's refetch removes an absorbed id the event did not name", async () => {
		let list = [discovery("s"), discovery("hidden"), discovery("named")]
		const { store, send, tick } = await ready([], call =>
			call.url.split("?")[0] === "/api/scanner/discoveries"
				? { body: { items: list, nextCursor: null } }
				: call.url === "/api/scanner/discoveries/s"
					? { body: discovery("s") }
					: undefined,
		)
		await store.refreshDiscoveries({})
		expect(store.get().discoveries.byId.has("hidden")).toBe(true)
		list = [discovery("s")]
		send("scanner:discovery", {
			change: "merged",
			discovery: discovery("s"),
			mergedIds: ["named"],
			mergedTruncated: true,
		})
		tick()
		await flush()
		await flush()
		const d = store.get().discoveries
		expect([...d.byId.keys()]).toEqual(["s"])
		expect(d.items.map(x => x.id)).toEqual(["s"])
		store.dispose()
	})

	it("a span fetch reconciles its window only, and only when complete", async () => {
		let page: { items: Discovery[]; nextCursor: string | null } = {
			items: [
				discovery("in", { frequencyHz: 160e6 }),
				discovery("gone", { frequencyHz: 160.5e6 }),
				discovery("far", { frequencyHz: 433e6 }),
			],
			nextCursor: null,
		}
		const { store } = await ready([], call =>
			call.url.startsWith("/api/scanner/discoveries?")
				? { body: page }
				: undefined,
		)
		await store.fetchDiscoveries({ freqMinHz: 0, freqMaxHz: 1e9 })
		page = { items: [discovery("in", { frequencyHz: 160e6 })], nextCursor: "c" }
		await store.fetchDiscoveries({ freqMinHz: 159e6, freqMaxHz: 161e6 })
		expect(store.get().discoveries.byId.has("gone")).toBe(true)
		page = { ...page, nextCursor: null }
		await store.fetchDiscoveries({ freqMinHz: 159e6, freqMaxHz: 161e6 })
		expect([...store.get().discoveries.byId.keys()].sort()).toEqual([
			"far",
			"in",
		])
		store.dispose()
	})

	it("a truncated deleted event refetches only the list", async () => {
		const { store, send, tick, calls } = await ready([discovery("s")])
		const before = calls.length
		send("scanner:discovery", {
			change: "deleted",
			discovery: discovery("s"),
			mergedIds: ["x"],
			mergedTruncated: true,
		})
		tick()
		await flush()
		const urls = calls.slice(before).map(c => c.url.split("?")[0])
		expect(urls).toEqual(["/api/scanner/discoveries"])
		store.dispose()
	})

	it("scanner:discoveries-resync refetches the list", async () => {
		const { store, send, calls } = await ready([discovery("a")])
		const before = calls.length
		send("scanner:discoveries-resync", { reason: "consolidation", groups: 300 })
		await flush()
		expect(calls.slice(before).map(c => c.url.split("?")[0])).toEqual([
			"/api/scanner/discoveries",
		])
		expect(store.get().discoveries.epoch).toBe(1)
		store.dispose()
	})

	it("an unknown event type changes nothing (old clients ignore the resync)", async () => {
		const { store, send, calls } = await ready([discovery("a")])
		const before = calls.length
		const snapshot = store.get()
		send("scanner:something-new", { reason: "x" })
		await flush()
		expect(calls.length).toBe(before)
		expect(store.get()).toBe(snapshot)
		store.dispose()
	})

	it("reading an absorbed id replaces it with the survivor", async () => {
		const { store } = await ready([discovery("old")], call =>
			call.url === "/api/scanner/discoveries/old"
				? {
						body: discovery("new", {
							absorbedInto: "new",
							requestedId: "old",
						}),
					}
				: undefined,
		)
		const d = await store.fetchDiscovery("old")
		expect(d.id).toBe("new")
		const s = store.get().discoveries
		expect(s.byId.has("old")).toBe(false)
		expect(s.byId.has("new")).toBe(true)
		expect(s.items.some(x => x.id === "old")).toBe(false)
		store.dispose()
	})
})

describe("ScannerStore: reconcile never drops what changed after the request", () => {
	const flush = () => new Promise(r => setTimeout(r, 0))
	function deferred(writeOrderLimits?: WriteOrderLimits) {
		const pending: ((
			body: unknown,
			status?: number,
			headers?: Record<string, string>,
		) => void)[] = []
		const calls: string[] = []
		const api = new ApiClient({
			fetch: url =>
				new Promise<Response>(resolve => {
					calls.push(url)
					pending.push((body, status = 200, headers = {}) =>
						resolve(new Response(JSON.stringify(body), { status, headers })),
					)
				}),
		})
		const sockets = fakeSockets()
		const events = new EventsClient({ createSocket: sockets.factory })
		events.connect()
		sockets.last().open()
		const frames: (() => void)[] = []
		const store = new ScannerStore(api, events, {
			frame: { request: cb => frames.push(cb), cancel: () => undefined },
			resyncDelayMs: () => 0,
			...(writeOrderLimits ? { writeOrderLimits } : {}),
		})
		const send = (type: string, data: unknown) =>
			sockets.last().receive({ type, channel: "scanner", data })
		const tick = () => {
			for (const f of frames.splice(0)) f()
		}
		return { store, pending, calls, send, tick }
	}
	const span = { freqMinHz: 446e6, freqMaxHz: 446.1e6 }

	it("a span fetch that answers empty keeps a discovery created live while it was in flight", async () => {
		const { store, pending, send, tick } = deferred()
		const p = store.fetchDiscoveries(span)
		await flush()
		send("scanner:discovery", {
			change: "created",
			discovery: discovery("live"),
		})
		tick()
		pending[0]!({ items: [], nextCursor: null })
		await p
		expect(store.get().discoveries.byId.has("live")).toBe(true)
		store.dispose()
	})

	it("an older span answer arriving last removes nothing; the newest still reconciles", async () => {
		const { store, pending } = deferred()
		const first = store.fetchDiscoveries(span)
		const second = store.fetchDiscoveries(span)
		await flush()
		// the newer request answers first with a record, then the older one answers empty
		pending[1]!({ items: [discovery("a")], nextCursor: null })
		await second
		pending[0]!({ items: [], nextCursor: null })
		await first
		expect(store.get().discoveries.byId.has("a")).toBe(true)
		// a later, newest fetch that no longer has it does remove it
		const third = store.fetchDiscoveries(span)
		await flush()
		pending[2]!({ items: [], nextCursor: null })
		await third
		expect(store.get().discoveries.byId.has("a")).toBe(false)
		store.dispose()
	})

	it("a list refresh keeps what a span fetch wrote after the refresh started", async () => {
		const { store, pending } = deferred()
		const refresh = store.refreshDiscoveries({})
		const spanFetch = store.fetchDiscoveries(span)
		await flush()
		pending[1]!({ items: [discovery("b")], nextCursor: null })
		await spanFetch
		pending[0]!({ items: [], nextCursor: null })
		await refresh
		expect(store.get().discoveries.byId.has("b")).toBe(true)
		store.dispose()
	})

	it("an older span answer never protects its record from a newer complete page", async () => {
		const { store, pending } = deferred()
		const a = store.fetchDiscoveries(span)
		const b = store.fetchDiscoveries(span)
		await flush()
		// A answers after B started; B then answers with an empty complete page
		pending[0]!({ items: [discovery("x")], nextCursor: null })
		await a
		expect(store.get().discoveries.byId.has("x")).toBe(true)
		pending[1]!({ items: [], nextCursor: null })
		await b
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		store.dispose()
	})

	it("an older list refresh answer never protects its record from a newer span page", async () => {
		const { store, pending } = deferred()
		const refresh = store.refreshDiscoveries({})
		const spanFetch = store.fetchDiscoveries(span)
		await flush()
		pending[0]!({ items: [discovery("x")], nextCursor: null })
		await refresh
		pending[1]!({ items: [], nextCursor: null })
		await spanFetch
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		store.dispose()
	})

	it("an older next page never protects its record from a newer span page", async () => {
		const { store, pending } = deferred()
		const refresh = store.refreshDiscoveries({})
		await flush()
		pending[0]!({ items: [discovery("first")], nextCursor: "c1" })
		await refresh
		const more = store.loadMore()
		const spanFetch = store.fetchDiscoveries(span)
		await flush()
		pending[1]!({ items: [discovery("x")], nextCursor: null })
		await more
		pending[2]!({ items: [], nextCursor: null })
		await spanFetch
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		store.dispose()
	})

	it("an older single-record answer never protects it from a newer span page", async () => {
		const { store, pending } = deferred()
		const one = store.fetchDiscovery("x")
		const spanFetch = store.fetchDiscoveries(span)
		await flush()
		pending[0]!(discovery("x"))
		await one
		pending[1]!({ items: [], nextCursor: null })
		await spanFetch
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		store.dispose()
	})

	it("a span page that started before an operator edit answered keeps the edited record", async () => {
		const { store, pending } = deferred()
		const spanFetch = store.fetchDiscoveries(span)
		const patch = store.patchDiscovery("x", { label: "kept" })
		await flush()
		pending[1]!(discovery("x", { operator: { label: "kept" } }))
		await patch
		pending[0]!({ items: [], nextCursor: null })
		await spanFetch
		expect(store.get().discoveries.byId.has("x")).toBe(true)
		store.dispose()
	})

	const page = (...items: Discovery[]) => ({ items, nextCursor: null })
	const labelled = (id: string, label: string) =>
		discovery(id, { operator: { label } })
	const labelOf = (store: ScannerStore, id: string) =>
		store.get().discoveries.byId.get(id)?.operator?.label

	it("adds, newer answers first: an older page cannot bring back what a newer complete page left out", async () => {
		const { store, pending } = deferred()
		const a = store.fetchDiscoveries(span)
		const b = store.fetchDiscoveries(span)
		await flush()
		pending[1]!(page())
		await b
		pending[0]!(page(discovery("x")))
		await a
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		store.dispose()
	})

	it("deletes, older answer first: the newer page that still has the record restores it", async () => {
		const { store, pending } = deferred()
		const seed = store.fetchDiscoveries(span)
		await flush()
		pending[0]!(page(discovery("x")))
		await seed
		const a = store.fetchDiscoveries(span)
		const b = store.fetchDiscoveries(span)
		await flush()
		pending[1]!(page())
		await a
		expect(store.get().discoveries.byId.has("x")).toBe(false)
		pending[2]!(page(discovery("x")))
		await b
		expect(store.get().discoveries.byId.has("x")).toBe(true)
		store.dispose()
	})

	it("deletes, newer answer first: an older empty page removes nothing the newer one kept", async () => {
		const { store, pending } = deferred()
		const a = store.fetchDiscoveries(span)
		const b = store.fetchDiscoveries(span)
		await flush()
		pending[1]!(page(discovery("x")))
		await b
		pending[0]!(page())
		await a
		expect(store.get().discoveries.byId.has("x")).toBe(true)
		store.dispose()
	})

	it("same-id payloads: the newer-started answer's content wins in either arrival order", async () => {
		for (const newerFirst of [false, true]) {
			const { store, pending } = deferred()
			const a = store.fetchDiscoveries(span)
			const b = store.fetchDiscoveries(span)
			await flush()
			const answers = [
				() => pending[0]!(page(labelled("x", "older"))),
				() => pending[1]!(page(labelled("x", "newer"))),
			]
			if (newerFirst) answers.reverse()
			for (const answer of answers) {
				answer()
				await flush()
			}
			await Promise.all([a, b])
			expect(labelOf(store, "x")).toBe("newer")
			store.dispose()
		}
	})

	it("a GET that started before a PATCH never overwrites the edit, in either arrival order", async () => {
		for (const patchFirst of [true, false]) {
			const { store, pending } = deferred()
			const get = store.fetchDiscovery("x")
			const patch = store.patchDiscovery("x", { label: "kept" })
			await flush()
			const answers = [
				() => pending[0]!(labelled("x", "old")),
				() => pending[1]!(labelled("x", "kept")),
			]
			if (patchFirst) answers.reverse()
			for (const answer of answers) {
				answer()
				await flush()
			}
			await Promise.all([get, patch])
			expect(labelOf(store, "x")).toBe("kept")
			store.dispose()
		}
	})

	it("a next page in flight never overwrites a live update, nor brings back a live deletion", async () => {
		const { store, pending, send, tick } = deferred()
		const refresh = store.refreshDiscoveries({})
		await flush()
		pending[0]!({ items: [labelled("x", "first")], nextCursor: "c1" })
		await refresh
		const more = store.loadMore()
		await flush()
		send("scanner:discovery", {
			change: "updated",
			discovery: labelled("x", "live"),
		})
		send("scanner:discovery", {
			change: "deleted",
			discovery: discovery("y"),
		})
		tick()
		pending[1]!({
			items: [labelled("x", "stale"), discovery("y")],
			nextCursor: null,
		})
		await more
		const d = store.get().discoveries
		expect(d.byId.get("x")?.operator?.label).toBe("live")
		expect(d.items.find(i => i.id === "x")?.operator?.label).toBe("live")
		expect(d.byId.has("y")).toBe(false)
		expect(d.items.some(i => i.id === "y")).toBe(false)
		store.dispose()
	})

	const both = [false, true]
	/** Answers pending[first] then pending[second], or the reverse, letting each settle. */
	async function answer(
		pending: ((body: unknown, status?: number) => void)[],
		order: readonly [() => void, () => void],
		reverse: boolean,
	) {
		const steps = reverse ? [order[1], order[0]] : [order[0], order[1]]
		for (const step of steps) {
			step()
			await flush()
		}
	}

	it("a PATCH that started before a GET keeps its saved label, in either arrival order", async () => {
		for (const reverse of both) {
			const { store, pending } = deferred()
			const patch = store.patchDiscovery("x", { label: "new" })
			const get = store.fetchDiscovery("x")
			await flush()
			await answer(
				pending,
				[
					() => pending[1]!(labelled("x", "old")),
					() => pending[0]!(labelled("x", "new")),
				],
				reverse,
			)
			await Promise.all([patch, get])
			expect(labelOf(store, "x")).toBe("new")
			store.dispose()
		}
	})

	it("a DELETE that started before a GET keeps the record gone, in either arrival order", async () => {
		for (const reverse of both) {
			const { store, pending } = deferred()
			const del = store.deleteDiscovery("x")
			const get = store.fetchDiscovery("x")
			await flush()
			await answer(
				pending,
				[() => pending[1]!(discovery("x")), () => pending[0]!(null)],
				reverse,
			)
			await Promise.all([del, get])
			expect(store.get().discoveries.byId.has("x")).toBe(false)
			store.dispose()
		}
	})

	it("a GET that started before a DELETE never brings the record back, in either arrival order", async () => {
		for (const reverse of both) {
			const { store, pending } = deferred()
			const get = store.fetchDiscovery("x")
			const del = store.deleteDiscovery("x")
			await flush()
			await answer(
				pending,
				[() => pending[0]!(discovery("x")), () => pending[1]!(null)],
				reverse,
			)
			await Promise.all([get, del])
			expect(store.get().discoveries.byId.has("x")).toBe(false)
			store.dispose()
		}
	})

	it("after a PATCH answer, a newer live event or a later read still wins", async () => {
		const { store, pending, send, tick } = deferred()
		const patch = store.patchDiscovery("x", { label: "new" })
		await flush()
		pending[0]!(labelled("x", "new"))
		await patch
		send("scanner:discovery", {
			change: "updated",
			discovery: labelled("x", "live"),
		})
		tick()
		expect(labelOf(store, "x")).toBe("live")
		const get = store.fetchDiscovery("x")
		await flush()
		pending[1]!(labelled("x", "later"))
		await get
		expect(labelOf(store, "x")).toBe("later")
		store.dispose()
	})

	it("a failed PATCH or DELETE changes nothing", async () => {
		const { store, pending } = deferred()
		const seed = store.fetchDiscovery("x")
		await flush()
		pending[0]!(labelled("x", "old"))
		await seed
		const failure = { code: "SCANNER_INTERNAL", message: "nope" }
		const patch = store.patchDiscovery("x", { label: "new" })
		await flush()
		pending[1]!(failure, 500)
		await expect(patch).rejects.toSatisfy(isApiError)
		const del = store.deleteDiscovery("x")
		await flush()
		pending[2]!(failure, 500)
		await expect(del).rejects.toSatisfy(isApiError)
		expect(labelOf(store, "x")).toBe("old")
		store.dispose()
	})

	describe("with store revisions (req 3.3)", () => {
		const E = "epoch-1"
		/** A record of a current core: its revision and label. */
		const at = (
			id: string,
			revision: number,
			label: string,
			over: Partial<Discovery> = {},
		) => discovery(id, { revision, operator: { label }, ...over })
		/** The headers of a successful DELETE from a current core, at store revision `revision`. */
		const deleted = (revision: number) => ({
			"x-wavekit-store-epoch": E,
			"x-wavekit-store-revision": String(revision),
		})
		const pageAt = (storeRevision: number, ...items: Discovery[]) => ({
			items,
			nextCursor: null,
			storeEpoch: E,
			storeRevision,
		})
		const one = (d: Discovery, storeRevision = d.revision!) => ({
			...d,
			storeEpoch: E,
			storeRevision,
		})
		const event = (
			change: ScannerDiscoveryEventData["change"],
			d: Discovery,
			revision: number,
			mergedIds?: string[],
		) => ({
			change,
			discovery: d,
			revision,
			storeEpoch: E,
			...(mergedIds ? { mergedIds } : {}),
		})
		const has = (store: ScannerStore, id: string) =>
			store.get().discoveries.byId.has(id)

		it("an older page never brings back what a newer complete page left out, in either order", async () => {
			for (const reverse of both) {
				const { store, pending } = deferred()
				const a = store.fetchDiscoveries(span)
				const b = store.fetchDiscoveries(span)
				await flush()
				await answer(
					pending,
					[
						() => pending[0]!(pageAt(1, at("x", 1, "x"))),
						() => pending[1]!(pageAt(2)),
					],
					reverse,
				)
				await Promise.all([a, b])
				expect(has(store, "x")).toBe(false)
				store.dispose()
			}
		})

		it("same-id payloads: the higher revision wins in either order", async () => {
			for (const reverse of both) {
				const { store, pending } = deferred()
				const a = store.fetchDiscoveries(span)
				const b = store.fetchDiscovery("x")
				await flush()
				await answer(
					pending,
					[
						() => pending[0]!(pageAt(3, at("x", 3, "newer"))),
						() => pending[1]!(one(at("x", 1, "older"))),
					],
					reverse,
				)
				await Promise.all([a, b])
				expect(labelOf(store, "x")).toBe("newer")
				store.dispose()
			}
		})

		it("a GET taken before a PATCH never overwrites the edit, in either order", async () => {
			for (const reverse of both) {
				const { store, pending } = deferred()
				const patch = store.patchDiscovery("x", { label: "new" })
				const get = store.fetchDiscovery("x")
				await flush()
				await answer(
					pending,
					[
						() => pending[0]!(one(at("x", 2, "new"))),
						() => pending[1]!(one(at("x", 1, "old"))),
					],
					reverse,
				)
				await Promise.all([patch, get])
				expect(labelOf(store, "x")).toBe("new")
				store.dispose()
			}
		})

		for (const [what, later] of [
			["updated", event("updated", at("x", 3, "event"), 3)],
			["deleted", event("deleted", at("x", 2, "p"), 3)],
			["merged into y", event("merged", at("y", 3, "y"), 3, ["x"])],
		] as const)
			it(`a delayed PATCH answer never undoes a newer ${what} event, in either order`, async () => {
				for (const reverse of both) {
					const { store, pending, send, tick } = deferred()
					const patch = store.patchDiscovery("x", { label: "p" })
					await flush()
					await answer(
						pending,
						[
							() => pending[0]!(one(at("x", 2, "p"))),
							() => {
								send("scanner:discovery", later)
								tick()
							},
						],
						reverse,
					)
					await patch
					if (what === "updated") expect(labelOf(store, "x")).toBe("event")
					else expect(has(store, "x")).toBe(false)
					if (what === "merged into y") expect(labelOf(store, "y")).toBe("y")
					store.dispose()
				}
			})

		it("a delayed PATCH answer never brings back a completed DELETE, in either order", async () => {
			for (const reverse of both) {
				const { store, pending } = deferred()
				const patch = store.patchDiscovery("x", { label: "p" })
				const del = store.deleteDiscovery("x")
				await flush()
				await answer(
					pending,
					[() => pending[1]!(null), () => pending[0]!(one(at("x", 2, "p")))],
					reverse,
				)
				await Promise.all([patch, del])
				expect(has(store, "x")).toBe(false)
				store.dispose()
			}
		})

		it("a record a page no longer lists comes back when read at its newer place", async () => {
			const { store, pending } = deferred()
			const first = store.fetchDiscoveries(span)
			await flush()
			pending[0]!(pageAt(1, at("x", 1, "here")))
			await first
			// x moved out of the span at revision 4; the next page (taken at 5) no longer lists it
			const second = store.fetchDiscoveries(span)
			await flush()
			pending[1]!(pageAt(5))
			await second
			expect(has(store, "x")).toBe(false)
			const get = store.fetchDiscovery("x")
			await flush()
			pending[2]!(one(at("x", 4, "moved", { frequencyHz: 450e6 }), 5))
			await get
			expect(labelOf(store, "x")).toBe("moved")
			store.dispose()
		})

		it("a new epoch clears the cache and resyncs; late answers of the old epoch are dropped", async () => {
			const { store, pending, calls, send, tick } = deferred()
			const seed = store.fetchDiscoveries(span)
			const late = store.fetchDiscovery("x")
			await flush()
			pending[0]!(pageAt(9, at("x", 9, "old epoch")))
			await seed
			const epochBefore = store.get().discoveries.epoch
			// the core restarted: revisions restart at 1 under a new epoch
			send("scanner:discovery", {
				...event("updated", at("y", 2, "new epoch"), 2),
				storeEpoch: "epoch-2",
			})
			tick()
			expect(has(store, "x")).toBe(false)
			expect(labelOf(store, "y")).toBe("new epoch")
			expect(store.get().discoveries.epoch).toBe(epochBefore + 1)
			pending[1]!(one(at("x", 10, "late")))
			await late
			expect(has(store, "x")).toBe(false)
			expect(calls).toHaveLength(2)
			store.dispose()
		})

		it("an idle store past 32 complete pages still applies a fresh read of a new span", async () => {
			const { store, pending } = deferred()
			for (let i = 0; i < 33; i++) {
				const p = store.fetchDiscoveries(span)
				await flush()
				pending[i]!(pageAt(7))
				await p
			}
			const other = { freqMinHz: 450e6, freqMaxHz: 451e6 }
			const p = store.fetchDiscoveries(other)
			await flush()
			pending[33]!(pageAt(7, at("x", 7, "fresh", { frequencyHz: 450.5e6 })))
			await p
			expect(labelOf(store, "x")).toBe("fresh")
			store.dispose()
		})

		it("two reads of the same revision at the same store revision: the later-started one's coverage wins, in either order", async () => {
			const running = [{ decoderId: "dmr", state: "running" as const }]
			const stopped = [{ decoderId: "dmr", state: "stopped" as const }]
			for (const reverse of both) {
				const { store, pending } = deferred()
				const a = store.fetchDiscovery("x")
				const b = store.fetchDiscovery("x")
				await flush()
				await answer(
					pending,
					[
						() => pending[0]!(one(at("x", 5, "x", { coverage: running }), 5)),
						() => pending[1]!(one(at("x", 5, "x", { coverage: stopped }), 5)),
					],
					reverse,
				)
				await Promise.all([a, b])
				expect(store.get().discoveries.byId.get("x")?.coverage).toEqual(stopped)
				store.dispose()
			}
		})

		it("a hint tie: the later of an equal read and event wins; an event keeps the held coverage", async () => {
			const covered = [{ decoderId: "rtl433", state: "running" as const }]
			for (const getFirst of both) {
				const { store, pending, send, tick } = deferred()
				const ev = () => {
					send(
						"scanner:discovery",
						event("updated", at("x", 5, "x", { hint: "lora" }), 5),
					)
					tick()
				}
				if (!getFirst) ev()
				const get = store.fetchDiscovery("x")
				await flush()
				pending[0]!(
					one(at("x", 5, "x", { hint: "ism-device", coverage: covered }), 5),
				)
				await get
				if (getFirst) ev()
				const d = store.get().discoveries.byId.get("x")
				// the event arrived after the GET started (getFirst) or before it
				expect(d?.hint).toBe(getFirst ? "lora" : "ism-device")
				expect(d?.coverage).toEqual(covered)
				store.dispose()
			}
		})

		it("a DELETE asked before a restart never removes what the new epoch restored (204 or 404)", async () => {
			for (const status of [200, 404]) {
				const { store, pending, send, tick } = deferred()
				const seed = store.fetchDiscoveries(span)
				await flush()
				pending[0]!(pageAt(3, at("x", 3, "epoch A")))
				await seed
				const del = store.deleteDiscovery("x")
				await flush()
				send("scanner:discovery", {
					...event("updated", at("x", 2, "epoch B"), 2),
					storeEpoch: "epoch-2",
				})
				tick()
				pending[1]!(
					status === 200 ? null : { code: "SCANNER_NOT_FOUND" },
					status,
				)
				await del
				expect(labelOf(store, "x")).toBe("epoch B")
				store.dispose()
			}
		})

		it("only a first page ending the list is complete: the last page of several removes nothing", async () => {
			const { store, pending } = deferred()
			const refresh = store.refreshDiscoveries({})
			await flush()
			pending[0]!({ ...pageAt(4, at("a", 4, "a")), nextCursor: "c1" })
			await refresh
			const more = store.loadMore()
			await flush()
			pending[1]!(pageAt(4, at("b", 2, "b")))
			await more
			expect(has(store, "a")).toBe(true)
			expect(has(store, "b")).toBe(true)
			store.dispose()
		})

		it("a deletion the core stamped is remembered at its own revision: past the cap, a held GET of it stays out", async () => {
			const { store, pending, calls } = deferred({ tombstones: 2 })
			const seed = store.fetchDiscoveries(span)
			await flush()
			pending[0]!(pageAt(4, at("x", 2, "x"), at("y", 3, "y"), at("z", 4, "z")))
			await seed
			const held = store.fetchDiscovery("x")
			// the client's high-water is 4; the core deletes x, y and z at revisions 5, 6 and 7
			for (const [i, id] of (["x", "y", "z"] as const).entries()) {
				const del = store.deleteDiscovery(id)
				await flush()
				pending[calls.length - 1]!(null, 200, deleted(5 + i))
				await del
			}
			// x's tombstone left (cap 2): the floor is its revision 5, so the GET read at 4 is refused
			pending[1]!(one(at("x", 2, "x"), 4))
			await flush()
			expect(has(store, "x")).toBe(false)
			// the refusal asks again; the core answers 404 (x is gone)
			await flush()
			await flush()
			expect(calls.length).toBe(6)
			pending[5]!({ code: "SCANNER_DISCOVERY_NOT_FOUND" }, 404)
			await held.catch(() => undefined)
			expect(has(store, "x")).toBe(false)
			store.dispose()
		})

		it("a span the floor refused is read again and x appears with no event", async () => {
			const { store, pending, calls } = deferred({ coverages: 1 })
			const other = { freqMinHz: 450e6, freqMaxHz: 451e6 }
			const stale = store.fetchDiscoveries(span)
			// two pages elsewhere read at 6: the first coverage leaves, the floor rises to 6
			for (const n of [1, 2]) {
				const p = store.fetchDiscoveries(other)
				await flush()
				pending[n]!(pageAt(6))
				await p
			}
			let recorded = false
			const done = stale.then(() => {
				recorded = true
			})
			pending[0]!(pageAt(5, at("x", 1, "unchanged")))
			await flush()
			expect(has(store, "x")).toBe(false)
			expect(recorded).toBe(false)
			await flush()
			await flush()
			expect(calls.length).toBe(4)
			pending[3]!(pageAt(6, at("x", 1, "unchanged")))
			await done
			expect(recorded).toBe(true)
			expect(labelOf(store, "x")).toBe("unchanged")
			store.dispose()
		})

		const elsewhere = { freqMinHz: 450e6, freqMaxHz: 451e6 }
		/**
		 * Two held spans answered empty at revision 10, with room for one covered page: the first
		 * page's coverage left, so the floor is 10 and a stale event in `span` meets only the floor.
		 */
		async function floored() {
			const h = deferred({ coverages: 1 })
			for (const [n, q] of [span, elsewhere].entries()) {
				const p = h.store.fetchDiscoveries(q)
				await flush()
				h.pending[n]!(pageAt(10))
				await p
			}
			const refuse = (n: number, from = 0) => {
				for (let i = from; i < from + n; i++)
					h.send(
						"scanner:discovery",
						event("updated", at(`x${i}`, 5, "old"), 5),
					)
				h.tick()
			}
			const settle = async () => {
				for (let i = 0; i < 3; i++) await flush()
			}
			/** Answers every call from `from` on with an empty page at 12. */
			const answerAll = (from: number) => {
				for (let i = from; i < h.calls.length; i++) h.pending[i]!(pageAt(12))
			}
			return { ...h, refuse, settle, answerAll }
		}

		it("65 and more refused events produce one resync", async () => {
			const { store, refuse, settle, calls } = await floored()
			const before = calls.length
			refuse(70)
			expect(has(store, "x0")).toBe(false)
			await settle()
			// one resync: the two held spans read once each
			expect(calls.length - before).toBe(2)
			await settle()
			expect(calls.length - before).toBe(2)
			store.dispose()
		})

		it("refusals while a resync waits or runs never start a second one, and run exactly one more", async () => {
			const { store, refuse, settle, calls, answerAll } = await floored()
			const base = calls.length
			refuse(1)
			await settle()
			expect(calls.length - base).toBe(2)
			// refused again while the resync's reads are in flight: nothing new starts
			refuse(3, 1)
			await settle()
			expect(calls.length - base).toBe(2)
			answerAll(base)
			await settle()
			// exactly one follow-up for the refusals seen during the run
			expect(calls.length - base).toBe(4)
			answerAll(base + 2)
			await settle()
			// nothing refused since: no more
			expect(calls.length - base).toBe(4)
			store.dispose()
		})

		it("a refused id outside the list's query but inside a held span is recovered", async () => {
			const { store, refuse, settle, pending, calls } = await floored()
			const list = store.refreshDiscoveries({
				freqMinHz: 1e9,
				freqMaxHz: 1.1e9,
			})
			await flush()
			pending[calls.length - 1]!(pageAt(11))
			await list
			const base = calls.length
			refuse(1)
			expect(has(store, "x0")).toBe(false)
			await settle()
			// the resync reads both held spans and the list from its first page
			const asked = calls.slice(base)
			expect(asked).toHaveLength(3)
			expect(
				asked.filter(u => u.includes("freqMinHz=1000000000")),
			).toHaveLength(1)
			for (const [k, u] of asked.entries())
				pending[base + k]!(
					u.includes("freqMinHz=446000000")
						? pageAt(12, at("x0", 5, "recovered"))
						: pageAt(12),
				)
			await settle()
			expect(labelOf(store, "x0")).toBe("recovered")
			store.dispose()
		})

		// Feature: band-inspection-ux, Property 9: the client ends at the server's state
		// Validates: Requirements 3.2, 3.3
		it("property: any delivery order of answers, events and the store's own recovery reads ends at the server's final state", async () => {
			const ids = ["a", "b", "c"] as const
			const id = fc.constantFrom(...ids)
			const step = fc.oneof(
				fc.record({ kind: fc.constant("update" as const), id }),
				fc.record({ kind: fc.constant("delete" as const), id }),
				fc.record({ kind: fc.constant("merge" as const), id, into: id }),
				fc.record({ kind: fc.constant("span" as const) }),
				fc.record({ kind: fc.constant("read" as const), id }),
				fc.record({ kind: fc.constant("patch" as const), id }),
				fc.record({ kind: fc.constant("remove" as const), id }),
			)
			type Step = typeof step extends fc.Arbitrary<infer S> ? S : never
			type Answer = [unknown, number?, Record<string, string>?]
			const missing: Answer = [{ code: "SCANNER_DISCOVERY_NOT_FOUND" }, 404]
			/** The server: runs `steps`, returning what each request answers and every event. */
			function serve(steps: readonly Step[]) {
				let revision = 1
				// ids are unique and made by the server: all exist (unchanged, revision 1) from the
				// start, and a deleted or absorbed id never comes back
				const live = new Map<string, { revision: number; label: string }>(
					ids.map(i => [i, { revision: 1, label: `init-${i}` }]),
				)
				const gone = new Map<string, string>() // absorbed id -> survivor
				const record = (i: string) =>
					at(i, live.get(i)!.revision, live.get(i)!.label)
				const answers: (() => Answer)[] = []
				const events: unknown[] = []
				const write = (i: string, label: string) => {
					if (!live.has(i)) return false
					live.set(i, { revision: ++revision, label })
					events.push(event("updated", record(i), revision))
					return true
				}
				const remove = (i: string) => {
					if (!live.has(i)) return false
					const last = record(i)
					live.delete(i)
					events.push(event("deleted", last, ++revision))
					return true
				}
				const readOf = (i: string): Answer => {
					let target: string | undefined = i
					while (target !== undefined && !live.has(target))
						target = gone.get(target)
					if (target === undefined) return missing
					return [
						{
							...one(record(target), revision),
							...(target !== i ? { absorbedInto: target, requestedId: i } : {}),
						},
					]
				}
				const spanOf = (): Answer => [
					pageAt(revision, ...[...live.keys()].sort().map(record)),
				]
				for (const [k, s] of steps.entries()) {
					if (s.kind === "update") write(s.id, `u${k}`)
					else if (s.kind === "delete") remove(s.id)
					else if (s.kind === "merge") {
						if (s.id === s.into || !live.has(s.id) || !live.has(s.into))
							continue
						const r = ++revision
						live.delete(s.id)
						gone.set(s.id, s.into)
						live.get(s.into)!.revision = r
						events.push(event("merged", record(s.into), r, [s.id]))
					} else if (s.kind === "span") {
						const a = spanOf()
						answers.push(() => a)
					} else if (s.kind === "read") {
						const a = readOf(s.id)
						answers.push(() => a)
					} else if (s.kind === "patch") {
						const a = write(s.id, `p${k}`) ? readOf(s.id) : missing
						answers.push(() => a)
					} else {
						const a: Answer = remove(s.id)
							? [null, 200, deleted(revision)]
							: missing
						answers.push(() => a)
					}
				}
				// a recovery read the store asks for later is served from the final state
				const now = (url: string): Answer => {
					const m = /\/api\/scanner\/discoveries\/([^?]+)/.exec(url)
					return m ? readOf(decodeURIComponent(m[1]!)) : spanOf()
				}
				return { live, answers, events, now }
			}
			const scenario = fc
				.array(step, { minLength: 40, maxLength: 60 })
				.chain(steps => {
					const { answers, events } = serve(steps)
					const n = answers.length + events.length
					return fc.record({
						steps: fc.constant(steps),
						order: fc.shuffledSubarray(
							Array.from({ length: n }, (_, i) => i),
							{ minLength: n, maxLength: n },
						),
						seed: fc.integer(),
					})
				})
			await fc.assert(
				fc.asyncProperty(scenario, async ({ steps, order, seed }) => {
					const { live, answers, events, now } = serve(steps)
					// small bounds so long runs cross the eviction of removals and pages
					const { store, pending, calls, send, tick } = deferred({
						tombstones: 1,
						coverages: 1,
					})
					let rnd = seed >>> 0
					const random = () => {
						rnd = (rnd + 0x6d2b79f5) >>> 0
						let t = rnd
						t = Math.imul(t ^ (t >>> 15), t | 1)
						t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
						return ((t ^ (t >>> 14)) >>> 0) / 4294967296
					}
					const quiet = (p: Promise<unknown>) =>
						p.then(
							() => undefined,
							() => undefined,
						)
					const done: Promise<unknown>[] = []
					for (const s of steps)
						if (s.kind === "span")
							done.push(quiet(store.fetchDiscoveries(span)))
						else if (s.kind === "read")
							done.push(quiet(store.fetchDiscovery(s.id)))
						else if (s.kind === "patch")
							done.push(quiet(store.patchDiscovery(s.id, { label: "edit" })))
						else if (s.kind === "remove")
							done.push(quiet(store.deleteDiscovery(s.id)))
					await flush()
					expect(calls).toHaveLength(answers.length)
					// the ids the client has seen: named in an answer, an event or its own request
					const seen = new Set<string>()
					for (const s of steps)
						if (s.kind === "read" || s.kind === "patch" || s.kind === "remove")
							seen.add(s.id)
					const note = (body: unknown) => {
						const b = body as {
							id?: string
							items?: { id: string }[]
							discovery?: { id: string }
							mergedIds?: string[]
						} | null
						if (!b) return
						if (b.id) seen.add(b.id)
						for (const d of b.items ?? []) seen.add(d.id)
						if (b.discovery) seen.add(b.discovery.id)
						for (const m of b.mergedIds ?? []) seen.add(m)
					}
					type Message = { call: number } | { event: unknown }
					const queue: Message[] = order.map(i =>
						i < answers.length
							? { call: i }
							: { event: events[i - answers.length] },
					)
					let known = calls.length
					// every answer, event and recovery read, in a random order (random delays)
					for (;;) {
						const m = queue.shift()
						if (m === undefined) {
							for (let i = 0; i < 4 && known === calls.length; i++)
								await flush()
							if (known === calls.length) break
						} else if ("call" in m) {
							const [body, status, headers] =
								m.call < answers.length
									? answers[m.call]!()
									: now(calls[m.call]!)
							if (status === undefined || status === 200) note(body)
							pending[m.call]!(body, status, headers)
						} else {
							note(m.event)
							send("scanner:discovery", m.event)
							tick()
						}
						await flush()
						await flush()
						for (; known < calls.length; known++)
							queue.splice(Math.floor(random() * (queue.length + 1)), 0, {
								call: known,
							})
					}
					await Promise.all(done)
					const byId = store.get().discoveries.byId
					for (const i of ids)
						expect(byId.get(i)?.operator?.label).toBe(
							seen.has(i) ? live.get(i)?.label : undefined,
						)
					store.dispose()
				}),
				{ numRuns: 200 },
			)
		}, 120_000)
	})
})
