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
/** A second LO centre 100 kHz away: 100 bins, past the 18-bin separation a confirmation needs. */
const HOP_HZ = 100_000
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

	it("masks a 7-tooth comb once two LO centres confirm it, while a real 9 kHz emission between teeth is still detected", async () => {
		// Feature: signal-discovery-scanner, Property 24: Comb masking
		// Validates: spec § 4.9
		// The line window is injected at 3 s (default PROVISIONAL_WINDOW_MS = 30 s, covered by Task 7a's module
		// half). The comb is found at the first centre; it masks once the epoch of a second centre 100 kHz
		// away (≥ 18 bins) has closed with the teeth still at their baseband bins, within 0.1 s.
		const ms = (t: number): number => (t * FS) / 1000
		const firstEnd = ms(WINDOW_MS + 300)
		const secondEnd = firstEnd + ms(500)
		const total = secondEnd + ms(1500)
		const emitFrom = secondEnd + ms(500)
		const maskedBy = secondEnd + ms(100)
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 20, max: 26 }), // tooth spacing in bins (kHz)
				fc.double({ min: 0, max: 1, noNaN: true }), // comb position around DC
				fc.double({ min: -0.3, max: 0.3, noNaN: true }), // common sub-bin offset of the teeth
				// tooth per-bin SNR: receiver lines read under the gate's 6 dB pass level in a 12.5 kHz slot
				fc.double({ min: 8, max: 10, noNaN: true }),
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
					const step = ms(100)
					for (let at = 0; at < total; at += step) {
						if (at === firstEnd)
							h.pending({ epoch: 2, centreHz: CENTRE + HOP_HZ, staleMaxMs: 0 })
						if (at === secondEnd)
							h.pending({ epoch: 3, centreHz: CENTRE, staleMaxMs: 0 })
						const len = Math.min(step, total - at)
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
					// the bound itself: no tooth is tracked unflagged past the second centre's epoch (+ 0.1 s)
					const late = tracks.filter(
						t => onTooth(t) && !t.flags.spur && t.lastSample > maskedBy,
					)
					expect(late).toEqual([])
					const found = tracks.filter(
						t =>
							!t.flags.spur &&
							t.startSample >= emitFrom - BLOCK &&
							Math.abs(t.centreHz - (CENTRE + emissionHz)) <= 2 * BIN_HZ,
					)
					expect(found.length).toBeGreaterThan(0)
					// the two teeth beside the emission may read its bins in their 12.5 kHz slot: their
					// mask lifts while it is on air, the other five stay masked
					const masks = h.pipeline.artefactMasks()
					const combs = masks.spurs.filter(s => s.origin === "comb").length
					expect(combs).toBeGreaterThanOrEqual(5)
					expect(combs).toBeLessThanOrEqual(7)
					teethHz.forEach((hz, k) => {
						if (k !== gap && k !== gap + 1)
							expect(artefactOf(CENTRE + hz, masks.epoch, masks)).toBe("spur")
					})
					expect(artefactOf(CENTRE + emissionHz, masks.epoch, masks)).toBeNull()
				},
			),
			{ numRuns: 100, seed: 24 },
		)
	}, 180_000)

	it("never masks a comb seen from one centre only: a parked comb stays tracked", () => {
		const toothBins = [70, 95, 120 + 25, 170]
		const teethHz = toothBins.map(b => (b - N / 2) * BIN_HZ)
		const h = new Harness(
			{ format: "FLOAT32LE" },
			{ provisionalWindowMs: WINDOW_MS },
		)
		h.start()
		const n = ((WINDOW_MS + 1500) * FS) / 1000
		h.push(
			addInto(
				noiseAt(0, n),
				toneComb(
					n,
					FS,
					teethHz,
					teethHz.map(() => toneAmp(9)),
				),
			),
			16_384,
		)
		const masks = h.pipeline.artefactMasks()
		const last = lastSnapshots(h)
		expect(masks.spurs).toEqual([])
		for (const hz of teethHz)
			expect(
				last.some(
					t =>
						!t.flags.spur &&
						t.lastSample >= ((WINDOW_MS + 1000) * FS) / 1000 &&
						Math.abs(t.centreHz - (CENTRE + hz)) <= 2 * BIN_HZ,
				),
			).toBe(true)
	})

	it("starts unverified after a restart: persisted lines over carriers mask nothing until two centres re-confirm them", () => {
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
		const ms = (t: number): number => (t * FS) / 1000
		const teethHz = toothBins.map(b => (b - N / 2) * BIN_HZ)
		// a strong carrier on the first tooth (the restart case of a channel under a stale line), weak lines on the rest
		const amps = toothBins.map((_, i) => toneAmp(i === 0 ? 25 : 9))
		const h = new Harness({ format: "FLOAT32LE", persistedEngine })
		h.start()
		const near = (hz: number, from: number): TrackSnapshot[] =>
			h
				.tracks()
				.filter(
					t =>
						t.lastSample >= from &&
						Math.abs(t.centreHz - (CENTRE + hz)) <= 2 * BIN_HZ,
				)
		let at = 0
		const play = (len: number): void => {
			h.push(
				addInto(noiseAt(at, len), toneComb(len, FS, teethHz, amps, at)),
				16_384,
			)
			at += len
		}
		play(ms(1000))
		for (const hz of teethHz) expect(near(hz, 0).length).toBeGreaterThan(0)
		expect(h.pipeline.artefactMasks().spurs).toEqual([])
		h.pending({ epoch: 2, centreHz: CENTRE + HOP_HZ, staleMaxMs: 0 })
		play(ms(500))
		h.pending({ epoch: 3, centreHz: CENTRE, staleMaxMs: 0 })
		play(ms(1000))
		const from = at - ms(500)
		// the strong carrier is above the gate's pass level: never re-confirmed, still tracked
		expect(near(teethHz[0] ?? 0, from).some(t => !t.flags.spur)).toBe(true)
		for (const hz of teethHz.slice(1))
			expect(near(hz, from).filter(t => !t.flags.spur)).toEqual([])
		const masks = h.pipeline.artefactMasks()
		expect(
			artefactOf(CENTRE + (teethHz[0] ?? 0), masks.epoch, masks),
		).toBeNull()
		for (const hz of teethHz.slice(1))
			expect(artefactOf(CENTRE + hz, masks.epoch, masks)).toBe("spur")
	})

	it("suspends a verified mask on the bins of a confirmed signal and counts it", () => {
		const toothBins = [70, 95, 160, 185]
		const teethHz = toothBins.map(b => (b - N / 2) * BIN_HZ)
		const amps = toothBins.map(() => toneAmp(9))
		const ms = (t: number): number => (t * FS) / 1000
		const h = new Harness(
			{ format: "FLOAT32LE" },
			{ provisionalWindowMs: WINDOW_MS },
		)
		h.start()
		let at = 0
		const play = (len: number): void => {
			h.push(
				addInto(noiseAt(at, len), toneComb(len, FS, teethHz, amps, at)),
				16_384,
			)
			at += len
		}
		play(ms(WINDOW_MS + 300))
		h.pending({ epoch: 2, centreHz: CENTRE + HOP_HZ, staleMaxMs: 0 })
		play(ms(500))
		h.pending({ epoch: 3, centreHz: CENTRE, staleMaxMs: 0 })
		play(ms(500))
		const masked = h.pipeline.artefactMasks()
		for (const hz of teethHz)
			expect(artefactOf(CENTRE + hz, masked.epoch, masked)).toBe("spur")
		// the scanner confirmed the second tooth's frequency real (a voice, a decode, a proof)
		const real = CENTRE + (teethHz[1] ?? 0)
		h.send({
			kind: "masks",
			exclusions: [],
			cfarRanges: [],
			burstRanges: [],
			rasters: [],
			obwHz: [],
			inWindow: true,
			realRanges: [{ startHz: real - 2000, endHz: real + 2000 }],
		})
		const from = at
		play(ms(6000)) // past the 5 s stats interval
		// the tooth is tracked again on the real bins (a track keeps a spur flag it once got: Tracker's rule)
		const tracked = h
			.tracks()
			.filter(
				t =>
					t.lastSample > from + FS && Math.abs(t.centreHz - real) <= 2 * BIN_HZ,
			)
		expect(tracked.length).toBeGreaterThan(0)
		for (const hz of [teethHz[0], teethHz[2], teethHz[3]])
			expect(
				h
					.tracks()
					.filter(
						t =>
							t.lastSample > from + FS &&
							Math.abs(t.centreHz - (CENTRE + (hz ?? 0))) <= 2 * BIN_HZ,
					),
			).toEqual([])
		const after = h.pipeline.artefactMasks()
		expect(artefactOf(real, after.epoch, after)).toBeNull()
		expect(artefactOf(CENTRE + (teethHz[0] ?? 0), after.epoch, after)).toBe(
			"spur",
		)
		const stats = h.of("stats").at(-1)?.stats.spurMask
		expect(stats?.suspensions).toBe(1)
		expect(stats?.suspendedBlocks).toBeGreaterThan(0)
	})
})
