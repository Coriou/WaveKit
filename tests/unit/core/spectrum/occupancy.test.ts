import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { OccupancyHistory } from "../../../../src/core/spectrum/occupancy.js"
import { ScannerPersistence } from "../../../../src/core/scanner/store/persistence.js"
import type {
	EngineState,
	FreqRange,
} from "../../../../src/core/spectrum/types.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const HOUR = 3_600_000
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0) // on an hour boundary
const BASE = 400_000_000
const BW = 12_500
const r = (startHz: number, endHz: number): FreqRange => ({ startHz, endHz })
/** ±1 kHz around the centre of bucket i above BASE. */
const around = (i: number): FreqRange =>
	r(BASE + i * BW + 5_250, BASE + i * BW + 7_250)

function blocks(
	h: OccupancyHistory,
	at: number,
	n: number,
	usable: FreqRange,
	active: (i: number) => FreqRange[],
	blockMs = 50,
): void {
	for (let i = 0; i < n; i++)
		h.observe(at + i * blockMs, usable, active(i), blockMs)
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "wavekit-occupancy-"))
	try {
		return await fn(dir)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

describe("OccupancyHistory duty", () => {
	it("adds observed time to every usable bucket and active time to buckets under a track", () => {
		const h = new OccupancyHistory()
		blocks(h, T0, 20, r(BASE, BASE + 50_000), i =>
			i < 5 ? [r(BASE + 12_000, BASE + 13_000)] : [],
		)
		expect(h.size).toBe(4) // the usable span ends exactly on a bucket edge
		expect(h.query(r(BASE, BASE + 50_000), T0, T0 + 1_000)).toEqual({
			bucketHz: BW,
			buckets: [
				{ startHz: BASE, dutyByHour: [0.25], observedMs: 1_000, activeMs: 250 },
				{
					startHz: BASE + 12_500,
					dutyByHour: [0.25],
					observedMs: 1_000,
					activeMs: 250,
				},
				{
					startHz: BASE + 25_000,
					dutyByHour: [0],
					observedMs: 1_000,
					activeMs: 0,
				},
				{
					startHz: BASE + 37_500,
					dutyByHour: [0],
					observedMs: 1_000,
					activeMs: 0,
				},
			],
		})
	})

	it("ignores active ranges outside the usable span and clips partial ones", () => {
		const h = new OccupancyHistory()
		h.observe(
			T0,
			r(BASE, BASE + 12_500),
			[r(BASE + 1_000_000, BASE + 1_010_000), r(BASE - 30_000, BASE + 1_000)],
			50,
		)
		expect(
			h.query(r(BASE + 1_000_000, BASE + 1_100_000), T0, T0).buckets,
		).toEqual([])
		expect(h.query(r(BASE - 50_000, BASE + 12_500), T0, T0).buckets).toEqual([
			{ startHz: BASE, dutyByHour: [1], observedMs: 50, activeMs: 50 },
		])
	})

	it("ranks the most active buckets and seeds from the busiest one over 24 h", () => {
		const h = new OccupancyHistory()
		blocks(h, T0, 100, r(BASE, BASE + 50_000), i => [
			...(i < 50 ? [around(0)] : []),
			...(i < 80 ? [around(2)] : []),
			...(i < 10 ? [around(3)] : []),
		])
		expect(h.topActive(r(BASE, BASE + 50_000), 2, T0, T0 + 5_000)).toEqual([
			{ startHz: BASE + 25_000, duty: 0.8, observedMs: 5_000, activeMs: 4_000 },
			{ startHz: BASE, duty: 0.5, observedMs: 5_000, activeMs: 2_500 },
		])
		expect(h.seedScore(r(BASE, BASE + 50_000), T0 + 5_000)).toBeCloseTo(0.8)
		expect(h.seedScore(r(BASE, BASE + 50_000), T0 + 30 * HOUR)).toBe(0) // older than 24 h
		expect(h.seedScore(r(BASE + 5_000_000, BASE + 6_000_000), T0)).toBe(0) // never observed
		h.observe(
			T0,
			r(BASE + 2_000_000, BASE + 2_012_500),
			[r(BASE + 2_000_000, BASE + 2_012_500)],
			50,
		)
		expect(h.seedScore(r(BASE + 2_000_000, BASE + 2_012_500), T0)).toBe(0) // observed < 1 s
	})

	it("rejects an invalid bucket width or bound", () => {
		expect(() => new OccupancyHistory({ bucketHz: 0 })).toThrow(WaveKitError)
		expect(() => new OccupancyHistory({ maxBuckets: 0 })).toThrow(WaveKitError)
	})
})

describe("OccupancyHistory hourly ring", () => {
	const one = r(BASE, BASE + 12_500)

	it("rolls over to a new slot each hour", () => {
		const h = new OccupancyHistory()
		h.observe(T0 + HOUR - 2_000, one, [one], 2_000)
		h.observe(T0 + HOUR + 10, one, [], 1_000)
		expect(h.query(one, T0, T0 + HOUR + 10).buckets[0]).toEqual({
			startHz: BASE,
			dutyByHour: [1, 0],
			observedMs: 3_000,
			activeMs: 2_000,
		})
	})

	it("keeps the current hour exact and rounds a closed hour's remainder to whole seconds", () => {
		const h = new OccupancyHistory()
		for (let i = 0; i < 29; i++)
			h.observe(T0 + i * 50, one, i < 10 ? [one] : [], 50) // 1450 ms observed, 500 ms active
		expect(h.query(one, T0, T0 + 2_000).buckets[0]).toMatchObject({
			observedMs: 1_450,
			activeMs: 500,
		})
		h.observe(T0 + HOUR, one, [], 50)
		// hour H closed: 1 s + round(0.45 s) = 1 s observed, round(0.5 s) = 1 s active
		expect(h.query(one, T0, T0).buckets[0]).toEqual({
			startHz: BASE,
			dutyByHour: [1],
			observedMs: 1_000,
			activeMs: 1_000,
		})
	})

	it("caps a slot at one hour and never reports active above observed", () => {
		const h = new OccupancyHistory()
		for (let i = 0; i < 5; i++) h.observe(T0 + i, one, [one], 1_000_000)
		expect(h.query(one, T0, T0).buckets[0]).toEqual({
			startHz: BASE,
			dutyByHour: [1],
			observedMs: HOUR,
			activeMs: HOUR,
		})
	})

	it("wraps after 168 hours, drops samples older than the ring and keeps late ones inside it", () => {
		const h = new OccupancyHistory()
		h.observe(T0, one, [one], 2_000)
		h.observe(T0 + 170 * HOUR, one, [], 50)
		const now = T0 + 170 * HOUR
		let view = h.query(one, T0, now).buckets[0]
		expect(view?.dutyByHour).toHaveLength(168)
		expect(view?.dutyByHour.filter(d => d !== null)).toEqual([0])
		expect(view?.observedMs).toBe(50)
		h.observe(T0 + HOUR, one, [one], 2_000) // older than the ring: dropped
		h.observe(T0 + 169 * HOUR, one, [one], 2_000) // late but inside the ring: kept as whole seconds
		view = h.query(one, T0, now).buckets[0]
		expect(view?.observedMs).toBe(2_050)
		expect(view?.dutyByHour.at(-2)).toBe(1)
		expect(h.query(one, T0, T0 + 10 * HOUR).buckets).toEqual([]) // hours the ring no longer holds
	})
})

describe("OccupancyHistory bound", () => {
	it("evicts the least recently observed buckets", () => {
		const h = new OccupancyHistory({ maxBuckets: 10 })
		h.observe(T0, r(BASE, BASE + 125_000), [], 50)
		h.observe(T0 + 1_000, r(BASE, BASE + 25_000), [], 50)
		h.observe(T0 + 2_000, r(BASE + 1_000_000, BASE + 1_037_500), [], 50)
		expect(h.size).toBe(10)
		expect(
			h
				.query(r(BASE, BASE + 125_000), T0, T0 + 2_000)
				.buckets.map(b => (b.startHz - BASE) / BW),
		).toEqual([0, 1, 5, 6, 7, 8, 9])
	})

	it("holds the bound even when one block spans more buckets than allowed", () => {
		const h = new OccupancyHistory({ maxBuckets: 10 })
		h.observe(T0, r(BASE, BASE + 1_000_000), [], 50)
		expect(h.size).toBe(10)
		expect(
			h
				.query(r(BASE, BASE + 1_000_000), T0, T0)
				.buckets.map(b => (b.startHz - BASE) / BW),
		).toEqual([70, 71, 72, 73, 74, 75, 76, 77, 78, 79])
	})
})

describe("OccupancyHistory persistence", () => {
	function busyHistory(): OccupancyHistory {
		const h = new OccupancyHistory({ maxBuckets: 50 })
		blocks(h, T0, 40, r(BASE, BASE + 100_000), i =>
			i % 3 === 0 ? [around(1), around(6)] : [],
		)
		blocks(h, T0 + 5 * HOUR, 40, r(BASE + 50_000, BASE + 150_000), i =>
			i % 2 === 0 ? [around(9)] : [],
		)
		return h
	}

	it("round-trips through exportState/importState, including the eviction order", () => {
		const h = busyHistory()
		const state = JSON.parse(JSON.stringify(h.exportState())) as ReturnType<
			OccupancyHistory["exportState"]
		>
		const copy = new OccupancyHistory({ maxBuckets: 50 })
		expect(copy.importState(state)).toBe(true)
		expect(copy.exportState()).toEqual(h.exportState())
		expect(copy.query(r(BASE, BASE + 150_000), T0, T0 + 6 * HOUR)).toEqual(
			h.query(r(BASE, BASE + 150_000), T0, T0 + 6 * HOUR),
		)
		expect(new OccupancyHistory({ bucketHz: 25_000 }).importState(state)).toBe(
			false,
		)
	})

	it("persists per source next to the engine state without disturbing engine loading", async () => {
		await withDir(async dir => {
			const p = new ScannerPersistence({ dir, logger, now: () => T0 })
			const engine: EngineState = {
				version: 1,
				absoluteFloors: [],
				spurs: [],
				kByRange: [],
			}
			const state = busyHistory().exportState()
			await p.writeEngine("rtl/1", engine)
			await p.writeOccupancy("rtl/1", state)
			expect(await p.loadOccupancy("rtl/1")).toEqual(state)
			expect(await p.loadOccupancy("other")).toBeNull()
			expect(await p.loadEngine("rtl/1")).toEqual(engine)
			expect(await p.loadEngine("other")).toBeNull()
			const loaded = await p.load()
			expect(loaded.engines).toEqual({ "rtl/1": engine })
			await mkdir(join(dir, "engine", "occupancy"), { recursive: true })
			await writeFile(
				join(dir, "engine", "occupancy", "bad.json"),
				JSON.stringify({
					version: 1,
					bucketHz: 12_500,
					buckets: [
						{ index: 1, lastHour: 5, observed: "AAAA", active: "AAAA" },
					],
				}),
			)
			expect(await p.loadOccupancy("bad")).toBeNull()
		})
	})

	// Feature: signal-discovery-scanner, Property 21: Occupancy bounds
	// Validates: spec § 4.11
	it("keeps duty in [0, 1], active ≤ observed and size ≤ maxBuckets for any observe sequence", () => {
		const opArb = fc.record({
			dtMs: fc.oneof(
				fc.integer({ min: 0, max: 3 * HOUR }),
				fc.integer({ min: -200 * HOUR, max: 0 }),
			),
			start: fc.integer({ min: -100_000, max: 1_000_000 }),
			width: fc.integer({ min: -10_000, max: 200_000 }),
			active: fc.array(
				fc.record({
					start: fc.integer({ min: -200_000, max: 1_300_000 }),
					width: fc.integer({ min: 0, max: 100_000 }),
				}),
				{ maxLength: 4 },
			),
			// whole and fractional block lengths, up to blocks that saturate an hour slot
			blockMs: fc.oneof(
				fc.integer({ min: 1, max: 5_000 }),
				fc.double({ min: 0.1, max: 200, noNaN: true }),
				fc.constant(2_000_000),
			),
		})
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 50 }),
				fc.array(opArb, { minLength: 1, maxLength: 60 }),
				(maxBuckets, ops) => {
					const h = new OccupancyHistory({ maxBuckets })
					let at = T0
					for (const op of ops) {
						at = Math.max(0, at + op.dtMs)
						h.observe(
							at,
							r(BASE + op.start, BASE + op.start + op.width),
							op.active.map(a => r(BASE + a.start, BASE + a.start + a.width)),
							op.blockMs,
						)
						expect(h.size).toBeLessThanOrEqual(maxBuckets)
					}
					const all = r(BASE - 1_000_000, BASE + 3_000_000)
					for (const b of h.query(all, 0, at).buckets) {
						expect(b.activeMs).toBeLessThanOrEqual(b.observedMs)
						for (const d of b.dutyByHour)
							if (d !== null) {
								expect(d).toBeGreaterThanOrEqual(0)
								expect(d).toBeLessThanOrEqual(1)
							}
					}
					for (const t of h.topActive(all, 100, 0, at)) {
						expect(t.duty).toBeGreaterThan(0)
						expect(t.duty).toBeLessThanOrEqual(1)
					}
					const seed = h.seedScore(all, at)
					expect(seed).toBeGreaterThanOrEqual(0)
					expect(seed).toBeLessThanOrEqual(1)
				},
			),
			{ numRuns: 100 },
		)
	})
})
