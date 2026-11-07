import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	classOf,
	speechModulated,
	VOICE_MIN_BLOCKS,
	VOICE_SPREAD_MIN_DB,
	VOICE_SWING_MIN_DB,
} from "../../../../../src/core/scanner/classify/classifier.js"
import type { TrackSnapshot } from "../../../../../src/core/spectrum/types.js"

const flags: TrackSnapshot["flags"] = {
	truncated: false,
	overload: false,
	gap: false,
	edge: false,
	skirt: false,
	obwBiased: false,
	burst: false,
	iqImage: false,
	spur: false,
}

function track(over: Partial<TrackSnapshot> = {}): TrackSnapshot {
	return {
		trackId: "t",
		sourceId: "s",
		stream: 1,
		epoch: 1,
		startSample: 0,
		lastSample: 1,
		centreHz: 145_000_000,
		obwHz: 6000,
		obwMethod: "on-bins",
		peakDbfs: -40,
		meanDbfs: -45,
		snrDb: 14,
		floorDbfs: -60,
		thresholdDb: 4,
		blocks: VOICE_MIN_BLOCKS,
		maxBlockSnrDb: 18,
		dutyCycle: 1,
		spectralShape: "peaked",
		obw6Hz: 3000,
		binHz: 1000,
		flags,
		tuningTrust: "commanded",
		...over,
	}
}

const SPEECH = {
	blockSpreadDb: VOICE_SPREAD_MIN_DB,
	blockSwingDb: VOICE_SWING_MIN_DB,
}

describe("speechModulated", () => {
	it("needs each reading at its bound", () => {
		expect(speechModulated(track(SPEECH))).toBe(true)
		expect(
			speechModulated(track({ ...SPEECH, blocks: VOICE_MIN_BLOCKS - 1 })),
		).toBe(false)
		expect(
			speechModulated(
				track({ ...SPEECH, blockSpreadDb: VOICE_SPREAD_MIN_DB - 1e-9 }),
			),
		).toBe(false)
		expect(
			speechModulated(
				track({ ...SPEECH, blockSwingDb: VOICE_SWING_MIN_DB - 1e-9 }),
			),
		).toBe(false)
	})

	it("takes an absent or malformed reading as no speech", () => {
		expect(speechModulated(track())).toBe(false)
		expect(speechModulated(track({ blockSpreadDb: 1 }))).toBe(false)
		expect(speechModulated(track({ blockSwingDb: 1 }))).toBe(false)
		for (const bad of [Number.NaN, Infinity, -Infinity, "1" as never])
			expect(
				speechModulated(track({ ...SPEECH, blockSpreadDb: bad as number })),
			).toBe(false)
		expect(speechModulated(track({ ...SPEECH, blocks: Number.NaN }))).toBe(
			false,
		)
	})
})

describe("classOf with a speech reading", () => {
	it.each([
		{ obwHz: 6000, spectralShape: "peaked" as const, width: "gmsk-narrow" },
		{ obwHz: 5000, spectralShape: "flat" as const, width: "fsk4-6k25" },
		{ obwHz: 9000, spectralShape: "flat" as const, width: "fsk4-12k5" },
		{ obwHz: 12_000, spectralShape: "flat" as const, width: "fsk2-wide" },
	])(
		"a weak voice reading $width comes out analog-fm",
		({ obwHz, spectralShape, width }) => {
			expect(classOf(track({ obwHz, spectralShape }))).toBe(width)
			expect(classOf(track({ obwHz, spectralShape, ...SPEECH }))).toBe(
				"analog-fm",
			)
		},
	)

	it("keeps a carrier's line a carrier", () => {
		expect(
			classOf(
				track({
					...SPEECH,
					spectralShape: "narrow",
					obwHz: 3000,
					obw6Hz: 2000,
				}),
			),
		).toBe("carrier")
		// A peaked line of a carrier's widths, not narrow: a steady carrier, not voice.
		expect(
			classOf(
				track({
					...SPEECH,
					spectralShape: "peaked",
					obwHz: 4000,
					obw6Hz: 3000,
				}),
			),
		).toBe("carrier")
		// The ambiguous 3-bin flat reading: no steady line, and no voice either: width alone rules it out.
		expect(
			classOf(
				track({
					...SPEECH,
					spectralShape: "flat",
					obwHz: 3000,
					obw6Hz: 3000,
				}),
			),
		).toBe("fsk4-6k25")
	})

	it("gains no voice class at a carrier's width, at and past the 4-bin bound", () => {
		const peaked = { ...SPEECH, spectralShape: "peaked" as const, obw6Hz: 4000 }
		expect(classOf(track({ ...peaked, obwHz: 4000 }))).toBe("gmsk-narrow")
		expect(classOf(track({ ...peaked, obwHz: 5000 }))).toBe("analog-fm")
		// Bins, not Hz: 4 bins of 1 171.875 Hz.
		expect(classOf(track({ ...peaked, obwHz: 4687.5, binHz: 1171.875 }))).toBe(
			"gmsk-narrow",
		)
		expect(
			classOf(track({ ...peaked, obwHz: 5859.375, binHz: 1171.875 })),
		).toBe("analog-fm")
	})

	it("reads no voice on a malformed width", () => {
		for (const obwHz of [0, -1, Number.NaN])
			expect(classOf(track({ ...SPEECH, obwHz }))).not.toBe("analog-fm")
	})

	it("leaves TDMA, bursts and two-tone data to their own rules", () => {
		expect(classOf(track({ ...SPEECH, acf30: -0.7, acf60: 0.9 }))).toBe(
			"tdma-ms",
		)
		expect(classOf(track({ ...SPEECH, fsk2: true }))).toBe("fsk2-wide")
		expect(classOf(track({ ...SPEECH, blocks: 4 }))).toBe("ook-burst")
	})

	it("claims nothing past analog FM's width", () => {
		const justPast = {
			...SPEECH,
			obwHz: 18_001,
			spectralShape: "peaked" as const,
		}
		expect(classOf(track(justPast))).toBe("unknown")
		expect(
			classOf(
				track({ ...justPast, obwHz: 18_000, spectralShape: "flat" as const }),
			),
		).toBe("analog-fm")
	})

	// Feature: voice-class, Property 1: without both speech readings the width class is unchanged
	// Validates: Requirements 2.1 (safe answer on unknown input), 2.2 (digital and carriers keep their class)
	it("a track without a speech reading keeps its width class", () => {
		fc.assert(
			fc.property(
				fc.record({
					obwHz: fc.double({ min: 1, max: 40_000, noNaN: true }),
					obw6Hz: fc.double({ min: 1, max: 40_000, noNaN: true }),
					blocks: fc.integer({ min: 1, max: 2000 }),
					dutyCycle: fc.double({ min: 0, max: 1, noNaN: true }),
					spectralShape: fc.constantFrom(
						"flat" as const,
						"peaked" as const,
						"narrow" as const,
					),
				}),
				fc.double({
					min: 0,
					max: VOICE_SPREAD_MIN_DB,
					noNaN: true,
					maxExcluded: true,
				}),
				fc.double({ min: 0, max: 10, noNaN: true }),
				(fields, spread, swing) => {
					const bare = classOf(track(fields))
					expect(
						classOf(
							track({ ...fields, blockSpreadDb: spread, blockSwingDb: swing }),
						),
					).toBe(bare)
				},
			),
			{ numRuns: 200 },
		)
	})

	// Feature: voice-class, Property 2: a speech reading only ever moves a class to analog-fm
	// Validates: Requirements 2.1 (weak voice reaches analog-fm), 2.3 (a carrier gains no voice class)
	it("a speech reading moves a class to analog-fm or not at all", () => {
		fc.assert(
			fc.property(
				fc.record({
					obwHz: fc.double({ min: 1, max: 40_000, noNaN: true }),
					obw6Hz: fc.double({ min: 1, max: 40_000, noNaN: true }),
					blocks: fc.integer({ min: 1, max: 2000 }),
					dutyCycle: fc.double({ min: 0, max: 1, noNaN: true }),
					spectralShape: fc.constantFrom(
						"flat" as const,
						"peaked" as const,
						"narrow" as const,
					),
				}),
				fields => {
					const bare = classOf(track(fields))
					const read = classOf(track({ ...fields, ...SPEECH }))
					if (read !== bare) expect(read).toBe("analog-fm")
					if (bare === "carrier") expect(read).toBe("carrier")
				},
			),
			{ numRuns: 200 },
		)
	})
})
