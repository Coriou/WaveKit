import { beforeEach, describe, expect, it } from "vitest"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	analogFm,
	concatIq,
	counterRun,
	gaussianNoise,
	impulseTrain,
	mulberry32,
	ookBursts,
	packCu8,
	packS16,
	tone,
	zerosIq,
} from "../../../mocks/scanner/signals.js"
import type { Burst, Iq } from "../../../mocks/scanner/signals.js"
import { frameWasm, WASM_LABEL } from "./frame-wasm-harness.js"
import { lockstep } from "./frame-wasm-lockstep.js"
import type { LockstepOptions, LockstepResult } from "./frame-wasm-lockstep.js"
import { FS, yieldToRpc } from "./pipeline-harness.js"
import type { Harness } from "./pipeline-harness.js"

/**
 * The wasm frame kernel against the JS frame path, on realistic scenes. Every input goes to both
 * pipelines; after each one the event lists and the frame-path state (frame, block and short sums,
 * the short ring and window scalars, thresholds, burst counts and peaks, the blanker's sums,
 * reference, pending frames and timing, every open track's envelope) must be identical
 * (frame-wasm-lockstep.ts). Identical state means identical detections, tracks, duty, data-burst
 * flags and short-path verdicts at every threshold, not only on these scenes' margins.
 */

const SIGMA = 0.005
const ampFor = (snrDb: number, fs = FS): number =>
	Math.sqrt(10 ** (snrDb / 10) * SIGMA * SIGMA * (12_500 / fs))

function gate(iq: Iq, fs: number, bursts: Burst[]): Iq {
	const keep = new Uint8Array(iq.re.length)
	for (const b of bursts) {
		const a = Math.round((b.startMs * fs) / 1000)
		const e = Math.min(keep.length, a + Math.round((b.durationMs * fs) / 1000))
		keep.fill(1, a, e)
	}
	for (let i = 0; i < keep.length; i++)
		if (!keep[i]) {
			iq.re[i] = 0
			iq.im[i] = 0
		}
	return iq
}

/** Two carriers, a two-way voice QSO and a Morse ID: the band an operator listens to. */
function qso(total: number): Iq {
	const iq = gaussianNoise(mulberry32(11), total, SIGMA)
	addInto(iq, tone(total, FS, 40_000, ampFor(15)))
	addInto(iq, tone(total, FS, -75_000, ampFor(35)))
	addInto(
		iq,
		gate(analogFm(mulberry32(12), total, FS, -20_000, ampFor(25)), FS, [
			{ startMs: 100, durationMs: 400 },
			{ startMs: 1150, durationMs: 300 },
		]),
	)
	addInto(
		iq,
		gate(analogFm(mulberry32(13), total, FS, -20_000, ampFor(18)), FS, [
			{ startMs: 600, durationMs: 450 },
		]),
	)
	// "ID" in Morse at 20 wpm: dit 60 ms, dah 180 ms
	const id: Burst[] = []
	let at = 300
	for (const sym of "-.. .- .-.-.-") {
		if (sym === " ") {
			at += 120
			continue
		}
		const len = sym === "." ? 60 : 180
		id.push({ startMs: at, durationMs: len })
		at += len + 60
	}
	addInto(iq, gate(tone(total, FS, 60_000, ampFor(20)), FS, id))
	return iq
}

/** Mode-S-like 120 µs and 64 µs pulses at irregular spacing (the short golden's generator). */
function pulses(seed: number, total: number, fs: number, snrDb: number): Iq {
	const rng = mulberry32(seed)
	const sig = zerosIq(total)
	const amp = ampFor(snrDb, fs)
	let at = Math.round(0.05 * fs)
	while (at < total - fs / 100) {
		const len = Math.round((rng() < 0.5 ? 120e-6 : 64e-6) * fs)
		addInto(sig, tone(len, fs, 0.125 * fs, amp), at)
		at += Math.round((2 + rng() * 9) * 1e-3 * fs)
	}
	return sig
}

/** Bursts near the short path's threshold and well above it, across block edges. */
function bursts(total: number): Iq {
	const iq = gaussianNoise(mulberry32(5), total, SIGMA)
	for (const [i, snr] of [6, 7.5, 8.5, 9.5, 11, 14, 25].entries())
		addInto(
			iq,
			ookBursts(
				mulberry32(50 + i),
				total,
				FS,
				-90_000 + i * 25_000,
				ampFor(snr),
				{
					bursts: [
						{ startMs: 210 + i * 61, durationMs: 5 },
						{ startMs: 520 + i * 23, durationMs: 2 },
					],
				},
			),
		)
	return iq
}

function expectSame(
	drive: (h: Harness) => void,
	opts: LockstepOptions = {},
): LockstepResult {
	const r = lockstep(drive, opts)
	expect(r.diffs).toEqual([])
	expect(r.wasmAtEnd).toBe(true)
	expect(r.inputs).toBeGreaterThan(3)
	return r
}

const kinds = (events: PipelineEvent[], kind: PipelineEvent["kind"]): number =>
	events.filter(e => e.kind === kind).length

describe.skipIf(!frameWasm)(
	`frame path equivalence, JS against ${WASM_LABEL}`,
	() => {
		beforeEach(yieldToRpc)

		it("noise", () => {
			const r = expectSame(h => {
				h.start()
				h.push(gaussianNoise(mulberry32(1), Math.round(1.2 * FS), SIGMA))
			})
			expect(kinds(r.events, "block-summary")).toBeGreaterThan(20)
		})

		it("carriers, a QSO and an ID: tracks, duty and short-path verdicts", () => {
			const r = expectSame(h => {
				h.start()
				h.push(qso(Math.round(1.6 * FS)), 3000)
			})
			expect(kinds(r.events, "track-open")).toBeGreaterThanOrEqual(3)
			const duty = r.events.flatMap(e =>
				e.kind === "track-update" || e.kind === "track-close"
					? [e.track.dutyCycle]
					: [],
			)
			expect(duty.some(d => d !== undefined)).toBe(true)
		})

		it("bursts at the short-path threshold, U8 and FLOAT32", () => {
			for (const format of ["U8_IQ", "FLOAT32LE"] as const) {
				const r = expectSame(
					h => {
						h.start()
						h.push(bursts(Math.round(0.9 * FS)), 2048)
					},
					{ config: { format } },
				)
				expect(
					r.events.some(e => e.kind === "track-open" && e.track.flags.burst),
				).toBe(true)
			}
		})

		it("Mode S bursts at 2.4 Msps, FFT 2048", () => {
			const fs = 2_400_000
			const total = Math.round(0.6 * fs)
			const r = expectSame(
				h => {
					h.start()
					const iq = gaussianNoise(mulberry32(21), total, SIGMA)
					addInto(iq, pulses(22, total, fs, 30))
					h.push(iq, 65_536)
				},
				{ config: { sampleRateHz: fs, fftSize: 2048 }, stateEvery: 4 },
			)
			expect(kinds(r.events, "block-summary")).toBeGreaterThan(8)
		})

		it("zeros, non-finite samples and clipping", () => {
			expectSame(h => {
				h.start()
				const iq = zerosIq(Math.round(0.5 * FS))
				addInto(iq, tone(iq.re.length, FS, 20_000, ampFor(30)))
				h.push(iq)
			})
			const nonFinite = expectSame(
				h => {
					h.start()
					h.push(zerosIq(Math.round(0.4 * FS)))
					const iq = addInto(
						gaussianNoise(mulberry32(7), Math.round(0.6 * FS), SIGMA),
						tone(Math.round(0.6 * FS), FS, -30_000, ampFor(12)),
					)
					for (const at of [0.11, 0.27]) iq.re[Math.round(at * FS)] = Number.NaN
					for (const at of [0.19, 0.41]) iq.im[Math.round(at * FS)] = Infinity
					iq.re[Math.round(0.46 * FS)] = -Infinity
					h.push(iq)
				},
				{ config: { format: "FLOAT32LE" } },
			)
			// all-zero blocks floor at −200 dB, where the bracket is empty: every short sum after them is
			// decided in dB, by JS `shortOnInDb` on both paths; NaN and infinite frames are blanked
			expect(nonFinite.dbCalls).toBeGreaterThan(100)
			expect(nonFinite.blanked).toBeGreaterThan(0)
			const clipped = expectSame(h => {
				h.start()
				const iq = gaussianNoise(mulberry32(8), Math.round(0.8 * FS), SIGMA)
				addInto(iq, tone(iq.re.length, FS, 10_000, 1.4))
				h.push(iq)
			})
			expect(
				clipped.events.some(
					e => e.kind === "block-summary" && e.summary.overload,
				),
			).toBe(true)
		})

		it("S16 IQ and 50 % overlap", () => {
			expectSame(
				h => {
					h.start()
					const iq = qso(Math.round(0.8 * FS))
					h.pushBytes(packS16(iq.re, iq.im), 1500)
				},
				{ config: { format: "S16_IQ" } },
			)
			expectSame(
				h => {
					h.start()
					h.push(bursts(Math.round(0.8 * FS)), 4096)
				},
				{ config: { overlap: 0.5 } },
			)
		})

		it("broadband impulses: blanked on offer and among the first block's pending frames", () => {
			const r = expectSame(h => {
				h.start()
				const total = Math.round(1.2 * FS)
				const iq = gaussianNoise(mulberry32(31), total, SIGMA)
				addInto(
					iq,
					impulseTrain(mulberry32(32), total, FS, {
						periodMs: 37,
						widthMs: 0.6,
						toneSpacingHz: FS / 256,
						occupiedFraction: 0.9,
						toneAmp: 0.05,
						phaseMs: 3,
					}),
				)
				h.push(iq, 2500)
			})
			expect(r.blanked).toBeGreaterThan(10)
		})

		it("seams, gaps, a marker epoch with its counter run, a new stream and odd chunks", () => {
			expectSame(h => {
				h.start()
				const iq = qso(Math.round(0.5 * FS))
				const bytes = packCu8(iq.re, iq.im)
				h.pushBytes(bytes.subarray(0, 40_000), 777)
				h.gap(300) // short gap: a seam
				h.pushBytes(bytes.subarray(40_000, 90_000), 1)
				h.gap(Math.round(0.6 * FS)) // past the track hang: closes tracks
				h.pushBytes(bytes.subarray(90_000, 200_000), 5000)
				// a retune that expects the marker: frames wait until the counter run resolves it
				h.pending({ centreHz: 446_200_000, expectMarker: true })
				h.pushBytes(bytes.subarray(0, 30_000), 4096)
				h.pushBytes(counterRun(4096, 17), 4096)
				h.pushBytes(bytes.subarray(30_000, 180_000), 3333)
				// a skipped sample range (not a gap input): FrameSource sees a seam
				h.sample += 1234
				h.pushBytes(bytes.subarray(180_000), 4096)
				h.send({
					kind: "new-stream",
					stream: 2,
					centreHz: 446_300_000,
					sampleRateHz: FS,
					gainKey: "m:496",
					tuningTrust: "commanded",
				})
				h.sample = 0
				h.pushBytes(bytes, 2048)
			})
		})

		it("a timer epoch, a stale-check retune and a channel plan with a wide track", () => {
			expectSame(h => {
				h.start({ rasters: [] })
				const iq = qso(Math.round(0.6 * FS))
				h.push(iq, 4096)
				h.pending({ centreHz: 446_150_000, settleSamples: 3000 })
				h.push(qso(Math.round(0.6 * FS)), 4096)
			})
		})

		it("a carrier on a learned spur line with a voice across it (line join)", () => {
			const r = expectSame(
				h => {
					h.start()
					const total = Math.round(2.4 * FS)
					const iq = gaussianNoise(mulberry32(41), total, SIGMA)
					addInto(iq, tone(total, FS, 30_000, ampFor(22)))
					addInto(
						iq,
						gate(analogFm(mulberry32(42), total, FS, 30_000, ampFor(24)), FS, [
							{ startMs: 1500, durationMs: 700 },
						]),
					)
					h.push(iq, 4096)
				},
				{ provisionalWindowMs: 1000, stateEvery: 3 },
			)
			expect(kinds(r.events, "track-open")).toBeGreaterThan(0)
		})

		it("a one-ulp change to one window coefficient fails the comparison (negative control)", () => {
			const r = lockstep(
				h => {
					h.start()
					h.push(qso(Math.round(0.4 * FS)))
				},
				{
					perturb: k => {
						const w = new Uint32Array(
							k.memory.buffer,
							k.layout.offsets.window,
							256,
						)
						w[100] = w[100]! + 1
					},
				},
			)
			expect(r.diffs.length).toBeGreaterThan(0)
			expect(r.diffs[0]).toMatch(/frameAcc|blockAcc|shortAcc|events/)
		})

		it("chunk and batch cuts give the same stream", () => {
			const iq = concatIq([
				qso(Math.round(0.7 * FS)),
				bursts(Math.round(0.5 * FS)),
			])
			const play = (chunk: number, batch?: number): PipelineEvent[] =>
				expectSame(
					h => {
						h.start()
						h.push(iq, chunk)
					},
					{
						...(batch === undefined ? {} : { frameBatchFrames: batch }),
						stateEvery: 5,
					},
				).events
			const base = play(4096)
			expect(play(333, 1)).toEqual(base)
			expect(play(65_536, 7)).toEqual(base)
		})
	},
)
