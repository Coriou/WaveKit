import { afterEach, describe, expect, it, vi } from "vitest"
import type {
	Discovery,
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
