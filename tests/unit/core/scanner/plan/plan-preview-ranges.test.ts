import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	planForSpec,
	previewPlan,
	toJobSpec,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import type {
	PreviewContext,
	PreviewSourceView,
} from "../../../../../src/core/scanner/plan/plan-preview.js"
import { protocolsForFrequency } from "../../../../../src/core/scanner/plan/protocols.js"
import { isRangeEnabled } from "../../../../../src/core/scanner/plan/range-contract.js"
import type {
	Hop,
	Impact,
	ScanRange,
	ScannerProtocol,
} from "../../../../../src/core/scanner/types.js"
import { testSettings } from "../../../../mocks/scanner/engine-fakes.js"

const MHz = (n: number) => Math.round(n * 1e6)
const PROTOCOLS = [
	"analog-fm",
	"dmr",
	"p25p1",
	"aprs",
	"pocsag",
] as const satisfies readonly ScannerProtocol[]

function emptyImpact(): Impact {
	return {
		liveAudioClients: 0,
		digitalVoiceListeners: 0,
		runningDecoders: [],
		pinnedDecoders: [],
		scannerJobs: [],
		unrestorable: [],
	}
}

const PI: PreviewSourceView = {
	id: "pi",
	kind: "rtl_tcp",
	format: "U8_IQ",
	sampleRateHz: 2_048_000,
	centreHz: MHz(446.1),
	controllable: true,
	controlMode: "internal",
	role: "shared",
	link: "network",
}

function ctx(): PreviewContext {
	return {
		sources: [PI],
		channelizerAvailable: false,
		usableFraction: 0.8,
		settings: testSettings(),
		measured: {
			settleMs: { local: null, network: null },
			markerSupported: { pi: true },
			probeStartMs: 400,
		},
		impactFor: () => emptyImpact(),
		region: "EU",
		tunerRange: () => ({ startHz: 24_000_000, endHz: 1_766_000_000 }),
		bandplans: [],
	}
}

function slotRange(slot: number, protocols?: ScannerProtocol[]): ScanRange {
	const startHz = MHz(430) + slot * 250_000
	const range: ScanRange = {
		startHz,
		endHz: startHz + 100_000,
		rasters: [{ spacingHz: 12_500, firstChannelHz: startHz + 12_500 }],
		obwHz: [9_000],
	}
	if (protocols !== undefined) range.protocols = protocols
	return range
}

const inside: ScanRange = {
	startHz: MHz(446.05),
	endHz: MHz(446.15),
	rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(446.05625) }],
	obwHz: [9_000],
}
const outside: ScanRange = {
	startHz: MHz(400),
	endHz: MHz(400.2),
	rasters: [{ spacingHz: 12_500, firstChannelHz: MHz(400.00625) }],
	obwHz: [9_000],
}

function geometry(hops: Hop[]) {
	return hops.map(h => ({
		index: h.index,
		centreHz: h.centreHz,
		covered: h.covered,
		channelCount: h.channelCount,
	}))
}

function periodOf(
	hops: readonly Hop[],
	dwellMs: number,
	share: number,
): number {
	const count = hops.length
	const every = share > 0 ? Math.max(1, Math.round(1 / share)) : Infinity
	const revisits = Number.isFinite(every) ? Math.floor(count / every) : 0
	if (count === 0) return 0
	const sum = hops.reduce((total, hop) => total + (hop.dwellMs ?? dwellMs), 0)
	return sum + revisits * (sum / count)
}

describe("range fields in the plan", () => {
	it("keeps a disabled range out of the window fit, coverage and protocol union", () => {
		const disabledOutside = { ...outside, enabled: false as const }
		const auto = previewPlan({ ranges: [inside, disabledOutside] }, ctx())
		const removed = previewPlan({ ranges: [inside] }, ctx())
		expect(auto.spec.mode).toBe("in-window")
		expect(auto.plan.hops.map(h => h.centreHz)).toEqual(
			removed.plan.hops.map(h => h.centreHz),
		)
		expect(auto.issues.map(i => i.code)).not.toContain("not-in-window")
		expect(previewPlan({ ranges: [inside, outside] }, ctx()).spec.mode).toBe(
			"sweep",
		)

		const pinned = previewPlan(
			{ mode: "in-window", ranges: [inside, disabledOutside] },
			ctx(),
		)
		expect(pinned.issues.map(i => i.code)).not.toContain("not-in-window")
		expect(
			previewPlan(
				{ mode: "in-window", ranges: [inside, outside] },
				ctx(),
			).issues.map(i => i.code),
		).toContain("not-in-window")

		const excluded = previewPlan(
			{
				mode: "sweep",
				ranges: [
					{ ...inside, enabled: false },
					{
						...outside,
						protocols: ["dmr"],
					},
				],
				exclusions: [{ startHz: outside.startHz, endHz: outside.endHz }],
			},
			ctx(),
		)
		expect(excluded.issues.map(i => i.code)).toContain("all-excluded")
	})

	it("rejects every range disabled, a short per-range dwell, and a monitor signals-only job", () => {
		const disabled = previewPlan(
			{
				mode: "sweep",
				ranges: [
					{ ...inside, enabled: false },
					{ ...outside, enabled: false },
				],
			},
			ctx(),
		)
		expect(disabled.issues).toContainEqual({
			code: "range-empty",
			severity: "error",
			message: "every range is disabled",
			details: { disabled: 2 },
		})

		const short = previewPlan(
			{
				mode: "sweep",
				ranges: [
					{ ...inside, enabled: false, dwellMs: 10 },
					{ ...outside, dwellMs: 10 },
				],
				dwellMs: 500,
				settleMs: 0,
				integrationMs: 20,
			},
			ctx(),
		)
		const tooShort = short.issues.filter(i => i.code === "dwell-too-short")
		expect(tooShort).toHaveLength(1)
		expect(tooShort[0]?.details).toMatchObject({ rangeIndex: 1 })
		expect(tooShort[0]?.details?.["minimumMs"]).toBeGreaterThan(10)

		const monitor = previewPlan(
			{ kind: "monitor", signalsOnly: true, ranges: [inside] },
			ctx(),
		)
		expect(monitor.issues).toContainEqual({
			code: "signals-only-unsupported",
			severity: "error",
			message: "monitor jobs need decoders",
		})
		expect(monitor.spec.signalsOnly).toBe(true)
		expect(monitor.spec.provenance["signalsOnly"]).toBe("operator")
		const off = previewPlan(
			{ kind: "monitor", signalsOnly: false, ranges: [inside] },
			ctx(),
		)
		expect(off.issues.map(i => i.code)).not.toContain(
			"signals-only-unsupported",
		)
		expect(off.spec.signalsOnly).toBe(false)
	})

	it("copies live fields, drops enabled true, and overlays rangeLive as a full snapshot", () => {
		const kept = previewPlan(
			{
				ranges: [{ ...inside, enabled: true, name: "air", sensitivity: "low" }],
			},
			ctx(),
		)
		expect(kept.spec.ranges[0]).toMatchObject({
			name: "air",
			sensitivity: "low",
		})
		expect(kept.spec.ranges[0]?.enabled).toBeUndefined()
		expect(kept.spec.provenance["ranges[0].name"]).toBe("operator")
		expect(kept.spec.provenance["ranges[0].sensitivity"]).toBe("operator")
		expect(kept.spec.provenance["ranges[0].dwellMs"]).toBeUndefined()
		expect(kept.spec.signalsOnly).toBeUndefined()
		expect(kept.spec.provenance["signalsOnly"]).toBeUndefined()

		const overlaid = previewPlan(
			{
				ranges: [
					{
						...inside,
						name: "old",
						protocols: ["dmr"],
						dwellMs: 400,
						sensitivity: "low",
					},
					{ ...outside, protocols: ["aprs"], name: "east" },
				],
				rangeLive: [
					{ enabled: false, name: "new" },
					{ protocols: ["pocsag"], dwellMs: 800 },
				],
				signalsOnly: true,
			},
			ctx(),
		)
		expect(overlaid.spec.ranges[0]).toMatchObject({
			enabled: false,
			name: "new",
			startHz: inside.startHz,
		})
		expect(overlaid.spec.ranges[0]?.protocols).toBeUndefined()
		expect(overlaid.spec.ranges[0]?.dwellMs).toBeUndefined()
		expect(overlaid.spec.ranges[0]?.sensitivity).toBeUndefined()
		expect(overlaid.spec.ranges[1]).toMatchObject({
			protocols: ["pocsag"],
			dwellMs: 800,
		})
		expect(overlaid.spec.ranges[1]?.name).toBeUndefined()
		expect(overlaid.spec.provenance["ranges[0].name"]).toBe("operator")
		expect(overlaid.spec.provenance["ranges[1].dwellMs"]).toBe("operator")
		expect(overlaid.spec.provenance["ranges[1].name"]).toBeUndefined()
		expect(overlaid.spec.signalsOnly).toBe(true)

		const mismatch = previewPlan({ ranges: [inside], rangeLive: [] }, ctx())
		expect(mismatch.issues).toContainEqual({
			code: "range-locked",
			severity: "error",
			message: "a running job's ranges cannot be added or removed",
			details: { reason: "range-count", expected: 1, received: 0 },
		})

		const round = toJobSpec(overlaid.spec)
		expect(round.signalsOnly).toBe(true)
		expect(round.ranges?.[0]).toMatchObject({ enabled: false, name: "new" })
		expect(round.ranges?.[1]).toMatchObject({
			protocols: ["pocsag"],
			dwellMs: 800,
		})
	})

	it("ignores per-range dwell on an in-window plan", () => {
		const planned = planForSpec(
			previewPlan(
				{
					mode: "in-window",
					ranges: [{ ...inside, dwellMs: 5_000 }],
					dwellMs: 400,
				},
				ctx(),
			).spec,
			ctx(),
		)
		expect(planned.hops.every(h => h.dwellMs === undefined)).toBe(true)
	})

	// Feature: scanner-followups, Property 2: Disabled exclusion
	// Validates: Requirements 1.6, 2.2
	it("plans a spec with disabled ranges as if those ranges were removed", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 12 }), {
					minLength: 1,
					maxLength: 3,
				}),
				fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
				(slots, mask) => {
					const ranges = slots.map(slot => slotRange(slot))
					const withFlags = ranges.map((range, i) =>
						mask[i] === false ? { ...range, enabled: false as const } : range,
					)
					const preview = previewPlan(
						{ mode: "sweep", ranges: withFlags, dwellMs: 500, settleMs: 0 },
						ctx(),
					)
					if (withFlags.every(r => r.enabled === false)) {
						expect(preview.issues).toContainEqual({
							code: "range-empty",
							severity: "error",
							message: "every range is disabled",
							details: { disabled: withFlags.length },
						})
						return
					}
					const kept = previewPlan(
						{
							mode: "sweep",
							ranges: withFlags.filter(isRangeEnabled),
							dwellMs: 500,
							settleMs: 0,
						},
						ctx(),
					)
					expect(geometry(preview.plan.hops)).toEqual(geometry(kept.plan.hops))
					expect(preview.plan.hops).toEqual(kept.plan.hops)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-followups, Property 3: Neutral defaults
	// Validates: Requirements 2.3, 2.7, 8.1
	it("treats enabled true, a name, and a job-equal dwell as neutral, and empty rangeLive as a no-op when no live field is set", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 8 }), {
					minLength: 1,
					maxLength: 3,
				}),
				fc.integer({ min: 0, max: 2 }),
				fc.string({ minLength: 1, maxLength: 12 }),
				(slots, indexSeed, name) => {
					const ranges = slots.map(slot => slotRange(slot))
					const base = {
						mode: "sweep" as const,
						ranges,
						dwellMs: 400,
						settleMs: 0,
						integrationMs: 50,
						revisit: { share: 0.5 },
					}
					const original = previewPlan(base, ctx())
					const index = indexSeed % ranges.length
					const enabled = ranges.map((range, i) =>
						i === index ? { ...range, enabled: true as const } : range,
					)
					const named = ranges.map((range, i) =>
						i === index ? { ...range, name } : range,
					)
					const equalDwell = ranges.map((range, i) =>
						i === index ? { ...range, dwellMs: original.spec.dwellMs } : range,
					)
					const withEnabled = previewPlan({ ...base, ranges: enabled }, ctx())
					const withName = previewPlan({ ...base, ranges: named }, ctx())
					const withDwell = previewPlan({ ...base, ranges: equalDwell }, ctx())
					expect(withEnabled.plan.hops).toEqual(original.plan.hops)
					expect(withEnabled.sweepPeriodMs).toEqual(original.sweepPeriodMs)
					expect(withEnabled.spec.protocols).toEqual(original.spec.protocols)
					expect(withEnabled.issues).toEqual(original.issues)
					expect(withName.plan.hops).toEqual(original.plan.hops)
					expect(withName.sweepPeriodMs).toEqual(original.sweepPeriodMs)
					expect(withName.spec.protocols).toEqual(original.spec.protocols)
					expect(withName.issues).toEqual(original.issues)
					expect(geometry(withDwell.plan.hops)).toEqual(
						geometry(original.plan.hops),
					)
					expect(withDwell.sweepPeriodMs).toEqual(original.sweepPeriodMs)
					expect(withDwell.spec.protocols).toEqual(original.spec.protocols)
					expect(withDwell.issues).toEqual(original.issues)
					for (const hop of withDwell.plan.hops) {
						if (hop.dwellMs !== undefined)
							expect(hop.dwellMs).toBe(original.spec.dwellMs)
					}
					const absent = previewPlan(
						{ ...base, rangeLive: ranges.map(() => ({})) },
						ctx(),
					)
					expect(absent.plan).toEqual(original.plan)
					expect(absent.sweepPeriodMs).toEqual(original.sweepPeriodMs)
					expect(absent.spec.protocols).toEqual(original.spec.protocols)
					expect(absent.spec.ranges).toEqual(original.spec.ranges)
					expect(absent.issues).toEqual(original.issues)
					expect(absent.spec.provenance).toEqual(original.spec.provenance)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-followups, Property 4: Hop dwell
	// Validates: Requirements 2.3
	it("sets hop dwell to the max of overlapping enabled ranges and keeps today's sweep period without it", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						slot: fc.integer({ min: 0, max: 2 }),
						widthKhz: fc.integer({ min: 50, max: 2_500 }),
						dwellMs: fc.oneof(
							fc.constant(null),
							fc.integer({ min: 200, max: 2_000 }),
						),
						enabled: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 3 },
				),
				fc.double({ min: 0, max: 0.5, noNaN: true }),
				(parts, share) => {
					const ranges: ScanRange[] = parts.map(part => {
						const startHz = MHz(430) + part.slot * MHz(3)
						const range: ScanRange = {
							startHz,
							endHz: startHz + part.widthKhz * 1_000,
							rasters: [
								{ spacingHz: 25_000, firstChannelHz: startHz + 12_500 },
							],
							obwHz: [12_500],
						}
						if (part.dwellMs !== null) range.dwellMs = part.dwellMs
						if (!part.enabled) range.enabled = false
						return range
					})
					const preview = previewPlan(
						{
							mode: "sweep",
							ranges,
							dwellMs: 500,
							settleMs: 0,
							integrationMs: 20,
							revisit: { share },
						},
						ctx(),
					)
					const n = preview.spec
					for (const hop of preview.plan.hops) {
						const overlapping = n.ranges.filter(
							r =>
								isRangeEnabled(r) &&
								r.endHz >= hop.covered.startHz &&
								r.startHz <= hop.covered.endHz,
						)
						if (!overlapping.some(r => r.dwellMs !== undefined))
							expect(hop.dwellMs).toBeUndefined()
						else {
							expect(hop.dwellMs).toBe(
								Math.max(...overlapping.map(r => r.dwellMs ?? n.dwellMs)),
							)
						}
					}
					if (preview.sweepPeriodMs !== null) {
						expect(preview.sweepPeriodMs).toBeCloseTo(
							periodOf(preview.plan.hops, n.dwellMs, n.revisit.share),
							6,
						)
					}
					if (
						!n.ranges.some(r => isRangeEnabled(r) && r.dwellMs !== undefined)
					) {
						expect(preview.plan.hops.every(h => h.dwellMs === undefined)).toBe(
							true,
						)
						if (preview.sweepPeriodMs !== null) {
							const count = preview.plan.hops.length
							const every =
								n.revisit.share > 0
									? Math.max(1, Math.round(1 / n.revisit.share))
									: Infinity
							const revisits = Number.isFinite(every)
								? Math.floor(count / every)
								: 0
							expect(preview.sweepPeriodMs).toBe((count + revisits) * n.dwellMs)
						}
					}
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: scanner-followups, Property 5: Protocol precedence
	// Validates: Requirements 2.6
	it("lets an operator protocol list override enabled covering ranges", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 6 }), {
					minLength: 1,
					maxLength: 3,
				}),
				fc.array(fc.constantFrom(...PROTOCOLS), { maxLength: 3 }),
				fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
				fc.oneof(
					fc.constant(null),
					fc.array(fc.constantFrom(...PROTOCOLS), { maxLength: 3 }),
				),
				fc.integer({ min: 0, max: 6 }),
				(slots, rangeProtocols, mask, jobProtocols, at) => {
					const ranges = slots.map((slot, i) => {
						const range = slotRange(
							slot,
							rangeProtocols.length > 0 ? [...rangeProtocols] : ["dmr"],
						)
						if (mask[i] === false) range.enabled = false
						return range
					})
					const hz = (ranges[at % ranges.length]?.startHz ?? MHz(430)) + 1_000
					const spec =
						jobProtocols === null
							? { mode: "sweep" as const, ranges }
							: { mode: "sweep" as const, ranges, protocols: [...jobProtocols] }
					const n = previewPlan(spec, ctx()).spec
					const got = protocolsForFrequency(n, hz)
					if (jobProtocols !== null) {
						expect(n.provenance["protocols"]).toBe("operator")
						expect(got).toEqual([...jobProtocols])
						return
					}
					const union = [
						...new Set(
							ranges
								.filter(
									r => isRangeEnabled(r) && r.endHz >= hz && r.startHz <= hz,
								)
								.flatMap(r => r.protocols ?? []),
						),
					]
					expect(got).toEqual(union)
				},
			),
			{ numRuns: 100 },
		)
	})
})
