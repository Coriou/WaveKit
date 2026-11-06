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
 * Linear-power short path: the pipeline's full event stream on seeded synthetic scenes must be
 * byte-identical to the dB-path pipeline. The hashes were recorded from the pre-change code
 * (base c838f93d, short path converting every frame to dB) before any edit in this change.
 */
const GOLDEN: Record<string, { events: number; sha256: string }> = {
	noise: {
		events: 17,
		sha256: "632320aaf46d233778cc1abcb76356d37fb98757e7add6f5ae5405fc2cac1588",
	},
	cw: {
		events: 19,
		sha256: "5524fae69b623461e62500b1d2b62b511a4abd84be2b8ea531d137052bec302c",
	},
	nfm: {
		events: 19,
		sha256: "1227ff20eb6f6db3aca5469bfe1b7ff0294e3da52f3a0624fdc3cb1c5e2fc4be",
	},
	modeS: {
		events: 20,
		sha256: "fd1337dd5af54df6ac326d732f6c44a473b47a2c4bad66ddae0a6049fef535b8",
	},
	bursts: {
		events: 28,
		sha256: "f26fe99938a569c927d0a6f5632c52ce4ce72aa04cbfb96b1e4d119fe5884eb6",
	},
	zero: {
		events: 17,
		sha256: "add58f2a3dc984677b42b768c989e549a25a5bfcd9910ec490e08e940da18096",
	},
	nonFinite: {
		events: 21,
		sha256: "da8a98f19fcacd48704b5b3a1ec6c3d06552d8acdb85c8e7e2e54c8c520c5be7",
	},
}

const SIGMA = 0.005
const TOTAL = Math.round(0.8 * FS)
/** Amplitude whose power is `snrDb` above the noise in 12.5 kHz. */
const ampFor = (snrDb: number): number =>
	Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / FS))

function noise(seed: number): Iq {
	return gaussianNoise(mulberry32(seed), TOTAL, SIGMA)
}

function ook(
	seed: number,
	offsetHz: number,
	snrDb: number,
	bursts: { startMs: number; durationMs: number }[],
): Iq {
	return ookBursts(mulberry32(seed), TOTAL, FS, offsetHz, ampFor(snrDb), {
		bursts,
	})
}

/** Mode-S-like: 120 µs and 64 µs pulses, strong, irregular spacing. */
function pulses(seed: number): Iq {
	const rng = mulberry32(seed)
	const sig = zerosIq(TOTAL)
	const amp = ampFor(30)
	let at = Math.round(0.05 * FS)
	while (at < TOTAL - FS / 100) {
		const len = Math.round((rng() < 0.5 ? 120e-6 : 64e-6) * FS)
		addInto(sig, tone(len, FS, 31_000, amp), at)
		at += Math.round((2 + rng() * 9) * 1e-3 * FS)
	}
	return sig
}

const SCENES: Record<string, () => Iq> = {
	noise: () => noise(1),
	cw: () => addInto(noise(2), tone(TOTAL, FS, 40_000, ampFor(15))),
	nfm: () =>
		addInto(noise(3), analogFm(mulberry32(33), TOTAL, FS, -52_000, ampFor(20))),
	modeS: () => addInto(noise(4), pulses(44)),
	bursts: () => {
		const iq = noise(5)
		// near the short-path threshold (k 8.5 dB) and well above it, across block edges
		for (const [i, snr] of [6, 7.5, 8.5, 9.5, 11, 14, 25].entries())
			addInto(
				iq,
				ook(50 + i, -90_000 + i * 25_000, snr, [
					{ startMs: 210 + i * 61, durationMs: 5 },
					{ startMs: 520 + i * 23, durationMs: 2 },
				]),
			)
		return iq
	},
	zero: () => {
		const iq = zerosIq(TOTAL)
		addInto(iq, ook(60, 20_000, 30, [{ startMs: 400, durationMs: 5 }]))
		return iq
	},
	nonFinite: () => {
		const iq = addInto(noise(7), tone(TOTAL, FS, -30_000, ampFor(12)))
		for (const at of [0.31, 0.47]) iq.re[Math.round(at * FS)] = Number.NaN
		for (const at of [0.39, 0.61]) iq.im[Math.round(at * FS)] = Infinity
		iq.re[Math.round(0.66 * FS)] = -Infinity
		return iq
	},
}

function run(name: string): PipelineEvent[] {
	const scene = SCENES[name]
	if (!scene) throw new Error(`no scene ${name}`)
	const h = new Harness({ format: "FLOAT32LE" })
	h.start({ feed: true })
	h.push(scene(), 8192)
	return h.events
}

const digest = (events: PipelineEvent[]): string =>
	createHash("sha256").update(JSON.stringify(events)).digest("hex")

describe("linear short path equals the dB short path (pre-change goldens)", () => {
	beforeEach(yieldToRpc)

	it("the scenes exercise short-path burst segments and frame-track envelopes", () => {
		const burstSegs = (events: PipelineEvent[]): number =>
			events.reduce(
				(n, e) =>
					e.kind === "block-summary"
						? n + e.summary.tracks.filter(s => s.flags.burst).length
						: n,
				0,
			)
		const tracks = (events: PipelineEvent[]): number =>
			events.filter(e => e.kind === "track-open").length
		expect(burstSegs(run("bursts"))).toBeGreaterThan(3)
		expect(burstSegs(run("modeS"))).toBeGreaterThan(0)
		expect(tracks(run("cw"))).toBeGreaterThan(0)
		expect(tracks(run("nfm"))).toBeGreaterThan(0)
	})

	for (const name of Object.keys(SCENES)) {
		it(`scene ${name}`, () => {
			const events = run(name)
			const got = { events: events.length, sha256: digest(events) }
			expect(got).toEqual(GOLDEN[name])
		})
	}
})
