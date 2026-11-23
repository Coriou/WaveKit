/**
 * The recording admission discard (`discarded:noise`) through the API: it is a member of the
 * SCANNER_RECORDER_DECISIONS contract (so the discovery recorder schema's enum and the enums route
 * carry it), GET /api/scanner/recorder/decisions returns it as a `discarded` outcome that ends its
 * session, and it is no refusal-streak code.
 */
import { afterEach, describe, expect, it } from "vitest"
import Fastify, { type FastifyInstance } from "fastify"
import {
	SCANNER_RECORDER_DECISIONS,
	type RecorderDecisionsResponse,
	type ScannerRecorderStatus,
} from "@wavekit/api-types"
import {
	RecorderStreakTracker,
	isStreakCode,
	outcomeOf,
	recorderDecisionsRoutes,
} from "../../../src/api/routes/recorder-decisions.js"

const T0 = Date.parse("2026-01-01T00:00:00.000Z")
const iso = (ms: number): string => new Date(ms).toISOString()

let app: FastifyInstance | undefined
afterEach(async () => {
	await app?.close()
	app = undefined
})

describe("discarded:noise in the recorder decisions API", () => {
	// Feature: recording-admission, the decision code (docs/API.md).
	it("is a contract code, a discard and no streak code", () => {
		expect(SCANNER_RECORDER_DECISIONS).toContain("discarded:noise")
		expect(outcomeOf("discarded:noise")).toBe("discarded")
		expect(isStreakCode("discarded:noise")).toBe(false)
	})

	it("GET /api/scanner/recorder/decisions returns it as a discarded outcome", async () => {
		const status: ScannerRecorderStatus = {
			sessions: [],
			parked: 0,
			recent: [
				{
					code: "started",
					at: iso(T0),
					sourceId: "rtl",
					observationId: "o-1",
					discoveryId: "d-1",
				},
				{
					code: "discarded:noise",
					at: iso(T0 + 8_000),
					sourceId: "rtl",
					observationId: "o-1",
					discoveryId: "d-1",
				},
			],
			recentRefusals: [],
			counts: { started: 1, "discarded:noise": 1 },
			logsSuppressed: 0,
		}
		app = Fastify({ logger: false })
		await app.register(recorderDecisionsRoutes, {
			source: { recorder: () => status, frequencyOf: () => 100_000_000 },
			tracker: new RecorderStreakTracker(),
			now: () => T0 + 10_000,
		})
		await app.ready()
		const res = await app.inject({ url: "/api/scanner/recorder/decisions" })
		expect(res.statusCode).toBe(200)
		const body = res.json<RecorderDecisionsResponse>()
		expect(body.items[0]).toMatchObject({
			code: "discarded:noise",
			outcome: "discarded",
			kind: "session",
			observationId: "o-1",
		})
		expect(body.streak).toBeNull()
	})
})
