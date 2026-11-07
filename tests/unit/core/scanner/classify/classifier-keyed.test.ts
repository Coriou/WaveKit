import { describe, expect, it } from "vitest"
import { speechModulated } from "../../../../../src/core/scanner/classify/classifier.js"
import {
	KEYING_EDGE_RANGE,
	KEYING_EDGE_SHARE_MIN,
	KEYING_MIN_BLOCKS,
	KEYING_SCORE_MIN,
	KEYING_WINDOW_BLOCKS,
	keyingEdgeShare,
	keyingScore,
} from "../../../../../src/core/spectrum/emissions/tracker.js"
import { mulberry32 } from "../../../../mocks/scanner/signals.js"
import { yieldToRpc } from "../../spectrum/pipeline-harness.js"
import {
	keyedData,
	productionClass,
	runVisit,
	SIGNALS,
	speechFm,
} from "./classifier-signals.js"

/**
 * Data keyed against a bare carrier moves its power between bins as far and as often as speech,
 * and repeats where speech does not. Through the real pipeline; no sample comes from a real capture.
 */

const MODES = {
	dstar: keyedData([-1200, 1200], 4800, 0.5),
	nxdn48: keyedData([-800, -267, 267, 800], 2400, 3),
	dmr: keyedData([-1944, -648, 648, 1944], 4800, 3),
	"dstar-200ms": keyedData([-1200, 1200], 4800, 0.5, 200, 200),
	"dstar-75ms": keyedData([-1200, 1200], 4800, 0.5, 75, 75),
	"nxdn48-75ms": keyedData([-800, -267, 267, 800], 2400, 3, 75, 75),
	"nxdn48-200ms": keyedData([-800, -267, 267, 800], 2400, 3, 200, 200),
	"dmr-75ms": keyedData([-1944, -648, 648, 1944], 4800, 3, 75, 75),
	"dmr-200ms": keyedData([-1944, -648, 648, 1944], 4800, 3, 200, 200),
} as const

describe("data keyed against a carrier", () => {
	it.each(Object.entries(MODES))(
		"%s is not read as speech",
		async (_name, gen) => {
			for (const snrDb of [8, 20, 30]) {
				await yieldToRpc()
				const tracks = runVisit({ name: "keyed", gen }, snrDb, 4120, 3).filter(
					t => t.blocks >= 32,
				)
				expect(tracks.length).toBeGreaterThan(0)
				for (const t of tracks) expect(speechModulated(t)).toBe(false)
			}
		},
		60_000,
	)

	it("a keying period that leaves a block straddling each edge holds from 20 dB", () => {
		// 125/125 ms at 8 dB can fall under the edge bound on a snapshot: docs/SCANNER.md states it.
		const gen = keyedData([-1200, 1200], 4800, 0.5, 125, 125)
		for (const snrDb of [20, 30]) {
			const tracks = runVisit({ name: "keyed", gen }, snrDb, 4120, 3).filter(
				t => t.blocks >= 32,
			)
			expect(tracks.length).toBeGreaterThan(0)
			for (const t of tracks) expect(speechModulated(t)).toBe(false)
		}
	}, 60_000)

	it("keying crossed by a line beside its carrier is not read as speech", () => {
		// With the carrier itself on a line the bare phase is dropped and only the data phases are
		// left, which do not repeat cleanly: docs/SCANNER.md states that limit.
		for (const name of ["dstar", "nxdn48"] as const)
			for (const t of runVisit({ name, gen: MODES[name] }, 20, 4120, 4, 50, [
				[173, 3],
			]))
				if (t.blocks >= 40) expect(speechModulated(t)).toBe(false)
	}, 60_000)

	it("D-STAR and NXDN keyed 100/100 ms read their width on every settled snapshot", async () => {
		for (const name of ["dstar", "nxdn48"] as const) {
			await yieldToRpc()
			const tracks = runVisit({ name, gen: MODES[name] }, 20, 4120, 3).filter(
				t => t.blocks >= 20,
			)
			expect(tracks.length).toBeGreaterThan(0)
			for (const t of tracks) expect(productionClass(t)).not.toBe("analog-fm")
		}
	}, 60_000)
})

describe("speech stays speech beside the keying rule", () => {
	it.each(["voice", "voice-ctcss", "voice-narrow"])(
		"%s keeps its reading wherever it reaches one",
		async name => {
			const signal = SIGNALS.find(s => s.name === name)!
			for (const snrDb of [12, 20]) {
				await yieldToRpc()
				const late = runVisit(signal, snrDb, 4140 + snrDb, 10).filter(
					t => t.blocks >= 100,
				)
				expect(late.length).toBeGreaterThan(0)
				for (const t of late) {
					expect(t.blockSpreadDb).toBeDefined()
					expect(t.blockSwingDb).toBeDefined()
				}
			}
		},
		120_000,
	)
})

describe("speech with a steady cadence", () => {
	/** Every syllable the same length, gap and level: as regular as speech gets. */
	const rhythmic = (peakDeviationHz: number, rngValue = 0.75) => ({
		name: "rhythmic",
		gen: (_rng: () => number, n: number, amp: number) =>
			speechFm(() => rngValue, n, amp, { peakDeviationHz, ctcssHz: 88.5 }),
	})

	it.each([12, 20, 30])(
		"a ±2.5 kHz talker at %i dB stays analog-fm, its width narrow",
		snrDb => {
			const tracks = runVisit(rhythmic(2500), snrDb, 1, 4).filter(
				t => t.blocks >= 40,
			)
			expect(tracks.length).toBeGreaterThan(0)
			for (const t of tracks) {
				expect(t.blockSpreadDb).toBeDefined()
				expect(productionClass(t)).toBe("analog-fm")
			}
		},
		60_000,
	)

	it("at 8 dB it reads analog-fm once it has settled", () => {
		const tracks = runVisit(rhythmic(2500), 8, 1, 4)
		expect(productionClass(tracks.at(-1)!)).toBe("analog-fm")
	}, 60_000)
})

describe("keyingEdgeShare", () => {
	const ring = (values: readonly number[]) => Float32Array.from(values)

	it("is all of a square wave's movement and none of a slow ramp's", () => {
		const square = ring([0, 1, 1, 0, 0, 1, 1, 0])
		expect(keyingEdgeShare(square, 8, 0)).toBe(1)
		const ramp = ring([0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25])
		expect(keyingEdgeShare(ramp, 8, 0)).toBe(0)
	})

	it("counts a step at the edge bound and not one under it", () => {
		expect(KEYING_EDGE_RANGE).toBe(0.7)
		// Range 10, so the bound is a step of 7.
		expect(keyingEdgeShare(ring([0, 7, 10]), 3, 0)).toBeCloseTo(0.7, 6)
		expect(keyingEdgeShare(ring([0, 6.5, 10]), 3, 0)).toBe(0)
	})

	it("a block straddling one edge in three steps holds the veto; two straddles lift it", () => {
		// 75/75 ms against 50 ms blocks: high, straddle, low.
		const third = ring([1, 0.5, 0, 1, 0.5, 0, 1, 0.5, 0])
		expect(keyingEdgeShare(third, 9, 0)).toBeGreaterThanOrEqual(
			KEYING_EDGE_SHARE_MIN,
		)
		const both = ring([1, 0.5, 0, 0.5, 1, 0.5, 0, 0.5, 1])
		expect(keyingEdgeShare(both, 9, 0)).toBeLessThan(KEYING_EDGE_SHARE_MIN)
	})

	it("reads a full ring from its oldest value, and only the values it holds", () => {
		const r = ring([0.5, 0.5, 1, 0, 0.5, 0.5])
		// Oldest at 2: 1, 0, 0.5, 0.5, 0.5, 0.5. The first step is the edge, the wrap is not a step.
		expect(keyingEdgeShare(r, 6, 2)).toBeCloseTo(1 / 1.5, 6)
		const partial = ring([1, 0, 9, 9])
		expect(keyingEdgeShare(partial, 2, 3)).toBe(1)
	})

	it("reads a constant and malformed values as no keying", () => {
		expect(keyingEdgeShare(new Float32Array(8).fill(2), 8, 0)).toBe(0)
		expect(keyingEdgeShare(new Float32Array(8), 0, 0)).toBe(0)
		expect(keyingEdgeShare(ring([0, 1, Number.NaN, 0]), 4, 0)).toBe(0)
		expect(keyingEdgeShare(ring([0, Infinity, 0, 1]), 4, 0)).toBe(0)
	})
})

describe("keyingScore", () => {
	const square = (n: number, period: number, level = 1): Float32Array =>
		Float32Array.from({ length: n }, (_, i) =>
			i % period < period / 2 ? level : 0,
		)
	const noise = (n: number, seed: number): Float32Array => {
		const rng = mulberry32(seed)
		return Float32Array.from({ length: n }, () => rng())
	}

	it("reads a square wave at full score, once it holds the minimum", () => {
		const under = square(KEYING_MIN_BLOCKS - 1, 4)
		expect(keyingScore(under, under.length, 0)).toBe(0)
		const atMin = square(KEYING_MIN_BLOCKS, 4)
		expect(keyingScore(atMin, atMin.length, 0)).toBeGreaterThan(0.95)
	})

	it("needs the period to hold twice inside the window", () => {
		// A period over a quarter of the window is not read.
		const n = KEYING_MIN_BLOCKS
		const atBound = square(n, n >> 2)
		const past = square(n, (n >> 2) + 1)
		expect(keyingScore(atBound, n, 0)).toBeGreaterThanOrEqual(KEYING_SCORE_MIN)
		expect(keyingScore(past, n, 0)).toBeLessThan(KEYING_SCORE_MIN)
	})

	it("reads a full ring from its oldest value", () => {
		const n = KEYING_WINDOW_BLOCKS
		const ring = square(n, 8)
		for (const head of [0, 1, 17, n - 1])
			expect(keyingScore(ring, n, head)).toBeGreaterThanOrEqual(
				KEYING_SCORE_MIN,
			)
	})

	it("reads noise, a constant and malformed values as no keying", () => {
		const n = KEYING_WINDOW_BLOCKS
		for (let seed = 1; seed <= 200; seed++)
			expect(keyingScore(noise(n, seed), n, 0)).toBeLessThan(KEYING_SCORE_MIN)
		expect(keyingScore(new Float32Array(n).fill(3), n, 0)).toBe(0)
		const bad = square(n, 4)
		bad[9] = Number.NaN
		expect(keyingScore(bad, n, 0)).toBe(0)
		bad[9] = Number.POSITIVE_INFINITY
		expect(keyingScore(bad, n, 0)).toBe(0)
	})
})
