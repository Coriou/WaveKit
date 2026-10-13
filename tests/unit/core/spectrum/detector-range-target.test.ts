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

interface Step {
	bin: number
	minutes: number
}

function trace(
	d: Detector,
	steps: readonly Step[],
	probes: readonly number[],
): number[] {
	const out: number[] = []
	for (const step of steps) {
		const on = new Uint8Array(N)
		if (step.bin >= 0 && step.bin < N) on[step.bin] = 1
		d.recordNoiseEdges(on, new Uint8Array(N), step.minutes, N)
		for (const probe of probes) out.push(d.kFor(probe))
	}
	return out
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
		const faArb = fc.double({ min: 0.05, max: 20, noNaN: true })
		const rangeArb = (key: string, startBin: number, endBin: number) =>
			fc
				.record({
					faTarget: fc.option(faArb, { nil: undefined }),
					burst: fc.boolean(),
				})
				.map(
					({ faTarget, burst }): CfarRange => ({
						startBin,
						endBin,
						key,
						burst,
						...(faTarget !== undefined ? { faTarget } : {}),
					}),
				)
		const stepArb: fc.Arbitrary<Step> = fc.record({
			bin: fc.integer({ min: 0, max: N - 1 }),
			minutes: fc.double({ min: 0.05, max: 8, noNaN: true }),
		})
		fc.assert(
			fc.property(
				faArb,
				rangeArb("a", 0, 128),
				rangeArb("b", 128, 256),
				fc.array(stepArb, { minLength: 1, maxLength: 8 }),
				(pipelineFa, a, b, steps) => {
					const subject = make(pipelineFa)
					arm(subject, [a, b])
					const probes = [10, 200]
					const got = trace(subject, steps, probes)
					for (const range of [a, b]) {
						const probe = range.key === "a" ? 10 : 200
						const targetsAbsent = make(range.faTarget ?? pipelineFa)
						arm(targetsAbsent, [withoutTarget(range)])
						const ref = trace(targetsAbsent, steps, [probe])
						const fromSubject = got.filter((_, i) =>
							range.key === "a" ? i % 2 === 0 : i % 2 === 1,
						)
						expect(fromSubject).toEqual(ref)
						expect(subject.stats().find(s => s.key === range.key)).toEqual(
							targetsAbsent.stats()[0],
						)
					}
					if (a.faTarget === undefined && b.faTarget === undefined) {
						const twin = make(pipelineFa)
						arm(twin, [withoutTarget(a), withoutTarget(b)])
						expect(trace(twin, steps, probes)).toEqual(got)
						expect(twin.stats()).toEqual(subject.stats())
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
