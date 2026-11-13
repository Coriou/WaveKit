/**
 * Measure-from requests the spectrum worker cannot validate are ignored without an error (a
 * pipeline-error doubt would loop), and counted: one log line per MEASURE_FROM_LOG_MS at most,
 * naming how many were ignored since the last one (Q5).
 */
import { describe, expect, it } from "vitest"
import {
	IgnoredMeasureFrom,
	isMeasureFromMessage,
	MEASURE_FROM_LOG_MS,
} from "../../../../src/core/spectrum/worker-protocol.js"

describe("IgnoredMeasureFrom", () => {
	it("answers the first at once, then at most once per MEASURE_FROM_LOG_MS with the count since", () => {
		const c = new IgnoredMeasureFrom()
		expect(c.note(1000)).toEqual({ count: 1, total: 1 })
		expect(c.note(1001)).toBeNull()
		expect(c.note(1000 + MEASURE_FROM_LOG_MS - 1)).toBeNull()
		// At the bound: the line is due, with the two held back and this one.
		expect(c.note(1000 + MEASURE_FROM_LOG_MS)).toEqual({ count: 3, total: 4 })
		expect(c.note(1000 + MEASURE_FROM_LOG_MS + 1)).toBeNull()
		expect(c.note(1000 + 2 * MEASURE_FROM_LOG_MS + 1)).toEqual({
			count: 2,
			total: 6,
		})
	})

	it("only measure-from inputs are its business", () => {
		expect(
			isMeasureFromMessage({ type: "input", input: { kind: "measure-from" } }),
		).toBe(true)
		expect(
			isMeasureFromMessage({ type: "input", input: { kind: "bytes" } }),
		).toBe(false)
		expect(isMeasureFromMessage(null)).toBe(false)
	})
})
