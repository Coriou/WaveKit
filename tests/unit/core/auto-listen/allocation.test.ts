import { afterEach, describe, expect, it, vi } from "vitest"
import { PreRollShadow } from "../../../../src/core/auto-listen/preroll-shadow.js"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import {
	FLAG_AUDIBLE,
	FLAG_SILENT,
	SourceFifo,
} from "../../../../src/core/auto-listen/source-fifo.js"
import type { PreRollTag } from "../../../../src/core/evidence-squelch/contract.js"
import { lcg } from "./helpers.js"

const CONSTRUCTORS = [
	"Int16Array",
	"Int32Array",
	"Uint8Array",
	"Float32Array",
	"Float64Array",
	"DataView",
] as const

const TAGS: PreRollTag[] = ["pending", "pass", "guard", "drop"]

/** Steady-state DSP work: resample into small FIFOs (with overflow), read blocks, shadow runs. */
function steady(
	work: {
		fifos: SourceFifo[]
		resamplers: PolyphaseResampler[]
		inputs: (Int16Array | Float32Array)[]
		shadow: PreRollShadow
		block: Int16Array
		flags: Uint8Array
	},
	rounds: number,
	rand: () => number,
): void {
	for (let r = 0; r < rounds; r++) {
		work.fifos.forEach((fifo, i) => {
			const input = work.inputs[i]
			const res = work.resamplers[i]
			if (input === undefined || res === undefined) return
			const a = Math.floor(rand() * input.length)
			const b = a + Math.floor(rand() * (input.length - a))
			fifo.writeFrom(
				res,
				input,
				a,
				b,
				rand() < 0.5 ? FLAG_AUDIBLE : FLAG_SILENT,
				r,
			)
			if (rand() < 0.3) fifo.read(work.block, 0, work.block.length, work.flags)
			if (rand() < 0.1) fifo.discardSilentHead(500)
			if (rand() < 0.05) fifo.discardUntilAudible()
			void fifo.oldestQueuedAt
		})
		const tag = TAGS[Math.floor(rand() * TAGS.length)] ?? "drop"
		const n = work.shadow.process(1 + Math.floor(rand() * 2_000), tag)
		for (let k = 0; k < n; k++) {
			void work.shadow.runBytes(k)
			void work.shadow.runPlays(k)
		}
		if (rand() < 0.05) work.shadow.latch()
		if (rand() < 0.05) work.shadow.abandon()
		work.shadow.sync(work.shadow.delaySamples)
	}
}

describe("auto listen DSP allocation (requirement 2.4)", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("allocates no buffer, typed array or view after warm-up", () => {
		const rand = lcg(99)
		const rates = [8_000, 25_000, 25_600, 48_001, 200_000]
		const work = {
			// Small FIFOs so the overflow path runs too.
			fifos: rates.map(() => new SourceFifo(4_000)),
			resamplers: rates.map(rate => new PolyphaseResampler(rate, 48_000)),
			inputs: rates.map((rate, i) => {
				const len = Math.ceil(rate / 50)
				return i % 2 === 0
					? Int16Array.from({ length: len }, () =>
							Math.round((rand() * 2 - 1) * 30_000),
						)
					: Float32Array.from({ length: len }, () => rand() * 2 - 1)
			}),
			shadow: new PreRollShadow({ rate: 25_000, format: "s16le" }),
			block: new Int16Array(960),
			flags: new Uint8Array(960),
		}
		steady(work, 50, rand)
		const spies = [
			vi.spyOn(Buffer, "alloc"),
			vi.spyOn(Buffer, "allocUnsafe"),
			vi.spyOn(Buffer, "from"),
			vi.spyOn(Int16Array.prototype, "subarray"),
			vi.spyOn(Float32Array.prototype, "subarray"),
			vi.spyOn(Uint8Array.prototype, "subarray"),
			vi.spyOn(Int16Array.prototype, "slice"),
			vi.spyOn(Uint8Array.prototype, "slice"),
		]
		let constructed = 0
		for (const name of CONSTRUCTORS) {
			const Original = globalThis[name]
			vi.stubGlobal(
				name,
				new Proxy(Original, {
					construct(target, args, newTarget) {
						constructed++
						return Reflect.construct(target, args, newTarget) as object
					},
				}),
			)
		}
		steady(work, 500, rand)
		const calls = spies.map(s => s.mock.calls.length)
		const byRun = constructed
		// Control: the instrumentation sees each kind.
		void new globalThis.Int16Array(1).subarray(0, 1)
		const control = constructed
		const controlSubarray = spies[3]?.mock.calls.length ?? 0
		vi.unstubAllGlobals()
		expect(calls).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
		expect(byRun).toBe(0)
		expect(control).toBeGreaterThan(0)
		expect(controlSubarray).toBe(1)
		expect(work.fifos.some(f => f.overflowDroppedSamples > 0)).toBe(true)
	})
})
