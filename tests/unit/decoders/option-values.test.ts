// Feature: web-gaps-7, Property 14: Bounded numeric options
// Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5
import { describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import {
	createOptionWarner,
	readNumericArrayOption,
	readNumericOption,
	type NumericOptionIssue,
	type NumericOptionRule,
} from "../../../src/decoders/option-values.js"

const INT: NumericOptionRule = { key: "k", integer: true, min: 0, max: 10 }
const DEC: NumericOptionRule = {
	key: "k",
	integer: false,
	min: -5,
	max: 5,
	default: 1,
}
const SIGNED_INT: NumericOptionRule = {
	key: "k",
	integer: true,
	min: -100,
	max: 100,
}

function collect() {
	const calls: [string, NumericOptionIssue][] = []
	return {
		calls,
		warn: (key: string, issue: NumericOptionIssue) =>
			void calls.push([key, issue]),
	}
}

describe("readNumericOption", () => {
	it("passes finite in-range numbers silently", () => {
		const { calls, warn } = collect()
		expect(readNumericOption(3, INT, warn)).toBe(3)
		expect(readNumericOption(0, INT, warn)).toBe(0)
		expect(readNumericOption(10, INT, warn)).toBe(10)
		expect(readNumericOption(-4.5, DEC, warn)).toBe(-4.5)
		expect(calls).toEqual([])
	})

	it("treats undefined and null as absent without a warning", () => {
		const { calls, warn } = collect()
		expect(readNumericOption(undefined, INT, warn)).toBeUndefined()
		expect(readNumericOption(null, INT, warn)).toBeUndefined()
		expect(readNumericOption(null, DEC, warn)).toBe(1)
		expect(calls).toEqual([])
	})

	it("coerces numeric text as the schema does", () => {
		const { calls, warn } = collect()
		expect(readNumericOption("3", INT, warn)).toBe(3)
		expect(readNumericOption("-2.5", DEC, warn)).toBe(-2.5)
		expect(readNumericOption("-7", SIGNED_INT, warn)).toBe(-7)
		expect(calls).toEqual([])
	})

	it("rejects text forms the schema does not accept", () => {
		for (const value of ["3.5", "-1", " 3", "3 ", "0x10", "1e3", ""]) {
			const { calls, warn } = collect()
			expect(readNumericOption(value, INT, warn), value).toBeUndefined()
			expect(calls).toEqual([["k", "invalid"]])
		}
		const { calls, warn } = collect()
		expect(readNumericOption("1e1", DEC, warn)).toBe(1)
		expect(calls).toEqual([["k", "invalid"]])
	})

	it("treats garbage, NaN and Infinity as absent with an invalid warning", () => {
		const garbage: unknown[] = [
			"abc",
			"1; rm -rf /",
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			true,
			{},
			[],
			[3],
			() => 3,
			Symbol("x"),
			10n,
		]
		for (const value of garbage) {
			const { calls, warn } = collect()
			expect(readNumericOption(value, DEC, warn)).toBe(1)
			expect(calls).toEqual([["k", "invalid"]])
		}
	})

	it("clamps out-of-range values and fractions of integer keys", () => {
		const cases: [unknown, number][] = [
			[11, 10],
			[1e9, 10],
			[-1, 0],
			["99", 10],
			[3.7, 3],
		]
		for (const [value, expected] of cases) {
			const { calls, warn } = collect()
			expect(readNumericOption(value, INT, warn)).toBe(expected)
			expect(calls).toEqual([["k", "clamped"]])
		}
		const { calls, warn } = collect()
		expect(readNumericOption(-5.5, DEC, warn)).toBe(-5)
		expect(readNumericOption("-101", SIGNED_INT, warn)).toBe(-100)
		expect(calls).toEqual([
			["k", "clamped"],
			["k", "clamped"],
		])
	})

	it("never returns -0", () => {
		const { warn } = collect()
		expect(Object.is(readNumericOption(-0, INT, warn), 0)).toBe(true)
		expect(Object.is(readNumericOption(-0.4, SIGNED_INT, warn), 0)).toBe(true)
	})

	it("always returns a finite in-range number or the default", () => {
		fc.assert(
			fc.property(fc.anything(), value => {
				const result = readNumericOption(value, DEC, () => undefined)
				expect(typeof result).toBe("number")
				expect(Number.isFinite(result)).toBe(true)
				expect(result).toBeGreaterThanOrEqual(-5)
				expect(result).toBeLessThanOrEqual(5)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("readNumericArrayOption", () => {
	it("passes an in-bounds array and absent values silently", () => {
		const { calls, warn } = collect()
		expect(readNumericArrayOption([1, "2", 3], INT, 3, warn)).toEqual([1, 2, 3])
		expect(readNumericArrayOption(undefined, INT, 3, warn)).toBeUndefined()
		expect(readNumericArrayOption(null, INT, 3, warn)).toBeUndefined()
		expect(readNumericArrayOption([], INT, 3, warn)).toEqual([])
		expect(calls).toEqual([])
	})

	it("caps the length at maxLength with one clamped warning", () => {
		const { calls, warn } = collect()
		expect(readNumericArrayOption([1, 2, 3, 4, 5], INT, 3, warn)).toEqual([
			1, 2, 3,
		])
		expect(calls).toEqual([["k", "clamped"]])
	})

	it("drops invalid entries and clamps out-of-range ones with one warning", () => {
		const { calls, warn } = collect()
		expect(
			readNumericArrayOption([1, "x", 50, Number.NaN], INT, 10, warn),
		).toEqual([1, 10])
		expect(calls).toEqual([["k", "invalid"]])
		const second = collect()
		expect(readNumericArrayOption([1, 50], INT, 10, second.warn)).toEqual([
			1, 10,
		])
		expect(second.calls).toEqual([["k", "clamped"]])
	})

	it("treats a non-array as absent with an invalid warning", () => {
		for (const value of ["1,2", 3, {}, true]) {
			const { calls, warn } = collect()
			expect(readNumericArrayOption(value, INT, 3, warn)).toBeUndefined()
			expect(calls).toEqual([["k", "invalid"]])
		}
	})
})

describe("createOptionWarner", () => {
	it("logs once per key with the key and issue, never the value", () => {
		const log = vi.fn()
		const warn = createOptionWarner(log)
		const secret = "1; rm -rf / # 424242"
		readNumericOption(secret, { ...INT, key: "verbosity" }, warn)
		readNumericOption(1e9, { ...INT, key: "verbosity" }, warn)
		readNumericOption(Number.NaN, { ...INT, key: "fmGain" }, warn)
		expect(log).toHaveBeenCalledTimes(2)
		expect(log.mock.calls[0]?.[0]).toEqual({
			key: "verbosity",
			issue: "invalid",
		})
		expect(log.mock.calls[1]?.[0]).toEqual({ key: "fmGain", issue: "invalid" })
		const text = JSON.stringify(log.mock.calls)
		expect(text).not.toContain("rm -rf")
		expect(text).not.toContain("424242")
		expect(text).not.toContain("1000000000")
	})

	it("keeps separate warners independent (one per decoder)", () => {
		const a = vi.fn()
		const b = vi.fn()
		const warnA = createOptionWarner(a)
		const warnB = createOptionWarner(b)
		warnA("k", "clamped")
		warnA("k", "invalid")
		warnB("k", "clamped")
		expect(a).toHaveBeenCalledTimes(1)
		expect(b).toHaveBeenCalledTimes(1)
	})
})
