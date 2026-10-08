import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus } from "@wavekit/api-types"
import {
	LANE_TTL_MS,
	apiView,
	emptyLane,
	iqSummary,
	iqView,
	isFresh,
	isOld,
	laneFail,
	laneOk,
	restFresh,
} from "../../../cli/source/data/freshness.js"
import { memoOne } from "../../../cli/source/data/memo.js"
import type {
	ConnState,
	LaneError,
	SourceRow,
} from "../../../cli/source/data/types.js"

function source(
	over: Partial<ExtendedSourceStatus> = {},
): ExtendedSourceStatus {
	return {
		id: "pi-iq",
		connected: true,
		consumers: 9,
		bytesReceived: 1,
		dataRate: 3994,
		reconnectAttempts: 0,
		caps: {
			kind: "iq",
			sampleRate: 2048000,
			format: "U8_IQ",
			exclusive: false,
		},
		assignments: [],
		available: true,
		activity: {
			state: "streaming",
			lastSampleAt: null,
			sampleAgeMs: 4,
			timeoutMs: 10000,
		},
		...over,
	}
}

function conn(
	over: Partial<ConnState["rest"]> = {},
	ws: ConnState["ws"]["state"] = "open",
): ConnState {
	return {
		target: { base: "http://127.0.0.1:9000", ws: "ws://127.0.0.1:9000/ws" },
		discovery: { mode: "explicit", tried: [] },
		ws: {
			state: ws,
			since: 0,
			code: null,
			reason: null,
			nextRetryAt: null,
			attempt: 0,
		},
		rest: {
			lastOkAt: null,
			lastCycleAt: null,
			nextAt: null,
			failing: [],
			firstFailAt: null,
			lastError: null,
			...over,
		},
		invalidFrames: 0,
		rejectedItems: 0,
		lastEventAt: null,
	}
}

describe("migrated source-activity cases", () => {
	it("expires cached streaming after a failed refresh and recovers on a new snapshot", () => {
		const s = source()
		const fresh = (receivedAt: number | null, now: number) =>
			receivedAt !== null &&
			!isOld({ value: [s], receivedAt, origin: "rest" }, now)
		expect(iqView(s, fresh(1000, 15999), undefined, 15999).word).toBe(
			"streaming",
		)
		expect(iqView(s, fresh(1000, 16001), undefined, 16001).word).toBe("unknown")
		expect(iqView(s, fresh(1000, 30000), undefined, 30000).word).toBe("unknown")
		expect(iqView(s, fresh(30000, 30001), undefined, 30001).word).toBe(
			"streaming",
		)
		expect(iqView(s, fresh(null, 30000), undefined, 30000).word).toBe("unknown")
	})
	it("does not infer streaming from an older server's connected flag", () => {
		const { activity: _a, ...old } = source()
		expect(iqView(old as ExtendedSourceStatus, true, undefined, 0).word).toBe(
			"connected",
		)
		expect(
			iqView(
				{ ...(old as ExtendedSourceStatus), connected: false },
				true,
				undefined,
				0,
			).word,
		).toBe("disconnected")
	})
})

describe("iqView (T2)", () => {
	it("maps activity states to words and glyphs", () => {
		const v = (
			state: "waiting" | "stale" | "paused" | "ended" | "disconnected",
		) =>
			iqView(
				source({
					activity: {
						state,
						lastSampleAt: null,
						sampleAgeMs: 23000,
						timeoutMs: 10000,
					},
				}),
				true,
				undefined,
				0,
			)
		expect(v("waiting")).toMatchObject({
			glyph: "neutral",
			word: "connected · no samples",
		})
		expect(v("stale")).toMatchObject({
			glyph: "fault",
			word: "no samples",
			ageMs: 23000,
		})
		expect(v("paused").word).toBe("paused")
		expect(v("ended").word).toBe("ended")
		expect(v("disconnected")).toMatchObject({
			glyph: "fault",
			word: "disconnected",
		})
	})
	it("falls back to the WS metrics heartbeat as `receiving`", () => {
		const beat = { bytesReceived: 1, dataRateKiB: 3994, at: 1000 }
		expect(iqView(source(), false, beat, 5000)).toMatchObject({
			glyph: "live",
			word: "receiving",
			rateBytesPerSec: 3994 * 1024,
		})
		expect(
			iqView(source(), false, { ...beat, dataRateKiB: 0 }, 5000).word,
		).toBe("unknown")
		expect(iqView(source(), false, beat, 1000 + LANE_TTL_MS + 1).word).toBe(
			"unknown",
		)
	})
	it("summarises two sources with the worst glyph (review focus 5)", () => {
		const lane = laneOk(
			[
				source(),
				source({
					id: "b",
					activity: {
						state: "stale",
						lastSampleAt: null,
						sampleAgeMs: 30000,
						timeoutMs: 10000,
					},
				}),
			],
			1000,
			"rest",
		)
		expect(iqSummary(lane, {}, 2000)).toMatchObject({
			glyph: "fault",
			word: "1/2 streaming",
		})
	})
	it("is unknown with no sources and no heartbeat", () => {
		expect(iqSummary(emptyLane(), {}, 0)).toMatchObject({
			glyph: "unknown",
			word: "unknown",
		})
	})
})

describe("apiView (T1)", () => {
	it("is ok only when WS is open and REST is fresh", () => {
		expect(apiView(conn({ lastOkAt: 8000 }), 10000)).toEqual({
			kind: "ok",
			restAgeMs: 2000,
		})
		expect(apiView(conn({ lastOkAt: 8000 }, "closed"), 10000)).toEqual({
			kind: "split",
			ws: false,
			rest: true,
			restAgeMs: 2000,
		})
		expect(apiView(conn({ lastOkAt: 0 }), 45000)).toEqual({
			kind: "split",
			ws: true,
			rest: false,
			restAgeMs: 45000,
		})
		expect(apiView(conn({ lastOkAt: 0 }, "closed"), 180000)).toEqual({
			kind: "down",
			sinceMs: 180000,
		})
		expect(apiView(conn({}, "connecting"), 1000)).toEqual({
			kind: "connecting",
		})
		expect(apiView(conn({ firstFailAt: 500 }, "closed"), 1000)).toEqual({
			kind: "down",
			sinceMs: 500,
		})
	})
})

describe("lanes", () => {
	const err: LaneError = { kind: "network", message: "ECONNREFUSED", at: 5 }

	// Feature: cli-dashboard-overhaul, Property 17: freshness
	// Validates: spec T6, §10.10
	it("P17: old iff age > TTL; errors keep values; success clears errors", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1e9 }),
				fc.integer({ min: 0, max: 100000 }),
				fc.anything(),
				(at, age, value) => {
					const lane = laneOk(value, at, "rest")
					expect(isOld(lane, at + age)).toBe(age > LANE_TTL_MS)
					const failed = laneFail(lane, err)
					expect(failed.value).toBe(value)
					expect(failed.receivedAt).toBe(at)
					expect(failed.error).toEqual(err)
					// A success after a failure: the failed lane's value comes back fresh.
					const healed = laneOk(failed.value, at + age, "rest")
					expect("error" in healed).toBe(false)
					expect(healed.receivedAt).toBe(at + age)
				},
			),
			{ numRuns: 100 },
		)
	})
	it("never-received lanes are not old (they are 'no data')", () => {
		expect(isOld(emptyLane(), 1e12)).toBe(false)
	})
})

describe("memoOne", () => {
	it("returns the cached result for identical arguments", () => {
		let calls = 0
		const f = memoOne((a: object, n: number) => {
			calls++
			return { a, n }
		})
		const a = {}
		expect(f(a, 1)).toBe(f(a, 1))
		expect(calls).toBe(1)
		f({}, 1)
		expect(calls).toBe(2)
	})
})

describe("A1 fix round 1", () => {
	it("TTL boundary: 15 000 ms is fresh, 15 001 ms is old (P17)", () => {
		const lane = laneOk([1], 1000, "rest")
		expect(isOld(lane, 1000 + 15000)).toBe(false)
		expect(isFresh(lane, 1000 + 15000)).toBe(true)
		expect(isOld(lane, 1000 + 15001)).toBe(true)
		expect(isFresh(lane, 1000 + 15001)).toBe(false)
		expect(restFresh(conn({ lastOkAt: 1000 }), 16000)).toBe(true)
		expect(restFresh(conn({ lastOkAt: 1000 }), 16001)).toBe(false)
	})
	it("a success after a failure clears the error", () => {
		const failed = laneFail(laneOk("v", 1000, "rest"), {
			kind: "http",
			status: 500,
			message: "boom",
			at: 2000,
		})
		expect(failed.error?.kind).toBe("http")
		const healed = laneOk(failed.value, 3000, "rest")
		expect(healed).toEqual({ value: "v", receivedAt: 3000, origin: "rest" })
	})
	it("shows unknown, not transport wording, for unrecognised activity", () => {
		const { activity: _a, ...rest } = source()
		const row: SourceRow = { ...rest, activityUnrecognised: true }
		expect(iqView(row, true, undefined, 0)).toMatchObject({
			glyph: "unknown",
			word: "unknown",
		})
		const lane = laneOk([row, source({ id: "b" })], 1000, "rest")
		expect(iqSummary(lane, {}, 2000).glyph).toBe("unknown")
	})
	it("multi-source rate is unknown when any source's rate is unknown", () => {
		const lane = laneOk([source(), source({ id: "b" })], 0, "rest")
		const beat = { bytesReceived: 1, dataRateKiB: 100, at: 50000 }
		// Lane is old; only pi-iq has a fresh heartbeat, so b's rate is unknown.
		expect(iqSummary(lane, { "pi-iq": beat }, 50000).rateBytesPerSec).toBeNull()
		expect(
			iqSummary(lane, { "pi-iq": beat, b: { ...beat, dataRateKiB: 50 } }, 50000)
				.rateBytesPerSec,
		).toBe(150 * 1024)
		expect(
			iqSummary(laneOk([source(), source({ id: "b" })], 1000, "rest"), {}, 2000)
				.rateBytesPerSec,
		).toBe(2 * 3994 * 1024)
	})
})
