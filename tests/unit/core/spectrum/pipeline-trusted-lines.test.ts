import { describe, expect, it } from "vitest"
import {
	addInto,
	gaussianNoise,
	mulberry32,
	toneComb,
} from "../../../mocks/scanner/signals.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import { PipelineConfigSchema } from "../../../../src/core/spectrum/worker-protocol.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import type { EngineState } from "../../../../src/core/spectrum/types.js"
import { EngineStateSchema } from "../../../../src/core/spectrum/engine-state.js"
import { BIN_HZ, CENTRE, FS, Harness, N } from "./pipeline-harness.js"

/**
 * A parked receiver (one LO centre) restarting with its saved lines: a baseband spur (SpurMap)
 * and a provisional line, 9 dB per bin over the noise. Trusted (`persistedEngineTrusted`, set
 * only for a resumed strong-key namespace) they mask from the first blocks; untrusted (the
 * default) one centre cannot verify them and nothing masks.
 */
const SIGMA = 0.02
/** Tone-calibrated per-bin noise power at SIGMA (pipeline-artefacts.test.ts). */
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N
const SPUR_BIN = 183
const LINE_BIN = 60
const AMP = Math.sqrt(NOISE_BIN_POWER * 10 ** (9 / 10))
const KEY = `${FS}:m:496:${N}`
const hz = (bin: number): number => (bin - N / 2) * BIN_HZ

const SAVED: EngineState = {
	version: 1,
	absoluteFloors: [],
	kByRange: [],
	spurs: [
		{
			key: KEY,
			basebandBin: SPUR_BIN - 1,
			widthBins: 3,
			kind: "baseband",
			verified: true,
		},
	],
	provisionalSpurs: [
		{
			key: KEY,
			basebandBin: LINE_BIN,
			widthBins: 1,
			comb: false,
			verified: true,
		},
	],
}
/** The same lines in an older file's shape: no verified flag (unverified on load). */
const OLD_FILE: EngineState = {
	...SAVED,
	spurs: SAVED.spurs.map(({ verified: _v, ...sp }) => sp),
	provisionalSpurs: (SAVED.provisionalSpurs ?? []).map(
		({ verified: _v, ...l }) => l,
	),
}

function parked(trusted: boolean | undefined, saved: EngineState = SAVED) {
	const h = new Harness({
		format: "FLOAT32LE",
		integrationMs: 50,
		persistedEngine: saved,
		...(trusted === undefined ? {} : { persistedEngineTrusted: trusted }),
	})
	const rng = mulberry32(7)
	h.start({ centreHz: CENTRE, inWindow: false })
	const n = 2 * FS
	const iq = gaussianNoise(rng, n, SIGMA)
	addInto(
		iq,
		toneComb(n, FS, [hz(SPUR_BIN), hz(LINE_BIN)], [AMP, AMP], h.sample),
	)
	h.push(iq, 8192)
	return {
		exported: h.pipeline.exportEngineState(),
		origins: h.pipeline
			.artefactMasks()
			.spurs.map(s => s.origin)
			.sort(),
		// Each track on a line, as its last snapshot: blocks on and the spur flag.
		lineTracks: [
			...new Map(
				h
					.tracks()
					.filter(t =>
						[SPUR_BIN, LINE_BIN].some(
							b => Math.abs((t.centreHz - CENTRE) / BIN_HZ + N / 2 - b) < 2,
						),
					)
					.map(t => [t.trackId, { blocks: t.blocks, spur: t.flags.spur }]),
			).values(),
		],
	}
}

describe("a parked receiver's saved lines", () => {
	it("mask at once when the saved state is trusted", () => {
		const v = parked(true)
		expect(v.origins).toEqual(["baseband", "provisional"])
		// Only the first block, before the pipeline has a floor (nothing masks without one): one
		// block per line, flagged a spur.
		expect(v.lineTracks).toEqual([
			{ blocks: 1, spur: true },
			{ blocks: 1, spur: true },
		])
	}, 60_000)

	it.each([false, undefined])(
		"stay unverified from one centre when trusted is %s",
		trusted => {
			const v = parked(trusted)
			expect(v.origins).toEqual([])
			// Both lines are tracks for the whole 2 s visit (40 blocks), not spurs.
			expect(v.lineTracks).toEqual([
				{ blocks: 40, spur: false },
				{ blocks: 40, spur: false },
			])
		},
		60_000,
	)
})

describe("the per-line verified flag across a restart", () => {
	it("accepts an older file without the flag, and a trusted load of it masks nothing", () => {
		expect(EngineStateSchema.parse(OLD_FILE)).toEqual(OLD_FILE)
		const v = parked(true, OLD_FILE)
		expect(v.origins).toEqual([])
		expect(v.lineTracks).toEqual([
			{ blocks: 40, spur: false },
			{ blocks: 40, spur: false },
		])
	}, 60_000)

	it("round-trips a verified line: it saves verified, and the trusted restart masks it at once parked", () => {
		const first = parked(true)
		const saved = first.exported
		expect(EngineStateSchema.parse(saved)).toEqual(saved) // the saved file's shape
		expect(saved.spurs.filter(sp => sp.kind === "baseband")).toEqual([
			{ ...SAVED.spurs[0]!, verified: true },
		])
		expect(saved.provisionalSpurs).toEqual(SAVED.provisionalSpurs)
		const next = parked(true, saved)
		expect(next.origins).toEqual(["baseband", "provisional"])
		expect(next.lineTracks).toEqual([
			{ blocks: 1, spur: true },
			{ blocks: 1, spur: true },
		])
	}, 60_000)

	it("a take-over (untrusted load) saved within 10 min, then a restart that loads trusted: the lines stay unverified", () => {
		// The take-over hands the lines over untrusted; the core saves before the restored lines
		// expire (10 min of wall time), so they persist, but without the flag.
		const takenOver = parked(false)
		const saved = takenOver.exported
		expect(EngineStateSchema.parse(saved)).toEqual(saved)
		expect(saved.spurs.some(sp => sp.kind === "baseband")).toBe(true)
		expect(saved.spurs.every(sp => sp.verified === undefined)).toBe(true)
		expect(
			(saved.provisionalSpurs ?? []).every(l => l.verified === undefined),
		).toBe(true)
		// The restart resumes the namespace under the strong key (trusted): nothing masks.
		const restarted = parked(true, saved)
		expect(restarted.origins).toEqual([])
		expect(restarted.lineTracks).toEqual([
			{ blocks: 40, spur: false },
			{ blocks: 40, spur: false },
		])
	}, 60_000)
})

describe("the trust flag in the pipeline config", () => {
	const settings = testSettings()
	const tuning = {
		fftSize: null,
		integrationMs: null,
		thresholdDb: null,
		sensitivity: null,
	}

	it("is set only with a persisted state and a true flag, and survives the worker's init schema", () => {
		const trusted = buildPipelineConfig(
			"s1",
			"U8_IQ",
			1_024_000,
			settings,
			tuning,
			SAVED,
			undefined,
			true,
		)
		expect(trusted.persistedEngineTrusted).toBe(true)
		expect(PipelineConfigSchema.parse(trusted).persistedEngineTrusted).toBe(
			true,
		)
		expect(
			buildPipelineConfig("s1", "U8_IQ", 1_024_000, settings, tuning, SAVED)
				.persistedEngineTrusted,
		).toBeUndefined()
		expect(
			buildPipelineConfig(
				"s1",
				"U8_IQ",
				1_024_000,
				settings,
				tuning,
				undefined,
				undefined,
				true,
			).persistedEngineTrusted,
		).toBeUndefined()
	})
})
