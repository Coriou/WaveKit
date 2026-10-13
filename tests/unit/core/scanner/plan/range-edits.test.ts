import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { applyRangePatch } from "../../../../../src/core/scanner/plan/range-edits.js"
import {
	RANGE_LOCKED_FIELDS,
	RANGE_LIVE_FIELDS,
} from "../../../../../src/core/scanner/plan/range-contract.js"
import type { ScanRangeLive } from "../../../../../src/core/scanner/plan/range-contract.js"
import type {
	PlanIssue,
	ScanRange,
	ScannerProtocol,
} from "../../../../../src/core/scanner/types.js"

const PROTOCOLS = [
	"analog-fm",
	"dmr",
	"p25p1",
	"aprs",
	"pocsag",
	"ism",
] as const satisfies readonly ScannerProtocol[]

const SENSITIVITY = ["low", "normal", "high"] as const

interface GenRange {
	startHz: number
	endHz: number
	rasters: { spacingHz: number; firstChannelHz: number }[] | null
	obwHz: number[] | null
	bandplanId: string | null
	enabled: boolean | null
	protocols: ScannerProtocol[] | null
	name: string | null
	dwellMs: number | null
	sensitivity: "low" | "normal" | "high" | null
}

const rasterArb = fc.record({
	spacingHz: fc.integer({ min: 1, max: 1_000_000 }),
	firstChannelHz: fc.integer({ min: 0, max: 2_000_000_000 }),
})

const genArb: fc.Arbitrary<GenRange> = fc.record({
	startHz: fc.integer({ min: 1, max: 1_000_000_000 }),
	endHz: fc.integer({ min: 1, max: 2_000_000_000 }),
	rasters: fc.oneof(fc.constant(null), fc.array(rasterArb, { maxLength: 3 })),
	obwHz: fc.oneof(
		fc.constant(null),
		fc.array(fc.integer({ min: 1, max: 500_000 }), { maxLength: 3 }),
	),
	bandplanId: fc.oneof(
		fc.constant(null),
		fc.string({ minLength: 1, maxLength: 8 }),
	),
	enabled: fc.oneof(fc.constant(null), fc.boolean()),
	protocols: fc.oneof(
		fc.constant(null),
		fc.array(fc.constantFrom(...PROTOCOLS), { maxLength: 3 }),
	),
	name: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 12 })),
	dwellMs: fc.oneof(fc.constant(null), fc.integer({ min: 10, max: 60_000 })),
	sensitivity: fc.oneof(fc.constant(null), fc.constantFrom(...SENSITIVITY)),
})

function toRange(g: GenRange): ScanRange {
	const range: ScanRange = { startHz: g.startHz, endHz: g.endHz }
	if (g.rasters !== null) range.rasters = g.rasters.map(r => ({ ...r }))
	if (g.obwHz !== null) range.obwHz = [...g.obwHz]
	if (g.bandplanId !== null) range.bandplanId = g.bandplanId
	if (g.enabled !== null) range.enabled = g.enabled
	if (g.protocols !== null) range.protocols = [...g.protocols]
	if (g.name !== null) range.name = g.name
	if (g.dwellMs !== null) range.dwellMs = g.dwellMs
	if (g.sensitivity !== null) range.sensitivity = g.sensitivity
	return range
}

function rastersEqual(
	a: ScanRange["rasters"],
	b: ScanRange["rasters"],
): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.length !== b.length) return false
	return a.every(
		(r, i) =>
			r.spacingHz === b[i]?.spacingHz &&
			r.firstChannelHz === b[i]?.firstChannelHz,
	)
}

function numbersEqual(
	a: number[] | undefined,
	b: number[] | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b
	return a.length === b.length && a.every((n, i) => n === b[i])
}

function differing(current: ScanRange, patch: ScanRange): string[] {
	const fields: string[] = []
	if (current.startHz !== patch.startHz) fields.push("startHz")
	if (current.endHz !== patch.endHz) fields.push("endHz")
	if (!rastersEqual(current.rasters, patch.rasters)) fields.push("rasters")
	if (!numbersEqual(current.obwHz, patch.obwHz)) fields.push("obwHz")
	if (current.bandplanId !== patch.bandplanId) fields.push("bandplanId")
	return fields
}

function liveOf(range: ScanRange): ScanRangeLive {
	const out: ScanRangeLive = {}
	if (range.enabled !== undefined) out.enabled = range.enabled
	if (range.protocols !== undefined) out.protocols = [...range.protocols]
	if (range.name !== undefined) out.name = range.name
	if (range.dwellMs !== undefined) out.dwellMs = range.dwellMs
	if (range.sensitivity !== undefined) out.sensitivity = range.sensitivity
	return out
}

function lockedPatch(current: ScanRange, live: GenRange): ScanRange {
	const range = toRange({
		...live,
		startHz: current.startHz,
		endHz: current.endHz,
	})
	if (current.rasters === undefined) delete range.rasters
	else range.rasters = current.rasters.map(r => ({ ...r }))
	if (current.obwHz === undefined) delete range.obwHz
	else range.obwHz = [...current.obwHz]
	if (current.bandplanId === undefined) delete range.bandplanId
	else range.bandplanId = current.bandplanId
	return range
}

const base = (startHz: number, endHz: number): ScanRange => ({ startHz, endHz })

describe("applyRangePatch", () => {
	it("rejects a length change and reports the count", () => {
		const current = [base(100, 200), base(300, 400)]
		const removed = applyRangePatch(current, [current[0]!])
		expect(removed).toEqual({
			rangeLive: [],
			issues: [
				{
					code: "range-locked",
					severity: "error",
					message: "a running job's ranges cannot be added or removed",
					details: { reason: "range-count", expected: 2, received: 1 },
				},
			],
		})
		const added = applyRangePatch(current, [...current, base(500, 600)])
		expect(added.issues[0]?.details).toEqual({
			reason: "range-count",
			expected: 2,
			received: 3,
		})
		expect(added.rangeLive).toEqual([])
	})

	it("treats an empty raster or obw list as different from an absent one", () => {
		const current = [base(100, 200)]
		const emptyRasters = applyRangePatch(current, [
			{ ...base(100, 200), rasters: [] },
		])
		expect(emptyRasters.issues).toEqual([
			{
				code: "range-locked",
				severity: "error",
				message:
					"range 0: rasters cannot change while the job exists; stop it to change edges or channel spacing",
				details: { index: 0, fields: ["rasters"] },
			},
		])
		expect(emptyRasters.rangeLive).toEqual([])
		const emptyObw = applyRangePatch(
			[{ ...base(100, 200), obwHz: [] }],
			[base(100, 200)],
		)
		expect(emptyObw.issues[0]?.details).toEqual({ index: 0, fields: ["obwHz"] })
	})

	it("compares rasters by spacing and first channel, in order", () => {
		const current = [
			{
				...base(100, 200),
				rasters: [
					{ spacingHz: 12_500, firstChannelHz: 100 },
					{ spacingHz: 25_000, firstChannelHz: 200 },
				],
			},
		]
		const swapped = applyRangePatch(current, [
			{
				...base(100, 200),
				rasters: [
					{ spacingHz: 25_000, firstChannelHz: 200 },
					{ spacingHz: 12_500, firstChannelHz: 100 },
				],
			},
		])
		expect(swapped.issues[0]?.details).toEqual({
			index: 0,
			fields: ["rasters"],
		})
		const same = applyRangePatch(current, [
			{
				...current[0]!,
				rasters: current[0]!.rasters!.map(
					r => ({ ...r, extra: true }) as never,
				),
				name: "kept",
			},
		])
		expect(same.issues).toEqual([])
		expect(same.rangeLive).toEqual([{ name: "kept" }])
	})

	it("names every locked field of an index, in contract order, and keeps the live snapshot only when clean", () => {
		const current = [
			{
				...base(100, 200),
				rasters: [{ spacingHz: 12_500, firstChannelHz: 100 }],
				obwHz: [9_000],
				bandplanId: "pmr",
				protocols: ["dmr" as const],
			},
			base(300, 400),
		]
		const patch = [
			{
				startHz: 101,
				endHz: 199,
				rasters: [{ spacingHz: 25_000, firstChannelHz: 100 }],
				obwHz: [12_500],
				bandplanId: "other",
				name: "ignored",
			},
			{ ...base(300, 400), enabled: false, protocols: ["aprs" as const] },
		]
		const edited = applyRangePatch(current, patch)
		expect(edited.rangeLive).toEqual([])
		expect(edited.issues.map(i => i.details)).toEqual([
			{
				index: 0,
				fields: ["startHz", "endHz", "rasters", "obwHz", "bandplanId"],
			},
		])
		expect(edited.issues[0]?.message).toBe(
			"range 0: startHz, endHz, rasters, obwHz, bandplanId cannot change while the job exists; stop it to change edges or channel spacing",
		)
		const clean = applyRangePatch(current, [
			{
				...current[0]!,
				protocols: ["pocsag"],
				dwellMs: 250,
				sensitivity: "high",
			},
			{ ...current[1]!, enabled: false },
		])
		expect(clean.issues).toEqual([])
		expect(clean.rangeLive).toEqual([
			{ protocols: ["pocsag"], dwellMs: 250, sensitivity: "high" },
			{ enabled: false },
		])
	})

	it("does not mutate either input and copies protocol arrays", () => {
		const protocols = ["dmr" as const]
		const current = [base(1, 2)]
		const patch = [{ ...base(1, 2), protocols }]
		const beforeCurrent = structuredClone(current)
		const beforePatch = structuredClone(patch)
		const edited = applyRangePatch(current, patch)
		edited.rangeLive[0]?.protocols?.push("aprs")
		expect(current).toEqual(beforeCurrent)
		expect(patch).toEqual(beforePatch)
		expect(protocols).toEqual(["dmr"])
	})

	// Feature: scanner-followups, Property 1: Locked fields
	// Validates: Requirements 1.2, 1.3, 1.4
	it("accepts a patch iff the length matches and every locked field deep-equals", () => {
		fc.assert(
			fc.property(
				fc.array(genArb, { maxLength: 4 }),
				fc.array(genArb, { maxLength: 4 }),
				fc.array(genArb, { maxLength: 4 }),
				(currentGen, patchGen, liveGen) => {
					const current = currentGen.map(toRange)
					const modes = [
						patchGen.map(toRange),
						current.map((range, i) =>
							lockedPatch(
								range,
								liveGen[i] ??
									liveGen[0] ??
									patchGen[0] ?? {
										startHz: 0,
										endHz: 0,
										rasters: null,
										obwHz: null,
										bandplanId: null,
										enabled: null,
										protocols: null,
										name: null,
										dwellMs: null,
										sensitivity: null,
									},
							),
						),
						current.slice(0, Math.max(0, current.length - 1)),
					]
					for (const patch of modes) {
						const beforeCurrent = structuredClone(current)
						const beforePatch = structuredClone(patch)
						const result = applyRangePatch(current, patch)
						expect(current).toEqual(beforeCurrent)
						expect(patch).toEqual(beforePatch)
						expectLocked(current, patch, result.issues, result.rangeLive)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

function expectLocked(
	current: ScanRange[],
	patch: ScanRange[],
	issues: PlanIssue[],
	rangeLive: ScanRangeLive[],
): void {
	expect(RANGE_LOCKED_FIELDS).toEqual([
		"startHz",
		"endHz",
		"rasters",
		"obwHz",
		"bandplanId",
	])
	expect(RANGE_LIVE_FIELDS).toEqual([
		"enabled",
		"protocols",
		"name",
		"dwellMs",
		"sensitivity",
	])
	if (patch.length !== current.length) {
		expect(issues).toEqual([
			{
				code: "range-locked",
				severity: "error",
				message: "a running job's ranges cannot be added or removed",
				details: {
					reason: "range-count",
					expected: current.length,
					received: patch.length,
				},
			},
		])
		expect(rangeLive).toEqual([])
		return
	}
	const expected = current.flatMap((range, index) => {
		const next = patch[index]
		if (next === undefined) return [{ index, fields: [...RANGE_LOCKED_FIELDS] }]
		const fields = differing(range, next)
		return fields.length > 0 ? [{ index, fields }] : []
	})
	expect(issues.map(issue => issue.details)).toEqual(expected)
	for (const issue of issues) {
		expect(issue.code).toBe("range-locked")
		expect(issue.severity).toBe("error")
		const fields = (issue.details?.["fields"] as string[] | undefined) ?? []
		expect(issue.message).toContain(fields.join(", "))
		expect(issue.message).toContain(
			"stop it to change edges or channel spacing",
		)
	}
	if (expected.length === 0) {
		expect(rangeLive).toEqual(patch.map(liveOf))
		expect(issues).toEqual([])
	} else {
		expect(rangeLive).toEqual([])
	}
}
