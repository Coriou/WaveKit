import { describe, expect, it } from "vitest"
import type {
	EvidencePcmFormat,
	PreRollTag,
} from "../../../../src/core/evidence-squelch/contract.js"
import {
	msToSamples,
	pcmSampleBytes,
	preRollCapacitySamples,
} from "../../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"

const RATE = 25_000
const FORMATS: readonly EvidencePcmFormat[] = ["s16le", "f32le"]

/** Sample id `n` (1-based, 0 means silence) encoded so every sample is distinguishable. */
function encode(ids: readonly number[], format: EvidencePcmFormat): Buffer {
	const width = pcmSampleBytes(format)
	const buf = Buffer.alloc(ids.length * width)
	ids.forEach((id, i) => {
		if (format === "s16le")
			buf.writeUInt16LE(id === 0 ? 0 : (id % 65_535) + 1, i * 2)
		else buf.writeFloatLE(id, i * 4)
	})
	return buf
}

function decode(buf: Buffer, format: EvidencePcmFormat): number[] {
	const width = pcmSampleBytes(format)
	const out: number[] = []
	for (let i = 0; i + width <= buf.length; i += width)
		out.push(format === "s16le" ? buf.readUInt16LE(i) : buf.readFloatLE(i))
	return out
}

function expectedIds(
	ids: readonly number[],
	format: EvidencePcmFormat,
): number[] {
	return format === "s16le"
		? ids.map(id => (id === 0 ? 0 : (id % 65_535) + 1))
		: [...ids]
}

/** Feeds consecutive sample ids in 10 ms chunks; returns the decoded output. */
class Feeder {
	next = 1
	readonly out: number[] = []
	readonly delays: number[] = []
	constructor(
		readonly pre: PreRoll,
		readonly format: EvidencePcmFormat,
		readonly rate = RATE,
	) {}
	feed(samples: number, tag: PreRollTag): void {
		const chunk = msToSamples(10, this.rate)
		for (let done = 0; done < samples; done += chunk) {
			const n = Math.min(chunk, samples - done)
			const ids = Array.from({ length: n }, (_, j) => this.next + j)
			this.next += n
			const buf = encode(ids, this.format)
			this.pre.process(buf, 0, buf.length, tag)
			this.out.push(...decode(buf, this.format))
			this.delays.push(this.pre.delaySamples)
		}
	}
}

const ms = (value: number): number => msToSamples(value, RATE)
const range = (from: number, count: number): number[] =>
	Array.from({ length: count }, (_, i) => from + i)
const zeros = (count: number): number[] => new Array<number>(count).fill(0)

describe("PreRoll", () => {
	it("rejects an unknown format and a bad rate", () => {
		expect(
			() =>
				new PreRoll({
					rate: RATE,
					format: "u8" as unknown as EvidencePcmFormat,
				}),
		).toThrow(expect.objectContaining({ code: "PRE_ROLL_FORMAT" }))
		for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
			expect(() => new PreRoll({ rate, format: "s16le" })).toThrow(
				expect.objectContaining({ code: "PRE_ROLL_RATE" }),
			)
	})

	for (const format of FORMATS) {
		describe(format, () => {
			it("fast path zero-fills", () => {
				const pre = new PreRoll({ rate: RATE, format })
				const buf = encode(range(1, 100), format)
				pre.process(buf, 0, buf.length, "drop")
				expect(decode(buf, format)).toEqual(zeros(100))
				expect(pre.delaySamples).toBe(0)
			})

			it("waiting emits zeros and grows delay", () => {
				const f = new Feeder(new PreRoll({ rate: RATE, format }), format)
				f.feed(ms(400), "pending")
				expect(f.out).toEqual(zeros(ms(400)))
				expect(f.pre.delaySamples).toBe(ms(400))
			})

			it("latch plays from onset", () => {
				const f = new Feeder(new PreRoll({ rate: RATE, format }), format)
				f.feed(ms(900), "pending")
				f.pre.latch()
				f.feed(ms(2000), "pass")
				expect(f.out.slice(0, ms(900))).toEqual(zeros(ms(900)))
				expect(f.out.slice(ms(900))).toEqual(
					expectedIds(range(1, ms(2000)), format),
				)
				const passDelays = f.delays.slice(ms(900) / 250)
				expect(new Set(passDelays)).toEqual(new Set([ms(900)]))
			})

			it("catch-up after the tail", () => {
				const f = new Feeder(new PreRoll({ rate: RATE, format }), format)
				f.feed(ms(900), "pending")
				f.pre.latch()
				f.feed(ms(2000), "pass")
				f.feed(ms(300), "guard")
				f.feed(ms(2000), "drop")
				const played = ms(900) + ms(2000) + ms(300)
				expect(f.out.slice(ms(900), ms(900) + played)).toEqual(
					expectedIds(range(1, played), format),
				)
				expect(f.out.slice(ms(900) + played)).toEqual(
					zeros(f.out.length - ms(900) - played),
				)
				// The chunk holding the first sample after the tail returns the delay to 0.
				const chunk = ms(10)
				const firstQuiet = ms(900) + played
				const chunkIndex = Math.floor(firstQuiet / chunk)
				expect(f.delays[chunkIndex]).toBe(0)
				expect(f.pre.delaySamples).toBe(0)
			})

			it("abandoned over then new over", () => {
				const f = new Feeder(new PreRoll({ rate: RATE, format }), format)
				f.feed(ms(600), "pending")
				f.pre.abandon()
				f.feed(ms(200), "drop")
				const overStart = f.next
				f.feed(ms(1000), "pending")
				f.pre.latch()
				f.feed(ms(1000), "pass")
				const firstOver = new Set(expectedIds(range(1, ms(600)), format))
				const nonZero = f.out.filter(v => v !== 0)
				expect(nonZero.some(v => firstOver.has(v))).toBe(false)
				expect(nonZero[0]).toBe(expectedIds([overStart], format)[0])
				expect(nonZero).toEqual(expectedIds(range(overStart, ms(1000)), format))
			})

			it("overflow discards oldest pending", () => {
				const pre = new PreRoll({ rate: RATE, format })
				const f = new Feeder(pre, format)
				f.feed(ms(2000), "pending")
				expect(Math.max(...f.delays)).toBeLessThanOrEqual(pre.capacitySamples)
				f.pre.latch()
				f.feed(ms(2000), "pass")
				expect(Math.max(...f.delays)).toBeLessThanOrEqual(pre.capacitySamples)
				const nonZero = f.out.filter(v => v !== 0)
				// Playback starts 1 500 ms before the latch.
				const first = ms(2000) - ms(1500) + 1
				expect(nonZero[0]).toBe(expectedIds([first], format)[0])
				expect(nonZero).toEqual(expectedIds(range(first, ms(2000)), format))
			})

			it("capacity bound per sizing row", () => {
				for (const rate of [24_975.6, 25_000, 50_000, 20_078.4]) {
					const pre = new PreRoll({ rate, format })
					const cap = preRollCapacitySamples(rate)
					expect(pre.capacitySamples).toBe(cap)
					const width = pcmSampleBytes(format)
					const buf = Buffer.alloc(cap * width, 1)
					pre.process(buf, 0, buf.length, "pending")
					expect(pre.delaySamples).toBe(cap)
					const one = Buffer.alloc(width, 1)
					pre.process(one, 0, one.length, "pending")
					expect(pre.delaySamples).toBe(cap)
					expect(one.equals(Buffer.alloc(width))).toBe(true)
				}
			})

			it("ten minutes waiting at capacity", () => {
				const pre = new PreRoll({ rate: RATE, format })
				const width = pcmSampleBytes(format)
				const chunk = Buffer.alloc(ms(10) * width)
				const zero = Buffer.alloc(chunk.length)
				let allZero = true
				let maxDelay = 0
				for (let i = 0; i < 60_000; i++) {
					chunk.fill(0x41)
					pre.process(chunk, 0, chunk.length, "pending")
					if (!chunk.equals(zero)) allZero = false
					maxDelay = Math.max(maxDelay, pre.delaySamples)
				}
				expect(allZero).toBe(true)
				expect(maxDelay).toBe(pre.capacitySamples)
				expect(pre.delaySamples).toBe(pre.capacitySamples)
			})

			it("clear", () => {
				const f = new Feeder(new PreRoll({ rate: RATE, format }), format)
				f.feed(ms(500), "pending")
				f.pre.latch()
				f.feed(ms(500), "pass")
				const before = f.next
				f.pre.clear()
				expect(f.pre.delaySamples).toBe(0)
				const mark = f.out.length
				f.feed(ms(500), "pass")
				expect(f.out.slice(mark)).toEqual(
					expectedIds(range(before, ms(500)), format),
				)
				expect(f.pre.delaySamples).toBe(0)
				const earlier = new Set(expectedIds(range(1, before - 1), format))
				expect(f.out.slice(mark).some(v => earlier.has(v))).toBe(false)
			})

			it("writes only inside [start, end)", () => {
				const pre = new PreRoll({ rate: RATE, format })
				const width = pcmSampleBytes(format)
				const buf = Buffer.alloc(10 * width, 7)
				pre.process(buf, 3 * width, 7 * width, "drop")
				expect(buf.subarray(0, 3 * width).every(b => b === 7)).toBe(true)
				expect(buf.subarray(3 * width, 7 * width).every(b => b === 0)).toBe(
					true,
				)
				expect(buf.subarray(7 * width).every(b => b === 7)).toBe(true)
			})

			it("ignores an empty or out-of-bounds range safely", () => {
				const pre = new PreRoll({ rate: RATE, format })
				const buf = Buffer.alloc(8, 5)
				pre.process(buf, 6, 2, "pass")
				pre.process(buf, -4, 0, "pass")
				expect(buf.every(b => b === 5)).toBe(true)
				pre.process(buf, 0, 1_000, "drop")
				expect(buf.every(b => b === 0)).toBe(true)
			})
		})
	}

	describe("split samples (A3)", () => {
		it("a split sample takes the tag of the call with its first byte", () => {
			const pre = new PreRoll({ rate: RATE, format: "s16le" })
			const buf = encode([1, 2], "s16le")
			pre.process(buf, 0, 1, "drop")
			pre.process(buf, 1, 4, "pass")
			// Sample 1 started as drop (zero); sample 2 passes at delay 0.
			expect(decode(buf, "s16le")).toEqual([0, expectedIds([2], "s16le")[0]])
		})

		it("latch and abandon retag a held partial pending sample", () => {
			for (const action of ["latch", "abandon"] as const) {
				const pre = new PreRoll({ rate: RATE, format: "f32le" })
				const a = encode([1, 2, 3], "f32le")
				pre.process(a, 0, 6, "pending")
				expect(pre.delaySamples).toBe(2)
				if (action === "latch") pre.latch()
				else pre.abandon()
				pre.process(a, 6, 12, "pass")
				const b = encode([4, 5, 6], "f32le")
				pre.process(b, 0, b.length, "pass")
				const out = [...decode(a, "f32le"), ...decode(b, "f32le")]
				if (action === "latch") expect(out).toEqual([0, 0, 1, 2, 3, 4])
				else expect(out).toEqual([0, 0, 3, 4, 5, 6])
			}
		})

		it("output is identical for a byte-at-a-time split", () => {
			for (const format of FORMATS) {
				const width = pcmSampleBytes(format)
				const ids = range(1, 300)
				const whole = encode(ids, format)
				const bytes = Buffer.from(whole)
				const a = new PreRoll({ rate: RATE, format })
				const b = new PreRoll({ rate: RATE, format })
				const plan: [number, PreRollTag | "latch"][] = [
					[50, "drop"],
					[100, "pending"],
					[0, "latch"],
					[100, "pass"],
					[50, "drop"],
				]
				let at = 0
				for (const [count, tag] of plan) {
					if (tag === "latch") {
						a.latch()
						b.latch()
						continue
					}
					const end = at + count * width
					a.process(whole, at, end, tag)
					for (let i = at; i < end; i++) b.process(bytes, i, i + 1, tag)
					at = end
				}
				expect(bytes.equals(whole)).toBe(true)
			}
		})
	})

	describe("run ring bound (160 runs, 153 from the wiring)", () => {
		/** pending `wait` samples, latch, then `n` alternating one-sample drop/pass inputs. */
		function alternate(pre: PreRoll, wait: number, n: number): void {
			const one = Buffer.alloc(2, 1)
			const queue = Buffer.alloc(wait * 2, 1)
			pre.process(queue, 0, queue.length, "pending")
			pre.latch()
			for (let i = 0; i < n; i++)
				pre.process(one, 0, 2, i % 2 === 0 ? "drop" : "pass")
		}

		it("holds exactly 160 runs without discarding", () => {
			const pre = new PreRoll({ rate: RATE, format: "s16le" })
			alternate(pre, 1_000, 159)
			expect(pre.tagRuns).toBe(160)
			expect(pre.runOverflows).toBe(0)
			expect(pre.delaySamples).toBe(1_000)
		})

		it("past the bound discards the oldest run, stays bounded and never throws", () => {
			const pre = new PreRoll({ rate: RATE, format: "s16le" })
			alternate(pre, 1_000, 160)
			expect(pre.runOverflows).toBe(1)
			expect(pre.tagRuns).toBe(160)
			expect(pre.delaySamples).toBeLessThan(1_000)
			alternate(pre, 10, 5_000)
			expect(pre.tagRuns).toBeLessThanOrEqual(160)
			expect(pre.delaySamples).toBeLessThanOrEqual(pre.capacitySamples)
		})

		it("maximum alternation (10 ms pass/drop blocks) never exceeds 153 runs", () => {
			for (const format of FORMATS) {
				const pre = new PreRoll({ rate: RATE, format })
				const width = pcmSampleBytes(format)
				const stream = Buffer.alloc(ms(10) * width, 3)
				// Chunks deliberately misaligned with the 10 ms blocks (odd byte counts).
				const chunkBytes = 333
				let maxRuns = 0
				const feed = (tag: PreRollTag): void => {
					for (let at = 0; at < stream.length; at += chunkBytes) {
						const piece = Buffer.from(stream.subarray(at, at + chunkBytes))
						pre.process(piece, 0, piece.length, tag)
						maxRuns = Math.max(maxRuns, pre.tagRuns)
					}
				}
				for (let b = 0; b < 200; b++) feed("pending")
				pre.latch()
				expect(pre.delaySamples).toBe(pre.capacitySamples)
				for (let b = 0; b < 3_000; b++) feed(b % 2 === 0 ? "pass" : "drop")
				expect(maxRuns).toBeGreaterThan(140)
				expect(maxRuns).toBeLessThanOrEqual(153)
				expect(pre.runOverflows).toBe(0)
			}
		})

		it("a worst-case wiring schedule never exceeds 153 runs", () => {
			for (const format of FORMATS) {
				const pre = new PreRoll({ rate: RATE, format })
				const width = pcmSampleBytes(format)
				const block = ms(10)
				// Chunks deliberately misaligned with the 10 ms blocks (odd byte counts).
				const chunkBytes = 333
				const stream = Buffer.alloc(block * width, 3)
				let maxRuns = 0
				let pending = 0
				const feed = (tag: PreRollTag): void => {
					for (let at = 0; at < stream.length; at += chunkBytes) {
						const piece = Buffer.from(stream.subarray(at, at + chunkBytes))
						pre.process(piece, 0, piece.length, tag)
						maxRuns = Math.max(maxRuns, pre.tagRuns)
					}
				}
				// Fill the FIFO to capacity while waiting, then latch.
				for (let b = 0; b < 200; b++) feed("pending")
				pre.latch()
				expect(pre.delaySamples).toBe(pre.capacitySamples)
				// Stage 1 flips every block: pass, guard, then drop once the guard expires,
				// and a new over (pending) starting during the tail, then latching again.
				const cycle: PreRollTag[] = [
					"pass",
					"guard",
					"drop",
					"drop",
					"pass",
					"drop",
				]
				for (let b = 0; b < 3_000; b++) {
					const tag = cycle[b % cycle.length] ?? "drop"
					if (b % 500 === 400) {
						for (let k = 0; k < 30; k++) feed("pending")
						pending++
						pre.latch()
					}
					feed(tag)
				}
				expect(pending).toBeGreaterThan(0)
				expect(maxRuns).toBeGreaterThan(100)
				expect(maxRuns).toBeLessThanOrEqual(153)
				expect(pre.runOverflows).toBe(0)
			}
		})
	})
})
