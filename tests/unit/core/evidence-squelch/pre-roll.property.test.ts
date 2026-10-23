import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	EvidencePcmFormat,
	PreRollTag,
} from "../../../../src/core/evidence-squelch/contract.js"
import {
	pcmSampleBytes,
	preRollCapacitySamples,
} from "../../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"

/** Low rate keeps the FIFO small (capacity 1 500 samples) so schedules exercise every edge. */
const RATE = 1_000
const CAP = preRollCapacitySamples(RATE)
/** Shortest tag segment: keeps run counts within the 10 ms block bound the wiring guarantees. */
const MIN_SEGMENT = 10
const MAX_SPLIT = 700

type Op =
	| { kind: "data"; tag: PreRollTag; samples: number }
	| { kind: "latch" | "abandon" | "clear" }

interface Discard {
	id: number
	tag: PreRollTag
	reason: "catch-up" | "overflow" | "clear"
}

/** Per-sample reference of the design's output rule (PreRoll steps 1-3), labelling every sample. */
class Model {
	fifo: { id: number; tag: PreRollTag }[] = []
	readonly finalTag = new Map<number, PreRollTag>()
	readonly discards: Discard[] = []
	readonly receivedTag = new Map<number, PreRollTag>()
	readonly out: number[] = []
	readonly delays: number[] = []
	readonly onlyDropBefore: boolean[] = []
	next = 1

	sample(tag: PreRollTag): void {
		this.onlyDropBefore.push(this.fifo.every(e => e.tag === "drop"))
		const id = this.next++
		this.receivedTag.set(id, tag)
		this.fifo.push({ id, tag })
		while (this.fifo.length > 1 && this.fifo[0]?.tag === "drop") {
			const d = this.fifo.shift()
			if (d) this.discards.push({ id: d.id, tag: d.tag, reason: "catch-up" })
		}
		const head = this.fifo[0]
		if (!head) throw new Error("unreachable")
		if (head.tag === "pass" || head.tag === "guard") {
			this.fifo.shift()
			this.finalTag.set(head.id, head.tag)
			this.out.push(head.id)
		} else if (head.tag === "drop") {
			this.fifo.shift()
			this.out.push(0)
		} else {
			this.out.push(0)
		}
		if (this.fifo.length > CAP) {
			const d = this.fifo.shift()
			if (d) this.discards.push({ id: d.id, tag: d.tag, reason: "overflow" })
		}
		this.delays.push(this.fifo.length)
	}

	retag(tag: PreRollTag): void {
		for (const entry of this.fifo) if (entry.tag === "pending") entry.tag = tag
	}

	clear(): void {
		for (const d of this.fifo)
			this.discards.push({ id: d.id, tag: d.tag, reason: "clear" })
		this.fifo = []
	}
}

/** Schedules consistent with the wiring: pending ends in latch or abandon; guard only after pass. */
const segment = fc.integer({ min: MIN_SEGMENT, max: 1_800 })
const phase: fc.Arbitrary<Op[]> = fc.oneof(
	segment.map(n => [{ kind: "data", tag: "drop", samples: n }] as Op[]),
	fc
		.tuple(
			segment,
			fc.boolean(),
			segment,
			fc.option(segment, { nil: undefined }),
			segment,
		)
		.map(([wait, latch, pass, guard, gap]) => {
			const ops: Op[] = [{ kind: "data", tag: "pending", samples: wait }]
			if (!latch) {
				ops.push(
					{ kind: "abandon" },
					{ kind: "data", tag: "drop", samples: gap },
				)
				return ops
			}
			ops.push({ kind: "latch" }, { kind: "data", tag: "pass", samples: pass })
			if (guard !== undefined)
				ops.push({ kind: "data", tag: "guard", samples: guard })
			ops.push({ kind: "data", tag: "drop", samples: gap })
			return ops
		}),
	// Reopen within the hang: pass, drop, pass with no new evidence window.
	fc
		.tuple(segment, segment, segment, segment)
		.map(
			([wait, pass, gap, again]) =>
				[
					{ kind: "data", tag: "pending", samples: wait },
					{ kind: "latch" },
					{ kind: "data", tag: "pass", samples: pass },
					{ kind: "data", tag: "drop", samples: gap },
					{ kind: "data", tag: "pass", samples: again },
					{ kind: "data", tag: "drop", samples: gap },
				] as Op[],
		),
	fc.constant([{ kind: "clear" }] as Op[]),
)
/** At most 6 phases × 5 segments × 1 800 samples = 54 000 ids, within the s16le id range. */
const schedule = fc
	.array(phase, { minLength: 1, maxLength: 6 })
	.map(p => p.flat())
const shortSchedule = fc
	.array(phase, { minLength: 1, maxLength: 3 })
	.map(p => p.flat())
const formatArb = fc.constantFrom<EvidencePcmFormat>("s16le", "f32le")
/** Chunk split sizes in bytes (odd sizes split samples). */
const splits = fc.array(fc.integer({ min: 1, max: MAX_SPLIT }), {
	minLength: 1,
	maxLength: 30,
})

function encodeId(
	buf: Buffer,
	at: number,
	id: number,
	format: EvidencePcmFormat,
): void {
	if (format === "s16le") buf.writeUInt16LE(id, at)
	else buf.writeFloatLE(id, at)
}

function decodeAll(buf: Buffer, format: EvidencePcmFormat): number[] {
	const width = pcmSampleBytes(format)
	const out: number[] = []
	for (let i = 0; i + width <= buf.length; i += width)
		out.push(format === "s16le" ? buf.readUInt16LE(i) : buf.readFloatLE(i))
	return out
}

interface RunResult {
	out: number[]
	/** Delay after each whole-sample call (per-sample runs only). */
	delays: number[]
	maxDelay: number
	rangeOk: boolean
}

/**
 * Runs ops through a PreRoll. `sizes` cycles through chunk byte sizes; `perSample` feeds one
 * sample per call so delays can be compared sample by sample.
 */
function run(
	ops: readonly Op[],
	format: EvidencePcmFormat,
	sizes: readonly number[],
	perSample = false,
): RunResult {
	const width = pcmSampleBytes(format)
	const pre = new PreRoll({ rate: RATE, format })
	const out: number[] = []
	const delays: number[] = []
	let maxDelay = 0
	let rangeOk = true
	let id = 1
	let sizeIndex = 0
	const pad = 3
	const chunk = Buffer.alloc(MAX_SPLIT + 2 * pad)
	for (const op of ops) {
		if (op.kind !== "data") {
			if (op.kind === "latch") pre.latch()
			else if (op.kind === "abandon") pre.abandon()
			else pre.clear()
		} else {
			const data = Buffer.alloc(op.samples * width)
			for (let s = 0; s < op.samples; s++)
				encodeId(data, s * width, id++, format)
			let at = 0
			while (at < data.length) {
				const want = perSample
					? width
					: (sizes[sizeIndex++ % sizes.length] ?? width)
				const n = Math.min(want, data.length - at)
				// Margins around the range must stay untouched (Property 7).
				chunk.fill(0xa5, 0, pad)
				chunk.fill(0xa5, pad + n, pad + n + pad)
				data.copy(chunk, pad, at, at + n)
				pre.process(chunk, pad, pad + n, op.tag)
				for (let b = 0; b < pad; b++)
					if (chunk[b] !== 0xa5 || chunk[pad + n + b] !== 0xa5) rangeOk = false
				chunk.copy(data, at, pad, pad + n)
				at += n
				maxDelay = Math.max(maxDelay, pre.delaySamples)
				if (perSample) delays.push(pre.delaySamples)
			}
			out.push(...decodeAll(data, format))
		}
	}
	return { out, delays, maxDelay, rangeOk }
}

function model(ops: readonly Op[]): Model {
	const m = new Model()
	for (const op of ops) {
		if (op.kind === "data")
			for (let s = 0; s < op.samples; s++) m.sample(op.tag)
		else if (op.kind === "latch") m.retag("pass")
		else if (op.kind === "abandon") m.retag("drop")
		else m.clear()
	}
	return m
}

const runs = { numRuns: 100 }
/** 100 generated schedules of up to 54 000 samples, some fed one sample per call. */
const TIMEOUT_MS = 120_000

describe("PreRoll properties", () => {
	// Feature: evidence-squelch, Property 6: Chunk-split invariance (output bytes)
	// Validates: Requirements 2.3
	it(
		"output bytes equal the reference for any two chunk splits",
		() => {
			fc.assert(
				fc.property(
					schedule,
					formatArb,
					splits,
					splits,
					(ops, format, a, b) => {
						const expected = model(ops).out
						expect(run(ops, format, a).out).toEqual(expected)
						expect(run(ops, format, b).out).toEqual(expected)
					},
				),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 7: Nominal rate
	// Validates: Requirements 2.3
	it(
		"writes exactly the given range, one output byte per input byte",
		() => {
			fc.assert(
				fc.property(schedule, formatArb, splits, (ops, format, sizes) => {
					const total = ops.reduce(
						(n, op) => n + (op.kind === "data" ? op.samples : 0),
						0,
					)
					const r = run(ops, format, sizes)
					expect(r.rangeOk).toBe(true)
					expect(r.out.length).toBe(total)
				}),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 8: Delayed copy, no loss while open
	// Validates: Requirements 2.4
	it(
		"plays pass samples in order with nothing lost and constant delay",
		() => {
			fc.assert(
				fc.property(schedule, formatArb, (ops, format) => {
					const m = model(ops)
					const r = run(ops, format, [], true)
					expect(r.out).toEqual(m.out)
					const passIn = [...m.finalTag.entries()]
						.filter(([, tag]) => tag === "pass")
						.map(([id]) => id)
					const passOut = r.out.filter(
						id => id !== 0 && m.finalTag.get(id) === "pass",
					)
					expect(passOut).toEqual(passIn.sort((x, y) => x - y))
					// Across each latched interval (a maximal run of consecutive input ids that all
					// played as pass or guard), the delay (output index - input index) is one value.
					const outIndex = new Map<number, number>()
					r.out.forEach((id, i) => {
						if (id !== 0) outIndex.set(id, i)
					})
					const playedTag = (id: number): boolean => {
						const tag = m.finalTag.get(id)
						return tag === "pass" || tag === "guard"
					}
					let delayChanges = 0
					let intervals = 0
					let intervalDelay: number | undefined
					for (let id = 1; id < m.next; id++) {
						const at = outIndex.get(id)
						if (at === undefined || !playedTag(id)) {
							intervalDelay = undefined
							continue
						}
						const delay = at - (id - 1)
						if (intervalDelay === undefined) {
							intervalDelay = delay
							intervals++
						} else if (delay !== intervalDelay) delayChanges++
					}
					expect(delayChanges).toBe(0)
					if (passIn.length > 0) expect(intervals).toBeGreaterThan(0)
					// No pass sample is ever discarded.
					expect(
						m.discards.filter(d => d.tag === "pass" && d.reason !== "clear"),
					).toEqual([])
				}),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 9: Bounded delay
	// Validates: Requirements 2.2
	it(
		"delay never exceeds capacity",
		() => {
			fc.assert(
				fc.property(schedule, formatArb, splits, (ops, format, sizes) => {
					expect(run(ops, format, sizes).maxDelay).toBeLessThanOrEqual(CAP)
					const r = run(ops, format, [], true)
					expect(r.delays).toEqual(model(ops).delays)
				}),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 10: Onset
	// Validates: Requirements 2.1
	it(
		"an over latched within capacity plays from its first sample",
		() => {
			fc.assert(
				fc.property(schedule, formatArb, splits, (ops, format, sizes) => {
					const r = run(ops, format, sizes)
					let id = 1
					for (let i = 0; i < ops.length; i++) {
						const op = ops[i]
						if (op?.kind !== "data") continue
						const next = ops[i + 1]
						const prev = ops[i - 1]
						const startsOver = op.tag === "pending" && prev?.kind !== "data"
						if (
							startsOver &&
							next?.kind === "latch" &&
							op.samples <= CAP &&
							!ops.slice(i + 1).some(o => o.kind === "clear")
						) {
							const overIds = new Set(
								Array.from({ length: op.samples }, (_, j) => id + j),
							)
							const firstPlayed = r.out.find(v => overIds.has(v))
							expect(firstPlayed).toBe(id)
						}
						id += op.samples
					}
				}),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 11: Catch-up drops only silence
	// Validates: Requirements 2.5, 2.6
	it(
		"catch-up discards only drop, overflow only pending, delay 0 after the tail",
		() => {
			fc.assert(
				fc.property(schedule, formatArb, (ops, format) => {
					const m = model(ops)
					const r = run(ops, format, [], true)
					expect(r.out).toEqual(m.out)
					const wrong = m.discards.filter(
						d =>
							(d.reason === "catch-up" && d.tag !== "drop") ||
							(d.reason === "overflow" && d.tag !== "pending"),
					)
					expect(wrong).toEqual([])
					// Every pass or guard sample received is either played or cleared.
					const played = new Set(r.out)
					const queued = new Set(m.fifo.map(e => e.id))
					const cleared = new Set(
						m.discards.filter(d => d.reason === "clear").map(d => d.id),
					)
					let lost = 0
					for (const [id, tag] of m.receivedTag)
						if (
							(tag === "pass" || tag === "guard") &&
							!played.has(id) &&
							!cleared.has(id)
						)
							if (!queued.has(id)) lost++
					expect(lost).toBe(0)
					// Once only drop samples remain queued, the next drop sample brings the delay to 0.
					let lateCatchUp = 0
					m.onlyDropBefore.forEach((onlyDrop, i) => {
						if (
							onlyDrop &&
							m.receivedTag.get(i + 1) === "drop" &&
							r.delays[i] !== 0
						)
							lateCatchUp++
					})
					expect(lateCatchUp).toBe(0)
				}),
				runs,
			)
		},
		TIMEOUT_MS,
	)

	// Feature: evidence-squelch, Property 13: Lifecycle
	// Validates: Requirements 2.9
	it(
		"after clear the delay is zero and nothing queued before is emitted",
		() => {
			fc.assert(
				fc.property(
					shortSchedule,
					shortSchedule,
					formatArb,
					splits,
					(before, after, format, sizes) => {
						const ops: Op[] = [...before, { kind: "clear" }, ...after]
						const lastBefore = before.reduce(
							(n, op) => n + (op.kind === "data" ? op.samples : 0),
							0,
						)
						const r = run(ops, format, sizes)
						const emittedBefore = new Set(r.out.slice(0, lastBefore))
						const stale = r.out
							.slice(lastBefore)
							.filter(v => v !== 0 && (v <= lastBefore || emittedBefore.has(v)))
						expect(stale).toEqual([])
						const pre = new PreRoll({ rate: RATE, format })
						const buf = Buffer.alloc(40 * pcmSampleBytes(format), 1)
						pre.process(buf, 0, buf.length, "pending")
						pre.clear()
						expect(pre.delaySamples).toBe(0)
					},
				),
				runs,
			)
		},
		TIMEOUT_MS,
	)
})
