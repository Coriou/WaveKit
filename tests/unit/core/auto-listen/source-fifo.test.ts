import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { PolyphaseResampler } from "../../../../src/core/auto-listen/resampler.js"
import {
	FLAG_ADMITTED,
	FLAG_AUDIBLE,
	AUTO_ROUTE_TIME_ENTRIES,
	AUTO_ROUTE_TIME_TOLERANCE_MS,
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

	it("writes output left after a ring segment fills, then drops exactly (regression)", () => {
		// 184 inputs at 8 kHz, delay 17: (184 − 17) × 6 = 1 002 outputs into 1 000 slots.
		const input = ramp(184, 11)
		const ref = feed(
			new PolyphaseResampler(8_000, OUT),
			input,
			[],
			100_000,
		).samples
		expect(ref.length).toBe(1_002)
		const fifo = new SourceFifo(1_000)
		const res = new PolyphaseResampler(8_000, OUT)
		fifo.writeFrom(res, input, 0, input.length, FLAG_AUDIBLE)
		expect(res.pendingOutput(0)).toBe(0)
		expect(fifo.queuedSamples).toBe(1_000)
		expect(fifo.overflowDroppedSamples).toBe(2)
		expect(drain(fifo).samples).toEqual(ref.slice(2))
	})

	it("writes across the wrap boundary in one call without loss", () => {
		const input = ramp(400, 12)
		const ref = feed(
			new PolyphaseResampler(8_000, OUT),
			input,
			[],
			100_000,
		).samples
		const fifo = new SourceFifo(1_000)
		const res = new PolyphaseResampler(8_000, OUT)
		// 100 inputs → (100 − 17) × 6 = 498 outputs; read 497 so the head sits at slot 497.
		fifo.writeFrom(res, input, 0, 100, FLAG_SILENT)
		const head = new Int16Array(497)
		fifo.read(head, 0, 497)
		// 150 more inputs → 900 outputs in one call: slots 498..999 then 0..397 (901 queued).
		fifo.writeFrom(res, input, 100, 250, FLAG_AUDIBLE)
		expect(fifo.queuedSamples).toBe(901)
		expect(fifo.overflowDroppedSamples).toBe(0)
		expect([...head, ...drain(fifo).samples]).toEqual(ref.slice(0, 1_398))
	})

	it("keeps oldestQueuedAt exact under sustained partial draining (regression)", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(2_000, 13)
		const one = new Int16Array(1)
		// 19 inputs, delay 17: 2 outputs at t = 0; read 1.
		fifo.writeFrom(res, input, 0, 19, FLAG_AUDIBLE, 0)
		fifo.read(one, 0, 1)
		for (let k = 1; k <= 1_000; k++) {
			fifo.writeFrom(res, input, 18 + k, 19 + k, FLAG_AUDIBLE, k * 20)
			fifo.read(one, 0, 1)
			// One sample queued: the one written at k × 20 ms.
			expect(fifo.queuedSamples).toBe(1)
			expect(fifo.oldestQueuedAt).toBe(k * 20)
		}
	})

	it("keeps oldestQueuedAt exact over 1 000 undrained writes (regression)", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(2_000, 14)
		// Prime with 17 inputs (the delay): no output yet.
		fifo.writeFrom(res, input, 0, 17, FLAG_AUDIBLE, 0)
		for (let k = 0; k < 1_000; k++)
			fifo.writeFrom(res, input, 17 + k, 18 + k, FLAG_AUDIBLE, k * 20)
		expect(fifo.queuedSamples).toBe(1_000)
		fifo.read(new Int16Array(999), 0, 999)
		expect(fifo.oldestQueuedAt).toBe(19_980)
	})

	it("merges writes within 1 ms and keeps the earlier time", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(100, 15)
		fifo.writeFrom(res, input, 0, 18, FLAG_AUDIBLE, 10)
		fifo.writeFrom(res, input, 18, 19, FLAG_AUDIBLE, 11)
		fifo.writeFrom(res, input, 19, 20, FLAG_AUDIBLE, 11.5)
		fifo.read(new Int16Array(2), 0, 2)
		// 11 − 10 ≤ 1 ms merges into the entry at 10; 11.5 − 10 > 1 ms starts a new entry.
		expect(fifo.oldestQueuedAt).toBe(11.5)
		const g = new SourceFifo()
		const r2 = new PolyphaseResampler(48_000, OUT)
		g.writeFrom(r2, input, 0, 18, FLAG_AUDIBLE, 10)
		g.writeFrom(r2, input, 18, 19, FLAG_AUDIBLE, 11)
		g.read(new Int16Array(1), 0, 1)
		expect(g.oldestQueuedAt).toBe(10)
		// A clock step back extends the newest entry and lowers it to the step's time, so the
		// sample written at 5 is never reported late.
		g.writeFrom(r2, input, 19, 20, FLAG_AUDIBLE, 5)
		g.read(new Int16Array(1), 0, 1)
		expect(g.oldestQueuedAt).toBe(5)
	})

	it("is never late after backward and non-finite write times", () => {
		const fifo = new SourceFifo(1_000, 4)
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(200, 21)
		fifo.writeFrom(res, input, 0, 17, FLAG_AUDIBLE, 0)
		const times = [100, 50, 200, 199.5, Number.POSITIVE_INFINITY, 300, 10, 400]
		const truth: number[] = []
		let pos = 17
		for (const t of times) {
			fifo.writeFrom(res, input, pos, pos + 1, FLAG_AUDIBLE, t)
			pos++
			truth.push(t)
		}
		const one = new Int16Array(1)
		for (let k = 0; k < truth.length; k++) {
			const reported = fifo.oldestQueuedAt
			const t = truth[k] ?? Number.NaN
			// Untimed samples have no truth; timed ones are never reported late.
			if (Number.isFinite(t) && reported !== null)
				expect(reported).toBeLessThanOrEqual(t)
			fifo.read(one, 0, 1)
		}
	})

	it("bound is 4 094 ms, not 4 095 ms: tolerance-extended entry merged at saturation (regression)", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(5_000, 22)
		fifo.writeFrom(res, input, 0, 17, FLAG_AUDIBLE, 0)
		const s = 1 + 1 / 8_192
		const times = [0, s, s + 0.75]
		for (let j = 2; j <= 4_096; j++) times.push(j * s)
		let pos = 17
		for (const t of times) {
			fifo.writeFrom(res, input, pos, pos + 1, FLAG_AUDIBLE, t)
			pos++
		}
		fifo.read(new Int16Array(2), 0, 2)
		const truth = s + 0.75
		const age = 4_096 * s - truth
		expect(fifo.oldestQueuedAt).toBe(0)
		// The merge error exceeds 1 ms at an age above 4 094 ms but below 4 095 ms.
		expect(truth - 0).toBeGreaterThan(AUTO_ROUTE_TIME_TOLERANCE_MS)
		expect(age).toBeGreaterThan(
			(AUTO_ROUTE_TIME_ENTRIES - 2) * AUTO_ROUTE_TIME_TOLERANCE_MS,
		)
		expect(age).toBeLessThan(
			(AUTO_ROUTE_TIME_ENTRIES - 1) * AUTO_ROUTE_TIME_TOLERANCE_MS,
		)
	})

	it("reaches the bound at saturation of the default ring", () => {
		const fifo = new SourceFifo()
		const res = new PolyphaseResampler(48_000, OUT)
		const input = ramp(6_000, 16)
		fifo.writeFrom(res, input, 0, 17, FLAG_AUDIBLE, 0)
		// 5 000 one-sample writes 2 ms apart, undrained: 4 096 entries saturate.
		for (let k = 0; k < 5_000; k++)
			fifo.writeFrom(res, input, 17 + k, 18 + k, FLAG_AUDIBLE, k * 2)
		const one = new Int16Array(1)
		for (let k = 0; k < 5_000; k++) {
			const reported = fifo.oldestQueuedAt ?? Number.NaN
			const truth = k * 2
			const age = (5_000 - 1) * 2 - truth
			expect(reported).toBeLessThanOrEqual(truth)
			if (age <= (AUTO_ROUTE_TIME_ENTRIES - 2) * AUTO_ROUTE_TIME_TOLERANCE_MS)
				expect(truth - reported).toBeLessThanOrEqual(
					AUTO_ROUTE_TIME_TOLERANCE_MS,
				)
			fifo.read(one, 0, 1)
		}
	})

	// Feature: auto-listen-route, Property 6: Priority and bound (write-time support)
	// Validates: Requirements 2.4, 4.5, 4.10
	it("oldestQueuedAt is never late and within 1 ms inside the age bound", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 2, max: 40 }),
				fc.array(
					fc.oneof(
						fc.record({
							kind: fc.constant("write" as const),
							inputs: fc.integer({ min: 0, max: 60 }),
							dt: fc.oneof(
								fc.constant(0),
								fc.double({ min: 0, max: 3, noNaN: true }),
								fc.integer({ min: 0, max: 400 }),
								fc.double({ min: -5, max: 0, noNaN: true }),
							),
						}),
						fc.record({
							kind: fc.constant("read" as const),
							n: fc.integer({ min: 0, max: 80 }),
						}),
					),
					{ maxLength: 300 },
				),
				fc.integer({ min: 50, max: 3_000 }),
				(entries, ops, cap) => {
					const fifo = new SourceFifo(cap, entries)
					const res = new PolyphaseResampler(48_000, OUT)
					const input = ramp(20_000, 17)
					// Prime the delay so every input yields one output at the write's time.
					fifo.writeFrom(res, input, 0, 17, FLAG_AUDIBLE, 0)
					const truth: number[] = []
					let head = 0
					let pos = 17
					let now = 0
					let dropped = 0
					// The 1 ms bound is stated for nondecreasing times; "never late" always holds.
					let backward = false
					const out = new Int16Array(80)
					const bound = (entries - 2) * AUTO_ROUTE_TIME_TOLERANCE_MS
					for (const op of ops) {
						if (op.kind === "write") {
							now += op.dt
							if (op.dt < 0) backward = true
							fifo.writeFrom(
								res,
								input,
								pos,
								pos + op.inputs,
								FLAG_AUDIBLE,
								now,
							)
							pos += op.inputs
							for (let k = 0; k < op.inputs; k++) truth.push(now)
							head += fifo.overflowDroppedSamples - dropped
							dropped = fifo.overflowDroppedSamples
						} else {
							head += fifo.read(out, 0, op.n)
						}
						expect(fifo.queuedSamples).toBe(truth.length - head)
						const reported = fifo.oldestQueuedAt
						if (fifo.queuedSamples === 0) {
							expect(reported).toBeNull()
							continue
						}
						const t = truth[head] ?? Number.NaN
						expect(reported).not.toBeNull()
						const r = reported ?? Number.NaN
						expect(r).toBeLessThanOrEqual(t)
						if (!backward && now - t <= bound)
							expect(t - r).toBeLessThanOrEqual(
								AUTO_ROUTE_TIME_TOLERANCE_MS + 1e-9,
							)
					}
				},
			),
			{ numRuns: 200 },
		)
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
