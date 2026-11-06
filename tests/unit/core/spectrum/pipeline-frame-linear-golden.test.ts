import { createHash } from "node:crypto"
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
import { FS, Harness, yieldToRpc } from "./pipeline-harness.js"

/**
 * Linear-power Tracker.frame against the per-frame dB path it replaced. The goldens were recorded
 * from the dB path (base 64ebbe99) before the change. Everything but `acf30`/`acf60` must stay
 * byte-identical. Those two read the 1 ms envelope, which the dB path rounded through a Float32 dB
 * value, so they move by the bound stated in `ACF_BOUND`. The scene `zero` has no noise at all: its
 * envelopes are flat to rounding, the ACF of that rounding is numeric noise on either path, and it
 * is compared only with the fields stripped.
 */
const GOLDEN: Record<
	string,
	{ events: number; sha256: string; acf: number[] }
> = {
	noise: {
		events: 33,
		sha256: "91e4aba9fa25d64b4961687c7abd773b40b01ca60c5345396c922101bdc49a78",
		acf: [],
	},
	cw: {
		events: 37,
		sha256: "c0b1b4bc01c0a972b41bbf0a04e899c2db1688c55532b1d0f0f54743ecab0f8e",
		acf: [0.04057896916927682, -0.02756246331495417],
	},
	cwStrong: {
		events: 37,
		sha256: "b393b606ecf622dd3463435678905bb6b79ee604e374ed0daaaef6a04d27a1ba",
		acf: [0.0323721015966609, 0.02886589603602508],
	},
	nfm: {
		events: 37,
		sha256: "b8589b34a42ec2ee8f94997648a27895e2a0d8fd1167e308833704bd6c437007",
		acf: [0.02244488898011183, 0.0009855362102007415],
	},
	tdma: {
		events: 39,
		sha256: "ce7c828bfada389084b2d375da7c5d6540127a784914d140879c29fbcef0f3a6",
		acf: [
			-0.5232384454408819, 0.49629799371891264, -0.1152309844862664,
			0.12459217561651906,
		],
	},
	zero: {
		events: 105,
		sha256: "feb1f2ea85a63b662708b81aff435f92210eab84f31f1caf6332381b1a5dcbb3",
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
		sha256: "b9b17613c03b265554167383bef212cc2588de0a0fe6d01a7675a7d99d818996",
		acf: [0.036420584268504405, 0.013959193852030097],
	},
}

/** Largest |Δacf| seen on the noisy scenes was 1.08e-6 (50 dB SNR carrier); see docs/PERFORMANCE.md. */
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

/** A run is deterministic and takes seconds on a busy host, so each scene runs once. */
const runs = new Map<string, PipelineEvent[]>()
function run(name: string): PipelineEvent[] {
	const done = runs.get(name)
	if (done) return done
	const scene = SCENES[name]
	if (!scene) throw new Error(`no scene ${name}`)
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: true })
	h.push(scene(), 8192)
	runs.set(name, h.events)
	return h.events
}

function acfOf(events: PipelineEvent[]): number[] {
	const out: number[] = []
	JSON.stringify(events, (key, value: unknown) => {
		if ((key === "acf30" || key === "acf60") && typeof value === "number")
			out.push(value)
		return value
	})
	return out
}

const digest = (events: PipelineEvent[]): string =>
	createHash("sha256")
		.update(
			JSON.stringify(events, (key, value: unknown) =>
				key === "acf30" || key === "acf60" ? undefined : value,
			),
		)
		.digest("hex")

describe("linear Tracker.frame against the dB path's recorded event streams", () => {
	beforeEach(yieldToRpc)

	for (const name of Object.keys(SCENES)) {
		it(`scene ${name}`, () => {
			const events = run(name)
			const golden = GOLDEN[name]!
			expect({ events: events.length, sha256: digest(events) }).toEqual({
				events: golden.events,
				sha256: golden.sha256,
			})
			const acf = acfOf(events)
			expect(acf.length).toBe(golden.acf.length)
			if (name === "zero") return
			acf.forEach((v, i) => {
				expect(Math.abs(v - golden.acf[i]!)).toBeLessThanOrEqual(ACF_BOUND)
			})
		})
	}

	it("the scenes reach the TDMA rule and every noisy scene with a signal has an ACF", () => {
		for (const name of ["cw", "cwStrong", "nfm", "tdma", "nonFinite"])
			expect(acfOf(run(name)).length).toBeGreaterThan(0)
		const tdmaAcf = acfOf(run("tdma"))
		expect(tdmaAcf.some(v => v <= -0.5)).toBe(true)
		expect(tdmaAcf.some(v => v >= 0.45)).toBe(true)
	})
})
