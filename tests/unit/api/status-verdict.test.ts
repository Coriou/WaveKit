/**
 * GET /api/status gives one verdict an agent can trust: a scanner sweep that suspends the
 * configured decoders is not "unhealthy" (it says so in `reasons`), a recorder refusal streak
 * over 5 min raises it to "degraded" with the fixing call, and `load` carries the shared
 * diagnostics sample's CPU and event-loop figures.
 */
import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	RECORDER_STREAK_FIXES,
	RECORDER_STREAK_LIMITS,
	type Diagnostics,
	type ScannerRecorderDecision,
	type ScannerRecorderStatus,
	type SystemStatusReason,
} from "@wavekit/api-types"
import {
	healthRoutes,
	liveScannerJobSources,
	SWEEP_RELEASE_GRACE_MS,
	type HealthRoutesOptions,
} from "../../../src/api/routes/health.js"
import { RecorderStreakTracker } from "../../../src/api/routes/recorder-decisions.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type { DecoderManager } from "../../../src/decoders/manager.js"
import type { AudioOutput } from "../../../src/core/audio-output.js"

interface DecoderRow {
	id: string
	running: boolean
	sourceId?: string
	reasonCode?: string
	health?: "running" | "restarting" | "faulted"
}

function options(decoders: DecoderRow[]): HealthRoutesOptions {
	const sourceManager = {
		getAllStatus: () => [
			{
				id: "rtl",
				connected: true,
				bytesReceived: 0,
				dataRate: 0,
				reconnectAttempts: 0,
				caps: { kind: "iq" },
			},
		],
	} as unknown as SourceManager
	const decoderManager = {
		getAllStatus: () =>
			decoders.map(d => ({
				id: d.id,
				type: "synthetic",
				uptime: 0,
				restartCount: 0,
				stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
				origin: "config",
				running: d.running,
				desiredRunning: true,
				health: d.health ?? (d.running ? "running" : "restarting"),
				...(d.sourceId !== undefined ? { sourceId: d.sourceId } : {}),
				...(d.reasonCode !== undefined
					? {
							suspended: true,
							suspension: {
								reasonCode: d.reasonCode,
								since: "2026-01-01T00:00:00.000Z",
							},
						}
					: {}),
			})),
		getAllHealth: () =>
			new Map(
				decoders.map(d => [
					d.id,
					d.health ?? (d.running ? "running" : "restarting"),
				]),
			),
		isDecoderConfirmedStopped: () => false,
	} as unknown as DecoderManager
	const audioOutput = {
		getPort: () => 0,
		getConnectedClients: () => 0,
	} as unknown as AudioOutput
	return { sourceManager, decoderManager, audioOutput }
}

let app: FastifyInstance | undefined

async function serve(opts: HealthRoutesOptions): Promise<FastifyInstance> {
	app = Fastify({ logger: false })
	await app.register(healthRoutes, opts)
	await app.ready()
	return app
}

afterEach(async () => {
	await app?.close()
	app = undefined
})

interface StatusBody {
	status: string
	health: { status: string }
	reasons: SystemStatusReason[]
	load?: Record<string, unknown> | null
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z")
const iso = (ms: number): string => new Date(ms).toISOString()

function recorder(
	session: Array<[ScannerRecorderDecision, number]>,
	refusals: Array<[ScannerRecorderDecision, number]> = [],
	counts: Partial<Record<ScannerRecorderDecision, number>> = {},
): ScannerRecorderStatus {
	const entry = ([code, ms]: [ScannerRecorderDecision, number], i: number) => ({
		code,
		at: iso(ms),
		sourceId: "rtl",
		observationId: `obs-${i}`,
		discoveryId: null,
	})
	return {
		sessions: [],
		parked: 0,
		recent: session.map(entry),
		recentRefusals: refusals.map(entry),
		counts,
		logsSuppressed: 0,
	}
}

describe("GET /api/status during a sweep", () => {
	const swept: DecoderRow[] = [
		{
			id: "pocsag",
			running: false,
			sourceId: "rtl",
			reasonCode: "tuner-scanning",
		},
		{
			id: "aprs",
			running: false,
			sourceId: "rtl",
			reasonCode: "tuner-scanning",
		},
	]

	it("is not unhealthy while every decoder is suspended by the sweep, and says why", async () => {
		const server = await serve(options(swept))
		const res = await server.inject({ url: "/api/status" })
		expect(res.statusCode).toBe(200)
		const body = res.json<StatusBody>()
		expect(body.status).toBe("healthy")
		expect(body.health.status).toBe("healthy")
		expect(body.reasons).toEqual([
			expect.objectContaining({
				code: "sweep-suspends-decoders",
				level: "info",
				sources: [{ sourceId: "rtl", decoders: 2 }],
			}),
		])
		expect(body.reasons[0]?.message).toContain("2 decoder(s)")
		expect(body.reasons[0]?.fix).toContain("/api/scanner/jobs")
	})

	it("a live job on the held source keeps it info; a hold no live job names is a warn", async () => {
		let jobs = new Set(["rtl"])
		const server = await serve({
			...options(swept),
			scannerJobSources: () => jobs,
		})
		let body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("healthy")
		expect(body.reasons.map(r => r.code)).toEqual(["sweep-suspends-decoders"])
		jobs = new Set()
		body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("degraded")
		expect(body.health.status).toBe("healthy")
		expect(body.reasons).toEqual([
			expect.objectContaining({
				code: "sweep-hold-without-job",
				level: "warn",
				sources: [{ sourceId: "rtl", decoders: 2 }],
			}),
		])
	})

	it("only jobs that may hold decoders name a source", () => {
		const longAgo = iso(T0 - SWEEP_RELEASE_GRACE_MS - 1)
		expect([
			...liveScannerJobSources(
				[
					{ state: "running", sourceId: "a" },
					{ state: "paused", sourceId: "b" },
					{ state: "holding", sourceId: "c" },
					{ state: "starting", sourceId: "d" },
					{ state: "pending", sourceId: "e" },
					{ state: "completed", sourceId: "f", updatedAt: longAgo },
					{ state: "cancelled", sourceId: "g", updatedAt: longAgo },
					{ state: "failed", sourceId: "h", updatedAt: longAgo },
				],
				T0,
			),
		]).toEqual(["a", "b", "c", "d"])
	})

	it("a job that just ended explains the hold for 30 s while it releases; past that it is leaked", () => {
		expect(SWEEP_RELEASE_GRACE_MS).toBe(30_000)
		const ended = (state: string, endedMs: number, nowMs: number) =>
			liveScannerJobSources(
				[{ state, sourceId: "rtl", updatedAt: iso(endedMs) }],
				nowMs,
			).has("rtl")
		for (const state of ["completed", "cancelled", "failed"]) {
			expect(ended(state, T0, T0)).toBe(true)
			expect(ended(state, T0, T0 + SWEEP_RELEASE_GRACE_MS)).toBe(true)
			expect(ended(state, T0, T0 + SWEEP_RELEASE_GRACE_MS + 1)).toBe(false)
		}
		// An unreadable end time is never guessed leaked.
		expect(
			liveScannerJobSources([{ state: "completed", sourceId: "rtl" }], T0).has(
				"rtl",
			),
		).toBe(true)
	})

	it("/api/status reads a sweep that just ended as info, and the same hold 30 s later as leaked", async () => {
		let now = T0 + SWEEP_RELEASE_GRACE_MS
		const server = await serve({
			...options(swept),
			scannerJobSources: () =>
				liveScannerJobSources(
					[{ state: "completed", sourceId: "rtl", updatedAt: iso(T0) }],
					now,
				),
		})
		let body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("healthy")
		expect(body.reasons.map(r => r.code)).toEqual(["sweep-suspends-decoders"])
		now = T0 + SWEEP_RELEASE_GRACE_MS + 1
		body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("degraded")
		expect(body.reasons.map(r => r.code)).toEqual(["sweep-hold-without-job"])
		expect(body.reasons[0]?.message).toContain("in the last 30 s")
	})

	it("keeps /health and /health/ready green during the sweep", async () => {
		const server = await serve(options(swept))
		expect((await server.inject({ url: "/health" })).statusCode).toBe(200)
		expect((await server.inject({ url: "/health/ready" })).statusCode).toBe(200)
	})

	it("still counts a faulted decoder on the swept source as down", async () => {
		const server = await serve(
			options([
				{
					id: "pocsag",
					running: false,
					sourceId: "rtl",
					reasonCode: "tuner-scanning",
					health: "faulted",
				},
			]),
		)
		const body = (
			await server.inject({ url: "/api/status" })
		).json<StatusBody>()
		expect(body.status).toBe("unhealthy")
		expect(body.reasons).toEqual([])
	})

	it("other suspensions are unchanged (a stopped decoder is still down)", async () => {
		const server = await serve(
			options([{ id: "adsb", running: false, sourceId: "rtl" }]),
		)
		const body = (
			await server.inject({ url: "/api/status" })
		).json<StatusBody>()
		expect(body.status).toBe("unhealthy")
		expect(body.reasons).toEqual([])
	})
})

describe("recorder refusal streak", () => {
	const BOUND = RECORDER_STREAK_LIMITS.raiseAfterMs

	// The first blocking refusal starts it; a newer one keeps it fresh.
	const streakOf = (
		code: ScannerRecorderDecision = "refused:tuning",
	): ScannerRecorderStatus =>
		recorder(
			[],
			[
				[code, T0],
				[code, T0 + BOUND],
			],
		)

	it("does not raise at exactly 5 min, and raises past it", () => {
		const rec = streakOf()
		const atBound = new RecorderStreakTracker().read(rec, T0 + BOUND)
		expect(atBound).toMatchObject({
			since: iso(T0),
			durationMs: BOUND,
			newestCode: "refused:tuning",
			raisesStatus: false,
		})
		const past = new RecorderStreakTracker().read(rec, T0 + BOUND + 1)
		expect(past?.raisesStatus).toBe(true)
		expect(past?.fix).toBe(RECORDER_STREAK_FIXES["refused:tuning"])
	})

	it("raises /api/status to degraded with the fixing call, past the bound only", async () => {
		const tracker = new RecorderStreakTracker()
		let now = T0 + BOUND
		const rec = streakOf()
		const server = await serve({
			...options([{ id: "adsb", running: true, sourceId: "rtl" }]),
			recorderStreak: () => tracker.read(rec, now),
		})
		let body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("healthy")
		expect(body.reasons).toEqual([])
		now = T0 + BOUND + 1
		body = (await server.inject({ url: "/api/status" })).json<StatusBody>()
		expect(body.status).toBe("degraded")
		expect(body.health.status).toBe("healthy")
		expect(body.reasons).toEqual([
			expect.objectContaining({
				code: "recorder-refusal-streak",
				level: "warn",
				fix: expect.stringContaining("POST /api/tuner/:sourceId/take-back"),
			}),
		])
		expect(body.reasons[0]?.message).toContain(
			"/api/scanner/recorder/decisions",
		)
	})

	it("a kept file ends the streak", () => {
		const rec = recorder([["finalized", T0 + 60_000]], [["refused:cpu", T0]], {
			finalized: 1,
		})
		expect(new RecorderStreakTracker().read(rec, T0 + BOUND * 2)).toBeNull()
	})

	it("classification refusals never make a streak", () => {
		const rec = recorder(
			[["discarded:unvoiced", T0]],
			[["refused:not-analog", T0]],
		)
		expect(new RecorderStreakTracker().read(rec, T0 + BOUND * 2)).toBeNull()
	})

	it("remembers the start once the rings rolled over, until a file is kept", () => {
		const tracker = new RecorderStreakTracker()
		tracker.read(recorder([], [["refused:slots", T0]]), T0 + 1_000)
		// The first refusal is gone from the ring; a newer one is there.
		const later = tracker.read(
			recorder([], [["refused:slots", T0 + 240_000]]),
			T0 + BOUND + 1,
		)
		expect(later).toMatchObject({ since: iso(T0), raisesStatus: true })
		// A kept file since (the count moved) restarts it from the rings.
		const kept = tracker.read(
			recorder([], [["refused:slots", T0 + 290_000]], { finalized: 1 }),
			T0 + BOUND + 2,
		)
		expect(kept).toMatchObject({
			since: iso(T0 + 290_000),
			raisesStatus: false,
		})
	})

	it("a stale streak (no blocking refusal for over 5 min) does not raise", () => {
		const rec = recorder([], [["refused:tuning", T0]])
		const stale = new RecorderStreakTracker().read(
			rec,
			T0 + RECORDER_STREAK_LIMITS.freshMs + 1,
		)
		expect(stale?.raisesStatus).toBe(false)
		expect(
			new RecorderStreakTracker().read(rec, T0 + RECORDER_STREAK_LIMITS.freshMs)
				?.raisesStatus,
		).toBe(false)
	})

	it("a gap over the freshness window restarts the streak (stale, then one fresh refusal)", () => {
		const tracker = new RecorderStreakTracker()
		const hour = 60 * 60_000
		// T0: one refusal, then an hour of silence: stale, and the tracker forgets it.
		expect(
			tracker.read(recorder([], [["refused:cpu", T0]]), T0 + hour)
				?.raisesStatus,
		).toBe(false)
		// One fresh refusal at T0+60 min: the ring still holds T0, but the gap restarts it.
		const ring: Array<[ScannerRecorderDecision, number]> = [
			["refused:cpu", T0],
			["refused:slots", T0 + hour],
		]
		const one = tracker.read(recorder([], ring), T0 + hour + 1_000)
		expect(one).toMatchObject({
			since: iso(T0 + hour),
			refusals: 1,
			raisesStatus: false,
		})
		// Sustained refusals for over 5 min then raise it.
		for (let m = 1; m <= 5; m++)
			ring.push(["refused:slots", T0 + hour + m * 60_000])
		const sustained = tracker.read(recorder([], ring), T0 + hour + BOUND + 1)
		expect(sustained).toMatchObject({
			since: iso(T0 + hour),
			newestCode: "refused:slots",
			raisesStatus: true,
		})
		// A fresh tracker reading the same rings agrees (the ring gap alone restarts it).
		expect(
			new RecorderStreakTracker().read(
				recorder([], ring),
				T0 + hour + BOUND + 1,
			)?.since,
		).toBe(iso(T0 + hour))
	})

	it("refused:record-disabled is an operator choice and never makes a streak", () => {
		const rec = recorder(
			[],
			[
				["refused:record-disabled", T0],
				["refused:record-disabled", T0 + BOUND * 2],
			],
		)
		expect(new RecorderStreakTracker().read(rec, T0 + BOUND * 2)).toBeNull()
		expect(RECORDER_STREAK_FIXES).not.toHaveProperty("refused:record-disabled")
	})

	it("a session started inside the window breaks the streak once it ends without a blocking code", () => {
		const refusals: Array<[ScannerRecorderDecision, number]> = [
			["refused:slots", T0],
			["refused:slots", T0 + 200_000],
			["refused:slots", T0 + BOUND],
		]
		const ended = (
			code: ScannerRecorderDecision,
			at: number,
		): ScannerRecorderStatus["recent"] => [
			{
				code,
				at: iso(at),
				sourceId: "rtl",
				observationId: "s",
				discoveryId: null,
			},
			{
				code: "discarded:unvoiced",
				at: iso(at + 1_000),
				sourceId: "rtl",
				observationId: "s",
				discoveryId: null,
			},
		]
		for (const code of ["started", "shadow"] as const) {
			const rec = recorder([], refusals, { [code]: 1 })
			rec.recent = ended(code, T0 + 100_000)
			expect(
				new RecorderStreakTracker().read(rec, T0 + BOUND + 1),
			).toMatchObject({ since: iso(T0 + 200_000), raisesStatus: false })
			// With no terminal decision yet it is no breaker: pending, and it holds the raise back.
			expect(
				new RecorderStreakTracker().read(
					recorder([[code, T0 + 100_000]], refusals, { [code]: 1 }),
					T0 + BOUND + 1,
				),
			).toMatchObject({ since: iso(T0), pending: true, raisesStatus: false })
		}
		// Remembered across reads: a start in the rings since the remembered one restarts it too.
		const tracker = new RecorderStreakTracker()
		tracker.read(recorder([], [["refused:slots", T0]]), T0 + 1_000)
		const later = recorder([], [["refused:slots", T0 + 280_000]], {
			started: 1,
		})
		later.recent = ended("started", T0 + 200_000)
		const after = tracker.read(later, T0 + BOUND + 1)
		expect(after).toMatchObject({
			since: iso(T0 + 280_000),
			raisesStatus: false,
		})
	})

	/** Session decisions as the recorder notes them: a start, then that session's outcome. */
	function sessions(
		outcome: ScannerRecorderDecision | null,
		count: number,
		everyMs: number,
	): ScannerRecorderStatus["recent"] {
		const out: ScannerRecorderStatus["recent"] = []
		for (let i = 0; i < count; i++) {
			const at = T0 + i * everyMs
			const base = {
				sourceId: "rtl",
				observationId: `obs-${i}`,
				discoveryId: null,
			}
			out.push({ ...base, code: "started", at: iso(at) })
			if (outcome !== null)
				out.push({ ...base, code: outcome, at: iso(at + 1_000) })
		}
		return out
	}

	function sessionRecorder(
		recent: ScannerRecorderStatus["recent"],
		counts: Partial<Record<ScannerRecorderDecision, number>> = {},
	): ScannerRecorderStatus {
		return {
			sessions: [],
			parked: 0,
			recent,
			recentRefusals: [],
			counts,
			logsSuppressed: 0,
		}
	}

	it("a session that started and then failed is no breaker: 10 min of started then refused:store raises", () => {
		// One session every 30 s for 10 min: 21 starts, each followed 1 s later by its refusal.
		for (const outcome of [
			"refused:store",
			"discarded:store-backlog",
			"discarded:write-failed",
			"discarded:buffer-full",
			"refused:start-failed",
		] as const) {
			const recent = sessions(outcome, 21, 30_000)
			const now = T0 + 10 * 60_000 + 2_000
			const streak = new RecorderStreakTracker().read(
				sessionRecorder(recent, { started: 21, [outcome]: 21 }),
				now,
			)
			expect(streak).toMatchObject({
				since: iso(T0 + 1_000),
				newestCode: outcome,
				refusals: 21,
				raisesStatus: true,
			})
		}
	})

	it("the same across reads while the session ring rolls over (64 entries)", () => {
		const tracker = new RecorderStreakTracker()
		const all = sessions("refused:store", 41, 15_000)
		let last = null as ReturnType<RecorderStreakTracker["read"]>
		// Read every minute, 2 s after a session start (its refusal 1 s after it is noted), then once
		// between a start and its refusal; the ring holds only the newest 64 entries noted so far.
		const at = (now: number, recording: boolean) => {
			const noted = all.filter(e => Date.parse(e.at) <= now).slice(-64)
			const rec = sessionRecorder(noted, { started: 1 })
			if (recording)
				rec.sessions = [{} as ScannerRecorderStatus["sessions"][number]]
			return tracker.read(rec, now)
		}
		for (let m = 1; m <= 9; m++) last = at(T0 + m * 60_000 + 2_000, false)
		// 41 sessions over 10 min hold 82 entries: the first ones rolled out of the ring.
		expect(last?.raisesStatus).toBe(true)
		// The newest session is open and the recorder holds it: pending, memory kept, and the raise
		// the streak earned before that session started stays.
		const open = at(T0 + 10 * 60_000 + 500, true)
		expect(open).toMatchObject({
			since: iso(T0 + 1_000),
			pending: true,
			raisesStatus: true,
		})
		// It then ended refused:store: the streak continues from the remembered start.
		last = at(T0 + 10 * 60_000 + 2_000, false)
		expect(last).toMatchObject({
			since: iso(T0 + 1_000),
			pending: false,
			raisesStatus: true,
		})
	})

	it("a session that started and kept a file, or is still recording, breaks the streak", () => {
		const refusals: Array<[ScannerRecorderDecision, number]> = [
			["refused:cpu", T0],
			["refused:cpu", T0 + BOUND + 60_000],
		]
		const mid = T0 + 60_000
		const ended = (code: ScannerRecorderDecision | null, recording = false) => {
			const rec = recorder([], refusals, { started: 1 })
			if (recording)
				rec.sessions = [{} as ScannerRecorderStatus["sessions"][number]]
			const base = { sourceId: "rtl", observationId: "s", discoveryId: null }
			rec.recent = [{ ...base, code: "started", at: iso(mid) }]
			if (code !== null)
				rec.recent.push({ ...base, code, at: iso(mid + 1_000) })
			return new RecorderStreakTracker().read(rec, T0 + BOUND + 60_001)
		}
		for (const code of ["finalized", "discarded:unvoiced", null] as const)
			expect(ended(code)).toMatchObject({
				since: iso(T0 + BOUND + 60_000),
				raisesStatus: false,
			})
		// Still open while the recorder holds a session: it may be recording, so the streak is
		// pending and does not raise (its two refusals are 6 min apart: it starts at the second).
		expect(ended(null, true)).toMatchObject({
			since: iso(T0 + BOUND + 60_000),
			pending: true,
			raisesStatus: false,
		})
		// The same session ending refused:store is no breaker: the streak runs from T0.
		expect(ended("refused:store")).toMatchObject({
			since: iso(T0),
			raisesStatus: true,
		})
	})

	it("refused:slots while a session records is recording at capacity, not a streak", () => {
		const rec = streakOf("refused:slots")
		expect(
			new RecorderStreakTracker().read(rec, T0 + BOUND + 1)?.raisesStatus,
		).toBe(true)
		const recording = {
			...rec,
			sessions: [
				{ sourceId: "rtl" } as ScannerRecorderStatus["sessions"][number],
			],
		}
		expect(
			new RecorderStreakTracker().read(recording, T0 + BOUND + 1),
		).toBeNull()
		// Other codes still count while a session records.
		expect(
			new RecorderStreakTracker().read(
				{ ...streakOf("refused:cpu"), sessions: recording.sessions },
				T0 + BOUND + 1,
			)?.raisesStatus,
		).toBe(true)
	})

	it("refused:slots counts per source: sessions on one source do not discount another's", () => {
		const rec = streakOf("refused:slots")
		const elsewhere = {
			...rec,
			sessions: [
				{ sourceId: "other" } as ScannerRecorderStatus["sessions"][number],
			],
		}
		expect(
			new RecorderStreakTracker().read(elsewhere, T0 + BOUND + 1)?.raisesStatus,
		).toBe(true)
	})

	/**
	 * Session decisions in the recorder's real emission order: per session `[offsetMs, code]`
	 * steps after its start, one session every `everyMs`, each on its own observation.
	 */
	function noted(
		steps: Array<[number, ScannerRecorderDecision]>,
		count: number,
		everyMs: number,
	): ScannerRecorderStatus["recent"] {
		const out: ScannerRecorderStatus["recent"] = []
		for (let i = 0; i < count; i++)
			for (const [offset, code] of steps)
				out.push({
					code,
					at: iso(T0 + i * everyMs + offset),
					sourceId: "rtl",
					observationId: `obs-${i}`,
					discoveryId: null,
				})
		return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
	}

	/** Reads `tracker` at `now` with what the recorder had noted by then (ring of 64). */
	function readAt(
		tracker: RecorderStreakTracker,
		all: ScannerRecorderStatus["recent"],
		now: number,
		live: number,
	): ReturnType<RecorderStreakTracker["read"]> {
		const recent = all.filter(e => Date.parse(e.at) <= now).slice(-64)
		const rec: ScannerRecorderStatus = {
			sessions: Array.from(
				{ length: live },
				() =>
					({ sourceId: "rtl" }) as ScannerRecorderStatus["sessions"][number],
			),
			parked: 0,
			recent,
			recentRefusals: [],
			counts: { started: 1 },
			logsSuppressed: 0,
		}
		return tracker.read(rec, now)
	}

	it("progress codes are no outcome: started, voiced, discarded:write-failed each minute raises past 5 min", () => {
		const all = noted(
			[
				[0, "started"],
				[10_000, "voiced"],
				[40_000, "discarded:write-failed"],
			],
			12,
			60_000,
		)
		const tracker = new RecorderStreakTracker()
		let last = null as ReturnType<RecorderStreakTracker["read"]>
		// Read every minute while the newest session records (after its voiced, before its end).
		for (let m = 1; m <= 7; m++) {
			last = readAt(tracker, all, T0 + m * 60_000 + 20_000, 1)
			expect(last?.since).toBe(iso(T0 + 40_000))
		}
		expect(last).toMatchObject({
			pending: true,
			newestCode: "discarded:write-failed",
			raisesStatus: true,
		})
	})

	it("overlapping failing sessions (always an open start newer than the last failure) still raise", () => {
		// A session every 30 s lasting 45 s: two slots busy, one always open.
		const all = noted(
			[
				[0, "started"],
				[5_000, "classed"],
				[10_000, "voiced"],
				[45_000, "discarded:write-failed"],
			],
			20,
			30_000,
		)
		const tracker = new RecorderStreakTracker()
		let last = null as ReturnType<RecorderStreakTracker["read"]>
		for (let m = 1; m <= 7; m++)
			last = readAt(tracker, all, T0 + m * 60_000 + 20_000, 2)
		expect(last).toMatchObject({
			since: iso(T0 + 45_000),
			pending: true,
			raisesStatus: true,
		})
	})

	it("a done session awaiting its store receipt (no longer listed) does not wipe the streak", () => {
		const all = noted(
			[
				[0, "started"],
				[10_000, "voiced"],
				[40_000, "discarded:write-failed"],
			],
			8,
			60_000,
		)
		const tracker = new RecorderStreakTracker()
		for (let m = 1; m <= 6; m++)
			readAt(tracker, all, T0 + m * 60_000 + 45_000, 1)
		// The newest session (started at 7 min) is done and waits for its receipt: not listed.
		const waiting = readAt(tracker, all, T0 + 7 * 60_000 + 30_000, 0)
		expect(waiting).toMatchObject({
			since: iso(T0 + 40_000),
			pending: true,
			raisesStatus: true,
		})
		// Its receipt then says write-failed: the streak continues.
		expect(readAt(tracker, all, T0 + 7 * 60_000 + 45_000, 0)).toMatchObject({
			since: iso(T0 + 40_000),
			pending: false,
			raisesStatus: true,
		})
	})

	it("a session that went started, classed, voiced, then kept or discarded without a blocking code breaks it", () => {
		const failing = noted(
			[
				[0, "started"],
				[10_000, "voiced"],
				[40_000, "discarded:write-failed"],
			],
			6,
			60_000,
		)
		for (const end of ["finalized", "discarded:not-speech"] as const) {
			const tracker = new RecorderStreakTracker()
			for (let m = 1; m <= 5; m++)
				readAt(tracker, failing, T0 + m * 60_000 + 45_000, 0)
			const base = {
				sourceId: "rtl",
				observationId: "good",
				discoveryId: null,
			}
			const at = T0 + 6 * 60_000
			const all = [
				...failing,
				{ ...base, code: "started" as const, at: iso(at) },
				{ ...base, code: "classed" as const, at: iso(at + 5_000) },
				{ ...base, code: "voiced" as const, at: iso(at + 10_000) },
				{ ...base, code: end, at: iso(at + 30_000) },
			]
			expect(readAt(tracker, all, at + 40_000, 0)).toBeNull()
		}
	})

	it("a session end whose start rolled out of the ring breaks it unless blocking", () => {
		const refusals: Array<[ScannerRecorderDecision, number]> = [
			["refused:cpu", T0],
			["refused:cpu", T0 + 200_000],
			["refused:cpu", T0 + BOUND],
		]
		const orphan = (code: ScannerRecorderDecision) => {
			const rec = recorder([], refusals)
			rec.recent = [
				{
					code,
					at: iso(T0 + 100_000),
					sourceId: "rtl",
					observationId: "gone",
					discoveryId: null,
				},
			]
			return new RecorderStreakTracker().read(rec, T0 + BOUND + 1)
		}
		expect(orphan("discarded:unvoiced")).toMatchObject({
			since: iso(T0 + 200_000),
			raisesStatus: false,
		})
		// A blocking end or a progress code is no breaker.
		for (const code of ["discarded:write-failed", "voiced"] as const)
			expect(orphan(code)).toMatchObject({ since: iso(T0), raisesStatus: true })
	})

	it("refused:tuning counts only while its source's tuning is unproven, when that is known", () => {
		const rec = streakOf("refused:tuning")
		let unproven = false
		const tracker = new RecorderStreakTracker({
			tuningUnproven: sourceId => sourceId === "rtl" && unproven,
		})
		expect(tracker.read(rec, T0 + BOUND + 1)).toBeNull()
		unproven = true
		expect(tracker.read(rec, T0 + BOUND + 1)?.raisesStatus).toBe(true)
		// Other codes are not affected by the source's tuning.
		expect(
			new RecorderStreakTracker({ tuningUnproven: () => false }).read(
				streakOf("refused:cpu"),
				T0 + BOUND + 1,
			)?.raisesStatus,
		).toBe(true)
	})

	it("keeps the start through a read whose rings were flooded by other codes", () => {
		const tracker = new RecorderStreakTracker()
		tracker.read(recorder([], [["refused:cpu", T0]]), T0 + 1_000)
		// 32 non-blocking snapshot refusals pushed it out; nothing was kept or started.
		const flood = Array.from(
			{ length: 32 },
			(_, i): [ScannerRecorderDecision, number] => [
				"refused:not-analog",
				T0 + 60_000 + i * 1_000,
			],
		)
		const flooded = tracker.read(recorder([], flood), T0 + 120_000)
		expect(flooded).toMatchObject({
			since: iso(T0),
			newestCode: "refused:cpu",
			refusals: 0,
			raisesStatus: false,
		})
		// A new blocking refusal within the freshness window continues the same streak.
		const later = tracker.read(
			recorder([], [["refused:cpu", T0 + 240_000]]),
			T0 + BOUND + 1,
		)
		expect(later).toMatchObject({ since: iso(T0), raisesStatus: true })
		// A flood read after the newest went stale forgets it.
		const forgetting = new RecorderStreakTracker()
		forgetting.read(recorder([], [["refused:cpu", T0]]), T0 + 1_000)
		expect(
			forgetting.read(
				recorder([], flood),
				T0 + RECORDER_STREAK_LIMITS.freshMs + 1,
			)?.raisesStatus,
		).toBe(false)
		expect(forgetting.read(recorder([], flood), T0 + BOUND * 3)).toBeNull()
	})

	it("an unhealthy verdict is not lowered by a streak", async () => {
		const rec = streakOf()
		const server = await serve({
			...options([{ id: "adsb", running: false }]),
			recorderStreak: () =>
				new RecorderStreakTracker().read(rec, T0 + BOUND + 1),
		})
		const body = (
			await server.inject({ url: "/api/status" })
		).json<StatusBody>()
		expect(body.status).toBe("unhealthy")
		expect(body.reasons.map(r => r.code)).toEqual(["recorder-refusal-streak"])
	})
})

describe("GET /api/status load", () => {
	const sample: Diagnostics = {
		at: iso(T0),
		eventLoopUtilization: 0.25,
		eventLoopDelay: {
			last: { maxMs: 12, p99Ms: 11 },
			maxMs10m: 40,
			p99MaxMs10m: 30,
			intervals10m: 300,
		},
		process: {
			windowMs: 2000,
			cpuCores: 0.8,
			userSeconds: 10,
			systemSeconds: 2,
		},
		containerCpuCores: 1.1,
		threads: null,
		threadsTimedOut: false,
		channels: null,
	}

	it("carries the shared sample's CPU and event-loop figures", async () => {
		const server = await serve({
			...options([{ id: "adsb", running: true }]),
			diagnostics: async () => sample,
		})
		const body = (
			await server.inject({ url: "/api/status" })
		).json<StatusBody>()
		expect(body.load).toEqual({
			at: iso(T0),
			processCpuCores: 0.8,
			containerCpuCores: 1.1,
			eventLoopUtilization: 0.25,
			eventLoopDelayMaxMs: 12,
			eventLoopDelayP99Ms: 11,
			eventLoopDelayMaxMs10m: 40,
			details: "/api/diagnostics",
		})
	})

	it("reads null when the sample fails, and is absent when not wired", async () => {
		const failing = await serve({
			...options([{ id: "adsb", running: true }]),
			diagnostics: async () => {
				throw new Error("sample failed")
			},
		})
		const body = (
			await failing.inject({ url: "/api/status" })
		).json<StatusBody>()
		expect(body.load).toBeNull()
		await app?.close()
		const plain = await serve(options([{ id: "adsb", running: true }]))
		const res = (await plain.inject({ url: "/api/status" })).json<StatusBody>()
		expect(res).not.toHaveProperty("load")
		expect(res.reasons).toEqual([])
	})
})
