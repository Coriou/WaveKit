import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	TransmissionSegmenter,
	planSegments,
	type PlannedSegment,
	type SegmentEvent,
	type SegmenterOptions,
} from "../../../../src/core/scanner/channel/transmission-segmenter.js"

interface Tx {
	start: number
	end: number
	openDelay: number
	closeDelay: number
}

/** Drives the streaming segmenter one sample of "live edge" at a time with late events. */
function simulate(txs: readonly Tx[], o: SegmenterOptions): PlannedSegment[] {
	const seg = new TransmissionSegmenter(o)
	const events: { at: number; run: () => SegmentEvent[] }[] = []
	// The engine reports one channel's track opens in onset order.
	let lastOpenAt = Number.NEGATIVE_INFINITY
	txs.forEach((tx, i) => {
		const id = `t${i}`
		const openAt = Math.max(tx.start + tx.openDelay, lastOpenAt)
		lastOpenAt = openAt
		events.push({ at: openAt, run: () => seg.open(id, tx.start, 0) })
		events.push({
			at: Math.max(tx.end + tx.closeDelay, openAt),
			run: () => {
				seg.close(id, tx.end, true)
				return []
			},
		})
	})
	// Stable: equal times keep their push order (an open before its own close).
	events.sort((a, b) => a.at - b.at)
	const out: PlannedSegment[] = []
	let open: number | null = null
	const take = (evs: readonly SegmentEvent[]): void => {
		for (const ev of evs) {
			if (ev.kind === "start") {
				expect(open).toBeNull()
				open = ev.sample
			} else {
				expect(open).not.toBeNull()
				out.push({ start: open!, end: ev.sample, cut: ev.cut! })
				open = null
			}
		}
	}
	const last = Math.max(...txs.map(t => t.end + t.closeDelay))
	// Every decision (end or roll) is due by the last close + hang + holdback.
	const horizon = last + o.hangSamples + o.holdbackSamples + 2
	let e = 0
	for (let t = 0; t <= horizon; t++) {
		while (e < events.length && events[e]!.at <= t) take(events[e++]!.run())
		take(seg.advance(t))
	}
	expect(open).toBeNull()
	return out
}

const options = fc.record({
	preRollSamples: fc.integer({ min: 0, max: 100 }),
	hangSamples: fc.integer({ min: 0, max: 200 }),
	holdbackSamples: fc.integer({ min: 1, max: 100 }),
	maxSegmentSamples: fc.integer({ min: 50, max: 2000 }),
})

const scenario = options.chain(o =>
	fc
		.array(
			fc.record({
				gap: fc.integer({ min: 1, max: 3 * o.hangSamples + 5 }),
				length: fc.integer({ min: 1, max: 400 }),
				openDelay: fc.integer({ min: 0, max: o.holdbackSamples - 1 }),
				// A close is reported within the hang and within the holdback (see the recorder).
				closeDelay: fc.integer({
					min: 0,
					max: Math.min(o.holdbackSamples - 1, o.hangSamples),
				}),
			}),
			{ minLength: 1, maxLength: 8 },
		)
		.map(parts => {
			let t = 0
			const txs: Tx[] = parts.map(p => {
				const start = t + p.gap
				t = start + p.length
				return {
					start,
					end: t,
					openDelay: p.openDelay,
					closeDelay: p.closeDelay,
				}
			})
			return { o, txs }
		}),
)

describe("TransmissionSegmenter (property)", () => {
	it("matches the offline plan for late opens and closes", () => {
		fc.assert(
			fc.property(scenario, ({ o, txs }) => {
				expect(simulate(txs, o)).toEqual(planSegments(txs, o, 0))
			}),
			{ numRuns: 200 },
		)
	})

	it("one file per transmission group: gaps under the hang never split, others always do", () => {
		fc.assert(
			fc.property(scenario, ({ o, txs }) => {
				const long = { ...o, maxSegmentSamples: 1_000_000 }
				const files = simulate(txs, long)
				const splits = txs
					.slice(1)
					.filter((tx, i) => tx.start - txs[i]!.end >= o.hangSamples).length
				expect(files).toHaveLength(splits + 1)
				for (const f of files) expect(f.cut).toBe("completed")
				// Files never overlap and each covers its transmissions plus the hang.
				for (let i = 1; i < files.length; i++)
					expect(files[i]!.start).toBeGreaterThanOrEqual(files[i - 1]!.end)
				for (const tx of txs) {
					const f = files.find(x => x.start <= tx.start && tx.end <= x.end)
					expect(f).toBeDefined()
					expect(f!.end).toBeGreaterThanOrEqual(tx.end + o.hangSamples)
				}
			}),
			{ numRuns: 200 },
		)
	})

	it("rolls an over-long transmission into back-to-back files of at most maxSegment", () => {
		fc.assert(
			fc.property(scenario, ({ o, txs }) => {
				const files = simulate(txs, o)
				for (const f of files)
					expect(f.end - f.start).toBeLessThanOrEqual(o.maxSegmentSamples)
				for (let i = 1; i < files.length; i++)
					if (files[i - 1]!.cut === "duration-limit")
						expect(files[i]!.start).toBe(files[i - 1]!.end)
			}),
			{ numRuns: 100 },
		)
	})
})

describe("TransmissionSegmenter", () => {
	const o = {
		preRollSamples: 300,
		hangSamples: 2000,
		holdbackSamples: 1000,
		maxSegmentSamples: 120_000,
	}

	it("starts preRoll early, clamped to the floor and to the previous file's end", () => {
		const seg = new TransmissionSegmenter(o)
		expect(seg.open("a", 10_000, 0)).toEqual([{ kind: "start", sample: 9_700 }])
		seg.close("a", 11_000, true)
		expect(seg.endTarget).toBe(13_000)
		expect(seg.advance(13_999)).toEqual([])
		expect(seg.advance(14_000)).toEqual([
			{ kind: "end", sample: 13_000, cut: "completed" },
		])
		// The next onset 200 samples after the end: the pre-roll stops at that end.
		expect(seg.open("b", 13_200, 0)).toEqual([
			{ kind: "start", sample: 13_000 },
		])
		const floored = new TransmissionSegmenter(o)
		expect(floored.open("c", 100, 50)).toEqual([{ kind: "start", sample: 50 }])
	})

	it("a gap of exactly the hang splits, one sample less joins", () => {
		const join = new TransmissionSegmenter(o)
		join.open("a", 1000, 0)
		join.close("a", 2000, true)
		expect(join.open("b", 3999, 0)).toEqual([])
		expect(join.openTracks).toBe(1)
		const split = new TransmissionSegmenter(o)
		split.open("a", 1000, 0)
		split.close("a", 2000, true)
		expect(split.open("b", 4000, 0)).toEqual([
			{ kind: "end", sample: 4000, cut: "completed" },
			{ kind: "start", sample: 4000 },
		])
	})

	it("a cut close ends at the last sample at once, without the hang", () => {
		const seg = new TransmissionSegmenter(o)
		seg.open("a", 1000, 0)
		seg.close("a", 5000, false)
		expect(seg.advance(5000)).toEqual([
			{ kind: "end", sample: 5000, cut: "cut" },
		])
	})

	it("holds writes back while a track is open and up to the end target after", () => {
		const seg = new TransmissionSegmenter(o)
		seg.open("a", 1000, 0)
		expect(seg.writableUntil(5000)).toBe(4000)
		seg.close("a", 4500, true)
		expect(seg.writableUntil(5000)).toBe(5000)
		expect(seg.writableUntil(9000)).toBe(6500)
	})

	it("rejects invalid bounds at and past their limits", () => {
		expect(
			() => new TransmissionSegmenter({ ...o, maxSegmentSamples: 0 }),
		).toThrow()
		expect(() => new TransmissionSegmenter({ ...o, hangSamples: -1 })).toThrow()
		expect(
			() => new TransmissionSegmenter({ ...o, preRollSamples: 0.5 }),
		).toThrow()
		expect(
			() => new TransmissionSegmenter({ ...o, maxSegmentSamples: 1 }),
		).not.toThrow()
	})
})
