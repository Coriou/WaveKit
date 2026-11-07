import { beforeEach, describe, expect, it } from "vitest"
import type { PipelineEvent } from "../../../../src/core/spectrum/types.js"
import {
	addInto,
	counterRun,
	gaussianNoise,
	mulberry32,
	packCu8,
	tone,
} from "../../../mocks/scanner/signals.js"
import { frameWasm, WASM_LABEL } from "./frame-wasm-harness.js"
import { lockstep } from "./frame-wasm-lockstep.js"
import type { LockstepOptions, LockstepResult } from "./frame-wasm-lockstep.js"
import { BLOCK, FS, Harness, yieldToRpc } from "./pipeline-harness.js"

/**
 * Kernel faults against the JS reference: wherever a fault lands (a batch cut, a block change after a
 * counter run or a seam, an epoch's first block, a held-back frame, 50 % overlap), the frames it lost
 * and the block it discarded are the only departure. The lockstep comparison mirrors that loss on the
 * JS side (frame-wasm-lockstep.ts) and then requires the events and every piece of frame-path state to
 * match after each input, through the fault, the switch to JS and the blocks after it. A frame that
 * was handed over raw when the switch happened must run on JS like any other.
 */

const SIGMA = 0.005
const BIG = 1 << 20

/** `n` U8 noise samples, seeded by `n`. */
function noise(n: number): Uint8Array {
	const iq = gaussianNoise(mulberry32(n), n, SIGMA)
	return packCu8(iq.re, iq.im)
}

/** Noise and a carrier that opens a track, so the faults cross a live envelope. */
function scene(seed: number, n: number): Uint8Array {
	const iq = gaussianNoise(mulberry32(seed), n, SIGMA)
	addInto(iq, tone(n, FS, 30_000, 0.01))
	return packCu8(iq.re, iq.im)
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}

const arm = (h: Harness): void =>
	h.pipeline.frameKernelForTest()!.trapNextRunForTest()

/** The two restarts, each a trap on a chunk of the carrier scene; the next fault switches to JS. */
function exhaust(h: Harness): void {
	h.start()
	h.pushBytes(scene(1, 3 * BLOCK), 4096)
	for (let i = 0; i < 2; i++) {
		arm(h)
		h.pushBytes(scene(2 + i, 4096), BIG)
	}
	expect(h.pipeline.frameKernelForTest()!.restarts).toBe(2)
}

/** After the switch: more of the scene, so later blocks are compared too. */
function after(h: Harness, seed: number): void {
	h.pushBytes(scene(seed, 8 * BLOCK), 3000)
}

const summaries = (events: PipelineEvent[]): number =>
	events.filter(e => e.kind === "block-summary").length

function expectFallback(
	drive: (h: Harness) => void,
	opts: LockstepOptions = {},
	minSummaries = 8,
): LockstepResult {
	const r = lockstep(drive, opts)
	expect(r.diffs).toEqual([])
	expect(r.faults).toBe(3)
	expect(r.wasmAtEnd).toBe(false)
	expect(summaries(r.events)).toBeGreaterThanOrEqual(minSummaries)
	return r
}

const sum = (a: Float64Array): number => a.reduce((s, v) => s + v, 0)

describe.skipIf(!frameWasm)(
	`kernel faults against the JS reference (${WASM_LABEL})`,
	() => {
		beforeEach(yieldToRpc)

		it("a fault finishing a block when the next block's first frame arrives raw: that frame runs on JS", () => {
			const input = (): Uint8Array =>
				concat(noise(2559), counterRun(20_480, 17), noise(257))
			let wasm: Harness | null = null
			expectFallback(
				h => {
					wasm = h
					for (let i = 0; i < 2; i++) {
						h.start()
						arm(h)
						h.pushBytes(noise(4096 + i), BIG)
					}
					h.start()
					h.pushBytes(noise(12_801), BIG)
					arm(h)
					// block 1 holds 10 staged frames; the counter run moves the next frame into block 2, whose
					// arrival finishes block 1, and that flush traps
					h.pushBytes(input(), BIG)
				},
				{},
				1,
			)
			// the reported case, against a plain JS pipeline: block 2's one frame, as JS computes it
			const ref = new Harness({})
			ref.start()
			ref.pushBytes(noise(12_801), BIG)
			ref.pushBytes(input(), BIG)
			const p = wasm!.pipeline as unknown as Record<string, Float64Array>
			const q = ref.pipeline as unknown as Record<string, Float64Array>
			expect(sum(p["frameAcc"]!)).toBeGreaterThan(0)
			expect(sum(p["frameAcc"]!)).toBe(sum(q["frameAcc"]!))
			expect(sum(p["blockAcc"]!)).toBe(sum(q["blockAcc"]!))
			expect(
				(wasm!.pipeline as unknown as Record<string, number>)["blockFrames"],
			).toBe(1)
		})

		it("the same with a carrier track open, and blocks after the switch", () => {
			expectFallback(h => {
				exhaust(h)
				h.pushBytes(scene(9, 2 * BLOCK + 2000), BIG)
				arm(h)
				h.pushBytes(
					concat(scene(10, 2559), counterRun(20_480, 17), scene(11, 4000)),
					BIG,
				)
				after(h, 12)
			})
		})

		it("inside a batch, and on a batch cut at a block's last frame", () => {
			// 7-frame batches: the trap lands mid-block, the rest of the block runs on JS
			const mid = expectFallback(
				h => {
					exhaust(h)
					h.pushBytes(scene(20, BLOCK + 3 * 256), BIG)
					arm(h)
					h.pushBytes(scene(21, 4096), BIG)
					after(h, 22)
				},
				{ frameBatchFrames: 7 },
			)
			expect(mid.lost.at(-1)).toHaveLength(7)
			// 5-frame batches and 50 frames a block: the batch that fills on the block's last frame traps,
			// then the block end finishes an empty block
			const cut = expectFallback(
				h => {
					exhaust(h)
					const at = h.sample % BLOCK
					// 46 frames' samples: 45 run (9 batches), the 46th is held back for the next push
					h.pushBytes(scene(23, 2 * BLOCK - at + 46 * 256), BIG)
					arm(h)
					h.pushBytes(scene(24, 5 * 256 + 100), BIG)
					after(h, 25)
				},
				{ frameBatchFrames: 5 },
			)
			const lastLost = cut.lost.at(-1)!
			expect(lastLost).toHaveLength(5)
			expect((lastLost.at(-1)! + 256) % BLOCK).toBe(0)
		})

		it("at a seam: a skipped sample range moves the next frame into a new block", () => {
			const r = expectFallback(h => {
				exhaust(h)
				// end two frames into a block, on a frame boundary: the second frame is held back
				const at = h.sample % BLOCK
				h.pushBytes(scene(30, 2 * BLOCK - at + 2 * 256), BIG)
				arm(h)
				// a seam: the held-back frame is staged, then the next frame opens a new block and its
				// arrival finishes the old one, which traps
				h.sample += BLOCK
				h.pushBytes(scene(31, 4000), BIG)
				after(h, 32)
			})
			expect(r.lost.at(-1)).toHaveLength(1)
			// a short gap input: the seam flushes the held-back frame alone, and that run traps
			expectFallback(h => {
				exhaust(h)
				h.pushBytes(scene(33, BLOCK + 10 * 256), BIG)
				arm(h)
				h.gap(300)
				after(h, 34)
			})
		})

		it("at an epoch: the first block's pending frames, after a timer and after a marker", () => {
			expectFallback(h => {
				exhaust(h)
				// same centre: no stale-block check, so the epoch's blocks are kept
				h.pending({
					centreHz: 446_150_000,
					settleSamples: 3000,
					centreChanged: false,
				})
				arm(h)
				h.pushBytes(scene(40, 9000), BIG)
				after(h, 41)
			})
			expectFallback(h => {
				exhaust(h)
				h.pending({
					centreHz: 446_200_000,
					expectMarker: true,
					centreChanged: false,
				})
				arm(h)
				// one chunk: frames wait, the counter run resolves the epoch, then frames are staged
				h.pushBytes(
					concat(scene(42, 3000), counterRun(4096, 17), scene(43, 9000)),
					BIG,
				)
				after(h, 44)
			})
		})

		it("at hold-back: the frame held for the next push is the one lost", () => {
			const r = expectFallback(h => {
				exhaust(h)
				// a chunk ending on a frame boundary: its last frame is held back until the next input
				const at = h.sample % 256
				h.pushBytes(scene(50, BLOCK + 256 * 12 - at), BIG)
				arm(h)
				h.gap(0) // releases the held-back frame alone; its run traps
				after(h, 52)
			})
			expect(r.lost.at(-1)).toHaveLength(1)
		})

		it("with 50 % overlap: a block change after a counter run, and a batch cut", () => {
			const opts: LockstepOptions = { config: { overlap: 0.5 } }
			expectFallback(h => {
				exhaust(h)
				h.pushBytes(scene(60, BLOCK + 2001), BIG)
				arm(h)
				h.pushBytes(
					concat(scene(61, 2559), counterRun(20_480, 17), scene(62, 4000)),
					BIG,
				)
				after(h, 63)
			}, opts)
			expectFallback(
				h => {
					exhaust(h)
					h.pushBytes(scene(64, BLOCK + 999), BIG)
					arm(h)
					h.pushBytes(scene(65, 5000), BIG)
					after(h, 66)
				},
				{ ...opts, frameBatchFrames: 9 },
			)
		})

		it("a kernel error code at a block end, like a trap", () => {
			expectFallback(h => {
				exhaust(h)
				h.pushBytes(scene(70, 2 * BLOCK + 3000), BIG)
				h.pipeline.frameKernelForTest()!.failForTest(4)
				h.pushBytes(
					concat(scene(71, 2559), counterRun(20_480, 17), scene(72, 4 * BLOCK)),
					BIG,
				)
				after(h, 73)
			})
		})

		it("restarts are mirrored too: the kernel keeps running after one fault", () => {
			const r = lockstep(h => {
				h.start()
				h.pushBytes(scene(80, 2 * BLOCK + 3000), BIG)
				arm(h)
				h.pushBytes(
					concat(scene(81, 2559), counterRun(20_480, 17), scene(82, 4000)),
					BIG,
				)
				after(h, 83)
			})
			expect(r.diffs).toEqual([])
			expect(r.faults).toBe(1)
			expect(r.wasmAtEnd).toBe(true)
		})
	},
)
