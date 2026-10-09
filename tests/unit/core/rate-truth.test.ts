/**
 * Rate-truth check (roadmap item 8): a sustained difference between the
 * measured byte rate and caps.sampleRate × bytes per sample is flagged,
 * never corrected. Incident: an external client left the dongle at ~2.16 Msps
 * for 8 h while caps said 2.048 Msps.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	RATE_TRUTH_SUSTAIN_MS,
	RATE_TRUTH_TOLERANCE,
	RateTruthTracker,
	bytesPerSampleFor,
} from "../../../src/core/rate-truth.js"

const DECLARED = 2_048_000
const TICK = 5_000
const CU8 = 2

function tick(
	tracker: RateTruthTracker,
	atMs: number,
	actualHz: number,
	options: { stable?: boolean; declared?: number } = {},
) {
	return tracker.observe({
		atMs,
		elapsedMs: TICK,
		bytes: Math.round((actualHz * CU8 * TICK) / 1000),
		declaredSampleRateHz: options.declared ?? DECLARED,
		bytesPerSample: CU8,
		stable: options.stable ?? true,
	})
}

/** Feeds `count` ticks starting at `start`; returns the transitions seen. */
function run(
	tracker: RateTruthTracker,
	start: number,
	count: number,
	actualHz: number,
) {
	const events: Array<string | null> = []
	for (let i = 0; i < count; i++)
		events.push(tick(tracker, start + i * TICK, actualHz))
	return events
}

describe("bytesPerSampleFor", () => {
	it("knows the wire size of each declared format", () => {
		expect(bytesPerSampleFor({ format: "U8_IQ" })).toBe(2)
		expect(bytesPerSampleFor({ format: "S16_IQ" })).toBe(4)
		expect(bytesPerSampleFor({ format: "S16LE", channels: 2 })).toBe(4)
		expect(bytesPerSampleFor({ format: "S16LE" })).toBe(2)
		expect(bytesPerSampleFor({ format: "FLOAT32LE" })).toBe(4)
		expect(bytesPerSampleFor({ format: "auto" })).toBeUndefined()
	})
})

describe("RateTruthTracker", () => {
	it("flags the incident once the mismatch has lasted 30 s, with measured rate and sign", () => {
		const tracker = new RateTruthTracker()
		const events = run(tracker, 0, 6, 2_160_000)
		expect(events.slice(0, 5)).toEqual([null, null, null, null, null])
		expect(events[5]).toBe("flagged")
		expect(tracker.mismatch).toMatchObject({
			declaredSampleRateHz: DECLARED,
			measuredSampleRateHz: 2_160_000,
		})
		expect(tracker.mismatch?.deviation).toBeCloseTo(0.0547, 3)
		expect(tracker.mismatch?.since).toEqual(new Date(0))
	})

	it("ignores deviations within 2 %", () => {
		const tracker = new RateTruthTracker()
		expect(run(tracker, 0, 20, DECLARED * 1.019)).not.toContain("flagged")
		expect(tracker.mismatch).toBeUndefined()
	})

	it("does not flag a short burst (catch-up after a stall)", () => {
		const tracker = new RateTruthTracker()
		run(tracker, 0, 3, DECLARED)
		run(tracker, 3 * TICK, 3, DECLARED * 1.2)
		expect(run(tracker, 6 * TICK, 10, DECLARED)).not.toContain("flagged")
	})

	it("restarts the run when the deviation changes sign", () => {
		const tracker = new RateTruthTracker()
		run(tracker, 0, 4, DECLARED * 1.05)
		expect(run(tracker, 4 * TICK, 5, DECLARED * 0.9)).not.toContain("flagged")
		expect(tick(tracker, 9 * TICK, DECLARED * 0.9)).toBe("flagged")
		expect(tracker.mismatch?.deviation).toBeCloseTo(-0.1, 6)
	})

	it("skips unstable intervals (backpressure, reconnect) without clearing a flag", () => {
		const tracker = new RateTruthTracker()
		run(tracker, 0, 6, 2_160_000)
		expect(tick(tracker, 6 * TICK, 0, { stable: false })).toBeNull()
		expect(tracker.mismatch).toBeDefined()
		// An unstable tick also breaks a pending run.
		const fresh = new RateTruthTracker()
		run(fresh, 0, 5, 2_160_000)
		tick(fresh, 5 * TICK, 2_160_000, { stable: false })
		expect(tick(fresh, 6 * TICK, 2_160_000)).toBeNull()
	})

	it("clears only after the rate has matched for 30 s", () => {
		const tracker = new RateTruthTracker()
		run(tracker, 0, 6, 2_160_000)
		const events = run(tracker, 6 * TICK, 6, DECLARED)
		expect(events.slice(0, 5)).toEqual([null, null, null, null, null])
		expect(events[5]).toBe("cleared")
		expect(tracker.mismatch).toBeUndefined()
	})

	it("resets on a new declared rate: the old flag no longer describes the caps", () => {
		const tracker = new RateTruthTracker()
		run(tracker, 0, 6, 2_160_000)
		expect(tick(tracker, 6 * TICK, 2_160_000, { declared: 2_160_000 })).toBe(
			"cleared",
		)
		expect(tracker.mismatch).toBeUndefined()
	})

	it("reset() clears the flag and reports whether one was set", () => {
		const tracker = new RateTruthTracker()
		expect(tracker.reset()).toBe(false)
		run(tracker, 0, 6, 2_160_000)
		expect(tracker.reset()).toBe(true)
		expect(tracker.mismatch).toBeUndefined()
	})

	it("flags exactly the sustained out-of-tolerance runs", () => {
		// Feature: rate-truth, Property 1: flag iff |deviation| > tolerance for the sustain period
		fc.assert(
			fc.property(
				fc.double({ min: -0.5, max: 0.5, noNaN: true }),
				deviation => {
					const tracker = new RateTruthTracker()
					const events = run(
						tracker,
						0,
						RATE_TRUTH_SUSTAIN_MS / TICK,
						DECLARED * (1 + deviation),
					)
					// Byte rounding moves the measured deviation by < 1e-6.
					if (Math.abs(Math.abs(deviation) - RATE_TRUTH_TOLERANCE) < 1e-5)
						return
					expect(events.includes("flagged")).toBe(
						Math.abs(deviation) > RATE_TRUTH_TOLERANCE,
					)
				},
			),
			{ numRuns: 100 },
		)
	})
})
