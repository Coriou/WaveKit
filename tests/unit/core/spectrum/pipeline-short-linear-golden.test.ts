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
import { projectionDigest, shortInDb } from "./linear-golden-projection.js"
import { FS, Harness, yieldToRpc } from "./pipeline-harness.js"
import { FRAME_PATHS, WASM_LABEL } from "./frame-wasm-harness.js"
import type { FrameWasmModule } from "../../../../src/core/spectrum/frame-wasm.js"

/**
 * Linear-power short path against the dB short path, on what the change could move
 * (linear-golden-projection.ts states the fields and why). `projection` is the sha256 of
 * `project(events)`, recorded by running the helper on base 64ebbe99 (`git archive` with this
 * file's scenes); this tree gives the same digests. On the dB short path itself (base c838f93d,
 * before the linear change) `noise`, `bursts` and `zero` give these digests too; the other four
 * had one track-update fewer per track there, from tracker changes made between the two bases.
 * `shortInDb` sends every short-path decision through its dB comparison in the test, as
 * Detector.detect made it, and must give the same digests; with a 1 dB fault it must not.
 */
const GOLDEN: Record<string, { events: number; projection: string }> = {
	noise: {
		events: 17,
		projection:
			"994d6d9c69cc0d1a089b26ec2ed697bfdd123397f9acf00425f984d2219982ab",
	},
	cw: {
		events: 20,
		projection:
			"6c2265615a553f1e4b5a658a9df00f63c045842c4714d7eff9a378d108ad0c16",
	},
	nfm: {
		events: 20,
		projection:
			"183a5960de287173ac58c669422f7c79e8db82744b4f6b2cb11eb4973764408d",
	},
	modeS: {
		events: 21,
		projection:
			"4b7f6ba52d992e4b589c157d2b36bd847d56988471adfff526864225a3fab721",
	},
	bursts: {
		events: 28,
		projection:
			"0d9d0ff20b3d452b7cd09cbb2131affa973cbb87c282396017231e6b0cea290e",
	},
	zero: {
		events: 17,
		projection:
			"994d6d9c69cc0d1a089b26ec2ed697bfdd123397f9acf00425f984d2219982ab",
	},
	nonFinite: {
		events: 23,
		projection:
			"eae997ca0ec9c3630ca1dcd65dda40dea38c8ab9de86437787227d75afdfa871",
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

function run(
	name: string,
	setup?: (h: Harness) => void,
	frameWasm: FrameWasmModule | null = null,
): PipelineEvent[] {
	const scene = SCENES[name]
	if (!scene) throw new Error(`no scene ${name}`)
	const h = new Harness({ format: "FLOAT32LE" }, { frameWasm })
	if (frameWasm && h.pipeline.framePath.path !== "wasm")
		throw new Error(h.pipeline.framePath.reason)
	setup?.(h)
	h.start({ feed: true })
	h.push(scene(), 8192)
	return h.events
}

const summary = (events: PipelineEvent[]) => ({
	events: events.length,
	projection: projectionDigest(events),
})

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

	// The wasm frame kernel sends a sum inside its bracket to the same `shortOnInDb` (the import
	// `short_db`), so the dB variants below exercise the kernel's fallback as well.
	for (const fp of FRAME_PATHS) {
		const label = fp.path === "js" ? "" : ` (${WASM_LABEL})`
		describe.skipIf(fp.skip)(`frame path ${fp.path}`, () => {
			for (const name of Object.keys(SCENES)) {
				it(`scene ${name}${label}`, () => {
					expect(summary(run(name, undefined, fp.frameWasm))).toEqual(
						GOLDEN[name],
					)
				})

				it(`scene ${name}: every short-path decision taken in dB gives the same stream${label}`, () => {
					expect(summary(run(name, h => shortInDb(h), fp.frameWasm))).toEqual(
						GOLDEN[name],
					)
				})
			}

			it(`a 1 dB fault in the short path's dB comparison fails the comparison${label}`, () => {
				// The accumulator read 1 dB high before its dB comparison: near-threshold bursts flip.
				for (const name of ["modeS", "bursts"]) {
					const events = run(
						name,
						h =>
							shortInDb(
								h,
								exact => (d, i, a, was) => exact(d, i, a * 10 ** 0.1, was),
							),
						fp.frameWasm,
					)
					expect(summary(events)).not.toEqual(GOLDEN[name])
				}
			})
		})
	}

	it.skipIf(FRAME_PATHS[1]!.skip)(
		`the wasm kernel gives the JS stream itself, event for event (${WASM_LABEL})`,
		() => {
			for (const name of Object.keys(SCENES))
				expect(run(name, undefined, FRAME_PATHS[1]!.frameWasm)).toEqual(
					run(name),
				)
		},
	)
})
