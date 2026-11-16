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
		expect([
			...liveScannerJobSources([
				{ state: "running", sourceId: "a" },
				{ state: "paused", sourceId: "b" },
				{ state: "holding", sourceId: "c" },
				{ state: "starting", sourceId: "d" },
				{ state: "pending", sourceId: "e" },
				{ state: "completed", sourceId: "f" },
				{ state: "cancelled", sourceId: "g" },
				{ state: "failed", sourceId: "h" },
			]),
		]).toEqual(["a", "b", "c", "d"])
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

	it("a session started inside the window breaks the streak", () => {
		const refusals: Array<[ScannerRecorderDecision, number]> = [
			["refused:slots", T0],
			["refused:slots", T0 + 200_000],
			["refused:slots", T0 + BOUND],
		]
		for (const code of ["started", "shadow"] as const) {
			const rec = recorder([[code, T0 + 100_000]], refusals, { [code]: 1 })
			expect(
				new RecorderStreakTracker().read(rec, T0 + BOUND + 1),
			).toMatchObject({ since: iso(T0 + 200_000), raisesStatus: false })
		}
		// Remembered across reads: a start counted since the last read restarts it too.
		const tracker = new RecorderStreakTracker()
		tracker.read(recorder([], [["refused:slots", T0]]), T0 + 1_000)
		const after = tracker.read(
			recorder([], [["refused:slots", T0 + 280_000]], { started: 1 }),
			T0 + BOUND + 1,
		)
		expect(after).toMatchObject({
			since: iso(T0 + 280_000),
			raisesStatus: false,
		})
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
