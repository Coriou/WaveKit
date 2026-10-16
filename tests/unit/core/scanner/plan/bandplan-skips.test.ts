import { describe, expect, it } from "vitest"
import type { ResolvedBandPlanView } from "@wavekit/api-types"
import {
	BANDPLAN_SKIP_MAX_RANGES,
	BANDPLAN_SKIP_MAX_SOURCES,
} from "@wavekit/api-types"
import {
	bandPlanSkipSources,
	computeBandPlanSkips,
} from "../../../../../src/core/scanner/plan/bandplan-skips.js"
import type {
	BandPlanSkipSource,
	NormalisedJobSpec,
} from "../../../../../src/core/scanner/types.js"

function spec(
	ranges: { startHz: number; endHz: number; enabled?: boolean }[],
): NormalisedJobSpec {
	return { ranges } as unknown as NormalisedJobSpec
}

function band(key: string, skip: unknown, segments: unknown): unknown {
	return { key, band: { skip }, segments }
}

function view(bands: unknown[]): ResolvedBandPlanView {
	return { bands } as unknown as ResolvedBandPlanView
}

describe("bandPlanSkipSources", () => {
	it("takes segments of skip bands only, in view order", () => {
		const v = view([
			band("a/x", { reason: "noise" }, [
				{ startHz: 1, endHz: 5 },
				{ startHz: 10, endHz: 20 },
			]),
			band("a/y", null, [{ startHz: 30, endHz: 40 }]),
			band("a/z", undefined, [{ startHz: 30, endHz: 40 }]),
			band("b/w", { reason: "x" }, [{ startHz: 50, endHz: 60 }]),
		])
		expect(bandPlanSkipSources(v)).toEqual([
			{ key: "a/x", startHz: 1, endHz: 5 },
			{ key: "a/x", startHz: 10, endHz: 20 },
			{ key: "b/w", startHz: 50, endHz: 60 },
		])
	})

	it("returns [] for missing or malformed views", () => {
		expect(bandPlanSkipSources(null)).toEqual([])
		expect(bandPlanSkipSources(undefined)).toEqual([])
		expect(bandPlanSkipSources(5 as unknown as ResolvedBandPlanView)).toEqual(
			[],
		)
		expect(bandPlanSkipSources(view("nope" as unknown as unknown[]))).toEqual(
			[],
		)
		const throwing = Object.defineProperty({}, "bands", {
			get() {
				throw new Error("boom")
			},
		}) as ResolvedBandPlanView
		expect(bandPlanSkipSources(throwing)).toEqual([])
	})

	it("skips malformed bands and segments", () => {
		const bad = Object.defineProperty({ key: "t/t" }, "band", {
			get() {
				throw new Error("boom")
			},
		})
		const v = view([
			null,
			7,
			bad,
			{
				key: 3,
				band: { skip: { reason: "x" } },
				segments: [{ startHz: 1, endHz: 2 }],
			},
			band("a/x", { reason: "x" }, "nope"),
			band("a/y", { reason: "x" }, [
				null,
				{ startHz: Number.NaN, endHz: 3 },
				{ startHz: 9, endHz: 3 },
				{ startHz: "1", endHz: 3 },
				{ startHz: 1, endHz: Infinity },
				{ startHz: 4, endHz: 4 },
			]),
		])
		expect(bandPlanSkipSources(v)).toEqual([
			{ key: "a/y", startHz: 4, endHz: 4 },
		])
	})

	it("stops at the bound plus one", () => {
		const segs = Array.from({ length: 2000 }, (_, i) => ({
			startHz: i * 10,
			endHz: i * 10 + 5,
		}))
		const out = bandPlanSkipSources(
			view([
				band("a/x", { reason: "x" }, segs),
				band("a/y", { reason: "x" }, segs),
			]),
		)
		expect(out).toHaveLength(BANDPLAN_SKIP_MAX_SOURCES + 1)
	})
})

describe("bandPlanSkipSources regressions", () => {
	const seg = [{ startHz: 1, endHz: 2 }]
	it("accepts only a BandSkip by meaning", () => {
		for (const skip of [false, true, 0, "x", {}, { reason: 5 }, [], ["x"]]) {
			expect(bandPlanSkipSources(view([band("a/x", skip, seg)]))).toEqual([])
		}
		expect(
			bandPlanSkipSources(view([band("a/x", { reason: "" }, seg)])),
		).toEqual([{ key: "a/x", startHz: 1, endHz: 2 }])
	})

	it("counts examined segments, not accepted ones, against the bound", () => {
		const nulls: unknown[] = Array.from(
			{ length: BANDPLAN_SKIP_MAX_SOURCES + 1 },
			() => null,
		)
		const out = bandPlanSkipSources(
			view([
				band("a/x", { reason: "x" }, nulls),
				band("a/y", { reason: "x" }, [{ startHz: 5, endHz: 6 }]),
			]),
		)
		expect(out).toEqual([])
	})

	it("examines at most MAX + 1 segments of a huge malformed array", () => {
		let reads = 0
		const huge = new Proxy([] as unknown[], {
			get(target, prop, receiver) {
				if (prop === "length") return 1e9
				if (typeof prop === "string" && /^\d+$/.test(prop)) {
					reads++
					return null
				}
				return Reflect.get(target, prop, receiver) as unknown
			},
		})
		expect(
			bandPlanSkipSources(view([band("a/x", { reason: "x" }, huge)])),
		).toEqual([])
		expect(reads).toBe(BANDPLAN_SKIP_MAX_SOURCES + 1)
	})

	it("keeps the MAX + 1 overflow signal when the extra segment is valid", () => {
		const segs: unknown[] = Array.from(
			{ length: BANDPLAN_SKIP_MAX_SOURCES + 5 },
			(_, i) => (i === 0 ? null : { startHz: i * 10, endHz: i * 10 + 1 }),
		)
		const out = bandPlanSkipSources(view([band("a/x", { reason: "x" }, segs)]))
		// 1 malformed + MAX valid examined: MAX entries, overflow cut silently (documented).
		expect(out).toHaveLength(BANDPLAN_SKIP_MAX_SOURCES)
		const valid = segs.slice(1)
		const full = bandPlanSkipSources(
			view([band("a/x", { reason: "x" }, valid)]),
		)
		expect(full).toHaveLength(BANDPLAN_SKIP_MAX_SOURCES + 1)
		const r = computeBandPlanSkips(full, spec([{ startHz: 0, endHz: 1e9 }]))
		expect(r.issues.map(i => i.code)).toEqual(["bandplan-skips-truncated"])
	})
})

describe("computeBandPlanSkips", () => {
	it("empty sources give an empty result", () => {
		expect(
			computeBandPlanSkips([], spec([{ startHz: 0, endHz: 100 }])),
		).toEqual({ ranges: [], issues: [] })
	})

	it("clips to enabled ranges only", () => {
		const r = computeBandPlanSkips(
			[{ key: "a/x", startHz: 50, endHz: 250 }],
			spec([
				{ startHz: 0, endHz: 100 },
				{ startHz: 120, endHz: 140, enabled: false },
				{ startHz: 200, endHz: 300 },
			]),
		)
		expect(r.ranges).toEqual([
			{ startHz: 50, endHz: 100, bandKeys: ["a/x"], applied: false },
			{ startHz: 200, endHz: 250, bandKeys: ["a/x"], applied: false },
		])
		expect(r.issues).toEqual([])
	})

	it("drops sources outside every enabled range and invalid sources", () => {
		const r = computeBandPlanSkips(
			[
				{ key: "a/x", startHz: 500, endHz: 600 },
				{ key: "a/y", startHz: 9, endHz: 3 },
				{ key: "a/z", startHz: Number.NaN, endHz: 3 },
			],
			spec([{ startHz: 0, endHz: 100 }]),
		)
		expect(r.ranges).toEqual([])
	})

	it("merges overlapping and touching (inclusive Hz) and unites keys", () => {
		const r = computeBandPlanSkips(
			[
				{ key: "b/2", startHz: 30, endHz: 40 },
				{ key: "a/1", startHz: 10, endHz: 20 },
				{ key: "c/3", startHz: 21, endHz: 25 },
				{ key: "a/1", startHz: 15, endHz: 18 },
				{ key: "d/4", startHz: 27, endHz: 29 },
				{ key: "e/5", startHz: 60, endHz: 70 },
			],
			spec([{ startHz: 0, endHz: 1000 }]),
		)
		expect(r.ranges).toEqual([
			{ startHz: 10, endHz: 25, bandKeys: ["a/1", "c/3"], applied: false },
			{ startHz: 27, endHz: 40, bandKeys: ["b/2", "d/4"], applied: false },
			{ startHz: 60, endHz: 70, bandKeys: ["e/5"], applied: false },
		])
	})

	const wide = spec([{ startHz: 0, endHz: 1e9 }])
	const disjoint = (n: number): BandPlanSkipSource[] =>
		Array.from({ length: n }, (_, i) => ({
			key: `p/${i}`,
			startHz: i * 100,
			endHz: i * 100 + 10,
		}))

	it("1 024 sources: all examined, no warning", () => {
		const src = Array.from({ length: BANDPLAN_SKIP_MAX_SOURCES }, (_, i) => ({
			key: "p/a",
			startHz: i * 10,
			endHz: i * 10 + 9,
		}))
		const r = computeBandPlanSkips(src, wide)
		expect(r.ranges).toEqual([
			{ startHz: 0, endHz: 10239, bandKeys: ["p/a"], applied: false },
		])
		expect(r.issues).toEqual([])
	})

	it("1 025 sources: the last is not examined, one warning without keys", () => {
		const src = Array.from(
			{ length: BANDPLAN_SKIP_MAX_SOURCES + 1 },
			(_, i) => ({ key: `p/${i}`, startHz: i * 10, endHz: i * 10 + 9 }),
		)
		const r = computeBandPlanSkips(src, wide)
		expect(r.ranges).toHaveLength(1)
		expect(r.ranges[0]?.endHz).toBe(10239)
		expect(r.ranges[0]?.bandKeys).not.toContain("p/1024")
		expect(r.issues).toHaveLength(1)
		expect(r.issues[0]).toMatchObject({
			severity: "warning",
			code: "bandplan-skips-truncated",
		})
		expect(r.issues[0]?.message).not.toContain("p/")
	})

	it("256 ranges: no warning; 257: 256 kept with a warning", () => {
		const a = computeBandPlanSkips(disjoint(BANDPLAN_SKIP_MAX_RANGES), wide)
		expect(a.ranges).toHaveLength(256)
		expect(a.issues).toEqual([])
		const b = computeBandPlanSkips(disjoint(BANDPLAN_SKIP_MAX_RANGES + 1), wide)
		expect(b.ranges).toHaveLength(256)
		expect(b.ranges[255]?.startHz).toBe(25500)
		expect(b.issues.map(i => i.code)).toEqual(["bandplan-skips-truncated"])
	})

	it("truncated but empty reports no issue", () => {
		const r = computeBandPlanSkips(
			disjoint(BANDPLAN_SKIP_MAX_SOURCES + 1),
			spec([{ startHz: 5e8, endHz: 6e8 }]),
		)
		expect(r).toEqual({ ranges: [], issues: [] })
	})

	it("honours custom limits", () => {
		const r = computeBandPlanSkips(disjoint(5), wide, {
			maxSources: 3,
			maxRanges: 2,
		})
		expect(r.ranges).toHaveLength(2)
		expect(r.issues).toHaveLength(1)
	})
})
