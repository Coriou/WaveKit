import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	classifyAlarm,
	untrackedRetuneAlarm,
	vanishedFeatures,
} from "../../../../src/core/spectrum/retune-alarm.js"
import type {
	PersistentFeature,
	SegmentRange,
} from "../../../../src/core/spectrum/retune-alarm.js"

const C = 446_100_000
const TOL = 1000
const HALF_SPAN = 1_000_000
const seg = (hz: number, half = 500): SegmentRange => ({
	startHz: hz - half,
	endHz: hz + half,
	centreHz: hz,
})
const visible = (hz: number): boolean => Math.abs(hz - C) <= HALF_SPAN
const base = { centreHz: C, toleranceHz: TOL, visible }
const never = (): boolean => false
const always = (): boolean => true

/** 3-8 feature offsets, ≥ 10 kHz from the centre and from each other's positions and mirrors. */
const offsets = fc
	.uniqueArray(fc.integer({ min: 2, max: 90 }), { minLength: 3, maxLength: 8 })
	.chain(ks =>
		fc
			.array(fc.boolean(), { minLength: ks.length, maxLength: ks.length })
			.map(signs =>
				// Distinct magnitudes keep every mirror off every other feature.
				ks.map((k, i) => (signs[i] ? 1 : -1) * k * 10_000),
			),
	)
const feats = (os: number[]): PersistentFeature[] =>
	os.map(o => ({ rfHz: C + o, widthHz: 1000 }))

describe("classifyAlarm (WG10 req 2.9)", () => {
	// Feature: web-gaps-10, Property 8: Alarm classification
	// Validates: Requirements 2.9
	it("a mirrored scene is iq-byte-slip; a genuine shift is external-control with its Δ; signal-change never explains a moved or emptied scene", () => {
		fc.assert(
			fc.property(
				offsets,
				fc.integer({ min: 0, max: 8 }).map(k => k * 10_000 + 5_000),
				fc.boolean(),
				fc.boolean(),
				(os, shiftAbs, up, endedAll) => {
					const features = feats(os)
					// Mirror: every feature reappears at 2·centre − f.
					const mirrored = features.map(f => seg(2 * C - f.rfHz))
					const mAlarm = untrackedRetuneAlarm(features, mirrored, base)
					expect(mAlarm).not.toBeNull()
					expect(
						classifyAlarm({
							...base,
							features,
							segments: mirrored,
							deltaHz: mAlarm!.deltaHz,
							ended: endedAll ? always : never,
						}),
					).toBe("iq-byte-slip")

					// Genuine untracked retune: everything moves by one Δ, 5 kHz off the 10 kHz grid,
					// so no shifted feature lands on another feature or a mirror.
					const delta = up ? shiftAbs : -shiftAbs
					const shifted = features.map(f => seg(f.rfHz + delta))
					const sAlarm = untrackedRetuneAlarm(features, shifted, base)
					expect(sAlarm).not.toBeNull()
					expect(
						Math.abs((sAlarm!.deltaHz ?? NaN) - delta),
					).toBeLessThanOrEqual(TOL)
					expect(
						classifyAlarm({
							...base,
							features,
							segments: shifted,
							deltaHz: sAlarm!.deltaHz,
							ended: endedAll ? always : never,
						}),
					).toBe("external-control")

					// Everything vanished: never signal-change, even when every feature "ended".
					expect(
						classifyAlarm({
							...base,
							features,
							segments: [],
							deltaHz: null,
							ended: always,
						}),
					).toBe("external-control")
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: web-gaps-10, Property 8: Alarm classification
	// Validates: Requirements 2.9
	it("signal-change exactly when Δ is null, at least two features stay, and every vanished feature ended", () => {
		fc.assert(
			fc.property(
				offsets.filter(os => os.length >= 5),
				fc.integer({ min: 1, max: 2 }),
				fc.boolean(),
				fc.boolean(),
				(os, kept, allEnded, withDelta) => {
					const features = feats(os)
					const stay = features.slice(0, kept)
					const gone = features.slice(kept)
					const segments = stay.map(f => seg(f.rfHz))
					const alarm = untrackedRetuneAlarm(features, segments, base)
					expect(alarm).not.toBeNull()
					expect(vanishedFeatures(features, segments, base)).toEqual(gone)
					const endedSet = new Set(allEnded ? gone : gone.slice(1))
					const got = classifyAlarm({
						...base,
						features,
						segments,
						deltaHz: withDelta ? 12_500 : alarm!.deltaHz,
						ended: f => endedSet.has(f),
					})
					const expected =
						kept >= 2 && allEnded && !withDelta && alarm!.deltaHz === null
							? "signal-change"
							: "external-control"
					expect(got).toBe(expected)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("review WG10 R1 M2: survivors covered only by a wide new occupancy are no evidence (external-control); similar-width survivors are", () => {
		const features: PersistentFeature[] = [
			{ rfHz: C + 20_000, widthHz: 17_000 },
			{ rfHz: C + 45_000, widthHz: 17_000 },
			{ rfHz: C - 34_000, widthHz: 3000 },
			{ rfHz: C - 68_000, widthHz: 3000 },
			{ rfHz: C - 90_000, widthHz: 3000 },
		]
		const input = { ...base, features, deltaHz: null, ended: always }
		const cover = [{ startHz: C, endHz: C + 65_000, centreHz: C + 32_500 }]
		expect(classifyAlarm({ ...input, segments: cover })).toBe(
			"external-control",
		)
		const same = [seg(C + 20_000, 8500), seg(C + 45_200, 8500)]
		expect(classifyAlarm({ ...input, segments: same })).toBe("signal-change")
		// A survivor twice-plus too wide, or off its centre by more than width / 4, fails.
		const wide = [seg(C + 20_000, 8500), seg(C + 45_000, 18_500)]
		expect(classifyAlarm({ ...input, segments: wide })).toBe("external-control")
		const off = [seg(C + 20_000, 8500), seg(C + 49_500, 8500)]
		expect(classifyAlarm({ ...input, segments: off })).toBe("external-control")
	})

	it("features on the centre or with an invisible mirror never count toward a mirror", () => {
		const features: PersistentFeature[] = [
			{ rfHz: C, widthHz: 1000 },
			{ rfHz: C + 900_000, widthHz: 1000 },
			{ rfHz: C - 950_000, widthHz: 1000 },
		]
		// Only one usable mirror (900 kHz) is present: below MIN_SHIFT_MATCHES.
		const segments = [seg(C - 900_000)]
		const vis = (hz: number) => hz >= C - 960_000 && hz <= C + 920_000
		expect(
			classifyAlarm({
				features,
				segments,
				centreHz: C,
				toleranceHz: TOL,
				visible: vis,
				deltaHz: null,
				ended: never,
			}),
		).toBe("external-control")
	})
})
