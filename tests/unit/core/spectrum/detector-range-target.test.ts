import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	Detector,
	type CfarRange,
} from "../../../../src/core/spectrum/detector.js"
import {
	buildPipelineConfig,
	DEFAULT_TUNING,
	faTargetForSensitivity,
} from "../../../../src/core/spectrum/spectrum-engine.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const N = 256
const TABLE_K = 4

function make(faTargetPerMhzMin: number): Detector {
	return new Detector({
		fftSize: N,
		hysteresisDb: 3,
		faTargetPerMhzMin,
		pinnedK: null,
		rbwHz: 1000,
		integrationMs: 50,
	})
}

function arm(d: Detector, ranges: CfarRange[]): void {
	d.setMasks({ dcGuardBins: 0, edgeBins: 0, extra: null })
	d.setCfarRanges(ranges)
}

function withoutTarget(range: CfarRange): CfarRange {
	const { faTarget: _fa, ...rest } = range
	return rest
}

describe("faTargetForSensitivity", () => {
	it("keeps the settings target for normal and the fixed presets otherwise", () => {
		expect(faTargetForSensitivity("low", 0.7)).toBe(0.25)
		expect(faTargetForSensitivity("normal", 0.7)).toBe(0.7)
		expect(faTargetForSensitivity("high", 0.7)).toBe(2)
		const settings = testSettings(s => {
			s.detection.faTargetPerMhzMin = 0.7
			s.detection.sensitivity = "normal"
		})
		for (const sensitivity of ["low", "normal", "high"] as const) {
			const cfg = buildPipelineConfig("rtl", "U8_IQ", 2_048_000, settings, {
				...DEFAULT_TUNING,
				sensitivity,
			})
			expect(cfg.faTargetPerMhzMin).toBe(
				faTargetForSensitivity(sensitivity, 0.7),
			)
		}
		const fromSettings = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			2_048_000,
			testSettings(s => {
				s.detection.sensitivity = "low"
				s.detection.faTargetPerMhzMin = 0.7
			}),
			DEFAULT_TUNING,
		)
		expect(fromSettings.faTargetPerMhzMin).toBe(0.25)
	})
})

describe("per-range CFAR target", () => {
	const rangeA = (faTarget?: number): CfarRange => ({
		startBin: 0,
		endBin: 128,
		key: "a",
		burst: false,
		...(faTarget !== undefined ? { faTarget } : {}),
	})

	it("raises and lowers against the range target when set, and the pipeline target otherwise", () => {
		// mhz = 4, 128/256 of the window: 5 min exposes 10 MHz·min, 30 min exposes 60.
		const blips = (n: number): number[] =>
			Array.from({ length: n }, (_, i) => 10 + i * 2)
		const run = (d: Detector, edges: number[], minutes: number): void => {
			const on = new Uint8Array(N)
			for (const b of edges) on[b] = 1
			d.recordNoiseEdges(on, new Uint8Array(N), minutes, 4)
		}
		const script = (d: Detector): void => {
			run(d, blips(11), 4.9)
			run(d, [], 0.1) // 11 edges / 10 MHz·min → rate 1.1, raises for target 1 and 0.25
			for (let w = 0; w < 6; w++) {
				run(d, [20], 4.9)
				run(d, [], 0.1) // 1 edge / 10 → 0.1, not noisy; six of them are rate 0.1 over 30 min
			}
		}
		const pipeline = make(1)
		arm(pipeline, [rangeA()])
		script(pipeline)
		const ranged = make(1)
		arm(ranged, [rangeA(0.25)])
		script(ranged)
		const absentAtRangeTarget = make(0.25)
		arm(absentAtRangeTarget, [rangeA()])
		script(absentAtRangeTarget)
		expect(pipeline.kFor(10)).toBe(TABLE_K)
		expect(ranged.kFor(10)).toBe(TABLE_K + 0.5)
		expect(absentAtRangeTarget.kFor(10)).toBe(ranged.kFor(10))
		expect(absentAtRangeTarget.stats()).toEqual(ranged.stats())
		expect(pipeline.kFor(200)).toBe(TABLE_K)
	})

	it("adapts same-key ranges independently when their targets differ", () => {
		// Half the window at mhz 4 is 2 MHz. Five minutes expose 10 MHz·min.
		// Three edges → rate 0.3: above 0.25, below 2.
		const edges = [10, 12, 14]
		const run = (d: Detector, bins: number[], minutes: number): void => {
			const on = new Uint8Array(N)
			for (const b of bins) on[b] = 1
			d.recordNoiseEdges(on, new Uint8Array(N), minutes, 4)
		}
		const ranges = (low: number, high: number): CfarRange[] => [
			{ startBin: 0, endBin: 128, key: "same", burst: false, faTarget: low },
			{ startBin: 128, endBin: 256, key: "same", burst: false, faTarget: high },
		]
		const shared = make(1)
		arm(shared, ranges(0.25, 2))
		run(shared, edges, 2.5)
		run(shared, [], 2.5)
		expect(shared.kFor(10)).toBe(TABLE_K + 0.5)
		expect(shared.kFor(200)).toBe(TABLE_K)
		expect(shared.stats().map(s => s.key)).toEqual(["same", "same"])

		const alone = make(1)
		arm(alone, [ranges(0.25, 2)[0]!])
		run(alone, edges, 2.5)
		run(alone, [], 2.5)
		expect(alone.kFor(10)).toBe(shared.kFor(10))
	})

	it("exports only the live target's k when the target changes", () => {
		const edges = [10, 12, 14]
		const run = (d: Detector, minutes: number): void => {
			const on = new Uint8Array(N)
			for (const b of edges) on[b] = 1
			d.recordNoiseEdges(on, new Uint8Array(N), minutes, 4)
		}
		const withTarget = (faTarget: number): CfarRange => ({
			startBin: 0,
			endBin: 128,
			key: "same",
			burst: false,
			faTarget,
		})
		const d = make(1)
		arm(d, [withTarget(0.25)])
		run(d, 2.5)
		run(d, 2.5)
		expect(d.kFor(10)).toBe(TABLE_K + 0.5)
		arm(d, [withTarget(2)])
		expect(d.kFor(10)).toBe(TABLE_K)
		expect(d.stats().map(s => s.k)).toEqual([TABLE_K])
		arm(d, [withTarget(0.25)])
		expect(d.kFor(10)).toBe(TABLE_K + 0.5)
		expect(d.stats().map(s => ({ key: s.key, k: s.k }))).toEqual([
			{ key: "same", k: TABLE_K + 0.5 },
		])
		const restored = make(1)
		restored.importK(d.stats().map(s => ({ key: s.key, k: s.k })))
		arm(restored, [withTarget(0.25)])
		expect(restored.kFor(10)).toBe(TABLE_K + 0.5)
		expect(restored.stats().map(s => s.k)).toEqual([TABLE_K + 0.5])
	})

	it("restores a persisted k onto a range that sets its own target", () => {
		const d = make(1)
		d.importK([{ key: "same", k: 5 }])
		arm(d, [
			{ startBin: 0, endBin: 128, key: "same", burst: false, faTarget: 0.25 },
		])
		expect(d.kFor(10)).toBe(5)
		expect(d.stats()).toEqual([{ key: "same", k: 5, faPerMhzMin: 0 }])
	})

	it("does not adapt a burst range even when it sets a target", () => {
		const d = make(1)
		arm(d, [
			{ startBin: 0, endBin: 128, key: "b", burst: true, faTarget: 0.01 },
		])
		for (let c = 0; c < 20; c++) {
			const on = new Uint8Array(N)
			on[10 + (c % 40)] = 1
			d.recordNoiseEdges(on, new Uint8Array(N), 0.5, 4)
		}
		expect(d.kFor(10)).toBe(TABLE_K)
	})

	// Feature: scanner-followups, Property 7: Per-range target
	// Validates: Requirements 2.5
	it("matches a run whose pipeline target is the range target and whose ranges set none", () => {
		// Half a window at 4 MHz for 5 minutes exposes 10 MHz·min, so a handful of
		// edges crosses the generated target. A random trace at mhz = 256 never does.
		const faArb = fc.double({ min: 0.05, max: 2, noNaN: true })
		const rangeArb = (key: string, startBin: number, endBin: number) =>
			fc
				.record({
					faTarget: fc.option(faArb, { nil: undefined }),
					burst: fc.boolean(),
					noisy: fc.boolean(),
				})
				.map(({ faTarget, burst, noisy }) => ({
					range: {
						startBin,
						endBin,
						key,
						burst,
						...(faTarget !== undefined ? { faTarget } : {}),
					} satisfies CfarRange,
					noisy,
				}))
		const edgesFor = (startBin: number, count: number): number[] =>
			Array.from({ length: count }, (_, i) => startBin + 1 + i * 2)
		const window = (
			d: Detector,
			bins: number[],
			minutesEach: readonly number[],
		): void => {
			for (const minutes of minutesEach) {
				const on = new Uint8Array(N)
				for (const b of bins) on[b] = 1
				d.recordNoiseEdges(on, new Uint8Array(N), minutes, 4)
			}
		}
		fc.assert(
			fc.property(
				faArb,
				rangeArb("a", 0, 128),
				rangeArb("b", 128, 256),
				(pipelineFa, specA, specB) => {
					const specs = [specA, specB]
					const play = (d: Detector, which: 0 | 1 | "both"): number[] => {
						const chosen = which === "both" ? specs : [specs[which]!]
						const targetOf = (spec: (typeof specs)[number]): number =>
							spec.range.faTarget ?? pipelineFa
						const noisyBins = chosen.flatMap(spec =>
							spec.noisy
								? edgesFor(
										spec.range.startBin,
										Math.ceil(targetOf(spec) * 10) + 1,
									)
								: [],
						)
						window(d, noisyBins, [2.5, 2.5])
						const afterRaise = [d.kFor(10), d.kFor(200)]
						window(
							d,
							[],
							[2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5],
						)
						return [...afterRaise, d.kFor(10), d.kFor(200)]
					}
					const subject = make(pipelineFa)
					arm(subject, [specA.range, specB.range])
					const got = play(subject, "both")
					for (const [index, spec] of specs.entries()) {
						const targetsAbsent = make(spec.range.faTarget ?? pipelineFa)
						arm(targetsAbsent, [withoutTarget(spec.range)])
						const ref = play(targetsAbsent, index as 0 | 1)
						const fromSubject = [got[index]!, got[2 + index]!]
						const fromRef = [ref[index]!, ref[2 + index]!]
						expect(fromSubject).toEqual(fromRef)
						const raised = !spec.range.burst && spec.noisy
						expect(fromSubject[0]).toBe(raised ? TABLE_K + 0.5 : TABLE_K)
						// The quiet 30 minutes undo exactly one raise.
						expect(fromSubject[1]).toBe(TABLE_K)
						expect(subject.stats().find(s => s.key === spec.range.key)).toEqual(
							targetsAbsent.stats()[0],
						)
					}
					if (
						specA.range.faTarget === undefined &&
						specB.range.faTarget === undefined
					) {
						const twin = make(pipelineFa)
						arm(twin, [withoutTarget(specA.range), withoutTarget(specB.range)])
						expect(play(twin, "both")).toEqual(got)
						expect(twin.stats()).toEqual(subject.stats())
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
