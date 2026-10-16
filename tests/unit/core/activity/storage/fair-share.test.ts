import { describe, expect, it } from "vitest"
import {
	planFairStep,
	retentionShareKey,
	waterLevel,
} from "../../../../../src/core/activity/storage/fair-share.js"

describe("fair-share planner", () => {
	it("builds share keys", () => {
		expect(retentionShareKey("adsb-1", "aircraft")).toBe("decoder:adsb-1")
		expect(retentionShareKey(null, "page")).toBe("kind:page")
	})

	it("computes the design arithmetic water level", () => {
		expect(waterLevel([6000, 43200, 216000, 1296000], 151000)).toBe(50900)
		expect(waterLevel([10, 20], 30)).toBeNull()
		expect(waterLevel([], 0)).toBeNull()
		expect(waterLevel([5, 5, 5], 10)).toBe(3)
	})

	it("gives a quiet share nothing", () => {
		const plan = planFairStep({
			shares: [
				{ key: "decoder:busy", rows: 1000, bytes: 0 },
				{ key: "kind:page", rows: 10, bytes: 0 },
			],
			rowTarget: 500,
			byteExcess: null,
			budget: 100,
		})
		expect(plan.rowLevel).toBe(490)
		expect(plan.allocations).toEqual([
			{ key: "decoder:busy", rows: 100, minRows: 100, byteFloor: null },
		])
		expect(plan.residual).toBe(false)
	})

	it("single share gets min(budget, excess)", () => {
		const s = [{ key: "a", rows: 100, bytes: 0 }]
		expect(
			planFairStep({ shares: s, rowTarget: 95, byteExcess: null, budget: 50 })
				.allocations,
		).toEqual([{ key: "a", rows: 5, minRows: 5, byteFloor: null }])
		expect(
			planFairStep({ shares: s, rowTarget: 10, byteExcess: null, budget: 50 })
				.allocations,
		).toEqual([{ key: "a", rows: 50, minRows: 50, byteFloor: null }])
	})

	it("splits by largest remainder with key-ascending ties", () => {
		const plan = planFairStep({
			shares: [
				{ key: "c", rows: 20, bytes: 0 },
				{ key: "b", rows: 20, bytes: 0 },
				{ key: "a", rows: 20, bytes: 0 },
			],
			rowTarget: 30,
			byteExcess: null,
			budget: 10,
		})
		expect(plan.rowLevel).toBe(10)
		expect(plan.allocations).toEqual([
			{ key: "a", rows: 4, minRows: 4, byteFloor: null },
			{ key: "b", rows: 3, minRows: 3, byteFloor: null },
			{ key: "c", rows: 3, minRows: 3, byteFloor: null },
		])
	})

	it("budget smaller than share count picks largest excess first", () => {
		const plan = planFairStep({
			shares: [
				{ key: "a", rows: 12, bytes: 0 },
				{ key: "b", rows: 50, bytes: 0 },
				{ key: "c", rows: 12, bytes: 0 },
			],
			rowTarget: 30,
			byteExcess: null,
			budget: 2,
		})
		expect(plan.allocations).toEqual([
			{ key: "a", rows: 1, minRows: 1, byteFloor: null },
			{ key: "b", rows: 1, minRows: 1, byteFloor: null },
		])
	})

	it("converts byte excess to rows", () => {
		const plan = planFairStep({
			shares: [
				{ key: "big", rows: 100, bytes: 100_000 },
				{ key: "small", rows: 100, bytes: 1_000 },
			],
			rowTarget: null,
			byteExcess: 50_000,
			budget: 1000,
		})
		// T = 51000, level = 50000: big frees 50000 bytes at 1000 B/row = 50 rows.
		expect(plan.byteLevel).toBe(50_000)
		expect(plan.allocations).toEqual([
			{ key: "big", rows: 50, minRows: 0, byteFloor: 50_000 },
		])
	})

	it("byte excess at or above the total puts the level at 0", () => {
		const plan = planFairStep({
			shares: [{ key: "a", rows: 10, bytes: 100 }],
			rowTarget: null,
			byteExcess: 500,
			budget: 100,
		})
		expect(plan.byteLevel).toBe(0)
		expect(plan.allocations).toEqual([
			{ key: "a", rows: 10, minRows: 0, byteFloor: 0 },
		])
	})

	it("both caps take the larger excess", () => {
		const plan = planFairStep({
			shares: [
				{ key: "a", rows: 100, bytes: 1000 },
				{ key: "b", rows: 100, bytes: 100_000 },
			],
			rowTarget: 180,
			byteExcess: 10_000,
			budget: 1000,
		})
		expect(plan.rowLevel).toBe(90)
		expect(plan.byteLevel).toBe(90_000)
		// a: rows 10, bytes 0. b: rows 10, bytes 10000/1000 = 10.
		expect(plan.allocations).toEqual([
			{ key: "a", rows: 10, minRows: 10, byteFloor: 90_000 },
			{ key: "b", rows: 10, minRows: 10, byteFloor: 90_000 },
		])
	})

	it("flags residual excess when no share has rows to delete", () => {
		const plan = planFairStep({
			shares: [{ key: "a", rows: 0, bytes: 0 }],
			rowTarget: null,
			byteExcess: 100,
			budget: 10,
		})
		expect(plan.residual).toBe(true)
		expect(plan.allocations).toEqual([])
		const none = planFairStep({
			shares: [{ key: "a", rows: 5, bytes: 50 }],
			rowTarget: 10,
			byteExcess: 0,
			budget: 10,
		})
		expect(none).toEqual({
			allocations: [],
			rowLevel: null,
			byteLevel: null,
			residual: false,
			overLevel: [],
		})
	})

	it("sanitizes hostile inputs", () => {
		const plan = planFairStep({
			shares: [
				{ key: "a", rows: Number.NaN, bytes: -5 },
				{ key: "b", rows: Number.POSITIVE_INFINITY, bytes: Number.NaN },
				{ key: "c", rows: 10.7, bytes: 0 },
				{ key: "c", rows: 10, bytes: 0 },
			],
			rowTarget: -3,
			byteExcess: Number.NaN,
			budget: 7.9,
		})
		expect(plan.rowLevel).toBe(0)
		expect(plan.byteLevel).toBeNull()
		expect(plan.allocations).toEqual([
			{ key: "c", rows: 7, minRows: 7, byteFloor: null },
		])
		expect(
			planFairStep({
				shares: [{ key: "a", rows: 10, bytes: 0 }],
				rowTarget: 1,
				byteExcess: null,
				budget: 0,
			}).allocations,
		).toEqual([])
		expect(
			planFairStep({
				shares: [{ key: "a", rows: 10, bytes: 0 }],
				rowTarget: 1,
				byteExcess: null,
				budget: Number.NaN,
			}).allocations,
		).toEqual([])
	})
})
