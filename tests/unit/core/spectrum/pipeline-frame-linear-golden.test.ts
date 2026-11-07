import { beforeEach, describe, expect, it } from "vitest"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	analogFm,
	gaussianNoise,
	mulberry32,
	ookBursts,
	tone,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import {
	acfOf,
	projectionDigest,
	withDbFrame,
} from "./linear-golden-projection.js"
import { FS, Harness, yieldToRpc } from "./pipeline-harness.js"

/**
 * Linear-power Tracker.frame against the per-frame dB path it replaced, on what that change could
 * move (linear-golden-projection.ts states the fields and why). `projection` is the sha256 of
 * `project(events)`, recorded by running the helper on the dB-path code (base 64ebbe99, `git
 * archive` with this file's scenes); this tree gives the same digests. `acf` holds that code's
 * `acf30`/`acf60` values. The dB path rounded the 1 ms envelope through a Float32 dB value, so the
 * linear path moves them by the bound stated in `ACF_BOUND`. The scene `zero` has no noise at
 * all: its envelopes are flat to rounding, the ACF of that rounding is numeric noise on either
 * path, and only its count is compared. `withDbFrame` rebuilds the dB path in the test and must
 * reproduce both columns exactly; with a fault in its dB values the comparison must fail.
 */
const GOLDEN: Record<
	string,
	{ events: number; projection: string; acf: number[] }
> = {
	noise: {
		events: 33,
		projection:
			"05592e1b68041743b7607adc5196e176649e4df1d661150f275c1fb6be65ea4c",
		acf: [],
	},
	cw: {
		events: 37,
		projection:
			"f6e27072e88c3b4af40d5c64c1cb988bfd3084e2b7e3579c6b0162f33cefc89f",
		acf: [0.04057896916927682, -0.02756246331495417],
	},
	cwStrong: {
		events: 37,
		projection:
			"e95de1295b5b018f620ce34fa7761523ce0e9c3689fe967a798e246153eaada7",
		acf: [0.0323721015966609, 0.02886589603602508],
	},
	nfm: {
		events: 37,
		projection:
			"ce6937c28c169c85e0d3d307696fbc6591a5bb3de1f698dd46bf37b29197d8fd",
		acf: [0.02244488898011183, 0.0009855362102007415],
	},
	tdma: {
		events: 39,
		projection:
			"f5e2b2a4ce01a3a1164d81499b9c8ccfe15daf7c0ac503035f905c5d8d0e2bfb",
		acf: [
			-0.5232384454408819, 0.49629799371891264, -0.1152309844862664,
			0.12459217561651906,
		],
	},
	zero: {
		events: 105,
		projection:
			"1c8c97544af0b56c1c04298eaa4a7ef52213a2bf3c6b37e3aaf6799c8fa96a06",
		acf: [
			0, 0, 0.30960545444433824, 0.6068878904778973, 0.270996536895976,
			0.24194408468023712, 0, 0, 0.030841570888188438, -0.8160886582694195,
			0.8096098478833504, 0.7057799789158972, 0.8558016265002243,
			0.7538216129457235, 0.10323111054234195, 0.3875955315887675,
			-0.20147397013227264, -0.39959638042327084, 0, 0, 0.14533027228261816,
			-0.1545956224180125, -0.28371907484826797, -0.28571560197927237,
			-0.3874316790762542, 0.06307366471239158, 0, 0, -0.006563810540925498,
			-0.006764948759475526, 0.02695764237422511, -0.8221096634641085,
			-0.018636918356034433, -0.6071672359131569, 0, 0,
		],
	},
	nonFinite: {
		events: 41,
		projection:
			"723d465bab7d8501c08b5e4033413a69ac59621182e109f041a80d7a343bed01",
		acf: [0.036420584268504405, 0.013959193852030097],
	},
}
/** Noisy scenes move ACF by at most about 2e-6: 1.08e-6 here (50 dB SNR carrier); see docs/PERFORMANCE.md. */
const ACF_BOUND = 2e-6

const SIGMA = 0.005
const TOTAL = Math.round(1.6 * FS)
const ampFor = (snrDb: number): number =>
	Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))
const noise = (seed: number): Iq =>
	gaussianNoise(mulberry32(seed), TOTAL, SIGMA)

/** 30 ms on, 30 ms off: the signature the classifier's TDMA rule reads from acf30 and acf60. */
function tdma(seed: number, offsetHz: number, snrDb: number): Iq {
	const bursts: { startMs: number; durationMs: number }[] = []
	for (let ms = 100; ms < 1500; ms += 60)
		bursts.push({ startMs: ms, durationMs: 30 })
	return ookBursts(mulberry32(seed), TOTAL, FS, offsetHz, ampFor(snrDb), {
		bursts,
	})
}

const SCENES: Record<string, () => Iq> = {
	noise: () => noise(1),
	cw: () => addInto(noise(2), tone(TOTAL, FS, 40_000, ampFor(15))),
	cwStrong: () => addInto(noise(8), tone(TOTAL, FS, 40_000, ampFor(50))),
	nfm: () =>
		addInto(noise(3), analogFm(mulberry32(33), TOTAL, FS, -52_000, ampFor(20))),
	tdma: () => addInto(noise(4), tdma(44, 31_000, 25)),
	zero: () => addInto(zerosIq(TOTAL), tone(TOTAL, FS, 20_000, ampFor(30))),
	nonFinite: () => {
		const iq = addInto(noise(7), tone(TOTAL, FS, -30_000, ampFor(12)))
		for (const at of [0.31, 0.47]) iq.re[Math.round(at * FS)] = Number.NaN
		for (const at of [0.39, 0.61]) iq.im[Math.round(at * FS)] = Infinity
		iq.re[Math.round(0.66 * FS)] = -Infinity
		return iq
	},
}

function play(name: string): PipelineEvent[] {
	const scene = SCENES[name]
	if (!scene) throw new Error(`no scene ${name}`)
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: true })
	h.push(scene(), 8192)
	return h.events
}

/** A run is deterministic and takes seconds on a busy host, so each scene runs once per path. */
const runs = new Map<string, PipelineEvent[]>()
function run(name: string): PipelineEvent[] {
	const done = runs.get(name)
	if (done) return done
	const events = play(name)
	runs.set(name, events)
	return events
}

/** Where `events` departs from the recorded dB path; `acfBound` 0 asks for the exact values. */
function departures(
	name: string,
	events: PipelineEvent[],
	acfBound: number,
): string[] {
	const golden = GOLDEN[name]!
	const out: string[] = []
	if (events.length !== golden.events)
		out.push(`events ${events.length}, recorded ${golden.events}`)
	if (projectionDigest(events) !== golden.projection) out.push("projection")
	const acf = acfOf(events)
	if (acf.length !== golden.acf.length)
		out.push(`acf count ${acf.length}, recorded ${golden.acf.length}`)
	else if (name !== "zero" || acfBound === 0)
		acf.forEach((v, i) => {
			const d = Math.abs(v - golden.acf[i]!)
			if (!(d <= acfBound)) out.push(`acf[${i}] moved ${d}`)
		})
	return out
}

describe("linear Tracker.frame against the dB path's recorded event streams", () => {
	beforeEach(yieldToRpc)

	for (const name of Object.keys(SCENES)) {
		it(`scene ${name}`, () => {
			expect(departures(name, run(name), ACF_BOUND)).toEqual([])
		})

		it(`scene ${name}: the dB path rebuilt in the test gives the recorded stream exactly`, () => {
			expect(
				departures(
					name,
					withDbFrame(() => play(name)),
					0,
				),
			).toEqual([])
		})
	}

	it("a fault in the per-frame dB values fails the comparison", () => {
		// The dB path with its Float32 values rounded to 0.5 dB, as a coarser conversion would.
		const halfDb = (db: Float32Array): void => {
			for (let i = 0; i < db.length; i++) db[i] = Math.round(db[i]! * 2) / 2
		}
		for (const name of ["cw", "tdma"]) {
			const events = withDbFrame(() => play(name), halfDb)
			expect(departures(name, events, ACF_BOUND)).not.toEqual([])
		}
	})

	it("the scenes reach the TDMA rule and every noisy scene with a signal has an ACF", () => {
		for (const name of ["cw", "cwStrong", "nfm", "tdma", "nonFinite"])
			expect(acfOf(run(name)).length).toBeGreaterThan(0)
		const tdmaAcf = acfOf(run("tdma"))
		expect(tdmaAcf.some(v => v <= -0.5)).toBe(true)
		expect(tdmaAcf.some(v => v >= 0.45)).toBe(true)
	})
})
