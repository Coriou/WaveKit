/**
 * GET /api/scanner/recorder/decisions: the last N recorder decisions of both rings, newest first,
 * joined to their discovery's frequency, with N validated and bounded by what the rings hold.
 */
import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	RECORDER_DECISIONS_LIMITS,
	RECORDER_RECENT_DECISIONS,
	RECORDER_RECENT_REFUSALS,
	type RecorderDecisionsResponse,
	type ScannerRecorderDecision,
	type ScannerRecorderStatus,
} from "@wavekit/api-types"
import {
	RecorderStreakTracker,
	recorderDecisionsRoutes,
} from "../../../src/api/routes/recorder-decisions.js"

const T0 = Date.parse("2026-01-01T00:00:00.000Z")
const iso = (ms: number): string => new Date(ms).toISOString()

function entries(
	n: number,
	code: ScannerRecorderDecision,
	offsetMs: number,
	stepMs: number,
	prefix: string,
) {
	return Array.from({ length: n }, (_, i) => ({
		code,
		at: iso(T0 + offsetMs + i * stepMs),
		sourceId: "rtl",
		observationId: `${prefix}-${i}`,
		discoveryId: i % 2 === 0 ? `d-${prefix}-${i}` : null,
	}))
}

/** Full rings: 64 session decisions at odd seconds, 32 refusals at even ones. */
function fullRings(): ScannerRecorderStatus {
	return {
		sessions: [],
		parked: 0,
		recent: entries(RECORDER_RECENT_DECISIONS, "finalized", 1_000, 2_000, "s"),
		recentRefusals: entries(
			RECORDER_RECENT_REFUSALS,
			"refused:not-analog",
			0,
			2_000,
			"r",
		),
		counts: { finalized: 64, "refused:not-analog": 32 },
		logsSuppressed: 0,
	}
}

let app: FastifyInstance | undefined

async function serve(
	status: ScannerRecorderStatus | undefined,
): Promise<FastifyInstance> {
	app = Fastify({ logger: false })
	await app.register(recorderDecisionsRoutes, {
		source: {
			recorder: () => status,
			frequencyOf: id => (id.startsWith("d-") ? 100_000_000 : null),
		},
		tracker: new RecorderStreakTracker(),
		now: () => T0 + 200_000,
	})
	await app.ready()
	return app
}

afterEach(async () => {
	await app?.close()
	app = undefined
})

describe("GET /api/scanner/recorder/decisions", () => {
	it("bounds limit by the two rings: 64 + 32 = 96", () => {
		expect(RECORDER_DECISIONS_LIMITS.maxLimit).toBe(96)
		expect(RECORDER_DECISIONS_LIMITS.defaultLimit).toBe(20)
	})

	it("returns the last 20 by default, newest first, with outcome, kind and frequency", async () => {
		const server = await serve(fullRings())
		const res = await server.inject({ url: "/api/scanner/recorder/decisions" })
		expect(res.statusCode).toBe(200)
		const body = res.json<RecorderDecisionsResponse>()
		expect(body.limit).toBe(20)
		expect(body.held).toBe(96)
		expect(body.items).toHaveLength(20)
		const times = body.items.map(i => Date.parse(i.at))
		expect([...times].sort((a, b) => b - a)).toEqual(times)
		// The newest is the last session decision (odd seconds end later).
		expect(body.items[0]).toMatchObject({
			code: "finalized",
			outcome: "kept",
			kind: "session",
			observationId: "s-63",
			discoveryId: null,
			frequencyHz: null,
		})
		// The refusals end at 62 s, the session decisions at 127 s: the last 20 are all session ones.
		expect(body.items.every(i => i.kind === "session")).toBe(true)
		const withDiscovery = body.items.find(i => i.discoveryId !== null)
		expect(withDiscovery?.frequencyHz).toBe(100_000_000)
		expect(body.streak).toBeNull()
	})

	it("returns every held decision at the bound", async () => {
		const server = await serve(fullRings())
		const res = await server.inject({
			url: "/api/scanner/recorder/decisions?limit=96",
		})
		expect(res.statusCode).toBe(200)
		const items = res.json<RecorderDecisionsResponse>().items
		expect(items).toHaveLength(96)
		// Both rings, interleaved by time: the oldest is the first refusal (0 s).
		expect(items.at(-1)).toMatchObject({
			code: "refused:not-analog",
			outcome: "refused",
			kind: "snapshot",
			observationId: "r-0",
			discoveryId: "d-r-0",
			frequencyHz: 100_000_000,
		})
		expect(items.at(-2)).toMatchObject({
			kind: "session",
			observationId: "s-0",
		})
	})

	it.each(["97", "0", "-1", "2.5", "abc"])(
		"refuses limit=%s with a 400 naming the field",
		async limit => {
			const server = await serve(fullRings())
			const res = await server.inject({
				url: `/api/scanner/recorder/decisions?limit=${limit}`,
			})
			expect(res.statusCode).toBe(400)
			const body = res.json<{ code: string; fields: { field: string }[] }>()
			expect(body.code).toBe("VALIDATION_ERROR")
			expect(body.fields[0]?.field).toBe("limit")
			expect(res.body).not.toContain("abc")
		},
	)

	it("refuses an unknown query parameter", async () => {
		const server = await serve(fullRings())
		const res = await server.inject({
			url: "/api/scanner/recorder/decisions?since=1",
		})
		expect(res.statusCode).toBe(400)
	})

	it("answers empty without a recorder", async () => {
		const server = await serve(undefined)
		const body = (
			await server.inject({ url: "/api/scanner/recorder/decisions" })
		).json<RecorderDecisionsResponse>()
		expect(body).toMatchObject({ items: [], held: 0, counts: {}, streak: null })
	})

	it("shows the refusal streak with its fix", async () => {
		const server = await serve({
			sessions: [],
			parked: 0,
			recent: [],
			recentRefusals: entries(3, "refused:cpu", 0, 10_000, "r"),
			counts: { "refused:cpu": 3 },
			logsSuppressed: 0,
		})
		const body = (
			await server.inject({ url: "/api/scanner/recorder/decisions" })
		).json<RecorderDecisionsResponse>()
		expect(body.streak).toMatchObject({
			since: iso(T0),
			durationMs: 200_000,
			newestCode: "refused:cpu",
			refusals: 3,
			raisesStatus: false,
			fix: expect.stringContaining("PATCH /api/scanner/settings"),
		})
	})
})
