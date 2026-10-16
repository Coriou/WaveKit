import { describe, expect, it } from "vitest"
import { ActivityQueryInvalidError } from "../../../../../src/core/activity/query/errors.js"
import {
	normaliseBandMapQuery,
	normaliseTimelineQuery,
	parseDecimalInteger,
} from "../../../../../src/core/activity/query/validate.js"

const NOW = Date.parse("2026-10-16T12:00:00.000Z")
const H = 3_600_000
const iso = (offset: number): string => new Date(NOW + offset).toISOString()

function rejects(run: () => unknown, label: string): void {
	expect(run, label).toThrow(ActivityQueryInvalidError)
}

describe("parseDecimalInteger", () => {
	it("accepts digits and safe integers only", () => {
		expect(parseDecimalInteger("0", "x")).toBe(0)
		expect(parseDecimalInteger("012", "x")).toBe(12)
		expect(parseDecimalInteger(7, "x")).toBe(7)
		for (const bad of [
			"",
			"-1",
			"+1",
			"1.5",
			"1e3",
			"0x10",
			" 1",
			"1 ",
			"1".repeat(16),
			-1,
			1.5,
			NaN,
			null,
			[],
			{},
		]) {
			rejects(() => parseDecimalInteger(bad, "x"), String(bad))
		}
	})
})

describe("normaliseBandMapQuery", () => {
	it("applies the defaults", () => {
		expect(normaliseBandMapQuery({}, NOW)).toEqual({
			producedFromMs: NOW - 24 * H,
			producedToMs: NOW,
			minHz: 0,
			maxHz: 2_000_000_000,
			bucketHz: 12_500,
		})
	})

	it("accepts from == to, 72 h, and every bound exactly", () => {
		for (const input of [
			{ producedFrom: iso(0), producedTo: iso(0) },
			{ producedFrom: iso(-72 * H), producedTo: iso(0) },
			{ minHz: 0, maxHz: 2_000_000_000 },
			{ minHz: 98_000_000_000, maxHz: 100_000_000_000 },
			{ minHz: 5, maxHz: 5 },
			{ bucketHz: 1_000 },
			{ bucketHz: 1_000_000 },
			{ minHz: "100", maxHz: "200", bucketHz: "2000" },
		]) {
			expect(
				() => normaliseBandMapQuery(input, NOW),
				JSON.stringify(input),
			).not.toThrow()
		}
	})

	it("rejects every rule one past its bound", () => {
		const bad: unknown[] = [
			{ producedFrom: "nope" },
			{ producedFrom: iso(0), producedTo: iso(-1) },
			{ producedFrom: iso(-72 * H - 1), producedTo: iso(0) },
			{ minHz: 6, maxHz: 5 },
			{ minHz: 1, maxHz: 2_000_000_002 },
			{ minHz: 98_000_000_001, maxHz: 100_000_000_001 },
			{ minHz: 100_000_000_001, maxHz: 100_000_000_001 },
			{ bucketHz: 999 },
			{ bucketHz: 1_000_001 },
			{ bucketHz: "12.5" },
			{ minHz: "-1" },
			{ minHz: "abc" },
			{ categories: ["bogus"] },
			{ extra: 1 },
			{ entityKeys: ["a"] },
		]
		for (const input of bad) {
			rejects(() => normaliseBandMapQuery(input, NOW), JSON.stringify(input))
		}
	})

	it("sorts and deduplicates filters", () => {
		expect(
			normaliseBandMapQuery(
				{ categories: ["marine", "aircraft", "marine"], protocols: ["b", "a"] },
				NOW,
			),
		).toMatchObject({
			categories: ["aircraft", "marine"],
			protocols: ["a", "b"],
		})
	})
})

describe("normaliseTimelineQuery", () => {
	const from = (buckets: number, bucketMs: number): Record<string, unknown> => {
		// Epoch-aligned start so the count is exact.
		const start = Math.floor(NOW / bucketMs) * bucketMs
		return {
			producedFrom: new Date(start).toISOString(),
			producedTo: new Date(start + (buckets - 1) * bucketMs).toISOString(),
			bucketMs,
		}
	}

	it("applies the defaults", () => {
		expect(normaliseTimelineQuery({}, NOW)).toEqual({
			producedFromMs: NOW - H,
			producedToMs: NOW,
			bucketMs: 60_000,
		})
	})

	it("accepts 1 440 buckets and rejects 1 441", () => {
		expect(() => normaliseTimelineQuery(from(1_440, 60_000), NOW)).not.toThrow()
		rejects(() => normaliseTimelineQuery(from(1_441, 60_000), NOW), "1441")
		expect(() => normaliseTimelineQuery(from(1_440, 10_000), NOW)).not.toThrow()
		rejects(
			() => normaliseTimelineQuery(from(1_441, 10_000), NOW),
			"1441 at 10s",
		)
	})

	it("counts a misaligned window by the grid steps it touches", () => {
		const bucketMs = 60_000
		const start = Math.floor(NOW / bucketMs) * bucketMs + 59_999
		// 1 439 whole steps later plus 2 ms crosses into a 1 441st bucket.
		rejects(
			() =>
				normaliseTimelineQuery(
					{
						producedFrom: new Date(start).toISOString(),
						producedTo: new Date(
							start + 1_440 * bucketMs - 59_998,
						).toISOString(),
					},
					NOW,
				),
			"misaligned",
		)
	})

	it("bounds the window, bucketMs and keys at and past the limit", () => {
		expect(() =>
			normaliseTimelineQuery(
				{ producedFrom: iso(-72 * H), producedTo: iso(0), bucketMs: 3_600_000 },
				NOW,
			),
		).not.toThrow()
		rejects(
			() =>
				normaliseTimelineQuery(
					{
						producedFrom: iso(-72 * H - 1),
						producedTo: iso(0),
						bucketMs: 3_600_000,
					},
					NOW,
				),
			"73h",
		)
		expect(() =>
			normaliseTimelineQuery({ bucketMs: 10_000 }, NOW),
		).not.toThrow()
		expect(() =>
			normaliseTimelineQuery({ bucketMs: 3_600_000 }, NOW),
		).not.toThrow()
		rejects(() => normaliseTimelineQuery({ bucketMs: 9_999 }, NOW), "min")
		rejects(() => normaliseTimelineQuery({ bucketMs: 3_600_001 }, NOW), "max")
		rejects(() => normaliseTimelineQuery({ bucketMs: "1.5e4" }, NOW), "float")
		rejects(
			() =>
				normaliseTimelineQuery(
					{ producedFrom: iso(0), producedTo: iso(-1) },
					NOW,
				),
			"order",
		)
		expect(() =>
			normaliseTimelineQuery({ producedFrom: iso(0), producedTo: iso(0) }, NOW),
		).not.toThrow()
		const keys = (n: number): string[] =>
			Array.from({ length: n }, (_, i) => `k${i}`)
		expect(
			normaliseTimelineQuery({ entityKeys: keys(64) }, NOW).entityKeys,
		).toHaveLength(64)
		rejects(
			() => normaliseTimelineQuery({ entityKeys: keys(65) }, NOW),
			"65 keys",
		)
		rejects(
			() => normaliseTimelineQuery({ categories: ["bogus"] }, NOW),
			"category",
		)
		rejects(() => normaliseTimelineQuery({ minHz: 1 }, NOW), "unknown")
	})

	it("keeps commas inside entity keys", () => {
		expect(
			normaliseTimelineQuery({ entityKeys: ["a,b"] }, NOW).entityKeys,
		).toEqual(["a,b"])
	})
})
