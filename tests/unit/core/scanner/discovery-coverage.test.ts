// Band inspection UX req 1.4: Discovery.coverage projection from decoder placements.
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import {
	buildCoverageIndex,
	withCoverage,
} from "../../../../src/core/scanner/discovery-coverage.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"

const F = 433_920_000

interface P {
	sourceId?: unknown
	channelHz?: unknown
	reach?: unknown
	running?: unknown
	suspension?: unknown
}

function status(
	id: string,
	placements: readonly P[] | undefined,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		...(placements !== undefined
			? {
					placements: placements.map(p => ({
						sourceId: "rtl",
						reach: "channel",
						running: false,
						...p,
					})),
				}
			: {}),
		...extra,
	}
}

const band = (sourceId: string, c = F, w = 1_000_000) => ({
	sourceId,
	bandAssessment: {
		verdict: "in-band",
		captureCenterHz: c,
		windowHalfWidthHz: w,
	},
})

const disc = (frequencyHz = F, sourceIds = ["rtl"]) => ({
	frequencyHz,
	sourceIds,
})

describe("discovery coverage projection", () => {
	it("is unknown when decoder status is unavailable or no decoder reports placements", () => {
		expect(buildCoverageIndex(undefined)).toBeNull()
		expect(buildCoverageIndex("x")).toBeNull()
		expect(buildCoverageIndex([status("a", undefined)])).toBeNull()
		const d = { id: "d_1" } as unknown as Discovery
		expect(withCoverage(d, null)).toBe(d)
	})

	it("is verified none ([]) when placements exist but none covers", () => {
		const index = buildCoverageIndex([
			status("a", [{ channelHz: F + 100_000 }]),
		])
		expect(index?.coverageOf(disc())).toEqual([])
	})

	it("ignores a placement on a source the discovery was not seen on", () => {
		const index = buildCoverageIndex([
			status("a", [{ sourceId: "other", channelHz: F, running: true }]),
		])
		expect(index?.coverageOf(disc())).toEqual([])
	})

	it("channel edge: half the default 12 500 Hz width covers, +1 Hz does not", () => {
		const index = buildCoverageIndex([
			status("a", [{ channelHz: F, running: true }]),
		])
		expect(index?.coverageOf(disc(F + 6250))).toEqual([
			{ decoderId: "a", state: "running" },
		])
		expect(index?.coverageOf(disc(F - 6250))).toHaveLength(1)
		expect(index?.coverageOf(disc(F + 6251))).toEqual([])
	})

	it("uses a declared channel width", () => {
		const index = buildCoverageIndex(
			[status("a", [{ channelHz: F, running: true }])],
			{ channelWidthHz: () => 25_000 },
		)
		expect(index?.coverageOf(disc(F + 12_500))).toHaveLength(1)
		expect(index?.coverageOf(disc(F + 12_501))).toEqual([])
	})

	it("raw and centre reach use the source capture window", () => {
		const index = buildCoverageIndex([
			{ ...status("r", [{ reach: "raw" }]), ...band("rtl", F, 1000) },
			status("c", [{ reach: "centre", running: true }]),
		])
		expect(index?.coverageOf(disc(F + 1000))).toEqual([
			{ decoderId: "c", state: "running" },
			{ decoderId: "r", state: "stopped" },
		])
		expect(index?.coverageOf(disc(F + 1001))).toEqual([])
	})

	it("a placement missing its figures makes the result unknown for its source only", () => {
		const index = buildCoverageIndex([
			status("a", [{ channelHz: undefined }]),
			status("b", [{ sourceId: "two", channelHz: F, running: true }]),
			status("c", [{ sourceId: "three", reach: "raw" }]),
			status("d", [{ sourceId: "four", reach: "bogus" }]),
		])
		expect(index?.coverageOf(disc())).toBeUndefined()
		expect(index?.coverageOf(disc(F, ["two"]))).toEqual([
			{ decoderId: "b", state: "running" },
		])
		expect(index?.coverageOf(disc(F, ["three"]))).toBeUndefined()
		expect(index?.coverageOf(disc(F, ["four"]))).toBeUndefined()
		expect(index?.coverageOf(disc(Number.NaN, ["two"]))).toBeUndefined()
	})

	it("per decoder the best placement wins: running over suspended over stopped", () => {
		const index = buildCoverageIndex([
			status("a", [
				{ channelHz: F },
				{ channelHz: F, suspension: { reasonCode: "capture-too-narrow" } },
			]),
			status("b", [
				{ channelHz: F, suspension: { reasonCode: "frequency-out-of-band" } },
				{ channelHz: F, running: true },
			]),
		])
		expect(index?.coverageOf(disc())).toEqual([
			{ decoderId: "b", state: "running" },
			{
				decoderId: "a",
				state: "suspended",
				suspensionReason: "capture-too-narrow",
			},
		])
	})

	it("a non-boolean running is not running; an unknown reason passes through", () => {
		const index = buildCoverageIndex([
			status("a", [{ channelHz: F, running: "yes" }]),
			status("b", [
				{ channelHz: F, suspension: { reasonCode: "novel-reason" } },
			]),
			status("c", [{ channelHz: F, suspension: { reasonCode: 7 } }]),
		])
		expect(index?.coverageOf(disc())).toEqual([
			{ decoderId: "b", state: "suspended", suspensionReason: "novel-reason" },
			{ decoderId: "c", state: "suspended" },
			{ decoderId: "a", state: "stopped" },
		])
	})

	it("keeps 3 of 4 covering decoders (3 kept as is)", () => {
		const three = ["d1", "d2", "d3"].map(id => status(id, [{ channelHz: F }]))
		expect(buildCoverageIndex(three)?.coverageOf(disc())).toHaveLength(3)
		const four = [...three, status("d0", [{ channelHz: F, running: true }])]
		expect(buildCoverageIndex(four)?.coverageOf(disc())).toEqual([
			{ decoderId: "d0", state: "running" },
			{ decoderId: "d1", state: "stopped" },
			{ decoderId: "d2", state: "stopped" },
		])
	})

	it("skips a 65-char decoder id (logged once), keeps a 64-char one", () => {
		const skipped = vi.fn()
		const long = "x".repeat(65)
		const ok = "y".repeat(64)
		const index = buildCoverageIndex(
			[
				status(long, [{ channelHz: F, running: true }, { channelHz: F }]),
				status(long, [{ channelHz: F }]),
				status(ok, [{ channelHz: F }]),
				status("", [{ channelHz: F }]),
			],
			{ onSkippedDecoderId: skipped },
		)
		expect(index?.coverageOf(disc())).toEqual([
			{ decoderId: ok, state: "stopped" },
		])
		expect(skipped).toHaveBeenCalledTimes(2)
		expect(skipped).toHaveBeenCalledWith(long)
	})

	it("tolerates malformed statuses and placements", () => {
		const index = buildCoverageIndex([
			null,
			7,
			{
				id: 5,
				placements: [{ sourceId: "rtl", reach: "channel", channelHz: F }],
			},
			{ id: "a", placements: [null, "x", { sourceId: 3, reach: "channel" }] },
		])
		expect(index?.coverageOf(disc())).toEqual([])
	})

	it("withCoverage copies; [] and absent stay distinct", () => {
		const d = {
			id: "d_1",
			frequencyHz: F,
			sourceIds: ["rtl"],
		} as unknown as Discovery
		const none = withCoverage(d, buildCoverageIndex([status("a", [])]))
		expect(none).not.toBe(d)
		expect(none.coverage).toEqual([])
		expect("coverage" in d).toBe(false)
		const unknown = withCoverage(
			d,
			buildCoverageIndex([status("a", [{ channelHz: null }])]),
		)
		expect("coverage" in unknown).toBe(false)
	})

	it("property: bounded, ordered, and running only from a covering running placement", () => {
		// Feature: band-inspection-ux, Property 5: coverage bounded and honest
		// Validates: Requirements 1.4
		const placementArb = fc.record({
			sourceId: fc.constantFrom("rtl", "two"),
			channelHz: fc.option(fc.integer({ min: F - 20_000, max: F + 20_000 }), {
				nil: undefined,
			}),
			reach: fc.constantFrom("channel", "raw", "centre"),
			running: fc.boolean(),
			suspension: fc.option(
				fc.record({ reasonCode: fc.constantFrom("capture-too-narrow", "x") }),
				{ nil: undefined },
			),
		})
		const statusArb = fc.record({
			id: fc.string({ minLength: 0, maxLength: 70 }),
			placements: fc.array(placementArb, { maxLength: 4 }),
			sourceId: fc.constantFrom("rtl", "two"),
			bandAssessment: fc.option(
				fc.record({
					captureCenterHz: fc.integer({ min: F - 20_000, max: F + 20_000 }),
					windowHalfWidthHz: fc.integer({ min: 0, max: 20_000 }),
				}),
				{ nil: undefined },
			),
		})
		const rank = { running: 0, suspended: 1, stopped: 2 }
		fc.assert(
			fc.property(
				fc.array(statusArb, { maxLength: 8 }),
				fc.integer({ min: F - 30_000, max: F + 30_000 }),
				fc.subarray(["rtl", "two"]),
				(statuses, f, sourceIds) => {
					const index = buildCoverageIndex(statuses)
					const coverage = index?.coverageOf({ frequencyHz: f, sourceIds })
					if (coverage === undefined) return
					expect(coverage.length).toBeLessThanOrEqual(3)
					for (let i = 0; i < coverage.length; i++) {
						const c = coverage[i]!
						expect(c.decoderId.length).toBeGreaterThanOrEqual(1)
						expect(c.decoderId.length).toBeLessThanOrEqual(64)
						if (i > 0)
							expect(rank[coverage[i - 1]!.state]).toBeLessThanOrEqual(
								rank[c.state],
							)
						if (c.state !== "running") continue
						const covering = statuses.some(
							s =>
								s.id === c.decoderId &&
								s.placements.some(p => {
									if (!p.running || !sourceIds.includes(p.sourceId))
										return false
									if (p.reach === "channel")
										return (
											p.channelHz !== undefined &&
											Math.abs(f - p.channelHz) <= 6250
										)
									const w = statuses.find(
										o => o.sourceId === p.sourceId && o.bandAssessment,
									)?.bandAssessment
									return (
										w !== undefined &&
										Math.abs(f - w.captureCenterHz) <= w.windowHalfWidthHz
									)
								}),
						)
						expect(covering).toBe(true)
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
