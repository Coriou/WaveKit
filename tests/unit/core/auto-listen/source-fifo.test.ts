import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import {
	FLAG_ADMITTED,
	FLAG_AUDIBLE,
	FLAG_SILENT,
	SourceFifo,
} from "../../../../src/core/auto-listen/source-fifo.js"
import type { SampleFlag } from "../../../../src/core/auto-listen/source-fifo.js"
import { feed, lcg } from "./helpers.js"

const OUT = 48_000

function ramp(length: number, seed: number): Int16Array {
	const rand = lcg(seed)
	return Int16Array.from({ length }, () =>
		Math.round((rand() * 2 - 1) * 30_000),
	)
}

function drain(fifo: SourceFifo): { samples: number[]; flags: number[] } {
	const out = new Int16Array(fifo.queuedSamples)
	const flags = new Uint8Array(out.length)
	fifo.read(out, 0, out.length, flags)
	return { samples: [...out], flags: [...flags] }
}

const flagAt = (at: number): SampleFlag =>
	([FLAG_SILENT, FLAG_AUDIBLE, FLAG_ADMITTED] as const)[
		Math.floor(at / 211) % 3
	] ?? FLAG_SILENT

/** Writes `input` in spans cut at `cuts` plus the flag edges (multiples of 211). */
function writeSplit(
	fifo: SourceFifo,
	res: PolyphaseResampler,
	input: Int16Array,
	cuts: readonly number[],
): void {
	const all = new Set(cuts.filter(c => c > 0 && c < input.length))
	for (let c = 211; c < input.length; c += 211) all.add(c)
	const bounds = [0, ...[...all].sort((a, b) => a - b), input.length]
	for (let s = 0; s + 1 < bounds.length; s++) {
		const a = bounds[s] ?? 0
		fifo.writeFrom(res, input, a, bounds[s + 1] ?? 0, flagAt(a))
	}
}

describe("SourceFifo", () => {
	it("defaults to 3 s at 48 kHz and rejects a malformed capacity", () => {
		expect(new SourceFifo().capacity).toBe(144_000)
		expect(new SourceFifo(Number.NaN).capacity).toBe(144_000)
		expect(new SourceFifo(-5).capacity).toBe(144_000)
	})

	it("holds exactly the resampled stream with per-sample flags", () => {
		const input = ramp(3_000, 1)
		const ref = feed(
			new PolyphaseResampler(8_000, OUT),
			input,
			[
				211, 422, 633, 844, 1055, 1266, 1477, 1688, 1899, 2110, 2321, 2532,
				2743, 2954,
			],
			100_000,
			flagAt,
		)
		const fifo = new SourceFifo()
		writeSplit(fifo, new PolyphaseResampler(8_000, OUT), input, [])
		expect(fifo.queuedSamples).toBe(ref.samples.length)
		expect(fifo.queuedAudibleSamples).toBe(
			ref.flags.filter(f => f !== 0).length,
		)
		expect(drain(fifo)).toEqual(ref)
		expect(fifo.queuedSamples).toBe(0)
		expect(fifo.queuedAudibleSamples).toBe(0)
	})

	it("reads zeros past the end and wraps", () => {
		const fifo = new SourceFifo(1_000)
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(2_500, 2)
		const ref = feed(
			new PolyphaseResampler(48_000, OUT),
			input,
			[],
			100_000,
		).samples
		const got: number[] = []
		const out = new Int16Array(300)
		let i = 0
		while (i < input.length) {
			const end = Math.min(input.length, i + 250)
			fifo.writeFrom(res, input, i, end, FLAG_AUDIBLE)
			i = end
			const n = fifo.read(out, 0, 300)
			got.push(...out.subarray(0, n))
			for (let k = n; k < 300; k++) expect(out[k]).toBe(0)
		}
		expect(got).toEqual(ref)
		expect(fifo.overflowDroppedSamples).toBe(0)
	})

	it("drops exactly the oldest samples at and past the bound", () => {
		const cap = 1_000
		const input = ramp(5_000, 3)
		const ref = feed(
			new PolyphaseResampler(25_000, OUT),
			input,
			[],
			100_000,
		).samples
		// At the bound: exactly cap samples fit, nothing dropped.
		const atBound = new SourceFifo(ref.length)
		atBound.writeFrom(
			new PolyphaseResampler(25_000, OUT),
			input,
			0,
			input.length,
			1,
		)
		expect(atBound.overflowDroppedSamples).toBe(0)
		expect(atBound.queuedSamples).toBe(ref.length)
		// Past it: the oldest ref.length − cap are dropped, the rest kept in order.
		const fifo = new SourceFifo(cap)
		const res = new PolyphaseResampler(25_000, OUT)
		for (let i = 0; i < input.length; i += 77)
			fifo.writeFrom(
				res,
				input,
				i,
				Math.min(input.length, i + 77),
				FLAG_AUDIBLE,
			)
		expect(fifo.queuedSamples).toBe(cap)
		expect(fifo.overflowDroppedSamples).toBe(ref.length - cap)
		expect(fifo.queuedAudibleSamples).toBe(cap)
		expect(drain(fifo).samples).toEqual(ref.slice(ref.length - cap))
	})

	it("discards only silent head samples", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(2_000, 4)
		fifo.writeFrom(res, input, 0, 1_000, FLAG_SILENT)
		fifo.writeFrom(res, input, 1_000, 2_000, FLAG_AUDIBLE)
		const silent = fifo.queuedSamples - fifo.queuedAudibleSamples
		expect(fifo.headFlag).toBe(FLAG_SILENT)
		expect(fifo.discardSilentHead(10)).toBe(10)
		expect(fifo.discardUntilAudible()).toBe(silent - 10)
		expect(fifo.headFlag).toBe(FLAG_AUDIBLE)
		expect(fifo.discardSilentHead(100)).toBe(0)
		expect(fifo.discardSilentHead(Number.NaN)).toBe(0)
		fifo.clear()
		expect(fifo.queuedSamples).toBe(0)
		expect(fifo.headFlag).toBe(FLAG_SILENT)
	})

	it("reports the oldest queued write time", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(3_000, 5)
		expect(fifo.oldestQueuedAt).toBeNull()
		fifo.writeFrom(res, input, 0, 1_000, FLAG_AUDIBLE, 100)
		fifo.writeFrom(res, input, 1_000, 2_000, FLAG_AUDIBLE, 200)
		expect(fifo.oldestQueuedAt).toBe(100)
		const first = fifo.queuedSamples - 1_000
		const out = new Int16Array(first)
		fifo.read(out, 0, first)
		expect(fifo.oldestQueuedAt).toBe(200)
		fifo.read(new Int16Array(fifo.queuedSamples), 0, fifo.queuedSamples)
		expect(fifo.queuedSamples).toBe(0)
		expect(fifo.oldestQueuedAt).toBeNull()
		fifo.writeFrom(res, input, 2_000, 3_000, FLAG_AUDIBLE)
		expect(fifo.oldestQueuedAt).toBeNull()
	})

	it("treats an unknown flag as silent", () => {
		const fifo = new SourceFifo()
		fifo.writeFrom(
			new PolyphaseResampler(48_000, OUT),
			ramp(500, 6),
			0,
			500,
			7 as SampleFlag,
		)
		expect(fifo.queuedAudibleSamples).toBe(0)
	})

	// Feature: auto-listen-route, Property 1: Chunk-split invariance
	// Validates: Requirements 2.4, 2.5
	it("contents, flags and drops do not depend on the split", () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.constantFrom(8_000, 25_000, 25_600, 48_000, 200_000),
					fc.integer({ min: 8_000, max: 200_000 }),
				),
				fc.integer({ min: 0, max: 4_000 }),
				fc.array(fc.integer({ min: 0, max: 4_000 }), { maxLength: 16 }),
				fc.array(fc.integer({ min: 0, max: 4_000 }), { maxLength: 16 }),
				fc.integer({ min: 200, max: 20_000 }),
				fc.integer(),
				(rate, length, cutsA, cutsB, cap, seed) => {
					const input = ramp(length, seed)
					const a = new SourceFifo(cap)
					const b = new SourceFifo(cap)
					writeSplit(a, new PolyphaseResampler(rate, OUT), input, cutsA)
					writeSplit(b, new PolyphaseResampler(rate, OUT), input, cutsB)
					expect(b.overflowDroppedSamples).toBe(a.overflowDroppedSamples)
					expect(b.queuedAudibleSamples).toBe(a.queuedAudibleSamples)
					const audible = a.queuedAudibleSamples
					const da = drain(a)
					expect(drain(b)).toEqual(da)
					expect(da.flags.filter(f => f !== 0).length).toBe(audible)
					expect(a.queuedAudibleSamples).toBe(0)
				},
			),
			{ numRuns: 100 },
		)
	})
})
