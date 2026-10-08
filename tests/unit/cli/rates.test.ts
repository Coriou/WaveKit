import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { FanoutSnapshot } from "@wavekit/api-types"
import {
	aggregateDropNow,
	branchDropNow,
	counterRate,
	pushCounter,
	pushFanout,
	restartIncrements,
	sparkAdd,
	sparkBuckets,
	type FanoutSample,
} from "../../../cli/source/data/rates.js"
import type { CounterSample } from "../../../cli/source/data/types.js"

function snap(
	t: number,
	offered: number | undefined,
	dropped: number,
	bp = false,
	id = "decoder-a",
): FanoutSnapshot {
	return {
		timestamp: new Date(t).toISOString(),
		branches: [
			{
				id,
				decoderId: id.replace("decoder-", ""),
				backpressureActive: bp,
				backpressureEnterCount: 0,
				droppedBytesTotal: dropped,
				droppedChunksTotal: 0,
				bufferBytes: 0,
				highWaterMark: 0,
				...(offered !== undefined ? { totalBytesWritten: offered } : {}),
			},
		],
		backpressureActiveCount: bp ? 1 : 0,
		droppedBytesTotal: dropped,
		droppedChunksTotal: 0,
	}
}

const build = (snaps: FanoutSnapshot[]): FanoutSample[] =>
	snaps.reduce<FanoutSample[]>((h, s) => pushFanout(h, s), [])

describe("drop now", () => {
	it("is Δdropped / Δoffered over the trailing 10 s", () => {
		const h = build([snap(0, 1000, 100), snap(5000, 2000, 400)])
		expect(branchDropNow(h, "decoder-a")).toBeCloseTo(0.3)
		expect(aggregateDropNow(h)).toMatchObject({
			ratio: 0.3,
			backpressure: 0,
			branches: 1,
			offeredBytesPerSec: 200,
		})
	})
	it("is unknown for every §10.6 condition", () => {
		expect(branchDropNow(build([snap(0, 1000, 0)]), "decoder-a")).toBeNull()
		expect(
			branchDropNow(
				build([snap(0, 1000, 0), snap(1500, 2000, 0)]),
				"decoder-a",
			),
		).toBeNull()
		expect(
			branchDropNow(
				build([snap(0, 1000, 0), snap(5000, 1000, 0)]),
				"decoder-a",
			),
		).toBeNull()
		expect(
			branchDropNow(
				build([snap(0, 1000, 50), snap(5000, 2000, 10)]),
				"decoder-a",
			),
		).toBeNull()
		expect(
			branchDropNow(
				build([snap(0, undefined, 0), snap(5000, undefined, 10)]),
				"decoder-a",
			),
		).toBeNull()
		expect(branchDropNow([], "decoder-a")).toBeNull()
	})
	it("only uses deltas, so a server clock ahead of the local clock still computes (review focus 3)", () => {
		const future = Date.now() + 3_600_000
		expect(
			branchDropNow(
				build([snap(future, 0, 0), snap(future + 5000, 1000, 250)]),
				"decoder-a",
			),
		).toBeCloseTo(0.25)
	})
	it("dedupes by timestamp and keeps only the trailing window", () => {
		const h = build([
			snap(0, 0, 0),
			snap(0, 0, 0),
			snap(20000, 10, 1),
			snap(25000, 20, 2),
		])
		expect(h.map(x => x.t)).toEqual([20000, 25000])
	})

	// Feature: cli-dashboard-overhaul, Property 12: drop now
	// Validates: spec §10.6
	it("P12: drop now is in [0,1] or unknown; equals Δd/Δo for two valid samples", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 1e9 }),
				fc.integer({ min: 2000, max: 9000 }),
				fc.integer({ min: 0, max: 1e9 }),
				fc.integer({ min: 1, max: 1e9 }),
				fc.integer({ min: 0, max: 1e9 }),
				(o0, dt, d0, dO, dD) => {
					const dDrop = Math.min(dD, dO)
					const h = build([snap(0, o0, d0), snap(dt, o0 + dO, d0 + dDrop)])
					const r = branchDropNow(h, "decoder-a")
					expect(r).not.toBeNull()
					expect(r!).toBeGreaterThanOrEqual(0)
					expect(r!).toBeLessThanOrEqual(1)
					expect(r!).toBeCloseTo(dDrop / dO, 9)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 12: drop now
	// Validates: spec §10.6
	it("P12: any counter decrease makes drop now unknown", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 1e6 }),
				fc.integer({ min: 1, max: 1e6 }),
				(a, b) => {
					const h = build([
						snap(0, a + b, a),
						snap(3000, a, a),
						snap(6000, a + b + 1, a),
					])
					expect(branchDropNow(h, "decoder-a")).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("decode rate", () => {
	it("needs 20 s of history and resets on a counter decrease", () => {
		let h: CounterSample[] = []
		h = pushCounter(h, 0, 10, 60000)
		h = pushCounter(h, 10000, 12, 60000)
		expect(counterRate(h)).toBeNull()
		h = pushCounter(h, 30000, 16, 60000)
		expect(counterRate(h)).toBeCloseTo(6 / 30)
		h = pushCounter(h, 40000, 2, 60000)
		expect(h).toEqual([{ t: 40000, v: 2 }])
		expect(counterRate(h)).toBeNull()
	})

	// Feature: cli-dashboard-overhaul, Property 13: decode rate
	// Validates: spec §10.6
	it("P13: rate is ≥ 0 or unknown, and a decrease resets the history", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1000 }), {
					minLength: 1,
					maxLength: 30,
				}),
				values => {
					let h: CounterSample[] = []
					values.forEach((v, i) => {
						const before = h[h.length - 1]
						h = pushCounter(h, i * 5000, v, 60000)
						if (before && v < before.v) expect(h).toEqual([{ t: i * 5000, v }])
						const r = counterRate(h)
						if (r !== null) expect(r).toBeGreaterThanOrEqual(0)
					})
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("restarts and sparkline", () => {
	it("counts restart increments inside 5 minutes", () => {
		let h: CounterSample[] = []
		for (const [t, v] of [
			[0, 10],
			[60000, 11],
			[120000, 11],
			[180000, 13],
		] as const)
			h = pushCounter(h, t, v, 300000)
		expect(restartIncrements(h, 180000)).toBe(3)
		expect(restartIncrements(h, 180000 + 300001)).toBe(0)
	})
	it("leaves unobserved minutes undefined", () => {
		let spark: Record<string, number> = {}
		spark = sparkAdd(spark, undefined, { t: 600000, v: 5 })
		spark = sparkAdd(spark, { t: 600000, v: 5 }, { t: 660000, v: 8 })
		const b = sparkBuckets(spark, 660000)
		expect(b).toHaveLength(30)
		expect(b[29]).toBe(3)
		expect(b[28]).toBe(0)
		expect(b[27]).toBeUndefined()
	})
})

function snap2(
	t: number,
	a: [number, number],
	b: [number, number] | null,
): FanoutSnapshot {
	const branch = (id: string, [offered, dropped]: [number, number]) => ({
		id,
		decoderId: id.replace("decoder-", ""),
		backpressureActive: false,
		backpressureEnterCount: 0,
		droppedBytesTotal: dropped,
		droppedChunksTotal: 0,
		bufferBytes: 0,
		highWaterMark: 0,
		totalBytesWritten: offered,
	})
	return {
		timestamp: new Date(t).toISOString(),
		branches: [branch("decoder-a", a), ...(b ? [branch("decoder-b", b)] : [])],
		backpressureActiveCount: 0,
		droppedBytesTotal: 0,
		droppedChunksTotal: 0,
	}
}

describe("R4: aggregate drop now and counter resets", () => {
	it("is unknown when any decoder branch in two samples has a counter decrease", () => {
		const h = build([
			snap2(0, [1000, 100], [5000, 900]),
			snap2(5000, [2000, 300], [100, 0]),
		])
		expect(branchDropNow(h, "decoder-a")).toBeCloseTo(0.2)
		expect(branchDropNow(h, "decoder-b")).toBeNull()
		expect(aggregateDropNow(h).ratio).toBeNull()
	})
	it("excludes a branch absent from one of the samples", () => {
		const h = build([
			snap2(0, [1000, 100], null),
			snap2(5000, [2000, 300], [100, 0]),
		])
		expect(aggregateDropNow(h)).toMatchObject({ ratio: 0.2, branches: 2 })
	})
	it("passes real fractions through, never pre-rounded (R21)", () => {
		const h = build([snap(0, 0, 0), snap(5000, 1_000_000, 37)])
		expect(branchDropNow(h, "decoder-a")).toBe(37 / 1_000_000)
		expect(aggregateDropNow(h).ratio).toBe(37 / 1_000_000)
	})
})
