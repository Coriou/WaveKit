import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { artefactOf } from "../../../../src/core/spectrum/artefacts.js"
import type {
	EngineState,
	PipelineConfig,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	fsk4Burst,
	gaussianNoise,
	impulseTrain,
	mulberry32,
	toneComb,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"
import {
	BIN_HZ,
	BLOCK,
	CENTRE,
	FS,
	Harness,
	N,
	yieldToRpc,
} from "./pipeline-harness.js"

const KEY = `${FS}:m:496:${N}`
const SIGMA = 0.005
const NOISE_BIN_POWER = (SIGMA * SIGMA * 1.5) / N // tone-calibrated per-bin noise power (Task 3 note)
const POOL_SIZE = 1 << 20
/** P24: the injected provisional-line window (the pipeline default is 30 s). */
const WINDOW_MS = 3_000
const POOL = gaussianNoise(mulberry32(20261010), POOL_SIZE, SIGMA)

function noiseAt(offset: number, n: number): Iq {
	const out = zerosIq(n)
	for (let i = 0; i < n; i++) {
		const j = (offset + i) % POOL_SIZE
		out.re[i] = POOL.re[j] ?? 0
		out.im[i] = POOL.im[j] ?? 0
	}
	return out
}

/** Amplitude of a bin-centred tone (or one impulse tone) at `perBinSnrDb` over the per-bin noise. */
const toneAmp = (perBinSnrDb: number): number =>
	Math.sqrt(NOISE_BIN_POWER * 10 ** (perBinSnrDb / 10))

function run(iq: Iq, over: Partial<PipelineConfig> = {}): Harness {
	const h = new Harness({ format: "FLOAT32LE", ...over })
	h.start()
	h.push(iq, 16_384)
	return h
}

/** Mean effective block floor after the first 0.5 s. */
function meanFloor(h: Harness): number {
	const floors = h
		.of("block-summary")
		.filter(e => e.summary.endSample > FS / 2)
		.map(e => e.summary.floorDbfs)
	return floors.reduce((s, f) => s + f, 0) / floors.length
}

/** The last snapshot of every track. */
function lastSnapshots(h: Harness): TrackSnapshot[] {
	const last = new Map<string, TrackSnapshot>()
	for (const t of h.tracks()) last.set(t.trackId, t)
	return [...last.values()]
}

describe("SpectrumPipeline artefact rejection", () => {
	it("blanks periodic broadband impulses: no track, floor lift ≤ 0.5 dB, period reported", async () => {
		// Feature: signal-discovery-scanner, Property 23: Impulse blanking
		// Validates: spec § 4.9
		const n = 2 * FS
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: POOL_SIZE - 1 }),
				fc.integer({ min: 0, max: 25_599 }), // impulse phase in samples, not frame-aligned
				fc.double({ min: 20, max: 26, noNaN: true }),
				fc.double({ min: 0.9, max: 1, noNaN: true }),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				async (offset, phase, excessDb, fraction, seed) => {
					await yieldToRpc()
					const noise = noiseAt(offset, n)
					const clean = run(noise)
					const impulses = impulseTrain(mulberry32(seed), n, FS, {
						periodMs: 100,
						widthMs: 2,
						toneSpacingHz: BIN_HZ,
						occupiedFraction: fraction,
						toneAmp: toneAmp(excessDb),
						phaseMs: (phase * 1000) / FS,
					})
					const dirty = run(addInto(impulses, noise))
					expect(dirty.of("track-open")).toEqual([])
					expect(meanFloor(dirty) - meanFloor(clean)).toBeLessThanOrEqual(0.5)
					const masks = dirty.pipeline.artefactMasks()
					expect(masks.rfi.active).toBe(true)
					expect(Math.abs((masks.rfi.periodMs ?? 0) - 100)).toBeLessThanOrEqual(
						10,
					)
					expect(masks.rfi.blankedFrames).toBeGreaterThanOrEqual(19) // ≥ 1 whole frame per 2 ms impulse
					expect(artefactOf(CENTRE + 30_000, masks.epoch, masks)).toBe("rfi")
				},
			),
			{ numRuns: 100, seed: 23 },
		)
	}, 180_000)

	it("masks a 7-tooth comb within one line window of settled data (30 s by default) while a real 9 kHz emission between teeth is still detected", async () => {
		// Feature: signal-discovery-scanner, Property 24: Comb masking
		// Validates: spec § 4.9
		// The line window is injected at 3 s (default PROVISIONAL_WINDOW_MS = 30 s, covered by Task 7a's module
		// half): the same 0.1 s masking margin, at a tenth of the simulated time.
		const total = ((WINDOW_MS + 1500) * FS) / 1000
		const emitFrom = ((WINDOW_MS + 500) * FS) / 1000
		const maskedBy = ((WINDOW_MS + 100) * FS) / 1000
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 20, max: 26 }), // tooth spacing in bins (kHz)
				fc.double({ min: 0, max: 1, noNaN: true }), // comb position around DC
				fc.double({ min: -0.3, max: 0.3, noNaN: true }), // common sub-bin offset of the teeth
				fc.double({ min: 15, max: 26, noNaN: true }), // tooth per-bin SNR
				fc.constantFrom(0, 1, 4, 5), // the gap that holds the emission (DC sits in gap 2)
				fc.integer({ min: 0, max: POOL_SIZE - 1 }),
				fc.integer({ min: 1, max: 2 ** 31 - 1 }),
				async (d, pos, frac, snr, gap, offset, seed) => {
					await yieldToRpc()
					const u = 5 + Math.round(pos * (Math.min(d - 5, 100 - 3 * d) - 5))
					const toothBins = Array.from(
						{ length: 7 },
						(_, k) => N / 2 + (k - 3) * d + u,
					)
					const teethHz = toothBins.map(b => (b - N / 2 + frac) * BIN_HZ)
					const amps = teethHz.map(() => toneAmp(snr))
					const emissionHz = ((toothBins[gap] ?? 0) + d / 2 - N / 2) * BIN_HZ
					const emissionAmp = Math.sqrt((SIGMA * SIGMA * 12_500 * 100) / FS) // 20 dB in 12.5 kHz (Task 2 SNR convention)
					const emission = fsk4Burst(
						mulberry32(seed),
						total - emitFrom,
						FS,
						emissionHz,
						emissionAmp,
					)
					const h = new Harness(
						{ format: "FLOAT32LE" },
						{ provisionalWindowMs: WINDOW_MS },
					)
					h.start()
					for (let at = 0; at < total; at += FS / 2) {
						const len = Math.min(FS / 2, total - at)
						const iq = addInto(
							noiseAt(offset + at, len),
							toneComb(len, FS, teethHz, amps, at),
						)
						if (at + len > emitFrom) addInto(iq, emission, emitFrom - at)
						h.push(iq, 16_384)
					}
					const tracks = lastSnapshots(h)
					const onTooth = (t: TrackSnapshot): boolean =>
						teethHz.some(
							hz => Math.abs(t.centreHz - (CENTRE + hz)) <= 2 * BIN_HZ,
						)
					const teeth = tracks.filter(onTooth)
					expect(teeth.length).toBeGreaterThanOrEqual(7)
					expect(teeth.every(t => t.flags.spur)).toBe(true)
					// the bound itself: the first snapshot that carries `spur` ends no later than one line window (+ 0.1 s)
					for (const t of teeth) {
						const firstSpur = h
							.tracks()
							.find(s => s.trackId === t.trackId && s.flags.spur)
						expect(firstSpur?.lastSample ?? Infinity).toBeLessThanOrEqual(
							maskedBy,
						)
					}
					const found = tracks.filter(
						t =>
							!t.flags.spur &&
							t.startSample >= emitFrom - BLOCK &&
							Math.abs(t.centreHz - (CENTRE + emissionHz)) <= 2 * BIN_HZ,
					)
					expect(found.length).toBeGreaterThan(0)
					const masks = h.pipeline.artefactMasks()
					expect(masks.spurs.filter(s => s.origin === "comb")).toHaveLength(7)
					for (const hz of teethHz)
						expect(artefactOf(CENTRE + hz, masks.epoch, masks)).toBe("spur")
					expect(artefactOf(CENTRE + emissionHz, masks.epoch, masks)).toBeNull()
				},
			),
			{ numRuns: 100, seed: 24 },
		)
	}, 120_000)

	it("starts masked after a restart: persisted comb lines drop their segments from the first block", () => {
		const toothBins = [70, 95, 160, 185]
		const persistedEngine: EngineState = {
			version: 1,
			absoluteFloors: [],
			kByRange: [],
			spurs: toothBins.map(b => ({
				key: KEY,
				basebandBin: b - 1,
				widthBins: 3,
				kind: "baseband" as const,
			})),
			provisionalSpurs: toothBins.map(b => ({
				key: KEY,
				basebandBin: b,
				widthBins: 1,
				comb: true,
			})),
		}
		const n = 2 * FS
		const teethHz = toothBins.map(b => (b - N / 2) * BIN_HZ)
		const betweenHz = (120 - N / 2) * BIN_HZ
		const tones = [...teethHz, betweenHz]
		const h = run(
			addInto(
				noiseAt(0, n),
				toneComb(
					n,
					FS,
					tones,
					tones.map(() => toneAmp(25)),
				),
			),
			{ persistedEngine },
		)
		const near = (hz: number): TrackSnapshot[] =>
			h.tracks().filter(t => Math.abs(t.centreHz - (CENTRE + hz)) <= 2 * BIN_HZ)
		for (const hz of teethHz) expect(near(hz)).toEqual([])
		expect(near(betweenHz).length).toBeGreaterThan(0)
		const masks = h.pipeline.artefactMasks()
		expect(masks.spurs.map(s => s.origin)).toEqual([
			"comb",
			"comb",
			"comb",
			"comb",
		])
		for (const hz of teethHz)
			expect(artefactOf(CENTRE + hz, masks.epoch, masks)).toBe("spur")
	})
})
