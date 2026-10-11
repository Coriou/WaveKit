import { describe, expect, it } from "vitest"
import { ImpulseBlanker } from "../../../../src/core/spectrum/impulse-blanker.js"
import type {
	BlockBlanking,
	FrameVerdict,
} from "../../../../src/core/spectrum/impulse-blanker.js"
import { mulberry32 } from "../../../mocks/scanner/signals.js"
import type { Rng } from "../../../mocks/scanner/signals.js"

const N = 256
const FS = 256_000
const L = 50 // frames per 50 ms block, one frame per N samples
const LO = 26
const HI = 231 // usable bins [LO, HI), as the pipeline passes them (usableEdgeBins(256, 0.8) = 26)

interface Rise {
	db: number
	from: number
	to: number
}
const ALL: Rise = { db: 20, from: 13, to: 243 } // a broadband impulse over 90 % of the bins

function newBlanker(): ImpulseBlanker {
	return new ImpulseBlanker({
		fftSize: N,
		usableStartBin: LO,
		usableEndBin: HI,
		sampleRateHz: FS,
	})
}

/** One frame's shifted bin powers: exponential (one Hann frame of complex noise) of mean 1, plus `rises`. */
function frame(rng: Rng, rises: readonly Rise[] = []): Float64Array {
	const p = new Float64Array(N)
	for (let i = 0; i < N; i++) p[i] = -Math.log(1 - rng())
	for (const r of rises)
		for (let i = r.from; i < r.to; i++) p[i] = (p[i] ?? 0) + 10 ** (r.db / 10)
	return p
}

interface BlockRun {
	verdicts: FrameVerdict[]
	acc: Float64Array
	result: BlockBlanking
}

/** Offers frames block·L … block·L + L − 1 (frame k starts at sample k·N) and closes the block, as the pipeline does. */
function runBlock(
	b: ImpulseBlanker,
	block: number,
	frameAt: (k: number) => Float64Array,
): BlockRun {
	const acc = new Float64Array(N)
	const verdicts: FrameVerdict[] = []
	for (let k = block * L; k < (block + 1) * L; k++) {
		const f = frameAt(k)
		const v = b.offer(f, k * N)
		if (v === "keep")
			for (let i = 0; i < N; i++) acc[i] = (acc[i] ?? 0) + (f[i] ?? 0)
		verdicts.push(v)
	}
	return { verdicts, acc, result: b.endBlock(acc) }
}

/** Mean bin power over the usable span of an accumulator holding `frames` frames. */
function usableMean(acc: Float64Array, frames: number): number {
	let s = 0
	for (let i = LO; i < HI; i++) s += acc[i] ?? 0
	return s / ((HI - LO) * frames)
}

describe("ImpulseBlanker", () => {
	it("never blanks noise or a steady wideband occupant, from the first block on", () => {
		const rng = mulberry32(1)
		const b = newBlanker()
		const occupant: Rise[] = [{ db: 20, from: 40, to: 200 }] // 78 % of the usable span, like a DVB-T edge
		for (let block = 0; block < 40; block++) {
			expect(runBlock(b, block, () => frame(rng, occupant)).result).toEqual({
				frames: L,
				integrated: L,
				blanked: 0,
				excluded: false,
			})
		}
		expect(b.blankedFrames).toBe(0)
		expect(b.rfi()).toEqual({ active: false, periodMs: null, events: 0 })
	})

	it("blanks a frame that rises ≥ 6 dB on half the usable bins, not one that rises on fewer or by less", () => {
		const rng = mulberry32(2)
		const b = newBlanker()
		runBlock(b, 0, () => frame(rng))
		const span = HI - LO
		const cases: [Rise, FrameVerdict][] = [
			[{ db: 8, from: LO, to: LO + Math.ceil(0.6 * span) }, "blank"],
			[{ db: 8, from: LO, to: LO + Math.floor(0.4 * span) }, "keep"],
			[{ db: 3, from: 0, to: N }, "keep"],
			[ALL, "blank"],
		]
		cases.forEach(([rise, verdict], k) =>
			expect(b.offer(frame(rng, [rise]), (L + 10 * k) * N)).toBe(verdict),
		)
	})

	it("judges an epoch's first block against the median of its own frames", () => {
		const rng = mulberry32(3)
		const b = newBlanker()
		const first = runBlock(b, 0, k =>
			frame(rng, k === 10 || k === 11 || k === 40 ? [ALL] : []),
		)
		expect(first.verdicts.every(v => v === "pending")).toBe(true)
		expect(first.result).toEqual({
			frames: L,
			integrated: L - 3,
			blanked: 3,
			excluded: false,
		})
		expect(usableMean(first.acc, L - 3)).toBeGreaterThan(0.9)
		expect(usableMean(first.acc, L - 3)).toBeLessThan(1.1)
		b.reset()
		expect(runBlock(b, 1, () => frame(rng)).verdicts[0]).toBe("pending")
	})

	it("excludes a block with more than half its frames blanked and accepts a lasting level change", () => {
		const rng = mulberry32(4)
		const b = newBlanker()
		runBlock(b, 0, () => frame(rng))
		const heavy = runBlock(b, 1, k => frame(rng, k % L < 30 ? [ALL] : []))
		expect(heavy.result).toEqual({
			frames: L,
			integrated: 20,
			blanked: 30,
			excluded: true,
		})
		expect(usableMean(heavy.acc, 20)).toBeLessThan(1.2) // the kept frames, not the impulses
		expect(runBlock(b, 2, () => frame(rng, [ALL])).result.blanked).toBe(0) // the reference followed the raw level
		b.reset()
		runBlock(b, 3, () => frame(rng))
		const all = runBlock(b, 4, () => frame(rng, [ALL]))
		expect(all.result).toEqual({
			frames: L,
			integrated: L,
			blanked: L,
			excluded: true,
		})
		expect(usableMean(all.acc, L)).toBeGreaterThan(50) // every frame blanked: the raw block stands in
	})

	it("reports broadband RFI with its period after three stable events, and drops it when the impulses stop", () => {
		const rng = mulberry32(5)
		const b = newBlanker()
		const periodic = (k: number): Float64Array =>
			frame(rng, k >= 30 && (k - 30) % 100 < 2 ? [ALL] : []) // 2 ms every 100 ms
		for (let block = 0; block < 3; block++) runBlock(b, block, periodic) // events at frames 30 and 130
		expect(b.rfi().active).toBe(false)
		for (let block = 3; block < 5; block++) runBlock(b, block, periodic) // event at frame 230
		expect(b.rfi()).toEqual({ active: true, periodMs: 100, events: 3 })
		expect(b.blankedFrames).toBe(6)
		for (let block = 5; block < 50; block++)
			runBlock(b, block, () => frame(rng)) // 2.25 s without impulses
		expect(b.rfi().active).toBe(false)
	})

	it("reports no period for irregular impulses", () => {
		const rng = mulberry32(6)
		const b = newBlanker()
		const starts = [30, 130, 290, 380] // intervals 100, 160, 90 ms
		const irregular = (k: number): Float64Array =>
			frame(rng, starts.some(s => k === s || k === s + 1) ? [ALL] : [])
		for (let block = 0; block < 9; block++) runBlock(b, block, irregular)
		expect(b.rfi()).toEqual({ active: false, periodMs: null, events: 4 })
		expect(b.blankedFrames).toBe(8)
	})

	it("keeps RFI timing across epoch starts on one stream", () => {
		const rng = mulberry32(7)
		const b = newBlanker()
		const periodic = (k: number): Float64Array =>
			frame(rng, k >= 30 && (k - 30) % 100 < 2 ? [ALL] : [])
		for (let block = 0; block < 5; block++) runBlock(b, block, periodic) // events at frames 30, 130, 230
		expect(b.rfi()).toEqual({ active: true, periodMs: 100, events: 3 })
		b.reset() // a hop: new centre, same stream
		expect(b.rfi()).toEqual({ active: true, periodMs: 100, events: 3 })
		for (let block = 5; block < 7; block++) {
			b.reset() // every block an epoch's first: the event at frame 330 is judged as pending
			runBlock(b, block, periodic)
		}
		expect(b.rfi()).toEqual({ active: true, periodMs: 100, events: 4 })
		expect(b.blankedFrames).toBe(8)
	})

	it("forgets RFI when a new stream restarts the sample index", () => {
		const rng = mulberry32(8)
		const b = newBlanker()
		const periodic = (k: number): Float64Array =>
			frame(rng, k >= 30 && (k - 30) % 100 < 2 ? [ALL] : [])
		for (let block = 0; block < 5; block++) runBlock(b, block, periodic)
		expect(b.rfi().active).toBe(true)
		b.reset()
		runBlock(b, 0, () => frame(rng)) // the new stream starts again at sample 0, quiet
		expect(b.rfi()).toEqual({ active: false, periodMs: null, events: 0 })
		expect(b.blankedFrames).toBe(6)
	})
})
